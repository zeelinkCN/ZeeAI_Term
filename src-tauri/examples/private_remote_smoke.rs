//! Optional live SSH/SFTP check. Read credentials as one JSON line on hidden stdin;
//! never accept secrets through argv, environment variables or a checked-in file.
//! Creates and removes only its own mktemp directory. It does not install software.
use base64::Engine as _;
use serde::Deserialize;
use std::io::{BufRead, IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::AsyncWriteExt;
use zeeai_terminal_lib::core::{pty, session::SessionEvent, session_log::LogRegistry, sftp, ssh};

#[derive(Deserialize)]
struct Input {
    host: String,
    user: String,
    password: String,
}

struct EchoGuard(Option<String>);
impl Drop for EchoGuard {
    fn drop(&mut self) {
        #[cfg(unix)]
        if let Some(mode) = &self.0 {
            let _ = std::process::Command::new("stty").arg(mode).status();
        }
    }
}

fn private_input() -> Result<Input, String> {
    let mut guard = EchoGuard(None);
    if std::io::stdin().is_terminal() {
        #[cfg(unix)]
        {
            let mode = std::process::Command::new("stty")
                .arg("-g")
                .output()
                .map_err(|e| e.to_string())?;
            ensure(mode.status.success(), "Cannot read terminal echo settings")?;
            guard.0 = Some(String::from_utf8_lossy(&mode.stdout).trim().to_string());
            let status = std::process::Command::new("stty")
                .arg("-echo")
                .status()
                .map_err(|e| e.to_string())?;
            ensure(status.success(), "Cannot hide credential input")?;
        }
        #[cfg(not(unix))]
        return Err("Use a secure stdin pipe for credentials on this platform".into());
    }
    eprintln!(
        "Provide one JSON line with host/user/password on hidden stdin; inputs are not logged."
    );
    let mut line = String::new();
    std::io::stdin()
        .lock()
        .read_line(&mut line)
        .map_err(|e| e.to_string())?;
    serde_json::from_str(&line).map_err(|_| "Invalid private input".into())
}

fn ensure(ok: bool, message: &str) -> Result<(), String> {
    if ok {
        Ok(())
    } else {
        Err(message.into())
    }
}

fn check_pty(input: &Input) -> Result<(), String> {
    let id = "private-remote-smoke";
    let command = "printf 'ZEEAI_REMOTE_READY\\n'; IFS= read -r line; printf 'ZEEAI_REMOTE_REPLY:%s\\n' \"$line\"; stty size";
    let mut args = ssh::ssh_args(
        &input.host,
        22,
        &input.user,
        None,
        Some(command),
        false,
        None,
    );
    args.splice(
        0..0,
        [
            "-o".into(),
            "PreferredAuthentications=password".into(),
            "-o".into(),
            "PubkeyAuthentication=no".into(),
            "-o".into(),
            "NumberOfPasswordPrompts=1".into(),
            "-o".into(),
            "ConnectTimeout=15".into(),
        ],
    );
    let (sender, receiver) = std::sync::mpsc::channel();
    let handle = pty::spawn_with_sink(
        id,
        "ssh",
        "Private smoke",
        &ssh::ssh_exe(),
        &args,
        None,
        80,
        24,
        move |event| {
            let _ = sender.send(event);
        },
        Arc::new(LogRegistry::new()),
        pty::SpawnOpts::default(),
    )?;
    handle
        .master
        .as_ref()
        .unwrap()
        .lock()
        .unwrap()
        .resize(portable_pty::PtySize {
            rows: 32,
            cols: 110,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    let mut sent_password = false;
    let mut sent_input = false;
    let deadline = Instant::now() + Duration::from_secs(30);
    while Instant::now() < deadline {
        if let Ok(SessionEvent::Data { data, seq }) =
            receiver.recv_timeout(Duration::from_millis(100))
        {
            bytes.extend(
                base64::engine::general_purpose::STANDARD
                    .decode(data)
                    .map_err(|e| e.to_string())?,
            );
            if let Some(seq) = seq {
                pty::ack_output(id, seq);
            }
            let text = String::from_utf8_lossy(&bytes);
            if !sent_password && text.to_ascii_lowercase().contains("password:") {
                let mut writer = handle.writer.lock().unwrap();
                writer
                    .write_all(input.password.as_bytes())
                    .map_err(|e| e.to_string())?;
                writer.write_all(b"\r").map_err(|e| e.to_string())?;
                sent_password = true;
            }
            if !sent_input && text.contains("ZEEAI_REMOTE_READY") {
                handle
                    .writer
                    .lock()
                    .unwrap()
                    .write_all(b"hello\r")
                    .map_err(|e| e.to_string())?;
                sent_input = true;
            }
            if text.contains("ZEEAI_REMOTE_REPLY:hello") && text.contains("32 110") {
                break;
            }
        }
    }
    if let Some(child) = handle.child {
        let _ = child.lock().unwrap().kill();
    }
    let text = String::from_utf8_lossy(&bytes);
    ensure(
        text.contains("ZEEAI_REMOTE_REPLY:hello") && text.contains("32 110"),
        "Live PTY input/resize check failed",
    )
}

async fn write_remote(conn: &sftp::SftpConn, path: &str, bytes: &[u8]) -> Result<(), String> {
    let mut file = conn.sftp.create(path).await.map_err(|e| e.to_string())?;
    file.write_all(bytes).await.map_err(|e| e.to_string())?;
    file.shutdown().await.map_err(|e| e.to_string())
}

async fn check_sftp(input: &Input) -> Result<(), String> {
    let conn = sftp::connect(
        &input.host,
        22,
        &input.user,
        None,
        Some(&input.password),
        None,
    )
    .await?;
    let marker = sftp::exec(&conn, "printf 'ZEEAI_RUSSH_OK'").await?;
    ensure(marker.contains("ZEEAI_RUSSH_OK"), "SSH exec marker missing")?;
    println!("PASS SSH/SFTP authentication and command execution");
    let output = sftp::exec(&conn, "mktemp -d /tmp/zeeai-smoke.XXXXXXXXXX").await?;
    let remote = output
        .lines()
        .find(|line| {
            line.strip_prefix("/tmp/zeeai-smoke.")
                .is_some_and(|suffix| {
                    !suffix.is_empty() && suffix.bytes().all(|b| b.is_ascii_alphanumeric())
                })
        })
        .ok_or_else(|| "Could not create isolated remote test directory".to_string())?
        .to_string();
    let local: PathBuf =
        std::env::temp_dir().join(format!("zeeai-private-smoke-{}", std::process::id()));
    std::fs::create_dir(&local).map_err(|e| e.to_string())?;
    let checks = async {
        let body = "ZeeAI SFTP smoke：中文路径与内容\n".as_bytes();
        let source = local.join("中文 文件.txt");
        std::fs::write(&source, body).map_err(|e| e.to_string())?;
        let path = format!("{remote}/中文 文件.txt");
        sftp::upload(&conn, &source, &path, &sftp::no_progress).await?;
        let (_, entries) = sftp::list(&conn, Some(&remote)).await?;
        ensure(
            entries.iter().any(|entry| entry.name == "中文 文件.txt"),
            "Unicode listing failed",
        )?;
        let target = local.join("download.txt");
        sftp::download(&conn, &path, &target, &sftp::no_progress).await?;
        ensure(
            std::fs::read(&target).map_err(|e| e.to_string())? == body,
            "Downloaded bytes differ",
        )?;
        println!("PASS Unicode names, listing, upload and download");
        std::fs::write(&target, &body[..7]).map_err(|e| e.to_string())?;
        sftp::download(&conn, &path, &target, &sftp::no_progress).await?;
        ensure(
            std::fs::read(&target).map_err(|e| e.to_string())? == body,
            "Download resume failed",
        )?;
        std::fs::write(&target, vec![b'x'; body.len()]).map_err(|e| e.to_string())?;
        sftp::download(&conn, &path, &target, &sftp::no_progress).await?;
        ensure(
            std::fs::read(&target).map_err(|e| e.to_string())? == body,
            "Equal-length stale file was skipped",
        )?;
        println!("PASS Download resume and same-length stale-file recovery");
        write_remote(&conn, &path, &body[..7]).await?;
        sftp::upload(&conn, &source, &path, &sftp::no_progress).await?;
        ensure(
            sftp::read_file(&conn, &path, 4096).await? == body,
            "Upload resume failed",
        )?;
        write_remote(&conn, &path, b"wrong").await?;
        sftp::upload(&conn, &source, &path, &sftp::no_progress).await?;
        ensure(
            sftp::read_file(&conn, &path, 4096).await? == body,
            "Mismatched upload prefix was spliced",
        )?;
        println!("PASS Upload resume and mismatched-prefix recovery");
        let renamed = format!("{remote}/renamed.txt");
        sftp::rename(&conn, &path, &renamed).await?;
        ensure(sftp::exists(&conn, &renamed).await, "Rename failed")?;
        write_remote(&conn, &format!("{remote}/..\\escape"), b"unsafe name").await?;
        let rejected =
            sftp::download(&conn, &remote, &local.join("recursive"), &sftp::no_progress).await;
        ensure(rejected.is_err(), "Unsafe remote name was accepted")?;
        ensure(
            !local.join("escape").exists(),
            "Traversal escaped download directory",
        )?;
        println!("PASS Rename and unsafe-name rejection");
        Ok::<(), String>(())
    }
    .await;
    let cleaned = sftp::remove(&conn, &remote).await;
    let local_cleaned = std::fs::remove_dir_all(&local);
    cleaned?;
    local_cleaned.map_err(|e| e.to_string())?;
    println!("PASS Isolated remote and local test files cleaned up");
    checks
}

#[tokio::main]
async fn main() {
    let input = match private_input() {
        Ok(input) => input,
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(2);
        }
    };
    let result = async {
        check_pty(&input)?;
        println!("PASS Live application PTY SSH input/output and resize");
        tokio::time::timeout(Duration::from_secs(60), check_sftp(&input))
            .await
            .map_err(|_| "Private SFTP check timed out".to_string())?
    }
    .await;
    if let Err(error) = result {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../artifacts/private");
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(dir.join("remote-smoke-error.txt"), error);
        eprintln!("FAIL Private test; details saved only in artifacts/private.");
        std::process::exit(1);
    }
    println!("PASS All private live checks");
}
