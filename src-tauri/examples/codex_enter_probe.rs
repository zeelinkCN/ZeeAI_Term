//! 探针：本地 codex（真 TUI）里，**粘贴正文 + 回车是"同一批字节"还是"分两次"**，
//! 哪一种才会真的提交？
//!
//! 为什么怀疑这个：用 BP 假 TUI 实测，从输入窗发一条时，我们的两次写入
//!（`term.paste()` 的正文、`term.input("\r")` 的回车）在 ConPTY 那头**被合成一次 read**
//!（假 TUI 只收到 1 段：`\x1b[200~正文\x1b[201~\r`）。远程走 ssh 时通常是分开到达的 ——
//! 这正好能解释"远程正常、本地不提交"。
//!
//! 判定不看屏幕：看 codex 自己写的 rollout（`~/.codex/sessions/**`）里出现了哪个标记：
//!   MARKA（同一批字节） / MARKB（回车晚 150ms 单独写）
//!
//! 用法（在 src-tauri 目录下）：
//!   cargo run --profile fast --example codex_enter_probe

use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use portable_pty::{native_pty_system, CommandBuilder, PtySize};

fn main() {
    let sys = native_pty_system();
    let pair = sys
        .openpty(PtySize {
            rows: 40,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        })
        .expect("openpty");

    let mut cmd = CommandBuilder::new("powershell.exe");
    cmd.arg("-NoLogo");
    cmd.arg("-Command");
    cmd.arg("codex --no-daemon");
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    let child = match pair.slave.spawn_command(cmd) {
        Ok(c) => c,
        Err(e) => {
            println!("spawn 失败：{e}");
            return;
        }
    };
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().expect("reader");
    let writer = Arc::new(Mutex::new(pair.master.take_writer().expect("writer")));
    let acc = Arc::new(Mutex::new(String::new()));
    let acc2 = Arc::clone(&acc);
    let w2 = Arc::clone(&writer);
    std::thread::spawn(move || {
        let mut buf = [0u8; 16384];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let bytes = &buf[..n];
                    acc2
                        .lock()
                        .unwrap()
                        .push_str(&String::from_utf8_lossy(bytes));
                    let mut reply: Vec<u8> = Vec::new();
                    if bytes.windows(4).any(|w| w == b"\x1b[6n") {
                        reply.extend_from_slice(b"\x1b[1;1R");
                    }
                    if bytes.windows(3).any(|w| w == b"\x1b[c") {
                        reply.extend_from_slice(b"\x1b[?6c");
                    }
                    if !reply.is_empty() {
                        if let Ok(mut g) = w2.lock() {
                            let _ = g.write_all(&reply);
                            let _ = g.flush();
                        }
                    }
                }
                Err(_) => break,
            }
        }
    });

    let raw = |bytes: &[u8]| {
        let mut g = writer.lock().unwrap();
        let _ = g.write_all(bytes);
        let _ = g.flush();
    };

    // 等 codex 的 TUI 就绪（横幅/输入框出现）
    let mut ready = false;
    for _ in 0..60 {
        std::thread::sleep(Duration::from_millis(500));
        let text = acc.lock().unwrap().clone();
        if text.contains("Ask Codex") || text.contains("OpenAI Codex") {
            ready = true;
            break;
        }
    }
    println!("codex 就绪 = {ready}（等了最多 30 秒）");
    if !ready {
        let text = acc.lock().unwrap().clone();
        println!("---- 当前输出 ----\n{}", text.chars().take(800).collect::<String>());
        return;
    }
    std::thread::sleep(Duration::from_secs(2));

    // A：正文（bracketed paste 包着）+ 回车，**同一次写**
    println!("A：paste 正文 + CR 同一次写");
    raw(b"\x1b[200~MARKA-coalesced\x1b[201~\r");
    std::thread::sleep(Duration::from_secs(8));

    // B：正文先写，回车晚 150ms 单独写
    println!("B：paste 正文，CR 晚 150ms 单独写");
    raw(b"\x1b[200~MARKB-split\x1b[201~");
    std::thread::sleep(Duration::from_millis(150));
    raw(b"\r");
    std::thread::sleep(Duration::from_secs(8));

    let text = acc.lock().unwrap().clone();
    println!("---- 末尾 600 字符 ----");
    let tail: String = text.chars().rev().take(600).collect::<Vec<_>>().into_iter().rev().collect();
    println!("{}", tail.replace('\u{1b}', "\\x1b"));

    println!("== 现在去看 rollout：哪个标记出现在 user 消息里 ==");
    println!("（A 的标记 MARKA / B 的标记 MARKB；两个都出现 = 两种都行）");
    let _ = child;
}

