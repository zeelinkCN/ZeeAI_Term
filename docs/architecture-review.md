# ZeeAI Term 架构审查（v0.1.13 · 只读）

> 基线：`codex/workspace` @ `42597e8`（tag `v0.1.13`）。本次**没有改任何源码**、没有提交、没有启动应用。
> 所有结论都给了 `文件:行`，无法当场验证的标注「待验证」并写了验证办法。
> 上一份同类文档是 `docs/review/tech-optimization-proposals.md`（v0.1.7，673 行）—— 那份里的问题**大部分已经修了**，
> 本文只在开头逐条确认"改没改"，不重复已解决的问题。

> ⚠️ **审查期间工作区出现了并行改动（未提交，不是本文产生的）**：`git diff --stat` = `commands.rs +195` / `store.rs +326` /
> `sftp.rs +95` / `tmux.rs +22` / `Cargo.toml +1`，并新增 `core/known_hosts.rs`。本文只新增了本文件，没有碰任何源码。
> **所有行号以 HEAD `42597e8` 为准**；凡"工作区已经改掉了"的条目，在表里标 **🟡**（= 结论在 HEAD 成立，但你现在去读代码会看到已修）。
> 这也意味着：`commands.rs`（3,742 → 3,897 行）、`store.rs`、`sftp.rs`、`tmux.rs` 的行号会整体后移。

---

## 一页摘要（≤25 行，可直接转给用户）

1. **选型不用换。** Tauri 2 + Rust/WebView2 + React + xterm 适合这个产品：产物 8.64MB（Electron 同功能一般 80–150MB）。现在的体感问题都不是选型造成的。
2. **真正的债是"一个文件装一个产品"**：`App.tsx` 11,735 行，`App()` 一个函数 10,374 行、JSX 4,557 行、61 处 useState / 159 个内嵌函数 / 0 个 memo、0 个 useCallback。
3. **后端同构**：`commands.rs` 3,742 行 / 97 个命令，81 个返回 `Result<_,String>`（无错误枚举）；`core/` 26 模块 10,443 行，但 `core/ai_herdr_dots.rs:527` 反向依赖 `commands`。
4. **性能热点已定位**：AI 面板打开时每秒重算看板并重渲整棵树（`App.tsx:1088-1097/1252/3677-3686`）；PTY 每片都 base64 + 一次 IPC、无合并无背压（`core/pty.rs:136-158`）——与 `docs/design.md:147-155` 写的"16ms 合并 + 二进制通道"相反。
5. **影响最大的是发布**：没有 CI（无 `.github/`）、没有代码签名（全仓 0 处）、发版靠本机 `GH_TOKEN` 手工跑脚本 → SmartScreen 拦截 + 版本号靠人工核对。
6. **最便宜的一批修复**（各 ≤1 小时）：🔴 补主机密钥校验（HEAD 里 russh 路径 `check_server_key` 无条件 `Ok(true)`，工作区正新增 `core/known_hosts.rs`）；加 `ErrorBoundary`（现在渲染异常=白屏）；`fs_list` 漏传 `user_override`（`commands.rs:1226`）；`save_history` 非原子写（`store.rs:488`）；sha256 走 PATH 上的 `certutil`（`commands.rs:2448`）。
7. **测试只覆盖"纯函数 + 假后端 UI"**：Rust 139 条、前端 150 条断言（约 144 秒）；真 SSH、真 TUI、并发、长跑、内存、WebGL 全无覆盖。
8. **建议顺序**：① CI 红绿灯 ② 前端三处止血 ③ 5 个数据/安全小坑 ④ 签名 ⑤ 输出链路插桩；3 个月做 App.tsx 拆分 + store + IPC 类型生成 + 真链路集成测试；12 个月做后端分层/插件化 + 可观测性 + 跨平台评估。
9. **这次不做**：换栈（Electron/原生/egui·Slint）、差分包更新、macOS/Linux 移植、i18n 全量、自研多路复用协议。

---

## 0. 上一份审查（v0.1.7）的落实情况

不是为了表扬，是为了**不重复提已经做完的事**（也让"还剩什么"可信）。

| 上版条目 | 状态 | 现在的证据 |
|---|---|---|
| T-01 升级脚本被挂进 Job Object（P0） | **已修** | `commands.rs:2721-2730` 明确写"千万别把升级脚本挂进 Job Object"，且代码里确实没有 `job::assign(child.id())` |
| T-02 MSI 装完不重启 | **已修** | `commands.rs:2530-2537` `AUTOLAUNCHAPP=1` |
| T-03 每次升级留 9–14MB 安装包 | **已修** | `sweep_update_dir` + 成功路径删包（`commands.rs:2156`） |
| T-04 重试从 0 重下 | **已修** | `-C -` 续传 + 三次不同策略（`commands.rs:2162-2167`） |
| T-05 更新包校验形同虚设 | **部分修** | 仓库前缀锁死 `commands.rs:2067`、必须带 size `2621`；但 sha256 仍是**可选**且由前端传入（见 C-05） |
| T-07 持全局锁做阻塞 IO | **已修** | `commands.rs:351-371`（先取 Arc 放锁 → `spawn_blocking`） |
| T-08 远端探测无超时 | **已修** | `REMOTE_CAPTURE_TIMEOUT = 20s` + `tokio::time::timeout`（`commands.rs:1546/1580`） |
| T-09 配置写入非原子 | **部分修** | `store::write_atomic`（`store.rs:156-173`）已用于 profiles/settings/workspace；**history 还是裸 `fs::write`**（`store.rs:492`） |
| T-11 日志 ANSI 过滤三处 | **已修** | `session_log.rs:42-96` + 6 条单测（含分片边界） |
| T-17 所有会话都占 WebGL | **已修** | 只有看得见的终端挂 WebGL，藏起来就摘（`Terminal.tsx:764-779`） |
| T-23 platform-tools 5.2MB 死代码 | **已修** | 目录现在只剩 5 个文件 11.48MB，全仓 0 处引用 `sqlite3.exe` 等 |
| T-24 没有 `[profile.release]` | **已修** | `Cargo.toml` 里 thin-LTO / strip / panic=abort / codegen-units=1 |
| T-25 前端 848KB 单包、零分割 | **未修** | 现在是 **897KB 单 chunk** + 43.3KB CSS（`dist/assets/index-3ZBDQWY8.js`） |
| T-26 日志每片 flush | **已修** | 64KB / 200ms 批量落盘（`session_log.rs:178-198`） |
| T-30 7 处版本号、无 CI | **部分修** | `check-docs.mjs` 守 4 类漂移；`publish-release.ps1` 校验 4 个文件 + 文档；**CI 仍然没有** |
| T-31 便携版手工打包 | **已修** | `scripts/build-portable.ps1`（147 行，含"改名让位"处理文件锁） |
| T-32 App.tsx / commands.rs 拆分 | **未修，且更大了** | App.tsx 7,384 → **11,735 行**；commands.rs 2,304/73 → **3,742/97 个命令** |

---

## A. 技术选型评价

### A.1 这套栈对这个产品好在哪（每条都有证据）

| 好处 | 为什么对"终端工作台"特别重要 | 证据 |
|---|---|---|
| 产物小 | 终端工具要能"随手给人装一个"。现在 exe **8.64MB**、便携 zip **8.92MB** | `src-tauri/target/release/ZeeAI_Term.exe`、`portable/ZeeAI_Term-0.1.13-portable.zip` |
| 前端就是 Web 技术 | 14 套界面主题 + 15 套终端配色 + Markdown/HTML 预览 + 可拖拽侧栏，这些用原生 Win32/Qt 做要贵一个量级 | `App.tsx:940-960`（THEMES）、`termThemes.ts` 497 行、`App.tsx:11634`（markdown+DOMPurify） |
| xterm.js 是成熟轮子 | 终端仿真（CSI/OSC/DEC 私有模式、真彩、bracketed paste、字形图集）自己写要几年 | `Terminal.tsx` 999 行里绝大多数是"和真实 TUI 打架"的经验（`Terminal.tsx:501-560` 的 200ms 回车、`:690-702` 的 OSC 7/133） |
| Rust 侧真能碰到系统底层 | Job Object、`CREATE_NO_WINDOW`、`ShellExecuteExW runas`、命名互斥体、凭据管理器 —— 这些在 Electron 里要么做不了要么得写 native addon | `core/job.rs`、`core/proc.rs:46-55`、`core/elevate.rs`、`instance.rs:20`、`core/secret.rs` |
| 原生 SSH/串口/SFTP 都在进程内 | 不需要 sidecar、不额外分发二进制；`portable-pty`/`russh`/`serialport` 全静态链接 | `Cargo.toml` 依赖段 |
| 单二进制 + 自带资源 | ADB platform-tools 直接打进包，用户免装 | `tauri.conf.json:33` |

### A.2 代价（不是理论，是这个仓库正在付的账）

1. **WebView2 是硬依赖，且离线场景没兜住。** `tauri.conf.json:31-44` 的 bundle 段**没有** `windows.webview2.installMode`，
   默认走"下载 bootstrapper"。内网/无网机器装完可能打不开（**待验证**：找一台没有 WebView2 Runtime 的 Win10 断网装 NSIS 包）。
   代价可量化：改成 `embedBootstrapper` 约 +1.5MB。
2. **两套语言栈 = 两套调试心智。** `AGENTS.md` 154 行几乎全是"跨层踩坑"的沉淀（"进程起来了≠界面能打开"、"release 里没嵌前端"、
   "改图标要 `cargo clean -p`"）。这不是文档写得啰嗦，是 IPC 边界本身会制造这类问题。
3. **WebView2 的内存/GC 不完全可控。** 11.7k 行组件 + 897KB 单包 + 每条会话一个 xterm 实例，前端内存曲线只能靠"少挂 WebGL"这种土办法压（`Terminal.tsx:353-359`）。
4. **原生能力要手写。** 4 个 `windows-sys` 手写模块（`job.rs`/`proc.rs`/`elevate.rs`/`instance.rs`）+ `commands.rs` 里的注册表/`where`/`curl` 探测，都是"能跑但不通用"的代码，跨平台等于重写。
5. **CSP 为 null**（`tauri.conf.json:27-29`），而渲染层会 `fetch` 用户可填的更新 URL（`App.tsx:5851`）—— 这是选型默认值带来的敞口，不是业务 bug。

### A.3 和 Electron / 原生 Win32 / Qt / egui / Slint 的关键决策点

| 维度 | Tauri 2（现状） | Electron | 原生 Win32 (C++/C#) | Qt Widgets/QML | egui / Slint |
|---|---|---|---|---|---|
| 包体 | **8.64MB exe（实测）** / NSIS ~6.5MB（README 标注） | 80–150MB（行业经验值） | 5–15MB | 30–60MB（含 Qt 运行库） | 5–15MB |
| 终端渲染性能 | xterm + WebGL，够用；瓶颈在数据链路（见 B.6） | 与 Tauri 同（也是 Chromium + xterm） | 最好，但要自己写终端仿真 | 好，但终端控件要自研 | 好，但**没有成熟终端控件** |
| 运行时依赖 | **WebView2**（Win11 自带，Win10 要装） | 自带 Chromium（无外部依赖） | 无 | 需带 Qt 运行库 | 无 |
| 跨平台 | 三平台都有，但本项目只做 Windows | 三平台 | 仅 Windows | 三平台 | 三平台 |
| 生态 | 前端生态全量 + Tauri 插件 | 最全 | 最少 | 中（Qt 模块全） | 少 |
| 开发速度（这种 UI 密度） | **最快**（React + CSS + xterm） | 快 | 慢 2–3 倍 | 中 | 慢（Rust GUI 迭代慢） |
| 对"AI 面板/看板"这类经常改的 UI | 最合适 | 最合适 | 不合适 | 一般 | 一般 |

**决策点一句话**：这个产品 80% 的界面是"列表 + 卡片 + 终端 + 对话框"，是 Web 技术的主场；20% 是系统集成（Job/提权/串口/凭据），Rust 侧已经写完并稳定。
**唯一会让人想换栈的理由是 WebView2 的内存与离线依赖**，而这两条用配置 + 纪律就能压住，不值得换。

### A.4 有没有"必须现在改"的选型错误？

**结论：没有。** 三条可证伪的判据：

1. **体积已经打到位**：8.64MB exe（`[profile.release]` 已开 thin-LTO/strip/panic=abort）；同功能 Electron 的 1/10 量级。再优化空间主要在资源（platform-tools 11.48MB 仍占 zip 一大半），不在框架。
2. **性能瓶颈全在应用层，不在框架**：base64 编解码、每片一次 IPC、每秒全树重渲染、双 SSH 栈 —— 这四条换成任何框架都还在（见 B.2/B.6）。
3. **没有"框架做不到"的功能缺口**：ADB/串口/SFTP/tmux/herdr/提权/托盘/单实例全部跑通了；剩下没做的是产品决策（`docs/backlog.md:225-236`），不是能力缺口。

**只有两件属于"配置上现在就该改"的**（不是选型）：
- `csp: null` → 给一个最小 CSP（至少禁 `unsafe-eval`、限 `connect-src`）；
- WebView2 `installMode` 至少设 `embedBootstrapper`，否则内网用户装不上（**待验证**）。

---

## B. 现状架构评价

### B.1 前端结构

**体量（硬数字）**

| 文件 | 行数 | 说明 |
|---|---|---|
| `src/App.tsx` | **11,735** | 其中 `App()` 组件 `1128–11501` = **10,374 行**；返回的 JSX `6944–11500` = **4,557 行** |
| `src/features/Terminal.tsx` | 999 | 唯一的"真组件"，质量最好 |
| `src/highlight.ts` | 530 | 高亮引擎（纯函数，只有 fe-smoke 间接覆盖） |
| `src/styles.css` | 3,279 | 412 个选择器，全局样式（无 CSS Module / 无 scoped） |
| `src/ipc.ts` / `types.ts` | 871 / 753 | 手写 IPC 封装 + 手写类型（54 个 interface/type） |
| `src/App.tsx` 以外全部 | 8,589 | 也就是说：**58% 的前端代码在一个文件里** |

**状态管理**

- **没有 store**：整个文件 **61 处 `useState`**（`App()` 内 60 处，`App.tsx:1132-1622` 一路排下来 + `useUiClock` 1 处），外加一堆 `useRef` 镜像（`sessionsRef`/`profilesRef`/`settingsRef` 等）用来给事件回调读最新值。
- **没有 `useCallback`、没有 `React.memo`、没有 `React.lazy`**（全仓 0 处）：**159 个内嵌函数**（`App.tsx` 里 2 空格缩进的 `function`）每次渲染全部重建，传给子组件的都是新身份。
- 全局/局部混在一起：`form`、`editDialog`、`newDialog` 这类"纯对话框草稿"和 `sessions`、`profiles`、`settings` 这类"真全局"住在同一个组件里。

**组件拆分现状**

- 真正拆出去的只有 3 个：`TerminalView`（`Terminal.tsx`）、`TermThemeDialog`（360 行）、`HighlightDialog`（349 行）；
- `LocalModule`、`FileView` **定义在 App.tsx 文件末尾**（`App.tsx:11523`、`11596`），和 App 同文件；
- 侧栏整块（`App.tsx:6996–8373`，约 **1,378 行** JSX）、标签栏（`8376–8480`）、AI 面板与看板（`8681–9100+`）、设置面板（`~10300–11200`）全部内联在主返回树里；
- 卡片不是组件而是**函数**：`boardCard(i)`（`App.tsx:3705–3935`，231 行）在 `map` 里被当函数调用（`8873`），所以 React 无法给它一个 memo 边界。

**懒加载 / 代码分割**

- `vite.config.ts:13-16` 没有 `manualChunks`、没有 `build.rollupOptions`；
- `markdown-it` + `dompurify` 在 `App.tsx:7-8` **静态引入**，但只在"点开 MD/HTML 预览"时才用（`App.tsx:11634`）；
- 结果：`dist/assets/index-3ZBDQWY8.js` = **897KB 单 chunk**，首屏必须解析完整包（含终端配色、highlight、markdown、所有面板代码）。这是启动 ~1s 里"解析 + 首次渲染"的固定成本。

**渲染热路径（按"每秒发生多少次"排序）**

| 热路径 | 频率 | 证据 | 现在的处理 |
|---|---|---|---|
| 终端字节流 | 每秒几十~上千次 | `bus.push` → `term.write`，**不过 React** | ✅ 设计正确（`App.tsx:3945-3949`、`Terminal.tsx:495-499`） |
| AI 看板重算 + 整树重渲 | **每秒 1 次**（面板打开时） | `useUiClock(aiPanelOpen)`（`1088-1097`）→ `aiUiNow`（`1252`）→ `boardShown`（`3677-3686`） | ❌ 整棵 4,557 行 JSX 重新 diff |
| 会话状态/标题/cwd | 每条命令 1–2 次 | `handleEvent`（`3945-3974`）、`handleTerminalCwd`（`3981-3988`） | ⚠️ cwd 有"值没变就不 set"的守卫，其余没有 |
| 命令退出码 | 每条命令 1 次 | `setCmdExit(prev => ({...prev, [id]: ...}))`（`8548-8550`） | ⚠️ 每次都新对象 → 必重渲 |
| 配置/标签/对话框 | 用户操作时 | 61 个 setState | ⚠️ 任意一个都重渲整树 |

> 一句话：**终端这条最热的路径躲开了 React（很好），第二热的那条（AI 面板每秒 tick）却把整棵树拖着一起渲（很贵）。**

### B.2 IPC 层

**数量与一致性（这部分做得比多数项目好）**

- `commands.rs`：**97 个 `#[tauri::command]`**、3,742 行；`lib.rs` 另有 2 个（`frontend_ready`/`startup_mark`），共 **99 个注册**（`lib.rs:629-731`）；
- `ipc.ts`：**97 个导出函数**，**逐个核对：前端调用的命令 100% 都已注册，注册的也 100% 都被前端用到**（除上面 2 个启动命令）—— 没有"调不通的命令"这种低级漂移；
- 命令名分区清楚（`commands.rs` 里的 `// ---------- Git / 串口 / herdr … ----------` 共 20 处分节）。

**职责混杂（问题在这里）**

| 现象 | 证据 |
|---|---|
| 一个命令管 5 种后端 | `open_ssh`（`137-340`，**206 行**）同时处理 `herdr-pane`/`herdr-control`/`herdr`/`tmux`/裸 shell |
| 超大函数 | `fetch_update_package` **469 行**（`2135-2603`）、`fs_download` 228 行（`1367-1594`）、`herdr_install` 263 行（`3296-3558`）、`settings_set` 130 行（`3612-3741`） |
| 业务逻辑写在命令里 | `open_ssh` 里直接拼 `SshConfig` → 远端命令 → 标题字符串；`update_download_install` 里直接写升级 `cmd` 脚本（`2518-2600`） |
| 同步命令 41 个 / 异步 57 个 | 同步命令在 Tauri 2 里跑在**主线程**（框架行为）。其中 `open_local`/`open_ssh` 会做 `store::load()`（读盘）+ ConPTY 启动，`restart_as_admin` 走 `ShellExecuteExW` —— 都有一点主线程阻塞风险 |

**错误类型**

- **81 处 `Result<_, String>`，0 个错误枚举**（`grep 'Result<[^>]*, String>'`）；前端只能 `String(e)` 然后 `notify()`。
- 好处：简单、中文提示能一路带到状态栏（`ssh::friendly_ssh_error` 把 russh 英文错误翻成"中文短句｜原始信息：英文"，`ssh.rs:332-358`）。
- 代价：**前端无法按类型分支**（例如"认证失败"要不要弹密码框、"超时"要不要重试），只能靠字符串包含（`App.tsx:745-762` 的 `looksLikeAuthFailure` 就是字符串匹配）。这是现在"重连/重试"逻辑分散在各处的根因。

**前后端契约：手写，已经出现漂移**

- `types.ts`（753 行）是手抄 Rust 结构体的镜像；`ipc.ts` 手抄命令名与参数名；
- **已确认的漂移**：TS 的 `SessionEvent` 有 5 个分支，含 `cwd`（`types.ts:69-74`），`App.tsx` 也写了处理分支（`3969-3973`）；
  但 Rust 的 `SessionEvent` **只有 4 个变体，没有 `Cwd`**（`core/session.rs:13-18`）→ 这段前端代码是死代码，真正的 cwd 走 OSC 7（`Terminal.tsx:690-694`）。
- 另有一处"阈值漂移"：前端 resize 闸门是 40×12（`Terminal.tsx:149-150`），后端是 20×5（`commands.rs:2949`）—— 两层各留了一份魔数。

**事件名 / 载荷一致性**

- 后端只发 4 个事件：`zeeai://transfer`（`commands.rs:1287/1389/1496`）、`zeeai://ai-log`（两处同名常量：`ai_herdr_dots.rs:68`、`ai_log_watch.rs:44`）、
  `zeeai://herdr-agents`（`ai_herdr_dots.rs:75`）、`zeeai://autodemo`（`lib.rs:191`，仅 selftest）；
- 前端 `listen` 全部对上（`App.tsx:2171/3408/3502`），`ai-log` 的两个来源靠 `source` 字段区分（`ai_herdr_dots.rs:62-68` 有明确解释）。
- 结论：**事件这块是整份代码里最干净的一层**。

### B.3 Rust 领域模块

**边界（`core/mod.rs:1-30`，26 个模块，10,443 行）**

| 域 | 模块 | 行数 | 边界评价 |
|---|---|---|---|
| 会话/进程 | `pty` `session` `job` `proc` `herdr_stream` | 284/81/67/105/124 | ✅ 清晰；`proc.rs` 是"防黑窗"唯一收口点，41 处调用 |
| SSH 通路 | `ssh` `sftp` `remote_fs` `tmux` | 444/642/138/192 | ⚠️ **两条 SSH 栈**（见下） |
| 设备 | `serial` `adb` | 179/149 | ✅ 小而清晰 |
| AI 域 | `ai` `ai_instance` `ai_sessions` `ai_tasks` `ai_history` `ai_herdr_dots` `ai_log_watch` | 138/1,500/1,310/770/161/981/883 | ⚠️ 5,743 行，是后端最大的一块；`ai_instance` 承载"合并/去重/陈旧降级"是**正确的归属**（前端不再自己合并，`ipc.ts:375-386` 有说明） |
| 其它 | `git` `paste` `elevate` `secret` `highlight` `session_log` | 158/157/132/52/129/282 | ✅ |

**依赖方向（有一处反向）**

- 正常：`commands → core → (无)`。
- **反向**：`core/ai_herdr_dots.rs:527` 调 `crate::commands::herdr_agents(...)`，`:586` 调 `crate::store::load()` —— **core 依赖 IPC 层**。
  更值得注意的是：有一条第 903-915 行的**单元测试用 `include_str!` 把源码读进来 grep**，**强制要求**这行存在（`code.contains("crate::commands::herdr_agents")`）。
  也就是说：这个依赖被测试钉死了，想改得先改测试。短期无害（模块注释解释了"要和用户点刷新走同一条链路"），长期是"底层不能单测"的地雷。
- 另一处结构性债务：**两条 SSH 实现**。
  - 终端：`ssh::ssh_args` → 系统 `ssh.exe`（`ssh.rs:104-147`），复用用户的 `~/.ssh/config`、agent、known_hosts；
  - SFTP/一次性命令/密码登录：`russh`（`sftp.rs:69-139`），密钥候选**只有 3 个固定文件**（`sftp.rs:54-65`），**不支持 ssh-agent、不读 `IdentityFile`**，认证只试"密码 + 3 个 key"（`sftp.rs:161-205`）。
  - 用户可感知的后果：**用 agent 免密登录的服务器，终端能进，但文件面板/AI 看板报"认证失败"**（置信度：高；**待验证**：用一台只配了 agent、没有私钥文件的服务器点开文件面板）。
- `commands.rs:750-776` 的 `ssh_config`/`ssh_config_for` 是唯一的配置读取口，方向正确。

**单例 / 全局状态**

- 5 个 `manage()` 全局注册表（`lib.rs:621-628`）：`SessionRegistry`（`Mutex<HashMap>`）、`HerdrPaneRegistry`（两张 map）、`LogRegistry`、`AiTaskRegistry`；
- 4 个进程级 static：`STARTUP_T0`、`WINDOW_SHOWN`（`lib.rs:13-15`）、`job::JOB`（`job.rs:20`）、`ai_herdr_dots::STOP`（`:90`）；
- 这些是合理的（进程内唯一），但**都是 `Mutex`**：`.lock()` + `map_err` 24 处、`.lock().unwrap()` 0 处（panic 纪律好）。

**线程模型（tokio + std 混用）**

| 用在哪 | 手段 | 证据 |
|---|---|---|
| PTY 读 | **每个会话一个 `std::thread`** | `pty.rs:136` |
| 会话写/resize/close | `tokio::task::spawn_blocking` | `commands.rs:365/391/438` |
| 一次性远端命令 | `tokio::process` + `timeout(20s)` | `commands.rs:1580` |
| 下载 | `spawn_blocking` + `std::thread::sleep(400ms)` 轮询 | `commands.rs:2423-2433` |
| 后台轮询 | `std::thread::spawn` + 分片睡眠 + `AtomicBool` 停止位 | `ai_herdr_dots.rs:77-90` |
| 文件监听 | `std::thread` 2.5s 一轮 | `ai_log_watch.rs` |

混用本身没错（同步阻塞必须离开 async 运行时），但代价是**没有统一的取消模型**：`tokio::time::timeout` 全仓只有 **1 处**（`commands.rs:1580`）；
SFTP 上传/下载（`sftp.rs:354-465`）、`russh` 连接、`curl` 下载（有 curl 自己的超时）都没有统一取消 —— 用户点"取消"目前靠"关会话/退出应用"。

**资源生命周期（这部分做得不错）**

- Job Object `KILL_ON_JOB_CLOSE`（`job.rs:29`）+ PTY 子进程显式 `assign`（`pty.rs:118-120`）→ 应用被强杀也不留孤儿 ssh；
- 退出路径显式 drain 会话并 kill（`lib.rs:747-764`）、`ai_herdr_dots::stop()`；
- 会话关闭时同时清 3 张表（session / pane meta / input pump，`commands.rs:414-425`），herdr control 流还会先发 `release`（`431-445`）。

### B.4 持久化

**5 个 JSON + 日志目录，位置不统一**

| 数据 | 路径 | 写入方式 | 证据 |
|---|---|---|---|
| 服务器/串口配置 | `%APPDATA%\ZeeAI-Terminal\profiles.json` | `write_atomic` | `store.rs:123-130/712-716` |
| 设置 | `…\settings.json` | `write_atomic` | `store.rs:437-440` |
| 历史 | `…\history.json` | **裸 `fs::write`（非原子）** | `store.rs:488-493` |
| 工作区快照 | `…\workspace.json` | `write_atomic` | `store.rs:207-209` |
| AI 时间线 | `…\ai_turns.json` | `write_atomic` | `store.rs:203-205` |
| 会话日志 | `…\logs\sessions\<name>-<ts>.log` | `BufWriter` + 64KB/200ms | `session_log.rs:127-155/178-198` |
| 启动打点 | **`%LOCALAPPDATA%\com.zeeai.terminal\logs\startup-marks.log`** | 直接 append | `lib.rs:29-46` |

- 前 6 项在 `%APPDATA%\ZeeAI-Terminal`，第 7 项在 `%LOCALAPPDATA%\com.zeeai.terminal` —— **同一产品两套目录**（一个用产品名、一个用 identifier），排查时要记两个路径。
- **并发写**：进程内没有文件级互斥；`settings_get`/`settings_set` 是同步命令（主线程），`on_window_event` 里读设置（`lib.rs:735`）也在主线程 —— 同一进程内不会交错，靠的是"都在主线程"这个隐含前提；单实例互斥体（`instance.rs:20`）挡住了跨进程。**前提一旦被打破（比如把 settings 写入挪进 spawn_blocking）就会出现后写覆盖**，建议加一把 `Mutex<()>` 或"读-改-写"在一个函数内完成。
- **迁移 / 版本化**：**没有 schema version 字段**（`Settings` 全文，`store.rs:238-334`）。迁移靠"字段缺失就用默认值 + 事后补丁"（`store.rs:410-428` 把老 `highlight_rules` 迁成"默认"规则集；`store.rs:412-414` 补 `update_url`）。现在能用，但**每次加字段都是一次隐性迁移**，且没有"我这份配置是哪一版写的"可查。
- 容错做得对：解析失败先备份 `.bad-<ts>` 再回落默认（`store.rs:179-190`），不会静默清空。
- 日志：**无轮转、无上限**（`session_log.rs:131-136` 每次 `File::create` 覆盖同名，名字带时间戳所以不会撞），长期使用会在 `%APPDATA%` 里堆几十上百 MB。

### B.5 并发与资源

**做得对的**

- 全局锁的持锁范围被严格收窄：`session_write`/`resize`/`close` 都是"取 Arc 就放锁"（`commands.rs:351-371/381-404/412-425`）—— 这是 v0.1.7 那次 P1 的修复，现在没有"一个卡住的会话拖死全部"的问题；
- PTY 读线程遇到 EOF 会发 `state: closed`（`pty.rs:150-157`），并且用共享 `close_flag` 区分"我让你停的"和"真的断了"（`pty.rs:14-30`）—— 这个细节很少见，避免 herdr 观察窗 resize 时误报断线；
- 隐藏窗口纪律：41 处 `hidden_command`、只有 1 处故意裸 `Command::new`（`commands.rs:2023`，explorer 需要窗口），还有 2 条源码级测试防止回退（`ai_log_watch.rs:617-627`、`ai_herdr_dots.rs:900-915`）。

**风险点**

1. **异步取消基本不存在**：`timeout` 仅 1 处。用户在 SFTP 传 2GB 时想取消，只能关标签/关应用：右下角传输面板只有一个"清空列表"（`App.tsx:9251-9292`），97 个后端命令里没有任何 cancel/abort。
2. **herdr 输入泵是阻塞写**：`HerdrPaneRegistry.inputs: Mutex<HashMap<String, Arc<Mutex<ChildStdin>>>>`（`session.rs:72-81`），写入丢进 `spawn_blocking`，但没有写超时；远端不回读时该任务会一直挂着。
3. **`herdr_pane_resize` 会重建整条流**（`commands.rs:3014-3040+`）：拖窗口时前端 150ms 合并（`Terminal.tsx:168`），后端还要 kill + 重新 spawn 一条 ssh —— 一次拖动可能触发 1–2 次 SSH 重连，成本不低（观感上"闪一下"）。
4. **`LogRegistry` 单锁**：所有会话的日志写入共用一把 `Mutex`（`session_log.rs:118`），高吞吐多会话时是串行点（单会话 16KB/片，影响有限，但它是全局的）。
5. **窗口关闭到托盘时不停会话**（`lib.rs:732-742`）：设计如此（后台继续跑 AI），但意味着"关窗口"≠"释放资源"，用户不容易预期。

### B.6 性能与可观测性

**有没有分层计时/指标？——基本没有。**

- 只有启动打点：`lib.rs:26-47` 往 `startup-marks.log` 写 `stage=… at_ms=… pid=…`，前端 `main.tsx:29-32` 和 `startup.ts:81-83` 打 `frontend_ready` / `startup_mark`；
- 别的计时都是"临时埋点"：`ai_herdr_dots.rs:582`、`ai_log_watch.rs:507`、`lib.rs:523/546`（selftest 里量 herdr 调用耗时）；
- **没有**：IPC 单命令耗时、PTY→xterm 端到端延迟、每秒 IPC 消息数、xterm 写队列深度、每秒字节数、内存占用曲线、打开 N 个会话的渲染帧率。
- 也就是说：**"卡"、"慢"、"越用越慢"这三类用户报障，现在只能靠人肉复现**（`AGENTS.md:130` 的建议就是"截一张图亲眼看过"）。

**输出链路（PTY → IPC → xterm）可能的放大点**

```
ssh.exe / shell ──(ConPTY, 16KB buf)──► std::thread 读循环（每会话 1 个）
     │ pty.rs:136-149
     ├─► logs.write()（ANSI 过滤 + 64KB/200ms 批量落盘）
     └─► base64 编码（+33% 体积）→ SessionEvent::Data{data:String}
              │ pty.rs:144-145
              ▼
        Tauri ipc::Channel（JSON 序列化）
              ▼
        App.handleEvent → bus.push → b64ToBytes（atob + 逐字节循环）→ term.write
              │ App.tsx:3948 / util.ts:10-15 / Terminal.tsx:495-499
              ▼
        xterm → 高亮器（可选二次扫描）→ WebGL 渲染
```

放大点排序（按我判断的收益）：

| # | 放大点 | 证据 | 代价 |
|---|---|---|---|
| 1 | **每片一次 IPC + 一次 base64**，无时间/大小合并 | `pty.rs:136-158` | 中（改成 Rust 侧 8–16ms 合并 + Tauri 2 的 `Channel<Vec<u8>>`/`tauri::ipc::Response` 二进制通道） |
| 2 | **无背压**：读线程不看前端是否消化得过来 | `pty.rs:145`（`sink` 直接 send） | 中（加有界队列 + 丢弃/合并策略）；当前无界会导致"刷屏时内存涨"（**待验证**：跑 `yes` 30 秒看 RSS） |
| 3 | 前端 base64 解码逐字节循环 | `util.ts:10-15` | 小（`atob` 后直接 `Uint8Array.from(bin, c=>c.charCodeAt(0))` 或让后端发二进制就没这一步） |
| 4 | 高亮器在 `term.write` 之前再扫一遍字节 | `Terminal.tsx:492-499` | 小（已按开关短路） |
| 5 | AI 面板每秒整树重渲 | `1088-1097/1252/3677-3686` | 小–中（下游时钟 / 切片订阅） |
| 6 | 每个会话都常驻一个 xterm 实例（`display:none` 藏着） | `App.tsx:8589-8600` | 中（懒挂载 + 保留 scrollback 序列化，工程量较大） |

> 注意：`docs/design.md:147-155` 写的是"Rust 侧约 16ms 合并 + Channel 直接传二进制 + 前端背压"，**这三条都没实现**。
> 这不是"文档过时"，而是**设计意图与实现的偏差**——建议要么照文档做，要么把文档改成现实（现在两边都不算数）。

**回滚缓冲 / 内存增长**

- 默认 `scrollback: 10000` 行/会话（`store.rs:349`），N 个会话 = N 份（单窗格模式下**所有会话都挂着**，`App.tsx:8589-8600`）；
- WebGL 上下文只在可见时挂（`Terminal.tsx:353-359`），这条已经修好；
- `aiHandledTurns` / `aiSeeded` 这类集合只增不减（`docs/backlog.md:231-232` 已记录，未修）——长跑（几天不关）会缓慢涨。

**GC / 重渲染风险**

- 每秒 tick 会让 61 个 state 的闭包全部重建，V8 每秒产生一批可回收的闭包 + 新 props 对象；单看一秒不算什么，但它和"终端持续输出"叠加时，主线程会出现可感知的抖动（**待验证**：Performance 面板录 60 秒，看 long task）。

### B.7 测试体系

**强项（比同规模项目好）**

- Rust：**139 个测试**（138 `#[test]` + 1 `#[tokio::test]`），25 个 `#[cfg(test)] mod`；覆盖重点正好是"最容易错又最难手工验"的地方：
  分片边界的 ANSI 过滤（`session_log.rs:253-282`）、herdr JSON 粘包（`pty.rs:228-283`）、
  历史去重键（`store.rs:739-806`）、更新包校验（`commands.rs:3617-3655`）、
  herdr 状态机（`ai_herdr_dots.rs` 13 条）、AI 实例合并（`ai_instance.rs` 16 条）、
  参数拼接（`ssh.rs:360-443`、`tmux.rs:150-207`）。
- 前端 `fe-smoke.mjs`：**150 条断言**、4,232 行，用无头 Edge + CDP + **假后端**（替换 `invoke`），真的点按钮、切换场景、出 26 张截图；
  断言写的是"用户看到的文字"（例如"点「刷新」→ 按钮变「探测中…」且不可点"，`fe-smoke.mjs:948-952`），而不是查代码。
- 还有一类"纪律测试"：用 `include_str!` 扫源码禁止裸 `Command::new`（`ai_log_watch.rs:617-627`）—— 把"不许闪黑窗"变成 CI 可执行的规则。

**盲区（决定下一步该补什么）**

| 盲区 | 说明 | 证据 |
|---|---|---|
| 每个 `cargo test` 只能证明"纯函数对" | `commands.rs` 3,742 行里只有 **4 条测试**，且都是更新包校验；`open_ssh`/`fs_*`/`herdr_*` 全无单测 | `commands.rs` 测试清单位于 3617+ |
| 真 SSH / 真 TUI | 假后端不会连服务器；TMUX/herdr 的花屏、尺寸、粘贴、200ms 回车这些全是"真机才知道"的经验 | `Terminal.tsx:501-560`（200ms 是用真 codex 试出来的） |
| 并发 | 没有"两个会话同时刷屏 / 同时上传"的用例 | — |
| 长跑 / 内存 | 没有 8 小时/24 小时用例；集合只增不减 | `docs/backlog.md:231-232` |
| WebGL | 无头 Edge 里 `webgl2Available()` 为 false，整条路径进不去 | `docs/backlog.md:212-214`（自己写的） |
| 前端单测 | **0 个**（`package.json` 无 vitest/jest）；`highlight.ts` 530 行纯函数只靠端到端间接覆盖 | `package.json:6-12` |
| 测试环境不自洽 | `fe-smoke` 读**真实的** `%APPDATA%\ZeeAI-Terminal\*.json` 并强制改字段，还要求先 `npm run build`；换台机器/没有 lz 服务器就假失败 | `fe-smoke.mjs:11/40-75` |
| 升级链路 | 没有一次端到端"真装一次"的自动化 | `docs/review/tech-optimization-proposals.md:630-631`（上版也承认） |

### B.8 构建与发布 —— **影响最大的一节**

**现状**

| 环节 | 现在怎么做 | 证据 |
|---|---|---|
| 前端构建 | `npm run build` = `tsc --noEmit && vite build` | `package.json:8` |
| 应用构建 | 必须 `npx tauri build`（`cargo build --release` 出来的 exe 会连 devUrl） | `AGENTS.md:8-38` |
| 日常迭代 | `scripts/build-fast.ps1`（`[profile.fast]`，绕开 LTO） | `Cargo.toml` `[profile.fast]`、`AGENTS.md:87-119` |
| 便携包 | `scripts/build-portable.ps1`（147 行，含文件锁处理） | 已存在 |
| 发版 | `scripts/publish-release.ps1`：核 4 处版本号 + 扫文档版本 + `check-docs.mjs` + 推 tag + `gh release create` | `publish-release.ps1:33-61/67/98` |
| 版本一致性守卫 | `check-docs.mjs` **5 条断言 / 4 类漂移**：主题与配色套数、便携版升级口径、Fastboot 措辞、selftest 是否门控 | `check-docs.mjs:28-74` |
| **CI** | **没有**（仓库无 `.github/`、无任何 yml） | `Get-ChildItem -Force` 只有 9 个顶层目录/文件 |
| **代码签名** | **没有**（全仓 grep `sign/certificate/thumbprint/signtool` = 0 命中） | `tauri.conf.json` 全文 45 行无签名配置 |
| 产物 | 4 个：便携 zip **8.92MB**、裸 exe **8.64MB**（本机实测）；NSIS/MSI 为 `README.md:52-55` 的标注值（未本机复核） | `README.md:52-55` + 实测 |

**为什么"这条影响最大"（按用户可感知排序）**

1. **SmartScreen / 信任**：未签名的 NSIS/MSI 在干净机器上第一次运行会弹"Windows 已保护你的电脑"，要点"更多信息 → 仍要运行"。
   对一个"给同事/客户用的终端工具"来说，这是**转化率杀手**，也让"企业批量部署"（MSI 的唯一理由）失效 —— 组策略部署未签名 MSI 同样要额外信任配置。
2. **没有 CI = 每次重构都是裸奔**：现在唯一自动门禁是"人记得跑 `cargo test` + `fe:smoke`"。
   `AGENTS.md:127-132` 甚至专门写了"攒着改、一次交付""别两个 agent 同时改 App.tsx"——**这是在用流程纪律替代 CI**，也直接说明了为什么拆分 App.tsx 需要 CI 先行。
3. **版本一致性靠脚本 + 人**：`publish-release.ps1` 校验 4 个文件，`check-docs.mjs` 守 4 类措辞 —— 已经比多数项目好，
   但**它们是"发版那一刻才跑"**：平时 PR 里改错版本号、写漂 README，要到发版才红。而且脚本本身没有测试。
4. **发版依赖本机环境**：需要本机 `GH_TOKEN`（`publish-release.ps1:25-27`）、本机装了 `gh`、本机有全部产物。
   "谁的发版机器坏了/离职了，就发不出版"。
5. **`fe:smoke` 不是门禁**：4,232 行脚本 + 150 条断言，跑一次约 144 秒（137 次 `sleep` 合计 143,970ms）+ 40 次 reload，
   但**没有任何地方强制它跑**。

**建议的最小 CI（3 步，不改任何业务代码）**

```yaml
# .github/workflows/ci.yml（草案）
jobs:
  web:   pnpm i && npx tsc --noEmit && npm run build && node scripts/check-docs.mjs
  rust:  cargo test --lib --manifest-path src-tauri/Cargo.toml
  smoke: npm run fe:smoke          # 可选： nightly + 只跑前 N 条子集
```
- 前两步 ≈ 5 分钟，能挡住 90% 的低级回归；
- `fe:smoke` 依赖本机 APPDATA（`fe-smoke.mjs:40-75`），**上 CI 前要先把它改成自带 fixture**（这是上 CI 的真正成本，约 0.5–1 天）。

**签名的最低可行路径**（按成本排序）

1. 短期（0 成本）：发版页 + README 固定给出 `SHA256SUMS.txt` 和"为什么会被 SmartScreen 拦"的说明（现在只在发版说明里零散提）。
2. 中期（$ 但快）：**Azure Trusted Signing**（按月，个人/小团队可申请）或 OV 证书 + `signtool`；Tauri 支持 `bundle.windows.signCommand`，接进 `publish-release.ps1` 只是一段配置。
3. 长期：EV 证书（SmartScreen 立刻有信誉），但成本高、要硬件 token。

### B.9 安全

| 面 | 现状 | 评价 | 证据 |
|---|---|---|---|
| 凭据存储 | Windows 凭据管理器（keyring，`windows-native`），service = `ZeeAI-Terminal`，key = profile id | ✅ 正确做法；`profiles.json` 里**没有密码字段**（只有 `allow_password` 开关） | `core/secret.rs:12-26`、`store.rs:8-35` |
| 密码进 russh | 只有 `allow_password` 为真才从凭据管理器取 | ✅ 最小暴露 | `commands.rs:1530-1536` |
| 远端命令拼接 | `remote_fs::sq` 单引号转义（`sq`）、`tmux.rs::quote`（`'` → `'\''`）、`herdr` 的 `sanitize_pane`/`sanitize_workspace` 白名单校验 | ⚠️ **三套转义、口径不一**：HEAD 里 `ssh::tmux_command`/`tmux::kill_remote_command` 是"**删掉**单引号"而不是转义（`ssh.rs:210-215`、`tmux.rs:46-51`）→ 名字带 `'` 时会**静默改名、杀错会话**；🟡 工作区已改 `kill_remote_command` 走 `quote()` 并补了测试 | 见左 |
| **主机密钥校验（russh 路径）** | **HEAD 里完全不校验**：`Sftp::check_server_key` 无条件 `Ok(true)`（`git show HEAD:src-tauri/src/core/sftp.rs`）；而终端路径用 `StrictHostKeyChecking=accept-new`（`ssh.rs:120`，首次接受、**之后密钥变更会拒绝**） | 🔴 **两条路径安全姿态不一致**：SFTP/一次性命令/密码登录这条路可被 MITM。🟡 工作区已新增 `core/known_hosts.rs`（TOFU：首次记指纹、之后不一致直接拒） | 见左 |
| 参数注入（ssh argv） | `ssh_target()` 返回 `user@host`，**host/user 未做字符校验**；若 host 以 `-` 开头（如 `-oProxyCommand=…`）会被 ssh 当成选项 | ⚠️ 需要用户自己填才触发，但 `profiles.json` 可被手工编辑；修法：校验 host/user 字符集或 argv 里加 `--` | `ssh.rs:83-91`、`commands.rs:168-172` |
| 本地命令注入 | `open_external_url` 用 `cmd /C start "" <url>`，只校验 `http(s)://` 前缀 | ⚠️ URL 里含 `&` 时 `cmd` 会当命令分隔符 → 可执行任意本地命令（用户点一次链接触发） | `commands.rs:2038-2054` |
| 更新包校验 | 仓库前缀锁死 + 必须给 size + 文件头 + 可选 sha256 | ⚠️ sha256 走 **PATH 上的 `certutil`**（PATH 劫持可让校验恒真）；且 sha 由渲染层传，可省 | `commands.rs:2448-2462`、`2470-2500` |
| 更新源 | 渲染层 `fetch(settings.updateUrl)`，可填任意 URL；后端只允许本项目 Release 前缀才执行 | ✅ 双闸；但**版本号比较用的是不可信 JSON**，可被诱导显示"有新版本"（点了也装不上） | `App.tsx:5851-5889`、`commands.rs:2616-2620` |
| WebView 侧 | `csp: null`；预览 HTML/MD 用 DOMPurify；全局拦截 `<a>` 点击与 drop | ⚠️ 无 CSP；但 sanitize 做了（`FORBID_TAGS: script`、`FORBID_ATTR: srcdoc`） | `tauri.conf.json:27-29`、`App.tsx:11634/11639`、`main.tsx:11-18` |
| 日志泄密 | 会话日志是**PTY 输出**（不含键盘输入）；`log::info!` 会打 profile_id/路径/URL | ⚠️ 用户 `cat` 出来的密钥、`echo $TOKEN` 会被落盘（这是终端的固有属性，建议 README 写一句）；应用日志可能含服务器名/路径 | `session_log.rs:1-9`、`commands.rs:1255`（打 path） |
| selftest 后门 | 已用 `--features selftest` 门控，默认不进发布二进制，且有测试守 | ✅ 很少见的自觉 | `Cargo.toml` `[features]`、`check-docs.mjs:63-74` |
| 提权 | `ShellExecuteExW runas`，重启整个应用或单开窗口 | ✅ 明确、无静默提权 | `core/elevate.rs` |
| 单实例 | 命名互斥体 `Local\…` | ✅（`Local\` 是会话级，多用户互不影响，符合预期） | `instance.rs:17-33` |

---

## C. 问题清单与优先级（按 影响 × 修复成本 排序）

排序原则：**先高影响低成本**；"影响"看用户能不能感知/会不会丢数据，"成本"见 S/M/L。
**P1 = 现在就该做；P2 = 三个月内；P3 = 排进 backlog 就行。**

### C.1 App.tsx 拆分方案（可执行；先看这节，再看待办表）

**目标形状**（目标：`App.tsx` ≤ 1,200 行，只留布局骨架 + 模块切换 + Provider）

| 新文件 | 职责 | 从 App.tsx 迁出 | 状态归谁 |
|---|---|---|---|
| `src/app/AppShell.tsx` | 保留在 `App.tsx`：`activitybar` + `sidebar` 插槽 + `main` 插槽 + 全局对话框挂载点 | —（新增） | 无状态（纯组合） |
| `src/features/tabs/TabBar.tsx` | 标签栏 + 拖动排序（`App.tsx:8376-8480`） | ~105 行 | props 传入 `sessions/activeId`，拖动临时态留在组件内 |
| `src/features/sidebar/Sidebar.tsx` | 活动栏 + 侧栏外壳 + 折叠（`6996-7060`） | ~65 行 | 全局 `uiStore`（module/sideTab/collapsedServers/sidebarWidth） |
| `src/features/sidebar/ServerTree.tsx` | 服务器树 + 右键菜单（`7060-7400`） | ~340 行 | 全局 `profilesStore` |
| `src/features/sidebar/SessionList.tsx` | 历史会话行 + H/T 标记（`7200-7400`） | ~200 行 | 全局 `sessionsStore`（只读） |
| `src/features/sidebar/FilePanel.tsx` | 远端文件面板（`7400-7800`） | ~400 行 | 全局 `fsStore`（`fsPath/fsEntries/fsBusy`） |
| `src/features/sessions/NewSessionDialog.tsx` | 新建会话 / tmux / herdr 选择（`~7800-8300`） | ~500 行 | 局部 `useState`（草稿）+ 打开时读 `herdrAvail` |
| `src/features/settings/SettingsDialog.tsx` | 设置全部二级页（`~10300-11200`，含更新页、主题页、高亮页） | ~900 行 | 全局 `settingsStore`（`updateSettings` 是唯一写入口） |
| `src/features/ai/AiPanel.tsx` | 右栏 AI 面板（`8681-9100`） | ~420 行 | 全局 `aiBoardStore` |
| `src/features/ai/AiCard.tsx` | 把 `boardCard()`（`3705-3935`，231 行）改成组件 | ~230 行 | props（`instance` + `task` + `nowMs`） |
| `src/features/ai/AiComposer.tsx` | 输入窗 / 贴图 / 附件（`8681-8850`、`10931+`） | ~250 行 | 局部 `useState` |
| `src/features/git/GitPanel.tsx` / `adb/AdbPanel.tsx` / `serial/SerialPanel.tsx` | 三块设备面板 | 各 ~200–400 行 | 各自局部 state（不用全局） |
| `src/features/files/FileView.tsx` | 文件末尾那个 `FileView`（`11596-11721`） | 已存在，只需移文件 | 局部 |
| `src/store/{sessions,profiles,settings,aiBoard,ui}.ts` | 5 个 store | —（新增） | 见下 |

> 行数按各段的实际跨度估算，合计能把 App.tsx 从 11,735 行压到 1,000–1,500 行。

**状态归属（4 条规则，拆的时候照着判断）**

| 类别 | 放哪 | 例子 | 判断标准 |
|---|---|---|---|
| 服务端数据 + 跨模块共享 | **全局 store** | `profiles`、`sessions`、`settings`、`history`、`boardInstances` | 两个以上模块要读，或要落盘 |
| 会话运行态（高频变化） | **全局 store，但用选择器订阅** | `activeId`、`paneLayout`、`panes` | 变化频率 ≥ 每秒一次 → 必须能切片订阅 |
| 对话框草稿 / 临时输入 | **组件局部 `useState`** | `form`、`editDialog.draft`、`newDialog`、`composerText` | 关闭就丢，别人不需要 |
| 纯 UI 坐标 / 一次性态 | **组件局部** | `ctxMenu`、`tabMenu`、`dragPos`、`statusMsg` | 不需要跨组件、不需要持久化 |

**推荐的 store 选型**：`zustand`（~1KB gzip，`useStore(state => slice)` 天然支持"只在切片变化时重渲"）。
不引 Redux（样板太多）、不引 react-query（这里的"服务器"不是 HTTP 语义）。若不想加依赖，`useReducer + Context + useSyncExternalStore` 也能做到，代码量约多 100 行。

**迁移顺序（6 步，每步都能独立发版、都能回滚）**

| 步 | 动什么 | 产出 / 验收 | 风险与回滚 | 量 |
|---|---|---|---|---|
| **1** | 抽 3 个"零依赖"面板：`SettingsDialog`、`AboutDialog`、`GitPanel` | App.tsx −1,500 行；`fe-smoke` 150 条全绿 | 纯搬 JSX + props；出问题 `git revert` 单 commit 即可 | S |
| **2** | 抽 `TabBar`（含拖动排序这条最容易碰坏的逻辑） | −105 行；专门补 3 条断言（拖动、右键、录日志小点） | 拖动靠 window 上的 mousemove/mouseup（`App.tsx:4750-4755`），搬的时候把 effect 一起搬，别只搬 JSX | S |
| **3** | 抽 `AiPanel` + 把 `boardCard` 变成 `<AiCard instance task nowMs>`，`nowMs` 由 AiPanel 内部 tick 提供 | −650 行；**C-01 的"每秒整树重渲"在这一步就消失了** | 卡片里用了 `herdrOrphans()`/`taskOfInstance` 等派生值（`3695-3696`），要改成 props 或在 AiPanel 内算 | M |
| **4** | 抽 `Sidebar`（含 ServerTree/SessionList/FilePanel/三块设备面板） | −1,300 行 | 侧栏 JSX 里有大量 `ctxMenu` 分支，先原样搬、再收口菜单 | M |
| **5** | 引入 store，先把 `settings` + `profiles` 迁进去（这两个读多写少、最容易验证） | `App.tsx` 去掉 ~20 个 `useState`；`updateSettings` 成为唯一写入口（顺带修上版 T-20 的"闭包合并覆盖"） | 逐步替换，允许新旧并存一个版本：store 是唯一真值，组件内 setState 先改成读 store | M–L |
| **6** | 迁 `sessions` + `activeId` + `panes` 到 `sessionsStore`，事件回调（`handleEvent`/`handleTerminalCwd`）改成 store action | `App.tsx` ≤ 1,500 行；61 个 `useState` 降到 ≤ 10 | 最危险的一步：所有 `sessionsRef.current` 之类的镜像（`App.tsx:2197` 等）要一起清；**必须先把 D-8 的集成测试做好** | L |

**拆分时的三条硬约束**

1. **终端字节流不进 store、不进 React**：`SessionBus`（`sessionBus.ts`）+ `term.write` 这条路一行都不许改（它是唯一经过实战验证的热路径）。
2. **命令名与事件名不动**：拆分只搬 UI，不改 `ipc.ts` / Rust 侧 → `fe-smoke` 的假后端（按命令名返回桩数据，`AGENTS.md:56-60`）不需要改。
3. **每步结束必须跑满 `fe:smoke` 150 条**（`AGENTS.md:127-129`）；跑不动就先做 D-1 的 CI + fixture 化，别硬拆。

### C.2 · P1（高影响 / 低成本，多数 ≤ 半天）

| # | 现象 / 风险 | 证据 | 建议做法 | 量 |
|---|---|---|---|---|
| **C-00** | 🔴 **russh 路径完全不校验服务器主机密钥**（HEAD）：`check_server_key` 无条件 `Ok(true)`。公共 Wi-Fi/局域网里可被中间人冒充目标服务器，影响 SFTP / 一次性命令 / 密码登录；而终端那条路（`accept-new`）是**会拒绝变更密钥**的 —— 同一个产品两条安全姿态 | `git show HEAD:src-tauri/src/core/sftp.rs`（`Ok(true)`）；`ssh.rs:120` | TOFU：首次记 `SHA256:` 指纹，之后不一致**拒绝连接**并把原因带回 UI；🟡 工作区已有 `core/known_hosts.rs`（未提交），补一条单测 + 一条"换密钥必须拒绝"的用例即可收口 | S |
| C-01 | **AI 面板一打开，整棵树每秒重渲**（61 个 state 的闭包 + 4,557 行 JSX 的 diff）。长时间开着会持续吃主线程，和终端输出叠加时抖动可感知 | `App.tsx:1088-1097`（1s tick）、`1252`、`3677-3686`（每秒重算 4 个 filter）、全仓 0 个 `memo`/`useCallback` | 把"每秒时钟"下推到 `AiPanel` 内部（或 `boardShown` 用 `useMemo` + `aiUiNow` 只传给卡片）；先给 `TerminalView`/`AiCard` 加 `React.memo` | S–M |
| C-02 | **没有 ErrorBoundary**：11.7k 行组件里任何一次渲染异常 = 白屏，用户只能杀进程 | `main.tsx:20-24`（直接 render `<App/>`），全仓 0 处 `ErrorBoundary` | `<ErrorBoundary fallback={…"界面崩了，点这里重载"}>`，并 `log::error` 上报 | S |
| C-03 | **`fs_list` 丢掉 `user_override`**：用"临时换用户"登录后，文件面板列的是配置里默认用户的家目录/权限（与上传/下载/读取不一致） | `commands.rs:1226` 传 `None`，而 `1256/1280/1382/1914` 都传了 `user_override`（工作区这行仍在，未修） | 改成传 `user_override`，并给 selftest 里 altuser 分支（`lib.rs:251`）加上"列出的路径必须在该用户家目录"的断言 | S |
| C-04 | **`save_history` 非原子**：升级/断电撞上写盘 → `history.json` 半截 → 下次启动**静默**变空（`load_history` 用 `unwrap_or_default`） | `store.rs:488-493`、`483`（工作区仍用裸 `fs::write`，未修） | 改用 `write_atomic`；`load_history` 解析失败时备份 `.bad-<ts>` | S |
| C-05 | **更新包 sha256 可被 PATH 劫持绕过**：`certutil` 从 PATH 找，攻击者放一个同名 exe 就能让校验恒真；且 sha 由渲染层传入，可省 | `commands.rs:2449-2452`、`2474`（`Option`）、`2485`（空则跳过）（工作区仍是 `certutil`） | 引 `sha2` crate 本地算；把 `expected_sha` 设为**后端必填**（从 GitHub API 自己取） | S |
| C-06 | 🟡 **`open_external_url` 命令注入**（HEAD）：`cmd /C start "" <url>`，URL 含 `&` 可执行本地命令 | HEAD `commands.rs:2038-2054`；工作区已改成 `ShellExecuteW("open")` + `validate_external_url`，并补了 `external_url_rejects_injection_and_non_http` 测试 | 保持工作区这个改法；同类"经 cmd 转发参数"的地方再扫一遍 | S |
| C-07 | **契约漂移**：TS 有 `cwd` 事件分支，Rust 根本不发 → 死代码误导后来人 | `types.ts:69-74`、`App.tsx:3969-3973` vs `core/session.rs:13-18` | 删分支，或让后端真的发（OSC 7 已在后端可解析）；并在 CI 里加"TS 与 Rust 事件名对账" | S |
| C-08 | **ssh argv 注入面**：host/user 未校验，`-o…` 开头的值会被 ssh 当选项 | `ssh.rs:83-91`、`commands.rs:168-172` | 校验 `^[A-Za-z0-9._@:-]+$`（host）与用户名白名单；或 argv 里 `--` 兜底 | S |
| C-09 | **没有 CI**：唯一门禁靠人记 | 仓库无 `.github/`；`AGENTS.md:127-132` 用纪律替代 | 先落 `tsc --noEmit` + `cargo test --lib` 两条（5 分钟），`fe:smoke` 改成自带 fixture 后再上 | M |
| C-10 | **零代码签名**：SmartScreen 拦截 + 企业部署受阻 | 全仓 0 命中签名配置；`tauri.conf.json:31-44` | 发 `SHA256SUMS.txt` + 说明（0 成本）；接 Azure Trusted Signing / OV 证书到 `publish-release.ps1` | S（说明）/ M（签名） |

### C.3 · P2（中影响 / 中成本，三个月内）

| # | 现象 / 风险 | 证据 | 建议做法 | 量 |
|---|---|---|---|---|
| C-11 | **双 SSH 栈**：终端走 `ssh.exe`（有 agent/config），SFTP/AI 走 `russh`（只认 3 个密钥文件、无 agent）→ "终端能进、文件面板报认证失败" | `ssh.rs:104-147` vs `sftp.rs:54-65/161-205` | 二选一：给 russh 补 agent + `~/.ssh/config` 解析（`russh` 生态有 `ssh-agent` crate）；或让 SFTP 走 `ssh.exe -s sftp` 并复用系统配置 | M |
| C-12 | **无合并、无背压的输出链路**：每片 base64 + 一次 IPC；刷屏时内存涨（待验证）+ 前端解码成本 | `pty.rs:136-158`、`util.ts:10-15` | Rust 侧 8–16ms 合并 + 有界队列；改用 Tauri 2 二进制通道（`ipc::Response`/`Channel<Vec<u8>>`）省掉 base64 | M |
| C-13 | **App.tsx 10,374 行单组件**：认知成本、合并冲突、无法局部优化（详见 C.1 拆分方案） | `App.tsx:1128-11501` | 按 C.1 的 6 步拆分（每步可独立发版） | L |
| C-14 | **`commands.rs` 3,742 行 / 97 命令**：一个文件承载 12 个域 | 20 处分节注释就是"该拆成文件的边界" | 拆成 `commands/{session,ssh,fs,git,adb,serial,ai,herdr,update,settings}.rs`，`pub use` 保命令名不变 → 前端零改动 | M–L |
| C-15 | **测试盲区**：真 SSH/TUI、并发、长跑、WebGL、升级端到端全无覆盖；`fe-smoke` 依赖本机 APPDATA | B.7 全表 | ① fe-smoke 改自带 fixture；② 加一个 `scripts/integration.ps1`（本机 sshd 或 docker）跑 6 条真链路；③ 加 8 小时 soak | M |
| C-16 | **无可观测性**：只有启动打点，没有 IPC/输出链路指标 | `lib.rs:26-47`、`startup.ts` | 加分层计时（PTY 读→IPC→write 三段 p50/p99、每秒消息数/字节数）+ "导出诊断包"按钮 | M |
| C-17 | **持久化无版本号、日志无轮转** | `store.rs:238-334`（无 version 字段）、`session_log.rs:131-136` | settings 加 `schemaVersion`；日志按大小/天轮转 + 保留 N 份 | S–M |
| C-18 | **CSP 为 null** | `tauri.conf.json:27-29` | 设最小 CSP（`default-src 'self'`，`connect-src` 只放更新域名） | S |
| C-19 | 🟡 **`write_atomic` 先删后改名**（注释说"NTFS rename 原子"，实现却有删除窗口） | HEAD `store.rs:164-167`；工作区已加 `replace_file()`（`ReplaceFileW`）+ 并发写测试 `concurrent_writes_never_leave_half_written_json` | 保持工作区改法；把 `save_history` 也接到 `write_atomic`（见 C-04） | S |
| C-20 | **WebView2 离线安装未配置** | `tauri.conf.json:31-44` 无 `webview2.installMode` | 设 `embedBootstrapper`（+1.5MB）；**先在一台无 Runtime 的机器上验证** | S |

### C.4 · P3（低影响 / 值得排队）

- **C-21 后端 `core → commands` 反向依赖**（`ai_herdr_dots.rs:527`）+ 源码 grep 测试把它钉死（`:903-915`）：短期忍，拆 `commands.rs` 时顺手把 `herdr_agents` 抽到 `core/herdr_probe.rs`，测试改成"不得引用 commands"。
- **C-22 前端零单测**：`highlight.ts`(530)、`boardActivity.ts`(198)、`compareVersion`、`splitErrText` 都是纯函数，上 vitest 约半天。
- **C-23 前端单包 897KB**：`markdown-it`/`dompurify` 改 `await import()`（`App.tsx:7-8`），预览首次点击才加载。
- **C-24 每会话都常驻 xterm**（`App.tsx:8589-8600`）：改成懒挂载 + scrollback 导出，工程量 M，收益在"开 10+ 会话"的人群。
- **C-25 魔数两处**：前端 40×12（`Terminal.tsx:149-150`）vs 后端 20×5（`commands.rs:2949`）。
- **C-26 日志/`log::info!` 里的路径与 URL**：`commands.rs:1255` 等。可在设置里给"详细日志"开关。
- **C-27 两套配置目录**：`%APPDATA%\ZeeAI-Terminal` vs `%LOCALAPPDATA%\com.zeeai.terminal`（`store.rs:123-126` vs `lib.rs:29-34`）。
- **C-28 `herdr_pane_resize` 重建流**（`commands.rs:3014+`）：拖动窗口会触发 SSH 重连；可改成"发一条 resize 指令"（control 流已经是这么做的）。

### C.5 · 这次明确不做（写清楚，免得反复讨论）

| 不做 | 为什么不做 |
|---|---|
| 换 Electron / 换原生 / 上 egui·Slint | 选型没错；瓶颈在应用层（A.4）；换栈=重写 20k 行前端 + 15k 行 Rust |
| 做二进制差分包更新 | 上版已论证（`docs/review/tech-optimization-proposals.md:180-195`），收益小、风险大，和"不要下错"冲突 |
| macOS / Linux 移植 | 核心价值（herdr/tmux + Windows 串口/ADB/提权）与 Windows 强绑定；现在做等于双倍维护 |
| i18n 全量 | 用户群是中文；英文只在远端提示里出现（`ssh.rs:218-226` 已有 ASCII 约定） |
| 把 tmux/herdr 换成自研多路复用 | 用户明确要"会话留在服务器上"；自研协议要装 agent，等于放弃"免装" |
| 引入 Redux/MobX 全家桶 | 状态复杂度是"多而浅"，Zustand/`useReducer`+Context 足够；引重的只会增加样板 |

---

## D. 路线建议

### D.1 现在（1–2 周，最多 5 件）

| # | 做什么 | 为什么是现在 |
|---|---|---|
| D-1 | **CI 红绿灯**：`.github/workflows/ci.yml` = `tsc --noEmit` + `npm run build` + `cargo test --lib` + `check-docs.mjs` | 后面所有重构都要靠它兜底；现在连"PR 能不能编过"都没人自动回答。5 分钟的门禁，收益最大 |
| D-2 | **前端三处止血**：ErrorBoundary、AI 面板每秒 tick 下推、`TerminalView`/卡片加 `memo` | 三天内能让"白屏"和"卡一下"两个最常被报的现象消失或减轻；且不依赖拆分 |
| D-3 | **修 5 个数据/安全小坑**：C-03（fs_list user）、C-04（history 原子写）、C-05（本地 sha256）、C-07（cwd 契约）、C-08（ssh argv 校验）。注：C-00（主机密钥）/C-06（ShellExecute）/C-19（ReplaceFileW）**并行工作区已在做**，本节不重复排期，只需复核 + 补测试 | 每条都是单点改动、风险低、能被用户感知（尤其 C-03/C-04 是"数据不对/丢了"级别） |
| D-4 | **可验证的发布信任**：发 `SHA256SUMS.txt` + README 写清 SmartScreen 说明；同时把签名方案（Azure Trusted Signing / OV）调研 + 报价定下来 | 每多发一个版本，就多一批被 SmartScreen 拦掉的用户；签名有 1–2 周采购/申请周期，**现在启动才来得及** |
| D-5 | **输出链路插桩**：PTY 读→IPC→xterm 三段计时 + 每秒消息数/字节数，写进应用日志；跑一次 `yes` 30 秒压力测试记录 RSS | 没有数据就无法判断 C-12/C-24 值不值得做；这也是 C-16 的第一步 |

> 这 5 件都不碰 App.tsx 的结构，可并行、可单独发版。

### D.2 三个月（3–5 件）

| # | 做什么 | 为什么是三个月内 |
|---|---|---|
| D-6 | **App.tsx 分阶段拆分**（见 C.1 的具体方案）+ 引入 **Zustand** 承接 sessions/profiles/settings，选择器订阅 | 拆分是 C-01 的根治手段；但**必须先有 CI**（D-1）和 `fe-smoke` 的 fixture 化，否则一次拆分就会毁掉 150 条断言的可信度 |
| D-7 | **IPC 类型生成**：`ts-rs`（或 `specta`）从 Rust 生成 `types.ts`，97 个命令 + 54 个接口不再手抄 | C-07 这类漂移会自然消失；越晚做，手写类型越多、迁移越贵 |
| D-8 | **真链路集成测试**：本机 sshd 或 docker，6 条场景（连接/tmux attach/断线重连/SFTP 100MB 断点/大输出 10MB/取消） | 这是唯一能覆盖"花屏、尺寸、粘贴、退出码"这类只有真机才暴露的问题的手段；也正好给 C-11/C-12 的改动上保险 |
| D-9 | **统一 SSH 认证**：给 russh 补 ssh-agent + `~/.ssh/config`（Host/User/Port/IdentityFile/ProxyJump），或让 SFTP 复用 `ssh.exe` | 用户可感知（"文件面板连不上"），且和 D-8 的测试用例同源 |
| D-10 | **发布自动化再进一步**：`publish-release.ps1` 拆成"产物构建 / 签名 / 上传"三段，产物在 CI 里构建，人只点"发布" | 把"发版依赖某台机器"变成"发版依赖一次点击"；签名上线后这一段必然要重写 |

### D.3 十二个月（2–3 件）

| # | 做什么 | 为什么放到以后 |
|---|---|---|
| D-11 | **后端分层 + 插件化承载**：定义 `SessionBackend` trait（pty / ssh-tmux / herdr-observe / herdr-control / serial / adb），`commands` 只做 DTO 转换；新协议（mosh、web 终端、远程桌面网关）按 adapter 接入 | 现在有 5 种后端硬编码在 `open_ssh` 的 206 行 if/else 里（`commands.rs:184-290`）。等第三种多路复用器或第二个产品形态出现时再做，收益才大于成本 |
| D-12 | **可观测性体系**：本地 ring buffer 指标 + "一键导出诊断包"（版本/最近日志/指标/最近 20 条命令耗时/环境信息），可选匿名上报 | 依赖 D-5 的插桩先积累出"哪些指标真的有用"；没有数据支撑的指标体系会做成一堆没人看的数字 |
| D-13 | **跨平台可行性评估（只评估，不实施）**：macOS 先行（PTY 用 portable-pty、SSH 用系统 ssh、UI 全复用），评估 WebView(WKWebView) 差异与 herdr/tmux 的可用性 | 只有当 Windows 增长见顶、且用户明确要求时才值得做；现在做等于把"串口/ADB/提权/Job Object"这些 Windows 护城河全部重写一遍 |

---

## 附录 A：统计口径与复现命令

```powershell
# 体量（以 HEAD 42597e8 为准；工作区 commands.rs 已 +195 行变 3897，store.rs 也变长了）
(Get-Content src\App.tsx).Count                       # 11735
(Get-Content src-tauri\src\commands.rs).Count          # 3742 (HEAD) / 3897 (工作区)
# 组件边界
Select-String src\App.tsx -Pattern '^  (async )?function '   # 159 个内嵌函数
Select-String src\App.tsx -Pattern 'useState\('              # 61
Select-String src\App.tsx -Pattern 'useCallback\(|React\.memo'  # 0
# IPC 一致性：注册数 vs 前端调用数
#   注册 99（lib.rs:629-731）= commands.rs 97 + lib.rs 2
#   前端 ipc.ts 97 个导出，全部命中；未注册的调用 0 个
# 测试
(Get-ChildItem src-tauri -Recurse -Filter *.rs | Select-String '#\[test\]').Count   # 138
(Get-ChildItem src-tauri -Recurse -Filter *.rs | Select-String '#\[tokio::test\]').Count # 1
# 前端断言
(Select-String scripts\fe-smoke.mjs -Pattern 'check\(').Count      # 150
```

## 附录 B：本文**没有**验证的事（别当成结论）

1. **WebView2 离线安装行为**（C-20）：需要一台没有 WebView2 Runtime 且断网的 Win10。
2. **刷屏时内存是否真的涨**（C-12 背压）：需要跑 `yes` / `cat 大文件` 30 秒并采样 RSS。
3. **agent-only 服务器上文件面板是否真的失败**（C-11）：需要一台只配了 agent、没有私钥文件的服务器。
4. **每秒重渲染的实际帧率影响**（C-01）：需要 Performance 面板录 60 秒 + AI 面板打开态。
5. **签名方案的价格与周期**（D-4）：属于采购信息，本次未询价。
6. **`fe:smoke` 在干净机器上能跑多少条**（B.7）：它读真实 `%APPDATA%`，本次没有在别的机器上验证。
7. **`tauri.conf.json` 少 `webview2.installMode` 时 NSIS 的实际行为**：需要真机装一次看是否提示下载运行时。
8. **并行工作区的改动最终形态**（`known_hosts.rs` / `replace_file` / `ShellExecuteW` / tmux `quote`）：审查时它们**还没提交**、可能仍在改；复核时以工作区为准，行号以 HEAD 为准。
