use base64::Engine as _;
use portable_pty::PtySize;
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;

use crate::core::{
    adb, ai, git, pty, remote_fs, serial, sftp, ssh, tmux, SessionEvent, SessionRegistry,
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
    let mut resolved_tmux: Option<String> = None;
    let remote_cmd = match mode.as_str() {
        // 不用 tmux：给普通 shell 注入「上报当前目录」，文件面板才能跟着 cd 走
        "none" => Some(ssh::shell_with_cwd_report()),
        "name" => {
            let name = tmux_name.unwrap_or_default();
            if name.trim().is_empty() {
                Some(ssh::shell_with_cwd_report())
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

/// 跑一条一次性远端命令：有密码就用 russh exec（系统 ssh 喂不了密码），
/// 否则还是走系统 ssh（更快，也复用用户的 known_hosts / config）。
async fn run_remote_capture(
    profile_id: &str,
    cfg: &store::SshConfig,
    command: &str,
) -> Result<String, String> {
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

/// 下载新版安装包并做基本校验（大小 + 文件头），返回落盘路径。
///
/// 为什么要绕这么一圈：
/// - **不用第三方 HTTP 库**：直接用 Windows 自带的 `curl.exe`（Win10 1803+ 内置，
///   走系统 Schannel），不往程序里塞一整套 TLS 栈，exe 体积不变；
/// - **分片下载 + 断点续传**：实测这条线路对"长时间保持的下载连接"很不友好
///   （整包 9MB 经常传着传着就被掐断，卡在几个百分点），但 1MB 左右的分段请求
///   每次都能正常返回。所以这里按 1MB 一段发 `Range` 请求，从已有文件大小接着下，
///   中途断了、甚至关掉应用重来，都能从断点继续，不用从头再来；
/// - **抽成独立函数**：`examples/update_spike.rs` 可以拿真实 Release 地址直接验证。
///
/// `on_progress(done, total)` 在每段下完后回调一次。
pub fn fetch_update_package(
    url: &str,
    expected_size: u64,
    ext: &str,
    version: &str,
    mut on_progress: impl FnMut(u64, u64),
) -> Result<std::path::PathBuf, String> {
    use std::io::Read;

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

    // 已经传完的同版本文件直接用（比如上次下好了但没装成）
    let existing = std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
    if expected_size > 0 && existing == expected_size && header_ok(&dest, ext) {
        log::info!("update: 复用已下载好的更新包 {}", dest.display());
        on_progress(existing, expected_size);
        return Ok(dest);
    }
    // 文件比预期还大 = 服务器没接受 Range（或上次下串了），从头来
    if expected_size > 0 && existing > expected_size {
        let _ = std::fs::remove_file(&dest);
    }

    const CHUNK: u64 = 1024 * 1024; // 1MB 一段
    const CHUNK_TRIES: usize = 4;
    // 有系统代理就先用代理试（国内直连 GitHub 的下载 CDN 经常慢到几乎不动），
    // 后两次改成直连，避免"代理开着但其实没启动"时彻底下不来。
    let proxy = system_proxy();

    let mut done = std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
    on_progress(done, expected_size.max(done));

    if expected_size == 0 {
        // 不知道总大小（Release 没给 size）→ 只能整包下，靠 curl 自己的重试
        run_curl_to_file(&curl, url, None, &dest, true, proxy.as_deref())?;
        done = std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
        on_progress(done, done);
    } else {
        while done < expected_size {
            let start = done;
            let end = (start + CHUNK - 1).min(expected_size - 1);
            let mut last_err = String::new();
            let mut ok = false;
            for attempt in 1..=CHUNK_TRIES {
                let use_proxy = if attempt <= 2 { proxy.as_deref() } else { None };
                match run_curl_to_file(&curl, url, Some((start, end)), &dest, true, use_proxy) {
                    Ok(()) => {
                        ok = true;
                        break;
                    }
                    Err(e) => {
                        last_err = e;
                        log::warn!("update: 第 {attempt} 次取分片 {start}-{end} 失败：{last_err}");
                        std::thread::sleep(std::time::Duration::from_millis(800));
                    }
                }
            }
            if !ok {
                return Err(format!(
                    "下载中断（已收到 {done} 字节 / 共 {expected_size}）。网络恢复后再点一次「一键升级」会从断点继续：{last_err}"
                ));
            }
            let now = std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
            if now <= done {
                return Err(format!("下载卡住（已收到 {done} 字节 / 共 {expected_size}），请稍后重试"));
            }
            done = now;
            on_progress(done, expected_size.max(done));
        }
    }

    // 校验 1：大小必须和 Release 里标注的一致（防半截文件 / 被塞东西）
    if expected_size > 0 && done != expected_size {
        return Err(format!(
            "更新包大小不对（下载 {done} 字节，官方标注 {expected_size} 字节），请重试（会从断点继续）"
        ));
    }

    // 校验 2：文件头要对（exe = PE 的 MZ；msi = OLE 复合文档 D0CF11E0）
    if !header_ok(&dest, ext) {
        let _ = std::fs::remove_file(&dest);
        return Err("更新包不是有效的安装程序（文件头不对），已丢弃".into());
    }

    Ok(dest)
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

/// 调一次 curl：`range` 有值时取指定分段，并且**追加**到 dest 末尾。
fn run_curl_to_file(
    curl: &std::path::Path,
    url: &str,
    range: Option<(u64, u64)>,
    dest: &std::path::Path,
    append: bool,
    proxy: Option<&str>,
) -> Result<(), String> {
    use std::fs::OpenOptions;
    let file = OpenOptions::new()
        .create(true)
        .write(true)
        .append(append)
        .truncate(!append)
        .open(dest)
        .map_err(|e| format!("打开目标文件失败: {e}"))?;

    let mut cmd = std::process::Command::new(curl);
    cmd.arg("-L")
        .arg("--fail")
        .arg("--silent")
        .arg("--show-error")
        .arg("--retry")
        .arg("3")
        .arg("--retry-delay")
        .arg("1")
        .arg("--retry-all-errors");
    if let Some((start, end)) = range {
        cmd.arg("-r").arg(format!("{start}-{end}"));
    }
    if let Some(p) = proxy {
        cmd.arg("--proxy").arg(p);
    }
    cmd.arg("-o").arg("-"); // 写到 stdout，我们负责追加到文件
    cmd.arg(url);
    cmd.stdout(std::process::Stdio::from(file));
    cmd.stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }

    let out = cmd.output().map_err(|e| format!("启动 curl 失败: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        let msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if msg.is_empty() {
            format!("curl 退出码 {:?}", out.status.code())
        } else {
            msg
        })
    }
}


/// 下载新版安装包，校验后静默覆盖安装并自动重启应用。
///
/// 几点设计说明：
/// - **只允许 GitHub Release 的下载地址**：这条命令本质上会执行一个下载来的安装包，
///   所以地址必须形如 `https://github.com/<owner>/<repo>/releases/download/...`，
///   避免它变成"任意 URL 下载并执行"的后门；
/// - **校验**：见 [`fetch_update_package`]（大小 + 文件头）；
/// - **进度**：复用 `zeeai://transfer` 事件，右下角进度面板直接显示下载进度；
/// - **安装**：先写一个隐藏的 cmd 辅助脚本，等本进程退出后再执行安装，最后把应用拉起来。
///   NSIS / MSI 都盖不住正在运行的 exe，所以必须先退出再装。
#[tauri::command]
pub async fn update_download_install(
    app: tauri::AppHandle,
    url: String,
    expected_size: u64,
    version: String,
) -> Result<String, String> {
    let u = url.trim().to_string();
    if !(u.starts_with("https://github.com/") && u.contains("/releases/download/")) {
        return Err("更新地址不是 GitHub Release 的下载地址，已拒绝执行".into());
    }
    let kind = update_install_kind();
    if kind == "portable" {
        return Err("当前是便携版，无法自动覆盖升级：请下载压缩包解压替换（配置不会丢）".into());
    }
    log::info!(
        "ipc: update_download_install -> {u} (kind={kind}, expect {expected_size} bytes, v{version})"
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
        fetch_update_package(&u, expected_size, ext, &version, |done, total| {
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
        })
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
    let pid = std::process::id();
    let body = if kind == "msi" {
        // MSI：msiexec 静默升级（/qb 显示一个进度条；perMachine 会弹一次 UAC）
        format!(
            "msiexec /i \"{}\" /qb /norestart\r\nstart \"\" \"{}\"\r\n",
            dest.display(),
            exe_path.display()
        )
    } else {
        // NSIS：/S 静默安装 + /R 装完自动重启应用
        format!("\"{}\" /S /R\r\n", dest.display())
    };
    let script = format!(
        "@echo off\r\n\
rem 等 ZeeAI_Term 主程序退出（pid {pid}），再执行安装\r\n\
:wait\r\n\
tasklist /FI \"PID eq {pid}\" /NH | find \"{pid}\" >nul\r\n\
if not errorlevel 1 (\r\n\
  ping -n 2 127.0.0.1 >nul\r\n\
  goto wait\r\n\
)\r\n\
{body}"
    );
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
