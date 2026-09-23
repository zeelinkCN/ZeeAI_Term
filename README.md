# ZeeAI Terminal

Windows 端的多协议终端工作台：SSH（基于 tmux 的会话持久化）、远程文件管理（SFTP + MD/HTML 预览）、串口、ADB，以及本地终端（PowerShell / CMD / WSL）。

## 当前状态

**M0 技术验证 + M1 骨架已完成，可直接试用**：本地终端（PowerShell / CMD / WSL）、SSH 连接、tmux 会话附加均已实测跑通。

已实现：VS Code 风格外壳、多会话标签、本地终端、SSH（免密/密钥，复用系统 OpenSSH）、
tmux 持久会话自动附加、tmux 会话管理面板（列表 / attach / kill）。

以及：远端文件浏览（跟随当前会话）、Markdown 渲染预览（四套样式 + 源码切换）、
HTML 沙箱预览、图片/代码/文本查看；每个会话各自维护打开的文件（终端为主标签，文件为二级副标签）。

无人值守自检：设置 `ZEEAI_SELFTEST=1` 启动，会自动验证 tmux / 文件命令链路后退出。
界面级演示：设置 `ZEEAI_AUTODEMO=1` 启动，应用会自己走一遍「连接 → 文件 → 预览」流程（便于截图/回归）。

> 已知坑：Windows OpenSSH 传 `-o ConnectTimeout=N` 会额外等待 N 秒，一次性 ssh 调用不要带这个参数。

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
