# 架构与内嵌契约（dsh-chat-embed）

本文记录 `client.js` 里每一条**反直觉**的实现决策、支撑它的证据，以及升级桌面壳时必须重新验证的清单。

目标运行环境：**`@deepseek-ai/dsh-desktop 0.2.2-rc.1`（Electron / Chromium）**。
当前实现：**v0.6.7**（`client.js` 约 3985 行，85 项契约测试）。

> **架构一句话**：聊天页直接渲染在**席位的布局盒**里（`.dce-panel.dce-inline`，`width/height:100%`），几何完全交给 CSS；席位只有两个 —— 中央主面板（`main`）和右栏聊天 tab —— 二者互斥，**哪边点哪边接管**，切换时 guest 重建一次并回到上次会话。

---

## 0. 结论速览

| 问题 | 结论 |
| --- | --- |
| 能用 iframe 吗 | ❌ 站点返回 `frame-ancestors 'none'`，任何源都拒绝被嵌入 |
| 能用 `<webview>` 吗 | ✅ 但必须持壳下发的**租约**，且三个属性完全一致 |
| 插件能拿到租约吗 | ✅ 客户端插件 bundle 以**同源 classic script** 注入，跑在 Electron 主世界，能读 `window.dshDesktop` |
| 挂上以后怎么导航 | 只能从 guest **文档内部**导航（`location.href`）；`loadURL()` / 改 `src` 无效 |
| 登录态能撑多久 | 未打壳补丁：仅本次运行有效；**打补丁后**每个服务固定 disk 分区，跨重启免登录 |
| 切换标签要重载吗 | 不用：guest 常驻，切标签只切 `data-active`（`display:none`） |
| 切席主要重载吗 | 会重建一次（WebContents 随 DOM 销毁），随后用 `startUrlFor()` 回到上次会话地址 |
| 两个席位能同时显示吗 | ❌ 互斥：右栏属于会话视图，中央打开聊天面板后右栏不可用 |
| 多标签怎么隔离 | 每个服务一个 `workspace` 身份 → 独立分区（独立 cookie 罐）；每个服务一个 guest，各自一条租约 |

---

## 1. 证据来源

本文的事实不是从参考插件抄的，而是从本机安装的桌面壳产物里反查出来的：

| 证据 | 位置 | 内容 |
| --- | --- | --- |
| `webviewTag` 开启 | `app.asar/lib/main.js`（主窗口创建处） | `webviewTag: primary` —— 主应用窗口允许 `<webview>` |
| 租约门禁 | `app.asar/lib/main.js`，`DesktopBrowserGuests.bind()` | `will-attach-webview` 校验 `src === about:blank#<lease>`、`partition === lease.partition`、租约未用过 |
| 租约签发 | 同文件 `DesktopBrowserGuests.acquire()` | 每个 workspace 身份缓存一个 `dsh-sidebar-browser-<uuid>` 分区；每次 acquire 发新 `lease` |
| 渲染进程桥 | `app.asar/lib/preload-app.cjs` | `contextBridge.exposeInMainWorld('dshDesktop', …)`，其中 `browser.acquire / release / onOpenRequested` |
| bundle 注入方式 | `@deepseek-ai/dsh-client-modules/lib/client.js` | `defaultLoadBundle` 用 `document.createElement('script')` 注入 → 主世界执行 |
| 中央面板渲染 | `@deepseek-ai/dsh-client-ui-layout/lib/client.js` | `renderSlot("main", {}, { entryKey: panelId ?? "conversation" })` |
| 右侧栏互斥 | 同壳 `sidebarRight` 服务 | 没有会话表面时 `openTab()` 抛 `no session surface is mounted` |

> 备注：0.2.0-rc.2 与 0.2.2-rc.1 的租约门禁实现一致；0.2.2-rc.1 额外把 `allowPopups` 相关偏好清空，只保留 `disablePopups`。

---

## 2. 为什么 iframe 必然失败

```text
$ curl -sI https://chat.deepseek.com/
content-security-policy: frame-ancestors 'none'
```

dsh Web GUI 跑在自定义协议/HTTP 源上，被 `frame-ancestors 'none'` 直接拒绝。这不是配置问题，浏览器内核层面无解。

`<webview>` 是独立的顶层 WebContents，不受该指令约束 —— 这是唯一可行的嵌入容器，也决定了**功能只存在于桌面版**。

---

## 3. 租约门禁：三个必须同时成立的条件

壳在 `will-attach-webview` 里校验，任何一条不满足就**直接拒绝挂载**（元素留在 DOM 里但不导航，诊断里表现为一直 `about:blank`）：

1. `src` 恰好是 `about:blank#<lease>`；
2. `partition` 恰好是该租约签发的 partition；
3. 租约**未被使用过**（一次性）。

因此 `mountGuest()` 的顺序被固定为：`acquire(workspace)` → 用返回的 lease 建元素 → 绑定监听 → 插进宿主 → 从文档内部导航。**重试必须换新租约**，旧租约不可复用。

### 3.1 `params.useragent` 为什么能活下来

壳只清理 `allowPopups` 一类偏好，没有清 `useragent`，所以元素上的 `useragent` 属性生效 —— 这是绕过「使用环境异常」风控的前提。

---

## 4. 插件为什么能拿到主世界桥

客户端插件 bundle 通过 `document.createElement('script')` 注入，**不是** ESM、也不走 preload 的隔离世界，所以：

- `window.dshDesktop` 直接可读；
- `require('react')` 拿到的是壳共享的那一份 React（装第二份会破坏 hooks）；
- 因此本插件不需要任何 Host 侧配合（`index.js` 目前是空壳）。

---

## 5. 登录态的边界

壳的 `acquire()`（**未打补丁时**）：

```text
partition = "dsh-sidebar-browser-" + randomUUID()   // 无 persist: 前缀
partitions.set(workspace, partition)                // 仅进程内缓存
```

三个结论：

1. **分区是内存分区**：Electron 只对 `persist:` 前缀的分区落盘；
2. **分区名每次启动重新随机**：即使落盘也无法命中上一次的分区；
3. 因此「登录一次、长期复用」**只在同一次应用运行内成立**（跨面板切换、跨页面刷新、跨 HMR 重载都有效）。

插件侧无法绕过：租约与分区都由主进程签发，渲染进程只能照单接收。

### 5.1 为什么「自己备份 cookie」也不行

登录态落在 `ds_session_id` / `HWWAFSESID` / `HWWAFSESTIME` 这些 **HttpOnly** cookie 上（站点响应头实测）：

```text
Set-Cookie: ds_session_id=…; Path=/; HttpOnly; Secure; SameSite=Strict
```

HttpOnly 对 guest 页面的 `document.cookie` 不可见，而插件只拿到 `<webview>` 元素、拿不到它的 `session` 对象（没有 cookie API）。所以「登录后导出 cookie、下次注入恢复」这条路在渲染进程里走不通。

更关键的是：**DeepSeek 的登录态根本不在 cookie 里**，而在 IndexedDB / localStorage；因此唯一正确的解法是**让分区落盘**。

### 5.2 壳补丁（`tools/shell-patch/`）

`patch-asar.cjs` 改 `resources/app.asar` 里 `lib/main.js` 的两处：

```js
// 1) 稳定、持久的分区名
partition = `persist:dsh-sidebar-${createHash('sha256').update(workspace).digest('hex').slice(0, 24)}`

// 2) 关掉磁盘缓存（登录态不受影响）
this.configureSession(session.fromPartition(partition, { cache: false }))
```

效果与代价：

| 项 | 结果 |
| --- | --- |
| 分区位置 | `<userData>/Partitions/dsh-sidebar-<sha256(workspace)[0..24]>/` |
| 跨重启登录 | ✅ 首次重启需登录一次，之后免登录 |
| 单次启动写入 | ≈13 MB → ≈0.09 MB（`Cache` 零新增，`Code Cache` 约 0.02 MB） |
| 副作用 | 壳自带右侧栏浏览器也变成持久分区 |
| 升级风险 | 客户端升级会覆盖 `app.asar`，**必须重打**；`restore-shell-patch.cmd` 可还原 |

> 补丁丢失时插件行为不变，只是回到"每次重启重新登录"。
>
> 插件侧只能**检测**补丁是否存在：guest 拿到的分区以 `persist:` 开头即已开启，否则是内存分区；结果记进 `localStorage['dsh-chat-embed:persist']`，设置菜单在重启后立即显示该状态。壳在 `acquire(workspace)` 里只接收 workspace，分区名由主进程决定，渲染进程没有任何接口能在运行时切换，所以菜单里只有状态与「复制补丁说明」，没有可点的开关。

---

## 6. 导航：只有一条路

guest attach 后停在 `about:blank#<lease>`。实测/契约：

| 方式 | 结果 |
| --- | --- |
| `el.loadURL(url)` | ❌ 静默无效 |
| `el.setAttribute('src', url)` | ❌ 静默无效 |
| `el.executeJavaScript('location.href = …')` | ✅ 文档级导航，触发 `will-frame-navigate` |

并且**第一次 `dom-ready` 可能早于壳完成租约绑定**，所以 `navigateGuest()` 采用「最多 5 次、每次间隔 350ms、以 `getURL()` 是否到达目标源为准」的重试模型。到达目标源（含 `/sign_in`）即视为 `ready`。

导航守卫：壳的 `will-frame-navigate` 只允许 `http(s)`、无 userinfo、且不是 dsh Host 自身 —— 各服务站点天然在允许范围内。

---

## 7. UA 归一化

默认 Electron UA 含 `Electron/<ver>` 与 `dsh-desktop/<ver>`，`chat.deepseek.com` 会叠加「使用环境异常」风控弹窗。

实现上不写死 Chrome 版本，而是**运行时从 `navigator.userAgent` 里过滤掉 `electron/`、`dsh-desktop/`、`deepseek-harness/` 三个 token**，保留其余部分；过滤后为空时退回内置的 Chrome UA。这样壳升级换 Chromium 版本时不用改插件。

---

## 8. Slot 契约要点

| 事实 | 说明 |
| --- | --- |
| `ctx.slots.register(options, Component)` | 两参数；目标 slot 在 `options.name`；不是三参数 |
| list slot 必须有 `id` | `sidebar.panellist` / `conversation.session.header.utilities` 属 list |
| keyed slot 必须有 `key` | `main`、`sidebar.right.pane.tab` 属 keyed |
| 注册别人的 slot 必须 `ctx.slots.inject(key, cb)` | 声明未就绪时 `register` 会抛错；`inject` 会等声明出现再执行、声明消失自动回收 |
| `registrant` 可选 | 写进去之后 `cordis_inspect_query(Slots)` 的 `occupants` 会显示插件名，便于排查 |
| `locale: NS` | 声明后组件 props 多一个 `t()`；`label` 传 thunk 可跟随语言切换而不重注册 |

本插件的五处注册：

```js
// 中央主面板：聊天页本身
ctx.slots.inject('main', () => ctx.slots.register(
  { name: 'main', key: 'chat-embed', locale: NS, registrant: 'dsh-chat-embed' }, ChatCenterPage))

// 左侧栏图标
ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
  { name: 'sidebar.panellist', id: 'chat-embed', order: 30, label: () => t('navLabel'),
    locale: NS, registrant: 'dsh-chat-embed' }, ChatNavIcon))

// 右栏聊天 tab：tab 类型走 sidebarRightTabs 服务，body 与 chip 标题走 slot
ctx.get('sidebarRightTabs').register(rightTabType(t('rightTabTitle')))   // id: 'dsh-chat-embed', kind: 'chat-embed'
ctx.slots.inject('sidebar.right.pane.tab', ...)          // ChatRightBody
ctx.slots.inject('sidebar.right.pane.tab.title', ...)    // ChatRightTitle

// 会话标题栏右侧的「⧉」按钮（list slot）
ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register(
  { name: 'conversation.session.header.utilities', id: 'chat-embed-dock', order: 60,
    locale: NS, registrant: 'dsh-chat-embed' }, ChatDockButton))
```

**不需要**在插件 `inject` 里写客户端服务名之外的东西：`inject: ['slots', 'locale']` 即可；跨模块依赖写在 `package.json` 的 `dsh.client.inject`。

---

## 9. 多标签模型：一服务一 guest、一分区

### 9.1 数据模型

`PROVIDERS` 是唯一需要维护的清单，每条记录五项：

| 字段 | 作用 | 约束 |
| --- | --- | --- |
| `id` | 标签 id，同时用于 `data-provider` 与分区命名 | `^[a-z0-9-]+$`，全局唯一 |
| `label` | 标签文字 | 非空 |
| `url` | 首次打开时导航到哪 | `https://` |
| `origin` | 站点基址（用于诊断与后续策略） | 必须是 `url` 的前缀 |
| `workspace` | 壳的**存储身份** = 分区键 | 全局唯一，且**一旦发布不可改**（改了就退出登录） |

门禁（`scripts/verify-bundle.mjs`）会检查唯一性、`https`、以及"运行时只允许出现注册表里声明过的外部站点"，防止漏配或偷偷请求别处。

### 9.2 一服务一 guest

```text
guests: Map<providerId, {
  lease, partition, mounts, mountsThisRun,
  layer, element, status, lastUrl, handoff, oauthBlocked,
  detachTimer, recoveryTimer, diagOpen, selfTest, lastEvent,
}>
```

- `element` 是 `<webview>`；`layer` 是包住它的 `.dce-guest-layer`。
- **只有当前激活的标签可见**（`data-active="true"`），其它层 `display:none` —— 元素不移动，所以草稿、滚动位置、会话都保留。
- `lastUrl` 记录 guest 最后停留的可用地址，供席位切换后 `startUrlFor()` 恢复。

### 9.3 内存与取舍

每个点亮的标签 = 一个完整 webview = 一个渲染进程。默认只点亮当前标签；7 个全开会明显吃内存。`⚙ 设置` 可以整体禁用某些服务（至少保留一个），禁用时释放其租约。

### 9.4 `keepMounted` 与右栏

右栏 tab 类型声明 `keepMounted: true`：切到别的右栏 tab 时 body 不卸载，guest 与其状态保留 —— 与壳自带浏览器、终端面板同机制。中央面板没有这个待遇（选别的主面板就卸载），这是两个席位的本质差异。

---

## 10. 席位模型：内联宿主与"哪边点哪边接管"

### 10.1 为什么必须内联

**Electron 在 `<webview>` 离开 DOM 时立即销毁其 WebContents**：重新插入等于重建，且无法"搬家"（搬 = detach + attach）。所以聊天页不能"先放别处、需要时挪进面板"，只能**渲染在席位自己的布局盒里**：

```text
.dce-panel.dce-inline        position:relative; width:100%; height:100%; overflow:hidden
  .dce-surface               position:absolute; inset:0; display:flex; flex-direction:column
    .dce-tabs                标签条（可拖动排序）
    .dce-status-bar          状态行（仅在加载中/失败时出现）
    .dce-viewport            宿主视口（flex:1）—— 注册为 inlineHosts[seat]
      .dce-guest-layer       每个服务一层；非激活层 display:none
```

拖分隔条时浏览器做一次原生布局，**零 JS 测量、零 React 重渲染**。`dragProbe` 实测 `397 → 445 → 397`，`guestFollowed=true`。

### 10.2 两个席位

| 席位 | 注册位置 | 生命周期 | 承载条件 |
| --- | --- | --- | --- |
| `main` | `main` slot（`key: 'chat-embed'`） | 选中该面板时挂载，切走即卸载 | 用户点左栏入口 |
| `right` | 右栏 tab body | 右栏打开且 tab 选中；`keepMounted` | 用户点右栏「聊天」tab |

二者互斥：右栏属于**会话视图**，中央换成聊天面板后右栏会报 `no session surface is mounted`。

### 10.3 接管规则

```text
preferredSeat        用户最近一次"点开"的席位（挂载时写入；右栏 tab 被选中时也写入）
inlineHosts[seat]    该席位已挂载的宿主视口
inlineSeat()         按 [首选, 另一席位] 顺序挑第一个"可用"的席位
hostArea(host)       宿主是否真的有面积（0×0 的收起右栏不算可用）
```

两个细节决定了实际体验：

1. **首选席位在注册前也算宿主**。否则会出现死锁：面板挂载时想认领 guest，但"认领"要求宿主已注册，而注册只发生在"开始承载"之后。
2. **零尺寸只允许中央面板**。刚挂载的中央面板有一帧是 0×0（正常），而收起的右栏永远是 0×0 —— 把页面搬进去就等于白屏。右栏展开时由 `ResizeObserver` 重新判定一次席位。

### 10.4 切换的代价与恢复

席位变化 → 旧宿主里的 guest 元素随 DOM 销毁 → `dropGuestsOutside()` 丢弃记录 → 在新宿主 `mountGuest()` 重建（新租约、同分区）→ `startUrlFor()` 用 `lastUrl` 回到上次会话。

- 只需一次页面加载，**不需要重新登录**（分区不变）；
- 同源且地址仍可用才复用 `lastUrl`，否则回到服务入口；
- 迁移失败（例如站点把会话 URL 改成一次性）时退回入口，行为与首次打开一致。

---

## 11. 每个标签的生命周期

```text
idle → acquiring → navigating → ready
                  ↘           ↘
                   failed ← (retry acquires a *fresh* lease)
```

- `acquiring`：`browser.acquire(workspace)` 申请租约；
- `navigating`：创建 `<webview>` 并从文档内部导航；
- `ready`：到达目标源；
- `failed`：租约被拒、导航超时、崩溃 —— 只影响该标签，其它标签不受影响。

### 11.1 OAuth 与弹窗

壳的 `disablePopups` 让我们无法真正开弹窗（`allowpopups` 仍在元素上，但主进程禁弹窗），所以：

- 站点用 `window.open` 打开的登录页：插件捕获 `new-window` 事件，把 URL **在同一 guest 里继续**（`navigateInPlace`）；
- Google 的 `gsi/transform` 交回页是**死路**（没有 `window.opener`，凭据无法交回）：检测到后 `record.oauthBlocked = true`，自动退回站点入口并显示说明卡片；用户可用邮箱登录；
- 恢复期间用 `TIMINGS` 里的四个延迟（落地、空窗观察、凭据探测、恢复重载）控制节奏，不轮询。

---

## 12. 诊断与探针

`⚙` 菜单里的「标签页诊断…」卡片与 Inspect Provider 共用一套读数：

| 探针/字段 | 内容 |
| --- | --- |
| `seatReport` | `build` / `mode: 'inline'` / `seat` / `host`（席位宿主矩形）/ `guest`（present、webviews、layers、active、hostBox）/ `right`（右栏注册状态）/ `selfTest` |
| `dom` | `.dce-panel.dce-inline` 数量、`webview` 数量、工具行按钮数、日志开关、持久化状态、各席位是否已注册、当前首选与宿主席位 |
| `layout` | `layout` 服务的键、`hasMainPanel('chat-embed')`、左栏导航 DOM 条目 |
| `log` | 调试日志开关与最近 50 条环形缓冲；`{ enabled: true/false }` 开关，`{ clear: true }` 清空。默认关闭，关闭时不打印也不缓冲 |
| `locale` | 当前活跃语言（`active`）、可用语言列表、`<html lang>`，以及面板文案当前解析出的样例（`sample` / `zhSample` / `enSample`） |

Host 半侧另有两条只读通道，专门用来回答"为什么重启后要重新登录"：

| 通道 | 内容 |
| --- | --- |
| `GET /dsh-chat-embed/patch-check` | 安装目录、`app.asar` 是否可写、是否已打补丁、补丁点是否还存在、备份与待替换文件、大小与内容哈希、**可执行的补丁命令**（含自带 Node 运行时路径与 `--resources`） |

客户端拿到探针结果后不再内联渲染，而是通过 `uiWorkspace.startSession(undefined, { prompt, whenDraftExists: 'append' })` 打开一个新会话，把事实与授权边界写进草稿；用户点发送即可。这与 DSH 自身「创建你的插件」入口用的是同一个 API，`whenDraftExists` 的取值语义在 `dsh-client-ui-conversation` 的 `requestDraftInitialization` 里定义（`replace` / `keep` / `append`）。
| agent 工具 `dsh_chat_embed_patch_check` | 同一份读数，供模型直接查询（只读，无需审批） |

> 读取 `app.asar` 必须走 Electron 的 `original-fs`：被补丁过的 `node:fs` 会把以 `.asar` 结尾的路径当成目录，`readFileSync` 直接 ENOENT。探针优先用 `original-fs`，普通 Node 下回落到 `node:fs`。
| `openPanel` | 选中中央面板（等价于点左栏图标；探针路径不等于真实点击，见下） |
| `openRight` | 展开右栏并打开聊天 tab，报告每一步的错误 |
| `prefer` | 把席位偏好切到 `main` / `right`，返回解析后的席位与宿主 |
| `handles` | 右栏注册状态与各 seat 的尝试结果 |
| `dragProbe` | 用合成指针拖动右栏分隔条再复位，报告宿主与 guest 宽度是否跟随 |

> 注意：`openPanel` 调用的是 `layout.selectPanel()`，走的是服务层状态；真实点击走侧栏面板列表自己的 store 路径。两者渲染时机不一定一致，**判断用户视角是否正常要以真实点击为准**。

### 12.1 调试日志（默认关闭）

日志分三处消费，开关只有一个：

| 出口 | 内容 |
| --- | --- |
| 控制台 | `[dsh-chat-embed] <ISO 时间> <级别> <事件>` + 结构化 detail |
| 环形缓冲 | 最近 200 条；菜单「调试日志」一行的「复制日志」导出完整 JSON |
| Inspect 探针 | `log`：读开关与最近 50 条；`{ enabled: boolean }` 开关，`{ clear: true }` 清空 |

默认关闭（`localStorage['dsh-chat-embed:log']` 不存在或不为 `1`）：不打印、不缓冲，零开销。开关入口在「⚙」菜单（工具行只保留重新加载 / 外开 / 设置）；状态持久化，下次启动沿用。

记录点覆盖：租约获取、重新加载、加载失败、渲染进程崩溃、席位偏好 / 宿主解析、右栏 slot 注册失败、服务启停。不记录用户输入、URL 凭据或页面内容。
---

## 13. 升级桌面壳时的复验清单

按顺序跑，前一项失败就不要继续：

1. `main` 窗口仍 `webviewTag: primary`；
2. `DesktopBrowserGuests.bind()` 的校验仍是 `src === about:blank#<lease>` + `partition` + 未使用；
3. `acquire()` 返回的 partition 仍是**内存**分区（或补丁重打成功，出现 `persist:`）；
4. `preload-app.cjs` 仍暴露 `window.dshDesktop.browser.acquire / release / onOpenRequested`；
5. `main` / `sidebar.panellist` / `sidebar.right.pane.tab` / `conversation.session.header.utilities` 四个 slot 的注册选项（`key` / `id` / `order` / `label`）是否变化；
6. `will-frame-navigate` 的允许范围是否仍包含各服务站点；
7. 右栏 `sidebarRight.openTab()` 在会话视图里可用、在聊天面板打开时**不可用**（互斥是预期行为）；
8. `seatReport`：左栏入口挂载后 `seat=main`、`guest.present=true`、`host` 尺寸等于中央区域；
9. `dragProbe`：`guestFollowed=true`，拖动前后宽度变化一致；
10. 重启应用后 `build` 正确、右栏 tab 类型注册成功、左栏入口可点开。

---

## 14. 扩展点（与 README 路线图对应）

| 扩展 | 做法 | 当前状态 |
| --- | --- | --- |
| 多壳适配 | 抽象 `desktopBrowser(scope)`，为 Tauri / 自定义原生协议实现同名接口 | 仅 Electron |
| 可关闭标签 | 关闭时 `releaseLease` 并删除 layer；顺序表同步 | 未做（现在只能 `⚙` 禁用） |
| 服务列表可配置 | 把 `PROVIDERS` 迁到 Host `Config`，客户端读 ctx 配置 | 未做（现在改代码 + 重跑门禁） |
| 内存策略 | 记录最后使用时间，LRU 回收长时间未用的 guest，切回重建 | 未做 |
| 模态让位 | 检测 `role="dialog"[aria-modal]` 时临时隐藏聊天页 | 未做（Electron 下 DOM 弹窗本就压得住 webview） |
