//! 真正的 SFTP 通道（纯 Rust：russh + russh-sftp），不再借道 scp。
//!
//! 为什么换掉 scp：
//! - scp 走的是老 SCP 协议，远端路径要被远端 shell 解释，空格/特殊字符要靠引号硬凑，
//!   还踩过 "filename does not match request" 的坑；
//! - SFTP 是 SSH_FXP 协议，路径是字面量，不经过 shell，天然安全；
//! - 以后做上传/下载进度条、断点续传，SFTP 才能按块读写（scp 只能黑盒等）。

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use russh::client::{self, Handle};
use russh_sftp::client::SftpSession;
use serde::Serialize;

/// 单块读写大小（以后做进度/续传就靠它切分）
const CHUNK: usize = 64 * 1024;

/// 传输进度回调：(已传字节, 总字节)。总字节可能是估算值（目录会边算边传）。
pub type ProgressSink<'a> = &'a (dyn Fn(u64, u64) + Send + Sync);

/// 什么都不做的回调（不需要进度时用）
pub fn no_progress(_done: u64, _total: u64) {}

pub struct Client;

impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &russh::keys::ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        // 和终端那边保持一致：首次连接直接信任（StrictHostKeyChecking=accept-new 的等价行为）
        Ok(true)
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpEntry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
}

pub struct SftpConn {
    pub session: Handle<Client>,
    pub sftp: SftpSession,
}

/// 候选密钥：配置里指定的 → id_ed25519 → id_rsa → id_ecdsa
fn key_candidates(key_path: Option<&str>) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    if let Some(k) = key_path.filter(|k| !k.trim().is_empty()) {
        out.push(PathBuf::from(k.trim()));
    }
    if let Ok(home) = std::env::var("USERPROFILE") {
        for name in ["id_ed25519", "id_rsa", "id_ecdsa"] {
            out.push(Path::new(&home).join(".ssh").join(name));
        }
    }
    out
}

/// 建立一条 SFTP 连接：先试密码（如果给了），再试各个密钥文件。
pub async fn connect(
    host: &str,
    port: u16,
    user: &str,
    key_path: Option<&str>,
    password: Option<&str>,
) -> Result<SftpConn, String> {
    let config = Arc::new(client::Config {
        inactivity_timeout: Some(Duration::from_secs(60)),
        ..Default::default()
    });
    let mut session = client::connect(config, (host, port), Client)
        .await
        .map_err(|e| format!("连接 {host}:{port} 失败: {e}"))?;

    let mut authed = false;

    if let Some(pwd) = password.filter(|p| !p.is_empty()) {
        match session.authenticate_password(user, pwd).await {
            Ok(res) if res.success() => authed = true,
            Ok(_) => {}
            Err(e) => log::warn!("sftp 密码认证失败: {e}"),
        }
    }

    if !authed {
        for kp in key_candidates(key_path) {
            if !kp.exists() {
                continue;
            }
            let key = match russh::keys::load_secret_key(&kp, None) {
                Ok(k) => k,
                Err(e) => {
                    log::warn!("读取密钥 {:?} 失败: {e}", kp);
                    continue;
                }
            };
            let key_pair = russh::keys::PrivateKeyWithHashAlg::new(Arc::new(key), None);
            match session.authenticate_publickey(user, key_pair).await {
                Ok(res) if res.success() => {
                    authed = true;
                    break;
                }
                Ok(_) => {}
                Err(e) => log::warn!("密钥认证失败（{:?}）: {e}", kp),
            }
        }
    }

    if !authed {
        return Err("认证失败：没有可用的密钥，也没有提供密码".into());
    }

    let channel = session
        .channel_open_session()
        .await
        .map_err(|e| format!("打开通道失败: {e}"))?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| format!("服务器不支持 SFTP 子系统: {e}"))?;
    let sftp = SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| format!("初始化 SFTP 失败: {e}"))?;

    Ok(SftpConn { session, sftp })
}

/// 列目录；path 为空时用登录后的家目录
pub async fn list(conn: &SftpConn, path: Option<&str>) -> Result<(String, Vec<SftpEntry>), String> {
    let dir = match path.map(str::trim).filter(|p| !p.is_empty()) {
        Some(p) => p.to_string(),
        None => conn
            .sftp
            .canonicalize(".")
            .await
            .map_err(|e| format!("取家目录失败: {e}"))?,
    };
    let raw = conn
        .sftp
        .read_dir(&dir)
        .await
        .map_err(|e| format!("读取目录 {dir} 失败: {e}"))?;

    let mut entries: Vec<SftpEntry> = raw
        .map(|e| {
            let name = e.file_name();
            let md = e.metadata();
            SftpEntry {
                is_dir: md.is_dir(),
                size: md.size.unwrap_or(0),
                name,
            }
        })
        .filter(|e| e.name != "." && e.name != "..")
        .collect();
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok((dir, entries))
}

/// 读远端文件（最多 max 字节）
pub async fn read_file(conn: &SftpConn, path: &str, max: u64) -> Result<Vec<u8>, String> {
    use tokio::io::AsyncReadExt;
    let mut f = conn
        .sftp
        .open(path)
        .await
        .map_err(|e| format!("打开 {path} 失败: {e}"))?;
    let mut buf = Vec::new();
    let mut chunk = vec![0u8; CHUNK];
    loop {
        let n = f
            .read(&mut chunk)
            .await
            .map_err(|e| format!("读取 {path} 失败: {e}"))?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
        if buf.len() as u64 >= max {
            buf.truncate(max as usize);
            break;
        }
    }
    Ok(buf)
}

/// 把本地文件写到远端，按 64KB 分块并回调进度。
/// `offset` 用于断点续传：远端已有这么多字节时，从这里继续追加。
async fn write_remote_stream(
    conn: &SftpConn,
    remote: &str,
    path: &Path,
    offset: u64,
    base_done: u64,
    total: u64,
    sink: ProgressSink<'_>,
) -> Result<u64, String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|e| format!("打开本地文件失败: {e}"))?;
    if offset > 0 {
        use tokio::io::AsyncSeekExt;
        file.seek(std::io::SeekFrom::Start(offset))
            .await
            .map_err(|e| format!("定位本地文件失败: {e}"))?;
    }

    let mut f = if offset > 0 {
        conn.sftp
            .open_with_flags(
                remote,
                russh_sftp::protocol::OpenFlags::WRITE | russh_sftp::protocol::OpenFlags::APPEND,
            )
            .await
            .map_err(|e| format!("打开远端文件（续传）失败: {e}"))?
    } else {
        conn.sftp
            .create(remote)
            .await
            .map_err(|e| format!("创建 {remote} 失败: {e}"))?
    };

    let mut done = base_done;
    let mut buf = vec![0u8; CHUNK];
    loop {
        let n = file
            .read(&mut buf)
            .await
            .map_err(|e| format!("读本地文件失败: {e}"))?;
        if n == 0 {
            break;
        }
        f.write_all(&buf[..n])
            .await
            .map_err(|e| format!("写入 {remote} 失败: {e}"))?;
        done += n as u64;
        sink(done, total.max(done));
    }
    f.flush().await.map_err(|e| format!("刷新 {remote} 失败: {e}"))?;
    let _ = f.shutdown().await;
    Ok(done - base_done)
}

/// 预先算一下本地文件/目录一共多少字节（给进度条用）
fn local_size(path: &Path) -> u64 {
    if path.is_dir() {
        let mut sum = 0u64;
        if let Ok(rd) = std::fs::read_dir(path) {
            for e in rd.flatten() {
                sum += local_size(&e.path());
            }
        }
        sum
    } else {
        std::fs::metadata(path).map(|m| m.len()).unwrap_or(0)
    }
}

/// 上传本地文件或目录（目录递归），带进度回调。
/// 远端已存在且比本地短时，会从断点继续（断点续传）。
pub async fn upload(
    conn: &SftpConn,
    local: &Path,
    remote: &str,
    sink: ProgressSink<'_>,
) -> Result<u64, String> {
    let total = local_size(local);
    upload_inner(conn, local, remote, total, 0, sink).await
}

async fn upload_inner(
    conn: &SftpConn,
    local: &Path,
    remote: &str,
    total: u64,
    done: u64,
    sink: ProgressSink<'_>,
) -> Result<u64, String> {
    if local.is_dir() {
        let _ = conn.sftp.create_dir(remote).await; // 已存在会报错，忽略
        let mut rd = tokio::fs::read_dir(local)
            .await
            .map_err(|e| format!("读取本地目录失败: {e}"))?;
        let mut sent = 0u64;
        let mut acc = done;
        while let Some(entry) = rd
            .next_entry()
            .await
            .map_err(|e| format!("遍历本地目录失败: {e}"))?
        {
            let name = entry.file_name().to_string_lossy().to_string();
            let child_remote = format!("{}/{}", remote.trim_end_matches('/'), name);
            let n = Box::pin(upload_inner(
                conn,
                &entry.path(),
                &child_remote,
                total,
                acc,
                sink,
            ))
            .await?;
            sent += n;
            acc += n;
        }
        return Ok(sent);
    }

    let local_len = std::fs::metadata(local).map(|m| m.len()).unwrap_or(0);
    // 断点续传：远端已有前缀就接着写
    let mut offset = 0u64;
    if let Ok(md) = conn.sftp.metadata(remote).await {
        let remote_len = md.size.unwrap_or(0);
        if remote_len > 0 && remote_len < local_len {
            offset = remote_len;
            log::info!("sftp 续传 {remote}: 从 {offset} 字节继续");
        }
    }
    let written = write_remote_stream(conn, remote, local, offset, done + offset, total, sink).await?;
    Ok(written)
}

/// 先递归算远端总大小（进度条用）
async fn remote_size(conn: &SftpConn, remote: &str) -> u64 {
    match conn.sftp.metadata(remote).await {
        Ok(md) if md.is_dir() => {
            let mut sum = 0u64;
            if let Ok(raw) = conn.sftp.read_dir(remote).await {
                for e in raw {
                    let name = e.file_name();
                    if name == "." || name == ".." {
                        continue;
                    }
                    let child = format!("{}/{}", remote.trim_end_matches('/'), name);
                    sum += Box::pin(remote_size(conn, &child)).await;
                }
            }
            sum
        }
        Ok(md) => md.size.unwrap_or(0),
        Err(_) => 0,
    }
}

/// 下载远端文件或目录到本地（目录递归），带进度回调 + 断点续传
pub async fn download(
    conn: &SftpConn,
    remote: &str,
    local: &Path,
    sink: ProgressSink<'_>,
) -> Result<u64, String> {
    let total = remote_size(conn, remote).await;
    download_inner(conn, remote, local, total, 0, sink).await
}

async fn download_inner(
    conn: &SftpConn,
    remote: &str,
    local: &Path,
    total: u64,
    done: u64,
    sink: ProgressSink<'_>,
) -> Result<u64, String> {
    let md = conn
        .sftp
        .metadata(remote)
        .await
        .map_err(|e| format!("远端不存在或读不到: {e}"))?;

    if md.is_dir() {
        tokio::fs::create_dir_all(local)
            .await
            .map_err(|e| format!("创建本地目录失败: {e}"))?;
        let raw = conn
            .sftp
            .read_dir(remote)
            .await
            .map_err(|e| format!("读取远端目录失败: {e}"))?;
        let mut sent = 0u64;
        let mut acc = done;
        for e in raw {
            let name = e.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let child_remote = format!("{}/{}", remote.trim_end_matches('/'), name);
            let n = Box::pin(download_inner(
                conn,
                &child_remote,
                &local.join(&name),
                total,
                acc,
                sink,
            ))
            .await?;
            sent += n;
            acc += n;
        }
        return Ok(sent);
    }

    if let Some(parent) = local.parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
    }
    // 断点续传：本地已有前缀就接着下
    let local_len = std::fs::metadata(local).map(|m| m.len()).unwrap_or(0);
    let remote_len = md.size.unwrap_or(0);
    let offset = if local_len > 0 && local_len < remote_len {
        log::info!("sftp 续传下载 {remote}: 从 {local_len} 字节继续");
        local_len
    } else if local_len == remote_len && remote_len > 0 {
        // 已经下完了，直接算完成
        sink(done + remote_len, total.max(done + remote_len));
        return Ok(0);
    } else {
        0
    };
    read_to_local(conn, remote, local, offset, done + offset, total, sink).await
}

/// 从远端读一段并追加写到本地，边写边报进度
async fn read_to_local(
    conn: &SftpConn,
    remote: &str,
    local: &Path,
    offset: u64,
    base_done: u64,
    total: u64,
    sink: ProgressSink<'_>,
) -> Result<u64, String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut f = conn
        .sftp
        .open(remote)
        .await
        .map_err(|e| format!("打开 {remote} 失败: {e}"))?;
    if offset > 0 {
        use tokio::io::AsyncSeekExt;
        f.seek(std::io::SeekFrom::Start(offset))
            .await
            .map_err(|e| format!("定位远端文件失败: {e}"))?;
    }
    let mut out = tokio::fs::OpenOptions::new()
        .create(true)
        .append(offset > 0)
        .write(true)
        .truncate(offset == 0)
        .open(local)
        .await
        .map_err(|e| format!("打开本地文件失败: {e}"))?;

    let mut done = base_done;
    let mut buf = vec![0u8; CHUNK];
    let mut written = 0u64;
    loop {
        let n = f
            .read(&mut buf)
            .await
            .map_err(|e| format!("读取 {remote} 失败: {e}"))?;
        if n == 0 {
            break;
        }
        out.write_all(&buf[..n])
            .await
            .map_err(|e| format!("写入本地文件失败: {e}"))?;
        done += n as u64;
        written += n as u64;
        sink(done, total.max(done));
    }
    out.flush().await.map_err(|e| format!("刷新本地文件失败: {e}"))?;
    Ok(written)
}

pub async fn mkdir(conn: &SftpConn, path: &str) -> Result<(), String> {
    conn.sftp
        .create_dir(path)
        .await
        .map_err(|e| format!("新建目录失败: {e}"))
}

/// 删除文件或目录（目录递归删）
pub async fn remove(conn: &SftpConn, path: &str) -> Result<(), String> {
    let md = conn
        .sftp
        .metadata(path)
        .await
        .map_err(|e| format!("读不到 {path}: {e}"))?;
    if md.is_dir() {
        let raw = conn
            .sftp
            .read_dir(path)
            .await
            .map_err(|e| format!("读取目录失败: {e}"))?;
        for e in raw {
            let name = e.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let child = format!("{}/{}", path.trim_end_matches('/'), name);
            Box::pin(remove(conn, &child)).await?;
        }
        conn.sftp
            .remove_dir(path)
            .await
            .map_err(|e| format!("删除目录失败: {e}"))
    } else {
        conn.sftp
            .remove_file(path)
            .await
            .map_err(|e| format!("删除文件失败: {e}"))
    }
}

pub async fn rename(conn: &SftpConn, from: &str, to: &str) -> Result<(), String> {
    conn.sftp
        .rename(from, to)
        .await
        .map_err(|e| format!("重命名失败: {e}"))
}

pub async fn exists(conn: &SftpConn, path: &str) -> bool {
    conn.sftp.metadata(path).await.is_ok()
}
