use base64::Engine as _;
use portable_pty::PtySize;
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;

use crate::core::{adb, git, pty, remote_fs, serial, ssh, tmux, SessionEvent, SessionRegistry};
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
    cols: Option<u16>,
    rows: Option<u16>,
    on_event: Channel<SessionEvent>,
    registry: State<'_, SessionRegistry>,
) -> Result<SessionInfo, String> {
    log::info!("ipc: open_local shell={} distro={:?}", shell, distro);
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
        "local",
        &title,
        &program,
        &args,
        None,
        cols.unwrap_or(110),
        rows.unwrap_or(30),
        on_event,
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
    user_override: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
    on_event: Channel<SessionEvent>,
    registry: State<'_, SessionRegistry>,
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
    let mut resolved_tmux: Option<String> = None;
    let remote_cmd = match mode.as_str() {
        "none" => None,
        "name" => {
            let name = tmux_name.unwrap_or_default();
            if name.trim().is_empty() {
                None
            } else {
                resolved_tmux = Some(name.clone());
                Some(ssh::tmux_command(&name, cfg.start_dir.as_deref()))
            }
        }
        _ => {
            if cfg.tmux_enabled {
                let name = ssh::tmux_session_name(&cfg.tmux_template, &cfg.host, &effective_user);
                resolved_tmux = Some(name.clone());
                Some(ssh::tmux_command(&name, cfg.start_dir.as_deref()))
            } else {
                None
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
    );
    let program = ssh::ssh_exe();
    let title = format!("{} · {}", profile.name, cfg.host);

    let handle = pty::spawn(
        "ssh",
        &title,
        &program,
        &args,
        None,
        cols.unwrap_or(110),
        rows.unwrap_or(30),
        on_event,
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
    let sessions = registry.sessions.lock().map_err(|e| e.to_string())?;
    let handle = sessions.get(&id).ok_or_else(|| "会话不存在".to_string())?;
    let mut writer = handle.writer.lock().map_err(|e| e.to_string())?;
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
    let sessions = registry.sessions.lock().map_err(|e| e.to_string())?;
    let handle = sessions.get(&id).ok_or_else(|| "会话不存在".to_string())?;
    let master = handle
        .master
        .as_ref()
        .ok_or_else(|| "该会话不支持调整尺寸（例如串口）".to_string())?;
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
pub fn session_close(id: String, registry: State<'_, SessionRegistry>) -> Result<(), String> {
    let mut sessions = registry.sessions.lock().map_err(|e| e.to_string())?;
    if let Some(handle) = sessions.remove(&id) {
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
    on_event: Channel<SessionEvent>,
    registry: State<'_, SessionRegistry>,
) -> Result<SessionInfo, String> {
    log::info!("ipc: open_serial path={path} baud={baud}");
    let title = format!("串口 · {path} · {baud}");
    let handle = serial::open(&path, baud, &title, on_event)?;
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

// ---------- Git ----------

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

/// 跑一个外部命令并拿到输出（隐藏控制台窗口）。
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
    cols: Option<u16>,
    rows: Option<u16>,
    on_event: Channel<SessionEvent>,
    app: tauri::AppHandle,
    registry: State<'_, SessionRegistry>,
) -> Result<SessionInfo, String> {
    let exe = adb_exe(&app);
    log::info!("ipc: open_adb_shell serial={serial} exe={exe:?}");
    let args = adb::shell_args(&serial);
    let program = exe.to_string_lossy().to_string();
    let title = format!("ADB · {serial}");
    let handle = pty::spawn(
        "adb",
        &title,
        &program,
        &args,
        None,
        cols.unwrap_or(110),
        rows.unwrap_or(30),
        on_event,
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

/// 列出服务器上的 tmux 会话（通过一次性 ssh 命令）。
#[tauri::command]
pub async fn tmux_list(
    profile_id: String,
    user_override: Option<String>,
) -> Result<Vec<tmux::TmuxSession>, String> {
    log::info!("ipc: tmux_list profile_id={profile_id} user={user_override:?}");
    let cfg = ssh_config_for(&profile_id, user_override)?;
    let args = ssh::ssh_exec_args(
        &cfg.host,
        cfg.port,
        &cfg.user,
        cfg.key_path.as_deref(),
        &tmux::list_remote_command(),
    );
    let out = run_ssh_capture(&args).await?;
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
    let args = ssh::ssh_exec_args(
        &cfg.host,
        cfg.port,
        &cfg.user,
        cfg.key_path.as_deref(),
        &tmux::kill_remote_command(&name),
    );
    let _ = run_ssh_capture(&args).await?;
    Ok(())
}

/// 列出远端目录（不传 path 则用登录后的家目录）。
#[tauri::command]
pub async fn fs_list(
    profile_id: String,
    path: Option<String>,
    user_override: Option<String>,
) -> Result<remote_fs::RemoteListing, String> {
    log::info!("ipc: fs_list profile_id={profile_id} path={path:?}");
    let cfg = ssh_config_for(&profile_id, user_override)?;
    let args = ssh::ssh_exec_args(
        &cfg.host,
        cfg.port,
        &cfg.user,
        cfg.key_path.as_deref(),
        &remote_fs::list_remote_command(path.as_deref()),
    );
    let out = run_ssh_capture(&args).await?;
    let listing = remote_fs::parse_listing(&out);
    log::info!(
        "ipc: fs_list -> {} entries at {}",
        listing.entries.len(),
        listing.path
    );
    Ok(listing)
}

/// 读取远端文件，返回 base64（二进制安全），最多 max_bytes 字节。
#[tauri::command]
pub async fn fs_read(
    profile_id: String,
    path: String,
    max_bytes: Option<u64>,
    user_override: Option<String>,
) -> Result<String, String> {
    log::info!("ipc: fs_read profile_id={profile_id} path={path}");
    let cfg = ssh_config_for(&profile_id, user_override)?;
    let limit = max_bytes.unwrap_or(512 * 1024);
    let args = ssh::ssh_exec_args(
        &cfg.host,
        cfg.port,
        &cfg.user,
        cfg.key_path.as_deref(),
        &remote_fs::read_remote_command(&path, limit),
    );
    let out = run_ssh_capture(&args).await?;
    Ok(out.trim().to_string())
}

// ---------- 会话历史 ----------

#[tauri::command]
pub fn history_list() -> Vec<HistoryEntry> {
    store::load_history()
}

#[tauri::command]
pub fn history_save(mut entry: HistoryEntry) -> Result<Vec<HistoryEntry>, String> {
    if entry.id.trim().is_empty() {
        entry.id = format!(
            "h-{}-{}",
            entry.profile_id,
            entry.tmux_session.clone().unwrap_or_else(|| "default".into())
        );
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
