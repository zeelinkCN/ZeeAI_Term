//! herdr 集成（方案②）：把 herdr 当成「更准的一路 AI 状态源」，以及「我们自己的只读观察窗」。
//!
//! 为什么不再把 herdr 自己的 TUI 跑在标签页里：
//! - 它退出时经常把终端留在**花屏**状态（用户截图里那次就是）；
//! - 它是有自己布局的 TUI，进了我们这种「一个标签页 = 一个 80x24 视口」的地方，
//!   尺寸/焦点会跟别的客户端互相抢。
//!
//! 现在的做法（全部只读，不改远程任何状态）：
//! - **状态源**：`herdr agent list`（一行 JSON）→ 映射成看板卡片，状态是
//!   `working / blocked / done / idle / unknown`，其中 `blocked` 就是"等你批准/回话"，
//!   这是我们自己扫进程**永远拿不到**的第一手信号；
//! - **看窗格**：`herdr terminal session observe <pane> --cols C --rows R` 给的是一串
//!   JSON 行（每个 `bytes` 字段是 base64 的原始终端字节），在 Rust 侧解出来直接喂 xterm
//!   —— 等于一个只读终端，不抢键盘、不抢尺寸、退出即干净；
//! - **输入**：另开一条常驻 ssh 跑一个「输入泵」，按行收 `T<base64 文本>` / `K<按键名>`，
//!   分别落到 `herdr pane send-text` / `herdr pane send-keys`。
//!   **不模拟任何前缀键**，也不去动用户的 `ctrl+b`。
//!
//! 兼容性判据是**协议号**（`latest.json` 里的 `protocol`，二进制自己也能 `api schema` 打出来），
//! 不是版本号 —— herdr 半年发了 40 多个版本，追版本号必死；而它明确说 client/server 版本可以不一致。

use serde::Serialize;

/// herdr 官方的版本清单：版本号 / 协议号 / 各平台直链 / 各平台 sha256。
pub const LATEST_MANIFEST_URL: &str = "https://herdr.dev/latest.json";

/// 官方 release 在国内经常拉不动（实测 lz 上 ~17KB/s）。**只在官方失败之后**才用镜像，
/// 而且不管从哪来，期望的 sha256 都一样 —— 来源可以换，字节不能换。
pub const MIRROR_PREFIXES: [&str; 2] = ["https://gh-proxy.com/", "https://ghfast.top/"];

/// 我们实测过的 herdr 协议号（0.9.1 自报 22），与 [`super::ai_sessions`] 保持一致口径。
pub use super::ai_sessions::{compat_of, MIN_PROTOCOL, TESTED_PROTOCOL};

/// 解析出来的官方清单
#[derive(Clone, Debug, Default)]
pub struct Manifest {
    pub version: String,
    pub protocol: u32,
    /// 平台键（linux-x86_64 等）→ 直链
    pub assets: Vec<(String, String)>,
    /// 平台键 → sha256（小写）
    pub sha256: Vec<(String, String)>,
}

impl Manifest {
    pub fn asset(&self, platform: &str) -> Option<&str> {
        self.assets
            .iter()
            .find(|(k, _)| k == platform)
            .map(|(_, v)| v.as_str())
    }
    pub fn sha(&self, platform: &str) -> Option<&str> {
        self.sha256
            .iter()
            .find(|(k, _)| k == platform)
            .map(|(_, v)| v.as_str())
    }
}

/// 解析 `latest.json`。用 serde_json 的 Value 手工取字段：
/// 这份清单里还有一个巨大的 `releases` 历史表，不值得为它建一套结构体。
pub fn parse_manifest(text: &str) -> Result<Manifest, String> {
    let v: serde_json::Value =
        serde_json::from_str(text).map_err(|e| format!("官方版本清单不是合法 JSON: {e}"))?;
    let mut m = Manifest {
        version: v
            .get("version")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .trim()
            .to_string(),
        protocol: v.get("protocol").and_then(|x| x.as_u64()).unwrap_or(0) as u32,
        ..Default::default()
    };
    if m.version.is_empty() {
        return Err("官方版本清单里没有 version 字段".into());
    }
    for key in ["assets", "sha256"] {
        let Some(obj) = v.get(key).and_then(|x| x.as_object()) else {
            continue;
        };
        let pairs: Vec<(String, String)> = obj
            .iter()
            .filter_map(|(k, val)| val.as_str().map(|s| (k.clone(), s.trim().to_string())))
            .filter(|(_, s)| !s.is_empty())
            .collect();
        if key == "assets" {
            m.assets = pairs;
        } else {
            m.sha256 = pairs.into_iter().map(|(k, s)| (k, s.to_lowercase())).collect();
        }
    }
    Ok(m)
}

/// `uname -sm` 的输出 → 清单里的平台键。
///
/// 我们只发 **Linux** 的一键安装（Windows 侧下载再 scp 上去）；
/// macOS 也认键名，但按钮在非 Linux 上会直接拒绝，不做半吊子的事。
pub fn platform_key(uname_sm: &str) -> Option<String> {
    let t = uname_sm.trim().to_ascii_lowercase();
    let mut it = t.split_whitespace();
    let os = it.next().unwrap_or("");
    let arch = it.next().unwrap_or("");
    let os_key = match os {
        "linux" => "linux",
        "darwin" => "macos",
        _ => return None,
    };
    let arch_key = match arch {
        "x86_64" | "amd64" => "x86_64",
        "aarch64" | "arm64" => "aarch64",
        _ => return None,
    };
    Some(format!("{os_key}-{arch_key}"))
}

/// herdr 的一个 agent（`herdr agent list` 里的一条）
#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HerdrAgent {
    /// agent 的种类：codex / claude / ...（herdr 自己认出来的）
    pub kind: String,
    /// working / blocked / done / idle / unknown
    pub status: String,
    /// 当前工作目录
    pub cwd: String,
    /// 窗格 id（形如 w1:p1）—— 同时就是给 agent 命令用的"名字"
    pub pane_id: String,
    pub tab_id: String,
    pub workspace_id: String,
    /// 窗格标题（herdr 里显示的那个，通常是 cwd 或用户改的名字）
    pub title: String,
    pub focused: bool,
    /// 这个 agent 是不是在等我们做事（= status == blocked）
    pub attention: bool,
}

/// 解析 `herdr agent list` / `herdr api snapshot` 的输出（一行一个 JSON）。
///
/// 只认 `type == "agent_list"` 的那条；别的一律忽略 —— 宁可"没读到"，
/// 也不要把一个不认识的 JSON 当成 agent 列表塞进看板。
pub fn parse_agents(text: &str) -> Vec<HerdrAgent> {
    let mut out: Vec<HerdrAgent> = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if !line.starts_with('{') {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
            collect_agents(&v, &mut out);
        }
    }
    // 兜底：万一哪天 herdr 改成"整份 JSON 跨多行"，也还能读出来
    if out.is_empty() {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(text.trim()) {
            collect_agents(&v, &mut out);
        }
    }
    out
}

/// 从一条 herdr JSON 里取 agent 数组。认两种形状：
/// - `herdr agent list` → `{"type":"agent_list","result":{"agents":[…]}}`
/// - `herdr api snapshot` → `{"result":{"snapshot":{"agents":[…]}}}`
fn collect_agents(v: &serde_json::Value, out: &mut Vec<HerdrAgent>) {
    let result = v.get("result");
    let list = result
        .and_then(|r| r.get("agents"))
        .or_else(|| {
            result
                .and_then(|r| r.get("snapshot"))
                .and_then(|s| s.get("agents"))
        })
        .and_then(|a| a.as_array());
    let Some(list) = list else {
        return;
    };
    for a in list {
        let s = |k: &str| -> String {
            a.get(k)
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .trim()
                .to_string()
        };
        let status = s("agent_status");
        let pane_id = s("pane_id");
        // 没有 pane id 就没法观察/输入，也就没资格进看板
        if pane_id.is_empty() {
            continue;
        }
        out.push(HerdrAgent {
            kind: s("agent"),
            attention: status == "blocked",
            status,
            cwd: {
                let c = s("cwd");
                if c.is_empty() {
                    s("foreground_cwd")
                } else {
                    c
                }
            },
            pane_id,
            tab_id: s("tab_id"),
            workspace_id: s("workspace_id"),
            title: {
                let t = s("terminal_title_stripped");
                if t.is_empty() {
                    s("terminal_title")
                } else {
                    t
                }
            },
            focused: a.get("focused").and_then(|x| x.as_bool()).unwrap_or(false),
        });
    }
}

/// 看板上的状态字符串（沿用现有卡片的 `running` / `done` 两档，
/// 但 `blocked` 单独开一档，因为它是"要人接手"，不是"跑完了"）。
pub fn board_state(status: &str) -> &'static str {
    match status {
        "working" => "running",
        "blocked" => "blocked",
        "idle" | "done" => "done",
        _ => "unknown",
    }
}

/// 界面上那一句中文
pub fn state_label(status: &str) -> &'static str {
    match status {
        "working" => "运行中",
        "blocked" => "等你处理",
        "done" => "已完成",
        "idle" => "空闲",
        _ => "状态未知",
    }
}

/// 远端「找到 herdr 二进制」的那一段 shell（和官方 install.sh 的查找顺序一致：
/// 先 PATH，再 `~/.local/bin/herdr` —— 官方默认就装后者，而且它可能不在 PATH 里）。
///
/// 所有要跑 herdr 的远端命令都以它开头，避免各处各写一份、改一处漏一处。
pub const CLI_PREFIX: &str = r#"H=""; if command -v herdr >/dev/null 2>&1; then H=$(command -v herdr); elif [ -x "$HOME/.local/bin/herdr" ]; then H="$HOME/.local/bin/herdr"; fi"#;

/// **确保 herdr 服务器在跑**：没跑就以"脱离终端"的方式起一个。
///
/// 为什么必须有这一段（真机上量出来的）：
/// herdr 的 API 命令（`workspace` / `pane` / `agent` / `session`…）都要求**服务器已在运行**，
/// 否则直接返回 `{"error":{"code":"server_not_running"}}`。而我们的应用**刻意不跑她的 TUI**，
/// 所以一旦用户服务器重启（或他自己 `herdr server stop` 过），我们的 herdr 功能会全部失效 ——
/// 除非用户手动去终端敲一次 `herdr`。这里显式补上这一步，效果和用户敲 `herdr` 一样。
///
/// 注意两点：
/// - 用 `setsid`（没有就用 `nohup`）+ 重定向 + 放后台：**不能**让它挂在我们这条 ssh 上，
///   否则 ssh 一断服务器就跟着没了；
/// - 判断用 `^status: running` 而不是 `running`：`herdr status server` 在没有服务器时
///   也会打印 "not running" 之类的字样，用整行匹配才不会误判。
pub const ENSURE_SERVER: &str = r#"if [ -n "$H" ] && ! "$H" status server 2>/dev/null | grep -q '^status: running'; then printf '[ZeeAI] herdr 服务没在跑，已帮你启动。\n' >&2; if command -v setsid >/dev/null 2>&1; then setsid "$H" server </dev/null >/dev/null 2>&1 & else nohup "$H" server </dev/null >/dev/null 2>&1 & fi; sleep 2; fi"#;

/// 读这台机器上 herdr 认得的 agent（一行 JSON，解析在 Rust 里做）。
pub fn agents_command() -> String {
    format!(
        "{CLI_PREFIX}; {ENSURE_SERVER}; if [ -n \"$H\" ]; then \"$H\" agent list 2>/dev/null; else printf 'HERDR_NONE\\n'; fi"
    )
}

/// herdr 里的**一个窗格**（不管里面有没有 agent）
///
/// 为什么除了 agent 还要有它：`agent list` 只给"正在跑 agent"的窗格。
/// 用户想接管一个刚开的、或者 AI 已经退出的空壳窗格时，那个列表是**空的** ——
/// "接管已有窗格"就会变成没东西可选（实测发现）。`pane list` 是所有窗格。
#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HerdrPane {
    pub pane_id: String,
    /// 窗格标题（herdr 里显示的名字，通常是 cwd）
    pub title: String,
    pub cwd: String,
    /// 里面跑着什么 agent（没有就是空串）
    pub agent: String,
    /// 该 agent 的状态：working / blocked / done / idle / unknown
    pub status: String,
    pub focused: bool,
}

/// 读这台机器上的所有窗格
pub fn panes_command() -> String {
    format!(
        "{CLI_PREFIX}; {ENSURE_SERVER}; if [ -n \"$H\" ]; then \"$H\" pane list 2>/dev/null; else printf 'HERDR_NONE\\n'; fi"
    )
}

/// 这台机器上 herdr 服务的状态（**只读**，不带 ENSURE_SERVER —— 探测不该有副作用）。
///
/// 输出格式（两行）：
/// ```text
/// SRV|<herdr status server 的第一行，例如 status: running>
/// <窗格数量>
/// ```
pub fn server_status_command() -> String {
    format!(
        "{CLI_PREFIX}; if [ -n \"$H\" ]; then S=$(\"$H\" status server 2>/dev/null | head -1 | tr -d '\\r'); printf 'SRV|%s\\n' \"$S\"; \"$H\" pane list 2>/dev/null | tr ',' '\\n' | grep -c '\"pane_id\"'; else printf 'SRV|\\n0\\n'; fi"
    )
}

/// herdr 服务的状态
#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatus {
    /// 服务在不在跑（`herdr status server` 打的是 `status: running`）
    pub running: bool,
    /// 原始那一行，界面上可以悬停看
    pub raw: String,
    /// 这套服务里现在有多少个窗格
    pub panes: u32,
}

pub fn parse_server_status(out: &str) -> ServerStatus {
    let mut st = ServerStatus::default();
    let mut saw_srv = false;
    for line in out.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("SRV|") {
            // 注意：**即使 SRV| 后面是空的也要认下来** —— 那表示"问到了，但服务没在跑"；
            // 只有整段里压根没有 SRV 行，才叫"没问出来"（老版本 herdr 没这一列）。
            saw_srv = true;
            st.raw = rest.trim().to_string();
            st.running = st.raw.contains("status: running");
            continue;
        }
        if let Ok(n) = line.parse::<u32>() {
            st.panes = n;
            continue;
        }
        if !saw_srv && !line.is_empty() {
            // 没有 SRV 行时的兜底：整段里出现 "status: running" 也算在跑
            st.raw = line.to_string();
            st.running = line.contains("status: running");
        }
    }
    st
}

/// **启动** herdr 服务（用户显式点「启动」时用；后台起来，不挂在我们这条 ssh 上）
pub fn server_start_command() -> String {
    format!("{CLI_PREFIX}; {ENSURE_SERVER}; {CLI_PREFIX}; \"$H\" status server 2>/dev/null | head -1")
}

/// **停止** herdr 服务（会关掉它管着的所有窗格，所以只在用户明确点「停止」时执行）
pub fn server_stop_command() -> String {
    format!("{CLI_PREFIX}; if [ -n \"$H\" ]; then \"$H\" server stop 2>&1 | head -3; else printf 'no herdr\\n'; fi")
}

/// 扫一遍服务器上的**工作区 + 每个窗格的前台进程**（只读）。
///
/// 为什么要把"前台进程"一起拿回来：清理工作区时要能分清
/// **"空壳"（停在提示符上的 shell）** 和 **"里面正跑着东西"**（codex / vim / 编译…）。
/// 只有前者才允许被清理 —— 后者一旦关掉就是直接毁掉用户正在跑的活。
///
/// 输出形如：
/// ```text
/// WSL|w9
/// WSP|w9:p1|bash
/// ```
pub fn workspace_scan_command() -> String {
    format!(
        "{CLI_PREFIX}; if [ -n \"$H\" ]; then \"$H\" workspace list 2>/dev/null | tr ',' '\\n' | sed -n 's/.*\"workspace_id\":\"\\([^\"]*\\)\".*/WSL|\\1/p' | sort -u; for p in $(\"$H\" pane list 2>/dev/null | tr ',' '\\n' | sed -n 's/.*\"pane_id\":\"\\([^\"]*\\)\".*/\\1/p'); do n=$(\"$H\" pane process-info --pane \"$p\" 2>/dev/null | sed -n 's/.*\"name\":\"\\([^\"]*\\)\".*/\\1/p' | head -1); printf 'WSP|%s|%s\\n' \"$p\" \"$n\"; done; fi"
    )
}

/// 服务器上的一个窗格 + 它的前台进程名（`bash` / `codex` / …）
#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PaneProc {
    pub pane_id: String,
    /// 前台进程名；取不到就是空串（当作"不知道"，按不安全处理）
    pub proc_name: String,
}

/// 一次扫描的结果：有哪些工作区、每个窗格上跑着什么
#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceScan {
    pub workspaces: Vec<String>,
    pub panes: Vec<PaneProc>,
}

pub fn parse_workspace_scan(out: &str) -> WorkspaceScan {
    let mut scan = WorkspaceScan::default();
    for line in out.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("WSL|") {
            let id = rest.trim().to_string();
            if !id.is_empty()
                && sanitize_workspace(&id).as_deref() == Some(id.as_str())
                && !scan.workspaces.contains(&id)
            {
                scan.workspaces.push(id);
            }
            continue;
        }
        if let Some(rest) = line.strip_prefix("WSP|") {
            let (pane, proc_name) = match rest.split_once('|') {
                Some((p, n)) => (p.trim(), n.trim()),
                None => (rest.trim(), ""),
            };
            if !pane.is_empty() && sanitize_pane(pane) == pane {
                scan.panes.push(PaneProc {
                    pane_id: pane.to_string(),
                    // 进程名只用来跟一组 shell 名字做比对（不进任何 shell 片段），
                    // 但仍然只认"干净的一串"：有别的字符就当作"不知道"（空串）。
                    proc_name: if proc_name
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
                    {
                        proc_name.to_string()
                    } else {
                        String::new()
                    },
                });
            }
        }
    }
    scan
}

/// 关掉一个工作区（连带它里面的窗格）。
///
/// 「生命周期管理」的最后一块：herdr 的工作区**天生是持久的**（这正是它的卖点），
/// 但每开一次 herdr 会话就会多一个 —— 关标签页**不会**回收它们，攒久了服务器上
/// 会留一堆没人用的空工作区（用户就撞见过十几条）。所以给用户一个**显式**的清理动作，
/// 只关他自己点了确认的那些；没在用的工作区不会被他以外的人动。
pub fn close_workspace_command(workspace_id: &str) -> String {
    let ws = sanitize_workspace(workspace_id).unwrap_or_default();
    format!(
        "{CLI_PREFIX}; if [ -n \"$H\" ]; then \"$H\" workspace close '{ws}' 2>&1 | head -3; else printf 'no herdr\\n'; fi"
    )
}

/// 把一段文本包进**单引号**（里面的单引号按 shell 的写法断开再拼）。
/// 只有"重命名窗格"这一个动作会用到用户输入的文本。
fn quote_text(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// 「herdr 快捷操作」面板上的按钮 → 具体要跑的 herdr 命令。
///
/// 和 tmux 那份一个道理（见 core/tmux.rs::action_command）：
/// **只认下面这些固定动作**，前端传的是动作名而不是命令，所以这个接口
/// 不会变成"在前端拼任意远端命令"的口子；而且它是**另开一条 ssh 跑 herdr 的
/// socket API**，不往你的终端里塞按键 —— 不抢任何快捷键，也不受"窗格里正在跑程序"的影响。
///
/// `pane` 是当前会话那个窗格（形如 `w1T:p1`）；要工作区号的动作自己从它切出来。
pub fn action_command(pane: &str, action: &str, arg: Option<&str>) -> Option<String> {
    let p = sanitize_pane(pane);
    let ws = p.split(':').next().unwrap_or("").to_string();
    let text = arg.unwrap_or("").trim().to_string();
    let inner = match action {
        // 工作区（= 一条独立的工作，和 tmux 的"窗口/会话"对位）
        "new-workspace" => "\"$H\" workspace create".to_string(),
        "close-workspace" => format!("\"$H\" workspace close '{ws}'"),
        // 窗格
        "split-right" => format!("\"$H\" pane split --pane '{p}' --direction right"),
        "split-down" => format!("\"$H\" pane split --pane '{p}' --direction down"),
        "zoom" => format!("\"$H\" pane zoom --pane '{p}' --toggle"),
        "pane-left" => format!("\"$H\" pane focus --pane '{p}' --direction left"),
        "pane-right" => format!("\"$H\" pane focus --pane '{p}' --direction right"),
        "pane-up" => format!("\"$H\" pane focus --pane '{p}' --direction up"),
        "pane-down" => format!("\"$H\" pane focus --pane '{p}' --direction down"),
        "rename-pane" => {
            if text.is_empty() {
                return None;
            }
            format!("\"$H\" pane rename --pane '{p}' {}", quote_text(&text))
        }
        "close-pane" => format!("\"$H\" pane close '{p}'"),
        _ => return None,
    };
    Some(format!(
        "{CLI_PREFIX}; {ENSURE_SERVER}; if [ -z \"$H\" ]; then printf 'HERDR_NONE\\n'; else {inner} 2>&1 | head -3; fi"
    ))
}

/// 工作区号只允许 `[A-Za-z0-9_-]`（形如 `w9`）。它会被拼进单引号的 shell 片段里，
/// 直接拒绝其它字符比"转义"踏实。**空串返回 `None`**：调用方必须当成非法输入。
pub fn sanitize_workspace(workspace_id: &str) -> Option<String> {
    let cleaned: String = workspace_id
        .trim()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .collect();
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned)
    }
}

/// 解析 `herdr pane list` 的输出（一行 JSON：`{"result":{"panes":[…]}}`）
pub fn parse_panes(text: &str) -> Vec<HerdrPane> {
    let mut out: Vec<HerdrPane> = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if !line.starts_with('{') {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
            collect_panes(&v, &mut out);
        }
    }
    // 兜底：万一哪天 herdr 改成"整份 JSON 跨多行"，也还能读出来（和 parse_agents 一致）
    if out.is_empty() {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(text.trim()) {
            collect_panes(&v, &mut out);
        }
    }
    out
}

/// 从一条 herdr JSON 里取窗格数组（形状与 [`collect_agents`] 一致，只是取的是 panes）
fn collect_panes(v: &serde_json::Value, out: &mut Vec<HerdrPane>) {
    let Some(list) = v
        .get("result")
        .and_then(|r| r.get("panes"))
        .and_then(|p| p.as_array())
    else {
        return;
    };
    for p in list {
        let s = |k: &str| -> String {
            p.get(k)
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .trim()
                .to_string()
        };
        let pane_id = s("pane_id");
        if pane_id.is_empty() {
            continue;
        }
        out.push(HerdrPane {
            pane_id,
            title: {
                let t = s("terminal_title_stripped");
                if t.is_empty() {
                    s("terminal_title")
                } else {
                    t
                }
            },
            cwd: {
                let c = s("cwd");
                if c.is_empty() {
                    s("foreground_cwd")
                } else {
                    c
                }
            },
            agent: s("agent"),
            status: s("agent_status"),
            focused: p.get("focused").and_then(|x| x.as_bool()).unwrap_or(false),
        });
    }
}

/// 在服务器上**新建一个 herdr workspace**（她的一个工作区，自带一个 shell 窗格）。
///
/// 用户勾了"用 herdr 打开新会话"时走这条：新会话在 herdr 里就是一条新工作区，
/// 断线/关标签之后它还在服务器上（和 tmux 新建会话一个感觉）。
pub fn create_workspace_command() -> String {
    format!("{CLI_PREFIX}; {ENSURE_SERVER}; if [ -n \"$H\" ]; then \"$H\" workspace create 2>/dev/null; else printf 'HERDR_NONE\\n'; fi")
}

/// 打开窗格前的**存在性检查片段**（本身不是一条完整命令，由 [`format!`] 拼进去）。
///
/// 为什么必须有它：herdr 服务重启过、或者那个工作区被关掉之后，**老的窗格号就不存在了** ——
/// 这时候 `terminal session observe/control` 会直接报错退出，界面上只剩一片黑。用户报过
/// "重新打开之前的 herdr 会话是黑屏"，根因就在这里。
///
/// 先用 `pane get` 探一下：不在就把"现在还有哪些窗格"列出来，再退回普通 shell ——
/// 用户看到的是一条人话，而不是盯着一块黑屏猜。
const PANE_GUARD_BODY: &str = r#"printf '\n[ZeeAI] herdr 上已经没有窗格 %s 了（服务器重启过，或这个工作区被关掉了）。\n' "$P"; printf '[ZeeAI] 现在还在的窗格：\n'; "$H" pane list 2>/dev/null | tr ',' '\n' | sed -n 's/.*"pane_id":"\([^"]*\)".*/  - \1/p'; printf '\n[ZeeAI] 这里先退回普通 shell；要接着用 herdr，请在左侧列表里重新开一个 herdr 会话。\n\n'"#;

/// 打开一个**只读观察窗**：把窗格的终端字节流引出来。
///
/// `--cols/--rows` 是观察端自己声明要多大 —— herdr 支持多个观察者，而且**不会**因为这个
/// 观察者去改窗格尺寸（这正是我们不再用 TUI attach 的原因：不会再跟手机端抢窗口）。
///
/// 打开之前先做 [`PANE_GUARD_BODY`] 的存在性检查：窗格没了就给人话 + 退回 shell，不留黑屏。
pub fn observe_command(pane_id: &str, cols: u16, rows: u16) -> String {
    let pane = sanitize_pane(pane_id);
    format!(
        "{CLI_PREFIX}; {ENSURE_SERVER}; if [ -z \"$H\" ]; then printf '\\n[ZeeAI] herdr not found on this server - cannot open the pane view.\\n\\n'; exec \"${{SHELL:-/bin/sh}}\"; fi; P='{pane}'; if ! \"$H\" pane get \"$P\" >/dev/null 2>&1; then {PANE_GUARD_BODY}; exec \"${{SHELL:-/bin/sh}}\"; fi; exec \"$H\" terminal session observe '{pane}' --cols {cols} --rows {rows}"
    )
}

/// 「输入泵」：常驻一个 ssh，按行读指令。
///
/// - `T<base64>`：把这段文本**按字面**送进窗格（`pane send-text`，等价于键盘敲进去）；
/// - `K<按键名>`：送一个逻辑按键（`enter` / `esc` / `ctrl+c` / `up` …）。
///
/// 为什么要用 base64 包一层：远端 shell 是**按行**读的，文本里可能有空格、引号、中文、
/// 甚至内嵌换行；base64 之后这些都不再是"语法"，只剩 [A-Za-z0-9+/=]。
pub fn input_pump_command(pane_id: &str) -> String {
    let pane = sanitize_pane(pane_id);
    format!(
        "{CLI_PREFIX}; {ENSURE_SERVER}; if [ -z \"$H\" ]; then exit 0; fi; P='{pane}'; \
while IFS= read -r l; do case \"$l\" in \
T*) v=${{l#T}}; [ -n \"$v\" ] && \"$H\" pane send-text \"$P\" \"$(printf '%s' \"$v\" | base64 -d 2>/dev/null)\" >/dev/null 2>&1 ;; \
K*) v=${{l#K}}; [ -n \"$v\" ] && \"$H\" pane send-keys \"$P\" \"$v\" >/dev/null 2>&1 ;; \
esac; done"
    )
}

/// 打开一个**可写**的终端流（就是我们自己的界面"进到她的环境里"那条路）。
///
/// 和观察窗的区别（实测记录，见 docs/impl-log-2026-09-29-herdr.md）：
/// - 观察窗 `terminal session observe`：只读、可多开、**不吃输入**；
/// - 控制流 `terminal session control`：**可读可写**，一个窗格同一时间只允许一个控制端，
///   需要抢过来时加 `--takeover`；帧格式和观察窗**完全一样**，
///   所以解码那套代码两边共用；输入/改尺寸/退出走 stdin 上的 JSON 行（见下面的 `*_line`）。
///
/// 为什么不用 `herdr --session <名>` 那种整屏 TUI：那条路退出时会把终端留在花屏状态，
/// 而且它自己会跟别的客户端抢窗格尺寸（用户截的两张图都是它）。
///
/// 同样要先过 [`PANE_GUARD_BODY`]：窗格没了就给人话 + 退回 shell（否则一片黑）。
pub fn control_command(pane_id: &str, cols: u16, rows: u16, takeover: bool) -> String {
    let pane = sanitize_pane(pane_id);
    let tk = if takeover { " --takeover" } else { "" };
    format!(
        "{CLI_PREFIX}; {ENSURE_SERVER}; if [ -z \"$H\" ]; then printf '\\n[ZeeAI] herdr not found on this server - cannot open the pane.\\n\\n'; exec \"${{SHELL:-/bin/sh}}\"; fi; P='{pane}'; if ! \"$H\" pane get \"$P\" >/dev/null 2>&1; then {PANE_GUARD_BODY}; exec \"${{SHELL:-/bin/sh}}\"; fi; exec \"$H\" terminal session control '{pane}'{tk} --cols {cols} --rows {rows}"
    )
}

/// stdin 指令：把一段**原始字节**按字面送进窗格（等价于键盘敲进去）。
///
/// 为什么用 `bytes` + base64：实测只有这个字段名认（`data` / `data_base64` 发过去没有任何反应）；
/// 而且 base64 之后，换行、引号、中文、方向键（`\x1b[A`）都不会破坏"一行一条 JSON"的格式。
///
/// 回车怎么发：**base64 里带 `\r`**（`echo hi\r`）—— 实测能提交；只发 `\n` 那种是打字，
/// 不会执行。
pub fn input_line(bytes: &[u8]) -> String {
    use base64::Engine as _;
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    format!("{{\"type\":\"terminal.input\",\"bytes\":\"{b64}\"}}")
}

/// stdin 指令：改这个控制端自己的视口大小（不用像观察窗那样把流重开一次）
pub fn resize_line(cols: u16, rows: u16) -> String {
    format!("{{\"type\":\"terminal.resize\",\"cols\":{cols},\"rows\":{rows}}}")
}

/// stdin 指令：主动交还控制权（窗格本身**不会**被关掉，留在服务器上等你回来）
pub fn release_line() -> String {
    "{\"type\":\"terminal.release\"}".to_string()
}

/// 一条流记录的解码结果
#[derive(Clone, Debug, PartialEq)]
pub enum StreamLine {
    /// 数据帧：base64 解出来的原始终端字节
    Data(Vec<u8>),
    /// 服务端关流（例如被别的客户端接管了）—— 里面是人话，应该进状态栏而不是打进终端
    Closed(String),
    /// 其它（不是 JSON / 不认识的记录）—— 原样透传，免得用户什么都看不到
    Other(Vec<u8>),
}

/// 解一条 herdr 流记录（观察窗和控制流**共用**同一种帧格式）。
///
/// 为什么要单独认 `terminal.closed`：它是一条合法 JSON 但没有 `bytes` 字段，
/// 如果按"不认识就原样打印"处理，终端里会冒出一行 `{"type":"terminal.closed",...}` 的怪东西。
pub fn classify_line(line: &str) -> StreamLine {
    let t = line.trim();
    if !t.starts_with('{') {
        return StreamLine::Other(line.as_bytes().to_vec());
    }
    let Ok(v) = serde_json::from_str::<serde_json::Value>(t) else {
        return StreamLine::Other(line.as_bytes().to_vec());
    };
    if v.get("type").and_then(|x| x.as_str()) == Some("terminal.closed") {
        let reason = v.get("reason").and_then(|x| x.as_str()).unwrap_or("");
        return StreamLine::Closed(match reason {
            "detached" => "这个窗格被别的客户端接管了（现在看的是只读画面）".to_string(),
            "" => "herdr 关掉了这条终端流".to_string(),
            other => format!("herdr 关掉了这条终端流（{other}）"),
        });
    }
    match v.get("bytes").and_then(|x| x.as_str()) {
        Some(b64) => {
            use base64::Engine as _;
            match base64::engine::general_purpose::STANDARD.decode(b64.as_bytes()) {
                Ok(d) => StreamLine::Data(d),
                // 解不开就当成"不是数据帧"，原样透传（宁可多打一行，也别吞掉内容）
                Err(_) => StreamLine::Other(line.as_bytes().to_vec()),
            }
        }
        None => StreamLine::Other(line.as_bytes().to_vec()),
    }
}

/// 从 `herdr workspace create` 的输出里取新窗格号（形如 w3:p1）
pub fn pane_from_create(out: &str) -> Option<String> {
    for line in out.lines() {
        let t = line.trim();
        if !t.starts_with('{') {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(t) else {
            continue;
        };
        if let Some(id) = v
            .get("result")
            .and_then(|r| r.get("root_pane"))
            .and_then(|p| p.get("pane_id"))
            .and_then(|x| x.as_str())
        {
            if !id.trim().is_empty() {
                return Some(id.trim().to_string());
            }
        }
    }
    None
}

/// 窗格 id 只允许 `[A-Za-z0-9:_-]`：它会被拼进单引号的 shell 片段，
/// 直接拒绝其它字符，比"转义"踏实（这个值来自我们自己的探测，但边界上仍然要挡）。
pub fn sanitize_pane(pane_id: &str) -> String {
    let cleaned: String = pane_id
        .trim()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == ':' || *c == '_' || *c == '-')
        .collect();
    if cleaned.is_empty() {
        "w1:p1".to_string()
    } else {
        cleaned
    }
}

/// 安装完成后在远端做的**只读**自检：版本 + 协议号 + 路径。
/// 用 `-x` 明确检查我们装的那个文件，不依赖 PATH。
pub fn installed_check_command() -> String {
    "B=\"$HOME/.local/bin/herdr\"; if [ -x \"$B\" ]; then V=$(\"$B\" --version 2>/dev/null | head -1 | tr -d '\\r'); S=$(\"$B\" api schema 2>/dev/null | head -4 | tr -d '\\r'); P=$(printf '%s\\n' \"$S\" | sed -n 's/^protocol: *//p' | head -1); printf 'HDR|%s|%s|%s\\n' \"$V\" \"${P:-0}\" \"$B\"; else printf 'HDR|none|0|\\n'; fi"
        .to_string()
}

/// 远端平台（`uname -sm`）
pub fn uname_command() -> String {
    "uname -sm 2>/dev/null || printf 'unknown unknown\\n'".to_string()
}

/// 解析 [`installed_check_command`] 的输出
pub fn parse_installed(out: &str) -> Option<(String, u32)> {
    for line in out.lines() {
        let Some(rest) = line.trim().strip_prefix("HDR|") else {
            continue;
        };
        let mut it = rest.splitn(3, '|');
        let ver = it.next().unwrap_or("").trim();
        let proto = it
            .next()
            .and_then(|s| s.trim().parse::<u32>().ok())
            .unwrap_or(0);
        if ver.is_empty() || ver == "none" {
            return None;
        }
        return Some((
            ver.trim_start_matches("herdr ").trim().to_string(),
            proto,
        ));
    }
    None
}

/// 一个待下载的候选来源（官方直链 / 镜像）
#[derive(Clone, Debug, PartialEq)]
pub struct Source {
    pub label: String,
    pub url: String,
}

/// 候选来源列表：官方打头，镜像兜底。**顺序固定**，写在这里方便以后加镜像。
pub fn sources(asset_url: &str) -> Vec<Source> {
    let mut list = vec![Source {
        label: "官方".into(),
        url: asset_url.to_string(),
    }];
    for (i, p) in MIRROR_PREFIXES.iter().enumerate() {
        list.push(Source {
            label: format!("镜像{}", i + 1),
            url: format!("{p}{asset_url}"),
        });
    }
    list
}

/// herdr 版本清单里的平台键，和我们要不要给这个平台装
pub fn is_supported_platform(platform: &str) -> bool {
    platform.starts_with("linux-")
}

// ---------- 单测 ----------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_parse_takes_version_protocol_and_per_platform_sha() {
        let text = r#"{
          "version": "0.9.1",
          "protocol": 22,
          "assets": {
            "linux-x86_64": "https://github.com/herdrdev/herdr/releases/download/v0.9.1/herdr-linux-x86_64",
            "windows-x86_64": "https://x/y.zip"
          },
          "sha256": { "linux-x86_64": "2A02FED16BEB651EF006E1D43F048F652CA4DC58AD053CD2D44450563D5C54B7" },
          "releases": { "0.9.0": { "notes": "..." } }
        }"#;
        let m = parse_manifest(text).unwrap();
        assert_eq!(m.version, "0.9.1");
        assert_eq!(m.protocol, 22);
        assert!(m.asset("linux-x86_64").unwrap().ends_with("herdr-linux-x86_64"));
        // sha 统一小写，比较时不用再管大小写
        assert_eq!(
            m.sha("linux-x86_64").unwrap(),
            "2a02fed16beb651ef006e1d43f048f652ca4dc58ad053cd2d44450563d5c54b7"
        );
        assert!(m.asset("plan9-mips").is_none());
    }

    #[test]
    fn platform_key_maps_uname() {
        assert_eq!(platform_key("Linux x86_64\n").unwrap(), "linux-x86_64");
        assert_eq!(platform_key("Linux aarch64").unwrap(), "linux-aarch64");
        assert_eq!(platform_key("Darwin arm64").unwrap(), "macos-aarch64");
        assert!(platform_key("FreeBSD amd64").is_none());
    }

    #[test]
    fn agents_parse_keeps_pane_bound_agents_only() {
        let line = r#"{"id":"cli:agent:list","result":{"agents":[
          {"agent":"codex","agent_status":"blocked","cwd":"/home/lz/proj","focused":true,"pane_id":"w2:p1","tab_id":"w2:t1","terminal_title":"lz","terminal_title_stripped":"proj","workspace_id":"w2"},
          {"agent":"claude","agent_status":"working","cwd":"/tmp","pane_id":"","tab_id":"w3:t1","workspace_id":"w3"}
        ]},"type":"agent_list"}"#;
        let got = parse_agents(line);
        assert_eq!(got.len(), 1, "没有 pane_id 的条目不该进看板");
        assert_eq!(got[0].kind, "codex");
        assert_eq!(got[0].pane_id, "w2:p1");
        assert_eq!(got[0].title, "proj");
        assert!(got[0].attention, "blocked 必须被标成「等你处理」");
        assert_eq!(board_state("blocked"), "blocked");
        assert_eq!(board_state("working"), "running");
        assert_eq!(board_state("idle"), "done");
        assert_eq!(state_label("blocked"), "等你处理");
    }

    #[test]
    fn pane_id_is_sanitized_before_being_embedded() {
        assert_eq!(sanitize_pane(" w2:p1\n"), "w2:p1");
        assert_eq!(sanitize_pane("w2:p1'; rm -rf / #"), "w2:p1rm-rf");
        assert_eq!(sanitize_pane("!!!"), "w1:p1");
        let cmd = observe_command("w2:p1", 120, 40);
        assert!(cmd.contains("terminal session observe 'w2:p1' --cols 120 --rows 40"));
        assert!(!cmd.contains('\n'), "远端命令必须是单行（CRLF 会把 shell 语法搞坏）");
    }

    #[test]
    fn sources_keep_official_first_then_mirrors() {
        let s = sources("https://github.com/a/b/releases/download/v1/x");
        assert_eq!(s[0].label, "官方");
        assert!(s[0].url.starts_with("https://github.com/"));
        assert!(s[1].url.starts_with("https://gh-proxy.com/https://github.com/"));
        // 换来源，期望的字节不变：镜像只是"换条路把同一份东西拿回来"
        assert!(s.iter().all(|x| x.url.ends_with("/v1/x")));
    }

    #[test]
    fn parse_installed_handles_both_states() {
        assert!(parse_installed("HDR|none|0|\n").is_none());
        let got = parse_installed("noise\nHDR|herdr 0.9.1|22|/home/lz/.local/bin/herdr\n").unwrap();
        assert_eq!(got.0, "0.9.1");
        assert_eq!(got.1, 22);
        assert!(got.1 >= MIN_PROTOCOL && got.1 == TESTED_PROTOCOL);
    }

    #[test]
    fn control_command_is_single_line_and_can_take_over() {
        let c = control_command("w2:p1", 120, 40, false);
        assert!(c.contains("terminal session control 'w2:p1' --cols 120 --rows 40"));
        assert!(!c.contains("--takeover"));
        assert!(!c.contains('\n'), "远端命令必须单行");
        let t = control_command("w2:p1", 80, 24, true);
        assert!(t.contains("terminal session control 'w2:p1' --takeover --cols 80 --rows 24"));
        // 窗格号照样要消毒，别被拼进 shell
        let bad = control_command("w2:p1'; rm -rf / #", 80, 24, true);
        assert!(!bad.contains("rm -rf"));
    }

    #[test]
    fn every_api_command_ensures_the_server_is_running() {
        // herdr 的 API 命令都要求服务器在跑，否则返回 server_not_running ——
        // 用户服务器重启后功能就全废。所以每条命令前都要有 ENSURE_SERVER。
        for cmd in [
            agents_command(),
            panes_command(),
            create_workspace_command(),
            observe_command("w1:p1", 80, 24),
            control_command("w1:p1", 80, 24, true),
            input_pump_command("w1:p1"),
        ] {
            assert!(
                cmd.contains("status server") && cmd.contains("server </dev/null"),
                "少了「确保服务器在跑」那一段：{cmd}"
            );
            assert!(!cmd.contains('\n'), "远端命令必须单行（CRLF 会把 shell 语法搞坏）");
        }
    }

    #[test]
    fn pane_open_commands_guard_against_a_dead_pane() {
        // 服务重启过之后老窗格号就没了：必须**先探一下**，而不是让 observe/control
        // 直接报错退出 → 界面只剩一片黑（用户报过这个）。
        for cmd in [observe_command("w1:p1", 80, 24), control_command("w1:p1", 80, 24, true)] {
            assert!(cmd.contains(r#"pane get "$P" >/dev/null 2>&1"#), "少了窗格存在性检查：{cmd}");
            assert!(cmd.contains("已经没有窗格"), "窗格没了要给人话：{cmd}");
            assert!(cmd.contains(r#"exec "${SHELL:-/bin/sh}""#), "窗格没了要能退回 shell：{cmd}");
            assert!(!cmd.contains('\n'), "远端命令必须单行");
            // 消毒过的窗格号，不能被拼成别的命令
            let bad = control_command("w1:p1'; touch /tmp/x; #", 80, 24, true);
            assert!(!bad.contains("touch /tmp/x"), "窗格号没消毒：{bad}");
        }
    }

    #[test]
    fn parses_server_status_in_both_shapes() {
        let running = parse_server_status("SRV|status: running\n3\n");
        assert!(running.running);
        assert_eq!(running.panes, 3);
        assert_eq!(running.raw, "status: running");

        // 服务没在跑时那一行可能是空的 —— 只要 SRV 行在，就得算成"问到了、没在跑"，
        // 而且**后面的窗格数不能被当成状态行吃掉**（这里就是曾经的坑）
        let stopped = parse_server_status("SRV|\n0\n");
        assert!(!stopped.running);
        assert_eq!(stopped.panes, 0);

        // 老版本 herdr 没有这一列：退回"整段里找 status: running"
        let old = parse_server_status("server:\n  status: running\n");
        assert!(old.running);
        assert!(!parse_server_status("").running);
    }

    #[test]
    fn workspace_commands_are_sanitized_and_single_line() {
        assert_eq!(sanitize_workspace("w9").as_deref(), Some("w9"));
        assert_eq!(sanitize_workspace(" w-9_A ").as_deref(), Some("w-9_A"));
        assert!(sanitize_workspace("   ").is_none());
        assert!(sanitize_workspace("; rm -rf /").is_some(), "非法字符是被**过滤掉**的");
        assert_eq!(sanitize_workspace("; rm -rf /").as_deref(), Some("rm-rf"));
        let c = close_workspace_command("w9");
        assert!(c.contains("workspace close 'w9'"));
        assert!(!c.contains('\n'));
        let bad = close_workspace_command("w9'; touch /tmp/x; #");
        assert!(!bad.contains("touch /tmp/x"), "工作区号没消毒：{bad}");
    }

    #[test]
    fn shortcut_actions_are_whitelisted_and_single_line() {
        // 只认白名单：前端传动作名，不能借这个口子拼任意命令
        assert!(action_command("w1T:p1", "rm -rf /", None).is_none());
        assert!(action_command("w1T:p1", "unknown", None).is_none());
        // 重命名必须给文本
        assert!(action_command("w1T:p1", "rename-pane", None).is_none());
        assert!(action_command("w1T:p1", "rename-pane", Some("  ")).is_none());

        for (action, arg, want) in [
            ("new-workspace", None, "workspace create"),
            ("split-right", None, "pane split --pane 'w1T:p1' --direction right"),
            ("split-down", None, "pane split --pane 'w1T:p1' --direction down"),
            ("zoom", None, "pane zoom --pane 'w1T:p1' --toggle"),
            ("pane-left", None, "pane focus --pane 'w1T:p1' --direction left"),
            ("close-pane", None, "pane close 'w1T:p1'"),
            ("close-workspace", None, "workspace close 'w1T'"),
            ("rename-pane", Some("我的窗格"), "pane rename --pane 'w1T:p1' '我的窗格'"),
        ] {
            let cmd = action_command("w1T:p1", action, arg).unwrap_or_default();
            assert!(cmd.contains(want), "{action} 生成的不对：{cmd}");
            // 每条都得先确保服务在跑，而且必须是单行
            assert!(cmd.contains("status server") && cmd.contains("server </dev/null"));
            assert!(!cmd.contains('\n'), "远端命令必须单行：{cmd}");
        }
        // 带引号的窗格号/文本不能把命令拼坏
        let evil = action_command("w1T:p1'; touch /tmp/x; #", "rename-pane", Some("a'; rm -rf / #"))
            .unwrap_or_default();
        assert!(!evil.contains("touch /tmp/x"), "窗格号没消毒：{evil}");
        assert!(evil.contains(r"'a'\''; rm -rf / #'"), "文本没按 shell 规则转义：{evil}");
    }

    #[test]
    fn scans_workspaces_and_their_foreground_process() {
        // 真机上拿回来的形状（见库里那条 ssh 实测）
        let out = "WSL|w9\nWSL|wD\nWSP|w9:p1|bash\nWSP|wD:p1|codex\n";
        let scan = parse_workspace_scan(out);
        assert_eq!(scan.workspaces, vec!["w9".to_string(), "wD".to_string()]);
        assert_eq!(
            scan.panes,
            vec![
                PaneProc { pane_id: "w9:p1".into(), proc_name: "bash".into() },
                PaneProc { pane_id: "wD:p1".into(), proc_name: "codex".into() },
            ]
        );
        // 脏数据要挡住（工作区号 / 窗格号会被拼进远端 shell；进程名只做比对，
        // 但也只认干净的一串，带别的字符就当"不知道"）
        let dirty = parse_workspace_scan("WSL|w9'; rm -rf /\nWSP|w9:p1|x\"; rm -rf /\nWSP||x\n");
        assert!(dirty.workspaces.is_empty(), "{:?}", dirty.workspaces);
        assert_eq!(
            dirty.panes,
            vec![PaneProc { pane_id: "w9:p1".into(), proc_name: String::new() }],
            "窗格号合法就留着，但进程名必须被清成空串"
        );
        assert!(parse_workspace_scan("").workspaces.is_empty());
    }

    #[test]
    fn stdin_lines_match_the_wire_format_we_measured() {
        // 回车要用 \r（实测能提交），并且整行必须是合法 JSON、单行
        let l = input_line(b"echo hi\r");
        assert_eq!(l, "{\"type\":\"terminal.input\",\"bytes\":\"ZWNobyBoaQ0=\"}");
        assert!(!l.contains('\n'));
        assert_eq!(resize_line(100, 30), "{\"type\":\"terminal.resize\",\"cols\":100,\"rows\":30}");
        assert_eq!(release_line(), "{\"type\":\"terminal.release\"}");
        // 方向键这种控制字节也要能原样塞进 base64
        let up = input_line(b"\x1b[A");
        assert_eq!(up, "{\"type\":\"terminal.input\",\"bytes\":\"G1tB\"}");
    }

    #[test]
    fn stream_lines_are_classified_not_printed_raw() {
        // 数据帧 → 原始字节
        let frame = format!(
            "{{\"bytes\":\"{}\"}}",
            {
                use base64::Engine as _;
                base64::engine::general_purpose::STANDARD.encode(b"\x1b[31mhi")
            }
        );
        assert_eq!(
            classify_line(&frame),
            StreamLine::Data(b"\x1b[31mhi".to_vec())
        );
        // 关流记录不能原样打进终端（否则屏幕上冒出一行 JSON），要翻成人话
        let closed = classify_line("{\"type\":\"terminal.closed\",\"reason\":\"detached\"}");
        match closed {
            StreamLine::Closed(msg) => assert!(msg.contains("接管")),
            other => panic!("terminal.closed 应该被认出来，实际：{other:?}"),
        }
        // 不是 JSON 的东西原样透传
        assert_eq!(
            classify_line("herdr: boom\n"),
            StreamLine::Other(b"herdr: boom\n".to_vec())
        );
        // 合法 JSON 但没有 bytes 字段 → 也算"不认识"，透传
        assert_eq!(
            classify_line("{\"other\":1}"),
            StreamLine::Other(b"{\"other\":1}".to_vec())
        );
    }

    #[test]
    fn pane_id_comes_out_of_workspace_create() {
        let out = r#"{"id":"cli:workspace:create","result":{"root_pane":{"pane_id":"w5:p1","cwd":"/home/lz"},"tab":{"tab_id":"w5:t1"},"workspace":{"workspace_id":"w5"}}}"#;
        assert_eq!(pane_from_create(out).unwrap(), "w5:p1");
        assert!(pane_from_create("no json here").is_none());
        assert!(pane_from_create("{\"result\":{\"root_pane\":{\"pane_id\":\"\"}}}").is_none());
    }

    #[test]
    fn panes_include_shells_without_agents() {
        // 真实输出（lz 上抓的）：一个跑着 codex 的窗格 + 一个空壳窗格
        let line = r#"{"id":"cli:pane:list","result":{"panes":[
          {"agent":"codex","agent_status":"idle","cwd":"/home/lz","focused":true,"pane_id":"w2:p1","terminal_title_stripped":"lz"},
          {"agent_status":"unknown","cwd":"/home/lz","focused":false,"pane_id":"w9:p1","terminal_title_stripped":"lz"}
        ]},"type":"pane_list"}"#;
        let got = parse_panes(line);
        assert_eq!(got.len(), 2, "空壳窗格也要列出来（否则没东西可接管）");
        assert_eq!(got[0].agent, "codex");
        assert_eq!(got[0].status, "idle");
        assert!(got[1].agent.is_empty());
        assert_eq!(got[1].pane_id, "w9:p1");
    }
}
