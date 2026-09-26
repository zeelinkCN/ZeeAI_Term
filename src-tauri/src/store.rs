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
    /// 跳板机，写法与 `ssh -J` 一致：`user@host` 或 `user@host:port`；留空表示直连
    #[serde(default)]
    pub jump: Option<String>,
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
    #[serde(default = "default_data_bits")]
    pub data_bits: u8,
    /// 1 或 2
    #[serde(default = "default_stop_bits")]
    pub stop_bits: u8,
    /// "none" / "odd" / "even"
    #[serde(default = "default_parity")]
    pub parity: String,
    /// "none" / "software" / "hardware"
    #[serde(default = "default_flow_control")]
    pub flow_control: String,
}

fn default_data_bits() -> u8 {
    8
}

fn default_stop_bits() -> u8 {
    1
}

fn default_parity() -> String {
    "none".into()
}

fn default_flow_control() -> String {
    "none".into()
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalConfig {
    pub shell: String,
    #[serde(default)]
    pub distro: Option<String>,
    /// 本地终端/工作空间的起始目录（Git 工作空间就靠它）
    #[serde(default)]
    pub cwd: Option<String>,
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
    /// 这个服务器 / 串口 / 本地终端用哪一套关键字高亮规则集（空 = 用全局默认那套）
    #[serde(default)]
    pub highlight_set_id: Option<String>,
    /// 这个服务器 / 串口 / 本地终端用哪套终端配色（空 = 用全局那套）
    #[serde(default)]
    pub term_scheme: Option<String>,
    /// 配合 term_scheme = "custom" 的自定义配色 JSON
    #[serde(default)]
    pub term_scheme_custom: Option<String>,
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

/// 读取文本文件并去掉 UTF-8 BOM。
///
/// 用户手动编辑过 JSON（旧版记事本、部分编辑器会写 BOM）之后，serde_json 会因为开头的
/// BOM 直接解析失败 —— 表现就是「设置/服务器列表被悄悄重置成默认值」。统一在这里容错。
fn read_text(path: &PathBuf) -> std::io::Result<String> {
    let text = fs::read_to_string(path)?;
    Ok(text.trim_start_matches('\u{feff}').to_string())
}

/// 上次退出时的工作区快照（JSON 字符串，前端自己定义结构）
fn workspace_file() -> PathBuf {
    store_dir().join("workspace.json")
}

pub fn save_workspace(data: &str) -> Result<(), String> {
    let dir = store_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("创建配置目录失败: {e}"))?;
    fs::write(workspace_file(), data).map_err(|e| format!("写入工作区失败: {e}"))
}

pub fn load_workspace() -> Option<String> {
    read_text(&workspace_file()).ok()
}

/// 会话日志目录：%APPDATA%\ZeeAI-Terminal\logs\sessions
pub fn log_dir() -> PathBuf {
    // 设置里指定了自定义目录就用它（比如放到 D:\zeeai-logs 或网络盘），
    // 空字符串 = 用默认位置。
    let custom = load_settings().log_dir.trim().to_string();
    if !custom.is_empty() {
        return PathBuf::from(custom);
    }
    store_dir().join("logs").join("sessions")
}

/// 应用设置。所有字段都有默认值，方便版本升级时兼容旧文件。
/// 一套命名的高亮规则（"生产机"/"串口调试"/"默认"…），服务器 / 串口 / 本地终端各自绑定一套。
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HighlightRuleSet {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub rules: Vec<crate::core::highlight::HighlightRule>,
}

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
    /// 文件面板是否跟随终端当前目录（点刷新时自动跳到 tmux 的 pane 目录）
    pub fs_follow_terminal: bool,
    /// 退出时保存工作区、启动时恢复上次打开的会话
    pub restore_workspace: bool,
    /// 终端回滚缓冲多少行（往上能翻多少历史）
    pub scrollback: u32,
    /// 新建会话时自动开始记录终端日志
    pub auto_log: bool,
    /// 上次检查更新成功的时间（Unix 秒）；0 表示从没检查过
    pub last_update_check: u64,
    /// 用户点了「忽略这个版本」的版本号，避免同一个版本反复闪小红点
    pub ignored_update_version: String,
    /// 终端配色方案 key（见前端 src/termThemes.ts）；空 = 跟随旧行为
    pub term_scheme: String,
    /// 自定义配色的 JSON（仅 term_scheme = "custom" 时使用）
    pub term_scheme_custom: String,
    /// 会话日志目录；空 = 默认 %APPDATA%\ZeeAI-Terminal\logs\sessions
    pub log_dir: String,
    /// 终端关键字高亮总开关（SSH / 串口 / 本地终端共用同一份规则）
    pub highlight_enabled: bool,
    /// 终端关键字高亮规则（预设见 core::highlight::presets）
    pub highlight_rules: Vec<crate::core::highlight::HighlightRule>,
    /// 命名规则集：服务器 / 串口 / 本地终端可以各绑一套（见 ConnectionProfile::highlight_set_id）
    pub highlight_rule_sets: Vec<HighlightRuleSet>,
    /// 本地终端按 shell 各自绑的配色方案（powershell / cmd / wsl → 方案 key）
    pub term_scheme_by_shell: std::collections::HashMap<String, String>,
    /// 本地终端按 shell 各自绑的高亮规则集（powershell / cmd / wsl → 规则集 id）
    pub highlight_set_by_shell: std::collections::HashMap<String, String>,
    /// AI 有新消息/要你处理时，除活动栏红点外，是否再闪 Windows 任务栏
    pub ai_notify_taskbar: bool,
    /// 是否在左侧活动栏的 AI 星号上显示红点/数字
    pub ai_notify_badge: bool,
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
            update_url: default_update_url(),
            auto_reconnect: true,
            fs_follow_terminal: true,
            restore_workspace: true,
            scrollback: 10000,
            auto_log: false,
            last_update_check: 0,
            ignored_update_version: String::new(),
            term_scheme: "vscode-dark".into(),
            term_scheme_custom: String::new(),
            log_dir: String::new(),
            // 默认就带上预设规则包（ERROR / WARN / OK / panic 各一套）。
            // 全都是"只给关键词上色"，不影响交互式回显；不想要的在设置里关掉。
            highlight_enabled: true,
            highlight_rules: crate::core::highlight::presets(),
            // 空 → 由 load_settings 用 highlight_rules（或预设）填出名为「默认」的那套，
            // 这样老配置里用户自己调过的规则不会丢
            highlight_rule_sets: Vec::new(),
            term_scheme_by_shell: std::collections::HashMap::new(),
            highlight_set_by_shell: std::collections::HashMap::new(),
            // 默认只在活动栏的 AI 图标上点红点（最不打扰）；闪任务栏/右下角提示由用户自己开
            ai_notify_taskbar: false,
            ai_notify_badge: true,
        }
    }
}

pub fn load_settings() -> Settings {
    let Ok(text) = read_text(&settings_file()) else {
        return Settings::default();
    };
    let mut s = serde_json::from_str::<Settings>(&text).unwrap_or_default();
    // 老配置里 update_url 是空字符串，会盖掉默认值 —— 这里补回来，
    // 让「检查更新」默认就指向本项目的 GitHub Releases。
    if s.update_url.trim().is_empty() {
        s.update_url = default_update_url();
    }
    // 老配置只有一份 highlight_rules（没有规则集）→ 把它迁移成名为「默认」的那套，
    // 免得用户之前调好的规则在升级后丢了。
    if s.highlight_rule_sets.is_empty() {
        let rules = if s.highlight_rules.is_empty() {
            crate::core::highlight::presets()
        } else {
            s.highlight_rules.clone()
        };
        s.highlight_rule_sets = vec![HighlightRuleSet {
            id: "default".into(),
            name: "默认".into(),
            rules,
        }];
    }
    s
}

/// 默认更新源：本仓库的 latest release（GitHub API，返回 JSON，含 tag_name）
fn default_update_url() -> String {
    "https://api.github.com/repos/zeelinkCN/ZeeAI_Term/releases/latest".to_string()
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
    /// 用户给这个会话起的名字（为空则界面按 tmux 会话名/普通 shell 显示）
    #[serde(default)]
    pub title: Option<String>,
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
    let Ok(text) = read_text(&path) else {
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

/// 首次运行**不内置任何服务器**。
///
/// 这里曾经塞过一条开发用的测试服务器（带真实 IP），那是我的疏忽：发布出去之后
/// 每个下载的人打开就能看到那台机器的地址。现在改成空的，用户自己加自己的机器。
fn seed() -> Vec<ConnectionProfile> {
    Vec::new()
}

#[cfg(test)]
mod settings_tests {
    use super::*;

    /// 老配置只有一份 highlight_rules → 读进来要自动变成名为「默认」的规则集
    #[test]
    fn migrates_legacy_rules_into_default_set() {
        let legacy = r##"{
            "highlightEnabled": true,
            "highlightRules": [
                {"id":"mine","name":"我的","keywords":["boom"],"fg":"#ff0000","enabled":true}
            ]
        }"##;
        let s: Settings = serde_json::from_str(legacy).unwrap_or_default();
        assert!(s.highlight_rule_sets.is_empty(), "老配置里没有规则集字段");
        // 走一次 load_settings 里的迁移逻辑（这里直接复现那段，避免碰真实文件）
        let mut s = s;
        if s.highlight_rule_sets.is_empty() {
            let rules = if s.highlight_rules.is_empty() {
                crate::core::highlight::presets()
            } else {
                s.highlight_rules.clone()
            };
            s.highlight_rule_sets = vec![HighlightRuleSet {
                id: "default".into(),
                name: "默认".into(),
                rules,
            }];
        }
        assert_eq!(s.highlight_rule_sets.len(), 1);
        assert_eq!(s.highlight_rule_sets[0].id, "default");
        assert_eq!(s.highlight_rule_sets[0].rules[0].id, "mine");
    }

    /// 默认设置里就带一套「默认」规则集（内容 = 预设）
    #[test]
    fn default_settings_are_seeded_by_migration() {
        let s = Settings::default();
        // 出厂状态没有规则集，靠 load_settings 的迁移补出「默认」那套
        assert!(s.highlight_rule_sets.is_empty());
        assert!(!s.highlight_rules.is_empty(), "兜底规则默认就是预设");
        assert!(s.ai_notify_badge, "活动栏数字默认打开");
    }

    /// 服务器可以绑定规则集；不绑就是 None
    #[test]
    fn profile_binding_round_trips() {
        let p: ConnectionProfile = serde_json::from_str(
            r#"{"id":"x","type":"ssh","name":"n","group":"g","highlightSetId":"prod"}"#,
        )
        .unwrap();
        assert_eq!(p.highlight_set_id.as_deref(), Some("prod"));
        assert!(p.term_scheme.is_none(), "没配就是 None（跟随全局）");
        let json = serde_json::to_string(&p).unwrap();
        assert!(json.contains("highlightSetId"), "{json}");
    }

    /// 每台服务器可以各存一套配色方案；不写就是 None
    #[test]
    fn profile_can_carry_its_own_palette() {
        let p: ConnectionProfile = serde_json::from_str(
            r##"{"id":"x","type":"ssh","name":"n","group":"g","termScheme":"dracula",
                "termSchemeCustom":"{\"red\":\"#ff0000\"}"}"##,
        )
        .unwrap();
        assert_eq!(p.term_scheme.as_deref(), Some("dracula"));
        assert!(p.term_scheme_custom.unwrap().contains("ff0000"));
    }
}

pub fn load() -> Result<Vec<ConnectionProfile>, String> {
    let path = store_file();
    if !path.exists() {
        let seeded = seed();
        save(&seeded)?;
        return Ok(seeded);
    }
    let text = read_text(&path).map_err(|e| format!("读取配置失败: {e}"))?;
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
