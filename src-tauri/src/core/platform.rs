//! Desktop paths, executable discovery and local shells shared by the IPC layer.
use std::ffi::OsStr;
use std::path::{Path, PathBuf};

pub fn config_dir() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("ZeeAI-Terminal")
}

pub fn log_dir() -> PathBuf {
    #[cfg(windows)]
    if let Some(base) = std::env::var_os("LOCALAPPDATA") {
        return PathBuf::from(base).join("com.zeeai.terminal").join("logs");
    }
    #[cfg(target_os = "macos")]
    if let Some(home) = dirs::home_dir() {
        return home.join("Library/Logs/com.zeeai.terminal");
    }
    config_dir().join("logs")
}

pub fn default_shell() -> &'static str {
    if cfg!(windows) {
        "powershell"
    } else if cfg!(target_os = "macos") {
        "zsh"
    } else {
        "bash"
    }
}

pub fn executable_name(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.into()
    }
}

fn is_executable(path: &Path) -> bool {
    let Ok(md) = path.metadata() else {
        return false;
    };
    if !md.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        md.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

pub fn find_program(name: &str) -> Option<PathBuf> {
    let name = OsStr::new(name);
    let path = Path::new(name);
    if path.is_absolute() || path.components().count() > 1 {
        return is_executable(path).then(|| path.to_path_buf());
    }
    let paths = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&paths) {
        let path = dir.join(name);
        if is_executable(&path) {
            return Some(path);
        }
        #[cfg(windows)]
        if path.extension().is_none() {
            for ext in ["exe", "com", "cmd", "bat"] {
                let candidate = path.with_extension(ext);
                if is_executable(&candidate) {
                    return Some(candidate);
                }
            }
        }
    }
    None
}

/// Finder does not inherit the PATH from a terminal. Add the usual user-installed
/// tool locations before any worker threads start; login shells still load their own profiles.
pub fn init_environment() {
    #[cfg(target_os = "macos")]
    {
        let mut paths: Vec<PathBuf> = std::env::var_os("PATH")
            .map(|p| std::env::split_paths(&p).collect())
            .unwrap_or_default();
        let mut extra = vec![
            "/opt/homebrew/bin".into(),
            "/usr/local/bin".into(),
            "/usr/bin".into(),
            "/bin".into(),
            "/usr/sbin".into(),
            "/sbin".into(),
        ];
        if let Some(home) = dirs::home_dir() {
            extra.push(home.join(".local/bin"));
            extra.push(home.join("Library/Android/sdk/platform-tools"));
        }
        for key in ["ANDROID_HOME", "ANDROID_SDK_ROOT"] {
            if let Some(base) = std::env::var_os(key) {
                extra.push(PathBuf::from(base).join("platform-tools"));
            }
        }
        for path in extra {
            if !paths.contains(&path) {
                paths.push(path);
            }
        }
        if let Ok(path) = std::env::join_paths(paths) {
            std::env::set_var("PATH", path);
        }
    }
}

/// Returns argv without involving a command shell. Unsupported platform choices
/// fail explicitly instead of silently starting a different shell.
pub fn local_shell(
    shell: &str,
    distro: Option<&str>,
) -> Result<(String, Vec<String>, String), String> {
    #[cfg(windows)]
    let result = match shell {
        "powershell" => (
            "powershell.exe".into(),
            vec!["-NoLogo".into()],
            "PowerShell".into(),
        ),
        "pwsh" => {
            if find_program("pwsh.exe").is_none() {
                return Err(
                    "本机没找到 PowerShell 7（pwsh.exe），请先安装或选择 PowerShell".into(),
                );
            }
            (
                "pwsh.exe".into(),
                vec!["-NoLogo".into()],
                "PowerShell 7".into(),
            )
        }
        "cmd" => ("cmd.exe".into(), vec![], "命令提示符".into()),
        "wsl" => {
            let args = distro
                .filter(|d| !d.trim().is_empty())
                .map(|d| vec!["-d".into(), d.into()])
                .unwrap_or_default();
            ("wsl.exe".into(), args, "WSL".into())
        }
        _ => return Err(format!("Windows 不支持本地终端 {shell}")),
    };
    #[cfg(not(windows))]
    let result = {
        let _ = distro;
        match shell {
            "zsh" | "bash" => (format!("/bin/{shell}"), vec!["-l".into()], shell.into()),
            _ => {
                return Err(format!(
                    "当前系统不支持本地终端 {shell}，请选择 zsh 或 bash"
                ))
            }
        }
    };
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_is_absolute_and_independent_of_working_directory() {
        assert!(config_dir().is_absolute());
        assert_eq!(config_dir().file_name().unwrap(), "ZeeAI-Terminal");
    }

    #[test]
    fn rejects_unknown_shell_instead_of_launching_powershell() {
        assert!(local_shell("unknown-shell", None).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn unix_shell_is_a_login_shell_and_windows_choices_are_rejected() {
        let (program, args, _) = local_shell("bash", None).unwrap();
        assert_eq!(program, "/bin/bash");
        assert_eq!(args, ["-l"]);
        assert!(local_shell("wsl", None).is_err());
        assert!(find_program("/bin/sh").is_some());
        assert!(find_program("/tmp").is_none());
    }
}
