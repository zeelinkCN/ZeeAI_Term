//! 本机 AI CLI 的健康检查：**装了没 / 装了但坏了 / 正在自更新**。
//!
//! 为什么单独做这件事（用户已批准的第 8 条）：本机 CLI 坏掉的方式有好几种，
//! 但在界面上它们长得**一模一样** —— "扫不到进程"既可能是"没装"，
//! 也可能是"装了但入口丢了"。用户真实踩过的四种症状：
//!
//! 1. **入口丢了**：包在 `%APPDATA%\npm\node_modules\@openai\codex`，但
//!    `%APPDATA%\npm\codex.cmd` 不见了 → 在 PowerShell 里敲 `codex` 报
//!    "无法将 … 识别为 cmdlet"；
//! 2. **缺平台二进制**：`Error: Missing optional dependency @openai/codex-win32-x64.
//!    Reinstall Codex: npm install -g @openai/codex@latest`；
//! 3. **正在自更新**：`npm install -g @openai/codex` 在跑 —— 期间它**不接受输入**，
//!    用户从输入窗发的字会落到裸 shell（这是"回车没反应"那次的一部分原因）；
//! 4. **守护进程起不来**：`Error: 拒绝访问。 (os error 5)`，官方建议 `--no-daemon`。
//!
//! 三条纪律：
//! - **"扫不到" ≠ "没装"** —— 必须能区分，并把证据（stderr 原文）留着；
//! - **不许把"没法证明"说成事实** —— 拿不到进程命令行就报 `Unknown`，不猜"在更新"；
//! - `fix` **只描述、不执行** —— 真正动手要用户点（安装本身是重动作，替用户装东西不合适）。
//!
//! 前端只负责显示这五个词与 `fix.label`；探测逻辑（含"哪些症状对应哪种修法"）
//! 只在这一份实现里，避免前端和后端各判一套。

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use super::ai_instance::AgentKind;

/// 探测结果的五种状态。**"没装"和"装了但坏了"必须分开** —— 前者要装，后者要修。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CliStatus {
    Ok,
    NotInstalled,
    InstalledButBroken,
    Updating,
    Unknown,
}

impl CliStatus {
    /// 是不是"该在看板上冒一格异常"的状态（正常/未知不冒）。
    pub fn is_anomaly(self) -> bool {
        matches!(self, CliStatus::InstalledButBroken | CliStatus::Updating)
    }
}

/// 建议用户做的事。`value` 里放的是**参数或命令原文**，不改写。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case", tag = "kind", content = "value")]
pub enum FixKind {
    /// 重装（给一条能直接粘进终端的命令）。
    Reinstall,
    /// 换启动参数（例如 codex 的 `--no-daemon`）。
    AddFlag(String),
    /// 没有可自动化的修法，只说清下一步。
    OpenDocs,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Fix {
    /// 界面上那个按钮/一行字的文案（中文，用户能照做）。
    pub label: String,
    pub kind: FixKind,
}

/// 一个本机 agent CLI 的健康状况。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CliHealth {
    pub agent: AgentKind,
    /// 我们实际用的命令名（`codex` / `claude` / …）。
    pub command: String,
    pub status: CliStatus,
    /// 一行结论（状态栏/看板异常位直接用这句）。
    pub summary: String,
    /// 证据原文（stderr / 找到的路径 / 命中的进程命令行），悬停时看。
    pub detail: String,
    pub fix: Option<Fix>,
    /// 「在终端里启动它」该敲的那一行 —— 已经带上用户选过的额外参数
    /// （例如 `codex --no-daemon`）。
    ///
    /// 为什么由后端给：加参数这件事的**语义**（只影响我们启动的方式，不动全局配置）
    /// 和判定逻辑放在一起，前端就不用各自拼一份命令。
    #[serde(default)]
    pub run_cmd: String,
}

/// 允许我们替用户加进启动命令的**参数白名单**。
///
/// 为什么要白名单：这些参数最终会被拼成一条**要敲进用户终端**的命令，
/// 而参数来源是界面上那一下点击 —— 不做白名单就等于开了个"往终端塞任意串"的口子。
/// 目前只有 `--no-daemon`（codex 官方对"守护进程起不来 / os error 5"的建议）。
pub const ALLOWED_LAUNCH_FLAGS: [&str; 1] = ["--no-daemon"];

/// 把"我们启动时额外带的参数"接在命令名后面（空参数表 → 原样返回命令名）。
pub fn launch_command(command: &str, extra: &[String]) -> String {
    let kept: Vec<&str> = extra
        .iter()
        .map(|f| f.trim())
        .filter(|f| ALLOWED_LAUNCH_FLAGS.contains(f))
        .collect();
    if kept.is_empty() {
        command.to_string()
    } else {
        format!("{command} {}", kept.join(" "))
    }
}

/// 我们认识的几个本机 agent（顺序即界面展示顺序）。
pub fn known_commands() -> Vec<(AgentKind, &'static str)> {
    vec![
        (AgentKind::Codex, "codex"),
        (AgentKind::Claude, "claude"),
        (AgentKind::Gemini, "gemini"),
        (AgentKind::Aider, "aider"),
    ]
}

/// 命令名 → 包名。用来拼"重装"命令，也用来认"是不是它在自更新"。
/// 认不出来就 `None`（**别瞎拼一个包名**）。
pub fn npm_package_for(command: &str) -> Option<&'static str> {
    match command {
        "codex" => Some("@openai/codex"),
        "claude" => Some("@anthropic-ai/claude-code"),
        "gemini" => Some("@google/gemini-cli"),
        _ => None,
    }
}

/// 拼一条"能直接粘进终端"的重装命令。
///
/// 注意 aider 是 **Python 生态**的：用 npm 命令去"重装"会把人带沟里，所以单独给。
pub fn reinstall_command(command: &str) -> String {
    match command {
        "aider" => "python -m pip install -U aider-chat".into(),
        _ => match npm_package_for(command) {
            Some(pkg) => format!("npm install -g {pkg}@latest"),
            // 认不出的命令：别瞎猜包名，用命令名兜底（界面会把这条原文显示出来让用户自己判断）
            None => format!("npm install -g {command}@latest"),
        },
    }
}

/// 解析 `where.exe <cmd>` 的输出（CRLF、空行、带引号都要忍）。
pub fn parse_where_output(out: &str) -> Vec<PathBuf> {
    out.lines()
        .map(|l| l.trim().trim_matches('"').trim())
        .filter(|l| !l.is_empty())
        .map(PathBuf::from)
        .collect()
}

/// npm 全局 bin 目录下的候选入口。
///
/// 为什么要自己拼：用户的 codex 就坏在"包在、shim 不在"，而 `where` 也找不到它 ——
/// 只查 `where` 会把"入口丢了"误判成"没装"。
///
/// 顺序 = **Windows 能直接起的优先**：`.cmd` > `.exe` > `.ps1`。
/// （npm 还会生成一个**无扩展名**的 sh 脚本给 Git Bash 用，那个 CreateProcess 起不了，
/// 实测会把好的 codex 误报成"装了但坏了" —— 所以它排在最后。）
pub fn npm_shim_candidates(npm_dir: &Path, command: &str) -> Vec<PathBuf> {
    vec![
        npm_dir.join(format!("{command}.cmd")),
        npm_dir.join(format!("{command}.exe")),
        npm_dir.join(format!("{command}.ps1")),
        npm_dir.join(command), // 无扩展名的 sh shim：最后备选
    ]
}

/// 可执行性排序：数字越小越优先（`.cmd` 走 `cmd /C`、`.exe` 直接起、`.ps1` 走 powershell）。
/// 无扩展名的返回 3 —— 还能当"找到了"的证据，但不该被优先选中。
fn exec_rank(p: &Path) -> u8 {
    match p
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("cmd") | Some("bat") => 0,
        Some("exe") => 1,
        Some("ps1") => 2,
        Some(_) => 3,
        None => 3,
    }
}

/// 入口解析：`where` 和 npm 全局目录**都看**，并挑"最像能直接起"的那个。
///
/// 为什么不是"取第一个存在的"：`where codex` 会同时列出 `codex`（sh）、`codex.cmd`、
/// `codex.ps1`，取第一个就会拿到 sh 那个 → 起不来 → 误报"坏了"。
pub fn resolve_command(command: &str, where_out: &str, npm_dir: Option<&Path>) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = parse_where_output(where_out);
    if let Some(dir) = npm_dir {
        candidates.extend(npm_shim_candidates(dir, command));
    }
    candidates
        .into_iter()
        .filter(|p| p.exists())
        .min_by_key(|p| exec_rank(p))
}

/// 从 stderr 认出"坏在哪"，并给出对应修法。认不出就返回通用坏法（原文留着）。
///
/// 四种真实症状的判据都写在这里，改判据只改这一处。
pub fn classify_failure(command: &str, stderr: &str) -> (String, Fix) {
    let low = stderr.to_ascii_lowercase();

    // ② 缺平台二进制：npm 的 optional dependency 没装上（自动更新装了一半最典型）
    if low.contains("missing optional dependency") {
        return (
            "缺平台二进制（安装没装完，最常见的是一次被打断的自动更新）".into(),
            Fix {
                label: format!("重装：{}", reinstall_command(command)),
                kind: FixKind::Reinstall,
            },
        );
    }

    // ④ 守护进程起不来：官方建议 --no-daemon
    if low.contains("os error 5")
        || stderr.contains("拒绝访问")
        || low.contains("access is denied")
    {
        return (
            "启动被系统拒绝（后台守护进程起不来）".into(),
            Fix {
                label: format!("以 {command} --no-daemon 启动"),
                kind: FixKind::AddFlag("--no-daemon".into()),
            },
        );
    }

    // 入口在、模块找不到：同样是装坏了
    if low.contains("cannot find module") || low.contains("module_not_found") {
        return (
            "入口在但依赖不完整（安装目录被破坏）".into(),
            Fix {
                label: format!("重装：{}", reinstall_command(command)),
                kind: FixKind::Reinstall,
            },
        );
    }

    (
        "命令能跑起来但报错（见证据原文）".into(),
        Fix {
            label: format!("重装：{}", reinstall_command(command)),
            kind: FixKind::Reinstall,
        },
    )
}

/// 有没有"正在装它自己"的 node 进程。
///
/// 判据保守：命令行里要同时出现 `npm`、`install`、`-g`/`--global`，且提到这个包名（或命令名）。
/// 拿不到命令行（枚举失败、权限不足）就**返回 false**，由调用方把状态记成 `Unknown` —— 不猜。
pub fn is_self_update_in_progress(cmdlines: &[String], command: &str) -> bool {
    let pkg = npm_package_for(command).unwrap_or(command);
    let short = pkg.rsplit('/').next().unwrap_or(pkg); // @openai/codex → codex
    cmdlines.iter().any(|line| {
        let l = line.to_ascii_lowercase();
        l.contains("npm")
            && (l.contains(" install ") || l.contains(" i -g") || l.contains("install -g"))
            && (l.contains("-g ") || l.contains("--global"))
            && (l.contains(&pkg.to_ascii_lowercase()) || l.contains(short))
            && !l.contains("uninstall")
    })
}

/// 跑一次 `<cmd> --version` 的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VersionProbe {
    /// 进程跑完了没有（超时算没跑完）。
    pub finished: bool,
    pub success: bool,
    /// 失败时的原文（stdout + stderr 合并，用户真要看的就是这段）。
    pub output: String,
}

/// 组装结论。**纯函数**，所有真机交互都在外面 —— 这样判据可以被单测钉住。
///
/// `extra_args` 是"我们启动它时额外带的参数"（来自设置，见 `store::Settings::agent_launch_args`），
/// 只影响结果里的 `run_cmd` —— **判据一个字都不受它影响**（带了参数照样坏就是坏）。
pub fn judge(
    agent: AgentKind,
    command: &str,
    found: Option<&Path>,
    probe: Option<&VersionProbe>,
    updating: bool,
    extra_args: &[String],
) -> CliHealth {
    let detail = match (found, probe) {
        (Some(p), _) => p.display().to_string(),
        (None, _) => String::new(),
    };
    let run_cmd = launch_command(command, extra_args);

    // 没找到入口 —— 这时还**不能**断言"没装"：包可能在，只是 shim 丢了。
    let Some(_path) = found else {
        return CliHealth {
            agent,
            command: command.into(),
            status: CliStatus::NotInstalled,
            summary: "没找到这个命令（PATH 和 npm 全局目录里都没有）".into(),
            detail,
            fix: Some(Fix {
                label: format!("安装：{}", reinstall_command(command)),
                kind: FixKind::Reinstall,
            }),
            run_cmd,
        };
    };

    // 正在自更新优先报 —— 这时它不接受输入，用户最容易误会成"终端坏了"。
    if updating {
        return CliHealth {
            agent,
            command: command.into(),
            status: CliStatus::Updating,
            summary: "正在自更新（安装期间它不接受输入，等它跑完再发消息）".into(),
            detail,
            fix: None,
            run_cmd,
        };
    }

    match probe {
        Some(p) if p.success => CliHealth {
            agent,
            command: command.into(),
            status: CliStatus::Ok,
            summary: "正常".into(),
            detail,
            fix: None,
            run_cmd,
        },
        Some(p) if p.finished => {
            // 跑完了但报错：按 stderr 认症状
            let (what, fix) = classify_failure(command, &p.output);
            CliHealth {
                agent,
                command: command.into(),
                status: CliStatus::InstalledButBroken,
                summary: format!("装了但起不来：{what}"),
                detail: format!("{detail}\n---\n{}", p.output.trim()),
                fix: Some(fix),
                run_cmd,
            }
        }
        Some(_) => CliHealth {
            // 超时：不敢说是坏 —— 可能是首次启动慢
            agent,
            command: command.into(),
            status: CliStatus::Unknown,
            summary: "探测超时（可能只是首次启动慢）".into(),
            detail,
            fix: None,
            run_cmd,
        },
        None => CliHealth {
            agent,
            command: command.into(),
            status: CliStatus::Unknown,
            summary: "没探测（未执行）".into(),
            detail,
            fix: None,
            run_cmd,
        },
    }
}

/// 缓存有效吗（纯函数，便于单测）。
pub fn cache_fresh(at: Instant, now: Instant, ttl: Duration) -> bool {
    now.duration_since(at) < ttl
}

const CACHE_TTL: Duration = Duration::from_secs(5);
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

struct Cache {
    at: Instant,
    items: Vec<CliHealth>,
}

static CACHE: Mutex<Option<Cache>> = Mutex::new(None);

/// 探测所有认识的本机 agent（带 5 秒缓存 —— 看板刷新很频繁，不能每次都起进程）。
pub fn probe_all() -> Vec<CliHealth> {
    probe_all_with_args(&std::collections::HashMap::new())
}

/// 同上，但带上"我们启动它时额外带的参数"（`命令名 → 参数表`，来自设置）。
///
/// 注意**不进缓存**：用户刚点了「以 --no-daemon 启动」就该立刻在界面上看见命令变了，
/// 等 5 秒的缓存过期会像"点了没反应"。带参数这条路径只在"点一键修 / 刷新健康"时走，
/// 频率很低，多探一次不心疼。
pub fn probe_all_with_args(
    extra: &std::collections::HashMap<String, Vec<String>>,
) -> Vec<CliHealth> {
    if extra.is_empty() {
        if let Ok(guard) = CACHE.lock() {
            if let Some(c) = guard.as_ref() {
                if cache_fresh(c.at, Instant::now(), CACHE_TTL) {
                    return c.items.clone();
                }
            }
        }
    }
    let items: Vec<CliHealth> = known_commands()
        .into_iter()
        .map(|(agent, cmd)| {
            let empty: Vec<String> = Vec::new();
            let flags = extra.get(cmd).unwrap_or(&empty);
            probe_one_with_args(agent, cmd, flags)
        })
        .collect();
    if extra.is_empty() {
        if let Ok(mut guard) = CACHE.lock() {
            *guard = Some(Cache {
                at: Instant::now(),
                items: items.clone(),
            });
        }
    }
    items
}

/// 探测单个 agent（真机交互：`where` + 跑一次 `--version` + 找自更新进程）。
pub fn probe_one(agent: AgentKind, command: &str) -> CliHealth {
    probe_one_with_args(agent, command, &[])
}

/// 同 [`probe_one`]，但带上"我们启动它时额外带的参数"（只影响 `run_cmd`）。
pub fn probe_one_with_args(agent: AgentKind, command: &str, extra_args: &[String]) -> CliHealth {
    let where_out = run_capture("where.exe", &[command]).unwrap_or_default();
    let npm_dir = std::env::var_os("APPDATA")
        .map(|v| PathBuf::from(v).join("npm"))
        .filter(|p| p.exists());
    let found = resolve_command(command, &where_out, npm_dir.as_deref());

    let updating = detect_self_update(command);

    let probe = found.as_deref().map(run_version_probe);

    judge(
        agent,
        command,
        found.as_deref(),
        probe.as_ref(),
        updating,
        extra_args,
    )
}

/// 跑一条命令，拿 stdout（失败返回 None —— 调用方按"没拿到"处理）。
fn run_capture(program: &str, args: &[&str]) -> Option<String> {
    let out = Command::new(program).args(args).output().ok()?;
    let mut s = String::from_utf8_lossy(&out.stdout).to_string();
    if s.trim().is_empty() {
        s = String::from_utf8_lossy(&out.stderr).to_string();
    }
    Some(s)
}

/// 按扩展名决定"怎么把它起起来"：
/// `.cmd`/`.bat` 要走 `cmd /C`（CreateProcess 起不了批处理）、`.ps1` 要走 PowerShell、
/// 其余（`.exe`）直接起。
fn command_for(path: &Path) -> Command {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase());
    match ext.as_deref() {
        #[cfg(windows)]
        Some("cmd") | Some("bat") => {
            let mut c = Command::new("cmd");
            c.arg("/C").arg(path);
            c
        }
        #[cfg(windows)]
        Some("ps1") => {
            let mut c = Command::new("powershell.exe");
            c.arg("-NoProfile").arg("-File").arg(path);
            c
        }
        _ => Command::new(path),
    }
}

/// 跑 `<cmd> --version`，**带 5 秒超时**。
fn run_version_probe(path: &Path) -> VersionProbe {
    let mut cmd = command_for(path);
    cmd.arg("--version");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = match cmd
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .stdin(std::process::Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            return VersionProbe {
                finished: true,
                success: false,
                output: format!("起不来：{e}"),
            }
        }
    };

    let deadline = Instant::now() + PROBE_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                // 进程结束了，把两路输出收干净
                let out = child.wait_with_output().ok();
                let text = out
                    .map(|o| {
                        let mut s = String::from_utf8_lossy(&o.stdout).to_string();
                        let err = String::from_utf8_lossy(&o.stderr).to_string();
                        if !err.trim().is_empty() {
                            if !s.is_empty() {
                                s.push('\n');
                            }
                            s.push_str(&err);
                        }
                        s
                    })
                    .unwrap_or_default();
                return VersionProbe {
                    finished: true,
                    success: status.success(),
                    output: text,
                };
            }
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    return VersionProbe {
                        finished: false,
                        success: false,
                        output: "探测超时（5 秒）".into(),
                    };
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(e) => {
                return VersionProbe {
                    finished: true,
                    success: false,
                    output: format!("等待进程失败：{e}"),
                }
            }
        }
    }
}

// 说明：`is_batch` 保留给"无扩展名 shim 的兜底判断"用（见 exec_rank 注释），
// 真正决定怎么起进程的是 `command_for`。所以它**现在没有调用点** ——
// 加 `allow(dead_code)` 只是让"这是有意留着的"写在编译器能看见的地方，
// 免得每次构建都在警告列表里多一行噪音（噪音多了真警告就没人看了）。
#[allow(dead_code)]
fn is_batch(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()),
        Some(ref e) if e == "cmd" || e == "bat" || e == "ps1"
    )
}

/// 枚举本机 node 进程的命令行，找"正在装自己"。
/// 枚举失败 → 返回**空列表**（调用方会把状态记成 Unknown，而不是猜"在更新"）。
fn detect_self_update(command: &str) -> bool {
    let lines = list_node_cmdlines();
    if lines.is_empty() {
        return false;
    }
    is_self_update_in_progress(&lines, command)
}

#[cfg(windows)]
fn list_node_cmdlines() -> Vec<String> {
    // 用 wmic 的现代替代品 PowerShell CIM；拿不到就当空（不猜）。
    let script = "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | \
                  Select-Object -ExpandProperty CommandLine";
    run_capture("powershell.exe", &["-NoProfile", "-Command", script])
        .map(|s| s.lines().map(|l| l.trim().to_string()).collect())
        .unwrap_or_default()
}

#[cfg(not(windows))]
fn list_node_cmdlines() -> Vec<String> {
    run_capture("ps", &["-eo", "args"])
        .map(|s| s.lines().map(|l| l.trim().to_string()).collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn where_output_parsing_tolerates_noise() {
        let out = "\r\nC:\\Users\\a\\AppData\\Roaming\\npm\\codex.cmd\r\nC:\\other\\codex.exe\r\n\r\n";
        let v = parse_where_output(out);
        assert_eq!(v.len(), 2);
        assert!(v[0].to_string_lossy().ends_with("codex.cmd"));
    }

    #[test]
    fn npm_shim_candidates_prefer_windows_executables() {
        let dir = Path::new("C:\\npm");
        let v = npm_shim_candidates(dir, "codex");
        assert_eq!(v[0].to_string_lossy(), "C:\\npm\\codex.cmd");
        assert_eq!(v[1].to_string_lossy(), "C:\\npm\\codex.exe");
        assert_eq!(v[2].to_string_lossy(), "C:\\npm\\codex.ps1");
        // 无扩展名那个（给 Git Bash 的 sh shim）排最后
        assert_eq!(v[3].to_string_lossy(), "C:\\npm\\codex");
    }

    #[test]
    fn resolve_prefers_cmd_over_extensionless_shim() {
        // 真机踩到的 bug：`where codex` 同时列出 `codex`（sh）、`codex.cmd`、`codex.ps1`，
        // 取第一个会拿到 sh 那个 → CreateProcess 报 os error 193 → 把好的 codex 误报成"坏了"。
        let dir = std::env::temp_dir().join(format!("zeeai-clihealth-rank-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let sh = dir.join("codex");
        let cmd = dir.join("codex.cmd");
        let ps1 = dir.join("codex.ps1");
        std::fs::write(&sh, "#!/bin/sh\n").unwrap();
        std::fs::write(&cmd, "@echo off\r\n").unwrap();
        std::fs::write(&ps1, "exit 0\r\n").unwrap();
        let where_out = format!("{}\r\n{}\r\n{}\r\n", sh.display(), cmd.display(), ps1.display());
        let got = resolve_command("codex", &where_out, None).expect("应能找到");
        assert!(
            got.to_string_lossy().ends_with("codex.cmd"),
            "必须优先选 .cmd，实际选了 {}",
            got.display()
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn resolve_falls_back_to_npm_dir_when_where_is_empty() {
        // 真实症状①：where 找不到，但包在 npm 全局目录里挂着 shim
        let dir = std::env::temp_dir().join(format!("zeeai-clihealth-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let shim = dir.join("codex.cmd");
        std::fs::write(&shim, "@echo off\r\n").unwrap();
        let got = resolve_command("codex", "", Some(dir.as_path()));
        assert!(got.is_some(), "where 空但 npm 目录有 shim 时必须认得出来");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn resolve_returns_none_only_when_both_places_empty() {
        let dir = std::env::temp_dir().join(format!("zeeai-clihealth-none-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(resolve_command("nosuchagent", "", Some(dir.as_path())).is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn missing_platform_binary_maps_to_reinstall() {
        // 真实症状②
        let stderr = "Error: Missing optional dependency @openai/codex-win32-x64. \
                      Reinstall Codex: npm install -g @openai/codex@latest";
        let (what, fix) = classify_failure("codex", stderr);
        assert!(what.contains("缺平台二进制"), "实际：{what}");
        assert_eq!(fix.kind, FixKind::Reinstall);
        assert!(fix.label.contains("@openai/codex@latest"), "实际：{}", fix.label);
    }

    #[test]
    fn access_denied_maps_to_no_daemon_flag() {
        // 真实症状④
        let (what, fix) = classify_failure("codex", "Error: 拒绝访问。 (os error 5)");
        assert!(what.contains("启动被系统拒绝"), "实际：{what}");
        assert_eq!(fix.kind, FixKind::AddFlag("--no-daemon".into()));
    }

    #[test]
    fn self_update_detection_is_conservative() {
        // 真实症状③
        let lines = vec![
            "node C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\npm\\bin\\npm-cli.js install -g @openai/codex"
                .to_string(),
            "codex --no-daemon".to_string(),
        ];
        assert!(is_self_update_in_progress(&lines, "codex"));
        // 反例：别的包在装、或只是跑 codex，都不能误报
        assert!(!is_self_update_in_progress(
            &["node npm-cli.js install -g typescript".to_string()],
            "codex"
        ));
        assert!(!is_self_update_in_progress(
            &["C:\\npm\\codex.cmd --version".to_string()],
            "codex"
        ));
        // 卸载不算"在更新"
        assert!(!is_self_update_in_progress(
            &["node npm-cli.js uninstall -g @openai/codex".to_string()],
            "codex"
        ));
    }

    #[test]
    fn judge_covers_five_states() {
        let ok = VersionProbe {
            finished: true,
            success: true,
            output: "codex-cli 0.162.1".into(),
        };
        // 正常
        let h = judge(
            AgentKind::Codex,
            "codex",
            Some(Path::new("C:\\npm\\codex.cmd")),
            Some(&ok),
            false,
            &[],
        );
        assert_eq!(h.status, CliStatus::Ok);
        assert!(!h.status.is_anomaly());
        assert_eq!(h.run_cmd, "codex");

        // 装了但坏了
        let broken = VersionProbe {
            finished: true,
            success: false,
            output: "Error: Missing optional dependency @openai/codex-win32-x64".into(),
        };
        let h = judge(
            AgentKind::Codex,
            "codex",
            Some(Path::new("C:\\npm\\codex.cmd")),
            Some(&broken),
            false,
            &[],
        );
        assert_eq!(h.status, CliStatus::InstalledButBroken);
        assert!(h.status.is_anomaly());
        assert!(h.fix.is_some());
        assert!(h.detail.contains("Missing optional dependency"), "证据原文要留着");

        // 正在自更新（优先报，且不给 fix —— 只能等）
        let h = judge(
            AgentKind::Codex,
            "codex",
            Some(Path::new("C:\\npm\\codex.cmd")),
            Some(&ok),
            true,
            &[],
        );
        assert_eq!(h.status, CliStatus::Updating);
        assert!(h.fix.is_none());

        // 没装
        let h = judge(AgentKind::Claude, "claude", None, None, false, &[]);
        assert_eq!(h.status, CliStatus::NotInstalled);
        assert!(h.fix.is_some());
        assert!(!h.status.is_anomaly(), "没装不算异常，别在看板上冒红");

        // 超时 → 不猜（unknown）
        let slow = VersionProbe {
            finished: false,
            success: false,
            output: "探测超时（5 秒）".into(),
        };
        let h = judge(
            AgentKind::Gemini,
            "gemini",
            Some(Path::new("C:\\npm\\gemini.cmd")),
            Some(&slow),
            false,
            &[],
        );
        assert_eq!(h.status, CliStatus::Unknown);
        assert!(h.fix.is_none());
    }

    /// 存过的启动参数要出现在 run_cmd 里；白名单之外的一律不许拼进去。
    #[test]
    fn launch_command_only_takes_whitelisted_flags() {
        assert_eq!(launch_command("codex", &[]), "codex");
        assert_eq!(
            launch_command("codex", &["--no-daemon".to_string()]),
            "codex --no-daemon"
        );
        // 库里被人手改脏了也不能把任意串拼进"要敲进终端"的命令
        assert_eq!(
            launch_command("codex", &["; rm -rf /".to_string()]),
            "codex",
            "白名单外的一律丢掉"
        );
        assert_eq!(
            launch_command("codex", &["--no-daemon".to_string(), "&& whoami".to_string()]),
            "codex --no-daemon"
        );
    }

    /// 带了额外参数时，判据（status/summary）不许变 —— 参数只影响"怎么启动"。
    #[test]
    fn extra_args_do_not_change_the_verdict() {
        let broken = VersionProbe {
            finished: true,
            success: false,
            output: "Error: 拒绝访问。 (os error 5)".into(),
        };
        let h = judge(
            AgentKind::Codex,
            "codex",
            Some(Path::new("C:\\npm\\codex.cmd")),
            Some(&broken),
            false,
            &["--no-daemon".to_string()],
        );
        assert_eq!(h.status, CliStatus::InstalledButBroken);
        assert!(h.summary.contains("启动被系统拒绝"), "实际：{}", h.summary);
        assert_eq!(h.run_cmd, "codex --no-daemon");
    }

    #[test]
    fn cache_ttl_boundary() {
        let now = Instant::now();
        assert!(cache_fresh(now, now + Duration::from_secs(1), Duration::from_secs(5)));
        assert!(!cache_fresh(now, now + Duration::from_secs(6), Duration::from_secs(5)));
    }

    #[test]
    fn reinstall_command_uses_package_name() {
        assert_eq!(reinstall_command("codex"), "npm install -g @openai/codex@latest");
        assert_eq!(reinstall_command("claude"), "npm install -g @anthropic-ai/claude-code@latest");
        assert_eq!(reinstall_command("gemini"), "npm install -g @google/gemini-cli@latest");
        // aider 是 Python 生态的：不能给 npm 命令
        assert_eq!(reinstall_command("aider"), "python -m pip install -U aider-chat");
        // 不认识的命令：别瞎猜包名，用命令名兜底（界面会显示出来让用户自己看）
        assert_eq!(reinstall_command("myagent"), "npm install -g myagent@latest");
    }

    /// 真机冒烟（**默认不跑**：会起进程、依赖这台机器装了什么）：
    ///     cargo test --lib -- --ignored --nocapture real_probe_smoke
    /// 用途：换机器/接手时先看一眼"探测到底能不能认出本机 CLI 的状态"。
    #[test]
    #[ignore]
    fn real_probe_smoke() {
        let list = probe_all();
        assert_eq!(list.len(), known_commands().len());
        for h in &list {
            println!(
                "[{:?}] {} → {:?} （{}）\n    证据: {}\n    修法: {}",
                h.agent,
                h.command,
                h.status,
                h.summary,
                h.detail.replace('\n', " / "),
                h.fix.as_ref().map(|f| f.label.clone()).unwrap_or_else(|| "无".into())
            );
        }
    }
}
