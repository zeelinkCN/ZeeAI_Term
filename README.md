# ZeeAI Terminal

Windows 端的多协议终端工作台：SSH（基于 tmux 的会话持久化）、远程文件管理（SFTP + MD/HTML 预览）、串口、ADB，以及本地终端（PowerShell / CMD / WSL）。

## 当前状态

方案设计阶段，尚未开始编码。

- 技术设计文档：[docs/design.md](docs/design.md)
- 界面交互草稿：[layout-preview.html](layout-preview.html)（双击用浏览器打开）

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
