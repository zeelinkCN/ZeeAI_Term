//! 把所有子进程（ssh.exe / PowerShell / wsl 等）放进一个 Windows Job Object，
//! 并设置 "job 关闭时终止所有进程"。
//!
//! 这样即使应用被强杀或崩溃，也不会留下孤儿 ssh 进程——孤儿客户端会一直挂在
//! 服务器的 tmux 上，导致多客户端尺寸冲突（表现为终端显示不全、满屏花点）。

#[cfg(windows)]
mod imp {
    use std::sync::OnceLock;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
    };

    static JOB: OnceLock<usize> = OnceLock::new();

    fn job_handle() -> Option<HANDLE> {
        let value = *JOB.get_or_init(|| unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return 0;
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &mut info as *mut _ as *mut core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if ok == 0 {
                CloseHandle(job);
                return 0;
            }
            job as usize
        });
        if value == 0 {
            None
        } else {
            Some(value as HANDLE)
        }
    }

    pub fn assign(pid: u32) {
        let Some(job) = job_handle() else {
            return;
        };
        unsafe {
            let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
            if !process.is_null() {
                AssignProcessToJobObject(job, process);
                CloseHandle(process);
            }
        }
    }
}

#[cfg(windows)]
pub use imp::assign;

#[cfg(not(windows))]
pub fn assign(_pid: u32) {}
