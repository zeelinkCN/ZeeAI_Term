//! 远端文件面板：列表 / 预览 / 上传 / 下载 / 增删改。
use base64::Engine as _;

use crate::core::{remote_fs, sftp};

use super::ssh::sftp_for;
use super::util::{human_size, TransferEvent};

/// 列出远端目录（不传 path 则用登录后的家目录）。
/// 走真 SFTP：路径是字面量，不经过远端 shell。
#[tauri::command]
pub async fn fs_list(
    profile_id: String,
    path: Option<String>,
    user_override: Option<String>,
) -> Result<remote_fs::RemoteListing, String> {
    log::info!("ipc: fs_list profile_id={profile_id} path={path:?}");
    // 必须把 user_override 一路带到**连接**上：以前这里只把它给了配置解析，连接仍用默认用户，
    // 于是"临时换用户"之后文件面板列的还是默认用户的家目录（审查 C-03）。
    let conn = sftp_for(&profile_id, user_override).await?;
    let (dir, entries) = sftp::list(&conn, path.as_deref()).await?;
    let listing = remote_fs::RemoteListing {
        path: dir,
        entries: entries
            .into_iter()
            .map(|e| remote_fs::RemoteEntry {
                name: e.name,
                is_dir: e.is_dir,
                size: e.size,
            })
            .collect(),
    };
    log::info!(
        "ipc: fs_list -> {} entries at {}",
        listing.entries.len(),
        listing.path
    );
    Ok(listing)
}

/// 读取文件并返回 base64（二进制安全），最多 max_bytes 字节。
#[tauri::command]
pub async fn fs_read(
    profile_id: String,
    path: String,
    max_bytes: Option<u64>,
    user_override: Option<String>,
) -> Result<String, String> {
    log::info!("ipc: fs_read profile_id={profile_id} path={path}");
    let conn = sftp_for(&profile_id, user_override).await?;
    let limit = max_bytes.unwrap_or(512 * 1024);
    let data = sftp::read_file(&conn, &path, limit).await?;
    Ok(base64::engine::general_purpose::STANDARD.encode(data))
}

/// 上传本地文件（或整个目录）到远端某个目录。返回一句人话结果。
#[tauri::command]
pub async fn fs_upload(
    profile_id: String,
    local_paths: Vec<String>,
    remote_dir: String,
    user_override: Option<String>,
    task_id: Option<String>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    log::info!("ipc: fs_upload -> {} items to {}", local_paths.len(), remote_dir);
    if local_paths.is_empty() {
        return Err("没有选择要上传的文件".into());
    }
    let dir = remote_dir.trim_end_matches('/').to_string();
    let dir = if dir.is_empty() { "/".to_string() } else { dir };
    let conn = sftp_for(&profile_id, user_override).await?;

    let mut done = 0usize;
    let mut bytes = 0u64;
    let task = task_id.unwrap_or_else(|| "upload".to_string());
    let emit = |ev: TransferEvent| {
        use tauri::Emitter;
        let _ = app.emit("zeeai://transfer", ev);
    };
    let mut failed: Vec<String> = Vec::new();
    for lp in &local_paths {
        let p = std::path::Path::new(lp);
        if !p.exists() {
            failed.push(format!("{lp}: 本地不存在"));
            continue;
        }
        let Some(name) = p.file_name().map(|n| n.to_string_lossy().to_string()) else {
            failed.push(format!("{lp}: 无法识别文件名"));
            continue;
        };
        let remote_path = if dir == "/" {
            format!("/{name}")
        } else {
            format!("{dir}/{name}")
        };
        emit(TransferEvent::Start {
            task: task.clone(),
            name: name.clone(),
            total: 0,
        });
        let name_for_sink = name.clone();
        let task_for_sink = task.clone();
        let app_for_sink = app.clone();
        let progress = move |d: u64, t: u64| {
            use tauri::Emitter;
            let _ = app_for_sink.emit(
                "zeeai://transfer",
                TransferEvent::Progress {
                    task: task_for_sink.clone(),
                    name: name_for_sink.clone(),
                    done: d,
                    total: t,
                },
            );
        };
        match sftp::upload(&conn, p, &remote_path, &progress).await {
            Ok(n) => {
                done += 1;
                bytes += n;
                emit(TransferEvent::FileDone {
                    task: task.clone(),
                    name: name.clone(),
                    bytes: n,
                });
            }
            Err(e) => {
                emit(TransferEvent::FileFailed {
                    task: task.clone(),
                    name: name.clone(),
                    message: e.clone(),
                });
                failed.push(format!("{name}: {e}"));
            }
        }
    }

    emit(TransferEvent::AllDone {
        task: task.clone(),
        ok: done,
        failed: failed.len(),
    });

    if failed.is_empty() {
        Ok(format!("已上传 {done} 项（{}）到 {dir}", human_size(bytes)))
    } else if done == 0 {
        Err(format!("上传失败：{}", failed.join("；")))
    } else {
        Ok(format!(
            "已上传 {done} 项，{} 项失败：{}",
            failed.len(),
            failed.join("；")
        ))
    }
}

/// 把远端文件/目录下载到本地某个目录。
#[tauri::command]
pub async fn fs_download(
    profile_id: String,
    remote_paths: Vec<String>,
    local_dir: String,
    user_override: Option<String>,
    task_id: Option<String>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    log::info!("ipc: fs_download -> {} items to {}", remote_paths.len(), local_dir);
    if remote_paths.is_empty() {
        return Err("没有选择要下载的文件".into());
    }
    if !std::path::Path::new(&local_dir).is_dir() {
        return Err(format!("本地目录不存在: {local_dir}"));
    }
    let conn = sftp_for(&profile_id, user_override).await?;

    let mut done = 0usize;
    let mut bytes = 0u64;
    let task = task_id.unwrap_or_else(|| "download".to_string());
    let emit = |ev: TransferEvent| {
        use tauri::Emitter;
        let _ = app.emit("zeeai://transfer", ev);
    };
    let mut failed: Vec<String> = Vec::new();
    for rp in &remote_paths {
        if !sftp::exists(&conn, rp).await {
            failed.push(format!("{rp}: 远端不存在"));
            continue;
        }
        let name = rp
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            .unwrap_or("download")
            .to_string();
        let target = std::path::Path::new(&local_dir).join(&name);
        emit(TransferEvent::Start {
            task: task.clone(),
            name: name.clone(),
            total: 0,
        });
        let task_for_sink = task.clone();
        let name_for_sink = name.clone();
        let app_for_sink = app.clone();
        let progress = move |d: u64, t: u64| {
            use tauri::Emitter;
            let _ = app_for_sink.emit(
                "zeeai://transfer",
                TransferEvent::Progress {
                    task: task_for_sink.clone(),
                    name: name_for_sink.clone(),
                    done: d,
                    total: t,
                },
            );
        };
        match sftp::download(&conn, rp, &target, &progress).await {
            Ok(n) => {
                done += 1;
                bytes += n;
                emit(TransferEvent::FileDone {
                    task: task.clone(),
                    name: name.clone(),
                    bytes: n,
                });
            }
            Err(e) => {
                emit(TransferEvent::FileFailed {
                    task: task.clone(),
                    name: name.clone(),
                    message: e.clone(),
                });
                failed.push(format!("{rp}: {e}"));
            }
        }
    }

    emit(TransferEvent::AllDone {
        task: task.clone(),
        ok: done,
        failed: failed.len(),
    });

    if failed.is_empty() {
        Ok(format!("已下载 {done} 项（{}）到 {local_dir}", human_size(bytes)))
    } else if done == 0 {
        Err(format!("下载失败：{}", failed.join("；")))
    } else {
        Ok(format!(
            "已下载 {done} 项，{} 项失败：{}",
            failed.len(),
            failed.join("；")
        ))
    }
}

#[tauri::command]
pub async fn fs_mkdir(
    profile_id: String,
    path: String,
    user_override: Option<String>,
) -> Result<(), String> {
    log::info!("ipc: fs_mkdir path={path}");
    let conn = sftp_for(&profile_id, user_override).await?;
    sftp::mkdir(&conn, &path).await
}

#[tauri::command]
pub async fn fs_remove(
    profile_id: String,
    path: String,
    user_override: Option<String>,
) -> Result<(), String> {
    log::info!("ipc: fs_remove path={path}");
    let conn = sftp_for(&profile_id, user_override).await?;
    sftp::remove(&conn, &path).await
}

#[tauri::command]
pub async fn fs_rename(
    profile_id: String,
    from: String,
    to: String,
    user_override: Option<String>,
) -> Result<(), String> {
    log::info!("ipc: fs_rename from={from} to={to}");
    let conn = sftp_for(&profile_id, user_override).await?;
    sftp::rename(&conn, &from, &to).await
}
