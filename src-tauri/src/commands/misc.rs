//! 其余 IPC：配置 CRUD、管理员、剪贴板粘贴、会话日志、扩展 URL、工作区、
//! 历史记录与设置。
use base64::Engine as _;
use tauri::State;

use crate::core::{elevate, highlight, paste as paste_core};
use crate::store::{self, ConnectionProfile, HistoryEntry, Settings};

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

/// 终端关键字高亮的预设规则包（前端「载入预设规则」按钮用）。
/// 规则本体存在 settings.json 里，这里只给一份出厂预设。
#[tauri::command]
pub fn highlight_presets() -> Vec<highlight::HighlightRule> {
    highlight::presets()
}

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

/// 把前端从**剪贴板 / 拖拽**拿到的文件落到本地临时文件，返回绝对路径。
///
/// 为什么要绕这一下：WebView 的 `paste` 事件能直接拿到文件字节（资源管理器里复制的文件、
/// 别的截图工具塞进剪贴板的位图，Chromium 都当 file 给出来），而上传送给已有的 `fs_upload`，
/// 它要的是**本地路径** —— 中间只差这一步落盘。见 core/paste.rs 的说明。
#[tauri::command]
pub fn paste_save_file(name: String, data_b64: String) -> Result<String, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_b64.trim())
        .map_err(|e| format!("内容不是合法的 base64：{e}"))?;
    let path = paste_core::save(&name, &bytes)?;
    log::info!("ipc: paste_save_file -> {path}（{} 字节）", bytes.len());
    Ok(path)
}

/// 上传成功后把本地临时文件删掉（只认粘贴临时目录里的路径，见 core/paste.rs）
#[tauri::command]
pub fn paste_discard_file(path: String) -> Result<(), String> {
    paste_core::discard(&path)
}

/// 把用户选中的本地文件收进粘贴临时目录，返回新路径（上传/预览/清理都只认这一个目录）
#[tauri::command]
pub fn paste_adopt_file(path: String) -> Result<String, String> {
    paste_core::adopt(&path)
}

/// 读粘贴进来的文件做**预览**（base64）。只认粘贴临时目录、最多 4MB。
#[tauri::command]
pub fn paste_read_thumb(path: String) -> Result<String, String> {
    let bytes = paste_core::read_thumb(&path)?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

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
        // 故意保留裸 Command::new：explorer.exe 就是要**显示窗口**的，
        // 不属于"后台探测/查询"，不能套 hidden_command（见 core/proc.rs 的例外说明）。
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

/// 校验「用系统默认浏览器打开」的 URL。
///
/// 以前是 `cmd /C start "" <url>`：URL 里只要带 `&` / `|` / `"` / `%VAR%` 就能
/// 拼出额外的 cmd 命令（经典命令注入）。现在两层防护：
/// 1. 只允许 http/https（`javascript:` / `file:` 直接拒）；
/// 2. 拒绝 shell 元字符与换行（命中即返回错误，**不静默**）——
///    即使将来启动方式退回 cmd，这层也拦得住。
fn validate_external_url(url: &str) -> Result<&str, String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err("链接为空".into());
    }
    let lower = trimmed.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err("只允许打开 http/https 链接".into());
    }
    for ch in trimmed.chars() {
        if matches!(ch, '&' | '|' | '<' | '>' | '^' | '"' | '%') || ch.is_control() {
            return Err(format!(
                "链接里含有不允许的字符 {ch:?}（可能导致命令注入），已拒绝打开"
            ));
        }
    }
    Ok(trimmed)
}

/// 用系统默认浏览器打开一个 http/https 链接（用于「检查更新 → 下载新版」）
#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), String> {
    let trimmed = validate_external_url(&url)?;
    log::info!("ipc: open_external_url {trimmed}");
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Foundation::{GetLastError, HINSTANCE};
        use windows_sys::Win32::UI::Shell::ShellExecuteW;
        use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

        fn wide(s: &str) -> Vec<u16> {
            std::ffi::OsStr::new(s)
                .encode_wide()
                .chain(std::iter::once(0))
                .collect()
        }

        // 直接 ShellExecuteW("open")：不经过 cmd，URL 不再有被 shell 解释的机会。
        // 浏览器窗口该出来（这是用户主动点链接），不需要隐藏窗口。
        let op = wide("open");
        let file = wide(trimmed);
        let rc: HINSTANCE = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                op.as_ptr(),
                file.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                SW_SHOWNORMAL,
            )
        };
        // ShellExecute 约定：返回值 <= 32 表示失败（32 是"找不到关联程序"）
        let code = rc as isize;
        if code <= 32 {
            let last = unsafe { GetLastError() };
            return Err(format!(
                "打开浏览器失败（ShellExecuteW 返回 {code}，系统错误 {last}）"
            ));
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = trimmed;
        Err("只支持 Windows".into())
    }
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
        // 普通 shell 的 id 也要带名字，否则同一台机器的多个普通 shell 会撞成同一个 id
        // herdr 会话按**窗格号**分条（同一个窗格只有一条记录，不同窗格互不覆盖）。
        let tail = if let Some(pane) = entry.herdr_pane.clone().filter(|p| !p.trim().is_empty()) {
            format!("herdr-{pane}")
        } else {
            entry
                .tmux_session
                .clone()
                .map(|t| format!("tmux-{t}"))
                .unwrap_or_else(|| {
                    format!("plain-{}", entry.title.clone().unwrap_or_else(|| "shell".into()))
                })
        };
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
mod security_tests {
    use super::*;

    /// `open_external_url` 的输入白名单：命令注入字符、非 http(s) 协议一律拒绝。
    #[test]
    fn external_url_rejects_injection_and_non_http() {
        for bad in [
            "https://x/&calc",
            "https://x/a%PATH%",
            "javascript:alert(1)",
            "file:///C:/Windows/System32/calc.exe",
            "https://x/\" & calc & \"",
            "https://x/a\ncalc",
            "https://x/|calc",
            "https://x/^calc",
            "ftp://example.com/file",
            "",
        ] {
            assert!(
                validate_external_url(bad).is_err(),
                "必须拒绝: {bad:?}"
            );
        }
        // 正常链接仍要放行
        assert_eq!(
            validate_external_url("  https://github.com/zeelinkCN/ZeeAI_Term  ").unwrap(),
            "https://github.com/zeelinkCN/ZeeAI_Term"
        );
        assert!(validate_external_url("http://127.0.0.1:64502/").is_ok());
    }
}
