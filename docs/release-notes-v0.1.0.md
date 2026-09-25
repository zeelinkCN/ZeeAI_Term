# ZeeAI_Term v0.1.0

Windows 端的多协议终端工作台：SSH（tmux 持久化）、远程文件与预览、Git 工作空间、
串口 / ADB / 本地终端，外加一个盯 AI 任务的小面板。

## 下载

| 文件 | 说明 |
|---|---|
| `ZeeAI_Term_0.1.0_x64-setup.exe` | **推荐**：NSIS 安装包，双击装 |
| `ZeeAI_Term_0.1.0_x64_en-US.msi` | MSI 安装包（适合企业批量部署） |
| `ZeeAI_Term-0.1.0-portable.zip` | 便携版：解压双击即用，含内置 ADB |
| `ZeeAI_Term.exe` | 单文件免安装版（需要和 `resources/` 放一起，建议直接用便携版 zip） |

> 依赖：Windows 10/11 + WebView2 Runtime（Win11 自带）+ 系统 OpenSSH 客户端（Win10 1809+ 自带）。
> 首次运行 SmartScreen 可能提示"未知发布者"（没有代码签名），点"仍要运行"即可。

## 主要能力

**远程**
- 多服务器 / 多会话，SSH 复用你本机的密钥与 `~/.ssh/config`
- tmux 持久化：断网、关软件之后回来仍是同一会话；内置 tmux 管理面板（列表 / attach / kill）
- 登录用户可临时切换（普通用户登录不用改配置）；远程文件与 tmux 都跟随该会话实际登录的用户
- 跳板机（`ssh -J` 写法；SFTP 走 direct-tcpip 隧道）
- 密码登录支持：密码存 **Windows 凭据管理器**，SFTP 与一次性命令都能用
- 远程文件：**真 SFTP**（russh-sftp）——浏览 / 预览 / 上传 / 下载（目录递归）/ 新建 / 重命名 / 删除，
  带进度条与**断点续传**
- 文件面板可「跟随终端目录」（tmux 走 pane 路径，普通 shell 走 OSC 7）
- Markdown 预览（4 套样式 + 源码切换）、HTML 沙箱预览、图片与代码查看

**本地与设备**
- PowerShell / CMD / WSL；侧栏直接列出"这个模块开了几个会话"
- 串口：自建连接（每条连接独立的波特率/数据位/停止位/校验/流控），真机验证过（ESP32-S3 @ COM5）
- ADB：内置 platform-tools，设备列表 + shell + logcat + 设备文件管理（推送/拉取/删除）
- Git 面板：新建仓库、暂存/取消暂存/丢弃、提交、提交历史 + diff、分支切换与新建、
  在仓库目录一键开终端

**工作台**
- VS Code 风格界面：13 套主题、原生标题栏跟随主题、命令面板（`Ctrl+Shift+P`）
- **分屏**：单窗格 / 左右两分屏 / 上下两分屏 / 三分屏 / 四分屏，一屏同时盯多台机器
- **终端日志**（SecureCRT 式）：右键标签开始记录，纯文本落到 `%APPDATA%\ZeeAI-Terminal\logs\sessions`
- 终端回滚行数可调（1k / 10k / 50k / 200k）
- 退出保存工作区，下次打开自动恢复上次的会话
- **AI Agent 面板**：探测服务器上的 Codex CLI / Claude Code / Aider / Gemini CLI 装没装、跑没跑，
  一键把命令敲进当前终端；任务跑完（进程退出）会在状态栏 + 面板里提醒你

## 安装包内置的更新源

应用内「设置 → 检查更新」默认指向本仓库的 Releases：
`https://api.github.com/repos/zeelinkCN/ZeeAI_Term/releases/latest`

## 已知限制

- 仅 Windows；未做代码签名
- 远程文件走系统 SFTP，暂不支持并行传输
- ADB 文件管理未在真机上验证（开发时手头只有串口设备）
- 非 bash 的远端 shell 拿不到实时工作目录（tmux 会话不受影响）

---

构建与开发说明见仓库 [README.md](https://github.com/zeelinkCN/ZeeAI_Term/blob/main/README.md)；
每一轮的决策与待确认项见 [docs/decisions.md](https://github.com/zeelinkCN/ZeeAI_Term/blob/main/docs/decisions.md)。
