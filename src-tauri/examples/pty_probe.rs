//! 手动探针：用 portable-pty 起 ssh.exe，验证「PTY + ssh + tmux attach」这条链路是否真的通。
//!
//! 用法（在 src-tauri 目录下）：
//!   cargo run --release --example pty_probe -- <host> <user>

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

fn main() {
    let host = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "203.0.113.10".into());
    let user = std::env::args().nth(2).unwrap_or_else(|| "root".into());
    let session = "zeeai-probe";

    let sys = native_pty_system();
    let pair = sys
        .openpty(PtySize {
            rows: 40,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        })
        .expect("openpty failed");

    let mut cmd = CommandBuilder::new(r"C:\Windows\System32\OpenSSH\ssh.exe");
    cmd.arg("-tt");
    cmd.arg("-o");
    cmd.arg("BatchMode=yes");
    cmd.arg("-o");
    cmd.arg("StrictHostKeyChecking=accept-new");
    cmd.arg("-o");
    cmd.arg("ServerAliveInterval=30");
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.arg(format!("{user}@{host}"));
    cmd.arg(format!(
        "if command -v tmux >/dev/null 2>&1; then exec tmux new-session -A -s '{session}'; \
else printf '\\n[PROBE] tmux not found - fallback\\n'; exec \"${{SHELL:-/bin/bash}}\"; fi"
    ));

    println!("spawning: ssh -tt {user}@{host}  (tmux session: {session})");
    let mut child = pair.slave.spawn_command(cmd).expect("spawn failed");
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().expect("reader failed");
    let writer = Arc::new(Mutex::new(pair.master.take_writer().expect("writer failed")));

    let acc = Arc::new(Mutex::new(String::new()));
    let acc2 = acc.clone();
    let writer_for_reply = writer.clone();
    thread::spawn(move || {
        let mut chunk = [0u8; 4096];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => {
                    let bytes = &chunk[..n];
                    let text = String::from_utf8_lossy(bytes).to_string();
                    acc2.lock().unwrap().push_str(&text);

                    // 探针本身不是终端模拟器，需要自己应答终端的“状态查询”，
                    // 否则 tmux 会一直等光标位置回复（xterm.js 在真实应用里会自动应答）。
                    let mut reply: Vec<u8> = Vec::new();
                    if bytes.windows(4).any(|w| w == b"\x1b[6n") {
                        reply.extend_from_slice(b"\x1b[1;1R"); // 光标位置报告
                    }
                    if bytes.windows(3).any(|w| w == b"\x1b[c") {
                        reply.extend_from_slice(b"\x1b[?6c"); // 设备属性报告
                    }
                    if !reply.is_empty() {
                        if let Ok(mut w) = writer_for_reply.lock() {
                            let _ = w.write_all(&reply);
                            let _ = w.flush();
                        }
                    }
                }
                Err(_) => break,
            }
        }
    });

    thread::sleep(Duration::from_secs(6));
    let _ = writer.lock().unwrap().write_all(
        b"echo ZEEAI_PTY_MARKER_OK; echo PROBE_HOST=$(hostname); tmux ls 2>&1; echo PROBE_CWD=$(pwd)\n",
    );
    let _ = writer.lock().unwrap().flush();
    thread::sleep(Duration::from_secs(4));
    let _ = writer.lock().unwrap().write_all(b"exit\n");
    let _ = writer.lock().unwrap().flush();
    thread::sleep(Duration::from_secs(2));
    let _ = child.kill();

    let out = acc.lock().unwrap().clone();
    println!("----- captured output ({} bytes) -----", out.len());
    println!("{out}");
    println!("----- checks -----");
    let marker = out.contains("ZEEAI_PTY_MARKER_OK");
    println!("marker ok : {marker}");
    println!("host echo : {}", out.contains("PROBE_HOST="));
    println!("tmux seen : {}", out.contains(session));
    if !marker {
        println!("RESULT: FAILED");
        std::process::exit(1);
    }
    println!("RESULT: OK");
}
