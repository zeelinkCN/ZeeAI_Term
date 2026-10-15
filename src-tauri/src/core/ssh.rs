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
    ];
    // 0 = "没说"：不传 -P，交给 ~/.ssh/config 的 Port（和 ssh_args 同一套口径）
    if port != 0 {
        args.push("-P".into());
        args.push(port.to_string());
    }
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
/// 用户名没说时退化成 `host:'/路径'`，同样是为了让 config 的 User 生效。
pub fn scp_remote(host: &str, user: &str, remote_path: &str) -> String {
    format!(
        "{}:{}",
        ssh_target(host, user),
        crate::core::remote_fs::sq(remote_path)
    )
}

/// `user@host`；**用户名没说时只给 `host`** —— 让 `~/.ssh/config` 里的 `User` 生效。
pub fn ssh_target(host: &str, user: &str) -> String {
    let user = user.trim();
    let host = host.trim();
    if user.is_empty() {
        host.to_string()
    } else {
        format!("{user}@{host}")
    }
}

/// 组装 ssh 命令行。复用用户本机已经配好的密钥/agent/config，
/// 因此不在这里处理密码认证（交给 ssh 自己在终端里提示）。
///
/// **端口 / 用户名允许"没说"**：`port == 0`、或用户名为空时，我们**不传** `-p`、
/// 不写 `user@`，把这两项交给用户的 `~/.ssh/config` 决定。
///
/// 为什么要这样：以前永远显式传 `-p 22 root@host`，会把 config 里的 `Port`/`User`
/// **顶掉** —— 实测 `ssh -p 22 root@myalias` 解析出来是 `user root / port 22`，
/// 而只给别名时 config 才会生效（`user alice / port 2222 / identityfile …`）。
/// 于是"本机配了免密、界面里填了别名"的用户永远连不上（2026-10 用户报障）。
/// 显式值仍然优先：用户填了就是我们说了算。
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
    ];
    // 0 = "没说"，交给 ~/.ssh/config 的 Port
    if port != 0 {
        args.push("-p".into());
        args.push(port.to_string());
    }
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
    args.push(ssh_target(host, user));
    if let Some(cmd) = remote_cmd {
        args.push(cmd.to_string());
    }
    args
}

/// 和 [`ssh_args`] 一样，但**不申请远端 PTY**（不带 `-tt`）。
///
/// 给谁用：herdr 的终端流（观察窗 / 可写控制流）。那条协议是"行分隔 JSON"，
/// 不需要任何终端语义；反而 **申请 PTY 会坏事** —— 远端会做回显/换行转换，
/// 而本地这边我们也不走 ConPTY（原因见 core::herdr_stream 顶部）。
pub fn ssh_args_no_tty(
    host: &str,
    port: u16,
    user: &str,
    key_path: Option<&str>,
    remote_cmd: &str,
    jump: Option<&str>,
) -> Vec<String> {
    ssh_args(host, port, user, key_path, Some(remote_cmd), true, jump)
        .into_iter()
        // ssh_args 固定把 -tt 放在第一位，这里只去掉它
        .filter(|a| a != "-tt")
        .collect()
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
    // 注意 `-gw`：aggressive-resize 是**窗口选项**，写成 `-g` 会被老 tmux 判成
    // "unknown option: aggressive-resize"（实测踩过），而 -gw 从 tmux 1.x 起就支持。
    let tune = "tmux set-option -gw aggressive-resize on 2>/dev/null; \
tmux set-option -g window-size latest 2>/dev/null; ";
    let mut tmux = format!("tmux new-session -A -s '{}'", session_name.replace('\'', ""));
    if let Some(dir) = start_dir {
        let dir = dir.replace('\'', "");
        if !dir.trim().is_empty() {
            tmux.push_str(&format!(" -c '{}'", dir));
        }
    }

    // 注意：这里的提示信息保持 ASCII，避免远端 locale 不是 UTF-8 时中文变乱码。
    // **不要用 ` - ` 这种破折号**：用户会把中文提示里的孤立 `-` 当成我们的 bug
    //（2026-10 报障就是这么来的），所以这里统一用 "." 断句。
    format!(
        "if command -v tmux >/dev/null 2>&1; then {tune}exec {tmux}; \
else printf '\\n[ZeeAI] tmux not found on this server. Falling back to a plain shell.\\n\
[ZeeAI] Install it to get persistent sessions:  yum install -y tmux   (or: apt-get install -y tmux)\\n\\n'; \
exec \"${{SHELL:-/bin/bash}}\"; fi"
    )
}

/// herdr 后端的连接命令（试用版）。
///
/// 这一版先把 herdr **自己的界面**跑在这个标签页里 —— 目的是让「会话后端」这个位置先落地可用，
/// 用户马上能拿到 herdr 的 agent 列表 / 状态 / 断线恢复（这些我们自己都还没有）。
/// 下一步（方案②的原生集成）会把这里换成"我们自己的界面 + herdr 的 observe/control 通道"，
/// **位置和开关不变**，只是启动方式换掉。
///
/// 为什么不像 tmux 那样先 set-option：herdr 的配置由它自己管（`~/.config/herdr/config.toml`），
/// 我们不去改用户的配置；它的默认前缀键就是 `ctrl+b`（和 tmux 一样），用户已知悉。
///
/// 找不到 herdr 时**原样退化成普通 shell**并打印一行英文提示（远端 locale 不保证是 UTF-8，
/// 所以远端提示统一用 ASCII，和 tmux 那条的做法一致）。
pub fn herdr_command(session_name: &str) -> String {
    let cleaned = session_name.trim().replace('\'', "");
    let name = if cleaned.is_empty() {
        "main".to_string()
    } else {
        cleaned
    };
    format!(
        "if command -v herdr >/dev/null 2>&1; then exec herdr --session '{name}'; \
elif [ -x \"$HOME/.local/bin/herdr\" ]; then exec \"$HOME/.local/bin/herdr\" --session '{name}'; \
else printf '\\n[ZeeAI] herdr not found on this server. Falling back to a plain shell.\\n\
[ZeeAI] The herdr option is only available when herdr is installed on this machine.\\n\\n'; \
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
///
/// 端口 0 / 用户名空 = "没说"，不传 `-p` / 不写 `user@`（口径同 [`ssh_args`]）。
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
    ];
    if port != 0 {
        args.push("-p".into());
        args.push(port.to_string());
    }
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
    args.push(ssh_target(host, user));
    args.push(remote_command.to_string());
    args
}

/// 把 russh（纯 Rust 实现）的**英文报错**分类成中文短句，并**保留英文原文**。
///
/// 为什么要做：这些错误以前被原样透给界面 —— 例如
/// `No common Kex algorithm - ours: […], theirs: […]`（russh-0.53/src/lib.rs:183），
/// 中文提示里冒出一个孤零零的 `-`，用户只能猜（2026-10 用户报障：以为是我们打错了）。
///
/// 分类只做够用的四类，原文一律附在后面（排查时不用翻日志，前端也可以放进悬停）。
pub fn friendly_ssh_error(raw: &str) -> String {
    let low = raw.to_ascii_lowercase();
    let algo = (low.contains("no common") || low.contains("not supported"))
        && (low.contains("algorithm") || low.contains("kex") || low.contains("host key"));
    let auth = low.contains("auth")
        || low.contains("permission denied")
        || low.contains("publickey")
        || low.contains("password");
    let net = low.contains("timed out")
        || low.contains("timeout")
        || low.contains("refused")
        || low.contains("unreachable")
        || low.contains("no route")
        || low.contains("dns")
        || low.contains("connect")
        || low.contains("resolve");
    let kind = if algo {
        "算法不匹配（这台服务器的加密算法和我们的实现对不上：试试改用密钥/系统 ssh，或让管理员开启现代算法）"
    } else if auth {
        "认证失败（用户名、密码或密钥不对，或服务器不允许这种登录方式）"
    } else if net {
        "连不上服务器（网络、端口、防火墙，或地址写错了）"
    } else {
        "连接失败"
    };
    format!("{kind}｜原始信息：{raw}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn has(args: &[String], s: &str) -> bool {
        args.iter().any(|a| a == s)
    }

    /// port = 0 = "没说"：不许传 `-p`（ssh）/ `-P`（scp），否则会把 config 的端口顶掉
    #[test]
    fn port_zero_leaves_port_to_ssh_config() {
        let a = ssh_args("myalias", 0, "root", None, None, false, None);
        assert!(!has(&a, "-p"), "port=0 不该传 -p：{a:?}");
        let b = ssh_exec_args("myalias", 0, "root", None, "ls", None);
        assert!(!has(&b, "-p"), "一次性命令也不该传 -p：{b:?}");
        let c = scp_args(0, None, false, "a", "b");
        assert!(!has(&c, "-P"), "scp 的端口开关是 -P：{c:?}");
    }

    /// 用户名空 = "没说"：只给 host，让 config 的 User 生效
    #[test]
    fn empty_user_leaves_user_to_ssh_config() {
        let a = ssh_args("myalias", 22, "", None, None, false, None);
        assert!(has(&a, "myalias"), "{a:?}");
        assert!(
            !a.iter().any(|x| x.contains('@')),
            "空用户名不该拼出 user@host：{a:?}"
        );
        // 全是空格也算没说
        let b = ssh_args("h", 22, "   ", None, None, false, None);
        assert!(has(&b, "h"), "{b:?}");
        assert_eq!(scp_remote("myalias", "", "/tmp/x"), "myalias:'/tmp/x'");
    }

    /// 显式填了端口/用户名时，行为跟以前一模一样（用户说了算）
    #[test]
    fn explicit_port_and_user_still_win() {
        let a = ssh_args(
            "h",
            2222,
            "alice",
            Some("/k"),
            Some("echo hi"),
            true,
            Some("jump"),
        );
        assert!(has(&a, "-p") && has(&a, "2222"), "{a:?}");
        assert!(has(&a, "alice@h"), "{a:?}");
        assert!(has(&a, "-i") && has(&a, "/k"), "{a:?}");
        assert!(has(&a, "-J") && has(&a, "jump"), "{a:?}");
        assert!(has(&a, "BatchMode=yes") && has(&a, "-tt"), "{a:?}");
        assert_eq!(a.last().unwrap(), "echo hi");
    }

    #[test]
    fn no_tty_variant_only_drops_tt() {
        let a = ssh_args_no_tty("h", 0, "", None, "cmd", None);
        assert!(!has(&a, "-tt"), "{a:?}");
        assert!(has(&a, "h") && has(&a, "cmd"), "{a:?}");
        assert!(!has(&a, "-p"), "{a:?}");
    }

    /// russh 的英文报错要分类成中文，但**原文必须留着**（否则没法排查）
    #[test]
    fn russh_errors_are_classified_with_raw_text_kept() {
        let algo = friendly_ssh_error(
            "No common Kex algorithm - ours: [curve25519], theirs: [diffie-hellman-group1-sha1]",
        );
        assert!(algo.contains("算法不匹配"), "{algo}");
        assert!(algo.contains("No common Kex algorithm"), "原文要留着：{algo}");
        assert!(friendly_ssh_error("Permission denied (publickey,password)").contains("认证失败"));
        assert!(friendly_ssh_error("connect timed out").contains("连不上服务器"));
        let other = friendly_ssh_error("something weird");
        assert!(other.contains("连接失败") && other.contains("something weird"), "{other}");
    }

    /// 远端提示里不能再出现孤立的 ` - `（用户会当成我们的 bug）
    #[test]
    fn remote_notices_have_no_stray_dash() {
        for s in [tmux_command("s", None), herdr_command("s")] {
            assert!(!s.contains(" - "), "不该有孤立破折号：{s}");
            assert!(s.contains("Falling back to a plain shell."), "{s}");
        }
    }
}
