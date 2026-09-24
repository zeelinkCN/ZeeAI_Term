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

/// 找到系统自带的 scp（文件上传/下载用，和 ssh 同一个目录）。
pub fn scp_exe() -> String {
    let candidates = [
        r"C:\Windows\System32\OpenSSH\scp.exe",
        r"C:\Program Files\Git\usr\bin\scp.exe",
    ];
    for c in candidates {
        if Path::new(c).exists() {
            return c.to_string();
        }
    }
    "scp".to_string()
}

/// 组装 scp 参数。注意 scp 的端口是 `-P`（大写），和 ssh 的 `-p` 不一样。
/// Windows 自带的是 OpenSSH 8.1，走的还是老 SCP 协议，远端路径会被远端 shell 解释，
/// 所以调用方必须把远端路径用单引号包好（见 remote_fs::sq）。
pub fn scp_args(
    port: u16,
    key_path: Option<&str>,
    recursive: bool,
    source: &str,
    target: &str,
) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-q".into(),
        // -T：关掉「收到的文件名必须和请求的一致」这个检查。
        // 我们为了支持带空格/特殊字符的路径会给远端路径加单引号，
        // 本地 scp 会把这串字面量当成请求名去比对，于是下载必然报
        // "protocol error: filename does not match request"。加 -T 即可。
        "-T".into(),
        "-o".into(),
        "BatchMode=yes".into(),
        "-o".into(),
        "StrictHostKeyChecking=accept-new".into(),
        "-P".into(),
        port.to_string(),
    ];
    if recursive {
        args.push("-r".into());
    }
    if let Some(k) = key_path {
        if !k.trim().is_empty() {
            args.push("-i".into());
            args.push(k.to_string());
        }
    }
    args.push(source.to_string());
    args.push(target.to_string());
    args
}

/// scp 的远端路径写法：`user@host:'/绝对/路径'`（单引号给远端 shell 用）。
pub fn scp_remote(host: &str, user: &str, remote_path: &str) -> String {
    format!("{user}@{host}:{}", crate::core::remote_fs::sq(remote_path))
}

/// 组装 ssh 命令行。复用用户本机已经配好的密钥/agent/config，
/// 因此不在这里处理密码认证（交给 ssh 自己在终端里提示）。
pub fn ssh_args(
    host: &str,
    port: u16,
    user: &str,
    key_path: Option<&str>,
    remote_cmd: Option<&str>,
    batch_mode: bool,
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
    if batch_mode {
        args.push("-o".into());
        args.push("BatchMode=yes".into());
    }
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

/// 普通 shell（不用 tmux）时用的远端命令：
/// 先让 bash 每次显示提示符时用 OSC 7 上报当前目录，再 exec 真 shell。
/// 这样「文件面板同步终端目录」在非 tmux 会话里也能用——
/// 你在终端里 `cd` 到哪儿，面板点一下同步就跟过去。
///
/// PROMPT_COMMAND 通过 export 传进去：bash 启动时会从环境导入它，
/// 交互式运行时每次画提示符都会执行，所以不需要改服务器上任何 rc 文件。
pub fn shell_with_cwd_report() -> String {
    r#"if [ -n "$BASH_VERSION" ] || [ "$(basename "${SHELL:-bash}")" = "bash" ]; then PROMPT_COMMAND='printf "\033]7;file://%s%s\007" "$HOSTNAME" "$PWD"'; export PROMPT_COMMAND; fi; exec "${SHELL:-/bin/bash}""#.to_string()
}

/// 组装一次非交互式 `ssh <host> "<cmd>"` 调用（用于 tmux 列表 / kill 这类一次性命令）。
pub fn ssh_exec_args(
    host: &str,
    port: u16,
    user: &str,
    key_path: Option<&str>,
    remote_command: &str,
) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-o".into(),
        "BatchMode=yes".into(),
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
    args.push(remote_command.to_string());
    args
}
