use base64::Engine as _;
use portable_pty::PtySize;
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;

use crate::core::{
    adb, ai, ai_tasks, git, highlight, pty, remote_fs, serial, sftp, ssh, tmux, AiTaskRegistry,
    SessionEvent, SessionRegistry,
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

/// 终端关键字高亮的预设规则包（前端「载入预设规则」按钮用）。
/// 规则本体存在 settings.json 里，这里只给一份出厂预设。
#[tauri::command]
pub fn highlight_presets() -> Vec<highlight::HighlightRule> {
    highlight::presets()
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
            let (procs, panes) = ai_tasks::parse_remote(&out);
            Some(ai_tasks::classify(&procs, &panes, "remote", &server))
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
                    let (procs, panes) = ai_tasks::parse_remote(&out);
                    let mut list = ai_tasks::classify(&procs, &panes, env, &server);
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
                    let procs = ai_tasks::parse_windows(&out);
                    let mut list =
                        ai_tasks::classify(&procs, &std::collections::HashMap::new(), env, &server);
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
    // 有系统代理就先用代理试（国内直连 GitHub 的下载 CDN 经常慢到几乎不动），
    // 第二次改成直连，避免"代理开着但其实没启动"时彻底下不来。
    let proxy = system_proxy();

    let mut last_err = String::new();
    for attempt in 1..=2u8 {
        let _ = std::fs::remove_file(&part);
        let use_proxy = if attempt == 1 { proxy.as_deref() } else { None };
        log::info!(
            "update: 第 {attempt} 次整包下载 {url}（proxy={use_proxy:?}，期望 {expected_size} 字节）"
        );
        let one = run_curl_download(&curl, url, &part, expected_size, use_proxy, &mut on_progress)
            .and_then(|()| {
                match package_problem(&part, ext, expected_size, expected_sha) {
                    None => Ok(()),
                    Some(why) => Err(why),
                }
            });
        match one {
            Ok(()) => {
                // 校验全过 → 原子改名成正式包
                let _ = std::fs::remove_file(&dest);
                std::fs::rename(&part, &dest).map_err(|e| format!("重命名更新包失败: {e}"))?;
                let done = std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
                on_progress(done, done);
                log::info!("update: 更新包已下好并校验通过 {}", dest.display());
                return Ok(dest);
            }
            Err(e) => {
                last_err = e;
                log::warn!("update: 第 {attempt} 次下载/校验没过：{last_err}");
                let _ = std::fs::remove_file(&part);
                if attempt == 1 {
                    std::thread::sleep(std::time::Duration::from_millis(1500));
                }
            }
        }
    }
    Err(format!("更新包下载或校验失败（已自动重试一次）：{last_err}"))
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

/// 调一次 curl：**整包一次下完**（不分片、不续传），支持代理。
///
/// 三条都是 0.1.5 事故留下的教训：
/// - **带超时**：连不上 15 秒、或 60 秒内平均速率低于 2KB/s 就判失败去重试，
///   顺序挂在这里等死（0.1.5 那个僵尸 curl 就是这么来的）；
/// - **stderr 写文件不写管道**：管道没人读、写满之后双方互等 = 死锁；
/// - **挂进 Job Object**：App 退出/被强杀时 curl 跟着被收掉，不留孤儿进程。
///
/// 进度靠轮询文件大小（整包下载也能有进度条）。
fn run_curl_download(
    curl: &std::path::Path,
    url: &str,
    dest: &std::path::Path,
    expected_size: u64,
    proxy: Option<&str>,
    on_progress: &mut impl FnMut(u64, u64),
) -> Result<(), String> {
    let mut err_path = dest.as_os_str().to_os_string();
    err_path.push(".stderr");
    let err_path = std::path::PathBuf::from(err_path);
    let _ = std::fs::remove_file(dest);
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

    on_progress(0, expected_size);
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
fn apply_update_script(
    kind: &str,
    dest: &std::path::Path,
    log: &std::path::Path,
    exe_path: &std::path::Path,
    pid: u32,
) -> String {
    // 安装那一步单独一行：无论成不成，退出码都拿得到（0 = 成功）
    let install = if kind == "msi" {
        // MSI：msiexec 静默升级（/qb 显示一个进度条；perMachine 会弹一次 UAC）
        format!("msiexec /i \"{}\" /qb /norestart", dest.display())
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
if \"%RC%\"==\"0\" goto done\r\n\
if \"%RC%\"==\"3010\" goto done\r\n\
del /f /q \"{dest}\" >nul 2>&1\r\n\
echo %DATE% %TIME% 安装失败，已丢弃这次下载的更新包 >> \"{log}\"\r\n\
start \"\" \"{exe}\"\r\n\
:done\r\n",
        pid = pid,
        install = install,
        log = log.display(),
        dest = dest.display(),
        exe = exe_path.display(),
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
    if !(u.starts_with("https://github.com/") && u.contains("/releases/download/")) {
        return Err("更新地址不是 GitHub Release 的下载地址，已拒绝执行".into());
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
    // 顺手把升级脚本也挂进 Job Object：万一它自己卡住，App 退出时会一起被收掉
    crate::core::job::assign(child.id());

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

        // MSI 走 msiexec，且 3010（要重启）也算成功
        let m = apply_update_script("msi", &dest, &log, &exe, 7);
        assert!(m.contains("msiexec /i"), "{m}");
        assert!(m.contains("\"%RC%\"==\"3010\" goto done"), "{m}");
    }
}
