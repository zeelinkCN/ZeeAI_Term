use std::io::Read;
use std::sync::{Arc, Mutex};
use std::thread;

use base64::Engine as _;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use tauri::ipc::Channel;

use super::session::{SessionEvent, SessionHandle};
use super::job;

/// 输出流的**后处理**方式。
///
/// 目前只有一种特殊流：herdr 的 `terminal session observe` —— 它吐的是一行行 JSON
/// （`{"bytes":"<base64 的原始终端字节>"}`），必须先解出来才是能喂给 xterm 的字节。
/// 为什么不在远端用 `sed + base64 -d` 拼：那样每来一片就要在服务器上多起两个进程，
/// 而且 shell 引号一多就容易出错 —— 放在 Rust 里只有一个状态机，服务器侧零额外开销。
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub enum Filter {
    /// 原样转发
    #[default]
    Raw,
    /// herdr 的终端流（观察窗 `terminal session observe` 和可写的 `terminal session control`
    /// **帧格式完全一样**）：JSON 行 → base64 解成原始字节；`terminal.closed` 翻成人话送去告警。
    HerdrStream,
}

/// 起进程时的两个开关
#[derive(Clone, Debug)]
pub struct SpawnOpts {
    pub filter: Filter,
    /// **故意重开**时用：不要因为这一路流结束就往前端报 "closed"。
    ///
    /// 为什么是共享开关而不是一个 bool：herdr 的 observe 流在"用户改了窗口大小"时要重开，
    /// 而重开前必须先杀掉旧进程 —— 旧进程的读取线程此时会 EOF。用 bool 的话这个值在起
    /// 线程时就定死了，没法事后告诉它"这次是我让你停的"。所以给一个共享标志：
    /// 重开之前把它置上，旧线程看到它就不会误报"会话已关闭"。
    pub close_flag: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl Default for SpawnOpts {
    fn default() -> Self {
        Self {
            filter: Filter::Raw,
            close_flag: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }
    }
}

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
    opts: SpawnOpts,
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
        // herdr observe 的行缓冲：JSON 是按行来的，一次 read 里可能是半行/多行
        let mut pending: Vec<u8> = Vec::new();
        let flush = |bytes: &[u8],
                     ch: &Channel<SessionEvent>,
                     logs: &std::sync::Arc<super::session_log::LogRegistry>| {
            if bytes.is_empty() {
                return true;
            }
            logs.write(&sid, bytes);
            let data = base64::engine::general_purpose::STANDARD.encode(bytes);
            ch.send(SessionEvent::Data { data }).is_ok()
        };
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if opts.filter == Filter::HerdrStream {
                        // 一次 read 可能切在半行上：push 只吐"完整行的解码结果"，
                        // 剩下的半截留在 pending 里等下一片（分片边界必须处理，
                        // 否则 JSON 会被腰斩 → 解不出来 → 画面断片）。
                        for rec in push_herdr_bytes(&mut pending, &buf[..n]) {
                            // 服务端关流（比如被别的客户端接管）→ 进状态栏，不打进终端
                            if let super::herdr::StreamLine::Closed(msg) = &rec {
                                let _ = ch.send(SessionEvent::Error {
                                    message: msg.clone(),
                                });
                                continue;
                            }
                            let bytes = match rec {
                                super::herdr::StreamLine::Data(d) => d,
                                super::herdr::StreamLine::Other(d) => d,
                                super::herdr::StreamLine::Closed(_) => continue,
                            };
                            if !flush(&bytes, &ch, &logs) {
                                return;
                            }
                        }
                        continue;
                    }
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
        // 收尾：observe 流最后可能还剩半行（正常情况不会有），解出来别丢
        if opts.filter == Filter::HerdrStream && !pending.is_empty() {
            let text = String::from_utf8_lossy(&pending).to_string();
            if let super::herdr::StreamLine::Data(bytes) = super::herdr::classify_line(&text) {
                let _ = flush(&bytes, &ch, &logs);
            }
        }
        if !opts
            .close_flag
            .load(std::sync::atomic::Ordering::Relaxed)
        {
            let _ = ch.send(SessionEvent::State {
                state: "closed".into(),
            });
        }
    });

    Ok(SessionHandle {
        kind: kind.to_string(),
        title: title.to_string(),
        writer: Arc::new(Mutex::new(writer)),
        master: Some(Arc::new(Mutex::new(pair.master))),
        child: Some(Arc::new(Mutex::new(child))),
    })
}

/// 把新收到的一片字节喂进行缓冲，返回**已经能处理的完整记录**。
///
/// 为什么单独抽出来：herdr 的流是**按行**的 JSON，而 socket 读到的分片**不保证**落在
/// 行边界上 —— 一条 JSON 可能被切成两片（甚至跨三片）。这种"粘包/半包"必须自己缓冲，
/// 否则会出现"偶尔花屏/断片"，而且多半在网速慢的时候才复现（最难查的那一类 bug）。
///
/// 解码规则本身在 [`super::herdr::classify_line`] 里（那是 herdr 的协议知识，和被谁调用无关），
/// 这里只负责"按行切分 + 缓冲半截"。
pub fn push_herdr_bytes(
    pending: &mut Vec<u8>,
    chunk: &[u8],
) -> Vec<super::herdr::StreamLine> {
    pending.extend_from_slice(chunk);
    let mut out = Vec::new();
    while let Some(pos) = pending.iter().position(|b| *b == b'\n') {
        let line: Vec<u8> = pending.drain(..=pos).collect();
        let text = String::from_utf8_lossy(&line).to_string();
        let rec = super::herdr::classify_line(&text);
        // 空的数据帧没必要转发（省一次 IPC）
        if let super::herdr::StreamLine::Data(d) = &rec {
            if d.is_empty() {
                continue;
            }
        }
        out.push(rec);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;
    use crate::core::herdr::StreamLine;

    #[test]
    fn observe_line_decodes_base64_payload() {
        let raw = b"\x1b[31mhello\x1b[0m\r\n";
        let json = format!(
            "{{\"bytes\":\"{}\"}}",
            base64::engine::general_purpose::STANDARD.encode(raw)
        );
        assert_eq!(
            crate::core::herdr::classify_line(&json),
            StreamLine::Data(raw.to_vec())
        );
    }

    #[test]
    fn observe_line_passes_through_non_json() {
        assert!(matches!(
            crate::core::herdr::classify_line("herdr: something went wrong"),
            StreamLine::Other(_)
        ));
        assert!(matches!(
            crate::core::herdr::classify_line("{\"other\":1}"),
            StreamLine::Other(_)
        ));
    }

    #[test]
    fn observe_stream_survives_split_across_reads() {
        // 一条 JSON 被切成三片喂进来 —— 这正是网速慢时会发生的情况
        let frame = format!(
            "{{\"bytes\":\"{}\"}}\n",
            base64::engine::general_purpose::STANDARD.encode(b"HELLO\r\n")
        );
        let bytes = frame.as_bytes();
        let mut pending = Vec::new();
        assert!(push_herdr_bytes(&mut pending, &bytes[..5]).is_empty());
        assert!(push_herdr_bytes(&mut pending, &bytes[5..11]).is_empty());
        let got = push_herdr_bytes(&mut pending, &bytes[11..]);
        assert_eq!(got, vec![StreamLine::Data(b"HELLO\r\n".to_vec())]);
        assert!(pending.is_empty(), "完整行解完之后不该留东西");

        // 一片里塞两行半：前两行要立刻出来，剩下的半行留着
        let two = format!(
            "{{\"bytes\":\"{}\"}}\n{{\"bytes\":\"{}\"}}\n{{\"bytes\":",
            base64::engine::general_purpose::STANDARD.encode(b"AA"),
            base64::engine::general_purpose::STANDARD.encode(b"BB")
        );
        let mut p2 = Vec::new();
        let got2 = push_herdr_bytes(&mut p2, two.as_bytes());
        assert_eq!(
            got2,
            vec![
                StreamLine::Data(b"AA".to_vec()),
                StreamLine::Data(b"BB".to_vec())
            ]
        );
        assert!(!p2.is_empty(), "半截行必须留在缓冲里");
        // 非 JSON 的错误文本要原样带出去（否则用户什么都看不到）
        let mut p3 = Vec::new();
        assert_eq!(
            push_herdr_bytes(&mut p3, b"herdr: boom\n"),
            vec![StreamLine::Other(b"herdr: boom\n".to_vec())]
        );
        // 关流记录要被认出来（不能打成一行 JSON 丢到终端里）
        let mut p4 = Vec::new();
        assert!(matches!(
            push_herdr_bytes(&mut p4, b"{\"type\":\"terminal.closed\",\"reason\":\"detached\"}\n")[0],
            StreamLine::Closed(_)
        ));
        // 空数据帧直接丢掉，不浪费一次 IPC
        let mut p5 = Vec::new();
        assert!(push_herdr_bytes(&mut p5, b"{\"bytes\":\"\"}\n").is_empty());
        // 半截 JSON 留在缓冲里，不能当成"其它内容"打到屏幕上
        let mut p6 = Vec::new();
        assert!(push_herdr_bytes(&mut p6, b"{\"bytes\":\"YWJ").is_empty());
        assert_eq!(p6, b"{\"bytes\":\"YWJ".to_vec());
        assert_eq!(
            push_herdr_bytes(&mut p6, b"j\"}\n"),
            // "YWJj" → "abc"（半截 + 剩下的拼起来才是一个完整帧）
            vec![StreamLine::Data(b"abc".to_vec())]
        );
    }
}
