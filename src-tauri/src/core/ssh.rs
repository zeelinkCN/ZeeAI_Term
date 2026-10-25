use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;

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

// ---------------------------------------------------------------------------
// SSH 连接诊断（系统 `ssh -G` 的只读解析）
// ---------------------------------------------------------------------------

/// `ssh -G` 最多等这么久。它只解析本机配置，正常是毫秒级；配置里若有
/// `Match exec` 之类的钩子也不该把 UI 拖死。
pub const SSH_DIAG_TIMEOUT: Duration = Duration::from_secs(10);

/// `ssh -G` 实际生效的配置（只挑诊断需要的字段）。
///
/// 字段名保留 OpenSSH 配置项的小写写法（`identityfile` / `proxyjump` …），
/// 前端下一轮直接按配置项名展示即可。
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct SshEffectiveConfig {
    pub hostname: String,
    pub port: u16,
    pub user: String,
    /// 可能有多条（`ssh -G` 会为每个 IdentityFile 输出一行，也包含系统默认值）
    pub identityfile: Vec<String>,
    pub proxyjump: Option<String>,
    pub proxycommand: Option<String>,
    pub identitiesonly: String,
    pub batchmode: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SshKeyFile {
    pub path: String,
    pub exists: bool,
}

/// 给界面自证/排查用：实际生效配置 + 每个候选密钥是否存在 + 一句中文总结。
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SshDiagnosis {
    pub effective: SshEffectiveConfig,
    pub key_files: Vec<SshKeyFile>,
    pub summary: String,
}

/// 组装 `ssh -G` 参数：端口 / 用户名 / 密钥 / 跳板机都只在**用户真的说了**时才传。
///
/// 和 [`ssh_args`] 同一个口径：留空就把选择权交给 `~/.ssh/config`，诊断看到的
/// 才是用户实际会用到的那份配置。
fn ssh_g_args(
    host: &str,
    port: u16,
    user: &str,
    key_path: Option<&str>,
    jump: Option<&str>,
) -> Vec<String> {
    let mut args: Vec<String> = vec!["-G".into()];
    if port != 0 {
        args.push("-p".into());
        args.push(port.to_string());
    }
    let user = user.trim();
    if !user.is_empty() {
        args.push("-l".into());
        args.push(user.to_string());
    }
    if let Some(k) = key_path.map(str::trim).filter(|k| !k.is_empty()) {
        args.push("-i".into());
        args.push(k.to_string());
    }
    if let Some(j) = jump.map(str::trim).filter(|j| !j.is_empty()) {
        args.push("-J".into());
        args.push(j.to_string());
    }
    args.push(host.trim().to_string());
    args
}

/// 去掉 `ssh -G` 值两侧可能存在的引号。
fn config_value(value: &str) -> &str {
    let value = value.trim();
    if value.len() >= 2 {
        let bytes = value.as_bytes();
        if (bytes[0] == b'"' && bytes[value.len() - 1] == b'"')
            || (bytes[0] == b'\'' && bytes[value.len() - 1] == b'\'')
        {
            return &value[1..value.len() - 1];
        }
    }
    value
}

fn optional_config_value(value: &str) -> Option<String> {
    let value = config_value(value);
    if value.is_empty() || value.eq_ignore_ascii_case("none") {
        None
    } else {
        Some(value.to_string())
    }
}

/// 解析 `ssh -G <host>` 的输出（纯函数，单测喂固定文本，不联网）。
///
/// 只认 `key value` 这种行；同名字段出现多次时，`identityfile` 全部保留，
/// 其它字段后者覆盖前者（与 OpenSSH 的“后读到的配置优先”一致）。
pub fn parse_ssh_g_output(text: &str) -> SshEffectiveConfig {
    let mut effective = SshEffectiveConfig {
        port: 22,
        ..Default::default()
    };
    let mut seen_identity: HashSet<String> = HashSet::new();

    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut parts = line.splitn(2, char::is_whitespace);
        let Some(key) = parts.next() else { continue };
        let value = parts.next().unwrap_or("").trim();
        match key.to_ascii_lowercase().as_str() {
            "hostname" => effective.hostname = config_value(value).to_string(),
            "port" => {
                if let Ok(port) = config_value(value).parse::<u16>() {
                    if port > 0 {
                        effective.port = port;
                    }
                }
            }
            "user" => effective.user = config_value(value).to_string(),
            "identityfile" => {
                let path = config_value(value).to_string();
                if !path.is_empty()
                    && !path.eq_ignore_ascii_case("none")
                    && seen_identity.insert(path.to_ascii_lowercase())
                {
                    effective.identityfile.push(path);
                }
            }
            "proxyjump" => effective.proxyjump = optional_config_value(value),
            "proxycommand" => effective.proxycommand = optional_config_value(value),
            "identitiesonly" => {
                let v = config_value(value);
                if !v.is_empty() {
                    effective.identitiesonly = v.to_ascii_lowercase();
                }
            }
            "batchmode" => {
                let v = config_value(value);
                if !v.is_empty() {
                    effective.batchmode = v.to_ascii_lowercase();
                }
            }
            _ => {}
        }
    }
    if effective.port == 0 {
        effective.port = 22;
    }
    effective
}

fn home_dir() -> Option<PathBuf> {
    for key in ["USERPROFILE", "HOME"] {
        if let Some(value) = std::env::var_os(key) {
            let path = PathBuf::from(value);
            if !path.as_os_str().is_empty() {
                return Some(path);
            }
        }
    }
    None
}

/// 把 `~/.ssh/id_x` / `%USERPROFILE%\.ssh\id_x` 展开成真实路径，便于 `Path::exists`。
fn expand_key_path(raw: &str, home: Option<&Path>) -> PathBuf {
    let raw = config_value(raw);
    if raw == "~" {
        return home.map(Path::to_path_buf).unwrap_or_else(|| PathBuf::from(raw));
    }
    if let Some(rest) = raw
        .strip_prefix("~/")
        .or_else(|| raw.strip_prefix("~\\"))
    {
        if let Some(home) = home {
            return home.join(rest);
        }
    }
    if let Some(rest) = raw.strip_prefix("%USERPROFILE%") {
        if let Some(home) = home {
            return home.join(rest.trim_start_matches(|c| c == '\\' || c == '/'));
        }
    }
    PathBuf::from(raw)
}

fn collect_key_files_with_home(
    effective: &SshEffectiveConfig,
    home: Option<&Path>,
) -> Vec<SshKeyFile> {
    let mut out: Vec<SshKeyFile> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    let mut push = |raw: &str| {
        let path = expand_key_path(raw, home);
        if path.as_os_str().is_empty() {
            return;
        }
        #[cfg(windows)]
        let text = path.to_string_lossy().replace('/', "\\");
        #[cfg(not(windows))]
        let text = path.to_string_lossy().to_string();
        // 去重键统一分隔符 + 小写：`ssh -G` 给的 `~/.ssh/id_x` 和 common 列表的
        // `C:\Users\...\.ssh\id_x` 必须认成同一个文件，否则界面会列两遍。
        let dedup = text.replace('\\', "/").to_ascii_lowercase();
        if text.trim().is_empty() || !seen.insert(dedup) {
            return;
        }
        out.push(SshKeyFile {
            exists: path.exists(),
            path: text,
        });
    };

    for path in &effective.identityfile {
        push(path);
    }
    // 配置里没写 IdentityFile 的老用户，也要能看到“本机到底有没有现成密钥”。
    if let Some(home) = home {
        for name in ["id_ed25519", "id_rsa", "id_ecdsa"] {
            push(&home.join(".ssh").join(name).to_string_lossy());
        }
    }
    out
}

fn compact_key_path(path: &str, home: Option<&Path>) -> String {
    let path = path.replace('\\', "/");
    if let Some(home) = home {
        let home = home.to_string_lossy().replace('\\', "/");
        let home = home.trim_end_matches('/');
        if !home.is_empty() && path.len() > home.len() {
            let is_under_home = path[..home.len()].eq_ignore_ascii_case(home)
                && path.as_bytes().get(home.len()) == Some(&b'/');
            if is_under_home {
                return format!("~/{}", &path[home.len() + 1..]);
            }
        }
    }
    path
}

fn summarize_with_home(
    effective: &SshEffectiveConfig,
    key_files: &[SshKeyFile],
    home: Option<&Path>,
) -> String {
    let hostname = if effective.hostname.trim().is_empty() {
        "（未知主机）"
    } else {
        effective.hostname.trim()
    };
    let target = if effective.user.trim().is_empty() {
        format!("{hostname}:{}", effective.port)
    } else {
        format!("{}@{hostname}:{}", effective.user.trim(), effective.port)
    };
    let mut summary = format!("将使用 {target}");
    if let Some(jump) = effective.proxyjump.as_deref().map(str::trim) {
        if !jump.is_empty() {
            summary.push_str(&format!("，经跳板机 {jump}"));
        }
    }

    // 优先说“真正存在的”那一把；全都缺失时也把第一把拎出来并明确标“不存在”。
    let chosen = key_files
        .iter()
        .find(|key| key.exists)
        .or_else(|| key_files.first());
    match chosen {
        Some(key) => {
            let state = if key.exists { "存在" } else { "不存在" };
            summary.push_str(&format!(
                "，密钥 {}（{state}）",
                compact_key_path(&key.path, home)
            ));
        }
        None => summary.push_str("，没有找到可用密钥"),
    }
    summary
}

/// 纯函数：固定文本 → 诊断结果。测试和线上共用，避免“测的”和“跑的”是两套。
pub fn diagnosis_from_output(text: &str, home: Option<&Path>) -> SshDiagnosis {
    let effective = parse_ssh_g_output(text);
    let key_files = collect_key_files_with_home(&effective, home);
    let summary = summarize_with_home(&effective, &key_files, home);
    SshDiagnosis {
        effective,
        key_files,
        summary,
    }
}

/// 只读诊断：跑一次 `ssh -G`，**不连接服务器、不写任何配置**。
///
/// 系统 ssh 找不到时返回明确中文 Err（前端可以直接提示去装 OpenSSH 客户端）。
/// 进程启动统一走 [`crate::core::proc::hidden_command_async`]：GUI 进程不会闪黑窗。
pub async fn diagnose(
    host: &str,
    port: u16,
    user: &str,
    key_path: Option<&str>,
    jump: Option<&str>,
) -> Result<SshDiagnosis, String> {
    let exe = ssh_exe();
    let mut cmd = crate::core::proc::hidden_command_async(&exe);
    cmd.args(ssh_g_args(host, port, user, key_path, jump));
    cmd.kill_on_drop(true);

    let output = match tokio::time::timeout(SSH_DIAG_TIMEOUT, cmd.output()).await {
        Err(_) => {
            return Err(format!(
                "读取 SSH 配置超时（ssh -G 超过 {} 秒没有返回）",
                SSH_DIAG_TIMEOUT.as_secs()
            ))
        }
        Ok(Err(e)) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err("系统没有 OpenSSH 客户端（请先在 Windows 可选功能里安装 OpenSSH 客户端）".into())
        }
        Ok(Err(e)) => {
            return Err(friendly_ssh_error_context("启动系统 ssh 失败", &e.to_string()))
        }
        Ok(Ok(output)) => output,
    };

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let raw = if stderr.is_empty() { &stdout } else { &stderr };
        return Err(friendly_ssh_error_context("读取 SSH 配置失败", raw));
    }

    let home = home_dir();
    let mut diagnosis = diagnosis_from_output(&stdout, home.as_deref());
    if diagnosis.effective.hostname.trim().is_empty() {
        diagnosis.effective.hostname = host.trim().to_string();
        diagnosis.summary =
            summarize_with_home(&diagnosis.effective, &diagnosis.key_files, home.as_deref());
    }
    if diagnosis.effective.user.trim().is_empty() {
        diagnosis.effective.user = user.trim().to_string();
        diagnosis.summary =
            summarize_with_home(&diagnosis.effective, &diagnosis.key_files, home.as_deref());
    }
    Ok(diagnosis)
}

fn classify_ssh_error(raw: &str, fallback: &'static str) -> &'static str {
    let low = raw.to_ascii_lowercase();
    let algo = (low.contains("no common") || low.contains("not supported"))
        && (low.contains("algorithm") || low.contains("kex") || low.contains("host key"));
    let host_key = low.contains("host key verification")
        || low.contains("host key changed")
        || low.contains("remote host identification has changed");
    let auth = low.contains("authentication")
        || low.contains("auth failed")
        || low.contains("unable to authenticate")
        || low.contains("publickey")
        || low.contains("password")
        || (low.contains("permission denied") && low.contains("publickey"));
    let permission = low.contains("permission denied");
    let not_found = low.contains("no such file")
        || low.contains("not found")
        || low.contains("does not exist")
        || low.contains("cannot find");
    let net = low.contains("timed out")
        || low.contains("timeout")
        || low.contains("refused")
        || low.contains("unreachable")
        || low.contains("no route")
        || low.contains("dns")
        || low.contains("connect")
        || low.contains("resolve");

    if algo {
        "算法不匹配（这台服务器的加密算法和我们的实现对不上：试试改用密钥/系统 ssh，或让管理员开启现代算法）"
    } else if host_key {
        "主机密钥校验失败（服务器身份和本机记录不一致，可能被中间人劫持）"
    } else if auth {
        "认证失败（用户名、密码或密钥不对，或服务器不允许这种登录方式）"
    } else if permission {
        "权限不足（远端不允许当前用户执行这个操作）"
    } else if not_found {
        "路径或文件不存在"
    } else if net {
        "连不上服务器（网络、端口、防火墙，或地址写错了）"
    } else {
        fallback
    }
}

/// 原始信息里单独成词的 ASCII `-` 换成全角冒号。
///
/// 规则：**用户能看到的所有中文分类文案都不许含 `" - "`**（2026-10 用户把孤立的
/// 破折号当成我们的 bug）。原始信息仍完整保留，只是把 `" - "` 这个分隔符换掉；
/// 路径里的 `-`、`user@host:22` 这种没有空格的连字符不受影响。
fn sanitize_raw(raw: &str) -> String {
    let cleaned = raw.replace(" - ", "：").replace("\r\n", "\n").replace('\r', "\n");
    let cleaned = cleaned.trim();
    if cleaned.is_empty() {
        "（没有更多信息）".to_string()
    } else {
        cleaned.to_string()
    }
}

/// 把 russh（纯 Rust 实现）的**英文报错**分类成中文短句，并**保留英文原文**。
///
/// 为什么要做：这些错误以前被原样透给界面 —— 例如
/// `No common Kex algorithm - ours: […], theirs: […]`（russh-0.53/src/lib.rs:183），
/// 中文提示里冒出一个孤零零的 `-`，用户只能猜（2026-10 用户报障：以为是我们打错了）。
///
/// 原文附在后面方便排查；分隔符统一是 `｜原始信息：`，且原文里的 `" - "` 会被替换掉。
pub fn friendly_ssh_error(raw: &str) -> String {
    let kind = classify_ssh_error(raw, "连接失败");
    format!("{kind}｜原始信息：{}", sanitize_raw(raw))
}

/// 带动作上下文的版本：`打开 xxx 失败` + 中文分类 + 原始信息。
///
/// SFTP / scp / 跳板机转发这类错误不能只说“连接失败”，也不能把英文原文直接
/// 拼在句子里；统一走这里，保证每个出口都是「中文短句｜原始信息：…」。
pub fn friendly_ssh_error_context(context: &str, raw: &str) -> String {
    let kind = classify_ssh_error(raw, "操作失败");
    let context = context
        .trim()
        .trim_end_matches(|c: char| c == '：' || c == ':' || c.is_whitespace());
    if context.is_empty() {
        format!("{kind}｜原始信息：{}", sanitize_raw(raw))
    } else {
        format!("{context}：{kind}｜原始信息：{}", sanitize_raw(raw))
    }
}

/// 密码模式提示文案（前端下一轮直接用）。
pub const PASSWORD_MODE_HINT: &str = "本机已有免密配置；密码模式不会使用 ~/.ssh/config 与 ssh-agent，若想免密请取消勾选『允许在终端里输入密码』";

/// 判断要不要给“密码模式”提示。
///
/// 返回 Some 的条件：**启用了允许输入密码**，且本机确实有免密条件 ——
/// `key_path` 里配了密钥、`identity_files`（`ssh -G` 解析出来的 IdentityFile）非空，
/// 或 ssh-agent 可用。否则返回 None，不打扰用户。
pub fn password_mode_hint(
    allow_password: bool,
    key_path: Option<&str>,
    identity_files: &[String],
    agent_available: bool,
) -> Option<String> {
    if !allow_password {
        return None;
    }
    let has_configured_key = key_path.map(str::trim).is_some_and(|key| !key.is_empty());
    let has_identity_file = identity_files.iter().any(|path| !path.trim().is_empty());
    if has_configured_key || has_identity_file || agent_available {
        Some(PASSWORD_MODE_HINT.to_string())
    } else {
        None
    }
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

    /// 六种最常见的 SSH 英文报错：中文分类正确、原文保留、整条文案不出现 `" - "`。
    ///
    /// 规则定死：连「｜原始信息：」里的英文也把 `" - "` 换掉，所以这里可以对
    /// 整条字符串断言 `!contains(" - ")`（见 sanitize_raw 的注释）。
    #[test]
    fn six_common_ssh_errors_are_friendly_and_have_no_stray_dash() {
        let cases = [
            (
                "No common Kex algorithm - ours: [curve25519], theirs: [diffie-hellman-group1-sha1]",
                "算法不匹配",
            ),
            ("Authentication failed", "认证失败"),
            ("Permission denied (publickey).", "认证失败"),
            ("Connection refused", "连不上服务器"),
            ("Connection timed out", "连不上服务器"),
            ("Host key verification failed.", "主机密钥校验失败"),
        ];
        for (raw, expected) in cases {
            let text = friendly_ssh_error(raw);
            assert!(text.contains(expected), "分类不对：{raw} -> {text}");
            assert!(text.contains("｜原始信息："), "要保留原始信息：{text}");
            assert!(!text.contains(" - "), "不能有孤立的破折号：{text}");
        }
    }

    /// `ssh -G` 的固定输出：字段提取、多个 identityfile、none 归一化。
    #[test]
    fn ssh_g_output_is_parsed_with_multiple_identity_files() {
        let text = r#"hostname alice.example.com
user alice
port 2222
identityfile ~/.ssh/id_ed25519
identityfile C:\keys\work
proxyjump jump.example:2200
proxycommand none
identitiesonly yes
batchmode no
"#;
        let effective = parse_ssh_g_output(text);
        assert_eq!(effective.hostname, "alice.example.com");
        assert_eq!(effective.user, "alice");
        assert_eq!(effective.port, 2222);
        assert_eq!(
            effective.identityfile,
            vec!["~/.ssh/id_ed25519".to_string(), r"C:\keys\work".to_string()]
        );
        assert_eq!(effective.proxyjump.as_deref(), Some("jump.example:2200"));
        assert_eq!(effective.proxycommand, None);
        assert_eq!(effective.identitiesonly, "yes");
        assert_eq!(effective.batchmode, "no");
    }

    /// 留空不传参：诊断和实际连接同一套口径，否则会把 config 的端口/用户顶掉。
    #[test]
    fn ssh_g_args_leave_blank_values_to_config() {
        assert_eq!(ssh_g_args("myalias", 0, "", None, None), vec!["-G", "myalias"]);
        let args = ssh_g_args("h", 2222, "alice", Some("C:\\keys\\id"), Some("jump"));
        assert!(has(&args, "-p") && has(&args, "2222"), "{args:?}");
        assert!(has(&args, "-l") && has(&args, "alice"), "{args:?}");
        assert!(has(&args, "-i") && has(&args, "C:\\keys\\id"), "{args:?}");
        assert!(has(&args, "-J") && has(&args, "jump"), "{args:?}");
        assert_eq!(args.last().unwrap(), "h");
    }

    fn temp_home(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "zeeai-ssh-{tag}-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(dir.join(".ssh")).expect("建临时 home");
        dir
    }

    /// 缺失密钥必须标 exists=false；存在的 identityfile 排在前面，common 密钥补进列表；
    /// summary 用「~/.ssh/...」这种用户看得懂的形式。
    #[test]
    fn diagnosis_checks_key_existence_and_builds_summary() {
        let home = temp_home("diag");
        let good = home.join(".ssh").join("id_ed25519");
        std::fs::write(&good, b"test-key").expect("写测试密钥");
        let missing = home.join(".ssh").join("missing_key");
        // 故意用 `~/...` 写法：验证展开后不会和 common 列表里的同一把钥匙重复
        let text = format!(
            "hostname h\nuser alice\nport 2222\nidentityfile ~/.ssh/id_ed25519\nidentityfile {}\n",
            missing.display()
        );

        let diagnosis = diagnosis_from_output(&text, Some(&home));
        assert_eq!(diagnosis.effective.hostname, "h");
        assert_eq!(diagnosis.effective.port, 2222);
        assert!(
            diagnosis.key_files.iter().any(|k| k.path == good.to_string_lossy()
                && k.exists),
            "存在的密钥要标 exists=true：{:?}",
            diagnosis.key_files
        );
        assert!(
            diagnosis
                .key_files
                .iter()
                .any(|k| k.path == missing.to_string_lossy() && !k.exists),
            "缺失的密钥要标 exists=false：{:?}",
            diagnosis.key_files
        );
        // 常见密钥也带出来（id_ed25519 已由 identityfile 带入，不能重复）
        assert!(
            diagnosis
                .key_files
                .iter()
                .any(|k| k.path.ends_with("id_rsa")),
            "{:?}",
            diagnosis.key_files
        );
        assert_eq!(
            diagnosis
                .key_files
                .iter()
                .filter(|k| k.path.ends_with("id_ed25519"))
                .count(),
            1,
            "同一个密钥不能重复列出：{:?}",
            diagnosis.key_files
        );
        assert_eq!(
            diagnosis.summary,
            "将使用 alice@h:2222，密钥 ~/.ssh/id_ed25519（存在）"
        );

        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn password_hint_when_identity_file_is_known() {
        let identities = vec!["~/.ssh/id_ed25519".to_string()];
        assert_eq!(
            password_mode_hint(true, None, &identities, false),
            Some(PASSWORD_MODE_HINT.to_string())
        );
    }

    #[test]
    fn password_hint_when_configured_key_or_agent_is_available() {
        assert_eq!(
            password_mode_hint(true, Some("C:\\keys\\id_ed25519"), &[], false),
            Some(PASSWORD_MODE_HINT.to_string())
        );
        assert_eq!(
            password_mode_hint(true, None, &[], true),
            Some(PASSWORD_MODE_HINT.to_string())
        );
    }

    #[test]
    fn password_hint_is_silent_without_password_mode_or_free_auth() {
        assert_eq!(
            password_mode_hint(false, Some("C:\\keys\\id_ed25519"), &[], true),
            None
        );
        assert_eq!(password_mode_hint(true, None, &[], false), None);
    }
}
