use std::io::Read;
use std::sync::{Arc, Mutex};
use std::thread;

use base64::Engine as _;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use tauri::ipc::Channel;

use super::session::{SessionEvent, SessionHandle};
use super::job;

/// 用系统 PTY 起一个进程（本地终端，或把 ssh.exe 跑在 PTY 里充当远程终端）。
pub fn spawn(
    session_id: &str,
    kind: &str,
    title: &str,
    program: &str,
    args: &[String],
    cwd: Option<&str>,
    cols: u16,
    rows: u16,
    channel: Channel<SessionEvent>,
    logs: std::sync::Arc<super::session_log::LogRegistry>,
) -> Result<SessionHandle, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty failed: {e}"))?;

    let mut cmd = CommandBuilder::new(program);
    for a in args {
        cmd.arg(a);
    }
    if let Some(dir) = cwd {
        cmd.cwd(dir);
    }
    // 尽量给出一个可用的终端环境变量集合
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn failed: {e}"))?;
    drop(pair.slave);

    // 让子进程跟随应用生命周期，避免留下孤儿 ssh 客户端挂在远端 tmux 上
    if let Some(pid) = child.process_id() {
        job::assign(pid);
    }

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone reader failed: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take writer failed: {e}"))?;

    let _ = channel.send(SessionEvent::State {
        state: "connected".into(),
    });

    let ch = channel.clone();
    let sid = session_id.to_string();
    thread::spawn(move || {
        let mut buf = [0u8; 16384];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    // 会话日志：顺手把这一片原始输出落盘（没开日志时是空操作）
                    logs.write(&sid, &buf[..n]);
                    let data = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                    if ch.send(SessionEvent::Data { data }).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = ch.send(SessionEvent::State {
            state: "closed".into(),
        });
    });

    Ok(SessionHandle {
        kind: kind.to_string(),
        title: title.to_string(),
        writer: Arc::new(Mutex::new(writer)),
        master: Some(Arc::new(Mutex::new(pair.master))),
        child: Some(Arc::new(Mutex::new(child))),
    })
}
