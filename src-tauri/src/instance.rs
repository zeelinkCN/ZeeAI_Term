//! 单实例保护（Windows）。
//!
//! 为什么需要：便携版和安装版**共用**同一份配置目录
//! （`%APPDATA%\ZeeAI-Terminal`：settings / history / workspace / ai_turns 都在那儿），
//! 两个实例同时跑会互相覆盖（后写的赢），AI 通知也会各弹一遍 —— 用户桌面上真的同时开着
//! 便携版预览和安装版，就是这么踩上的。
//!
//! 做法：进程级命名互斥体。已经有一个在跑时不弹任何东西 —— 把那个窗口叫到前面来，
//! 然后自己安静退出。名字里**不带 exe 路径**：便携版与安装版要互相挡住；
//! 找窗口时按"可执行文件名"匹配（两边都叫 `ZeeAI_Term.exe`）。

#[cfg(windows)]
pub fn ensure_single_instance() -> bool {
    use windows_sys::Win32::Foundation::{GetLastError, ERROR_ALREADY_EXISTS};
    use windows_sys::Win32::System::Threading::CreateMutexW;

    const NAME: &str = "Local\\ZeeAI_Term_SingleInstance";
    let name: Vec<u16> = NAME.encode_utf16().chain(std::iter::once(0)).collect();
    // 句柄**故意不关**：它要活到进程退出（关掉就等于放弃"我在跑"这个声明）
    let handle = unsafe { CreateMutexW(std::ptr::null(), 1, name.as_ptr()) };
    if handle.is_null() {
        // 建不出来就别挡用户，当作第一个实例继续跑
        return true;
    }
    if unsafe { GetLastError() } != ERROR_ALREADY_EXISTS {
        return true;
    }
    let focused = focus_existing_window();
    log::info!(
        "已经有一个 ZeeAI Term 在跑（把它的窗口叫到前面{}），本次启动直接退出",
        if focused { "成功" } else { "失败（它可能被最小化到托盘了）" }
    );
    false
}

/// 找到"另一个自己"的顶层窗口并把它叫到前面；找不到返回 false
#[cfg(windows)]
fn focus_existing_window() -> bool {
    use windows_sys::Win32::Foundation::{HWND, LPARAM};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowThreadProcessId, IsWindowVisible, SetForegroundWindow, ShowWindow,
        SW_RESTORE,
    };

    /// 我们自己的可执行文件名（便携版与安装版同名，所以两边能互相认出来）
    const EXE: &str = "ZeeAI_Term.exe";

    unsafe extern "system" fn cb(hwnd: HWND, lparam: LPARAM) -> i32 {
        unsafe {
            if IsWindowVisible(hwnd) == 0 {
                return 1;
            }
            let mut pid: u32 = 0;
            GetWindowThreadProcessId(hwnd, &mut pid);
            if pid == 0 || pid == std::process::id() {
                return 1;
            }
            let Some(name) = process_exe_name(pid) else {
                return 1;
            };
            if !name.eq_ignore_ascii_case(EXE) {
                return 1;
            }
            ShowWindow(hwnd, SW_RESTORE);
            SetForegroundWindow(hwnd);
            *(lparam as *mut bool) = true;
            0 // 找到了就停止枚举
        }
    }

    let mut found = false;
    unsafe {
        EnumWindows(Some(cb), &mut found as *mut bool as LPARAM);
    }
    found
}

/// 进程 pid → 可执行文件名（拿不到就 None：可能是系统进程，权限不够）
#[cfg(windows)]
fn process_exe_name(pid: u32) -> Option<String> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        return None;
    }
    let mut buf = [0u16; 1024];
    let mut len = buf.len() as u32;
    let ok = unsafe { QueryFullProcessImageNameW(handle, 0, buf.as_mut_ptr(), &mut len) };
    unsafe { CloseHandle(handle) };
    if ok == 0 || len == 0 {
        return None;
    }
    let full = String::from_utf16_lossy(&buf[..len as usize]);
    full.rsplit(['\\', '/']).next().map(str::to_string)
}
