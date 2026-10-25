//! 主机密钥的 TOFU（Trust On First Use）记录 —— 补上 russh 之前缺失的 MITM 防护。
//!
//! 背景：`sftp.rs` 的 `check_server_key` 以前无条件 `Ok(true)`，等于**完全不校验**
//! 服务器主机密钥。公共 Wi-Fi / 局域网里的中间人可以冒充目标服务器。
//!
//! 这里做的是"最小可用"的 known_hosts：
//! - 第一次连 `host:port`：记下公钥的 SHA256 指纹（OpenSSH 风格 `SHA256:<base64>`）+ 时间，放行；
//! - 之后再连同一个 `host:port`：指纹一致放行；**不一致直接拒绝**（连接失败），
//!   由上层把原因带回 UI；
//! - 文件独立成 `known_hosts.json`（不和 settings.json / profiles.json 共用），
//!   写盘时走 `store::write_atomic`，和配置写入共用同一把锁，不会互相踩。
//!
//! 用户确认服务器确实换了密钥后，删掉文件里对应 `host:port` 条目即可（错误信息里会写）。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// 已知主机密钥（一个 `host:port` 一条）。
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KnownHost {
    /// OpenSSH 风格指纹：`SHA256:<base64>`（由 ssh-key 计算，无需自己引 sha2）
    pub fingerprint: String,
    /// 算法名（`ssh-ed25519` / `rsa-sha2-512` …），方便用户判断"是不是换机器了"
    pub key_type: String,
    /// 第一次见到这个主机密钥的时间（Unix 秒）
    pub first_seen: u64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct KnownHostsFile {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    hosts: BTreeMap<String, KnownHost>,
}

/// 一次校验的结果。单测直接断言这个枚举，生产路径见 [`verify`]。
#[derive(Debug, PartialEq, Eq)]
pub enum Verdict {
    /// 已有记录且指纹一致
    Match,
    /// 第一次见到：已把指纹写盘
    New,
    /// 指纹和记录不一致 —— 调用方必须拒绝连接
    Changed { known: String, presented: String },
}

/// 串行化「读-改-写」：两个并发 SSH 连接同时首次见到不同主机时，
/// 不能各写各的、把对方刚记下的条目覆盖掉。
static KNOWN_HOSTS_LOCK: Mutex<()> = Mutex::new(());

/// known_hosts 文件位置：`%APPDATA%\ZeeAI-Terminal\known_hosts.json`。
///
/// 故意和 settings.json / profiles.json 分开：独立文件 = 独立的写路径，
/// 不会和 store 的并发写抢同一个目标。
pub fn known_hosts_file() -> PathBuf {
    // 目录规则和 settings / profiles 共用（`%APPDATA%\ZeeAI-Terminal`），
    // 但文件名单独一个：独立写路径，不和 store 的保存抢同一个目标。
    crate::store::store_dir().join("known_hosts.json")
}

/// 规范化成文件里的 key：小写、去掉末尾的点；IPv6 加方括号避免和端口混淆。
pub fn host_key(host: &str, port: u16) -> String {
    let mut host = host.trim();
    if let Some(inner) = host.strip_prefix('[').and_then(|h| h.strip_suffix(']')) {
        host = inner;
    }
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

/// 公钥指纹：OpenSSH 的 `SHA256:<base64>` 格式（ssh-key 自带实现）。
pub fn fingerprint(key: &russh::keys::PublicKey) -> String {
    key.fingerprint(russh::keys::HashAlg::Sha256).to_string()
}

fn parse_file(bytes: &[u8]) -> Result<KnownHostsFile, String> {
    // 用户可能用记事本打开/另存过，容忍 UTF-8 BOM
    let body = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    serde_json::from_slice(body).map_err(|e| e.to_string())
}

fn read_file(path: &Path) -> Result<KnownHostsFile, String> {
    match std::fs::read(path) {
        Ok(bytes) => parse_file(&bytes),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(KnownHostsFile::default()),
        Err(e) => Err(format!("读取 {} 失败: {e}", path.display())),
    }
}

/// 校验（并可能记录）一个主机密钥。
///
/// 抽成显式 `path` 参数是为了单测能用临时目录，**不碰用户真实的 known_hosts**。
///
/// 返回 `Err` 表示"记录读写不出来"（文件损坏且备份失败、写盘失败等），
/// 由调用方决定放行还是拦截；指纹不一致是 `Ok(Verdict::Changed { .. })`。
pub fn verify_at(
    path: &Path,
    host: &str,
    fingerprint: &str,
    key_type: &str,
    now: u64,
) -> Result<Verdict, String> {
    let _guard = KNOWN_HOSTS_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    let mut file = match read_file(path) {
        Ok(file) => file,
        Err(e) => {
            // 文件坏了不能让所有服务器都连不上：备份留证，然后按"从没记录过"重新 TOFU。
            // 这是安全数据库，宁可重置 + 大声记日志，也不静默覆盖或静默放行。
            let backup = crate::store::backup_broken(path);
            log::error!(
                "known_hosts 读取/解析失败（{e}），已备份为 {:?}，本次按首次信任重新记录",
                backup
            );
            KnownHostsFile::default()
        }
    };

    if let Some(known) = file.hosts.get(host) {
        if known.fingerprint == fingerprint {
            // 一致时**不写盘**：读路径不产生磁盘写，也避免每次连接都刷文件时间
            return Ok(Verdict::Match);
        }
        return Ok(Verdict::Changed {
            known: known.fingerprint.clone(),
            presented: fingerprint.to_string(),
        });
    }

    file.version = 1;
    file.hosts.insert(
        host.to_string(),
        KnownHost {
            fingerprint: fingerprint.to_string(),
            key_type: key_type.to_string(),
            first_seen: now,
        },
    );
    let text = serde_json::to_string_pretty(&file)
        .map_err(|e| format!("序列化 known_hosts 失败: {e}"))?;
    crate::store::write_atomic(path, &text)?;
    Ok(Verdict::New)
}

/// 指纹变化时给用户看的话（必须包含"删哪个文件的哪一条"，否则用户没法自救）。
fn changed_message(path: &Path, host_key: &str, known: &str, presented: &str) -> String {
    format!(
        "{host_key} 的主机密钥变了（记录的是 {known}，这次是 {presented}），\
         可能被中间人劫持，已拒绝连接。如确认是服务器换了密钥，\
         删除 {} 里的 \"{host_key}\" 条目后重试。",
        path.display()
    )
}

/// 生产入口：校验服务器公钥。返回 `None` = 放行；`Some(原因)` = 拒绝（原因给 UI）。
pub fn verify(host: &str, port: u16, key: &russh::keys::PublicKey) -> Option<String> {
    let path = known_hosts_file();
    let host_key = host_key(host, port);
    let presented = fingerprint(key);
    match verify_at(
        &path,
        &host_key,
        &presented,
        key.algorithm().as_str(),
        crate::store::now_secs(),
    ) {
        Ok(Verdict::Match) => None,
        Ok(Verdict::New) => {
            log::info!("known_hosts: 首次记录 {host_key} 的主机密钥 {presented}（TOFU）");
            None
        }
        Ok(Verdict::Changed {
            known,
            presented: now_fp,
        }) => {
            let msg = changed_message(&path, &host_key, &known, &now_fp);
            log::error!("known_hosts: {msg}");
            Some(msg)
        }
        Err(e) => {
            // APPDATA 只读之类的极端情况：记不下来也不能把用户挡在门外，但必须留日志。
            log::error!("known_hosts: 校验 {host_key} 时出错（{e}），本次按首次信任放行");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "zeeai-known-hosts-{}-{tag}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn entries(path: &Path) -> BTreeMap<String, KnownHost> {
        let text = std::fs::read_to_string(path).expect("known_hosts 应该已经写出来了");
        serde_json::from_str::<KnownHostsFile>(&text)
            .expect("写出来的必须是合法 JSON")
            .hosts
    }

    #[test]
    fn first_use_records_fingerprint_then_matches_without_rewriting() {
        let dir = temp_dir("first-use");
        let path = dir.join("known_hosts.json");
        let host = host_key("Example.COM.", 22);
        assert_eq!(host, "example.com:22");

        let v = verify_at(&path, &host, "SHA256:aaa", "ssh-ed25519", 1_700_000_000).unwrap();
        assert_eq!(v, Verdict::New);
        let all = entries(&path);
        assert_eq!(all.len(), 1);
        assert_eq!(all[&host].fingerprint, "SHA256:aaa");
        assert_eq!(all[&host].key_type, "ssh-ed25519");
        assert_eq!(all[&host].first_seen, 1_700_000_000);

        // 二次一致：放行，而且读路径不能写盘（文件内容一个字节都不动）
        let before = std::fs::read_to_string(&path).unwrap();
        let v = verify_at(&path, &host, "SHA256:aaa", "ssh-ed25519", 1_700_000_100).unwrap();
        assert_eq!(v, Verdict::Match);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before, "Match 时不能改写记录");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn changed_fingerprint_is_rejected_and_old_record_survives() {
        let dir = temp_dir("changed");
        let path = dir.join("known_hosts.json");
        let host = host_key("192.0.2.10", 2222);

        verify_at(&path, &host, "SHA256:old", "ssh-ed25519", 1).unwrap();
        let v = verify_at(&path, &host, "SHA256:new", "ssh-rsa", 2).unwrap();
        assert_eq!(
            v,
            Verdict::Changed {
                known: "SHA256:old".into(),
                presented: "SHA256:new".into()
            }
        );
        let all = entries(&path);
        assert_eq!(all[&host].fingerprint, "SHA256:old", "拒绝时绝不能覆盖原记录");
        assert_eq!(all[&host].key_type, "ssh-ed25519");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn different_hosts_accumulate_without_overwriting_each_other() {
        let dir = temp_dir("hosts");
        let path = dir.join("known_hosts.json");

        verify_at(&path, "a:22", "SHA256:a", "ssh-ed25519", 1).unwrap();
        verify_at(&path, "b:22", "SHA256:b", "ssh-rsa", 2).unwrap();
        let all = entries(&path);
        assert_eq!(all.len(), 2);
        assert_eq!(all["a:22"].fingerprint, "SHA256:a");
        assert_eq!(all["b:22"].fingerprint, "SHA256:b");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_file_is_backed_up_then_retofu() {
        let dir = temp_dir("corrupt");
        let path = dir.join("known_hosts.json");
        std::fs::write(&path, b"{not json at all").unwrap();

        let v = verify_at(&path, "h:22", "SHA256:new", "ssh-ed25519", 1).unwrap();
        assert_eq!(v, Verdict::New, "坏文件不能把连接挡死，按首次信任重来");
        let backups: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().starts_with("known_hosts.json.bad-"))
            .collect();
        assert_eq!(backups.len(), 1, "坏文件必须先备份");
        assert_eq!(
            std::fs::read_to_string(backups[0].path()).unwrap(),
            "{not json at all",
            "备份必须原样保留坏内容"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn host_key_normalizes_case_trailing_dot_and_ipv6() {
        assert_eq!(host_key(" host ", 22), "host:22");
        assert_eq!(host_key("EXAMPLE.com.", 22), "example.com:22");
        assert_eq!(host_key("[::1]", 2222), "[::1]:2222");
        assert_eq!(host_key("::1", 2222), "[::1]:2222");
        assert_eq!(host_key("2001:db8::1", 22), "[2001:db8::1]:22");
    }

    #[test]
    fn changed_message_tells_user_how_to_recover() {
        let path = Path::new(r"C:\Users\u\AppData\Roaming\ZeeAI-Terminal\known_hosts.json");
        let msg = changed_message(path, "example.com:22", "SHA256:old", "SHA256:new");
        assert!(msg.contains("主机密钥变了"), "{msg}");
        assert!(msg.contains("可能被中间人劫持"), "{msg}");
        assert!(msg.contains("known_hosts.json"), "必须告诉用户删哪个文件: {msg}");
        assert!(msg.contains("\"example.com:22\""), "必须说明删哪一条: {msg}");
        assert!(msg.contains("SHA256:old") && msg.contains("SHA256:new"), "{msg}");
    }

    #[test]
    fn fingerprint_is_openssh_sha256_format() {
        let key = russh::keys::PublicKey::from_openssh(
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINwzim+vTzqJPrV4HglX07d04i59bkIsUaCNNsJx3QmV zeeai-test",
        )
        .expect("测试公钥必须能解析");
        let fp = fingerprint(&key);
        assert!(fp.starts_with("SHA256:"), "指纹格式不对: {fp}");
        let body = fp.trim_start_matches("SHA256:");
        assert_eq!(body.len(), 43, "SHA256 的 base64（无 padding）应为 43 字符: {fp}");
        assert!(!body.contains('='), "不该带 padding: {fp}");
        assert_eq!(key.algorithm().as_str(), "ssh-ed25519");
    }
}
