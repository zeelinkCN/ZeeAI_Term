//! 升级辅助进程：**没有 .cmd、没有 shell、没有路径插值**（架构审查 O-04）。
//!
//! 之前这条链路是：把安装包路径拼进一个 `apply_update.cmd`，再 `cmd /C` 跑它。
//! 那个做法有两个洞：
//! - **路径插值 = 执行任意命令**：批处理里 `&` 分割命令、`%VAR%` 会展开、`!` 在
//!   `setlocal enabledelayedexpansion` 下会展开、`"` 直接闭合引号。只要安装包所在路径
//!   （或资产名）里带上这些字符，`"更新"就变成了"执行别人指定的命令"`；
//! - 它发生在**退出前静默升级**这个最敏感的时机（用户正好不在看屏幕）。
//!
//! 现在的做法：**用我们自己的可执行文件**（拷一份到临时目录，见
//! [`prepare_helper`]）带隐藏参数运行：
//!
//! ```text
//! ZeeAI_Term_updater.exe --apply-update <安装包> <父进程 pid> <应用 exe>
//! ```
//!
//! - 参数是 argv 数组，没有 shell 参与 —— 路径里有什么字符都只是字符；
//! - 时序：等父进程退出（最多 [`PARENT_WAIT`]，超时就像老脚本的 `killit` 一样强杀）
//!   → 静默跑安装器（NSIS `/S /R`、MSI `msiexec /i … /qb /norestart AUTOLAUNCHAPP=1`）
//!   → 看退出码（0 / 3010 算成功）→ 删安装包 → 成功时兜底拉起应用、失败时把旧版拉回来；
//! - 结果照旧写 `%TEMP%\ZeeAI-Term-update\apply_update.log`（`commands::update_take_result`
//!   读它给用户一行提示）。
//!
//! 为什么要把自己**拷一份**再跑：Windows 上正在运行的 exe 映像文件会被锁住
//! （可读、可改名/删除，但**不能覆盖写入**），而升级恰恰要覆盖这个 exe ——
//! 如果辅助进程就是原路径那个 exe，安装器永远写不进去。拷到临时目录以后，
//! 原 exe 就自由了；辅助进程自己那份由下一次升级的 [`crate::commands`] 清理
//! （文件名同样以 `ZeeAI_Term_` 开头，`sweep_update_dir` 会收掉）。

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// 隐藏命令行开关（只有我们自己会传）
pub const APPLY_UPDATE_FLAG: &str = "--apply-update";
/// 等父进程退出最多这么久（和老脚本的 60 次 × 2 秒一致）
pub const PARENT_WAIT: Duration = Duration::from_secs(120);
/// 装完之后等应用自己起来的时间（NSIS `/R` / MSI AUTOLAUNCHAPP 生效需要几秒）
pub const RELAUNCH_WAIT: Duration = Duration::from_secs(10);
/// 辅助进程文件名（放在 `%TEMP%\ZeeAI-Term-update\` 下；以 `ZeeAI_Term_` 开头，
/// 这样 `sweep_update_dir` 下次会顺手把旧的副本清掉）
pub const HELPER_NAME: &str = "ZeeAI_Term_updater.exe";
/// 升级结果日志（`update_take_result` 读的就是它）
pub const LOG_NAME: &str = "apply_update.log";

/// 一次升级任务（辅助进程从自己的命令行解析出来）
#[derive(Clone, Debug, PartialEq)]
pub struct UpdateTask {
    /// 已经校验过的安装包
    pub package: PathBuf,
    /// 主程序 pid：等它退出再装
    pub parent_pid: u32,
    /// 装完/失败后要拉起的程序（**不是**辅助进程自己那份副本）
    pub app_exe: PathBuf,
}

/// 拼辅助进程的命令行（argv 数组，**不拼字符串**）。
///
/// 这就是修复的核心：不管 `package` 里有 `&`、`%`、`!`、`"` 还是换行，
/// 它都只是某一个 argv 元素里的字符。
pub fn helper_args(package: &Path, parent_pid: u32, app_exe: &Path) -> Vec<OsString> {
    vec![
        OsString::from(APPLY_UPDATE_FLAG),
        package.as_os_str().to_os_string(),
        OsString::from(parent_pid.to_string()),
        app_exe.as_os_str().to_os_string(),
    ]
}

/// 从命令行里认出"这是一次升级任务"。不是升级任务返回 `None`（主程序照常启动）。
pub fn parse_args<I>(args: I) -> Option<UpdateTask>
where
    I: IntoIterator<Item = OsString>,
{
    let mut it = args.into_iter();
    let _exe = it.next()?;
    let flag = it.next()?;
    if flag != APPLY_UPDATE_FLAG {
        return None;
    }
    let package = PathBuf::from(it.next()?);
    let pid_text = it.next()?;
    let app_exe = PathBuf::from(it.next()?);
    let parent_pid: u32 = pid_text.to_string_lossy().trim().parse().ok()?;
    // pid 0 / 空路径都是坏参数：宁可不动（主程序照常起来），也不能拿它们去操作文件系统
    if parent_pid == 0 || package.as_os_str().is_empty() || app_exe.as_os_str().is_empty() {
        return None;
    }
    Some(UpdateTask {
        package,
        parent_pid,
        app_exe,
    })
}

/// 安装器的调用方式：`(program, args)`。
///
/// **argv 分开传**，绝不拼成一条命令行去交给 shell —— 路径里的引号/与号/百分号
/// 原来就是在"拼字符串"那一步变成语法字符的。
pub fn installer_invocation(package: &Path) -> (OsString, Vec<OsString>) {
    let msi = package
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("msi"));
    if msi {
        (
            OsString::from(msiexec_program()),
            vec![
                OsString::from("/i"),
                package.as_os_str().to_os_string(),
                OsString::from("/qb"),
                OsString::from("/norestart"),
                // WiX 模板里"装完把应用拉起来"的自定义动作开关（不带它 MSI 用户升完就没了）
                OsString::from("AUTOLAUNCHAPP=1"),
            ],
        )
    } else {
        (
            package.as_os_str().to_os_string(),
            // NSIS：/S 静默安装 + /R 装完自动重启
            vec![OsString::from("/S"), OsString::from("/R")],
        )
    }
}

/// `msiexec` 优先用 `%SystemRoot%\System32` 下那一份（不靠 PATH 解析）。
fn msiexec_program() -> String {
    if let Ok(sys) = std::env::var("SystemRoot") {
        let p = Path::new(&sys).join("System32").join("msiexec.exe");
        if p.exists() {
            return p.to_string_lossy().to_string();
        }
    }
    "msiexec.exe".to_string()
}

/// 安装器的退出码算不算成功：0 = 成功，3010 = 成功但要重启。
pub fn exit_is_ok(code: Option<i32>) -> bool {
    matches!(code, Some(0) | Some(3010))
}

/// 写进 `apply_update.log` 的那一行（纯函数，单测能用）。
///
/// 3010（成功但要重启）**写成 `installer exit=0`** 并附上原始码：界面那条判定是
/// `/ins.*exit=0/`（见 `App.tsx` 里 `updateTakeResult` 的处理），老脚本直接写 3010
/// 会被显示成"上次升级失败"，明明装成功了。
pub fn result_line(exit_code: Option<i32>) -> String {
    match exit_code {
        Some(3010) => "installer exit=0 (raw 3010, 需要重启)".to_string(),
        Some(code) => format!("installer exit={code}"),
        None => "installer exit=-1".to_string(),
    }
}

/// 辅助进程副本的落盘路径（和应用自己的 exe 区分开，名字也便于下一次清理）。
pub fn helper_path(dir: &Path) -> PathBuf {
    dir.join(HELPER_NAME)
}

/// 主程序那边用：把当前 exe 拷一份到 `dir`，返回副本路径。
///
/// 覆盖已存在的旧副本（上一次升级留下的那份可能还在运行，删不掉就换个名字）。
pub fn prepare_helper(dir: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("创建升级目录失败: {e}"))?;
    let src = std::env::current_exe().map_err(|e| format!("取当前程序路径失败: {e}"))?;
    let base = helper_path(dir);
    let mut last: Option<String> = None;
    for attempt in 0..3 {
        let dest = if attempt == 0 {
            base.clone()
        } else {
            base.with_extension(format!("{attempt}.exe"))
        };
        match std::fs::copy(&src, &dest) {
            Ok(_) => {
                log::info!("update: 升级辅助进程已就位 {}", dest.display());
                return Ok(dest);
            }
            // 上一次的副本可能正被占用：换一个名字再试
            Err(e) => last = Some(format!("复制升级辅助进程失败: {e}")),
        }
    }
    Err(last.unwrap_or_else(|| "复制升级辅助进程失败".to_string()))
}

/// 入口：如果命令行上是升级任务，就整个做完再返回退出码；否则立刻返回 `None`。
///
/// 调用点必须在**单实例检查与创建窗口之前**（`lib.rs::run`）：辅助进程不该弹窗、
/// 也不该因为"已经有一个实例在跑"而退出。
pub fn maybe_run() -> Option<i32> {
    let task = parse_args(std::env::args_os())?;
    Some(run_task(task))
}

#[cfg(windows)]
fn run_task(task: UpdateTask) -> i32 {
    use crate::core::proc;
    use std::io::Write as _;

    let dir = task
        .package
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(std::env::temp_dir);
    let log_path = dir.join(LOG_NAME);
    // 上一次的失败记录先清掉（和原来一样：新的一次还没跑完不该被读成"上次失败了"）
    let _ = std::fs::remove_file(&log_path);
    let write_log = |line: &str| {
        log::info!("update-helper: {line}");
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
        {
            let _ = writeln!(f, "{line}");
            let _ = f.flush();
        }
    };

    write_log(&format!(
        "开始升级：包={} pid={}",
        task.package.display(),
        task.parent_pid
    ));

    // 1) 等主程序退出（最多 PARENT_WAIT；超时就像老脚本一样强杀，不能挂死）
    if !wait_for_parent(task.parent_pid, PARENT_WAIT) {
        write_log("主程序在 120 秒内没有退出，强制结束它再继续安装");
        force_kill(task.parent_pid);
        std::thread::sleep(Duration::from_millis(500));
    }

    // 2) 静默安装（argv 分开传，没有 shell）
    let (program, args) = installer_invocation(&task.package);
    let mut cmd = proc::hidden_command_quiet(&program);
    cmd.args(&args);
    cmd.current_dir(&dir);
    let status = cmd.status();
    let code = match &status {
        Ok(s) => Some(s.code()),
        Err(e) => {
            write_log(&format!("安装器启动失败：{e}"));
            None
        }
    };
    let flat = code.flatten();
    let ok = exit_is_ok(flat);
    write_log(&result_line(flat));

    if ok {
        // 成功：安装包没用了（不删就是每次升级在 %TEMP% 里留 9~14MB）
        let _ = std::fs::remove_file(&task.package);
        // 正常应该由安装包把应用拉起来（NSIS /R、MSI AUTOLAUNCHAPP=1），没起来就兜一次底
        if !wait_for_app(RELAUNCH_WAIT) {
            write_log("安装完成但应用没自己起来，辅助进程代为启动");
            let _ = proc::hidden_command_quiet(&task.app_exe).spawn();
        } else {
            write_log("安装完成，应用已由安装包启动");
        }
        0
    } else {
        // 失败：丢掉这次下载的包（下次重新下），并把旧版拉回来
        let _ = std::fs::remove_file(&task.package);
        write_log("安装失败，已丢弃这次下载的更新包");
        let _ = proc::hidden_command_quiet(&task.app_exe).spawn();
        1
    }
}

#[cfg(not(windows))]
fn run_task(_task: UpdateTask) -> i32 {
    log::warn!("update-helper: 升级辅助只支持 Windows");
    1
}

/// 等某个 pid 退出；返回 `true` = 已退出。
///
/// 主路径是 `WaitForSingleObject`（精确、不轮询）；打不开那个进程（例如它已经没了、
/// 或者权限不够）就退回"看单实例互斥体还在不在"的轮询。
#[cfg(windows)]
fn wait_for_parent(pid: u32, timeout: Duration) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
    };

    let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
    if !handle.is_null() {
        let ms = timeout.as_millis().min(u32::MAX as u128) as u32;
        let r = unsafe { WaitForSingleObject(handle, ms) };
        unsafe { CloseHandle(handle) };
        return r == WAIT_OBJECT_0;
    }
    // 打不开 = 多半已经退出了；再用互斥体确认一下，别在应用还跑着的时候开始覆盖
    let start = std::time::Instant::now();
    while start.elapsed() < timeout {
        if !crate::instance::app_running() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    false
}

/// 应用是不是已经起来了：看那个"我在跑"的单实例互斥体在不在。
#[cfg(windows)]
fn wait_for_app(timeout: Duration) -> bool {
    let start = std::time::Instant::now();
    while start.elapsed() < timeout {
        if crate::instance::app_running() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    crate::instance::app_running()
}

/// 超时就把主程序强杀（老脚本的 `taskkill /F`；这里同样只在"等不到"时用）。
#[cfg(windows)]
fn force_kill(pid: u32) {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, TerminateProcess, PROCESS_TERMINATE,
    };
    let handle = unsafe { OpenProcess(PROCESS_TERMINATE, 0, pid) };
    if handle.is_null() {
        log::warn!("update-helper: 打不开主程序进程 {pid}，无法强杀");
        return;
    }
    unsafe {
        TerminateProcess(handle, 1);
        CloseHandle(handle);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn os(s: &str) -> OsString {
        OsString::from(s)
    }

    /// 带 shell 元字符的路径必须**原样**作为一个 argv 元素传下去 ——
    /// 这正是 `.cmd` 方案会执行任意命令的地方。
    #[test]
    fn helper_args_keep_metacharacters_as_plain_argv() {
        let nasty = Path::new(r#"C:\tmp\a&b%PATH%!c\d"e\f.exe"#);
        let args = helper_args(nasty, 4321, Path::new(r"C:\app\ZeeAI_Term.exe"));
        assert_eq!(args.len(), 4, "{args:?}");
        assert_eq!(args[0], APPLY_UPDATE_FLAG);
        assert_eq!(
            args[1],
            nasty.as_os_str().to_os_string(),
            "路径必须原样保留，不能被转义/拼字符串"
        );
        assert_eq!(args[2], "4321");
        assert_eq!(args[3], r"C:\app\ZeeAI_Term.exe");
        // 一个元素就是一个参数：里面不该出现 shell 的引号包裹
        let joined = args
            .iter()
            .map(|a| a.to_string_lossy().to_string())
            .collect::<Vec<_>>();
        assert!(
            !joined.iter().any(|a| a.starts_with('"') || a.ends_with('"')),
            "{joined:?}"
        );
    }

    /// 解析：正常任务能认出来；坏参数一律当"不是升级任务"（主程序照常启动）。
    #[test]
    fn parse_args_only_accepts_a_well_formed_task() {
        let good = vec![
            os("ZeeAI_Term.exe"),
            os(APPLY_UPDATE_FLAG),
            os(r"C:\Temp\ZeeAI_Term_0.1.15_setup.exe"),
            os("4321"),
            os(r"C:\App\ZeeAI_Term.exe"),
        ];
        let t = parse_args(good.clone()).expect("正常参数应该认出来");
        assert_eq!(t.parent_pid, 4321);
        assert_eq!(t.package, PathBuf::from(r"C:\Temp\ZeeAI_Term_0.1.15_setup.exe"));
        assert_eq!(t.app_exe, PathBuf::from(r"C:\App\ZeeAI_Term.exe"));
        // 再包一层 Owned 的形式（真实调用是 args_os）
        assert!(parse_args(good.clone()).is_some());

        // 普通启动
        assert!(parse_args(vec![os("ZeeAI_Term.exe")]).is_none());
        assert!(parse_args(vec![os("ZeeAI_Term.exe"), os("--selftest")]).is_none());

        // 坏参数：pid 不是数字 / 是 0 / 缺 exe / 缺包
        let mut bad = good.clone();
        bad[3] = os("abc");
        assert!(parse_args(bad).is_none(), "pid 不是数字");
        let mut bad = good.clone();
        bad[3] = os("0");
        assert!(parse_args(bad).is_none(), "pid 0 不能当成任务");
        let mut bad = good.clone();
        bad[2] = os("");
        assert!(parse_args(bad).is_none(), "空包路径");
        let mut bad = good;
        bad.pop();
        assert!(parse_args(bad).is_none(), "缺 app exe");
    }

    /// 安装包路径是**一个**参数，不是拼出来的一条命令行；MSI/NSIS 各有各的开关。
    #[test]
    fn installer_invocation_passes_the_path_as_one_argument() {
        let exe = Path::new(r"C:\Temp\a&b\ZeeAI_Term_0.1.15_setup.exe");
        let (program, args) = installer_invocation(exe);
        assert_eq!(program, exe.as_os_str().to_os_string());
        assert_eq!(args, vec![os("/S"), os("/R")], "NSIS：静默 + 装完重启");
        assert!(
            !args.iter().any(|a| a == &exe.as_os_str().to_os_string()),
            "exe 路径不该出现在参数里"
        );

        let msi = Path::new(r"C:\Temp\ZeeAI_Term_0.1.15_setup.msi");
        let (program, args) = installer_invocation(msi);
        assert!(
            program.to_string_lossy().to_ascii_lowercase().contains("msiexec"),
            "{program:?}"
        );
        assert_eq!(args[0], "/i");
        assert_eq!(
            args[1],
            msi.as_os_str().to_os_string(),
            "msi 路径是第二个参数（完整一个）"
        );
        assert!(args.contains(&os("AUTOLAUNCHAPP=1")), "MSI 必须带自启动开关：{args:?}");
        assert!(args.contains(&os("/norestart")), "{args:?}");
    }

    #[test]
    fn exit_code_3010_means_success() {
        assert!(exit_is_ok(Some(0)));
        assert!(exit_is_ok(Some(3010)), "3010 = 成功但需要重启（和老脚本一致）");
        assert!(!exit_is_ok(Some(2)), "NSIS Error 退出码 2 必须算失败");
        assert!(!exit_is_ok(Some(1603)), "MSI 安装失败");
        assert!(!exit_is_ok(None), "起不来也算失败");
    }

    /// 结果日志那一行必须能被界面认出"成功"：`/ins.*exit=0/`（3010 也算成功）。
    #[test]
    fn result_line_is_recognisable_by_the_ui() {
        let ui_says_ok = |s: &str| s.to_lowercase().contains("ins") && s.contains("exit=0");
        assert!(ui_says_ok(&result_line(Some(0))), "{}", result_line(Some(0)));
        let reboot = result_line(Some(3010));
        assert!(ui_says_ok(&reboot), "3010 要写成成功那一行：{reboot}");
        assert!(reboot.contains("3010"), "但原始码要留着：{reboot}");
        assert_eq!(result_line(Some(2)), "installer exit=2");
        assert_eq!(result_line(None), "installer exit=-1");
    }

    /// 辅助进程副本的文件名要落在 `ZeeAI_Term_` 前缀里 —— 下一轮升级的
    /// `sweep_update_dir` 才会把旧副本一起清掉（不然每升一次多 16MB）。
    #[test]
    fn helper_path_is_inside_the_sweeped_namespace() {
        let p = helper_path(Path::new(r"C:\Temp\ZeeAI-Term-update"));
        let name = p.file_name().unwrap().to_string_lossy().to_string();
        assert!(name.starts_with("ZeeAI_Term_"), "{name}");
        assert!(name.ends_with(".exe"), "{name}");
        assert_eq!(p.parent().unwrap(), Path::new(r"C:\Temp\ZeeAI-Term-update"));
    }
}
