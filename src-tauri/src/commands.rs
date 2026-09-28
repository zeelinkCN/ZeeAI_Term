use base64::Engine as _;
use portable_pty::PtySize;
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;

use crate::core::{
    adb, ai, ai_sessions, ai_tasks, elevate, git, herdr, highlight, pty, remote_fs, serial, sftp,
    ssh, tmux, AiTaskRegistry, HerdrPaneRegistry, SessionEvent, SessionRegistry,
};
use crate::store::{self, ConnectionProfile, HistoryEntry, Settings};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: String,
    pub profile_id: String,
    pub title: String,
    pub kind: String,
    #[serde(default)]
    pub tmux_session: Option<String>,
    /// SSH 会话实际使用的登录用户名（可能来自本次会话的临时覆盖）
    #[serde(default)]
    pub user: Option<String>,
    #[serde(default)]
    pub host: Option<String>,
}

#[tauri::command]
pub fn list_profiles() -> Result<Vec<ConnectionProfile>, String> {
    log::info!("ipc: list_profiles");
    let profiles = store::load()?;
    log::info!("ipc: list_profiles -> {} entries", profiles.len());
    Ok(profiles)
}

#[tauri::command]
pub fn save_profile(profile: ConnectionProfile) -> Result<(), String> {
    let mut all = store::load()?;
    match all.iter_mut().find(|p| p.id == profile.id) {
        Some(existing) => *existing = profile,
        None => all.push(profile),
    }
    store::save(&all)
}

#[tauri::command]
pub fn delete_profile(id: String) -> Result<(), String> {
    let mut all = store::load()?;
    all.retain(|p| p.id != id);
    store::save(&all)
}

#[tauri::command]
pub fn open_local(
    id: String,
    shell: String,
    distro: Option<String>,
    cwd: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
    on_event: Channel<SessionEvent>,
    registry: State<'_, SessionRegistry>,
    logs: State<'_, std::sync::Arc<crate::core::session_log::LogRegistry>>,
) -> Result<SessionInfo, String> {
    log::info!(
        "ipc: open_local shell={} distro={:?} cwd={:?}",
        shell,
        distro,
        cwd
    );
    let (program, args, title) = match shell.as_str() {
        "cmd" => ("cmd.exe".to_string(), vec![], "命令提示符".to_string()),
        "wsl" => {
            let mut args: Vec<String> = vec![];
            if let Some(d) = distro.as_ref().filter(|d| !d.trim().is_empty()) {
                args.push("-d".into());
                args.push(d.clone());
            }
            ("wsl.exe".to_string(), args, "WSL".to_string())
        }
        _ => (
            "powershell.exe".to_string(),
            vec!["-NoLogo".to_string()],
            "PowerShell".to_string(),
        ),
    };

    let handle = pty::spawn(
        &id,
        "local",
        &title,
        &program,
        &args,
        cwd.as_deref().filter(|d| !d.trim().is_empty()),
        cols.unwrap_or(110),
        rows.unwrap_or(30),
        on_event,
        logs.inner().clone(),
        pty::SpawnOpts::default(),
    )?;
    registry
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .insert(id.clone(), handle);

    Ok(SessionInfo {
        id,
        profile_id: String::new(),
        title,
        kind: "local".into(),
        tmux_session: None,
        user: None,
        host: None,
    })
}

#[tauri::command]
pub fn open_ssh(
    id: String,
    profile_id: String,
    tmux_mode: Option<String>,
    tmux_name: Option<String>,
    // 会话后端：None/"tmux" = 用 tmux（默认，兼容所有老服务器）；"herdr" = 用 herdr
    backend: Option<String>,
    user_override: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
    on_event: Channel<SessionEvent>,
    registry: State<'_, SessionRegistry>,
    panes: State<'_, HerdrPaneRegistry>,
    logs: State<'_, std::sync::Arc<crate::core::session_log::LogRegistry>>,
) -> Result<SessionInfo, String> {
    log::info!(
        "ipc: open_ssh profile_id={} mode={:?} name={:?}",
        profile_id,
        tmux_mode,
        tmux_name
    );
    let profiles = store::load()?;
    let profile = profiles
        .into_iter()
        .find(|p| p.id == profile_id)
        .ok_or_else(|| "连接配置不存在".to_string())?;
    let cfg = profile
        .ssh
        .clone()
        .ok_or_else(|| "该配置不是 SSH 类型".to_string())?;
    // 允许在新建会话时临时改用户名（不改配置也能用别的账号登录）
    let effective_user = user_override
        .as_ref()
        .map(|u| u.trim().to_string())
        .filter(|u| !u.is_empty())
        .unwrap_or_else(|| cfg.user.clone());

    // "none" = 明确不用 tmux（直接给普通 shell）；"name" = 指定会话名；
    // 其他 = 按配置里的默认策略（开了就用模板名，没开就普通 shell）。
    let mode = tmux_mode.unwrap_or_else(|| "default".into());
    let use_herdr = backend.as_deref() == Some("herdr");

    // ---------- herdr 观察窗（backend = "herdr-pane"） ----------
    //
    // 这一路**不跑 herdr 自己的 TUI**，只把某个窗格的只读字节流引过来（见 core::herdr 顶部说明）。
    // 为什么值得单开一条：TUI attach 会跟别的客户端抢窗口尺寸，退出时还会留下花屏；
    // `terminal session observe` 是只读、可多开、按观察者自己的行列数渲染的。
    if backend.as_deref() == Some("herdr-pane") {
        let pane = tmux_name.clone().unwrap_or_default();
        if pane.trim().is_empty() {
            return Err("缺少 herdr 窗格号，无法打开观察窗".into());
        }
        let c = cols.unwrap_or(110);
        let r = rows.unwrap_or(30);
        let cmd = herdr::observe_command(&pane, c, r);
        let args = ssh::ssh_args(
            &cfg.host,
            cfg.port,
            &effective_user,
            cfg.key_path.as_deref(),
            Some(&cmd),
            !cfg.allow_password,
            cfg.jump.as_deref(),
        );
        let title = format!(
            "{} · herdr {}",
            profile.name,
            herdr::sanitize_pane(&pane)
        );
        let close_flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let handle = pty::spawn(
            &id,
            "ssh",
            &title,
            &ssh::ssh_exe(),
            &args,
            None,
            c,
            r,
            on_event.clone(),
            logs.inner().clone(),
            pty::SpawnOpts {
                filter: pty::Filter::HerdrObserve,
                close_flag: close_flag.clone(),
            },
        )?;
        registry
            .sessions
            .lock()
            .map_err(|e| e.to_string())?
            .insert(id.clone(), handle);
        panes.panes.lock().map_err(|e| e.to_string())?.insert(
            id.clone(),
            crate::core::session::HerdrPaneMeta {
                profile_id: profile_id.clone(),
                user: user_override
                    .as_ref()
                    .map(|u| u.trim().to_string())
                    .filter(|u| !u.is_empty()),
                pane_id: pane.clone(),
                cols: c,
                rows: r,
                channel: on_event,
                close_flag,
            },
        );
        log::info!("ipc: open_ssh(herdr-pane) pane={pane} {c}x{r} -> {id}");
        return Ok(SessionInfo {
            id,
            profile_id,
            title,
            kind: "ssh".into(),
            tmux_session: None,
            user: Some(effective_user),
            host: Some(cfg.host.clone()),
        });
    }
    let mut resolved_tmux: Option<String> = None;
    let remote_cmd = match mode.as_str() {
        // 不用 tmux：给普通 shell 注入「上报当前目录」，文件面板才能跟着 cd 走
        "none" => Some(ssh::shell_with_cwd_report()),
        "name" => {
            let name = tmux_name.unwrap_or_default();
            if name.trim().is_empty() {
                Some(ssh::shell_with_cwd_report())
            } else {
                if use_herdr {
                    // herdr 的会话名不用记进"tmux 会话"字段（那是给 tmux 面板用的）
                    Some(ssh::herdr_command(&name))
                } else {
                    resolved_tmux = Some(name.clone());
                    Some(ssh::tmux_command(&name, cfg.start_dir.as_deref()))
                }
            }
        }
        _ => {
            if use_herdr {
                let name = ssh::tmux_session_name(&cfg.tmux_template, &cfg.host, &effective_user);
                Some(ssh::herdr_command(&name))
            } else if cfg.tmux_enabled {
                let name = ssh::tmux_session_name(&cfg.tmux_template, &cfg.host, &effective_user);
                resolved_tmux = Some(name.clone());
                Some(ssh::tmux_command(&name, cfg.start_dir.as_deref()))
            } else {
                Some(ssh::shell_with_cwd_report())
            }
        }
    };

    let args = ssh::ssh_args(
        &cfg.host,
        cfg.port,
        &effective_user,
        cfg.key_path.as_deref(),
        remote_cmd.as_deref(),
        !cfg.allow_password,
        cfg.jump.as_deref(),
    );
    let program = ssh::ssh_exe();
    let title = format!("{} · {}", profile.name, cfg.host);

    let handle = pty::spawn(
        &id,
        "ssh",
        &title,
        &program,
        &args,
        None,
        cols.unwrap_or(110),
        rows.unwrap_or(30),
        on_event,
        logs.inner().clone(),
        pty::SpawnOpts::default(),
    )?;
    registry
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .insert(id.clone(), handle);

    Ok(SessionInfo {
        id,
        profile_id,
        title,
        kind: "ssh".into(),
        tmux_session: resolved_tmux,
        user: Some(effective_user),
        host: Some(cfg.host.clone()),
    })
}

#[tauri::command]
pub fn session_write(
    id: String,
    data_b64: String,
    registry: State<'_, SessionRegistry>,
) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_b64.as_bytes())
        .map_err(|e| format!("解码输入失败: {e}"))?;
    // ★ 只在这把全局锁里**取出 Arc**，拿到就放锁，再做阻塞写。
    //
    // 以前是"持着 sessions 锁 → 锁 writer → write_all + flush"一路到底：只要有一个会话
    // 的远端不再读（回显停了、管道缓冲写满），write_all 就会一直阻塞，而全局锁被它握着，
    // 于是**所有**会话操作（连 session_close 想关掉这个卡住的会话）全部排队 —— 整个应用
    // 看起来像死了，只能杀进程。Arc 本来就是共享所有权，克隆出来不需要改数据结构。
    let writer = {
        let sessions = registry.sessions.lock().map_err(|e| e.to_string())?;
        sessions
            .get(&id)
            .ok_or_else(|| "会话不存在".to_string())?
            .writer
            .clone()
    };
    let mut writer = writer.lock().map_err(|e| e.to_string())?;
    writer.write_all(&bytes).map_err(|e| e.to_string())?;
    writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn session_resize(
    id: String,
    cols: u16,
    rows: u16,
    registry: State<'_, SessionRegistry>,
) -> Result<(), String> {
    // 同 session_write：先把 Arc 拿出来、放掉全局锁，再做可能阻塞的 resize
    let master = {
        let sessions = registry.sessions.lock().map_err(|e| e.to_string())?;
        sessions
            .get(&id)
            .ok_or_else(|| "会话不存在".to_string())?
            .master
            .clone()
            .ok_or_else(|| "该会话不支持调整尺寸（例如串口）".to_string())?
    };
    let master = master.lock().map_err(|e| e.to_string())?;
    master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn session_close(
    id: String,
    registry: State<'_, SessionRegistry>,
    panes: State<'_, HerdrPaneRegistry>,
) -> Result<(), String> {
    // 先把 handle 从表里摘出来、**放掉全局锁**，再去 kill。
    // 否则 kill 的等待时间也会占着全局锁，同样会拖住别的会话。
    let handle = {
        let mut sessions = registry.sessions.lock().map_err(|e| e.to_string())?;
        sessions.remove(&id)
    };
    // herdr 观察窗还有两样东西要一起收：元信息，和那条常驻的「输入泵」。
    // 输入泵是**把 stdin 关掉**就结束（远端 `read` 拿到 EOF 自己退出），不用 kill。
    if let Ok(mut m) = panes.panes.lock() {
        m.remove(&id);
    }
    if let Ok(mut m) = panes.inputs.lock() {
        m.remove(&id);
    }
    if let Some(handle) = handle {
        if let Some(child) = handle.child.as_ref() {
            if let Ok(mut child) = child.lock() {
                let _ = child.kill();
            }
        }
    }
    Ok(())
}

// ---------- 串口 ----------

#[tauri::command]
pub fn serial_list() -> Result<Vec<serial::SerialPortInfo>, String> {
    log::info!("ipc: serial_list");
    let ports = serial::list();
    if let Ok(list) = &ports {
        log::info!("ipc: serial_list -> {} ports", list.len());
    }
    ports
}

#[tauri::command]
pub fn open_serial(
    id: String,
    path: String,
    baud: u32,
    data_bits: Option<u8>,
    stop_bits: Option<u8>,
    parity: Option<String>,
    flow_control: Option<String>,
    on_event: Channel<SessionEvent>,
    registry: State<'_, SessionRegistry>,
    logs: State<'_, std::sync::Arc<crate::core::session_log::LogRegistry>>,
) -> Result<SessionInfo, String> {
    let settings = serial::SerialSettings {
        baud,
        data_bits: data_bits.unwrap_or(8),
        stop_bits: stop_bits.unwrap_or(1),
        parity: parity.unwrap_or_else(|| "none".into()),
        flow_control: flow_control.unwrap_or_else(|| "none".into()),
    };
    log::info!("ipc: open_serial path={path} {:?}", settings);
    let title = format!("串口 · {path} · {baud}");
    let handle = serial::open(&id, &path, &settings, &title, on_event, logs.inner().clone())?;
    registry
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .insert(id.clone(), handle);
    Ok(SessionInfo {
        id,
        profile_id: String::new(),
        title,
        kind: "serial".into(),
        tmux_session: None,
        user: None,
        host: None,
    })
}

// ---------- Fastboot ----------

#[tauri::command]
pub async fn fastboot_version(app: tauri::AppHandle) -> Result<String, String> {
    let exe = adb_exe(&app).with_file_name("fastboot.exe");
    let out = run_capture(&exe, &["--version".into()]).await?;
    Ok(out.lines().next().unwrap_or("").trim().to_string())
}

#[tauri::command]
pub async fn fastboot_devices(app: tauri::AppHandle) -> Result<Vec<adb::AdbDevice>, String> {
    let exe = adb_exe(&app).with_file_name("fastboot.exe");
    let out = run_capture(&exe, &["devices".into()]).await?;
    let devices = adb::parse_fastboot_devices(&out);
    log::info!("ipc: fastboot_devices -> {} devices", devices.len());
    Ok(devices)
}

// ---------- ADB 文件管理 ----------

/// 列设备上的目录（默认 /sdcard）
#[tauri::command]
pub async fn adb_ls(
    app: tauri::AppHandle,
    serial: String,
    path: Option<String>,
) -> Result<Vec<adb::AdbFile>, String> {
    let dir = path
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .unwrap_or_else(|| "/sdcard".to_string());
    log::info!("ipc: adb_ls {serial}:{dir}");
    let exe = adb_exe(&app);
    let args = vec![
        "-s".to_string(),
        serial,
        "shell".to_string(),
        format!("ls -la '{dir}'"),
    ];
    let out = run_capture(&exe, &args).await?;
    Ok(adb::parse_ls(&out))
}

/// 从设备拉一个文件/目录到本地
#[tauri::command]
pub async fn adb_pull(
    app: tauri::AppHandle,
    serial: String,
    remote: String,
    local_dir: String,
) -> Result<String, String> {
    log::info!("ipc: adb_pull {serial}:{remote} -> {local_dir}");
    if !std::path::Path::new(&local_dir).is_dir() {
        return Err(format!("本地目录不存在: {local_dir}"));
    }
    let exe = adb_exe(&app);
    let args = vec![
        "-s".to_string(),
        serial,
        "pull".to_string(),
        remote.clone(),
        local_dir.clone(),
    ];
    let (ok, text) = run_capture_checked(&exe, &args).await?;
    if ok {
        Ok(format!("已下载到 {local_dir}"))
    } else {
        Err(text.trim().to_string())
    }
}

/// 把本地文件推到设备上
#[tauri::command]
pub async fn adb_push(
    app: tauri::AppHandle,
    serial: String,
    local_paths: Vec<String>,
    remote_dir: String,
) -> Result<String, String> {
    log::info!("ipc: adb_push -> {} items to {remote_dir}", local_paths.len());
    if local_paths.is_empty() {
        return Err("没有选择文件".into());
    }
    let exe = adb_exe(&app);
    let mut done = 0usize;
    let mut failed: Vec<String> = Vec::new();
    for lp in &local_paths {
        let args = vec![
            "-s".to_string(),
            serial.clone(),
            "push".to_string(),
            lp.clone(),
            remote_dir.clone(),
        ];
        let (ok, text) = run_capture_checked(&exe, &args).await?;
        if ok {
            done += 1;
        } else {
            failed.push(format!("{lp}: {}", text.trim()));
        }
    }
    if failed.is_empty() {
        Ok(format!("已推送 {done} 项到 {remote_dir}"))
    } else if done == 0 {
        Err(format!("推送失败：{}", failed.join("；")))
    } else {
        Ok(format!("已推送 {done} 项，{} 项失败", failed.len()))
    }
}

#[tauri::command]
pub async fn adb_rm(
    app: tauri::AppHandle,
    serial: String,
    path: String,
    is_dir: Option<bool>,
) -> Result<(), String> {
    log::info!("ipc: adb_rm {serial}:{path}");
    let exe = adb_exe(&app);
    let cmd = if is_dir.unwrap_or(false) {
        format!("rm -rf '{path}'")
    } else {
        format!("rm -f '{path}'")
    };
    let args = vec!["-s".to_string(), serial, "shell".to_string(), cmd];
    let (ok, text) = run_capture_checked(&exe, &args).await?;
    if ok {
        Ok(())
    } else {
        Err(text.trim().to_string())
    }
}

#[tauri::command]
pub async fn adb_mkdir(
    app: tauri::AppHandle,
    serial: String,
    path: String,
) -> Result<(), String> {
    log::info!("ipc: adb_mkdir {serial}:{path}");
    let exe = adb_exe(&app);
    let args = vec![
        "-s".to_string(),
        serial,
        "shell".to_string(),
        format!("mkdir -p '{path}'"),
    ];
    let (ok, text) = run_capture_checked(&exe, &args).await?;
    if ok {
        Ok(())
    } else {
        Err(text.trim().to_string())
    }
}

// ---------- Git ----------

/// 在一个目录里 `git init`（目录不存在时可先创建）。
/// 注意：这里只做「本地建仓库」，不会替用户 commit 任何东西。
#[tauri::command]
pub async fn git_init(path: String, create_dir: Option<bool>) -> Result<String, String> {
    let dir = path.trim().trim_end_matches(['\\', '/']).to_string();
    if dir.is_empty() {
        return Err("请填写要创建仓库的目录".into());
    }
    log::info!("ipc: git_init path={dir} create={create_dir:?}");
    let p = std::path::Path::new(&dir);
    if !p.exists() {
        if create_dir.unwrap_or(true) {
            std::fs::create_dir_all(p).map_err(|e| format!("创建目录失败: {e}"))?;
        } else {
            return Err(format!("目录不存在: {dir}"));
        }
    } else if !p.is_dir() {
        return Err(format!("这不是一个目录: {dir}"));
    }
    let args = vec![
        "-C".to_string(),
        dir.clone(),
        "init".to_string(),
        "-b".to_string(),
        "main".to_string(),
    ];
    let out = match run_capture(std::path::Path::new("git"), &args).await {
        Ok(o) => o,
        // 老版本 git 不支持 -b main，退回普通 git init
        Err(_) => {
            let fallback = vec!["-C".to_string(), dir.clone(), "init".to_string()];
            run_capture(std::path::Path::new("git"), &fallback).await?
        }
    };
    let text = out.trim().to_string();
    log::info!("ipc: git_init -> {text}");
    Ok(text)
}

#[tauri::command]
pub async fn git_status(path: String) -> Result<git::GitStatus, String> {
    log::info!("ipc: git_status path={path}");
    let args = vec![
        "-C".to_string(),
        path.clone(),
        "status".to_string(),
        "--porcelain=v1".to_string(),
        "-b".to_string(),
    ];
    match run_capture(std::path::Path::new("git"), &args).await {
        Ok(out) => {
            let text = out.trim();
            if text.contains("not a git repository") {
                return Ok(git::GitStatus {
                    ok: false,
                    branch: String::new(),
                    upstream: String::new(),
                    ahead: 0,
                    behind: 0,
                    files: Vec::new(),
                    message: "这个目录不是 Git 仓库".into(),
                });
            }
            let mut status = git::parse_status(&out);
            if status.branch.is_empty() && status.files.is_empty() {
                status.message = if text.is_empty() {
                    "仓库干净，没有改动".into()
                } else {
                    text.lines().take(3).collect::<Vec<_>>().join(" / ")
                };
            }
            Ok(status)
        }
        Err(e) => Ok(git::GitStatus {
            ok: false,
            branch: String::new(),
            upstream: String::new(),
            ahead: 0,
            behind: 0,
            files: Vec::new(),
            message: format!("执行 git 失败（本机需要安装 Git）: {e}"),
        }),
    }
}

fn ssh_config(profile_id: &str) -> Result<store::SshConfig, String> {
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
fn ssh_config_for(
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

async fn run_ssh_capture(args: &[String]) -> Result<String, String> {
    let exe = ssh::ssh_exe();
    run_capture(std::path::Path::new(&exe), args).await
}

/// 跑一次 scp，失败时把 stderr 原样带出来（方便前端显示为什么没传上去）。
async fn run_scp(args: &[String]) -> Result<(), String> {
    let exe = ssh::scp_exe();
    let mut cmd = tokio::process::Command::new(&exe);
    cmd.args(args);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd
        .output()
        .await
        .map_err(|e| format!("启动 scp 失败（本机需要 OpenSSH 客户端）: {e}"))?;
    if out.status.success() {
        return Ok(());
    }
    let mut msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if msg.is_empty() {
        msg = String::from_utf8_lossy(&out.stdout).trim().to_string();
    }
    if msg.is_empty() {
        msg = format!("scp 退出码 {:?}", out.status.code());
    }
    Err(msg)
}

/// 跑一个外部命令并拿到输出（隐藏控制台窗口）。
/// 注意：命令失败时也会返回 Ok（把 stderr 拼在文本里），仅供「不关心成败」的场景用。
async fn run_capture(program: &std::path::Path, args: &[String]) -> Result<String, String> {
    let mut cmd = tokio::process::Command::new(program);
    cmd.args(args);
    // 关键：一次性 ssh 命令不能弹出控制台窗口（否则界面上会闪一个黑框甚至挡住操作）
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output = cmd
        .output()
        .await
        .map_err(|e| format!("执行命令失败: {e}"))?;
    let mut text = String::from_utf8_lossy(&output.stdout).to_string();
    if !output.status.success() {
        text.push_str(&String::from_utf8_lossy(&output.stderr));
    }
    Ok(text)
}

/// 关心成败的版本：返回 (是否成功, 合并后的输出)。
async fn run_capture_checked(
    program: &std::path::Path,
    args: &[String],
) -> Result<(bool, String), String> {
    let mut cmd = tokio::process::Command::new(program);
    cmd.args(args);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output = cmd
        .output()
        .await
        .map_err(|e| format!("执行命令失败: {e}"))?;
    let mut text = String::from_utf8_lossy(&output.stdout).to_string();
    if !output.status.success() {
        text.push_str(&String::from_utf8_lossy(&output.stderr));
    }
    Ok((output.status.success(), text))
}

// ---------- Git 仓库操作（暂存 / 提交 / 历史 / 分支 / diff） ----------

/// 跑一条 git 子命令；失败时把 git 的报错原样抛出去（前端直接显示）。
async fn git_run(repo: &str, args: &[&str]) -> Result<String, String> {
    let mut full: Vec<String> = vec!["-C".into(), repo.to_string()];
    full.extend(args.iter().map(|s| s.to_string()));
    let (ok, text) = run_capture_checked(std::path::Path::new("git"), &full).await?;
    if ok {
        Ok(text)
    } else {
        let msg = text.trim().to_string();
        Err(if msg.is_empty() {
            "git 执行失败（本机需要安装 Git）".to_string()
        } else {
            msg
        })
    }
}

/// 暂存：files 为空表示全部（git add -A）
#[tauri::command]
pub async fn git_add(path: String, files: Option<Vec<String>>) -> Result<(), String> {
    log::info!("ipc: git_add path={path} files={:?}", files);
    match files.filter(|f| !f.is_empty()) {
        Some(files) => {
            let mut args: Vec<String> =
                vec!["-C".into(), path.clone(), "add".into(), "--".into()];
            args.extend(files);
            let (ok, text) = run_capture_checked(std::path::Path::new("git"), &args).await?;
            if ok {
                Ok(())
            } else {
                Err(text.trim().to_string())
            }
        }
        None => git_run(&path, &["add", "-A"]).await.map(|_| ()),
    }
}

/// 取消暂存（git restore --staged）
#[tauri::command]
pub async fn git_unstage(path: String, files: Vec<String>) -> Result<(), String> {
    log::info!("ipc: git_unstage {} files", files.len());
    if files.is_empty() {
        return git_run(&path, &["reset"]).await.map(|_| ());
    }
    let mut args: Vec<&str> = vec!["restore", "--staged", "--"];
    for f in &files {
        args.push(f);
    }
    git_run(&path, &args).await.map(|_| ())
}

/// 丢弃工作区改动（危险：会覆盖未提交的修改）
#[tauri::command]
pub async fn git_discard(path: String, files: Vec<String>) -> Result<(), String> {
    log::info!("ipc: git_discard {} files", files.len());
    let mut args: Vec<&str> = vec!["restore", "--"];
    for f in &files {
        args.push(f);
    }
    git_run(&path, &args).await.map(|_| ())
}

/// 提交（提交信息不能为空）
#[tauri::command]
pub async fn git_commit(path: String, message: String) -> Result<String, String> {
    log::info!("ipc: git_commit path={path}");
    if message.trim().is_empty() {
        return Err("提交信息不能为空".into());
    }
    git_run(&path, &["commit", "-m", message.trim()]).await
}

/// 最近提交历史
#[tauri::command]
pub async fn git_log(path: String, limit: Option<u32>) -> Result<Vec<git::GitCommit>, String> {
    let n = limit.unwrap_or(30).to_string();
    let out = git_run(
        &path,
        &[
            "log",
            "--no-color",
            &format!("-n{n}"),
            "--pretty=format:%H%x09%h%x09%an%x09%ar%x09%s",
        ],
    )
    .await?;
    Ok(git::parse_log(&out))
}

/// 本地分支列表
#[tauri::command]
pub async fn git_branches(path: String) -> Result<Vec<git::GitBranch>, String> {
    let out = git_run(
        &path,
        &[
            "branch",
            "--no-color",
            "--format=%(refname:short)%09%(HEAD)%09%(upstream:short)%09%(committerdate:relative)",
        ],
    )
    .await?;
    Ok(git::parse_branches(&out))
}

/// 切换分支；create=true 时新建并切换
#[tauri::command]
pub async fn git_checkout(
    path: String,
    branch: String,
    create: Option<bool>,
) -> Result<String, String> {
    log::info!("ipc: git_checkout {branch} create={create:?}");
    if create.unwrap_or(false) {
        git_run(&path, &["checkout", "-b", branch.trim()]).await
    } else {
        let tracked = git_run(&path, &["checkout", branch.trim()]).await;
        match tracked {
            Ok(out) => Ok(out),
            // 本地没有这个分支时，尝试从远端同名分支建一个跟踪分支
            Err(e) => {
                let remote = format!("origin/{}", branch.trim());
                match git_run(&path, &["checkout", "-b", branch.trim(), &remote]).await {
                    Ok(out) => Ok(out),
                    Err(_) => Err(e),
                }
            }
        }
    }
}

/// 看某个文件相对 HEAD 的 diff（staged=true 时看已暂存的 diff）
#[tauri::command]
pub async fn git_diff(path: String, file: String, staged: Option<bool>) -> Result<String, String> {
    let args: Vec<&str> = if staged.unwrap_or(false) {
        vec!["diff", "--cached", "--no-color", "--", file.as_str()]
    } else {
        vec!["diff", "--no-color", "--", file.as_str()]
    };
    git_run(&path, &args).await
}

/// 看某次提交的完整 diff（git show）
#[tauri::command]
pub async fn git_show(path: String, rev: String) -> Result<String, String> {
    git_run(&path, &["show", "--no-color", "--stat", "--patch", rev.trim()]).await
}

// ---------- ADB ----------

/// 优先用随应用内置的 platform-tools，其次用 PATH 里的 adb。
fn adb_exe(app: &tauri::AppHandle) -> std::path::PathBuf {
    use tauri::Manager;
    if let Ok(dir) = app.path().resource_dir() {
        let bundled = dir
            .join("resources")
            .join("platform-tools")
            .join("adb.exe");
        if bundled.exists() {
            return bundled;
        }
    }
    std::path::PathBuf::from("adb")
}

#[tauri::command]
pub async fn adb_version(app: tauri::AppHandle) -> Result<String, String> {
    let exe = adb_exe(&app);
    let out = run_capture(&exe, &["version".into()]).await?;
    Ok(out
        .lines()
        .filter(|l| !l.trim().is_empty())
        .take(2)
        .collect::<Vec<_>>()
        .join(" · "))
}

#[tauri::command]
pub async fn adb_devices(app: tauri::AppHandle) -> Result<Vec<adb::AdbDevice>, String> {
    let exe = adb_exe(&app);
    log::info!("ipc: adb_devices exe={:?}", exe);
    let out = run_capture(&exe, &["devices".into(), "-l".into()]).await?;
    let devices = adb::parse_devices(&out);
    log::info!("ipc: adb_devices -> {} devices", devices.len());
    Ok(devices)
}

#[tauri::command]
pub fn open_adb_shell(
    id: String,
    serial: String,
    mode: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
    on_event: Channel<SessionEvent>,
    app: tauri::AppHandle,
    registry: State<'_, SessionRegistry>,
    logs: State<'_, std::sync::Arc<crate::core::session_log::LogRegistry>>,
) -> Result<SessionInfo, String> {
    let exe = adb_exe(&app);
    let mode = mode.unwrap_or_else(|| "shell".to_string());
    log::info!("ipc: open_adb_shell serial={serial} mode={mode} exe={exe:?}");
    let (args, title) = match mode.as_str() {
        "logcat" => (adb::logcat_args(&serial), format!("logcat · {serial}")),
        _ => (adb::shell_args(&serial), format!("ADB · {serial}")),
    };
    let program = exe.to_string_lossy().to_string();
    let handle = pty::spawn(
        &id,
        "adb",
        &title,
        &program,
        &args,
        None,
        cols.unwrap_or(110),
        rows.unwrap_or(30),
        on_event,
        logs.inner().clone(),
        pty::SpawnOpts::default(),
    )?;
    registry
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .insert(id.clone(), handle);
    Ok(SessionInfo {
        id,
        profile_id: String::new(),
        title,
        kind: "adb".into(),
        tmux_session: None,
        user: None,
        host: None,
    })
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

/// 列出远端目录（不传 path 则用登录后的家目录）。
/// 走真 SFTP：路径是字面量，不经过远端 shell。
#[tauri::command]
pub async fn fs_list(
    profile_id: String,
    path: Option<String>,
    user_override: Option<String>,
) -> Result<remote_fs::RemoteListing, String> {
    log::info!("ipc: fs_list profile_id={profile_id} path={path:?}");
    let cfg = ssh_config_for(&profile_id, user_override)?;
    let conn = sftp_for(&profile_id, None).await?;
    let (dir, entries) = sftp::list(&conn, path.as_deref()).await?;
    let listing = remote_fs::RemoteListing {
        path: dir,
        entries: entries
            .into_iter()
            .map(|e| remote_fs::RemoteEntry {
                name: e.name,
                is_dir: e.is_dir,
                size: e.size,
            })
            .collect(),
    };
    log::info!(
        "ipc: fs_list -> {} entries at {}",
        listing.entries.len(),
        listing.path
    );
    Ok(listing)
}

/// 读取文件并返回 base64（二进制安全），最多 max_bytes 字节。
#[tauri::command]
pub async fn fs_read(
    profile_id: String,
    path: String,
    max_bytes: Option<u64>,
    user_override: Option<String>,
) -> Result<String, String> {
    log::info!("ipc: fs_read profile_id={profile_id} path={path}");
    let conn = sftp_for(&profile_id, user_override).await?;
    let limit = max_bytes.unwrap_or(512 * 1024);
    let data = sftp::read_file(&conn, &path, limit).await?;
    Ok(base64::engine::general_purpose::STANDARD.encode(data))
}

// ---------- 远端文件写操作（上传 / 下载 / 新建目录 / 重命名 / 删除） ----------

/// 上传本地文件（或整个目录）到远端某个目录。返回一句人话结果。
#[tauri::command]
pub async fn fs_upload(
    profile_id: String,
    local_paths: Vec<String>,
    remote_dir: String,
    user_override: Option<String>,
    task_id: Option<String>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    log::info!("ipc: fs_upload -> {} items to {}", local_paths.len(), remote_dir);
    if local_paths.is_empty() {
        return Err("没有选择要上传的文件".into());
    }
    let dir = remote_dir.trim_end_matches('/').to_string();
    let dir = if dir.is_empty() { "/".to_string() } else { dir };
    let conn = sftp_for(&profile_id, user_override).await?;

    let mut done = 0usize;
    let mut bytes = 0u64;
    let task = task_id.unwrap_or_else(|| "upload".to_string());
    let emit = |ev: TransferEvent| {
        use tauri::Emitter;
        let _ = app.emit("zeeai://transfer", ev);
    };
    let mut failed: Vec<String> = Vec::new();
    for lp in &local_paths {
        let p = std::path::Path::new(lp);
        if !p.exists() {
            failed.push(format!("{lp}: 本地不存在"));
            continue;
        }
        let Some(name) = p.file_name().map(|n| n.to_string_lossy().to_string()) else {
            failed.push(format!("{lp}: 无法识别文件名"));
            continue;
        };
        let remote_path = if dir == "/" {
            format!("/{name}")
        } else {
            format!("{dir}/{name}")
        };
        emit(TransferEvent::Start {
            task: task.clone(),
            name: name.clone(),
            total: 0,
        });
        let name_for_sink = name.clone();
        let task_for_sink = task.clone();
        let app_for_sink = app.clone();
        let progress = move |d: u64, t: u64| {
            use tauri::Emitter;
            let _ = app_for_sink.emit(
                "zeeai://transfer",
                TransferEvent::Progress {
                    task: task_for_sink.clone(),
                    name: name_for_sink.clone(),
                    done: d,
                    total: t,
                },
            );
        };
        match sftp::upload(&conn, p, &remote_path, &progress).await {
            Ok(n) => {
                done += 1;
                bytes += n;
                emit(TransferEvent::FileDone {
                    task: task.clone(),
                    name: name.clone(),
                    bytes: n,
                });
            }
            Err(e) => {
                emit(TransferEvent::FileFailed {
                    task: task.clone(),
                    name: name.clone(),
                    message: e.clone(),
                });
                failed.push(format!("{name}: {e}"));
            }
        }
    }

    emit(TransferEvent::AllDone {
        task: task.clone(),
        ok: done,
        failed: failed.len(),
    });

    if failed.is_empty() {
        Ok(format!("已上传 {done} 项（{}）到 {dir}", human_size(bytes)))
    } else if done == 0 {
        Err(format!("上传失败：{}", failed.join("；")))
    } else {
        Ok(format!(
            "已上传 {done} 项，{} 项失败：{}",
            failed.len(),
            failed.join("；")
        ))
    }
}

/// 把远端文件/目录下载到本地某个目录。
#[tauri::command]
pub async fn fs_download(
    profile_id: String,
    remote_paths: Vec<String>,
    local_dir: String,
    user_override: Option<String>,
    task_id: Option<String>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    log::info!("ipc: fs_download -> {} items to {}", remote_paths.len(), local_dir);
    if remote_paths.is_empty() {
        return Err("没有选择要下载的文件".into());
    }
    if !std::path::Path::new(&local_dir).is_dir() {
        return Err(format!("本地目录不存在: {local_dir}"));
    }
    let conn = sftp_for(&profile_id, user_override).await?;

    let mut done = 0usize;
    let mut bytes = 0u64;
    let task = task_id.unwrap_or_else(|| "download".to_string());
    let emit = |ev: TransferEvent| {
        use tauri::Emitter;
        let _ = app.emit("zeeai://transfer", ev);
    };
    let mut failed: Vec<String> = Vec::new();
    for rp in &remote_paths {
        if !sftp::exists(&conn, rp).await {
            failed.push(format!("{rp}: 远端不存在"));
            continue;
        }
        let name = rp
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            .unwrap_or("download")
            .to_string();
        let target = std::path::Path::new(&local_dir).join(&name);
        emit(TransferEvent::Start {
            task: task.clone(),
            name: name.clone(),
            total: 0,
        });
        let task_for_sink = task.clone();
        let name_for_sink = name.clone();
        let app_for_sink = app.clone();
        let progress = move |d: u64, t: u64| {
            use tauri::Emitter;
            let _ = app_for_sink.emit(
                "zeeai://transfer",
                TransferEvent::Progress {
                    task: task_for_sink.clone(),
                    name: name_for_sink.clone(),
                    done: d,
                    total: t,
                },
            );
        };
        match sftp::download(&conn, rp, &target, &progress).await {
            Ok(n) => {
                done += 1;
                bytes += n;
                emit(TransferEvent::FileDone {
                    task: task.clone(),
                    name: name.clone(),
                    bytes: n,
                });
            }
            Err(e) => {
                emit(TransferEvent::FileFailed {
                    task: task.clone(),
                    name: name.clone(),
                    message: e.clone(),
                });
                failed.push(format!("{rp}: {e}"));
            }
        }
    }

    emit(TransferEvent::AllDone {
        task: task.clone(),
        ok: done,
        failed: failed.len(),
    });

    if failed.is_empty() {
        Ok(format!("已下载 {done} 项（{}）到 {local_dir}", human_size(bytes)))
    } else if done == 0 {
        Err(format!("下载失败：{}", failed.join("；")))
    } else {
        Ok(format!(
            "已下载 {done} 项，{} 项失败：{}",
            failed.len(),
            failed.join("；")
        ))
    }
}

/// 传输进度事件：前端拿它画进度条
#[derive(Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum TransferEvent {
    /// 开始处理某个文件
    Start { task: String, name: String, total: u64 },
    /// 传输中
    Progress {
        task: String,
        name: String,
        done: u64,
        total: u64,
    },
    /// 某个文件完成
    FileDone { task: String, name: String, bytes: u64 },
    /// 某个文件失败
    FileFailed {
        task: String,
        name: String,
        message: String,
    },
    /// 整批完成
    AllDone {
        task: String,
        ok: usize,
        failed: usize,
    },
}

/// 把传输/下载进度推给前端（右下角进度面板监听 `zeeai://transfer`）。
fn emit_transfer(app: &tauri::AppHandle, ev: TransferEvent) {
    use tauri::Emitter;
    let _ = app.emit("zeeai://transfer", ev);
}

fn human_size(n: u64) -> String {
    const UNITS: [&str; 4] = ["B", "KB", "MB", "GB"];
    let mut v = n as f64;
    let mut i = 0;
    while v >= 1024.0 && i < UNITS.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    if i == 0 {
        format!("{n} B")
    } else {
        format!("{v:.1} {}", UNITS[i])
    }
}

/// 打开一条 SFTP 连接（几个文件操作命令共用）
async fn sftp_for(profile_id: &str, user_override: Option<String>) -> Result<sftp::SftpConn, String> {
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
fn password_for(profile_id: &str, cfg: &store::SshConfig) -> Option<String> {
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
async fn run_remote_capture(
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

// ---------- 凭据（Windows 凭据管理器） ----------

// ---------- 服务器上的 AI 命令行工具 ----------

/// 探测这台服务器上装了哪些 AI CLI、npm 有没有、有没有正在跑的
#[tauri::command]
pub async fn ai_probe(
    profile_id: String,
    user_override: Option<String>,
) -> Result<ai::AiProbe, String> {
    let cfg = ssh_config_for(&profile_id, user_override)?;
    let out = run_remote_capture(&profile_id, &cfg, &ai::probe_script()).await?;
    let probe = ai::parse_probe(&out);
    log::info!(
        "ipc: ai_probe -> {} 个工具，npm={:?}，运行中={:?}",
        probe.tools.len(),
        probe.npm,
       probe.running
   );
   Ok(probe)
}

/// 终端关键字高亮的预设规则包（前端「载入预设规则」按钮用）。
/// 规则本体存在 settings.json 里，这里只给一份出厂预设。
#[tauri::command]
pub fn highlight_presets() -> Vec<highlight::HighlightRule> {
    highlight::presets()
}

// ---------- 管理员模式（提权） ----------

/// 当前应用是不是以管理员身份在跑（状态栏要显示一个"管理员"标）
#[tauri::command]
pub fn is_admin() -> bool {
    elevate::is_elevated()
}

/// 以管理员身份重启整个应用：过一次 UAC，之后开的 PowerShell / CMD 天然都是管理员。
///
/// 为什么不给"单个标签页提权"：终端是我们用 ConPTY 建的，伪控制台挂在普通权限进程上，
/// Windows 不允许管理员子进程挂进去（详见 core::elevate 的说明）。
#[tauri::command]
pub fn restart_as_admin(app: tauri::AppHandle) -> Result<(), String> {
    log::info!("ipc: restart_as_admin");
    elevate::relaunch_self_elevated()?;
    // 新实例起来之后再退出（走正常退出路径，顺手把会话进程收干净）
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(1500));
        log::info!("admin: 退出旧实例，交给管理员实例接管");
        app.exit(0);
    });
    Ok(())
}

/// 以管理员身份单独开一个 PowerShell / CMD 窗口（不在我们的标签里，但立刻有管理员权限）
#[tauri::command]
pub fn open_admin_shell(shell: String) -> Result<(), String> {
    log::info!("ipc: open_admin_shell shell={shell}");
    elevate::open_elevated_shell(&shell)
}

// ---------- AI 任务看板（v1） ----------

/// 记一笔「App 自己在某个会话里启动了某个 AI 工具」。
/// 这一层是最精确的信号源：开始时间、跑没跑完都由 App 自己判，不靠猜。
#[tauri::command]
pub fn ai_task_note_start(
    tasks: State<'_, AiTaskRegistry>,
    env: String,
    server: String,
    tool: String,
    command: String,
) -> ai_tasks::AiTask {
    log::info!("ipc: ai_task_note_start env={env} server={server} tool={tool}");
    tasks.note_start(&env, &server, &tool, &command, store::now_secs() as i64)
}

/// 远端任务快照：tmux 窗格（能精确到 pane）+ ps 扫描，再和 App 自己启动的合并。
#[tauri::command]
pub async fn ai_tasks_remote(
    tasks: State<'_, AiTaskRegistry>,
    profile_id: String,
    server: String,
    user_override: Option<String>,
) -> Result<Vec<ai_tasks::AiTask>, String> {
    let cfg = ssh_config_for(&profile_id, user_override)?;
    let detected = match run_remote_capture(&profile_id, &cfg, &ai_tasks::remote_script()).await {
        Ok(out) => {
            let scan = ai_tasks::parse_remote(&out);
            Some(ai_tasks::classify(&scan, "remote", &server))
        }
        Err(e) => {
            // 探测失败不是致命错误：App 自己启动的那批照样显示，只是状态停在上一次
            log::warn!("ai_tasks_remote 探测失败：{e}");
            None
        }
    };
    Ok(tasks.merge("remote", &server, detected, store::now_secs() as i64))
}

/// 本机任务快照。
///
/// - `powershell`：用系统自带的 `Get-CimInstance Win32_Process` 读 CommandLine。
///   全进程表扫描偏重，所以前端只在真有本机会话时、15~30 秒才调一次；
/// - `wsl`：**进 WSL 里面**扫（Windows 侧只能看到 wslhost/vmmem，看不见里面的进程）；
/// - `cmd`：CMD 没有脚本钩子，本阶段只给「仅状态」，不为它扫进程表。
#[tauri::command]
pub async fn ai_tasks_local(
    tasks: State<'_, AiTaskRegistry>,
    shell: String,
    server: String,
    distro: Option<String>,
) -> Result<Vec<ai_tasks::AiTask>, String> {
    let env = if shell == "wsl" { "wsl" } else { "local" };
    let detected = match shell.as_str() {
        "cmd" => None,
        "wsl" => {
            let mut args: Vec<String> = Vec::new();
            if let Some(d) = distro.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
                args.push("-d".into());
                args.push(d.to_string());
            }
            args.push("--".into());
            args.push("sh".into());
            args.push("-c".into());
            args.push(ai_tasks::remote_script());
            match run_capture_checked(std::path::Path::new("wsl.exe"), &args).await {
                Ok((true, out)) => {
                    let scan = ai_tasks::parse_remote(&out);
                    let mut list = ai_tasks::classify(&scan, env, &server);
                    for t in list.iter_mut() {
                        t.source = "ps".into();
                    }
                    Some(list)
                }
                Ok((false, out)) => {
                    log::warn!("ai_tasks_local(wsl) 失败：{}", out.trim());
                    None
                }
                Err(e) => {
                    log::warn!("ai_tasks_local(wsl) 失败：{e}");
                    None
                }
            }
        }
        _ => {
            let args = vec![
                "-NoProfile".to_string(),
                "-NonInteractive".to_string(),
                "-Command".to_string(),
                ai_tasks::windows_script(),
            ];
            match run_capture_checked(std::path::Path::new("powershell.exe"), &args).await {
                Ok((true, out)) => {
                    let scan = ai_tasks::scan_windows(&out);
                    let mut list = ai_tasks::classify(&scan, env, &server);
                    for t in list.iter_mut() {
                        t.source = "winproc".into();
                    }
                    Some(list)
                }
                Ok((false, out)) => {
                    log::warn!("ai_tasks_local(powershell) 失败：{}", out.trim());
                    None
                }
                Err(e) => {
                    log::warn!("ai_tasks_local(powershell) 失败：{e}");
                    None
                }
            }
        }
    };
    Ok(tasks.merge(env, &server, detected, store::now_secs() as i64))
}

/// 清掉某个环境里「已结束」的卡片（还在跑的不动）
#[tauri::command]
pub fn ai_tasks_clear_finished(tasks: State<'_, AiTaskRegistry>, env: String, server: String) {
    log::info!("ipc: ai_tasks_clear_finished env={env} server={server}");
    tasks.clear_finished(&env, &server);
}

/// 读 Codex 的会话日志，给出"有没有新消息 / 在跑还是在等我 / 耗时 / token 用量"。
///
/// 这一层比"进程还在不在"准得多：进程只能说明跑着，而日志里有 `task_complete`
/// （带 AI 最后一段话和耗时）和 `token_count`（带本轮与累计用量、上下文窗口）。
/// 远端走一条 ssh 命令读 `~/.codex/sessions` 里最新那个 rollout 的尾巴；
/// 本机/WSL 直接读文件。CMD 没有这个概念，返回 None。
#[tauri::command]
pub async fn ai_session_snapshot(
    profile_id: Option<String>,
    user_override: Option<String>,
    shell: Option<String>,
    distro: Option<String>,
) -> Result<Option<ai_sessions::AiSessionSnapshot>, String> {
    if let Some(pid) = profile_id.as_deref().filter(|s| !s.trim().is_empty()) {
        let cfg = ssh_config_for(pid, user_override)?;
        let out = run_remote_capture(pid, &cfg, &ai_sessions::remote_tail_script()).await?;
        let snap = ai_sessions::parse_script_output(&out);
        log::info!(
            "ipc: ai_session_snapshot(remote) -> state={:?} tokens={:?}",
            snap.as_ref().map(|s| s.state.as_str()),
            snap.as_ref().and_then(|s| s.usage.as_ref()).map(|u| u.total)
        );
        return Ok(snap);
    }
    match shell.as_deref().unwrap_or("powershell") {
        "cmd" => Ok(None),
        "wsl" => {
            let mut args: Vec<String> = Vec::new();
            if let Some(d) = distro.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
                args.push("-d".into());
                args.push(d.to_string());
            }
            args.push("--".into());
            args.push("sh".into());
            args.push("-c".into());
            args.push(ai_sessions::remote_tail_script());
            match run_capture_checked(std::path::Path::new("wsl.exe"), &args).await {
                Ok((true, out)) => Ok(ai_sessions::parse_script_output(&out)),
                _ => Ok(None),
            }
        }
        _ => Ok(ai_sessions::local_snapshot()),
    }
}

/// 任务产物：`cwd` 下在 `since`（Unix 秒）之后被新增/修改的文件。
///
/// 这一步是为了回答"AI 刚给我生成了什么"—— 日志里只有它干了活，产物得去目录里找。
/// 远端走 `find -newermt`，本机/WSL 走文件系统遍历，两边都限制深度和条数。
#[tauri::command]
pub async fn ai_task_artifacts(
    profile_id: Option<String>,
    user_override: Option<String>,
    shell: Option<String>,
    distro: Option<String>,
    cwd: String,
    since: i64,
) -> Result<Vec<ai_sessions::AiArtifact>, String> {
    let cwd = cwd.trim().to_string();
    if cwd.is_empty() {
        return Ok(Vec::new());
    }
    if let Some(pid) = profile_id.as_deref().filter(|s| !s.trim().is_empty()) {
        let cfg = ssh_config_for(pid, user_override)?;
        let script = ai_sessions::remote_artifacts_script(&cwd, since);
        let out = run_remote_capture(pid, &cfg, &script).await?;
        let list = ai_sessions::parse_artifacts(&out);
        log::info!("ipc: ai_task_artifacts(remote {cwd}) -> {} 个", list.len());
        return Ok(list);
    }
    match shell.as_deref().unwrap_or("powershell") {
        "cmd" => Ok(Vec::new()),
        "wsl" => {
            let mut args: Vec<String> = Vec::new();
            if let Some(d) = distro.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
                args.push("-d".into());
                args.push(d.to_string());
            }
            args.push("--".into());
            args.push("sh".into());
            args.push("-c".into());
            args.push(ai_sessions::remote_artifacts_script(&cwd, since));
            match run_capture_checked(std::path::Path::new("wsl.exe"), &args).await {
                Ok((true, out)) => Ok(ai_sessions::parse_artifacts(&out)),
                _ => Ok(Vec::new()),
            }
        }
        _ => Ok(ai_sessions::local_artifacts(&cwd, since)),
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

#[tauri::command]
pub async fn fs_mkdir(
    profile_id: String,
    path: String,
    user_override: Option<String>,
) -> Result<(), String> {
    log::info!("ipc: fs_mkdir path={path}");
    let conn = sftp_for(&profile_id, user_override).await?;
    sftp::mkdir(&conn, &path).await
}

#[tauri::command]
pub async fn fs_remove(
    profile_id: String,
    path: String,
    user_override: Option<String>,
) -> Result<(), String> {
    log::info!("ipc: fs_remove path={path}");
    let conn = sftp_for(&profile_id, user_override).await?;
    sftp::remove(&conn, &path).await
}

#[tauri::command]
pub async fn fs_rename(
    profile_id: String,
    from: String,
    to: String,
    user_override: Option<String>,
) -> Result<(), String> {
    log::info!("ipc: fs_rename from={from} to={to}");
    let conn = sftp_for(&profile_id, user_override).await?;
    sftp::rename(&conn, &from, &to).await
}

// ---------- 会话历史 ----------

// ---------- 终端会话日志 ----------

/// 开始记录某个会话的终端输出，返回日志文件路径
#[tauri::command]
pub fn session_log_start(
    id: String,
    file_name: Option<String>,
    logs: State<'_, std::sync::Arc<crate::core::session_log::LogRegistry>>,
) -> Result<String, String> {
    logs.start(&id, file_name.as_deref())
}

/// 停止记录，返回刚刚写过的文件路径
#[tauri::command]
pub fn session_log_stop(
    id: String,
    logs: State<'_, std::sync::Arc<crate::core::session_log::LogRegistry>>,
) -> Option<String> {
    logs.stop(&id)
}

/// 这个会话正在记日志吗？是的话返回文件路径
#[tauri::command]
pub fn session_log_status(
    id: String,
    logs: State<'_, std::sync::Arc<crate::core::session_log::LogRegistry>>,
) -> Option<String> {
    logs.status(&id)
}

/// 会话日志目录（不存在会创建）
#[tauri::command]
pub fn session_log_dir() -> Result<String, String> {
    let dir = crate::core::session_log::LogRegistry::dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建日志目录失败: {e}"))?;
    Ok(dir.to_string_lossy().to_string())
}

/// 用资源管理器打开一个文件或目录
#[tauri::command]
pub fn open_in_explorer(path: String) -> Result<(), String> {
    log::info!("ipc: open_in_explorer {path}");
    #[cfg(windows)]
    {
        std::process::Command::new("explorer.exe")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("打开失败: {e}"))?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        Err("只支持 Windows".into())
    }
}

/// 用系统默认浏览器打开一个 http/https 链接（用于「检查更新 → 下载新版」）
#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), String> {
    let trimmed = url.trim();
    if !(trimmed.starts_with("https://") || trimmed.starts_with("http://")) {
        return Err("只允许打开 http/https 链接".into());
    }
    log::info!("ipc: open_external_url {trimmed}");
    #[cfg(windows)]
    {
        // 用 cmd 的 start 走默认浏览器；空标题参数是为了防止带引号的 URL 被当成窗口标题
        std::process::Command::new("cmd")
            .args(["/C", "start", "", trimmed])
            .spawn()
            .map_err(|e| format!("打开浏览器失败: {e}"))?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = trimmed;
        Err("只支持 Windows".into())
    }
}

// ---------- 一键升级：下载新版安装包 → 静默覆盖安装 → 自动重启 ----------

/// 允许自动下载安装的**唯一来源**前缀（本项目自己的 Release）。
///
/// 「不要下错」这条要求的底线：只有这个前缀下的地址才允许走"下载并静默执行"这条链路。
const UPDATE_REPO_PREFIX: &str = "https://github.com/zeelinkCN/ZeeAI_Term/releases/download/";

/// 当前这份是怎么装上的：`nsis` / `msi` / `portable`。
///
/// - `nsis`：我们的 NSIS 安装包按当前用户装到 `%LOCALAPPDATA%\ZeeAI_Term\`，
///   可以用 `/S`（静默）+ `/R`（装完自动重启）一键覆盖；
/// - `msi`：WiX 的 MSI 是 perMachine，装在 `%ProgramFiles%\ZeeAI_Term\`，
///   没有 `/S /R` 这种开关，只能走 `msiexec /i <msi> /qb /norestart`（会弹一次 UAC）；
/// - `portable`：解压在任意目录，只能手动替换文件。
#[tauri::command]
pub fn update_install_kind() -> String {
    let Ok(exe) = std::env::current_exe() else {
        return "portable".into();
    };
    let exe_l = exe.to_string_lossy().to_lowercase();
    let under = |base: String| -> bool {
        let base = base.to_lowercase();
        let base = base.trim_end_matches('\\');
        !base.is_empty() && exe_l.starts_with(&format!("{base}\\zeeai_term\\"))
    };
    let kind = if under(std::env::var("LOCALAPPDATA").unwrap_or_default()) {
        "nsis"
    } else if under(std::env::var("ProgramFiles").unwrap_or_default())
        || under(std::env::var("ProgramFiles(x86)").unwrap_or_default())
    {
        "msi"
    } else {
        "portable"
    };
    log::info!("ipc: update_install_kind -> {kind} ({exe_l})");
    kind.to_string()
}

/// 上一次「一键升级」的结果（安装器退出码 / 失败原因）。
///
/// 升级脚本会把 `installer exit=…` 写进 `%TEMP%\ZeeAI-Term-update\apply_update.log`，
/// 这里读一次就删掉，前端拿它在状态栏提示一行（不弹浮层）。
/// 0.1.5 的教训：升级失败时用户什么都看不到，只能干等。
#[tauri::command]
pub fn update_take_result() -> Option<String> {
    let path = std::env::temp_dir()
        .join("ZeeAI-Term-update")
        .join("apply_update.log");
    let text = std::fs::read_to_string(&path).ok()?;
    let _ = std::fs::remove_file(&path);
    let t = text.trim().to_string();
    if t.is_empty() {
        None
    } else {
        log::info!("ipc: update_take_result -> {t}");
        Some(t)
    }
}

/// 下载新版安装包并做校验（大小 + 文件头 + 官方 sha256），返回落盘路径。
///
/// 为什么要绕这么一圈：
/// - **不用第三方 HTTP 库**：直接用 Windows 自带的 `curl.exe`（Win10 1803+ 内置，
///   走系统 Schannel），不往程序里塞一整套 TLS 栈，exe 体积不变；
/// - **单请求整包下载**：0.1.5 试过"按 1MB 分段发 Range 请求接着下"，结果并发写同一个
///   文件把包写坏了（那次事故见 `docs/decisions.md`），所以现在是**一次请求下完整个包**；
///   但失败不会永远从 0 重来 —— `.part` 留着，下一次（包括重启应用之后）用 `curl -C -`
///   从已有字节接着下。注意这是**单请求续传**，不是分片并发写；
/// - **抽成独立函数**：`examples/update_spike.rs` 可以拿真实 Release 地址直接验证。
///
/// 最多试三次，每次策略不同：① 有系统代理先用代理（带续传）；② 去掉代理走直连（带续传）；
/// ③ 丢掉 `.part` 从 0 来一遍。**只有网络层失败才保留 `.part`** —— 校验不过说明内容本身
/// 有问题，续传只会把坏内容续成"完整的坏包"，直接丢弃。
pub fn fetch_update_package(
    url: &str,
    expected_size: u64,
    expected_sha: Option<&str>,
    ext: &str,
    version: &str,
    mut on_progress: impl FnMut(u64, u64),
) -> Result<std::path::PathBuf, String> {
    let curl = find_curl().ok_or_else(|| {
        "找不到系统自带的 curl.exe（Windows 10 1803 以上都自带），请改用手动下载".to_string()
    })?;
    let dir = std::env::temp_dir().join("ZeeAI-Term-update");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建下载目录失败: {e}"))?;
    let safe_version: String = version
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' { c } else { '_' })
        .collect();
    let dest = dir.join(format!("ZeeAI_Term_{safe_version}_setup.{ext}"));
    // 临时名：校验全过之前，这个文件永远不算"下好了"
    let part = dir.join(format!("ZeeAI_Term_{safe_version}_setup.{ext}.part"));
    // 顺手清掉**别的版本**留下的残留（每个包 9~14MB，不清会一直堆在 %TEMP% 里）
    sweep_update_dir(&dir, &[&dest, &part]);
    // 有系统代理就先用代理试（国内直连 GitHub 的下载 CDN 经常慢到几乎不动），
    // 第二次改成直连，避免"代理开着但其实没启动"时彻底下不来。
    let proxy = system_proxy();

    // 上一次（甚至上一次开应用时）留下的半截文件：能续就续，别再从头下一遍
    let leftover = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0) > 0;
    let plans: [(bool, bool); 3] = [
        (proxy.is_some(), leftover),
        (false, leftover),
        (false, false),
    ];

    let mut last_err = String::new();
    for (step, (use_proxy, resume)) in plans.into_iter().enumerate() {
        let attempt = step + 1;
        let use_proxy = if use_proxy { proxy.as_deref() } else { None };
        log::info!(
            "update: 第 {attempt} 次整包下载 {url}（proxy={use_proxy:?}，续传={resume}，期望 {expected_size} 字节）"
        );
        match run_curl_download(
            &curl,
            url,
            &part,
            expected_size,
            use_proxy,
            resume,
            &mut on_progress,
        ) {
            // 网络层失败（断流 / 超时）：`.part` 留着，下一次接着下
            Err(e) => last_err = e,
            Ok(()) => match package_problem(&part, ext, expected_size, expected_sha) {
                None => {
                    // 校验全过 → 原子改名成正式包
                    let _ = std::fs::remove_file(&dest);
                    std::fs::rename(&part, &dest).map_err(|e| format!("重命名更新包失败: {e}"))?;
                    let done = std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
                    on_progress(done, done);
                    log::info!("update: 更新包已下好并校验通过 {}", dest.display());
                    return Ok(dest);
                }
                // 内容本身不对（大小不符 / 文件头不对 / sha256 对不上）：留下只会续成坏包
                Some(why) => {
                    last_err = why;
                    let _ = std::fs::remove_file(&part);
                }
            },
        }
        log::warn!("update: 第 {attempt} 次下载/校验没过：{last_err}");
        // 文件已经"下满"却仍然失败（例如续传时本地文件本来就完整、服务器回 416），
        // 说明这半截文件不可信：丢掉，让下一次从 0 来
        let size = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
        if expected_size > 0 && size >= expected_size {
            let _ = std::fs::remove_file(&part);
        }
        if attempt < 3 {
            std::thread::sleep(std::time::Duration::from_millis(if attempt == 1 { 1500 } else { 500 }));
        }
    }
    Err(format!("更新包下载或校验失败（已自动重试两次）：{last_err}"))
}

/// 清掉下载目录里**别的版本**留下的残留（安装包、半截的 `.part`、curl 的 `.stderr`）。
///
/// 为什么需要：老的升级脚本只在**失败**时删包，成功就直接结束 —— 每升一次就在 `%TEMP%`
/// 留一份 9.15MB（NSIS）/ 14.08MB（MSI），升十个版本就是上百 MB，而且不在"磁盘清理"的
/// 常规视野里。脚本那边已经补成"成功也删包"（见 [`apply_update_script`]），这里再兜一层：
/// 万一用户升级到一半把应用杀了、脚本没跑完，下次下载时也顺手收干净。
///
/// `keep` 里的路径（本次要用的正式名和临时名）不动；只删我们自己命名的文件，
/// 不碰用户可能放在同一个目录里的别的东西。
fn sweep_update_dir(dir: &std::path::Path, keep: &[&std::path::Path]) {
    let Ok(read) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in read.flatten() {
        let path = entry.path();
        if keep.iter().any(|k| path == **k) {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        // 只删我们自己命名的下载产物；**别碰 `apply_update.cmd`**
        // （正在跑的批处理被删掉会中途断）
        let mine = name.starts_with("ZeeAI_Term_") || name.ends_with(".stderr");
        if mine && path.is_file() {
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// 读 Windows「Internet 选项」里的代理设置。
///
/// 为什么需要：很多用户是靠 Clash / v2ray 这类本地代理访问 GitHub 的，而 `curl.exe`
/// **不会**自动读这些设置，不显式告诉它就会走直连 —— 直连 GitHub 的下载 CDN 在国内
/// 经常慢到几乎下不动。这里用 `reg query` 读一下（不引任何新依赖），有代理就带上。
fn system_proxy() -> Option<String> {
    const KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings";
    let enable = reg_value(KEY, "ProxyEnable")?;
    // 0x0 = 关，0x1 = 开
    let flag = enable.trim().to_ascii_lowercase();
    if !(flag.ends_with("0x1") || flag == "1") {
        return None;
    }
    let server = reg_value(KEY, "ProxyServer")?;
    let server = server.trim();
    if server.is_empty() {
        return None;
    }
    // 可能是 "127.0.0.1:7897"，也可能是 "http=127.0.0.1:7897;https=..." 这种分协议写法
    let host_port = server
        .split(';')
        .find_map(|part| {
            let p = part.trim();
            if let Some(rest) = p.strip_prefix("https=") {
                Some(rest.to_string())
            } else if let Some(rest) = p.strip_prefix("http=") {
                Some(rest.to_string())
            } else if !p.contains('=') {
                Some(p.to_string())
            } else {
                None
            }
        })?;
    let url = if host_port.starts_with("http://") || host_port.starts_with("https://") {
        host_port
    } else {
        format!("http://{host_port}")
    };
    log::info!("update: 检测到系统代理 {url}，下载时一并使用");
    Some(url)
}

/// `reg query <key> /v <name>` 取最后一个字段（值）
fn reg_value(key: &str, name: &str) -> Option<String> {
    let out = std::process::Command::new("reg")
        .args(["query", key, "/v", name])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    for line in text.lines() {
        if line.contains(name) {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if let Some(last) = parts.last() {
                return Some((*last).to_string());
            }
        }
    }
    None
}

/// 找系统的 curl.exe：先看 System32，再看 PATH。
fn find_curl() -> Option<std::path::PathBuf> {
    if let Ok(sys) = std::env::var("SystemRoot") {
        let p = std::path::Path::new(&sys).join("System32").join("curl.exe");
        if p.exists() {
            return Some(p);
        }
    }
    Some(std::path::PathBuf::from("curl.exe"))
}

/// 文件头对不对（exe = PE 的 MZ；msi = OLE 复合文档 D0CF11E0）
fn header_ok(path: &std::path::Path, ext: &str) -> bool {
    use std::io::Read;
    let mut head = [0u8; 4];
    match std::fs::File::open(path) {
        Ok(mut f) => {
            if f.read_exact(&mut head).is_err() {
                false
            } else if ext == "msi" {
                head == [0xD0, 0xCF, 0x11, 0xE0]
            } else {
                &head[..2] == b"MZ"
            }
        }
        Err(_) => false,
    }
}

/// 调一次 curl：**整包一次下完**（不分片），可选从已有字节续传，支持代理。
///
/// 三条都是 0.1.5 事故留下的教训：
/// - **带超时**：连不上 15 秒、或 60 秒内平均速率低于 2KB/s 就判失败去重试，
///   顺序挂在这里等死（0.1.5 那个僵尸 curl 就是这么来的）；
/// - **stderr 写文件不写管道**：管道没人读、写满之后双方互等 = 死锁；
/// - **挂进 Job Object**：App 退出/被强杀时 curl 跟着被收掉，不留孤儿进程。
///   （注意：升级**辅助脚本**不能挂 Job，原因见 [`update_download_install`]。）
///
/// `resume = true` 时带 `-C -`：从 `dest` 已有的大小接着下。配合 `--retry`，
/// 同一个 curl 进程内部的重连也是接着下，而不是把已经下好的几 MB 再传一遍。
/// 进度靠轮询文件大小（整包下载也能有进度条）。
fn run_curl_download(
    curl: &std::path::Path,
    url: &str,
    dest: &std::path::Path,
    expected_size: u64,
    proxy: Option<&str>,
    resume: bool,
    on_progress: &mut impl FnMut(u64, u64),
) -> Result<(), String> {
    let mut err_path = dest.as_os_str().to_os_string();
    err_path.push(".stderr");
    let err_path = std::path::PathBuf::from(err_path);
    // 不续传才清空目标文件；续传时留着，curl 从它的长度往后接着要
    let have = if resume {
        std::fs::metadata(dest).map(|m| m.len()).unwrap_or(0)
    } else {
        let _ = std::fs::remove_file(dest);
        0
    };
    let _ = std::fs::remove_file(&err_path);

    let mut cmd = std::process::Command::new(curl);
    cmd.arg("-L")
        .arg("--fail")
        .arg("--silent")
        .arg("--show-error")
        .arg("--connect-timeout")
        .arg("15")
        .arg("--speed-limit")
        .arg("2048")
        .arg("--speed-time")
        .arg("60")
        .arg("--max-time")
        .arg("3600")
        .arg("--retry")
        .arg("5")
        .arg("--retry-delay")
        .arg("2")
        .arg("--retry-all-errors");
    if have > 0 {
        // 已经有一部分了：从断点接着下（没有这部分时加不加都一样，curl 会从 0 开始）
        cmd.arg("-C").arg("-");
    }
    if let Some(p) = proxy {
        cmd.arg("--proxy").arg(p);
    }
    cmd.arg("--stderr").arg(&err_path);
    cmd.arg("-o").arg(dest);
    cmd.arg(url);
    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(std::process::Stdio::null());
    cmd.stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }

    on_progress(have, expected_size.max(have));
    let mut child = cmd.spawn().map_err(|e| format!("启动 curl 失败: {e}"))?;
    crate::core::job::assign(child.id());
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break st,
            Ok(None) => {
                let done = std::fs::metadata(dest).map(|m| m.len()).unwrap_or(0);
                on_progress(done, expected_size.max(done));
                std::thread::sleep(std::time::Duration::from_millis(400));
            }
            Err(e) => return Err(format!("等待 curl 失败: {e}")),
        }
    };
    let done = std::fs::metadata(dest).map(|m| m.len()).unwrap_or(0);
    on_progress(done, expected_size.max(done));
    if status.success() {
        return Ok(());
    }
    let msg = std::fs::read_to_string(&err_path).unwrap_or_default();
    let msg = msg.trim().to_string();
    Err(if msg.is_empty() {
        format!("curl 退出码 {:?}", status.code())
    } else {
        msg
    })
}

/// 用系统自带的 certutil 算 sha256（不引第三方加密库；certutil 从 Win7 起就有）
fn sha256_of(path: &std::path::Path) -> Result<String, String> {
    let out = std::process::Command::new("certutil")
        .args(["-hashfile", &path.to_string_lossy(), "SHA256"])
        .output()
        .map_err(|e| format!("调用 certutil 失败: {e}"))?;
    let text = String::from_utf8_lossy(&out.stdout);
    for line in text.lines() {
        let t = line.trim();
        if t.len() == 64 && t.chars().all(|c| c.is_ascii_hexdigit()) {
            return Ok(t.to_ascii_lowercase());
        }
    }
    Err("certutil 没能算出 sha256，无法校验更新包".into())
}

/// 校验下好的包：没问题返回 None，有问题返回原因。
///
/// - 大小必须和 Release 标注一致（防半截）；
/// - 文件头必须是 PE / OLE（防下成 HTML 错误页、别的产物）；
/// - 官方给了 sha256（GitHub Release API 的 `digest`）就必须一模一样 ——
///   0.1.5 那次"大小对、内容错位"就是靠这一条能当场抓住。
fn package_problem(
    path: &std::path::Path,
    ext: &str,
    expected_size: u64,
    expected_sha: Option<&str>,
) -> Option<String> {
    let actual = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    if expected_size > 0 && actual != expected_size {
        return Some(format!(
            "大小不符（下载 {actual} 字节，官方 {expected_size} 字节）"
        ));
    }
    if !header_ok(path, ext) {
        return Some("文件头不对（不是有效的安装程序）".to_string());
    }
    if let Some(want) = expected_sha.map(str::trim).filter(|s| !s.is_empty()) {
        let want = want
            .strip_prefix("sha256:")
            .unwrap_or(want)
            .to_ascii_lowercase();
        if want.len() != 64 || !want.chars().all(|c| c.is_ascii_hexdigit()) {
            return Some(format!("官方给的 sha256 格式不对：{want}"));
        }
        match sha256_of(path) {
            Ok(got) if got == want => {}
            Ok(got) => return Some(format!("sha256 对不上（下载 {got}，官方 {want}）")),
            Err(e) => return Some(e),
        }
    }
    None
}

/// 生成「等主程序退出 → 安装 → 拉起应用」的辅助脚本。
///
/// 这里是 0.1.5 那次"点了升级什么都没发生"的事故现场，两个坑都补上了：
/// - 等主程序退出**必须有上限**（以前主程序不退，脚本就永远卡着，安装永远不会开始）；
/// - **必须检查安装器的退出码**。那次下载到的安装包被残留 curl 并发写坏，安装器弹
///   "NSIS Error" 后以退出码 2 结束，而脚本照样一声不响地退出 —— 用户看不到任何反馈。
///   现在失败会记一行日志、把坏包丢掉（下次自动重下），并把旧版重新拉起来。
///
/// 后来又补了三处（见 `docs/review/raw/perf-packaging.md` 的 PP-02 / PP-03）：
/// - **MSI 也要自动重启**：`msiexec` 命令行带上 `AUTOLAUNCHAPP=1`。WiX 模板里
///   `LaunchApplication` 的前提是 `AUTOLAUNCHAPP AND NOT Installed`，以前没传这个属性，
///   于是 MSI 用户看到的是"应用自己关了、再也没回来"；
/// - **成功也要删包**：以前只有失败分支删，升一次就在 `%TEMP%` 留一份 9~14MB；
/// - **拉起应用兜底**：装完先等一会儿看进程在不在，不在就自己 `start` 一次。
///   正常情况下 NSIS 的 `/S /R` 和 MSI 的 `AUTOLAUNCHAPP=1` 已经把它拉起来了，
///   这里只兜"两边都没生效"的情况（等 5 轮 × 约 2 秒，确定没起来才自己启动，避免开出两个窗口）。
fn apply_update_script(
    kind: &str,
    dest: &std::path::Path,
    log: &std::path::Path,
    exe_path: &std::path::Path,
    pid: u32,
) -> String {
    let exe_name = exe_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "ZeeAI_Term.exe".to_string());
    // 安装那一步单独一行：无论成不成，退出码都拿得到（0 = 成功）
    let install = if kind == "msi" {
        // MSI：msiexec 静默升级（/qb 显示一个进度条；perMachine 会弹一次 UAC）。
        // AUTOLAUNCHAPP=1 是 WiX 模板里"装完把应用拉起来"那个自定义动作的开关，
        // 不传它，MSI 用户升完就是"应用没了"。
        format!(
            "msiexec /i \"{}\" /qb /norestart AUTOLAUNCHAPP=1",
            dest.display()
        )
    } else {
        // NSIS：/S 静默安装 + /R 装完自动重启应用
        format!("\"{}\" /S /R", dest.display())
    };
    format!(
        "@echo off\r\n\
setlocal enabledelayedexpansion\r\n\
rem 等 ZeeAI_Term 主程序退出（pid {pid}）；最多等 2 分钟，超时就强杀，别挂死\r\n\
set tries=0\r\n\
:wait\r\n\
tasklist /FI \"PID eq {pid}\" /NH | find \"{pid}\" >nul\r\n\
if errorlevel 1 goto install\r\n\
set /a tries+=1\r\n\
if !tries! GEQ 60 goto killit\r\n\
ping -n 2 127.0.0.1 >nul\r\n\
goto wait\r\n\
:killit\r\n\
taskkill /PID {pid} /F >nul 2>&1\r\n\
ping -n 2 127.0.0.1 >nul\r\n\
:install\r\n\
{install}\r\n\
set RC=%ERRORLEVEL%\r\n\
echo %DATE% %TIME% installer exit=%RC% >> \"{log}\"\r\n\
if \"%RC%\"==\"0\" goto ok\r\n\
if \"%RC%\"==\"3010\" goto ok\r\n\
del /f /q \"{dest}\" >nul 2>&1\r\n\
echo %DATE% %TIME% 安装失败，已丢弃这次下载的更新包 >> \"{log}\"\r\n\
start \"\" \"{exe}\"\r\n\
goto end\r\n\
:ok\r\n\
rem 装成功了：安装包已经没用，删掉（不删就是每次升级在 %TEMP% 里留 9~14MB）\r\n\
del /f /q \"{dest}\" >nul 2>&1\r\n\
rem 正常应该由安装包把应用拉起来（NSIS 的 /R、MSI 的 AUTOLAUNCHAPP=1）；\r\n\
rem 万一没起来，这里兜一次底 —— 等 5 轮（每轮约 2 秒）还没见到进程，就自己启动\r\n\
set relaunch=0\r\n\
:waitapp\r\n\
ping -n 3 127.0.0.1 >nul\r\n\
tasklist /FI \"IMAGENAME eq {exe_name}\" /NH | find /I \"{exe_name}\" >nul\r\n\
if not errorlevel 1 goto end\r\n\
set /a relaunch+=1\r\n\
if !relaunch! GEQ 5 goto startapp\r\n\
goto waitapp\r\n\
:startapp\r\n\
echo %DATE% %TIME% 安装完成但应用没自己起来，脚本代为启动 >> \"{log}\"\r\n\
start \"\" \"{exe}\"\r\n\
:end\r\n",
        pid = pid,
        install = install,
        log = log.display(),
        dest = dest.display(),
        exe = exe_path.display(),
        exe_name = exe_name,
    )
}

/// 下载新版安装包，校验后静默覆盖安装并自动重启应用。
///
/// 几点设计说明：
/// - **只允许 GitHub Release 的下载地址**：这条命令本质上会执行一个下载来的安装包，
///   所以地址必须形如 `https://github.com/<owner>/<repo>/releases/download/...`，
///   避免它变成"任意 URL 下载并执行"的后门；
/// - **校验**：见 [`fetch_update_package`]（大小 + 文件头 + 官方 sha256）；
/// - **进度**：复用 `zeeai://transfer` 事件，右下角进度面板直接显示下载进度；
/// - **安装**：先写一个隐藏的 cmd 辅助脚本，等本进程退出后再执行安装，最后把应用拉起来。
///   NSIS / MSI 都盖不住正在运行的 exe，所以必须先退出再装。
#[tauri::command]
pub async fn update_download_install(
    app: tauri::AppHandle,
    url: String,
    expected_size: u64,
    expected_sha: Option<String>,
    version: String,
) -> Result<String, String> {
    let u = url.trim().to_string();
    // 「不要下错」的第一道闸：**只认本项目自己的 Release**。
    // 以前只校验"是不是 github.com 的 release 下载地址"，等于任何仓库都放行；
    // 而校验用的 size / sha256 是渲染层传进来的（可以不传），一旦省掉就只剩"文件头是 MZ"，
    // 这条链路就能变成"下载并静默执行任意安装包"。所以这里把 owner/repo 钉死。
    if !u.starts_with(UPDATE_REPO_PREFIX) {
        return Err(format!(
            "更新地址不是本项目的 GitHub Release（只允许 {UPDATE_REPO_PREFIX}…），已拒绝执行"
        ));
    }
    if expected_size == 0 {
        // 没有官方字节数就没法判断"下没下全"，宁可拒绝也不装一个来路不明/半截的包
        return Err("缺少官方文件大小，无法校验更新包，已拒绝执行".into());
    }
    let kind = update_install_kind();
    if kind == "portable" {
        return Err("当前是便携版，无法自动覆盖升级：请下载压缩包解压替换（配置不会丢）".into());
    }
    log::info!(
        "ipc: update_download_install -> {u} (kind={kind}, expect {expected_size} bytes, sha={:?}, v{version})",
        expected_sha
    );

    let ext = if kind == "msi" { "msi" } else { "exe" };
    let task = "update".to_string();
    let name = if version.trim().is_empty() {
        format!("ZeeAI_Term 新版安装包 (.{ext})")
    } else {
        format!("ZeeAI_Term {version} 安装包 (.{ext})")
    };

    // 下载 + 校验（放到阻塞线程里跑，别卡住 async 运行时）
    let task_for_blocking = task.clone();
    let name_for_blocking = name.clone();
    let app_for_blocking = app.clone();
    let result = tokio::task::spawn_blocking(move || {
        fetch_update_package(
            &u,
            expected_size,
            expected_sha.as_deref(),
            ext,
            &version,
            |done, total| {
                if done == 0 {
                    emit_transfer(
                        &app_for_blocking,
                        TransferEvent::Start {
                            task: task_for_blocking.clone(),
                            name: name_for_blocking.clone(),
                            total,
                        },
                    );
                } else {
                    emit_transfer(
                        &app_for_blocking,
                        TransferEvent::Progress {
                            task: task_for_blocking.clone(),
                            name: name_for_blocking.clone(),
                            done,
                            total,
                        },
                    );
                }
            },
        )
    })
    .await
    .map_err(|e| format!("下载任务异常: {e}"))?;

    let dest = match result {
        Ok(p) => p,
        Err(e) => {
            emit_transfer(
                &app,
                TransferEvent::FileFailed {
                    task: task.clone(),
                    name: name.clone(),
                    message: e.clone(),
                },
            );
            return Err(e);
        }
    };
    let done = std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
    let dir = dest.parent().map(|p| p.to_path_buf()).unwrap_or_else(std::env::temp_dir);
    emit_transfer(
        &app,
        TransferEvent::FileDone {
            task: task.clone(),
            name: name.clone(),
            bytes: done,
        },
    );

    // ---- 写辅助脚本：等本进程退出后再装，装完把应用拉起来 ----
    let exe_path = std::env::current_exe().map_err(|e| format!("取当前程序路径失败: {e}"))?;
    let helper = dir.join("apply_update.cmd");
    let log = dir.join("apply_update.log");
    // 上一次的失败记录先清掉，免得新的一次还没跑完就被读成"上次失败了"
    let _ = std::fs::remove_file(&log);
    let pid = std::process::id();
    let script = apply_update_script(&kind, &dest, &log, &exe_path, pid);
    std::fs::write(&helper, script).map_err(|e| format!("写升级脚本失败: {e}"))?;

    let mut cmd = std::process::Command::new("cmd");
    cmd.args(["/C", &helper.to_string_lossy()]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW：升级过程不闪黑框
        cmd.creation_flags(0x0800_0000);
    }
    let child = cmd.spawn().map_err(|e| format!("启动升级脚本失败: {e}"))?;
    log::info!("update: 升级脚本已启动 pid={}", child.id());
    // ★ 千万别把升级脚本挂进 Job Object。
    //
    // 这个 Job 带 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`（见 core/job.rs），App 一退出
    // 句柄关闭、job 里的进程全被杀。而脚本的**第一步就是等 App 退出**（见
    // apply_update_script 的 :wait 循环）——两边一撞，脚本恰好在它唯一需要活下去的那一刻
    // 被系统杀掉，安装器永远不会启动，`apply_update.log` 也不会写，用户看到的就是
    // 「点了升级、应用关了、版本没变、也没有任何提示」（0.1.5 那次事故的真身）。
    //
    // 脚本自带 2 分钟等待上限 + 退出码检查 + 失败拉回旧版，本来就不需要跟 App 同生共死。
    // 真正需要挂 Job 的是 curl 和终端子进程（它们才怕变孤儿），那些照旧。

    // 给脚本一点时间就位，然后走正常退出路径（收干净会话进程）；重启由脚本/安装包负责
    let app_for_exit = app.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
        log::info!("update: 退出应用，交给升级脚本完成覆盖");
        app_for_exit.exit(0);
    });

    Ok(dest.to_string_lossy().to_string())
}

/// 保存工作区快照（退出/变更时由前端调用）
#[tauri::command]
pub fn workspace_save(data: String) -> Result<(), String> {
    store::save_workspace(&data)
}

// ---------- AI 任务时间线（G-01） ----------

/// 读整条 AI 任务时间线（新的在前）。
///
/// 这是"我离开电脑再回来，昨晚跑了什么"的答案：看板只显示当前这一轮，
/// 而这份记录是落盘的，重启应用也还在。
#[tauri::command]
pub fn ai_timeline_list() -> Vec<crate::core::ai_history::AiTurnRecord> {
    crate::core::ai_history::list()
}

/// 记一条"这一轮跑完了"。前端在发现新一轮完成时调用（那一刻它手上有全部信息）。
/// 返回 true 表示是新记录（前端据此刷新列表）。
#[tauri::command]
pub fn ai_timeline_add(entry: crate::core::ai_history::AiTurnRecord) -> bool {
    let at = entry.completed_at;
    let server = entry.server.clone();
    let is_new = crate::core::ai_history::record(entry);
    if is_new {
        log::info!("ai_timeline: 记下一条新的完成记录 server={server} at={at}");
    }
    is_new
}

/// 清空时间线
#[tauri::command]
pub fn ai_timeline_clear() {
    crate::core::ai_history::clear();
}

/// 探测"这台机器的 AI 状态是从哪来的"：装了 herdr 就用它的 agent 状态机，
/// 没装就用我们自己的探测。只读，不启动、不安装、不改远程任何东西。
#[tauri::command]
pub async fn ai_source_probe(
    profile_id: Option<String>,
    user_override: Option<String>,
) -> Result<crate::core::ai_sessions::AiSourceInfo, String> {
    if let Some(pid) = profile_id.as_deref().filter(|s| !s.trim().is_empty()) {
        let cfg = ssh_config_for(pid, user_override)?;
        let out = run_remote_capture(pid, &cfg, &ai_sessions::remote_source_script()).await?;
        let info = ai_sessions::parse_source(&out);
        log::info!(
            "ipc: ai_source_probe(remote) -> herdr={:?} agents={}",
            info.herdr_version,
            info.agents
        );
        return Ok(info);
    }
    Ok(ai_sessions::local_source())
}

// ---------- herdr：状态源 / 观察窗 / 一键安装 ----------

/// 读这台服务器上 herdr 认得的 agent（**只读**：就是一条 `agent list`）。
///
/// 为什么要单独一条命令，而不是并进 `ai_tasks_remote`：看板每 10~20 秒刷一次，
/// 那条探针本身已经在扫 ps / tmux 了；herdr 的 agent 状态是"第一手"，
/// 但只有**这台机器确实装了 herdr** 才值得多花一次往返。前端探到有 herdr 才调它。
#[tauri::command]
pub async fn herdr_agents(
    profile_id: String,
    user_override: Option<String>,
) -> Result<Vec<herdr::HerdrAgent>, String> {
    let cfg = ssh_config_for(&profile_id, user_override)?;
    let out = run_remote_capture(&profile_id, &cfg, &herdr::agents_command()).await?;
    let agents = herdr::parse_agents(&out);
    log::info!("ipc: herdr_agents -> {} 个 agent", agents.len());
    Ok(agents)
}

/// 观察窗的尺寸变了：把 observe 流**重开**一次。
///
/// herdr 的观察者是在开流时声明自己行列数的（不会去改窗格本身的尺寸 —— 这正是我们
/// 想要的）。所以"窗口变大"对我们是"重开一条更大观察者"，而不是去 resize 别人的窗格。
#[tauri::command]
pub fn herdr_pane_resize(
    id: String,
    cols: u16,
    rows: u16,
    registry: State<'_, SessionRegistry>,
    panes: State<'_, HerdrPaneRegistry>,
    logs: State<'_, std::sync::Arc<crate::core::session_log::LogRegistry>>,
) -> Result<(), String> {
    // 和前端同一道闸：太小的尺寸一律不发（首次布局时容器可能是 0）
    if cols < 20 || rows < 5 {
        return Ok(());
    }
    let meta = {
        let m = panes.panes.lock().map_err(|e| e.to_string())?;
        m.get(&id).map(|x| {
            (
                x.profile_id.clone(),
                x.user.clone(),
                x.pane_id.clone(),
                x.cols,
                x.rows,
                x.channel.clone(),
                x.close_flag.clone(),
            )
        })
    };
    let Some((profile_id, user, pane_id, old_cols, old_rows, channel, close_flag)) = meta else {
        return Ok(()); // 不是观察窗会话（普通 ssh/tmux），交给原来的 session_resize
    };
    if old_cols == cols && old_rows == rows {
        return Ok(());
    }
    let effective_user = user
        .as_ref()
        .map(|u| u.trim().to_string())
        .filter(|u| !u.is_empty());
    let cfg = ssh_config_for(&profile_id, user)?;
    let effective_user = effective_user.unwrap_or_else(|| cfg.user.clone());

    // 1) 先让旧线程别再报 "closed"，再把旧进程收掉
    close_flag.store(true, std::sync::atomic::Ordering::Relaxed);
    let old = {
        let mut sessions = registry.sessions.lock().map_err(|e| e.to_string())?;
        sessions.remove(&id)
    };
    if let Some(h) = old {
        if let Some(child) = h.child.as_ref() {
            if let Ok(mut c) = child.lock() {
                let _ = c.kill();
            }
        }
    }

    // 2) 擦掉旧画面再铺新的：新流是按**新的宽度**渲染的，不擦会和上面的残影叠在一起
    let clear = base64::engine::general_purpose::STANDARD.encode(b"\x1b[2J\x1b[H");
    let _ = channel.send(SessionEvent::Data { data: clear });

    // 3) 开一条新的观察者
    let cmd = herdr::observe_command(&pane_id, cols, rows);
    let args = ssh::ssh_args(
        &cfg.host,
        cfg.port,
        &effective_user,
        cfg.key_path.as_deref(),
        Some(&cmd),
        !cfg.allow_password,
        cfg.jump.as_deref(),
    );
    let title = format!("herdr {}", herdr::sanitize_pane(&pane_id));
    let new_flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let handle = pty::spawn(
        &id,
        "ssh",
        &title,
        &ssh::ssh_exe(),
        &args,
        None,
        cols,
        rows,
        channel.clone(),
        logs.inner().clone(),
        pty::SpawnOpts {
            filter: pty::Filter::HerdrObserve,
            close_flag: new_flag.clone(),
        },
    )?;
    registry
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .insert(id.clone(), handle);
    if let Ok(mut m) = panes.panes.lock() {
        if let Some(x) = m.get_mut(&id) {
            x.cols = cols;
            x.rows = rows;
            x.close_flag = new_flag;
        }
    }
    log::info!("ipc: herdr_pane_resize -> {id} {old_cols}x{old_rows} => {cols}x{rows}");
    Ok(())
}

/// 给观察窗配一条常驻的「输入泵」。
///
/// 为什么要常驻：如果每次按键都起一条 ssh，打字会变成"一个字半秒"。
/// 这条进程的 stdin 就是指令通道，按行读：
/// `T<base64 文本>` = 把文本按字面敲进窗格；`K<按键名>` = 敲一个逻辑按键。
#[tauri::command]
pub fn herdr_pane_input_start(
    id: String,
    profile_id: String,
    user_override: Option<String>,
    pane_id: String,
    panes: State<'_, HerdrPaneRegistry>,
) -> Result<(), String> {
    let cfg = ssh_config_for(&profile_id, user_override.clone())?;
    let effective_user = user_override
        .as_ref()
        .map(|u| u.trim().to_string())
        .filter(|u| !u.is_empty())
        .unwrap_or_else(|| cfg.user.clone());
    // 密码登录的服务器：系统 ssh 喂不了密码，输入泵会卡在认证上。
    // 这里**提前说清楚**，比"看起来能打字、实际一个字都进不去"强。
    if password_for(&profile_id, &cfg).is_some() {
        return Err(
            "这台服务器用的是密码登录：观察窗只能看，输入请用 tmux/普通 shell 会话".into(),
        );
    }
    let cmd = herdr::input_pump_command(&pane_id);
    let args = ssh::ssh_args(
        &cfg.host,
        cfg.port,
        &effective_user,
        cfg.key_path.as_deref(),
        Some(&cmd),
        true,
        cfg.jump.as_deref(),
    );
    // 用**标准库**的 Command：它的 ChildStdin 实现了 std::io::Write，
    // 这样"敲一个字"就是一次同步的小写入，不用为了几字节去 await 一个异步管道。
    let mut c = std::process::Command::new(ssh::ssh_exe());
    c.args(&args);
    c.stdin(std::process::Stdio::piped());
    c.stdout(std::process::Stdio::null());
    c.stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = c.spawn().map_err(|e| format!("启动输入通道失败: {e}"))?;
    // 跟着应用生命周期走：App 退出/被强杀时不会留下孤儿 ssh
    crate::core::job::assign(child.id());
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "拿不到输入通道的 stdin".to_string())?;
    panes
        .inputs
        .lock()
        .map_err(|e| e.to_string())?
        .insert(id.clone(), stdin);
    // Child 句柄本身不留在注册表里：我们只关心它的 stdin（它在表里，管道就不会断）。
    // 远端那条循环是 `while read`，stdin 一关（会话结束）它自己就退出了。
    drop(child);
    log::info!("ipc: herdr_pane_input_start {id} pane={pane_id}");
    Ok(())
}

/// 往观察窗里**按字面**送一段文本（等价于在窗格里敲键盘）
#[tauri::command]
pub fn herdr_pane_type(
    id: String,
    text: String,
    panes: State<'_, HerdrPaneRegistry>,
) -> Result<(), String> {
    if text.is_empty() {
        return Ok(());
    }
    let b64 = base64::engine::general_purpose::STANDARD.encode(text.as_bytes());
    herdr_write_input(&panes, &id, &format!("T{b64}\n"))
}

/// 往观察窗里送一个**逻辑按键**（enter / esc / ctrl+c / up …）
///
/// 白名单校验：这个值会被拼进远端命令行，所以只允许 `[a-z0-9+-]`，且不超过 16 个字符。
#[tauri::command]
pub fn herdr_pane_key(
    id: String,
    key: String,
    panes: State<'_, HerdrPaneRegistry>,
) -> Result<(), String> {
    let k = key.trim().to_ascii_lowercase();
    let ok = !k.is_empty()
        && k.len() <= 16
        && k.chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '+' || c == '-');
    if !ok {
        return Err(format!("不认这个按键名：{key}"));
    }
    herdr_write_input(&panes, &id, &format!("K{k}\n"))
}

/// 往输入泵写一行指令（写失败时把这条通道从表里摘掉，下次输入会自动重开）
fn herdr_write_input(
    panes: &State<'_, HerdrPaneRegistry>,
    id: &str,
    line: &str,
) -> Result<(), String> {
    use std::io::Write as _;
    // 写的是内存管道、一行就几十字节，正常永远写得进去；真写满了也只会短暂阻塞这一下。
    let mut dead = false;
    let res = {
        let mut m = panes.inputs.lock().map_err(|e| e.to_string())?;
        match m.get_mut(id) {
            None => Err("输入通道还没建立".to_string()),
            Some(s) => match s.write_all(line.as_bytes()) {
                Ok(()) => Ok(()),
                Err(e) => {
                    dead = true;
                    Err(format!("输入通道断了（下次输入会自动重连）: {e}"))
                }
            },
        }
    };
    if dead {
        if let Ok(mut m) = panes.inputs.lock() {
            m.remove(id);
        }
    }
    res
}

/// 一键安装 herdr 的结果（前端拿去显示"装了什么版本、来自哪、校验对不对"）
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HerdrInstallReport {
    pub version: String,
    pub protocol: u32,
    pub platform: String,
    pub source: String,
    pub sha256: String,
    pub bytes: u64,
    pub path: String,
}

/// 一键安装 herdr：**Windows 侧下载 → 校验 → scp 上去**。
///
/// 几条硬规矩（用户明确要求过，这里逐条落地）：
/// 1. **不下错**：版本号和 sha256 都取自官方 `latest.json`；官方直链失败才退到镜像，
///    但**不管是官方还是镜像，都按同一份 sha256 校验**，对不上就删掉换下一个来源；
/// 2. **不乱装**：绝不执行远端安装脚本、绝不 sudo、不碰系统目录；只放进 `~/.local/bin`，
///    而且**已经有一个能用的 herdr 就不覆盖**（宁可报错让用户决定）；
/// 3. **可回滚**：装完做一次只读自检（`--version` + 协议号），不达标就把刚装的文件删掉；
/// 4. 每一步都往状态栏回一条进度，失败时把原因原样带出来（前端直接显示）。
#[tauri::command]
pub async fn herdr_install(
    profile_id: String,
    user_override: Option<String>,
    on_progress: Channel<String>,
) -> Result<HerdrInstallReport, String> {
    herdr_install_inner(profile_id, user_override, move |s: &str| {
        let _ = on_progress.send(s.to_string());
    })
    .await
}

/// 安装进度的小包装：既写日志，也交给调用方（界面通道 / 自检）。
/// 用 `Arc` 包一层是因为下载那一段要丢到阻塞线程里跑，而回调得跟着进那个线程。
struct Say<F: Fn(&str)>(std::sync::Arc<F>);

impl<F: Fn(&str)> Clone for Say<F> {
    fn clone(&self) -> Self {
        Say(self.0.clone())
    }
}

impl<F: Fn(&str)> Say<F> {
    fn say(&self, s: &str) {
        log::info!("herdr_install: {s}");
        (self.0)(s);
    }
}

/// [`herdr_install`] 的实现体（**故意**和命令壳分开）。
///
/// 分开的原因：进度通道是给界面看的，而自检（`ZEEAI_SELFTEST_HERDR=1`）需要在不建
/// Channel 的情况下把整条链路跑一遍。把进度回调抽成 `Fn(&str)`，两边就都能用了 ——
/// 这样"我验证过的"和"用户点按钮跑到的"是**同一段代码**，不是两套。
pub(crate) async fn herdr_install_inner<F: Fn(&str) + Send + Sync + 'static>(
    profile_id: String,
    user_override: Option<String>,
    say: F,
) -> Result<HerdrInstallReport, String> {
    let cfg = ssh_config_for(&profile_id, user_override.clone())?;
    let effective_user = user_override
        .as_ref()
        .map(|u| u.trim().to_string())
        .filter(|u| !u.is_empty())
        .unwrap_or_else(|| cfg.user.clone());
    let say = Say(std::sync::Arc::new(say));

    // ---- 0) 这台机器是什么平台 ----
    say.say("正在读取服务器平台…");
    let uname = run_remote_capture(&profile_id, &cfg, &herdr::uname_command()).await?;
    let platform = herdr::platform_key(&uname)
        .ok_or_else(|| format!("这台机器的平台不支持一键安装：{}", uname.trim()))?;
    if !herdr::is_supported_platform(&platform) {
        return Err(format!("一键安装目前只支持 Linux 服务器（这台是 {platform}）"));
    }

    // ---- 1) 已经装了就不动它 ----
    let existing = run_remote_capture(&profile_id, &cfg, &herdr::installed_check_command()).await?;
    if let Some((ver, proto)) = herdr::parse_installed(&existing) {
        if proto >= herdr::MIN_PROTOCOL {
            return Err(format!(
                "这台机器上已经有 herdr {ver}（协议 {proto}），不覆盖。要升级请在服务器上自己执行 herdr update"
            ));
        }
        say.say(&format!("发现 herdr {ver} 太旧（协议 {proto}），继续安装新版"));
    }

    // ---- 2) 官方清单 ----
    say.say("正在读取 herdr 官方版本清单（herdr.dev）…");
    let curl = find_curl()
        .ok_or_else(|| "找不到系统自带的 curl.exe，请手动下载安装".to_string())?;
    let manifest_text = curl_text(&curl, herdr::LATEST_MANIFEST_URL, 30)?;
    let manifest = herdr::parse_manifest(&manifest_text)?;
    let asset = manifest
        .asset(&platform)
        .ok_or_else(|| format!("官方清单里没有 {platform} 这个平台的产物"))?
        .to_string();
    let want_sha = manifest
        .sha(&platform)
        .ok_or_else(|| "官方清单里没给 sha256，拒绝安装（不敢赌下到的是什么）".to_string())?
        .to_string();
    if manifest.protocol > 0 && manifest.protocol < herdr::MIN_PROTOCOL {
        say.say(&format!(
            "注意：官方最新版协议 {}  低于我们实测的 {}，装完可能不兼容",
            manifest.protocol,
            herdr::MIN_PROTOCOL
        ));
    }
    say.say(&format!(
        "官方最新版 herdr {}（协议 {}，sha256 {}…）",
        manifest.version,
        manifest.protocol,
        &want_sha[..want_sha.len().min(12)]
    ));

    // ---- 3) 在 Windows 侧下载（官方不通就走镜像，校验标准不变） ----
    let dir = std::env::temp_dir().join("zeeai-herdr");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建缓存目录失败: {e}"))?;
    let dest = dir.join(format!("herdr-{}-{platform}", manifest.version));
    let candidates = herdr::sources(&asset);
    let proxy = system_proxy();
    // 下载整段放到阻塞线程里：它可能要跑几分钟，放在 async 运行时的 worker 上会拖住别的命令
    let (bytes, got_from) = {
        let curl = curl.clone();
        let dest = dest.clone();
        let want_sha = want_sha.clone();
        let proxy = proxy.clone();
        let progress = say.clone();
        let candidates = candidates.clone();
        tokio::task::spawn_blocking(move || -> Result<(u64, String), String> {
            if dest.exists() {
                let have = sha256_of(&dest).unwrap_or_default();
                if have == want_sha {
                    let n = std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
                    return Ok((n, "本地缓存（校验一致）".to_string()));
                }
                let _ = std::fs::remove_file(&dest);
            }
            let mut last_err = String::new();
            for src in &candidates {
                // 每个来源先直连、再试系统代理（不少用户是靠本地代理访问 GitHub 的）
                for (tag, p) in [("直连", None), ("系统代理", proxy.as_deref())] {
                    if tag == "系统代理" && proxy.is_none() {
                        continue;
                    }
                    progress.say(&format!("正在下载（{}·{}）…", src.label, tag));
                    let _ = std::fs::remove_file(&dest);
                    let mut last_mb = 0u64;
                    let r = run_curl_download(
                        &curl,
                        &src.url,
                        &dest,
                        0,
                        p,
                        false,
                        &mut |done, _total| {
                            // 跨过 1MB 才回一条进度，免得状态栏被刷屏
                            if done / 1_048_576 > last_mb {
                                last_mb = done / 1_048_576;
                                progress.say(&format!(
                                    "下载中（{}）：{} MB",
                                    src.label, last_mb
                                ));
                            }
                        },
                    );
                    match r {
                        Ok(()) => {
                            let have = sha256_of(&dest).unwrap_or_default();
                            if have != want_sha {
                                last_err = format!(
                                    "{}·{} 下到的文件 sha256 和官方不一致（拿到 {}…），已丢弃",
                                    src.label,
                                    tag,
                                    &have[..have.len().min(12)]
                                );
                                let _ = std::fs::remove_file(&dest);
                                continue;
                            }
                            let n = std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
                            return Ok((n, format!("{}·{}", src.label, tag)));
                        }
                        Err(e) => last_err = format!("{}·{} 失败：{e}", src.label, tag),
                    }
                }
            }
            Err(format!(
                "所有下载来源都没成功（最后一个：{last_err}）。可以稍后重试，或手动下载后在服务器上安装"
            ))
        })
        .await
        .map_err(|e| format!("下载线程失败: {e}"))??
    };
    let pct = format!("{:.1} MB", bytes as f64 / 1_048_576.0);
    say.say(&format!("下载完成（{got_from}，{pct}，sha256 已核对）"));

    // ---- 4) scp 上去 + chmod + 只读自检 ----
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let tmp = format!("/tmp/zeeai-herdr-{stamp}");
    say.say("正在上传到服务器（scp → /tmp）…");
    let scp_args = ssh::scp_args(
        cfg.port,
        cfg.key_path.as_deref(),
        false,
        &dest.to_string_lossy(),
        &ssh::scp_remote(&cfg.host, &effective_user, &tmp),
    );
    run_scp(&scp_args).await?;

    say.say("正在安装到 ~/.local/bin/herdr（不需要 root）…");
    let install_cmd = format!(
        "set -e; mkdir -p \"$HOME/.local/bin\"; install -m 755 '{tmp}' \"$HOME/.local/bin/herdr\"; rm -f '{tmp}'; {}",
        herdr::installed_check_command()
    );
    let out = run_remote_capture(&profile_id, &cfg, &install_cmd).await?;
    let parsed = herdr::parse_installed(&out);

    // ---- 5) 自检不过就回滚 ----
    let Some((ver, proto)) = parsed else {
        let _ = run_remote_capture(
            &profile_id,
            &cfg,
            "rm -f \"$HOME/.local/bin/herdr\"; printf 'rolled back\\n'",
        )
        .await;
        return Err(format!(
            "装完后自检没通过（herdr --version 拿不到版本），已把刚放上去的文件删掉。远端原话：{}",
            out.trim()
        ));
    };
    if proto < herdr::MIN_PROTOCOL {
        let _ = run_remote_capture(
            &profile_id,
            &cfg,
            "rm -f \"$HOME/.local/bin/herdr\"; printf 'rolled back\\n'",
        )
        .await;
        return Err(format!(
            "装上的 herdr {ver} 协议号 {proto} 低于我们支持的下限 {}，已回滚",
            herdr::MIN_PROTOCOL
        ));
    }
    say.say(&format!("安装完成：herdr {ver}（协议 {proto}）"));
    Ok(HerdrInstallReport {
        version: ver,
        protocol: proto,
        platform,
        source: got_from,
        sha256: want_sha,
        bytes,
        path: "$HOME/.local/bin/herdr".into(),
    })
}

/// 用 curl 取一小段文本（清单文件只有几十 KB）。失败时带出 curl 的原话。
fn curl_text(curl: &std::path::Path, url: &str, timeout_secs: u64) -> Result<String, String> {
    let out = std::process::Command::new(curl)
        .args([
            "-fsSL",
            "--connect-timeout",
            "15",
            "--max-time",
            &timeout_secs.to_string(),
            url,
        ])
        .output()
        .map_err(|e| format!("执行 curl 失败: {e}"))?;
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    if out.status.success() && !text.trim().is_empty() {
        return Ok(text);
    }
    let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
    Err(if err.is_empty() {
        format!("下载 {url} 失败（curl 退出码 {:?}）", out.status.code())
    } else {
        err
    })
}

/// 读取上次的工作区快照（没有就返回 null）
#[tauri::command]
pub fn workspace_load() -> Option<String> {
    let data = store::load_workspace();
    if data.is_some() {
        log::info!("ipc: workspace_load -> 有快照");
    }
    data
}

#[tauri::command]
pub fn history_list() -> Vec<HistoryEntry> {
    store::load_history()
}

#[tauri::command]
pub fn history_save(mut entry: HistoryEntry) -> Result<Vec<HistoryEntry>, String> {
    if entry.id.trim().is_empty() {
        // 普通 shell 的 id 也要带名字，否则同一台机器的多个普通 shell 会撞成同一个 id
        let tail = entry
            .tmux_session
            .clone()
            .map(|t| format!("tmux-{t}"))
            .unwrap_or_else(|| {
                format!("plain-{}", entry.title.clone().unwrap_or_else(|| "shell".into()))
            });
        entry.id = format!("h-{}-{}", entry.profile_id, tail);
    }
    log::info!(
        "ipc: history_save profile={} tmux={:?}",
        entry.profile_name,
        entry.tmux_session
    );
    store::upsert_history(entry)
}

#[tauri::command]
pub fn history_remove(id: String) -> Result<Vec<HistoryEntry>, String> {
    log::info!("ipc: history_remove id={id}");
    store::remove_history(&id)
}

// ---------- 设置 ----------

#[tauri::command]
pub fn settings_get() -> Settings {
    store::load_settings()
}

#[tauri::command]
pub fn settings_set(settings: Settings) -> Result<(), String> {
    log::info!("ipc: settings_set theme={} font={}", settings.theme, settings.font_size);
    store::save_settings(&settings)
}

#[cfg(test)]
mod update_tests {
    use super::*;

    fn tmp(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join("zeeai-cmd-tests");
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(name)
    }

    #[test]
    fn package_problem_catches_short_wrong_and_mismatched_files() {
        let exe = tmp("pkg-check.exe");
        // 半截文件：大小不符
        std::fs::write(&exe, vec![b'M', b'Z', 0, 0]).unwrap();
        let p = package_problem(&exe, "exe", 1000, None).unwrap();
        assert!(p.contains("大小不符"), "{p}");

        // 大小对、文件头不对（比如下成了一个 HTML 错误页）
        std::fs::write(&exe, b"<html>404</html>").unwrap();
        let p = package_problem(&exe, "exe", 16, None).unwrap();
        assert!(p.contains("文件头不对"), "{p}");

        // 大小对、头也对，但 sha256 和官方给的差一位 → 必须拦住（0.1.5 就是这么坏的）
        let mut body = vec![b'M', b'Z'];
        body.extend(std::iter::repeat(0u8).take(14));
        std::fs::write(&exe, &body).unwrap();
        let good = sha256_of(&exe).unwrap();
        assert_eq!(package_problem(&exe, "exe", 16, Some(&good)), None);
        let mut bad = good.clone();
        bad.replace_range(0..1, if good.starts_with('a') { "b" } else { "a" });
        let p = package_problem(&exe, "exe", 16, Some(&format!("sha256:{bad}"))).unwrap();
        assert!(p.contains("sha256 对不上"), "{p}");
        let _ = std::fs::remove_file(&exe);
    }

    #[test]
    fn apply_update_script_has_bounded_wait_and_failure_feedback() {
        let dest = std::path::PathBuf::from(
            r"C:\Users\u\AppData\Local\Temp\ZeeAI-Term-update\ZeeAI_Term_0.1.6_setup.exe",
        );
        let log = std::path::PathBuf::from(
            r"C:\Users\u\AppData\Local\Temp\ZeeAI-Term-update\apply_update.log",
        );
        let exe = std::path::PathBuf::from(r"C:\Users\u\AppData\Local\ZeeAI_Term\ZeeAI_Term.exe");
        let s = apply_update_script("nsis", &dest, &log, &exe, 4321);

        // 等主程序退出：看得到 pid，而且有次数上限（不会无限等）
        assert!(s.contains("PID eq 4321"), "{s}");
        assert!(s.contains("if !tries! GEQ 60 goto killit"), "{s}");
        // 安装完必须看退出码，失败要记日志、丢包、把旧版拉起来
        assert!(s.contains("set RC=%ERRORLEVEL%"), "{s}");
        assert!(s.contains("installer exit=%RC%"), "{s}");
        assert!(
            s.contains(
                "del /f /q \"C:\\Users\\u\\AppData\\Local\\Temp\\ZeeAI-Term-update\\ZeeAI_Term_0.1.6_setup.exe\""
            ),
            "{s}"
        );
        assert!(
            s.contains("start \"\" \"C:\\Users\\u\\AppData\\Local\\ZeeAI_Term\\ZeeAI_Term.exe\""),
            "{s}"
        );
        // NSIS 走 /S /R（静默装 + 装完重启）
        assert!(s.contains("/S /R"), "{s}");
        // 成功路径**也要删包**（老版本只在失败分支删，每升一次在 %TEMP% 留 9~14MB）
        assert!(s.contains(":ok"), "{s}");
        let ok_block = s.split(":ok").nth(1).unwrap_or("");
        assert!(
            ok_block.contains("del /f /q"),
            "成功分支必须删安装包：{s}"
        );
        // 装完要有"应用没起来就自己拉一次"的兜底
        assert!(s.contains(":waitapp"), "{s}");
        assert!(s.contains(":startapp"), "{s}");

        // MSI 走 msiexec，且 3010（要重启）也算成功
        let m = apply_update_script("msi", &dest, &log, &exe, 7);
        assert!(m.contains("msiexec /i"), "{m}");
        assert!(m.contains("\"%RC%\"==\"3010\" goto ok"), "{m}");
        // MSI 必须传 AUTOLAUNCHAPP=1，否则装完应用不会自己回来
        assert!(
            m.contains("AUTOLAUNCHAPP=1"),
            "MSI 分支缺 AUTOLAUNCHAPP=1，升级后应用不会重启：{m}"
        );
    }

    #[test]
    fn update_only_accepts_our_own_release_url() {
        // 本项目自己的 Release 地址要放行（大小 > 0 才行，这里只测前缀判定）
        assert!(UPDATE_REPO_PREFIX.ends_with("/releases/download/"));
        let ours = format!("{UPDATE_REPO_PREFIX}v0.1.8/ZeeAI_Term_0.1.8_x64-setup.exe");
        assert!(ours.starts_with(UPDATE_REPO_PREFIX));
        // 别的仓库（哪怕也是 GitHub Release）必须被拒
        let other = "https://github.com/someone/evil/releases/download/v1/x.exe";
        assert!(!other.starts_with(UPDATE_REPO_PREFIX));
    }

    #[test]
    fn sweep_update_dir_keeps_current_files_and_spares_the_helper_script() {
        let dir = std::env::temp_dir().join("zeeai-cmd-tests-sweep");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let keep = dir.join("ZeeAI_Term_0.1.9_setup.exe");
        let stale_exe = dir.join("ZeeAI_Term_0.1.8_setup.exe");
        let stale_part = dir.join("ZeeAI_Term_0.1.8_setup.exe.part");
        let stale_err = dir.join("ZeeAI_Term_0.1.8_setup.exe.part.stderr");
        // 正在跑的升级脚本和用户自己的文件都不能被删
        let helper = dir.join("apply_update.cmd");
        let user_file = dir.join("我的笔记.txt");
        for p in [&keep, &stale_exe, &stale_part, &stale_err, &helper, &user_file] {
            std::fs::write(p, b"x").unwrap();
        }

        sweep_update_dir(&dir, &[&keep]);

        assert!(keep.exists(), "本次要用的文件不能删");
        assert!(helper.exists(), "升级脚本不能被清掉（它可能正在跑）");
        assert!(user_file.exists(), "不是我们命名的文件不能动");
        assert!(!stale_exe.exists(), "别的版本的安装包应该清掉");
        assert!(!stale_part.exists(), "别的版本的半截文件应该清掉");
        assert!(!stale_err.exists(), "curl 的 stderr 应该清掉");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
