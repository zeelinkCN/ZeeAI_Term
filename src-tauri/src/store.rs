use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfig {
    pub host: String,
    pub port: u16,
    pub user: String,
    #[serde(default = "default_auth_kind")]
    pub auth_kind: String,
    #[serde(default)]
    pub key_path: Option<String>,
    #[serde(default = "default_true")]
    pub tmux_enabled: bool,
    #[serde(default = "default_tmux_template")]
    pub tmux_template: String,
    #[serde(default)]
    pub start_dir: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialConfig {
    pub path: String,
    pub baud_rate: u32,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalConfig {
    pub shell: String,
    #[serde(default)]
    pub distro: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionProfile {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub name: String,
    #[serde(default = "default_group")]
    pub group: String,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub ssh: Option<SshConfig>,
    #[serde(default)]
    pub serial: Option<SerialConfig>,
    #[serde(default)]
    pub local: Option<LocalConfig>,
}

fn default_auth_kind() -> String {
    "key".into()
}
fn default_true() -> bool {
    true
}
fn default_tmux_template() -> String {
    "{host}-{user}".into()
}
fn default_group() -> String {
    "默认".into()
}

fn store_dir() -> PathBuf {
    let base = std::env::var("APPDATA").unwrap_or_else(|_| ".".into());
    PathBuf::from(base).join("ZeeAI-Terminal")
}

fn store_file() -> PathBuf {
    store_dir().join("profiles.json")
}

/// 首次运行时写入一条测试服务器，方便直接试用（可在界面里删除/修改）。
fn seed() -> Vec<ConnectionProfile> {
    vec![ConnectionProfile {
        id: "seed-test-server".into(),
        kind: "ssh".into(),
        name: "测试服务器".into(),
        group: "默认".into(),
        color: None,
        ssh: Some(SshConfig {
            host: "203.0.113.10".into(),
            port: 22,
            user: "root".into(),
            auth_kind: "key".into(),
            key_path: None,
            tmux_enabled: true,
            tmux_template: "{host}-{user}".into(),
            start_dir: None,
        }),
        serial: None,
        local: None,
    }]
}

pub fn load() -> Result<Vec<ConnectionProfile>, String> {
    let path = store_file();
    if !path.exists() {
        let seeded = seed();
        save(&seeded)?;
        return Ok(seeded);
    }
    let text = fs::read_to_string(&path).map_err(|e| format!("读取配置失败: {e}"))?;
    if text.trim().is_empty() {
        return Ok(vec![]);
    }
    serde_json::from_str::<Vec<ConnectionProfile>>(&text).map_err(|e| format!("解析配置失败: {e}"))
}

pub fn save(profiles: &[ConnectionProfile]) -> Result<(), String> {
    let dir = store_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("创建配置目录失败: {e}"))?;
    let text =
        serde_json::to_string_pretty(profiles).map_err(|e| format!("序列化配置失败: {e}"))?;
    fs::write(store_file(), text).map_err(|e| format!("写入配置失败: {e}"))
}
