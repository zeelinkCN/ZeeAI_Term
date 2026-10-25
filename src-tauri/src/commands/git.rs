//! 本地 Git 面板：状态、暂存、提交、历史、分支、diff。
use crate::core::git;

use super::util::run_capture;

/// 在一个目录里 `git init`（目录不存在时可先创建）。
/// 注意：这里只做「本地建仓库」，不会替用户 commit 任何东西。
#[tauri::command]
pub async fn git_init(path: String, create_dir: Option<bool>) -> Result<String, String> {
    let dir = path.trim().trim_end_matches(['\\', '/']).to_string();
    if dir.is_empty() {
        return Err("请填写要创建仓库的目录".into());
    }
    log::info!("ipc: git_init path={dir} create={create_dir:?}");
    let p = std::path::Path::new(&dir);
    if !p.exists() {
        if create_dir.unwrap_or(true) {
            std::fs::create_dir_all(p).map_err(|e| format!("创建目录失败: {e}"))?;
        } else {
            return Err(format!("目录不存在: {dir}"));
        }
    } else if !p.is_dir() {
        return Err(format!("这不是一个目录: {dir}"));
    }
    let args = vec![
        "-C".to_string(),
        dir.clone(),
        "init".to_string(),
        "-b".to_string(),
        "main".to_string(),
    ];
    let git = std::path::Path::new("git");
    // 老版本 git 不支持 `-b main`：**失败**（而不是"起不来"）就退回普通 git init
    let (ok, out) = match run_capture(git, &args).await {
        Ok((true, o)) => (true, o),
        _ => {
            let fallback = vec!["-C".to_string(), dir.clone(), "init".to_string()];
            run_capture(git, &fallback).await?
        }
    };
    if !ok {
        let msg = out.trim().to_string();
        return Err(if msg.is_empty() {
            "git init 失败（本机需要安装 Git）".to_string()
        } else {
            format!("git init 失败：{msg}")
        });
    }
    let text = out.trim().to_string();
    log::info!("ipc: git_init -> {text}");
    Ok(text)
}

#[tauri::command]
pub async fn git_status(path: String) -> Result<git::GitStatus, String> {
    log::info!("ipc: git_status path={path}");
    let args = vec![
        "-C".to_string(),
        path.clone(),
        "status".to_string(),
        "--porcelain=v1".to_string(),
        "-b".to_string(),
    ];
    // 一个"不是仓库 / 没装 git"的 GitStatus，message 由调用方给
    let failed = |message: String| git::GitStatus {
        ok: false,
        branch: String::new(),
        upstream: String::new(),
        ahead: 0,
        behind: 0,
        files: Vec::new(),
        message,
    };
    match run_capture(std::path::Path::new("git"), &args).await {
        Ok((ok, out)) => {
            let text = out.trim();
            // `git status` 在"不是仓库"时是**非零退出**，但那种情况要给出比报错更有用的一句话
            if !ok && text.contains("not a git repository") {
                return Ok(failed("这个目录不是 Git 仓库".into()));
            }
            if !ok {
                return Ok(failed(if text.is_empty() {
                    "执行 git 失败（本机需要安装 Git）".into()
                } else {
                    format!(
                        "执行 git 失败：{}",
                        text.lines().take(3).collect::<Vec<_>>().join(" / ")
                    )
                }));
            }
            let mut status = git::parse_status(&out);
            if status.branch.is_empty() && status.files.is_empty() {
                status.message = if text.is_empty() {
                    "仓库干净，没有改动".into()
                } else {
                    text.lines().take(3).collect::<Vec<_>>().join(" / ")
                };
            }
            Ok(status)
        }
        Err(e) => Ok(failed(format!("执行 git 失败（本机需要安装 Git）: {e}"))),
    }
}

/// 跑一条 git 子命令；失败时把 git 的报错原样抛出去（前端直接显示）。
async fn git_run(repo: &str, args: &[&str]) -> Result<String, String> {
    let mut full: Vec<String> = vec!["-C".into(), repo.to_string()];
    full.extend(args.iter().map(|s| s.to_string()));
    let (ok, text) = run_capture(std::path::Path::new("git"), &full).await?;
    if ok {
        Ok(text)
    } else {
        let msg = text.trim().to_string();
        Err(if msg.is_empty() {
            "git 执行失败（本机需要安装 Git）".to_string()
        } else {
            msg
        })
    }
}

/// 暂存：files 为空表示全部（git add -A）
#[tauri::command]
pub async fn git_add(path: String, files: Option<Vec<String>>) -> Result<(), String> {
    log::info!("ipc: git_add path={path} files={:?}", files);
    match files.filter(|f| !f.is_empty()) {
        Some(files) => {
            let mut args: Vec<String> =
                vec!["-C".into(), path.clone(), "add".into(), "--".into()];
            args.extend(files);
            let (ok, text) = run_capture(std::path::Path::new("git"), &args).await?;
            if ok {
                Ok(())
            } else {
                Err(text.trim().to_string())
            }
        }
        None => git_run(&path, &["add", "-A"]).await.map(|_| ()),
    }
}

/// 取消暂存（git restore --staged）
#[tauri::command]
pub async fn git_unstage(path: String, files: Vec<String>) -> Result<(), String> {
    log::info!("ipc: git_unstage {} files", files.len());
    if files.is_empty() {
        return git_run(&path, &["reset"]).await.map(|_| ());
    }
    let mut args: Vec<&str> = vec!["restore", "--staged", "--"];
    for f in &files {
        args.push(f);
    }
    git_run(&path, &args).await.map(|_| ())
}

/// 丢弃工作区改动（危险：会覆盖未提交的修改）
#[tauri::command]
pub async fn git_discard(path: String, files: Vec<String>) -> Result<(), String> {
    log::info!("ipc: git_discard {} files", files.len());
    let mut args: Vec<&str> = vec!["restore", "--"];
    for f in &files {
        args.push(f);
    }
    git_run(&path, &args).await.map(|_| ())
}

/// 提交（提交信息不能为空）
#[tauri::command]
pub async fn git_commit(path: String, message: String) -> Result<String, String> {
    log::info!("ipc: git_commit path={path}");
    if message.trim().is_empty() {
        return Err("提交信息不能为空".into());
    }
    git_run(&path, &["commit", "-m", message.trim()]).await
}

/// 最近提交历史
#[tauri::command]
pub async fn git_log(path: String, limit: Option<u32>) -> Result<Vec<git::GitCommit>, String> {
    let n = limit.unwrap_or(30).to_string();
    let out = git_run(
        &path,
        &[
            "log",
            "--no-color",
            &format!("-n{n}"),
            "--pretty=format:%H%x09%h%x09%an%x09%ar%x09%s",
        ],
    )
    .await?;
    Ok(git::parse_log(&out))
}

/// 本地分支列表
#[tauri::command]
pub async fn git_branches(path: String) -> Result<Vec<git::GitBranch>, String> {
    let out = git_run(
        &path,
        &[
            "branch",
            "--no-color",
            "--format=%(refname:short)%09%(HEAD)%09%(upstream:short)%09%(committerdate:relative)",
        ],
    )
    .await?;
    Ok(git::parse_branches(&out))
}

/// 切换分支；create=true 时新建并切换
#[tauri::command]
pub async fn git_checkout(
    path: String,
    branch: String,
    create: Option<bool>,
) -> Result<String, String> {
    log::info!("ipc: git_checkout {branch} create={create:?}");
    if create.unwrap_or(false) {
        git_run(&path, &["checkout", "-b", branch.trim()]).await
    } else {
        let tracked = git_run(&path, &["checkout", branch.trim()]).await;
        match tracked {
            Ok(out) => Ok(out),
            // 本地没有这个分支时，尝试从远端同名分支建一个跟踪分支
            Err(e) => {
                let remote = format!("origin/{}", branch.trim());
                match git_run(&path, &["checkout", "-b", branch.trim(), &remote]).await {
                    Ok(out) => Ok(out),
                    Err(_) => Err(e),
                }
            }
        }
    }
}

/// 看某个文件相对 HEAD 的 diff（staged=true 时看已暂存的 diff）
#[tauri::command]
pub async fn git_diff(path: String, file: String, staged: Option<bool>) -> Result<String, String> {
    let args: Vec<&str> = if staged.unwrap_or(false) {
        vec!["diff", "--cached", "--no-color", "--", file.as_str()]
    } else {
        vec!["diff", "--no-color", "--", file.as_str()]
    };
    git_run(&path, &args).await
}

/// 看某次提交的完整 diff（git show）
#[tauri::command]
pub async fn git_show(path: String, rev: String) -> Result<String, String> {
    git_run(&path, &["show", "--no-color", "--stat", "--patch", rev.trim()]).await
}
