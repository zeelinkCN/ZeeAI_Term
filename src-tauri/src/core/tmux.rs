use serde::Serialize;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TmuxSession {
    pub name: String,
    pub windows: u32,
    pub attached: bool,
}

/// 解析 `tmux ls -F '#{session_name}|#{session_windows}|#{session_attached}'` 的输出。
/// 每行形如：`main|3|1`
pub fn parse_list(output: &str) -> Vec<TmuxSession> {
    let mut out = Vec::new();
    for line in output.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with("no server running") {
            continue;
        }
        let mut parts = line.split('|');
        let name = match parts.next() {
            Some(n) if !n.trim().is_empty() => n.trim().to_string(),
            _ => continue,
        };
        let windows = parts
            .next()
            .and_then(|w| w.trim().parse::<u32>().ok())
            .unwrap_or(0);
        let attached = parts
            .next()
            .map(|a| a.trim() == "1" || a.trim().eq_ignore_ascii_case("true"))
            .unwrap_or(false);
        out.push(TmuxSession {
            name,
            windows,
            attached,
        });
    }
    out
}

pub fn list_remote_command() -> String {
    "tmux ls -F '#{session_name}|#{session_windows}|#{session_attached}' 2>/dev/null || true".into()
}

pub fn kill_remote_command(name: &str) -> String {
    format!(
        "tmux kill-session -t '{}' 2>&1 || true",
        name.replace('\'', "")
    )
}

/// tmux 窗口（给「tmux 快捷操作」面板列出来点着切）
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TmuxWindow {
    pub index: u32,
    pub name: String,
    pub active: bool,
    pub panes: u32,
}

/// 解析 `tmux list-windows -F '#{window_index}|#{window_name}|#{window_active}|#{window_panes}'`
pub fn parse_windows(output: &str) -> Vec<TmuxWindow> {
    let mut out = Vec::new();
    for line in output.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let mut parts = line.split('|');
        let index = parts
            .next()
            .and_then(|v| v.trim().parse::<u32>().ok())
            .unwrap_or(0);
        let name = parts.next().unwrap_or("").trim().to_string();
        let active = parts
            .next()
            .map(|v| v.trim() == "1")
            .unwrap_or(false);
        let panes = parts
            .next()
            .and_then(|v| v.trim().parse::<u32>().ok())
            .unwrap_or(1);
        out.push(TmuxWindow {
            index,
            name,
            active,
            panes,
        });
    }
    out
}

pub fn list_windows_command(session: &str) -> String {
    format!(
        "tmux list-windows -t {} -F '#{{window_index}}|#{{window_name}}|#{{window_active}}|#{{window_panes}}' 2>/dev/null || true",
        quote(session)
    )
}

/// 单引号安全转义，避免会话名/窗口名里的字符跑到 shell 里当语法
fn quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// 「tmux 快捷操作」面板上的按钮 → 具体要跑的 tmux 命令。
///
/// **只认下面这些固定动作**（前端传的是动作名，不是命令），
/// 这样这个接口不会变成"在前端拼任意远端命令"的口子。
pub fn action_command(session: &str, action: &str, arg: Option<&str>) -> Option<String> {
    let s = quote(session);
    let a = arg.unwrap_or("").trim().to_string();
    let cmd = match action {
        // 窗口
        "new-window" => format!("tmux new-window -t {s}"),
        "next-window" => format!("tmux next-window -t {s}"),
        "prev-window" => format!("tmux previous-window -t {s}"),
        "kill-window" => format!("tmux kill-window -t {s}"),
        "select-window" => {
            let idx: u32 = a.parse().ok()?; // 只接受数字下标
            format!("tmux select-window -t {s}:{idx}")
        }
        "rename-window" => {
            if a.is_empty() {
                return None;
            }
            format!("tmux rename-window -t {s} {}", quote(&a))
        }
        // 窗格
        "split-v" => format!("tmux split-window -v -t {s}"),
        "split-h" => format!("tmux split-window -h -t {s}"),
        "pane-up" => format!("tmux select-pane -U -t {s}"),
        "pane-down" => format!("tmux select-pane -D -t {s}"),
        "pane-left" => format!("tmux select-pane -L -t {s}"),
        "pane-right" => format!("tmux select-pane -R -t {s}"),
        "zoom" => format!("tmux resize-pane -Z -t {s}"),
        "next-layout" => format!("tmux next-layout -t {s}"),
        "kill-pane" => format!("tmux kill-pane -t {s}"),
        // 滚动 / 复制模式（就是平时按 Ctrl+B [ 的那个）
        "copy-mode" => format!("tmux copy-mode -t {s}"),
        "copy-mode-exit" => format!("tmux copy-mode -q -t {s}"),
        // 离开但不关掉（平时按 Ctrl+B d）
        "detach" => format!("tmux detach-client -s {s}"),
        _ => return None,
    };
    Some(format!("{cmd} 2>&1 || true"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_basic_list() {
        let out = "main|3|1\nwork|1|0\n";
        let v = parse_list(out);
        assert_eq!(v.len(), 2);
        assert_eq!(v[0].name, "main");
        assert_eq!(v[0].windows, 3);
        assert!(v[0].attached);
        assert_eq!(v[1].name, "work");
        assert!(!v[1].attached);
    }

    #[test]
    fn ignores_empty_output_and_tmux_no_server_message() {
        assert!(parse_list("").is_empty());
        assert!(parse_list("no server running on /tmp/tmux-0/default\n").is_empty());
        assert!(parse_list("\n  \n").is_empty());
    }

    #[test]
    fn tolerates_missing_fields() {
        let v = parse_list("lonely\n");
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].name, "lonely");
        assert_eq!(v[0].windows, 0);
        assert!(!v[0].attached);
    }

    #[test]
    fn parses_window_list() {
        let v = parse_windows("0|bash|1|2\n1|logs|0|1\n");
        assert_eq!(v.len(), 2);
        assert_eq!(v[0].index, 0);
        assert_eq!(v[0].name, "bash");
        assert!(v[0].active);
        assert_eq!(v[0].panes, 2);
        assert!(!v[1].active);
    }

    #[test]
    fn only_whitelisted_actions_become_commands() {
        assert!(action_command("main", "split-h", None).is_some());
        assert!(action_command("main", "rm -rf /", None).is_none());
        // select-window 只接受数字，其他一律拒绝
        assert!(action_command("main", "select-window", Some("2")).is_some());
        assert!(action_command("main", "select-window", Some("2; rm -rf /")).is_none());
    }

    #[test]
    fn quotes_session_names_with_single_quotes() {
        let c = action_command("my sess'x", "new-window", None).unwrap();
        // 里面的单引号被转义掉，不会跑出 shell 语法
        assert!(c.contains(r"'my sess'\''x'"), "got: {c}");
    }
}
