//! herdr 终端流的**管道**传输（**不走 ConPTY**）。
//!
//! 为什么不走 ConPTY（都是实测出来的，见 docs/impl-log-2026-09-29-herdr-session.md）：
//! 1) **黑屏**：ConPTY 一启动就会发 `ESC[6n`（问光标位置）这类终端握手，**必须由终端回答**。
//!    而我们的 JSON 行过滤器会把这些"没有换行的字节"当作"半行 JSON"缓冲起来 —— xterm
//!    根本收不到、也就无法回答，ConPTY 于是一直等，herdr 会话一帧都不出来（用户看到的黑屏）；
//! 2) **折行**：ConPTY 把输出按控制台宽度折行，而 herdr 的一帧是**一条超长 JSON 行**
//!    （base64 的整屏画面，几 KB 甚至更大），折行之后 JSON 直接坏掉；
//! 3) 这条协议本身就是"行分隔 JSON"，不需要任何终端语义 —— 用管道最直接：
//!    没有终端握手、没有折行、也不惊动 conhost（顺带把那类 AppHang 也一起躲开了）。

use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;

use base64::Engine as _;

use super::session::{SessionEvent, SessionHandle};
use super::{herdr, job, pty, session_log::LogRegistry};

/// 起一条 herdr 流（观察窗 / 可写控制流共用）：ssh 跑在**管道**里，
/// stdout 上的 JSON 帧解码后交给 `sink`；stdin 就是给 herdr 发指令的入口。
pub fn spawn<F>(
    session_id: &str,
    title: &str,
    program: &str,
    args: &[String],
    sink: F,
    logs: Arc<LogRegistry>,
    close_flag: Arc<std::sync::atomic::AtomicBool>,
) -> Result<SessionHandle, String>
where
    F: Fn(SessionEvent) + Send + Sync + 'static,
{
    let mut cmd = std::process::Command::new(program);
    cmd.args(args);
    cmd.stdin(std::process::Stdio::piped());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    // 一次性/长驻的 ssh 都不该弹控制台窗口
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = cmd.spawn().map_err(|e| format!("启动 herdr 流失败: {e}"))?;
    // 跟着应用生命周期走：App 退出/被强杀时不留下孤儿 ssh
    job::assign(child.id());

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "拿不到 herdr 流的 stdin".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "拿不到 herdr 流的 stdout".to_string())?;
    let stderr = child.stderr.take();

    // sink 要同时给 stdout / stderr 两个线程用 → 用 Arc 包一层（Fn 是共享调用）
    let sink = Arc::new(sink);
    sink(SessionEvent::State {
        state: "connected".into(),
    });

    // stderr 单独一个线程读：herdr 的报错（例如"没有这个窗格"）大多走 stderr，
    // 直接丢掉的话用户只会看到一个空窗口 —— 所以原样送到状态栏。
    let sink_err = sink.clone();
    if let Some(mut err) = stderr {
        thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = err.read_to_end(&mut buf);
            let text = String::from_utf8_lossy(&buf).trim().to_string();
            if !text.is_empty() {
                log::warn!("herdr 流 stderr：{text}");
                sink_err(SessionEvent::Error { message: text });
            }
        });
    }

    let sid = session_id.to_string();
    let mut reader = stdout;
    let sink_out = sink.clone();
    thread::spawn(move || {
        let mut buf = [0u8; 16384];
        let mut pending: Vec<u8> = Vec::new();
        let flush = |bytes: &[u8], logs: &Arc<LogRegistry>| {
            if bytes.is_empty() {
                return;
            }
            logs.write(&sid, bytes);
            let data = base64::engine::general_purpose::STANDARD.encode(bytes);
            sink_out(SessionEvent::Data { data });
        };
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    for rec in pty::push_herdr_bytes(&mut pending, &buf[..n]) {
                        match rec {
                            herdr::StreamLine::Data(d) => flush(&d, &logs),
                            // 不是 JSON 的东西原样透传（远端自己打的提示、错误文本…）
                            herdr::StreamLine::Other(d) => flush(&d, &logs),
                            // 关流记录翻成人话进状态栏，别把一行 JSON 打到终端里
                            herdr::StreamLine::Closed(msg) => {
                                sink_out(SessionEvent::Error { message: msg });
                            }
                        }
                    }
                }
                Err(_) => break,
            }
        }
        if !pending.is_empty() {
            let text = String::from_utf8_lossy(&pending).to_string();
            if let herdr::StreamLine::Data(bytes) = herdr::classify_line(&text) {
                flush(&bytes, &logs);
            }
        }
        if !close_flag.load(std::sync::atomic::Ordering::Relaxed) {
            sink_out(SessionEvent::State {
                state: "closed".into(),
            });
        }
    });

    Ok(SessionHandle {
        kind: "ssh".to_string(),
        title: title.to_string(),
        writer: Arc::new(Mutex::new(Box::new(stdin) as Box<dyn Write + Send>)),
        // 没有 PTY：尺寸靠协议里的 terminal.resize 指令，不走 master.resize
        master: None,
        child: Some(Arc::new(Mutex::new(
            Box::new(child) as Box<dyn portable_pty::Child + Send + Sync>
        ))),
    })
}
