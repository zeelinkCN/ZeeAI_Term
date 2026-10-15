//! 探针：**本地 PowerShell（ConPTY）里，回车到底怎么才送得进去**。
//!
//! 用户报的问题：从 AI 输入窗发消息，远程 SSH 正常，**本地 PowerShell 回车发不过去**。
//! 前端那半（`insertText` → `bus.sendInput` → `term.paste(text)` + `term.input("\r")`）
//! 在 mock 里看不出差别，所以这里用**应用自己那份 PTY 代码**（`pty::spawn_with_sink`）
//! 起一个真 PowerShell，把 xterm 会发的那几种字节序列逐个试一遍。
//!
//! 用法（在 src-tauri 目录下）：
//!   cargo run --profile fast --example local_enter_probe
//!
//! 判定用"执行才会出现"的标记：命令写成 `Write-Output ('ZEEAI'+'_A')`，
//! 那么字面量 `ZEEAI_A` **只可能来自执行结果**（PSReadLine 回显的是带 `+` 的原文）。

use std::io::Write;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine as _;
use zeeai_terminal_lib::core::{pty, session_log::LogRegistry, SessionEvent};

/// 执行后才会出现的标记（命令原文里不含这个子串）
fn cmd(mark: &str) -> String {
    format!("Write-Output ('ZEEAI'+'_{mark}')")
}

fn main() {
    // 看门狗：写入有可能卡在 ConPTY 上（第一次跑就卡了 8 分钟、conhost 烧了 445s CPU），
    // 到点强制退出 —— 这样"卡在哪一步"本身也是证据，而且不会挂住构建。
    std::thread::spawn(|| {
        std::thread::sleep(Duration::from_secs(75));
        eprintln!("[watchdog] 75 秒到，强制退出（写 PTY 卡住了）");
        std::process::exit(3);
    });

    let cap: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
    let cap_sink = Arc::clone(&cap);

    // 写入端要能在"收到状态查询时"立刻应答，所以先留一个槽，spawn 之后再填。
    // 不答 `\x1b[6n` 的后果第一次跑就看到了：整段输出只有 `\x1b[6n`，PowerShell 的
    // 横幅/提示符一个字都没渲染 —— 那是**探针不是终端模拟器**，不是被测代码的问题。
    // （真实应用里 xterm.js 会自动应答，见 examples/pty_probe.rs 里同样的处理。）
    type W = Arc<Mutex<Box<dyn Write + Send>>>;
    let slot: Arc<Mutex<Option<W>>> = Arc::new(Mutex::new(None));
    let slot_sink = Arc::clone(&slot);

    let logs = Arc::new(LogRegistry::new());

    let program = std::env::args().nth(1).unwrap_or_else(|| "powershell.exe".into());
    let args: Vec<String> = std::env::args().skip(2).collect();
    println!("被测程序：{program} {args:?}");
    let handle = pty::spawn_with_sink(
        "probe-local",
        "local",
        "probe",
        &program,
        &args,
        None,
        120,
        40,
        move |ev: SessionEvent| {
            if let SessionEvent::Data { data } = ev {
                if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(data.as_bytes())
                {
                    cap_sink.lock().unwrap().extend_from_slice(&bytes);

                    // 应答终端状态查询（真实应用里由 xterm.js 应答）
                    let mut reply: Vec<u8> = Vec::new();
                    if bytes.windows(4).any(|w| w == b"\x1b[6n") {
                        reply.extend_from_slice(b"\x1b[1;1R"); // 光标位置报告
                    }
                    if bytes.windows(3).any(|w| w == b"\x1b[c") {
                        reply.extend_from_slice(b"\x1b[?6c"); // 设备属性报告
                    }
                    if !reply.is_empty() {
                        if let Some(w) = slot_sink.lock().unwrap().as_ref() {
                            if let Ok(mut g) = w.lock() {
                                let _ = g.write_all(&reply);
                                let _ = g.flush();
                            }
                        }
                    }
                }
            }
        },
        logs,
        pty::SpawnOpts::default(),
    )
    .expect("spawn failed");

    // 槽填上：之后凡是有状态查询，sink 就能立刻应答
    *slot.lock().unwrap() = Some(Arc::clone(&handle.writer));

    let writer = Arc::clone(&handle.writer);
    let raw = |bytes: &[u8]| {
        let mut w = writer.lock().unwrap();
        let _ = w.write_all(bytes);
        let _ = w.flush();
    };

    let snapshot = || -> String { String::from_utf8_lossy(&cap.lock().unwrap()).to_string() };

    println!("== 等 PowerShell 起来 ==");
    std::thread::sleep(Duration::from_secs(5));
    let boot = snapshot();
    println!(
        "bracketed paste（\\x1b[?2004h）已开启 = {}",
        boot.contains("\x1b[?2004h")
    );
    println!("启动输出 {} 字节", boot.len());

    // 每个用例：写入 → 等 → 看"执行标记"有没有出现
    let mut case = |name: &str, mark: &str, step1: Vec<u8>, step2: Option<(u64, Vec<u8>)>| {
        // 写前后都打印：万一某次写入卡住，最后一行就指明了卡在哪
        println!("  → {name}：写 {} 字节", step1.len());
        let _ = std::io::stdout().flush();
        raw(&step1);
        println!("     …第一步写完");
        let _ = std::io::stdout().flush();
        if let Some((gap_ms, bytes)) = step2 {
            std::thread::sleep(Duration::from_millis(gap_ms));
            println!("     …第二步写 {} 字节", bytes.len());
            let _ = std::io::stdout().flush();
            raw(&bytes);
            println!("     …第二步写完");
            let _ = std::io::stdout().flush();
        }
        std::thread::sleep(Duration::from_millis(1700));
        let text = snapshot();
        let ok = text.contains(&format!("ZEEAI_{mark}"));
        println!(
            "  {name:<48} 执行标记 ZEEAI_{mark} = {}",
            if ok { "出现 ✓" } else { "没出现 ✗" }
        );
        let _ = std::io::stdout().flush();
        ok
    };

    println!("== 用例（都是 xterm 真实会发的字节）==");
    let a = case("A 原文 + CR（同一次写）", "A", format!("{}\r", cmd("A")).into_bytes(), None);
    let b = case(
        "B bracketed paste 包裹 + CR（同一次写）",
        "B",
        format!("\x1b[200~{}\x1b[201~\r", cmd("B")).into_bytes(),
        None,
    );
    let c = case(
        "C bracketed paste 包裹，CR 隔 80ms 单独写",
        "C",
        format!("\x1b[200~{}\x1b[201~", cmd("C")).into_bytes(),
        Some((80, b"\r".to_vec())),
    );
    let d = case("D 原文 + LF（同一次写）", "D", format!("{}\n", cmd("D")).into_bytes(), None);
    let e = case(
        "E 原文，CR 隔 80ms 单独写",
        "E",
        cmd("E").into_bytes(),
        Some((80, b"\r".to_vec())),
    );
    let f = case(
        "F 原文 + CRLF（同一次写）",
        "F",
        format!("{}\r\n", cmd("F")).into_bytes(),
        None,
    );
    let g = case(
        "G bracketed paste 包裹，然后隔 80ms 写 CRLF",
        "G",
        format!("\x1b[200~{}\x1b[201~", cmd("G")).into_bytes(),
        Some((80, b"\r\n".to_vec())),
    );

    println!("== 结论 ==");
    println!(
        "A(原文+CR)={a}  B(包裹+CR)={b}  C(包裹,CR另写)={c}  D(原文+LF)={d}  E(原文,CR另写)={e}  F(原文+CRLF)={f}  G(包裹,CRLF另写)={g}"
    );

    let tail: String = snapshot().chars().rev().take(400).collect::<String>().chars().rev().collect();
    println!("---- 末尾 400 字符（转义可见）----");
    println!("{}", tail.replace('\x1b', "\\x1b").replace('\r', "\\r"));
}
