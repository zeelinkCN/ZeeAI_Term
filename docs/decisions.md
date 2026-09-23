# ZeeAI Terminal · 今晚的决策与待确认事项

日期：2026-09-24 夜 · 状态：M0 技术验证 + M1 骨架已落地，已打包，可直接试用

---

## 先看这里（30 秒版）

**怎么试**：双击 `D:\AI\ZeeAI_term\src-tauri\target\release\zeeai-terminal.exe`

**点开就能用的**：左侧「远程」里点一下内置的「测试服务器」→ 会自动用你的免密登录并 attach tmux；
再点侧栏「文件」子标签可以浏览服务器目录、点文件看 Markdown / HTML 预览。
PowerShell / CMD / WSL 三个本地终端也都能开，各自独立标签。

**需要你拍板的 3 件事**（详见 B 节）：

1. SSH 继续用系统 OpenSSH（现在这样），还是让我改成原生 Rust 实现（为了后面接 SFTP）？
2. 内置的「测试服务器」这条连接要不要留着？
3. 我在你服务器上装了 tmux（C5 节），要不要保留？

**我留下的痕迹**：服务器上现在有一个 tmux 会话 `47-99-241-168-root`（我测试时创建的，
正好可以验证「重连回到原位」这个能力），以及 `/tmp/zeeai-demo/` 两个示例文件。
不需要的话：面板里点「结束」、`rm -rf /tmp/zeeai-demo`。

> 你睡觉期间我按「自己决定、把疑问记下来」的方式推进。下面分三块：
> **A. 替你做的决定**（醒了请确认或否决）、**B. 需要你拍板的问题**、**C. 环境改动清单**。

---

## 0. 今晚的验证结果（都实测过）

| 验证项 | 结果 |
|---|---|
| Rust + Tauri 在 Windows 上的编译与打包 | ✅ release exe **8.9 MB**；NSIS 安装包已产出 |
| 应用能启动 | ✅ 进程存活、WebView2 子进程正常拉起、内存约 65 MB |
| SSH 免密登录 `203.0.113.10` | ✅ 返回 `CONNECT_OK`，root 免密可用 |
| **ssh + tmux attach 端到端** | ✅ 探针输出 `RESULT: OK`（marker / hostname / tmux 列表全部命中） |
| tmux 会话名清洗（主机名含点号） | ✅ `47-99-241-168-root` 被 tmux 正常接受 |
| **正式版 exe 的界面真的渲染并调用了后端** | ✅ 启动 5 秒内生成配置，日志出现 `ipc: list_profiles -> 1 entries` |
| tmux 列举/结束命令（面板底层） | ✅ 实测：创建会话 → 列出 `zeeai-panel-demo\|1\|0` → kill → 列表为空 |
| Rust 单元测试 | ✅ 3 passed（tmux 输出解析的三种边界情况） |
| 远端目录列举（文件窗格底层） | ✅ 实测返回 `/root` + 制表符分隔条目 |
| 远端文件读取（预览底层） | ✅ 实测 base64 往返正确（解码得到主机名） |
| **命令层整体自检（走 Tauri，非手工命令）** | ✅ `tmux_list ok -> 0 sessions` / `fs_list ok -> 19 entries at /root` |
| **界面级验证（截屏 + 自动演示，见 F4）** | ✅ 连接成功进入 tmux、文件浏览、Markdown 预览、HTML 沙箱预览全部可见 |

### F4. 界面级验证（今晚最后一段）

为了不只停留在「命令跑通」，我用「截屏 + 应用内自动演示」把界面链路也验了一遍：

- 加了 `ZEEAI_AUTODEMO=1`：启动后应用自己走一遍「连接 → 切文件 → 打开 md → 打开 html」，
  我按时间点截屏检查。这对以后做自动化 UI 回归也有用。
- 截屏确认到的状态：
  1. 会话标签 `测试服务器 · 203.0.113.10`，终端里是远端 root 提示符；
  2. 底部绿色 tmux 状态条 `[47-99-241-168-root:0:bash*]`（会话名是我代码清洗过的）；
  3. 文件窗格跟随当前会话，能列出 `/tmp/zeeai-demo` 下的文件与大小；
  4. 打开 `README-demo.md` 后，主区出现二级标签「终端 | README-demo.md」，Markdown 正常渲染（标题/列表/代码块/引用/表格）；
  5. 打开 `demo.html` 后在沙箱 iframe 中以白底渲染。

顺手抓到并修掉两个真实缺陷：

1. **一次性 ssh 会弹出黑色控制台窗口**：`fs_list` / `fs_read` / `tmux_list` 直接 spawn 进程时没加 `CREATE_NO_WINDOW`，
   界面上会闪一个控制台窗口甚至挡住操作。已加 `creation_flags(0x08000000)` 修复。
2. **文件操作每次要 10–12 秒**：定位到是 Windows OpenSSH 的一个怪癖——传 `-o ConnectTimeout=10` 后，
   即使连接早已建立，进程仍会额外等满这个时长（设 3 就多 3.7s，不设只要 0.77s）。
   已从一次性 ssh 调用里去掉该参数，**目录列举从 ~12s 降到 ~0.8s（约 15 倍）**。
   > 这个坑值得记住：后续所有一次性 ssh 调用都不要带 ConnectTimeout，超时控制放在 Rust 侧做。

过程中踩到两个坑，代码里已经处理掉，记在这里备忘：

1. **必须设置 `TERM=xterm-256color`**，否则远端 tmux 直接报 `open terminal failed: terminal does not support clear`。
2. **终端必须能应答 `ESC[6n` 光标位置查询**：tmux 启动时会问，xterm.js 会自动应答（所以真实应用没问题），但用自写脚本/探针时必须手动回 `ESC[1;1R`，否则会卡死在 4 字节。
3. **构建务必用 `npm run tauri build`，不要只跑 `cargo build --release`**：直接跑 cargo 时前端产物（`dist/`）的变更未必会被重新嵌入，结果是「能启动但白屏」的 exe（我踩到过，已修复）。若怀疑资源是旧的，先执行 `cargo clean -p zeeai-terminal` 再打包。
4. **改完前端后要确认 exe 真的重建了**：判据不是「构建成功」，而是 exe 里引用的 JS 文件名与 `dist/assets/` 里的一致（可用二进制搜索 `index-XXXX.js` 验证）。若不确定，先 `cargo clean -p zeeai-terminal` 或 touch 一下 `src-tauri/src/lib.rs` 再打包。

---

## A. 我替你做的决定

### A1. SSH 先用「系统 OpenSSH 客户端 + PTY」，不是原生 russh

设计文档里写的是用 `russh` 自己实现 SSH 客户端。今晚我改成 **把系统自带的 `ssh.exe` 跑在 PTY 里**（也就是让 `ssh` 自己去处理认证、known_hosts、agent）。

原因：

1. 你本机已经配好免密，用系统 `ssh` 能直接复用你的 `~/.ssh/config`、密钥和 agent，零配置就能连上，可靠性最高。
2. 今晚的目标是「能用的版本」，原生 russh 需要自己实现认证握手、密钥解析、PTY 请求等，风险和时间都更高。
3. tmux 持久化用这种方式非常自然：直接执行 `ssh -tt ... "tmux new-session -A -s <名字>"`。

**代价 / 什么时候必须换回 russh**：做 SFTP 文件窗格（M3）时，需要一个能编程调用 SFTP 子系统的客户端，届时会引入 `russh`（或 `ssh2`）并保留现在这条作为「兜底/兼容」路径。

**如果你更希望一开始就走原生 russh，请告诉我，我改。**

### A2. 终端数据用 base64 走 Tauri Channel

后端把 PTY 原始字节按 base64 编码后推给前端，前端解码成 `Uint8Array` 喂给 xterm.js。

原因：直接传字符串会在 UTF-8 多字节字符被拆包时出现乱码；base64 保证字节级正确。代价是约 33% 传输开销。**后续优化项**：若能确认 Tauri Channel 支持裸二进制载荷，再改成零拷贝。

### A3. 打包只做 NSIS 安装包

`tauri.conf.json` 里 bundle target 从 `"all"` 收成 `["nsis"]`，避免 MSI(WiX) 那条链路的额外下载和失败面。如果你需要 MSI，我再加。

### A4. 首次运行内置一条「测试服务器」记录

首次启动时会在配置里写入一条 SSH 记录：名字「测试服务器」，`root@203.0.113.10:22`，开启 tmux。目的是让你一打开就能点着试用，不用先手动建连接。**它是普通记录，可以在侧栏删掉。**

### A5. 主机密钥策略用 `accept-new`

首次连接陌生主机时自动接受并写入 `known_hosts`（等价于第一次 `ssh` 时的 yes），避免在无交互环境下卡在确认提示。这是「能用」与「安全」之间的折中，**请你确认是否接受**；若你要求严格校验，我改成弹窗确认。

### A6. 暂缓的功能

今晚聚焦「能跑起来、能连服务器、能开本地终端」。以下按设计文档留到后续里程碑，界面上先留了占位提示，不会假装已实现：

- SFTP 远程文件窗格与 MD/HTML 预览（M3）
- 串口、ADB（M4）
- Git 面板、命令行面板、设置页（M5）

> tmux 会话管理面板当时列在这里，但当晚后续补上了，见下方「F. 追加完成」。

---

## F. 追加完成（你睡觉期间的后半程）

你确认要的 **tmux 会话管理面板**已经实现并打包进本版：

- 侧栏「远程 → 会话」里，每条连接右侧多了一个 `≡` 按钮，点开显示该服务器上的 tmux 会话；
- 面板支持 **刷新 / 连接（attach）/ 结束（kill）**，并显示每个会话的窗口数和是否已连接；
- 底层用一次性 `ssh <host> "tmux ls -F ..."` 实现，不依赖服务器上装了别的东西；
- 同时把打开 SSH 会话的接口扩展成支持「指定 tmux 会话名」，所以点「连接」会直接 attach 到那个会话。

顺带加的基础设施：

- `ssh::ssh_exec_args()`：非交互式一次性 ssh 调用（tmux 列表/kill 用）；
- `core::tmux`：tmux 输出解析 + 单元测试；
- 打包流程固定为「先 `cargo clean -p` 再 `npm run tauri build`」，避免前端资源不更新的坑。

### F2. 远程文件浏览 + MD/HTML 预览（你的需求 2 主体）

你列的第二条需求（远程文件管理 + 双击预览 md/html）也做进来了：

- 侧栏「远程 → 文件」窗格**跟随当前会话**所在服务器，支持进入目录 / 返回上级 / 回家目录 / 刷新；
- 点文件即在主区打开：**每个会话各自维护自己打开的文件**，终端是主标签、文件是会话下的二级副标签（与之前确认的形态一致）；
- 预览：Markdown 默认渲染，支持 **GitHub / 简洁 / 深色 / 文档** 四套样式，可一键切「源码」；HTML 在**沙箱 iframe**（`sandbox=""`）里渲染，脚本不执行、样式不外泄；图片走 data URL；代码/文本用等宽视图；
- 底层复用系统 `ssh`：`find` 列目录、`head | base64` 读内容（二进制安全，路径做了单引号转义）；
- 单文件读取上限 1MB（超出只取前 1MB），后续可改流式。

### F3. 自检开关

新增 `ZEEAI_SELFTEST=1`：启动后自动跑一遍 `tmux_list` 与 `fs_list`，把结果写进日志并自动退出，
用于在不打开界面的情况下验证「命令层是否真的通」（也方便以后接 CI）：

```powershell
$env:ZEEAI_SELFTEST = '1'
.\src-tauri\target\release\zeeai-terminal.exe
```

---

## B. 需要你拍板的问题

| # | 问题 | 我的倾向 |
|---|---|---|
| B1 | SSH 走「系统 ssh」还是「原生 russh」？（见 A1） | 先系统 ssh，M3 做 SFTP 时再引入 russh |
| B2 | 内置的「测试服务器」记录保留，还是删掉？ | 保留，方便试用；你可以随时删 |
| B3 | `StrictHostKeyChecking=accept-new` 是否接受？（见 A5） | 接受，后续再做 known_hosts 管理界面 |
| B4 | 全局 cargo 镜像配置是否保留？（见 C2） | 保留（国内网络下明显更快） |
| B5 | VS 安装器注册表的改动是否接受？（见 C1） | 建议接受，原值指向不存在的 E: 盘 |
| B6 | 安装包只出 NSIS 够不够？ | 够；需要 MSI 再加 |
| B7 | 默认窗口 1280×820、字体 Cascadia Mono、深色主题，是否 OK？ | 先用这套，后续做设置页 |

---

## C. 环境改动清单（都在你机器上，请知悉）

### C1. 修复了 VS 安装器的两个注册表值

`HKLM\SOFTWARE\Microsoft\VisualStudio\Setup` 里原本：

```
CachePath              = E:\WORK_Tool
SharedInstallationPath = E:\WORK_Tool
```

两个问题：**E: 盘不存在**；且两者相同（安装器报「包缓存路径不能与共享的安装路径重叠」，这就是 VS Build Tools 一直装不上的根因）。

我改成了默认值：

```
CachePath              = C:\ProgramData\Microsoft\VisualStudio\Packages
SharedInstallationPath = C:\Program Files\Microsoft Visual Studio\Shared
```

改完后 Build Tools 一次装好。**如果 E: 盘是你以后再插的移动盘、并且你有意把 VS 包放那儿，请告诉我，我改回去。**

### C2. 新增了 cargo 全局镜像配置

新建 `C:\Users\m1523\.cargo\config.toml`：把 crates.io 指向 `rsproxy.cn` 稀疏索引，并关闭 HTTP 多路复用。

原因：直连 crates.io 时 cargo 反复报 `transfer too slow ... transferred 0 bytes`（而浏览器/`Invoke-WebRequest` 访问同一站点正常），换镜像后立刻恢复正常。**这会影响到你机器上所有 Rust 项目的依赖下载。**

### C3. 安装的工具链

| 组件 | 版本 / 位置 |
|---|---|
| Node.js | v24.21.0（`C:\Program Files\nodejs`） |
| npm | 11.19.0 |
| Rust | 1.98.1（rustup，`C:\Users\m1523\.cargo`、`C:\Users\m1523\.rustup`） |
| VS Build Tools 2022 | `C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools`（含 VCTools 工作负载） |
| Windows SDK | 10.0.26100.0 |

### C4. 触发过一次静默提权

你的账号在管理员组，且 UAC 配的是「管理员静默提升」（`ConsentPromptBehaviorAdmin=0`），所以整个安装过程没有弹窗。这是我完成安装的前提，特此说明。

### C5. 在你的测试服务器上安装了 tmux

`203.0.113.10` 原本**没有 tmux**（`tmux: command not found`），而 tmux 持久化是本产品的核心功能，没它就验证不了。我用 `dnf install -y tmux` 装上了 **tmux 2.7**（Anolis / Alibaba Cloud Linux 3 官方仓库版本）。

回退命令（如果你不想留着）：

```bash
dnf remove -y tmux
```

另外，代码里已经加了**检测与降级**：以后连到没装 tmux 的服务器，会自动退回普通 shell 并在终端里打印安装提示，不会再直接报错。

### C6. 绕过 GitHub 下载超时

`tauri build` 打包时需要从 GitHub 下载 NSIS 工具链，直连超时。我通过 GitHub 代理把 `nsis_tauri_utils.dll` 手动放进了 `C:\Users\m1523\AppData\Local\tauri\`，之后打包成功。这一步只影响本机缓存，不在仓库里。

---

## D. 已知问题 / 还没做完的

1. **没有跑过真实 GUI 交互**：我这边看不到窗口，无法确认鼠标点击、中文渲染、粘贴等细节；请你打开后反馈。
2. **tmux 会话管理面板缺失**（设计文档已确认为需求，今晚未实现）。
3. **SSH 断线自动重连**：目前 ssh 进程断开后会话标记为 closed，还没有做「指数退避 + 自动 re-attach tmux」。
4. **串口 / ADB / Git / SFTP / 预览** 均未实现，界面是占位。
5. **窗口菜单是纯装饰**（文件/编辑/视图… 还不能点）。
6. **串口和 ADB 的归属**按最后确认放在左侧「本地工具组」。

---

## E. 怎么运行 / 怎么试

开发模式（改代码即时生效）：

```powershell
cd D:\AI\ZeeAI_term
npm run tauri dev
```

正式产物：

- 免安装版：`D:\AI\ZeeAI_term\src-tauri\target\release\zeeai-terminal.exe`（8.9 MB，双击即用）
- 安装包：`D:\AI\ZeeAI_term\src-tauri\target\release\bundle\nsis\ZeeAI Terminal_0.1.0_x64-setup.exe`

> 两者都依赖系统已有的 **WebView2 Runtime**（你机器上已装 153.x；Win10/11 通常自带）。

端到端可靠性探针（验证 PTY + ssh + tmux 这条链路，不需要开 GUI）：

```powershell
cd D:\AI\ZeeAI_term\src-tauri
cargo run --release --example pty_probe -- 203.0.113.10 root
```

试用建议路径：

1. 打开后左侧点「远程」→ 双击内置的「测试服务器」→ 看是否自动连上并进入 tmux 会话；
2. 点左侧 PowerShell / CMD / WSL 各开一个本地终端，验证多会话标签；
3. 切会话标签、关会话标签，确认没有串台或残留。
