//! AI 看板 / 会话快照 / 产物 / 时间线 / 来源探测。
use tauri::State;

use crate::core::{ai, ai_sessions, ai_tasks, AiTaskRegistry};
use crate::store;

use super::ssh::{run_remote_capture, ssh_config_for};
use super::util::run_capture;

/// 探测这台服务器上装了哪些 AI CLI、npm 有没有、有没有正在跑的
#[tauri::command]
pub async fn ai_probe(
    profile_id: String,
    user_override: Option<String>,
) -> Result<ai::AiProbe, String> {
    let cfg = ssh_config_for(&profile_id, user_override)?;
    let out = run_remote_capture(&profile_id, &cfg, &ai::probe_script()).await?;
    let probe = ai::parse_probe(&out);
    log::info!(
        "ipc: ai_probe -> {} 个工具，npm={:?}，运行中={:?}",
        probe.tools.len(),
        probe.npm,
       probe.running
   );
   Ok(probe)
}

/// 记一笔「App 自己在某个会话里启动了某个 AI 工具」。
/// 这一层是最精确的信号源：开始时间、跑没跑完都由 App 自己判，不靠猜。
#[tauri::command]
pub fn ai_task_note_start(
    tasks: State<'_, AiTaskRegistry>,
    env: String,
    server: String,
    tool: String,
    command: String,
) -> ai_tasks::AiTask {
    log::info!("ipc: ai_task_note_start env={env} server={server} tool={tool}");
    tasks.note_start(&env, &server, &tool, &command, store::now_secs() as i64)
}

/// 远端任务快照：tmux 窗格（能精确到 pane）+ ps 扫描，再和 App 自己启动的合并。
#[tauri::command]
pub async fn ai_tasks_remote(
    tasks: State<'_, AiTaskRegistry>,
    profile_id: String,
    server: String,
    user_override: Option<String>,
) -> Result<Vec<ai_tasks::AiTask>, String> {
    let cfg = ssh_config_for(&profile_id, user_override)?;
    let detected = match run_remote_capture(&profile_id, &cfg, &ai_tasks::remote_script()).await {
        Ok(out) => {
            let scan = ai_tasks::parse_remote(&out);
            Some(ai_tasks::classify(&scan, "remote", &server))
        }
        Err(e) => {
            // 探测失败不是致命错误：App 自己启动的那批照样显示，只是状态停在上一次
            log::warn!("ai_tasks_remote 探测失败：{e}");
            None
        }
    };
    Ok(tasks.merge("remote", &server, detected, store::now_secs() as i64))
}

/// 本机任务快照。
///
/// - `powershell`：用系统自带的 `Get-CimInstance Win32_Process` 读 CommandLine。
///   全进程表扫描偏重，所以前端只在真有本机会话时、15~30 秒才调一次；
/// - `wsl`：**进 WSL 里面**扫（Windows 侧只能看到 wslhost/vmmem，看不见里面的进程）；
/// - `cmd`：CMD 没有脚本钩子，本阶段只给「仅状态」，不为它扫进程表。
#[tauri::command]
pub async fn ai_tasks_local(
    tasks: State<'_, AiTaskRegistry>,
    shell: String,
    server: String,
    distro: Option<String>,
) -> Result<Vec<ai_tasks::AiTask>, String> {
    let env = if shell == "wsl" { "wsl" } else { "local" };
    let detected = match shell.as_str() {
        "cmd" => None,
        "wsl" => {
            let mut args: Vec<String> = Vec::new();
            if let Some(d) = distro.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
                args.push("-d".into());
                args.push(d.to_string());
            }
            args.push("--".into());
            args.push("sh".into());
            args.push("-c".into());
            args.push(ai_tasks::remote_script());
            match run_capture(std::path::Path::new("wsl.exe"), &args).await {
                Ok((true, out)) => {
                    let scan = ai_tasks::parse_remote(&out);
                    let mut list = ai_tasks::classify(&scan, env, &server);
                    for t in list.iter_mut() {
                        t.source = "ps".into();
                    }
                    Some(list)
                }
                Ok((false, out)) => {
                    log::warn!("ai_tasks_local(wsl) 失败：{}", out.trim());
                    None
                }
                Err(e) => {
                    log::warn!("ai_tasks_local(wsl) 失败：{e}");
                    None
                }
            }
        }
        _ => {
            let args = vec![
                "-NoProfile".to_string(),
                "-NonInteractive".to_string(),
                "-Command".to_string(),
                ai_tasks::windows_script(),
            ];
            match run_capture(std::path::Path::new("powershell.exe"), &args).await {
                Ok((true, out)) => {
                    let scan = ai_tasks::scan_windows(&out);
                    let mut list = ai_tasks::classify(&scan, env, &server);
                    for t in list.iter_mut() {
                        t.source = "winproc".into();
                    }
                    Some(list)
                }
                Ok((false, out)) => {
                    log::warn!("ai_tasks_local(powershell) 失败：{}", out.trim());
                    None
                }
                Err(e) => {
                    log::warn!("ai_tasks_local(powershell) 失败：{e}");
                    None
                }
            }
        }
    };
    Ok(tasks.merge(env, &server, detected, store::now_secs() as i64))
}

/// 清掉某个环境里「已结束」的卡片（还在跑的不动）
#[tauri::command]
pub fn ai_tasks_clear_finished(tasks: State<'_, AiTaskRegistry>, env: String, server: String) {
    log::info!("ipc: ai_tasks_clear_finished env={env} server={server}");
    tasks.clear_finished(&env, &server);
}

/// 读 Codex 的会话日志，给出"有没有新消息 / 在跑还是在等我 / 耗时 / token 用量"。
///
/// 这一层比"进程还在不在"准得多：进程只能说明跑着，而日志里有 `task_complete`
/// （带 AI 最后一段话和耗时）和 `token_count`（带本轮与累计用量、上下文窗口）。
/// 远端走一条 ssh 命令读 `~/.codex/sessions` 里最新那个 rollout 的尾巴；
/// 本机/WSL 直接读文件。CMD 没有这个概念，返回 None。
#[tauri::command]
pub async fn ai_session_snapshot(
    profile_id: Option<String>,
    user_override: Option<String>,
    shell: Option<String>,
    distro: Option<String>,
) -> Result<Option<ai_sessions::AiSessionSnapshot>, String> {
    if let Some(pid) = profile_id.as_deref().filter(|s| !s.trim().is_empty()) {
        let cfg = ssh_config_for(pid, user_override)?;
        let out = run_remote_capture(pid, &cfg, &ai_sessions::remote_tail_script()).await?;
        let snap = ai_sessions::parse_script_output(&out);
        log::info!(
            "ipc: ai_session_snapshot(remote) -> state={:?} tokens={:?}",
            snap.as_ref().map(|s| s.state.as_str()),
            snap.as_ref().and_then(|s| s.usage.as_ref()).map(|u| u.total)
        );
        return Ok(snap);
    }
    match shell.as_deref().unwrap_or("powershell") {
        "cmd" => Ok(None),
        "wsl" => {
            let mut args: Vec<String> = Vec::new();
            if let Some(d) = distro.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
                args.push("-d".into());
                args.push(d.to_string());
            }
            args.push("--".into());
            args.push("sh".into());
            args.push("-c".into());
            args.push(ai_sessions::remote_tail_script());
            match run_capture(std::path::Path::new("wsl.exe"), &args).await {
                Ok((true, out)) => Ok(ai_sessions::parse_script_output(&out)),
                _ => Ok(None),
            }
        }
        _ => Ok(ai_sessions::local_snapshot()),
    }
}

/// 任务产物：`cwd` 下在 `since`（Unix 秒）之后被新增/修改的文件。
///
/// 这一步是为了回答"AI 刚给我生成了什么"—— 日志里只有它干了活，产物得去目录里找。
/// 远端走 `find -newermt`，本机/WSL 走文件系统遍历，两边都限制深度和条数。
#[tauri::command]
pub async fn ai_task_artifacts(
    profile_id: Option<String>,
    user_override: Option<String>,
    shell: Option<String>,
    distro: Option<String>,
    cwd: String,
    since: i64,
) -> Result<Vec<ai_sessions::AiArtifact>, String> {
    let cwd = cwd.trim().to_string();
    if cwd.is_empty() {
        return Ok(Vec::new());
    }
    if let Some(pid) = profile_id.as_deref().filter(|s| !s.trim().is_empty()) {
        let cfg = ssh_config_for(pid, user_override)?;
        let script = ai_sessions::remote_artifacts_script(&cwd, since);
        let out = run_remote_capture(pid, &cfg, &script).await?;
        let list = ai_sessions::parse_artifacts(&out);
        log::info!("ipc: ai_task_artifacts(remote {cwd}) -> {} 个", list.len());
        return Ok(list);
    }
    match shell.as_deref().unwrap_or("powershell") {
        "cmd" => Ok(Vec::new()),
        "wsl" => {
            let mut args: Vec<String> = Vec::new();
            if let Some(d) = distro.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
                args.push("-d".into());
                args.push(d.to_string());
            }
            args.push("--".into());
            args.push("sh".into());
            args.push("-c".into());
            args.push(ai_sessions::remote_artifacts_script(&cwd, since));
            match run_capture(std::path::Path::new("wsl.exe"), &args).await {
                Ok((true, out)) => Ok(ai_sessions::parse_artifacts(&out)),
                _ => Ok(Vec::new()),
            }
        }
        _ => Ok(ai_sessions::local_artifacts(&cwd, since)),
    }
}

/// AI 看板 v2：把前端采集到的五套来源映射成统一的「AI 实例」并合并成卡片。
///
/// 为什么不让前端合并：**可信度闸门**（推断不许说成事实）、**陈旧降级**、
/// **一个实例一张卡** 这三条口径只能有一份实现 —— 老看板在前端 JS 里合并，
/// 于是出现了两趟打补丁（`taskKeyOf` + 第二趟并组），还留下过"两个 codex 只剩一张卡"。
///
/// 输入是前端**已经采集到**的东西（进程/tmux/WSL 扫描结果、herdr agent 列表、
/// 本应用账本、rollout 快照）；这一版刻意不在这里重新发起 SSH 扫描 ——
/// 那属于接线（M1b），先把口径落地。
#[tauri::command]
pub async fn ai_instances(
    sources: crate::core::ai_instance::BoardSources,
    now_ms: Option<u64>,
) -> Result<Vec<crate::core::ai_instance::AiInstance>, String> {
    let now = now_ms.unwrap_or_else(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    });
    let list = crate::core::ai_instance::board_from_sources(sources, now);
    log::info!("ipc: ai_instances -> {} 张卡", list.len());
    Ok(list)
}

/// 读整条 AI 任务时间线（新的在前）。
///
/// 这是"我离开电脑再回来，昨晚跑了什么"的答案：看板只显示当前这一轮，
/// 而这份记录是落盘的，重启应用也还在。
#[tauri::command]
pub fn ai_timeline_list() -> Vec<crate::core::ai_history::AiTurnRecord> {
    crate::core::ai_history::list()
}

/// 记一条"这一轮跑完了"。前端在发现新一轮完成时调用（那一刻它手上有全部信息）。
/// 返回 true 表示是新记录（前端据此刷新列表）。
#[tauri::command]
pub fn ai_timeline_add(entry: crate::core::ai_history::AiTurnRecord) -> bool {
    let at = entry.completed_at;
    let server = entry.server.clone();
    let is_new = crate::core::ai_history::record(entry);
    if is_new {
        log::info!("ai_timeline: 记下一条新的完成记录 server={server} at={at}");
    }
    is_new
}

/// 清空时间线
#[tauri::command]
pub fn ai_timeline_clear() {
    crate::core::ai_history::clear();
}

/// 探测"这台机器的 AI 状态是从哪来的"：装了 herdr 就用它的 agent 状态机，
/// 没装就用我们自己的探测。只读，不启动、不安装、不改远程任何东西。
#[tauri::command]
pub async fn ai_source_probe(
    profile_id: Option<String>,
    user_override: Option<String>,
) -> Result<crate::core::ai_sessions::AiSourceInfo, String> {
    if let Some(pid) = profile_id.as_deref().filter(|s| !s.trim().is_empty()) {
        let cfg = ssh_config_for(pid, user_override)?;
        let out = run_remote_capture(pid, &cfg, &ai_sessions::remote_source_script()).await?;
        let info = ai_sessions::parse_source(&out);
        log::info!(
            "ipc: ai_source_probe(remote) -> herdr={:?} agents={}",
            info.herdr_version,
            info.agents
        );
        return Ok(info);
    }
    Ok(ai_sessions::local_source())
}
