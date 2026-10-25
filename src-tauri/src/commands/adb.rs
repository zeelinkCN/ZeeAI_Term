//! ADB / Fastboot：设备列表、文件管理、设备 shell / logcat。
use tauri::ipc::Channel;
use tauri::State;

use crate::core::{adb, pty, remote_fs, SessionEvent, SessionRegistry};

use super::session::SessionInfo;
use super::util::{capture_text, run_capture};

#[tauri::command]
pub async fn fastboot_version(app: tauri::AppHandle) -> Result<String, String> {
    let exe = adb_exe(&app).with_file_name("fastboot.exe");
    let out = capture_text(&exe, &["--version".into()], "读取 fastboot 版本").await?;
    Ok(out.lines().next().unwrap_or("").trim().to_string())
}

#[tauri::command]
pub async fn fastboot_devices(app: tauri::AppHandle) -> Result<Vec<adb::AdbDevice>, String> {
    let exe = adb_exe(&app).with_file_name("fastboot.exe");
    let out = capture_text(&exe, &["devices".into()], "列出 fastboot 设备").await?;
    let devices = adb::parse_fastboot_devices(&out);
    log::info!("ipc: fastboot_devices -> {} devices", devices.len());
    Ok(devices)
}

/// ADB 的 `shell` 只接受**一整条命令字符串**（不像 `exec` 那样有 argv 分隔），
/// 所以路径必须按远端 shell 的规则做单引号转义。
///
/// 复用 `core::remote_fs::sq`（和 SSH 文件面板同一套规则）：以前这里是
/// `format!("ls -la '{dir}'")`，路径里带一个 `'` 就能闭合引号、在设备上执行任意命令。
fn adb_ls_command(dir: &str) -> String {
    format!("ls -la {}", remote_fs::sq(dir))
}

fn adb_rm_command(path: &str, is_dir: bool) -> String {
    if is_dir {
        format!("rm -rf {}", remote_fs::sq(path))
    } else {
        format!("rm -f {}", remote_fs::sq(path))
    }
}

fn adb_mkdir_command(path: &str) -> String {
    format!("mkdir -p {}", remote_fs::sq(path))
}

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
        adb_ls_command(&dir),
    ];
    let out = capture_text(&exe, &args, "列出设备目录").await?;
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
    let (ok, text) = run_capture(&exe, &args).await?;
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
        let (ok, text) = run_capture(&exe, &args).await?;
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
    let cmd = adb_rm_command(&path, is_dir.unwrap_or(false));
    let args = vec!["-s".to_string(), serial, "shell".to_string(), cmd];
    let (ok, text) = run_capture(&exe, &args).await?;
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
        adb_mkdir_command(&path),
    ];
    let (ok, text) = run_capture(&exe, &args).await?;
    if ok {
        Ok(())
    } else {
        Err(text.trim().to_string())
    }
}

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
    let out = capture_text(&exe, &["version".into()], "读取 adb 版本").await?;
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
    let out = capture_text(&exe, &["devices".into(), "-l".into()], "列出 adb 设备").await?;
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


#[cfg(test)]
mod security_tests {
    use super::*;

    /// ADB shell 是"一整条字符串交给设备端 sh"，路径里的 `'` / `;` / `&&` / 空格
    /// 都必须被 `remote_fs::sq` 转义成字面量，不能跑出 shell 语法。
    #[test]
    fn adb_shell_commands_quote_dangerous_paths() {
        let path = "/sdcard/a b'c; rm -rf / && echo pwned";

        assert_eq!(
            adb_ls_command(path),
            "ls -la '/sdcard/a b'\\''c; rm -rf / && echo pwned'"
        );
        assert_eq!(
            adb_rm_command(path, true),
            "rm -rf '/sdcard/a b'\\''c; rm -rf / && echo pwned'"
        );
        assert_eq!(
            adb_rm_command(path, false),
            "rm -f '/sdcard/a b'\\''c; rm -rf / && echo pwned'"
        );
        assert_eq!(
            adb_mkdir_command(path),
            "mkdir -p '/sdcard/a b'\\''c; rm -rf / && echo pwned'"
        );

        // 内部那个单引号必须转义成 '\''；如果把转义去掉，`; rm -rf /` 就会变成独立命令
        let cmd = adb_rm_command(path, true);
        assert!(cmd.contains(r"'/sdcard/a b'\''c; rm -rf / && echo pwned'"), "{cmd}");
    }

    /// 正常路径也要保持原样，别把引号加错（`/sdcard` 不能变成带空格的怪串）
    #[test]
    fn adb_shell_commands_keep_plain_paths() {
        assert_eq!(adb_ls_command("/sdcard"), "ls -la '/sdcard'");
        assert_eq!(adb_mkdir_command("/sdcard/My Files"), "mkdir -p '/sdcard/My Files'");
    }
}
