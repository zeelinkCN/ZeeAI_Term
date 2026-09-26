//! 从 **Codex 的会话日志**（`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`）里读出
//! "这一轮跑完没、AI 最后说了什么、花了多少 token、现在在干什么"。
//!
//! 为什么走日志而不是猜：
//! - 进程在不在只能说明"跑着"，说明不了**有没有新消息 / 是不是在等你**；
//! - Codex 会把每个事件按行追加写进 rollout 文件，里面有现成的 `task_started` /
//!   `task_complete`（带 `last_agent_message`、`duration_ms`）/ `token_count`
//!   （带本轮与累计用量、上下文窗口）/ `function_call`（在跑哪条命令）；
//! - 这份文件在**远端机器上**，我们本来就用 ssh 跑命令，读它的尾巴就行，
//!   不需要 shell 集成、也不用改服务器上的任何配置。
//!
//! 解析上刻意做得"宽进"：事件名只做子串判定（例如 payload 类型里含
//! `approval_request` 就算"在等你批准"），因为日志格式会随版本演进，
//! 而我们只需要它别崩、别把明显不是的状态说成是。

use serde::Serialize;
use serde_json::Value;

/// 一次读取的日志尾巴上限（40 万字节，够覆盖最近几轮）
pub const TAIL_BYTES: u64 = 400_000;

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AiUsage {
    pub input: u64,
    pub cached_input: u64,
    pub output: u64,
    pub reasoning: u64,
    /// 累计总量（这一整个会话）
    pub total: u64,
    /// 最近一次请求的用量
    pub last_total: u64,
    /// 模型上下文窗口（用来算"用掉多少 %"）
    pub context_window: u64,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AiSessionSnapshot {
    pub session_id: String,
    /// 这个会话的工作目录（卡片上显示项目目录就用它）
    pub cwd: String,
    /// AI 在最近一轮结束时的最后一段话
    pub last_message: String,
    pub last_turn_duration_ms: i64,
    /// 最近一轮的结束时间（Unix 秒），用来算"多久之前跑完的"
    pub last_turn_completed_at: i64,
    pub usage: Option<AiUsage>,
    /// running / idle / needs-approval / waiting-user
    pub state: String,
    /// 一行人类可读的"现在在干什么"
    pub last_action: String,
    /// 这个会话的审批策略（never / on-request / untrusted…）
    pub approval_policy: String,
    /// 日志里最后一条事件的时间（Unix 秒）
    pub updated_at: i64,
    pub lines_seen: usize,
}

/// 日志里"最后发生了什么"的粗粒度分类，用来推状态
#[derive(Clone, Copy, PartialEq)]
enum Last {
    None,
    TaskStarted,
    TaskComplete,
    ToolCall,
    ToolDone,
    Reasoning,
    AssistantMessage,
    UserMessage,
    ApprovalRequest,
    UserInputRequest,
    ApprovalDone,
}

/// 解析 rollout 日志（可以是 tail 出来的片段，开头被截断也没关系）
pub fn parse_rollout(text: &str) -> AiSessionSnapshot {
    let mut snap = AiSessionSnapshot {
        state: "idle".into(),
        ..Default::default()
    };
    let mut last = Last::None;
    let mut turn_open = false;

    for line in text.lines() {
        let line = line.trim();
        // tail 出来的第一行通常是被截断的，跳过
        if !line.starts_with('{') {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        snap.lines_seen += 1;
        if let Some(ts) = v.get("timestamp").and_then(Value::as_str) {
            if let Some(secs) = parse_ts(ts) {
                snap.updated_at = secs;
            }
        }
        let kind = v.get("type").and_then(Value::as_str).unwrap_or("");
        let payload = v.get("payload").cloned().unwrap_or(Value::Null);

        match kind {
            "session_meta" => {
                if let Some(id) = payload.get("session_id").and_then(Value::as_str) {
                    snap.session_id = id.to_string();
                }
                if let Some(cwd) = payload.get("cwd").and_then(Value::as_str) {
                    snap.cwd = cwd.to_string();
                }
            }
            "turn_context" => {
                if let Some(cwd) = payload.get("cwd").and_then(Value::as_str) {
                    snap.cwd = cwd.to_string();
                }
                if let Some(p) = payload.get("approval_policy").and_then(Value::as_str) {
                    snap.approval_policy = p.to_string();
                }
            }
            "event_msg" => {
                let sub = payload.get("type").and_then(Value::as_str).unwrap_or("");
                parse_event(sub, &payload, &mut snap, &mut last, &mut turn_open);
            }
            "response_item" => {
                let sub = payload.get("type").and_then(Value::as_str).unwrap_or("");
                parse_item(sub, &payload, &mut snap, &mut last, &mut turn_open);
            }
            "token_usage_record" => {
                // 老一点/另一种写法：payload 直接带 usage
                if let Some(u) = payload.get("usage") {
                    apply_usage(&mut snap, u);
                }
            }
            _ => {}
        }
    }

    // 状态推断：先看"是不是在等我们"，再看"是不是在干活"
    snap.state = match last {
        Last::ApprovalRequest => "needs-approval",
        Last::UserInputRequest => "waiting-user",
        _ => {
            let busy = turn_open
                || matches!(last, Last::TaskStarted | Last::ToolCall | Last::Reasoning);
            if busy {
                "running"
            } else {
                "idle"
            }
        }
    }
    .to_string();
    if snap.last_action.is_empty() {
        snap.last_action = match snap.state.as_str() {
            "needs-approval" => "等你批准一个操作".into(),
            "waiting-user" => "等你回话".into(),
            "running" => "运行中".into(),
            _ => String::new(),
        };
    }
    snap
}

#[allow(clippy::too_many_arguments)]
fn parse_event(
    sub: &str,
    payload: &Value,
    snap: &mut AiSessionSnapshot,
    last: &mut Last,
    turn_open: &mut bool,
) {
    if sub.contains("approval_request") {
        *last = Last::ApprovalRequest;
        snap.last_action = describe_approval(sub, payload);
        return;
    }
    if sub == "request_user_input" || sub == "elicitation" {
        *last = Last::UserInputRequest;
        snap.last_action = "等你输入".into();
        return;
    }
    if sub.contains("approval") && (sub.contains("approved") || sub.contains("denied")) {
        *last = Last::ApprovalDone;
        return;
    }
    match sub {
        "task_started" => {
            *turn_open = true;
            *last = Last::TaskStarted;
            snap.last_action = "接到任务，开始跑".into();
        }
        "task_complete" => {
            *turn_open = false;
            *last = Last::TaskComplete;
            if let Some(at) = payload.get("completed_at").and_then(Value::as_i64) {
                snap.last_turn_completed_at = at;
            }
            snap.last_turn_duration_ms = payload
                .get("duration_ms")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            if let Some(msg) = payload.get("last_agent_message").and_then(Value::as_str) {
                if !msg.trim().is_empty() {
                    snap.last_message = msg.trim().to_string();
                }
            }
            snap.last_action = "这一轮跑完了".into();
        }
        "token_count" => {
            if let Some(info) = payload.get("info") {
                apply_usage(snap, info);
            }
        }
        _ => {}
    }
}

fn parse_item(
    sub: &str,
    payload: &Value,
    snap: &mut AiSessionSnapshot,
    last: &mut Last,
    turn_open: &mut bool,
) {
    match sub {
        "function_call" | "custom_tool_call" | "local_shell_call" | "web_search_call" => {
            *last = Last::ToolCall;
            snap.last_action = describe_call(sub, payload);
        }
        "function_call_output" | "custom_tool_call_output" => {
            *last = Last::ToolDone;
            if !*turn_open {
                snap.last_action = "工具跑完了".into();
            }
        }
        "reasoning" => {
            *last = Last::Reasoning;
            snap.last_action = "思考中".into();
        }
        "message" => {
            let role = payload.get("role").and_then(Value::as_str).unwrap_or("");
            let text = message_text(payload);
            match role {
                "assistant" => {
                    *last = Last::AssistantMessage;
                    if !text.is_empty() {
                        snap.last_message = text;
                        snap.last_action = "AI 回了一句，等你".into();
                    }
                }
                "user" => {
                    *last = Last::UserMessage;
                }
                _ => {}
            }
        }
        _ => {}
    }
}

/// 从 message 的 content 数组里拼出纯文本
fn message_text(payload: &Value) -> String {
    let mut out = String::new();
    if let Some(arr) = payload.get("content").and_then(Value::as_array) {
        for c in arr {
            if let Some(t) = c.get("text").and_then(Value::as_str) {
                if !out.is_empty() {
                    out.push('\n');
                }
                out.push_str(t);
            }
        }
    }
    out.trim().to_string()
}

/// 把一次工具调用写成人话（命令太长就截断）
fn describe_call(sub: &str, payload: &Value) -> String {
    let name = payload.get("name").and_then(Value::as_str).unwrap_or(sub);
    let args = payload.get("arguments").and_then(Value::as_str).unwrap_or("");
    // exec_command 的参数是 JSON 字符串，里面 cmd 才是真命令
    if let Ok(v) = serde_json::from_str::<Value>(args) {
        if let Some(cmd) = v.get("cmd").and_then(Value::as_str) {
            return format!("正在执行：{}", shorten(cmd, 90));
        }
        if let Some(path) = v.get("path").and_then(Value::as_str) {
            return format!("{name}：{}", shorten(path, 70));
        }
    }
    if args.is_empty() {
        format!("正在调用 {name}")
    } else {
        format!("正在调用 {name}：{}", shorten(args, 70))
    }
}

fn describe_approval(sub: &str, payload: &Value) -> String {
    // 不同版本字段名可能不一样，能拿到就用，拿不到给一句通用的
    for key in ["command", "cmd", "reason", "message", "path"] {
        if let Some(v) = payload.get(key).and_then(Value::as_str) {
            if !v.trim().is_empty() {
                return format!("等你批准：{}", shorten(v, 70));
            }
        }
    }
    if sub.contains("apply_patch") {
        "等你批准这次文件修改".into()
    } else {
        "等你批准一个操作".into()
    }
}

fn apply_usage(snap: &mut AiSessionSnapshot, info: &Value) {
    let total = info.get("total_token_usage").unwrap_or(&Value::Null);
    let last = info.get("last_token_usage").unwrap_or(&Value::Null);
    let u = AiUsage {
        input: num(total, "input_tokens"),
        cached_input: num(total, "cached_input_tokens"),
        output: num(total, "output_tokens"),
        reasoning: num(total, "reasoning_output_tokens"),
        total: num(total, "total_tokens"),
        last_total: num(last, "total_tokens"),
        context_window: info
            .get("model_context_window")
            .and_then(Value::as_u64)
            .unwrap_or(0),
    };
    if u.total > 0 || u.last_total > 0 {
        snap.usage = Some(u);
    }
}

fn num(v: &Value, key: &str) -> u64 {
    v.get(key).and_then(Value::as_u64).unwrap_or(0)
}

fn shorten(s: &str, max: usize) -> String {
    let one_line = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if one_line.chars().count() <= max {
        return one_line;
    }
    let mut out: String = one_line.chars().take(max).collect();
    out.push('…');
    out
}

/// 解析 ISO8601（`2026-09-26T10:46:31.038Z`）成 Unix 秒。
/// 只认这一种格式（Codex 就写这种），不引时间库。
pub fn parse_ts(s: &str) -> Option<i64> {
    let (date, rest) = s.split_once('T')?;
    let mut d = date.split('-');
    let (y, mo, da) = (
        d.next()?.parse::<i64>().ok()?,
        d.next()?.parse::<i64>().ok()?,
        d.next()?.parse::<i64>().ok()?,
    );
    let time: String = rest.chars().take_while(|c| c.is_ascii_digit() || *c == ':').collect();
    let mut t = time.split(':');
    let (h, mi) = (
        t.next()?.parse::<i64>().ok()?,
        t.next().unwrap_or("0").parse::<i64>().ok()?,
    );
    let sec = t.next().unwrap_or("0").parse::<i64>().unwrap_or(0);
    // days from civil (Howard Hinnant 的算法，标准写法)
    let y2 = if mo <= 2 { y - 1 } else { y };
    let era = if y2 >= 0 { y2 } else { y2 - 399 } / 400;
    let yoe = y2 - era * 400;
    let mp = (mo + 9) % 12;
    let doy = (153 * mp + 2) / 5 + da - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    Some(days * 86400 + h * 3600 + mi * 60 + sec)
}

/// 远端取"最新的那个 rollout 的尾巴"（一条命令搞定，输出前缀一行文件路径）
pub fn remote_tail_script() -> String {
    format!(
        "f=$(ls -t \"$HOME\"/.codex/sessions/*/*/*/rollout-*.jsonl 2>/dev/null | head -1); \
if [ -n \"$f\" ]; then printf 'ZFILE|%s\\n' \"$f\"; tail -c {TAIL_BYTES} \"$f\"; fi"
    )
}

/// 任务产物：某个文件是"这一轮跑完之后新出现/被改过"的
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AiArtifact {
    pub path: String,
    pub name: String,
    pub size: u64,
    /// 最后修改时间（Unix 秒）
    pub mtime: i64,
}

/// 找 cwd 下 `since` 之后被改过的文件（远端脚本：一行 `mtime|size|相对路径`）。
///
/// 为什么要"时间窗 + 目录"这套：AI 跑完不会告诉你它写了哪些文件（除非上 shell 集成），
/// 但把"这一轮的起止时间"和"会话的工作目录"一对上，答案基本就在那儿了。
/// 限制深度 3、排除 .git，取最近 12 个，避免在大仓库里扫爆。
pub fn remote_artifacts_script(cwd: &str, since: i64) -> String {
    let sq = cwd.replace('\'', "'\\''");
    format!(
        "cd '{sq}' 2>/dev/null || exit 0; \
since=$(date -d @{since} '+%Y-%m-%d %H:%M:%S' 2>/dev/null) || exit 0; \
find . -maxdepth 3 -type f -newermt \"$since\" -not -path './.git/*' -not -path './node_modules/*' \
-not -path './.codex/*' -not -name '*.sqlite*' -not -name '*.db' \
-printf '%T@|%s|%p\\n' 2>/dev/null | sort -rn | head -12"
    )
}

/// 解析 `mtime|size|路径` 形式的产物清单（路径里的 `|` 不影响，只切前两段）
pub fn parse_artifacts(out: &str) -> Vec<AiArtifact> {
    let mut list = Vec::new();
    for line in out.lines() {
        let line = line.trim_end_matches(['\r', '\n']);
        let mut it = line.splitn(3, '|');
        let (Some(ts), Some(size), Some(path)) = (it.next(), it.next(), it.next()) else {
            continue;
        };
        let Ok(mtime) = ts.trim().split('.').next().unwrap_or("").parse::<i64>() else {
            continue;
        };
        let size = size.trim().parse::<u64>().unwrap_or(0);
        let rel = path.trim().trim_start_matches("./");
        if rel.is_empty() {
            continue;
        }
        let name = rel.rsplit('/').next().unwrap_or(rel).to_string();
        list.push(AiArtifact {
            path: rel.to_string(),
            name,
            size,
            mtime,
        });
    }
    list
}

/// 本机版本：直接走文件系统（深度 3、排除 .git / node_modules、最多 12 个）
pub fn local_artifacts(cwd: &str, since: i64) -> Vec<AiArtifact> {
    fn walk(
        base: &std::path::Path,
        dir: &std::path::Path,
        since: i64,
        depth: u32,
        out: &mut Vec<AiArtifact>,
    ) {
        if depth > 3 || out.len() >= 12 {
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for e in entries.flatten() {
            let p = e.path();
            let name = e.file_name().to_string_lossy().to_string();
            // 明显的噪音目录（版本库、依赖、以及 Codex 自己的状态库）不进产物清单
            if name == ".git" || name == "node_modules" || name == ".codex" || name == "__pycache__" {
                continue;
            }
            if name.ends_with(".sqlite")
                || name.ends_with(".sqlite-wal")
                || name.ends_with(".sqlite-shm")
                || name.ends_with(".db")
            {
                continue;
            }
            if p.is_dir() {
                walk(base, &p, since, depth + 1, out);
                continue;
            }
            let Ok(md) = e.metadata() else { continue };
            let Ok(mt) = md.modified() else { continue };
            let Ok(dur) = mt.duration_since(std::time::UNIX_EPOCH) else {
                continue;
            };
            if (dur.as_secs() as i64) < since {
                continue;
            }
            let rel = p
                .strip_prefix(base)
                .map(|r| r.to_string_lossy().to_string())
                .unwrap_or_else(|_| p.to_string_lossy().to_string());
            out.push(AiArtifact {
                path: rel,
                name,
                size: md.len(),
                mtime: dur.as_secs() as i64,
            });
            if out.len() >= 12 {
                return;
            }
        }
    }
    let mut out = Vec::new();
    walk(std::path::Path::new(cwd), std::path::Path::new(cwd), since, 0, &mut out);
    out.sort_by(|a, b| b.mtime.cmp(&a.mtime));
    out
}

#[cfg(test)]
mod artifact_tests {
    use super::*;

    #[test]
    fn parses_find_output() {
        let out = "1758889100.123|4096|./report.md\n1758889000.000|128|docs/summary.md\n";
        let a = parse_artifacts(out);
        assert_eq!(a.len(), 2);
        assert_eq!(a[0].name, "report.md");
        assert_eq!(a[0].path, "report.md");
        assert_eq!(a[0].size, 4096);
        assert_eq!(a[0].mtime, 1758889100);
        assert_eq!(a[1].name, "summary.md");
        assert!(parse_artifacts("garbage\n\n").is_empty());
    }

    #[test]
    fn script_quotes_cwd_and_since() {
        let s = remote_artifacts_script("/home/lz/my proj", 1758889000);
        assert!(s.contains("cd '/home/lz/my proj'"));
        assert!(s.contains("date -d @1758889000"));
    }
}

/// 脚本输出（可能带一行 `ZFILE|路径` 前缀）→ 快照；没有会话就返回 None
pub fn parse_script_output(text: &str) -> Option<AiSessionSnapshot> {
    let mut body = String::new();
    for line in text.lines() {
        if line.starts_with("ZFILE|") {
            continue;
        }
        body.push_str(line);
        body.push('\n');
    }
    let snap = parse_rollout(&body);
    if snap.lines_seen == 0 {
        None
    } else {
        Some(snap)
    }
}

/// 本机：`%USERPROFILE%\.codex\sessions` 下最新的那个 rollout，读它的尾巴
pub fn local_snapshot() -> Option<AiSessionSnapshot> {
    let home = std::env::var("USERPROFILE").ok()?;
    let root = std::path::Path::new(&home).join(".codex").join("sessions");
    let newest = newest_rollout(&root, 0)?;
    let text = read_tail(&newest, TAIL_BYTES)?;
    let snap = parse_rollout(&text);
    if snap.lines_seen == 0 {
        None
    } else {
        Some(snap)
    }
}

/// 递归找最新的 rollout-*.jsonl（目录结构是 sessions/年/月/日/，最多三层的递归）
fn newest_rollout(dir: &std::path::Path, depth: u32) -> Option<std::path::PathBuf> {
    if depth > 3 {
        return None;
    }
    let read = std::fs::read_dir(dir).ok()?;
    let mut best: Option<(std::time::SystemTime, std::path::PathBuf)> = None;
    for e in read.flatten() {
        let path = e.path();
        if path.is_dir() {
            if let Some(found) = newest_rollout(&path, depth + 1) {
                let t = std::fs::metadata(&found)
                    .and_then(|m| m.modified())
                    .unwrap_or(std::time::UNIX_EPOCH);
                if best.as_ref().map(|(bt, _)| t > *bt).unwrap_or(true) {
                    best = Some((t, found));
                }
            }
            continue;
        }
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if !(name.starts_with("rollout-") && name.ends_with(".jsonl")) {
            continue;
        }
        let t = e
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(std::time::UNIX_EPOCH);
        if best.as_ref().map(|(bt, _)| t > *bt).unwrap_or(true) {
            best = Some((t, path));
        }
    }
    best.map(|(_, p)| p)
}

/// 读文件最后 n 字节（大文件不要整个读进来）
fn read_tail(path: &std::path::Path, n: u64) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    let start = len.saturating_sub(n);
    f.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).ok()?;
    Some(String::from_utf8_lossy(&buf).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 这些行是从真实会话文件里抄下来的（字段名/结构一致）
    fn sample() -> String {
        [
            r#"{"timestamp":"2026-09-26T10:46:20.400Z","ordinal":0,"type":"session_meta","payload":{"session_id":"01a0dd52-ade1-7e20-9177-6188acb46968","cwd":"D:\\AI\\ZeeAI_term","originator":"Codex Desktop"}}"#,
            r#"{"timestamp":"2026-09-26T10:46:20.419Z","ordinal":7,"type":"turn_context","payload":{"turn_id":"t1","cwd":"D:\\AI\\ZeeAI_term","approval_policy":"never","sandbox_policy":"danger-full-access"}}"#,
            r#"{"timestamp":"2026-09-26T10:46:20.500Z","ordinal":10,"type":"event_msg","payload":{"type":"task_started","turn_id":"t1"}}"#,
            r#"{"timestamp":"2026-09-26T10:46:21.000Z","ordinal":12,"type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\"cmd\": \"ping -n 2 8.8.8.8\"}"}}"#,
            r#"{"timestamp":"2026-09-26T10:46:25.000Z","ordinal":14,"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":25475,"cached_input_tokens":15872,"output_tokens":556,"reasoning_output_tokens":452,"total_tokens":26031},"last_token_usage":{"total_tokens":26031},"model_context_window":950000}}}"#,
            r#"{"timestamp":"2026-09-26T10:46:31.038Z","ordinal":24,"type":"event_msg","payload":{"type":"task_complete","turn_id":"t1","last_agent_message":"网络通的。\n\n可以正常访问外网。","started_at":1790419580,"completed_at":1790419591,"duration_ms":11015,"time_to_first_token_ms":2764}}"#,
        ]
        .join("\n")
    }

    #[test]
    fn reads_turn_result_and_usage() {
        let s = parse_rollout(&sample());
        assert_eq!(s.session_id, "01a0dd52-ade1-7e20-9177-6188acb46968");
        assert_eq!(s.cwd, r"D:\AI\ZeeAI_term");
        assert_eq!(s.approval_policy, "never");
        assert!(s.last_message.starts_with("网络通的。"));
        assert_eq!(s.last_turn_duration_ms, 11015);
        assert_eq!(s.last_turn_completed_at, 1790419591);
        assert_eq!(s.state, "idle", "task_complete 之后就是空闲等你了");
        let u = s.usage.unwrap();
        assert_eq!(u.total, 26031);
        assert_eq!(u.cached_input, 15872);
        assert_eq!(u.context_window, 950000);
    }

    #[test]
    fn in_flight_turn_is_running_and_approval_wins() {
        let running = parse_rollout(
            r#"{"type":"session_meta","payload":{"session_id":"x","cwd":"/root/proj"}}
{"type":"event_msg","payload":{"type":"task_started"}}
{"type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\"cmd\": \"npm test\"}"}}"#,
        );
        assert_eq!(running.state, "running");
        assert!(running.last_action.contains("npm test"), "{}", running.last_action);

        // 出现"要批准"之后，状态必须是 needs-approval（优先级高于 running）
        let approval = parse_rollout(
            r#"{"type":"session_meta","payload":{"session_id":"x","cwd":"/root/proj"}}
{"type":"event_msg","payload":{"type":"task_started"}}
{"type":"event_msg","payload":{"type":"exec_approval_request","command":"rm -rf build"}}"#,
        );
        assert_eq!(approval.state, "needs-approval");
        assert!(approval.last_action.contains("rm -rf build"), "{}", approval.last_action);
    }

    #[test]
    fn tolerates_truncated_first_line_and_garbage() {
        let text = "4,\"payload\":{\"type\":\"message\"}}\nnot json at all\n\
{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_complete\",\"last_agent_message\":\"好了\"}}";
        let s = parse_rollout(text);
        assert_eq!(s.last_message, "好了");
        assert_eq!(s.lines_seen, 1, "只应认出一行合法 JSON");
    }

    #[test]
    fn parses_iso_timestamps() {
        assert_eq!(parse_ts("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(parse_ts("2026-09-26T10:46:31.038Z"), Some(1790419591));
        assert_eq!(parse_ts("garbage"), None);
    }
}
