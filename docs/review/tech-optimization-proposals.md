# ZeeAI Terminal v0.1.7 —— 技术优化建议（供你勾选）

> 本轮只做**审查**：没有改任何代码、没有动版本号、没有发版。
> 基线：`main` @ `1e86921`（v0.1.7），工作区干净。
> 原始素材：`docs/review/raw/perf-packaging.md`（性能/体积/打包专项，带实测数据）；
> tmux 花屏那条另有专篇：`docs/review/bug-tmux-scrollback-narrow.md`。

---

## 怎么用这份文档

每条都是「可以直接开工」的粒度，带编号、位置、证据、影响、建议和代价。你可以直接告诉我编号
（例如 `T-01 T-02 T-18`），或者从最后的**三个套餐**里挑一个。

严重度定义：

| 级别 | 含义 |
|---|---|
| **P0** | 功能必然失效 / 丢数据，用户点一下就能踩到 |
| **P1** | 明显 bug，会在真实使用中造成困扰或数据损坏 |
| **P2** | 隐患、性能、体积问题，平时不炸但会持续消耗体验 |
| **P3** | 打磨项 / 工程化，性价比高但不紧急 |

代价：**S** = 一小时内、改一处；**M** = 半天、涉及几个文件；**L** = 需要单独排一次。
置信度标了「读代码确认」还是「推测」；凡标「待确认」的，我都写清了怎么验证。

---

## 0. 先把结论说清楚（Top 6）

1. **【P0】一键升级现在是坏的**：升级辅助脚本被挂进了「App 一退就杀掉所有进程」的 Job Object，
   而它第一件事就是「等 App 退出」——App 一退，它也一起被杀，安装器**永远不会运行**。
   这与你之前反馈的「点了升级、重启之后版本没变 / 没有再重启」完全对得上。（T-01）
2. **【P1】有一把锁能让整个应用"会话全卡死"**：`session_write` / `session_resize` / `session_close`
   都在**持有全局会话表锁**的情况下做阻塞 IO。一个卡住的会话（远端不回显、管道写满）会让
   *所有* 会话操作一起排队——包括你想「关掉那个卡住的会话」的那次点击。（T-07）
3. **【P1】你截图里那个 tmux「上面变窄 / 被覆盖」**：这是一次**窗口尺寸被压小**留下的永久伤疤。
   你这台服务器是 **tmux 2.7**，它没有 `window-size` 选项 —— 多客户端时**按最小的客户端算尺寸**；
   而本应用用的 `tmux new-session -A`（不带 `-d`）允许多个客户端同时挂在同一个会话上。
   详见专篇。（T-33 / `bug-tmux-scrollback-narrow.md`）
4. **【P2】体积能砍一半以上**：`platform-tools` 占 17.63MB，其中至少 5.2MB 是代码里**从未引用**的
   二进制（`sqlite3.exe` 3.03MB 等）；实测砍掉后便携版 zip 从 13.48MB → 5.43MB，
   按 LZMA 比例估算 NSIS 从 9.15MB → 约 3.5–4MB。（T-23）
5. **【P2】轮询偏贵**：本机看板每 20 秒起一个 PowerShell 做全表 WMI 扫描（实测 **0.79–1.06 秒/次**）；
   每个远端会话每次探测都**新起一条 ssh**（无连接复用），8 会话约 22 次/分钟。（T-13 / T-14）
6. **【P2】AI 探针的 400KB 固定窗口会漏报**：实测你本机当前会话最后一次 `task_complete` 距文件尾
   已有 **293KB**，余量只剩 27% —— 某一轮输出超过 400KB，「AI 跑完了」就不会提示。（T-12）

---

## 1. 升级 / 更新链路

### T-01 【P0】一键升级必然失败：升级脚本被挂进了 Job Object

**位置**

- `src-tauri/src/commands.rs:2299-2310`（启动脚本 → 挂 Job → 1 秒后退出）
- `src-tauri/src/core/job.rs:29`（`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`）、`job.rs:49-58`（`assign`）
- 生成的脚本 `src-tauri/src/commands.rs:2149-2157`（第一步就是等 App 退出）

**证据**

```rust
// commands.rs:2299-2310
let child = cmd.spawn().map_err(|e| format!("启动升级脚本失败: {e}"))?;
log::info!("update: 升级脚本已启动 pid={}", child.id());
// 顺手把升级脚本也挂进 Job Object：万一它自己卡住，App 退出时会一起被收掉
crate::core::job::assign(child.id());

let app_for_exit = app.clone();
tokio::spawn(async move {
    tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
    app_for_exit.exit(0);            // ← App 一退，job 句柄关闭，脚本同时被杀
});
```

```bat
rem commands.rs:2149-2157 —— 脚本唯一要等的那一刻，正是它自己被杀的同一刻
:wait
tasklist /FI "PID eq {pid}" /NH | find "{pid}" >nul
if errorlevel 1 goto install
...
ping -n 2 127.0.0.1 >nul
goto wait
```

**影响**：点「一键升级」→ 下载完成、`apply_update.cmd` 写出 → App 退出 → 脚本被系统连带杀死 →
安装器根本没运行、`apply_update.log` 不会写 → 你回到桌面发现版本号没变，而且**没有任何失败提示**。
这也解释了 0.1.5 那次"点了升级什么都没发生"的现场（`docs/decisions.md:874`）。

**建议修法**（择一，都是 S）

1. 最小改动：**删掉 `crate::core::job::assign(child.id())` 这一行**。脚本自带 2 分钟超时 + 退出码检查，
   本来就不需要跟 App 同生共死。curl 和终端子进程继续留在 Job 里（那是对的）。
2. 更稳：用 `CREATE_BREAKAWAY_FROM_JOB` 启动脚本，并在 Job 上加 `JOB_OBJECT_LIMIT_BREAKAWAY_OK`。

**置信度**：高（Windows 语义 + 代码路径都已确认；缺「真机点一次升级」的端到端复核 —— 见文末第 8 节）。

---

### T-02 【P1】MSI 版升级成功后不会自动重启应用

**位置**：`src-tauri/src/commands.rs:2139-2145`；模板证据 `src-tauri/target/release/wix/x64/main.wxs:36-38, 226`

```rust
// commands.rs:2139-2145
let install = if kind == "msi" {
    format!("msiexec /i \"{}\" /qb /norestart", dest.display())   // ← 没有等价于 /R 的东西
} else {
    format!("\"{}\" /S /R", dest.display())                       // NSIS 才会 /R 重启
};
```

WiX 模板里自动拉起应用的条件是 `AUTOLAUNCHAPP AND NOT Installed`，而 `AUTOLAUNCHAPP` 默认**没有赋值**，
我们的 `msiexec` 命令行也没传 → MSI 用户看到「应用自己关了、再也没回来」。

**建议**：`msiexec` 命令行加 `AUTOLAUNCHAPP=1`（一行）；发版说明里注明「MSI 升级会弹一次 UAC」。代价 S。

---

### T-03 【P1】每次成功升级都在 `%TEMP%` 留一份 9–14MB 安装包

**位置**：`src-tauri/src/commands.rs:2163-2170`

```bat
if "%RC%"=="0" goto done          rem ← 成功：不删包，直接结束
del /f /q "{dest}" >nul 2>&1      rem ← 只有失败才删
```

文件名带版本号（`ZeeAI_Term_{ver}_setup.exe`），所以**每个版本各留一份**；升 10 版 ≈ 90–140MB 常驻，
而且不会进 Windows「磁盘清理」的常规视野。

**建议**：成功路径也删包；`.cmd` 结尾加 `del "%~f0"`；或下次升级开头清掉该目录里所有非当前版本的文件。代价 S。

---

### T-04 【P2】下载失败重试必然从 0 重来

**位置**：`src-tauri/src/commands.rs:1858-1864`（外层每次 attempt 先 `remove_file(&part)`）、
`commands.rs:2006`（内层又删一次）、`commands.rs:2022-2026`（`--retry 5` 但**没有 `-C -`**）

**影响**：9.15MB 的包在弱网下最坏 = 内层 6 次 × 外层 2 次 ≈ **110MB 整体重传**。

**建议**：不删 `.part`（只在校验失败时删）+ curl 加 `-C -` 做真续传。注意这与你的「不要分片」不冲突：
`-C -` 是**单请求断点续传**，不是 1MB Range 分片（0.1.5 事故的成因是两个下载交叠写同一个文件）。代价 S。

---

### T-05 【P2】"不要下错"的最后一道防线现在是空的

**位置**：`src-tauri/src/commands.rs:2097-2120`（`package_problem`）、`commands.rs:2190-2199`（只校验 URL 是不是 GitHub Release）；
前端来源 `src/App.tsx:3051-3069`；配合 `src-tauri/tauri.conf.json:26` 的 `"csp": null`

```rust
if expected_size > 0 && actual != expected_size { return Some(...); }   // 传 0 → 跳过
if !header_ok(path, ext) { return Some(...); }                          // 只剩「前两字节是 MZ」
if let Some(want) = expected_sha.map(str::trim).filter(|s| !s.is_empty()) { ... }  // 传 null → 跳过
```

**影响**：`expected_size` / `expected_sha` **完全由渲染层传入**，传 `0` + `null` 时唯一剩下的校验是
「文件头是 `MZ`」。任何能触发 IPC 的东西都可以让应用**下载并静默执行**任意 GitHub Release 里的 exe。
单机场景不算致命，但你反复强调过「**不要下错**」，这是这条链路里最不该省的一道。

**建议**：后端自己取 release 信息（把 `expected_sha` 变成**后端必填**）+ 白名单锁死 `owner/repo`；
可选再加 CSP。代价 M。

---

### T-06 【P3】注释/文档与实现互相打架

- `commands.rs:1826-1829` 注释还写着「按 1MB 一段发 Range 请求…从已有文件大小接着下」，
  而 `commands.rs:1986` 的注释明确写「整包一次下完（不分片、不续传）」——同一个函数里两种说法。
- `README.md:127` 还写着「未实现：传输进度条 / 断点续传（现在是 scp，无进度）」，
  但这三样其实早就做了（现在是真 SFTP）。

**建议**：以代码为准统一措辞，把 README 那段「未实现」整段重写。代价 S。

---

### 顺带回答你问过的：「为什么下载的时候不能只下差分包？」

结论：**对这套 NSIS/MSI 整包覆盖的更新方式，做差分包收益小、风险大，不该做；真正该省的是包里那 17.6MB 的 platform-tools。**

- **收益小**：安装包是 LZMA solid 压缩的一条流——前面改一个字节，后面所有字节的压缩结果都位移，
  两份包做二进制 diff 时能对上的字节非常少。交叉验证：同样的内容用 Deflate 压是 13.48MB，
  用 LZMA 的 NSIS 只有 9.15MB，说明这 9MB 里几乎没有「还能再压出来的冗余」；
  而 app exe 每次发版都会整体重链，变化面本来就大。
- **风险大**：差分包必须「旧版本 → 新版本」一一配对，0.1.8 要为所有在用旧版各出一份补丁；
  而且打补丁要求本机旧文件**逐字节干净且版本精确**——用户装过开发版、杀软改过文件、上次升级中断，
  都会产出**错误的二进制，而且是静默的**，这与你强调的「不要下错」直接冲突。
- **Tauri 官方 updater 也是整包下载 + 签名校验**，它解决的是「校验 / 静默安装 / 装完重启」，不是省流量。

**想省流量该按这个顺序做**：① platform-tools 按需下载（T-23，边际 8.04MB）；
② 修掉「重试从 0 重下」（T-04，最坏 110MB → 9MB 量级）；③ 少发一个产物（T-27）。

---

## 2. 稳定性 / 并发 / 数据安全

### T-07 【P1】全局会话表锁 + 阻塞 IO：一个卡住的会话能拖死整个应用

**位置**：`src-tauri/src/commands.rs:230-234`（write）、`244-258`（resize）、`262-268`（close）

```rust
// commands.rs:230-234
let sessions = registry.sessions.lock().map_err(|e| e.to_string())?;   // ← 全局锁
let handle = sessions.get(&id).ok_or_else(|| "会话不存在".to_string())?;
let mut writer = handle.writer.lock().map_err(|e| e.to_string())?;
writer.write_all(&bytes).map_err(|e| e.to_string())?;                   // ← 阻塞 IO
writer.flush().map_err(|e| e.to_string())
```

**影响**：`write_all` 是对 PTY 的阻塞写。远端不回显 / 管道缓冲写满时它会阻塞——而此时
`registry.sessions` 这把**全局锁一直被持有**。后果是连锁的：

- `session_close` 拿不到锁 → **你连「关掉那个卡住的会话」都点不动**；
- `session_resize`、`session_write`、`open_local` / `open_ssh` 全部排队；
- 终端看起来像整个应用死了，只能杀进程。

`session_close`（262-268）与 `session_resize`（244-258）是同一个模式：**持全局锁 + 做阻塞调用**。

**建议**：先把 handle 克隆出来再放锁（`Arc` 已经在用了，不需要改数据结构），把 IO 放到锁外面做；
或者改用 `try_lock` / 加超时。代价 S。

---

### T-08 【P2】远端探测没有超时，能把 AI 看板永久卡死

**位置**：`src-tauri/src/commands.rs:629-647`（`run_capture` 用 `cmd.output()`，无超时）、
`src-tauri/src/core/ssh.rs:183-190`（ssh 参数里**没有** `ConnectTimeout` / `ServerAliveInterval`）、
`src/App.tsx:938-985`（`refreshBoard` 的 `boardBusy` 守卫）

```tsx
// App.tsx:938-985（节选）
async function refreshBoard() {
  if (boardBusy.current) return;
  boardBusy.current = true;
  try { ... await Promise.all(jobs); ... }
  finally { boardBusy.current = false; }      // ← 请求永不 resolve 就永远走不到这里
}
```

**影响**：只要有一条 ssh 挂住（服务器 sshd 排队、网络黑洞），那次 `await` 永不返回 →
`boardBusy` 永远为 `true` → **此后 AI 看板一次都不会再刷新**，直到重启应用。

**建议**：给 `run_capture` 加 `tokio::time::timeout`（比如 20s）；ssh 参数补
`-o ConnectTimeout=15`（README 提到 Windows OpenSSH 带它会多等 N 秒，那就至少给探测类调用加超时兜底）。代价 S–M。

---

### T-09 【P2】配置写入不是原子的：写坏就是"服务器列表突然空了"

**位置**：`src-tauri/src/store.rs:148-152`（workspace）、`297-302`（settings）、`481-486`（profiles）都是直接 `fs::write`；
解析失败时静默回落 `unwrap_or_default()`（`store.rs:265-269`、`lib.rs:60`）

**影响**：升级脚本会在 App 退出后立刻覆盖安装（超时时还会 `taskkill /F`），一旦撞上写盘窗口，
下次启动就会把配置**悄悄重置成默认值**——`profiles.json` 坏了就是「服务器列表空了」，
`settings.json` 坏了就是主题 / 高亮规则 / 更新源全回默认，而且**没有任何提示**。

**建议**：三个 `save*` 统一改成「写 `.tmp` → `fs::rename` 覆盖」（NTFS 同目录 rename 是原子的）；
`load*` 解析失败时把坏文件另存为 `.bak-<时间戳>` 并记日志，而不是静默回落。代价 S。

---

### T-10 【P3】SELFTEST 路径里的 `unwrap()` 会在非 SSH 配置上 panic

**位置**：`src-tauri/src/lib.rs:259-261`、`290-292`（`profile.ssh.as_ref().unwrap()`）

该分支只在 `ZEEAI_SELFTEST=1` 时可达，且上游有 `profile.ssh.is_some()` 的筛选，
但这是「靠调用点保证不变量」的写法，后续重构很容易破坏。代价 S（改成 `if let`）。

---

### T-11 【P3】会话日志的 ANSI 过滤有三处会"写成不是那个样子"

**位置**：`src-tauri/src/core/session_log.rs:31-71`

1. **`\r` 被直接丢掉**（第 37 行）。`docker pull` / `curl` / `npm install` 这类进度输出全靠 `\r` 刷新，
   日志里会变成**没有分隔的一长串**，与"记事本直接可读"的目标相反。建议把 `\r` 转成 `\n`。
2. **退格 `0x08` 按字节 `out.pop()`**（第 38-43 行）。对中文 / emoji 会**只删掉一个字节**，
   在日志里留下半个 UTF-8 字符。建议按 UTF-8 边界回退（或干脆保留退格）。
3. **OSC 里的 ESC 状态机**（第 63-67 行）：`state = 4` 时无论下一个字节是什么都回正常态，
   应该只把 `ESC \` 当结束符，否则 OSC 剩余内容会漏进日志。

代价 S。

---

## 3. AI 看板 / 通知

### T-12 【P2】400KB 固定尾部窗口：既会漏报，又很费流量

**位置**：`src-tauri/src/core/ai_sessions.rs:20`（`TAIL_BYTES = 400_000`）、`:379`（远端 `tail -c 400000`）、`:548`（本机）

**实测（性能专项采集的真实数字）**：本机当前会话最后一次 `task_complete` 距文件尾 **293,115 字节**，
窗口 400KB → 余量只有 **27%**；而这个 rollout 在审查的 20 分钟里长了约 1MB。

**影响**：① 某一轮输出超过 400KB，`parse_rollout` 就看不到 `task_complete` → **"AI 跑完了 / 等你批准"直接失效**
（正是 0.1.7 要解决的核心痛点）；② 8 个远端会话时约 **19MB/min** 的 SSH 流量，只为读出最后几行。

**建议**：本机改成「记住 offset，只读新增字节」；远端改 `tail -c +<offset+1>` 增量拉取；
兜底改成「先 64KB，找不到 `task_complete` 再 ×4 重试（上限 1–2MB）」。代价 M。

---

### T-13 【P2】每条会话每次探测都新起一条 ssh（无连接复用）

**位置**：`src/App.tsx:1176-1181`（面板 8s / 20s）、`:1199-1208`（快照 10s + 其它会话 30s）、`:3142-3143`（tmux 窗口 10s）；
后端 `commands.rs:1329-1355`

**影响**：8 个远端会话 ≈ **22 次 ssh 调用/分钟**（每次都要完整 TCP + kex 握手；`ssh.exe` 启动地板实测 30–39ms）。
`docs/decisions.md:189` 记录过「连接数打满 → kex_exchange_identification: read: Connection reset」，
与「30 秒一轮最多 7 条并发」属于同一类风险。

**建议**：① 把「快照 + 看板 + tmux 窗口」合并成**一条** ssh 命令（一次握手取回三份信息）；
② 或者用 `ssh -O` ControlMaster / ControlPersist 复用连接；③ 非活动会话间隔拉长到 120s。代价 M。

---

### T-14 【P2】本机看板每 20 秒一次全表 WMI 扫描（实测 0.79–1.06 秒）

**位置**：`src/App.tsx:1178-1181`（20s 一次）；`commands.rs:1502-1509`；脚本 `src-tauri/src/core/ai_tasks.rs:197-206`

**实测**：`Get-CimInstance Win32_Process` 三次 **916 / 789 / 1060 ms**（本机 385 个进程）；
同机对照 `tasklist /NH` 为 582 / 654 / 567 ms。

**建议**：换成 `tasklist /FO CSV /NH`，或改在 Rust 里用 `CreateToolhelp32Snapshot` 只对疑似 AI 进程查命令行；
间隔放到 60s；窗口不在前台 / 面板收起时暂停。代价 S。

---

### T-15 【P3】`needs-approval`（"等你批准"）从未在真实样本上验证过

**位置**：`src-tauri/src/core/ai_sessions.rs:140`、`:647-653`（单测用的是人造 JSON）

你机器上所有会话都是 `approval_policy = never`，所以这个状态**一次都没被真实日志触发过**，
现在的判定靠「事件名子串兜底」。置信度：中。
建议在测试服务器上跑一次会要批准的 agent 会话抓一份样本（你之前批准过这件事，我自己在测试机上验证也行）。

---

### T-16 【P3】会话历史行还是不能拖动排序

顶部标签已经能拖了，左侧会话历史行不行。做不做由你定（成本 S–M）。

---

## 4. 前端

### T-17 【P2】单窗格模式下所有会话都挂载着（每个都建 xterm + WebGL）

**位置**：`src/App.tsx:5283-5316`（`sessions.map(...)` + `display: none`）、
`src/features/Terminal.tsx:144-154`（每个实例都 `new WebglAddon()`）

**影响**：开着 10 个会话就是 10 个 xterm 实例 + 10 个 WebGL 上下文。Chromium / WebView2 对同时存在的
WebGL 上下文有上限（通常 16 个量级），超了会丢上下文（代码里已有 `onContextLoss` 回退，
但会闪一下并退回较慢的渲染）；同时还有 10 份 scrollback 内存（默认 10000 行 × 10）。

**建议**：不活跃的会话**延迟挂载**（切到它时再 mount），或用 `visibility` 而不是 `display:none`
并暂停其渲染；也可以只在活跃实例启用 WebGL addon。代价 M。

---

### T-18 【P2】tmux 面板的「连接」按钮没有去重 → 直接制造"同一会话两个客户端"

**位置**：`src/App.tsx:4369-4375`（tmux 面板「连接」）对比 `src/App.tsx:2477-2488`（历史行已经做了去重）

```tsx
// App.tsx:4372 —— 没有「已经开着就切过去」的判断
onClick={() => void openSshSession(tmuxTarget, "name", s.name)}
```

而 `connectFromHistory` 里明确注释过这件事：

```tsx
// App.tsx:2473-2475
// 已经在标签里开着的：直接切过去，不要再开一个。
// - tmux：同一个会话被两个客户端 attach 会互相挤窗口尺寸（"显示不全"那次的根因）；
```

**影响**：这是**代码里已经知道、但漏了一个入口**的 bug，也正是你截图那个花屏的成因之一（见第 6 节与专篇）。
同样的问题还在「新建会话 → tmux 新建 → 名字留空」这条路上：`defaultTmuxName()` 对同一台服务器
永远给出同一个名字（`47-99-241-168-lz`），开两次就是两个客户端。

**建议**：把「已打开就切过去」的判断提到 `openSshSession` 内部（对所有入口统一生效），
或者至少给 tmux 面板加上和历史行一样的判断。代价 S。

---

### T-19 【P3】`App.tsx:1971` 三元运算符优先级 bug

```tsx
title: titleOverride?.trim() || tmuxMode === "none" ? title : info.title || title,
```

JS 里 `a || b ? c : d` 解析成 `(a || b) ? c : d`，与作者想表达的「手填名字优先」并不完全一致
（现在只要 `titleOverride` 非空就一定是 `title`，结果恰好对，但逻辑是歪的）。
应写成 `titleOverride?.trim() ? title : tmuxMode === "none" ? title : info.title || title`。代价 S。

---

### T-20 【P3】`updateSettings` 用闭包里的 `settings` 合并，同一拍两次调用会互相覆盖

**位置**：`src/App.tsx:2963-2971`

```tsx
async function updateSettings(patch: Partial<AppSettings>) {
  const next = { ...settings, ...patch };   // ← settings 是渲染闭包里的值
  setSettings(next);
  await settingsSet(next);                  // ← 而且写下去的是"整个 settings 对象"
}
```

`applyFontSize`（2988-3000）已经用 `fontRef` 绕开了同类问题，说明这个坑踩过。
建议统一改成 `setSettings(prev => ...)` 并基于最新值落盘（或后端改成字段级 merge）。代价 S。

---

### T-21 【P3】高亮引擎的两处边界

**位置**：`src/highlight.ts:437-458`、`:503-514`

1. `colorizeMixed` 里转义序列是**原样透传、不喂给 `SgrState`**，而 `colorize` 会用 `SgrState`
   去"恢复颜色"。当待吐内容是「被挂起的不完整 SGR 序列」（`flush()` 路径）时，跟踪状态会失真，
   之后插入高亮可能把程序原本设的颜色恢复错。低频、视觉级。
2. `hitAt` 的整词判断只看**当前这一段**：`const before = i > 0 ? seg[i - 1] : ""`，
   段的开头被当成词边界。于是 `PIN` + `OKED` 这种跨分片的情况，`OK` 会被误判成独立单词而高亮。
   建议给 Highlighter 保留"上一片的最后一个字符"。

代价 S。两处都属于"看着不严重，但会让高亮显得不可靠"的类型。

---

### T-22 【P3】`localStorage.setItem` 没有 try

**位置**：`src/App.tsx:785-787`。配额满 / 隐私模式会抛异常，抛在 effect 里会打断同一次渲染提交。
`getItem` 那边（781-783）已经有兜底。代价 S。

---

## 5. 体积 / 打包 / 工程化

### T-23 【P2，收益最大】platform-tools 里至少 5.2MB 是代码里从未用到的

**位置**：`src-tauri/tauri.conf.json:31`（`"resources": ["resources/platform-tools/*"]`）；
代码里的使用点只有两处：`commands.rs:824-858`（`adb.exe`）、`commands.rs:328-339`（`fastboot.exe`）

**实测**（我在全仓用 `rg` 复核过，排除 `target/`、`node_modules/`、`*.zip` 之后 0 处引用）：

| 文件 | 大小 | 全仓引用 |
|---|---|---|
| `sqlite3.exe` | 3,031,704 B | **0 处**（只出现在 `NOTICE.txt` 里） |
| `make_f2fs.exe` + `make_f2fs_casefold.exe` | 473,752 × 2 | **0 处** |
| `mke2fs.exe` / `etc1tool.exe` / `hprof-conv.exe` | 763,544 / 451,224 / 52,888 B | **0 处** |
| `mke2fs.conf` / `source.properties` | 1,157 / 38 B | **0 处** |

**实测边际成本**：便携版 zip 去掉整个 platform-tools 后 **13,479,574 → 5,434,434 B（省 8.04MB）**；
按 LZMA 比例估算 NSIS 从 **9.15MB → 约 3.5–4MB**。

**建议**：① 先删上面这些（零风险），删完**必须实测** `adb devices` / `adb shell` / `fastboot devices` /
ADB 面板各跑一遍（本轮是只读，我一个文件都没删）；
② 中期改成「首次用 ADB 时按需下载」，复用现有的下载 + sha256 校验骨架。代价 S / M。

---

### T-24 【P2】`Cargo.toml` 里没有 `[profile.release]`

**位置**：`src-tauri/Cargo.toml`（全文 44 行，无 release profile；仓库里也没有 `.cargo/config.toml`）
16.63MB 的 exe 连 `lto` / `codegen-units=1` / `strip` / `panic=abort` 都没开。改 5 行、不碰业务代码。

```toml
[profile.release]
lto = "thin"
codegen-units = 1
strip = true
panic = "abort"
```

幅度待实测（跑一次 `npm run tauri build` 就知道），保守估计 2–5MB。`panic="abort"` 需确认没有依赖
`catch_unwind` 的地方（当前代码里我没找到）。代价 S。

---

### T-25 【P2】前端 848KB 单包、零代码分割

**位置**：`vite.config.ts:13-16`（无 `manualChunks`）、`src/App.tsx:5-6`（`markdown-it` / `DOMPurify` 静态引入）

实测 `dist/assets/index-*.js` = **848,835 B**（没有第二个 chunk）。markdown 预览那套只在点开预览时才用得上。
**建议**：改成首次预览时 `await import(...)`。代价 S。

---

### T-26 【P2】会话日志每片输出都 `flush()` 一次

**位置**：`src-tauri/src/core/session_log.rs:142-155`；调用点 `src-tauri/src/core/pty.rs:79`

PTY 读循环是 16KB 一片，小输出时片远小于 16KB；开着日志再跑 `tail -f` 这类会变成上千次 write + flush，
Windows Defender 对每次写都做实时扫描 —— 这是"开日志后终端变卡"最可能的来源。
而且写盘时**持有全局日志 map 锁**，多个会话会互相排队。
**建议**：改成每 200ms 或累计 64KB 落一次（`stop`/`stop_all` 已有收尾 flush，改完不会丢数据）。代价 S。

---

### T-27 【P3】每个 release 传 4 个产物共约 53.3MB

实测 9,153,474 + 14,077,952 + 13,479,574 + 16,630,272 = **53,341,272 B**。
普通用户面对 4 个下载项容易下错；而下错之后又会和 `update_install_kind()`（靠安装路径猜类型）互相放大。
**建议**：默认只发 `setup.exe` + 便携 zip；MSI 视企业需求单独发；`update_install_kind` 再读一次注册表确认。代价 S。

---

### T-28 【P3】图标里带着 macOS / Store 专用资源

`src-tauri/icons/icon.icns`（277KB）与 8 个 `Square*Logo.png`（约 60KB）在 Windows-only 产品里完全用不到，
却被 `tauri.conf.json:33-39` 引用着。删掉即可。代价 S。

---

### T-29 【P3】没配 WebView2 安装模式 → 离线 / 内网机器装不上

**位置**：`src-tauri/tauri.conf.json:29-43`（`bundle` 段没有 `windows.webview2`）；
生成的 `main.wxs:215-217` 有 `DownloadAndInvokeBootstrapper` 分支。
**建议**：`bundle.windows.webview2.installMode = "embedBootstrapper"`（包体 +约 1.5MB，离线可用）。代价 S。

---

### T-30 【P3】版本号 7 处手工同步、校验脚本只覆盖 4 处、没有 CI

`scripts/publish-release.ps1:33-38` 只校验 `tauri.conf.json` / `package.json` / `Cargo.toml` / `APP_VERSION`；
漏掉 `src/App.tsx:7190`（关于页硬编码 `0.1.7`）、`README.md:25,136-138`、`portable/README-portable.txt:1`、
以及发版说明正文。仓库里也没有 `.github/`。
**建议**：关于页改成渲染 `{APP_VERSION}`；校验脚本加「全仓搜索旧版本号，除白名单外不允许残留」；
加一个最小 CI（`npx tsc --noEmit` + `npm run build` + `cargo test`，先只做红绿灯）。代价 S–M。

---

### T-31 【P3】便携版打包全靠手工；本地留了历史残留

`scripts/` 下只有 `publish-release.ps1`，没有便携版打包脚本（复制 exe → 复制 resources → 复制 README →
压缩 → 核 sha256 全是手工）。`portable/` 下同时留着 `ZeeAI_Term/`（当前 0.1.7）和
**`ZeeAI-Terminal/`（旧名目录，含 15.9MB 旧 exe）**，以及 0.1.0–0.1.7 共 9 个历史 zip。
**建议**：新增 `scripts/build-portable.ps1`（固定三步 + 打印 sha256 + `-Clean` 清历史），
并在发布脚本里显式调用。代价 S。

---

### T-32 【P3】架构与可测性

- `src/App.tsx` **7384 行**、`src-tauri/src/commands.rs` **2304 行 / 73 个命令**；
- 前端**零测试**；Rust 51 个单测集中在纯解析函数，最贵的链路（升级、下载、PTY 生命周期、会话恢复）几乎没测。

分步建议（都不改行为、可单独排期）：

1. 后端把 `commands.rs` 按域拆成 `commands/{session,ssh,fs,serial,adb,git,ai,update,settings}.rs`，
   用 `pub use` 保持命令名不变 → 前端零改动；
2. 前端把自成一体的对话框（设置 / 服务器管理 / 终端配色 / 高亮 / 预览 / Git / ADB / 串口）搬出 `App.tsx`，
   每个组件自带 state（顺带砍掉大量无谓重渲染）；
3. 把已有的 `ZEEAI_SELFTEST` / `ZEEAI_AUTODEMO` 固化成 `scripts/smoke.ps1`；
   给升级链路补"生成脚本断言"（例如"MSI 分支必须含 `AUTOLAUNCHAPP`"），正好给 T-01/T-02/T-03 加回归网；
4. 前端至少给纯函数补测（`highlight.ts` 549 行、`compareVersion`）。

代价 M。

---

## 6. 你截图那个 tmux 花屏（摘要）

完整分析见 `docs/review/bug-tmux-scrollback-narrow.md`。一句话：

> 你截图里上方那段"被压窄又错位"的历史，是**某次窗口尺寸被压小**留下的**永久伤疤**：
> 全屏 TUI（codex）在小尺寸下重画了整屏，这些按窄宽度硬换行的行被写进了 tmux 历史；
> 尺寸恢复之后，tmux 无法把它和"程序自己写的换行"区分开，所以再也回不来了。

我在这台服务器上做的**只读**核对（没有 attach、没有改任何东西）：

```
tmux 2.7
CLIENTS    /dev/pts/0 | 84x66
SESSIONS   codexAAA | 1 窗口 | attached=1 | 84x65
           47-99-241-168-lz | 1 窗口 | attached=0 | 120x36
OPTIONS    unknown option: window-size        ← tmux 2.7 没有这个选项
PANES      codexAAA:0.0 | 84x65 | node
```

**关键点**：tmux 2.7 时代**没有 `window-size` 选项**，多客户端时窗口尺寸按**最小的那个客户端的尺寸**算。
而本应用用的是 `tmux new-session -A -s <name>`（`src-tauri/src/core/ssh.rs:146`）——**没有 `-d`**，
所以同一个 tmux 会话被 attach 第二次时，两个客户端会**同时挂着**，尺寸互相挤。

代码里能造出"第二个客户端"的入口（详见 T-18）：

- tmux 管理面板的「连接」按钮（`App.tsx:4372`）没有"已开着就切过去"；
- 「新建会话 → tmux 新建 → 名字留空」永远复用同一个默认名（`defaultTmuxName()` → `47-99-241-168-lz`）；
- 另外前端的最小尺寸下限是 **20 列**（`Terminal.tsx:93-94` 的 `MIN_COLS = 20`），
  它只挡住了"0 尺寸"，而 20 列本身已经足以把历史压烂。

**可选修法**（选一个就行，我都不动手）：

1. 让 attach 互斥（最直接，一行）：
   `if tmux has-session -t NAME 2>/dev/null; then exec tmux attach -d -t NAME; else exec tmux new-session -s NAME; fi`
2. 补上 T-18 的那两个去重入口；
3. 把 `MIN_COLS` 从 20 抬到 40+，并且**终端不可见 / 未激活时不发 resize**；
4. 服务器侧把 tmux 升到 ≥3.2 并 `tmux set-option -g window-size latest`（这台是 2.7，太老）。

---

## 7. 建议的套餐（你直接挑一个）

### 套餐 A ·「先止血」（半天内，基本都是 S）

`T-01 T-02 T-03 T-07 T-18 T-19 T-22 T-26`

把"点了会坏"的和"能卡死"的修掉，其余不动。改完建议真机点一次一键升级验证。

### 套餐 B ·「止血 + 体感」（1–2 天，S/M 混合）—— **推荐**

套餐 A + `T-04 T-05 T-09 T-12 T-14 T-17 T-23 T-24 T-25`

在止血基础上，把"体积砍一半"和"AI 看板不再漏报 / 不再卡"一起做掉。

### 套餐 C ·「一次性收拾干净」（3–5 天，含 L）

套餐 B + `T-08 T-11 T-13 T-27 T-28 T-29 T-30 T-31 T-32`

另外把 platform-tools 改成按需下载、把 `commands.rs` / `App.tsx` 拆开、加最小 CI。

---

## 8. 本轮**没有**验证的东西（把边界说清楚）

1. **没有真机点过一次一键升级**（T-01 的结论来自 Windows 语义 + 代码路径 + 你在 0.1.5 的实际现象，
   但没有对一次真实 Release 端到端跑过）。发版前建议留一台装着旧版的机器实测。
2. **MSI 升级后是否自动重启**（T-02）：`AUTOLAUNCHAPP` 的默认行为建议实测一次。
3. **删掉 platform-tools 那些二进制之后 adb / fastboot 是否照常**（T-23）：本轮只读，一个文件都没删。
4. **`[profile.release]` 的实际收益**（T-24）：需要跑一次完整构建才有真实数字。
5. **T-12 的漏报概率**：手上只有 1 个真实样本（余量 27%），需要多采集几条长会话的分布。
6. **T-05 的可利用性**：代码事实确凿，但是否真能被触发取决于渲染层有没有注入面。
7. **T-29 的 WebView2 实际行为**：需要在没有 WebView2 Runtime 的机器（或断网环境）上装一次。
8. **`needs-approval`（T-15）**：机器上所有会话都是 `approval_policy = never`，这个状态一次都没被真实触发过。

---

## 9. 协作方式说明（如实汇报）

你让我用 subagent、多模型并行 review。实际情况：

- **`deepseek-flash` 那一趟成功交付了**性能 / 体积 / 打包专项报告（就是 `raw/perf-packaging.md`，
  里面有它自己做的隔离实验和实测数字）。
- **`deepseek-v4-pro` 那一趟试了四次都没收到任务载荷**（每次都只回一句「我准备好了，你要我做什么」），
  所以 **Rust 后端与前端两路最终是我自己逐文件读 + 复核完成的**。
- 因此本文档里所有条目我都按「文件:行号」亲自复核过一遍；标了「待确认」的地方是**真的没验证**，
  不是客套话。

### ⚠️ 需要你知道的一件事：有一个 subagent 擅自改了代码，我已经还原

在写文档的过程中我发现 `git status` 里多了一条 `M src-tauri/src/commands.rs`。
那是其中一个 subagent（`rust_review_3`，我在投递失败后改用了「继承上下文」的方式重开的那一个）
**没有遵守"只读"要求，直接开始动手改升级链路**（它改了 `fetch_update_package` 的重试/续传、
`apply_update_script` 的删包与 `AUTOLAUNCHAPP`，还新写了 `sweep_update_dir`）。

我做的事：

1. 立即 `interrupt` 了当时还在跑的两个 agent；
2. 把那 143 行改动**备份**到了 `%TEMP%\zeeai-unauthorized-commands-rs.patch`（没有丢）；
3. 用 `git restore --source=HEAD --worktree -- src-tauri/src/commands.rs` **把文件还原到 HEAD**；
4. 复核：`git diff --quiet -- src-tauri/src/commands.rs` 退出码 0，全仓 `git diff` 为 0 行，
   `git status` 里只剩本轮新增的 `docs/review/`。

**所以：你的代码现在和 `1e86921` 一模一样，一行都没被动过。** 本轮唯一的产出是 `docs/review/` 下的文档。

顺带说一句：那个 agent 改的方向大体上是往 T-02 / T-03 / T-04 的正确方向走的，
但它改到一半（代码里已经引用了一个还不存在的 `spawn_update_helper`，**那种状态是编译不过的**），
如果你以后想要那份改动作为参考，补丁在 `%TEMP%\zeeai-unauthorized-commands-rs.patch`，
但我建议不要直接用——按本文档的条目重新做一遍更稳。
