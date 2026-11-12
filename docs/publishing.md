# 发布与分发（维护者）

面向维护者的发版流程。用户安装请看 [README](../README.md#快速开始)。

## 版本与提交约定

- 同时改 `package.json` 的 `version` 与 `client.js` 的 `BUILD`，两者必须一致；
- 门禁必须绿：`npm run check`（`verify-bundle` + 83 项契约测试）；
- 代码注释/提交信息英文，文档中文。

## 发版步骤

```powershell
npm run check            # 门禁：verify-bundle + 83 项测试（prepublishOnly 也会跑）
npm run pack:dist        # 产出 dist\dsh-chat-embed-<版本>.tgz
gh release create v0.5.0 dist\dsh-chat-embed-0.5.0.tgz --title "v0.5.0" --notes-file dist\release-notes.md
```

`dist/` 与 `*.tgz` 已被 `.gitignore` 忽略；分发包只走 GitHub Release 资产。

发版后自检：

```powershell
gh release download v0.5.0 --pattern '*.tgz' --dir $env:TEMP\check
Get-FileHash $env:TEMP\check\dsh-chat-embed-0.5.0.tgz -Algorithm SHA256
```

## 当前发布物

| 项 | 地址 |
| --- | --- |
| 仓库 | <https://github.com/poluce/dsh-chat-embed> |
| Release | <https://github.com/poluce/dsh-chat-embed/releases> |
| 分发包 | `dsh-chat-embed-0.6.3.tgz`（16 个文件，约 70 kB） |
| npm | `dsh-chat-embed@0.6.3`（<https://www.npmjs.com/package/dsh-chat-embed>，维护者 `poluce_auto`） |
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
3. 发布：`npm publish`（`prepublishOnly` 自动跑门禁；包名 `dsh-chat-embed` 已发布 `0.5.4`）；
4. 使用者随后只需：`dsh plugin --profile desktop add dsh-chat-embed`。

## 发布前后检查项

- `engines.dsh` 与实测 dsh 版本一致（当前实测 `dsh --version` = `0.1.0-rc.6`）；壳升级改掉 slot / 服务名时要同步升版本；
- 改包名（例如加 npm 作用域）必须同步改 `cordis.patch.yml` 里 loader 行的 `name`（必须等于包名）；`id` 保持唯一即可；
- `repository` / `homepage` / `bugs` 当前指向 `github.com/poluce/dsh-chat-embed`；换账号或换仓库时改这三处；
- 发布后用一份干净 profile 验证：`dsh plugin --profile <新名字> add <包名>`，然后打开左栏入口；
- 可选壳补丁（跨重启免登录）不是安装必需项；不装补丁时功能完整，只是重启后要重新登录；
- npm 首次发布新包时会出现 `0.0.0-stage` 占位版本（staged publishing 机制），审核/发布完成后 `latest` 指向正式版本；占位版本可忽略；
- 账号 2FA 使用通行密钥（passkey），CLI 发布需要交互式终端完成 WebAuthn，或在 npm 网页创建 **Bypass 2FA 的 Granular Token** 后用 `npm publish --//registry.npmjs.org/:_authToken=<token>`；
- 带 Bypass 2FA 的直接发布能力 npm 计划 2027 年 1 月收紧，届时改用 trusted publishing 或 staged 流程。

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
