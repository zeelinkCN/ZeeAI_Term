//! Load the pinned Microsoft ConPTY pair before portable-pty initializes it.
//!
//! Installers keep the pair beside our exe. A standalone exe also embeds it and
//! can repair its own versioned cache without changing the installation folder.
//! Nothing is downloaded at runtime. macOS release builds omit this module.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

const CACHE_KEY: &str = "1.25.260930003-x64";
static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy)]
struct RuntimeFile {
    name: &'static str,
    bytes: &'static [u8],
    // Executables have independently pinned upstream hashes. Text notices are
    // compared to the same bytes embedded in this application.
    sha256: Option<&'static str>,
}

fn unsafe_entry(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return true; // FILE_ATTRIBUTE_REPARSE_POINT, including junctions
        }
    }
    false
}

fn validate_embedded(files: &[RuntimeFile]) -> Result<(), String> {
    for file in files {
        if file.bytes.is_empty()
            || file
                .sha256
                .is_some_and(|expected| super::sha256::hex_digest(file.bytes) != expected)
        {
            return Err(format!(
                "内置终端组件校验失败：{}，请重新下载完整应用",
                file.name
            ));
        }
    }
    Ok(())
}

/// On Windows the returned handle denies writes/deletes until the loaded
/// runtime is no longer needed, including OpenConsole's later process startup.
fn open_verified(directory: &Path, file: RuntimeFile) -> Result<File, String> {
    let path = directory.join(file.name);
    let before = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
    if !before.is_file() || unsafe_entry(&before) {
        return Err("终端组件不是普通文件".into());
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // Do not follow a reparse point substituted between metadata and open.
        options.share_mode(0x1).custom_flags(0x0020_0000); // SHARE_READ / OPEN_REPARSE_POINT
    }
    let mut handle = options.open(&path).map_err(|e| e.to_string())?;
    let metadata = handle.metadata().map_err(|e| e.to_string())?;
    if !metadata.is_file() || unsafe_entry(&metadata) || metadata.len() != file.bytes.len() as u64 {
        return Err("终端组件大小不匹配".into());
    }
    let mut bytes = Vec::with_capacity(file.bytes.len());
    (&mut handle)
        .take(file.bytes.len() as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    let matches = if let Some(expected) = file.sha256 {
        super::sha256::hex_digest(&bytes) == expected
    } else {
        bytes == file.bytes
    };
    if !matches {
        return Err("终端组件内容不匹配".into());
    }
    Ok(handle)
}

fn verify_pair(directory: &Path, files: &[RuntimeFile]) -> Result<Vec<File>, String> {
    files
        .iter()
        .map(|file| open_verified(directory, *file))
        .collect()
}

/// Follow the user's chosen local-data base, but never a link placed inside
/// this application's cache hierarchy.
fn cache_directory(local_data: &Path) -> Result<PathBuf, String> {
    if !local_data.is_absolute() {
        return Err("终端组件缓存目录不是绝对路径".into());
    }
    fs::create_dir_all(local_data).map_err(|e| format!("无法创建终端组件缓存目录：{e}"))?;
    let mut directory = fs::canonicalize(local_data).map_err(|e| e.to_string())?;
    for name in ["ZeeAI-Terminal", "runtime", "conpty", CACHE_KEY] {
        directory.push(name);
        match fs::create_dir(&directory) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(format!("无法创建终端组件缓存目录：{e}")),
        }
        let metadata = fs::symlink_metadata(&directory).map_err(|e| e.to_string())?;
        if !metadata.is_dir() || unsafe_entry(&metadata) {
            return Err("终端组件缓存目录包含不安全的链接或文件".into());
        }
    }
    Ok(directory)
}

struct Temporary(PathBuf);
impl Drop for Temporary {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

#[cfg(windows)]
fn atomic_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    if unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(not(windows))]
fn atomic_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(source, destination)
}

fn extract_pair(directory: &Path, files: &[RuntimeFile]) -> Result<Vec<File>, String> {
    validate_embedded(files)?;
    for file in files {
        if open_verified(directory, *file).is_ok() {
            continue;
        }
        let target = directory.join(file.name);
        if let Ok(metadata) = fs::symlink_metadata(&target) {
            if !metadata.is_file() || unsafe_entry(&metadata) {
                return Err("终端组件缓存中存在不安全的链接或目录".into());
            }
        }
        let temporary = Temporary(directory.join(format!(
            ".{}-{}-{}.tmp",
            file.name,
            std::process::id(),
            NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
        )));
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary.0)
            .map_err(|e| format!("无法写入终端组件缓存：{e}"))?;
        output
            .write_all(file.bytes)
            .and_then(|_| output.sync_all())
            .map_err(|e| format!("无法写入终端组件缓存：{e}"))?;
        drop(output);
        if let Err(error) = atomic_replace(&temporary.0, &target) {
            // Another process may already have installed and opened this same
            // immutable version, preventing a redundant replacement on Windows.
            if open_verified(directory, *file).is_err() {
                return Err(format!("无法替换终端组件缓存：{error}"));
            }
        }
    }
    verify_pair(directory, files).map_err(|_| "终端组件缓存校验失败，请重新启动应用后重试".into())
}

#[cfg(all(windows, target_arch = "x86_64"))]
mod windows {
    use super::*;
    use std::ffi::OsString;
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use std::sync::OnceLock;
    use windows_sys::Win32::Foundation::HMODULE;
    use windows_sys::Win32::System::LibraryLoader::{
        GetModuleFileNameW, GetModuleHandleW, GetProcAddress, LoadLibraryExW,
        LOAD_LIBRARY_SEARCH_DEFAULT_DIRS, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR,
    };

    pub(super) const FILES: &[RuntimeFile] = &[
        RuntimeFile {
            name: "conpty.dll",
            bytes: include_bytes!("../../resources/conpty/conpty.dll"),
            sha256: Some("feeef341d891643c62d30b6b07800bc70f0bc148f44cb8c3bee84aa557ae805a"),
        },
        RuntimeFile {
            name: "OpenConsole.exe",
            bytes: include_bytes!("../../resources/conpty/OpenConsole.exe"),
            sha256: Some("3d66b23d0a71bb8eed2b77edc8b9df9bf54ce6c8fb74c863a30e760997f80586"),
        },
        RuntimeFile {
            name: "LICENSE-ConPTY.txt",
            bytes: include_bytes!("../../resources/conpty/LICENSE-ConPTY.txt"),
            sha256: None,
        },
        RuntimeFile {
            name: "ConPTY-UPSTREAM.md",
            bytes: include_bytes!("../../resources/conpty/UPSTREAM.md"),
            sha256: None,
        },
    ];

    struct Runtime {
        // Deliberately kept loaded for the process lifetime. portable-pty's
        // later bare-name LoadLibrary must resolve to this validated module.
        _module: usize,
        _files: Vec<File>,
    }
    static RUNTIME: OnceLock<Result<Runtime, String>> = OnceLock::new();

    fn module_path(module: HMODULE) -> Result<PathBuf, String> {
        let mut path = vec![0u16; 32_768];
        let length =
            unsafe { GetModuleFileNameW(module, path.as_mut_ptr(), path.len() as u32) } as usize;
        if length == 0 || length >= path.len() {
            return Err("无法确认已加载的终端组件，请重新启动应用".into());
        }
        Ok(PathBuf::from(OsString::from_wide(&path[..length])))
    }

    fn initialize() -> Result<Runtime, String> {
        validate_embedded(FILES)?;
        let name: Vec<u16> = "conpty.dll".encode_utf16().chain(Some(0)).collect();
        let previous = unsafe { GetModuleHandleW(name.as_ptr()) };
        let (library, files) = if !previous.is_null() {
            // Never let portable-pty reuse a previously loaded, unverified DLL.
            let library = module_path(previous)?;
            let directory = library.parent().ok_or("终端组件路径无效")?;
            let files = verify_pair(directory, FILES)
                .map_err(|_| "已加载不匹配的终端组件，请重新启动应用".to_string())?;
            (library, files)
        } else {
            let exe = std::env::current_exe().map_err(|e| e.to_string())?;
            let directory = exe.parent().ok_or("无法确认应用目录")?;
            match verify_pair(directory, FILES) {
                Ok(files) => (directory.join("conpty.dll"), files),
                Err(_) => {
                    let base = std::env::var_os("LOCALAPPDATA")
                        .map(PathBuf::from)
                        .or_else(dirs::data_local_dir)
                        .ok_or("无法确定终端组件缓存目录")?;
                    let directory = cache_directory(&base)?;
                    let files = extract_pair(&directory, FILES)?;
                    (directory.join("conpty.dll"), files)
                }
            }
        };
        let library = fs::canonicalize(library).map_err(|e| e.to_string())?;
        let wide: Vec<u16> = library.as_os_str().encode_wide().chain(Some(0)).collect();
        let module = unsafe {
            LoadLibraryExW(
                wide.as_ptr(),
                std::ptr::null_mut(),
                LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS,
            )
        };
        if module.is_null() {
            return Err(format!(
                "无法加载 Windows 终端组件：{}",
                std::io::Error::last_os_error()
            ));
        }
        if unsafe { GetModuleHandleW(name.as_ptr()) } != module
            || [
                b"CreatePseudoConsole\0".as_slice(),
                b"ResizePseudoConsole\0",
                b"ClosePseudoConsole\0",
            ]
            .iter()
            .any(|symbol| unsafe { GetProcAddress(module, symbol.as_ptr()) }.is_none())
        {
            return Err("Windows 终端组件冲突或不兼容，请重新启动应用".into());
        }
        log::info!("terminal: verified Microsoft ConPTY {CACHE_KEY} loaded");
        Ok(Runtime {
            _module: module as usize,
            _files: files,
        })
    }

    pub(crate) fn ensure() -> Result<(), String> {
        RUNTIME
            .get_or_init(initialize)
            .as_ref()
            .map(|_| ())
            .map_err(Clone::clone)
    }
}

#[cfg(all(windows, target_arch = "x86_64"))]
pub(crate) use windows::ensure;

#[cfg(all(windows, not(target_arch = "x86_64")))]
pub(crate) fn ensure() -> Result<(), String> {
    Err("此 Windows 构建仅支持 x64 终端组件，请使用 Windows x64 版本".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    const FILES: &[RuntimeFile] = &[
        RuntimeFile {
            name: "conpty.dll",
            bytes: b"test-dll",
            sha256: None,
        },
        RuntimeFile {
            name: "OpenConsole.exe",
            bytes: b"test-console",
            sha256: None,
        },
        RuntimeFile {
            name: "LICENSE-ConPTY.txt",
            bytes: b"test-license",
            sha256: None,
        },
        RuntimeFile {
            name: "ConPTY-UPSTREAM.md",
            bytes: b"test-upstream",
            sha256: None,
        },
    ];

    struct TestDirectory(PathBuf);
    impl TestDirectory {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "zeeai-conpty-{}-{}-路径 空格",
                std::process::id(),
                NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn standalone_cache_extracts_the_pair_and_notice_and_repairs_corrupt_content() {
        let root = TestDirectory::new();
        let directory = cache_directory(&root.0).unwrap();
        let handles = extract_pair(&directory, FILES).unwrap();
        assert_eq!(handles.len(), 4);
        assert_eq!(
            fs::read(directory.join("LICENSE-ConPTY.txt")).unwrap(),
            b"test-license"
        );
        drop(handles);
        fs::write(directory.join("conpty.dll"), b"tampered").unwrap();
        fs::remove_file(directory.join("OpenConsole.exe")).unwrap();
        drop(extract_pair(&directory, FILES).unwrap());
        assert_eq!(fs::read(directory.join("conpty.dll")).unwrap(), b"test-dll");
        assert_eq!(
            fs::read(directory.join("OpenConsole.exe")).unwrap(),
            b"test-console"
        );
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 4);
    }

    #[test]
    fn simultaneous_cache_initialization_never_exposes_a_partial_final_file() {
        let root = TestDirectory::new();
        let directory = cache_directory(&root.0).unwrap();
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let directory = directory.clone();
                std::thread::spawn(move || {
                    drop(extract_pair(&directory, FILES).unwrap());
                })
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
        drop(verify_pair(&directory, FILES).unwrap());
        assert_eq!(fs::read_dir(directory).unwrap().count(), FILES.len());
    }

    #[test]
    fn bad_embedded_hash_or_unsafe_cache_target_is_not_loaded_or_overwritten() {
        let root = TestDirectory::new();
        let directory = cache_directory(&root.0).unwrap();
        let bad = [RuntimeFile {
            name: "conpty.dll",
            bytes: b"tampered",
            sha256: Some("not-the-pinned-sha256"),
        }];
        assert!(extract_pair(&directory, &bad).is_err());
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 0);
        fs::create_dir(directory.join("conpty.dll")).unwrap();
        assert!(extract_pair(&directory, FILES).is_err());
        assert!(directory.join("conpty.dll").is_dir());
    }

    #[cfg(unix)]
    #[test]
    fn linked_cache_files_and_directories_are_rejected_without_touching_their_targets() {
        use std::os::unix::fs::symlink;
        let root = TestDirectory::new();
        let outside = root.0.join("outside");
        fs::create_dir(&outside).unwrap();
        let target = outside.join("keep");
        fs::write(&target, b"untouched").unwrap();
        let directory = cache_directory(&root.0).unwrap();
        symlink(&target, directory.join("conpty.dll")).unwrap();
        assert!(extract_pair(&directory, FILES).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"untouched");
        fs::remove_dir_all(root.0.join("ZeeAI-Terminal")).unwrap();
        symlink(&outside, root.0.join("ZeeAI-Terminal")).unwrap();
        assert!(cache_directory(&root.0).is_err());
        assert!(!outside.join("runtime").exists());
    }

    #[cfg(all(windows, target_arch = "x86_64"))]
    #[test]
    fn the_official_runtime_loads_once_for_all_pty_users() {
        ensure().unwrap();
        ensure().unwrap();
    }

    #[cfg(all(windows, target_arch = "x86_64"))]
    #[test]
    fn a_fresh_standalone_exe_extracts_its_runtime_and_passes_the_real_protocol_test() {
        use std::process::Stdio;
        use std::time::{Duration, Instant};

        let root = TestDirectory::new();
        let application = root.0.join("独立应用 空格");
        fs::create_dir(&application).unwrap();
        let exe = application.join("ZeeAI_Term.exe");
        fs::copy(std::env::current_exe().unwrap(), &exe).unwrap();
        assert_eq!(fs::read_dir(&application).unwrap().count(), 1);
        let local_data = root.0.join("独立缓存");
        let log_path = root.0.join("child-output.log");
        let output = File::create(&log_path).unwrap();
        let errors = output.try_clone().unwrap();
        let mut command = super::super::proc::hidden_command(&exe);
        command
            .current_dir(&application)
            // Run one real PTY test only; never recursively run this test.
            .args([
                "--exact",
                "core::pty::tests::native_pty_osc7501_negotiation_and_status_round_trip",
                "--nocapture",
            ])
            .env("LOCALAPPDATA", &local_data)
            .env("APPDATA", root.0.join("临时配置"))
            .stdout(Stdio::from(output))
            .stderr(Stdio::from(errors));
        let mut child = command.spawn().unwrap();
        let deadline = Instant::now() + Duration::from_secs(35);
        let (status, timed_out) = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break (status, false);
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                break (child.wait().unwrap(), true);
            }
            std::thread::sleep(Duration::from_millis(50));
        };
        let mut bytes = Vec::new();
        File::open(&log_path)
            .unwrap()
            .take(64 * 1024)
            .read_to_end(&mut bytes)
            .unwrap();
        let output = String::from_utf8_lossy(&bytes);
        assert!(
            !timed_out && status.success() && output.contains("1 passed"),
            "Standalone PTY child failed (timeout={timed_out}, status={status}):\n{output}"
        );
        let cache = local_data
            .join("ZeeAI-Terminal/runtime/conpty")
            .join(CACHE_KEY);
        drop(verify_pair(&cache, windows::FILES).unwrap());
        assert_eq!(fs::read_dir(&cache).unwrap().count(), 4);
        // Extraction leaves the application directory untouched.
        assert_eq!(fs::read_dir(&application).unwrap().count(), 1);
    }
}
