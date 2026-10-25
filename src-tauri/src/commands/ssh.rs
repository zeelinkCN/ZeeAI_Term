//! SSH / SFTP 连接、诊断、远端一次性命令、tmux 面板与凭据。
//!
//! 注意和 `core/ssh.rs` 区分：这里只做 IPC 编排（读配置、跑系统 ssh、收口错误），
//! 不实现协议本身。其它子模块复用这里的 `ssh_config_for` / `run_remote_capture`。
use crate::core::{proc, remote_fs, sftp, ssh, tmux};
use crate::store;

use super::util::run_capture;

pub(super) fn ssh_config(profile_id: &str) -> Result<store::SshConfig, String> {
    let profiles = store::load()?;
    let profile = profiles
        .into_iter()
        .find(|p| p.id == profile_id)
        .ok_or_else(|| "连接配置不存在".to_string())?;
    profile
        .ssh
        .ok_or_else(|| "该配置不是 SSH 类型".to_string())
}

/// 会话级的用户名覆盖：同一条服务器配置可以用不同账号登录，
/// 远程文件浏览 / tmux 列表必须跟着这个会话实际用的账号走，否则普通用户
/// 登录后侧栏还在按配置里的 root 去读文件，权限和家目录都会对不上。
pub(super) fn ssh_config_for(
    profile_id: &str,
    user_override: Option<String>,
) -> Result<store::SshConfig, String> {
    let mut cfg = ssh_config(profile_id)?;
    if let Some(u) = user_override {
        let u = u.trim().to_string();
        if !u.is_empty() {
            cfg.user = u;
        }
    }
    Ok(cfg)
}

/// SSH 连接诊断：跑一次只读的 `ssh -G`，把本机最终生效的 hostname/port/user/
/// IdentityFile/ProxyJump 等交给前端，并标出每个候选密钥是否存在。
///
/// 不会连接服务器、不会改任何配置；系统没有 OpenSSH 客户端会返回明确中文 Err。
#[tauri::command]
pub async fn ssh_diagnose(profile_id: String) -> Result<ssh::SshDiagnosis, String> {
    log::info!("ipc: ssh_diagnose profile_id={profile_id}");
    let cfg = ssh_config(&profile_id)?;
    ssh::diagnose(
        &cfg.host,
        cfg.port,
        &cfg.user,
        cfg.key_path.as_deref(),
        cfg.jump.as_deref(),
    )
    .await
}

/// 跑一次系统 ssh 并拿输出。**失败必须变成 Err**（架构审查 minor-10）：
/// 以前失败时把 stderr 拼进正文照样返回 Ok，上层的解析器会把那句英文报错当数据
///（例如把 "Connection timed out" 当成"这台机器上没有 herdr"）。
pub(super) async fn run_ssh_capture(args: &[String]) -> Result<String, String> {
    let exe = ssh::ssh_exe();
    let (ok, text) = run_capture(std::path::Path::new(&exe), args)
        .await
        .map_err(|e| ssh::friendly_ssh_error_context("执行 SSH 命令失败", &e))?;
    if ok {
        return Ok(text);
    }
    let msg = text.trim().to_string();
    Err(ssh::friendly_ssh_error_context(
        "执行 SSH 命令失败",
        if msg.is_empty() {
            "远端命令以非零退出码结束（没有更多错误信息）"
        } else {
            &msg
        },
    ))
}

/// 跑一次 scp，失败时把 stderr 原样带出来（方便前端显示为什么没传上去）。
pub(super) async fn run_scp(args: &[String]) -> Result<(), String> {
    let exe = ssh::scp_exe();
    // 统一收口：带 CREATE_NO_WINDOW，后台 scp 不闪控制台（见 core/proc.rs）
    let mut cmd = proc::hidden_command_async(&exe);
    cmd.args(args);
    // 见 run_capture 上面的说明：一次性进程必须能"跟着未来一起被杀掉"
    cmd.kill_on_drop(true);
    // ★ 必须显式接管 stdout/stderr：`Command::output()` 会自己接管，但换成
    //   `spawn()` + `wait_with_output()` 之后**默认是继承父进程的输出** ——
    //   不写这一句，子进程的输出会直接漏到控制台，我们捕获到的是**空字符串**。
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    cmd.stdin(std::process::Stdio::null());
    let child = cmd.spawn().map_err(|e| {
        ssh::friendly_ssh_error_context("启动 scp 失败（本机需要 OpenSSH 客户端）", &e.to_string())
    })?;
    if let Some(pid) = child.id() {
        crate::core::job::assign(pid);
    }
    let out = child.wait_with_output().await.map_err(|e| {
        ssh::friendly_ssh_error_context("等待 scp 失败", &e.to_string())
    })?;
    if out.status.success() {
        return Ok(());
    }
    let mut msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if msg.is_empty() {
        msg = String::from_utf8_lossy(&out.stdout).trim().to_string();
    }
    if msg.is_empty() {
        return Err(format!(
            "scp 传输失败（退出码 {:?}，没有更多错误信息）",
            out.status.code()
        ));
    }
    Err(ssh::friendly_ssh_error_context("scp 传输失败", &msg))
}

/// 问一下这个会话当前在哪个目录。
/// tmux 会话能准确拿到（`#{pane_current_path}` 是 tmux 自己维护的），
/// 普通 shell 拿不到，只能退回家目录——那种情况前端会保持原路径。
#[tauri::command]
pub async fn remote_pwd(
    profile_id: String,
    tmux_session: Option<String>,
    user_override: Option<String>,
) -> Result<String, String> {
    let cfg = ssh_config_for(&profile_id, user_override)?;
    let cmd = match tmux_session
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(name) => format!(
            "tmux display-message -p -t {} '#{{pane_current_path}}' 2>/dev/null",
            remote_fs::sq(name)
        ),
        None => "pwd".to_string(),
    };
    let out = run_remote_capture(&profile_id, &cfg, &cmd).await?;
    let path = out
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && l.starts_with('/'))
        .next_back()
        .unwrap_or("")
        .to_string();
    if path.is_empty() {
        return Err("拿不到远端当前目录".into());
    }
    log::info!("ipc: remote_pwd -> {path}");
    Ok(path)
}

/// 列出服务器上的 tmux 会话（通过一次性 ssh 命令）。
#[tauri::command]
pub async fn tmux_list(
    profile_id: String,
    user_override: Option<String>,
) -> Result<Vec<tmux::TmuxSession>, String> {
    log::info!("ipc: tmux_list profile_id={profile_id} user={user_override:?}");
    let cfg = ssh_config_for(&profile_id, user_override)?;
    let out = run_remote_capture(&profile_id, &cfg, &tmux::list_remote_command()).await?;
    let sessions = tmux::parse_list(&out);
    log::info!("ipc: tmux_list -> {} sessions", sessions.len());
    Ok(sessions)
}

/// 结束服务器上的某个 tmux 会话。
#[tauri::command]
pub async fn tmux_kill(
    profile_id: String,
    name: String,
    user_override: Option<String>,
) -> Result<(), String> {
    log::info!("ipc: tmux_kill profile_id={profile_id} name={name}");
    let cfg = ssh_config_for(&profile_id, user_override)?;
    let _ = run_remote_capture(&profile_id, &cfg, &tmux::kill_remote_command(&name)).await?;
    Ok(())
}

/// 列出某个 tmux 会话里的窗口（给「tmux 快捷操作」面板用）
#[tauri::command]
pub async fn tmux_windows(
    profile_id: String,
    session: String,
    user_override: Option<String>,
) -> Result<Vec<tmux::TmuxWindow>, String> {
    log::info!("ipc: tmux_windows profile_id={profile_id} session={session}");
    let cfg = ssh_config_for(&profile_id, user_override)?;
    let out =
        run_remote_capture(&profile_id, &cfg, &tmux::list_windows_command(&session)).await?;
    Ok(tmux::parse_windows(&out))
}

/// 「tmux 快捷操作」面板：执行一个白名单动作。
///
/// 走的是**另开一条 ssh 跑 tmux 命令**，不是往终端里塞按键 ——
/// 好处是不用抢 `Ctrl+B` 这个 tmux 前缀，也不会因为当前窗格正在跑程序而按键失效。
#[tauri::command]
pub async fn tmux_action(
    profile_id: String,
    session: String,
    action: String,
    arg: Option<String>,
    user_override: Option<String>,
) -> Result<String, String> {
    let cmd = tmux::action_command(&session, &action, arg.as_deref())
        .ok_or_else(|| format!("不支持的操作: {action}"))?;
    log::info!("ipc: tmux_action {action} on {session}");
    let cfg = ssh_config_for(&profile_id, user_override)?;
    let out = run_remote_capture(&profile_id, &cfg, &cmd).await?;
    Ok(out.trim().to_string())
}

/// 打开一条 SFTP 连接（几个文件操作命令共用）
pub(super) async fn sftp_for(profile_id: &str, user_override: Option<String>) -> Result<sftp::SftpConn, String> {
    let cfg = ssh_config_for(profile_id, user_override)?;
    let pw = password_for(profile_id, &cfg);
    sftp::connect(
        &cfg.host,
        cfg.port,
        &cfg.user,
        cfg.key_path.as_deref(),
        pw.as_deref(),
        cfg.jump.as_deref(),
    )
    .await
}

/// 这个配置要不要用凭据管理器里的密码（只有显式开了「允许输入密码」才取）
pub(super) fn password_for(profile_id: &str, cfg: &store::SshConfig) -> Option<String> {
    if cfg.allow_password {
        crate::core::secret::get_password(profile_id)
    } else {
        None
    }
}

/// 一次性远端命令的超时上限。
///
/// 为什么必须有：下游的 AI 看板探针（`ai_tasks_remote` / `ai_session_snapshot`）是每 10~20 秒
/// 打一轮的，而系统 ssh **没有配 ConnectTimeout / ServerAliveInterval**（Windows OpenSSH 带
/// `-o ConnectTimeout` 会额外空等，所以刻意没加）。一旦服务器 sshd 排队或网络黑洞，
/// `Cmd::output()` 可能几十分钟不返回 —— 前端 `refreshBoard` 的 `boardBusy` 守卫就永远
/// 松不下来，**看板从此再也不刷新**（`App.tsx:938-985`）。所以在这里兜一层超时：
/// 超时算这次探测失败，调用方本来就把"探测失败"当非致命错误处理。
const REMOTE_CAPTURE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

/// 跑一条一次性远端命令：有密码就用 russh exec（系统 ssh 喂不了密码），
/// 否则还是走系统 ssh（更快，也复用用户的 known_hosts / config）。
///
/// 整条链路（连接 + 执行 + 读输出）都套在 [`REMOTE_CAPTURE_TIMEOUT`] 里。
pub(super) async fn run_remote_capture(
    profile_id: &str,
    cfg: &store::SshConfig,
    command: &str,
) -> Result<String, String> {
    let inner = async {
        if let Some(pw) = password_for(profile_id, cfg) {
            let conn = sftp::connect(
                &cfg.host,
                cfg.port,
                &cfg.user,
                cfg.key_path.as_deref(),
                Some(&pw),
                cfg.jump.as_deref(),
            )
            .await?;
            return sftp::exec(&conn, command).await;
        }
        let args = ssh::ssh_exec_args(
            &cfg.host,
            cfg.port,
            &cfg.user,
            cfg.key_path.as_deref(),
            command,
            cfg.jump.as_deref(),
        );
        run_ssh_capture(&args).await
    };
    match tokio::time::timeout(REMOTE_CAPTURE_TIMEOUT, inner).await {
        Ok(r) => r,
        Err(_) => Err(format!(
            "远端命令超时（超过 {} 秒没返回），已放弃本次探测",
            REMOTE_CAPTURE_TIMEOUT.as_secs()
        )),
    }
}

// 说明：曾经有过「一键安装」（后端直接帮你在服务器上跑 npm/pip）。
// 实测体验不好：安装要几分钟、中间没有输出，看着像卡死；而且替用户在服务器上装东西本身偏重。
// 现在改成「把安装命令敲进当前终端」，进度和报错你自己看得见。
#[tauri::command]
pub fn secret_set(profile_id: String, password: String) -> Result<(), String> {
    log::info!("ipc: secret_set profile={profile_id}");
    crate::core::secret::set_password(&profile_id, &password)
}

#[tauri::command]
pub fn secret_has(profile_id: String) -> bool {
    crate::core::secret::has_password(&profile_id)
}

#[tauri::command]
pub fn secret_delete(profile_id: String) -> Result<(), String> {
    log::info!("ipc: secret_delete profile={profile_id}");
    crate::core::secret::delete_password(&profile_id)
}
