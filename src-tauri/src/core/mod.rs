pub mod adb;
pub mod ai;
pub mod ai_history;
/// AI 看板 v2 的统一实体（"AI 实例"）。见 `docs/design-ai-board-v2.md` §3.1/§10。
pub mod ai_instance;
pub mod ai_sessions;
pub mod ai_tasks;
/// 本机 AI CLI 的健康检查（起不来 / 在自更新）。见 `docs/design-ai-board-v2.md` §10.8。
pub mod cli_health;
pub mod elevate;
pub mod git;
pub mod herdr;
pub mod herdr_stream;
pub mod highlight;
pub mod job;
pub mod paste;
pub mod pty;
pub mod remote_fs;
pub mod secret;
pub mod serial;
pub mod session;
pub mod session_log;
pub mod sftp;
pub mod ssh;
pub mod tmux;

pub use ai_tasks::AiTaskRegistry;
pub use session::{HerdrPaneRegistry, SessionEvent, SessionRegistry};
