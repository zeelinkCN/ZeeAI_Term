//! AI monitoring is scoped to live herdr sessions explicitly selected by the UI.
//! No profile enumeration, local log watching, remote writes, or notification logic.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{Emitter, Manager};
use tokio::sync::Notify;

use super::herdr::{self, HerdrAgent};
use super::session::{HerdrPaneMeta, HerdrPaneRegistry, SessionHandle, SessionRegistry};

pub const EVENT_NAME: &str = "zeeai://ai-monitor-herdr";
pub const POLL_MS: u64 = 60_000;
pub const CONNECTION_CHANGED_ERROR: &str =
    "ssh_connection_changed: SSH 连接配置已变更，监控已停止，请重新连接该会话";
const CONNECTION_UNVERIFIABLE_ERROR: &str =
    "ssh_connection_changed: 无法确认 SSH 连接配置，请修正配置后重新连接该会话";
const NOT_INSTALLED: &str = "ZEEAI_AI_MONITOR_NOT_INSTALLED";
const EXIT_PREFIX: &str = "ZEEAI_AI_MONITOR_EXIT:";

/// Bind probes to the SSH destination/auth options used to open the stream.
/// Store only a digest; no passwords or additional user files are read here.
pub(crate) fn connection_fingerprint(cfg: &crate::store::SshConfig, user: &str) -> String {
    let fields = serde_json::json!([
        cfg.host,
        cfg.port,
        user,
        cfg.key_path,
        cfg.jump,
        cfg.auth_kind,
        cfg.allow_password
    ]);
    super::sha256::hex_digest(fields.to_string().as_bytes())
}

pub(crate) fn verify_connection(
    cfg: &crate::store::SshConfig,
    user: &str,
    expected: &[String],
) -> Result<(), String> {
    let current = connection_fingerprint(cfg, user);
    if expected.is_empty() || expected.iter().any(|fingerprint| fingerprint != &current) {
        return Err(CONNECTION_CHANGED_ERROR.into());
    }
    Ok(())
}

/// Include OpenSSH alias resolution, without retaining host names, account
/// names, key paths, proxy commands, or any other diagnostic fields in state.
pub(crate) fn effective_connection_fingerprint(
    effective: &super::ssh::SshEffectiveConfig,
) -> String {
    super::sha256::hex_digest(serde_json::json!(effective).to_string().as_bytes())
}

/// Local configuration parsing only; this does not create an SSH connection.
pub(crate) async fn resolve_connection_fingerprint(
    cfg: &crate::store::SshConfig,
    user: &str,
) -> Result<String, String> {
    let diagnosis = super::ssh::diagnose(
        &cfg.host,
        cfg.port,
        user,
        cfg.key_path.as_deref(),
        cfg.jump.as_deref(),
    )
    .await
    .map_err(|_| CONNECTION_UNVERIFIABLE_ERROR.to_string())?;
    Ok(effective_connection_fingerprint(&diagnosis.effective))
}

pub(crate) fn verify_effective_connection(
    current: &str,
    expected: &[String],
) -> Result<(), String> {
    if current.is_empty()
        || expected.is_empty()
        || expected.iter().any(|fingerprint| fingerprint != current)
    {
        return Err(CONNECTION_CHANGED_ERROR.into());
    }
    Ok(())
}

/// A dedicated read-only query. Capture the remote exit code inside the protocol
/// so transport failures, a stopped server, and a valid empty list stay distinct.
pub fn agents_readonly_command() -> String {
    format!(
        "{}; if [ -z \"$H\" ]; then printf '{NOT_INSTALLED}\\n'; else O=$(\"$H\" agent list 2>&1); R=$?; printf '{EXIT_PREFIX}%s\\n%s\\n' \"$R\" \"$O\"; fi",
        herdr::CLI_PREFIX
    )
}

pub fn parse_agents_readonly(text: &str) -> Result<Vec<HerdrAgent>, String> {
    let text = text.trim();
    if text == NOT_INSTALLED {
        return Err("herdr_not_installed: 未安装 herdr".into());
    }
    let invalid = || "herdr_output_invalid: herdr agent list 输出格式错误".to_string();
    let (header, body) = text.split_once('\n').ok_or_else(invalid)?;
    let code = header
        .trim()
        .strip_prefix(EXIT_PREFIX)
        .and_then(|s| s.parse::<u8>().ok())
        .ok_or_else(invalid)?;
    let value: serde_json::Value = serde_json::from_str(body.trim()).map_err(|_| {
        if code == 0 {
            invalid()
        } else {
            "herdr_query_failed: herdr agent list 执行失败".into()
        }
    })?;
    if let Some(error) = value.get("error") {
        return Err(
            if error.get("code").and_then(|v| v.as_str()) == Some("server_not_running") {
                "herdr_server_not_running: herdr 服务未运行".into()
            } else {
                "herdr_query_failed: herdr agent list 返回错误".into()
            },
        );
    }
    if code != 0 {
        return Err("herdr_query_failed: herdr agent list 执行失败".into());
    }
    let result = value.get("result").ok_or_else(invalid)?;
    // TUI v0.9.5 / protocol 22 tags result.type. Keep the older adapter's
    // top-level tag shape compatible, while rejecting unrelated responses.
    if result
        .get("type")
        .or_else(|| value.get("type"))
        .and_then(|v| v.as_str())
        != Some("agent_list")
    {
        return Err(invalid());
    }
    let list = result
        .get("agents")
        .and_then(|v| v.as_array())
        .ok_or_else(invalid)?;
    // Never silently turn an unrecognized or damaged response into "no AI".
    for agent in list {
        if agent
            .get("pane_id")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .unwrap_or("")
            .is_empty()
            || agent
                .get("agent")
                .map(|v| !v.is_null() && !v.is_string())
                .unwrap_or(false)
            || agent.get("agent_status").and_then(|v| v.as_str()).is_none()
        {
            return Err(invalid());
        }
    }
    Ok(herdr::parse_agents(body))
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
struct Account {
    profile_id: String,
    user: String,
}

#[derive(Clone, Debug)]
struct Target {
    session_id: String,
    account: Account,
    pane_id: String,
    fingerprint: String,
    effective_fingerprint: String,
    connection: Arc<AtomicBool>,
    generation: u64,
}

fn child_is_running(handle: &SessionHandle) -> bool {
    handle.kind == "ssh"
        && handle.master.is_none()
        && handle
            .child
            .as_ref()
            .and_then(|child| child.lock().ok())
            .map(|mut child| matches!(child.try_wait(), Ok(None)))
            .unwrap_or(false)
}

fn target_from(session_id: &str, handle: &SessionHandle, meta: &HerdrPaneMeta) -> Option<Target> {
    if !matches!(meta.mode.as_str(), "observe" | "control")
        || meta.close_flag.load(Ordering::Acquire)
        || meta.profile_id.is_empty()
        || meta.pane_id.trim().is_empty()
        || meta.connection_fingerprint.is_empty()
        || meta.effective_connection_fingerprint.is_empty()
        || !child_is_running(handle)
    {
        return None;
    }
    Some(Target {
        session_id: session_id.into(),
        account: Account {
            profile_id: meta.profile_id.clone(),
            // Metadata binds this to the account used when the stream opened.
            // None is not sufficient evidence; it must not use a later profile default.
            user: meta.user.as_ref()?.trim().to_string(),
        },
        pane_id: meta.pane_id.clone(),
        fingerprint: meta.connection_fingerprint.clone(),
        effective_fingerprint: meta.effective_connection_fingerprint.clone(),
        connection: meta.close_flag.clone(),
        generation: 0,
    })
}

fn same_connection(a: &Target, b: &Target) -> bool {
    a.session_id == b.session_id
        && a.account == b.account
        && a.pane_id == b.pane_id
        && a.fingerprint == b.fingerprint
        && a.effective_fingerprint == b.effective_fingerprint
        && Arc::ptr_eq(&a.connection, &b.connection)
}

fn live_target(
    target: &Target,
    sessions: &HashMap<String, SessionHandle>,
    panes: &HashMap<String, HerdrPaneMeta>,
) -> bool {
    sessions
        .get(&target.session_id)
        .zip(panes.get(&target.session_id))
        .and_then(|(handle, meta)| target_from(&target.session_id, handle, meta))
        .map(|now| same_connection(target, &now))
        .unwrap_or(false)
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HerdrMonitorEvent {
    pub session_ids: Vec<String>,
    pub at_ms: u64,
    pub agents: Vec<HerdrAgent>,
    pub error: Option<String>,
}

#[derive(Default)]
struct Schedule {
    next_at_ms: u64,
    failures: u32,
    in_flight: bool,
    suspended_scope: Option<Vec<(String, u64)>>,
}

#[derive(Clone)]
struct Work {
    account: Account,
    targets: Vec<Target>,
}

fn scope_signature(targets: &[Target]) -> Vec<(String, u64)> {
    targets
        .iter()
        .map(|target| (target.session_id.clone(), target.generation))
        .collect()
}

#[derive(Default)]
struct MonitorState {
    enabled: bool,
    stopped: bool,
    generation: u64,
    targets: BTreeMap<String, Target>,
    // Retain limits even when disabled or the last pane on an account closes.
    schedules: BTreeMap<Account, Schedule>,
}

impl MonitorState {
    fn set_scope(&mut self, enabled: bool, targets: Vec<Target>) {
        self.enabled = enabled && !self.stopped;
        self.generation = self.generation.wrapping_add(1);
        let mut next = BTreeMap::new();
        if self.enabled {
            for mut target in targets {
                target.generation = self
                    .targets
                    .get(&target.session_id)
                    .filter(|old| same_connection(old, &target))
                    .map(|old| old.generation)
                    .unwrap_or(self.generation);
                next.insert(target.session_id.clone(), target);
            }
        }
        self.targets = next;
    }

    fn plan(&mut self, now: u64, live: impl Fn(&Target) -> bool) -> (Vec<Work>, Option<Duration>) {
        if !self.enabled || self.stopped {
            return (Vec::new(), None);
        }
        self.targets.retain(|_, target| live(target));
        let mut groups: BTreeMap<Account, Vec<Target>> = BTreeMap::new();
        for target in self.targets.values() {
            groups
                .entry(target.account.clone())
                .or_default()
                .push(target.clone());
        }
        let mut work = Vec::new();
        let mut next = None;
        for (account, targets) in groups {
            let schedule = self.schedules.entry(account.clone()).or_default();
            if schedule.in_flight {
                continue;
            }
            if schedule.suspended_scope.as_ref() == Some(&scope_signature(&targets)) {
                continue;
            }
            schedule.suspended_scope = None;
            if now >= schedule.next_at_ms {
                schedule.in_flight = true;
                schedule.next_at_ms = now.saturating_add(POLL_MS);
                work.push(Work { account, targets });
            } else {
                let wait = schedule.next_at_ms - now;
                next = Some(next.map(|n: u64| n.min(wait)).unwrap_or(wait));
            }
        }
        (work, next.map(Duration::from_millis))
    }

    fn current_targets<'a>(
        &'a self,
        work: &'a Work,
        live: impl Fn(&Target) -> bool,
    ) -> Vec<&'a Target> {
        if !self.enabled || self.stopped {
            return Vec::new();
        }
        work.targets
            .iter()
            .filter(|target| {
                self.targets
                    .get(&target.session_id)
                    .map(|current| {
                        current.generation == target.generation && same_connection(target, current)
                    })
                    .unwrap_or(false)
                    && live(target)
            })
            .collect()
    }

    fn finish(
        &mut self,
        work: &Work,
        result: Option<Result<Vec<HerdrAgent>, String>>,
        now: u64,
        at_ms: u64,
        live: impl Fn(&Target) -> bool,
    ) -> Option<HerdrMonitorEvent> {
        let schedule = self.schedules.get_mut(&work.account)?;
        schedule.in_flight = false;
        if matches!(result.as_ref(), Some(Err(error)) if error.starts_with("ssh_connection_changed:"))
        {
            // This connection must be reopened. Scope re-renders do not resume
            // probes or leave a periodic timer for a changed destination.
            schedule.suspended_scope = Some(scope_signature(&work.targets));
        }
        if let Some(ref result) = result {
            let wait = if result.is_ok() {
                schedule.failures = 0;
                POLL_MS
            } else {
                schedule.failures = schedule.failures.saturating_add(1);
                if schedule.failures == 1 {
                    120_000
                } else {
                    300_000
                }
            };
            schedule.next_at_ms = schedule.next_at_ms.max(now.saturating_add(wait));
        }
        let result = result?;
        let targets = self.current_targets(work, live);
        if targets.is_empty() {
            return None;
        }
        let panes: BTreeSet<&str> = targets.iter().map(|t| t.pane_id.as_str()).collect();
        let (agents, error) = match result {
            Ok(agents) => {
                let agents = agents
                    .into_iter()
                    .filter_map(|mut agent| {
                        if !panes.contains(agent.pane_id.as_str()) {
                            return None;
                        }
                        agent.kind = canonical_kind(&agent.kind)?.into();
                        Some(agent)
                    })
                    .collect();
                (agents, None)
            }
            Err(error) => (Vec::new(), Some(error)),
        };
        Some(HerdrMonitorEvent {
            session_ids: targets.iter().map(|t| t.session_id.clone()).collect(),
            at_ms,
            agents,
            error,
        })
    }
}

fn canonical_kind(kind: &str) -> Option<&'static str> {
    let name = kind
        .trim()
        .rsplit(['/', '\\'])
        .next()?
        .to_ascii_lowercase()
        .replace('_', "-");
    match name.strip_suffix(".exe").unwrap_or(&name) {
        "codex" | "codex-cli" | "openai-codex" | "openai codex" => Some("codex"),
        "claude" | "claude-code" | "claude-cli" | "claude code" | "anthropic-claude" => {
            Some("claude")
        }
        _ => None,
    }
}

pub struct AiMonitor {
    state: Mutex<MonitorState>,
    wake: Notify,
    started: Instant,
}

impl Default for AiMonitor {
    fn default() -> Self {
        Self {
            state: Mutex::new(MonitorState::default()),
            wake: Notify::new(),
            started: Instant::now(),
        }
    }
}

impl AiMonitor {
    fn now(&self) -> u64 {
        self.started.elapsed().as_millis() as u64
    }

    pub fn set_sessions(
        &self,
        session_ids: Vec<String>,
        enabled: bool,
        registry: &SessionRegistry,
        panes: &HerdrPaneRegistry,
    ) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|e| e.to_string())?;
        // Keep scope and registry checks in the same critical section as result
        // delivery, so disabling/removing a session cannot race a later emit.
        let targets = if enabled {
            let sessions = registry.sessions.lock().map_err(|e| e.to_string())?;
            let panes = panes.panes.lock().map_err(|e| e.to_string())?;
            session_ids
                .into_iter()
                .collect::<BTreeSet<_>>()
                .into_iter()
                .filter_map(|id| target_from(&id, sessions.get(&id)?, panes.get(&id)?))
                .collect()
        } else {
            Vec::new()
        };
        state.set_scope(enabled, targets);
        drop(state);
        self.wake.notify_one();
        Ok(())
    }

    pub fn stop(&self) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.stopped = true;
        state.set_scope(false, Vec::new());
        drop(state);
        self.wake.notify_one();
    }
}

fn wall_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn spawn(app: tauri::AppHandle) {
    let monitor = app.state::<Arc<AiMonitor>>().inner().clone();
    tauri::async_runtime::spawn(async move {
        let mut jobs = tokio::task::JoinSet::new();
        let mut pending = HashMap::new();
        loop {
            // Register before reading state, so a scope update cannot be lost
            // between planning and sleeping. With no targets there is no timer.
            let wake = monitor.wake.notified();
            tokio::pin!(wake);
            wake.as_mut().enable();
            let (work, wait) = {
                let mut state = monitor.state.lock().unwrap_or_else(|e| e.into_inner());
                if state.stopped {
                    break;
                }
                let registry = app.state::<SessionRegistry>();
                let panes = app.state::<HerdrPaneRegistry>();
                let sessions = registry.sessions.lock().unwrap_or_else(|e| e.into_inner());
                let panes = panes.panes.lock().unwrap_or_else(|e| e.into_inner());
                state.plan(monitor.now(), |target| {
                    live_target(target, &sessions, &panes)
                })
            };
            for work in work {
                let account = work.account.clone();
                let task_app = app.clone();
                let task_monitor = monitor.clone();
                let check = work.clone();
                let task = jobs.spawn(async move {
                    let (fingerprints, effective_fingerprints): (Vec<_>, Vec<_>) = {
                        let state = task_monitor.state.lock().unwrap_or_else(|e| e.into_inner());
                        let registry = task_app.state::<SessionRegistry>();
                        let panes = task_app.state::<HerdrPaneRegistry>();
                        let sessions = registry.sessions.lock().unwrap_or_else(|e| e.into_inner());
                        let panes = panes.panes.lock().unwrap_or_else(|e| e.into_inner());
                        state
                            .current_targets(&check, |target| {
                                live_target(target, &sessions, &panes)
                            })
                            .into_iter()
                            .map(|target| {
                                (
                                    target.fingerprint.clone(),
                                    target.effective_fingerprint.clone(),
                                )
                            })
                            .unzip()
                    };
                    if fingerprints.is_empty() {
                        return None;
                    }
                    Some(
                        crate::commands::ai_monitor_agents_readonly(
                            &account.profile_id,
                            &account.user,
                            &fingerprints,
                            &effective_fingerprints,
                        )
                        .await,
                    )
                });
                pending.insert(task.id(), work);
            }
            tokio::select! {
                _ = &mut wake => {},
                joined = jobs.join_next_with_id(), if !jobs.is_empty() => {
                    let (id, result) = match joined {
                        Some(Ok((id, result))) => (id, result),
                        Some(Err(error)) => (error.id(), Some(Err("herdr_query_failed: 监控任务异常结束".into()))),
                        None => continue,
                    };
                    if let Some(work) = pending.remove(&id) {
                        let mut state = monitor.state.lock().unwrap_or_else(|e| e.into_inner());
                        let registry = app.state::<SessionRegistry>();
                        let panes = app.state::<HerdrPaneRegistry>();
                        let sessions = registry.sessions.lock().unwrap_or_else(|e| e.into_inner());
                        let panes = panes.panes.lock().unwrap_or_else(|e| e.into_inner());
                        if let Some(event) = state.finish(&work, result, monitor.now(), wall_ms(),
                            |target| live_target(target, &sessions, &panes))
                        {
                            let _ = app.emit(EVENT_NAME, event);
                        }
                    }
                },
                _ = tokio::time::sleep(wait.unwrap_or(Duration::ZERO)), if wait.is_some() => {},
            }
        }
        jobs.abort_all();
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use portable_pty::{Child, ChildKiller, ExitStatus};

    fn target(id: &str, user: &str, pane: &str) -> Target {
        Target {
            session_id: id.into(),
            account: Account {
                profile_id: "server".into(),
                user: user.into(),
            },
            pane_id: pane.into(),
            fingerprint: "fixture-fingerprint".into(),
            effective_fingerprint: "fixture-effective-fingerprint".into(),
            connection: Arc::new(AtomicBool::new(false)),
            generation: 0,
        }
    }

    fn agent(kind: &str, pane: &str, status: &str) -> HerdrAgent {
        HerdrAgent {
            kind: kind.into(),
            pane_id: pane.into(),
            status: status.into(),
            ..Default::default()
        }
    }

    fn response(body: &str, code: u8) -> String {
        format!("{EXIT_PREFIX}{code}\n{body}\n")
    }

    #[test]
    fn a_valid_empty_list_is_success_but_missing_stopped_and_bad_output_are_errors() {
        assert!(parse_agents_readonly(&response(
            r#"{"type":"agent_list","result":{"agents":[]}}"#,
            0
        ))
        .unwrap()
        .is_empty());
        assert!(parse_agents_readonly(NOT_INSTALLED)
            .unwrap_err()
            .starts_with("herdr_not_installed:"));
        assert!(
            parse_agents_readonly(&response(r#"{"error":{"code":"server_not_running"}}"#, 1))
                .unwrap_err()
                .starts_with("herdr_server_not_running:")
        );
        for body in [
            "",
            "not JSON",
            "{}",
            "[]",
            r#"{"type":"pane_list","result":{"agents":[]}}"#,
            r#"{"type":"agent_list","result":{"agents":null}}"#,
            r#"{"type":"agent_list","result":{"agents":[{}]}}"#,
            r#"{"type":"agent_list","result":{"agents":[{"pane_id":"w1:p1","agent":42,"agent_status":"done"}]}}"#,
            r#"{"type":"agent_list","result":{"agents":[]}} garbage"#,
        ] {
            assert!(parse_agents_readonly(&response(body, 0)).is_err(), "{body}");
        }
        assert!(parse_agents_readonly(&response(
            r#"{"type":"agent_list","result":{"agents":[]}}"#,
            1
        ))
        .is_err());
        assert!(parse_agents_readonly(r#"{"type":"agent_list","result":{"agents":[]}}"#).is_err());
    }

    #[test]
    fn parses_multiline_agent_output_without_losing_first_hand_fields() {
        let body = r#"{
            "type":"agent_list","result":{"agents":[{
                "agent":"codex","agent_status":"blocked","pane_id":"w1:p1",
                "cwd":"/project","terminal_title_stripped":"build","focused":true
            }]}}
        "#;
        let agents = parse_agents_readonly(&response(body, 0)).unwrap();
        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0].status, "blocked");
        assert_eq!(agents[0].cwd, "/project");
        assert_eq!(agents[0].title, "build");
        assert!(agents[0].attention);
    }

    #[test]
    fn tui_v095_protocol22_response_remains_compatible_with_the_legacy_adapter() {
        // Official TUI v0.9.5: src/api/schema/response.rs + agents.rs.
        // The discriminator belongs to result; AgentInfo.agent is optional.
        // https://github.com/herdrdev/herdr/tree/v0.9.5/src/api/schema
        let body = r#"{"id":"cli:agent:list","result":{"type":"agent_list","agents":[
            {"terminal_id":"term_a","agent":"codex","agent_status":"working",
             "workspace_id":"w1","tab_id":"w1:t1","pane_id":"w1:p1","focused":false,
             "state_change_seq":3,"completion_seq":2,"revision":10,"foreground_cwd":"/project"},
            {"terminal_id":"term_b","agent":null,"agent_status":"unknown",
             "workspace_id":"w1","tab_id":"w1:t1","pane_id":"w1:p2","focused":false,"revision":1},
            {"terminal_id":"term_c","agent_status":"idle",
             "workspace_id":"w1","tab_id":"w1:t1","pane_id":"w1:p3","focused":false,"revision":1}
        ]}}"#;
        let parsed = parse_agents_readonly(&response(body, 0)).unwrap();
        assert_eq!(parsed, herdr::parse_agents(body));
        assert_eq!(parsed[0].kind, "codex");
        assert_eq!(parsed[0].status, "working");
        assert_eq!(parsed[0].cwd, "/project");
        assert!(parsed[1].kind.is_empty() && parsed[2].kind.is_empty());
        assert!(parse_agents_readonly(&response(
            r#"{"id":"cli:agent:list","result":{"type":"agent_list","agents":[]}}"#,
            0
        ))
        .unwrap()
        .is_empty());
    }

    fn ssh_config() -> crate::store::SshConfig {
        serde_json::from_value(serde_json::json!({
            "host":"host.example", "port":22, "user":"root", "authKind":"key",
            "keyPath":"/fixtures/id_test", "jump":"jump.example:2222"
        }))
        .unwrap()
    }

    #[test]
    fn changed_ssh_destinations_and_auth_options_cannot_be_probed_as_an_open_session() {
        let original = ssh_config();
        let fingerprints = vec![connection_fingerprint(&original, "alice")];
        assert!(verify_connection(&original, "alice", &fingerprints).is_ok());
        let mut changed = original.clone();
        changed.user = "edited-profile-default".into();
        assert!(
            verify_connection(&changed, "alice", &fingerprints).is_ok(),
            "the connected override account stays bound"
        );
        assert!(verify_connection(&changed, "bob", &fingerprints).is_err());
        for field in ["host", "port", "key", "jump", "auth", "password"] {
            let mut changed = original.clone();
            match field {
                "host" => changed.host = "another.example".into(),
                "port" => changed.port = 2222,
                "key" => changed.key_path = Some("/fixtures/other_key".into()),
                "jump" => changed.jump = Some("other-jump.example".into()),
                "auth" => changed.auth_kind = "password".into(),
                "password" => changed.allow_password = !changed.allow_password,
                _ => unreachable!(),
            }
            assert_eq!(
                verify_connection(&changed, "alice", &fingerprints).unwrap_err(),
                CONNECTION_CHANGED_ERROR,
                "{field}"
            );
        }
        let mixed = vec![fingerprints[0].clone(), "another-connection".into()];
        assert!(verify_connection(&original, "alice", &mixed).is_err());
    }

    #[test]
    fn ssh_alias_resolution_changes_cannot_redirect_a_bound_connection() {
        let original = super::super::ssh::parse_ssh_g_output(
            "hostname original.example\nport 22\nuser alice\nidentityfile /fixtures/id_test\nproxyjump jump.example\nidentitiesonly yes\nbatchmode yes\n",
        );
        let original_digest = effective_connection_fingerprint(&original);
        assert_eq!(original_digest.len(), 64);
        let expected = vec![original_digest.clone()];
        assert!(verify_effective_connection(&original_digest, &expected).is_ok());
        // The application profile can be unchanged while ssh -G resolves its
        // alias to a different destination/account, key, or transport route.
        for field in [
            "hostname",
            "port",
            "user",
            "identityfile",
            "proxyjump",
            "proxycommand",
            "identitiesonly",
            "batchmode",
        ] {
            let mut changed = original.clone();
            match field {
                "hostname" => changed.hostname = "another.example".into(),
                "port" => changed.port = 2222,
                "user" => changed.user = "bob".into(),
                "identityfile" => changed.identityfile.push("/fixtures/other_key".into()),
                "proxyjump" => changed.proxyjump = Some("another-jump.example".into()),
                "proxycommand" => changed.proxycommand = Some("fixture-proxy %h %p".into()),
                "identitiesonly" => changed.identitiesonly = "no".into(),
                "batchmode" => changed.batchmode = "no".into(),
                _ => unreachable!(),
            }
            assert_eq!(
                verify_effective_connection(&effective_connection_fingerprint(&changed), &expected)
                    .unwrap_err(),
                CONNECTION_CHANGED_ERROR,
                "{field}"
            );
        }
        assert!(verify_effective_connection(&original_digest, &[]).is_err());
        assert!(verify_effective_connection("", &expected).is_err());
        assert!(verify_effective_connection(
            &original_digest,
            &[original_digest.clone(), "another-connection".into()]
        )
        .is_err());
    }

    #[test]
    fn a_changed_connection_reports_an_error_then_sleeps_until_scope_reconnects() {
        let a = target("a", "alice", "w1:p1");
        let mut state = MonitorState::default();
        state.set_scope(true, vec![a.clone()]);
        let work = state.plan(0, |_| true).0.remove(0);
        let event = state
            .finish(
                &work,
                Some(Err(CONNECTION_CHANGED_ERROR.into())),
                1,
                2,
                |_| true,
            )
            .unwrap();
        assert_eq!(event.error.as_deref(), Some(CONNECTION_CHANGED_ERROR));
        state.set_scope(true, vec![a]);
        let (work, timer) = state.plan(1_000_000, |_| true);
        assert!(
            work.is_empty() && timer.is_none(),
            "scope rerenders cannot resume a changed connection"
        );
        state.set_scope(true, vec![target("a", "alice", "w1:p1")]);
        assert!(
            state.plan(120_000, |_| true).0.is_empty(),
            "reconnecting still respects backoff"
        );
        assert_eq!(state.plan(120_001, |_| true).0.len(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn readonly_shell_command_runs_only_agent_list_and_preserves_exit_diagnostics() {
        use std::os::unix::fs::PermissionsExt;
        static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "zeeai-monitor-command-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let cli = dir.join("herdr");
        let calls = dir.join("calls.txt");
        std::fs::write(&cli, "#!/bin/sh\nprintf '%s %s\\n' \"$1\" \"$2\" >> \"$ZEEAI_MONITOR_TEST_CALLS\"\nprintf '%s\\n' '{\"error\":{\"code\":\"server_not_running\"}}'\nexit 1\n").unwrap();
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o700)).unwrap();
        let output = super::super::proc::hidden_command("/bin/sh")
            .args(["-c", &agents_readonly_command()])
            .env("PATH", &dir)
            .env("ZEEAI_MONITOR_TEST_CALLS", &calls)
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(std::fs::read_to_string(&calls).unwrap(), "agent list\n");
        assert!(
            parse_agents_readonly(&String::from_utf8(output.stdout).unwrap())
                .unwrap_err()
                .starts_with("herdr_server_not_running:")
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn first_poll_is_immediate_and_scope_churn_cannot_bypass_the_account_limit() {
        let a = target("a", "alice", "w1:p1");
        let b = target("b", "alice", "w1:p2");
        let mut state = MonitorState::default();
        assert!(state.plan(0, |_| true).1.is_none());
        state.set_scope(true, vec![a.clone()]);
        let (work, wait) = state.plan(0, |_| true);
        assert_eq!(work.len(), 1);
        assert!(wait.is_none());
        state.set_scope(true, vec![a.clone(), b.clone()]);
        assert!(
            state.plan(1, |_| true).0.is_empty(),
            "no second query while one is in flight"
        );
        let event = state
            .finish(&work[0], Some(Ok(Vec::new())), 10, 10, |_| true)
            .unwrap();
        assert_eq!(event.session_ids, ["a"]);
        assert!(event.agents.is_empty() && event.error.is_none());
        state.set_scope(false, Vec::new());
        assert_eq!(state.plan(20, |_| true).1, None);
        state.set_scope(true, vec![a.clone(), b.clone()]);
        for now in [20, 999, 59_999, 60_009] {
            state.set_scope(true, vec![a.clone(), b.clone()]);
            assert!(state.plan(now, |_| true).0.is_empty());
        }
        let work = state.plan(60_010, |_| true).0;
        assert_eq!(work.len(), 1);
        assert_eq!(work[0].targets.len(), 2);
    }

    #[test]
    fn failures_back_off_120_then_300_seconds_and_success_resets_the_delay() {
        let a = target("a", "alice", "w1:p1");
        let mut state = MonitorState::default();
        state.set_scope(true, vec![a.clone()]);
        let work = state.plan(0, |_| true).0.remove(0);
        let event = state
            .finish(&work, Some(Err("offline".into())), 10, 10, |_| true)
            .unwrap();
        assert_eq!(event.error.as_deref(), Some("offline"));
        state.set_scope(false, Vec::new());
        state.set_scope(true, vec![a]);
        assert!(state.plan(120_009, |_| true).0.is_empty());
        let work = state.plan(120_010, |_| true).0.remove(0);
        state.finish(&work, Some(Err("offline".into())), 120_020, 0, |_| true);
        assert!(state.plan(420_019, |_| true).0.is_empty());
        let work = state.plan(420_020, |_| true).0.remove(0);
        state.finish(&work, Some(Ok(Vec::new())), 420_030, 0, |_| true);
        assert!(state.plan(480_029, |_| true).0.is_empty());
        assert_eq!(state.plan(480_030, |_| true).0.len(), 1);
    }

    #[test]
    fn accounts_share_a_profile_but_never_share_panes_or_status_results() {
        let mut state = MonitorState::default();
        state.set_scope(
            true,
            vec![
                target("root-tab", "root", "w1:p1"),
                target("alice-tab", "alice", "w1:p1"),
            ],
        );
        let work = state.plan(0, |_| true).0;
        assert_eq!(work.len(), 2);
        for work in work {
            let status = if work.account.user == "root" {
                "working"
            } else {
                "blocked"
            };
            let result = vec![
                agent("codex", "w1:p1", status),
                agent("claude", "not-open", "done"),
            ];
            let event = state
                .finish(&work, Some(Ok(result)), 10, 10, |_| true)
                .unwrap();
            assert_eq!(event.session_ids, [format!("{}-tab", work.account.user)]);
            assert_eq!(event.agents.len(), 1);
            assert_eq!(event.agents[0].status, status);
        }
    }

    #[test]
    fn late_results_only_include_the_original_sessions_still_in_scope() {
        let a = target("a", "alice", "w1:p1");
        let b = target("b", "alice", "w1:p2");
        let c = target("c", "alice", "w1:p3");
        let mut state = MonitorState::default();
        state.set_scope(true, vec![a, b.clone()]);
        let work = state.plan(0, |_| true).0.remove(0);
        state.set_scope(true, vec![b, c]);
        let agents = vec![
            agent("codex_cli", "w1:p1", "done"),
            agent("CLAUDE-CODE", "w1:p2", "blocked"),
            agent("codex", "w1:p3", "working"),
            agent("gemini", "w1:p2", "working"),
        ];
        let event = state
            .finish(&work, Some(Ok(agents)), 1, 2, |_| true)
            .unwrap();
        assert_eq!(event.session_ids, ["b"]);
        assert_eq!(event.agents.len(), 1);
        assert_eq!(event.agents[0].kind, "claude");
        assert_eq!(event.agents[0].pane_id, "w1:p2");
    }

    #[test]
    fn disabling_reenabling_or_reopening_the_same_id_discards_an_old_result() {
        for reopen in [false, true] {
            let a = target("a", "alice", "w1:p1");
            let mut state = MonitorState::default();
            state.set_scope(true, vec![a.clone()]);
            let work = state.plan(0, |_| true).0.remove(0);
            if reopen {
                state.set_scope(true, vec![target("a", "alice", "w1:p1")]);
            } else {
                state.set_scope(false, Vec::new());
                assert!(state.current_targets(&work, |_| true).is_empty());
                state.set_scope(true, vec![a]);
            }
            assert!(state
                .finish(
                    &work,
                    Some(Ok(vec![agent("codex", "w1:p1", "done")])),
                    1,
                    1,
                    |_| true
                )
                .is_none());
            assert!(state.plan(59_999, |_| true).0.is_empty());
        }
    }

    #[test]
    fn disconnected_or_closed_targets_emit_nothing_and_leave_no_poll_timer() {
        let mut state = MonitorState::default();
        state.set_scope(true, vec![target("a", "alice", "w1:p1")]);
        let work = state.plan(0, |_| true).0.remove(0);
        assert!(state
            .finish(&work, Some(Ok(Vec::new())), 1, 1, |_| false)
            .is_none());
        let (work, wait) = state.plan(60_001, |_| false);
        assert!(work.is_empty());
        assert_eq!(wait, None);
        assert!(state.targets.is_empty());
    }

    #[derive(Clone, Debug)]
    struct FakeChild {
        running: Arc<AtomicBool>,
    }

    impl ChildKiller for FakeChild {
        fn kill(&mut self) -> std::io::Result<()> {
            self.running.store(false, Ordering::Release);
            Ok(())
        }
        fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
            Box::new(self.clone())
        }
    }

    impl Child for FakeChild {
        fn try_wait(&mut self) -> std::io::Result<Option<ExitStatus>> {
            Ok(if self.running.load(Ordering::Acquire) {
                None
            } else {
                Some(ExitStatus::with_exit_code(0))
            })
        }
        fn wait(&mut self) -> std::io::Result<ExitStatus> {
            Ok(ExitStatus::with_exit_code(0))
        }
        fn process_id(&self) -> Option<u32> {
            None
        }
        #[cfg(windows)]
        fn as_raw_handle(&self) -> Option<std::os::windows::io::RawHandle> {
            None
        }
    }

    fn registered() -> (SessionRegistry, HerdrPaneRegistry, Arc<AtomicBool>) {
        let registry = SessionRegistry::new();
        let panes = HerdrPaneRegistry::default();
        let running = Arc::new(AtomicBool::new(true));
        registry.sessions.lock().unwrap().insert(
            "tab".into(),
            SessionHandle {
                kind: "ssh".into(),
                title: "test".into(),
                writer: Arc::new(Mutex::new(Box::new(std::io::sink()))),
                master: None,
                child: Some(Arc::new(Mutex::new(Box::new(FakeChild {
                    running: running.clone(),
                })))),
            },
        );
        panes.panes.lock().unwrap().insert(
            "tab".into(),
            HerdrPaneMeta {
                profile_id: "backend-profile".into(),
                user: Some(" alice ".into()),
                connection_fingerprint: "fixture-fingerprint".into(),
                effective_connection_fingerprint: "fixture-effective-fingerprint".into(),
                pane_id: "w1:p1".into(),
                mode: "control".into(),
                cols: 80,
                rows: 24,
                channel: tauri::ipc::Channel::new(|_| Ok(())),
                close_flag: Arc::new(AtomicBool::new(false)),
            },
        );
        (registry, panes, running)
    }

    #[test]
    fn session_ids_are_resolved_from_both_registries_and_an_active_child_only() {
        let monitor = AiMonitor::default();
        let (registry, panes, running) = registered();
        monitor
            .set_sessions(
                vec!["unknown".into(), "tab".into(), "tab".into()],
                true,
                &registry,
                &panes,
            )
            .unwrap();
        {
            let state = monitor.state.lock().unwrap();
            assert_eq!(state.targets.len(), 1);
            let target = state.targets.get("tab").unwrap();
            assert_eq!(target.account.profile_id, "backend-profile");
            assert_eq!(target.account.user, "alice");
        }
        running.store(false, Ordering::Release);
        monitor
            .set_sessions(vec!["tab".into()], true, &registry, &panes)
            .unwrap();
        assert!(monitor.state.lock().unwrap().targets.is_empty());
        running.store(true, Ordering::Release);
        panes
            .panes
            .lock()
            .unwrap()
            .get_mut("tab")
            .unwrap()
            .close_flag
            .store(true, Ordering::Release);
        monitor
            .set_sessions(vec!["tab".into()], true, &registry, &panes)
            .unwrap();
        assert!(monitor.state.lock().unwrap().targets.is_empty());
        panes.panes.lock().unwrap().clear();
        monitor
            .set_sessions(vec!["tab".into()], true, &registry, &panes)
            .unwrap();
        assert!(monitor.state.lock().unwrap().targets.is_empty());
    }

    #[test]
    fn a_replaced_registry_connection_invalidates_an_inflight_result() {
        let monitor = AiMonitor::default();
        let (registry, panes, _) = registered();
        monitor
            .set_sessions(vec!["tab".into()], true, &registry, &panes)
            .unwrap();
        let work = monitor.state.lock().unwrap().plan(0, |_| true).0.remove(0);
        panes
            .panes
            .lock()
            .unwrap()
            .get_mut("tab")
            .unwrap()
            .close_flag = Arc::new(AtomicBool::new(false));
        let sessions = registry.sessions.lock().unwrap();
        let panes = panes.panes.lock().unwrap();
        assert!(monitor
            .state
            .lock()
            .unwrap()
            .finish(&work, Some(Ok(Vec::new())), 1, 1, |target| live_target(
                target, &sessions, &panes
            ))
            .is_none());
    }

    #[test]
    fn changed_alias_binding_discards_a_result_from_the_previous_resolution() {
        let monitor = AiMonitor::default();
        let (registry, panes, _) = registered();
        monitor
            .set_sessions(vec!["tab".into()], true, &registry, &panes)
            .unwrap();
        let work = monitor.state.lock().unwrap().plan(0, |_| true).0.remove(0);
        panes
            .panes
            .lock()
            .unwrap()
            .get_mut("tab")
            .unwrap()
            .effective_connection_fingerprint = "new-resolution-digest".into();
        let sessions = registry.sessions.lock().unwrap();
        let panes = panes.panes.lock().unwrap();
        assert!(monitor
            .state
            .lock()
            .unwrap()
            .finish(
                &work,
                Some(Ok(vec![agent("codex", "w1:p1", "done")])),
                1,
                1,
                |target| live_target(target, &sessions, &panes)
            )
            .is_none());
    }

    #[test]
    fn payload_has_only_the_agreed_fields_and_empty_success_is_not_an_error() {
        let event = HerdrMonitorEvent {
            session_ids: vec!["tab".into()],
            at_ms: 7,
            agents: Vec::new(),
            error: None,
        };
        assert_eq!(
            serde_json::to_value(event).unwrap(),
            serde_json::json!({
                "sessionIds":["tab"], "atMs":7, "agents":[], "error":null
            })
        );
    }
}
