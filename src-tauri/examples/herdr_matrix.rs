//! herdr 功能**全矩阵**真机测试（用应用自己的代码路径，不假后端）。
//!
//! 覆盖：探测 / 新建窗格 / 可写流（读+写+改尺寸+交还）/ 只读观察 / 输入泵 /
//!        抢控制权(--takeover) / 窗格不存在时的报错 / 关流告警 / 清理。
//!
//! 用法（需要真机）：
//! ```text
//! ZEEAI_PROBE_USER=lz cargo run --example herdr_matrix
//! ```
//! 退出码 0 = 全过；非 0 = 有失败（失败项会打出来）。

use std::io::Write;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use zeeai_terminal_lib::core::{
    herdr, herdr_stream, session_log::LogRegistry, ssh, SessionEvent,
};

/// 收集一条流的输出（解码后的原始字节 → 去掉 ANSI 的文本）
#[derive(Default)]
struct Recorder {
    bytes: usize,
    text: String,
    states: Vec<String>,
    errors: Vec<String>,
    closed: bool,
}

fn collector(r: Arc<Mutex<Recorder>>) -> impl Fn(SessionEvent) + Send + Sync + 'static {
    move |ev| match ev {
        SessionEvent::Data { data } => {
            use base64::Engine as _;
            let b = base64::engine::general_purpose::STANDARD
                .decode(data.as_bytes())
                .unwrap_or_default();
            let mut g = r.lock().unwrap();
            g.bytes += b.len();
            g.text.push_str(&strip_ansi(&String::from_utf8_lossy(&b)));
        }
        SessionEvent::Error { message } => r.lock().unwrap().errors.push(message),
        SessionEvent::State { state } => {
            let mut g = r.lock().unwrap();
            if state == "closed" {
                g.closed = true;
            }
            g.states.push(state);
        }
        SessionEvent::Title { .. } => {}
    }
}

/// 粗略去掉 ANSI 转义（只为断言里找关键词）
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        if c == '\u{1b}' {
            match it.peek() {
                Some('[') => {
                    it.next();
                    while let Some(&n) = it.peek() {
                        it.next();
                        if n.is_ascii_alphabetic() {
                            break;
                        }
                    }
                }
                Some(']') => {
                    it.next();
                    // OSC 的结束符有**两种**：BEL(\x07) 或 ST(ESC \)。
                    // herdr 用的是 ST（`ESC]8;;ESC\`，OSC 8 超链接），只认 BEL 的话
                    // 会把后面整屏文字一起吃掉 —— 这个坑我自己的测试脚本先踩了。
                    while let Some(n) = it.next() {
                        if n == '\u{7}' {
                            break;
                        }
                        if n == '\u{1b}' && it.peek() == Some(&'\\') {
                            it.next();
                            break;
                        }
                    }
                }
                _ => {}
            }
            continue;
        }
        out.push(c);
    }
    out
}

fn ssh_run(host: &str, user: &str, cmd: &str) -> String {
    let args = ssh::ssh_exec_args(host, 22, user, None, cmd, None);
    match std::process::Command::new(ssh::ssh_exe()).args(&args).output() {
        Ok(o) => {
            let mut s = String::from_utf8_lossy(&o.stdout).to_string();
            s.push_str(&String::from_utf8_lossy(&o.stderr));
            s
        }
        Err(e) => format!("ssh 执行失败：{e}"),
    }
}

/// 当前机器上所有 `ssh.exe` 的 pid。
///
/// 为什么要按 pid 差集收尾：这个例程会起好几条**长驻** ssh 流（观察/控制/输入泵），
/// 它们的进程不会随 Rust 句柄释放而退出。上一次我忘了收，真机上攒了 41 个残留 ssh，
/// 一直挂在服务器上，最终把 sshd 拖到"新连接被排队"——用户看到的就是
/// **「新建 herdr 窗格」一直卡着**。所以跑完必须只把我们自己新起的那些收掉。
fn ssh_pids() -> Vec<u32> {
    let out = std::process::Command::new("tasklist")
        .args([
            "/FI",
            "IMAGENAME eq ssh.exe",
            "/FO",
            "CSV",
            "/NH",
        ])
        .output();
    let Ok(out) = out else { return Vec::new() };
    let text = String::from_utf8_lossy(&out.stdout);
    text.lines()
        .filter_map(|l| {
            let mut it = l.split("\",\"");
            let name = it.next()?.trim_start_matches('"').to_ascii_lowercase();
            if name != "ssh.exe" {
                return None;
            }
            it.next()?.trim_end_matches('"').trim().parse::<u32>().ok()
        })
        .collect()
}

/// 只杀"这次新起来"的 ssh（不碰用户自己的 ssh 会话）
fn kill_new_ssh(before: &[u32]) {
    for pid in ssh_pids() {
        if !before.contains(&pid) {
            let _ = std::process::Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/F"])
                .output();
        }
    }
}

/// 等一条流**拿到第一帧**（最多 `timeout_ms`）。
///
/// 为什么不能固定 sleep 3 秒就断言：ssh 握手 + herdr 首帧在机器忙的时候会超过 3 秒
/// （我第一次跑矩阵时就因为这样误报了 3 条 observe 失败）。这里轮询到有数据为止，
/// 结论才稳定；同时这也说明**应用侧同样可能"先空白一会儿"**（流不会断，帧到了就画）。
fn wait_bytes(rec: &Arc<Mutex<Recorder>>, timeout_ms: u64) -> usize {
    let step = 250u64;
    let mut waited = 0u64;
    loop {
        let n = rec.lock().unwrap().bytes;
        if n > 0 || waited >= timeout_ms {
            return n;
        }
        std::thread::sleep(std::time::Duration::from_millis(step));
        waited += step;
    }
}

/// 等"有数据**或**有告警"（有些用例的预期结果就是一条报错，不是画面）
fn wait_any(rec: &Arc<Mutex<Recorder>>, timeout_ms: u64) -> (usize, usize) {
    let step = 250u64;
    let mut waited = 0u64;
    loop {
        let g = rec.lock().unwrap();
        if (g.bytes > 0 || !g.errors.is_empty()) || waited >= timeout_ms {
            return (g.bytes, g.errors.len());
        }
        drop(g);
        std::thread::sleep(std::time::Duration::from_millis(step));
        waited += step;
    }
}

fn main() {
    let host = std::env::var("ZEEAI_PROBE_HOST").unwrap_or_else(|_| "47.99.241.168".into());
    let user = std::env::var("ZEEAI_PROBE_USER").unwrap_or_else(|_| "lz".into());
    println!("== herdr 全矩阵测试 → {user}@{host} ==");
    // 记下"开跑前就有哪些 ssh"，收尾时只杀我们自己新起的（见 kill_new_ssh）
    let ssh_before = ssh_pids();

    let mut pass = 0usize;
    let mut fail = 0usize;
    macro_rules! check {
        ($name:expr, $cond:expr, $extra:expr) => {{
            if $cond {
                pass += 1;
                println!("PASS  {}\t{}", $name, $extra);
            } else {
                fail += 1;
                println!("FAIL  {}\t{}", $name, $extra);
            }
        }};
    }

    // ---------- 1) 探测：herdr 在不在、协议号 ----------
    let probe = ssh_run(&host, &user, &herdr::agents_command());
    let agents = herdr::parse_agents(&probe);
    check!(
        "探测 herdr 可用",
        !probe.contains("HERDR_NONE"),
        format!("agents={}", agents.len())
    );

    // ---------- 2) 新建窗格（应用里「新建一个 herdr 窗格」走的就是这条） ----------
    let create = ssh_run(&host, &user, &herdr::create_workspace_command());
    let pane = herdr::pane_from_create(&create).unwrap_or_default();
    check!(
        "新建 herdr 窗格并解析出窗格号",
        pane.starts_with('w') && pane.contains(':'),
        format!("pane={pane}")
    );
    if pane.is_empty() {
        println!("\n拿不到窗格号，后面的用例没法跑。原始输出：{create}");
        std::process::exit(2);
    }
    let ws = pane.split(':').next().unwrap_or("").to_string();

    // ---------- 3) 可写控制流：能收到帧 ----------
    let rec = Arc::new(Mutex::new(Recorder::default()));
    let ctl_cmd = herdr::control_command(&pane, 100, 28, true);
    let ctl_args = ssh::ssh_args_no_tty(&host, 22, &user, None, &ctl_cmd, None);
    let ctl = herdr_stream::spawn(
        "matrix-ctl",
        "matrix",
        &ssh::ssh_exe(),
        &ctl_args,
        collector(rec.clone()),
        Arc::new(LogRegistry::new()),
        Arc::new(std::sync::atomic::AtomicBool::new(false)),
    );
    std::thread::sleep(std::time::Duration::from_secs(3));
    let (bytes, text) = {
        let g = rec.lock().unwrap();
        (g.bytes, g.text.clone())
    };
    check!(
        "可写流收到画面（说明管道传输通了）",
        bytes > 0,
        format!("{bytes} 字节，开头：{:?}", text.trim().chars().take(40).collect::<String>())
    );

    // ---------- 4) 往流里写命令 → 真的执行了吗 ----------
    if let Ok(h) = &ctl {
        let marker = format!("ZEEAI_MATRIX_{}", std::process::id());
        let line = format!("{}\n", herdr::input_line(format!("echo {marker}\r").as_bytes()));
        let write_res = {
            let mut w = h.writer.lock().unwrap();
            let r = w.write_all(line.as_bytes()).and_then(|_| w.flush());
            r
        };
        println!("   [诊断] 写入 {} 字节 → {:?}", line.len(), write_res);
        std::thread::sleep(std::time::Duration::from_secs(1));
        // 直接看窗格自己的画面：到底有没有收到我们敲的字
        let pane_after = ssh_run(
            &host,
            &user,
            &format!("herdr pane read '{pane}' --source recent --format text --lines 10"),
        );
        println!(
            "   [诊断] 窗格画面里有没有 marker：{}；片段：{:?}",
            pane_after.contains(&marker),
            pane_after.trim().chars().take(120).collect::<String>()
        );
        std::thread::sleep(std::time::Duration::from_secs(2));
        let (got, count, tail) = {
            let g = rec.lock().unwrap();
            let n = g.text.matches(&marker).count();
            let tail: String = g
                .text
                .chars()
                .rev()
                .take(160)
                .collect::<String>()
                .chars()
                .rev()
                .collect();
            (n >= 2, n, tail.replace('\n', "⏎"))
        };
        check!(
            "写入命令后被真的执行（画面里出现回显+输出）",
            got,
            format!("marker={marker} 出现 {count} 次；尾部：{tail}")
        );

        // ---------- 5) 改尺寸不报错、且画面重绘 ----------
        let before = rec.lock().unwrap().bytes;
        let rl = format!("{}\n", herdr::resize_line(80, 20));
        {
            let mut w = h.writer.lock().unwrap();
            let _ = w.write_all(rl.as_bytes());
            let _ = w.flush();
        }
        std::thread::sleep(std::time::Duration::from_secs(2));
        let after = rec.lock().unwrap().bytes;
        let errs = rec.lock().unwrap().errors.clone();
        check!(
            "terminal.resize 生效（画面重绘、无报错）",
            after > before && errs.is_empty(),
            format!("字节 {before} → {after}，errors={errs:?}")
        );

        // ---------- 6) 抢控制权：再来一个 --takeover，原控制端应该收到告警 ----------
        let rec2 = Arc::new(Mutex::new(Recorder::default()));
        let ctl2_cmd = herdr::control_command(&pane, 100, 28, true);
        let ctl2_args = ssh::ssh_args_no_tty(&host, 22, &user, None, &ctl2_cmd, None);
        let ctl2 = herdr_stream::spawn(
            "matrix-ctl2",
            "matrix",
            &ssh::ssh_exe(),
            &ctl2_args,
            collector(rec2.clone()),
            Arc::new(LogRegistry::new()),
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
        );
        let _ = wait_bytes(&rec2, 8000);
        let b2 = rec2.lock().unwrap().bytes;
        check!("--takeover 能抢到控制权（新控制端拿到画面）", b2 > 0, format!("{b2} 字节"));
        let old_errors = rec.lock().unwrap().errors.clone();
        check!(
            "原控制端收到「被接管」告警（翻成中文进状态栏）",
            old_errors.iter().any(|e| e.contains("接管") || e.contains("关掉")),
            format!("errors={old_errors:?}")
        );
        if let Ok(h2) = &ctl2 {
            let _ = h2
                .writer
                .lock()
                .map(|mut w| {
                    let _ = w.write_all(format!("{}\n", herdr::release_line()).as_bytes());
                    let _ = w.flush();
                });
        }
        std::thread::sleep(std::time::Duration::from_secs(1));

        // ---------- 7) 交还控制权后，窗格还在（tmux 那种"能回来"） ----------
        let still = ssh_run(&host, &user, &format!("herdr pane get '{pane}' 2>&1 | head -c 600"));
        check!(
            "交还控制权后窗格仍在服务器上",
            still.contains("\"pane_id\"") && still.contains(&pane),
            format!("含 pane_id={}", still.contains(&pane))
        );
    }

    // ---------- 8) 只读观察窗 ----------
    {
        let rec3 = Arc::new(Mutex::new(Recorder::default()));
        let obs_cmd = herdr::observe_command(&pane, 100, 28);
        let obs_args = ssh::ssh_args_no_tty(&host, 22, &user, None, &obs_cmd, None);
        let _obs = herdr_stream::spawn(
            "matrix-obs",
            "matrix",
            &ssh::ssh_exe(),
            &obs_args,
            collector(rec3.clone()),
            Arc::new(LogRegistry::new()),
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
        );
        let b = wait_bytes(&rec3, 8000);
        check!("只读观察窗拿到画面", b > 0, format!("{b} 字节"));
    }

    // ---------- 9) 输入泵（观察窗打字用的那条） ----------
    {
        let marker = format!("ZEEAI_PUMP_{}", std::process::id());
        let mut cmd = std::process::Command::new(ssh::ssh_exe());
        cmd.args(ssh::ssh_args_no_tty(
            &host,
            22,
            &user,
            None,
            &herdr::input_pump_command(&pane),
            None,
        ));
        cmd.stdin(std::process::Stdio::piped());
        cmd.stdout(std::process::Stdio::null());
        cmd.stderr(std::process::Stdio::null());
        match cmd.spawn() {
            Ok(mut child) => {
                {
                    use base64::Engine as _;
                    let text = base64::engine::general_purpose::STANDARD
                        .encode(format!("echo {marker}").as_bytes());
                    if let Some(si) = child.stdin.as_mut() {
                        let _ = si.write_all(format!("T{text}\n").as_bytes());
                        let _ = si.write_all(b"Kenter\n");
                        let _ = si.flush();
                    }
                }
                std::thread::sleep(std::time::Duration::from_secs(2));
                let out = ssh_run(
                    &host,
                    &user,
                    &format!("herdr pane read '{pane}' --source recent --format text --lines 20"),
                );
                check!(
                    "输入泵能把命令敲进窗格（send-text + enter）",
                    out.contains(&marker) && out.matches(&marker).count() >= 2,
                    format!("marker={marker}")
                );
                let _ = child.kill();
            }
            Err(e) => check!("输入泵能起来", false, format!("{e}")),
        }
    }

    // ---------- 9b) 观察者 + 控制端**同时**挂在一个窗格上（不打架） ----------
    {
        let rec_obs = Arc::new(Mutex::new(Recorder::default()));
        let rec_ctl = Arc::new(Mutex::new(Recorder::default()));
        let obs_cmd = herdr::observe_command(&pane, 100, 28);
        let obs_args = ssh::ssh_args_no_tty(&host, 22, &user, None, &obs_cmd, None);
        let ctl_cmd = herdr::control_command(&pane, 100, 28, true);
        let ctl_args = ssh::ssh_args_no_tty(&host, 22, &user, None, &ctl_cmd, None);
        let _o = herdr_stream::spawn(
            "matrix-both-obs",
            "matrix",
            &ssh::ssh_exe(),
            &obs_args,
            collector(rec_obs.clone()),
            Arc::new(LogRegistry::new()),
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
        );
        let c = herdr_stream::spawn(
            "matrix-both-ctl",
            "matrix",
            &ssh::ssh_exe(),
            &ctl_args,
            collector(rec_ctl.clone()),
            Arc::new(LogRegistry::new()),
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
        );
        // 等到**两边都出画面**再往下走（握手慢的时候 3 秒不够，会误报）
        let _ = wait_bytes(&rec_obs, 8000);
        let _ = wait_bytes(&rec_ctl, 8000);
        // 让控制端敲一句，观察端**应该也能看到**（同一块屏幕的两个视角）
        if let Ok(h) = &c {
            let m = format!("ZEEAI_BOTH_{}", std::process::id());
            let line = format!("{}\n", herdr::input_line(format!("echo {m}\r").as_bytes()));
            let _ = h.writer.lock().map(|mut w| {
                let _ = w.write_all(line.as_bytes());
                let _ = w.flush();
            });
            std::thread::sleep(std::time::Duration::from_secs(2));
            let obs_text = rec_obs.lock().unwrap().text.clone();
            let ctl_text = rec_ctl.lock().unwrap().text.clone();
            check!(
                "观察者与控制端可同时工作，且看到同一画面变化",
                obs_text.contains(&m) && ctl_text.contains(&m),
                format!("观察端看到={} 控制端看到={}", obs_text.contains(&m), ctl_text.contains(&m))
            );
        }
        let o = rec_obs.lock().unwrap().bytes;
        let cc = rec_ctl.lock().unwrap().bytes;
        check!(
            "两边都能持续收到帧（互不踢掉）",
            o > 0 && cc > 0,
            format!("观察 {o} 字节 / 控制 {cc} 字节")
        );
    }

    // ---------- 9c) 观察流"重开"（窗口改尺寸时我们就是这么做的）----------
    {
        let rec_a = Arc::new(Mutex::new(Recorder::default()));
        let args_a = ssh::ssh_args_no_tty(
            &host,
            22,
            &user,
            None,
            &herdr::observe_command(&pane, 100, 28),
            None,
        );
        let _a = herdr_stream::spawn(
            "matrix-re-open-1",
            "matrix",
            &ssh::ssh_exe(),
            &args_a,
            collector(rec_a.clone()),
            Arc::new(LogRegistry::new()),
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
        );
        let _ = wait_bytes(&rec_a, 8000);
        // 换一个尺寸重开一条（真实场景：用户拖窗口宽度 → 前端 debounce 后重开观察流）
        let rec_b = Arc::new(Mutex::new(Recorder::default()));
        let args_b = ssh::ssh_args_no_tty(
            &host,
            22,
            &user,
            None,
            &herdr::observe_command(&pane, 80, 20),
            None,
        );
        let _b = herdr_stream::spawn(
            "matrix-re-open-2",
            "matrix",
            &ssh::ssh_exe(),
            &args_b,
            collector(rec_b.clone()),
            Arc::new(LogRegistry::new()),
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
        );
        let _ = wait_bytes(&rec_b, 8000);
        let (ba, bb) = {
            let a = rec_a.lock().unwrap();
            let b = rec_b.lock().unwrap();
            (a.bytes, b.bytes)
        };
        check!(
            "观察流按新尺寸重开时两条都能拿到画面（模拟拖动窗口）",
            ba > 0 && bb > 0,
            format!("100x28 → {ba} 字节；80x20 → {bb} 字节")
        );
    }

    // ---------- 9d) 冷启动：herdr 服务器没在跑时（服务器刚重启那种） ----------
    //
    // 为什么用"另一个 session 名"来测：默认 session 的服务器**正是用户在用的**，
    // 停掉它会把用户的工作区一起关掉（我不做这种有副作用的验证）。
    // 命名 session 是完全独立的运行空间，可以安全地"先确认没服务器、再起一个、再建工作区"。
    {
        // 1) 默认 session 的状态检测（我们那条 ENSURE_SERVER 就是靠它判断的）
        let st = ssh_run(&host, &user, "herdr status server 2>&1 | head -1");
        check!(
            "能判断「服务器在不在跑」（我们是按 status: running 这一行判的）",
            st.contains("status:"),
            st.trim().to_string()
        );

        let sname = format!("zeeai-mat-{}", std::process::id());
        // 2) 这个 session 还没有服务器 → 应当明确报 server_not_running（而不是静默）
        let before = ssh_run(
            &host,
            &user,
            &format!("herdr --session '{sname}' workspace create 2>&1 | head -c 200"),
        );
        check!(
            "没有服务器时，herdr 会明确报 server_not_running",
            before.contains("server_not_running") || before.contains("\"error\""),
            before.trim().chars().take(120).collect::<String>()
        );
        // 3) 用和应用同一套办法起服务器（setsid + 后台 + 重定向）→ 之后建工作区应当成功
        let _ = ssh_run(
            &host,
            &user,
            &format!(
                "if command -v setsid >/dev/null 2>&1; then setsid herdr --session '{sname}' server </dev/null >/dev/null 2>&1 & else nohup herdr --session '{sname}' server </dev/null >/dev/null 2>&1 & fi; sleep 2; printf ok"
            ),
        );
        let after = ssh_run(
            &host,
            &user,
            &format!("herdr --session '{sname}' workspace create 2>&1 | head -c 200"),
        );
        check!(
            "自己把服务器起起来之后，新建工作区就成功了（重启后我们也能自愈）",
            after.contains("\"pane_id\""),
            after.trim().chars().take(120).collect::<String>()
        );
        // 4) 收尾：关工作区 + 停服务器 + 删 session
        let _ = ssh_run(
            &host,
            &user,
            &format!(
                "W=$(herdr --session '{sname}' pane list 2>/dev/null | tr ',' '\\n' | sed -n 's/.*\"pane_id\":\"\\([^\"]*\\)\".*/\\1/p' | head -1); \
[ -n \"$W\" ] && herdr --session '{sname}' workspace close \"$(printf '%s' \"$W\" | cut -d: -f1)\" >/dev/null 2>&1; \
herdr --session '{sname}' server stop >/dev/null 2>&1; herdr session delete '{sname}' >/dev/null 2>&1; printf 'cleaned\\n'"
            ),
        );
        let left = ssh_run(&host, &user, &format!("herdr session list 2>&1 | grep -c '{sname}'"));
        check!(
            "临时 herdr session 已清理",
            left.trim().ends_with('0'),
            format!("剩余匹配={}", left.trim())
        );
    }

    // ---------- 10) 窗格不存在时：必须报错（而不是静默黑屏） ----------
    {
        let rec4 = Arc::new(Mutex::new(Recorder::default()));
        let bad_cmd = herdr::control_command("w9999:p1", 80, 20, true);
        let bad_args = ssh::ssh_args_no_tty(&host, 22, &user, None, &bad_cmd, None);
        let _bad = herdr_stream::spawn(
            "matrix-bad",
            "matrix",
            &ssh::ssh_exe(),
            &bad_args,
            collector(rec4.clone()),
            Arc::new(LogRegistry::new()),
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
        );
        let _ = wait_any(&rec4, 8000);
        let g = rec4.lock().unwrap();
        check!(
            "窗格不存在时给出人话 + 退回普通 shell（不会静默黑屏）",
            g.text.contains("已经没有窗格")
                && g.text.contains("现在还在的窗格")
                && g.bytes > 0,
            format!(
                "{} 字节；文本={:?} 告警={:?}",
                g.bytes,
                g.text.trim().chars().take(90).collect::<String>(),
                g.errors
            )
        );
    }

    // ---------- 10b) 工作区/窗格扫描：清理功能就是靠它判断"空壳"的 ----------
    {
        let raw = ssh_run(&host, &user, &herdr::workspace_scan_command());
        let scan = herdr::parse_workspace_scan(&raw);
        let mine = scan.panes.iter().find(|p| p.pane_id == pane);
        check!(
            "扫描能列出工作区（含我们刚建的这个）",
            scan.workspaces.contains(&ws),
            format!("工作区={:?}", scan.workspaces)
        );
        check!(
            "扫描能拿到每个窗格的前台进程名（用来分辨空壳 / 正在跑）",
            mine.is_some() && !mine.unwrap().proc_name.is_empty(),
            format!("{:?}", mine)
        );
    }

    // ---------- 10c) 清理：关掉空壳工作区，数量要回落（前端「清理空壳」走的就是它） ----------
    {
        let before = herdr::parse_workspace_scan(&ssh_run(
            &host,
            &user,
            &herdr::workspace_scan_command(),
        ))
        .workspaces
        .len();
        // 再建一个临时工作区（就是"每开一次 herdr 会话会多出来的那个"）
        let made = ssh_run(&host, &user, &herdr::create_workspace_command());
        let made_pane = herdr::pane_from_create(&made).unwrap_or_default();
        let made_ws = made_pane.split(':').next().unwrap_or("").to_string();
        let mid = herdr::parse_workspace_scan(&ssh_run(
            &host,
            &user,
            &herdr::workspace_scan_command(),
        ))
        .workspaces
        .len();
        // 关掉它（这一步就是界面上那句「确认清理」）
        let closed = ssh_run(&host, &user, &herdr::close_workspace_command(&made_ws));
        let after = herdr::parse_workspace_scan(&ssh_run(
            &host,
            &user,
            &herdr::workspace_scan_command(),
        ))
        .workspaces
        .len();
        check!(
            "新建会多一个工作区、清理之后再回落（生命周期闭环）",
            mid == before + 1 && after == before,
            format!("{before} → 建后 {mid} → 清理后 {after}（close 回显={:?}）", closed.trim())
        );
        check!(
            "被清理的工作区真的从服务器上消失",
            !herdr::parse_workspace_scan(&ssh_run(&host, &user, &herdr::workspace_scan_command()))
                .workspaces
                .contains(&made_ws),
            format!("关掉的是 {made_ws}")
        );
    }

    // ---------- 11) 关掉窗格 → 流应当结束（前端会收到"已关闭"） ----------
    {
        let rec5 = Arc::new(Mutex::new(Recorder::default()));
        let cmd2 = herdr::control_command(&pane, 90, 24, true);
        let args2 = ssh::ssh_args_no_tty(&host, 22, &user, None, &cmd2, None);
        let _c5 = herdr_stream::spawn(
            "matrix-close",
            "matrix",
            &ssh::ssh_exe(),
            &args2,
            collector(rec5.clone()),
            Arc::new(LogRegistry::new()),
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
        );
        let _ = wait_bytes(&rec5, 8000);
        let _ = ssh_run(&host, &user, &format!("herdr workspace close '{ws}'"));
        // 关掉之后要等"流结束/收到告警"，同样是轮询而不是固定睡
        let step = 250u64;
        let mut waited = 0u64;
        while waited < 8000 {
            if rec5.lock().unwrap().closed || !rec5.lock().unwrap().errors.is_empty() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(step));
            waited += step;
        }
        let g = rec5.lock().unwrap();
        check!(
            "窗格被关掉后，流结束（或给出告警）",
            g.closed || !g.errors.is_empty(),
            format!("closed={} errors={:?}", g.closed, g.errors)
        );
    }

    // ---------- 收尾：确保临时工作区都关掉 ----------
    let _ = ssh_run(&host, &user, &format!("herdr workspace close '{ws}'"));
    let left = ssh_run(&host, &user, "herdr pane list");
    check!(
        "临时窗格已清理干净",
        !left.contains(&pane),
        format!("剩余 pane 数={}", left.matches("\"pane_id\"").count())
    );

    println!("\n== 结果：{pass} 通过 / {fail} 失败 ==");
    // 收尾：把我们这次新起的 ssh 全收掉（不碰用户自己的）
    kill_new_ssh(&ssh_before);
    // 再扫一次：有的 ssh 是"命令跑完了但进程还没退干净"，差一点就会被漏掉
    std::thread::sleep(std::time::Duration::from_millis(800));
    kill_new_ssh(&ssh_before);
    let _ = Ordering::Relaxed;
    let _ = AtomicUsize::new(0);
    std::process::exit(if fail > 0 { 1 } else { 0 });
}
