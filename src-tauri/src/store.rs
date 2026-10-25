use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};

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
    /// 这台服务器的新会话**默认用 herdr 打开**（和 tmux_enabled 一个性质，只是换成工具）。
    ///
    /// 为什么放在服务器配置里而不是全局设置：有的机器装了 herdr、有的没装；
    /// 用户的要求是"我在这个服务器上勾了默认用 herdr，就别每次再问我"。
    #[serde(default)]
    pub herdr_enabled: bool,
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

pub(crate) fn store_dir() -> PathBuf {
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
fn read_text(path: &Path) -> std::io::Result<String> {
    let text = fs::read_to_string(path)?;
    Ok(text.trim_start_matches('\u{feff}').to_string())
}

/// 同一个进程里的所有"配置写盘"共用这一把锁。
///
/// 为什么需要：settings / profiles / workspace / ai_turns / known_hosts 都可能被不同线程
/// 同时保存（UI 设置、看板轮询、SSH 连接回调）。以前各自算各自的临时文件名、各自
/// remove + rename，并发时会互相踩掉对方刚写的文件，甚至留下半截 JSON。
static SAVE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// 临时文件名后缀：pid + 纳秒。多开一个实例也不会撞名。
fn unique_save_suffix() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{}-{nanos}", std::process::id())
}

fn tmp_path_for(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "config".to_string());
    path.with_file_name(format!("{name}.{}.tmp", unique_save_suffix()))
}

/// 把 `tmp` 原子地替换成目标文件。
///
/// Windows：`MoveFileExW(MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)`。
/// **不能先删目标再 rename** —— 那两步之间有个空窗，进程被杀就是"配置文件消失"；
/// 而 `std::fs::rename` 在目标已存在时会直接失败（Windows 语义）。
#[cfg(windows)]
fn replace_file(tmp: &Path, dst: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    fn wide(path: &Path) -> Vec<u16> {
        path.as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    let from = wide(tmp);
    let to = wide(dst);
    let ok = unsafe {
        MoveFileExW(
            from.as_ptr(),
            to.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if ok == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

/// 非 Windows 的兜底：先把旧目标改名备份，再 rename 新的上去；
/// 新文件替换失败时把备份改回来，保证原文件还在。
#[cfg(not(windows))]
fn replace_file(tmp: &Path, dst: &Path) -> std::io::Result<()> {
    if !dst.exists() {
        return fs::rename(tmp, dst);
    }
    let name = dst
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "config".to_string());
    let backup = dst.with_file_name(format!("{name}.old-{}.bak", unique_save_suffix()));
    fs::rename(dst, &backup)?;
    match fs::rename(tmp, dst) {
        Ok(()) => {
            let _ = fs::remove_file(&backup);
            Ok(())
        }
        Err(e) => {
            // 尽力恢复原文件；即使恢复失败也把真实错误返回，不静默丢数据
            let _ = fs::rename(&backup, dst);
            Err(e)
        }
    }
}

/// **原子写**：先写同目录的唯一 `.tmp`，`sync_all` 落盘，再整体替换目标。
///
/// 为什么必须这样：以前是 `fs::write(目标, text)` 直接覆盖。升级脚本会在 App 退出后
/// 立刻覆盖安装（等不到退出还会 `taskkill /F`），一旦撞上正在写盘的那一瞬间，文件就会
/// 变成半截 JSON；下一次启动 `load_settings()` / `store::load()` 解析失败，
/// **静默回落默认值** —— 用户看到的就是「服务器列表突然空了」「主题/配色/高亮规则全没了」，
/// 而且没有任何提示。
///
/// 现在：同进程写盘串行化 + 唯一临时名（pid+纳秒） + `sync_all` + 系统级原子替换。
/// Windows 上用 `MoveFileExW`，全程**碰不到"目标文件不存在"的中间态**。
pub(crate) fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    let _guard = SAVE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    let dir = path
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| store_dir());
    fs::create_dir_all(&dir).map_err(|e| format!("创建配置目录失败: {e}"))?;

    let tmp = tmp_path_for(path);
    let wrote = (|| -> std::io::Result<()> {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(text.as_bytes())?;
        // 必须等数据真正落盘，否则断电/强杀后 rename 过去的是个空文件
        file.sync_all()?;
        Ok(())
    })();
    if let Err(e) = wrote {
        let _ = fs::remove_file(&tmp);
        return Err(format!("写临时文件失败: {e}"));
    }

    if let Err(e) = replace_file(&tmp, path) {
        // 替换失败：目标文件原样保留（MoveFileExW 失败不会动源/目标数据），只清临时文件
        let _ = fs::remove_file(&tmp);
        return Err(format!("保存失败: {e}"));
    }
    Ok(())
}

/// 解析失败时把坏文件另存一份 `.bad-<时间戳>`，方便事后找回。
///
/// 为什么不直接删：坏文件里可能还有用户手工加过的内容，留着比丢掉强；
/// 同时也让「配置被重置」这件事在磁盘上留下证据，而不是无声无息。
///
/// 返回备份后的路径（备份失败返回 None，调用方据此给出提示）。
pub fn backup_broken(path: &Path) -> Option<PathBuf> {
    let stamp = now_secs();
    let mut backup = path.to_path_buf();
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "config".to_string());
    backup.set_file_name(format!("{name}.bad-{stamp}"));
    if fs::rename(path, &backup).is_ok() {
        log::warn!("配置解析失败，已备份为 {}", backup.display());
        Some(backup)
    } else {
        None
    }
}

/// 上次退出时的工作区快照（JSON 字符串，前端自己定义结构）
fn workspace_file() -> PathBuf {
    store_dir().join("workspace.json")
}

/// AI 任务时间线（`docs/impl-log` 里说的 G-01）落盘位置
pub fn ai_turns_file() -> PathBuf {
    store_dir().join("ai_turns.json")
}

/// 写 AI 任务时间线（原子写，理由同 [`write_atomic`]）
pub fn write_ai_turns(text: &str) -> Result<(), String> {
    write_atomic(&ai_turns_file(), text)
}

pub fn save_workspace(data: &str) -> Result<(), String> {
    write_atomic(&workspace_file(), data)
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
    /// 按**终端类型**各自绑的配色方案（ssh / local / serial / adb → 方案 key）
    pub term_scheme_by_kind: std::collections::HashMap<String, String>,
    /// 按**终端类型**各自绑的高亮规则集（ssh / local / serial / adb → 规则集 id）
    pub highlight_set_by_kind: std::collections::HashMap<String, String>,
    /// AI 有新消息/要你处理时，除活动栏红点外，是否再闪 Windows 任务栏
    pub ai_notify_taskbar: bool,
    /// 是否在左侧活动栏的 AI 星号上显示红点/数字。
    ///
    /// ⚠️ 老的总开关：口径已改成下面两条独立规则（`docs/design-ai-board-v2.md` §10.6
    /// "红点只为两种情况亮"），界面不再用它。字段留着只为**读得懂老配置**。
    pub ai_notify_badge: bool,
    /// 红点规则 ①（§10.6）：有实例在「需要你」时亮 —— **亮到你处理为止**。默认开。
    ///
    /// 为什么这条不能漏：那是唯一真正值得打断用户的事（等你批准 / 回话）。
    #[serde(default = "default_true")]
    pub ai_notify_needs_you_badge: bool,
    /// 红点规则 ②（§10.6）：某一轮跑完**并停下**时亮一个未读 —— 点开面板即清。默认开。
    ///
    /// 注意"只产出文件但还没停"**不算**（那条老口径已被 §10.9 冲突清单否掉）。
    #[serde(default = "default_true")]
    pub ai_notify_finished_badge: bool,
    /// 通知策略：**每一轮跑完**就提醒一次。
    ///
    /// 默认**关**：用户的原话是"我跑的小任务太多，每跑一个都弹一条，很烦"。
    /// 真正要人接手的那种（等你批准 / 问你选择题）由下面两项负责，不会漏。
    pub ai_notify_complete: bool,
    /// 通知策略：这一轮**产出了文档**（HTML / Markdown）才提醒 —— 默认开。
    /// "我离开电脑，AI 写完一份文档我得知道去哪儿看"就是这个场景。
    pub ai_notify_docs: bool,
    /// 通知策略：AI **在等你**（批准 / 回话 / 选择题）时提醒 —— 默认开，这条不能关掉才好用
    pub ai_notify_needs_you: bool,
    /// 产物范围：true = 任何新文件都算"有产物"；false = 只算 HTML / Markdown 文档（默认）
    pub ai_notify_all_artifacts: bool,
    /// 粘贴/拖进来的图片、文件在**远端**落到哪个目录（前端解析成绝对路径后再传上来）。
    ///
    /// 默认 `~/.zeeai/paste`：不往用户的项目目录里丢东西。
    /// 填 `.` 表示"跟随终端当前目录"（落进项目里，对 CLI agent 的沙箱最友好）。
    pub paste_dir: String,
    /// 哪个键负责粘贴：`ctrl-v` / `shift-insert` / `both`（默认）。
    ///
    /// 为什么这是个"二选一"而不是"开关"：两个键在 Windows 下都能直接触发浏览器的粘贴
    ///（不需要读剪贴板权限）。所以设置的意思是"**哪个键留给终端**" —— 没被选中的那个会
    /// 原样送给远端：Ctrl+V 送 `^V`（readline 的 quoted-insert、vim 的块选择），
    /// Shift+Insert 送 Insert 键。终端老手要的就是这个。
    pub paste_key: String,
    /// 终端里点**右键**做什么：`menu` = 弹菜单（默认）；`paste` = 直接粘贴文本。
    ///
    /// `paste` 模式下 Shift+右键仍然弹菜单（PuTTY 的习惯）。直接粘贴读的是剪贴板**文本**，
    /// 万一被系统拒绝会自动退回弹菜单并给一句提示（图片仍然靠 Ctrl+V / Shift+Insert）。
    pub right_click: String,
    /// 怎么复制：`ctrl-shift-c`（默认）/ `ctrl-c-smart`（有选中就复制，没选中发 SIGINT）/
    /// `select`（选中即复制，不用按键）。
    pub copy_key: String,
    /// **直接粘进终端**（不经过输入窗）上传完成后，弹一个几秒的缩略图预览。
    ///
    /// 默认开：那样"我粘对了没有"不用靠猜 —— 粘贴的语义就是"现在就发"，
    /// 发错了得能立刻看出来。走输入窗时不需要它（那边附件是常驻缩略图）。
    pub paste_toast: bool,
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
            term_scheme_by_kind: std::collections::HashMap::new(),
            highlight_set_by_kind: std::collections::HashMap::new(),
            // 默认只在活动栏的 AI 图标上点红点（最不打扰）；闪任务栏/右下角提示由用户自己开
            ai_notify_taskbar: false,
            ai_notify_badge: true,
            // 红点的两条规则，默认都开（§10.6）：
            //   ① 需要你 → 亮到你处理；② 跑完一轮并停下 → 点开面板就消。
            // 其它情况（运行中/空闲/陈旧/只产出文件/探测不到）不提醒。
            ai_notify_needs_you_badge: true,
            ai_notify_finished_badge: true,
            // 通知的默认口径（用户明确要求"别每跑一个小任务都弹"）：
            //   - 跑完就提醒：关（小任务太多）
            //   - 产出了 HTML/MD 文档：开（这是要你去看的成果）
            //   - 在等你批准/回话/做选择题：开（这条漏了就白等了）
            //   - 产物范围：只看文档（想连其它文件一起算，自己在设置里开）
            ai_notify_complete: false,
            ai_notify_docs: true,
            ai_notify_needs_you: true,
            ai_notify_all_artifacts: false,
            // 粘贴/拖进来的图片、文件在远端的落地目录（不往项目里丢东西；填 "." 可改成跟随当前目录）
            paste_dir: "~/.zeeai/paste".into(),
            // 终端交互的三个习惯项：默认跟大多数人一样（Ctrl+V 与 Shift+Insert 都能粘、
            // 右键弹菜单、Ctrl+Shift+C 复制）
            paste_key: "both".into(),
            right_click: "menu".into(),
            copy_key: "ctrl-shift-c".into(),
            // 直接粘进终端时是否给一眼缩略图。**默认关**：用户明确要求
            // "图片上传/粘贴不要在右下角弹消息"（想要的人在设置里打开）
            paste_toast: false,
        }
    }
}

pub fn load_settings() -> Settings {
    let path = settings_file();
    let Ok(text) = read_text(&path) else {
        return Settings::default();
    };
    let mut s = match serde_json::from_str::<Settings>(&text) {
        Ok(s) => s,
        Err(e) => {
            // 解析不了就先把坏文件留证，再用默认值起来（总不能让应用起不来）
            log::error!("settings.json 解析失败（{e}），已备份并回落默认值");
            let _ = backup_broken(&path);
            Settings::default()
        }
    };
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
    let text = serde_json::to_string_pretty(settings).map_err(|e| format!("序列化失败: {e}"))?;
    write_atomic(&settings_file(), &text)
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
    /// herdr 会话：恢复时要打开的窗格号（形如 w1:p1）。空 = 不是 herdr 会话。
    ///
    /// 为什么必须记：不记的话，从侧栏会话列表点开一个 herdr 会话会开出**普通 shell**
    ///（同一类 bug 在工作区恢复那里也踩过一次）。
    #[serde(default)]
    pub herdr_pane: Option<String>,
    /// herdr 会话的打开方式：observe（只读）/ control（可写）
    #[serde(default)]
    pub herdr_mode: Option<String>,
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
    let all = serde_json::from_str::<Vec<HistoryEntry>>(&text).unwrap_or_default();
    // 读的时候就顺手把重复行收掉（老用户的历史文件里已经有一串了）
    dedupe_history(all)
}

pub fn save_history(entries: &[HistoryEntry]) -> Result<(), String> {
    let dir = store_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("创建配置目录失败: {e}"))?;
    let text = serde_json::to_string_pretty(entries).map_err(|e| format!("序列化失败: {e}"))?;
    // 和 profiles / settings 走同一条原子写：history.json 以前是裸 `fs::write`，
    // 升级安装撞上写盘就会变半截 JSON，下次 `load_history` 静默回落到空列表
    // （用户看到的就是"会话历史突然没了"）。这里补上同一套 SAVE_LOCK + 原子替换。
    write_atomic(&history_file(), &text).map_err(|e| format!("写入历史失败: {e}"))
}

/// 历史记录的去重键。
///
/// - **herdr：按「服务器 + 窗格」**。这是这次的修复重点：以前只看 tmux 名和标题，
///   而 herdr 会话没有 tmux 名，标题又会随打开方式变（`… w1P:p1` /
///   `… w1P:p1 （接管）` / 从看板点开时带的是 agent 标题），于是**同一个窗格在侧栏里
///   长出一排重复行**（用户截图里那一串绿色 H 就是它）。
/// - tmux：按「服务器 + tmux 名」；
/// - 普通 shell：按「服务器 + 会话名」—— 以前不看名字，同一台机器的所有普通 shell
///   都被算成同一条互相覆盖，用户开了好几个却只看到一行（数量永远不涨）。
pub fn history_key_for(
    profile_id: &str,
    tmux_session: &Option<String>,
    title: &str,
    herdr_pane: &Option<String>,
) -> String {
    if let Some(pane) = herdr_pane
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty())
    {
        return format!("{profile_id}|herdr:{pane}");
    }
    match tmux_session
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
    {
        Some(name) => format!("{profile_id}|tmux:{name}"),
        None => format!("{profile_id}|plain:{}", title.trim()),
    }
}

pub fn upsert_history(mut entry: HistoryEntry) -> Result<Vec<HistoryEntry>, String> {
    let mut all = load_history();
    // herdr 的标题里"（接管）"是随打开方式变的：同一个窗格一会儿叫
    // `lz · codex w1P:p1`、一会儿叫 `lz · codex w1P:p1 （接管）`。
    // 既然是同一个窗格，标题就统一成不带这个尾巴的那个，免得侧栏那一行名字来回跳。
    if entry
        .herdr_pane
        .as_deref()
        .map(str::trim)
        .is_some_and(|p| !p.is_empty())
    {
        if let Some(t) = entry.title.clone() {
            let cleaned = t.replace(" （接管）", "").replace("（接管）", "");
            let cleaned = cleaned.trim().to_string();
            entry.title = if cleaned.is_empty() { None } else { Some(cleaned) };
        }
    }
    let new_key = history_key_for(
        &entry.profile_id,
        &entry.tmux_session,
        entry.title.as_deref().unwrap_or(""),
        &entry.herdr_pane,
    );
    all.retain(|e| {
        history_key_for(
            &e.profile_id,
            &e.tmux_session,
            e.title.as_deref().unwrap_or(""),
            &e.herdr_pane,
        ) != new_key
    });
    entry.last_used = now_secs();
    all.insert(0, entry);
    all.truncate(50);
    save_history(&all)?;
    Ok(all)
}

/// 把已经有的一堆重复行收拾干净：同一个「服务器 + herdr 窗格」只留最近用过的那条。
///
/// 为什么要在**读**的时候就做：去重键是这次才补上的，老用户的历史文件里已经躺着
/// 一串重复行（用户截图里就是），光改写入侧的话它们会一直留在那儿。
fn dedupe_history(all: Vec<HistoryEntry>) -> Vec<HistoryEntry> {
    let mut out: Vec<HistoryEntry> = Vec::with_capacity(all.len());
    for e in all {
        // last_used 大的在前（load 出来已经是倒序，这里再稳一手）
        let dup = out
            .iter()
            .position(|k| history_key_for(&k.profile_id, &k.tmux_session, k.title.as_deref().unwrap_or(""), &k.herdr_pane)
                == history_key_for(&e.profile_id, &e.tmux_session, e.title.as_deref().unwrap_or(""), &e.herdr_pane));
        match dup {
            // 同一条：保留已有的（它更近），但如果新的标题更"干净"就把名字换过来
            Some(i) => {
                if out[i].title.is_none() && e.title.is_some() {
                    out[i].title = e.title.clone();
                }
            }
            None => out.push(e),
        }
    }
    out
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
        assert!(s.ai_notify_badge, "活动栏数字默认打开（老开关，界面已不用它）");
        // §10.6：红点的两条规则**默认都开** —— "需要你"漏了就白等了
        assert!(s.ai_notify_needs_you_badge, "「需要你处理时提醒」默认开");
        assert!(s.ai_notify_finished_badge, "「跑完一轮并停下时提醒」默认开");
    }

    /// 老配置里没有这两条新键时，必须**默认都开**（§10.6：不能为了降噪把"需要你"漏掉）
    #[test]
    fn old_config_without_badge_rules_defaults_both_on() {
        let s: Settings = serde_json::from_str("{}").expect("空配置也要能读");
        assert!(s.ai_notify_needs_you_badge);
        assert!(s.ai_notify_finished_badge);
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

/// 读服务器配置。
///
/// **读接口绝不写盘**：
/// - 文件不存在 → 返回默认值（空列表），由显式保存（例如添加服务器）创建文件；
/// - 解析失败 → 把坏文件备份成 `.bad-<时间戳>`，返回明确的 `Err`，**绝不自动覆盖**。
///
/// 以前这两条都会顺手 `save(seed())`：一旦读到半截 JSON，用户原来的服务器列表就被
/// 默认值永久覆盖了 —— 这正是"配置被悄悄重置"的根因。
pub fn load() -> Result<Vec<ConnectionProfile>, String> {
    load_from(&store_file())
}

/// 从指定路径读（单测用临时文件，绝不碰用户真实配置）。
fn load_from(path: &Path) -> Result<Vec<ConnectionProfile>, String> {
    if !path.exists() {
        return Ok(seed());
    }
    let text = read_text(path).map_err(|e| format!("读取配置失败: {e}"))?;
    if text.trim().is_empty() {
        return Ok(vec![]);
    }
    match serde_json::from_str::<Vec<ConnectionProfile>>(&text) {
        Ok(v) => Ok(v),
        Err(e) => {
            // 半截 JSON（例如写盘时被升级安装打断）会走到这里。
            // 备份留证后**返回错误**，让 UI 明确提示；下一次保存才会写新文件。
            let backup = backup_broken(path);
            let hint = backup
                .as_ref()
                .map(|b| format!("，坏文件已备份为 {}", b.display()))
                .unwrap_or_else(|| "，坏文件备份失败".to_string());
            log::error!("profiles.json 解析失败（{e}）{hint}");
            Err(format!(
                "服务器配置 profiles.json 解析失败（{e}）{hint}。请检查该文件；\
                 如确认损坏，可删除后重新添加服务器。"
            ))
        }
    }
}

pub fn save(profiles: &[ConnectionProfile]) -> Result<(), String> {
    let text =
        serde_json::to_string_pretty(profiles).map_err(|e| format!("序列化配置失败: {e}"))?;
    write_atomic(&store_file(), &text)
}

#[cfg(test)]
mod history_tests {
    use super::{dedupe_history, history_key_for, write_atomic, HistoryEntry};

    fn tmp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "zeeai-store-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn leftover_tmp_files(dir: &std::path::Path) -> Vec<String> {
        std::fs::read_dir(dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.ends_with(".tmp"))
            .collect()
    }

    #[test]
    fn atomic_write_replaces_content_and_leaves_no_tmp() {
        let dir = tmp_dir("atomic");
        let f = dir.join("atomic.json");

        write_atomic(&f, "{\"v\":1}").unwrap();
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "{\"v\":1}");
        // 再写一次：必须整体替换，而不是追加
        write_atomic(&f, "{\"v\":22}").unwrap();
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "{\"v\":22}");
        // 不能留下 .tmp
        assert!(
            leftover_tmp_files(&dir).is_empty(),
            "留下了临时文件: {:?}",
            leftover_tmp_files(&dir)
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 20 个线程同时保存：不管谁最后写，落盘的一定是**某一次的完整 JSON**，
    /// 不能出现半截文件，也不能留下临时文件。
    #[test]
    fn concurrent_writes_never_leave_half_written_json() {
        let dir = tmp_dir("concurrent");
        let f = dir.join("profiles.json");
        // 先放一个完整的初始文件，确保并发期间目标始终存在
        write_atomic(&f, "{\"writer\":-1,\"pad\":\"\"}").unwrap();

        let mut handles = Vec::new();
        for i in 0..20 {
            let f = f.clone();
            handles.push(std::thread::spawn(move || {
                let text = format!("{{\"writer\":{i},\"pad\":\"{}\"}}", "x".repeat(8192));
                write_atomic(&f, &text).expect("并发写不能失败");
                text
            }));
        }
        let written: Vec<String> = handles
            .into_iter()
            .map(|h| h.join().expect("写线程不能 panic"))
            .collect();

        let final_text = std::fs::read_to_string(&f).unwrap();
        let v: serde_json::Value =
            serde_json::from_str(&final_text).expect("最终文件必须是完整 JSON");
        assert!(v.get("writer").is_some(), "JSON 结构不完整: {final_text}");
        assert!(
            written.iter().any(|w| w == &final_text),
            "最终内容必须是某一次完整写入，而不是拼出来的"
        );
        assert!(
            leftover_tmp_files(&dir).is_empty(),
            "留下了临时文件: {:?}",
            leftover_tmp_files(&dir)
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn tmux_sessions_dedupe_by_name() {
        let k = |tmux: Option<&str>, title: &str| {
            history_key_for("p1", &tmux.map(str::to_string), title, &None)
        };
        let a = k(Some("my-sess"), "随便什么名字");
        let b = k(Some("my-sess"), "另一个名字");
        assert_eq!(a, b, "tmux 会话按会话名去重");
        let c = k(Some("other"), "随便什么名字");
        assert_ne!(a, c);
        let other_profile = history_key_for("p2", &Some("my-sess".into()), "", &None);
        assert_ne!(a, other_profile, "不同服务器不能撞");
    }

    #[test]
    fn plain_shells_are_separate_per_name() {
        // 这就是用户报的问题：同一台机器开了好几个普通 shell，只看到一行
        let k = |title: &str| history_key_for("p1", &None, title, &None);
        let s1 = k("服务器 · 普通 shell 1");
        let s2 = k("服务器 · 普通 shell 2");
        assert_ne!(s1, s2, "普通 shell 要按名字分成不同记录");
        // 同名（自动命名重复的情况）仍然算同一条，不会无限堆积
        assert_eq!(s1, k("服务器 · 普通 shell 1"));
        // 空 tmux 名也要走 plain 分支（不能和 tmux: 撞）
        assert_eq!(
            history_key_for("p1", &Some("  ".into()), "x", &None),
            k("x")
        );
    }

    #[test]
    fn herdr_sessions_dedupe_by_pane_not_title() {
        // 用户截图里那一串重复的 H 行：同一个窗格被存了好几条，因为标题随打开方式变
        let a = history_key_for("p1", &None, "lz · codex w1P:p1", &Some("w1P:p1".into()));
        let b = history_key_for("p1", &None, "lz · 测试1 w1P:p1 （接管）", &Some("w1P:p1".into()));
        let c = history_key_for("p1", &None, "lz · 查看机器网页的显示内容 | lz w1Q:p1", &Some("w1Q:p1".into()));
        assert_eq!(a, b, "同一个窗格无论怎么打开都算一条");
        assert_ne!(a, c, "不同窗格是不同记录");
        // 不能跟同名的 tmux / 普通 shell 撞
        assert_ne!(a, history_key_for("p1", &Some("w1P:p1".into()), "x", &None));
    }

    #[test]
    fn dedupe_history_collapses_existing_duplicates() {
        // 老版本写下的历史文件里已经有一串重复行，读进来就要收拾干净
        let mk = |id: &str, pane: Option<&str>, title: &str, used: u64| HistoryEntry {
            id: id.into(),
            profile_id: "p1".into(),
            profile_name: "lz".into(),
            host: "h".into(),
            tmux_session: None,
            title: Some(title.into()),
            herdr_pane: pane.map(str::to_string),
            herdr_mode: None,
            last_used: used,
        };
        let all = vec![
            mk("1", Some("w1P:p1"), "lz · codex w1P:p1", 100),
            mk("2", Some("w1P:p1"), "lz · codex w1P:p1 （接管）", 90),
            mk("3", Some("w1Q:p1"), "lz · w1Q:p1", 80),
            mk("4", None, "lz · 普通 shell 1", 70),
        ];
        let out = dedupe_history(all);
        assert_eq!(out.len(), 3, "同一个窗格只留一条");
        assert_eq!(out[0].id, "1");
        assert_eq!(out[1].id, "3");
        assert_eq!(out[2].id, "4");
    }
}

#[cfg(test)]
mod load_tests {
    use super::{load_from, ConnectionProfile};
    use std::path::{Path, PathBuf};

    fn tmp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "zeeai-store-load-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn backups(dir: &Path) -> Vec<PathBuf> {
        std::fs::read_dir(dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| {
                p.file_name()
                    .map(|n| n.to_string_lossy().contains(".bad-"))
                    .unwrap_or(false)
            })
            .collect()
    }

    /// 文件不存在 = 首次运行：返回空列表，**不能顺手创建文件**（读接口不写盘）
    #[test]
    fn missing_file_returns_defaults_without_writing() {
        let dir = tmp_dir("missing");
        let f = dir.join("profiles.json");

        let profiles: Vec<ConnectionProfile> = load_from(&f).expect("缺文件不算错误");
        assert!(profiles.is_empty());
        assert!(!f.exists(), "读配置不能创建/初始化文件");
        assert!(backups(&dir).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 坏 JSON：必须原样备份成 .bad-<时间戳> 并返回 Err，绝不能覆盖成默认值
    #[test]
    fn bad_json_is_backed_up_and_never_overwritten() {
        let dir = tmp_dir("bad");
        let f = dir.join("profiles.json");
        let bad = "{ this is half a json";
        std::fs::write(&f, bad).unwrap();
        let before = std::fs::read_to_string(&f).unwrap();

        let err = match load_from(&f) {
            Ok(_) => panic!("坏 JSON 必须返回错误，而不是静默回落"),
            Err(e) => e,
        };
        assert!(err.contains("解析失败"), "错误信息要说清原因: {err}");

        // 原文件被移走（备份），而不是被默认值覆盖
        assert!(!f.exists(), "坏文件不能被就地覆盖");
        let backup_files = backups(&dir);
        assert_eq!(backup_files.len(), 1, "必须留下恰好一份 .bad 备份");
        assert_eq!(
            std::fs::read_to_string(&backup_files[0]).unwrap(),
            before,
            "备份内容必须和坏文件完全一致"
        );

        // 再读一次：文件不存在 → 空列表；依然不会偷偷创建文件
        assert!(load_from(&f).unwrap().is_empty());
        assert!(!f.exists(), "第二次读也不能创建文件");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
