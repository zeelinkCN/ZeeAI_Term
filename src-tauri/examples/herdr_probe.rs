//! 真机复现器：用**应用自己的代码路径**跑一遍 herdr 会话，看本地到底收到了什么。
//!
//! 为什么需要它：无头前端测试把后端假掉了，测不到"本地 ConPTY ↔ ssh ↔ herdr"这一段；
//! 而用户遇到的黑屏正好出在这段。这里不做任何特殊处理 —— 用的是
//! `pty::spawn_with_sink`（和正式代码同一个实现）+ 和 `open_ssh` 同一套 ssh 参数。
//!
//! 用法（只在需要时手动跑）：
//! ```text
//! ZEEAI_PROBE_USER=lz cargo run --example herdr_probe
//! ```
//! 可选：`ZEEAI_PROBE_HOST`（默认 192.0.2.45）、`ZEEAI_PROBE_SECS`（默认 5）、
//! `ZEEAI_PROBE_NOTTY=1`（对照：不加 -tt）。

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use zeeai_terminal_lib::core::{
    herdr, herdr_stream, pty, session_log::LogRegistry, ssh, SessionEvent,
};

fn main() {
    let host = std::env::var("ZEEAI_PROBE_HOST").unwrap_or_else(|_| "192.0.2.45".into());
    let user = std::env::var("ZEEAI_PROBE_USER").unwrap_or_else(|_| "lz".into());
    let secs: u64 = std::env::var("ZEEAI_PROBE_SECS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(5);
    let no_tty = std::env::var("ZEEAI_PROBE_NOTTY").is_ok();
    // 结果写文件：这个复现器最后可能卡在"关工作区"那条 ssh 上，写文件才拿得到结论
    let report_path = std::env::temp_dir().join("zeeai-herdr-probe.txt");
    let mut report = String::new();
    macro_rules! say {
        ($($arg:tt)*) => {{
            let line = format!($($arg)*);
            println!("{line}");
            report.push_str(&line);
            report.push('\n');
            let _ = std::fs::write(&report_path, &report);
        }};
    }

    // ---------- 对照 0：先确认"我们这个 PTY 到底收得到东西吗" ----------
    // 本地 cmd 和一条 ssh echo 各跑 2 秒。这两条都收不到 = 问题在 PTY 这一层，
    // 而不是 herdr；收得到 = 才轮到怀疑 herdr 的输出格式。
    for (name, program, args) in [
        ("本地 cmd echo", "cmd.exe".to_string(), vec!["/c".into(), "echo HELLO_FROM_PTY".into()]),
        (
            "ssh echo（非终端）",
            ssh::ssh_exe(),
            vec![
                "-o".to_string(),
                "StrictHostKeyChecking=accept-new".to_string(),
                format!("{user}@{host}"),
                "echo HELLO_FROM_SSH".to_string(),
            ],
        ),
    ] {
        let got = Arc::new(AtomicUsize::new(0));
        let g2 = got.clone();
        let text = Arc::new(Mutex::new(String::new()));
        let t2 = text.clone();
        let r = pty::spawn_with_sink(
            "probe-ctl",
            "probe",
            "probe",
            &program,
            &args,
            None,
            80,
            24,
            move |ev| {
                if let SessionEvent::Data { data } = ev {
                    use base64::Engine as _;
                    let b = base64::engine::general_purpose::STANDARD
                        .decode(data.as_bytes())
                        .unwrap_or_default();
                    g2.fetch_add(b.len(), Ordering::Relaxed);
                    let mut t = t2.lock().unwrap();
                    t.push_str(&String::from_utf8_lossy(&b));
                }
            },
            Arc::new(LogRegistry::new()),
            pty::SpawnOpts::default(),
        );
        std::thread::sleep(std::time::Duration::from_secs(2));
        let n = got.load(Ordering::Relaxed);
        let t = text.lock().unwrap().clone();
        say!(
            "   [对照] {name}：{}，收到 {n} 字节；内容：{}",
            if r.is_ok() { "spawn 成功" } else { "spawn 失败" },
            t.replace(['\r', '\n'], " ").chars().take(80).collect::<String>()
        );
    }

    say!("== 1) 先在服务器上开一个 herdr 工作区（和「新建窗格」同一条命令）==");
    // 注意：正式代码里这条走 run_remote_capture，**不加 -tt**（只有终端会话才加）
    let create = run_ssh(&host, &user, &herdr::create_workspace_command(), false);
    let pane = herdr::pane_from_create(&create).unwrap_or_default();
    say!("   create 输出：{}", create.trim());
    say!("   解析出的窗格：{pane}");
    if pane.is_empty() {
        eprintln!("   拿不到窗格号，停");
        std::process::exit(2);
    }

    say!("== 2) 用**新的管道传输**接管它（herdr_stream，不申请 PTY）==");
    let cmd = herdr::control_command(&pane, 110, 30, true);
    let args = ssh::ssh_args_no_tty(&host, 22, &user, None, &cmd, None);
    let logs = Arc::new(LogRegistry::new());
    let frames = Arc::new(AtomicUsize::new(0));
    let total = Arc::new(AtomicUsize::new(0));
    let first_text = Arc::new(Mutex::new(String::new()));
    let f2 = frames.clone();
    let t2 = total.clone();
    let s2 = first_text.clone();
    let handle = herdr_stream::spawn(
        "probe",
        "probe",
        &ssh::ssh_exe(),
        &args,
        move |ev| match ev {
            SessionEvent::Data { data } => {
                use base64::Engine as _;
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(data.as_bytes())
                    .unwrap_or_default();
                t2.fetch_add(bytes.len(), Ordering::Relaxed);
                f2.fetch_add(1, Ordering::Relaxed);
                let mut g = s2.lock().unwrap();
                if g.is_empty() {
                    *g = String::from_utf8_lossy(&bytes).to_string();
                }
            }
            SessionEvent::Error { message } => println!("   [状态栏告警] {message}"),
            SessionEvent::State { state } => println!("   [状态] {state}"),
            SessionEvent::Title { .. } => {}
        },
        logs,
        Arc::new(std::sync::atomic::AtomicBool::new(false)),
    );
    match &handle {
        Ok(_) => say!("   PTY 起来了（和正式代码同一条路）"),
        Err(e) => {
            say!("   PTY 起不来：{e}");
            std::fs::write(&report_path, &report).ok();
            std::process::exit(3);
        }
    }

    std::thread::sleep(std::time::Duration::from_secs(secs));
    let n = frames.load(Ordering::Relaxed);
    let bytes = total.load(Ordering::Relaxed);
    say!("== 3) {secs} 秒里本地收到 ==");
    say!("   数据事件 {n} 个，解出来 {bytes} 字节");
    let text = first_text.lock().unwrap().clone();
    let clean: String = text
        .chars()
        .filter(|c| !c.is_control() || *c == '\n')
        .collect();
    say!("   第一帧开头：{}", clean.chars().take(160).collect::<String>());
    say!(
        "== 结论 ==\n   {}",
        if bytes > 0 {
            "本机能收到帧 → 本地这一段没问题"
        } else {
            "本机**一帧都没收到** → 黑屏出在这一层（PTY/ssh/参数）"
        }
    );

    // 收尾：关掉服务器上那个临时工作区（不加 -tt，和正式代码一致）。
    // PTY 那边直接让进程退出带走，不做 drop(handle)（那一步在某些情况下会等 conhost）。
    let _ = std::process::Command::new("ssh")
        .args([
            "-o",
            "StrictHostKeyChecking=accept-new",
            &format!("{user}@{host}"),
            &format!("herdr workspace close '{}'", pane.split(':').next().unwrap_or("")),
        ])
        .status();
    say!("（临时工作区已关掉）");
    std::process::exit(0);
}

/// 跑一次一次性远端命令（偷懒版 run_remote_capture：只走系统 ssh，够用）
fn run_ssh(host: &str, user: &str, cmd: &str, tty: bool) -> String {
    let mut args: Vec<String> = Vec::new();
    if tty {
        args.push("-tt".into());
    }
    args.push("-o".into());
    args.push("StrictHostKeyChecking=accept-new".into());
    args.push(format!("{user}@{host}"));
    args.push(cmd.to_string());
    let out = std::process::Command::new(ssh::ssh_exe())
        .args(&args)
        .output();
    match out {
        Ok(o) => {
            let mut s = String::from_utf8_lossy(&o.stdout).to_string();
            s.push_str(&String::from_utf8_lossy(&o.stderr));
            s
        }
        Err(e) => format!("执行 ssh 失败：{e}"),
    }
}

/// 和正式代码同款的 ssh 参数（这里 -tt 可控，方便做对照实验）
fn ssh_args(host: &str, user: &str, cmd: &str, tty: bool) -> Vec<String> {
    let mut a: Vec<String> = Vec::new();
    if tty {
        a.push("-tt".into());
    }
    a.extend(
        ssh::ssh_args(host, 22, user, None, Some(cmd), false, None)
            .into_iter()
            // ssh_args 自己会加 -tt，这里去掉，交给本函数的 tty 开关决定
            .filter(|x| x != "-tt"),
    );
    a
}
