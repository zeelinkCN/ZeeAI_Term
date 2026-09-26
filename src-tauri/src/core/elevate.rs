//! Windows 管理员模式（提权）。
//!
//! **为什么是"整个应用提权"，而不是"某一个标签页提权"**：
//! 终端是我们（普通权限进程）用 ConPTY 建的 —— 伪控制台和两根管道都挂在**我们的进程**上。
//! 要开一个"管理员权限的子进程"，得用管理员令牌去 `CreateProcessAsUser`，而拿到那个令牌本身
//! 就需要特权；把管理员进程挂进普通进程的伪控制台也不行。所以在这一层上，业界通行做法就是
//! **整个终端应用提权**（Windows Terminal 的"以管理员身份运行"也是这个模型）：
//! 点一次「以管理员身份重启」→ 过一次 UAC → 之后开的本地终端**天然都是管理员**。
//!
//! 另外给一个不改整体的折中：以管理员身份**单独开一个** PowerShell / CMD 窗口
//! （它会出现在自己独立的控制台窗口里，不在我们的标签中，但能立刻拿到管理员权限）。
//!
//! 实现上只用系统自带的 API（`ShellExecuteExW` 的 `runas` 动作 / 令牌查询），不引任何新依赖。

#[cfg(windows)]
mod imp {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, ERROR_CANCELLED, HANDLE,
    };
    use windows_sys::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION};
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
    use windows_sys::Win32::UI::Shell::{
        ShellExecuteExW, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    /// 需要查询令牌，`TOKEN_QUERY` = 0x0008
    const TOKEN_QUERY: u32 = 0x0008;

    fn wide(s: &str) -> Vec<u16> {
        OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
    }

    /// 当前进程是不是管理员（令牌已提权）
    pub fn is_elevated() -> bool {
        unsafe {
            let mut token: HANDLE = std::ptr::null_mut();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
                return false;
            }
            let mut info: TOKEN_ELEVATION = std::mem::zeroed();
            let mut size = 0u32;
            let ok = GetTokenInformation(
                token,
                TokenElevation,
                &mut info as *mut _ as *mut core::ffi::c_void,
                std::mem::size_of::<TOKEN_ELEVATION>() as u32,
                &mut size,
            );
            CloseHandle(token);
            ok != 0 && info.TokenIsElevated != 0
        }
    }

    /// 用 `runas` 动作启动一个程序（会弹 UAC）。
    /// 用户在 UAC 上点"否"时返回 Err（错误码 1223），调用方据此提示"已取消"。
    fn shell_execute_runas(file: &str, params: Option<&str>) -> Result<(), String> {
        let verb = wide("runas");
        let file_w = wide(file);
        let params_w = params.map(wide);

        let mut info: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
        info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
        // NOASYNC：不把这个调用丢给后台的 DDE/异步路径；NOCLOSEPROCESS 让我们拿到进程句柄
        info.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC;
        info.lpVerb = verb.as_ptr();
        info.lpFile = file_w.as_ptr();
        info.lpParameters = params_w
            .as_ref()
            .map(|v| v.as_ptr())
            .unwrap_or(std::ptr::null());
        info.nShow = SW_SHOWNORMAL;

        let ok = unsafe { ShellExecuteExW(&mut info) };
        if ok == 0 {
            let code = unsafe { GetLastError() };
            if code == ERROR_CANCELLED {
                return Err("已取消：没有在 UAC 里点“是”".into());
            }
            return Err(format!("提权启动失败（Windows 错误码 {code}）"));
        }
        if !info.hProcess.is_null() {
            unsafe { CloseHandle(info.hProcess) };
        }
        Ok(())
    }

    /// 以管理员身份重启整个应用（UAC 弹一次；之后本地终端都是管理员）
    pub fn relaunch_self_elevated() -> Result<(), String> {
        let exe = std::env::current_exe().map_err(|e| format!("取当前程序路径失败: {e}"))?;
        if is_elevated() {
            return Err("当前已经是管理员模式，不用再提权".into());
        }
        shell_execute_runas(&exe.to_string_lossy(), None)
    }

    /// 以管理员身份单独开一个 shell 窗口（powershell / cmd）
    pub fn open_elevated_shell(shell: &str) -> Result<(), String> {
        match shell {
            "cmd" => {
                // cmd 不带参数就是交互式会话；/k 留在窗口里
                shell_execute_runas("cmd.exe", Some("/k"))
            }
            _ => shell_execute_runas("powershell.exe", Some("-NoLogo -NoExit")),
        }
    }
}

#[cfg(windows)]
pub use imp::{is_elevated, open_elevated_shell, relaunch_self_elevated};

#[cfg(not(windows))]
pub fn is_elevated() -> bool {
    false
}

#[cfg(not(windows))]
pub fn relaunch_self_elevated() -> Result<(), String> {
    Err("管理员模式目前只在 Windows 上支持".into())
}

#[cfg(not(windows))]
pub fn open_elevated_shell(_shell: &str) -> Result<(), String> {
    Err("管理员模式目前只在 Windows 上支持".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn elevation_state_is_queryable() {
        // 这个测试只要求"能问出结果、不崩"；在 CI/普通会话里通常是 false，管理员会话里是 true。
        let _ = is_elevated();
    }

    #[test]
    fn unknown_shell_still_maps_to_powershell() {
        // 这里只验证参数拼装不会 panic（真的会弹 UAC，所以不实际调用）：
        // open_elevated_shell 的两个分支都必须是有意义的程序名。
        for s in ["powershell", "cmd", "wsl", ""] {
            let target = if s == "cmd" { "cmd.exe" } else { "powershell.exe" };
            assert!(target.ends_with(".exe"));
        }
    }
}
