# Windows 修复与 macOS 适配审查

日期：2026-11-04。基线：`733769b` / 0.1.14。本文记录纳入 0.1.15 的跨平台改进与验证边界。

## 已修复的问题

| 优先级 | 原问题与用户影响 | 修改 |
|---|---|---|
| P1 | npm 锁定依赖报告 5 个受影响依赖，包括严重/高危项 | 升级 DOMPurify、markdown-it、Vite 与相关依赖，重建锁文件并重新审计 |
| P1 | Windows 管理员重启被原实例的单实例锁拦截，随后两个实例都退出 | 新管理员实例先等待旧进程退出，再检查单实例锁 |
| P1 | Git 把中文路径、首尾空格和文件名中的 ` -> ` 当成转义或重命名语法 | 改用 `--porcelain=v1 -z`；文件操作使用 literal pathspec |
| P1 | SFTP 下载直接拼远端文件名，Windows 的反斜杠、盘符、ADS 等可能写到错误位置 | 验证顶层和递归文件名，拒绝已有符号链接/目录联接目标及 Windows 非法文件名 |
| P1 | 传输仅凭大小判断可续传或已完成，不同内容可能被拼接或跳过 | 续传前逐块核对已有前缀；大小相同也验证内容。代价是续传会增加读取流量 |
| P1 | 更新包选择不区分平台/CPU，甚至可能把独立 exe 当安装器；缺少摘要仍能继续 | 使用 Rust 报告的运行系统/架构选包；禁止跨平台/架构回退；一键更新必须有合法 SHA-256 |
| P2 | SFTP 与 SSH 对别名、默认用户名、端口 0 的理解不同 | 读取同一份 `ssh -G` 生效配置再建 SFTP 连接；不支持的 ProxyCommand 给出明确提示 |
| P2 | herdr 安装上传对 OpenSSH 8/9 的路径引号行为不同，且漏传显式跳板机 | 生成不需引号的安全临时路径并保留 ProxyJump；密码模式改走 SFTP |
| P2 | 本地终端启动失败后仍显示“连接中”，检查更新可能一直等待，普通 URL 被误拦 | 失败状态明确显示；更新请求设超时；解析 http/https URL 后直接调用系统浏览器 |
| P2 | Mac 仍显示 Windows 凭据、路径和管理员入口，窗口有无功能的仿控制按钮 | 提供平台对应入口和文案、原生复制粘贴快捷键，并移除仿控制按钮 |

## 两个平台哪些路径相同，哪些不同

| 用途 | Windows | macOS |
|---|---|---|
| 检查版本的远程地址 | `https://api.github.com/repos/zeelinkCN/ZeeAI_Term/releases/latest` | 相同 |
| 下载附件 | 匹配运行架构的 `*_x64-setup.exe` / `.msi` 或便携 zip | 优先 `*_universal.dmg`，其次匹配 `aarch64` 或 `x64` 的 DMG |
| 自动安装 | 安装版使用独立更新辅助进程，大小、文件头、摘要全部检查 | 当前版本手动替换 Applications 中的 app，不执行 Windows 更新程序 |
| 配置、连接、历史 | `%APPDATA%\ZeeAI-Terminal` | `~/Library/Application Support/ZeeAI-Terminal` |
| 启动与应用日志 | `%LOCALAPPDATA%\com.zeeai.terminal\logs` | `~/Library/Logs/com.zeeai.terminal` |
| SSH 密钥、配置 | 用户目录中的 `.ssh` | `~/.ssh` |
| SSH 密码 | Windows 凭据管理器 | macOS 钥匙串 |
| 本地 shell | PowerShell / PowerShell 7 / CMD / WSL | zsh / bash，默认从用户家目录启动 |
| Android 工具 | 随 Windows 包分发 | 使用已安装的 Platform Tools，支持常见 SDK 路径、ANDROID_HOME / ANDROID_SDK_ROOT |
| herdr 远端位置 | Linux 服务器的 `$HOME/.local/bin/herdr` | 相同；二进制按远端 `uname` 选择，与本地电脑平台无关 |

两台电脑共用 Release API 是正常的；安装文件地址必须不同。已有版本没有当前平台安装包时，界面明确说明原因并提供发布页入口，不下载另一平台的文件。服务器上的路径使用服务器的规则，不把 Windows 盘符或 Mac 家目录直接用于服务器安装。

## 构建与发布

`.github/workflows/desktop.yml` 在 Windows 运行后端测试、Edge 功能测试与 NSIS/MSI 打包；在 Mac 运行后端测试并生成 Universal DMG。安装包保存在 Actions Artifacts，工作流不自动发布 Release。公开仓库的标准 GitHub 托管 runner 可免费使用，参见 [GitHub 文档](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)。

Windows 资源和安装目标独立放在 `tauri.windows.conf.json`，Mac 使用 `tauri.macos.conf.json`。Windows 的 adb.exe、DLL、图标格式不会被带进 Mac 包。Mac 使用系统 WKWebView，前端编译目标同时覆盖 Chrome 与 Safari。

本地构建应先装 Node.js 22.18+、Rust stable 与相应系统工具，再运行：

```sh
npm ci
npm run test:platform
npm run test:ai
npm run check:docs
npm run build
node scripts/ai-monitor-smoke.mjs
cargo test --locked --lib --manifest-path src-tauri/Cargo.toml
npm run tauri build
```

## 验证边界与后续事项

- 本地验证包括前端构建/依赖审计、跨平台更新包选择、后端单元测试，以及真实 PTY 的启动、输入输出和尺寸调整。Mac `.app` 已构建并通过启动日志确认前端加载。
- 本地验证包括后端、33 项 AI 协议/状态、6 项平台/更新选择、44 项监控界面测试及 5 项文档检查，npm 审计为 0 项漏洞。新增真实 PTY 双向 OSC 协商测试，Windows 使用固定版本微软 ConPTY 组件，Mac 使用系统 PTY；双平台最终测试数与构建结果见 Actions。
- 已在获得授权的真实 Linux 测试机验证应用 PTY SSH 的输入输出/尺寸调整，以及 SFTP 中文路径、列目录、上传下载、重命名、正确续传、错误前缀恢复与危险文件名拦截。只创建并清理独立临时目录，没有安装远端软件。服务器地址和凭据不写入源码、公共日志或 CI。
- Windows 的 UAC 交互、串口和 Android 硬件仍需对应环境验收；云端测试使用合成数据，不访问用户服务器和手机。
- Mac 包使用 ad-hoc 签名，尚无 Apple Developer ID 证书与公证，首次打开可能需要系统隐私与安全性许可。
- SFTP 使用 russh，尚不完整支持系统 OpenSSH 的所有认证/代理组合，例如自定义 ProxyCommand、多级跳板链、仅代理持有的加密私钥；SSH 终端本身仍使用系统 OpenSSH。递归符号链接尚需单独设计防循环策略。
- AI 面板恢复为只观察 ZeeAI 内远端 Claude/Codex 的状态监控。OSC 7501 与 scoped herdr 使用同一前端体验，不启动旧本机日志/全服务器进程扫描。详见 [AI 状态观察设计](ai-monitor.md)。
- 前端主文件和构建后的主 JS 仍较大，后续可按功能拆分并延迟载入。此次不做大规模架构重写。
