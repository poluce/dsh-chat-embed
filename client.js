/**
 * dsh-chat-embed — Client half.
 *
 * A left-navigation entry ("聊天") that opens a **multi-tab AI chat surface**
 * in the central panel of the DeepSeek Harness desktop app: one tab per web
 * chat service (DeepSeek, 豆包, ChatGPT, MiniMax, Kimi, Gemini and Grok by default), each in its own desktop webview and its own storage partition.
 *
 * ## Why a desktop webview instead of an iframe
 *
 * Every service here refuses framing (`frame-ancestors 'none'` or X-Frame
 * Options), so no document may embed it — not the Web GUI, not a browser
 * profile, not this panel. An Electron `<webview>` is a separate top-level
 * WebContents and ignores those directives, which is why the embedded surface
 * only exists in the desktop app.
 *
 * ## Why the lease handshake
 *
 * The desktop shell refuses every `<webview>` it did not hand a lease to
 * (`will-attach-webview`): the element's `src` must be exactly
 * `about:blank#<lease>` and its `partition` must be the one issued with that
 * lease. `window.dshDesktop.browser.acquire(workspace)` is the only source of
 * leases, and client plugin bundles are injected as same-origin classic
 * scripts, so this file runs in the same main world as that bridge.
 *
 * The workspace string is a storage identity, not a secret: the shell caches
 * one partition per identity for the process lifetime. Giving every provider
 * its own identity keeps their logins isolated, and keeps each service signed
 * in for as long as the app runs.
 *
 * ## Why the guest lives in the seat's own layout box
 *
 * Electron destroys a webview's WebContents as soon as the element leaves the
 * DOM, and re-parenting does not help either: a move is a detach plus an
 * attach. So the surface is rendered *inside* the panel or tab body showing
 * it (`.dce-panel.dce-inline`, `width/height:100%`) and the browser owns the
 * geometry - no measurement, no per-frame JS.
 *
 * Two seats can show it: the central panel (`main`) and the right sidebar tab.
 * They are mutually exclusive because the right sidebar belongs to a Session,
 * so whichever seat the user opens claims the guests. Switching seats rebuilds
 * the guest once; the last conversation URL is restored, so no re-login.
 *
 * ## Per-tab lifecycle
 *
 *   idle → acquiring → navigating → ready
 *                    ↘           ↘
 *                     failed ← (retry acquires a *fresh* lease; a consumed
 *                               lease can never be reused)
 *
 * A tab's guest is created the first time that tab is activated and then kept
 * for the app run. Activating a tab never touches another tab's guest.
 *
 * ## Adding a service
 *
 * Append one entry to `PROVIDERS`: `id`, `label`, `url`, `origin`, and a unique
 * `workspace` (storage identity). Nothing else is provider-specific.
 */

window.__ModuleLoader__.load({
  id: 'dsh-chat-embed',
  factory(require) {
    'use strict'

    // The browser module table publishes React; installing a second copy here
    // would break hooks, so the bundle requires the shared instance.
    const React = require('react')
    const h = React.createElement

    // ------------------------------------------------------------------
    // Identity
    // ------------------------------------------------------------------

    /** Locale namespace this plugin's UI strings register under. */
    const NS = 'dshChatEmbed'

    /** Sidebar entry id; the sidebar dispatches the `main` key of the same name. */
    const PANEL_ID = 'chat-embed'

    /** Right sidebar: one tab type, its body seat, its chip title seat. */
    const RIGHT_TAB_SLOT = 'sidebar.right.pane.tab'
    const RIGHT_TAB_TITLE_SLOT = 'sidebar.right.pane.tab.title'
    const RIGHT_TAB_ID = 'dsh-chat-embed'
    const RIGHT_TAB_KIND = 'chat-embed'

    /**
     * Right-aligned Session utilities (a list slot). The far-right corner is a
     * single slot already owned by another plugin, and shadowing it would hide
     * that plugin's control, so this entry joins the utilities instead.
     */
    const DOCK_SLOT = 'conversation.session.header.utilities'
    const DOCK_ID = 'chat-embed-dock'

    /**
     * Right-sidebar wiring state. The right column is optional and may reject a
     * foreign slot or load after this plugin, so every step is attempted
     * independently and reported in the diagnostics card instead of throwing.
     */
    let rightSeatAttempts = []
    let rightSeatsInstalled = false
    let rightTypeState = { state: 'idle', detail: '' }
    let rightTabTypeDispose
    let rightDisposers = []
    let openRightTabImpl = () => {}

    /** Build identity, surfaced in the panel so a packaged app can be diagnosed. */
    const BUILD = '0.6.9'

    /** Where a re-applied instance finds the one it must take over from. */
    const INSTANCE_KEY = '__DSH_CHAT_EMBED_INSTANCE__'

    /** Where the last session's active tab is remembered. */
    const ACTIVE_TAB_KEY = 'dsh-chat-embed:active-tab'

    /** Where the user's own tab order is remembered. */
    const TAB_ORDER_KEY = 'dsh-chat-embed:tab-order'

    /** Where the set of enabled providers is remembered. */
    const ENABLED_KEY = 'dsh-chat-embed:enabled'

    /**
     * The services this surface can host. Order is the tab order.
     *
     * `workspace` is the shell's storage identity and the partition key: give
     * every provider its own, otherwise two providers share one cookie jar.
     * Keep the value stable — changing it signs the user out.
     */
    const PROVIDERS = Object.freeze([
      {
        id: 'deepseek',
        label: 'DeepSeek',
        url: 'https://chat.deepseek.com/',
        origin: 'https://chat.deepseek.com',
        workspace: 'dsh-chat-embed:chat:v1',
      },
      {
        id: 'doubao',
        label: '豆包',
        url: 'https://www.doubao.com/chat/',
        origin: 'https://www.doubao.com',
        workspace: 'dsh-chat-embed:doubao:v1',
      },
      {
        id: 'chatgpt',
        label: 'ChatGPT',
        url: 'https://chatgpt.com/',
        origin: 'https://chatgpt.com',
        workspace: 'dsh-chat-embed:chatgpt:v1',
      },
      {
        id: 'minimax',
        label: 'MiniMax',
        url: 'https://chat.minimaxi.com/',
        origin: 'https://chat.minimaxi.com',
        workspace: 'dsh-chat-embed:minimax:v1',
      },
      {
        id: 'kimi',
        label: 'Kimi',
        url: 'https://www.kimi.com/',
        origin: 'https://www.kimi.com',
        workspace: 'dsh-chat-embed:kimi:v1',
      },
      {
        id: 'gemini',
        label: 'Gemini',
        url: 'https://gemini.google.com/',
        origin: 'https://gemini.google.com',
        workspace: 'dsh-chat-embed:gemini:v1',
      },
      {
        id: 'grok',
        label: 'Grok',
        url: 'https://grok.com/',
        origin: 'https://grok.com',
        workspace: 'dsh-chat-embed:grok:v1',
      },
    ].map(Object.freeze))

    const DEFAULT_PROVIDER = 'deepseek'

    /**
     * Identity providers that refuse to complete OAuth inside an embedded
     * browser. Relaying their popups would only navigate the guest into a blank
     * page, so they are reported instead of followed.
     */
    const OAUTH_HOSTS = Object.freeze([
      'accounts.google.com',
      'accounts.youtube.com',
      'appleid.apple.com',
      'login.microsoftonline.com',
      'login.live.com',
    ])

    // ------------------------------------------------------------------
    // Timing
    // ------------------------------------------------------------------

    /** The first `dom-ready` can beat the shell's lease registration. */
    const NAVIGATE_RETRY_MS = 350
    const NAVIGATE_MAX_ATTEMPTS = 5

    /**
     * How long to wait after an OAuth roundtrip lands back on the site before
     * checking whether the callback page actually rendered. Overridable in the
     * test hook so the suite does not sleep for seconds.
     */
    const TIMINGS = {
      oauthLandingDelayMs: 1800,
      oauthBlankWatchMs: 2200,
      oauthHandoffProbeMs: 1200,
      oauthRecoveryReloadMs: 700,
    }

    const PHASE = {
      IDLE: 'idle',
      ACQUIRING: 'acquiring',
      NAVIGATING: 'navigating',
      READY: 'ready',
      FAILED: 'failed',
      UNSUPPORTED: 'unsupported',
    }

    // ------------------------------------------------------------------
    // Locale
    // ------------------------------------------------------------------

    const DICTS = {
      en: {
        navLabel: 'Chat',
        statusIdle: 'Idle',
        statusAcquiring: 'Requesting an embedded view…',
        statusNavigating: 'Opening…',
        statusReady: 'Connected',
        statusFailedShort: 'Unavailable',
        statusUnsupportedShort: 'Desktop app required',
        statusFailed: 'This tab could not start',
        statusUnsupported: 'Embedded chat needs the DSH desktop app',
        failedHint:
          'The desktop shell did not hand back a usable webview lease for this tab. Retrying asks for a fresh one.',
        unsupportedHint:
          'These chat services refuse to be framed, so the Web GUI can only link out. Open this panel in the DSH desktop app to chat inside the app.',
        retry: 'Retry',
        reload: 'Reload',
        openInBrowser: 'Open in browser',
        partitionLabel: 'Partition',
        tabHint: 'Open {label}',
        dismiss: 'Dismiss',
        dragHint: 'Drag to reorder',
        settings: 'Settings',
        menuTitle: 'Chat tabs',
        lastTabHint: 'At least one tab must stay enabled',
        logging: 'Debug log',
        loggingHint: 'Print plugin events to the console (off by default)',
        loggingOn: 'on',
        loggingOff: 'off',
        loggingCopy: 'Copy log',
        persistLabel: 'Login across restarts',
        persistOn: 'on (persist: partition)',
        persistOff: 'off (memory partition)',
        persistLost: 'lost (the shell update replaced the patch)',
        persistUnknown: 'not detected yet',
        persistHint: 'Needs the shell patch; a plugin cannot change how the shell names partitions.',
        persistRisk:
          'Experimental: the patch rewrites the app.asar of the desktop shell and needs write access to its install folder. A shell update replaces it, so the patch has to be applied again.',
        persistCheckHint: 'Opens a new session and drafts the check for you',
        persistConfirmTitle: 'Turn on “login across restarts”?',
        persistConfirmNote: 'Continuing opens a new session with the known facts already in the composer — review them and press send.',
        persistConfirmGo: 'Continue',
        persistConfirmCancel: 'Cancel',
        patchPromptPlugin: 'Plugin',
        patchPrompt:
          'Check the DSH desktop shell patch that keeps the embedded chat logins across restarts, and tell me what to do.\n\nKnown so far:\n{facts}\n\nCall the dsh_chat_embed_patch_check tool to confirm the facts, then:\n1. say in a sentence or two what the situation is;\n2. if the patch is missing or was lost, give me the exact command to run;\n3. do not modify any file.',
        patchYes: 'yes',
        patchNo: 'no',
        patchPresent: 'present',
        patchMissing: 'missing (shell version mismatch)',
        patchUnknown: 'unknown',
        patchWritable: 'writable',
        patchSiteLabel: 'patch site',
        patchApplied: 'already patched',
        patchCommandLabel: 'Patch command:',
        patchDetail: 'Note',
        copyDiag: 'Copy diagnostics',
        copied: 'Copied',
        copyFailed: 'Copy failed',
        dockTitle: 'Open chat in the right sidebar',
        rightTabTitle: 'Chat',
        goHome: 'Go to start page',
        diagTitle: 'Tab diagnostics',
        diagUrl: 'URL',
        diagPhase: 'State',
        diagEvent: 'Last event',
        diagHint: 'Send these lines when reporting a broken page.',
        diagHandoff: 'Handoff probe',
        diagRight: 'Right column',
        diagSeat: 'Seat',
        selfTest: 'Self-test',
        rect: 'left {left} top {top} {width}×{height}',
        seatMain: 'center panel',
        seatRight: 'right column',
        seatNone: 'none',
        seatMissing: '{seat} (no host)',
        seatDescribe: '{seat} host={host} (css-owned)',
        rightRegistered: 'registered',
        rightPending: 'pending registration',
        rightFailed: 'registration failed',
        rightUnavailable: 'unavailable',
        rightSeatBody: 'body',
        rightSeatTitle: 'title',
        rightSeatDock: 'dock',
        rightDetail: ' · {detail}',
        seatListSep: ', ',
        selfTestInline: 'inline seat={seat} host={host} width=100% (layout owns the box; no measurement, no polling)',
        selfTestNoSeat: 'no inline seat',
        selfTestLostHost: 'the inline seat lost its host',
        eventStopLoading: 'page stopped loading',
        eventOauthDeadEnd: 'sign-in page dead end',
        eventOauthProbeFailed: 'sign-in dead end (probe failed)',
        eventRendererGone: 'renderer gone',
        oauthBlockedTitle: 'Google sign-in cannot finish here',
        oauthBlockedBody:
          'A normal browser tab works because the site opens a real popup and Google posts the credential back to it through window.opener. A panel cannot open that popup, so the flow stops on Google’s gsi/transform page. Use the site’s own email sign-in instead.',
      },
      zh: {
        navLabel: '聊天',
        statusIdle: '空闲',
        statusAcquiring: '正在申请内嵌视图…',
        statusNavigating: '正在打开…',
        statusReady: '已连接',
        statusFailedShort: '不可用',
        statusUnsupportedShort: '需要桌面版',
        statusFailed: '该标签页启动失败',
        statusUnsupported: '内嵌聊天需要 DSH 桌面版',
        failedHint: '桌面壳没有为这个标签页返回可用的 webview 租约。点击重试会重新申请一张新租约。',
        unsupportedHint:
          '这些 AI 站点都禁止被 frame 嵌入，Web 端只能外开。请在 DSH 桌面版中打开本面板，直接在内嵌页里聊天。',
        retry: '重试',
        reload: '重新加载',
        openInBrowser: '在浏览器打开',
        partitionLabel: '分区',
        tabHint: '打开 {label}',
        dismiss: '知道了',
        dragHint: '拖动可排序',
        settings: '设置',
        menuTitle: '对话窗口',
        lastTabHint: '至少保留一个对话窗口',
        logging: '调试日志',
        loggingHint: '在控制台输出插件事件（默认关闭）',
        loggingOn: '开',
        loggingOff: '关',
        loggingCopy: '复制日志',
        persistLabel: '重启保持登录',
        persistOn: '已开启（persist: 分区）',
        persistOff: '未开启（内存分区）',
        persistLost: '已失效（桌面壳升级覆盖了补丁）',
        persistUnknown: '尚未检测',
        persistHint: '需要桌面壳补丁；插件无法改变壳的分区命名。',
        persistRisk: '实验性功能：补丁会改写桌面壳的 app.asar，需要安装目录的写权限；桌面壳升级会覆盖补丁，需要重新打一次。',
        persistCheckHint: '打开新会话，把检查内容写好，点发送即可',
        persistConfirmTitle: '开启「重启保持登录」？',
        persistConfirmNote: '点击「继续」会打开一个新会话，把已知信息写进输入框，确认后发送即可。',
        persistConfirmGo: '继续',
        persistConfirmCancel: '取消',
        patchPromptPlugin: '插件',
        patchPrompt:
          '帮我检查 DSH 桌面版「跨重启保持登录」的补丁状态，并告诉我该做什么。\n\n已知信息：\n{facts}\n\n请先调用 dsh_chat_embed_patch_check 工具核对上面的信息，然后：\n1. 用一两句话说明现在是什么情况；\n2. 如果补丁没打或已失效，给出我可以直接执行的命令；\n3. 不要修改任何文件。',
        patchYes: '是',
        patchNo: '否',
        patchPresent: '存在',
        patchMissing: '不存在（壳版本不匹配）',
        patchUnknown: '未知',
        patchWritable: '可写',
        patchSiteLabel: '补丁点',
        patchApplied: '已打补丁',
        patchCommandLabel: '补丁命令:',
        patchDetail: '说明',
        copyDiag: '复制诊断信息',
        copied: '已复制',
        copyFailed: '复制失败',
        dockTitle: '在右侧栏打开聊天',
        rightTabTitle: '聊天',
        goHome: '回到首页',
        diagTitle: '标签页诊断',
        diagUrl: '地址',
        diagPhase: '状态',
        diagEvent: '最近事件',
        diagHint: '反馈问题时把这几行发出来即可。',
        diagHandoff: '凭据探测',
        diagRight: '右栏',
        diagSeat: '占位',
        selfTest: '自检',
        rect: '左{left} 上{top} {width}×{height}',
        seatMain: '中央面板',
        seatRight: '右栏',
        seatNone: '无',
        seatMissing: '{seat}（无宿主）',
        seatDescribe: '{seat} 宿主={host}（CSS 决定）',
        rightRegistered: '已注册',
        rightPending: '等待注册',
        rightFailed: '注册失败',
        rightUnavailable: '不可用',
        rightSeatBody: '主体',
        rightSeatTitle: '标题',
        rightSeatDock: '按钮',
        rightDetail: '（{detail}）',
        seatListSep: '，',
        selfTestInline: '内联席位={seat} 宿主={host} 宽度=100%（布局决定，无测量、无轮询）',
        selfTestNoSeat: '没有内联席位',
        selfTestLostHost: '内联席位丢失宿主',
        eventStopLoading: '页面已停止加载',
        eventOauthDeadEnd: '登录页陷入死路',
        eventOauthProbeFailed: '登录页死路（探测失败）',
        eventRendererGone: '渲染进程退出',
        oauthBlockedTitle: 'Google 登录在内嵌面板里无法完成',
        oauthBlockedBody:
          '普通浏览器标签页能成功，是因为站点开了一个真正的弹窗，Google 通过 window.opener 把凭据交回给它；内嵌面板开不出这个弹窗，流程就停在 Google 的 gsi/transform 页。请改用站点自己的「使用电子邮箱继续」。',
      },
    }

    /** Locale keys for diagnostic values that are not free text. */
    const SEAT_KEY = { main: 'seatMain', right: 'seatRight', none: 'seatNone' }
    const RIGHT_STATE_KEY = {
      registered: 'rightRegistered',
      pending: 'rightPending',
      failed: 'rightFailed',
      unavailable: 'rightUnavailable',
    }
    const RIGHT_SEAT_KEY = { body: 'rightSeatBody', title: 'rightSeatTitle', dock: 'rightSeatDock' }
    const EVENT_KEY = {
      'did-stop-loading': 'eventStopLoading',
      'oauth-dead-end': 'eventOauthDeadEnd',
      'oauth-dead-end (probe failed)': 'eventOauthProbeFailed',
      'renderer-gone': 'eventRendererGone',
    }

    /** @param {Record<string, string>} map @param {string} value @returns {string} */
    function valueText(t, map, value) {
      const key = map[value]
      return key !== undefined ? t(key) : value
    }

    /** Fill {name} placeholders in a translated template. */
    function fill(template, params) {
      if (params === undefined) return template
      return String(template).replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
    }

    /** Phase → locale key for the status text. */
    const STATUS_KEY = {
      [PHASE.IDLE]: 'statusIdle',
      [PHASE.ACQUIRING]: 'statusAcquiring',
      [PHASE.NAVIGATING]: 'statusNavigating',
      [PHASE.READY]: 'statusReady',
      [PHASE.FAILED]: 'statusFailedShort',
      [PHASE.UNSUPPORTED]: 'statusUnsupportedShort',
    }

    /** @param {(key: string) => string} t @param {string} phase @returns {string} */
    function phaseText(t, phase) {
      const key = STATUS_KEY[phase]
      return key !== undefined ? t(key) : phase
    }

    /** Debug-only translator: probe readouts stay Chinese. */
    const probeT = (key, params) => fill(DICTS.zh[key] !== undefined ? DICTS.zh[key] : key, params)

    // ------------------------------------------------------------------
    // Pure helpers
    // ------------------------------------------------------------------

    /**
     * Drop the desktop shell's own User-Agent tokens.
     *
     * chat.deepseek.com and friends overlay a "使用环境异常" risk-control dialog
     * when they recognise an Electron UA, so every guest presents as plain
     * Chrome. The raw UA is read at mount time, which keeps this correct across
     * shell upgrades without pinning a Chrome version here.
     *
     * @param {string} raw
     * @returns {string}
     */
    function normalizedUserAgent(raw) {
      const source = typeof raw === 'string' ? raw : ''
      const kept = source
        .split(/\s+/)
        .filter(Boolean)
        .filter((token) => !/^(electron|dsh-desktop|deepseek-harness)\//i.test(token))
      return kept.join(' ')
    }

    /** A plain-Chrome User-Agent used when the renderer exposes none. */
    const FALLBACK_USER_AGENT =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36'

    /** @returns {string} the guest User-Agent for this renderer. */
    function currentUserAgent() {
      const raw = typeof navigator === 'undefined' || navigator === null ? '' : navigator.userAgent
      const normalized = normalizedUserAgent(raw)
      return normalized === '' ? FALLBACK_USER_AGENT : normalized
    }

    /**
     * The desktop shell's leased-browser bridge, when this page runs inside it.
     *
     * @param {object} [scope] override for tests.
     * @returns {{ acquire: Function, release: Function } | undefined}
     */
    function desktopBrowser(scope) {
      const shell = scope === undefined ? window : scope
      const bridge = shell === undefined || shell === null ? undefined : shell.dshDesktop
      const browser = bridge === undefined || bridge === null ? undefined : bridge.browser
      if (browser === undefined || browser === null) return undefined
      if (typeof browser.acquire !== 'function' || typeof browser.release !== 'function') return undefined
      return browser
    }

    /** @returns {boolean} whether this page can host a leased webview. */
    function isEmbedSupported() {
      return desktopBrowser() !== undefined
    }

    /** @returns {Promise<void>} */
    function delay(ms) {
      return new Promise((resolve) => {
        setTimeout(resolve, ms)
      })
    }

    /** Best-effort human text for an unknown thrown value. */
    function messageOf(error) {
      if (error === undefined || error === null) return ''
      if (typeof error === 'string') return error
      const message = error.message
      return typeof message === 'string' ? message : String(error)
    }

    /** Last four characters of an opaque id, for the diagnostic readout. */
    function shortId(value) {
      if (typeof value !== 'string' || value === '') return '—'
      return value.length <= 4 ? value : value.slice(-4)
    }

    /**
     * The plain-text diagnostics report behind the copy button. Kept pure so it
     * can be checked without a renderer or a clipboard.
     *
     * @param {{ labels: Record<string, string>, url: string, frame: any, phase: string, detail: string, partition: string, mounts: number, lastEvent: string, handoff: string, build: string }} input
     * @returns {string}
     */
    function formatDiagReport(input) {
      const labels = input.labels
      const lines = [labels.diagTitle]
      lines.push(labels.diagUrl + ': ' + (input.url === '' ? '—' : input.url))
      lines.push(labels.diagPhase + ': ' + input.phase + (input.detail === '' ? '' : ' · ' + input.detail))
      lines.push(labels.partitionLabel + ': ' + input.partition + ' · #' + input.mounts)
      lines.push(labels.diagEvent + ': ' + (input.lastEvent === '' ? '—' : input.lastEvent))
      if (input.handoff !== '') lines.push(labels.diagHandoff + ': ' + input.handoff)
      if (labels.diagRight !== undefined && input.right !== undefined && input.right !== '') {
        lines.push(labels.diagRight + ': ' + input.right)
      }
      if (labels.diagSeat !== undefined && input.seat !== undefined && input.seat !== '') {
        lines.push(labels.diagSeat + ': ' + input.seat)
      }
      if (labels.selfTest !== undefined && input.selfTest !== undefined && input.selfTest !== '') {
        lines.push(labels.selfTest + ': ' + input.selfTest)
      }
      lines.push('dsh-chat-embed ' + input.build)
      return lines.join('\n')
    }

    /**
     * Copy text to the clipboard, with an execCommand fallback for renderers
     * where the async clipboard API is unavailable.
     *
     * @param {string} text
     * @returns {Promise<boolean>}
     */
    function copyText(text) {
      const api = typeof navigator !== 'undefined' && navigator !== null ? navigator.clipboard : undefined
      if (api !== undefined && api !== null && typeof api.writeText === 'function') {
        return api.writeText(text).then(
          () => true,
          () => fallbackCopy(text),
        )
      }
      return Promise.resolve(fallbackCopy(text))
    }

    /** @param {string} text */
    function fallbackCopy(text) {
      try {
        if (typeof document === 'undefined' || document === null) return false
        if (typeof document.createElement !== 'function') return false
        const area = document.createElement('textarea')
        area.value = text
        area.setAttribute('readonly', 'true')
        area.style.position = 'fixed'
        area.style.top = '-1000px'
        const body = document.body
        if (body !== null && body !== undefined) body.appendChild(area)
        if (typeof area.select === 'function') area.select()
        const ok = typeof document.execCommand === 'function' ? document.execCommand('copy') === true : false
        if (body !== null && body !== undefined) body.removeChild(area)
        return ok
      } catch (error) {
        return false
      }
    }

    /**
     * Whether a URL belongs to an identity provider that blocks embedded OAuth.
     *
     * @param {string} url
     * @returns {boolean}
     */
    function isOAuthUrl(url) {
      if (typeof url !== 'string') return false
      try {
        const parsed = new URL(url)
        return OAUTH_HOSTS.indexOf(parsed.hostname) !== -1
      } catch (error) {
        return false
      }
    }

    /**
     * Google Identity Services ends a popup sign-in on a `gsi/transform` page
     * whose only job is `window.opener.postMessage(...)` followed by close.
     * Replayed in a normal tab it has no opener to talk to and never finishes,
     * so it is a dead end rather than a blank page to retry.
     *
     * @param {string} url
     * @returns {boolean}
     */
    function isOAuthDeadEnd(url) {
      if (typeof url !== 'string' || url === '') return false
      return url.indexOf('accounts.google.com/gsi/') !== -1
    }

    /**
     * @param {string} url
     * @returns {string | undefined}
     */
    function hostOf(url) {
      if (typeof url !== 'string' || url === '') return undefined
      try {
        return new URL(url).hostname
      } catch (error) {
        return undefined
      }
    }

    /** @param {string} id */
    function findProvider(id) {      for (const provider of PROVIDERS) if (provider.id === id) return provider
      return undefined
    }

    /**
     * Whether a guest URL means "the page really opened". Any http(s) document
     * counts: a provider is free to redirect to its own login host without that
     * being a failure.
     *
     * @param {string} url
     */
    function isLiveUrl(url) {
      return typeof url === 'string' && url.indexOf('https://') === 0
    }

    // ------------------------------------------------------------------
    // Store: one revision counter for status, surface and active tab
    // ------------------------------------------------------------------

    // ------------------------------------------------------------------
    // Debug log
    //
    // Off by default: nothing is printed and nothing is buffered until the
    // user turns it on from the settings menu (one click) or from a probe.
    // While on, events go to the console and to a small ring buffer that the
    // diagnostics card can copy, which is what makes a bug report useful.
    // ------------------------------------------------------------------

    /** localStorage key for the on/off switch. */
    const LOG_KEY = 'dsh-chat-embed:log'

    /** localStorage key remembering how the last guest was partitioned. */
    const PERSIST_KEY = 'dsh-chat-embed:persist'

    /**
     * localStorage key remembering that a persistent partition was seen once.
     * A shell update replaces the patch, so "was on, now off" is a lost patch
     * rather than a first run: the difference is what the settings row reports.
     */
    const PERSIST_SEEN_KEY = 'dsh-chat-embed:persist-seen'

    /** How many entries the ring buffer keeps. */
    const LOG_LIMIT = 200

    /** @returns {boolean} the persisted switch; off unless the user opted in */
    function readStoredLogging() {
      try {
        if (typeof localStorage === 'undefined' || localStorage === null) return false
        return localStorage.getItem(LOG_KEY) === '1'
      } catch (error) {
        void error
        return false
      }
    }

    let logEnabled = readStoredLogging()

    /** @type {{ seq: number, time: string, level: string, message: string, detail: any }[]} */
    let logEntries = []

    let logSeq = 0

    /** @returns {boolean} whether the debug log is on */
    function getLogging() {
      return logEnabled
    }

    /** @param {boolean} enabled @returns {boolean} the resulting switch */
    function setLogging(enabled) {
      const next = enabled === true
      logEnabled = next
      try {
        if (typeof localStorage !== 'undefined' && localStorage !== null) localStorage.setItem(LOG_KEY, next ? '1' : '0')
      } catch (error) {
        void error
      }
      if (next) writeLog('info', 'debug log enabled', undefined)
      notify()
      return logEnabled
    }

    function clearLog() {
      logEntries = []
      logSeq = 0
    }

    /** @returns {typeof logEntries} a copy of the ring buffer */
    function readLogEntries() {
      return logEntries.slice()
    }

    /**
     * Record one event; a no-op while the switch is off.
     *
     * @param {string} level
     * @param {string} message
     * @param {any} [detail]
     */
    function log(level, message, detail) {
      if (logEnabled !== true) return
      writeLog(level, message, detail)
    }

    function writeLog(level, message, detail) {
      logSeq += 1
      const entry = {
        seq: logSeq,
        time: new Date().toISOString(),
        level,
        message,
        detail: detail === undefined ? null : detail,
      }
      logEntries.push(entry)
      if (logEntries.length > LOG_LIMIT) logEntries = logEntries.slice(logEntries.length - LOG_LIMIT)
      const text = '[dsh-chat-embed] ' + entry.time + ' ' + entry.level.toUpperCase() + ' ' + entry.message
      try {
        if (typeof console === 'undefined' || console === null) return
        if (level === 'error') console.error(text, entry.detail === null ? '' : entry.detail)
        else if (level === 'warn') console.warn(text, entry.detail === null ? '' : entry.detail)
        else console.log(text, entry.detail === null ? '' : entry.detail)
      } catch (error) {
        void error
      }
    }
    const watchers = new Set()

    function notify() {
      for (const watcher of Array.from(watchers)) {
        try {
          watcher()
        } catch (error) {
          void error
        }
      }
    }

    /**
     * @param {() => void} watcher
     * @returns {() => void}
     */
    function watch(watcher) {
      watchers.add(watcher)
      return () => {
        watchers.delete(watcher)
      }
    }

    // ------------------------------------------------------------------
    // Active tab
    // ------------------------------------------------------------------

    function readStoredActive() {
      try {
        if (typeof localStorage === 'undefined' || localStorage === null) return DEFAULT_PROVIDER
        const stored = localStorage.getItem(ACTIVE_TAB_KEY)
        return findProvider(stored) === undefined ? DEFAULT_PROVIDER : stored
      } catch (error) {
        return DEFAULT_PROVIDER
      }
    }

    /** @param {string} id */
    function storeActive(id) {
      try {
        if (typeof localStorage === 'undefined' || localStorage === null) return
        localStorage.setItem(ACTIVE_TAB_KEY, id)
      } catch (error) {
        void error
      }
    }

    // ------------------------------------------------------------------
    // Tab order (drag to reorder)
    // ------------------------------------------------------------------

    /** @param {string[]} list */
    function normalizeOrder(list) {
      const known = new Set(PROVIDERS.map((provider) => provider.id))
      const seen = new Set()
      const result = []
      for (const id of list) {
        if (!known.has(id) || seen.has(id)) continue
        seen.add(id)
        result.push(id)
      }
      for (const provider of PROVIDERS) {
        if (!seen.has(provider.id)) result.push(provider.id)
      }
      return result
    }

    /** @returns {string[]} */
    function readStoredOrder() {
      try {
        if (typeof localStorage === 'undefined' || localStorage === null) return []
        const raw = localStorage.getItem(TAB_ORDER_KEY)
        if (raw === null) return []
        const parsed = JSON.parse(raw)
        return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : []
      } catch (error) {
        return []
      }
    }

    /** Provider ids in the user's order. */
    let tabOrder = normalizeOrder(readStoredOrder())

    /** @returns {object[]} every provider in the user's order (enabled or not). */
    function providersInOrder() {
      const result = []
      for (const id of tabOrder) {
        const provider = findProvider(id)
        if (provider !== undefined) result.push(provider)
      }
      return result
    }

    /** @returns {object[]} the providers whose tabs are currently shown. */
    function orderedProviders() {
      return providersInOrder().filter((provider) => isEnabled(provider.id))
    }

    /** @returns {string[]} */
    function getTabOrder() {
      return tabOrder.slice()
    }

    // ------------------------------------------------------------------
    // Enabled providers (settings menu)
    // ------------------------------------------------------------------

    /**
     * Keep only known ids, drop duplicates, and fall back to "all enabled" so a
     * corrupt or empty preference never leaves the panel without tabs.
     *
     * @param {string[]} list
     * @returns {string[]}
     */
    function normalizeEnabled(list) {
      const known = new Set(PROVIDERS.map((provider) => provider.id))
      const seen = new Set()
      const result = []
      for (const id of list) {
        if (!known.has(id) || seen.has(id)) continue
        seen.add(id)
        result.push(id)
      }
      return result.length === 0 ? PROVIDERS.map((provider) => provider.id) : result
    }

    /** @returns {string[]} */
    function readStoredEnabled() {
      try {
        if (typeof localStorage === 'undefined' || localStorage === null) return []
        const raw = localStorage.getItem(ENABLED_KEY)
        if (raw === null) return []
        const parsed = JSON.parse(raw)
        return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : []
      } catch (error) {
        return []
      }
    }

    /** Enabled provider ids, normalised once at startup. */
    let enabledIds = normalizeEnabled(readStoredEnabled())

    /** @param {string} id */
    function isEnabled(id) {
      return enabledIds.indexOf(id) !== -1
    }

    /** @returns {string[]} */
    function getEnabled() {
      return enabledIds.slice()
    }

    /** @returns {string} */
    function firstEnabled() {
      return enabledIds.length === 0 ? DEFAULT_PROVIDER : enabledIds[0]
    }

    function storeEnabled() {
      try {
        if (typeof localStorage === 'undefined' || localStorage === null) return
        localStorage.setItem(ENABLED_KEY, JSON.stringify(enabledIds))
      } catch (error) {
        void error
      }
    }

    /**
     * Show or hide one provider's tab. The last enabled provider cannot be
     * hidden; hiding the active one moves the panel to the next enabled tab.
     *
     * @param {string} id
     * @param {boolean} on
     * @returns {boolean} whether the change was applied
     */
    function setProviderEnabled(id, on) {
      const provider = findProvider(id)
      if (provider === undefined) return false
      const currently = isEnabled(id)
      if (currently === on) return true
      log('info', 'provider toggled', { provider: id, on: on === true })
      if (on === false && enabledIds.length <= 1) return false

      if (on) {
        // Re-insert following the user's tab order, not at the end.
        enabledIds = normalizeEnabled(tabOrder.filter((entryId) => entryId === id || isEnabled(entryId)))
      } else {
        enabledIds = enabledIds.filter((entryId) => entryId !== id)
        const record = guestRecord(id)
        if (record.element !== undefined && record.element !== null) dropGuest(record)
      }
      storeEnabled()

      if (on === false && state.active === id) {
        const next = firstEnabled()
        state.active = next
        storeActive(next)
        syncLayers()
        notify()
        void ensureActiveGuest()
        return true
      }
      notify()
      if (on) void ensureActiveGuest()
      return true
    }

    /** Move the active tab to a still-enabled provider when it was hidden. */
    function reconcileActive() {
      if (isEnabled(state.active)) return
      const next = findProvider(firstEnabled())
      if (next === undefined) return
      state.active = next.id
      storeActive(next.id)
    }

    /**
     * Move a tab to a new index and remember the order.
     *
     * @param {string} fromId
     * @param {number} toIndex
     */
    function moveProvider(fromId, toIndex) {
      const from = tabOrder.indexOf(fromId)
      if (from === -1) return
      const next = tabOrder.filter((id) => id !== fromId)
      const index = Math.max(0, Math.min(next.length, toIndex))
      next.splice(index, 0, fromId)
      if (next.join('\u0000') === tabOrder.join('\u0000')) return
      tabOrder = next
      try {
        if (typeof localStorage !== 'undefined' && localStorage !== null) {
          localStorage.setItem(TAB_ORDER_KEY, JSON.stringify(tabOrder))
        }
      } catch (error) {
        void error
      }
      notify()
    }

    /** @type {{ active: string, surface: { host: any } }} */
    const state = {
      active: readStoredActive(),
      surface: { host: null },
    }

    reconcileActive()

    /** @returns {object} the active provider record. */
    function activeProvider() {
      const provider = findProvider(state.active)
      if (provider !== undefined && isEnabled(provider.id)) return provider
      const fallback = findProvider(firstEnabled())
      return fallback !== undefined ? fallback : PROVIDERS[0]
    }

    // ------------------------------------------------------------------
    // Guest registry (one guest per provider)
    // ------------------------------------------------------------------

    /**
     * @typedef {object} GuestRecord
     * @property {any} element
     * @property {string | undefined} lease
     * @property {string | undefined} partition
     * @property {any} layer
     * @property {boolean} mounting
     * @property {number} generation
     * @property {number} mounts
     * @property {boolean} navigated
     * @property {string} phase
     * @property {string} detail
     * @property {{ ready: Function, failed: Function } | undefined} handlers
     * @property {(() => void) | undefined} popupOff
     * @property {boolean} oauthPending
     * @property {any} recoveryTimer
     * @property {string} lastUrl
     * @property {string} lastEvent
     * @property {boolean} diagOpen
     * @property {boolean} oauthBlocked
     * @property {any} reloadTimer
     * @property {string} handoff
     */

    /** @type {Map<string, GuestRecord>} */
    const guests = new Map()

    /**
     * The last page each service was on, kept outside the guest record so it
     * survives a guest teardown: closing and reopening the tab then returns to
     * the same conversation instead of the service home page.
     *
     * @type {Map<string, string>}
     */
    const lastUrls = new Map()

    /**
     * Where a freshly built guest should open.
     *
     * @param {any} provider
     * @returns {string}
     */
    function startUrlFor(provider) {
      const remembered = lastUrls.get(provider.id)
      if (typeof remembered !== 'string' || remembered === '') return provider.url
      if (!remembered.startsWith(provider.origin)) return provider.url
      if (!isLiveUrl(remembered)) return provider.url
      if (isOAuthDeadEnd(remembered)) return provider.url
      return remembered
    }

    /** @returns {GuestRecord} */
    function guestRecord(id) {
      let record = guests.get(id)
      if (record === undefined) {
        record = {
          element: undefined,
          lease: undefined,
          partition: undefined,
          layer: undefined,
          mounting: false,
          generation: 0,
          mounts: 0,
          navigated: false,
          phase: PHASE.IDLE,
          detail: '',
          handlers: undefined,
          popupOff: undefined,
          oauthPending: false,
          recoveryTimer: undefined,
          lastUrl: '',
          lastEvent: '',
          diagOpen: false,
          oauthBlocked: false,
          reloadTimer: undefined,
          handoff: '',
          selfTest: '',
        }
        guests.set(id, record)
      }
      return record
    }

    /** @returns {{ phase: string, detail: string }} */
    function getStatus() {
      const record = guestRecord(state.active)
      return { phase: record.phase, detail: record.detail }
    }

    /**
     * @param {string} id
     * @param {string} phase
     * @param {string} [detail]
     */
    function setPhase(id, phase, detail) {
      const record = guestRecord(id)
      if (record.phase === phase && record.detail === (detail === undefined ? '' : detail)) return
      record.phase = phase
      record.detail = detail === undefined ? '' : detail
      notify()
    }

    /**
     * Hand a lease back to the shell. Failures are swallowed on purpose: a
     * rejected release must never leave the panel stuck in a failed state.
     *
     * @param {string | undefined} lease
     */
    function releaseLease(lease) {
      const bridge = desktopBrowser()
      if (bridge === undefined || typeof lease !== 'string' || lease === '') return
      try {
        const pending = bridge.release(lease)
        if (pending !== undefined && pending !== null && typeof pending.catch === 'function') {
          pending.catch(() => {})
        }
      } catch (error) {
        void error
      }
    }

    /** @param {GuestRecord} record */
    function dropGuest(record) {
      const element = record.element
      const lease = record.lease
      const handlers = record.handlers
      const popupOff = record.popupOff

      record.element = undefined
      record.lease = undefined
      record.partition = undefined
      record.navigated = false
      record.handlers = undefined
      record.popupOff = undefined
      record.oauthPending = false
      record.lastUrl = ''
      record.lastEvent = ''
      record.diagOpen = false
      record.selfTest = ''
      // `oauthBlocked` is deliberately kept: the explanation must survive the
      // recovery reload that replaces the stuck guest.

      if (record.reloadTimer !== undefined) {
        try {
          clearTimeout(record.reloadTimer)
        } catch (error) {
          void error
        }
        record.reloadTimer = undefined
      }

      if (record.recoveryTimer !== undefined) {
        try {
          clearTimeout(record.recoveryTimer)
        } catch (error) {
          void error
        }
        record.recoveryTimer = undefined
      }

      if (typeof popupOff === 'function') {
        try {
          popupOff()
        } catch (error) {
          void error
        }
      }

      if (element !== undefined && element !== null) {
        try {
          if (handlers !== undefined) {
            element.removeEventListener('dom-ready', handlers.ready)
            element.removeEventListener('did-fail-load', handlers.failed)
            element.removeEventListener('did-navigate', handlers.navigate)
            element.removeEventListener('did-navigate-in-page', handlers.navigateInPage)
            element.removeEventListener('did-stop-loading', handlers.stop)
            element.removeEventListener('render-process-gone', handlers.crash)
            element.removeEventListener('crashed', handlers.crash)
          }
        } catch (error) {
          void error
        }
        try {
          if (element.parentNode !== null && element.parentNode !== undefined) {
            element.parentNode.removeChild(element)
          } else if (typeof element.remove === 'function') {
            element.remove()
          }
        } catch (error) {
          void error
        }
      }
      if (lease !== undefined) releaseLease(lease)

      const layer = record.layer
      record.layer = undefined
      if (layer !== undefined && layer !== null && layer.isConnected !== false) {
        try {
          if (layer.parentNode !== null && layer.parentNode !== undefined) {
            layer.parentNode.removeChild(layer)
          }
        } catch (error) {
          void error
        }
      }
    }

    /**
     * @param {any} element
     * @returns {string}
     */
    function guestUrl(element) {
      if (element === undefined || element === null || typeof element.getURL !== 'function') return ''
      try {
        const url = element.getURL()
        return typeof url === 'string' ? url : ''
      } catch (error) {
        return ''
      }
    }

    /** @param {object} provider */
    function layerFor(provider) {
      const record = guestRecord(provider.id)
      if (record.layer !== undefined && record.layer !== null && record.layer.isConnected !== false) {
        return record.layer
      }
      const host = state.surface.host
      if (host === null || host === undefined) return undefined
      const layer = document.createElement('div')
      layer.className = 'dce-guest-layer'
      layer.setAttribute('data-provider', provider.id)
      layer.setAttribute('data-active', provider.id === state.active ? 'true' : 'false')
      host.appendChild(layer)
      record.layer = layer
      return layer
    }

    /** Show only the active provider's layer; hidden layers keep their guest. */
    function syncLayers() {
      for (const provider of PROVIDERS) {
        const record = guests.get(provider.id)
        if (record === undefined || record.layer === undefined || record.layer === null) continue
        const want = provider.id === state.active ? 'true' : 'false'
        if (record.layer.getAttribute('data-active') !== want) record.layer.setAttribute('data-active', want)
      }
    }

    /**
     * Create a provider's guest the first time its tab is shown (idempotent).
     *
     * @param {string} id
     * @returns {Promise<void>}
     */
    async function mountGuest(id) {
      const provider = findProvider(id)
      if (provider === undefined) return
      const record = guestRecord(id)

      if (record.mounting === true) return
      if (record.element !== undefined && record.element !== null) {
        if (record.element.isConnected !== false) return
        // The host was torn down underneath the guest; rebuild it.
        dropGuest(record)
      }

      const layer = layerFor(provider)
      if (layer === undefined) return

      record.mounting = true
      record.generation += 1
      const generation = record.generation

      try {
        const bridge = desktopBrowser()
        if (bridge === undefined) {
          setPhase(id, PHASE.UNSUPPORTED, '')
          return
        }

        setPhase(id, PHASE.ACQUIRING, '')
        let lease
        let partition
        try {
          const acquired = await bridge.acquire(provider.workspace)
          lease = acquired === null || acquired === undefined ? undefined : acquired.lease
          partition = acquired === null || acquired === undefined ? undefined : acquired.partition
          if (typeof lease !== 'string' || lease === '') throw new Error('desktop shell returned no lease')
          if (typeof partition !== 'string' || partition === '') {
            throw new Error('desktop shell returned no partition')
          }
        } catch (error) {
          if (generation === record.generation) setPhase(id, PHASE.FAILED, messageOf(error))
          return
        }

        log('info', 'lease acquired', { provider: id, partition: shortId(partition) })

        // Teardown or reload happened while the lease was in flight.
        if (generation !== record.generation) {
          releaseLease(lease)
          return
        }

        const element = document.createElement('webview')
        element.className = 'dce-guest'
        element.setAttribute('src', 'about:blank#' + lease)
        element.setAttribute('partition', partition)
        element.setAttribute('useragent', currentUserAgent())
        // OAuth buttons ("Continue with Google") are popups. Without this the
        // request dies inside the guest and the site reports a generic sign-in
        // error; with it, the shell relays the URL to us instead of creating a
        // window, and `onGuestPopup` continues the flow in place.
        element.setAttribute('allowpopups', '')
        element.style.cssText = 'display:inline-flex;width:100%;height:100%;border:0;background:transparent;'

        const handlers = {
          ready: (event) => onGuestReady(id, event),
          failed: (event) => onGuestFailed(id, event),
          navigate: (event) => onGuestNavigated(id, event !== undefined && event !== null ? event.url : ''),
          navigateInPage: (event) => onGuestLocation(id, event !== undefined && event !== null ? event.url : ''),
          stop: () => onGuestStopped(id),
          crash: () => onGuestCrashed(id),
        }
        element.addEventListener('dom-ready', handlers.ready)
        element.addEventListener('did-fail-load', handlers.failed)
        element.addEventListener('did-navigate', handlers.navigate)
        element.addEventListener('did-navigate-in-page', handlers.navigateInPage)
        element.addEventListener('did-stop-loading', handlers.stop)
        element.addEventListener('render-process-gone', handlers.crash)
        element.addEventListener('crashed', handlers.crash)

        record.element = element
        record.lease = lease
        record.partition = partition
        record.navigated = false
        record.handlers = handlers
        record.mounts += 1

        try {
          layer.appendChild(element)
        } catch (error) {
          dropGuest(record)
          setPhase(id, PHASE.FAILED, messageOf(error))
          return
        }

        // Popup requests are relayed per lease; keep the disposer with the guest
        // so a reload or teardown cannot leave a listener behind.
        if (typeof bridge.onOpenRequested === 'function') {
          try {
            record.popupOff = bridge.onOpenRequested(lease, (url) => onGuestPopup(id, url))
          } catch (error) {
            record.popupOff = undefined
          }
        }
        setPhase(id, PHASE.NAVIGATING, '')
      } finally {
        record.mounting = false
        syncLayers()
      }
    }

    /**
     * Navigate a guest to its provider's entry URL.
     *
     * `loadURL()` and `src` writes are ignored after attachment; only a
     * document-level navigation from inside the guest moves it. Retries cover
     * the first `dom-ready` arriving before the shell registered the lease.
     *
     * @param {string} id
     * @param {any} element
     * @returns {Promise<void>}
     */
    async function navigateGuest(id, element) {
      const provider = findProvider(id)
      if (provider === undefined) return
      const record = guestRecord(id)

      for (let attempt = 0; attempt < NAVIGATE_MAX_ATTEMPTS; attempt += 1) {
        if (element !== record.element) return
        try {
          await element.executeJavaScript('location.href = ' + JSON.stringify(startUrlFor(provider)) + ';')
        } catch (error) {
          // The guest document is not executing yet; keep trying.
        }
        await delay(NAVIGATE_RETRY_MS)
        if (element !== record.element) return
        const landed = guestUrl(element)
        if (isLiveUrl(landed)) {
          if (typeof landed === 'string' && landed !== '') lastUrls.set(id, landed)
          setPhase(id, PHASE.READY, '')
          return
        }
      }
      if (element !== record.element) return
      setPhase(id, PHASE.FAILED, 'navigation-timeout')
    }

    /**
     * @param {string} id
     * @param {any} event
     */
    function onGuestReady(id, event) {
      const record = guestRecord(id)
      const element =
        event !== undefined && event !== null && event.currentTarget !== undefined ? event.currentTarget : record.element
      if (element === undefined || element !== record.element) return
      if (record.navigated) return
      record.navigated = true
      void navigateGuest(id, element)
    }

    /**
     * @param {string} id
     * @param {any} event
     */
    function onGuestFailed(id, event) {
      const record = guestRecord(id)
      const element =
        event !== undefined && event !== null && event.currentTarget !== undefined ? event.currentTarget : record.element
      if (element === undefined || element !== record.element) return
      if (event !== undefined && event !== null && event.errorCode === -3) return
      setPhase(id, PHASE.FAILED, 'load-failed')
      log('warn', 'guest failed to load', { provider: id })
    }

    /**
     * Remember where the guest is (in-page navigations included).
     *
     * @param {string} id
     * @param {string} url
     */
    function onGuestLocation(id, url) {
      const record = guestRecord(id)
      if (typeof url === 'string' && url !== '') {
        record.lastUrl = url
        lastUrls.set(id, url)
      }
    }

    /**
     * Describe — never dump — the credential Google left on the handoff page.
     *
     * Records only the shape (hash/query length and top-level key names) so the
     * diagnostics card can answer "is interception even possible here?" without
     * copying a live token anywhere.
     *
     * @param {any} element
     * @param {GuestRecord} record
     * @returns {Promise<void>}
     */
    async function inspectOAuthHandoff(element, record) {
      try {
        const raw = await Promise.race([
          element.executeJavaScript(
            '(function(){try{var h=String(location.hash||"");var q=String(location.search||"");var keys=[];' +
              'if(h.length>1){try{var o=JSON.parse(decodeURIComponent(h.slice(1)));if(o&&typeof o==="object")keys=Object.keys(o)}catch(e){}}' +
              'return JSON.stringify({hash:h.length,search:q.length,keys:keys.slice(0,10)})}catch(e){return ""}})()',
          ),
          delay(TIMINGS.oauthHandoffProbeMs).then(() => ''),
        ])
        record.lastEvent =
          typeof raw === 'string' && raw !== '' ? 'oauth-dead-end ' + raw : 'oauth-dead-end (no js response)'
        // Kept on the record (not reset with the guest) so the diagnostics card
        // still explains the handoff after the recovery reload.
        record.handoff = typeof raw === 'string' && raw !== '' ? raw : '(无 JS 返回)'
        notify()
      } catch (error) {
        record.lastEvent = 'oauth-dead-end (probe failed)'
        record.handoff = '(探测失败)'
        notify()
      }
    }

    /**
     * A load finished. Every load gets one blank inspection — this is what turns
     * an unreadable white page into a card with buttons, even when the OAuth
     * heuristic above never armed.
     *
     * @param {string} id
     */
    function onGuestStopped(id) {
      const record = guestRecord(id)
      const element = record.element
      if (element === undefined || element === null) return
      const url = guestUrl(element)
      record.lastUrl = url
      if (typeof url === 'string' && url !== '' && isLiveUrl(url)) lastUrls.set(id, url)
      record.lastEvent = 'did-stop-loading'

      // Google's popup-handoff page cannot finish without an opener: return to
      // a usable page and explain, instead of inspecting a white box.
      if (isOAuthDeadEnd(url)) {
        record.lastEvent = 'oauth-dead-end'
        record.oauthBlocked = true
        record.oauthPending = false
        notify()
        // Best effort only: describe the handoff page for the diagnostics card.
        void inspectOAuthHandoff(element, record)
        // Recovery must not depend on that page executing scripts — replace the
        // guest instead, which is the only reliable way out of a dead document.
        if (record.reloadTimer !== undefined) {
          try {
            clearTimeout(record.reloadTimer)
          } catch (error) {
            void error
          }
        }
        record.reloadTimer = setTimeout(() => {
          record.reloadTimer = undefined
          if (record.element !== element) return
          void reloadGuest(id)
        }, TIMINGS.oauthRecoveryReloadMs)
        return
      }

      // The initial `about:blank#<lease>` load is blank by design.
      if (url.indexOf('about:') === 0) return
      notify()
    }

    /**
     * The guest's renderer died — surface it instead of leaving a white box.
     *
     * @param {string} id
     */
    function onGuestCrashed(id) {
      const record = guestRecord(id)
      if (record.element === undefined || record.element === null) return
      setPhase(id, PHASE.FAILED, 'renderer-gone')
      record.lastEvent = 'renderer-gone'
      log('error', 'renderer gone', { provider: id })
      notify()
    }

    /**
     * A guest asked to open a window (OAuth button, "open in new window" link).
     *
     * The desktop shell never creates that window: it validates the URL against
     * its own navigation policy and hands it here instead. A plugin cannot spawn
     * a real popup, so the flow continues **in place** — that is exactly what an
     * OAuth redirect expects, and it keeps the sign-in inside the same partition.
     *
     * @param {string} id
     * @param {string} url
     */
    function onGuestPopup(id, url) {
      const record = guestRecord(id)
      const element = record.element
      if (element === undefined || element === null) return
      if (typeof url !== 'string' || url.indexOf('https://') !== 0) return

      // Google/Apple complete sign-in but their callback page cannot finish in
      // an embedded WebContents, so arm the dead-end tracking from here.
      if (isOAuthUrl(url)) {
        record.oauthPending = true
        notify()
      }

      navigateInPlace(element, url)
    }

    /**
     * Track where a guest lands.
     *
     * OAuth can start as a popup (handled in `onGuestPopup`) *or* as a plain
     * full-page redirect, so the identity-provider hop is detected here too.
     * When the roundtrip comes back to the site's own origin, recovery is
     * scheduled.
     *
     * @param {string} id
     * @param {string} url
     */
    function onGuestNavigated(id, url) {
      const record = guestRecord(id)
      const provider = findProvider(id)
      if (provider === undefined) return
      const host = hostOf(url)
      if (host === undefined) return

      if (isOAuthUrl(url)) {
        if (record.oauthPending !== true) {
          record.oauthPending = true
          notify()
        }
        return
      }

      if (record.oauthPending !== true) return
      if (host !== hostOf(provider.origin)) return
      record.oauthPending = false
      scheduleOAuthRecovery(id, provider)
    }

    /** @param {GuestRecord} record */
    function clearRecoveryTimer(record) {
      if (record.recoveryTimer === undefined) return
      try {
        clearTimeout(record.recoveryTimer)
      } catch (error) {
        void error
      }
      record.recoveryTimer = undefined
    }

    /**
     * Continue a document in place — the only navigation a leased guest honors.
     *
     * @param {any} element
     * @param {string} url
     */
    function navigateInPlace(element, url) {
      try {
        const pending = element.executeJavaScript('location.href = ' + JSON.stringify(url) + ';')
        if (pending !== undefined && pending !== null && typeof pending.catch === 'function') pending.catch(() => {})
      } catch (error) {
        void error
      }
    }

    /**
     * Recover from a blank OAuth callback in one bounded step.
     *
     * The callback route is written for a popup that reports back through
     * `window.opener`; replayed as a normal tab it can render nothing even
     * though the sign-in cookie already landed. Loading the site's entry URL
     * once (same partition) therefore usually lands the user signed in. No
     * recovery card: the page is left to the site itself.
     *
     * @param {string} id
     * @param {object} provider
     */
    function scheduleOAuthRecovery(id, provider) {
      const record = guestRecord(id)
      clearRecoveryTimer(record)

      record.recoveryTimer = setTimeout(() => {
        record.recoveryTimer = undefined
        const element = record.element
        if (element === undefined || element === null) return
        void (async () => {
          if ((await isGuestBlank(element)) !== true) return
          if (element !== record.element) return
          navigateInPlace(element, provider.url)
          record.notice = ''
          notify()
        })()
      }, TIMINGS.oauthLandingDelayMs)
    }

    /**
     * Ask the guest whether its document is effectively empty.
     *
     * Text-only on purpose: a stuck callback can still carry the site's
     * `<title>`, so a title check would miss exactly the case this recovers.
     *
     * @param {any} element
     * @returns {Promise<boolean>}
     */
    async function isGuestBlank(element) {
      try {
        const raw = await element.executeJavaScript(
          '(function(){try{var b=document.body;var t=b?String(b.innerText||b.textContent||""):"";' +
            'return JSON.stringify({text:t.trim().slice(0,160)})}' +
            'catch(e){return ""}})()',
        )
        if (typeof raw !== 'string' || raw === '') return false
        const parsed = JSON.parse(raw)
        return String(parsed.text || '').length < 20
      } catch (error) {
        return false
      }
    }

    /**
     * Replace one provider's guest with a fresh lease.
     *
     * @param {string} id
     * @returns {Promise<void>}
     */
    async function reloadGuest(id) {
      const record = guestRecord(id)
      log('info', 'reload requested', { provider: id })
      record.generation += 1
      dropGuest(record)
      setPhase(id, PHASE.IDLE, '')
      await mountGuest(id)
    }
    /** Release every guest; used on plugin unload. */
    function destroyGuests() {
      for (const [id, record] of guests) {
        record.generation += 1
        dropGuest(record)
        setPhase(id, PHASE.IDLE, '')
        if (record.layer !== undefined && record.layer !== null) {
          try {
            if (record.layer.parentNode !== null && record.layer.parentNode !== undefined) {
              record.layer.parentNode.removeChild(record.layer)
            }
          } catch (error) {
            void error
          }
          record.layer = undefined
        }
      }
    }

    /** @param {{left:number,top:number,width:number,height:number}} rect @returns {string} */
    function formatRect(rect, t) {
      if (rect === undefined || rect === null) return '—'
      return t('rect', {
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      })
    }

    
    
    // ------------------------------------------------------------------
    // Seats (central panel and the right sidebar tab)
    // ------------------------------------------------------------------

    /**
     * Seat preference order. The preferred seat is tried first; the other one
     * is only a fallback, and only while it is actually painted.
     */
    const SEAT_ORDER = ['right', 'main']

    /** @param {any} node */
    function isLiveSeat(node) {
      return node !== null && node !== undefined && node.isConnected !== false
    }

    
    
    
    
    
    // ------------------------------------------------------------------
    // Inline hosting
    //
    // The surface is rendered *inside* the panel's own layout box, so the
    // browser resizes it while a splitter is dragged — exactly how the shell's
    // terminal pane behaves. No measurement, no per-frame JS.
    // ------------------------------------------------------------------

    /** @type {{ main: any, right: any }} the mounted inline viewport per seat */
    const inlineHosts = { main: null, right: null }

    /**
     * The seat the user opened most recently. Clicking the left navigation entry
     * must show the chat *there*: a hint page is not an entry.
     *
     * @type {'main' | 'right' | undefined}
     */
    let preferredSeat = undefined

    /**
     * Pick the seat that owns the guests: the user's most recent choice wins, and
     * the right tab is the fallback because its body stays mounted while another
     * tab or panel is selected.
     *
     * @returns {any} the chosen viewport element, or null
     */
    /**
     * A guest element cannot move between hosts (Electron destroys the
     * WebContents with its DOM), so guests that are not inside the new host are
     * dropped and rebuilt there.
     *
     * @param {any} host
     */
    function dropGuestsOutside(host) {
      for (const provider of PROVIDERS) {
        const record = guests.get(provider.id)
        if (record === undefined || record.element === undefined || record.element === null) continue
        const element = record.element
        const inside = typeof host.contains === 'function' ? host.contains(element) : false
        if (inside) continue
        dropGuest(record)
      }
    }

    /** @returns {{ host: any }} the live guest viewport */
    function getSurface() {
      return state.surface
    }

    /** @param {any} host */
    function setHost(host) {
      state.surface.host = host
      notify()
    }

    /**
     * Compatibility entry for the tests and probes: only the guest viewport is
     * tracked, the browser owns the geometry.
     *
     * @param {{ host?: any }} patch
     */
    function updateSurface(patch) {
      if (patch !== undefined && patch !== null && patch.host !== undefined) setHost(patch.host)
    }

    function resolveInlineHost() {
      const seat = inlineSeat()
      const chosen = seat === undefined ? null : inlineHosts[seat]
      if (chosen !== state.surface.host) log('info', 'host resolved', { seat: seat === undefined ? 'none' : seat })
      setHost(chosen)
      if (chosen === null) destroyGuests()
      else {
        dropGuestsOutside(chosen)
        void ensureActiveGuest()
      }
      return chosen
    }

    /** @param {'main' | 'right'} seat @returns {boolean} */
    function hostsInline(seat) {
      return inlineSeat() === seat
    }

    /**
     * Hand the guests to another seat; that seat's surface becomes the host and
     * the previous one shows a pointer instead of an empty frame.
     *
     * @param {'main' | 'right'} seat
     */
    function preferSeat(seat) {
      preferredSeat = seat
      log('info', 'seat preferred', { seat })
      resolveInlineHost()
      notify()
    }

    /** @returns {string | undefined} the seat that currently owns the guests */
    /** @param {any} host @returns {number} painted area, 0 while hidden */
    function hostArea(host) {
      if (host === null || host === undefined || typeof host.getBoundingClientRect !== 'function') return 0
      const box = host.getBoundingClientRect()
      return Math.max(0, Math.round(box.width)) * Math.max(0, Math.round(box.height))
    }

    function inlineSeat() {
      const order = preferredSeat === undefined ? SEAT_ORDER : [preferredSeat, ...SEAT_ORDER]
      let hidden
      for (let index = 0; index < order.length; index += 1) {
        const seat = order[index]
        const host = inlineHosts[seat]
        if (host === null || host === undefined) continue
        if (hidden === undefined) hidden = seat
        // A freshly mounted center panel has a zero rect for one commit, so the
        // *main* choice may win before it is measured. The right column is a
        // different story: a collapsed tab body stays at 0×0 forever, and moving
        // the page there would paint it into nothing.
        const chosen = preferredSeat !== undefined && index === 0 && seat === preferredSeat
        const zeroSized = hostArea(host) <= 0
        if (!zeroSized || (chosen && seat === 'main')) return seat
      }
      return hidden
    }

    /**
     * The right sidebar tab type. `multiple: false` keeps a single chat tab per
     * pane; the guide entry is what makes the tab reachable from the sidebar's
     * own launcher.
     *
     * @param {string} title
     * @returns {object}
     */
    function rightTabType(title) {
      return {
        id: RIGHT_TAB_ID,
        kind: RIGHT_TAB_KIND,
        multiple: false,
        // Keep the body mounted while another tab is selected, exactly like the
        // shell's own browser type, so this tab keeps its guest and scroll
        // position while the user looks at another tab.
        keepMounted: true,
        title: () => title,
        guide: [
          {
            id: 'chat',
            commandId: 'chat-embed.open',
            order: 40,
            title: () => title,
            description: () => title,
          },
        ],
      }
    }

    function openRightTab() {
      try {
        openRightTabImpl()
      } catch (error) {
        void error
      }
    }

    /** @returns {string} a live self-test of the hosting seat and its box. */
    function runSeatSelfTest(t) {
      const translate = typeof t === 'function' ? t : probeT
      const seat = inlineSeat()
      if (seat !== undefined) {
        const host = inlineHosts[seat]
        if (host === null || host === undefined) return translate('selfTestLostHost')
        const box = typeof host.getBoundingClientRect === 'function' ? host.getBoundingClientRect() : null
        return translate('selfTestInline', {
          seat: valueText(translate, SEAT_KEY, seat),
          host: box === null ? '—' : formatRect(box, translate),
        })
      }
      return translate('selfTestNoSeat')
    }

    /** @returns {object} structured live geometry for the Inspect probe. */
    function seatReportData() {
      const rect = (value) =>
        value === undefined || value === null
          ? undefined
          : {
              left: Math.round(value.left),
              top: Math.round(value.top),
              width: Math.round(value.width),
              height: Math.round(value.height),
            }
      const seat = inlineSeat()
      const host = seat === undefined ? undefined : inlineHosts[seat]
      return {
        build: BUILD,
        mode: 'inline',
        seat: seat || 'none',
        host: rect(host === undefined || host === null ? undefined : host.getBoundingClientRect()),
        visible: true,
        guest: (() => {
          if (host === undefined || host === null || typeof host.querySelectorAll !== 'function') {
            return { present: false, reason: 'no inline host' }
          }
          const webviews = host.querySelectorAll('webview')
          const layers = host.querySelectorAll('.dce-guest-layer')
          const active = host.querySelectorAll('.dce-guest-layer[data-active="true"]')
          const inner = document.querySelector('.dce-inline')
          return {
            present: webviews.length > 0,
            webviews: webviews.length,
            layers: layers.length,
            active: active.length,
            surfaceMounted: inner !== null && inner !== undefined,
            hostBox: rect(host.getBoundingClientRect()),
          }
        })(),
        right: rightSidebarStatus(),
      }
    }

    /**
     * Register a read-only Client Inspect provider so the Host can read the live
     * geometry through `cordis_inspect_query`, with no UI interaction.
     *
     * @param {any} ctx
     * @returns {(() => void) | undefined}
     */
    function installInspect(ctx, translate) {
      const inspect = typeof ctx.get === 'function' ? ctx.get('cordisInspect') : undefined
      if (inspect === undefined || inspect === null || typeof inspect.register !== 'function') return undefined
      try {
        return inspect.register({
          manifest: {
            id: 'dsh-chat-embed',
            description: 'Live seat and host report for the embedded chat surface.',
            methods: [
              {
                name: 'seatReport',
                description: 'Return the hosting seat, its host box, guest state and a self-test verdict.',
                inputSchema: { type: 'object', properties: {}, additionalProperties: false },
                outputSchema: { type: 'object' },
              },
              {
                name: 'openPanel',
                description: 'Select this plugin central panel, the same thing the left entry does.',
                inputSchema: { type: 'object', properties: {}, additionalProperties: false },
                outputSchema: { type: 'object' },
              },
                                                                                                  {
                name: 'dragProbe',
                description: 'Drag the right column divider with synthetic pointers and report whether the inline surface followed.',
                inputSchema: {
                  type: 'object',
                  properties: { dx: { type: 'number', description: 'Horizontal drag distance; defaults to -48.' } },
                  additionalProperties: false,
                },
                outputSchema: { type: 'object' },
              },
              {
                name: 'handles',
                description: 'List the resize handles the frame currently renders, with their boxes.',
                inputSchema: { type: 'object', properties: {}, additionalProperties: false },
                outputSchema: { type: 'object' },
              },
              {
                name: 'layout',
                description: 'Report the layout service state and the left navigation entries.',
                inputSchema: { type: 'object', properties: {}, additionalProperties: false },
                outputSchema: { type: 'object' },
              },
              {
                name: 'log',
                description: 'Read the debug log ring buffer; set enabled to switch logging on or off.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    enabled: { type: 'boolean', description: 'Switch the debug log on or off.' },
                    clear: { type: 'boolean', description: 'Drop the buffered entries first.' },
                  },
                  additionalProperties: false,
                },
                outputSchema: { type: 'object' },
              },
              {
                name: 'locale',
                description: 'Report the active UI locale and the panel copy it currently resolves to.',
                inputSchema: { type: 'object', properties: {}, additionalProperties: false },
                outputSchema: { type: 'object' },
              },
              {
                name: 'prefer',
                description: 'Hand the chat to a seat (main or right) and report the resulting host seat.',
                inputSchema: {
                  type: 'object',
                  properties: { seat: { type: 'string', description: 'main or right' } },
                  additionalProperties: false,
                },
                outputSchema: { type: 'object' },
              },
              {
                name: 'dom',
                description: 'Report which chat surfaces and guests are actually in the document right now.',
                inputSchema: { type: 'object', properties: {}, additionalProperties: false },
                outputSchema: { type: 'object' },
              },
              {
                name: 'openRight',
                description: 'Open the right sidebar chat tab, then report the resulting host seat.',
                inputSchema: { type: 'object', properties: {}, additionalProperties: false },
                outputSchema: { type: 'object' },
              },
            ],
          },
          query(method, input) {
            if (method === 'locale') {
              const face = typeof ctx.locale.getLocale === 'function' ? ctx.locale.getLocale() : undefined
              const locales =
                face !== undefined && Array.isArray(face.locales) ? face.locales.map((entry) => entry.id) : []
              return {
                active: face !== undefined ? face.active : undefined,
                locales,
                htmlLang:
                  typeof document !== 'undefined' &&
                  document.documentElement !== null &&
                  document.documentElement !== undefined
                    ? document.documentElement.lang
                    : '',
                sample: translate('persistLabel'),
                zhSample: DICTS.zh.persistLabel,
                enSample: DICTS.en.persistLabel,
              }
            }
            if (method === 'log') {
              const patch = input !== undefined && input !== null ? input : {}
              if (typeof patch.enabled === 'boolean') setLogging(patch.enabled)
              if (patch.clear === true) clearLog()
              return { enabled: logEnabled, entries: readLogEntries().slice(-50) }
            }
            if (method === 'layout') {
              const layout = typeof ctx.get === 'function' ? ctx.get('layout') : undefined
              const out = { service: layout !== undefined && layout !== null, keys: [], hasMain: undefined, activePanelId: undefined, nav: [] }
              if (out.service) {
                out.keys = Object.keys(layout)
                if (typeof layout.hasMainPanel === 'function') {
                  try {
                    out.hasMain = layout.hasMainPanel(PANEL_ID)
                  } catch (error) {
                    out.hasMain = 'throw: ' + messageOf(error)
                  }
                }
                const read = (source, label) => {
                  if (source === undefined || source === null) return
                  try {
                    let value = source
                    if (typeof source.get === 'function') value = source.get()
                    else if (typeof source.getState === 'function') value = source.getState()
                    out[label] = value !== null && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : value
                  } catch (error) {
                    out[label] = 'throw: ' + messageOf(error)
                  }
                }
                read(layout.panelInfo, 'panelInfo')
                read(layout.navigation, 'navigation')
                const store = layout.panels
                if (store !== undefined && store !== null) {
                  out.storeKeys = Object.keys(store)
                  read(store, 'panelStore')
                }
              }
              try {
                if (typeof document.querySelectorAll === 'function') {
                  for (const node of document.querySelectorAll('[data-panel-id]')) {
                    out.nav.push({ id: node.getAttribute('data-panel-id'), tag: node.tagName })
                  }
                }
              } catch (error) {
                out.navError = messageOf(error)
              }
              return out
            }
            if (method === 'dom') {
              const count = (selector) => {
                try {
                  return typeof document.querySelectorAll === 'function' ? document.querySelectorAll(selector).length : -1
                } catch (error) {
                  return -1
                }
              }
              return {
                inlineSurfaces: count('.dce-panel.dce-inline'),
                logToggles: count('[data-log-toggle]'),
                toolbarButtons: count('.dce-tab-actions .dce-icon-button'),
                logEnabled,
                persistence: persistenceState(),
                webviews: count('webview'),
                selectedPanel: (() => {
                  const layout = typeof ctx.get === 'function' ? ctx.get('layout') : undefined
                  if (layout === undefined || layout === null || typeof layout.getPanel !== 'function') return undefined
                  try {
                    return layout.getPanel()
                  } catch (error) {
                    return undefined
                  }
                })(),
                hosts: { main: inlineHosts.main !== null, right: inlineHosts.right !== null },
                preferred: preferredSeat || 'none',
                seat: inlineSeat() || 'none',
              }
            }
            if (method === 'openRight') {
              const sidebar = typeof ctx.get === 'function' ? ctx.get('sidebarRight') : undefined
              const report = { steps: [], expanded: undefined }
              if (sidebar === undefined || sidebar === null) {
                report.steps.push('no sidebarRight service')
              } else {
                try {
                  report.expanded = typeof sidebar.isExpanded === 'function' ? sidebar.isExpanded() : undefined
                  if (report.expanded !== true && typeof sidebar.toggleExpanded === 'function') {
                    sidebar.toggleExpanded()
                    report.steps.push('expanded')
                  }
                } catch (error) {
                  report.steps.push('expand: ' + messageOf(error))
                }
                try {
                  if (typeof sidebar.openTab === 'function') sidebar.openTab(RIGHT_TAB_KIND, {})
                  else report.steps.push('no openTab on the service')
                  report.steps.push('openTab')
                } catch (error) {
                  report.steps.push('openTab: ' + messageOf(error))
                }
              }
              return { ...report, requested: RIGHT_TAB_KIND, seat: inlineSeat() || 'none' }
            }
            if (method === 'prefer') {
              const seat = input !== undefined && input !== null && input.seat === 'right' ? 'right' : 'main'
              preferSeat(seat)
              return { seat: inlineSeat() || 'none', host: seatReportData().host }
            }
            if (method === 'handles') {
              const nodes = typeof document.querySelectorAll === 'function' ? document.querySelectorAll('[class*="andle"]') : []
              const seatsNow = { main: inlineHosts.main !== null, right: inlineHosts.right !== null }
              return {
                seats: seatsNow,
                handles: [...nodes].map((node) => ({
                  cls: typeof node.className === 'string' ? node.className : '',
                  side: typeof node.getAttribute === 'function' ? node.getAttribute('data-side') : null,
                  box: (() => {
                    const box = node.getBoundingClientRect()
                    return {
                      left: Math.round(box.left),
                      top: Math.round(box.top),
                      width: Math.round(box.width),
                      height: Math.round(box.height),
                    }
                  })(),
                })),
              }
            }
            if (method === 'dragProbe') {
              const seat = inlineSeat()
              const host = seat === undefined ? null : inlineHosts[seat]
              const divider =
                typeof document.querySelector === 'function'
                  ? document.querySelector('[data-side="rightbar"]') || document.querySelector('[data-dockkit-divider]')
                  : null
              if (divider === null || divider === undefined) return { ok: false, reason: 'no divider in the document' }
              if (host === null || host === undefined) return { ok: false, reason: 'no inline host' }
              const dividerInfo = {
                cls: typeof divider.className === 'string' ? divider.className : '',
                side: typeof divider.getAttribute === 'function' ? divider.getAttribute('data-side') : null,
              }
              const box = divider.getBoundingClientRect()
              const x = box.left + box.width / 2
              const y = box.top + box.height / 2
              // The handle captures a real pointer; a synthetic one has no active
              // pointer to capture, so the capture calls are stubbed while the
              // probe runs and restored afterwards.
              const savedCapture = {
                set: divider.setPointerCapture,
                has: divider.hasPointerCapture,
                release: divider.releasePointerCapture,
              }
              try {
                divider.setPointerCapture = () => {}
                divider.hasPointerCapture = () => true
                divider.releasePointerCapture = () => {}
              } catch (error) {
                void error
              }
              const fire = (target, type, clientX) => {
                if (typeof PointerEvent !== 'function') return false
                try {
                  target.dispatchEvent(
                    new PointerEvent(type, {
                      bubbles: true,
                      cancelable: true,
                      clientX,
                      clientY: y,
                      pointerId: 7,
                      pointerType: 'mouse',
                      isPrimary: true,
                      buttons: type === 'pointerup' ? 0 : 1,
                    }),
                  )
                  return true
                } catch (error) {
                  return false
                }
              }
              const widthOf = () => Math.round(host.getBoundingClientRect().width)
              const dx = input !== undefined && input !== null && typeof input.dx === 'number' && Number.isFinite(input.dx) ? input.dx : -48
              const guest = typeof host.querySelector === 'function' ? host.querySelector('webview') : null
              const sweep = (distance, done) => {
                fire(divider, 'pointerdown', x)
                for (let step = 1; step <= 8; step += 1) fire(divider, 'pointermove', x + (distance * step) / 8)
                fire(divider, 'pointerup', x + distance)
                if (typeof setTimeout === 'function') setTimeout(done, 220)
                else done()
              }
              const before = widthOf()
              const guestWidth = () => {
                if (guest === null || guest === undefined) return undefined
                const box = guest.getBoundingClientRect()
                return Math.round(box.width)
              }
              const guestBefore = guestWidth()
              return new Promise((resolve) => {
                sweep(dx, () => {
                  const dragged = widthOf()
                  const guestDragged = guestWidth()
                  const moved = dragged !== before
                  // Put the column back where it started: the probe must not
                  // leave the user's layout changed.
                  sweep(-dx, () => {
                    const restored = widthOf()
                    const guestRestored = guestWidth()
                    try {
                      divider.setPointerCapture = savedCapture.set
                      divider.hasPointerCapture = savedCapture.has
                      divider.releasePointerCapture = savedCapture.release
                    } catch (error) {
                      void error
                    }
                    resolve({
                      ok: moved,
                      reason: moved
                        ? 'the inline surface followed a real divider drag'
                        : 'the divider did not move (the handle ignored synthetic pointers)',
                      divider: dividerInfo,
                      before,
                      dragged,
                      restored,
                      delta: dragged - before,
                      guest: guest !== null && guest !== undefined,
                      guestWidths: { before: guestBefore, dragged: guestDragged, restored: guestRestored },
                      guestFollowed: guestBefore !== undefined && guestDragged !== undefined && guestDragged !== guestBefore,
                    })
                  })
                })
              })
            }
                                                                        if (method === 'seatReport') return { ...seatReportData(), selfTest: runSeatSelfTest(probeT) }
            if (method === 'openPanel') {
              // The left navigation entry is the center panel; open that surface
              // so a probe can verify the seat the user actually clicks.
              const layout = typeof ctx.get === 'function' ? ctx.get('layout') : undefined
              if (layout === undefined || layout === null || typeof layout.selectPanel !== 'function') {
                return { opened: false, reason: 'layout service is unavailable' }
              }
              layout.selectPanel(PANEL_ID)
              return { opened: true, panel: PANEL_ID }
            }
                        throw new Error('unknown dsh-chat-embed inspect method "' + method + '"')
          },
        })
      } catch (error) {
        return undefined
      }
    }

    /** @returns {string} the live seat geometry, shown in the diagnostics card. */
    function describeSeat(t) {
      const translate = typeof t === 'function' ? t : probeT
      const seat = inlineSeat() || 'none'
      const name = valueText(translate, SEAT_KEY, seat)
      const host = seat === 'none' ? null : inlineHosts[seat]
      if (host === null || host === undefined || typeof host.getBoundingClientRect !== 'function') {
        return translate('seatMissing', { seat: name })
      }
      return translate('seatDescribe', { seat: name, host: formatRect(host.getBoundingClientRect(), translate) })
    }

    /**
     * Whether the mounted guests use a persistent shell partition.
     *
     * The shell names the partition, so the only honest answer comes from the
     * partition a guest already received: `persist:` is the patched, disk-backed
     * case, anything else is memory-only. The answer is remembered so the
     * settings menu can show it right after a restart, before any guest mounts.
     *
     * `lost` reports the specific case that needs an action: a persistent
     * partition was seen before, and this run does not get one — the desktop
     * shell was updated and replaced the patch.
     *
     * @returns {'on' | 'off' | 'lost' | 'unknown'}
     */
    function persistenceState() {
      const live = livePartitionState()
      if (live === 'on') {
        storePersistence('on')
        storePersistenceSeen(true)
        return 'on'
      }
      if (live === 'off') {
        storePersistence('off')
        return readPersistedSeen() ? 'lost' : 'off'
      }
      try {
        if (typeof localStorage === 'undefined' || localStorage === null) return 'unknown'
        const stored = localStorage.getItem(PERSIST_KEY)
        if (stored === 'on') return 'on'
        if (stored === 'off') return readPersistedSeen() ? 'lost' : 'off'
        return readPersistedSeen() ? 'lost' : 'unknown'
      } catch (error) {
        void error
        return 'unknown'
      }
    }

    /** @returns {'on' | 'off' | 'unknown'} what the mounted guests actually received */
    function livePartitionState() {
      for (const provider of PROVIDERS) {
        const record = guests.get(provider.id)
        if (record === undefined || typeof record.partition !== 'string' || record.partition === '') continue
        return record.partition.startsWith('persist:') ? 'on' : 'off'
      }
      return 'unknown'
    }

    /** @returns {boolean} whether a persistent partition was ever observed */
    function readPersistedSeen() {
      try {
        if (typeof localStorage === 'undefined' || localStorage === null) return false
        return localStorage.getItem(PERSIST_SEEN_KEY) === '1'
      } catch (error) {
        void error
        return false
      }
    }

    /** @param {boolean} seen */
    function storePersistenceSeen(seen) {
      try {
        if (typeof localStorage === 'undefined' || localStorage === null) return
        if (seen) localStorage.setItem(PERSIST_SEEN_KEY, '1')
        else localStorage.removeItem(PERSIST_SEEN_KEY)
      } catch (error) {
        void error
      }
    }

    /** @param {'on' | 'off'} state */
    function storePersistence(state) {
      try {
        if (typeof localStorage === 'undefined' || localStorage === null) return
        localStorage.setItem(PERSIST_KEY, state)
      } catch (error) {
        void error
      }
    }

    /** @param {(key: string) => string} t @param {string} state @returns {string} */
    function persistenceText(t, state) {
      if (state === 'on') return t('persistOn')
      if (state === 'off') return t('persistOff')
      if (state === 'lost') return t('persistLost')
      return t('persistUnknown')
    }

    /**
     * The clipboard copy behind "copy the patch instructions": what to run,
     * where the tool is, and how to replace the archive safely.
     *
     * @param {(key: string) => string} t
     * @returns {string}
     */
    /**
     * The clipboard copy behind "copy the patch instructions".
     *
     * The Host's probe supplies the exact command — including the Node binary
     * that ships with the desktop app, so the user is not asked to install one.
     *
     * @param {(key: string) => string} t
     * @param {any} [probe]
     * @returns {string}
     */
    function patchInstructions(t, probe) {
      const info = probe !== undefined && probe !== null ? probe : {}
      const command =
        typeof info.patchCommand === 'string' && info.patchCommand !== ''
          ? info.patchCommand
          : 'node tools/shell-patch/patch-asar.cjs build'
      const lines = [t('persistLabel') + '：' + t('persistHint'), '']
      lines.push('1) 执行下面这条命令（Desk 自带的 Node 运行时；无需另装 Node）：')
      lines.push('   ' + command)
      lines.push('   脚本会自动探测安装目录并逐字节校验，生成 app.asar.new。')
      lines.push('')
      lines.push('2) 完全退出 DSH 后替换（任选其一）：')
      lines.push('   - 运行 tools/shell-patch/watchdog.ps1，退出瞬间自动替换；')
      lines.push('   - 手动把 resources\\app.asar.new 改名为 app.asar。')
      lines.push('')
      lines.push('3) 重启 DSH，回到这里应显示「' + t('persistOn') + '」。')
      lines.push('')
      lines.push('回滚：restore-shell-patch.cmd（把 app.asar.orig 换回去）。')
      lines.push('Windows 之外的安装目录请用 --resources 指定。')
      return lines.join('\n')
    }

    /**
     * Host-side probe state for the "check the patch setup" button. The Host
     * half answers, so a renderer without Node access can still report where
     * the shell lives and whether the archive is writable.
     *
     * @type {{ running: boolean, report: string }}
     */
    const patchCheck = { running: false }

    /** One-shot cache of the Host probe, so both actions read the same facts. */
    const patchProbe = { loaded: false, value: undefined }

    /**
     * Ask the Host half for the shell facts and render a copyable report.
     * Nothing here writes: the button only inspects.
     *
     * @param {(key: string) => string} t
     * @returns {Promise<void>}
     */
    /**
     * Ask the Host for the shell facts once per session. Both the copy action
     * and the self-check read it, so the instructions never disagree with the
     * report.
     *
     * @returns {Promise<any>} the probe, or undefined when the route is absent
     */
    async function fetchProbe() {
      if (patchProbe.loaded) return patchProbe.value
      try {
        // The Host half serves this route; a relative fetch therefore works in
        // both the desktop app and the Web GUI, under any deployment prefix.
        const response = await fetch('./dsh-chat-embed/patch-check', {
          method: 'GET',
          headers: { accept: 'application/json' },
          cache: 'no-store',
        })
        patchProbe.value = response.ok ? await response.json() : undefined
      } catch (error) {
        patchProbe.value = undefined
        void error
      }
      patchProbe.loaded = true
      return patchProbe.value
    }

    /**
     * Hand the self-check to a Session instead of rendering it into the menu.
     *
     * A report inside the settings menu made the panel unusable: absolute paths
     * and a full command line stretched it across the surface, and the result was
     * a one-shot answer kept in panel state. A Session is the right place — the
     * agent can call the patch-check tool, read the reply and explain it, and the
     * user confirms by pressing send.
     *
     * @param {(key: string) => string} t
     * @returns {Promise<void>}
     */
    async function openPatchCheckSession(t) {
      const workspace = typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : undefined
      if (workspace === undefined || workspace === null || typeof workspace.startSession !== 'function') {
        // No Session service: fall back to the clipboard so the click still does
        // something useful instead of failing silently.
        void copyText(patchInstructions(t, patchProbe.value))
        return
      }
      patchCheck.running = true
      notify()
      try {
        const probe = await fetchProbe()
        const prompt = buildPatchPrompt(t, probe)
        patchProbe.loaded = false
        workspace.startSession(undefined, { prompt, whenDraftExists: 'append' })
      } catch (error) {
        void copyText(patchInstructions(t, patchProbe.value) + '\n' + t('copyFailed') + ': ' + messageOf(error))
      }
      patchCheck.running = false
      notify()
    }

    /**
     * The text dropped into the new Session's draft: what is already known, so
     * the agent starts from facts instead of asking the user to run something.
     *
     * @param {(key: string) => string} t
     * @param {any} probe
     * @returns {string}
     */
    function buildPatchPrompt(t, probe) {
      const facts = []
      facts.push(t('patchPromptPlugin') + ': dsh-chat-embed ' + BUILD)
      facts.push(t('persistLabel') + ': ' + persistenceText(t, persistenceState()))
      if (probe !== undefined && probe !== null) {
        const row = (label, value) => {
          if (value === undefined || value === null || value === '') return
          facts.push(label + ': ' + String(value))
        }
        row('resources', probe.resources)
        row('app.asar', probe.asar)
        row('app.asar.orig', probe.backup === true ? t('patchYes') : t('patchNo'))
        row(t('patchWritable'), probe.writable === true ? t('patchYes') : t('patchNo'))
        row(
          t('patchSiteLabel'),
          probe.patchSite === true ? t('patchPresent') : probe.patchSite === false ? t('patchMissing') : t('patchUnknown'),
        )
        row(
          t('patchApplied'),
          probe.patched === true ? t('patchYes') : probe.patched === false ? t('patchNo') : t('patchUnknown'),
        )
        if (typeof probe.patchCommand === 'string' && probe.patchCommand !== '') {
          facts.push('')
          facts.push(t('patchCommandLabel'))
          facts.push(probe.patchCommand)
        }
        if (typeof probe.detail === 'string' && probe.detail !== '') facts.push(t('patchDetail') + ': ' + probe.detail)
      }
      return fill(t('patchPrompt'), { facts: facts.join('\n') })
    }

    /** @returns {{ state: string, detail: string, seats: any[] }} */
    function rightSidebarStatus() {
      return { state: rightTypeState.state, detail: rightTypeState.detail, seats: rightSeatAttempts.slice() }
    }

    /** @returns {string} a one-line right-sidebar status for the diagnostics card. */
    function describeRightSidebar(t) {
      const status = rightSidebarStatus()
      const translate = typeof t === 'function' ? t : probeT
      const seats = status.seats
        .map((seat) => valueText(translate, RIGHT_SEAT_KEY, seat.label) + '=' + (seat.ok === true ? '✓' : '✗'))
        .join(translate('seatListSep'))
      const head =
        valueText(translate, RIGHT_STATE_KEY, status.state) +
        (status.detail === '' ? '' : translate('rightDetail', { detail: status.detail }))
      return seats === '' ? head : head + ' · ' + seats
    }

    /**
     * Wire the optional right column: three seats plus the tab type.
     *
     * The slots are session-scoped and the registry belongs to another plugin,
     * so each step can be rejected or simply be absent at apply time. Every
     * attempt is isolated — the rest of the plugin must survive a failure here.
     *
     * @param {any} ctx
     * @param {(key: string) => string} t
     */
    function installRightSidebar(ctx, t) {
      const attempt = (label, run) => {
        try {
          const dispose = run()
          rightSeatAttempts.push({ label, ok: true })
          if (typeof dispose === 'function') rightDisposers.push(dispose)
        } catch (error) {
          rightSeatAttempts.push({ label, ok: false, detail: messageOf(error) })
          log('warn', 'right sidebar step failed', { step: label, detail: messageOf(error) })
        }
      }

      if (rightSeatsInstalled !== true) {
        rightSeatsInstalled = true
        attempt('body', () =>
          ctx.slots.inject(RIGHT_TAB_SLOT, () =>
            ctx.slots.register(
              { name: RIGHT_TAB_SLOT, key: RIGHT_TAB_ID, locale: NS, registrant: 'dsh-chat-embed' },
              ChatRightBody,
            ),
          ),
        )
        attempt('title', () =>
          ctx.slots.inject(RIGHT_TAB_TITLE_SLOT, () =>
            ctx.slots.register(
              { name: RIGHT_TAB_TITLE_SLOT, key: RIGHT_TAB_ID, locale: NS, registrant: 'dsh-chat-embed' },
              ChatRightTitle,
            ),
          ),
        )
        attempt('dock', () =>
          ctx.slots.inject(DOCK_SLOT, () =>
            ctx.slots.register(
              { name: DOCK_SLOT, id: DOCK_ID, order: 20, locale: NS, registrant: 'dsh-chat-embed' },
              ChatDockButton,
            ),
          ),
        )
      }

      const connect = () => {
        if (rightTabTypeDispose !== undefined) return true
        const read = (name) => (typeof ctx.get === 'function' ? ctx.get(name) : undefined)
        const tabs = read('sidebarRightTabs')
        const controller = read('sidebarRight')
        if (tabs === undefined || tabs === null || typeof tabs.register !== 'function') {
          rightTypeState = { state: 'waiting', detail: 'sidebarRightTabs is not available yet' }
          return false
        }
        try {
          const dispose = tabs.register(rightTabType(t('rightTabTitle')))
          rightTabTypeDispose = typeof dispose === 'function' ? dispose : () => {}
          rightTypeState = { state: 'registered', detail: '' }
        } catch (error) {
          rightTypeState = { state: 'failed', detail: messageOf(error) }
          return false
        }
        openRightTabImpl =
          controller !== undefined && controller !== null && typeof controller.openTab === 'function'
            ? () => {
                controller.openTab(RIGHT_TAB_KIND, {})
              }
            : () => {}
        return true
      }

      try {
        if (connect()) return
      } catch (error) {
        rightTypeState = { state: 'failed', detail: messageOf(error) }
        return
      }

      // The right column may be composed after this plugin: retry briefly.
      if (typeof setTimeout !== 'function') return
      let left = 5
      const retry = () => {
        left -= 1
        let connected = false
        try {
          connected = connect()
        } catch (error) {
          rightTypeState = { state: 'failed', detail: messageOf(error) }
          return
        }
        if (!connected && left > 0) setTimeout(retry, 500)
      }
      setTimeout(retry, 400)
    }

    /**
     * Create the active tab's guest once its host viewport exists.
     *
     * @returns {Promise<void>}
     */
    function ensureActiveGuest() {
      const provider = activeProvider()
      const record = guestRecord(provider.id)
      // A guest whose element was detached with its seat is gone (Electron drops
      // the WebContents with the DOM), so a live element is the only reason to
      // skip the rebuild.
      const element = record.element
      if (element !== undefined && element !== null && element.isConnected !== false) return Promise.resolve()
      if (record.mounting === true) return Promise.resolve()
      // The host viewport inside the panel's layout is the only requirement.
      if (state.surface.host === null || state.surface.host === undefined) return Promise.resolve()
      return mountGuest(provider.id)
    }

    /**
     * Switch tabs: remember the choice and make sure its guest exists. Other
     * tabs are untouched — their guests keep running in hidden layers.
     *
     * @param {string} id
     * @returns {Promise<void>}
     */
    function setActive(id) {
      const provider = findProvider(id)
      if (provider === undefined) return Promise.resolve()
      if (!isEnabled(provider.id)) return Promise.resolve()
      if (state.active !== provider.id) {
        state.active = provider.id
        storeActive(provider.id)
        syncLayers()
      }
      notify()
      return ensureActiveGuest()
    }

    // ------------------------------------------------------------------
    // Styles
    // ------------------------------------------------------------------

    const STYLE_ID = 'dsh-chat-embed-styles'

    // Theme values come from the host's own tokens so the panel follows the
    // active theme instead of asserting a palette of its own.
    const CSS = [
      '.dce-panel{position:relative;display:flex;flex:1 1 auto;flex-direction:column;min-width:0;min-height:0;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#1f2329);overflow:hidden}',
      // Inline mode: the surface is a child of the panel's own layout box. Its
      // width and height are CSS facts, so dragging a splitter needs no JS.
      '.dce-inline{width:100%;height:100%;min-width:0;min-height:0}',
      '.dce-inline.dce-panel{flex:1 1 auto}',
      '.dce-inline>.dce-surface{position:absolute;inset:0}',
      '.dce-hotzone{position:absolute;top:0;left:0;right:0;height:10px;z-index:3}',
      '.dce-tabs{position:absolute;top:0;left:0;right:0;z-index:4;display:flex;align-items:stretch;padding:2px 4px 0;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.22));background:var(--dsw-alias-bg-base,#fff);box-shadow:0 2px 10px rgba(0,0,0,.14);transform:translateY(-110%);opacity:0;pointer-events:none;transition:transform 140ms ease,opacity 140ms ease}',
      '.dce-tabs[data-visible="true"]{transform:translateY(0);opacity:1;pointer-events:auto}',
      '.dce-tab-list{display:flex;align-items:stretch;gap:2px;flex:1 1 auto;min-width:0;overflow-x:auto;overflow-y:hidden;scrollbar-width:none}',
      '.dce-tab-list::-webkit-scrollbar{display:none}',
      '.dce-tab{appearance:none;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary,#5f6368);font:inherit;font-size:12px;line-height:28px;padding:0 10px;cursor:pointer;white-space:nowrap;border-radius:6px 6px 0 0}',
      '.dce-tab:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}',
      '.dce-tab:focus-visible{outline:2px solid var(--dsw-alias-button-primary-fill,#4c6ef5);outline-offset:-2px}',
      '.dce-tab[data-active="true"]{color:var(--dsw-alias-label-primary,#1f2329);border-bottom-color:var(--dsw-alias-button-primary-fill,#4c6ef5);font-weight:600}',
      '.dce-tab[data-failed="true"]{color:var(--dsw-alias-state-error-primary,#d33)}',
      '.dce-tab{cursor:pointer;user-select:none}',
      '.dce-tab[data-dragging="true"]{opacity:.55;cursor:grabbing}',
      '.dce-tab[data-drop="before"]{box-shadow:inset 2px 0 0 var(--dsw-alias-button-primary-fill,#4c6ef5)}',
      '.dce-tab[data-drop="after"]{box-shadow:inset -2px 0 0 var(--dsw-alias-button-primary-fill,#4c6ef5)}',
      '.dce-tab-actions{display:flex;align-items:center;gap:2px;flex:0 0 auto;padding:0 2px 2px}',
      '.dce-icon-button{appearance:none;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#5f6368);cursor:pointer}',
      '.dce-icon-button[data-on="true"]{color:var(--dsw-alias-label-accent,#4c7dff);background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}',
      '.dce-icon-button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}',
      '.dce-icon-button:focus-visible{outline:2px solid var(--dsw-alias-button-primary-fill,#4c6ef5);outline-offset:-2px}',
      '.dce-status-bar{position:absolute;top:0;left:0;right:0;z-index:2;display:flex;align-items:center;gap:8px;box-sizing:border-box;padding:4px 10px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18));background:var(--dsw-alias-bg-base,#fff);font-size:12px}',
      '.dce-dot{flex:0 0 auto;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-label-tertiary,#9aa0a6)}',
      '.dce-dot[data-phase="ready"]{background:var(--dsw-alias-state-success-primary,#2ea043)}',
      '.dce-dot[data-phase="failed"]{background:var(--dsw-alias-state-error-primary,#d33)}',
      '.dce-dot[data-phase="acquiring"],.dce-dot[data-phase="navigating"]{background:var(--dsw-alias-state-warn-primary,#c98a00);animation:dce-pulse 1.4s ease-in-out infinite}',
      '@keyframes dce-pulse{0%,100%{opacity:.35}50%{opacity:1}}',
      '.dce-status{color:var(--dsw-alias-label-secondary,#5f6368);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dce-diag{color:var(--dsw-alias-label-tertiary,#9aa0a6);white-space:nowrap;font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11px;overflow:hidden;text-overflow:ellipsis}',
      '.dce-spacer{flex:1 1 auto}',
      '.dce-button{appearance:none;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));background:transparent;color:var(--dsw-alias-label-secondary,#5f6368);border-radius:6px;font:inherit;font-size:12px;line-height:20px;padding:2px 10px;cursor:pointer}',
      '.dce-button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}',
      '.dce-button:focus-visible{outline:2px solid var(--dsw-alias-button-primary-fill,#4c6ef5);outline-offset:2px}',
      '.dce-button-primary{border-color:currentColor;color:var(--dsw-alias-button-primary-fill,#4c6ef5)}',
      '.dce-surface{position:absolute;inset:0;display:flex;min-height:0}',
      '.dce-viewport{position:absolute;inset:0;display:flex;min-width:0;min-height:0}',
      '.dce-guest-layer{position:absolute;inset:0;display:none;min-width:0;min-height:0}',
      '.dce-guest-layer[data-active="true"]{display:flex}',
      '.dce-guest{display:inline-flex;flex:1 1 auto;width:100%;height:100%;border:0;background:transparent}',
      '.dce-card{position:absolute;inset:0;z-index:2;display:flex;flex-direction:column;gap:10px;box-sizing:border-box;width:auto;max-width:460px;height:max-content;margin:auto;padding:20px 22px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));border-radius:12px;background:var(--dsw-alias-bg-layer-2,#fff);box-shadow:0 12px 32px rgba(0,0,0,.12);font-size:13px}',
      '.dce-card-title{display:flex;align-items:baseline;gap:8px;font-size:14px;font-weight:600}',
      '.dce-card-body{color:var(--dsw-alias-label-secondary,#5f6368);line-height:1.6}',
      '.dce-card-detail{font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11px;color:var(--dsw-alias-label-tertiary,#9aa0a6);word-break:break-all}',
      '.dce-card-actions{display:flex;gap:8px;justify-content:flex-end}',
      '.dce-menu-scrim{position:absolute;inset:0;z-index:5}',
      '.dce-menu{position:absolute;top:34px;right:6px;z-index:6;min-width:196px;max-width:min(420px,calc(100% - 12px));box-sizing:border-box;padding:6px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));border-radius:10px;background:var(--dsw-alias-bg-layer-2,#fff);box-shadow:0 12px 32px rgba(0,0,0,.18);display:flex;flex-direction:column;gap:1px}',
      '.dce-menu-title{display:flex;align-items:baseline;justify-content:space-between;gap:10px;font-size:11px;color:var(--dsw-alias-label-tertiary,#9aa0a6);padding:6px 8px 4px;letter-spacing:.04em}',
      '.dce-menu-version{flex:0 0 auto;font-size:10.5px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:0;opacity:.8}',
      '.dce-card-version{margin-left:auto;font-size:11px;font-weight:400;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dsw-alias-label-tertiary,#9aa0a6);opacity:.8}',
      '.dce-menu-row{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:5px 8px;border-radius:6px;font-size:13px;color:var(--dsw-alias-label-primary,#1f2329)}',
      '.dce-menu-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}',
      '.dce-menu-label{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dce-menu-sep{margin:5px 0 3px;border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24))}',
      '.dce-confirm-scrim{position:absolute;inset:0;z-index:7;background:rgba(0,0,0,.28)}',
      '.dce-card[data-modal="true"]{z-index:8}',
      '.dce-menu-item{display:flex;align-items:center;justify-content:flex-start;gap:8px;width:100%;box-sizing:border-box;padding:6px 8px;border:0;border-radius:6px;background:transparent;color:inherit;font-size:13px;text-align:left;cursor:pointer}',
      '.dce-menu-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}',
      '.dce-right-title{display:inline-flex;align-items:center;gap:6px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dce-right-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary,#19a15f);flex:0 0 auto}',
      '.dce-right-dot[data-phase="failed"]{background:var(--dsw-alias-state-error-primary,#d33)}',
      '.dce-right-dot[data-phase="acquiring"],.dce-right-dot[data-phase="navigating"]{background:var(--dsw-alias-state-warning-primary,#d9a514)}',
      '.dce-switch{appearance:none;border:0;padding:0;width:34px;height:20px;flex:0 0 auto;border-radius:10px;background:var(--dsw-alias-fill-3,rgba(127,127,127,.45));position:relative;cursor:pointer;transition:background 120ms ease}',
      '.dce-switch::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform 120ms ease}',
      '.dce-switch[data-on="true"]{background:var(--dsw-alias-button-primary-fill,#4c6ef5)}',
      '.dce-switch[data-on="true"]::after{transform:translateX(14px)}',
      '.dce-switch:disabled{opacity:.45;cursor:not-allowed}',
    ].join('\n')

    /** @returns {any} the plugin's stylesheet element. */
    function injectStyles() {
      const existing = document.getElementById(STYLE_ID)
      if (existing !== null && existing !== undefined) return existing
      const element = document.createElement('style')
      element.id = STYLE_ID
      element.textContent = CSS
      const parent = document.head !== undefined && document.head !== null ? document.head : document.body
      parent.appendChild(element)
      return element
    }

    // ------------------------------------------------------------------
    // React components
    // ------------------------------------------------------------------

    // Fall back to useEffect on a React build without layout effects.
    const useMountEffect = typeof React.useLayoutEffect === 'function' ? React.useLayoutEffect : React.useEffect

    /**
     * The locale-bound translator installed by apply. Components render through
     * it, so the panel follows the DSH language setting; a locale/change event
     * re-renders them immediately, no reload needed.
     *
     * @type {((key: string, params?: Record<string, string | number>) => string) | undefined}
     */
    let uiT

    /**
     * @returns {(key: string, params?: Record<string, string | number>) => string}
     */
    function translator() {
      return (key, params) => {
        if (typeof uiT === 'function') {
          const value = uiT(key, params)
          if (typeof value === 'string' && value !== '' && value !== key) return value
        }
        const local = DICTS.zh[key]
        return local !== undefined ? fill(local, params) : key
      }
    }

    /** Re-render on any store change, then read module state directly. */
    function useStore() {
      const [, force] = React.useState(0)
      React.useEffect(() => {
        let alive = true
        const bump = () => {
          if (alive) force((value) => value + 1)
        }
        const unsubscribe = watch(bump)
        bump()
        return () => {
          alive = false
          unsubscribe()
        }
      }, [])
    }

    /**
     * @param {string} title
     * @param {string} body
     * @param {(key: string) => string} t
     * @param {{ phase: string, detail: string }} snapshot
     * @param {() => void} [onRetry]
     */
    function hintCard(title, body, t, snapshot, onRetry) {
      return h(
        'div',
        { className: 'dce-card', role: 'status' },
        h('div', { className: 'dce-card-title' }, title),
        h('div', { className: 'dce-card-body' }, body),
        snapshot.detail === '' ? null : h('div', { className: 'dce-card-detail' }, snapshot.detail),
        h(
          'div',
          { className: 'dce-card-actions' },
          onRetry === undefined
            ? null
            : h('button', { type: 'button', className: 'dce-button dce-button-primary', onClick: onRetry }, t('retry')),
          h('button', { type: 'button', className: 'dce-button', onClick: openInBrowser }, t('openInBrowser')),
        ),
      )
    }

    /** Open the active service in the system browser. */
    function openInBrowser() {
      try {
        window.open(activeProvider().url, '_blank', 'noopener,noreferrer')
      } catch (error) {
        void error
      }
    }

    /** @returns {any} a refresh glyph for the tab strip. */
    function reloadIcon() {
      return h(
        'svg',
        {
          width: 14,
          height: 14,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.9,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          focusable: 'false',
        },
        h('path', { d: 'M20 12a8 8 0 1 1-2.34-5.66' }),
        h('path', { d: 'M20 4.5V9h-4.5' }),
      )
    }

    /** @returns {any} an external-link glyph for the tab strip. */
    function externalIcon() {
      return h(
        'svg',
        {
          width: 14,
          height: 14,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.9,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          focusable: 'false',
        },
        h('path', { d: 'M13.5 4H20v6.5' }),
        h('path', { d: 'M20 4l-8.5 8.5' }),
        h('path', { d: 'M18.5 14.5V19a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19V6.5A1.5 1.5 0 0 1 5 5h4.5' }),
      )
    }

    /** @returns {any} an info glyph for the tab strip. */
    function infoIcon() {
      return h(
        'svg',
        {
          width: 14,
          height: 14,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.9,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          focusable: 'false',
        },
        h('circle', { cx: 12, cy: 12, r: 8.5 }),
        h('path', { d: 'M12 11.2v5' }),
        h('path', { d: 'M12 7.8v.6' }),
      )
    }

    function dockIcon() {
      return h(
        'svg',
        {
          width: 14,
          height: 14,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.9,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          focusable: 'false',
        },
        h('rect', { x: 3, y: 4.5, width: 18, height: 15, rx: 3 }),
        h('path', { d: 'M15 4.5v15' }),
      )
    }

    function settingsIcon() {      return h(
        'svg',
        {
          width: 14,
          height: 14,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.9,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          focusable: 'false',
        },
        h('circle', { cx: 12, cy: 12, r: 3 }),
        h('path', {
          d: 'M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z',
        }),
      )
    }

    
    
    /**
     * The right sidebar tab body. `keepMounted` keeps it alive while another tab
     * is selected, so the guest survives a tab switch; the shell hides bodies it
     * is not showing, and a hidden `<webview>` keeps its guest running.
     */
    function ChatRightBody(props) {
      const active = props === undefined || props === null || props.active !== false
      return h(ChatSurface, { seat: 'right', active })
    }

    /**
     * The left-navigation page: the chat itself, hosted by the center panel.
     *
     * The center panel is torn down whenever another panel is selected, so this
     * seat is suitable while the user keeps the chat open; the right tab (below)
     * is the seat that survives panel switches.
     */
    function ChatCenterPage() {
      return h(ChatSurface, { seat: 'main' })
    }

    /** The right sidebar tab's chip title. */
    function ChatRightTitle() {
      useStore()
      const provider = activeProvider()
      const phase = getStatus().phase
      return h(
        'span',
        { className: 'dce-right-title' },
        h('span', { className: 'dce-right-dot', 'data-phase': phase, 'aria-hidden': 'true' }),
        h('span', null, provider.label),
      )
    }

    /** Session-header control that opens (and focuses) the right sidebar tab. */
    function ChatDockButton() {
      const t = translator({})
      return h(
        'button',
        {
          type: 'button',
          className: 'dce-icon-button',
          title: t('dockTitle'),
          'aria-label': t('dockTitle'),
          onClick: () => {
            openRightTab()
          },
        },
        dockIcon(),
      )
    }

    /**
     * One seat's chat surface: tab strip, toolbar, status line and the guest
     * viewport. It renders inline, so the seat's own layout box sizes it.
     */
    function ChatSurface(props) {
      const t = translator(props)
      useStore()
      const snapshot = getStatus()

      const provider = activeProvider()
      const hostRef = React.useRef(null)
      const listRef = React.useRef(null)
      /** @type {React.MutableRefObject<{ id: string, startX: number, active: boolean } | undefined>} */
      const dragRef = React.useRef(undefined)
      /** @type {React.MutableRefObject<{ id: string, side: string } | undefined>} */
      const dropRef = React.useRef(undefined)
      const suppressClickRef = React.useRef(false)
      const [, bumpDrag] = React.useState(0)
      const repaintDrag = () => bumpDrag((value) => value + 1)

      const seatName = props !== undefined && props !== null && props.seat === 'right' ? 'right' : 'main'

      // Mounting a seat is the user opening the chat there: only one of the two
      // seats can exist at a time (the right sidebar needs a Session surface),
      // so the seat that just rendered is the one that owns the guests.
      useMountEffect(() => {
        const visible = seatName === 'main' || props.active !== false
        if (visible) preferSeat(seatName)
        return undefined
      }, [])

      // `preferredSeat === seatName` must count as hosting even before this seat
      // is registered: the registration effect only runs once the viewport is
      // committed, so requiring a registered host first would deadlock.
      const hostingSeat = inlineSeat()
      const hosting =
        hostingSeat === undefined ||
        hostingSeat === seatName ||
        preferredSeat === seatName ||
        // A selected right tab is a user request too: it must render its
        // viewport so it can register and take the guests over.
        (seatName === 'right' && props.active === true)
      React.useEffect(() => {
        const node = hostRef.current
        if (hosting !== true || node === null || node === undefined) return undefined
        inlineHosts[seatName] = node
        if (preferredSeat === undefined) preferredSeat = seatName
        resolveInlineHost()
        notify()
        // A collapsed right tab is 0×0 and must not steal the page; when the user
        // expands the column the tab gets a box, and that is the moment to hand
        // the guests over. The observer only re-runs the seat choice.
        let ro
        if (typeof ResizeObserver === 'function' && preferredSeat === seatName) {
          ro = new ResizeObserver(() => {
            if (preferredSeat === seatName) resolveInlineHost()
          })
          ro.observe(node)
        }
        return () => {
          if (ro !== undefined) ro.disconnect()
          if (inlineHosts[seatName] === node) inlineHosts[seatName] = null
          if (preferredSeat === seatName) preferredSeat = undefined
          resolveInlineHost()
          notify()
        }
      }, [hosting])

      // Selecting the right tab hands the chat to that column, so the panel the
      // user is actually looking at is the one that shows it.
      React.useEffect(() => {
        if (seatName !== 'right' || props.active === false) return undefined
        if (preferredSeat !== 'right') preferSeat('right')
        return undefined
      }, [props.active])

      // Pointer-driven tab reordering. Dragging is armed on pointerdown and
      // only starts after a small threshold, so a plain click still selects.
      useMountEffect(() => {
        const findTab = (x, y) => {
          const element = typeof document.elementFromPoint === 'function' ? document.elementFromPoint(x, y) : null
          if (element === null || element === undefined) return null
          return typeof element.closest === 'function' ? element.closest('[data-tab-id]') : null
        }
        const onMove = (event) => {
          const drag = dragRef.current
          if (drag === undefined) return
          if (drag.active !== true) {
            if (Math.abs(event.clientX - drag.startX) < 6) return
            drag.active = true
          }
          const tab = findTab(event.clientX, event.clientY)
          let next
          if (tab !== null) {
            const rect = tab.getBoundingClientRect()
            next = {
              id: tab.getAttribute('data-tab-id'),
              side: event.clientX < rect.left + rect.width / 2 ? 'before' : 'after',
            }
          }
          const current = dropRef.current
          const unchanged =
            current === next ||
            (current !== undefined &&
              next !== undefined &&
              current.id === next.id &&
              current.side === next.side)
          if (unchanged) return
          dropRef.current = next
          repaintDrag()
        }
        const onUp = () => {
          const drag = dragRef.current
          const drop = dropRef.current
          dragRef.current = undefined
          dropRef.current = undefined
          repaintDrag()
          if (drag === undefined || drag.active !== true) return
          // Swallow the click that follows a drag so it does not also switch tabs.
          suppressClickRef.current = true
          if (drop === undefined || drop.id === drag.id) return
          const targetIndex = tabOrder.indexOf(drop.id)
          const fromIndex = tabOrder.indexOf(drag.id)
          if (targetIndex === -1 || fromIndex === -1) return
          let insertAt = drop.side === 'after' ? targetIndex + 1 : targetIndex
          if (fromIndex < insertAt) insertAt -= 1
          moveProvider(drag.id, insertAt)
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
        window.addEventListener('pointercancel', onUp)
        return () => {
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          window.removeEventListener('pointercancel', onUp)
        }
      }, [])

      const beginTabDrag = (id, event) => {
        if (event.button !== 0) return
        dragRef.current = { id, startX: event.clientX, active: false }
        dropRef.current = undefined
      }
      const onTabWheel = (event) => {
        const list = event.currentTarget
        if (list === null || list === undefined) return
        if (list.scrollWidth <= list.clientWidth) return
        if (event.deltaY === 0) return
        list.scrollLeft += event.deltaY
      }

      // Auto-hiding tab bar: hidden until the pointer reaches the top hot zone.
      const [barOpen, setBarOpen] = React.useState(false)
      const [menuOpen, setMenuOpen] = React.useState(false)
      const [confirmOpen, setConfirmOpen] = React.useState(false)

      /**
       * Close the settings menu.
       *
       * The self-check report is a one-shot answer to a click, not a setting:
       * it is dropped with the menu so reopening never replays a stale report.
       */
      const closeMenu = () => {
        setMenuOpen(false)
      }
      const [copyState, setCopyState] = React.useState('')
      const barTimerRef = React.useRef(0)
      const cancelBarTimer = () => {
        if (barTimerRef.current !== 0) {
          clearTimeout(barTimerRef.current)
          barTimerRef.current = 0
        }
      }
      const openBar = () => {
        cancelBarTimer()
        setBarOpen(true)
      }
      const closeBarNow = () => {
        cancelBarTimer()
        setBarOpen(false)
      }
      const scheduleCloseBar = () => {
        cancelBarTimer()
        barTimerRef.current = window.setTimeout(() => {
          barTimerRef.current = 0
          const drag = dragRef.current
          if (drag !== undefined && drag.active === true) {
            // Never yank the bar away while a tab is being dragged.
            scheduleCloseBar()
            return
          }
          setBarOpen(false)
        }, 400)
      }

      const copyDiagnostics = () => {
        const report = formatDiagReport({
          labels: {
            diagTitle: t('diagTitle'),
            diagUrl: t('diagUrl'),
            diagPhase: t('diagPhase'),
            partitionLabel: t('partitionLabel'),
            diagEvent: t('diagEvent'),
            diagHandoff: t('diagHandoff'),
            diagRight: t('diagRight'),
            diagSeat: t('diagSeat'),
            selfTest: t('selfTest'),
          },
          right: describeRightSidebar(t),
          seat: describeSeat(t),
          selfTest: record.selfTest,
          url: record.lastUrl === '' ? guestUrl(record.element) || '' : record.lastUrl,
          phase: phaseText(t, snapshot.phase),
          detail: snapshot.detail,
          partition: shortId(record.partition),
          mounts: record.mounts,
          lastEvent: record.lastEvent === '' ? '' : valueText(t, EVENT_KEY, record.lastEvent),
          handoff: record.handoff,
          build: BUILD,
        })
        void copyText(report).then((ok) => {
          setCopyState(ok ? 'copied' : 'failed')
          window.setTimeout(() => {
            setCopyState('')
          }, 1600)
        })
      }
      const onReload = () => {
        void reloadGuest(provider.id)
      }
      const record = guestRecord(provider.id)

      // The status strip only earns its space while something is happening or
      // wrong; a healthy tab shows nothing but its tabs.
      const showStatus = snapshot.phase !== PHASE.READY && snapshot.phase !== PHASE.IDLE
      // A problem keeps the bar reachable without hunting for it.
      const barVisible =
        barOpen ||
        menuOpen ||
        record.diagOpen ||
        record.oauthBlocked ||
        snapshot.phase === PHASE.FAILED
      const reloadTitle =
        t('reload') +
        (record.partition === undefined
          ? ''
          : ' · ' + t('partitionLabel') + ' ' + shortId(record.partition) + ' · #' + record.mounts)

      return h(
        'div',
        {
          className: 'dce-panel dce-inline',
          'data-visible': 'true',
          'data-mode': 'inline',
          'data-seat': seatName,
          'data-build': BUILD,
          'aria-hidden': 'false',
        },
        h(
          'div',
          { className: 'dce-panel', onPointerLeave: closeBarNow },
          h('div', { className: 'dce-hotzone', onPointerEnter: openBar, 'aria-hidden': 'true' }),
          h(
            'div',
            {
              className: 'dce-tabs',
              'data-visible': barVisible ? 'true' : 'false',
              onPointerEnter: cancelBarTimer,
              onPointerLeave: scheduleCloseBar,
            },
            h(
              'div',
              {
                className: 'dce-tab-list',
                role: 'tablist',
                'aria-label': 'AI chat services',
                ref: listRef,
                onWheel: onTabWheel,
              },
              orderedProviders().map((entry) =>
                h(
                  'button',
                  {
                    key: entry.id,
                    type: 'button',
                    role: 'tab',
                    className: 'dce-tab',
                    'data-tab-id': entry.id,
                    'data-active': entry.id === provider.id ? 'true' : 'false',
                    'data-failed': guestRecord(entry.id).phase === PHASE.FAILED ? 'true' : 'false',
                    'data-dragging':
                      dragRef.current !== undefined &&
                      dragRef.current.active === true &&
                      dragRef.current.id === entry.id
                        ? 'true'
                        : 'false',
                    'data-drop':
                      dropRef.current !== undefined && dropRef.current.id === entry.id
                        ? dropRef.current.side
                        : 'none',
                    'aria-selected': entry.id === provider.id ? 'true' : 'false',
                    title: entry.url + ' · ' + t('dragHint'),
                    onPointerDown: (event) => beginTabDrag(entry.id, event),
                    onClick: () => {
                      if (suppressClickRef.current === true) {
                        suppressClickRef.current = false
                        return
                      }
                      void setActive(entry.id)
                    },
                  },
                  entry.label,
                ),
              ),
            ),
            h(
              'div',
              { className: 'dce-tab-actions' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dce-icon-button',
                  'aria-label': t('reload'),
                  title: reloadTitle,
                  onClick: onReload,
                },
                reloadIcon(),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dce-icon-button',
                  'aria-label': t('openInBrowser'),
                  title: t('openInBrowser'),
                  onClick: openInBrowser,
                },
                externalIcon(),
              ),


              h(
                'button',
                {
                  type: 'button',
                  className: 'dce-icon-button',
                  'aria-label': t('settings'),
                  title: t('settings'),
                  'aria-expanded': menuOpen ? 'true' : 'false',
                  onClick: () => {
                    if (menuOpen) closeMenu()
                    else setMenuOpen(true)
                    openBar()
                  },
                },
                settingsIcon(),
              ),
            ),
          ),
          menuOpen
            ? h('div', {
                className: 'dce-menu-scrim',
                onPointerDown: closeMenu,
              })
            : null,
          menuOpen
            ? h(
                'div',
                { className: 'dce-menu', role: 'menu' },
                h(
                  'div',
                  { className: 'dce-menu-title' },
                  h('span', null, t('menuTitle')),
                  h('span', { className: 'dce-menu-version', 'data-build': BUILD }, 'v' + BUILD),
                ),
                providersInOrder().map((entry) => {
                  const on = isEnabled(entry.id)
                  const lastOne = on && enabledIds.length <= 1
                  return h(
                    'div',
                    { key: entry.id, className: 'dce-menu-row' },
                    h('span', { className: 'dce-menu-label' }, entry.label),
                    h('button', {
                      type: 'button',
                      role: 'switch',
                      className: 'dce-switch',
                      'data-on': on ? 'true' : 'false',
                      'aria-checked': on ? 'true' : 'false',
                      'aria-label': entry.label,
                      title: lastOne ? t('lastTabHint') : entry.label,
                      disabled: lastOne,
                      onClick: () => {
                        setProviderEnabled(entry.id, !on)
                      },
                    }),
                  )
                }),
                h('div', { className: 'dce-menu-sep', 'aria-hidden': 'true' }),
                h(
                  'div',
                  { className: 'dce-menu-row' },
                  h('span', { className: 'dce-menu-label', title: t('persistHint') }, t('persistLabel')),
                  h('button', {
                    type: 'button',
                    role: 'switch',
                    className: 'dce-switch',
                    'data-on': persistenceState() === 'on' ? 'true' : 'false',
                    'aria-checked': persistenceState() === 'on' ? 'true' : 'false',
                    'data-persist-open': 'true',
                    'aria-label': t('persistLabel'),
                    title: t('persistCheckHint'),
                    disabled: patchCheck.running,
                    onClick: () => {
                      closeMenu()
                      setConfirmOpen(true)
                    },
                  }),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dce-menu-item',
                    'aria-label': t('diagTitle'),
                    onClick: () => {
                      closeMenu()
                      record.diagOpen = !record.diagOpen
                      notify()
                    },
                  },
                  infoIcon(),
                  h('span', { className: 'dce-menu-label' }, t('diagTitle') + '…'),
                ),
                h(
                  'div',
                  { className: 'dce-menu-row' },
                  h('span', { className: 'dce-menu-label' }, t('logging')),
                  h(
                    'button',
                    {
                      type: 'button',
                      role: 'switch',
                      className: 'dce-switch',
                      'data-on': logEnabled ? 'true' : 'false',
                      'aria-checked': logEnabled ? 'true' : 'false',
                      'data-log-toggle': 'true',
                      'aria-label': t('logging'),
                      title: t('loggingHint'),
                      onClick: () => {
                        setLogging(!logEnabled)
                      },
                    },
                  ),
                ),
              )
            : null,
          confirmOpen
            ? h('div', {
                className: 'dce-confirm-scrim',
                onPointerDown: () => setConfirmOpen(false),
              })
            : null,
          confirmOpen
            ? h(
                'div',
                {
                  className: 'dce-card',
                  role: 'dialog',
                  'aria-modal': 'true',
                  'data-modal': 'true',
                  'aria-label': t('persistConfirmTitle'),
                },
                h('div', { className: 'dce-card-title' }, t('persistConfirmTitle')),
                h('div', { className: 'dce-card-body' }, t('persistRisk')),
                h('div', { className: 'dce-card-body' }, t('persistConfirmNote')),
                h(
                  'div',
                  { className: 'dce-card-actions' },
                  h(
                    'button',
                    { type: 'button', className: 'dce-button', 'data-persist-cancel': 'true', onClick: () => setConfirmOpen(false) },
                    t('persistConfirmCancel'),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dce-button dce-button-primary',
                      'data-persist-confirm': 'true',
                      onClick: () => {
                        setConfirmOpen(false)
                        void openPatchCheckSession(t)
                      },
                    },
                    t('persistConfirmGo'),
                  ),
                ),
              )
            : null,
          showStatus
            ? h(
                'div',
                { className: 'dce-status-bar' },
                h('span', { className: 'dce-dot', 'data-phase': snapshot.phase, 'aria-hidden': true }),
                h('span', { className: 'dce-status' }, t(STATUS_KEY[snapshot.phase] || 'statusIdle')),
                snapshot.detail === '' ? null : h('span', { className: 'dce-diag' }, snapshot.detail),
              )
            : null,
          h(
            'div',
            { className: 'dce-surface' },
            h('div', { className: 'dce-viewport', ref: hostRef }),
            snapshot.phase === PHASE.UNSUPPORTED
              ? hintCard(t('statusUnsupported'), t('unsupportedHint'), t, snapshot)
              : null,
            snapshot.phase === PHASE.FAILED
              ? hintCard(t('statusFailed'), t('failedHint'), t, snapshot, onReload)
              : null,
            record.oauthBlocked
              ? h(
                  'div',
                  { className: 'dce-card', role: 'alert' },
                  h('div', { className: 'dce-card-title' }, t('oauthBlockedTitle')),
                  h('div', { className: 'dce-card-body' }, t('oauthBlockedBody')),
                  record.lastUrl === '' ? null : h('div', { className: 'dce-card-detail' }, record.lastUrl),
                  h(
                    'div',
                    { className: 'dce-card-actions' },
                    h(
                      'button',
                      { type: 'button', className: 'dce-button dce-button-primary', onClick: onReload },
                      t('goHome'),
                    ),
                    h(
                      'button',
                      { type: 'button', className: 'dce-button', onClick: openInBrowser },
                      t('openInBrowser'),
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dce-button',
                        onClick: () => {
                          record.oauthBlocked = false
                          notify()
                        },
                      },
                      t('dismiss'),
                    ),
                  ),
                )
              : null,
            record.diagOpen
              ? h(
                  'div',
                  { className: 'dce-card', role: 'dialog' },
                  h(
                    'div',
                    { className: 'dce-card-title' },
                    h('span', null, t('diagTitle')),
                    h('span', { className: 'dce-card-version', 'data-build': BUILD }, 'v' + BUILD),
                  ),
                  h(
                    'div',
                    { className: 'dce-card-detail' },
                    t('diagUrl') + ': ' + (record.lastUrl === '' ? guestUrl(record.element) || '—' : record.lastUrl),
                  ),
                  h('div', { className: 'dce-card-detail' }, t('diagRight') + ': ' + describeRightSidebar(t)),
                  h('div', { className: 'dce-card-detail' }, t('diagSeat') + ': ' + describeSeat(t)),
                  record.selfTest === ''
                    ? null
                    : h('div', { className: 'dce-card-detail' }, t('selfTest') + ': ' + record.selfTest),
                  h(
                    'div',
                    { className: 'dce-card-detail' },
                    t('diagPhase') + ': ' + phaseText(t, snapshot.phase) + (snapshot.detail === '' ? '' : ' · ' + snapshot.detail),
                  ),
                  h(
                    'div',
                    { className: 'dce-card-detail' },
                    t('partitionLabel') + ': ' + shortId(record.partition) + ' · #' + record.mounts,
                  ),
                  h(
                    'div',
                    { className: 'dce-card-detail' },
                    t('diagEvent') + ': ' + (record.lastEvent === '' ? '—' : valueText(t, EVENT_KEY, record.lastEvent)),
                  ),
                  h(
                    'div',
                    { className: 'dce-card-detail' },
                    t('logging') + ': ' + (logEnabled ? t('loggingOn') : t('loggingOff')),
                  ),
                  logEnabled
                    ? h(
                        'button',
                        {
                          type: 'button',
                          className: 'dce-button',
                          onClick: () => {
                            void copyText(JSON.stringify(readLogEntries(), null, 2))
                          },
                        },
                        t('loggingCopy'),
                      )
                    : null,
                  record.handoff === ''
                    ? null
                    : h('div', { className: 'dce-card-detail' }, t('diagHandoff') + ': ' + record.handoff),
                  h('div', { className: 'dce-card-body' }, t('diagHint')),
                  h(
                    'div',
                    { className: 'dce-card-actions' },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dce-button',
                        onClick: () => {
                          record.selfTest = runSeatSelfTest(t)
                          notify()
                        },
                      },
                      t('selfTest'),
                    ),
                    h(
                      'button',
                      { type: 'button', className: 'dce-button dce-button-primary', onClick: copyDiagnostics },
                      copyState === 'copied' ? t('copied') : copyState === 'failed' ? t('copyFailed') : t('copyDiag'),
                    ),
                    h('button', { type: 'button', className: 'dce-button', onClick: onReload }, t('reload')),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dce-button',
                        onClick: () => {
                          record.diagOpen = false
                          notify()
                        },
                      },
                      t('dismiss'),
                    ),
                  ),
                )
              : null,
          ),
        ),
      )
    }

    /** The left-navigation entry; inherits color so it follows the theme. */
    function ChatNavIcon(props) {
      const size = props !== undefined && props !== null && typeof props.size === 'number' && props.size > 0 ? props.size : 20
      const active = props !== undefined && props !== null && props.active === true
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: active ? 2 : 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          focusable: 'false',
          style: { display: 'block', opacity: active ? 1 : 0.82 },
        },
        h('path', { d: 'M4.2 6.6c0-1.2 1-2.2 2.2-2.2h11.2c1.2 0 2.2 1 2.2 2.2v7.9c0 1.2-1 2.2-2.2 2.2H10l-4.6 3.1c-.5.3-1.2 0-1.2-.7V6.6Z' }),
        h('path', { d: 'M8.2 9.4h7.6M8.2 12.8h4.8' }),
      )
    }

    // ------------------------------------------------------------------
    // Plugin record
    // ------------------------------------------------------------------

    // Test hook: dead code in the app, because dsh never sets this flag. It
    // lets the suite drive the lease handshake against a fake shell instead of
    // mounting the React UI.
    if (globalThis.__DSH_CHAT_EMBED_TEST__ === true) {
      globalThis.__DSHCE_TEST__ = {
        NS,
        PANEL_ID,
        PROVIDERS,
        DEFAULT_PROVIDER,
        ACTIVE_TAB_KEY,
        TAB_ORDER_KEY,
        BUILD,
        PHASE,
        DICTS,
        CSS,
        TIMINGS,
        isOAuthUrl,
        isGuestBlank,
        normalizedUserAgent,
        currentUserAgent,
        desktopBrowser,
        isEmbedSupported,
        shortId,
        isLiveUrl,
        findProvider,
        getStatus,
        watch,
        activeProvider,
        setActive,
        guestRecord,
        mountGuest,
        reloadGuest,
        destroyGuests,
        navigateGuest,
        startUrlFor,
        lastUrls,
        orderedProviders,
        getTabOrder,
        moveProvider,
        normalizeOrder,
        isEnabled,
        getEnabled,
        setProviderEnabled,
        providersInOrder,
        ENABLED_KEY,
        getSurface,
        formatDiagReport,
        copyText,
        ensureActiveGuest,
        inlineHosts,
        resolveInlineHost,
        hostsInline,
        inlineSeat,
        ChatCenterPage,
        updateSurface,
        getLogging,
        persistenceState,
        readPersistedSeen,
        storePersistenceSeen,
        livePartitionState,
        patchInstructions,
        fetchProbe,
        patchProbe,
        patchCheck,
        openPatchCheckSession,
        buildPatchPrompt,
        setLogging,
        clearLog,
        readLogEntries,
        log,
        preferSeat,
        ChatSurface,
        ChatNavIcon,
        ChatRightBody,
        ChatRightTitle,
        ChatDockButton,
        RIGHT_TAB_ID,
        RIGHT_TAB_KIND,
        RIGHT_TAB_SLOT,
        RIGHT_TAB_TITLE_SLOT,
        DOCK_SLOT,
        DOCK_ID,
        PANEL_ID,
        describeSeat,
        runSeatSelfTest,
        seatReportData,
        installInspect,
        formatRect,
        translator,
        rightTabType,
        openRightTab,
        rightSidebarStatus,
        setOpenRightTabImpl: (impl) => {
          openRightTabImpl = typeof impl === 'function' ? impl : () => {}
        },
      }
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        // A hot reload can apply this bundle again while the previous instance is
        // still alive. Its slots, tab type and observers would then block or
        // shadow ours (duplicate id, single-slot collision), so take over first.
        const carrier = typeof window !== 'undefined' && window !== null ? window : undefined
        const previous = carrier === undefined ? undefined : carrier[INSTANCE_KEY]
        if (previous !== undefined && previous !== null && typeof previous.dispose === 'function') {
          try {
            previous.dispose()
          } catch (error) {
            void error
          }
        }

        const disposers = []
        const disposeAll = () => {
          while (disposers.length > 0) {
            const dispose = disposers.pop()
            try {
              dispose()
            } catch (error) {
              void error
            }
          }
          if (typeof rightTabTypeDispose === 'function') {
            try {
              rightTabTypeDispose()
            } catch (error) {
              void error
            }
          }
          rightTabTypeDispose = undefined
          rightSeatsInstalled = false
          rightSeatAttempts = []
          rightTypeState = { state: 'idle', detail: '' }
          openRightTabImpl = () => {}
          try {
            destroyGuests()
          } catch (error) {
            void error
          }
        }
        if (carrier !== undefined) carrier[INSTANCE_KEY] = { version: BUILD, dispose: disposeAll }

        // Locale dictionaries first: the entry label reads them.
        disposers.push(ctx.effect(() => ctx.locale.register(NS, DICTS), 'dsh-chat-embed: dictionaries'))
        const t = ctx.locale.bind(NS)
        uiT = t
        if (typeof ctx.on === 'function') {
          // Switching the DSH language re-renders the panel immediately; a
          // language change never needs a reload.
          disposers.push(ctx.on('locale/change', () => notify()))
        }

        // Slots: the chat page in the center panel, its sidebar icon, the right
        // sidebar tab (body + chip title) and the session header button.
        disposers.push(
          ctx.effect(() => {
            const entries = [
            ctx.slots.inject('main', () =>
              ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS, registrant: 'dsh-chat-embed' }, ChatCenterPage),
            ),
            ctx.slots.inject('sidebar.panellist', () =>
              ctx.slots.register(
                {
                  name: 'sidebar.panellist',
                  id: PANEL_ID,
                  order: 30,
                  label: () => t('navLabel'),
                  locale: NS,
                  registrant: 'dsh-chat-embed',
                },
                ChatNavIcon,
              ),
            ),
          ]
            return () => {
              for (const dispose of entries) dispose()
            }
          }, 'dsh-chat-embed: entries'),
        )

        // Styles and the guests share one lifetime: unloading the plugin must
        // release every lease and leave no detached surface behind.
        disposers.push(
          ctx.effect(() => {
            const style = injectStyles()
            return () => {
              destroyGuests()
              if (style !== null && style !== undefined && style.parentNode !== null && style.parentNode !== undefined) {
                style.parentNode.removeChild(style)
              }
            }
          }, 'dsh-chat-embed: surface'),
        )

        // The right column is an optional neighbour. Wire it up in isolated
        // steps: a rejected seat or a service that shows up later must never
        // take the whole plugin (and its left entry) down with it.
        installRightSidebar(ctx, t)
        disposers.push(() => {
          while (rightDisposers.length > 0) {
            const dispose = rightDisposers.pop()
            try {
              dispose()
            } catch (error) {
              void error
            }
          }
        })

        // Read-only inspection channel: the live geometry can be read from the
        // Host without user interaction.
        const disposeInspect = installInspect(ctx, t)
        if (typeof disposeInspect === 'function') disposers.push(disposeInspect)
      },
    }
  },
})
