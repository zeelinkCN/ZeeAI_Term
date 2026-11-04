//! The UI submits session IDs only; all server/account/pane metadata is backend-owned.
use std::sync::Arc;
use tauri::State;

use crate::core::{
    ai_monitor::{self, AiMonitor},
    herdr::HerdrAgent,
    HerdrPaneRegistry, SessionRegistry,
};

use super::ssh::{run_remote_capture, ssh_config_for};

#[tauri::command]
pub fn ai_monitor_sessions_set(
    session_ids: Vec<String>,
    enabled: bool,
    monitor: State<'_, Arc<AiMonitor>>,
    registry: State<'_, SessionRegistry>,
    panes: State<'_, HerdrPaneRegistry>,
) -> Result<(), String> {
    monitor.set_sessions(session_ids, enabled, &registry, &panes)
}

/// Internal only: the watcher enforces the shared per-account schedule.
/// Do not expose an unrestricted manual-refresh IPC around this read operation.
pub(crate) async fn ai_monitor_agents_readonly(
    profile_id: &str,
    user: &str,
    fingerprints: &[String],
    effective_fingerprints: &[String],
) -> Result<Vec<HerdrAgent>, String> {
    let mut cfg = ssh_config_for(profile_id, None)
        .map_err(|_| ai_monitor::CONNECTION_CHANGED_ERROR.to_string())?;
    // An empty user also belongs to the original connection: keep SSH-config
    // resolution instead of adopting a newly edited profile default account.
    cfg.user = user.to_string();
    ai_monitor::verify_connection(&cfg, user, fingerprints)?;
    let effective = ai_monitor::resolve_connection_fingerprint(&cfg, user).await?;
    ai_monitor::verify_effective_connection(&effective, effective_fingerprints)?;
    let output =
        run_remote_capture(profile_id, &cfg, &ai_monitor::agents_readonly_command()).await?;
    ai_monitor::parse_agents_readonly(&output)
}
