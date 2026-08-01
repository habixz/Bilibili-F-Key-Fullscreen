// ==UserScript==
// @name         B站F键切换网页全屏与全屏
// @namespace    /DBI/bilibili-f-screen-mode-cycle
// @version      1.2.0
// @description  在 B 站视频页按 F 键时，按“普通 -> 网页全屏 -> 全屏 -> 普通”的顺序循环切换，并避免在输入区打字时误触。
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
            '[role="textbox"]',
            '[contenteditable]:not([contenteditable="false"])'
        ].join(', ')
    };

    /**
     * 脚本涉及到一些异步等待：
     * 1. 唤醒控制栏后，给按钮一次重新出现的时间
     * 2. 真全屏退出后，等待浏览器和播放器状态同步
     * 3. 状态切换后，等待播放器稳定落到目标模式
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
     *
     * 当前循环已经简化成固定三态：
     * 1. 普通 -> 网页全屏
     * 2. 网页全屏 -> 真全屏
     * 3. 真全屏 -> 普通
     */
    const state = {
        switching: false,
        switchToken: 0
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
     * 把任意事件目标尽量归一化成元素节点。
     * 某些富文本编辑器里，keydown 的 target 可能是文本节点，
     * 如果只接受 Element，就会把“正在输入”的场景漏过去。
     *
     * @param {EventTarget|null} target
     * @returns {Element|null}
     */
    function getClosestTargetElement(target) {
        if (target instanceof Element) {
            return target;
        }

        if (target instanceof Node) {
            return target.parentElement;
        }

        return null;
    }

    /**
     * 判断某个元素是否位于可编辑输入区域内。
     * 这里统一兼容原生输入框、富文本编辑器，以及带 `role="textbox"` 的自定义输入控件。
     *
     * @param {Element|null} element
     * @returns {boolean}
     */
    function isEditableElement(element) {
        if (!(element instanceof Element)) {
            return false;
        }

        return Boolean(element.closest(SELECTORS.ignoredInputs));
    }

    /**
     * 获取当前文档里真正处于焦点链末端的元素。
     * 之所以不用只看 `document.activeElement`，
     * 是因为某些自定义输入控件会把真实焦点继续放进 shadowRoot 内部。
     *
     * @returns {Element|null}
     */
    function getDeepActiveElement() {
        let activeElement = document.activeElement instanceof Element ? document.activeElement : null;

        while (activeElement && activeElement.shadowRoot && activeElement.shadowRoot.activeElement instanceof Element) {
            activeElement = activeElement.shadowRoot.activeElement;
        }

        return activeElement;
    }

    /**
     * 从当前文本选区中推断用户是否正处于可编辑区域。
     * 富文本编辑器里，键盘事件目标、焦点元素都可能不稳定，
     * 但选区锚点通常仍然落在评论输入框内部。
     *
     * @returns {boolean}
     */
    function isEditingFromSelection() {
        const selection = window.getSelection();
        if (!selection) {
            return false;
        }

        const anchorElement = getClosestTargetElement(selection.anchorNode);
        const focusElement = getClosestTargetElement(selection.focusNode);

        return isEditableElement(anchorElement) || isEditableElement(focusElement);
    }

    /**
     * 从事件传播路径里检查是否命中了可编辑区域。
     * 某些站点在捕获阶段抛出的 keydown 事件，`target` 可能不是最终的输入节点，
     * 但 composedPath 里仍然能保留经过的编辑器容器。
     *
     * @param {KeyboardEvent} event
     * @returns {boolean}
     */
    function isEditingFromEventPath(event) {
        if (typeof event.composedPath !== 'function') {
            return false;
        }

        const path = event.composedPath();
        return path.some((pathItem) => {
            const element = getClosestTargetElement(pathItem);
            return isEditableElement(element);
        });
    }

    /**
     * 判断当前按键目标是否属于不该拦截的输入区域。
     * 这里综合检查：
     * 1. 事件目标
     * 2. 事件传播路径
     * 3. 当前焦点元素
     * 4. 当前文本选区
     *
     * 这样能更稳地覆盖评论框、搜索框、富文本编辑器等输入场景。
     *
     * @param {KeyboardEvent} event
     * @returns {boolean}
     */
    function shouldIgnoreShortcutTarget(event) {
        const targetElement = getClosestTargetElement(event.target);
        const activeElement = getDeepActiveElement();

        if (document.designMode === 'on') {
            return true;
        }

        return (
            isEditableElement(targetElement)
            || isEditableElement(activeElement)
            || isEditingFromEventPath(event)
            || isEditingFromSelection()
        );
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
     * 执行“真全屏 -> 普通模式”。
     *
     * 目标链路现在是：
     * 1. 普通 -> 网页全屏
     * 2. 网页全屏 -> 真全屏
     * 3. 真全屏 -> 普通
     *
     * 考虑到 B 站不同页面里，退出真全屏后的真实落点可能是：
     * 1. 直接回到普通模式
     * 2. 先回到网页全屏
     *
     * 为了把最终结果统一成“普通模式”，
     * 这里会先退出真全屏；如果发现仍停留在网页全屏，再补一次退出网页全屏。
     *
     * @param {HTMLElement} player
     * @param {number} token
     * @returns {Promise<boolean>}
     */
    async function switchFromFullscreenToNormal(player, token) {
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
         * 真全屏退出后，播放器可能直接回普通，也可能先停在网页全屏。
         * 这里先等待它稳定落到“非真全屏”的某个中间态，再根据实际状态决定是否继续补一步退出网页全屏。
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
            console.warn('[B站F键切换网页全屏与全屏] 退出真全屏后未能稳定回到普通模式或网页全屏');
            return false;
        }

        if (isNormalScreen(player)) {
            return true;
        }

        return switchFromWebscreenToNormal(player, token);
    }

    /**
     * 执行“网页全屏 -> 普通模式”。
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
        return isNormalScreen(player);
    }

    /**
     * 执行三态循环：
     * 1. 普通 -> 网页全屏
     * 2. 网页全屏 -> 全屏
     * 3. 全屏 -> 普通
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
                await switchFromFullscreenToNormal(player, switchToken);
                return;
            }

            if (isWebscreen(player)) {
                const enteredFullscreen = await clickPlayerButton(player, () => getFullscreenButton(player));
                if (!enteredFullscreen) {
                    console.warn('[B站F键切换网页全屏与全屏] 未找到原生全屏按钮，无法从网页全屏进入全屏');
                    return;
                }

                return;
            }

            const enteredWebscreen = await clickPlayerButton(player, () => getWebscreenButton(player));
            if (!enteredWebscreen) {
                console.warn('[B站F键切换网页全屏与全屏] 未找到原生网页全屏按钮，无法从普通模式进入网页全屏');
                return;
            }
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

            if (shouldIgnoreShortcutTarget(event)) {
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
