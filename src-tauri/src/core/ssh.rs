use std::path::Path;

/// 找到系统自带的 OpenSSH 客户端。Windows 10+ 默认在 System32\OpenSSH 下。
pub fn ssh_exe() -> String {
    let candidates = [
        r"C:\Windows\System32\OpenSSH\ssh.exe",
        r"C:\Program Files\Git\usr\bin\ssh.exe",
    ];
    for c in candidates {
        if Path::new(c).exists() {
            return c.to_string();
        }
    }
    "ssh".to_string()
}

/// 组装 ssh 命令行。复用用户本机已经配好的密钥/agent/config，
/// 因此不在这里处理密码认证（交给 ssh 自己在终端里提示）。
pub fn ssh_args(
    host: &str,
    port: u16,
    user: &str,
    key_path: Option<&str>,
    remote_cmd: Option<&str>,
) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-tt".into(),
        "-o".into(),
        "ServerAliveInterval=30".into(),
        "-o".into(),
        "ServerAliveCountMax=3".into(),
        "-o".into(),
        "StrictHostKeyChecking=accept-new".into(),
        "-p".into(),
        port.to_string(),
    ];
    if let Some(k) = key_path {
        if !k.trim().is_empty() {
            args.push("-i".into());
            args.push(k.to_string());
        }
    }
    args.push(format!("{user}@{host}"));
    if let Some(cmd) = remote_cmd {
        args.push(cmd.to_string());
    }
    args
}

/// tmux 的会话名不允许包含 `.` `:` 等字符，这里统一替换成 `-`。
fn sanitize(name: &str) -> String {
    name.chars()
        .map(|c| match c {
            '.' | ':' | '/' | '\\' | ' ' | '\t' => '-',
            c => c,
        })
        .collect()
}

/// tmux 会话名按模板生成，比如 {host}-{user} -> 47-99-241-168-root
pub fn tmux_session_name(template: &str, host: &str, user: &str) -> String {
    let raw = template
        .replace("{host}", host)
        .replace("{user}", user)
        .trim()
        .to_string();
    let name = sanitize(&raw);
    if name.is_empty() {
        sanitize(&format!("{host}-{user}"))
    } else {
        name
    }
}

/// 远端命令：优先 attach/新建 tmux 会话；若服务器没装 tmux，
/// 自动降级为普通 shell 并在终端里打印安装提示（不会替用户安装任何东西）。
pub fn tmux_command(session_name: &str, start_dir: Option<&str>) -> String {
    let mut tmux = format!("tmux new-session -A -s '{}'", session_name.replace('\'', ""));
    if let Some(dir) = start_dir {
        let dir = dir.replace('\'', "");
        if !dir.trim().is_empty() {
            tmux.push_str(&format!(" -c '{}'", dir));
        }
    }

    // 注意：这里的提示信息保持 ASCII，避免远端 locale 不是 UTF-8 时中文变乱码。
    format!(
        "if command -v tmux >/dev/null 2>&1; then exec {tmux}; \
else printf '\\n[ZeeAI] tmux not found on this server - falling back to a plain shell.\\n\
[ZeeAI] Install it to get persistent sessions:  yum install -y tmux   (or: apt-get install -y tmux)\\n\\n'; \
exec \"${{SHELL:-/bin/bash}}\"; fi"
    )
}
