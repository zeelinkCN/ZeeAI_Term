// 验证「tmux 快捷操作」面板用到的那几条命令在真实服务器上成立。
//
// 只跑只读命令（tmux ls / list-windows），不会新建或关闭任何窗口。
//
// 用法：
//   cargo run --release --example tmux_spike -- <host> <user> [port] [session]

use zeeai_terminal_lib::core::{ssh, tmux};

fn run(args: &[String]) -> Result<String, String> {
    let out = std::process::Command::new("ssh")
        .args(args)
        .output()
        .map_err(|e| format!("启动 ssh 失败: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    if a.len() < 3 {
        eprintln!("用法: tmux_spike <host> <user> [port] [session]");
        std::process::exit(2);
    }
    let host = &a[1];
    let user = &a[2];
    let port: u16 = a.get(3).and_then(|p| p.parse().ok()).unwrap_or(22);
    let session = a.get(4).cloned();

    println!("== 1) 列会话：{}", tmux::list_remote_command());
    let args = ssh::ssh_exec_args(host, port, user, None, &tmux::list_remote_command(), None);
    match run(&args) {
        Ok(out) => {
            let sessions = tmux::parse_list(&out);
            println!("   解析到 {} 个 tmux 会话", sessions.len());
            for s in &sessions {
                println!("     - {}  窗口{}  已附加={}", s.name, s.windows, s.attached);
            }

            let target = session.clone().or_else(|| sessions.first().map(|s| s.name.clone()));
            if let Some(target) = target {
                let cmd = tmux::list_windows_command(&target);
                println!("== 2) 列窗口：{cmd}");
                let args = ssh::ssh_exec_args(host, port, user, None, &cmd, None);
                match run(&args) {
                    Ok(out) => {
                        let wins = tmux::parse_windows(&out);
                        println!("   解析到 {} 个窗口", wins.len());
                        for w in &wins {
                            println!(
                                "     - #{} {}  窗格{}  {}",
                                w.index,
                                w.name,
                                w.panes,
                                if w.active { "当前" } else { "" }
                            );
                        }
                    }
                    Err(e) => println!("   列窗口失败: {e}"),
                }
            } else {
                println!("   （服务器上没有 tmux 会话，跳过列窗口）");
            }
        }
        Err(e) => {
            println!("列会话失败: {e}");
            std::process::exit(1);
        }
    }

    println!("== 3) 面板按钮会生成的命令（仅展示，不执行）");
    for action in [
        "new-window",
        "split-h",
        "split-v",
        "zoom",
        "next-layout",
        "copy-mode",
        "detach",
    ] {
        if let Some(c) = tmux::action_command("main", action, None) {
            println!("   {action:14} -> {c}");
        }
    }
    if let Some(c) = tmux::action_command("main", "select-window", Some("2")) {
        println!("   select-window  -> {c}");
    }
    println!(
        "   非法动作 rm -rf / -> {}",
        match tmux::action_command("main", "rm -rf /", None) {
            Some(_) => "竟然通过了（有漏洞！）",
            None => "已拒绝",
        }
    );
    println!(
        "   非法窗口号 '2; rm -rf /' -> {}",
        match tmux::action_command("main", "select-window", Some("2; rm -rf /")) {
            Some(_) => "竟然通过了（有漏洞！）",
            None => "已拒绝",
        }
    );
}
