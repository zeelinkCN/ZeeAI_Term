//! 一键升级：版本结果 / 安装类型 / 下载校验 / 拉起升级辅助进程。
//!
//! 可复用的下载、sha256、代理探测放在 `util.rs`（herdr 安装也走同一套），
//! 这里只保留“升级这条业务链”的判定和状态机。
use crate::core::proc;

use super::util::{
    emit_transfer, find_curl, run_curl_download, sha256_of, system_proxy,
    TransferEvent,
};

/// 允许自动下载安装的**唯一来源**前缀（本项目自己的 Release）。
///
/// 「不要下错」这条要求的底线：只有这个前缀下的地址才允许走"下载并静默执行"这条链路。
const UPDATE_REPO_PREFIX: &str = "https://github.com/zeelinkCN/ZeeAI_Term/releases/download/";

/// 当前这份是怎么装上的：`nsis` / `msi` / `portable`。
///
/// - `nsis`：我们的 NSIS 安装包按当前用户装到 `%LOCALAPPDATA%\ZeeAI_Term\`，
///   可以用 `/S`（静默）+ `/R`（装完自动重启）一键覆盖；
/// - `msi`：WiX 的 MSI 是 perMachine，装在 `%ProgramFiles%\ZeeAI_Term\`，
///   没有 `/S /R` 这种开关，只能走 `msiexec /i <msi> /qb /norestart`（会弹一次 UAC）；
/// - `portable`：解压在任意目录，只能手动替换文件。
#[tauri::command]
pub fn update_install_kind() -> String {
    let Ok(exe) = std::env::current_exe() else {
        return "portable".into();
    };
    let exe_l = exe.to_string_lossy().to_lowercase();
    let under = |base: String| -> bool {
        let base = base.to_lowercase();
        let base = base.trim_end_matches('\\');
        !base.is_empty() && exe_l.starts_with(&format!("{base}\\zeeai_term\\"))
    };
    let kind = if under(std::env::var("LOCALAPPDATA").unwrap_or_default()) {
        "nsis"
    } else if under(std::env::var("ProgramFiles").unwrap_or_default())
        || under(std::env::var("ProgramFiles(x86)").unwrap_or_default())
    {
        "msi"
    } else {
        "portable"
    };
    log::info!("ipc: update_install_kind -> {kind} ({exe_l})");
    kind.to_string()
}

/// 上一次「一键升级」的结果（安装器退出码 / 失败原因）。
///
/// 升级脚本会把 `installer exit=…` 写进 `%TEMP%\ZeeAI-Term-update\apply_update.log`，
/// 这里读一次就删掉，前端拿它在状态栏提示一行（不弹浮层）。
/// 0.1.5 的教训：升级失败时用户什么都看不到，只能干等。
#[tauri::command]
pub fn update_take_result() -> Option<String> {
    let path = std::env::temp_dir()
        .join("ZeeAI-Term-update")
        .join("apply_update.log");
    let text = std::fs::read_to_string(&path).ok()?;
    let _ = std::fs::remove_file(&path);
    let t = text.trim().to_string();
    if t.is_empty() {
        None
    } else {
        log::info!("ipc: update_take_result -> {t}");
        Some(t)
    }
}

/// 下载新版安装包并做校验（大小 + 文件头 + 官方 sha256），返回落盘路径。
///
/// 为什么要绕这么一圈：
/// - **不用第三方 HTTP 库**：直接用 Windows 自带的 `curl.exe`（Win10 1803+ 内置，
///   走系统 Schannel），不往程序里塞一整套 TLS 栈，exe 体积不变；
/// - **单请求整包下载**：0.1.5 试过"按 1MB 分段发 Range 请求接着下"，结果并发写同一个
///   文件把包写坏了（那次事故见 `docs/decisions.md`），所以现在是**一次请求下完整个包**；
///   但失败不会永远从 0 重来 —— `.part` 留着，下一次（包括重启应用之后）用 `curl -C -`
///   从已有字节接着下。注意这是**单请求续传**，不是分片并发写；
/// - **抽成独立函数**：`examples/update_spike.rs` 可以拿真实 Release 地址直接验证。
///
/// 最多试三次，每次策略不同：① 有系统代理先用代理（带续传）；② 去掉代理走直连（带续传）；
/// ③ 丢掉 `.part` 从 0 来一遍。**只有网络层失败才保留 `.part`** —— 校验不过说明内容本身
/// 有问题，续传只会把坏内容续成"完整的坏包"，直接丢弃。
pub fn fetch_update_package(
    url: &str,
    expected_size: u64,
    expected_sha: Option<&str>,
    ext: &str,
    version: &str,
    mut on_progress: impl FnMut(u64, u64),
) -> Result<std::path::PathBuf, String> {
    let curl = find_curl().ok_or_else(|| {
        "找不到系统自带的 curl.exe（Windows 10 1803 以上都自带），请改用手动下载".to_string()
    })?;
    let dir = std::env::temp_dir().join("ZeeAI-Term-update");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建下载目录失败: {e}"))?;
    let safe_version: String = version
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' { c } else { '_' })
        .collect();
    let dest = dir.join(format!("ZeeAI_Term_{safe_version}_setup.{ext}"));
    // 临时名：校验全过之前，这个文件永远不算"下好了"
    let part = dir.join(format!("ZeeAI_Term_{safe_version}_setup.{ext}.part"));
    // 顺手清掉**别的版本**留下的残留（每个包 9~14MB，不清会一直堆在 %TEMP% 里）
    sweep_update_dir(&dir, &[&dest, &part]);
    // 有系统代理就先用代理试（国内直连 GitHub 的下载 CDN 经常慢到几乎不动），
    // 第二次改成直连，避免"代理开着但其实没启动"时彻底下不来。
    let proxy = system_proxy();

    // 上一次（甚至上一次开应用时）留下的半截文件：能续就续，别再从头下一遍
    let leftover = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0) > 0;
    let plans: [(bool, bool); 3] = [
        (proxy.is_some(), leftover),
        (false, leftover),
        (false, false),
    ];

    let mut last_err = String::new();
    for (step, (use_proxy, resume)) in plans.into_iter().enumerate() {
        let attempt = step + 1;
        let use_proxy = if use_proxy { proxy.as_deref() } else { None };
        log::info!(
            "update: 第 {attempt} 次整包下载 {url}（proxy={use_proxy:?}，续传={resume}，期望 {expected_size} 字节）"
        );
        match run_curl_download(
            &curl,
            url,
            &part,
            expected_size,
            use_proxy,
            resume,
            &mut on_progress,
        ) {
            // 网络层失败（断流 / 超时）：`.part` 留着，下一次接着下
            Err(e) => last_err = e,
            Ok(()) => match package_problem(&part, ext, expected_size, expected_sha) {
                None => {
                    // 校验全过 → 原子改名成正式包
                    let _ = std::fs::remove_file(&dest);
                    std::fs::rename(&part, &dest).map_err(|e| format!("重命名更新包失败: {e}"))?;
                    let done = std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
                    on_progress(done, done);
                    log::info!("update: 更新包已下好并校验通过 {}", dest.display());
                    return Ok(dest);
                }
                // 内容本身不对（大小不符 / 文件头不对 / sha256 对不上）：留下只会续成坏包
                Some(why) => {
                    last_err = why;
                    let _ = std::fs::remove_file(&part);
                }
            },
        }
        log::warn!("update: 第 {attempt} 次下载/校验没过：{last_err}");
        // 文件已经"下满"却仍然失败（例如续传时本地文件本来就完整、服务器回 416），
        // 说明这半截文件不可信：丢掉，让下一次从 0 来
        let size = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
        if expected_size > 0 && size >= expected_size {
            let _ = std::fs::remove_file(&part);
        }
        if attempt < 3 {
            std::thread::sleep(std::time::Duration::from_millis(if attempt == 1 { 1500 } else { 500 }));
        }
    }
    Err(format!("更新包下载或校验失败（已自动重试两次）：{last_err}"))
}

/// 清掉下载目录里**别的版本**留下的残留（安装包、半截的 `.part`、curl 的 `.stderr`）。
///
/// 为什么需要：老的升级脚本只在**失败**时删包，成功就直接结束 —— 每升一次就在 `%TEMP%`
/// 留一份 9.15MB（NSIS）/ 14.08MB（MSI），升十个版本就是上百 MB，而且不在"磁盘清理"的
/// 常规视野里。现在 [`crate::core::update`] 成功/失败都会删包，这里再兜一层：
/// 万一用户升级到一半把应用杀了、辅助进程没跑完，下次下载时也顺手收干净。
///
/// `keep` 里的路径（本次要用的正式名和临时名）不动；只删我们自己命名的文件，
/// 不碰用户可能放在同一个目录里的别的东西。
fn sweep_update_dir(dir: &std::path::Path, keep: &[&std::path::Path]) {
    let Ok(read) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in read.flatten() {
        let path = entry.path();
        if keep.iter().any(|k| path == **k) {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        // 只删我们自己命名的下载产物；**别碰 `apply_update.cmd`**
        // （正在跑的批处理被删掉会中途断）
        let mine = name.starts_with("ZeeAI_Term_") || name.ends_with(".stderr");
        if mine && path.is_file() {
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// 文件头对不对（exe = PE 的 MZ；msi = OLE 复合文档 D0CF11E0）
fn header_ok(path: &std::path::Path, ext: &str) -> bool {
    use std::io::Read;
    let mut head = [0u8; 4];
    match std::fs::File::open(path) {
        Ok(mut f) => {
            if f.read_exact(&mut head).is_err() {
                false
            } else if ext == "msi" {
                head == [0xD0, 0xCF, 0x11, 0xE0]
            } else {
                &head[..2] == b"MZ"
            }
        }
        Err(_) => false,
    }
}

/// 校验下好的包：没问题返回 None，有问题返回原因。
///
/// - 大小必须和 Release 标注一致（防半截）；
/// - 文件头必须是 PE / OLE（防下成 HTML 错误页、别的产物）；
/// - 官方给了 sha256（GitHub Release API 的 `digest`）就必须一模一样 ——
///   0.1.5 那次"大小对、内容错位"就是靠这一条能当场抓住。
fn package_problem(
    path: &std::path::Path,
    ext: &str,
    expected_size: u64,
    expected_sha: Option<&str>,
) -> Option<String> {
    let actual = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    if expected_size > 0 && actual != expected_size {
        return Some(format!(
            "大小不符（下载 {actual} 字节，官方 {expected_size} 字节）"
        ));
    }
    if !header_ok(path, ext) {
        return Some("文件头不对（不是有效的安装程序）".to_string());
    }
    if let Some(want) = expected_sha.map(str::trim).filter(|s| !s.is_empty()) {
        let want = want
            .strip_prefix("sha256:")
            .unwrap_or(want)
            .to_ascii_lowercase();
        if want.len() != 64 || !want.chars().all(|c| c.is_ascii_hexdigit()) {
            return Some(format!("官方给的 sha256 格式不对：{want}"));
        }
        match sha256_of(path) {
            Ok(got) if got == want => {}
            Ok(got) => return Some(format!("sha256 对不上（下载 {got}，官方 {want}）")),
            Err(e) => return Some(e),
        }
    }
    None
}

/// 下载新版安装包，校验后静默覆盖安装并自动重启应用。
///
/// 几点设计说明：
/// - **只允许 GitHub Release 的下载地址**：这条命令本质上会执行一个下载来的安装包，
///   所以地址必须形如 `https://github.com/<owner>/<repo>/releases/download/...`，
///   避免它变成"任意 URL 下载并执行"的后门；
/// - **校验**：见 [`fetch_update_package`]（大小 + 文件头 + 官方 sha256）；
/// - **进度**：复用 `zeeai://transfer` 事件，右下角进度面板直接显示下载进度；
/// - **安装**：交给 `core::update` 的辅助进程（我们自己的 exe 的临时副本，argv 传参，
///   **没有 .cmd / 没有 shell**）。NSIS / MSI 都盖不住正在运行的 exe，所以还是"先退出再装"，
///   但等退出/安装/重启都由那个进程在 Rust 里做（以前是拼一个批处理 —— 路径里有
///   `&` `%` `!` `"` 就能执行任意命令）。
#[tauri::command]
pub async fn update_download_install(
    app: tauri::AppHandle,
    url: String,
    expected_size: u64,
    expected_sha: Option<String>,
    version: String,
) -> Result<String, String> {
    let u = url.trim().to_string();
    // 「不要下错」的第一道闸：**只认本项目自己的 Release**。
    // 以前只校验"是不是 github.com 的 release 下载地址"，等于任何仓库都放行；
    // 而校验用的 size / sha256 是渲染层传进来的（可以不传），一旦省掉就只剩"文件头是 MZ"，
    // 这条链路就能变成"下载并静默执行任意安装包"。所以这里把 owner/repo 钉死。
    if !u.starts_with(UPDATE_REPO_PREFIX) {
        return Err(format!(
            "更新地址不是本项目的 GitHub Release（只允许 {UPDATE_REPO_PREFIX}…），已拒绝执行"
        ));
    }
    if expected_size == 0 {
        // 没有官方字节数就没法判断"下没下全"，宁可拒绝也不装一个来路不明/半截的包
        return Err("缺少官方文件大小，无法校验更新包，已拒绝执行".into());
    }
    let kind = update_install_kind();
    if kind == "portable" {
        return Err("当前是便携版，无法自动覆盖升级：请下载压缩包解压替换（配置不会丢）".into());
    }
    log::info!(
        "ipc: update_download_install -> {u} (kind={kind}, expect {expected_size} bytes, sha={:?}, v{version})",
        expected_sha
    );

    let ext = if kind == "msi" { "msi" } else { "exe" };
    let task = "update".to_string();
    let name = if version.trim().is_empty() {
        format!("ZeeAI_Term 新版安装包 (.{ext})")
    } else {
        format!("ZeeAI_Term {version} 安装包 (.{ext})")
    };

    // 下载 + 校验（放到阻塞线程里跑，别卡住 async 运行时）
    let task_for_blocking = task.clone();
    let name_for_blocking = name.clone();
    let app_for_blocking = app.clone();
    let result = tokio::task::spawn_blocking(move || {
        fetch_update_package(
            &u,
            expected_size,
            expected_sha.as_deref(),
            ext,
            &version,
            |done, total| {
                if done == 0 {
                    emit_transfer(
                        &app_for_blocking,
                        TransferEvent::Start {
                            task: task_for_blocking.clone(),
                            name: name_for_blocking.clone(),
                            total,
                        },
                    );
                } else {
                    emit_transfer(
                        &app_for_blocking,
                        TransferEvent::Progress {
                            task: task_for_blocking.clone(),
                            name: name_for_blocking.clone(),
                            done,
                            total,
                        },
                    );
                }
            },
        )
    })
    .await
    .map_err(|e| format!("下载任务异常: {e}"))?;

    let dest = match result {
        Ok(p) => p,
        Err(e) => {
            emit_transfer(
                &app,
                TransferEvent::FileFailed {
                    task: task.clone(),
                    name: name.clone(),
                    message: e.clone(),
                },
            );
            return Err(e);
        }
    };
    let done = std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
    let dir = dest.parent().map(|p| p.to_path_buf()).unwrap_or_else(std::env::temp_dir);
    emit_transfer(
        &app,
        TransferEvent::FileDone {
            task: task.clone(),
            name: name.clone(),
            bytes: done,
        },
    );

    // ---- 拉起升级辅助进程：等本进程退出后再装，装完把应用拉起来 ----
    //
    // **这里不再写 .cmd**（架构审查 minor-04）：那个批处理要把安装包路径插值进命令行，
    // 路径里有 `&` / `%VAR%` / `!` / `"` 时整条命令的语义就变了（可执行任意命令），
    // 而它偏偏发生在"退出前静默升级"这种用户不看屏幕的时刻。
    //
    // 现在换成我们自己的 exe：
    // 1. 拷一份到 %TEMP%\ZeeAI-Term-update\（原 exe 被运行中的进程锁着，装不了自己）；
    // 2. 用 argv 传参（安装包 / 父 pid / 应用 exe）→ 没有任何 shell 参与；
    // 3. 那个进程负责"等本进程退出 → 静默安装 → 看退出码 → 删包 → 兜底重启"。
    let exe_path = std::env::current_exe().map_err(|e| format!("取当前程序路径失败: {e}"))?;
    let helper = crate::core::update::prepare_helper(&dir)?;
    let pid = std::process::id();
    let helper_args = crate::core::update::helper_args(&dest, pid, &exe_path);
    // 辅助进程也是后台进程：统一走 proc::hidden_command_quiet（不闪黑框、输出丢掉；
    // 它自己会往 apply_update.log 写结果）
    let mut cmd = proc::hidden_command_quiet(&helper);
    cmd.args(&helper_args);
    cmd.current_dir(&dir);
    let child = cmd.spawn().map_err(|e| format!("启动升级辅助进程失败: {e}"))?;
    log::info!(
        "update: 升级辅助进程已启动 pid={}（包={}）",
        child.id(),
        dest.display()
    );
    // ★ 千万别把升级辅助进程挂进 Job Object。
    //
    // 这个 Job 带 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`（见 core/job.rs），App 一退出
    // 句柄关闭、job 里的进程全被杀。而辅助进程的**第一步就是等 App 退出** —— 两边一撞，
    // 它恰好在唯一需要活下去的那一刻被系统杀掉，安装器永远不会启动、日志也不会写，
    // 用户看到的就是「点了升级、应用关了、版本没变、也没有任何提示」（0.1.5 事故的真身）。
    //
    // 辅助进程自带 2 分钟等待上限 + 退出码检查 + 失败拉回旧版，本来就不需要跟 App 同生共死。
    // 真正需要挂 Job 的是 curl 和终端子进程（它们才怕变孤儿），那些照旧。

    // 给辅助进程一点时间就位，然后走正常退出路径（收干净会话进程）；重启由它/安装包负责
    let app_for_exit = app.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
        log::info!("update: 退出应用，交给升级辅助进程完成覆盖");
        app_for_exit.exit(0);
    });

    Ok(dest.to_string_lossy().to_string())
}

#[cfg(test)]
mod update_tests {
    use super::*;

    fn tmp(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join("zeeai-cmd-tests");
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(name)
    }

    #[test]
    fn package_problem_catches_short_wrong_and_mismatched_files() {
        let exe = tmp("pkg-check.exe");
        // 半截文件：大小不符
        std::fs::write(&exe, vec![b'M', b'Z', 0, 0]).unwrap();
        let p = package_problem(&exe, "exe", 1000, None).unwrap();
        assert!(p.contains("大小不符"), "{p}");

        // 大小对、文件头不对（比如下成了一个 HTML 错误页）
        std::fs::write(&exe, b"<html>404</html>").unwrap();
        let p = package_problem(&exe, "exe", 16, None).unwrap();
        assert!(p.contains("文件头不对"), "{p}");

        // 大小对、头也对，但 sha256 和官方给的差一位 → 必须拦住（0.1.5 就是这么坏的）
        let mut body = vec![b'M', b'Z'];
        body.extend(std::iter::repeat(0u8).take(14));
        std::fs::write(&exe, &body).unwrap();
        let good = sha256_of(&exe).unwrap();
        assert_eq!(package_problem(&exe, "exe", 16, Some(&good)), None);
        let mut bad = good.clone();
        bad.replace_range(0..1, if good.starts_with('a') { "b" } else { "a" });
        let p = package_problem(&exe, "exe", 16, Some(&format!("sha256:{bad}"))).unwrap();
        assert!(p.contains("sha256 对不上"), "{p}");
        let _ = std::fs::remove_file(&exe);
    }

    // 说明：原来的 `apply_update_script_has_bounded_wait_and_failure_feedback` 已删 ——
    // 升级不再生成 .cmd。等待上限 / 退出码判定 / 删包 / 兜底重启的断言现在在
    // `core::update` 的单测里（那里是真正执行的那段代码）。

    #[test]
    fn update_only_accepts_our_own_release_url() {
        // 本项目自己的 Release 地址要放行（大小 > 0 才行，这里只测前缀判定）
        assert!(UPDATE_REPO_PREFIX.ends_with("/releases/download/"));
        let ours = format!("{UPDATE_REPO_PREFIX}v0.1.8/ZeeAI_Term_0.1.8_x64-setup.exe");
        assert!(ours.starts_with(UPDATE_REPO_PREFIX));
        // 别的仓库（哪怕也是 GitHub Release）必须被拒
        let other = "https://github.com/someone/evil/releases/download/v1/x.exe";
        assert!(!other.starts_with(UPDATE_REPO_PREFIX));
    }

    #[test]
    fn sweep_update_dir_keeps_current_files_and_spares_the_helper_script() {
        let dir = std::env::temp_dir().join("zeeai-cmd-tests-sweep");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let keep = dir.join("ZeeAI_Term_0.1.9_setup.exe");
        let stale_exe = dir.join("ZeeAI_Term_0.1.8_setup.exe");
        let stale_part = dir.join("ZeeAI_Term_0.1.8_setup.exe.part");
        let stale_err = dir.join("ZeeAI_Term_0.1.8_setup.exe.part.stderr");
        // 上一次升级留下的辅助进程副本（16MB；不清就每升一次多一份）
        let stale_helper = dir.join(crate::core::update::HELPER_NAME);
        // 老版本留下的批处理（新版不再生成它；万一它还在跑，别删）
        let legacy_cmd = dir.join("apply_update.cmd");
        let user_file = dir.join("我的笔记.txt");
        for p in [
            &keep,
            &stale_exe,
            &stale_part,
            &stale_err,
            &stale_helper,
            &legacy_cmd,
            &user_file,
        ] {
            std::fs::write(p, b"x").unwrap();
        }

        sweep_update_dir(&dir, &[&keep]);

        assert!(keep.exists(), "本次要用的文件不能删");
        assert!(
            legacy_cmd.exists(),
            "老版本的升级批处理不能被清掉（它可能正在跑）"
        );
        assert!(user_file.exists(), "不是我们命名的文件不能动");
        assert!(!stale_exe.exists(), "别的版本的安装包应该清掉");
        assert!(!stale_part.exists(), "别的版本的半截文件应该清掉");
        assert!(!stale_err.exists(), "curl 的 stderr 应该清掉");
        assert!(
            !stale_helper.exists(),
            "上一次的升级辅助进程副本应该清掉（否则每升一次多 16MB）"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
