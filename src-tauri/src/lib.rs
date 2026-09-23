mod commands;
mod core;
mod store;

use core::SessionRegistry;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_log::Builder::default().build())
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
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
