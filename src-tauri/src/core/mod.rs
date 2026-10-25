pub mod adb;
pub mod ai;
/// 开了 herdr 的服务器 → 每 60 秒查一次 `herdr agent list`：驱动红点，并顺带把同一份结果
/// 作为卡片快照发给前端（`zeeai://herdr-agents`，不额外起进程）。走 `commands::herdr_agents`
/// 的隐藏窗口链路。口径见 §10.6。
pub mod ai_herdr_dots;
pub mod ai_history;
/// 本机 codex rollout 日志 → 红点 + 卡片增量（只读文件，不启动子进程）。口径见 §10.6。
pub mod ai_log_watch;
/// AI 看板 v2 的统一实体（"AI 实例"）。见 `docs/design-ai-board-v2.md` §3.1/§10。
pub mod ai_instance;
pub mod ai_sessions;
pub mod ai_tasks;
pub mod elevate;
pub mod git;
pub mod herdr;
pub mod herdr_stream;
pub mod highlight;
pub mod job;
/// SSH 主机密钥的 TOFU 记录（防中间人）；sftp 的 `check_server_key` 走它校验。
pub mod known_hosts;
pub mod paste;
pub mod proc;
pub mod pty;
pub mod remote_fs;
pub mod secret;
pub mod serial;
pub mod session;
pub mod session_log;
/// 进程内 SHA-256（**不再调 PATH 上的 certutil**：更新包校验会被 PATH 劫持）。
pub mod sha256;
pub mod sftp;
pub mod ssh;
pub mod tmux;
/// 升级辅助进程：等主程序退出 → 静默跑安装器 → 重启（**没有 .cmd、没有 shell**）。
pub mod update;

pub use ai_tasks::AiTaskRegistry;
pub use session::{HerdrInputPump, HerdrPaneRegistry, SessionEvent, SessionRegistry};
