//! A/B 探针：**应用那个 Windows Job Object 是不是把本地 AI CLI 顶掉了**。
//!
//! 背景：用户在本地 PowerShell 里跑 `codex`，看到
//!   `Error: 拒绝访问。 (os error 5)` / "To work without the background server, rerun with --no-daemon"
//! 而同样的 codex 在远程（Linux）正常。`core::job` 给子进程挂的 job 只有
//! `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`，**没有 BREAKAWAY_OK** —— 那么子进程再用
//! `CREATE_BREAKAWAY_FROM_JOB` 起守护进程时，`CreateProcess` 会失败并报
//! **ERROR_ACCESS_DENIED(5)**。这个探针就是验证这条因果：
//!
//!   同一台机器、同一个 codex、同样的 ConPTY —— 只差"挂不挂 job"。
//!
//! 用法（在 src-tauri 目录下）：
//!   cargo run --profile fast --example codex_job_probe

use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use portable_pty::{native_pty_system, CommandBuilder, PtySize};

/// 起一次 codex，收 `secs` 秒输出，返回剥掉转义序列后的文本。
fn run(label: &str, with_job: bool, secs: u64) -> String {
    let sys = native_pty_system();
    let pair = sys
        .openpty(PtySize {
            rows: 40,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        })
        .expect("openpty");

    // codex 在 PATH 上是 npm 的 .cmd/.ps1 垫片，CreateProcess 不能直接跑它们 ——
    // 所以照用户的真实用法来：在 PowerShell 里跑 codex。
    let mut cmd = CommandBuilder::new("powershell.exe");
    cmd.arg("-NoLogo");
    cmd.arg("-Command");
    cmd.arg("codex");
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    let child = match pair.slave.spawn_command(cmd) {
        Ok(c) => c,
        Err(e) => {
            println!("[{label}] spawn 失败：{e}");
            return String::new();
        }
    };
    drop(pair.slave);

    if with_job {
        if let Some(pid) = child.process_id() {
            zeeai_terminal_lib::core::job::assign(pid);
            println!("[{label}] 已把 codex(pid={pid}) 挂进应用的 job object");
        }
    } else {
        println!("[{label}] 不挂 job object");
    }

    let mut reader = pair.master.try_clone_reader().expect("reader");
    let writer = Arc::new(Mutex::new(pair.master.take_writer().expect("writer")));
    let acc = Arc::new(Mutex::new(Vec::<u8>::new()));
    let acc2 = Arc::clone(&acc);
    let w2 = Arc::clone(&writer);
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let bytes = &buf[..n];
                    acc2.lock().unwrap().extend_from_slice(bytes);
                    // 探针不是终端模拟器：得应答状态查询，否则 ConPTY 一直等
                    let mut reply: Vec<u8> = Vec::new();
                    if bytes.windows(4).any(|w| w == b"\x1b[6n") {
                        reply.extend_from_slice(b"\x1b[1;1R");
                    }
                    if bytes.windows(3).any(|w| w == b"\x1b[c") {
                        reply.extend_from_slice(b"\x1b[?6c");
                    }
                    if !reply.is_empty() {
                        if let Ok(mut w) = w2.lock() {
                            let _ = w.write_all(&reply);
                            let _ = w.flush();
                        }
                    }
                }
                Err(_) => break,
            }
        }
    });

    std::thread::sleep(Duration::from_secs(secs));
    let raw = String::from_utf8_lossy(&acc.lock().unwrap()).to_string();
    // 剥掉 ANSI/CSI，留人看得懂的文本
    let mut clean = String::new();
    let mut it = raw.chars().peekable();
    while let Some(c) = it.next() {
        if c == '\u{1b}' {
            if it.peek() == Some(&'[') {
                it.next();
                while let Some(&n) = it.peek() {
                    it.next();
                    if n.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            continue;
        }
        clean.push(c);
    }
    clean
}

fn verdict(text: &str) -> &'static str {
    let low = text.to_lowercase();
    if text.contains("拒绝访问") || low.contains("os error 5") || low.contains("access is denied") {
        "❌ 起不来（拒绝访问 / os error 5）"
    } else if low.contains("no-daemon") {
        "❌ 提示要 --no-daemon（守护进程起不来）"
    } else if text.trim().is_empty() {
        "？ 没有输出"
    } else {
        "✅ 起来了（有 TUI 输出）"
    }
}

fn main() {
    println!("== A：挂 job object（应用现在的行为）==");
    let a = run("A", true, 9);
    println!("判定：{}", verdict(&a));
    println!("---- 输出（前 1200 字符）----\n{}", a.chars().take(1200).collect::<String>());

    println!("\n== B：不挂 job object ==");
    let b = run("B", false, 9);
    println!("判定：{}", verdict(&b));
    println!("---- 输出（前 1200 字符）----\n{}", b.chars().take(1200).collect::<String>());

    println!("\n== 结论 ==");
    println!("A(挂 job) = {}", verdict(&a));
    println!("B(不挂)   = {}", verdict(&b));
}
