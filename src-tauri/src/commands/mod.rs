//! Tauri IPC 命令入口。
//!
//! 原先 4000 行的 `commands.rs` 按域拆到子模块；对外路径仍是
//! `crate::commands::open_ssh` 这种形式（`lib.rs` 的 `generate_handler!` 不用改）。
//! 每个子模块里的命令保持 `pub` + `#[tauri::command]`，由这里统一 re-export。
//! `util` 只放共享辅助，不对外导出命令。

mod adb;
mod ai;
mod fs;
mod git;
mod herdr;
mod herdr_install;
mod misc;
mod session;
mod ssh;
mod update;
mod util;

pub use adb::*;
pub use ai::*;
pub use fs::*;
pub use git::*;
pub use herdr::*;
pub use herdr_install::*;
pub use misc::*;
pub use session::*;
pub use ssh::*;
pub use update::*;

// `TransferEvent` 原来就在 commands 根上（升级和文件传输共用），
// 现在落在 util，仍从同一路径导出，避免前端/调用方感知到移动。
pub use util::TransferEvent;
// 自检（lib.rs）直接调这个实现体，不是 IPC 命令；由上面的 glob 以 pub(crate) 带出。
