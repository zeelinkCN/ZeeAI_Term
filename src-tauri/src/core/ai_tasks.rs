//! AI 任务看板（v1）：把「哪些 AI 命令行工具正在跑」汇总成一张张卡片。
//!
//! 信号源按可靠度分层（越靠前越准）：
//! 1. **App 自己启动的** —— 用户在 AI 面板点「在终端启动」时记一笔（`AiTaskRegistry`），
//!    开始时间、跑完没跑完都由 App 自己判断，最精确；
//! 2. **远端 tmux** —— `tmux list-panes -a` 拿到每个 pane 的 pid，再看进程树
//!    能精确到「哪个会话的哪个窗格」；
//! 3. **远端普通 shell / WSL** —— `ps` 扫一遍进程表（只能给到「这台机器上有」）；
//! 4. **本机 PowerShell** —— `Get-CimInstance Win32_Process` 读 CommandLine。
//!
//! 必须避开的坑（写在这里免得以后又踩）：
//! - **WSL 里的进程从 Windows 侧看不见**（只能看到 wslhost/vmmem），所以 WSL 环境必须
//!   进 WSL 里跑 `ps`；
//! - **CMD 没有脚本钩子**，本阶段就标成「仅状态」，不为它投入；
//! - **TUI（codex/claude）没有进度百分比**，所以卡片上不做进度条；
//! - 判定**只按可执行文件路径/参数**，不看输出文本 —— 否则日志里出现 "claude" 字样就误报；
//! - Windows 全进程表扫描偏重，前端只在真有本机会话时才调，而且 15~30 秒才一次。

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// 我们认得的 AI 命令行工具（和 core::ai::TOOLS 保持一致）
pub const TOOLS: [&str; 4] = ["codex", "claude", "aider", "gemini"];

/// 会"替别人跑程序"的解释器/启动器：它们的第一个脚本参数才可能是 AI 工具。
const LAUNCHERS: [&str; 14] = [
    "node", "nodejs", "bun", "deno", "python", "python3", "npm", "npx", "pnpm", "yarn", "env",
    "sudo", "sh", "bash",
];

/// 看板上的一张卡片
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiTask {
    pub id: String,
    /// local（本机）/ remote（服务器）/ wsl
    pub env: String,
    /// 环境名：远端是服务器名，本地是「本机 PowerShell」这类
    pub server: String,
    /// codex / claude / aider / gemini
    pub tool: String,
    /// 命令行（过长会截断）
    pub command: String,
    /// tmux 窗格标签（形如 main:0.1）；不是 tmux 会话就是空串
    pub pane: String,
    /// app（App 自己启动的）/ tmux / ps / winproc
    pub source: String,
    /// running / done
    pub state: String,
    /// 已运行（运行中）或总共运行（已结束）的毫秒数
    pub duration_ms: i64,
    pub pid: u32,
    /// 开始时间（Unix 秒）；只有 App 自己启动的那批是精确的
    pub started_at: Option<i64>,
    /// 退出码：v1 拿不到（没有 shell 集成），一律 null
    pub exit_code: Option<i32>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RawProc {
    pub pid: u32,
    pub ppid: u32,
    /// 已经跑了多少秒（拿不到就是 None）
    pub etimes: Option<i64>,
    pub args: String,
}

// ---------- 远端采集 ----------

/// 远端采集脚本：先列 tmux 窗格，再扫进程表。
///
/// 输出全是 ASCII、一行一条，解析放在 Rust 里做（好写好测）：
/// ```text
/// ZZBEGIN
/// ZPANE|<pane_pid>|<会话:窗口.窗格>
/// ZPS1                       ← ps 支持 etimes
/// <pid> <ppid> <etimes> <命令行...>
/// ZZEND
/// ```
pub fn remote_script() -> String {
    "printf 'ZZBEGIN\\n'; \
if command -v tmux >/dev/null 2>&1; then \
tmux list-panes -a -F 'ZPANE|#{pane_pid}|#{session_name}:#{window_index}.#{pane_index}' 2>/dev/null; \
fi; \
if ps -eo pid=,ppid=,etimes=,args= >/dev/null 2>&1; then printf 'ZPS1\\n'; \
ps -eo pid=,ppid=,etimes=,args= 2>/dev/null; \
else printf 'ZPS0\\n'; ps -eo pid=,ppid=,args= 2>/dev/null; fi; \
printf 'ZZEND\\n'"
        .to_string()
}

/// 解析远端脚本的输出，返回（进程表, pane pid → 窗格标签）
pub fn parse_remote(output: &str) -> (Vec<RawProc>, HashMap<u32, String>) {
    let mut procs = Vec::new();
    let mut panes = HashMap::new();
    // 0 = 还没进进程区；1 = 有 etimes；2 = 没有 etimes（ps -o ...args= 的退化形式）
    let mut mode = 0u8;
    for line in output.lines() {
        let line = line.trim_end_matches('\r');
        if line == "ZZEND" {
            mode = 0;
            continue;
        }
        if line == "ZPS1" {
            mode = 1;
            continue;
        }
        if line == "ZPS0" {
            mode = 2;
            continue;
        }
        if let Some(rest) = line.strip_prefix("ZPANE|") {
            let mut it = rest.splitn(2, '|');
            let pid = it.next().and_then(|v| v.trim().parse::<u32>().ok());
            let label = it.next().unwrap_or("").trim().to_string();
            if let (Some(pid), false) = (pid, label.is_empty()) {
                panes.insert(pid, label);
            }
            continue;
        }
        if mode == 0 || line.trim().is_empty() {
            continue;
        }
        if let Some(p) = parse_ps_line(line, mode == 1) {
            procs.push(p);
        }
    }
    (procs, panes)
}

fn parse_ps_line(line: &str, with_etimes: bool) -> Option<RawProc> {
    let (pid_s, rest) = take_token(line);
    let (ppid_s, rest) = take_token(rest);
    let pid = pid_s?.parse::<u32>().ok()?;
    let ppid = ppid_s?.parse::<u32>().unwrap_or(0);
    if with_etimes {
        let (et_s, rest) = take_token(rest);
        Some(RawProc {
            pid,
            ppid,
            etimes: et_s.and_then(|v| v.parse::<i64>().ok()),
            args: rest.trim().to_string(),
        })
    } else {
        Some(RawProc {
            pid,
            ppid,
            etimes: None,
            args: rest.trim().to_string(),
        })
    }
}

/// 从字符串开头取一个空白分隔的字段，返回（字段, 剩下的部分）
fn take_token(s: &str) -> (Option<&str>, &str) {
    let t = s.trim_start();
    if t.is_empty() {
        return (None, "");
    }
    match t.find(char::is_whitespace) {
        Some(i) => (Some(&t[..i]), &t[i..]),
        None => (Some(t), ""),
    }
}

// ---------- 本机（Windows）采集 ----------

/// PowerShell 采集脚本：输出 `ZPROC|pid|ppid|已跑秒数|命令行`。
///
/// 用系统自带的 `Get-CimInstance`（不引任何库）。**全进程表扫描偏重**，
/// 所以前端只在真有本机会话的时候、15~30 秒一次地调它。
pub fn windows_script() -> String {
    "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; \
$OutputEncoding=[System.Text.Encoding]::UTF8; \
$ErrorActionPreference='SilentlyContinue'; \
$now=Get-Date; \
Get-CimInstance Win32_Process | ForEach-Object { \
$et=''; if ($_.CreationDate) { $d=($now - $_.CreationDate).TotalSeconds; if ($d -ge 0) { $et=[int]$d } }; \
'ZPROC|' + $_.ProcessId + '|' + $_.ParentProcessId + '|' + $et + '|' + $_.CommandLine }"
        .to_string()
}

/// 解析 PowerShell 采集脚本的输出
pub fn parse_windows(output: &str) -> Vec<RawProc> {
    let mut out = Vec::new();
    for line in output.lines() {
        let line = line.trim_end_matches(['\r', '\n']);
        let Some(rest) = line.strip_prefix("ZPROC|") else {
            continue;
        };
        let parts: Vec<&str> = rest.splitn(4, '|').collect();
        if parts.len() < 4 {
            continue;
        }
        let (Ok(pid), Ok(ppid)) = (parts[0].trim().parse::<u32>(), parts[1].trim().parse::<u32>())
        else {
            continue;
        };
        out.push(RawProc {
            pid,
            ppid,
            etimes: parts[2].trim().parse::<i64>().ok(),
            args: parts[3].trim().to_string(),
        });
    }
    out
}

// ---------- 认工具 ----------

fn base_name(s: &str) -> String {
    let cleaned = s.trim().trim_matches('"');
    let base = cleaned.rsplit(['/', '\\']).next().unwrap_or(cleaned);
    // 内核线程显示成 [kworker/0:1] 这种样子，去掉装饰字符
    let base = base
        .trim_matches(|c| c == '[' || c == ']')
        .trim_end_matches(':');
    // Windows 上可执行文件带扩展名（codex.cmd / node.exe），统一剥掉再认
    let lower = base.to_ascii_lowercase();
    for ext in [".exe", ".cmd", ".bat", ".ps1", ".js", ".mjs", ".cjs", ".py"] {
        if lower.ends_with(ext) && base.len() > ext.len() {
            return base[..base.len() - ext.len()].to_string();
        }
    }
    base.to_string()
}

fn known(name: &str) -> Option<String> {
    let lower = name.to_ascii_lowercase();
    TOOLS.iter().find(|t| **t == lower).map(|t| t.to_string())
}

/// 从一条命令行里认出 AI 工具。
///
/// **只看可执行文件名和解释器的脚本参数**，不看别的参数内容 —— 否则
/// `vim ~/claude.log`、`grep claude`、日志文本里出现 claude 都会误报。
pub fn tool_of(args: &str) -> Option<String> {
    let tokens: Vec<&str> = args.split_whitespace().collect();
    let first = tokens.first()?;
    let base = base_name(first);
    if let Some(t) = known(&base) {
        return Some(t);
    }
    if LAUNCHERS.contains(&base.to_ascii_lowercase().as_str()) {
        // node /usr/local/bin/codex、python3 -m aider、npx @openai/codex …
        for tok in tokens.iter().skip(1).take(2) {
            if *tok == "-m" {
                continue;
            }
            if let Some(t) = known(&base_name(tok)) {
                return Some(t);
            }
        }
    }
    None
}

/// 一条进程属于哪个 tmux 窗格（跟着 ppid 往上找 pane 的根进程）
fn pane_of(pid: u32, panes: &HashMap<u32, String>, ppid_of: &HashMap<u32, u32>) -> String {
    let mut cur = pid;
    for _ in 0..8 {
        if let Some(label) = panes.get(&cur) {
            return label.clone();
        }
        match ppid_of.get(&cur) {
            Some(next) if *next != 0 && *next != cur => cur = *next,
            _ => break,
        }
    }
    String::new()
}

fn is_ancestor(maybe_ancestor: u32, of: u32, ppid_of: &HashMap<u32, u32>) -> bool {
    let mut cur = of;
    for _ in 0..16 {
        match ppid_of.get(&cur) {
            Some(next) if *next != 0 && *next != cur => {
                if *next == maybe_ancestor {
                    return true;
                }
                cur = *next;
            }
            _ => return false,
        }
    }
    false
}

/// 把进程表变成卡片：认工具 → 找 tmux 窗格 → 去掉同一工具的父子重复
pub fn classify(procs: &[RawProc], panes: &HashMap<u32, String>, env: &str, server: &str) -> Vec<AiTask> {
    let ppid_of: HashMap<u32, u32> = procs.iter().map(|p| (p.pid, p.ppid)).collect();
    let mut out: Vec<AiTask> = Vec::new();
    for p in procs {
        let Some(tool) = tool_of(&p.args) else {
            continue;
        };
        let pane = pane_of(p.pid, panes, &ppid_of);
        out.push(AiTask {
            id: format!("{env}:{server}:{}:{tool}", p.pid),
            env: env.to_string(),
            server: server.to_string(),
            tool,
            command: tidy(&p.args, 300),
            pane,
            source: String::new(), // 下面按 pane 是否找到来定
            state: "running".to_string(),
            duration_ms: p.etimes.unwrap_or(0).max(0) * 1000,
            pid: p.pid,
            started_at: None,
            exit_code: None,
        });
    }
    // 同一个工具、同一个窗格里，如果一个是另一个的父进程（npx → codex 这种），
    // 只留真正在跑的那个（里面的那个）。
    for i in 0..out.len() {
        for j in 0..out.len() {
            if i == j {
                continue;
            }
            if out[i].tool != out[j].tool || out[i].pane != out[j].pane {
                continue;
            }
            if is_ancestor(out[i].pid, out[j].pid, &ppid_of) {
                out[i].pid = 0; // 标掉，下面统一清
                break;
            }
        }
    }
    out.retain(|t| t.pid != 0);
    // 同一个 pane 里同一种工具只留一条；没有 pane 信息时（普通 ps 扫描）不过滤，
    // 免得把服务器上不同用户各开的 codex 合成一条。
    let mut seen = HashSet::new();
    out.retain(|t| t.pane.is_empty() || seen.insert(t.pane.clone()));
    for t in out.iter_mut() {
        t.source = if t.pane.is_empty() { "ps" } else { "tmux" }.to_string();
    }
    sort_tasks(&mut out);
    out
}

/// 命令行太长就截断，顺便把控制字符（换行、制表）压成空格，免得把界面撑坏
fn tidy(s: &str, max: usize) -> String {
    let cleaned: String = s
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let one_line = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    if one_line.chars().count() <= max {
        return one_line;
    }
    let mut cut: String = one_line.chars().take(max).collect();
    cut.push('…');
    cut
}

fn sort_tasks(list: &mut [AiTask]) {
    list.sort_by(|a, b| {
        let run = (b.state == "running").cmp(&(a.state == "running"));
        run.then(b.duration_ms.cmp(&a.duration_ms))
            .then(a.tool.cmp(&b.tool))
    });
}

// ---------- 「App 自己启动的」那批 ----------

/// App 自己启动的一个 AI 任务（用户点了「在终端启动」）
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppTask {
    pub id: String,
    pub env: String,
    pub server: String,
    pub tool: String,
    pub command: String,
    pub started_at: i64,
    /// 最后一次"探到它还在跑"的时间 —— 用来算已结束任务的耗时
    pub last_running_at: i64,
    pub running: bool,
}

#[derive(Default)]
pub struct AiTaskRegistry {
    items: Mutex<Vec<AppTask>>,
}

impl AiTaskRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// 记一笔「我刚刚在某个会话里启动了某个 AI」
    pub fn note_start(&self, env: &str, server: &str, tool: &str, command: &str, now: i64) -> AiTask {
        let id = format!("app:{env}:{server}:{tool}:{now}");
        if let Ok(mut items) = self.items.lock() {
            items.push(AppTask {
                id: id.clone(),
                env: env.to_string(),
                server: server.to_string(),
                tool: tool.to_string(),
                command: tidy(command, 300),
                started_at: now,
                last_running_at: now,
                running: true,
            });
            // 上限护一下，别让长跑的应用越攒越多
            if items.len() > 60 {
                let extra = items.len() - 60;
                items.drain(0..extra);
            }
        }
        AiTask {
            id,
            env: env.to_string(),
            server: server.to_string(),
            tool: tool.to_string(),
            command: tidy(command, 300),
            pane: String::new(),
            source: "app".to_string(),
            state: "running".to_string(),
            duration_ms: 0,
            pid: 0,
            started_at: Some(now),
            exit_code: None,
        }
    }

    /// 把「App 自己启动的」和「探测到的」合成一份看板数据。
    ///
    /// `detected` 为 None 表示这次没探成功（比如 SSH 断了）—— 这时候**不能**
    /// 把 App 任务判成已结束，保持上次的状态就好。
    pub fn merge(
        &self,
        env: &str,
        server: &str,
        detected: Option<Vec<AiTask>>,
        now: i64,
    ) -> Vec<AiTask> {
        let mut detected = detected;
        let mut out: Vec<AiTask> = Vec::new();
        let Ok(mut items) = self.items.lock() else {
            return detected.unwrap_or_default();
        };
        for t in items.iter_mut().filter(|t| t.env == env && t.server == server) {
            let probe_ok = detected.is_some();
            let hit = detected.as_mut().and_then(|list| {
                list.iter()
                    .position(|d| d.tool.eq_ignore_ascii_case(&t.tool))
                    .map(|pos| list.remove(pos))
            });
            match hit {
                Some(mut d) => {
                    t.running = true;
                    t.last_running_at = now;
                    d.id = t.id.clone();
                    d.source = "app".to_string();
                    d.started_at = Some(t.started_at);
                    d.duration_ms = (now - t.started_at).max(0) * 1000;
                    out.push(d);
                }
                None => {
                    if probe_ok {
                        t.running = false;
                    }
                    let end = if t.running {
                        now
                    } else {
                        t.last_running_at.max(t.started_at)
                    };
                    out.push(AiTask {
                        id: t.id.clone(),
                        env: t.env.clone(),
                        server: t.server.clone(),
                        tool: t.tool.clone(),
                        command: t.command.clone(),
                        pane: String::new(),
                        source: "app".to_string(),
                        state: if t.running { "running" } else { "done" }.to_string(),
                        duration_ms: (end - t.started_at).max(0) * 1000,
                        pid: 0,
                        started_at: Some(t.started_at),
                        exit_code: None,
                    });
                }
            }
        }
        // 已经结束 6 小时以上的记录没什么用了，清掉
        let cutoff = now - 6 * 3600;
        items.retain(|t| {
            !(t.env == env && t.server == server && !t.running && t.last_running_at < cutoff)
        });
        drop(items);
        if let Some(mut list) = detected {
            out.append(&mut list);
        }
        sort_tasks(&mut out);
        out.truncate(40);
        out
    }

    /// 清掉某个环境里已结束的卡片
    pub fn clear_finished(&self, env: &str, server: &str) {
        if let Ok(mut items) = self.items.lock() {
            items.retain(|t| !(t.env == env && t.server == server && !t.running));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn proc(pid: u32, ppid: u32, etimes: i64, args: &str) -> RawProc {
        RawProc {
            pid,
            ppid,
            etimes: Some(etimes),
            args: args.to_string(),
        }
    }

    #[test]
    fn recognizes_tools_by_executable_not_by_output_text() {
        assert_eq!(tool_of("/usr/local/bin/codex --help"), Some("codex".into()));
        assert_eq!(tool_of("node /usr/local/bin/claude"), Some("claude".into()));
        assert_eq!(tool_of("python3 -m aider --model x"), Some("aider".into()));
        assert_eq!(
            tool_of("node /home/u/.npm/_npx/1/node_modules/.bin/gemini"),
            Some("gemini".into())
        );
        // 这些都不是"在跑 AI"：引用/查看/搜索都不算
        assert_eq!(tool_of("vim /home/u/claude.log"), None);
        assert_eq!(tool_of("grep -r claude /var/log"), None);
        assert_eq!(tool_of("tail -f codex.log"), None);
        assert_eq!(tool_of(""), None);
    }

    #[test]
    fn parses_remote_output_with_tmux_panes() {
        let out = "ZZBEGIN\n\
ZPANE|1000|main:0.1\n\
ZPS1\n\
  1000     1   900 -bash\n\
  1001  1000   120 node /usr/local/bin/codex\n\
  1002  1001    30 /usr/local/bin/codex\n\
ZZEND\n";
        let (procs, panes) = parse_remote(out);
        assert_eq!(procs.len(), 3);
        assert_eq!(panes.get(&1000).map(String::as_str), Some("main:0.1"));
        let tasks = classify(&procs, &panes, "remote", "测试机");
        assert_eq!(tasks.len(), 1, "父子重复应该只留一条");
        assert_eq!(tasks[0].tool, "codex");
        assert_eq!(tasks[0].pane, "main:0.1");
        assert_eq!(tasks[0].source, "tmux");
        assert_eq!(tasks[0].duration_ms, 30_000);
    }

    #[test]
    fn parses_remote_output_without_etimes() {
        let out = "ZZBEGIN\nZPS0\n  42  1  python3 -m aider\nZZEND\n";
        let (procs, panes) = parse_remote(out);
        assert_eq!(procs.len(), 1);
        assert_eq!(procs[0].etimes, None);
        let tasks = classify(&procs, &panes, "remote", "srv");
        assert_eq!(tasks[0].tool, "aider");
        assert_eq!(tasks[0].duration_ms, 0);
        assert_eq!(tasks[0].source, "ps");
    }

    #[test]
    fn parses_windows_proc_lines() {
        let out = "ZPROC|100|4|12|C:\\node.exe C:\\npm\\codex.cmd\r\n\
随便一句中文噪音\n\
ZPROC|200|4||python3 -m aider\n";
        let procs = parse_windows(out);
        assert_eq!(procs.len(), 2);
        assert_eq!(procs[0].etimes, Some(12));
        assert_eq!(procs[1].etimes, None);
        // Windows 自带工具跑起来的 AI（node.exe 里跑 codex.cmd）也要认得出来
        assert_eq!(tool_of(&procs[0].args), Some("codex".into()));
        assert_eq!(tool_of(&procs[1].args), Some("aider".into()));
    }

    #[test]
    fn app_tasks_win_over_detected_and_turn_done_when_process_gone() {
        let reg = AiTaskRegistry::new();
        reg.note_start("remote", "srv", "codex", "codex", 1000);

        // 探测到它还在跑：卡片用的是 App 记的开始时间，source = app
        let detected = vec![AiTask {
            id: "x".into(),
            env: "remote".into(),
            server: "srv".into(),
            tool: "codex".into(),
            command: "node /usr/local/bin/codex".into(),
            pane: "main:0.1".into(),
            source: "tmux".into(),
            state: "running".into(),
            duration_ms: 5_000,
            pid: 4242,
            started_at: None,
            exit_code: None,
        }];
        let list = reg.merge("remote", "srv", Some(detected), 1300);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].source, "app");
        assert_eq!(list[0].started_at, Some(1000));
        assert_eq!(list[0].duration_ms, 300_000);
        assert_eq!(list[0].state, "running");
        assert_eq!(list[0].pane, "main:0.1", "探测到的窗格信息要保留");

        // 进程没了：同一张卡片变成已结束，耗时停在最后一次看到它的时刻
        let list = reg.merge("remote", "srv", Some(Vec::new()), 1600);
        assert_eq!(list[0].state, "done");
        assert_eq!(list[0].duration_ms, 300_000);

        // 探测失败（None）：不能把还在跑的任务误判成结束
        let list = reg.merge("remote", "srv", None, 1900);
        assert_eq!(list[0].state, "done");
        reg.note_start("remote", "srv", "claude", "claude", 2000);
        let list = reg.merge("remote", "srv", None, 2100);
        let claude = list.iter().find(|t| t.tool == "claude").unwrap();
        assert_eq!(claude.state, "running");
    }

    #[test]
    fn keeps_detected_tasks_that_the_app_did_not_start() {
        let reg = AiTaskRegistry::new();
        let detected = vec![AiTask {
            id: "d1".into(),
            env: "local".into(),
            server: "本机 PowerShell".into(),
            tool: "claude".into(),
            command: "node claude".into(),
            pane: String::new(),
            source: "winproc".into(),
            state: "running".into(),
            duration_ms: 9_000,
            pid: 7,
            started_at: None,
            exit_code: None,
        }];
        let list = reg.merge("local", "本机 PowerShell", Some(detected), 500);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].source, "winproc");
        assert_eq!(list[0].duration_ms, 9000);
    }

    #[test]
    fn tidy_truncates_and_flattens() {
        assert_eq!(tidy("a\nb\tc", 100), "a b c");
        let long = tidy(&"x".repeat(400), 300);
        assert_eq!(long.chars().count(), 301);
    }
}
