//! herdr 一键安装：Windows 侧下载 → sha256 校验 → scp 到 ~/.local/bin → 自检回滚。
use serde::Serialize;
use tauri::ipc::Channel;

use crate::core::{herdr, proc, ssh};

use super::ssh::{run_remote_capture, run_scp, ssh_config_for};
use super::util::{
    find_curl, run_curl_download, sha256_of, short_sha, system_proxy,
};

/// 一键安装 herdr 的结果（前端拿去显示"装了什么版本、来自哪、校验对不对"）
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HerdrInstallReport {
    pub version: String,
    pub protocol: u32,
    pub platform: String,
    pub source: String,
    pub sha256: String,
    pub bytes: u64,
    pub path: String,
}

/// 一键安装 herdr：**Windows 侧下载 → 校验 → scp 上去**。
///
/// 几条硬规矩（用户明确要求过，这里逐条落地）：
/// 1. **不下错**：版本号和 sha256 都取自官方 `latest.json`；官方直链失败才退到镜像，
///    但**不管是官方还是镜像，都按同一份 sha256 校验**，对不上就删掉换下一个来源；
/// 2. **不乱装**：绝不执行远端安装脚本、绝不 sudo、不碰系统目录；只放进 `~/.local/bin`，
///    而且**已经有一个能用的 herdr 就不覆盖**（宁可报错让用户决定）；
/// 3. **可回滚**：装完做一次只读自检（`--version` + 协议号），不达标就把刚装的文件删掉；
/// 4. 每一步都往状态栏回一条进度，失败时把原因原样带出来（前端直接显示）。
#[tauri::command]
pub async fn herdr_install(
    profile_id: String,
    user_override: Option<String>,
    on_progress: Channel<String>,
) -> Result<HerdrInstallReport, String> {
    herdr_install_inner(profile_id, user_override, move |s: &str| {
        let _ = on_progress.send(s.to_string());
    })
    .await
}

/// 安装进度的小包装：既写日志，也交给调用方（界面通道 / 自检）。
/// 用 `Arc` 包一层是因为下载那一段要丢到阻塞线程里跑，而回调得跟着进那个线程。
struct Say<F: Fn(&str)>(std::sync::Arc<F>);

impl<F: Fn(&str)> Clone for Say<F> {
    fn clone(&self) -> Self {
        Say(self.0.clone())
    }
}

impl<F: Fn(&str)> Say<F> {
    fn say(&self, s: &str) {
        log::info!("herdr_install: {s}");
        (self.0)(s);
    }
}

/// [`herdr_install`] 的实现体（**故意**和命令壳分开）。
///
/// 分开的原因：进度通道是给界面看的，而自检（`ZEEAI_SELFTEST_HERDR=1`）需要在不建
/// Channel 的情况下把整条链路跑一遍。把进度回调抽成 `Fn(&str)`，两边就都能用了 ——
/// 这样"我验证过的"和"用户点按钮跑到的"是**同一段代码**，不是两套。
pub(crate) async fn herdr_install_inner<F: Fn(&str) + Send + Sync + 'static>(
    profile_id: String,
    user_override: Option<String>,
    say: F,
) -> Result<HerdrInstallReport, String> {
    let cfg = ssh_config_for(&profile_id, user_override.clone())?;
    let effective_user = user_override
        .as_ref()
        .map(|u| u.trim().to_string())
        .filter(|u| !u.is_empty())
        .unwrap_or_else(|| cfg.user.clone());
    let say = Say(std::sync::Arc::new(say));

    // ---- 0) 这台机器是什么平台 ----
    say.say("正在读取服务器平台…");
    let uname = run_remote_capture(&profile_id, &cfg, &herdr::uname_command()).await?;
    let platform = herdr::platform_key(&uname)
        .ok_or_else(|| format!("这台机器的平台不支持一键安装：{}", uname.trim()))?;
    if !herdr::is_supported_platform(&platform) {
        return Err(format!("一键安装目前只支持 Linux 服务器（这台是 {platform}）"));
    }

    // ---- 1) 已经装了就不动它 ----
    let existing = run_remote_capture(&profile_id, &cfg, &herdr::installed_check_command()).await?;
    if let Some((ver, proto)) = herdr::parse_installed(&existing) {
        if proto >= herdr::MIN_PROTOCOL {
            return Err(format!(
                "这台机器上已经有 herdr {ver}（协议 {proto}），不覆盖。要升级请在服务器上自己执行 herdr update"
            ));
        }
        say.say(&format!("发现 herdr {ver} 太旧（协议 {proto}），继续安装新版"));
    }

    // ---- 2) 官方清单 ----
    say.say("正在读取 herdr 官方版本清单（herdr.dev）…");
    let curl = find_curl()
        .ok_or_else(|| "找不到系统自带的 curl.exe，请手动下载安装".to_string())?;
    let manifest_text = curl_text(&curl, herdr::LATEST_MANIFEST_URL, 30)?;
    let manifest = herdr::parse_manifest(&manifest_text)?;
    let asset = manifest
        .asset(&platform)
        .ok_or_else(|| format!("官方清单里没有 {platform} 这个平台的产物"))?
        .to_string();
    let want_sha = manifest
        .sha(&platform)
        .ok_or_else(|| "官方清单里没给 sha256，拒绝安装（不敢赌下到的是什么）".to_string())?
        .to_string();
    if manifest.protocol > 0 && manifest.protocol < herdr::MIN_PROTOCOL {
        say.say(&format!(
            "注意：官方最新版协议 {}  低于我们实测的 {}，装完可能不兼容",
            manifest.protocol,
            herdr::MIN_PROTOCOL
        ));
    }
    say.say(&format!(
        "官方最新版 herdr {}（协议 {}，sha256 {}…）",
        manifest.version,
        manifest.protocol,
        short_sha(&want_sha, 12)
    ));

    // ---- 3) 在 Windows 侧下载（官方不通就走镜像，校验标准不变） ----
    let dir = std::env::temp_dir().join("zeeai-herdr");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建缓存目录失败: {e}"))?;
    let dest = dir.join(format!("herdr-{}-{platform}", manifest.version));
    let candidates = herdr::sources(&asset);
    let proxy = system_proxy();
    // 下载整段放到阻塞线程里：它可能要跑几分钟，放在 async 运行时的 worker 上会拖住别的命令
    let (bytes, got_from) = {
        let curl = curl.clone();
        let dest = dest.clone();
        let want_sha = want_sha.clone();
        let proxy = proxy.clone();
        let progress = say.clone();
        let candidates = candidates.clone();
        tokio::task::spawn_blocking(move || -> Result<(u64, String), String> {
            if dest.exists() {
                let have = sha256_of(&dest).unwrap_or_default();
                if have == want_sha {
                    let n = std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
                    return Ok((n, "本地缓存（校验一致）".to_string()));
                }
                let _ = std::fs::remove_file(&dest);
            }
            let mut last_err = String::new();
            for src in &candidates {
                // 每个来源先直连、再试系统代理（不少用户是靠本地代理访问 GitHub 的）
                for (tag, p) in [("直连", None), ("系统代理", proxy.as_deref())] {
                    if tag == "系统代理" && proxy.is_none() {
                        continue;
                    }
                    progress.say(&format!("正在下载（{}·{}）…", src.label, tag));
                    let _ = std::fs::remove_file(&dest);
                    let mut last_mb = 0u64;
                    let r = run_curl_download(
                        &curl,
                        &src.url,
                        &dest,
                        0,
                        p,
                        false,
                        &mut |done, _total| {
                            // 跨过 1MB 才回一条进度，免得状态栏被刷屏
                            if done / 1_048_576 > last_mb {
                                last_mb = done / 1_048_576;
                                progress.say(&format!(
                                    "下载中（{}）：{} MB",
                                    src.label, last_mb
                                ));
                            }
                        },
                    );
                    match r {
                        Ok(()) => {
                            let have = sha256_of(&dest).unwrap_or_default();
                            if have != want_sha {
                                last_err = format!(
                                    "{}·{} 下到的文件 sha256 和官方不一致（拿到 {}…），已丢弃",
                                    src.label,
                                    tag,
                                    short_sha(&have, 12)
                                );
                                let _ = std::fs::remove_file(&dest);
                                continue;
                            }
                            let n = std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
                            return Ok((n, format!("{}·{}", src.label, tag)));
                        }
                        Err(e) => last_err = format!("{}·{} 失败：{e}", src.label, tag),
                    }
                }
            }
            Err(format!(
                "所有下载来源都没成功（最后一个：{last_err}）。可以稍后重试，或手动下载后在服务器上安装"
            ))
        })
        .await
        .map_err(|e| format!("下载线程失败: {e}"))??
    };
    let pct = format!("{:.1} MB", bytes as f64 / 1_048_576.0);
    say.say(&format!("下载完成（{got_from}，{pct}，sha256 已核对）"));

    // ---- 4) scp 上去 + chmod + 只读自检 ----
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let tmp = format!("/tmp/zeeai-herdr-{stamp}");
    say.say("正在上传到服务器（scp → /tmp）…");
    let scp_args = ssh::scp_args(
        cfg.port,
        cfg.key_path.as_deref(),
        false,
        &dest.to_string_lossy(),
        &ssh::scp_remote(&cfg.host, &effective_user, &tmp),
    );
    run_scp(&scp_args).await?;

    say.say("正在安装到 ~/.local/bin/herdr（不需要 root）…");
    let install_cmd = format!(
        "set -e; mkdir -p \"$HOME/.local/bin\"; install -m 755 '{tmp}' \"$HOME/.local/bin/herdr\"; rm -f '{tmp}'; {}",
        herdr::installed_check_command()
    );
    let out = run_remote_capture(&profile_id, &cfg, &install_cmd).await?;
    let parsed = herdr::parse_installed(&out);

    // ---- 5) 自检不过就回滚 ----
    let Some((ver, proto)) = parsed else {
        let _ = run_remote_capture(
            &profile_id,
            &cfg,
            "rm -f \"$HOME/.local/bin/herdr\"; printf 'rolled back\\n'",
        )
        .await;
        return Err(format!(
            "装完后自检没通过（herdr --version 拿不到版本），已把刚放上去的文件删掉。远端原话：{}",
            out.trim()
        ));
    };
    if proto < herdr::MIN_PROTOCOL {
        let _ = run_remote_capture(
            &profile_id,
            &cfg,
            "rm -f \"$HOME/.local/bin/herdr\"; printf 'rolled back\\n'",
        )
        .await;
        return Err(format!(
            "装上的 herdr {ver} 协议号 {proto} 低于我们支持的下限 {}，已回滚",
            herdr::MIN_PROTOCOL
        ));
    }
    say.say(&format!("安装完成：herdr {ver}（协议 {proto}）"));
    Ok(HerdrInstallReport {
        version: ver,
        protocol: proto,
        platform,
        source: got_from,
        sha256: want_sha,
        bytes,
        path: "$HOME/.local/bin/herdr".into(),
    })
}

/// 用 curl 取一小段文本（清单文件只有几十 KB）。失败时带出 curl 的原话。
///
/// 注意：curl 的报错本身是英文，这里统一加一句中文动作前缀（架构审查 minor-14：
/// 界面上不该突然蹦出一整行英文），原文保留在后面方便排查。
fn curl_text(curl: &std::path::Path, url: &str, timeout_secs: u64) -> Result<String, String> {
    let out = proc::hidden_command(curl)
        .args([
            "-fsSL",
            "--connect-timeout",
            "15",
            "--max-time",
            &timeout_secs.to_string(),
            url,
        ])
        .output()
        .map_err(|e| format!("启动 curl 失败（读 {url}）：{e}"))?;
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    if out.status.success() && !text.trim().is_empty() {
        return Ok(text);
    }
    let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
    Err(if err.is_empty() {
        format!("下载 {url} 失败（curl 退出码 {:?}）", out.status.code())
    } else {
        format!("下载 {url} 失败（curl 原话：{err}）")
    })
}
