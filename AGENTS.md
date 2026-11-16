# AGENTS.md

给在本仓库工作的 agent（以及第一次接手的人）的说明书。

它只写**不写下来就一定会踩**的东西：哪些约束会真的坏东西、门禁会拦什么、改完怎么验。
用户向的说明在 [`README.md`](README.md)，内嵌契约与证据在 [`docs/architecture.md`](docs/architecture.md)，发版细节在 [`docs/publishing.md`](docs/publishing.md)。

本文件不随 npm 包发布。包里只有 README 一份文档：`docs/`、`AGENTS.md`、`assets/`、`scripts/`、`test/` 都只存在于仓库；门禁会拦住「又把 `docs` 加进 `files`」。

---

## 1. 这是什么

DSH 桌面版插件 `dsh-chat-embed`：左栏「聊天」面板 + 右栏标签，一个 webview 一个 AI 服务，各自一套登录态。

三个半侧，职责不许串：

| 半侧 | 文件 | 能做什么 | 绝不能做什么 |
| --- | --- | --- | --- |
| Client | `client.js` | 面板 UI、webview 租约、开关交互 | 碰文件、猜路径、开新会话问模型 |
| Host | `index.js` | 只读探针、起停补丁进程 | **写任何文件**（一个字节都不写） |
| 脚本 | `tools/shell-patch/shell-patch.mjs` | 改 `app.asar` 的**唯一写入者** | 索取除「退出 DSH」之外的操作 |

改功能前先看自己改的是哪一侧，越界就是设计错误，不是风格问题。

---

## 2. 命令

```powershell
npm run check     # 唯一门禁：打包检查 + 全部契约测试（提交前必须绿）
npm test          # 只跑测试
node scripts/verify-bundle.mjs   # 只跑打包检查
```

门禁自己会打印实际数量（跑一次就知道）。**别在别处写死这个数字，也别凭记忆引用**——README 与 `docs/publishing.md` 里「85 项」之类的旧数字就是这么过期的；要以门禁输出为准，不是以文档为准。

没有依赖、没有 lock 文件、**没有构建步骤**：`client.js` 就是最终产物，改了就是改了。

---

## 3. 目录地图

```
client.js                     Client 半侧（classic script，见 §4.5）
index.js                      Host 半侧（ESM，Node）
cordis.patch.yml              组合补丁：往 profile 插入 id=chat-embed 的 loader 行
package.json                  bundle manifest：dsh.bundle.patch / dsh.client.inject / files
locale/{zh,en}.json           插件管理器的标题与描述
icon.svg                      插件图标（不得引用远程资源）
scripts/verify-bundle.mjs     打包检查
scripts/release.mjs           一条命令发版
scripts/pack-dist.mjs         打 tgz 给 GitHub Release
test/fake-env.mjs             DOM + 桌面壳替身；整套测试的地基
test/{client,host,shell-patch}.test.mjs
tools/shell-patch/            补丁三件套：.mjs 全逻辑，.cmd / .command 只找 Node 和转参数
清理聊天缓存.cmd              一行壳：等价于 shell-patch.cmd cache
docs/                         架构与发版文档（中文，仅仓库，不进包）
```

**包里发什么**由 `package.json` 的 `files` 决定：共 13 个文件，文档只有 README 一份。

---

## 4. 硬约束

踩了这几条，坏的是**别人的 DSH 安装**，不是本仓库的测试。

### 4.1 `app.asar` 一律走 `original-fs`

Electron 的 `node:fs` 把以 `.asar` 结尾的路径当**压缩包**：

| 调用 | 结果 |
| --- | --- |
| `readFileSync('<install>/app.asar')` | ENOENT |
| `statSync` | 返回 **0** |
| `existsSync` | **false** |
| `writeFileSync` | `Invalid package` |

`index.js` 与 `shell-patch.mjs` 各自在进程启动时选一次真实 fs（有 `original-fs` 就用，普通 Node 用 `node:fs`）。
**不要**在别处直接 `import { existsSync } from 'node:fs'` 去判断 `app.asar`——那正是 0.6.13 之前探针在桌面版里误报「没有安装目录」的原因。

### 4.2 只有脚本写盘

Host 只负责判断（`started/same/denied/unsupported/noapp/failed`）和 `spawn`，脚本负责全部文件操作。
不要在 `index.js` 里加 asar 重建逻辑——那会变成两份实现，迟早对不上。

### 4.3 Host 路由只能是 GET

载体是 `@deepseek-ai/dsh-host-webserver`：它在路由匹配**之前**对非 GET/HEAD 直接 405，请求体根本不会被读取。
所以会改状态的 `GET /dsh-chat-embed/patch` 靠**探针下发的一次性 token** 把关，不是靠方法或请求体。

### 4.4 启动器有编码洁癖

- `shell-patch.cmd`：**纯 ASCII**、CRLF。批处理按控制台代码页读取，一个多字节字符就能让解析器崩（实测过 `'m' is not recognized...`）。测试里有断言。
- `shell-patch.command`：LF、无 BOM、git mode **100755**（`git ls-files -s` 可验）。
- 启动器只做三件事：找 Node、转参数、留住窗口。补丁逻辑一行都不许进去。

### 4.5 `client.js` 是 classic script，不是模块

文件必须以 `window.__ModuleLoader__.load({ id, factory(require) })` 开头，由 DSH 的模块加载器注入。
React 必须 `require('react')` 拿共享实例——自带一份副本会让 hooks 崩。

---

## 5. 测试

- 框架就是 `node --test`，**不引入任何依赖**。
- 测试夹具自己造 asar（`test/host.test.mjs`、`test/shell-patch.test.mjs` 都有 `buildAsar`）。**任何测试都不许读写真实安装目录**：跑门禁不该碰到你正在用的 DSH。
- 造 asar 时**必须写 `integrity`**（sha256 + 4 MiB 分块），否则「往返逐字节一致」断言会假失败。
- Client 测试通过 `test/fake-env.mjs` 安装 `window.__ModuleLoader__`，每个用例拿一个**新实例**（各自独立闭包），不要跨用例共享状态。
- **CI 跑在 ubuntu，本地是 Windows。** 任何按平台分叉的断言必须按平台守卫，否则会在 Linux runner 上红（`shell-patch.cmd` / `.command` 不存在就是这样翻的车）。文件本身可以无条件断言存在，因为它们随包发布。
- 需要子进程配合的用例（`--restart` 那组）必须**异步**驱动 CLI：`spawnSync` 会冻住事件循环，POSIX 上退出的子进程变成僵尸，`kill(pid, 0)` 依然成功，脚本就会一直等到超时。

---

## 6. 门禁会拦什么

`scripts/verify-bundle.mjs` 不是格式化工具，是**契约守卫**。改代码时别把这些当噪声删掉：

| 规则 | 为什么 |
| --- | --- |
| `client.js` 里不许出现 `setInterval` | 几何路径必须事件驱动，轮询会烧 CPU |
| `PROVIDERS` 每个 url 必须 `https://`、workspace 必须唯一 | 分区即登录隔离；重名会让两个服务共用登录态 |
| `files` 不许列 `docs`（也不许列别的文档目录） | 包里只发 README 一份文档；目录条目会连将来的草稿一起发出去 |
| `files` 必须列 `README.md` 与 `LICENSE` | npm 页面上唯一的说明与许可证 |
| `index.js` 必须有 `PATCH_PATH` 与 `spawnPatcher`，`client.js` 必须有 `startPatchAction` | 丢了就等于悄悄退回「复制命令」 |
| 交接补丁的路径里不许出现 `startSession` | 补丁不该经过模型判断 |
| `client.js` 的 `BUILD` 必须等于 `package.json` 的 `version` | 面板版本号撒谎是最常见的发布事故 |
| `locale` 的中英标题不得相同 | 相同就是漏翻 |
| `icon.svg` 不得引用远程资源 | 插件列表是静态页面 |

---

## 7. 改代码时

**生效方式**：`client.js` 热更新（刷新页面即可）；`index.js` 改了**必须重启 DSH**。本机 profile 是指向本仓库的 junction，所以改完不用重装。

**加一个聊天服务**：只往 `client.js` 的 `PROVIDERS` 追加一条（`id` / `label` / `url` / `origin` / 唯一 `workspace`），别处不用动。

**改版本号**：`package.json` 的 `version` 与 `client.js` 的 `BUILD` **两处必须同时改**（CI 与契约测试各拦一次）。

**面板 UI 的层级**：`.dce-tabs` 在 `top:0; z-index:4`，状态条原本也在 `top:0; z-index:2`——而「补丁待生效」这个状态会把标签栏钉住，于是提示条被它报告的东西盖住。加任何顶部浮层前先确认和标签栏的层叠关系，别让状态自己挡住状态的提示。

---

## 8. 样式约定

- **不写分号**，**2 空格缩进**，单引号。
- JSDoc 类型注释（`@param` / `@returns`）用于非平凡函数。
- 注释解释**为什么**，不解释**是什么**。历史坑要写进注释（「旧实现直接换回备份，一旦备份本身是补丁版就变成『点了关闭其实没关掉』」）。
- 代码与提交信息**英文**，文档**中文**。
- 提交信息格式：`area: imperative summary`（如 `client: put the pending-patch strip below the tab bar`），正文空一行后按 ~80 列折行，讲清「原来怎样 / 为什么错 / 现在怎样」。发版提交另用 `dsh-chat-embed <版本>:` 前缀。
- 删死代码，不要留「以防万一」的分支。

---

## 9. 提交与发版

- 直接对 `master` 提交推送，没有分支约定。
- 提交前跑 `npm run check`，并自己看一眼 `git status`（`dist/`、`*.tgz`、`*.log` 已被忽略）。
- **发版必须等用户明确指令**。`npm publish` 不可逆。
- 发版只有一条路：

```powershell
node scripts/release.mjs 0.6.14 --summary "一句话" --dry-run   # 先看计划
node scripts/release.mjs 0.6.14 --summary "一句话"
```

顺序固定：bump → gate → commit → push → 等 CI → publish（OIDC，不可逆，因此排在 tag 前）→ tag → release。
每一步先查「现在已经是真的了吗」，所以中途失败**重跑同一条命令即可续做**，不要手工补步骤。
夹具在 `dist/`，发版不靠本机 npm 令牌（Trusted Publishing，`publish.yml`，`workflow_dispatch`）。

---

## 10. 已知陷阱（都真实发生过，带着当时的证据）

1. **重复导航**：`navigateGuest` 每 350 ms 重设 `location.href`，而 `getURL()` 在提交前一直是 `about:blank`——第二次赋值取消了正在进行的加载，表现为同一页面加载两三次。改为「加载中只等不重发 + 20 秒总期限」。
2. **`ctx` 作用域**：组件在模块作用域，闭包里拿不到 `apply` 的参数，曾导致开关静默失败。现在用模块级 `activeCtx`，重装会覆盖它（这正好让热重载保持诚实）。
3. **脏备份**：`app.asar.orig` 本身是补丁版时，「还原」看着成功其实什么都没做。现在 `revert` 把两处字面量**反向写回**，完全不依赖备份；`apply` 也只在备份干净时才保留它。
4. **僵尸进程**：见 §5 最后一条。
5. **Electron fs**：见 §4.1。
6. **Linux CI**：见 §5。
7. **提示条被标签栏盖住**：见 §7。
8. **`detached` 不等于能活过 DSH 退出**：桌面壳把自己和它 spawn 的一切放进一个带 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 的 job，且不允许 breakaway。`detached: true` 只解除控制台和进程组，**不解除 job**，所以补丁进程恰好在它等待「DSH 退出」的那一刻被杀——`app.asar.new` 留在原地，`app.asar` 一个字节没动。实测两次：`spawn` 一次、`Win32_Process.Create` 一次（日志尾部是 `^C`）。现在 Windows 上改由计划任务启动（`svchost` 创建，在 job 外，但仍在交互会话里，所以重开窗口能落到桌面），POSIX 上 `detached` 才够用。**判断这类问题不要用 `IsProcessInJob(pid, NULL)`**——它只回答「在不在某个 job 里」，对任何 job 都返回 true，说明不了是不是 DSH 那个。
9. **改成计划任务后要清理**：任务在跑完自己删掉（`--task <名字>` → `forgetTask`），否则下次开机会再触发一次；重名的第二次点击靠 `Register-ScheduledTask -Force` 覆盖。

---

## 11. 环境

不要在这份文件、代码或别的文档里写死本机路径。每个人装 DSH 的位置都不一样，写死的路径除了让下一个人照着改一遍之外没有别的作用。

| 项 | 需求 / 怎么找 |
| --- | --- |
| Node | `>= 22.14.0`（`package.json` 的 `engines`）；CI 跑 22 与 24 |
| npm | `>= 11.5.1`（OIDC Trusted Publishing 的下限） |
| git | 任意版本（无 submodule、无 LFS） |
| dsh CLI | PATH 上的 `dsh`；不在 PATH 就用桌面版自带的那份（见下） |
| 本机 profile | `~/.dsh/profiles/<profile>`；其中 `node_modules/dsh-chat-embed` 通常是指向本仓库的 junction |
| 桌面壳安装目录 | **不写死**，用下面三条途径之一 |

### 找到桌面壳安装目录

```powershell
# 1. 环境变量：脚本与 Host 都优先认它（跨平台、最省事）
$env:DSH_RESOURCES = '<安装目录>\resources'
node tools/shell-patch/shell-patch.mjs status

# 2. 让脚本自己找：按平台常见位置探测，找不到会列出它试过的每个路径
node tools/shell-patch/shell-patch.mjs status

# 3. DSH 正在运行时，问 Host 的只读探针（最准，web 端口见 GUI 地址栏）
Invoke-RestMethod 'http://127.0.0.1:<port>/dsh-chat-embed/patch-check' | Select resources, asar, patched
```

`index.js` 的 `resourcesCandidates()` 已经把 `process.resourcesPath`（Electron 自己就是权威答案）、`$DSH_RESOURCES`、以及各平台常见安装位置都列进去了；**不要为了省一次探测就往代码里加固定路径**。

### 用壳自己的运行时跑脚本

Electron 与普通 Node 的 `fs` 对 `.asar` 的行为不同（§4.1），所以排查只读问题时，用壳的运行时跑一遍最接近真实环境：

```powershell
# Windows：exe 在 resources 的上一级
$exe = Join-Path (Split-Path $env:DSH_RESOURCES) 'DeepSeek Harness.exe'
# macOS：/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness

$env:ELECTRON_RUN_AS_NODE = '1'
& $exe tools/shell-patch/shell-patch.mjs status --resources $env:DSH_RESOURCES
Remove-Item Env:\ELECTRON_RUN_AS_NODE
```

> 开关在 Windows 上走的是计划任务（见 §10 第 8 条），任务里跑的就是这条命令的等价形式：DSH 自带的 Node + 这个脚本。所以「在真实环境里能跑」不是可选项。

---

## 12. 什么时候该更新本文件

踩到一个「下次还会踩」的坑时，加进 §10，写清现象 + 根因 + 现在的做法。
不要把它变成 README 的副本——用户怎么看功能，不属于这里。
