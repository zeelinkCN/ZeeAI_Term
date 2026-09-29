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

## 7. "herdr 会话黑屏"的根因：**不能走 ConPTY**（同日第四轮）

用户连续开了两个 herdr 窗格，都是**黑屏没有反应**。

### 怎么定位的

先做对照，把范围缩到"本地这一段"：

| 实验 | 结果 |
|---|---|
| Windows 侧 `ssh -tt lz "…terminal session control wN:p1…"` 直接写进文件 | ✅ 9738 字节，帧正常 |
| 服务器侧 `script -qc "…control…"`（远端有 PTY） | ✅ 帧正常 |
| 服务器侧不带 PTY 跑 | ✅ 帧正常 |
| **用应用自己的本地路径**（`pty::spawn_with_sink` + `ssh -tt`） | ❌ **0 字节** |
| 同上但去掉 `-tt` | ❌ 还是 0 字节 |
| 同上但换成"本地 cmd echo" | ❌ 只收到 4 字节：`ESC[6n` |

最后一行是决定性的：那 4 字节是 **ConPTY 的"光标在哪"终端握手**，必须由终端回答。
而我们的 herdr 过滤器**只认"整行 JSON"**，把这 4 个没有换行的字节当"半行"缓冲住了 →
xterm 永远收不到 → 无法回答 → ConPTY 一直等 → **一帧都不出来**（黑屏）。
普通 ssh/tmux 会话不受影响，因为那些走 `Filter::Raw`，字节直接进 xterm、xterm 会回答握手。
另外 ConPTY 还会把**超长的 JSON 行按控制台宽度折行**，就算握手过了，帧也会坏。

### 怎么修的

新增 `core/herdr_stream.rs`：herdr 的两条流（只读观察 + 可写控制）改成**管道传输**
（`std::process` + stdin/stdout/stderr 管道，不申请远端 PTY、本地也不过 ConPTY）：

- 没有终端握手 → 不会再被"半行缓冲"卡死；
- 没有折行 → 超长 JSON 行完好；
- 不惊动 conhost → 顺带把 6.2 那类 AppHang 也一起躲开；
- stderr 单独一个线程读回来、作为"状态栏告警"送到前端（以前 herdr 的报错会被丢掉，
  用户只看到一个空窗口）；
- 输入/尺寸走同一条 stdin（`terminal.input` / `terminal.resize`），关标签发 `terminal.release`。

`pty.rs` 里那条已证明走不通的 herdr 分支删掉了（解码函数 `push_herdr_bytes` 留着并复用，
单测也照旧跑）。观察窗的输入泵同样改成管道（不需要 PTY，也不需要回显）。

### 验证

新增 `src-tauri/examples/herdr_probe.rs`：**用应用自己的代码路径**在真机上复现/验证
（`ZEEAI_PROBE_USER=lz cargo run --example herdr_probe`）。修完的结果：

```
== 2) 用新的管道传输接管它（herdr_stream，不申请 PTY）
== 3) 5 秒里本地收到
   数据事件 1 个，解出来 3574 字节
   第一帧开头：[?2026h[?25l]8;;\[2J[1;1H[0;39;49m[lz@iZbp13lx01nj91v37nkv2uZ ~]$ …
== 结论 == 本机能收到帧 → 本地这一段没问题
```

（同一支复现器在改之前是 `数据事件 0 个，解出来 0 字节`。）

## 8. 整轮覆盖测试（同日第五轮，用户把电脑交给我做通宵验证）

用户的要求：**"每一套逻辑、每一个按钮都要管用"**，至少跑三四轮，每轮之间做回归。
我按"三轮互相独立 + 一轮自我拷问"来做，结论如下（全部可复现）。

### 第一轮：真机后端全矩阵 —— `cargo run --example herdr_matrix`

用**应用自己的代码路径**（`core::herdr_stream` + 应用同款 ssh 参数）在真服务器上跑：

```
PASS  探测 herdr 可用
PASS  新建 herdr 窗格并解析出窗格号
PASS  可写流收到画面（说明管道传输通了）
PASS  写入命令后被真的执行（画面里出现回显+输出）
PASS  terminal.resize 生效（画面重绘、无报错）
PASS  --takeover 能抢到控制权（新控制端拿到画面）
PASS  原控制端收到「被接管」告警（翻成中文进状态栏）
PASS  交还控制权后窗格仍在服务器上
PASS  只读观察窗拿到画面
PASS  输入泵能把命令敲进窗格（send-text + enter）
PASS  观察者与控制端可同时工作，且看到同一画面变化   ← 新加
PASS  两边都能持续收到帧（互不踢掉）                ← 新加
PASS  窗格不存在时给出报错（不会静默黑屏）
PASS  窗格被关掉后，流结束（或给出告警）
PASS  临时窗格已清理干净
== 结果：15 通过 / 0 失败 ==
```

> 这轮里我自己踩过两个**测试脚本**的坑（不是产品问题，但值得记）：
> ① 我写的 ANSI 剥离只认 BEL 结束 OSC，而 herdr 用 `ESC \`（ST），把整屏文字吃掉了；
> ② herdr 的帧是"行分隔 JSON"，解码没问题，但我断言时用的是自己剥过的文本。

### 第二轮：前端全流程 —— `npm run fe:smoke`（无头 Edge，37 条）

覆盖到的 herdr 相关路径（每条都是"点出来看结果"，不是读代码）：

| 场景 | 结果 |
|---|---|
| AI 面板显示状态来源 herdr + 卡片「等你处理」+ 红点 | ✅ |
| 卡片「查看窗格」→ `backend=herdr-pane`，且建立了输入通道 | ✅ |
| 卡片「接管」→ `backend=herdr-control` + 那个窗格 | ✅ |
| 观察窗里打字走 herdr 自己的通道（本地 PTY 零写入） | ✅ |
| 新建会话：herdr 真勾选框、默认值来自服务器配置 | ✅ |
| 新建窗格 → 先 `herdr_workspace_create` 再以 `herdr-control` 打开 | ✅ |
| 接管已有窗格 → 列**所有窗格**（含没有 agent 的空壳窗格，不再"没东西可选"） | ✅ |
| 勾了 herdr 就不显示 tmux 那条 | ✅ |
| **探测未返回时勾选框仍可点**（"一直建不开"的根因） | ✅ |
| **探测失败时勾选框仍可点 + 明说会重试**，连接时**强制重探** | ✅ |
| **新建窗格失败 → 状态栏红色报错**（以前异常被吞，对话框无声卡住） | ✅ |
| **重启恢复**：快照里的 herdr 会话仍以 `herdr-control` 打开 | ✅ |
| **从侧栏历史点开** herdr 会话 → 仍以 herdr 打开（以前开出普通 shell） | ✅ |
| 没装时「一键安装 herdr」→ 真的发起 `herdr_install` | ✅ |
| 通知策略默认值 + 改动写回设置 | ✅ |
| 产品名是 `ZeeAI Term`（不再出现全大写/Terminal 全称） | ✅ |
| PowerShell 面板两个"新建"按钮（5.1 / 7）+ 点 7 时 `shell=pwsh` | ✅ |

```
结果：37/37 通过
```

### 第三轮：真机自检（用最新二进制）

`ZEEAI_SELFTEST=1 ZEEAI_SELFTEST_HERDR=1 ZEEAI_SELFTEST_PROFILE=lz`（新加了按名字挑服务器的开关）：

```
SELFTEST: using profile lz
SELFTEST: herdr_agents(Ali_root) -> 0 个（1467 ms）
SELFTEST: herdr_agents(lz)       -> 0 个（1319 ms）
SELFTEST: herdr_workspace_create -> w0:p1（1441 ms）   ← 「新建窗格」那条路
herdr_install: ... 这台机器上已经有 herdr 0.9.1（协议 22），不覆盖   ← 安装闸门
```

（之前日志里"安装卡在读取平台 54 秒"的现象，这次同一步只用了 3 秒 —— 属于当时网络/sshd
一时拥塞；现在每一次远端采集都有 20 秒上限并会明确报错，不会再无声卡住。）

### 第四轮：自我拷问 —— 又揪出 4 个真问题（都已修）

把"用户会怎么用"再走一遍，发现这些**前面几轮没覆盖到**的：

1. **接管列表只有 agent 的窗格** → 空壳窗格（AI 已退出 / 刚开的）根本不出现，
   用户会觉得"没东西可接管"。改成读 `herdr pane list`（所有窗格），
   agent 信息有就显示、没有就标 `shell`。新增后端命令 `herdr_panes` + 单测。
2. **从侧栏会话列表点开 herdr 会话会开出普通 shell** —— 会话历史里没记窗格号。
   `HistoryEntry` 加 `herdr_pane/herdr_mode`，历史按窗格去重，
   `connectFromHistory` 按 herdr 方式重开。（和工作区恢复那次的 bug 同一类，这次一起补上。）
3. **可写流断了之后每次按键都弹一条提示** → 状态栏被刷屏。
   改成"第一次失败提示一次，之后不再发也不报"。
4. **探测失败（null）也被当成"这台机器没装"** → 勾选框被禁用、还弹出"一键安装"。
   规则收紧为"只有**确认**探到没装才禁用 / 才给安装入口"；探测失败一律允许先勾、连接时重探。

### 本轮最终验证（改动后再跑一遍，全绿）

| 套件 | 结果 |
|---|---|
| `cargo test --lib` | **72 通过 / 0 失败** |
| `cargo run --example herdr_matrix`（真机） | **15 通过 / 0 失败** |
| `npm run fe:smoke`（无头前端） | **37 通过 / 0 失败** |

### 第五轮：又抓到一个**会让功能整体失效**的问题 —— herdr 服务器没在跑

给矩阵补"服务器刚重启"这个场景时发现：**herdr 的 API 命令都要求服务器已在运行**。
服务器没跑时 `workspace create` 返回：

```json
{"error":{"code":"server_not_running","message":"no herdr server is running at …; run `herdr session attach X` to start or attach it"}}
```

而我们的应用**刻意不跑她的 TUI**，也从不启动服务器 —— 也就是说：**用户服务器重启一次，
我们的 herdr 功能就整体失效**，除非他自己去终端敲一次 `herdr`。这是今晚最有价值的发现。

修法：给**每一条** herdr 远端命令前面加上"确保服务器在跑"（`ENSURE_SERVER`）：

```sh
if [ -n "$H" ] && ! "$H" status server 2>/dev/null | grep -q '^status: running'; then
  printf '[ZeeAI] herdr 服务没在跑，已帮你启动。\n' >&2
  if command -v setsid >/dev/null 2>&1; then setsid "$H" server </dev/null >/dev/null 2>&1 &
  else nohup "$H" server </dev/null >/dev/null 2>&1 & fi
  sleep 2
fi
```

（`setsid`/`nohup` + 重定向 + 后台 = 服务器**不会**挂在我们这条 ssh 上，ssh 断开它照样活着；
启动时会在 stderr 打一行中文提示，观察窗/控制流会把它显示到状态栏。）

顺手加了单测：**每一条** API 命令都必须包含这段、且必须是单行。

验证（矩阵里新增三条，用的是**独立 session**，不动用户默认 session 的服务器）：

```
PASS  能判断「服务器在不在跑」（我们是按 status: running 这一行判的）      status: running
PASS  没有服务器时，herdr 会明确报 server_not_running
PASS  自己把服务器起起来之后，新建工作区就成功了（重启后我们也能自愈）
PASS  临时 herdr session 已清理
```

矩阵总数从 15 条增加到 **20 条，全绿**。

### 第六轮（用户当天再报）：新建 herdr 窗格"一直卡住"

用户点了「用 herdr 打开 / 新建一个 herdr 窗格 / 连接」，状态栏停在
"正在 herdr 里新建一个窗格…" 不动。

**查证**（用他自己的应用日志 + 进程表，不猜）：

- 日志里 10:46:58 开过普通 shell、10:47:09 探测成功，但**之后完全没有**
  `herdr_workspace_create` —— 说明请求根本没到后端，卡在"一次性远端采集"里
  （那条链路 20 秒超时，超时前不打日志）；
- 本机同时有 **41 个残留 ssh 进程**（最早的是前晚 2:49 的，当天 10:46 那次的也在），
  父进程全都退出了 —— 全是孤儿。

**根因**：`run_capture` / `run_capture_checked` / `run_scp` 用的是 `Command::output()`，
而 `run_remote_capture` 的 20 秒超时**只丢 future、不杀子进程** →
**每超时一次就漏一个 ssh** → 越积越多 → 服务器的 sshd 被拖到"新连接排队/丢弃" →
表现就是"新建窗格一直卡着"。这也解释了为什么它是**偶发**的：连接数攒到一定程度才出问题。

**修法**：

1. 三个一次性采集函数改成 `spawn()` + `kill_on_drop(true)` + 挂 Job Object ——
   超时/应用退出时 ssh 跟着死，不再累积；
2. `ZEEAI_SELFTEST` 收尾顺手 `adb kill-server`（它起的 adb 守护进程会占着构建要用的 DLL）；
3. 真机矩阵例程自己收尾：只杀**这次新起**的 ssh（pid 差集，不碰用户自己的 ssh），
   并把"等首帧"从固定 sleep 3 秒换成**轮询最多 8 秒**（握手慢时会误报 observe 失败，
   这个偶发已复现并消除）。

**现场清理**：41 个孤儿 ssh 全部收掉；服务器 sshd 立刻恢复（连续 5 次 1.3 秒响应）。

**验证**：`cargo test --lib` 73 通过；真机矩阵 **20/20**（连跑两次稳定，跑完剩余 ssh = 0）；
无头前端 **37/37**；便携版冒烟通过、退出后零残留。

### 仍然**没有**验证的（如实列出）

1. 真机上的**像素观感与打字手感**（延迟、中文输入、宽高比例）—— 数据链路已逐条验证，
   但"看起来顺不顺眼"需要人眼；
2. **herdr 服务器冷启动**（服务器重启后第一次连）—— 没敢在用户的默认 session 上实测
   （会关掉他正在用的 herdr 工作区）；
3. **非 Linux 服务器 / 密码登录服务器**走不到这条路（前者一键安装会被拒、后者输入通道会明确报错）；
4. 多客户端**真实并发抢控制权**（我只模拟了"程序化 takeover"）。
