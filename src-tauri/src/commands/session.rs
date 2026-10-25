//! 会话生命周期：本地 / SSH / 串口 PTY 的建立、输入、改尺寸、关闭。
//!
//! 为什么单独一层：这些命令直接持有 `SessionRegistry` 和 Channel，是“终端能不能用”的
//! 最短路径；和文件、AI、升级那些一次性操作分开后，改会话背压时不用在一万行里翻。
use base64::Engine as _;
use portable_pty::PtySize;
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;

use crate::core::{
    herdr, pty, serial, ssh, HerdrPaneRegistry, SessionEvent, SessionRegistry,
};
use crate::store;

use super::util::{friendly_herdr_event, program_on_path};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: String,
    pub profile_id: String,
    pub title: String,
    pub kind: String,
    #[serde(default)]
    pub tmux_session: Option<String>,
    /// SSH 会话实际使用的登录用户名（可能来自本次会话的临时覆盖）
    #[serde(default)]
    pub user: Option<String>,
    #[serde(default)]
    pub host: Option<String>,
}

#[tauri::command]
pub fn open_local(
    id: String,
    shell: String,
    distro: Option<String>,
    cwd: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
    on_event: Channel<SessionEvent>,
    registry: State<'_, SessionRegistry>,
    logs: State<'_, std::sync::Arc<crate::core::session_log::LogRegistry>>,
) -> Result<SessionInfo, String> {
    log::info!(
        "ipc: open_local shell={} distro={:?} cwd={:?}",
        shell,
        distro,
        cwd
    );
    let (program, args, title) = match shell.as_str() {
        "cmd" => ("cmd.exe".to_string(), vec![], "命令提示符".to_string()),
        // PowerShell 7（pwsh.exe）和系统自带的 Windows PowerShell 5.1（powershell.exe）
        // 是两个不同的程序，语法/编码都不一样，所以让用户自己挑（面板上是两个并排按钮）。
        "pwsh" => {
            if !program_on_path("pwsh.exe") {
                return Err(
                    "本机没找到 pwsh.exe（PowerShell 7）——先装 PowerShell 7 再用这个按钮；\
                     想用系统自带的那个请点「新建 PowerShell」"
                        .into(),
                );
            }
            (
                "pwsh.exe".to_string(),
                vec!["-NoLogo".to_string()],
                "PowerShell 7".to_string(),
            )
        }
        "wsl" => {
            let mut args: Vec<String> = vec![];
            if let Some(d) = distro.as_ref().filter(|d| !d.trim().is_empty()) {
                args.push("-d".into());
                args.push(d.clone());
            }
            ("wsl.exe".to_string(), args, "WSL".to_string())
        }
        _ => (
            "powershell.exe".to_string(),
            vec!["-NoLogo".to_string()],
            "PowerShell".to_string(),
        ),
    };

    let handle = pty::spawn(
        &id,
        "local",
        &title,
        &program,
        &args,
        cwd.as_deref().filter(|d| !d.trim().is_empty()),
        cols.unwrap_or(110),
        rows.unwrap_or(30),
        on_event,
        logs.inner().clone(),
        pty::SpawnOpts::default(),
    )?;
    registry
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .insert(id.clone(), handle);

    Ok(SessionInfo {
        id,
        profile_id: String::new(),
        title,
        kind: "local".into(),
        tmux_session: None,
        user: None,
        host: None,
    })
}

#[tauri::command]
pub fn open_ssh(
    id: String,
    profile_id: String,
    tmux_mode: Option<String>,
    tmux_name: Option<String>,
    // 会话后端：None/"tmux" = 用 tmux（默认，兼容所有老服务器）；"herdr" = 用 herdr
    backend: Option<String>,
    user_override: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
    on_event: Channel<SessionEvent>,
    registry: State<'_, SessionRegistry>,
    panes: State<'_, HerdrPaneRegistry>,
    logs: State<'_, std::sync::Arc<crate::core::session_log::LogRegistry>>,
) -> Result<SessionInfo, String> {
    log::info!(
        "ipc: open_ssh profile_id={} mode={:?} name={:?}",
        profile_id,
        tmux_mode,
        tmux_name
    );
    let profiles = store::load()?;
    let profile = profiles
        .into_iter()
        .find(|p| p.id == profile_id)
        .ok_or_else(|| "连接配置不存在".to_string())?;
    let cfg = profile
        .ssh
        .clone()
        .ok_or_else(|| "该配置不是 SSH 类型".to_string())?;
    // 允许在新建会话时临时改用户名（不改配置也能用别的账号登录）
    let effective_user = user_override
        .as_ref()
        .map(|u| u.trim().to_string())
        .filter(|u| !u.is_empty())
        .unwrap_or_else(|| cfg.user.clone());

    // "none" = 明确不用 tmux（直接给普通 shell）；"name" = 指定会话名；
    // 其他 = 按配置里的默认策略（开了就用模板名，没开就普通 shell）。
    let mode = tmux_mode.unwrap_or_else(|| "default".into());
    let use_herdr = backend.as_deref() == Some("herdr");

    // ---------- herdr 窗格（backend = "herdr-pane" 只读观察 / "herdr-control" 可读可写） ----------
    //
    // 这两路都**不跑 herdr 自己的 TUI**（那条路会花屏、还会跟别的客户端抢尺寸），
    // 而是直接用她的终端流：observe = 只读、可多开；control = 可读可写、需要接管权。
    // 两者的帧格式一样，所以解码那套代码共用（见 core::herdr 顶部说明）。
    if backend.as_deref() == Some("herdr-pane") || backend.as_deref() == Some("herdr-control") {
        let mode = if backend.as_deref() == Some("herdr-control") {
            "control"
        } else {
            "observe"
        };
        let pane = tmux_name.clone().unwrap_or_default();
        if pane.trim().is_empty() {
            return Err("缺少 herdr 窗格号，无法打开观察窗".into());
        }
        let c = cols.unwrap_or(110);
        let r = rows.unwrap_or(30);
        let cmd = if mode == "control" {
            herdr::control_command(&pane, c, r, true)
        } else {
            herdr::observe_command(&pane, c, r)
        };
        // **不申请远端 PTY**、本地也不走 ConPTY（走管道）：
        // ConPTY 的终端握手会被我们的 JSON 行缓冲吃掉，导致整条流不出一帧（黑屏）；
        // 而且它还会把超长的 JSON 行按宽度折行。详见 core::herdr_stream 顶部。
        let args = ssh::ssh_args_no_tty(
            &cfg.host,
            cfg.port,
            &effective_user,
            cfg.key_path.as_deref(),
            &cmd,
            cfg.jump.as_deref(),
        );
        let title = format!("{} · herdr {}", profile.name, herdr::sanitize_pane(&pane));
        let close_flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let handle = crate::core::herdr_stream::spawn(
            &id,
            &title,
            &ssh::ssh_exe(),
            &args,
            {
                let ch = on_event.clone();
                move |ev| {
                    let _ = ch.send(friendly_herdr_event(ev));
                }
            },
            logs.inner().clone(),
            close_flag.clone(),
        )
        .map_err(|e| ssh::friendly_ssh_error_context("打开 herdr 观察流失败", &e))?;
        registry
            .sessions
            .lock()
            .map_err(|e| e.to_string())?
            .insert(id.clone(), handle);
        panes.panes.lock().map_err(|e| e.to_string())?.insert(
            id.clone(),
            crate::core::session::HerdrPaneMeta {
                profile_id: profile_id.clone(),
                user: user_override
                    .as_ref()
                    .map(|u| u.trim().to_string())
                    .filter(|u| !u.is_empty()),
                pane_id: pane.clone(),
                mode: mode.to_string(),
                cols: c,
                rows: r,
                channel: on_event,
                close_flag,
            },
        );
        log::info!("ipc: open_ssh(herdr-{mode}) pane={pane} {c}x{r} -> {id}");
        return Ok(SessionInfo {
            id,
            profile_id,
            title,
            kind: "ssh".into(),
            tmux_session: None,
            user: Some(effective_user),
            host: Some(cfg.host.clone()),
        });
    }
    let mut resolved_tmux: Option<String> = None;
    let remote_cmd = match mode.as_str() {
        // 不用 tmux：给普通 shell 注入「上报当前目录」，文件面板才能跟着 cd 走
        "none" => Some(ssh::shell_with_cwd_report()),
        "name" => {
            let name = tmux_name.unwrap_or_default();
            if name.trim().is_empty() {
                Some(ssh::shell_with_cwd_report())
            } else {
                if use_herdr {
                    // herdr 的会话名不用记进"tmux 会话"字段（那是给 tmux 面板用的）
                    Some(ssh::herdr_command(&name))
                } else {
                    resolved_tmux = Some(name.clone());
                    Some(ssh::tmux_command(&name, cfg.start_dir.as_deref()))
                }
            }
        }
        _ => {
            if use_herdr {
                let name = ssh::tmux_session_name(&cfg.tmux_template, &cfg.host, &effective_user);
                Some(ssh::herdr_command(&name))
            } else if cfg.tmux_enabled {
                let name = ssh::tmux_session_name(&cfg.tmux_template, &cfg.host, &effective_user);
                resolved_tmux = Some(name.clone());
                Some(ssh::tmux_command(&name, cfg.start_dir.as_deref()))
            } else {
                Some(ssh::shell_with_cwd_report())
            }
        }
    };

    let args = ssh::ssh_args(
        &cfg.host,
        cfg.port,
        &effective_user,
        cfg.key_path.as_deref(),
        remote_cmd.as_deref(),
        !cfg.allow_password,
        cfg.jump.as_deref(),
    );
    let program = ssh::ssh_exe();
    // 用户**自己填了** tmux 会话名时，标题就用它。
    //
    // 以前这里一律写 `profile · host`，于是"我填了名字"的人看到标签和侧栏还是自动名
    // （实测反馈），以为名字没生效。只有"显式命名"（mode = "name" 且真的解析出 tmux 会话）
    // 才改；默认模式（模板自动命名）保持原样。
    let title = match resolved_tmux.as_deref() {
        Some(name) if mode == "name" => format!("{} · {}", profile.name, name),
        _ => format!("{} · {}", profile.name, cfg.host),
    };

    let handle = pty::spawn(
        &id,
        "ssh",
        &title,
        &program,
        &args,
        None,
        cols.unwrap_or(110),
        rows.unwrap_or(30),
        on_event,
        logs.inner().clone(),
        pty::SpawnOpts::default(),
    )
    .map_err(|e| ssh::friendly_ssh_error_context("打开 SSH 终端失败", &e))?;
    registry
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .insert(id.clone(), handle);

    Ok(SessionInfo {
        id,
        profile_id,
        title,
        kind: "ssh".into(),
        tmux_session: resolved_tmux,
        user: Some(effective_user),
        host: Some(cfg.host.clone()),
    })
}

#[tauri::command]
pub async fn session_write(
    id: String,
    data_b64: String,
    registry: State<'_, SessionRegistry>,
) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_b64.as_bytes())
        .map_err(|e| format!("解码输入失败: {e}"))?;
    // ★ 两道保险（都是实测踩出来的）：
    // 1) 只在这把全局锁里**取出 Arc**，拿到就放锁 —— 否则一个"远端不再读"的会话会把
    //    所有会话操作一起拖住；
    // 2) 真正阻塞的 write 放到**阻塞线程**去做 —— Tauri 的**同步命令跑在主线程**上，
    //    一旦这个写卡住（管道满 / conhost 不作声），整个界面就"未响应"
    //    （Windows 事件日志里那条 AppHangXProcB1、等着 conhost.exe，就是这么来的）。
    let writer = {
        let sessions = registry.sessions.lock().map_err(|e| e.to_string())?;
        sessions
            .get(&id)
            .ok_or_else(|| "会话不存在".to_string())?
            .writer
            .clone()
    };
    tokio::task::spawn_blocking(move || {
        let mut writer = writer.lock().map_err(|e| e.to_string())?;
        writer.write_all(&bytes).map_err(|e| e.to_string())?;
        writer.flush().map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("写入线程失败: {e}"))?
}

/// 前端「这一批 PTY 输出已经写进 xterm」的确认。
///
/// 背压协议的另一半在 `core::pty::run_output_pump`：
/// 后端最多发 2 批未确认数据，超过就暂停读 PTY；收到这个 ack 再继续。
/// 1 秒收不到会由后端记 warn 并推进窗口（防一次丢 ack 永久卡死）。
///
/// `seq` 是**累积**语义：确认 seq 及之前的所有批次。串口 / herdr 没有输出泵，
/// 调用到这里是空操作。
#[tauri::command]
pub fn session_output_ack(session_id: String, seq: u64) {
    crate::core::pty::ack_output(&session_id, seq);
}

#[tauri::command]
pub async fn session_resize(
    id: String,
    cols: u16,
    rows: u16,
    registry: State<'_, SessionRegistry>,
) -> Result<(), String> {
    // 同 session_write：先拿 Arc、放掉全局锁，再把可能阻塞的 resize 丢给阻塞线程
    let master = {
        let sessions = registry.sessions.lock().map_err(|e| e.to_string())?;
        sessions
            .get(&id)
            .ok_or_else(|| "会话不存在".to_string())?
            .master
            .clone()
            .ok_or_else(|| "该会话不支持调整尺寸（例如串口）".to_string())?
    };
    tokio::task::spawn_blocking(move || {
        let master = master.lock().map_err(|e| e.to_string())?;
        master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("resize 线程失败: {e}"))?
}

#[tauri::command]
pub async fn session_close(
    id: String,
    registry: State<'_, SessionRegistry>,
    panes: State<'_, HerdrPaneRegistry>,
) -> Result<(), String> {
    // 先把 handle 从表里摘出来、**放掉全局锁**，再去 kill。
    // 否则 kill 的等待时间也会占着全局锁，同样会拖住别的会话。
    let handle = {
        let mut sessions = registry.sessions.lock().map_err(|e| e.to_string())?;
        sessions.remove(&id)
    };
    // herdr 观察窗还有两样东西要一起收：元信息，和那条常驻的「输入泵」。
    if let Ok(mut m) = panes.panes.lock() {
        m.remove(&id);
    }
    // 输入泵：先摘出注册表，再**显式 kill**（架构审查 minor-01）。
    // 以前只把 stdin 丢掉、指望远端 `while read` 拿到 EOF 自己退出 —— 那个假设在 ssh
    // 已经卡住/半死时不成立，会在服务器上留一条挂着 `read` 的 ssh。现在主动收掉。
    let pump = panes.inputs.lock().ok().and_then(|mut m| m.remove(&id));
    if let Some(pump) = pump {
        let _ = tokio::task::spawn_blocking(move || {
            if let Ok(mut child) = pump.child.lock() {
                let _ = child.kill();
                // kill 之后 wait 一下：回收句柄，别留僵尸进程
                let _ = child.wait();
            }
        })
        .await;
    }
    if let Some(handle) = handle {
        // herdr 的**可写**流（control）：关标签前主动交还控制权。
        // 为什么值得多做这一步：万一我们是被强杀/拔线，窗格那边会还以为控制端在；
        // 下次想接管就得 `--takeover`。主动 release 之后，下一次是"干净的接管"。
        // 失败也无所谓（进程可能早就没了），所以忽略结果。
        let is_control = panes
            .panes
            .lock()
            .ok()
            .and_then(|m| m.get(&id).map(|x| x.mode == "control"))
            .unwrap_or(false);
        // 交还控制权 / 杀进程都是阻塞动作 → 丢到阻塞线程，别占主线程
        let _ = tokio::task::spawn_blocking(move || {
            if is_control {
                use std::io::Write as _;
                if let Ok(mut w) = handle.writer.lock() {
                    let _ = w.write_all(format!("{}\n", herdr::release_line()).as_bytes());
                    let _ = w.flush();
                }
            }
            if let Some(child) = handle.child.as_ref() {
                if let Ok(mut child) = child.lock() {
                    let _ = child.kill();
                }
            }
        })
        .await;
    }
    Ok(())
}

#[tauri::command]
pub fn serial_list() -> Result<Vec<serial::SerialPortInfo>, String> {
    log::info!("ipc: serial_list");
    let ports = serial::list();
    if let Ok(list) = &ports {
        log::info!("ipc: serial_list -> {} ports", list.len());
    }
    ports
}

#[tauri::command]
pub fn open_serial(
    id: String,
    path: String,
    baud: u32,
    data_bits: Option<u8>,
    stop_bits: Option<u8>,
    parity: Option<String>,
    flow_control: Option<String>,
    on_event: Channel<SessionEvent>,
    registry: State<'_, SessionRegistry>,
    logs: State<'_, std::sync::Arc<crate::core::session_log::LogRegistry>>,
) -> Result<SessionInfo, String> {
    let settings = serial::SerialSettings {
        baud,
        data_bits: data_bits.unwrap_or(8),
        stop_bits: stop_bits.unwrap_or(1),
        parity: parity.unwrap_or_else(|| "none".into()),
        flow_control: flow_control.unwrap_or_else(|| "none".into()),
    };
    log::info!("ipc: open_serial path={path} {:?}", settings);
    let title = format!("串口 · {path} · {baud}");
    let handle = serial::open(&id, &path, &settings, &title, on_event, logs.inner().clone())?;
    registry
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .insert(id.clone(), handle);
    Ok(SessionInfo {
        id,
        profile_id: String::new(),
        title,
        kind: "serial".into(),
        tmux_session: None,
        user: None,
        host: None,
    })
}
