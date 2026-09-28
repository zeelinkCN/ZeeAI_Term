# 实施记录 · 2026-09-29 第二轮：herdr 会话（勾选 / 默认 / 直接进环境）+ 通知可配

> 用户口径：**"现在就做，你提的建议都做"**，外加他补的第 5 条（AI 通知别每跑一个小任务都弹）。
> 仍然**不动版本号（0.1.8）、不打 tag、不发 release**。

## 0. 先探索，再实现：四个问题的答案

1. 新建服务器时能不能像 tmux 一样勾"用不用 herdr"？
   → 之前**不能**：服务器配置里只有 `tmuxEnabled`，herdr 那行只是只读状态。所以开出来的
   "lz · 普通 shell" 就是纯 shell，得自己敲 `herdr` 才进得去。
2. 勾了"默认打开用 herdr"之后别再每次让我勾。
3. 进 herdr 要有"新建窗格 / 接管已有窗格"两种进法。
4. 不跑她自己的整屏界面（上次花屏那条）。
5. （新增）AI 通知可控：默认**只**在"产出了 HTML/MD 文档"和"AI 在等我做选择题"时提醒。

## 1. 关键发现：herdr 有一条比"跑她的界面"干净得多的路

`herdr terminal session control <窗格> --takeover --cols N --rows R`

真机实测（lz 上临时 workspace，测完已删）：

| 验证项 | 结果 |
|---|---|
| 帧格式 | ✅ 和只读观察窗**完全一样**（`{"bytes":"<base64>"}` 一行一条）→ 解码代码直接复用 |
| 写输入 | ✅ `{"type":"terminal.input","bytes":"<base64>"}` |
| 字段名 | ⚠️ **只有 `bytes` 认**；`data` / `data_base64` 发过去毫无反应（实测排除） |
| 回车 | ✅ base64 里带 `\r` 才提交（只发 `\n` 是打字、不执行） |
| 改尺寸 | ✅ `{"type":"terminal.resize",...}`，**不用重开流** |
| 交还控制 | ✅ `{"type":"terminal.release"}` |
| 直接拔线（kill + 关 stdin） | ✅ 窗格还在、画面状态还在 → tmux 那种"断线回同一会话" |
| 拔线后重连 | ⚠️ 必须 `--takeover`；否则第二个控制端立刻收到 `terminal.closed(reason=detached)` |

**结论**：不跑她的 TUI 也能"进她的环境"：control 流可读可写、不抢尺寸、退出干净、断线可回。

## 2. 做了什么

### 2.1 服务器配置：`herdrEnabled`

- `store.rs::SshConfig` 加 `herdr_enabled`（`#[serde(default)]`，老配置不受影响）；
- 「服务器管理」里和"默认使用 tmux"并排多一个 **"默认用 herdr 打开"**；
- 新建会话里 herdr 勾选框的默认值**取这台服务器的配置** → 勾过一次就不用每次再勾。

### 2.2 新建会话：真勾选框，勾了就直接进去

- 原来那行只读状态换成**真勾选框**（没装时是灰的，旁边给"一键安装"）；
- 勾上后二选一（和 tmux 的"新建/附加"同理）：
  **新建一个 herdr 窗格**（`herdr workspace create` → 拿到 `wN:p1`）/
  **接管已有窗格**（列出她的 agent，点一个，带 `--takeover`）；
- 勾了 herdr 就**隐藏 tmux 那条**（两条是"用哪种方式开"，同时开没意义）；
- 连接时若探测到其实没装 herdr：**明确降级**到 tmux/普通 shell 并在状态栏说清楚。

### 2.3 会话本身：可读可写的 herdr 窗格

- 新后端 `backend = "herdr-control"`（旧的只读观察窗是 `herdr-pane`，两者共用帧解码）；
- 输入：`herdr_pane_input(id, data_b64)` → Rust 包成 `terminal.input` JSON 写进该会话 stdin
  （**不再需要观察窗那条常驻输入泵**）；
- 尺寸：control 直接发 `terminal.resize`（只读那条仍重开流）；
- 关标签：`session_close` 先发 `terminal.release` 再收进程 → 窗格留在服务器上，下次是干净接管；
- **不自动重连**：control 带 `--takeover`，自动重连会把控制权从刚接管的人手里抢回来
  （用户说过不要跟别的客户端打架）；断了就标成已断开，重开手动点标签上的 ↻；
- `terminal.closed` 这类非数据记录**不再原样打进终端**（否则屏幕冒出一行 JSON），
  翻成人话进底部状态栏。

### 2.4 看板卡片多了「接管」

每张 herdr 卡片两个按钮：**查看窗格**（只读，不影响她的尺寸）/ **接管**（可读可写，能直接
回答她的选择题）。标签名带窗格号（如 `lz · codex w2:p1`），同机开两个也分得清。

### 2.5 通知策略（用户第 5 条）

设置 → 通知，新增"**什么时候提醒我**"（默认值就是用户要的口径）：

| 开关 | 默认 | 说明 |
|---|---|---|
| 产出了文档（HTML / Markdown）就告诉我 | **开** | "我离开电脑，AI 写完了我得去看" |
| AI 等我做选择题（要批准 / 等回话）就告诉我 | **开** | 这条漏了就白等了 |
| 每一轮跑完都告诉我 | **关** | 用户原话"小任务太多，每跑一个都弹一条，很烦" |
| 所有新文件都算"产物" | **关** | 关着 = 只算 HTML/Markdown（用户要的"只看文档"） |

原来那两项（闪任务栏 / 活动栏红点）保留在"用哪种方式提醒"下面。提醒仍然**只**进底部状态栏 +
红点，不在窗口中间弹浮层。

### 2.6 产品名统一成 ZEEAI TERM

改了**用户可见**的地方：窗口标题、标题栏文字、空状态大标题、托盘菜单与悬浮提示、
帮助菜单的"关于 ZEEAI TERM"。
（`productName` / `mainBinaryName` / 仓库地址 / 配置目录 `%APPDATA%\ZeeAI-Terminal\`
**是标识符不是显示名**，动它们会导致装不上或丢配置，所以保持不变。）

## 3. 验证（无头，不弹窗口）

- **后端**：`cargo test --lib` **71 通过**（新增：control 命令单行 + takeover + 窗格号消毒、
  三种 stdin 指令的**线上格式**、流记录分类（数据帧/关流/其它）、从 `workspace create`
  输出取窗格号、半截 JSON 的粘包处理）。
- **前端**：`npm run fe:smoke`（无头 Edge + CDP，零依赖）对 `dist` 跑
  **25/25 通过、零控制台报错**。这一轮新增的端到端断言：

| 断言 | 结果 |
|---|---|
| herdr 是**真勾选框**，且按服务器配置**默认打勾** | ✅ `checked=true disabled=false` |
| 勾上后出现「新建一个 herdr 窗格 / 接管已有窗格」 | ✅ |
| 勾了 herdr 就不再显示 tmux 那条 | ✅ |
| 点连接 → 先 `herdr_workspace_create`，再以 `backend=herdr-control` 打开 `w9:p1` | ✅ |
| 标签栏出现这个可写会话（名字带窗格号） | ✅ |
| 可写会话里敲键 → 走 `herdr_pane_input`（观察窗那条零增量） | ✅ |
| 设置里能配通知；默认"文档 + 等选择题"开、"每轮跑完"关 | ✅ |
| 改开关立刻写回设置（`aiNotifyComplete=true`） | ✅ |
| 界面文案不再出现 `ZeeAI Terminal`，统一 `ZEEAI TERM` | ✅ |

## 4. 没验证的（如实说明）

1. **真机上 control 会话的手感**（打字延迟、宽高、中文输入）——远端命令、帧格式、输入格式
   都在真机逐条验证过，但"在我们窗口里顺不顺手"要你开便携版自己试。
2. `--takeover` 抢控制权只验证到"会收到 `terminal.closed(reason=detached)`"，
   没在"两个人同时用一个窗格"的情况下真对抢过。
3. 非 Linux 服务器、密码登录服务器走不到这条路（前者拒绝、后者输入通道建不起来并明确报错）。
4. 我**没有**启动真身应用去看界面（你在用便携版，不想弹窗打扰），25 条都是无头跑的。

## 5. 一个坑（记下来）

`cargo build` 报 `另一个程序正在使用此文件 (os error 32)`：是**上一轮跑 dev 自检时留下的
`adb.exe` 守护进程**还活着，它从 `src-tauri/target/debug/resources/platform-tools/` 启动、
占住了 `AdbWinApi.dll`，于是 Tauri 的构建脚本没法更新资源目录。杀掉那个 adb 就好了。
以后跑完自检记得顺手 `adb kill-server`。

## 6. 用户实测反馈后的修复（同日第三轮）

用户跑了便携版，报了两件事：「herdr 会话看着不像在 herdr 里面」和「软件崩了」。
查下来是**三个真问题**，都修了：

### 6.1 恢复工作区时 herdr 会话被打回原形（"不在 herdr 里面"的根因）

- `SavedSession`（工作区快照）**没记** `herdrPane` / `herdrMode`，重启后那条会话就按
  `tmuxMode/tmuxName` 走普通路径 → 你看到的是一个**裸 shell**，当然"不在 herdr 里"；
- 更糟的是 `openSshSession` 里"窗格号不写进 tmuxName"那句话**只排除了只读观察窗**
  （`herdr-pane`），可写那条（`herdr-control`）漏了 → 窗格号被当成 tmux 会话名存下来，
  于是会去 `tmux new-session -A -s w9:p1`，在服务器上凭空造一个假 tmux 会话。

修法：快照带上 herdr 两项、恢复时按 herdr 重开；`tmuxName` 对**两种** herdr 会话都不写；
标题统一成 `lz · herdr w9:p1`（以前标签叫这个、历史里却存着 `lz · w9:p1`，一份会话两条记录）。
**已经帮你清掉**：历史里那条重复的 `lz · w9:p1`、以及指向坏会话的 `workspace.json`。

### 6.2 "崩了"其实是**卡死**（Windows 事件日志 AppHangXProcB1，等着 conhost.exe）

根因：**Tauri 的同步命令跑在主线程上**，而我们在这些命令里做**阻塞的 PTY 操作**
（写管道、`master.resize()`、`child.kill()`、开新 PTY）。只要远端不读、或 conhost 一时不作声，
主线程就被顶住 → 整个界面"未响应" → Windows 报 AppHang 并关掉它。

修法：`session_write` / `session_resize` / `session_close` /
`herdr_pane_input` / `herdr_pane_type` / `herdr_pane_key` / `herdr_pane_resize`
全部改成 **async + `spawn_blocking`**：先从注册表里**只取 Arc**（拿完就放锁），
再把真正的阻塞动作丢给阻塞线程。输入泵的 `ChildStdin` 因此改存 `Arc<Mutex<..>>`（不能克隆）。

### 6.3 产品名

用户纠正：应该是原来的大小写 **ZeeAI Term**（他的语音输入法给打成了全大写，我照抄了）。
窗口标题 / 标题栏 / 空状态 / 托盘 / 关于 全部统一成 `ZeeAI Term`。
（`productName`、`mainBinaryName`、仓库地址、配置目录仍是标识符，保持不变。）

### 6.4 另外

进 herdr 窗格时会在底部状态栏说一句"已进入 herdr 的窗格 wN:pN（它留在服务器上、随时能回来）"，
免得再出现"这到底是不是在 herdr 里"的疑惑 —— 顺带说明：**herdr 的窗格本身就是一个普通终端**，
她的整体界面（侧栏/agent 列表）只在 herdr 自己的客户端上显示，我们这边显示的是那个窗格的画面。

### 6.5 PowerShell 5.1 / 7 两个按钮（用户当轮追加）

用户本机装了 PowerShell 7，但面板里默认开的还是系统自带的 Windows PowerShell 5.1，
有些脚本不兼容。做法：

- PowerShell 面板的"新建"变成**并排两个按钮**：左边长的 `新建 PowerShell`（5.1）、
  右边短的 `PowerShell 7`（`pwsh.exe`）；「终端」菜单里也加了一条"新建 PowerShell 7（pwsh）"。
- 后端 `open_local` 新增 `shell = "pwsh"`：先 `where pwsh.exe` 探一下，**没装就给一句人话**
  （"先装 PowerShell 7 再用这个按钮"），而不是甩一句 `spawn failed`。
- pwsh 会话在侧栏里**归到 PowerShell 面板**（kind 仍是 powershell），
  但标题/编号按各自的口味分开算（"PowerShell 7"、"PowerShell 7 2"），不会互相串号。
