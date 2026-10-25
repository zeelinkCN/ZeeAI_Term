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
            // 建不出 Job（极少见：受限环境 / 系统资源不足）——不能假装成功，
            // 否则"App 被杀之后会不会留孤儿 ssh"这个问题永远查不出来。
            log::warn!("job: Job Object 不可用，子进程 {pid} 没有挂进去（退出时可能留孤儿）");
            return;
        };
        unsafe {
            let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
            if process.is_null() {
                // 常见原因：进程已经退出了（竞态）、或者权限不够。
                // 这两条都不至于让功能坏掉，但**必须留痕**，否则"孤儿进程"永远查不到原因。
                log::warn!(
                    "job: OpenProcess({pid}) 失败（进程已退出或权限不足），未能挂进 Job"
                );
                return;
            }
            if AssignProcessToJobObject(job, process) == 0 {
                log::warn!("job: AssignProcessToJobObject({pid}) 失败，未能挂进 Job");
            }
            CloseHandle(process);
        }
    }
}

#[cfg(windows)]
pub use imp::assign;

#[cfg(not(windows))]
pub fn assign(_pid: u32) {}

#[cfg(test)]
mod tests {
    use super::*;

    /// 传一个不存在的 pid 也必须**安全返回**（只记 warn，不能 panic）：
    /// 这个函数在每条一次性命令后面都会被调用（包括刚起就退出的进程）。
    #[test]
    fn assign_with_bogus_pid_never_panics() {
        assign(0);
        assign(u32::MAX);
        // 真的起一个进程、等它退出之后再 assign（那是"进程已经没了"的常见路径）
        #[cfg(windows)]
        let mut child = std::process::Command::new("cmd")
            .args(["/C", "exit", "0"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("cmd 应该能起来");
        #[cfg(not(windows))]
        let mut child = std::process::Command::new("true")
            .spawn()
            .expect("true 应该能起来");
        let pid = child.id();
        let _ = child.wait();
        assign(pid);
    }
}
