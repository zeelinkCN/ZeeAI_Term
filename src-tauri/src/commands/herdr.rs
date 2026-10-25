//! herdr 服务 / 工作区 / 观察窗 / 输入通道。
//!
//! 一键安装拆在 `herdr_install.rs`：它要下载、校验、scp，体量和运行路径都独立，
//! 混在这里会让本文件重新逼近上限。
use base64::Engine as _;
use tauri::State;

use crate::core::{
    herdr, proc, ssh, HerdrInputPump, HerdrPaneRegistry, SessionEvent, SessionRegistry,
};

use super::ssh::{password_for, run_remote_capture, ssh_config_for};
use super::util::friendly_herdr_event;

/// 读这台服务器上 herdr 认得的 agent（**只读**：就是一条 `agent list`）。
///
/// 为什么要单独一条命令，而不是并进 `ai_tasks_remote`：看板每 10~20 秒刷一次，
/// 那条探针本身已经在扫 ps / tmux 了；herdr 的 agent 状态是"第一手"，
/// 但只有**这台机器确实装了 herdr** 才值得多花一次往返。前端探到有 herdr 才调它。
#[tauri::command]
pub async fn herdr_agents(
    profile_id: String,
    user_override: Option<String>,
) -> Result<Vec<herdr::HerdrAgent>, String> {
    let cfg = ssh_config_for(&profile_id, user_override)?;
    let out = run_remote_capture(&profile_id, &cfg, &herdr::agents_command()).await?;
    let agents = herdr::parse_agents(&out);
    log::info!("ipc: herdr_agents -> {} 个 agent", agents.len());
    Ok(agents)
}

/// 读这台服务器上 herdr 的**所有窗格**（不只 agent 的，只读）。
///
/// 用途：「接管已有窗格」的列表 —— 空壳窗格（AI 已退出 / 刚开的）也得能选。
#[tauri::command]
pub async fn herdr_panes(
    profile_id: String,
    user_override: Option<String>,
) -> Result<Vec<herdr::HerdrPane>, String> {
    let cfg = ssh_config_for(&profile_id, user_override)?;
    let out = run_remote_capture(&profile_id, &cfg, &herdr::panes_command()).await?;
    let panes = herdr::parse_panes(&out);
    log::info!("ipc: herdr_panes -> {} 个窗格", panes.len());
    Ok(panes)
}

/// herdr 服务现在是什么状态（**只读**，不会顺手把它起起来）
#[tauri::command]
pub async fn herdr_server_status(
    profile_id: String,
    user_override: Option<String>,
) -> Result<herdr::ServerStatus, String> {
    let cfg = ssh_config_for(&profile_id, user_override)?;
    let out = run_remote_capture(&profile_id, &cfg, &herdr::server_status_command()).await?;
    let st = herdr::parse_server_status(&out);
    log::info!(
        "ipc: herdr_server_status -> running={} panes={} raw={:?}",
        st.running,
        st.panes,
        st.raw
    );
    Ok(st)
}

/// **启动** herdr 服务（用户明确点「启动服务」时）。返回启动后的状态行。
#[tauri::command]
pub async fn herdr_server_start(
    profile_id: String,
    user_override: Option<String>,
) -> Result<String, String> {
    let cfg = ssh_config_for(&profile_id, user_override)?;
    let out = run_remote_capture(&profile_id, &cfg, &herdr::server_start_command()).await?;
    log::info!("ipc: herdr_server_start -> {}", out.trim());
    Ok(out.trim().to_string())
}

/// **停止** herdr 服务。**会关掉它管着的所有窗格**，所以只允许用户显式点（前端要确认）。
#[tauri::command]
pub async fn herdr_server_stop(
    profile_id: String,
    user_override: Option<String>,
) -> Result<String, String> {
    let cfg = ssh_config_for(&profile_id, user_override)?;
    let out = run_remote_capture(&profile_id, &cfg, &herdr::server_stop_command()).await?;
    log::info!("ipc: herdr_server_stop -> {}", out.trim());
    Ok(out.trim().to_string())
}

/// 扫一遍这台服务器上的 herdr 工作区 + 每个窗格的前台进程（**只读**）。
///
/// 用来在界面上对比"我们开着的会话"和"服务器上真实存在的工作区"，把**空壳**那些挑出来
/// 给用户一键清理（里面正跑着东西的不算，那是用户正在干的活）。
#[tauri::command]
pub async fn herdr_workspace_scan(
    profile_id: String,
    user_override: Option<String>,
) -> Result<herdr::WorkspaceScan, String> {
    let cfg = ssh_config_for(&profile_id, user_override)?;
    let out = run_remote_capture(&profile_id, &cfg, &herdr::workspace_scan_command()).await?;
    let scan = herdr::parse_workspace_scan(&out);
    log::info!(
        "ipc: herdr_workspace_scan -> {} 个工作区 / {} 个窗格",
        scan.workspaces.len(),
        scan.panes.len()
    );
    Ok(scan)
}

/// 关掉一个 herdr 工作区（连带它里面的窗格）。
///
/// 这一步**会把用户在服务器上的东西关掉**，所以只有用户在前端点过「清理」再点「确认」
/// 才会走到这里；工作区号在后端再消毒一遍（它会被拼进远端 shell 片段）。
#[tauri::command]
pub async fn herdr_workspace_close(
    profile_id: String,
    workspace_id: String,
    user_override: Option<String>,
) -> Result<String, String> {
    let ws = herdr::sanitize_workspace(&workspace_id)
        .ok_or_else(|| format!("工作区号不合法，已拒绝：{workspace_id:?}"))?;
    let cfg = ssh_config_for(&profile_id, user_override)?;
    let out = run_remote_capture(&profile_id, &cfg, &herdr::close_workspace_command(&ws)).await?;
    log::info!("ipc: herdr_workspace_close {ws} -> {}", out.trim());
    Ok(out.trim().to_string())
}

/// 「herdr 快捷操作」面板上的一个动作。
///
/// 和 tmux 那条一个道理：前端只传**动作名**（白名单见 core/herdr.rs::action_command），
/// 后端拼好命令、另开一条 ssh 去跑 herdr 的 socket API —— 不往用户的终端里塞按键，
/// 所以不抢任何快捷键，也不受"窗格里正在跑程序"的影响。
#[tauri::command]
pub async fn herdr_pane_action(
    profile_id: String,
    pane: String,
    action: String,
    arg: Option<String>,
    user_override: Option<String>,
) -> Result<String, String> {
    let cmd = herdr::action_command(&pane, &action, arg.as_deref())
        .ok_or_else(|| format!("不支持的动作，或缺少参数：{action}"))?;
    let cfg = ssh_config_for(&profile_id, user_override)?;
    let out = run_remote_capture(&profile_id, &cfg, &cmd).await?;
    log::info!("ipc: herdr_pane_action {action} pane={pane} -> {}", out.trim());
    Ok(out.trim().to_string())
}

/// 观察窗的尺寸变了：把 observe 流**重开**一次。
///
/// herdr 的观察者是在开流时声明自己行列数的（不会去改窗格本身的尺寸 —— 这正是我们
/// 想要的）。所以"窗口变大"对我们是"重开一条更大观察者"，而不是去 resize 别人的窗格。
#[tauri::command]
pub async fn herdr_pane_resize(
    id: String,
    cols: u16,
    rows: u16,
    registry: State<'_, SessionRegistry>,
    panes: State<'_, HerdrPaneRegistry>,
    logs: State<'_, std::sync::Arc<crate::core::session_log::LogRegistry>>,
) -> Result<(), String> {
    // 和前端同一道闸：太小的尺寸一律不发（首次布局时容器可能是 0）
    if cols < 20 || rows < 5 {
        return Ok(());
    }
    let meta = {
        let m = panes.panes.lock().map_err(|e| e.to_string())?;
        m.get(&id).map(|x| {
            (
                x.profile_id.clone(),
                x.user.clone(),
                x.pane_id.clone(),
                x.cols,
                x.rows,
                x.channel.clone(),
                x.close_flag.clone(),
            )
        })
    };
    let Some((profile_id, user, pane_id, old_cols, old_rows, channel, close_flag)) = meta else {
        return Ok(()); // 不是观察窗会话（普通 ssh/tmux），交给原来的 session_resize
    };
    if old_cols == cols && old_rows == rows {
        return Ok(());
    }
    // 控制流（可读可写那条）：尺寸是它自己的视口参数，**发一条命令就行**，
    // 不用像只读观察窗那样把整条流重开（重开会闪一下，而且没必要）。
    {
        let is_control = panes
            .panes
            .lock()
            .map(|m| m.get(&id).map(|x| x.mode == "control").unwrap_or(false))
            .unwrap_or(false);
        if is_control {
            let writer = {
                let sessions = registry.sessions.lock().map_err(|e| e.to_string())?;
                sessions.get(&id).map(|h| h.writer.clone())
            };
            if let Some(writer) = writer {
                // 阻塞写 → 丢给阻塞线程（见 session_write 上面的说明）
                let line = format!("{}\n", herdr::resize_line(cols, rows));
                let _ = tokio::task::spawn_blocking(move || {
                    use std::io::Write as _;
                    if let Ok(mut w) = writer.lock() {
                        let _ = w.write_all(line.as_bytes());
                        let _ = w.flush();
                    }
                })
                .await;
                if let Ok(mut m) = panes.panes.lock() {
                    if let Some(x) = m.get_mut(&id) {
                        x.cols = cols;
                        x.rows = rows;
                    }
                }
                log::info!("ipc: herdr_pane_resize(control) -> {id} {old_cols}x{old_rows} => {cols}x{rows}");
                return Ok(());
            }
        }
    }
    let effective_user = user
        .as_ref()
        .map(|u| u.trim().to_string())
        .filter(|u| !u.is_empty());
    let cfg = ssh_config_for(&profile_id, user)?;
    let effective_user = effective_user.unwrap_or_else(|| cfg.user.clone());

    // 1) 先让旧线程别再报 "closed"，再把旧进程收掉
    close_flag.store(true, std::sync::atomic::Ordering::Relaxed);
    let old = {
        let mut sessions = registry.sessions.lock().map_err(|e| e.to_string())?;
        sessions.remove(&id)
    };
    if let Some(h) = old {
        let _ = tokio::task::spawn_blocking(move || {
            if let Some(child) = h.child.as_ref() {
                if let Ok(mut c) = child.lock() {
                    let _ = c.kill();
                }
            }
        })
        .await;
    }

    // 2) 擦掉旧画面再铺新的：新流是按**新的宽度**渲染的，不擦会和上面的残影叠在一起
    let clear = base64::engine::general_purpose::STANDARD.encode(b"\x1b[2J\x1b[H");
    let _ = channel.send(SessionEvent::Data {
        data: clear,
        seq: None,
    });

    // 3) 开一条新的观察者
    let cmd = herdr::observe_command(&pane_id, cols, rows);
    let args = ssh::ssh_args_no_tty(
        &cfg.host,
        cfg.port,
        &effective_user,
        cfg.key_path.as_deref(),
        &cmd,
        cfg.jump.as_deref(),
    );
    let title = format!("herdr {}", herdr::sanitize_pane(&pane_id));
    let new_flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    // 起进程这一步也可能慢（要握手/认证）→ 一样丢给阻塞线程
    let spawn_id = id.clone();
    let spawn_program = ssh::ssh_exe();
    let spawn_channel = channel.clone();
    let spawn_logs = logs.inner().clone();
    let spawn_flag = new_flag.clone();
    let handle = tokio::task::spawn_blocking(move || {
        crate::core::herdr_stream::spawn(
            &spawn_id,
            &title,
            &spawn_program,
            &args,
            move |ev| {
                let _ = spawn_channel.send(friendly_herdr_event(ev));
            },
            spawn_logs,
            spawn_flag,
        )
    })
    .await
    .map_err(|e| format!("重建观察流失败: {e}"))?
    .map_err(|e| ssh::friendly_ssh_error_context("重建观察流失败", &e))?;
    registry
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .insert(id.clone(), handle);
    if let Ok(mut m) = panes.panes.lock() {
        if let Some(x) = m.get_mut(&id) {
            x.cols = cols;
            x.rows = rows;
            x.close_flag = new_flag;
        }
    }
    log::info!("ipc: herdr_pane_resize -> {id} {old_cols}x{old_rows} => {cols}x{rows}");
    Ok(())
}

/// 给观察窗配一条常驻的「输入泵」。
///
/// 为什么要常驻：如果每次按键都起一条 ssh，打字会变成"一个字半秒"。
/// 这条进程的 stdin 就是指令通道，按行读：
/// `T<base64 文本>` = 把文本按字面敲进窗格；`K<按键名>` = 敲一个逻辑按键。
#[tauri::command]
pub fn herdr_pane_input_start(
    id: String,
    profile_id: String,
    user_override: Option<String>,
    pane_id: String,
    panes: State<'_, HerdrPaneRegistry>,
) -> Result<(), String> {
    let cfg = ssh_config_for(&profile_id, user_override.clone())?;
    let effective_user = user_override
        .as_ref()
        .map(|u| u.trim().to_string())
        .filter(|u| !u.is_empty())
        .unwrap_or_else(|| cfg.user.clone());
    // 密码登录的服务器：系统 ssh 喂不了密码，输入泵会卡在认证上。
    // 这里**提前说清楚**，比"看起来能打字、实际一个字都进不去"强。
    if password_for(&profile_id, &cfg).is_some() {
        return Err(
            "这台服务器用的是密码登录：观察窗只能看，输入请用 tmux/普通 shell 会话".into(),
        );
    }
    let cmd = herdr::input_pump_command(&pane_id);
    // 输入泵也不需要 PTY：它只是"按行收指令、按行执行"，管道最干净
    //（申请 PTY 反而会带来回显和换行转换）。
    let args = ssh::ssh_args_no_tty(
        &cfg.host,
        cfg.port,
        &effective_user,
        cfg.key_path.as_deref(),
        &cmd,
        cfg.jump.as_deref(),
    );
    // 用**标准库**的 Command：它的 ChildStdin 实现了 std::io::Write，
    // 这样"敲一个字"就是一次同步的小写入，不用为了几字节去 await 一个异步管道。
    // 统一走 proc::hidden_command：常驻输入泵也不许弹控制台窗口。
    let mut c = proc::hidden_command(ssh::ssh_exe());
    c.args(&args);
    c.stdin(std::process::Stdio::piped());
    c.stdout(std::process::Stdio::null());
    c.stderr(std::process::Stdio::null());
    let mut child = c
        .spawn()
        .map_err(|e| ssh::friendly_ssh_error_context("启动输入通道失败", &e.to_string()))?;
    // 跟着应用生命周期走：App 退出/被强杀时不会留下孤儿 ssh
    crate::core::job::assign(child.id());
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "拿不到输入通道的 stdin".to_string())?;
    // ★ Child 句柄**必须**留在注册表里（架构审查 minor-01）。
    //
    // 以前这里 `drop(child)`，只存 stdin：远端 ssh 死掉时我们收不到任何通知，
    // 界面表现是"能打字、字进不去"。现在写入前会 `try_wait()` 判活（见
    // `herdr_write_input`），会话关闭时也会显式 kill（见 `session_close`）。
    panes
        .inputs
        .lock()
        .map_err(|e| e.to_string())?
        .insert(
            id.clone(),
            std::sync::Arc::new(HerdrInputPump {
                child: std::sync::Mutex::new(child),
                stdin: std::sync::Mutex::new(stdin),
            }),
        );
    log::info!("ipc: herdr_pane_input_start {id} pane={pane_id}");
    Ok(())
}

/// **可写**那条路（herdr-control）的输入：把一段原始字节送进窗格。
///
/// 为什么和观察窗的输入不一样：控制流的 stdout/stdin 本身就是"同一条线的两头"，
/// 所以我们不用再另起一条 ssh 去跑输入泵，直接把 JSON 指令写进这个会话的 PTY 就行。
/// JSON 长什么样（`bytes` = base64）由 `core::herdr::input_line` 负责 —— 那是实测出来的
/// 唯一可用字段名，放在 Rust 里也便于单测。
#[tauri::command]
pub async fn herdr_pane_input(
    id: String,
    data_b64: String,
    registry: State<'_, SessionRegistry>,
) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_b64.as_bytes())
        .map_err(|e| format!("解码输入失败: {e}"))?;
    if bytes.is_empty() {
        return Ok(());
    }
    let line = format!("{}\n", herdr::input_line(&bytes));
    // 跟 session_write 一样：只在这把锁里把 writer 的 Arc 取出来，拿完就放锁
    let writer = {
        let sessions = registry.sessions.lock().map_err(|e| e.to_string())?;
        sessions
            .get(&id)
            .ok_or_else(|| "会话不存在".to_string())?
            .writer
            .clone()
    };
    // 和 session_write 同样的道理：阻塞的写不能占着主线程
    tokio::task::spawn_blocking(move || {
        use std::io::Write as _;
        let mut writer = writer.lock().map_err(|e| e.to_string())?;
        writer
            .write_all(line.as_bytes())
            .map_err(|e| e.to_string())?;
        writer.flush().map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("写入线程失败: {e}"))?
}

/// 在 herdr 里**新开一个窗格**，返回它的窗格号（形如 w5:p1）。
///
/// 这就是"新建会话里勾了用 herdr → 直接进她的环境"落地时的那一步：
/// 先在服务器上开一个属于她的 workspace，再把它的根窗格接管到我们的标签页里。
#[tauri::command]
pub async fn herdr_workspace_create(
    profile_id: String,
    user_override: Option<String>,
) -> Result<String, String> {
    let cfg = ssh_config_for(&profile_id, user_override)?;
    let out = run_remote_capture(&profile_id, &cfg, &herdr::create_workspace_command()).await?;
    let pane = herdr::pane_from_create(&out)
        .ok_or_else(|| format!("herdr 没有返回新窗格号：{}", out.trim()))?;
    log::info!("ipc: herdr_workspace_create -> {pane}");
    Ok(pane)
}

/// 往观察窗里**按字面**送一段文本（等价于在窗格里敲键盘）
#[tauri::command]
pub async fn herdr_pane_type(
    id: String,
    text: String,
    panes: State<'_, HerdrPaneRegistry>,
) -> Result<(), String> {
    if text.is_empty() {
        return Ok(());
    }
    let b64 = base64::engine::general_purpose::STANDARD.encode(text.as_bytes());
    let line = format!("T{b64}\n");
    herdr_send_line(&panes, &id, line).await
}

/// 往观察窗里送一个**逻辑按键**（enter / esc / ctrl+c / up …）
///
/// 白名单校验：这个值会被拼进远端命令行，所以只允许 `[a-z0-9+-]`，且不超过 16 个字符。
#[tauri::command]
pub async fn herdr_pane_key(
    id: String,
    key: String,
    panes: State<'_, HerdrPaneRegistry>,
) -> Result<(), String> {
    let k = key.trim().to_ascii_lowercase();
    let ok = !k.is_empty()
        && k.len() <= 16
        && k.chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '+' || c == '-');
    if !ok {
        return Err(format!("不认这个按键名：{key}"));
    }
    let line = format!("K{k}\n");
    herdr_send_line(&panes, &id, line).await
}

/// 往这个会话的输入泵写一行指令；**通道已经死了要报告 + 清表**（架构审查 minor-01）。
///
/// 以前这里只拿 `Arc<Mutex<ChildStdin>>` 去写：远端 ssh 死了以后写 stdin **不会**报错
///（管道还开着，只是没人读），于是界面表现为"能打字、字进不去"。现在：
/// 1. 先把这一轮的错误（含"远端 ssh 已经退出"）通过会话的 Channel 推给界面；
/// 2. 把这条通道从注册表里摘掉 → 下一次按键会自动重开一条。
async fn herdr_send_line(
    panes: &HerdrPaneRegistry,
    id: &str,
    line: String,
) -> Result<(), String> {
    let pump = {
        let m = panes.inputs.lock().map_err(|e| e.to_string())?;
        m.get(id)
            .cloned()
            .ok_or_else(|| "输入通道还没建立".to_string())?
    };
    match herdr_write_input(pump, line).await {
        Ok(()) => Ok(()),
        Err(e) => {
            if let Ok(mut m) = panes.inputs.lock() {
                m.remove(id);
            }
            if let Ok(m) = panes.panes.lock() {
                if let Some(meta) = m.get(id) {
                    let _ = meta.channel.send(SessionEvent::Error {
                        message: e.clone(),
                    });
                }
            }
            log::warn!("herdr 输入通道断开（已从注册表摘掉，下次输入会重开）：{e}");
            Err(e)
        }
    }
}

/// `try_wait()` 的结果 → "还能不能写"。
///
/// 抽成纯函数（纯数据进、判定出）：这样"活着就写、死了就报错"这条判定能单测，
/// 不用真起一条 ssh。参数 `None` = 进程还在跑；`Some(退出码)` = 已经退出。
fn pump_alive_state(exit: Option<Option<i32>>) -> Result<(), String> {
    match exit {
        None => Ok(()),
        Some(Some(code)) => Err(ssh::friendly_ssh_error_context(
            "输入通道已断开（远端 ssh 退出了，正在重开）",
            &format!("输入泵进程退出码 {code}"),
        )),
        Some(None) => Err(ssh::friendly_ssh_error_context(
            "输入通道已断开（远端 ssh 退出了，正在重开）",
            "输入泵进程被异常终止（拿不到退出码）",
        )),
    }
}

/// 往输入泵写一行指令。
///
/// **写入前先判活**：`try_wait()` 说它已经退出，就别再往一个没人读的管道里写
/// —— 那种写是"成功"的，界面却永远等不到字出现在窗格里。
async fn herdr_write_input(pump: std::sync::Arc<HerdrInputPump>, line: String) -> Result<(), String> {
    // 写的是内存管道、一行就几十字节；但"可能阻塞"的东西一律交给阻塞线程，
    // 免得某次远端不读就把界面顶住（AppHang）。
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        use std::io::Write as _;
        let exit = {
            let mut child = pump.child.lock().map_err(|e| e.to_string())?;
            child
                .try_wait()
                .map_err(|e| format!("查询输入通道状态失败: {e}"))?
                .map(|s| s.code())
        };
        pump_alive_state(exit)?;
        let mut s = pump.stdin.lock().map_err(|_| "输入通道断了（内部锁异常）".to_string())?;
        s.write_all(line.as_bytes())
            .map_err(|e| ssh::friendly_ssh_error_context("输入通道断了（下次输入会自动重连）", &e.to_string()))?;
        s.flush().map_err(|e| {
            ssh::friendly_ssh_error_context("输入通道断了（下次输入会自动重连）", &e.to_string())
        })?;
        Ok(())
    })
    .await
    .map_err(|e| ssh::friendly_ssh_error_context("写入输入通道失败", &e.to_string()))?
}

#[cfg(test)]
mod herdr_pump_tests {
    use super::*;

    /// 还活着 = 可以写；退出了 = 必须报错（不能静默写进一个没人读的管道）。
    #[test]
    fn pump_alive_state_only_allows_write_while_running() {
        assert!(pump_alive_state(None).is_ok(), "还在跑 → 可以写");
        let dead = pump_alive_state(Some(Some(1))).unwrap_err();
        assert!(dead.contains("输入通道已断开"), "{dead}");
        assert!(dead.contains("｜原始信息："), "要带原始退出码：{dead}");
        assert!(dead.contains("退出码 1"), "{dead}");
        // 拿不到退出码（被异常终止）也算死了
        let gone = pump_alive_state(Some(None)).unwrap_err();
        assert!(gone.contains("输入通道已断开"), "{gone}");
    }

    /// 真起一个**立刻退出**的假子进程，等它退出后：
    /// 判定必须是"死"，而且真的去写也必须报错 —— 这就是"能打字、字进不去"的回归点。
    #[tokio::test]
    async fn writing_to_an_exited_pump_fails_instead_of_silently_succeeding() {
        let mut cmd = proc::hidden_command("cmd");
        cmd.args(["/C", "exit", "3"]);
        cmd.stdin(std::process::Stdio::piped());
        cmd.stdout(std::process::Stdio::null());
        cmd.stderr(std::process::Stdio::null());
        let mut child = cmd.spawn().expect("假子进程应该能起来");
        let stdin = child.stdin.take().expect("要拿到 stdin 才像真的输入泵");
        let pump = std::sync::Arc::new(HerdrInputPump {
            child: std::sync::Mutex::new(child),
            stdin: std::sync::Mutex::new(stdin),
        });

        // 等它真的退出（最多 5 秒；`cmd /C exit` 是毫秒级）
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let exit = loop {
            let state = {
                let mut c = pump.child.lock().unwrap();
                c.try_wait().unwrap().map(|s| s.code())
            };
            if state.is_some() {
                break state;
            }
            assert!(std::time::Instant::now() < deadline, "假子进程没有在 5 秒内退出");
            std::thread::sleep(std::time::Duration::from_millis(20));
        };
        assert!(
            pump_alive_state(exit).is_err(),
            "子进程退出了，判定必须是『死』：{exit:?}"
        );

        // 关键：写一条指令必须返回 Err（以前这里会静默成功）
        let err = herdr_write_input(pump, "TZGVsbG8=\n".to_string())
            .await
            .expect_err("往已经退出的输入泵里写必须报错");
        assert!(err.contains("输入通道已断开"), "{err}");
    }
}
