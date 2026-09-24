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
    .setup(|app| {
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
              match crate::commands::tmux_list(profile.id.clone()).await {
                Ok(list) => log::info!("SELFTEST: tmux_list ok -> {} sessions", list.len()),
                Err(e) => log::error!("SELFTEST: tmux_list failed -> {e}"),
              }
              match crate::commands::fs_list(profile.id.clone(), None).await {
                Ok(listing) => log::info!(
                  "SELFTEST: fs_list ok -> {} entries at {}",
                  listing.entries.len(),
                  listing.path
                ),
                Err(e) => log::error!("SELFTEST: fs_list failed -> {e}"),
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
      commands::fs_list,
      commands::fs_read,
    ])
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
          if let Ok(mut child) = handle.child.lock() {
            let _ = child.kill();
          }
        }
      }
    });
}
