# ZeeAI Terminal v0.1.7 —— 性能 / 体积 / 打包 / 更新链路 只读审查报告

- 审查对象：`D:\AI\ZeeAI_term`（HEAD = `1e86921`，v0.1.7，工作区干净）
- 审查范围：启动性能、运行时开销、体积/打包、升级与更新链路、发布工程、架构与可测性
- 方法：**只读**。读源码/生成的安装脚本/现有产物 + 无害的只读测量命令（文件大小、压缩率、进程扫描耗时、`ssh -V`、`rg`）。
  **没有**改任何源码、没有跑 `npm run build` / `cargo build`、没有发版、没有安装任何东西。
- 所有数字都是本机实测；所有行号都可按引用复核。不确定的标了「待确认」。
- 唯一新增的文件是这份报告本身。测量过程中的临时文件（`%TEMP%\jobtest*`、`%TEMP%\pp-measure`）已清理。

---

## 结论摘要

1. **PP-01（P0，阻断级）：一键升级现在根本装不上。** 升级辅助脚本被挂进了「App 退出就杀掉一切」的 Job Object，而脚本的第一件事就是「等 App 退出」——App 一退，脚本同时被系统杀掉，安装器永远没机会启动。我用一个隔离实验实测了这条 Windows 语义（见 PP-01 证据），现象与 `docs/decisions.md:874` 记录的「点了升级 → 应用退出 → 再没回来 → 版本没变」完全对上。
2. **PP-02（P1）：MSI 版升级成功后不会自动重启应用。** NSIS 分支有 `/S /R`，MSI 分支只有 `/qb /norestart`；生成的 WiX 里自动拉起应用的条件是 `AUTOLAUNCHAPP AND NOT Installed`，而我们的命令行没传 `AUTOLAUNCHAPP`（`main.wxs:226`）。MSI 用户会看到「应用自己关了、再也没回来」，而发版说明写的是「一键升级并重启」。
3. **PP-03（P1）：每次成功升级都在 `%TEMP%` 留一份 9–14MB 的安装包。** 脚本只在**失败**时删包，成功直接 `goto done`。NSIS 9.15MB / MSI 14.08MB × 每次升级一份，长期累积，而且不会进「磁盘清理」的常规视野。
4. **PP-04（P2）：AI 面板的 400KB 尾部窗口「两头不讨好」。** 每 10 秒（远端会话是每次新起一条 ssh）拉取 rollout 文件最后 400KB（`ai_sessions.rs:20`）。实测我本机当前这条会话的最后一次 `task_complete` 距文件尾 **293,115 字节**——只剩约 27% 余量：一轮输出超过 400KB 就会**漏掉「AI 跑完了」**（正是 0.1.7 想修的那个问题）；同时 8 个会话场景下这等于每分钟十几 MB 的无用网络流量。
5. **PP-05/PP-06（P2）：轮询密度偏高，且两条链路都很贵。** 远端快照/看板探针每条都是**新起一个 `ssh.exe` + 完整握手**（无连接复用），8 个远端会话约 22 次/分钟；本机看板每 20 秒起一个 `powershell.exe` 做全表 WMI 扫描，**实测 789–1,060ms / 385 进程**（`tasklist /NH` 同机 567–654ms）。
6. **PP-07/PP-08（P2）：升级链路的「省流量」和「防下错」都还有明显缺口。** 重试时先删 `.part` 再下，等于每次都从 0 重来（curl 的 `--retry 5` 也没带 `-C -`），弱网下最坏要重传约 110MB；而校验依据（`expected_size` / `expected_sha`）**完全由前端传入**，传 `0` 和 `null` 时只剩一道「文件头是 MZ」——配合 `csp: null`，这是一条从渲染层到「下载并静默执行任意安装包」的通路。
7. **PP-11（P2，收益最大）：platform-tools 17.63MB 里至少 5.2MB 是代码里根本没用到的。** 实测：便携版 zip 去掉 platform-tools 后 13,479,574 → 5,434,434 字节（**边际 8.04MB**）。未被任何代码引用的有 `sqlite3.exe`(3.03MB)、`mke2fs.exe`(0.76MB)、`make_f2fs(.casefold).exe`(0.95MB)、`etc1tool.exe`(0.45MB)、`hprof-conv.exe`(0.05MB)。先删这部分是零风险的一刀。
8. **PP-10（P2，性价比最高）：`Cargo.toml` 里没有任何 `[profile.release]` 配置。** 16.63MB 的 exe 连 `lto` / `codegen-units=1` / `strip` / `panic=abort` 都没开。这是改 5 行、不需要动任何业务代码的体积/启动时间优化。

> 一句话总结：**发版/体积这条线的最大问题不是「不够优化」，而是「一键升级这条自研链路有一个必然失败的 P0」**；其次是体积（platform-tools + release profile）和轮询开销（ssh/WMI/400KB）。

---

## 实测数据

### 1) 产物与体积

| 项目 | 实测值 | 测量命令 |
|---|---|---|
| `dist` 总量 | **888,546 B**（0.85MB） | `Get-ChildItem -Recurse -File dist \| Measure-Object Length -Sum` |
| └ `dist/assets/index-*.js` | **848,835 B**（唯一 JS chunk，无分包） | 同上 |
| └ `dist/assets/index-*.css` | **39,309 B** | 同上 |
| 裸 exe `ZeeAI_Term.exe` | **16,630,272 B**（16.63MB） | `Get-Item src-tauri\target\release\ZeeAI_Term.exe` |
| NSIS 安装包 v0.1.7 | **9,153,474 B**（9.15MB） | `...\bundle\nsis\ZeeAI_Term_0.1.7_x64-setup.exe` |
| MSI 安装包 v0.1.7 | **14,077,952 B**（14.08MB） | `...\bundle\msi\ZeeAI_Term_0.1.7_x64_en-US.msi` |
| 便携版 zip v0.1.7 | **13,479,574 B**（13.48MB） | `portable\ZeeAI_Term-0.1.7-portable.zip` |
| 每个 release 的 4 个产物合计 | **约 53.3MB** | 上面四行相加 |
| `src-tauri/resources/platform-tools/` | **17,627,204 B**（17.63MB，14 个文件） | `Get-ChildItem -Recurse -File` |
| └ 其中 `adb.exe` / `sqlite3.exe` / `fastboot.exe` / `NOTICE.txt` | 8.27MB / 3.03MB / 2.43MB / 1.15MB | 同上 |
| `src-tauri/icons/` | 约 430KB（含 **`icon.icns` 277KB**、Square*Logo 系列） | `Get-ChildItem -Recurse -File src-tauri\icons` |
| 版本历史对照（同一内容） | NSIS：0.1.0 8,999,879 → 0.1.7 9,153,474（+153KB） | `bundle\nsis` 目录 |
| 编译中间产物 | `zeeai_terminal_lib.lib` 149MB、`.rlib` 61MB、`.pdb` 9.4MB（在 `target/`，不进发布） | 同上 |

### 2) 压缩率 / 边际成本实测（本次为结论新做的实验）

用 Deflate(Optimal) 重新打包同样内容，量化 platform-tools 在分发包里的真实成本：

| 打包内容 | 结果 |
|---|---|
| exe + README + `platform-tools/`（= 现在便携版的全部内容） | **13,479,295 B** ← 与实际发布的 zip（13,479,574 B）几乎逐字节一致，说明便携版就是「Deflate 最优 + 原样目录」 |
| exe + README（去掉 platform-tools） | **5,434,434 B** |
| **platform-tools 的边际成本** | **8,044,861 B（8.04MB）** |

推论（供决策，非实测）：NSIS 用 LZMA，同样内容的 NSIS/便携版比为 9,153,474 / 13,479,574 ≈ **0.68**；按此比例估算，去掉 platform-tools 后 NSIS 约 **3.5–4MB**（当前 9.15MB）。**这是「省下载量」性价比最高的一刀，远高于做差分包。**

### 3) 运行时开销实测

| 项目 | 实测值 | 测量命令 / 位置 |
|---|---|---|
| 全表进程扫描（本机看板用） | **916 / 789 / 1,060 ms**（3 次） | `Measure-Command { powershell -NoProfile -Command "Get-CimInstance Win32_Process ..." }`；代码在 `commands.rs:1502-1509` + `ai_tasks.rs:197-206` |
| 对照：`tasklist /NH` | **582 / 654 / 567 ms** | `Measure-Command { tasklist /NH }` |
| 本机进程总数（同一时刻） | **385** | `(Get-Process).Count` |
| `ssh.exe` 进程启动地板 | **30–39 ms**（5 次，仅 `ssh -V`，无网络） | `Measure-Command { ssh -V }`；每次远端探针还要加 TCP + kex 握手（通常 150–600ms） |
| 递归遍历 `~/.codex/sessions` 找最新 rollout | **13 ms**（本机 10 个文件 / 125.6MB） | `Measure-Command { Get-ChildItem -Recurse -File ... \| Sort LastWriteTime \| Select -First 1 }`；代码在 `ai_sessions.rs:557-590`（每 10 秒一次） |
| rollout 尾部窗口 | `TAIL_BYTES = 400_000`（固定 400KB） | `ai_sessions.rs:20`；远端用 `tail -c 400000`（`ai_sessions.rs:379`） |
| **实测：本机当前会话最后一次 `task_complete` 距文件尾** | **293,115 B**（文件 4,299,689 B，余量仅 27%） | 直接对 `~/.codex/sessions/2026/09/26/rollout-...01a0de2b....jsonl` 计算，见 PP-04 |
| 轮询密度（前端） | 更新检查 30min tick / ≥6h 间隔；AI 面板 8s + 20s；快照 10s + 30s；tmux 窗口 10s | `App.tsx:872-887 / 1170-1187 / 1199-1208 / 3142-3143` |
| 单测数量（Rust） | **51 个**（ai_tasks 10、ai_sessions 6、store 6、tmux 6、session_log 5、remote_fs 4、adb 3、highlight 3、commands 2、elevate 2、git 2、ai 2） | `rg --glob "*.rs" -c "#\[test\]\|#\[tokio::test\]" src-tauri\src` |
| 单测数量（前端） | **0**（`src/` 下无任何测试文件） | `rg --files src \| rg "test"` 无结果 |
| CI | **无**（没有 `.github/`） | `Test-Path .github` → False |
| 依赖规模 | npm：12 运行依赖 + 7 开发依赖；Cargo 直接依赖 14 项、`Cargo.lock` 共 568 个包 | `package.json` / `Cargo.toml` / `rg -c "^\[\[package\]\]" Cargo.lock` |

### 4) 生成的安装器源码（用于验证升级行为，未修改）

- NSIS：`src-tauri/target/release/nsis/x64/installer.nsi`（33,547 B，2026-09-27 01:29）
  - `installer.nsi:728-736`：`.onInstSuccess` 在 `${Silent}` 下 `nsis_tauri_utils::RunAsUser "$INSTDIR\${MAINBINARYNAME}.exe"` → **`/S /R` 确实会自动拉起应用**（与 `decisions.md:906` 的结论一致）。
- WiX：`src-tauri/target/release/wix/x64/main.wxs`（15,394 B，2026-09-27 01:29）
  - `main.wxs:36-38`：`AUTOLAUNCHAPP` / `LAUNCHAPPARGS` 两个属性，默认**未赋值**；
  - `main.wxs:70`：`LaunchApplication` 自定义动作；
  - `main.wxs:226`：`<Custom Action="LaunchApplication" After="InstallFinalize">AUTOLAUNCHAPP AND NOT Installed</Custom>`；
  - `main.wxs:74`：另一处触发点是 ExitDialog 的「完成」按钮（`/qb` 下没有这个对话框）；
  - `main.wxs:28`：`InstallScope="perMachine"`（所以 MSI 必弹 UAC，与注释一致）。

---

## 问题与优化清单

### PP-01（P0 阻断）升级辅助脚本被挂进 Job Object，App 退出时被系统连带杀掉 —— 一键升级必然失败

- **位置**：`src-tauri/src/commands.rs:2301-2310`（挂 Job + 1 秒后 `app.exit(0)`）；`src-tauri/src/core/job.rs:29`（`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`）、`job.rs:49-58`（`assign`）
- **证据（代码）**：

```rust
// commands.rs:2299-2310
let child = cmd.spawn().map_err(|e| format!("启动升级脚本失败: {e}"))?;
log::info!("update: 升级脚本已启动 pid={}", child.id());
// 顺手把升级脚本也挂进 Job Object：万一它自己卡住，App 退出时会一起被收掉
crate::core::job::assign(child.id());

// 给脚本一点时间就位，然后走正常退出路径（收干净会话进程）；重启由脚本/安装包负责
let app_for_exit = app.clone();
tokio::spawn(async move {
    tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
    log::info!("update: 退出应用，交给升级脚本完成覆盖");
    app_for_exit.exit(0);
});
```

  脚本的第一步恰恰是**等 App 退出**（`commands.rs:2149-2157`：`tasklist /FI "PID eq {pid}"` + `goto wait`），也就是说：脚本唯一要等的那个时刻，正是它自己被杀的同一时刻。
- **证据（实测，本次新做的隔离实验）**：用 P/Invoke 复刻同一套设置（`CreateJobObjectW(null,null)` + `LimitFlags = KILL_ON_JOB_CLOSE(0x2000)`），子进程用 `cmd /c "ping -n 6 ... & echo OK > marker"`：
  - 对照组（**不进** Job 的子进程）：父进程退出后文件**正常写出**（`control2.txt`，6 B，01:45:24）。
  - 实验组（**进** Job 的子进程）：父进程退出后文件**从未出现**（`marker2.txt` 不存在）→ 子进程在父进程退出瞬间被系统终止。
  - 附带的第二次对照：第一次实验因 `Add-Type` 编译失败没能真正建 Job，两个子进程**都**写出了文件——进一步证明差异来自 Job 本身。
- **影响（在这台机器上的具体现象）**：用户点「一键升级」→ 下载完成、`apply_update.cmd` 已写出 → App 退出 → 脚本被收掉 → **安装器根本没运行**、`apply_update.log` 不会被写入（所以底部状态栏也不会提示失败）→ 用户回到桌面发现「版本号没变」，与 `docs/decisions.md:874` 记录的事故现场一致。**这也意味着 0.1.6 之后对外宣称的「一键升级」实际不可用（除非另有一次人工验证证明这条路径能过）。**
- **建议修法**（择一）：
  1. 最小改动：升级脚本**不要** `job::assign`（它不需要跟 App 同生共死；它本来就自带 2 分钟超时 + 退出码检查）。curl 与终端子进程仍然留 Job 里。
  2. 更稳：给脚本用 `CREATE_BREAKAWAY_FROM_JOB` 启动，并在 Job 上额外设置 `JOB_OBJECT_LIMIT_BREAKAWAY_OK`，让脚本显式脱离。
  3. 备选：把「写脚本 + 启动脚本 + 退出」交给一个独立进程（如 `cmd /c start /b`）并确保它在 job 外。
- **置信度**：**高**。Windows 语义已实测；代码路径（挂 Job → 1s 后退出）已读码确认。唯一未做的是「真机点一次一键升级」的端到端复核（需要真实 Release），建议发布前补一次。
- **修复代价**：**S**（删一行 + 加注释；方案 2 为 S+）

### PP-02（P1）MSI 一键升级成功后不会自动重启应用

- **位置**：`src-tauri/src/commands.rs:2139-2145`（msi 分支无 `/R` 等价物）、`2164-2166`（RC=0 → `goto done`）；证据来自生成的 `src-tauri/target/release/wix/x64/main.wxs:36-38,70,74,226`
- **证据**：

```rust
// commands.rs:2139-2145
let install = if kind == "msi" {
    // MSI：msiexec 静默升级（/qb 显示一个进度条；perMachine 会弹一次 UAC）
    format!("msiexec /i \"{}\" /qb /norestart", dest.display())
} else {
    // NSIS：/S 静默安装 + /R 装完自动重启应用
    format!("\"{}\" /S /R", dest.display())
};
```

```xml
<!-- main.wxs:226 —— 自动拉起应用的前提是 AUTOLAUNCHAPP 有值 -->
<Custom Action="LaunchApplication" After="InstallFinalize">AUTOLAUNCHAPP AND NOT Installed</Custom>
```
  `AUTOLAUNCHAPP` 在模板里是空属性（`main.wxs:36`），只有调用方在命令行上传了它才会生效；我们的 `msiexec` 命令行没传。另一处触发点是 ExitDialog 的「完成」按钮（`main.wxs:74`），`/qb` 下不显示该对话框。而 App 侧在 1 秒后已经自己 `app.exit(0)`（`commands.rs:2306-2310`），所以没有任何东西会把窗口拉回来。
- **影响**：MSI 用户点完一键升级 → 应用消失、**不再回来**；桌面/开始菜单里其实装好了新版，但用户会以为「升级把程序弄坏了」。而 `docs/release-notes-v0.1.7.md:112` 写的是「一键升级到 0.1.7 **并重启**」。
- **建议修法**：`msiexec` 命令行加 `AUTOLAUNCHAPP=1`（模板已支持，一行改动）；或在脚本里对 MSI 也做「RC=0 → `start "" "{exe}"`」，并把发版说明改成「MSI 升级会弹一次 UAC」。
- **置信度**：**高**（模板证据 + 无 `/R` 的事实）；建议实测一次 MSI 升级勾掉这个「待确认」。
- **修复代价**：**S**

### PP-03（P1）升级包下载成功后从不清理，每次升级在 `%TEMP%` 留一份 9–14MB

- **位置**：`commands.rs:2161-2170`（只有失败分支 `del /f /q "{dest}"`；RC=0 直接 `goto done`）；相关路径 `commands.rs:2283-2289`、`2003-2007`
- **证据**：

```bat
rem commands.rs:2163-2170 生成的脚本片段
set RC=%ERRORLEVEL%
echo %DATE% %TIME% installer exit=%RC% >> "{log}"
if "%RC%"=="0" goto done          <-- 成功：不删包，直接结束
if "%RC%"=="3010" goto done       <-- 需要重启：也不删
del /f /q "{dest}" >nul 2>&1      <-- 只有失败才删
```
  文件名的版本号是变量（`commands.rs:1846-1852`：`ZeeAI_Term_{safe_version}_setup.{ext}`），所以**每个版本各留一份**；只有「同一版本重下」时才会被 `1874` 行的 `remove_file(&dest)` 覆盖。
- **影响**：升一次留一份 **9.15MB（NSIS）/ 14.08MB（MSI）**；升 10 个版本 ≈ **90–140MB** 常驻 `%TEMP%\ZeeAI-Term-update\`。同目录还会留下 `apply_update.cmd` 与 `setup.*.part.stderr`（`.stderr` 只在**下一次**下载开始时才清，见 `2007`）。
- **建议修法**：脚本无论成败都在写日志之后删包（成功路径直接 `del /f /q "{dest}"`）；`.cmd` 自己在最后加 `del "%~f0"`；或 App 在**下一次** `update_download_install` 开头清理该目录里所有非当前版本的 `setup.*`。
- **置信度**：**高**（读码确认 + 生成脚本确认）
- **修复代价**：**S**

### PP-04（P2）AI 探针的 400KB 固定尾部窗口：既可能漏报「跑完了」，又是每条会话每 10 秒一次的流量

- **位置**：`src-tauri/src/core/ai_sessions.rs:20`（`TAIL_BYTES = 400_000`）、`:379`（远端 `tail -c 400000`）、`:548`（本机 `read_tail`）；调用方 `src/App.tsx:1199-1208`（10s / 30s）与 `src-tauri/src/commands.rs:1546-1582`（`ai_session_snapshot`：远端走 `run_remote_capture`，本机走 `local_snapshot`）
- **证据（实测）**：直接量本机真实 rollout（`~/.codex/sessions/2026/09/26/rollout-...01a0de2b-...jsonl`，4,299,689 B）：

```
size= 4,299,689 B   task_complete 距文件尾 = 293,115 B   token_count 距文件尾 = 2,927 B
```
  最后一次 `task_complete` 距文件尾 **293KB**，而窗口只有 400KB —— **余量 27%**。该文件在本次审查的 20 分钟内已增长约 1MB（长任务、大文件读写的 rollout 增长很快），只要某一个回合产生 >400KB 的新事件，`parse_rollout` 就会看不到 `task_complete` → **「AI 跑完/等批准」的判定直接失效**（这正是 0.1.7 要解决的核心痛点）。
- **影响**：① 长会话漏报完成（用户又回到「怎么没提示我」）；② 8 个远端会话时，`refreshSnapshot`(10s) + `refreshOtherSnapshots`(30s) 每秒都在传 400KB 级文本：单会话 ≈ 40KB/s ≈ 2.4MB/min，8 会话 ≈ **19MB/min** 的 SSH 流量，只为读出最后几行。
- **建议修法**：① 本机改成「记住上次读到的 offset，只读新增字节」（文件长度即可，零成本）；② 远端改成 `tail -c +<offset+1>` 增量拉取，或把 `records`/`wc -c` 与 `tail` 合并成一次 ssh 调用；③ 兜底自适应：先用 64KB 窗口，找不到 `task_complete` 再 ×4 重试（上限 1–2MB），而不是无条件 400KB；④ 轮询可先用本机 `mtime`/`size` 是否变化短路（本机零成本）。
- **置信度**：**高**（实测数字 + 代码路径）；「多大比例的会话会超窗」需要更多样本才能给比例，标 **待确认**。
- **修复代价**：**M**

### PP-05（P2）每次远端探针都是「新起 ssh.exe + 完整握手」，且密度偏高（8 会话 ≈ 22 次/分钟）

- **位置**：`src/App.tsx:1176-1181`（AI 面板 8s / 20s）、`:1199-1208`（快照 10s / 其它会话 30s）、`:3142-3143`（tmux 窗口 10s）；后端 `commands.rs:1329-1355`（`run_remote_capture` → 有密码走 russh、否则 `ssh::ssh_exec_args` + `run_ssh_capture`），**没有任何连接池/复用**
- **证据**：前端定时器代码 + `run_remote_capture` 每次都 `std::process::Command` 起新 `ssh.exe`；实测 `ssh.exe` 进程启动地板 30–39ms（`ssh -V` ×5），真实探针还要加 TCP + kex + 远端命令。
- **影响**：`8 个远端会话` 时约 **22 次 ssh 调用/分钟**（活动会话 6 + 其它 7×2 + tmux 6 + 面板 7.5 + 看板 3）。`docs/decisions.md:189` 记录过「连接数打满 → `kex_exchange_identification: read: Connection reset`」，而 30 秒一轮最多 7 条并发正是同一类风险。副作用还有：服务器 `auth.log`/`sshd` 噪音、笔记本耗电、Windows 上每 10 秒一次的进程创建。
- **建议修法**：① 优先把「快照 + 看板 + tmux 窗口」合并成**一条** ssh 命令（一次握手取回三份需要的信息）；② 启用 `ssh -O` ControlMaster/`ControlPersist` 复用连接（Windows OpenSSH 支持），或对同一 profile 维护一条长连接复用 russh；③ 拉长间隔（快照 10s → 30s，非活动会话 30s → 120s），或改成「终端侧事件驱动」（在终端里检测 `task_complete` 字样/OSC 后再触发一次探针）。
- **置信度**：**高**（代码路径 + 实测启动成本）；实际网络放大倍数取决于用户网络，标 **待确认**。
- **修复代价**：**M**

### PP-06（P2）本机看板每 20 秒起一个 PowerShell 做全表 WMI 扫描（实测 0.79–1.06 秒/次）

- **位置**：`src/App.tsx:1178-1181`（20s 一次）；`src-tauri/src/commands.rs:1502-1509`（`powershell.exe -NoProfile -NonInteractive -Command <脚本>`）；脚本在 `src-tauri/src/core/ai_tasks.rs:197-206`（`Get-CimInstance Win32_Process`）
- **证据（实测，3 次）**：`916 / 789 / 1,060 ms`（本机 385 个进程）；同机对照 `tasklist /NH` 为 `582 / 654 / 567 ms`。
- **影响**：只要「AI 面板打开 + 存在本地会话」，就每 20 秒拉起一个几十 MB 内存峰值的 PowerShell 进程，每次约 0.8–1.1 秒 CPU 时间（12% 单核占空比），任务管理器里会看到 `powershell.exe` 一闪一闪；在低配机上会让终端输入有轻微顿挫。1 小时 ≈ 180 次进程创建 + 180 次 WMI 全表枚举。
- **建议修法**：① 换成 `tasklist /FO CSV /NH`（实测快约 1.5×，且不需要 PowerShell 启动开销），或在 Rust 里用 `CreateToolhelp32Snapshot` 枚举 PID + 只对疑似 AI 工具进程查命令行；② 间隔放到 60 秒（看板对秒级新鲜度不敏感，`decisions.md:948` 也承认「偏重」）；③ 可加「窗口不在前台/面板收起时暂停」。
- **置信度**：**高**（实测数字 + 代码路径）
- **修复代价**：**S**

### PP-07（P2）下载失败重试必然从 0 重来；`curl --retry` 也没开续传

- **位置**：`commands.rs:1858-1859`（每次 attempt 先 `remove_file(&part)`）、`:2006`（`run_curl_download` 开头又 `remove_file(dest)`）、`:2022-2026`（`--retry 5 --retry-all-errors`，**没有 `-C -`**）
- **证据**：

```rust
// commands.rs:1858-1864
for attempt in 1..=2u8 {
    let _ = std::fs::remove_file(&part);          // <-- 每次重试都从头开始
    let use_proxy = if attempt == 1 { proxy.as_deref() } else { None };
    ...
    let one = run_curl_download(&curl, url, &part, expected_size, use_proxy, &mut on_progress)
```

```rust
// commands.rs:2006-2007（run_curl_download 内部同样先删）
let _ = std::fs::remove_file(dest);
let _ = std::fs::remove_file(&err_path);
```
- **影响**：9.15MB 的包在弱网下：内层 curl 最多 6 次尝试（`--retry 5`）× 外层 2 次 = **最多 12 次整体重传 ≈ 110MB**，用户等待时间成倍。这也解释了「GitHub 直连经常传一半断掉」时的体验。
- **建议修法**：① 不删 `.part`（只在校验失败时删）；② 给 curl 加 `-C -`（配合 `--retry`）实现**真续传**；③ 校验通过后再原子改名（现有 `1873-1879` 逻辑保留即可）。注意与「不要分片」的用户要求不冲突：`-C -` 是单请求续传，不是 1MB 分片。
- **置信度**：**高**（读码确认）
- **修复代价**：**S**

### PP-08（P2）升级包的校验依据完全由前端传入；传 `size=0` + `sha=null` 时只剩「文件头是 MZ」

- **位置**：`commands.rs:2190-2199`（只校验 URL 是不是 GitHub Release）、`:2099`（`expected_size > 0` 才对比大小）、`:2107`（`expected_sha` 为 `None` 直接跳过）；前端来源 `src/App.tsx:3051-3069`（取 Release API 的 `assets[].size/digest`）；
- **证据**：

```rust
// commands.rs:2097-2120（package_problem）
if expected_size > 0 && actual != expected_size { return Some(...); }   // size=0 → 跳过
if !header_ok(path, ext) { return Some(...); }                          // 只剩这一道
if let Some(want) = expected_sha.map(str::trim).filter(|s| !s.is_empty()) { ... }  // None → 跳过
```
  而 `header_ok`（`1969-1984`）对 `.exe` 只检查前两个字节是不是 `MZ`。
- **影响**：任何能调用 IPC 的东西（被注入的页面、XSS、恶意的本地脚本、将来某个插件的 bug）都可以让 App **下载并静默执行**任意 `https://github.com/**/**/releases/download/**` 的 exe/msi。`tauri.conf.json:26` 的 `"csp": null` 意味着渲染层没有 CSP 兜底，这两件事叠加就是「渲染层被攻破 → 本机任意代码执行」。单用户本机场景下不算致命，但它是这条链路里最不该省的一道防线——而且用户明确说过「**不要下错**」。
- **建议修法**：① 后端自己取依据：在 `update_download_install` 内部 `GET https://api.github.com/repos/<固定 owner>/<固定 repo>/releases/latest`（或至少 README 里公布的 `assets[].digest`），把 `expected_sha` 变成**后端必填**而不是可选参数；② 白名单校验 `owner/repo` 与 `bundle.identifier` 绑定，拒绝其它仓库的下载地址；③ 可选：给 WebView 加 CSP（`tauri.conf.json` 的 `app.security.csp`），把注入面压小。
- **置信度**：**中高**（代码事实确凿；是否真的可被利用取决于渲染层的注入面，标 **待确认**）
- **修复代价**：**M**

### PP-09（P2）注释/文档与实现不一致：「分片 + 断点续传」的描述还在，代码早已改成整包一次下完

- **位置**：`commands.rs:1826-1829`（注释仍写「按 1MB 一段发 Range 请求…从已有文件大小接着下」）vs `commands.rs:1986`（`run_curl_download` 的注释明确写「**整包一次下完**（不分片、不续传）」）；文档侧 `README.md:127`（「未实现：传输进度条 / 断点续传（现在是 scp，无进度）」）、`docs/release-notes-v0.1.5.md:76`（「慢的时候会分片续传」）、`portable/README-portable.txt:21`（「断点续传：传一半的文件再次上传/下载会自动从断点接着传」——这条说的是 SFTP 传输，与升级链路不是一回事）
- **证据**：上面四处文本自相矛盾（同一条 `fetch_update_package` 的注释里既是「分段续传」又是「整包」）。
- **影响**：① 后来的人按注释改代码会改错方向；② 用户/外部读者对「有没有断点续传」的认知不一致（用户当年就是因为 0.1.5 的分片方案出事才要求「不要分片」的）；③ `README.md:127` 那条「未实现」早已过时（SFTP 进度/续传/密码登录读文件其实都做了）。
- **建议修法**：以代码为准统一措辞：「升级包 = 单请求整包下载 + 失败整包重下一次（`-C -` 续传待做）」；把 `README.md:127` 的「未实现」段整段重写（它现在是全仓最陈旧的一段）。
- **置信度**：**高**
- **修复代价**：**S**

### PP-10（P2）`Cargo.toml` 没有任何 `[profile.release]` 配置：LTO / opt-level / codegen-units / strip / panic=abort 全没开

- **位置**：`src-tauri/Cargo.toml`（全文 44 行，无 `[profile.release]`）；仓库里也**没有** `.cargo/config.toml`（`Test-Path .cargo` → False）
- **证据**：`Cargo.toml` 只有 `[package] / [lib] / [build-dependencies] / [dependencies] / [target.'cfg(windows)'.dependencies]` 五段；实测产物 `ZeeAI_Term.exe = 16,630,272 B`，旁边还有 9.42MB 的 `.pdb`。
- **影响**：这是「零业务风险、只改构建参数」的体积/启动改进项：`lto` + `codegen-units = 1` 通常能把 Tauri 版 Rust 二进制压掉两三成，`strip = true` 去掉符号，`panic = "abort"` 再去掉一层 unwind 表。按 16.63MB 保守估计能省 2–5MB（**待实测**，不写死数字）。
- **建议修法**：

```toml
[profile.release]
opt-level = "s"      # 或 3，按实测权衡
lto = "thin"         # 追体积可上 "fat"（编译更慢）
codegen-units = 1
strip = true
panic = "abort"
```
  建议先只加 `lto="thin" + strip=true + codegen-units=1` 跑一次 `npm run tauri build`，对比 exe 与 NSIS 大小（一次构建即可给出真实收益）。
- **置信度**：**中**（方向确定，幅度待实测）；`panic="abort"` 会改变 panic 行为，需确认没有依赖 `catch_unwind` 的地方（当前代码里未见）。
- **修复代价**：**S**（代价是编译时间变长）

### PP-11（P2）platform-tools 17.63MB 内嵌：其中 ≥5.2MB 是代码里从未使用的二进制

- **位置**：`src-tauri/tauri.conf.json:31`（`"resources": ["resources/platform-tools/*"]`）；资源目录 `src-tauri/resources/platform-tools/`；**代码里的使用点只有两处**：`commands.rs:824-858`（`adb.exe`）与 `commands.rs:328-339`（`fastboot.exe`）
- **证据（实测）**：

| 文件 | 原始大小 | 全仓是否被引用（`rg -i <名字>`，排除 target/node_modules/zip） |
|---|---|---|
| `adb.exe` | 8,273,560 B | 是（`commands.rs:824-858`） |
| `AdbWinApi.dll` / `AdbWinUsbApi.dll` | 108,184 / 73,368 B | 由 adb 运行时加载，保留 |
| `fastboot.exe` | 2,429,080 B | 是（`commands.rs:328-339`，Fastboot 面板） |
| `sqlite3.exe` | 3,031,704 B | **仅出现在 `NOTICE.txt` 里**（0 处代码引用） |
| `mke2fs.exe` | 763,544 B | **0 处引用** |
| `make_f2fs.exe` + `make_f2fs_casefold.exe` | 473,752 ×2 | **0 处引用** |
| `etc1tool.exe` | 451,224 B | **0 处引用** |
| `hprof-conv.exe` | 52,888 B | **0 处引用**（`rg -i hprof` 的 9 个命中都是 `sshProfiles` 的假阳性） |
| `NOTICE.txt` | 1,154,131 B | 许可声明文件（建议保留，或至少压缩后再放） |
| `libwinpthread-1.dll` | 243,016 B | 0 处引用（疑似供 sqlite3 使用，需随 sqlite3 一起确认） |
| `mke2fs.conf` / `source.properties` | 1,157 / 38 B | 0 处引用 |

  压缩实测：便携版 zip 13,479,574 B；去掉整个 platform-tools 后 5,434,434 B → **边际 8.04MB**。
- **影响**：每个用户都要为「用不到的 5–8MB」付出下载时间、安装体积和首个 ADB 使用时的解压/杀软扫描成本；`docs/decisions.md:921` 自己也把「platform-tools 改按需下载」列为省流量的第一优先级。
- **建议修法**：① **立即**（零风险）：删掉 `sqlite3.exe` / `mke2fs.exe` / `make_f2fs*.exe` / `etc1tool.exe` / `hprof-conv.exe` / `mke2fs.conf` / `source.properties`，然后**必须**跑一次 `adb devices` + `fastboot devices` + ADB 面板一次真实操作复核（本轮为只读审查，没有删）；② **中期**：把 platform-tools 改成「首次使用 ADB/Fastboot 时按需下载到 `%APPDATA%\ZeeAI-Terminal\tools\`」，下载走已有的下载+sha256 校验骨架（可以顺带复用 curl/代理/重试那套）；
- **置信度**：**高**（全仓无引用 + 实测压缩数字）；「删完 adb/fastboot 一定还能跑」标 **待确认**，必须实测复核。
- **修复代价**：**S**（删除）/ **M**（按需下载）

### PP-12（P2）没配 WebView2 安装模式 → 用默认的「联网下载引导程序」，离线/内网安装会失败

- **位置**：`src-tauri/tauri.conf.json:29-43`（`bundle` 段没有 `windows.webview2` 配置）；生成的 `main.wxs:215-217` 有 `DownloadAndInvokeBootstrapper`（条件 `NOT(REMOVE OR INSTALLED_WEBVIEW2_VERSION)`）
- **影响**：Win10 机器上若没有 WebView2 Runtime，安装时会尝试联网下载引导程序；**内网/离线机器会直接装不上**（而这类机器恰恰是终端工具的目标场景）。
- **建议修法**：`bundle.windows.webview2.installMode = "embedBootstrapper"`（包体 +约 1.5MB，仍然小巧且离线可用）；若目标环境大量是无 WebView2 的 LTSC，再考虑 `offlineInstaller`（+100MB 以上，不建议）。
- **置信度**：**中高**（Tauri 默认值 + 模板动作名）；MSI 内是否已内嵌 bootstrapper 二进制需看构建产物，标 **待确认**（可 `7z l` 或安装时断网实测）。
- **修复代价**：**S**

### PP-13（P2）发版全手工：版本号 7 处要同步，校验脚本只覆盖其中 4 处，且没有 CI

- **位置**：`scripts/publish-release.ps1:33-38`（只校验 `tauri.conf.json` / `package.json` / `Cargo.toml` / `App.tsx` 的 `APP_VERSION`）；**漏掉**的同类位置：`src/App.tsx:7190`（关于页硬编码 `0.1.7`）、`README.md:25,136-138`、`portable/README-portable.txt:1`、`docs/release-notes-vX.md`（文件名 + 正文表格 + 升级方式段）；仓库无 `.github/`
- **证据**：`publish-release.ps1:36` 只正则抓 `const APP_VERSION = "..."`；而 `App.tsx:7190` 是另一处独立的字面量；README 与便携版 README 各有一处版本号字面量。
- **影响**：① 用户看到的「关于页版本号」可能与真实版本不一致（现在恰好一致，全靠手改）；② 文档漂移已经发生过（`README.md:127` 还在说「未实现进度条/断点续传」）；③ 一切都是「本地手工 + 记忆」，没有 CI 兜底（既没有 `tsc --noEmit`，也没有 `cargo test` 的自动回归）。
- **建议修法**：① `App.tsx:7190` 改成渲染 `{APP_VERSION}`（删掉重复字面量）；② 校验脚本加一条「全仓搜索旧版本号，除白名单外不允许残留」；③ 加一个最小 GitHub Actions：`npm ci && npx tsc --noEmit && npm run build` + `cargo test`（不必自动发 Release，先做「红绿灯」）。
- **置信度**：**高**
- **修复代价**：**S–M**

### PP-14（P3）会话日志每片输出都 `flush()` 一次：高频小写盘放大

- **位置**：`src-tauri/src/core/session_log.rs:142-155`（`write_all(&scratch)` 后紧跟 `entry.writer.flush()`）；调用点 `src-tauri/src/core/pty.rs:79`（每读一片 PTY 输出就调一次）
- **证据**：

```rust
// session_log.rs:142-155
pub fn write(&self, session_id: &str, bytes: &[u8]) {
    ...
    let _ = entry.writer.write_all(&scratch);
    let _ = entry.writer.flush();      // <-- 每片都落盘
}
```
  `pty.rs:72-84` 的读循环是 16KB 一片，PTY 在小输出时会返回**远小于 16KB** 的片（提示符、逐行日志）。
- **影响**：开了会话日志后，输出越碎写次数越多（`tail -f` 类命令每秒可产生上千次 write+flush）；Windows Defender 默认对每次文件写都做实时扫描，这是最容易被感知到的「开日志后终端变卡」的原因。已有 `stop`/`stop_all`（`127-166`）做收尾 flush，所以合并写不会丢数据。
- **建议修法**：去掉每片 flush，改成「每 200ms 或累计 64KB 落一次」；或在 `LogRegistry` 里保存 `last_flush` 时间戳做时间片批量。
- **置信度**：**中**（行为读码确认；实际影响幅度取决于输出速率与杀软，标 **待确认**）
- **修复代价**：**S**

### PP-15（P3）前端 848KB 单包、零代码分割；`markdown-it` / `DOMPurify` 静态引入

- **位置**：`vite.config.ts:13-16`（`build` 段只有 `target` / `sourcemap`，没有 `rollupOptions.output.manualChunks`）；`src/App.tsx:5-6`（`import MarkdownIt from "markdown-it"; import DOMPurify from "dompurify";`）
- **证据**：`dist/assets/` 下只有一个 JS + 一个 CSS（实测 848,835 B / 39,309 B），没有任何动态 chunk。
- **影响**：每次启动 WebView2 都要解析这 848KB（Tauri 从本地磁盘加载，没有 HTTP gzip），其中 markdown 预览相关的两个库只在「点开 MD/HTML 预览」时才用得上；`App.tsx` 7384 行本身也让首屏 JS 无法被裁剪。
- **建议修法**：把 `MarkdownIt` / `DOMPurify` 改成首次预览时 `await import(...)`（预览路径已经是异步的）；可选在 `vite.config.ts` 里加 `manualChunks` 拆 vendor（对 Tauri 本地加载收益有限，优先级低于动态 import）。
- **置信度**：**中**（事实清楚，收益幅度需实测一次构建对比）
- **修复代价**：**S**

### PP-16（P3）每个 release 上传 4 个产物 ≈ 53.3MB，用户选择困难

- **位置**：`scripts/publish-release.ps1:43-48`（assets 列表：NSIS + MSI + 便携 zip + 裸 exe）；`docs/release-notes-v0.1.7.md:103-108`（4 行表格）
- **证据**：实测 9,153,474 + 14,077,952 + 13,479,574 + 16,630,272 = **53,341,272 B（53.3MB）/ release**。
- **影响**：仓库 Release 体积线性增长（0.1.0–0.1.7 已在本地留下 8 套）；用户面对 4 个下载项容易下错——而「用户拿到 MSI 却点了 NSIS 的一键升级」这类错配又被 `update_install_kind()`（`commands.rs:1777-1797`，靠安装路径猜）放大。
- **建议修法**：① 默认只发 `setup.exe` + 便携 zip，MSI 视企业需求单独发（或同一 release 但文档明确「普通用户不要下」）；② 收窄 `update_install_kind` 的猜测：除了路径，再读注册表（`Software\zeeai\ZeeAI_Term`，`main.wxs:61-64` 已经在用这个键）确认到底是哪种安装。
- **置信度**：**高**（数字实测）
- **修复代价**：**S**

### PP-17（P3）便携版打包没有脚本、靠手工；本地留了历史残留

- **位置**：`scripts/` 下只有 `publish-release.ps1`（没有便携版打包脚本）；`portable/` 下同时存在 `ZeeAI_Term/`（当前 0.1.7）与 **`ZeeAI-Terminal/`（旧名目录，含 15.9MB 的 `zeeai-terminal.exe`）**，以及 0.1.0–0.1.7 的 9 个历史 zip；仓库根目录还有 47KB 的 `layout-preview.html`
- **影响**：便携版打包含「复制 exe → 复制 resources → 复制 README → 压缩 → 核对 sha256」多个手工步骤（`publish-release.ps1:51` 只能事后发现产物缺失，且提示语就是「先跑…和便携版打包」），漏一步就会发出坏包；本地磁盘也会越攒越多（`.gitignore` 已忽略，所以不会污染仓库）。
- **建议修法**：新增 `scripts/build-portable.ps1`（固定三步 + 打印 sha256 + 可选 `-Clean` 清掉历史目录），并在 `publish-release.ps1` 里显式调用它；顺手删掉 `portable/ZeeAI-Terminal/` 与旧 zip。
- **置信度**：**高**
- **修复代价**：**S**

### PP-18（P3）图标资源里带着 macOS / Store 专用文件

- **位置**：`src-tauri/icons/icon.icns`（277,003 B）、`Square310x310Logo.png` 等 8 个 `Square*` 文件（合计约 60KB）；引用处 `src-tauri/tauri.conf.json:33-39`
- **影响**：仓库体积无意义膨胀（Windows-only 产品，`.icns` 只在 macOS 打包时用到；`Square*Logo` 只在 MSIX/Store 场景用到）。当前 `bundle.icon` 列表里也确实引用了 `icons/icon.icns`。
- **建议修法**：删掉 `icon.icns` 与 `Square*`，同步精简 `tauri.conf.json:33-39` 的 icon 数组（保留 `icon.ico` + 三个 png）。
- **置信度**：**高**
- **修复代价**：**S**

### PP-19（P3）配置文件写入不是原子的：半截 JSON 会导致设置静默回落默认值

- **位置**：`src-tauri/src/store.rs:148-152`（`workspace`）、`:297-302`（`settings`）、`:481-486`（`profiles`）都是直接 `fs::write`；解析失败时的回落：`:265-269`（`load_settings` → `unwrap_or_default()`）、`src-tauri/src/lib.rs:60`（`store::load().unwrap_or_default()`）
- **证据**：

```rust
// store.rs:297-302
pub fn save_settings(settings: &Settings) -> Result<(), String> {
    let dir = store_dir();
    fs::create_dir_all(&dir)...;
    let text = serde_json::to_string_pretty(settings)...;
    fs::write(settings_file(), text)...      // <-- 直接覆盖，没有 tmp+rename
}
```
  读的时候已经有 BOM 容错（`138-141`，注释里也承认过「设置/服务器列表被悄悄重置成默认值」的历史故障），但**写**这一步仍然可能产出半截文件：升级脚本会在 App 退出后立刻覆盖安装（`commands.rs:2152`：超时后 `taskkill /F`），一旦撞上写盘窗口，下一次启动就会 `unwrap_or_default()` 静默回落默认。
- **影响**：`profiles.json` 被写坏 → 用户「服务器列表突然空了」（历史故障的同一类），`settings.json` 被写坏 → 主题/高亮规则/更新源全部回到默认，而且**没有任何提示**。
- **建议修法**：三个 `save*` 统一改成「写 `xxx.json.tmp` → `fs::rename` 覆盖」（同目录 rename 在 NTFS 上原子）；`load*` 解析失败时把坏文件另存为 `.bak-<时间戳>` 并写日志，而不是静默回落默认。
- **置信度**：**中高**（代码事实确凿；触发概率取决于时序，标 **待确认**）
- **修复代价**：**S**

### PP-20（P3）架构与可测性：单文件 7384 行 / 2304 行 73 个命令 / 前端零测试 / 无 CI

- **位置**：`src/App.tsx`（7384 行，几乎整个应用）、`src-tauri/src/commands.rs`（2304 行，73 个 `#[tauri::command]`）；测试分布见「实测数据」表；无 `.github/`
- **影响**：① 每次 `setState` 都在 7384 行的组件里重跑 render（`App.tsx` 里 30+ 个 `useState` 全在同一层），大体量列表（服务器/会话/历史）也没有虚拟化；② 改一处功能要在 7384 行里找上下文，代码审查与并行开发的成本都高；③ 51 个 Rust 单测**集中在纯解析函数**（`parse_*` / `classify` / `filter`），而最贵的链路（升级、下载、PTY 生命周期、会话恢复）**几乎没有测试**；前端 0 测试。
- **建议修法**（都不改行为，可以分步做）：
  1. 后端把 `commands.rs` 按域拆成 `commands/{session,ssh,fs,serial,adb,git,ai,update,settings}.rs`，用 `pub use` 保持命令名不变 → 前端零改动；
  2. 前端把自成一体的对话框（设置 / 服务器管理 / 终端配色 / 高亮 / 预览 / Git / ADB / 串口）搬出 `App.tsx`，每个组件自带自己的 state（这一步能顺带砍掉大量无谓重渲染）；
  3. 把 `lib.rs:46-140` 已有的 `ZEEAI_SELFTEST` / `ZEEAI_AUTODEMO` 固化成 `scripts/smoke.ps1`；给 `update` 链路补「生成的脚本断言」（例如「MSI 分支必须含 AUTOLAUNCHAPP=1」「成功后必须删包」——正好给 PP-01/02/03 加回归网）；
  4. 前端至少给纯函数补测（`highlight.ts` 513 行、版本比较 `compareVersion`）。
- **置信度**：**高**
- **修复代价**：**M**（拆分本身机械且低风险，但改动面大，建议单独排一次）

---

## 差分更新 FAQ

> 用户问过：「为什么下载的时候不能直接下载差分包，而必须重新下载安装器？」下面是带数据的结论，非专家也看得懂。

**结论：对当前这套「NSIS/MSI 整包覆盖」的更新方式，做差分包收益小、风险大，不该做；真正该省的是「包里那 17.6MB 的 platform-tools」。**

**为什么收益小？**

- 我们的安装包是 **NSIS + LZMA solid 压缩**：9.15MB 的包里装着约 **34MB 载荷**（app exe 16.63MB + platform-tools 17.63MB）。
- solid 压缩流是**一整条**：前面改一个字节，后面所有字节的压缩结果都会位移——两份安装包做二进制 diff 时，能对上的字节非常少，「差分」省下来的量远小于直觉。
- 交叉验证：同一份内容用较弱的 Deflate 压是 13.48MB，用 LZMA 的 NSIS 只有 9.15MB（比值 0.68）。也就是说这 9MB 里几乎没有「还能再压出来的冗余」；而差分能利用的只是「这次改了多少代码」，我们的 app exe 每次发版都会整体重链，变化面本来就大。
- 顺带说明：**Tauri 官方 updater 也是整包下载 + 签名校验**，并没有做二进制差分。官方 updater 解决的是「签名校验 / 静默安装 / 装完自动重启」，不是「省流量」——这也是下面第 4 条建议的由来。

**为什么风险大？**

- 差分包必须「某个确定旧版本 → 新版本」**一一配对**：发 v0.1.8 时，要为所有在用旧版本（0.1.0…0.1.7）各出一份补丁，产物数线性增长，还得在 CI 里对每个配对跑一次「装旧版 → 打补丁 → 校验」。
- 打补丁要求本机旧文件**逐字节干净且版本精确匹配**：用户装过开发版、杀软改过文件、上次升级中断、便携版被解压两次，都会产出**错误的二进制，而且是静默的**——这与用户反复强调的「**不要下错**」直接冲突。

**那想省流量该按什么顺序做？**（按性价比排序）

1. **platform-tools 改按需下载**（`docs/decisions.md:921` 也是同一结论）：实测边际成本 **8.04MB**（便携版 zip 13.48MB → 5.43MB），按 LZMA 比例估算 NSIS 9.15MB → 约 **3.5–4MB**。而且如 PP-11 所示，其中 ≥5.2MB 是代码里从不使用的二进制，先删这部分是零风险。
2. **修掉「重试必然从 0 重下」**（PP-07）：`-C -` + 不删 `.part`，弱网下实际流量能降一个数量级（最坏情况从约 110MB 降到 9MB 量级）。
3. **少发一个产物**（PP-16）：MSI 只在企业部署时需要，单这一项就是每个 release 少 14MB 上传、用户少一个坑。
4. **最后才考虑 zstd 差分包**（独立特性、单独排期）：它需要配套的产物矩阵、补丁校验、失败回滚设计，属于「有闲工夫再做的事」。

补充：如果愿意换掉自研链路，**Tauri 官方 updater** 是「不那么容易踩坑」的替代方案（它自带签名校验、装完自动拉起应用，NSIS/MSI 都覆盖）。本次发现的 PP-01（脚本被 Job 杀）、PP-02（MSI 不重启）、PP-08（校验依据来自前端）恰好都是「自己造轮子」造出来的坑。是否换，属于产品取舍，建议单独评估（代价 M，需要迁移签名密钥与 CI）。

---

## 建议改造顺序（Top 5）

1. **PP-01｜先让一键升级真的能装上（P0）** —— 删掉对升级脚本的 `job::assign`（或让它 breakaway）。这是「用户点一次就必然失败」的级别，且改动一行。改完**必须真机点一次一键升级**验证（同时能顺带验证 PP-02/PP-03 的修法）。
2. **PP-02 + PP-03｜同一函数里的两处收尾（P1）** —— MSI 加 `AUTOLAUNCHAPP=1`；成功路径也删包。两处都在 `apply_update_script` / `update_download_install` 附近，一起改、一起测，代价 S。
3. **PP-07 + PP-04 + PP-05｜把「省钱又省心」的三处流量/频率问题一起做** —— 升级下载加 `-C -` 且不再删 `.part`；AI 探针改增量读（不再每次 400KB）；把快照/看板/tmux 三路探针合并成一条 ssh 或拉长间隔。这三项都会立刻降低「弱网失败率 + 服务器连接压力 + 笔记本耗电」。
4. **PP-08｜把校验依据收回后端（P2，安全）** —— 后端自己取 Release 的 `digest/size`，`sha256` 变成必填，白名单锁死 `owner/repo`。配合可选的 CSP，把「下载并执行任意安装包」这条路堵上。
5. **PP-11 + PP-10｜体积两刀（P2，收益最大且风险最低）** —— 先删 platform-tools 里 5.2MB 无用二进制（并实测 adb/fastboot 回归），再补 `[profile.release]`（lto/strip/codegen-units/panic=abort）。两项都不碰业务逻辑，做完用一次 `npm run tauri build` 出真实收益数字；中期目标是把 platform-tools 改成按需下载，NSIS 有望从 9.15MB 降到 3.5–4MB 量级。

（PP-04/PP-06/PP-13/PP-14/PP-15/PP-16/PP-17/PP-18 都属于「顺手就能做、做了就少一类麻烦」，建议按发布节奏穿插，无需专门排期；PP-19/PP-20 属于结构性改造，建议单独排一次。）

---

## 已排查且认为没问题的点（避免重复怀疑）

- **curl 的三个「0.1.5 教训」修得对**：`--connect-timeout 15` + `--speed-limit 2048/--speed-time 60` + `--max-time 3600`（`commands.rs:2014-2021`）能防「僵尸 curl 挂死」；stderr 写文件而不是管道（`2030`）避免管道写满互锁；`job::assign(child.id())`（`2044`）让 curl 随 App 退出被收掉——**curl 挂 Job 是对的，问题只在把升级脚本也挂了进去（PP-01）**。
- **校验顺序合理**：大小 → 文件头 → sha256（`2092-2121`），且「全过才把 `.part` 原子改名」（`1873-1879`），`.part` 命名让「没校验完的包永远不算下好」这个设计是对的。
- **升级脚本的两个补强是真的**：等待有上限（最多 2 分钟，超时 `taskkill /F`，`2150-2160`）+ 检查安装器退出码（`2163-2169`）+ 失败时丢掉坏包并拉回旧版（`2167-2169`），逻辑本身没问题（只是执行不到，见 PP-01）。
- **NSIS `/S /R` 会自动拉起应用**：生成的 `installer.nsi:728-736` 里 `.onInstSuccess` + `${Silent}` 分支确实 `RunAsUser` 拉起 exe，与 `decisions.md:906` 自述一致。
- **代理处理**：先读系统代理试一次、第二次改直连（`1855-1860`）这个「代理开着但没启动」的兜底是合理的；`system_proxy` 对 `http=...;https=...` 分协议写法也有处理（`1913-1926`）。
- **`find_curl()` 的兜底**：找不到 System32 的 curl 时回落到 PATH 里的 `curl.exe`（`1958-1966`）——但因此 `1841-1843` 那句「找不到系统自带的 curl.exe」的错误提示实际上永远不会触发（属于非致命的文案瑕疵）。
- **`update_install_kind()` 的路径判断在当前默认安装方式下是对的**：NSIS 默认 perUser（生成的 `installer.nsi:100-105` 的 `RequestExecutionLevel` 分支），装到 `%LOCALAPPDATA%\ZeeAI_Term\`；MSI 是 perMachine（`main.wxs:28`），装到 `Program Files\ZeeAI_Term\`，两者都能被 `1782-1795` 正确识别（只有用户手工改安装目录时才可能误判，见 PP-16）。
- **前端轮询的定时器都正确清理**：`App.tsx:884/1183-1184/1204-1205/3143` 都有对应的 `clearInterval`，没有明显的定时器泄漏。
- **`dist` 没有 sourcemap**（`vite.config.ts:15`），`target: chrome110`（`:14`）与 WebView2 匹配——这两项是对的。
- **资源路径解析与便携版布局一致**：`adb_exe` 找 `resource_dir()/resources/platform-tools/adb.exe`（`commands.rs:824-835`），与 `tauri.conf.json:31` 的 `resources/platform-tools/*` 及便携版目录结构都对得上。
- **`ai_sessions::local_snapshot` 的目录遍历不慢**：`newest_rollout`（`557-590`）限深 3 层，本机 10 个文件 / 125.6MB 实测只用 **13ms**（真正的问题是固定 400KB 尾部窗口，见 PP-04）。
- **构建产物没有污染仓库**：`.gitignore` 覆盖了 `node_modules/`、`src-tauri/target/`、`dist/`、`portable/*.zip`、`portable/ZeeAI_Term/`；`git status` 干净。`layout-preview.html` 是 README 明确引用的设计稿（`README.md:131`），不算垃圾。

---

## 待确认清单（我没有条件在本轮验证的）

1. **端到端一键升级**：PP-01 的结论基于 Windows 语义实测 + 代码路径，没有真的对一次 Release 点「一键升级」（需要真实 Release 产物与网络）。**建议发版前让机器上留着 0.1.6 的安装版用户实际点一次**，观察：`%TEMP%\ZeeAI-Term-update\apply_update.log` 是否被写出、版本号是否真的变了。
2. **MSI 升级后的自动重启**：`AUTOLAUNCHAPP` 的默认行为建议用一次真实 MSI 升级复核（`/qb` 下 ExitDialog 不出现是确定的，`InstallFinalize` 之后的那个 Custom Action 需要属性为真）。
3. **platform-tools 删减后的回归**：删掉 `sqlite3/mke2fs/make_f2fs/etc1tool/hprof-conv/libwinpthread` 后，需实测 `adb devices`、`adb shell`、`adb logcat`、设备文件管理、`fastboot devices` 全部正常（本轮只读，未删任何文件）。
4. **`[profile.release]` 的实际收益**：需要跑一次 `npm run tauri build` 才能给出「exe/NSIS 各降多少 MB」的真实数字。
5. **PP-04 的超窗概率**：目前手上只有 1 个 >400KB 余量的真实样本（293KB），需要多采集几条长会话的「最后一次 `task_complete` 距文件尾」分布，才能说清漏报比例。
6. **PP-08 的可利用性**：需要确认渲染层是否存在注入面（`csp: null` + 预览 HTML 沙箱边界），才能把「理论通路」升级为「可复现漏洞」。
7. **PP-12 的 WebView2 实际行为**：需要在一台没有 WebView2 Runtime 的机器（或断网环境）上装一次 MSI 才能确认是「联网下载」还是「已内嵌」。
