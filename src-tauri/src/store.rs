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
    /// true = 允许 ssh 在终端里提示输入密码（BatchMode 关闭）；
    /// false = 只用密钥/agent，连不上就直接报错，避免卡在密码提示。
    #[serde(default)]
    pub allow_password: bool,
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

fn history_file() -> PathBuf {
    store_dir().join("history.json")
}

fn settings_file() -> PathBuf {
    store_dir().join("settings.json")
}

/// 应用设置。所有字段都有默认值，方便版本升级时兼容旧文件。
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub font_size: u32,
    pub default_shell: String,
    pub record_history: bool,
    pub tmux_default: bool,
    pub theme: String,
    /// 关闭窗口时的行为："exit" 退出应用；"tray" 收进托盘继续后台运行
    pub close_action: String,
    /// 更新检查地址（返回 JSON，含 tag_name 或 version 字段）；留空表示未配置
    pub update_url: String,
    /// SSH 会话意外断开时是否自动重连（并重新附加 tmux）
    pub auto_reconnect: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            font_size: 13,
            default_shell: "powershell".into(),
            record_history: true,
            tmux_default: true,
            theme: "dark".into(),
            close_action: "exit".into(),
            update_url: String::new(),
            auto_reconnect: true,
        }
    }
}

pub fn load_settings() -> Settings {
    let Ok(text) = fs::read_to_string(settings_file()) else {
        return Settings::default();
    };
    serde_json::from_str::<Settings>(&text).unwrap_or_default()
}

pub fn save_settings(settings: &Settings) -> Result<(), String> {
    let dir = store_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("创建配置目录失败: {e}"))?;
    let text = serde_json::to_string_pretty(settings).map_err(|e| format!("序列化失败: {e}"))?;
    fs::write(settings_file(), text).map_err(|e| format!("写入设置失败: {e}"))
}

/// 一条会话历史：记录「用哪个配置、附加了哪个 tmux 会话、什么时候用过」。
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: String,
    pub profile_id: String,
    pub profile_name: String,
    pub host: String,
    #[serde(default)]
    pub tmux_session: Option<String>,
    #[serde(default)]
    pub last_used: u64,
}

pub fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub fn load_history() -> Vec<HistoryEntry> {
    let path = history_file();
    let Ok(text) = fs::read_to_string(&path) else {
        return Vec::new();
    };
    if text.trim().is_empty() {
        return Vec::new();
    }
    serde_json::from_str::<Vec<HistoryEntry>>(&text).unwrap_or_default()
}

pub fn save_history(entries: &[HistoryEntry]) -> Result<(), String> {
    let dir = store_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("创建配置目录失败: {e}"))?;
    let text = serde_json::to_string_pretty(entries).map_err(|e| format!("序列化失败: {e}"))?;
    fs::write(history_file(), text).map_err(|e| format!("写入历史失败: {e}"))
}

/// 同一个「配置 + tmux 会话」只保留一条，按最近使用排序。
pub fn upsert_history(mut entry: HistoryEntry) -> Result<Vec<HistoryEntry>, String> {
    let mut all = load_history();
    all.retain(|e| !(e.profile_id == entry.profile_id && e.tmux_session == entry.tmux_session));
    entry.last_used = now_secs();
    all.insert(0, entry);
    all.truncate(50);
    save_history(&all)?;
    Ok(all)
}

pub fn remove_history(id: &str) -> Result<Vec<HistoryEntry>, String> {
    let mut all = load_history();
    all.retain(|e| e.id != id);
    save_history(&all)?;
    Ok(all)
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
            allow_password: false,
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
