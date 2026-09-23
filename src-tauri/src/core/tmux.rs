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
}
