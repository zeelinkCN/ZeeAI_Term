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

/// 读这台机器上 herdr 认得的 agent（一行 JSON，解析在 Rust 里做）。
pub fn agents_command() -> String {
    format!(
        "{CLI_PREFIX}; if [ -n \"$H\" ]; then \"$H\" agent list 2>/dev/null; else printf 'HERDR_NONE\\n'; fi"
    )
}

/// 打开一个**只读观察窗**：把窗格的终端字节流引出来。
///
/// `--cols/--rows` 是观察端自己声明要多大 —— herdr 支持多个观察者，而且**不会**因为这个
/// 观察者去改窗格尺寸（这正是我们不再用 TUI attach 的原因：不会再跟手机端抢窗口）。
pub fn observe_command(pane_id: &str, cols: u16, rows: u16) -> String {
    let pane = sanitize_pane(pane_id);
    format!(
        "{CLI_PREFIX}; if [ -z \"$H\" ]; then printf '\\n[ZeeAI] herdr not found on this server - cannot open the pane view.\\n\\n'; exec \"${{SHELL:-/bin/sh}}\"; fi; exec \"$H\" terminal session observe '{pane}' --cols {cols} --rows {rows}"
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
        "{CLI_PREFIX}; if [ -z \"$H\" ]; then exit 0; fi; P='{pane}'; \
while IFS= read -r l; do case \"$l\" in \
T*) v=${{l#T}}; [ -n \"$v\" ] && \"$H\" pane send-text \"$P\" \"$(printf '%s' \"$v\" | base64 -d 2>/dev/null)\" >/dev/null 2>&1 ;; \
K*) v=${{l#K}}; [ -n \"$v\" ] && \"$H\" pane send-keys \"$P\" \"$v\" >/dev/null 2>&1 ;; \
esac; done"
    )
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
}
