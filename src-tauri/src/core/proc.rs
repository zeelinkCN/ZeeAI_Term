//! 统一的后台进程入口（Windows 上不闪控制台窗口）。
//!
//! 为什么要有这个模块：ZeeAI_Term 是 **GUI 进程**（自己没控制台）。Windows 上
//! `CreateProcess` 起一个 console 程序（cmd / powershell / where / reg / curl / certutil /
//! ssh …）时，只要没带 `CREATE_NO_WINDOW`，系统就会给它**新建一个控制台窗口** ——
//! 对用户就是"黑窗一闪"。0.1.12 把看板 / 快照轮询改成常驻之后，
//! 探测进程每 10~20 秒起一次，**漏掉一个标志就变成"一直在弹本地终端"**（用户报障）。
//!
//! 所以本项目的纪律是：
//! - **后台探测 / 查询 / 一次性命令**一律从 `hidden_command` 拿 `Command`；
//! - 不要在业务代码里裸写 `std::process::Command::new` / `tokio::process::Command::new`；
//! - 故意要显示窗口的只有两类，保持原样：`explorer.exe` 打开目录、用户主动触发的
//!   提权 shell（`core/elevate.rs` 的 `ShellExecuteExW runas`）。终端 pty 由
//!   portable-pty 管，也不走这里。
//!
//! 非 Windows 是**原样返回**（没有 CREATE_NO_WINDOW 这回事），调用方不用写 `cfg`。

use std::ffi::OsStr;

/// Windows 的 `CREATE_NO_WINDOW`（0x08000000）。只在这个模块里出现，
/// 免得业务代码再散落一份魔数。
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 起一个**后台同步进程**：Windows 上带 `CREATE_NO_WINDOW`，并把 stdin 设成 null。
///
/// 为什么 stdout/stderr 不在这里设 null：`Command::output()` **不会覆盖**已经设过的
/// stdout/stderr —— 如果这里设成 null，所有 `output()` 调用都会拿到空字符串（CLI 健康
/// 探测、certutil 校验都会静默失效，实测踩过）。所以约定是：
/// - 要拿输出：`.output()`（它自己接管成管道，不会漏到控制台）；
/// - 不要输出、直接 `spawn()`：调用方显式 `.stdout(Stdio::null()).stderr(Stdio::null())`。
///
/// stdin 统一置空：后台探测不应该从父进程继承任何输入，避免子进程等输入卡住。
///
/// ⚠️ 这里就是本项目的"防弹窗"收口点。新增后台探测请用它；裸 `Command::new`
/// 在 Windows 上会让用户看到控制台黑窗（见模块注释）。
///
/// **为什么所有这些探测必须隐藏窗口**（不是"顺手加一下"，是可用性红线）：
/// 本应用没有自己的控制台，所以每一个 console 子进程在缺 `CREATE_NO_WINDOW` 时都会
/// **新建**一个控制台窗口；而这些探测是**周期性**的（看板 / 快照 10~20 秒一轮，
/// 一轮里就要起 `where`、`<cmd> --version`、`powershell` 枚举进程好几个）——
/// 漏掉一个标志，用户看到的就是"我坐在电脑前，每 20 秒被弹一次黑框"。
/// 0.1.12 的真机报障正是这么来的（当时那个每 20 秒的"CLI 健康检查"已经整条删掉，
/// 但**其余周期性探测还在**）：所以以后新增任何后台探测，都**不要**改回裸
/// `Command::new` —— 改回去的那一天，用户马上就会重新看到黑框。
pub fn hidden_command<S: AsRef<OsStr>>(program: S) -> std::process::Command {
    let mut cmd = std::process::Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd.stdin(std::process::Stdio::null());
    }
    cmd
}

/// [`hidden_command`] 的"完全静默"版本：stdout / stderr 也设成 null。
///
/// 用于**不需要任何输出、直接 spawn/status 的后台进程**（打开浏览器、where 查询、
/// 升级脚本）。要拿输出请用 [`hidden_command`] + `.output()`，不要用这个 ——
/// 它的输出会被直接丢掉。
pub fn hidden_command_quiet<S: AsRef<OsStr>>(program: S) -> std::process::Command {
    let mut cmd = hidden_command(program);
    cmd.stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    cmd
}

/// [`hidden_command`] 的 tokio 版本（`tokio::process::Command`）。
///
/// 为什么单独一份：tokio 的 `Command` 是另一套类型，不能和标准库的混用；
/// 两条路径都必须带上同一个 `CREATE_NO_WINDOW`，否则异步探测照样会闪窗。
pub fn hidden_command_async<S: AsRef<OsStr>>(program: S) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(program);
    #[cfg(windows)]
    {
        // tokio::process::Command 自己提供了 Windows 的 creation_flags（内部转给 std）
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd.stdin(std::process::Stdio::null());
    }
    cmd
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 收口函数本身要能正常起进程、拿到输出 —— 否则改完之后所有探测都会"静默失败"。
    #[test]
    fn hidden_command_still_captures_output() {
        #[cfg(windows)]
        let out = hidden_command("cmd")
            .args(["/C", "echo", "zeeai-proc"])
            .output();
        #[cfg(not(windows))]
        let out = hidden_command("sh").args(["-c", "echo zeeai-proc"]).output();
        let out = out.expect("后台命令应该能起来");
        assert!(out.status.success(), "退出码非 0: {:?}", out.status);
        assert!(
            String::from_utf8_lossy(&out.stdout).contains("zeeai-proc"),
            "stdout 没拿到：{:?}",
            String::from_utf8_lossy(&out.stdout)
        );
    }
}
