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
    jump: Option<&str>,
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
    // 跳板机：直接交给 ssh 的 -J，端口转发/认证都由它自己搞定
    if let Some(j) = jump.map(str::trim).filter(|j| !j.is_empty()) {
        args.push("-J".into());
        args.push(j.to_string());
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
    // 连上就顺手把"窗口尺寸该听谁的"这个策略设成我们想要的样子，**并且兼容老版本**：
    // - `aggressive-resize on`：tmux 1.8 起就有。窗口尺寸跟着"把这个窗口显示在前台的那个客户端"走，
    //   而不是被别的后台客户端拖着 —— 老 tmux（2.9 之前没有 window-size）就靠它缓解"小客户端说了算"；
    // - `window-size latest`：tmux 2.9 才有。让窗口跟着最近活动的客户端，
    //   老版本上没有这个选项，`2>/dev/null` 把报错吞掉即可（**不是**用 `|| true` 忽略一切，
    //   只是不让一句"unknown option"打断后面的连接）。
    //
    // 为什么放在连接命令里而不是要求用户升级 tmux：用户有几十台别人的服务器，
    // 不可能都去升级；而这两条设置是"能设就设、不能设就算了"，对任何版本都安全。
    let tune = "tmux set-option -g aggressive-resize on 2>/dev/null; \
tmux set-option -g window-size latest 2>/dev/null; ";
    let mut tmux = format!("tmux new-session -A -s '{}'", session_name.replace('\'', ""));
    if let Some(dir) = start_dir {
        let dir = dir.replace('\'', "");
        if !dir.trim().is_empty() {
            tmux.push_str(&format!(" -c '{}'", dir));
        }
    }

    // 注意：这里的提示信息保持 ASCII，避免远端 locale 不是 UTF-8 时中文变乱码。
    format!(
        "if command -v tmux >/dev/null 2>&1; then {tune}exec {tmux}; \
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
    // 除了 OSC 7（上报当前目录），这里还捎带做 G-02 的 shell 集成：OSC 133 的
    // A（提示符开始）/ B（提示符结束）/ C（命令开始）/ D;exit（命令结束 + 退出码）。
    //
    // 为什么用 PROMPT_COMMAND：它每次画提示符都会执行，不需要改服务器上任何 rc 文件——
    // 和当初做 OSC 7 是同一套做法（见 docs/decisions.md 第七轮）。
    //
    // 已知限制（如实记录）：**tmux 会话上这条路走不通**。tmux 里 shell 的环境来自
    // tmux server，而 server 可能是别的客户端先起的；本机这台服务器 tmux 还是 2.7，
    // 没有 `-e` 传环境变量、也不允许我们模拟按键（用户明确禁止）。所以 tmux 会话
    // 仍然只有 OSC 7 那一条（由 tmux 的 `-c` 起始目录 + 进程信息推断）。
    // 除了 OSC 7（上报当前目录），这里捎带做 G-02：OSC 133 的 `D;<退出码>` ——
    // 每个命令结束时把**退出码**报上来，卡片就能显示"上一轮退出码 0"、并拿到精确的结束时刻。
    //
    // 只发 D，不去改 PS1 / 不发 A/B/C：这条命令会被塞进 ssh 的远端命令里，
    // 越短越不容易踩转义坑；而"命令结束 + 退出码"恰好是最有用的那一个信号。
    // 注意 `$?` 必须是 PROMPT_COMMAND 里**第一个**被求值的东西，否则会被前面的命令覆盖。
    //
    // 已知限制（如实记录）：**tmux 会话上这条路走不通** —— tmux 里 shell 的环境来自
    // tmux server，而 server 可能是别的客户端先起的；这台服务器 tmux 还是 2.7，
    // 没有 `-e` 传环境变量，而模拟按键又被明确禁止。所以 tmux 会话拿不到退出码。
    r#"if [ -n "$BASH_VERSION" ] || [ "$(basename "${SHELL:-bash}")" = "bash" ]; then PROMPT_COMMAND='printf "\033]133;D;%s\007" "$?"; printf "\033]7;file://%s%s\007" "$HOSTNAME" "$PWD"'; export PROMPT_COMMAND; fi; exec "${SHELL:-/bin/bash}""#
        .to_string()
}

/// 组装一次非交互式 `ssh <host> "<cmd>"` 调用（用于 tmux 列表 / kill 这类一次性命令）。
pub fn ssh_exec_args(
    host: &str,
    port: u16,
    user: &str,
    key_path: Option<&str>,
    remote_command: &str,
    jump: Option<&str>,
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
    if let Some(j) = jump.map(str::trim).filter(|j| !j.is_empty()) {
        args.push("-J".into());
        args.push(j.to_string());
    }
    args.push(format!("{user}@{host}"));
    args.push(remote_command.to_string());
    args
}
