# 发布与分发（维护者）

面向维护者的发版流程。用户安装请看 [README](../README.md#快速开始)。

## 版本与提交约定

- 同时改 `package.json` 的 `version` 与 `client.js` 的 `BUILD`，两者必须一致（CI 与契约测试都会拦）；
- 门禁必须绿：`npm run check`（`verify-bundle` + 85 项契约测试）；
- 代码注释/提交信息英文，文档中文；
- 提交历史正常累积，**不再重写**：发版就是一次普通提交 + 普通 push。tag 不移动——它标记的是当时发布的那次提交。

## CI

`.github/workflows/ci.yml`：push 到 master、任何 PR、任何 `v*.*.*` tag 都会触发，Node 22 与 24 各跑一遍。

| 步骤 | 作用 |
| --- | --- |
| Gate | `npm run check`（bundle 检查 + 85 项契约测试） |
| Show the packed file list | `npm pack --dry-run`，让日志里能看见发出去的到底是什么 |
| Tag matches package.json version | 仅在 tag 触发时跑，tag 与版本不一致直接失败 |
| client BUILD matches package.json version | 面板显示假版本号是常见事故，这里显式拦一次 |

仓库没有运行时依赖，也没有 lock 文件，所以正常情况下 `npm ci` 会跳过；一旦加了依赖，锁文件出现后自动生效。

`.github/workflows/publish.yml`：发布专用，**只有手动触发**（`workflow_dispatch`）。它跑门禁、校验版本一致性，然后用 **OIDC Trusted Publishing** 发布，仓库和本机都不保存任何 npm 令牌。由 `scripts/release.mjs` 触发，也可以手动：

```powershell
gh workflow run publish.yml -f version=0.6.9
gh run watch
```

`.github/dependabot.yml`：每周一维护 `ci.yml` 里固定成 commit SHA 的 action。我们钉的是 `uses: owner/action@<40 位 SHA> # vX.Y.Z` 这种形式，Dependabot 认得行尾的版本注释，会把 SHA 换成新版本的完整 SHA 并同步更新注释。同周的 action 升级合成一个 PR。包本身没有依赖，所以没有声明 npm 生态。

## 发版步骤

一条命令：

```powershell
node scripts/release.mjs 0.6.7 --summary "一句话说明这次改了什么"
```

它按顺序做六件事。**顺序的理由：先发布，后打 tag。** 发布到 npm 是唯一不可逆的一步（72 小时后只能 deprecate），tag 与 Release 随时可删可重做；先做不可逆的，失败就停，不会留下"GitHub 有 Release、npm 没有包"的幽灵版本。

| 阶段 | 做什么 | 已经做过时怎么判断 |
| --- | --- | --- |
| bump | 改 `package.json` / `client.js` 的 `BUILD` / README 版本历史 / 两份文档 | 值相同就不动 |
| gate | `npm run check` | — |
| commit | `git add -A` + 普通提交 | 工作树干净则跳过 |
| push | 推送 master，触发 CI | — |
| ci | 等这次推送的 CI 跑完，红了就停 | — |
| publish | 触发 `publish.yml`，由 OIDC 在 CI 里发布 | registry 上已有该版本则跳过 |
| tag | 打 tag 并推送（CI 再校验一次） | tag 已存在则跳过 |
| release | `npm run pack:dist` + `gh release create` | Release 已存在则跳过 |

每个阶段都先检查现状，所以**中途失败后重跑同一条命令即可续做**，不会重复发布或重复建 tag。

常用变体：

```powershell
node scripts/release.mjs 0.6.7 --summary "..." --dry-run          # 只打印计划，不改任何东西
node scripts/release.mjs 0.6.7 --summary "..." --stop-after gate  # 做完 bump+门禁就停
node scripts/release.mjs 0.6.7 --summary "..." --notes dist\notes.md   # Release 用独立说明文件
```

每条提交只描述自己这次发布（`dsh-chat-embed <版本>: <summary>`）。项目长描述只留在历史第一条提交里，不再随版本重复。

### 手动等价步骤（脚本出问题时的兜底）

```powershell
npm run check                       # 1. 本地门禁
#                                   2. git add -A && git commit && git push
gh run list --repo poluce/dsh-chat-embed --limit 1   # 3. 等 CI 绿
gh workflow run publish.yml -f version=<版本>   # 4. 发布（OIDC，在 CI 里跑）
git tag v<版本>                      # 5. 打 tag 并推送
git push origin refs/tags/v<版本>
npm run pack:dist                   # 6. 打包 + 建 Release
gh release create v<版本> dist\dsh-chat-embed-<版本>.tgz --title "v<版本>" --notes-file dist\release-notes-<版本>.md
```

`prepack` 也挂了 `npm run check`，所以 `npm pack` / `npm publish` 两条路径都不会放过未过门禁的代码。0.6.5 及之前用的是 `prepublishOnly`，它只覆盖发布，GitHub Release 的 tarball 因此没有门禁。

`dist/` 与 `*.tgz` 已被 `.gitignore` 忽略。

发版后自检：

```powershell
npm view dsh-chat-embed version                    # 应等于 <版本>
npm audit signatures                               # 校验 provenance 签名
gh release download v<版本> --pattern '*.tgz' --dir $env:TEMP\check
Get-FileHash $env:TEMP\check\dsh-chat-embed-<版本>.tgz -Algorithm SHA256
```

## 已知的发版顺序债

0.6.5 及之前的版本是「tag → Release → publish」，与上面的顺序相反。已发布的历史无法回溯修正，从下一个版本起按新顺序执行。

## 发布凭证：OIDC Trusted Publishing

发布走 `.github/workflows/publish.yml`，用 **OIDC** 换取一次性的短期凭证。**仓库里、本机上都没有 npm 令牌可偷。**

### 在 npm 侧登记（一次性，只有包所有者能做）

1. npm 包设置页 → **Trusted Publisher** → 选 **GitHub Actions**；
2. 填三个字段：
   - Organization or user：`poluce`
   - Repository：`dsh-chat-embed`
   - Workflow filename：`publish.yml`（**只填文件名，含扩展名，且必须与仓库里的一致**）
3. Environment 留空（这个 workflow 没有用 GitHub Environment）；
4. 保存后在 **2 天内完成首次成功发布**，否则这条配置过期作废。

### CI 侧的要求（已在 workflow 里落实）

- job 带 `id-token: write`；
- 运行器是 GitHub-hosted（自托管不支持 OIDC）；
- npm ≥ 11.5.1（workflow 里固定装 `npm@11.15.0`）；
- **不设置** `NODE_AUTH_TOKEN` / `NPM_TOKEN`，残留令牌会干扰认证；
- `actions/setup-node` 刻意不传 `registry-url`，否则它会在 `.npmrc` 里写一行空的 `_authToken`。

### 为什么比令牌强

| | Granular token（旧） | OIDC（现在） |
| --- | --- | --- |
| 存在形态 | 40 字符静态串，存在 `~/.npmrc` | 每次运行现签，几分钟后失效 |
| 泄露后果 | 任何拿到的人在任何机器上都能发包 | 离开那次运行即无效 |
| 绑定 | 无 | 仓库 + workflow 文件名 + 分支 |
| provenance | 无 | 自动附带，用户可 `npm audit signatures` 验证 |

### 迁移后可以做的收尾

迁移验证通过后，去 npm 网页撤销那个 Bypass 2FA 的 Granular token，并把包设置收紧为"仅 Trusted Publishing"。这样即使旧 token 曾泄露也不再有价值。

提交历史正常累积之后，provenance 里的 commit SHA 长期可达，npm 页面上"source commit"链接不会失效。

## 当前发布物

| 项 | 地址 |
| --- | --- |
| 仓库 | <https://github.com/poluce/dsh-chat-embed> |
| Release | <https://github.com/poluce/dsh-chat-embed/releases> |
| 分发包 | `dsh-chat-embed-0.6.9.tgz`（16 个文件，约 70 kB） |
| npm | `dsh-chat-embed@0.6.9`（<https://www.npmjs.com/package/dsh-chat-embed>，维护者 `poluce_auto`） |
| 商店图标 | `assets/icon-180.png`（180×180 PNG） |
| 商店截图 | `assets/screenshots/` + 仓库根 `screenshots.json`（6 张） |

## 分发渠道

### 路线 A：不注册 npm（GitHub Releases / 直接给 tgz）

```powershell
dsh plugin --profile desktop add .\dsh-chat-embed-0.5.0.tgz   # 本地文件（已实测）
# 或： dsh plugin --profile desktop add <https://.../dsh-chat-embed-0.5.0.tgz>
# 或直接让别人从公开仓库装：
dsh plugin --profile desktop add git+https://github.com/poluce/dsh-chat-embed.git
```

### 路线 B：发布到 npm（可选）

1. 注册账号并完成邮箱验证：<https://www.npmjs.com/signup>；
2. 本机登录：`npm login`（浏览器确认或一次性密码；开了 2FA 输入验证码）；
3. 发布：`npm publish`（`prepack` 自动跑门禁；包名 `dsh-chat-embed` 已发布 `0.6.9`）；
4. 使用者随后只需：`dsh plugin --profile desktop add dsh-chat-embed`。

## 发布前后检查项

- `engines.dsh` 与实测 dsh 版本一致（当前实测 `dsh --version` = `0.1.0-rc.6`）；壳升级改掉 slot / 服务名时要同步升版本；
- 改包名（例如加 npm 作用域）必须同步改 `cordis.patch.yml` 里 loader 行的 `name`（必须等于包名）；`id` 保持唯一即可；
- `repository` / `homepage` / `bugs` 当前指向 `github.com/poluce/dsh-chat-embed`；换账号或换仓库时改这三处；
- 发布后用一份干净 profile 验证：`dsh plugin --profile <新名字> add <包名>`，然后打开左栏入口；
- 可选壳补丁（跨重启免登录）不是安装必需项；不装补丁时功能完整，只是重启后要重新登录；
- npm 首次发布新包时会出现 `0.0.0-stage` 占位版本（staged publishing 机制），审核/发布完成后 `latest` 指向正式版本；占位版本可忽略；
- 发布凭证走 OIDC，本机不需要任何 npm 令牌（见上文「发布凭证」）；本地 `npm publish` 已不再使用；
- 若临时需要兜底，只能在 npm 网页创建 Bypass 2FA 的 Granular token，用完立刻撤销——npm 计划 2027 年 1 月收紧该能力。

## 提交到插件列表（awesome-dsh-plugin）

- 列表只收一个条目文件 `data/plugins/<owner>__<repo>.yml`，README 由脚本生成，不要手改；
- 前置条件：`dsh.bundle` manifest、真实代码、仓库创建满 1 天、带 `dsh-plugin` topic、位图图标（SVG 不收）；
- 我们的条目：`category: ui`，`icon` 指向 `assets/icon-180.png`，`tarball` 指向 Release 资产；
- 投稿 PR：<https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/13872>（仓库满 1 天后自动通过年龄检查）。

## 截图维护

`assets/screenshots/` 里是 1600×1027 的 PNG（由原始 2564×1646 截图缩放而来），顺序即 `screenshots.json` 的顺序：

1. `01-deepseek-left-panel.png` / `02-chatgpt-left-panel.png` / `03-gemini-left-panel.png` / `04-grok-left-panel.png` —— 左栏中央面板；
2. `05-deepseek-right-tab.png` / `06-gemini-right-tab.png` —— 右栏聊天 tab。

界面改动较大时重新截图，保持同样的尺寸与命名即可；README 与商店详情页用的是同一批文件。
