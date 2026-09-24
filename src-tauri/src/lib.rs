mod commands;
mod core;
mod store;

use core::SessionRegistry;
use tauri::Manager;
use tauri::Emitter;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(
      tauri_plugin_log::Builder::default()
        .level(log::LevelFilter::Info)
        .build(),
    )
    .plugin(tauri_plugin_dialog::init())
    .setup(|app| {
      // 系统托盘：配合「关闭时收进托盘」使用，也能快速唤回窗口
      {
        use tauri::menu::{Menu, MenuItem};
        use tauri::tray::TrayIconBuilder;
        let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
        let quit = MenuItem::with_id(app, "quit", "退出 ZeeAI Terminal", true, None::<&str>)?;
        let menu = Menu::with_items(app, &[&show, &quit])?;
        let mut builder = TrayIconBuilder::with_id("main-tray")
          .tooltip("ZeeAI Terminal")
          .menu(&menu)
          .show_menu_on_left_click(false)
          .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
              if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
              }
            }
            "quit" => app.exit(0),
            _ => {}
          });
        if let Some(icon) = app.default_window_icon() {
          builder = builder.icon(icon.clone());
        }
        let _ = builder.build(app);
      }
      // 自动化演示：设置 ZEEAI_AUTODEMO=1 时，启动后通知前端按脚本走一遍流程
      // （连接 → 切文件 → 打开预览），便于无人值守截图验证界面。
      if std::env::var("ZEEAI_AUTODEMO").is_ok() {
        let handle = app.handle().clone();
        std::thread::spawn(move || {
          std::thread::sleep(std::time::Duration::from_secs(4));
          let _ = handle.emit("zeeai://autodemo", ());
        });
      }
      // 无人值守自检：设置 ZEEAI_SELFTEST=1 启动时，对第一条 SSH 配置跑一遍
      // tmux 列表与远端目录列举，把结果写进日志后退出。便于 CI/夜里验证。
      if std::env::var("ZEEAI_SELFTEST").is_ok() {
        let handle = app.handle().clone();
        tauri::async_runtime::spawn(async move {
          let profiles = crate::store::load().unwrap_or_default();
          match profiles.iter().find(|p| p.ssh.is_some()) {
            Some(profile) => {
              log::info!("SELFTEST: using profile {}", profile.name);
              match crate::commands::tmux_list(profile.id.clone(), None).await {
                Ok(list) => {
                  log::info!("SELFTEST: tmux_list ok -> {} sessions", list.len());
                  // 「文件面板跟随终端目录」依赖这个：问 tmux 会话当前在哪个目录
                  if let Some(first) = list.first() {
                    match crate::commands::remote_pwd(
                      profile.id.clone(),
                      Some(first.name.clone()),
                      None,
                    )
                    .await
                    {
                      Ok(pwd) => log::info!(
                        "SELFTEST: remote_pwd ok -> tmux {} 在 {}",
                        first.name,
                        pwd
                      ),
                      Err(e) => log::error!("SELFTEST: remote_pwd failed -> {e}"),
                    }
                  }
                }
                Err(e) => log::error!("SELFTEST: tmux_list failed -> {e}"),
              }
              match crate::commands::fs_list(profile.id.clone(), None, None).await {
                Ok(listing) => log::info!(
                  "SELFTEST: fs_list ok -> {} entries at {}",
                  listing.entries.len(),
                  listing.path
                ),
                Err(e) => log::error!("SELFTEST: fs_list failed -> {e}"),
              }
              // 以另一个普通用户登录时，远程文件必须跟着这个用户走（家目录不同）。
              // 设 ZEEAI_SELFTEST_ALTUSER=zeeai 可验证「选用户登录」这条链路。
              if let Ok(alt_user) = std::env::var("ZEEAI_SELFTEST_ALTUSER") {
                if !alt_user.trim().is_empty() {
                  match crate::commands::fs_list(
                    profile.id.clone(),
                    None,
                    Some(alt_user.clone()),
                  )
                  .await
                  {
                    Ok(listing) => log::info!(
                      "SELFTEST: fs_list as {alt_user} ok -> {} entries at {}",
                      listing.entries.len(),
                      listing.path
                    ),
                    Err(e) => log::error!("SELFTEST: fs_list as {alt_user} failed -> {e}"),
                  }
                  match crate::commands::tmux_list(
                    profile.id.clone(),
                    Some(alt_user.clone()),
                  )
                  .await
                  {
                    Ok(list) => log::info!(
                      "SELFTEST: tmux_list as {alt_user} ok -> {} sessions",
                      list.len()
                    ),
                    Err(e) => log::error!("SELFTEST: tmux_list as {alt_user} failed -> {e}"),
                  }
                }
              }
              match crate::commands::adb_devices(handle.clone()).await {
                Ok(list) => log::info!("SELFTEST: adb_devices ok -> {} devices", list.len()),
                Err(e) => log::error!("SELFTEST: adb_devices failed -> {e}"),
              }
              match crate::commands::fastboot_devices(handle.clone()).await {
                Ok(list) => log::info!("SELFTEST: fastboot ok -> {} devices", list.len()),
                Err(e) => log::error!("SELFTEST: fastboot failed -> {e}"),
              }
              match crate::commands::serial_list() {
                Ok(list) => log::info!("SELFTEST: serial_list ok -> {} ports", list.len()),
                Err(e) => log::error!("SELFTEST: serial_list failed -> {e}"),
              }
              // 真机串口验证：ZEEAI_SELFTEST_SERIAL=COM5 指定端口（默认自动挑一个非蓝牙口），
              // 打开读 4 秒，看能不能真收到设备发出来的数据。
              {
                let wanted = std::env::var("ZEEAI_SELFTEST_SERIAL").unwrap_or_default();
                let ports = crate::core::serial::list().unwrap_or_default();
                let pick = if !wanted.trim().is_empty() {
                  ports.iter().find(|p| p.path.eq_ignore_ascii_case(wanted.trim()))
                } else {
                  ports
                    .iter()
                    .find(|p| !p.label.contains("蓝牙"))
                    .or_else(|| ports.first())
                };
                match pick {
                  Some(p) => match crate::core::serial::probe(&p.path, 115200, 4000) {
                    Ok((n, preview)) => log::info!(
                      "SELFTEST: serial_probe {} ({}) ok -> {} bytes | {}",
                      p.path,
                      p.label,
                      n,
                      preview
                    ),
                    Err(e) => log::error!("SELFTEST: serial_probe {} failed -> {e}", p.path),
                  },
                  None => log::warn!("SELFTEST: no serial port to probe"),
                }
              }
              // M3 文件传输链路：新建目录 → 上传 → 列目录 → 下载回来比对 → 改名 → 删除
              {
                let pid = profile.id.clone();
                let remote_dir = "/tmp/zeeai-selftest".to_string();
                let local_up = std::env::temp_dir().join("zeeai-selftest-up.txt");
                let local_down_dir = std::env::temp_dir().join("zeeai-selftest-dl");
                let payload = b"zeeai transfer selftest\n";
                let _ = std::fs::create_dir_all(&local_down_dir);
                let _ = std::fs::write(&local_up, payload);
                let _ = std::fs::remove_file(local_down_dir.join("zeeai-selftest-up.txt"));

                match crate::commands::fs_mkdir(pid.clone(), remote_dir.clone(), None).await {
                  Ok(()) => log::info!("SELFTEST: fs_mkdir ok -> {remote_dir}"),
                  Err(e) => log::error!("SELFTEST: fs_mkdir failed -> {e}"),
                }
                match crate::commands::fs_upload(
                  pid.clone(),
                  vec![local_up.to_string_lossy().to_string()],
                  remote_dir.clone(),
                  None,
                  None,
                  handle.clone(),
                )
                .await
                {
                  Ok(msg) => log::info!("SELFTEST: fs_upload ok -> {msg}"),
                  Err(e) => log::error!("SELFTEST: fs_upload failed -> {e}"),
                }
                let remote_file = format!("{remote_dir}/zeeai-selftest-up.txt");
                match crate::commands::fs_list(pid.clone(), Some(remote_dir.clone()), None).await {
                  Ok(listing) => log::info!(
                    "SELFTEST: fs_upload verify -> {} entries ({})",
                    listing.entries.len(),
                    listing
                      .entries
                      .iter()
                      .map(|e| e.name.clone())
                      .collect::<Vec<_>>()
                      .join(",")
                  ),
                  Err(e) => log::error!("SELFTEST: fs_upload verify failed -> {e}"),
                }
                match crate::commands::fs_download(
                  pid.clone(),
                  vec![remote_file.clone()],
                  local_down_dir.to_string_lossy().to_string(),
                  None,
                  None,
                  handle.clone(),
                )
                .await
                {
                  Ok(msg) => {
                    let got = std::fs::read(local_down_dir.join("zeeai-selftest-up.txt"))
                      .unwrap_or_default();
                    log::info!(
                      "SELFTEST: fs_download ok -> {msg} (roundtrip match = {})",
                      got == payload
                    );
                  }
                  Err(e) => log::error!("SELFTEST: fs_download failed -> {e}"),
                }
                match crate::commands::fs_rename(
                  pid.clone(),
                  remote_file.clone(),
                  format!("{remote_dir}/renamed.txt"),
                  None,
                )
                .await
                {
                  Ok(()) => log::info!("SELFTEST: fs_rename ok"),
                  Err(e) => log::error!("SELFTEST: fs_rename failed -> {e}"),
                }
                match crate::commands::fs_remove(pid.clone(), remote_dir.clone(), None).await {
                  Ok(()) => log::info!("SELFTEST: fs_remove ok -> {remote_dir}"),
                  Err(e) => log::error!("SELFTEST: fs_remove failed -> {e}"),
                }
                let _ = std::fs::remove_file(&local_up);
                let _ = std::fs::remove_dir_all(&local_down_dir);
              }
              let probe_dir = std::env::current_dir()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();
              match crate::commands::git_status(probe_dir.clone()).await {
                Ok(s) => log::info!(
                  "SELFTEST: git_status ok -> ok={} branch={} files={} dir={}",
                  s.ok,
                  s.branch,
                  s.files.len(),
                  probe_dir
                ),
                Err(e) => log::error!("SELFTEST: git_status failed -> {e}"),
              }
            }
            None => log::warn!("SELFTEST: no ssh profile found"),
          }
          log::info!("SELFTEST: done");
          handle.exit(0);
        });
      }
      Ok(())
    })
    .manage(SessionRegistry::new())
    .invoke_handler(tauri::generate_handler![
      commands::list_profiles,
      commands::save_profile,
      commands::delete_profile,
      commands::open_local,
      commands::open_ssh,
      commands::session_write,
      commands::session_resize,
      commands::session_close,
      commands::tmux_list,
      commands::tmux_kill,
      commands::remote_pwd,
      commands::fs_list,
      commands::fs_read,
      commands::fs_upload,
      commands::fs_download,
      commands::fs_mkdir,
      commands::fs_remove,
      commands::fs_rename,
      commands::history_list,
      commands::history_save,
      commands::history_remove,
      commands::settings_get,
      commands::settings_set,
      commands::adb_version,
      commands::adb_devices,
      commands::open_adb_shell,
      commands::serial_list,
      commands::open_serial,
      commands::fastboot_version,
      commands::fastboot_devices,
      commands::git_status,
      commands::git_init,
      commands::git_add,
      commands::git_unstage,
      commands::git_discard,
      commands::git_commit,
      commands::git_log,
      commands::git_branches,
      commands::git_checkout,
      commands::git_diff,
      commands::git_show,
    ])
    .on_window_event(|window, event| {
      // 「关闭时收进托盘」：拦截关闭请求并隐藏窗口（托盘菜单可唤回）
      if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        let settings = crate::store::load_settings();
        if settings.close_action == "tray" {
          api.prevent_close();
          let _ = window.hide();
          log::info!("window close intercepted -> hidden to tray");
        }
      }
    })
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|app_handle, event| {
      // 退出前把所有会话进程收干净（Job Object 也会兜底，但显式做更清晰）
      if let tauri::RunEvent::Exit = event {
        let registry = app_handle.state::<SessionRegistry>();
        // 先把句柄取出来再 kill，避免在持有 map 锁的同时去碰子进程
        let handles: Vec<_> = match registry.sessions.lock() {
          Ok(mut sessions) => sessions.drain().map(|(_, handle)| handle).collect(),
          Err(_) => Vec::new(),
        };
        for handle in handles {
          if let Some(child) = handle.child.as_ref() {
            if let Ok(mut child) = child.lock() {
              let _ = child.kill();
            }
          }
        }
      }
    });
}
