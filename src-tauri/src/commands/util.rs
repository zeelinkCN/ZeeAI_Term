//! commands 层的共享工具：隐藏窗口跑命令、SSH 一次性调用、传输事件、
//! 下载 / sha256 / 代理 / 小工具。
//!
//! 为什么集中在这里：多个子模块都要“跑外部程序 + 收口错误”，各写一份迟早会漏掉
//! CREATE_NO_WINDOW 或 Job Object；放在 util 也让子模块之间不需要互相 `use` 成环。
use serde::Serialize;

use crate::core::{proc, ssh, SessionEvent};

/// herdr 的 stderr 是原样透到状态栏的（core::herdr_stream 的设计）。
/// 在 commands 这一层统一收口，保证 SSH / herdr 的英文报错也不会裸奔。
pub(super) fn friendly_herdr_event(event: SessionEvent) -> SessionEvent {
    match event {
        SessionEvent::Error { message } => SessionEvent::Error {
            message: ssh::friendly_ssh_error_context("herdr 连接错误", &message),
        },
        other => other,
    }
}

/// 跑一个外部命令，返回 **(是否成功, 输出)**（隐藏控制台窗口）。
///
/// ⚠️ **返回 `(bool, String)` 而不是 `Ok(String)`**（架构审查 minor-10）：
/// 以前失败时也返回 `Ok`，只是把 stderr 拼进正文 —— 调用方（远端探测 / 版本查询 /
/// 设备列表）很容易把一句报错当成数据去解析，界面上就变成"看起来正常、其实什么都没拿到"。
/// 现在成败必须显式处理：只关心数据的调用方用 [`capture_text`]（失败直接变中文 Err）。
///
/// **一次性进程必须能跟着未来被杀掉**（`kill_on_drop(true)` + 挂 Job Object）：
///
/// 这些一次性 ssh 是在 `run_remote_capture` 的 20 秒超时里跑的；超时一到，tokio 只会
/// **丢掉这个 future**，而 `Command::output()` 内部那个子进程**不会**被自动杀掉 ——
/// 于是一次超时就漏一个 ssh 进程。实测在用户机器上攒了 **41 个**残留 ssh：
/// 它们一直挂在服务器上占着连接，最后把 sshd 拖到"新连接被排队/丢弃"，
/// 表现就是**点「新建 herdr 窗格」一直卡着**（用户截图那次）。
pub(super) async fn run_capture(
    program: &std::path::Path,
    args: &[String],
) -> Result<(bool, String), String> {
    // 统一收口：带 CREATE_NO_WINDOW，一次性 ssh/git 不闪控制台（见 core/proc.rs）
    let mut cmd = proc::hidden_command_async(program);
    cmd.args(args);
    cmd.kill_on_drop(true);
    // ★ 见上：spawn + wait_with_output 不会自动接管，必须显式 pipe，
    //   否则"远端明明回了内容，我们却收到空串"（这个回归我踩过：herdr 探测一直显示没装）。
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    cmd.stdin(std::process::Stdio::null());
    let child = cmd.spawn().map_err(|e| format!("执行命令失败: {e}"))?;
    // 挂进 Job Object：App 退出/被强杀时不会留下孤儿 ssh
    if let Some(pid) = child.id() {
        crate::core::job::assign(pid);
    }
    let output = child
        .wait_with_output()
        .await
        .map_err(|e| format!("等待命令失败: {e}"))?;
    let mut text = String::from_utf8_lossy(&output.stdout).to_string();
    if !output.status.success() {
        text.push_str(&String::from_utf8_lossy(&output.stderr));
    }
    Ok((output.status.success(), text))
}

/// [`run_capture`] 的"我只要输出"版本：失败就把命令原话当**中文错误**抛出去。
///
/// 用于版本号 / 设备列表 / 远端读取这类"拿到的文本一定是数据"的地方。
pub(super) async fn capture_text(
    program: &std::path::Path,
    args: &[String],
    what: &str,
) -> Result<String, String> {
    let (ok, text) = run_capture(program, args).await?;
    if ok {
        return Ok(text);
    }
    let msg = text.trim().to_string();
    Err(if msg.is_empty() {
        format!("{what}失败（没有更多错误信息）")
    } else {
        format!("{what}失败：{msg}")
    })
}

/// 传输进度事件：前端拿它画进度条
#[derive(Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum TransferEvent {
    /// 开始处理某个文件
    Start { task: String, name: String, total: u64 },
    /// 传输中
    Progress {
        task: String,
        name: String,
        done: u64,
        total: u64,
    },
    /// 某个文件完成
    FileDone { task: String, name: String, bytes: u64 },
    /// 某个文件失败
    FileFailed {
        task: String,
        name: String,
        message: String,
    },
    /// 整批完成
    AllDone {
        task: String,
        ok: usize,
        failed: usize,
    },
}

/// 把传输/下载进度推给前端（右下角进度面板监听 `zeeai://transfer`）。
pub(super) fn emit_transfer(app: &tauri::AppHandle, ev: TransferEvent) {
    use tauri::Emitter;
    let _ = app.emit("zeeai://transfer", ev);
}

pub(super) fn human_size(n: u64) -> String {
    const UNITS: [&str; 4] = ["B", "KB", "MB", "GB"];
    let mut v = n as f64;
    let mut i = 0;
    while v >= 1024.0 && i < UNITS.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    if i == 0 {
        format!("{n} B")
    } else {
        format!("{v:.1} {}", UNITS[i])
    }
}

/// 读 Windows「Internet 选项」里的代理设置。
///
/// 为什么需要：很多用户是靠 Clash / v2ray 这类本地代理访问 GitHub 的，而 `curl.exe`
/// **不会**自动读这些设置，不显式告诉它就会走直连 —— 直连 GitHub 的下载 CDN 在国内
/// 经常慢到几乎下不动。这里用 `reg query` 读一下（不引任何新依赖），有代理就带上。
pub(super) fn system_proxy() -> Option<String> {
    const KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings";
    let enable = reg_value(KEY, "ProxyEnable")?;
    // 0x0 = 关，0x1 = 开
    let flag = enable.trim().to_ascii_lowercase();
    if !(flag.ends_with("0x1") || flag == "1") {
        return None;
    }
    let server = reg_value(KEY, "ProxyServer")?;
    let server = server.trim();
    if server.is_empty() {
        return None;
    }
    // 可能是 "127.0.0.1:7897"，也可能是 "http=127.0.0.1:7897;https=..." 这种分协议写法
    let host_port = server
        .split(';')
        .find_map(|part| {
            let p = part.trim();
            if let Some(rest) = p.strip_prefix("https=") {
                Some(rest.to_string())
            } else if let Some(rest) = p.strip_prefix("http=") {
                Some(rest.to_string())
            } else if !p.contains('=') {
                Some(p.to_string())
            } else {
                None
            }
        })?;
    let url = if host_port.starts_with("http://") || host_port.starts_with("https://") {
        host_port
    } else {
        format!("http://{host_port}")
    };
    log::info!("update: 检测到系统代理 {url}，下载时一并使用");
    Some(url)
}

/// `reg query <key> /v <name>` 取最后一个字段（值）
///
/// 后台查询，统一走 `proc::hidden_command`（否则注册表探测会闪控制台）。
pub(super) fn reg_value(key: &str, name: &str) -> Option<String> {
    let out = proc::hidden_command("reg")
        .args(["query", key, "/v", name])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    for line in text.lines() {
        if line.contains(name) {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if let Some(last) = parts.last() {
                return Some((*last).to_string());
            }
        }
    }
    None
}

/// 这个程序在不在 PATH 上（用系统自带的 `where`，不引任何库）。
///
/// 用它的场景：用户点了「PowerShell 7」但我们本机没装 `pwsh.exe` —— 那种情况下
/// ConPTY 只会甩一句 "spawn failed"，不如提前说清"你没装 PowerShell 7"。
pub(super) fn program_on_path(name: &str) -> bool {
    // 后台查询，统一走 `proc::hidden_command_quiet`（stdout/stderr 也丢掉，不闪控制台）
    proc::hidden_command_quiet("where")
        .arg(name)
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// 找系统的 curl.exe：先看 System32，再看 PATH。
pub(super) fn find_curl() -> Option<std::path::PathBuf> {
    if let Ok(sys) = std::env::var("SystemRoot") {
        let p = std::path::Path::new(&sys).join("System32").join("curl.exe");
        if p.exists() {
            return Some(p);
        }
    }
    Some(std::path::PathBuf::from("curl.exe"))
}

/// 调一次 curl：**整包一次下完**（不分片），可选从已有字节续传，支持代理。
///
/// 三条都是 0.1.5 事故留下的教训：
/// - **带超时**：连不上 15 秒、或 60 秒内平均速率低于 2KB/s 就判失败去重试，
///   顺序挂在这里等死（0.1.5 那个僵尸 curl 就是这么来的）；
/// - **stderr 写文件不写管道**：管道没人读、写满之后双方互等 = 死锁；
/// - **挂进 Job Object**：App 退出/被强杀时 curl 跟着被收掉，不留孤儿进程。
///   （注意：升级**辅助脚本**不能挂 Job，原因见 [`update_download_install`]。）
///
/// `resume = true` 时带 `-C -`：从 `dest` 已有的大小接着下。配合 `--retry`，
/// 同一个 curl 进程内部的重连也是接着下，而不是把已经下好的几 MB 再传一遍。
/// 进度靠轮询文件大小（整包下载也能有进度条）。
pub(super) fn run_curl_download(
    curl: &std::path::Path,
    url: &str,
    dest: &std::path::Path,
    expected_size: u64,
    proxy: Option<&str>,
    resume: bool,
    on_progress: &mut impl FnMut(u64, u64),
) -> Result<(), String> {
    let mut err_path = dest.as_os_str().to_os_string();
    err_path.push(".stderr");
    let err_path = std::path::PathBuf::from(err_path);
    // 不续传才清空目标文件；续传时留着，curl 从它的长度往后接着要
    let have = if resume {
        std::fs::metadata(dest).map(|m| m.len()).unwrap_or(0)
    } else {
        let _ = std::fs::remove_file(dest);
        0
    };
    let _ = std::fs::remove_file(&err_path);

    let mut cmd = proc::hidden_command(curl);
    cmd.arg("-L")
        .arg("--fail")
        .arg("--silent")
        .arg("--show-error")
        .arg("--connect-timeout")
        .arg("15")
        .arg("--speed-limit")
        .arg("2048")
        .arg("--speed-time")
        .arg("60")
        .arg("--max-time")
        .arg("3600")
        .arg("--retry")
        .arg("5")
        .arg("--retry-delay")
        .arg("2")
        .arg("--retry-all-errors");
    if have > 0 {
        // 已经有一部分了：从断点接着下（没有这部分时加不加都一样，curl 会从 0 开始）
        cmd.arg("-C").arg("-");
    }
    if let Some(p) = proxy {
        cmd.arg("--proxy").arg(p);
    }
    cmd.arg("--stderr").arg(&err_path);
    cmd.arg("-o").arg(dest);
    cmd.arg(url);
    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(std::process::Stdio::null());
    cmd.stderr(std::process::Stdio::null());

    on_progress(have, expected_size.max(have));
    let mut child = cmd.spawn().map_err(|e| format!("启动 curl 失败: {e}"))?;
    crate::core::job::assign(child.id());
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break st,
            Ok(None) => {
                let done = std::fs::metadata(dest).map(|m| m.len()).unwrap_or(0);
                on_progress(done, expected_size.max(done));
                std::thread::sleep(std::time::Duration::from_millis(400));
            }
            Err(e) => return Err(format!("等待 curl 失败: {e}")),
        }
    };
    let done = std::fs::metadata(dest).map(|m| m.len()).unwrap_or(0);
    on_progress(done, expected_size.max(done));
    if status.success() {
        return Ok(());
    }
    let msg = std::fs::read_to_string(&err_path).unwrap_or_default();
    let msg = msg.trim().to_string();
    Err(if msg.is_empty() {
        format!("curl 退出码 {:?}", status.code())
    } else {
        msg
    })
}

/// 算一个文件的 sha256（**进程内算，不调 PATH 上的 certutil**）。
///
/// 以前这里是 `certutil -hashfile`。两个问题（架构审查提的 PATH 劫持）：
/// 1. `certutil` 是按 PATH 解析的 —— 在 PATH 前面放一个假的 `certutil.exe` 就能让
///    "官方 sha256 校验"永远通过，而下一步就是**静默执行下载来的安装包**；
/// 2. 每算一次起一个子进程，还要把 9~14MB 再读一遍。
/// 实现见 [`crate::core::sha256`]（FIPS 180-4，单测对着官方向量钉死）。
pub(super) fn sha256_of(path: &std::path::Path) -> Result<String, String> {
    crate::core::sha256::file_digest(path)
}

/// 截断 sha256 用于界面展示：按 **char** 截断。
///
/// 不能写 `&s[..s.len().min(12)]` —— 那按字节切，遇到多字节 UTF-8（例如用户/来源里
/// 混进中文）会 panic。sha256 正常是 ASCII，但界面文案不该有这种隐雷。
pub(super) fn short_sha(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

#[cfg(test)]
mod capture_tests {
    use super::*;

    /// 架构审查 minor-10：`run_capture` 必须把**成/败**交出来，
    /// `capture_text` 必须把失败变成 Err —— 不能再让调用方把 stderr 当数据。
    #[tokio::test]
    async fn run_capture_reports_failure_instead_of_returning_ok() {
        let exe = std::path::Path::new("cmd");
        let ok_args = vec!["/C".to_string(), "echo hello".to_string()];
        let (ok, text) = run_capture(exe, &ok_args).await.expect("能起进程");
        assert!(ok, "成功的命令应该报 true：{text:?}");
        assert!(text.to_lowercase().contains("hello"), "{text:?}");

        let bad_args = vec![
            "/C".to_string(),
            "echo boom 1>&2 & exit 3".to_string(),
        ];
        let (ok, text) = run_capture(exe, &bad_args).await.expect("能起进程");
        assert!(!ok, "非零退出必须报 false（以前这里是 Ok）");
        assert!(text.contains("boom"), "失败时 stderr 要带在文本里：{text:?}");

        // 只要数据的调用方：失败直接是中文 Err，且保留原话
        let err = capture_text(exe, &bad_args, "测试命令")
            .await
            .expect_err("失败必须变成 Err");
        assert!(err.starts_with("测试命令失败"), "{err}");
        assert!(err.contains("boom"), "原始信息要留着：{err}");

        // 成功路径原样返回正文
        let out = capture_text(exe, &ok_args, "测试命令").await.unwrap();
        assert!(out.to_lowercase().contains("hello"), "{out:?}");
    }
}

#[cfg(test)]
mod ssh_error_tests {
    use super::*;

    /// herdr stderr 原样送到 commands 的 sink，这里必须收口成中文分类 + 原始信息；
    /// 普通数据/状态事件不能被改动。
    #[test]
    fn herdr_error_events_are_classified_without_stray_dash() {
        let event = friendly_herdr_event(SessionEvent::Error {
            message: "No common Kex algorithm - ours: [curve25519], theirs: []".into(),
        });
        match event {
            SessionEvent::Error { message } => {
                assert!(message.contains("算法不匹配"), "{message}");
                assert!(message.contains("｜原始信息："), "{message}");
                assert!(!message.contains(" - "), "{message}");
            }
            _ => panic!("Error 事件被改成了别的类型"),
        }

        let data = friendly_herdr_event(SessionEvent::Data {
            data: "aGVsbG8=".into(),
            seq: None,
        });
        match data {
            SessionEvent::Data { data, seq } => {
                assert_eq!(data, "aGVsbG8=");
                assert_eq!(seq, None);
            }
            _ => panic!("Data 事件不该被改动"),
        }
    }
}


#[cfg(test)]
mod security_tests {
    use super::*;

    /// L1：按 char 截断，不能因为多字节 UTF-8 而 panic
    #[test]
    fn short_sha_never_panics_on_multibyte() {
        assert_eq!(short_sha("abcdef0123456789", 12), "abcdef012345");
        assert_eq!(short_sha("中文指纹abcdef", 4), "中文指纹");
        // 长度不足时原样返回
        assert_eq!(short_sha("短", 12), "短");
        // 关键：多字节字符跨越第 12 个字节时，按字节切片会 panic，这里必须安全
        let _ = short_sha("中文中文中文中文中文", 12);
    }
}
