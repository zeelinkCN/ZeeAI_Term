# ZeeAI Terminal

Windows 端的多协议终端工作台：SSH（基于 tmux 的会话持久化）、远程文件管理（SFTP + MD/HTML 预览）、串口、ADB，以及本地终端（PowerShell / CMD / WSL）。

> **想直接试用**：双击 `src-tauri/target/release/zeeai-terminal.exe`。
> 交付说明与待确认事项见 [docs/decisions.md](docs/decisions.md)（开头有 30 秒版）。

## 当前状态

**M0 技术验证 + M1 骨架已完成，可直接试用**：本地终端（PowerShell / CMD / WSL）、SSH 连接、tmux 会话附加均已实测跑通。

已实现：VS Code 风格外壳、多会话标签、本地终端、SSH（免密/密钥，复用系统 OpenSSH）、
tmux 持久会话自动附加、tmux 会话管理面板（列表 / attach / kill）。

以及：远端文件浏览（跟随当前会话）、Markdown 渲染预览（四套样式 + 源码切换）、
HTML 沙箱预览、图片/代码/文本查看；每个会话各自维护打开的文件（终端为主标签，文件为二级副标签）。

无人值守自检：设置 `ZEEAI_SELFTEST=1` 启动，会自动验证 tmux / 文件命令链路后退出。
界面级演示：设置 `ZEEAI_AUTODEMO=1` 启动，应用会自己走一遍「连接 → 文件 → 预览」流程（便于截图/回归）。

> 已知坑：Windows OpenSSH 传 `-o ConnectTimeout=N` 会额外等待 N 秒，一次性 ssh 调用不要带这个参数。

### 便携版

`portable/ZeeAI-Terminal-0.1.0-portable.zip`（解压即用，内含内置 platform-tools，
ADB 无需另装；`resources` 目录必须与 exe 放在一起）。

### 功能现状

已实现：VS Code 风格外壳与真实可用的菜单栏、设置对话框（字体/主题/默认终端/tmux/历史）、
会话列表（已保存服务器 + 会话历史，可逐条删除）、新建会话对话框（可选是否 tmux、新建或附加已有会话）、
SSH + tmux 持久会话、远程文件浏览与 Markdown/HTML 预览、本地终端（PS/CMD/WSL）、ADB（内置 platform-tools）。

服务器管理：独立的「服务器管理」窗口（新建 / 编辑 / 复制 / 删除，删除有二次确认），
服务器右键菜单；新建会话时可**临时指定登录用户**（不改配置），远程文件与 tmux 会话
都跟随该会话实际登录的用户；配置里可选「允许在终端里输入密码」。

界面：13 套主题（含 One Dark Pro / Tokyo Night / Nord / 纸白 / 樱花粉…），原生标题栏跟随主题；
应用图标是对讲机（窗口 / 任务栏 / 资源管理器同一份多尺寸 ico，小尺寸另有简化版）；活动栏图标按原生样式重画（PowerShell 蓝底 `>_`、CMD 黑窗 `C:\`、WSL 企鹅）；
会话标签可右键重命名，会话历史按服务器缩进挂在下面。

本地工具：串口改成**自建连接**（每条连接独立波特率/数据位/停止位/校验/流控，不再罗列所有 COM 口）；
Git 面板可「打开本地仓库」并直接在仓库目录开本地终端（Git 工作空间会保存下来）。
文件面板有「跟随终端目录」开关：刷新时跳到 tmux 会话当前所在目录。

远端文件走**真正的 SFTP**（纯 Rust `russh` + `russh-sftp`，不再借道 scp）：列目录、读文件、
上传/下载（目录递归）、新建目录、重命名、删除。探测脚本：`cargo run --example sftp_spike -- <host> <user>`。

目录跟随：tmux 会话走 `tmux display-message`，普通 shell 走 **OSC 7**（启动时注入 PROMPT_COMMAND，
不改服务器文件）；文件面板有「⤓ 同步终端目录」按钮一键跳过去。

Git 面板已经能干活：新建仓库（`git init -b main`）、暂存/取消暂存/丢弃、提交（Ctrl+Enter）、
提交历史 + diff 查看、分支列表/切换/新建、在每个工作空间目录开新终端。

**队列已清空**：跳板机（`ssh -J` 写法；SFTP 走 russh direct-tcpip 隧道）、
ADB logcat + 设备文件管理（浏览/推送/拉取/删除）、断点续传（传一半的文件会自动接着传）、
命令面板（`Ctrl+Shift+P`）、MSI 安装包。

**分屏**：「视图」菜单可选单窗格 / 左右两分屏 / 上下两分屏 / 三分屏 / 四分屏，
每个窗格显示一个会话，同一页面同时看多台机器。

**AI Agent 面板**：活动栏底部 AI 按钮 → 右侧面板，探测服务器上的
Codex / Claude Code / Aider / Gemini CLI 是否安装、是否正在运行，支持一键安装与一键启动；
每 8 秒探测一次进程，进程退出即判断任务结束并弹消息通知。

**终端日志（像 SecureCRT 那样留档）**：右键任意会话标签 → 「开始记录终端日志」，
输出会以纯文本落到 `%APPDATA%\ZeeAI-Terminal\logs\sessions\`（写入前已剥掉 ANSI 颜色转义，
记事本直接可读）。标签上出现红点表示正在记录；设置里可以开「新建会话自动记录」。

**终端回滚行数可调**：设置里 1k / 10k / 50k / 200k 一键切换（默认 10000 行）。
超出后是丢掉最老的行，不会崩；要长期留存就配上面的日志功能。

补充：服务器右键可编辑配置；会话历史按服务器折叠在各自节点下；设置里可选关闭行为（退出/托盘）
与更新检查；主题支持 VS Code 深/浅、GitHub、微信绿、Teams 紫、Dracula；
串口已支持枚举与打开，ADB 与 Fastboot 均使用内置 platform-tools；Git 面板（分支/上游/改动列表）；
SSH 断线自动重连（指数退避，可关）。

远端文件支持**上传（可多选、目录递归）、下载、重命名、删除、新建文件夹**（右键或行尾 ⋯ 菜单）；
串口在真实设备（ESP32-S3 @ COM5，115200）上验证过能收到数据；内置自检可对真机串口做收发探测。

未实现：传输进度条 / 断点续传（现在是 scp，无进度）、密码登录的服务器读远程文件、Git 面板的写操作。

- 技术设计文档：[docs/design.md](docs/design.md)
- 决策与待确认事项：[docs/decisions.md](docs/decisions.md)
- 界面交互草稿：[layout-preview.html](layout-preview.html)（双击用浏览器打开）

### 产出物

- 免安装版：`src-tauri/target/release/zeeai-terminal.exe`
- 安装包：`src-tauri/target/release/bundle/nsis/ZeeAI Terminal_0.1.0_x64-setup.exe`

### 运行

```powershell
npm run tauri dev      # 开发模式（热更新）
npm run tauri build    # 打包 exe + NSIS 安装包
```

> 打包请始终使用 `npm run tauri build`。只跑 `cargo build --release` 时前端资源可能不会被重新嵌入，
> 会得到「能启动但白屏」的 exe。

端到端探针（验证 PTY + ssh + tmux，不需要开 GUI）：

```powershell
cd src-tauri
cargo run --release --example pty_probe -- <host> <user>
```

## 技术栈

- 应用外壳：Tauri 2（Rust 后端 + WebView2 前端）
- 前端：React + TypeScript + xterm.js
- 关键库：`portable-pty`（PTY/ConPTY）、`russh` / `russh-sftp`（SSH/SFTP，`ssh2` 作兼容兜底）、`serialport`（串口）、`tokio`（异步）

## 开发前置

- Windows 11
- Node.js LTS
- Rust（`rustup`，MSVC 工具链；需安装 VS Build Tools 的「C++ 生成工具」）
- WebView2 Runtime（Windows 11 自带）

## 规划

里程碑 M0–M5 见 [docs/design.md](docs/design.md) 第 8 节。
