// ==UserScript==
// @name         B站F键切换网页全屏与全屏
// @namespace    /DBI/bilibili-f-screen-mode-cycle
// @version      1.1.0
// @description  在 B 站视频页按 F 键时，按“普通 -> 网页全屏 -> 全屏 -> 网页全屏 -> 普通”的顺序循环切换，而不是只在普通与全屏之间切换。
// @author       SCP
// @match        https://www.bilibili.com/video/*
// @match        https://www.bilibili.com/bangumi/play/*
// @match        https://www.bilibili.com/cheese/play/*
// @match        https://www.bilibili.com/list/watchlater*
// @match        https://www.bilibili.com/list/*
// @match        https://www.bilibili.com/festival/*
// @icon         https://www.bilibili.com/favicon.ico
// @grant        none
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    const SCRIPT_KEY = '__biliFScreenModeCycleRuntime__';

    /**
     * 统一维护脚本里会反复用到的选择器。
     * 这里直接复用仓库内现有播放器脚本已经验证过的一组选择器，
     * 尽量依赖 B 站播放器中相对稳定的类名、role 和 aria-label，
     * 避免写成又长又脆弱的 CSS 路径。
     */
    const SELECTORS = {
        player: '.bpx-player-container',
        webscreenButton: '.bpx-player-ctrl-web[role="button"][aria-label="网页全屏"]',
        fullscreenButton: '.bpx-player-ctrl-full[role="button"][aria-label="全屏"]',
        ignoredInputs: [
            'input',
            'textarea',
            'select',
            '[contenteditable]:not([contenteditable="false"])'
        ].join(', ')
    };

    /**
     * 脚本涉及到一些异步等待：
     * 1. 唤醒控制栏后，给按钮一次重新出现的时间
     * 2. 真全屏退出后，等待浏览器和播放器状态同步
     * 3. 真全屏退到网页全屏后，等待网页全屏状态稳定
     *
     * 这些时序都不适合写死成同步 click，所以统一抽成可调参数。
     */
    const CONFIG = {
        buttonAppearTimeout: 1200,
        screenSwitchTimeout: 3000,
        waitInterval: 50
    };

    /**
     * 运行期状态：
     * 1. `switching` 用来避免用户连按 F 导致并发切换
     * 2. `switchToken` 用来在异步链路中识别“这次切换是否仍然有效”
     * 3. `webscreenReturnToNormal` 用来区分当前网页全屏是不是“刚从真全屏退回来”的中间态
     *
     * 之所以需要这个标记，是因为“网页全屏”现在有两种不同语义：
     * 1. 从普通进入网页全屏时，下一步应该进真全屏
     * 2. 从真全屏退回网页全屏时，下一步应该退到普通
     */
    const state = {
        switching: false,
        switchToken: 0,
        webscreenReturnToNormal: false
    };

    /**
     * 用脚本级运行时对象保证重复注入安全。
     * 这样在油猴热更新、手动保存脚本后再次注入时，
     * 旧实例留下的监听器会先被清掉，不会出现多个 F 键监听器叠在一起。
     */
    const runtime = window[SCRIPT_KEY] || (window[SCRIPT_KEY] = {});

    /**
     * 获取当前播放器根节点。
     * B 站是 SPA，播放器在切视频时可能被重建，所以这里每次实时查询。
     *
     * @returns {HTMLElement|null}
     */
    function getPlayer() {
        const player = document.querySelector(SELECTORS.player);
        return player instanceof HTMLElement ? player : null;
    }

    /**
     * 获取原生“网页全屏”按钮。
     *
     * @param {HTMLElement|null} player
     * @returns {HTMLElement|null}
     */
    function getWebscreenButton(player) {
        if (!player) {
            return null;
        }

        const button = player.querySelector(SELECTORS.webscreenButton);
        return button instanceof HTMLElement ? button : null;
    }

    /**
     * 获取原生“全屏”按钮。
     *
     * @param {HTMLElement|null} player
     * @returns {HTMLElement|null}
     */
    function getFullscreenButton(player) {
        if (!player) {
            return null;
        }

        const button = player.querySelector(SELECTORS.fullscreenButton);
        return button instanceof HTMLElement ? button : null;
    }

    /**
     * 判断当前是否处于网页全屏。
     * B 站播放器当前会把状态反映到 `data-screen` 上，
     * 直接读取这个字段，比去猜按钮图标状态要更稳。
     *
     * @param {HTMLElement|null} player
     * @returns {boolean}
     */
    function isWebscreen(player) {
        return !!player && player.dataset.screen === 'web';
    }

    /**
     * 判断当前是否处于真全屏。
     * 这里同时兼容浏览器原生 `fullscreenElement` 和播放器自己的 `data-screen="full"`。
     *
     * @param {HTMLElement|null} player
     * @returns {boolean}
     */
    function isFullscreen(player) {
        return !!document.fullscreenElement || !!(player && player.dataset.screen === 'full');
    }

    /**
     * 判断当前是否为普通模式。
     * “普通模式”就是既不是网页全屏，也不是真全屏。
     *
     * @param {HTMLElement|null} player
     * @returns {boolean}
     */
    function isNormalScreen(player) {
        return !!player && !isWebscreen(player) && !isFullscreen(player);
    }

    /**
     * 判断当前按键目标是否属于不该拦截的输入区域。
     * 这样用户在评论框、搜索框、其他输入框里输入 F 时，不会误触脚本。
     *
     * @param {EventTarget|null} target
     * @returns {boolean}
     */
    function shouldIgnoreShortcutTarget(target) {
        if (!(target instanceof Element)) {
            return false;
        }

        return Boolean(target.closest(SELECTORS.ignoredInputs));
    }

    /**
     * 尽量唤醒播放器控制栏。
     * 控制栏处于自动隐藏状态时，按钮有时还在，但也有可能延迟更新可点击状态。
     * 先派发一次 mousemove，更接近真实用户操作，整体稳定性会更高。
     *
     * @param {HTMLElement|null} player
     */
    function wakeControls(player) {
        if (!player) {
            return;
        }

        player.dispatchEvent(new MouseEvent('mousemove', {
            bubbles: true,
            cancelable: true,
            view: window
        }));
    }

    /**
     * 通用轮询等待器。
     * 这里不用一次性长等待，而是小步轮询判断：
     * 1. 状态达到目标时立即继续
     * 2. 超时则安全返回 false
     *
     * @param {() => boolean} checker
     * @param {number} timeout
     * @returns {Promise<boolean>}
     */
    function waitFor(checker, timeout) {
        return new Promise((resolve) => {
            const startedAt = Date.now();

            const timerId = window.setInterval(() => {
                if (checker()) {
                    clearInterval(timerId);
                    resolve(true);
                    return;
                }

                if (Date.now() - startedAt >= timeout) {
                    clearInterval(timerId);
                    resolve(false);
                }
            }, CONFIG.waitInterval);
        });
    }

    /**
     * 生成当前异步切换的唯一令牌。
     * 只要令牌变化，旧链路就应视为失效，避免前一次未完成的切换继续干扰当前状态。
     *
     * @returns {number}
     */
    function createSwitchToken() {
        state.switchToken += 1;
        return state.switchToken;
    }

    /**
     * 判断某次异步切换是否仍然有效。
     * 只要播放器实例已更换、节点脱离文档，或 token 被刷新，
     * 这次异步切换就必须立刻作废。
     *
     * @param {number} token
     * @param {HTMLElement|null} expectedPlayer
     * @returns {boolean}
     */
    function isActiveSwitchToken(token, expectedPlayer) {
        return (
            state.switchToken === token
            && !!expectedPlayer
            && expectedPlayer.isConnected
            && getPlayer() === expectedPlayer
        );
    }

    /**
     * 等待某个原生按钮出现。
     * 控制栏刚被唤醒时，按钮并不一定能在同一帧被稳定拿到，
     * 所以这里做一次轻量等待。
     *
     * @param {() => HTMLElement|null} getButton
     * @returns {Promise<HTMLElement|null>}
     */
    async function waitForButton(getButton) {
        const immediateButton = getButton();
        if (immediateButton) {
            return immediateButton;
        }

        const found = await waitFor(() => !!getButton(), CONFIG.buttonAppearTimeout);
        return found ? getButton() : null;
    }

    /**
     * 统一点击按钮前的准备动作：
     * 1. 先唤醒控制栏
     * 2. 再等待按钮可用
     * 3. 最后执行 click
     *
     * @param {HTMLElement|null} player
     * @param {() => HTMLElement|null} getButton
     * @returns {Promise<boolean>}
     */
    async function clickPlayerButton(player, getButton) {
        if (!player) {
            return false;
        }

        wakeControls(player);

        const button = await waitForButton(getButton);
        if (!button) {
            return false;
        }

        button.click();
        return true;
    }

    /**
     * 执行“真全屏 -> 网页全屏”。
     *
     * 目标链路现在是：
     * 1. 普通 -> 网页全屏
     * 2. 网页全屏 -> 真全屏
     * 3. 真全屏 -> 网页全屏
     * 4. 网页全屏 -> 普通
     *
     * 因此这里不再把“真全屏退出”强制收口到普通模式，
     * 而是明确等待它落回网页全屏，并把这个网页全屏标记成“下一步该退普通”的中间态。
     *
     * @param {HTMLElement} player
     * @param {number} token
     * @returns {Promise<boolean>}
     */
    async function switchFromFullscreenToWebscreen(player, token) {
        const exitedFullscreen = await clickPlayerButton(player, () => getFullscreenButton(player));
        if (!exitedFullscreen) {
            console.warn('[B站F键切换网页全屏与全屏] 未找到原生全屏按钮，无法退出真全屏');
            return false;
        }

        const hasExitedFullscreen = await waitFor(() => {
            if (!isActiveSwitchToken(token, player)) {
                return true;
            }

            return !isFullscreen(player);
        }, CONFIG.screenSwitchTimeout);

        if (!isActiveSwitchToken(token, player)) {
            return false;
        }

        if (!hasExitedFullscreen) {
            console.warn('[B站F键切换网页全屏与全屏] 退出真全屏超时');
            return false;
        }

        /**
         * 运行时证据表明，B 站当前从真全屏退出后会直接回到普通模式，
         * 而不是自动落到网页全屏。
         * 因此这里不再假设“播放器会替我们补回网页全屏”，
         * 而是先观察退出后的真实落点：
         * 1. 如果已经是网页全屏，就直接进入“下一步该退普通”的中间态
         * 2. 如果已经回到普通，就由脚本主动再补一次网页全屏
         */
        const hasReachedIntermediateState = await waitFor(() => {
            if (!isActiveSwitchToken(token, player)) {
                return true;
            }

            return isWebscreen(player) || isNormalScreen(player);
        }, CONFIG.screenSwitchTimeout);

        if (!isActiveSwitchToken(token, player)) {
            return false;
        }

        if (!hasReachedIntermediateState) {
            console.warn('[B站F键切换网页全屏与全屏] 退出真全屏后未能稳定回到网页全屏');
            return false;
        }

        if (isNormalScreen(player)) {
            const reenteredWebscreen = await clickPlayerButton(player, () => getWebscreenButton(player));
            if (!reenteredWebscreen) {
                console.warn('[B站F键切换网页全屏与全屏] 退出真全屏后已回到普通模式，但未能重新进入网页全屏');
                return false;
            }

            const hasEnteredWebscreen = await waitFor(() => {
                if (!isActiveSwitchToken(token, player)) {
                    return true;
                }

                return isWebscreen(player);
            }, CONFIG.screenSwitchTimeout);

            if (!isActiveSwitchToken(token, player)) {
                return false;
            }

            if (!hasEnteredWebscreen) {
                console.warn('[B站F键切换网页全屏与全屏] 退出真全屏后尝试补回网页全屏超时');
                return false;
            }
        }

        state.webscreenReturnToNormal = true;
        return isWebscreen(player);
    }

    /**
     * 执行“网页全屏 -> 普通模式”。
     * 这个分支只在“当前网页全屏是从真全屏退回来的中间态”时使用。
     *
     * @param {HTMLElement} player
     * @param {number} token
     * @returns {Promise<boolean>}
     */
    async function switchFromWebscreenToNormal(player, token) {
        const exitedWebscreen = await clickPlayerButton(player, () => getWebscreenButton(player));
        if (!exitedWebscreen) {
            console.warn('[B站F键切换网页全屏与全屏] 未找到原生网页全屏按钮，无法退出网页全屏');
            return false;
        }

        const hasExitedWebscreen = await waitFor(() => {
            if (!isActiveSwitchToken(token, player)) {
                return true;
            }

            return isNormalScreen(player);
        }, CONFIG.screenSwitchTimeout);

        if (!isActiveSwitchToken(token, player)) {
            return false;
        }

        if (!hasExitedWebscreen) {
            console.warn('[B站F键切换网页全屏与全屏] 退出网页全屏超时，未能回到普通模式');
            return false;
        }

        state.webscreenReturnToNormal = false;
        return isNormalScreen(player);
    }

    /**
     * 执行三态循环：
     * 1. 普通 -> 网页全屏
     * 2. 网页全屏 -> 全屏
     * 3. 全屏 -> 网页全屏
     * 4. 网页全屏 -> 普通
     *
     * 这里始终通过点击 B 站原生按钮来驱动切换，而不是直接调用浏览器全屏 API，
     * 这样更贴近 B 站自身的状态机，也更不容易和播放器内部逻辑打架。
     */
    async function cycleScreenMode() {
        if (state.switching) {
            return;
        }

        const player = getPlayer();
        if (!player) {
            return;
        }

        const switchToken = createSwitchToken();
        state.switching = true;

        try {
            if (isFullscreen(player)) {
                await switchFromFullscreenToWebscreen(player, switchToken);
                return;
            }

            if (isWebscreen(player)) {
                if (state.webscreenReturnToNormal) {
                    await switchFromWebscreenToNormal(player, switchToken);
                    return;
                }

                const enteredFullscreen = await clickPlayerButton(player, () => getFullscreenButton(player));
                if (!enteredFullscreen) {
                    console.warn('[B站F键切换网页全屏与全屏] 未找到原生全屏按钮，无法从网页全屏进入全屏');
                    return;
                }

                state.webscreenReturnToNormal = false;
                return;
            }

            const enteredWebscreen = await clickPlayerButton(player, () => getWebscreenButton(player));
            if (!enteredWebscreen) {
                console.warn('[B站F键切换网页全屏与全屏] 未找到原生网页全屏按钮，无法从普通模式进入网页全屏');
                return;
            }

            state.webscreenReturnToNormal = false;
        } finally {
            if (state.switchToken === switchToken) {
                state.switchToken += 1;
            }

            state.switching = false;
        }
    }

    /**
     * 安装 F 键监听。
     * 设计要点：
     * 1. 使用捕获阶段，尽量在 B 站原生监听器之前接管按键
     * 2. 只处理不带修饰键的裸 F，避免影响浏览器或其他扩展的组合键
     * 3. 过滤输入区域，避免打字时误触
     * 4. 过滤长按重复触发，防止一次长按直接跨过多个状态
     */
    function installShortcutListener() {
        const handleKeydown = (event) => {
            if (event.defaultPrevented) {
                return;
            }

            if (event.isComposing) {
                return;
            }

            if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
                return;
            }

            if (event.repeat) {
                return;
            }

            const isFKey = String(event.key).toLowerCase() === 'f' || event.code === 'KeyF';
            if (!isFKey) {
                return;
            }

            if (shouldIgnoreShortcutTarget(event.target)) {
                return;
            }

            const player = getPlayer();
            if (!player) {
                return;
            }

            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            void cycleScreenMode();
        };

        document.addEventListener('keydown', handleKeydown, true);
        runtime.cleanupTasks.push(() => {
            document.removeEventListener('keydown', handleKeydown, true);
        });
    }

    /**
     * 清理旧实例留下的副作用。
     * 目前脚本只挂了一个键盘监听，但仍然统一走 cleanup 体系，
     * 这样以后要扩展路由监听、观察器时结构也不会乱。
     */
    function cleanupPreviousRuntime() {
        if (typeof runtime.dispose === 'function') {
            runtime.dispose();
        }

        runtime.cleanupTasks = [];
        runtime.dispose = () => {
            const cleanupTasks = runtime.cleanupTasks || [];
            runtime.cleanupTasks = [];

            cleanupTasks.forEach((cleanup) => cleanup());
            state.switching = false;
            state.switchToken += 1;
            state.webscreenReturnToNormal = false;
        };
    }

    /**
     * 启动脚本。
     */
    function init() {
        cleanupPreviousRuntime();
        installShortcutListener();
        console.log('[B站F键切换网页全屏与全屏] 初始化完成');
    }

    init();
})();
