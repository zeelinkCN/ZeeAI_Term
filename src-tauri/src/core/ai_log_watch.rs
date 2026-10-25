//! 本机 codex rollout 日志 → 红点事件 + 卡片增量（口径 `docs/design-ai-board-v2.md` §10.6）。
//!
//! **为什么是这一路**（用户 2026-10-20 定的口径）：只有"能直接读"的来源才允许**自动**亮红点 ——
//! herdr 接管窗格（状态要拉，见下面）、本应用自己启动的任务、以及**本机 codex 的 rollout 日志**。
//! 进程扫描 / `ssh ps` / tmux / 裸 SSH / CMD 一律不许自动亮；**手动点「刷新」出来的红点算伪信号，
//! 用户明确不要**（那条在前端 `refreshAiPanel` 里就不碰红点）。
//!
//! herdr 为什么没在这里：它的 `terminal session control/observe` 控制流只推**终端字节**
//! （`herdr::classify_line` 只认 `bytes` 与 `terminal.closed`，见 `core/herdr.rs`），
//! agent 状态只能靠 `herdr agent list` 那条**新起的 ssh 命令**拉。所以它单独一个模块
//! （`core/ai_herdr_dots.rs`，用户 2026-10-20 批准：只对勾了 herdr 的服务器、60 秒一轮）——
//! 本模块只读本机文件，**不启动任何子进程**，两件事不要混在一起。
//!
//! 实现刻意做到最轻（用户对"影响电脑性能"很敏感）：
//! - 每 [`LOG_POLL_MS`]（2.5 秒）看一遍 `~/.codex/sessions`；
//! - **目录 mtime 缓存**（架构审查 minor-03）：只有 mtime 变了的目录才重新 read_dir，
//!   没变化的目录直接用上一轮的清单 —— rollout 攒到几千个之后，这一轮就是
//!   "几个目录 stat"，而不是"几千个文件 stat"；
//! - 候选文件只对最近 [`MAX_TRACKED_FILES`] 份 rollout 做 stat；
//! - 只读**上次 offset 之后新增的字节**（每次最多 [`MAX_READ_PER_TICK`]），不重解析整份日志；
//! - 解析复用 `ai_sessions::RolloutParser` —— 和看板、快照是**同一套**判定；
//! - 本模块**没有任何 `std::process` / `Command`**：它不启动子进程。
//!   `ai_log_watch_starts_no_process` 那条单测就是拿源码钉这件事的（防止以后有人加回来）。
//!
//! 去重：同一 `文件 + 轮次` 只发一次（Rust 侧 [`AnnouncedSet`]；前端还有一道）。
//! 去重集合**按插入顺序淘汰最旧的**（不是淘汰后 `clear()` 整个集合 —— 那会让
//! 仍然在等你的一条 needs-you 重复点亮，见架构审查 minor-07）。
//!
//! **2026-10-20 补充：信号现在还带"卡片级"三个字段**（`instanceKey` / `state` / `activity`）。
//! 用户要的是"没点刷新也能看到正在跑的本地 AI" —— 卡片和红点是两件事：
//! - 红点：`kind` / `key` / 去重 / 节流**一个字没动**（判据仍只在这条链路上）；
//! - 卡片：前端拿 `instanceKey` 找到同一实例、用 `state` / `activity` 就地改那张卡，
//!   卡片不存在时允许建一张最小卡（见 `App.tsx` 的 `applySignalCard`）。
//!
//! 为什么不顺手读一遍 `ai_instances`：那等于把「刷新」按钮自动点了一遍（会起进程 / ssh），
//! 用户明确反对隐形轮询。事件里带的这三个字段够画卡，就不该再发一次探测。

use std::collections::{HashMap, HashSet};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;

use super::ai_instance::{clip_chars, state_of_rollout, AiState, ACTIVITY_MAX_CHARS};
use super::ai_sessions::{self, RolloutParser};

/// 事件名：后端 → 前端。前端在 `App.tsx` 里 `listen("zeeai://ai-log")`。
pub const EVENT_NAME: &str = "zeeai://ai-log";
/// 轮询间隔。2.5 秒足够"人一抬头就看到红点"，又几乎不占 CPU；
/// 这一轮只做 stat + 读新增字节，**不跑任何命令**（用户反对的是短周期起子进程）。
pub const LOG_POLL_MS: u64 = 2_500;
/// 启动后先等一会儿再扫：让前端把 listener 挂上，
/// 免得"应用一启动时已经停在等你"的那条信号被丢掉。
pub const STARTUP_DELAY_MS: u64 = 2_000;
/// 一次最多处理这么多新增字节；超过就下一轮继续读（不阻塞、不涨内存）。
pub const MAX_READ_PER_TICK: u64 = 2 * 1024 * 1024;
/// seed（第一次看见某个文件）时只读文件尾巴这么多字节。
///
/// 1MB 足够覆盖"最后一轮"（实测 `task_complete` 被埋在 293KB 噪声里也能读到）；
/// seed 每个文件只发生一次，不重复读。
pub const SEED_BYTES: u64 = 1_000_000;
/// 同时盯最近这么多份 rollout（更老的不会再有"正在跑"的轮次）。
pub const MAX_TRACKED_FILES: usize = 8;
/// "还在等你"的陈旧边界：文件超过这么久没动，就不再算"现在在等你"。
pub const NEEDS_FRESH_MS: i64 = 10 * 60 * 1000;
/// 去重集合上限（长跑应用也不会无限涨）。
const MAX_ANNOUNCED: usize = 1_000;
/// 单行缓冲上限（架构审查 minor-08）。
///
/// `pending` 存的是"读到一半、还没等到换行"的那段。正常情况下它最多一条日志行（几 KB），
/// 但如果日志里出现一个**没有换行的超长行**（异常写入 / 二进制垃圾 / 巨型单行 JSON），
/// 它会一直追加、无界增长。超过这个上限就整段丢弃（极端行截断策略）：
/// 那条行反正也解析不出合法 JSON，丢掉比把内存吃光好。
const MAX_PENDING_BYTES: usize = 4 * 1024 * 1024;
/// 目录树最多往下走几层（`sessions/年/月/日/` = 3 层；和原来 `collect_rollouts` 一致）
const MAX_SCAN_DEPTH: u32 = 3;
/// 判断"这份日志是谁写的"要读文件开头这么多字节（和 `ai_sessions` 保持一致）。
const HEAD_BYTES: u64 = 64 * 1024;

/// 已经发过的去重键集合：**按插入顺序淘汰最旧的**。
///
/// 为什么不能像以前那样"满了就 `clear()`"（架构审查 minor-07）：`clear()` 会把**所有**
/// 去重记忆一次清空，包括那条仍然停在"需要你"的信号 —— 下一轮 scan 会认为它没发过，
/// 于是同一个 needs-you 被重复点亮。现在只淘汰最旧的那几个，正在等的那些（最近才插入）
/// 自然不会被淘汰。
#[derive(Default)]
struct AnnouncedSet {
    seen: HashSet<String>,
    /// 插入顺序（淘汰时从队首取）
    order: std::collections::VecDeque<String>,
}

impl AnnouncedSet {
    fn new() -> Self {
        Self::default()
    }

    /// 插入；返回 `true` = 以前没发过（调用方该发）。
    fn insert(&mut self, key: String) -> bool {
        if self.seen.contains(&key) {
            return false;
        }
        while self.seen.len() >= MAX_ANNOUNCED {
            let Some(old) = self.order.pop_front() else {
                break;
            };
            self.seen.remove(&old);
        }
        self.seen.insert(key.clone());
        self.order.push_back(key);
        true
    }

    fn remove(&mut self, key: &str) -> bool {
        let removed = self.seen.remove(key);
        if removed {
            // 保持 order 和 seen 一致：否则以后淘汰到这条时会把"重新插进来的同键"误删
            self.order.retain(|k| k != key);
        }
        removed
    }
}

/// 一层目录上次扫描的结果（[`RolloutIndex`] 用）。
#[derive(Clone, Debug, Default)]
struct DirSnapshot {
    /// 上次看到的目录 mtime（None = 当时读不到，例如目录还不存在）
    mtime: Option<SystemTime>,
    /// 这一层里的 rollout 文件（mtime, 路径）
    files: Vec<(SystemTime, PathBuf)>,
    /// 这一层的子目录
    subdirs: Vec<PathBuf>,
}

/// 一轮扫描实际做了多少工作（单测用它证明"没变化就不重扫"）。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ScanPass {
    /// 实际 stat 过的目录数（每层一次 metadata）
    pub dirs_checked: usize,
    /// 实际 read_dir 过的目录数
    pub dirs_read: usize,
    /// 实际 stat 过的 rollout 文件数
    pub files_stat: usize,
}

/// rollout 目录索引：**只在目录 mtime 变化时**重新列那一层。
///
/// 为什么需要（架构审查 minor-03）：`~/.codex/sessions` 按 年/月/日 分层，rollout 攒到
/// 几千个之后，"每 2.5 秒全树 read_dir + 每个文件 stat 一次"是稳定的 IO/CPU 开销
///（Windows Defender 还会对每次 stat 做实时检查）。现在每层目录先看自己的 mtime：
/// - 没变 → 直接用上一轮的清单（**0 次 read_dir、0 次文件 stat**）；
/// - 变了 → 只重扫这一层（新建/删除/改名才会改目录 mtime）。
///
/// 目录 mtime **不随"文件内容追加"变化**，所以正在写的那个会话不会让整棵树反复重扫；
/// 那个文件的 size/mtime 由 `LogWatcher::scan` 单独 stat（最多 8 + 跟踪中的几个）。
///
/// 缓存不会主动清理失效目录（用户删掉的老日期目录会留一条空记录）：一年 365 个日目录
/// 也就几百条，可以忽略；真要做清理的那天再说。
#[derive(Default)]
pub struct RolloutIndex {
    dirs: HashMap<PathBuf, DirSnapshot>,
    /// 上一次扫描的工作量（单测用）
    pub last_pass: ScanPass,
}

impl RolloutIndex {
    pub fn new() -> Self {
        Self::default()
    }

    /// 找最近 `keep` 份 rollout（按缓存里的 mtime 从新到旧）。
    ///
    /// `must_keep` 是**正在跟踪的文件**：它们必须留在结果里，否则会被当成"消失"而
    /// 误发一条 `resolved`。缓存里的 mtime 可能是上一轮的（文件正在追加时目录 mtime 不变），
    /// 所以光按缓存的 mtime 排序可能把活跃文件挤出前几名 —— 这一条兜住它。
    pub fn recent(
        &mut self,
        root: &Path,
        keep: usize,
        must_keep: &HashSet<PathBuf>,
    ) -> Vec<PathBuf> {
        let mut pass = ScanPass::default();
        let mut all: Vec<(SystemTime, PathBuf)> = Vec::new();
        self.walk(root, 0, &mut all, &mut pass);
        self.last_pass = pass;
        // 新的在前；mtime 相同按路径排，保证结果稳定（测试可复现）
        all.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
        let mut out: Vec<PathBuf> = Vec::with_capacity(keep + must_keep.len());
        for (_, path) in &all {
            if out.len() >= keep {
                break;
            }
            if !out.contains(path) {
                out.push(path.clone());
            }
        }
        for path in must_keep {
            // 已经删掉的文件不算"还在视野里"：否则它会永远留在 `tracks` 里，
            // 那条还没收的 needs_key 也就永远发不出一条 `resolved`（红点挂着一条不存在的事）。
            if std::fs::metadata(path).is_err() {
                continue;
            }
            if !out.contains(path) {
                out.push(path.clone());
            }
        }
        out
    }

    fn walk(
        &mut self,
        dir: &Path,
        depth: u32,
        out: &mut Vec<(SystemTime, PathBuf)>,
        pass: &mut ScanPass,
    ) {
        pass.dirs_checked += 1;
        let mtime = std::fs::metadata(dir).and_then(|m| m.modified()).ok();
        let cached = self.dirs.get(dir).cloned();
        if let (Some(c), Some(m)) = (&cached, mtime) {
            if c.mtime == Some(m) {
                // 这一层没动过：不 read_dir、不 stat 文件，直接用上一轮的清单
                out.extend(c.files.iter().cloned());
                if depth < MAX_SCAN_DEPTH {
                    for sub in &c.subdirs {
                        self.walk(sub, depth + 1, out, pass);
                    }
                }
                return;
            }
        }
        // 变了（或第一次见）：重新列这一层
        pass.dirs_read += 1;
        let mut snap = DirSnapshot {
            mtime,
            files: Vec::new(),
            subdirs: Vec::new(),
        };
        if let Ok(read) = std::fs::read_dir(dir) {
            for e in read.flatten() {
                let path = e.path();
                let Ok(ft) = e.file_type() else {
                    continue;
                };
                if ft.is_dir() {
                    snap.subdirs.push(path);
                    continue;
                }
                if !ft.is_file() {
                    continue;
                }
                let name = e.file_name().to_string_lossy().to_string();
                if !(name.starts_with("rollout-") && name.ends_with(".jsonl")) {
                    continue;
                }
                pass.files_stat += 1;
                let t = e
                    .metadata()
                    .and_then(|m| m.modified())
                    .unwrap_or(std::time::UNIX_EPOCH);
                snap.files.push((t, path));
            }
        }
        out.extend(snap.files.iter().cloned());
        if depth < MAX_SCAN_DEPTH {
            for sub in &snap.subdirs {
                self.walk(sub, depth + 1, out, pass);
            }
        }
        self.dirs.insert(dir.to_path_buf(), snap);
    }
}

/// 一条要发给前端的信号。
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiLogSignal {
    /// `needs-you`（等你批准/回话）/ `resolved`（不等了）/ `finished`（这一轮跑完并停下）
    pub kind: String,
    /// 哪个 AI（目前只有 codex 有这种日志）
    pub agent: String,
    pub session_id: String,
    pub cwd: String,
    /// 轮次标识：日志里的 `turn_id`；老日志没有就用完成时间兜底
    pub turn: String,
    /// 去重键：`log|<文件名>|<轮次>`。`resolved` 用的就是它对应的 `needs-you` 那个 key。
    pub key: String,
    /// 卡片级：这条信号对应的**实例标识**，跨轮不变（`local|codex|<cwd>`）。
    ///
    /// 为什么除了 `key` 还要它：`key` 是"这一轮"的身份（`log|<文件>|<轮次>`），下一轮就变了 ——
    /// 前端按它只能去重红点，找不到"同一张卡"。卡片是实例级，所以要一个跨轮稳定的东西；
    /// 口径和后端合并时"rollout 靠 环境 + agent + 目录 认领实例"一致（`core/ai_instance.rs`）。
    pub instance_key: String,
    /// 卡片级：这条信号想让卡片显示成什么（`working` / `needs-you` / `finished` / `idle`）。
    ///
    /// 注意它和 `kind` 不是一回事：`kind` 决定红点（三种），`state` 决定卡片（五种）；
    /// 例如 `kind=finished` 时 `state` 一定是 `finished`，而 `kind=resolved` 时
    /// `state` 取决于日志说它是不是又在跑了。
    pub state: String,
    /// 卡片级：最后一句 / 最后一个动作（已按字符截到 [`ACTIVITY_MAX_CHARS`]，可能是空串）。
    pub activity: String,
    /// 事件时间（Unix 毫秒）
    pub at_ms: i64,
    /// AI 最后一段话 / 等你批准的命令（给通知文案用）
    pub message: String,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn is_needs(state: &str) -> bool {
    state == "needs-approval" || state == "waiting-user"
}

/// "需要你"那条信号带什么文案：优先"等你批准：<命令>"，没有就用 AI 最后一段话。
fn needs_message(snap: &ai_sessions::AiSessionSnapshot) -> String {
    if !snap.last_action.trim().is_empty() {
        snap.last_action.clone()
    } else {
        snap.last_message.clone()
    }
}

/// 卡片实例标识：`local|codex|<cwd>`。
///
/// 本机 codex 日志只可能是本机 PowerShell 那一路（`~/.codex/sessions`），所以环境固定
/// 写 `local`；agent 目前只有 codex 会写 rollout，所以固定 `codex`。目录是唯一能区分
/// "两个 codex"的东西（后端认领无锚观测时也是"环境 + agent + 目录"三条都相等才算同一个）。
fn instance_key(cwd: &str) -> String {
    format!("local|codex|{}", cwd.trim())
}

/// 这条信号想让卡片显示成什么（五种状态词里的一个）。
///
/// - `needs-you` / `finished` 由 `kind` 直接决定；
/// - `resolved` 只说明"不再等你了"，它可能回去接着跑、也可能就此停下 ——
///   所以回到日志自己说的状态（`running` → working，其余 → idle）。
///
/// **只影响卡片**：红点仍然只看 `kind`，这里映射成什么都不会让它多亮/少亮。
fn card_state(kind: &str, snap: &ai_sessions::AiSessionSnapshot) -> AiState {
    match kind {
        "needs-you" => AiState::NeedsYou,
        "finished" => AiState::Finished,
        _ => state_of_rollout(&snap.state),
    }
}

/// 卡片上那句"最后动作"：等你的那条用"等你批准：<命令>"，其余用 AI 最后一段话。
fn card_activity(kind: &str, snap: &ai_sessions::AiSessionSnapshot) -> String {
    let raw = if kind == "needs-you" {
        needs_message(snap)
    } else if !snap.last_message.trim().is_empty() {
        snap.last_message.clone()
    } else {
        snap.last_action.clone()
    };
    clip_chars(&raw, ACTIVITY_MAX_CHARS)
}

/// 从一行日志里取轮次号（`turn_context` / `task_started` / `task_complete` 的 `payload.turn_id`）。
fn turn_of_line(line: &str) -> Option<String> {
    let t = line.trim();
    if !t.starts_with('{') {
        return None;
    }
    let v: serde_json::Value = serde_json::from_str(t).ok()?;
    let kind = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
    if kind != "event_msg" && kind != "turn_context" {
        return None;
    }
    v.get("payload")?
        .get("turn_id")
        .and_then(|x| x.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// 读文件 `[start, end)` 这段字节（最多 [`MAX_READ_PER_TICK`]，返回实际读到的）。
fn read_range(path: &Path, start: u64, end: u64) -> Option<Vec<u8>> {
    let mut f = std::fs::File::open(path).ok()?;
    f.seek(SeekFrom::Start(start)).ok()?;
    let want = end.saturating_sub(start).min(MAX_READ_PER_TICK) as usize;
    let mut buf = vec![0u8; want];
    let mut got = 0usize;
    while got < buf.len() {
        match f.read(&mut buf[got..]) {
            Ok(0) => break,
            Ok(n) => got += n,
            Err(_) => break,
        }
    }
    buf.truncate(got);
    Some(buf)
}

/// 桌面版 Codex / VS Code 扩展也把日志写进同一个目录（`originator=Codex Desktop`）。
///
/// 这条回归是用户报过的误报（`docs/backlog.md` 第 2 条）：不能把"助手在桌面端干的活"
/// 当成"你本机终端里的任务"。看板那边已经过滤，这里也必须过滤。
fn is_desktop_log(path: &Path) -> bool {
    ai_sessions::read_head(path, HEAD_BYTES)
        .map(|head| ai_sessions::parse_origin(&head).is_desktop_client())
        .unwrap_or(false)
}

/// 一个 rollout 文件的增量进度。
struct Track {
    /// 已经消费到的字节位置（下一次从这里读）
    offset: u64,
    /// 读到一半、还没等到换行的那段（不能丢，下次拼上）
    pending: String,
    /// 和看板 / 快照**同一套**解析器
    parser: RolloutParser,
    /// 当前轮次（`turn_id`；没有就当空串）
    turn: String,
    /// 已经当作"历史"的完成时间（seed 时记下，之后只增不减；用来只报**新**完成）
    last_finished: i64,
    /// 当前这条 `needs-you` 的 key（空 = 现在没在等你）
    needs_key: String,
    /// 桌面端写的日志：永久跳过（只记 offset，不读内容）
    skip: bool,
}

impl Track {
    fn new() -> Self {
        Self {
            offset: 0,
            pending: String::new(),
            parser: RolloutParser::new(),
            turn: String::new(),
            last_finished: 0,
            needs_key: String::new(),
            skip: false,
        }
    }

    /// 这一轮用哪个标识去重：优先 `turn_id`，其次完成时间，最后用已解析行数兜底。
    fn round(&self, snap: &ai_sessions::AiSessionSnapshot) -> String {
        if !self.turn.is_empty() {
            return self.turn.clone();
        }
        if snap.last_turn_completed_at > 0 {
            return format!("complete:{}", snap.last_turn_completed_at);
        }
        format!("lines:{}", snap.lines_seen)
    }
}

fn signal(
    kind: &str,
    path: &Path,
    track: &Track,
    snap: &ai_sessions::AiSessionSnapshot,
    at_ms: i64,
) -> AiLogSignal {
    let round = track.round(snap);
    AiLogSignal {
        kind: kind.to_string(),
        agent: "codex".to_string(),
        session_id: snap.session_id.clone(),
        cwd: snap.cwd.clone(),
        turn: round.clone(),
        key: format!(
            "log|{}|{}",
            path.file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("rollout"),
            round
        ),
        instance_key: instance_key(&snap.cwd),
        state: card_state(kind, snap).as_str().to_string(),
        activity: card_activity(kind, snap),
        at_ms,
        message: snap.last_message.clone(),
    }
}

/// 本机 rollout 日志的监视器（纯文件 IO，没有子进程、没有网络）。
pub struct LogWatcher {
    root: PathBuf,
    tracks: HashMap<PathBuf, Track>,
    /// 已经发过的 `kind|key`（同一轮同一类事件只发一次）
    announced: AnnouncedSet,
    /// 目录 mtime 缓存：没变化的目录不重扫
    index: RolloutIndex,
    /// 单行缓冲上限（测试会调小，默认 [`MAX_PENDING_BYTES`]）
    pending_max: usize,
}

impl LogWatcher {
    pub fn new(root: PathBuf) -> Self {
        Self::with_pending_limit(root, MAX_PENDING_BYTES)
    }

    /// 测试用：可以给一个很小的单行上限，这样不用真造一个 4MB 的日志文件
    fn with_pending_limit(root: PathBuf, pending_max: usize) -> Self {
        Self {
            root,
            tracks: HashMap::new(),
            announced: AnnouncedSet::new(),
            index: RolloutIndex::new(),
            pending_max: pending_max.max(16),
        }
    }

    /// 默认目录：`%USERPROFILE%\.codex\sessions`（和 `ai_sessions::local_snapshot` 一致）。
    pub fn default_root() -> Option<PathBuf> {
        let home = std::env::var("USERPROFILE").ok()?;
        if home.trim().is_empty() {
            return None;
        }
        Some(Path::new(&home).join(".codex").join("sessions"))
    }

    fn announce(&mut self, kind: &str, key: &str) -> bool {
        self.announced.insert(format!("{kind}|{key}"))
    }

    /// 这一轮"不再等你"之后，把 needs-you 的去重记下来 —— 否则同一个 turn 里
    /// 第二次要批准（codex 一轮里可以问好几次）就再也不会亮了。
    fn forget_needs(&mut self, key: &str) {
        self.announced.remove(&format!("needs-you|{key}"));
    }

    /// 跑一轮：只 stat + 读新增字节，返回这一轮该发给前端的信号（可能为空）。
    ///
    /// `now_ms` 由调用方传进来（单测可以给固定值，不依赖真实时钟）。
    pub fn scan(&mut self, now_ms: i64) -> Vec<AiLogSignal> {
        let mut out: Vec<AiLogSignal> = Vec::new();
        // 正在跟踪的文件必须留在视野里（否则会被当成"消失"，误发 resolved）
        let tracked: HashSet<PathBuf> = self.tracks.keys().cloned().collect();
        let files = self
            .index
            .recent(&self.root, MAX_TRACKED_FILES, &tracked);
        let keep: HashSet<&Path> = files.iter().map(|p| p.as_path()).collect();

        // 掉出视野的文件：如果它还在"等你"，发一条 resolved —— 别让红点亮着一条
        // 已经不再监视的旧状态。
        let gone: Vec<PathBuf> = self
            .tracks
            .keys()
            .filter(|p| !keep.contains(p.as_path()))
            .cloned()
            .collect();
        for path in gone {
            if let Some(t) = self.tracks.remove(&path) {
                if !t.needs_key.is_empty() {
                    let snap = t.parser.snapshot();
                    let mut sig = signal("resolved", &path, &t, &snap, now_ms);
                    sig.key = t.needs_key.clone();
                    self.forget_needs(&t.needs_key);
                    out.push(sig);
                }
            }
        }

        for path in files {
            let Ok(md) = std::fs::metadata(&path) else {
                continue;
            };
            let size = md.len();
            let mtime_ms = md
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);

            if !self.tracks.contains_key(&path) {
                // 第一次看见这个文件：读一次尾巴把当前状态"垫"进去，**不补报历史完成**。
                let mut track = Track::new();
                if is_desktop_log(&path) {
                    track.skip = true;
                    track.offset = size;
                    self.tracks.insert(path, track);
                    continue;
                }
                let start = size.saturating_sub(SEED_BYTES);
                if let Some(bytes) = read_range(&path, start, size) {
                    let text = String::from_utf8_lossy(&bytes).to_string();
                    for line in text.lines() {
                        if let Some(t) = turn_of_line(line) {
                            track.turn = t;
                        }
                        track.parser.feed(line);
                    }
                    track.parser.finish();
                    // 只推进到**最后一个换行之后**：最后那半行留给下一轮重读，
                    // 免得把"正在写的 JSON"当成坏行丢掉。
                    match text.rfind('\n') {
                        Some(i) => track.offset = start + i as u64 + 1,
                        None => track.offset = start,
                    }
                    if track.offset < start {
                        track.offset = start;
                    }
                } else {
                    track.offset = size;
                }
                let snap = track.parser.snapshot();
                track.last_finished = snap.last_turn_completed_at;
                // 启动时已经停在"等你"、而且文件还是新鲜的 → 这是**真实状态**，该亮。
                // （"跑完停下"是**事件**，只在看到新增的 task_complete 时才亮，不补报。）
                if is_needs(&snap.state)
                    && mtime_ms > 0
                    && now_ms.saturating_sub(mtime_ms) <= NEEDS_FRESH_MS
                {
                    let mut sig = signal("needs-you", &path, &track, &snap, now_ms);
                    track.needs_key = sig.key.clone();
                    if self.announce("needs-you", &sig.key) {
                        sig.message = needs_message(&snap);
                        out.push(sig);
                    }
                }
                self.tracks.insert(path, track);
                continue;
            }

            // 已经盯着的文件：只看新增字节
            let Some(mut track) = self.tracks.remove(&path) else {
                continue;
            };
            if track.skip {
                track.offset = size;
                self.tracks.insert(path, track);
                continue;
            }
            if size < track.offset {
                // 文件被截断 / 重写：丢掉旧进度，下一轮重新 seed。
                // 如果它当时在"等你"，先清掉，别让红点挂着一条已经不存在的事。
                if !track.needs_key.is_empty() {
                    let snap = track.parser.snapshot();
                    let mut sig = signal("resolved", &path, &track, &snap, now_ms);
                    sig.key = track.needs_key.clone();
                    self.forget_needs(&track.needs_key);
                    out.push(sig);
                }
                continue; // 不写回 tracks → 下一轮当新文件 seed
            }
            if size == track.offset {
                self.tracks.insert(path, track);
                continue;
            }

            if let Some(bytes) = read_range(&path, track.offset, size) {
                track.offset += bytes.len() as u64;
                track.pending.push_str(&String::from_utf8_lossy(&bytes));
                // 只处理**完整行**；最后那段半行留在 pending 里
                while let Some(pos) = track.pending.find('\n') {
                    let line: String = track.pending.drain(..=pos).collect();
                    if let Some(t) = turn_of_line(&line) {
                        if t != track.turn {
                            // 新一轮开始 = 上一轮的"等你"已经处理掉了
                            if !track.needs_key.is_empty() {
                                let snap = track.parser.snapshot();
                                let mut sig = signal("resolved", &path, &track, &snap, now_ms);
                                sig.key = track.needs_key.clone();
                                self.forget_needs(&track.needs_key);
                                out.push(sig);
                                track.needs_key.clear();
                            }
                            track.turn = t;
                        }
                    }
                    track.parser.feed(&line);
                }
                // **极端行截断**（架构审查 minor-08）：一个没有换行的超长行会让 pending
                // 无界增长（异常写入 / 二进制垃圾 / 巨型单行 JSON）。超过上限就整段丢弃 ——
                // 那条行本来就解析不出合法 JSON，丢掉比把内存吃光好。
                if track.pending.len() > self.pending_max {
                    log::warn!(
                        "ai-log: {} 里有超过 {} 字节没有换行，已丢弃这段（极端行截断）",
                        path.display(),
                        self.pending_max
                    );
                    track.pending.clear();
                }
            }
            track.parser.finish();
            let snap = track.parser.snapshot();

            // ② "这一轮跑完并停下"：只有 completed_at 往前走才是**新**的一轮完成。
            //    ⚠️ "需要你"优先：如果这一轮最后停在等你批准/回话，就不算"跑完停下"（§10.6）。
            let completed = snap.last_turn_completed_at;
            if completed > track.last_finished {
                track.last_finished = completed;
                if !is_needs(&snap.state) {
                    let sig = signal("finished", &path, &track, &snap, completed.saturating_mul(1000));
                    if self.announce("finished", &sig.key) {
                        out.push(sig);
                    }
                }
            }

            // ① "需要你"：状态进入 needs 就亮，离开就清（= 你处理完了）。
            let needs = is_needs(&snap.state);
            if needs && track.needs_key.is_empty() {
                let mut sig = signal("needs-you", &path, &track, &snap, now_ms);
                track.needs_key = sig.key.clone();
                if self.announce("needs-you", &sig.key) {
                    sig.message = needs_message(&snap);
                    out.push(sig);
                }
            } else if !needs && !track.needs_key.is_empty() {
                let mut sig = signal("resolved", &path, &track, &snap, now_ms);
                sig.key = track.needs_key.clone();
                self.forget_needs(&track.needs_key);
                track.needs_key.clear();
                out.push(sig);
            }
            self.tracks.insert(path, track);
        }
        out
    }
}

/// 起一条后台线程：每 [`LOG_POLL_MS`] 扫一次本机 rollout 日志，把信号 `emit` 给前端。
///
/// 只启动**这一条线程**，不启动任何子进程（见模块头的说明）。
pub fn spawn(app: tauri::AppHandle) {
    use tauri::Emitter;
    let _ = std::thread::Builder::new()
        .name("ai-log-watch".into())
        .spawn(move || {
            std::thread::sleep(Duration::from_millis(STARTUP_DELAY_MS));
            let Some(root) = LogWatcher::default_root() else {
                log::info!("ai-log: 找不到 ~/.codex/sessions，跳过本机日志监视");
                return;
            };
            log::info!("ai-log: 开始监视本机 codex 日志（{}）", root.display());
            let mut watcher = LogWatcher::new(root);
            loop {
                let t0 = std::time::Instant::now();
                for sig in watcher.scan(now_ms()) {
                    log::info!(
                        "ai-log: kind={} key={} cwd={}",
                        sig.kind,
                        sig.key,
                        sig.cwd
                    );
                    let _ = app.emit(EVENT_NAME, &sig);
                }
                let spent = t0.elapsed().as_millis() as u64;
                std::thread::sleep(Duration::from_millis(
                    LOG_POLL_MS.saturating_sub(spent.min(LOG_POLL_MS)),
                ));
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;

    /// 临时目录（Drop 时删干净，不留垃圾）
    struct TempRoot(PathBuf);

    impl TempRoot {
        fn new(tag: &str) -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let p = std::env::temp_dir().join(format!(
                "zeeai-logwatch-{tag}-{}-{nanos}",
                std::process::id()
            ));
            fs::create_dir_all(&p).expect("建临时目录");
            Self(p)
        }

        fn path(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }

        fn write(&self, name: &str, text: &str) {
            fs::write(self.path(name), text).expect("写测试日志");
        }

        fn append(&self, name: &str, text: &str) {
            let mut f = fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(self.path(name))
                .expect("打开测试日志");
            f.write_all(text.as_bytes()).expect("追加测试日志");
            f.flush().ok();
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn meta(session: &str, originator: &str) -> String {
        format!(
            r#"{{"timestamp":"2026-10-20T00:00:00.000Z","type":"session_meta","payload":{{"session_id":"{session}","cwd":"/work/proj","originator":"{originator}"}}}}"#
        ) + "\n"
    }

    fn started(turn: &str) -> String {
        format!(
            r#"{{"timestamp":"2026-10-20T00:00:01.000Z","type":"event_msg","payload":{{"type":"task_started","turn_id":"{turn}"}}}}"#
        ) + "\n"
    }

    fn completed(turn: &str, at: i64, msg: &str) -> String {
        format!(
            r#"{{"timestamp":"2026-10-20T00:00:09.000Z","type":"event_msg","payload":{{"type":"task_complete","turn_id":"{turn}","last_agent_message":"{msg}","completed_at":{at},"duration_ms":8000}}}}"#
        ) + "\n"
    }

    fn approval(turn: &str) -> String {
        format!(
            r#"{{"timestamp":"2026-10-20T00:00:05.000Z","type":"event_msg","payload":{{"type":"exec_approval_request","turn_id":"{turn}","command":"rm -rf build"}}}}"#
        ) + "\n"
    }

    fn approval_done(turn: &str) -> String {
        format!(
            r#"{{"timestamp":"2026-10-20T00:00:06.000Z","type":"event_msg","payload":{{"type":"exec_approval_response","turn_id":"{turn}","decision":"approved"}}}}"#
        ) + "\n"
    }

    fn tool_call() -> String {
        r#"{"timestamp":"2026-10-20T00:00:07.000Z","type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\"cmd\":\"ls\"}"}}"#.to_string() + "\n"
    }

    fn token_usage() -> String {
        r#"{"timestamp":"2026-10-20T00:00:08.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":100},"last_token_usage":{"total_tokens":10},"model_context_window":950000}}}"#.to_string() + "\n"
    }

    /// 测试用的"现在"：比真实 mtime 晚很多，保证 seed 时不会因为"文件新鲜"而亮
    /// （要测"启动时已经停在等你"的用例自己传 mtime+500）。
    fn later() -> i64 {
        now_ms() + NEEDS_FRESH_MS * 2
    }

    /// **不启动子进程**是设计约束：这个模块里不许出现 `Command::new` / `std::process::`。
    /// 用源码钉住它 —— 以后有人顺手加一条探测命令，这条会红。
    #[test]
    fn ai_log_watch_starts_no_process() {
        let src = include_str!("ai_log_watch.rs");
        // 只看"非测试"部分：测试里用 `std::process::id()` 造唯一目录是允许的
        let code = src.split("#[cfg(test)]").next().unwrap_or(src);
        assert!(
            !code.contains("Command::new") && !code.contains("std::process::"),
            "本机日志监视必须只读文件：不许出现 Command::new / std::process::"
        );
        assert!(
            code.contains("std::fs::metadata"),
            "它应该是靠 fs metadata 轮询的"
        );
    }

    /// ① 这一轮跑完并停下 → 一条 finished；同一轮再扫/重读都不重复亮。
    #[test]
    fn finishing_a_turn_lights_once() {
        let root = TempRoot::new("finish");
        root.write(
            "rollout-2026-10-20-t1.jsonl",
            &(meta("s1", "codex_cli_rs") + &started("t1")),
        );
        let mut w = LogWatcher::new(root.0.clone());
        let t0 = later();
        assert!(w.scan(t0).is_empty(), "seed 不补报历史");

        root.append("rollout-2026-10-20-t1.jsonl", &completed("t1", 1_790_000_000, "好了"));
        let got = w.scan(t0 + 1_000);
        assert_eq!(got.len(), 1, "应该只有一条 finished：{got:?}");
        assert_eq!(got[0].kind, "finished");
        assert_eq!(got[0].turn, "t1");
        assert_eq!(got[0].key, "log|rollout-2026-10-20-t1.jsonl|t1");
        assert_eq!(got[0].cwd, "/work/proj");

        assert!(w.scan(t0 + 2_000).is_empty(), "没有新增字节 → 不该再亮");
        // 同一轮的 task_complete 又被写了一遍（异常/重复）：仍然不重复亮
        root.append("rollout-2026-10-20-t1.jsonl", &completed("t1", 1_790_000_000, "好了"));
        assert!(w.scan(t0 + 3_000).is_empty(), "同一轮只亮一次");
    }

    /// ② "需要你"优先于"跑完"：最后状态是等你，就不亮 finished。
    #[test]
    fn needs_you_wins_over_finished() {
        let root = TempRoot::new("needs");
        root.write(
            "rollout-2026-10-20-t2.jsonl",
            &(meta("s2", "codex_cli_rs") + &started("t2")),
        );
        let mut w = LogWatcher::new(root.0.clone());
        let t0 = later();
        assert!(w.scan(t0).is_empty());

        // 同一批新增里先"跑完"、最后又停在"等你" → 只亮需要你
        root.append(
            "rollout-2026-10-20-t2.jsonl",
            &(completed("t2", 1_790_000_100, "做完一半") + &approval("t2")),
        );
        let got = w.scan(t0 + 1_000);
        assert_eq!(got.len(), 1, "只要 needs-you：{got:?}");
        assert_eq!(got[0].kind, "needs-you");

        // 处理完（日志里出现 approval response）→ resolved，且不再补一条 finished
        root.append("rollout-2026-10-20-t2.jsonl", &approval_done("t2"));
        let got = w.scan(t0 + 2_000);
        assert!(
            got.iter().any(|s| s.kind == "resolved"),
            "处理完要清红点：{got:?}"
        );
        assert!(
            got.iter().all(|s| s.kind != "finished"),
            "这一轮早就报过/不该补报完成：{got:?}"
        );
        assert!(w.scan(t0 + 3_000).is_empty());
    }

    /// ②b 同一个 turn 里"要批准 → 处理 → 又要批准"：第二次必须重新亮。
    /// （codex 一轮里可以问好几次；去重只能吞"重复送达"，不能吞"新的一次等待"。）
    #[test]
    fn needs_you_relights_after_resolution_in_same_turn() {
        let root = TempRoot::new("relight");
        root.write(
            "rollout-2026-10-20-t9.jsonl",
            &(meta("s9", "codex_cli_rs") + &started("t9")),
        );
        let mut w = LogWatcher::new(root.0.clone());
        let t0 = later();
        assert!(w.scan(t0).is_empty());

        root.append("rollout-2026-10-20-t9.jsonl", &approval("t9"));
        let first = w.scan(t0 + 1_000);
        assert_eq!(first.len(), 1, "{first:?}");
        assert_eq!(first[0].kind, "needs-you");

        root.append("rollout-2026-10-20-t9.jsonl", &approval_done("t9"));
        let cleared = w.scan(t0 + 2_000);
        assert!(cleared.iter().any(|s| s.kind == "resolved"), "{cleared:?}");

        root.append("rollout-2026-10-20-t9.jsonl", &approval("t9"));
        let again = w.scan(t0 + 3_000);
        assert_eq!(again.len(), 1, "同一轮第二次等你也要亮：{again:?}");
        assert_eq!(again[0].kind, "needs-you");
        assert_eq!(again[0].key, first[0].key, "去重键仍是这一轮");
    }

    /// ③ 运行中 / 只写文件（日志里只有工具调用与 token）→ 不亮。
    #[test]
    fn running_and_file_writes_do_not_light() {
        let root = TempRoot::new("running");
        root.write(
            "rollout-2026-10-20-t3.jsonl",
            &(meta("s3", "codex_cli_rs") + &started("t3")),
        );
        let mut w = LogWatcher::new(root.0.clone());
        let t0 = later();
        assert!(w.scan(t0).is_empty());

        root.append("rollout-2026-10-20-t3.jsonl", &(tool_call() + &token_usage()));
        assert!(w.scan(t0 + 1_000).is_empty(), "在跑 + 只产出 → 不亮");
    }

    /// ④ 半行先不处理（等换行），补齐后才算一条完成。
    #[test]
    fn partial_line_waits_for_newline() {
        let root = TempRoot::new("partial");
        root.write(
            "rollout-2026-10-20-t4.jsonl",
            &(meta("s4", "codex_cli_rs") + &started("t4")),
        );
        let mut w = LogWatcher::new(root.0.clone());
        let t0 = later();
        assert!(w.scan(t0).is_empty());

        let full = completed("t4", 1_790_000_200, "分两段写");
        let cut = full.len() / 2;
        root.append("rollout-2026-10-20-t4.jsonl", &full[..cut]);
        assert!(w.scan(t0 + 1_000).is_empty(), "半行不该被当成完成");
        root.append("rollout-2026-10-20-t4.jsonl", &full[cut..]);
        let got = w.scan(t0 + 2_000);
        assert_eq!(got.len(), 1, "补齐后应该亮一条：{got:?}");
        assert_eq!(got[0].kind, "finished");
    }

    /// ⑤ 新一轮开始 = 上一轮"等你"已经处理掉了 → 发 resolved。
    #[test]
    fn new_turn_resolves_previous_needs() {
        let root = TempRoot::new("newturn");
        root.write(
            "rollout-2026-10-20-t5.jsonl",
            &(meta("s5", "codex_cli_rs") + &started("t5")),
        );
        let mut w = LogWatcher::new(root.0.clone());
        let t0 = later();
        assert!(w.scan(t0).is_empty(), "seed 不补报历史");

        // 上一轮在等你 → 亮
        root.append("rollout-2026-10-20-t5.jsonl", &approval("t5"));
        let got = w.scan(t0 + 1_000);
        assert_eq!(got.len(), 1, "{got:?}");
        assert_eq!(got[0].kind, "needs-you");

        // 下一轮开始（说明上一轮已经被处理）
        root.append("rollout-2026-10-20-t5.jsonl", &started("t6"));
        let got = w.scan(t0 + 2_000);
        assert!(
            got.iter().any(|s| s.kind == "resolved" && s.turn == "t5"),
            "上一轮的等你必须被清掉：{got:?}"
        );
    }

    /// ⑥ 桌面端写的日志不读（用户报过的误报，回归用）。
    #[test]
    fn desktop_logs_are_ignored() {
        let root = TempRoot::new("desktop");
        root.write(
            "rollout-2026-10-20-t7.jsonl",
            &(meta("s7", "Codex Desktop") + &started("t7")),
        );
        let mut w = LogWatcher::new(root.0.clone());
        let t0 = later();
        assert!(w.scan(t0).is_empty());
        root.append(
            "rollout-2026-10-20-t7.jsonl",
            &(approval("t7") + &completed("t7", 1_790_000_300, "桌面端干的")),
        );
        assert!(w.scan(t0 + 1_000).is_empty(), "桌面端日志不该亮任何红点");
    }

    /// ⑦ 应用启动时已经停在"等你"、文件还新鲜 → 亮（这是状态，不是历史事件）。
    #[test]
    fn fresh_waiting_state_lights_on_seed() {
        let root = TempRoot::new("seedneeds");
        root.write(
            "rollout-2026-10-20-t8.jsonl",
            &(meta("s8", "codex_cli_rs") + &started("t8") + &approval("t8")),
        );
        let mut w = LogWatcher::new(root.0.clone());
        // 文件 mtime 是"现在"；给一个和它同一时刻的 now
        let mtime_ms = fs::metadata(root.path("rollout-2026-10-20-t8.jsonl"))
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let got = w.scan(mtime_ms + 500);
        assert_eq!(got.len(), 1, "{got:?}");
        assert_eq!(got[0].kind, "needs-you");
        assert_eq!(got[0].turn, "t8");
    }

    // ---------- 卡片级字段（2026-10-20：没点刷新也能更新卡片） ----------

    /// ⑧ 信号必须带齐"卡片级"三件套 + 时间；且同一实例跨轮 `instanceKey` 不变、红点 key 会变。
    ///
    /// "有序"也在这里钉：同一批新增里先发 `resolved`（清旧）、再发 `needs-you`（亮新）——
    /// 前端按这个顺序写卡片，不会出现"新卡被旧信号的清理动作盖掉"。
    #[test]
    fn signal_carries_card_fields_and_instance_key_survives_turns() {
        let root = TempRoot::new("cardfields");
        root.write(
            "rollout-2026-10-20-c1.jsonl",
            &(meta("s-c1", "codex_cli_rs") + &started("tc1")),
        );
        let mut w = LogWatcher::new(root.0.clone());
        let t0 = later();
        assert!(w.scan(t0).is_empty(), "seed 不补报历史");

        root.append("rollout-2026-10-20-c1.jsonl", &approval("tc1"));
        let first = w.scan(t0 + 1_000);
        assert_eq!(first.len(), 1, "{first:?}");
        let sig = &first[0];
        assert_eq!(sig.kind, "needs-you");
        assert_eq!(sig.instance_key, "local|codex|/work/proj", "卡片标识 = 环境|agent|目录");
        assert_eq!(sig.state, "needs-you", "卡片状态跟着 kind");
        assert!(sig.activity.contains("rm -rf build"), "最后动作：{}", sig.activity);
        assert_eq!(sig.at_ms, t0 + 1_000);
        assert_eq!(sig.cwd, "/work/proj", "卡片 where 的第二段用 cwd");

        // 下一轮：上一轮的"等你"先 resolved，再亮新一轮 —— 顺序固定（先清后亮）。
        root.append(
            "rollout-2026-10-20-c1.jsonl",
            &(approval_done("tc1") + &started("tc2") + &approval("tc2")),
        );
        let second = w.scan(t0 + 2_000);
        assert_eq!(second.len(), 2, "先清旧、再亮新：{second:?}");
        assert_eq!(second[0].kind, "resolved");
        assert_eq!(second[0].instance_key, "local|codex|/work/proj");
        assert_eq!(second[1].kind, "needs-you");
        assert_eq!(second[1].turn, "tc2");
        assert_ne!(second[0].key, second[1].key, "红点 key 是每轮一个");
        assert_eq!(
            second[0].instance_key, second[1].instance_key,
            "卡片标识必须跨轮不变，否则前端会建出第二张卡"
        );
    }

    /// ⑨ `state` 的映射：`needs-you` / `finished` 由 kind 决定；`resolved` 回到日志状态
    /// （还在跑 = working；停下了 = idle）—— 不能一律当"完成"。
    #[test]
    fn card_state_follows_kind_and_log_state() {
        let path = Path::new("rollout-x.jsonl");
        let track = Track::new();
        let snap = |state: &str, msg: &str| ai_sessions::AiSessionSnapshot {
            session_id: "s".into(),
            cwd: "/work/x".into(),
            state: state.into(),
            last_message: msg.into(),
            ..Default::default()
        };

        let needs = signal("needs-you", path, &track, &snap("needs-approval", "等你批准"), 1);
        assert_eq!(needs.state, "needs-you");
        let done = signal("finished", path, &track, &snap("idle", "好了"), 2);
        assert_eq!(done.state, "finished");
        assert_eq!(done.activity, "好了");
        assert_eq!(
            signal("resolved", path, &track, &snap("running", ""), 3).state,
            "working",
            "不再等你但还在跑 → 运行中"
        );
        assert_eq!(
            signal("resolved", path, &track, &snap("idle", ""), 4).state,
            "idle",
            "不再等你而且停下了 → 空闲"
        );
    }

    /// ⑩ 卡片文案按**字符**截断：长中文 / emoji 不会被劈成半个字；
    ///    正好等于上限时原样保留（不白加省略号）。
    #[test]
    fn card_activity_is_truncated_on_char_boundary() {
        let path = Path::new("rollout-long.jsonl");
        // emoji 是 4 字节字符：按字节切一定会切坏，按字符切才是安全的
        let long = "😀".repeat(ACTIVITY_MAX_CHARS + 200);
        let snap = ai_sessions::AiSessionSnapshot {
            cwd: "/work/x".into(),
            state: "idle".into(),
            last_message: long.clone(),
            ..Default::default()
        };
        let sig = signal("finished", path, &Track::new(), &snap, 1);
        assert_eq!(sig.activity.chars().count(), ACTIVITY_MAX_CHARS, "截到字符上限");
        assert!(sig.activity.ends_with('…'), "截断要有省略号");
        assert!(
            long.starts_with(sig.activity.trim_end_matches('…')),
            "只切尾巴，不改前面的内容"
        );

        let exact = "好".repeat(ACTIVITY_MAX_CHARS);
        let snap2 = ai_sessions::AiSessionSnapshot {
            last_message: exact.clone(),
            state: "idle".into(),
            ..Default::default()
        };
        assert_eq!(signal("finished", path, &Track::new(), &snap2, 2).activity, exact);
    }

    /// ⑪ 真扫一轮出来的 `finished` 也带卡片字段（前端据此在没点刷新时把卡改成「已完成」）。
    #[test]
    fn finished_signal_has_card_fields() {
        let root = TempRoot::new("finishcard");
        root.write(
            "rollout-2026-10-20-c2.jsonl",
            &(meta("s-c2", "codex_cli_rs") + &started("tc2")),
        );
        let mut w = LogWatcher::new(root.0.clone());
        let t0 = later();
        assert!(w.scan(t0).is_empty());

        root.append(
            "rollout-2026-10-20-c2.jsonl",
            &completed("tc2", 1_790_000_400, "报告写好了"),
        );
        let got = w.scan(t0 + 1_000);
        assert_eq!(got.len(), 1, "{got:?}");
        assert_eq!(got[0].kind, "finished");
        assert_eq!(got[0].instance_key, "local|codex|/work/proj");
        assert_eq!(got[0].state, "finished");
        assert_eq!(got[0].activity, "报告写好了");
        assert_eq!(got[0].at_ms, 1_790_000_400_000, "完成时间用日志里的 completed_at");
    }

    // ---------- 性能 / 去重（架构审查 minor-03 / 07 / 08） ----------

    /// 目录 mtime 缓存：这一轮什么都没改 → **一次目录 read_dir、一次文件 stat 都不做**；
    /// 新建/删除文件（只有这时目录 mtime 才会变）→ 只重扫那一层。
    #[test]
    fn directory_cache_skips_rescan_when_nothing_changed() {
        let root = TempRoot::new("dircache");
        let day = root.0.join("2026").join("10").join("26");
        fs::create_dir_all(&day).unwrap();
        let file = day.join("rollout-2026-10-26-a.jsonl");
        fs::write(&file, meta("s-dc", "codex_cli_rs") + &started("tdc")).unwrap();

        let mut w = LogWatcher::new(root.0.clone());
        let t0 = later();
        assert!(w.scan(t0).is_empty(), "seed 不补报历史");
        let first = w.index.last_pass;
        assert_eq!(first.dirs_read, 4, "第一次要逐层列：root/年/月/日 = {first:?}");
        assert_eq!(first.files_stat, 1, "只 stat 一个 rollout：{first:?}");

        // 预热一轮：把"可能被系统延迟更新"的目录 mtime 记成稳定值
        //（NTFS 的目录时间戳不是每次都立刻落定，不预热的话第二轮可能正好赶上更新）
        assert!(w.scan(t0 + 500).is_empty());
        w.index.last_pass = ScanPass::default();

        // 什么都不改：目录 mtime 一样 → 直接用缓存
        assert!(w.scan(t0 + 1_000).is_empty());
        let second = w.index.last_pass;
        assert_eq!(second.dirs_read, 0, "没变化就不该重扫目录：{second:?}");
        assert_eq!(second.files_stat, 0, "没变化就不该 stat 文件：{second:?}");
        assert_eq!(second.dirs_checked, 4, "每层目录仍要看一眼 mtime：{second:?}");
        assert!(
            w.index.dirs.contains_key(&day),
            "缓存里要留着这一层，下一轮才能短路"
        );

        // 往**已知**文件追加：目录 mtime 不变 → 仍然不重扫目录，但内容照样读到
        root.append(
            "2026/10/26/rollout-2026-10-26-a.jsonl",
            &completed("tdc", 1_790_002_000, "写完了"),
        );
        let got = w.scan(t0 + 2_000);
        assert_eq!(got.len(), 1, "追加的内容不能被缓存吞掉：{got:?}");
        assert_eq!(got[0].kind, "finished");
        assert_eq!(
            w.index.last_pass.dirs_read, 0,
            "文件追加不该触发目录重扫：{:?}",
            w.index.last_pass
        );

        // 新建一个文件（目录 mtime 变了）→ 只重扫这一层，新文件也在候选里
        let second_file = day.join("rollout-2026-10-26-b.jsonl");
        fs::write(
            &second_file,
            meta("s-dc2", "codex_cli_rs") + &started("tdc2"),
        )
        .unwrap();
        let got = w.scan(t0 + 3_000);
        assert!(got.is_empty(), "新文件只 seed，不补报：{got:?}");
        let third = w.index.last_pass;
        assert!(third.dirs_read >= 1, "变了的那一层必须重扫：{third:?}");
        assert_eq!(third.files_stat, 2, "这一层两个 rollout 都要 stat：{third:?}");
        assert!(w.tracks.contains_key(&second_file), "新文件要进入跟踪");
    }

    /// 去重集合满了：只淘汰最旧的那条，**不能把整张表清空**
    ///（以前 `clear()` 会让仍然停在"等你"的信号重复点亮）。
    #[test]
    fn announced_evicts_oldest_only() {
        let mut set = AnnouncedSet::new();
        for i in 0..MAX_ANNOUNCED {
            assert!(set.insert(format!("needs-you|k{i}")), "第 {i} 条应该是新的");
        }
        assert_eq!(set.seen.len(), MAX_ANNOUNCED);
        assert!(!set.insert("needs-you|k0".into()), "老键还在表里，不该重复发");

        // 再来一条新的：只淘汰最旧的 k0，其余的（尤其最近的那些）必须全部保留
        assert!(set.insert("needs-you|new".into()));
        assert_eq!(set.seen.len(), MAX_ANNOUNCED);
        assert!(
            !set.insert(format!("needs-you|k{}", MAX_ANNOUNCED - 1)),
            "最近插入的键不能被连带清掉"
        );
        assert!(!set.insert("needs-you|new".into()), "刚插入的也在表里");
        assert!(set.insert("needs-you|k0".into()), "被淘汰的那条可以重新点亮");
    }

    /// `remove` 之后重新插入，序号队列必须和集合保持一致
    ///（否则以后淘汰到这条时会把"重新插进来的同键"误删）。
    #[test]
    fn announced_remove_keeps_order_in_sync() {
        let mut set = AnnouncedSet::new();
        set.insert("a".into());
        set.insert("b".into());
        assert!(set.remove("a"));
        assert!(set.insert("a".into()), "清掉之后可以重新亮");
        assert_eq!(set.order.len(), set.seen.len(), "队列和集合必须一一对应");
        let order: HashSet<String> = set.order.iter().cloned().collect();
        assert_eq!(order, set.seen, "队列里不该残留已删除的键");

        // 塞到上限：最早插入的 b 在 `order` 队首
        for i in 0..MAX_ANNOUNCED - 2 {
            set.insert(format!("n{i}"));
        }
        // 淘汰只发生在"插入新键"时：先拿一个新键触发一次
        assert!(set.insert("trigger".into()), "新键应该能插进去");
        assert!(!set.insert("a".into()), "a 还在表里（它是后来插入的）");
        assert!(set.insert("b".into()), "b 是最旧的，应该已经被淘汰");
    }

    /// 超长"没有换行"的行：整段丢弃，`pending` 不能无界增长（极端行截断）。
    #[test]
    fn oversized_pending_is_dropped() {
        let root = TempRoot::new("pendcap");
        root.write(
            "rollout-2026-10-20-p1.jsonl",
            &(meta("s-p1", "codex_cli_rs") + &started("tp1")),
        );
        let mut w = LogWatcher::with_pending_limit(root.0.clone(), 64);
        let t0 = later();
        assert!(w.scan(t0).is_empty());

        // 追加一条"永远不换行"的超长垃圾（5000 字节，远超 64 的上限）
        root.append("rollout-2026-10-20-p1.jsonl", &"x".repeat(5_000));
        assert!(w.scan(t0 + 1_000).is_empty(), "垃圾行不该产生信号");
        let track = w
            .tracks
            .get(&root.path("rollout-2026-10-20-p1.jsonl"))
            .expect("文件应该还在跟踪");
        assert!(
            track.pending.len() <= 64,
            "pending 必须有上限（现在 {} 字节）",
            track.pending.len()
        );

        // 截断之后还能正常继续读：随后的完整行照样被处理
        root.append(
            "rollout-2026-10-20-p1.jsonl",
            &("\n".to_string() + &completed("tp1", 1_790_005_000, "继续干活")),
        );
        let got = w.scan(t0 + 2_000);
        assert!(
            got.iter().any(|s| s.kind == "finished"),
            "截断只丢那一行，后面的正常行还要能读：{got:?}"
        );
    }

    /// 已经被删掉的日志文件不能靠"还在跟踪"赖在视野里：
    /// 那会永远留着一条 needs-you，前端红点挂在一条不存在的事上。
    #[test]
    fn deleted_tracked_file_resolves_and_is_dropped() {
        let root = TempRoot::new("deleted");
        root.write(
            "rollout-2026-10-20-d1.jsonl",
            &(meta("s-d1", "codex_cli_rs") + &started("td1")),
        );
        let mut w = LogWatcher::new(root.0.clone());
        let t0 = later();
        assert!(w.scan(t0).is_empty(), "seed 不补报历史");

        // 让它进到"等你"的状态
        root.append("rollout-2026-10-20-d1.jsonl", &approval("td1"));
        let got = w.scan(t0 + 1_000);
        assert_eq!(got.len(), 1, "{got:?}");
        assert_eq!(got[0].kind, "needs-you");
        let tracked = root.path("rollout-2026-10-20-d1.jsonl");
        assert!(w.tracks.contains_key(&tracked));

        // 文件被删（会话被清理 / codex 轮转）：必须收掉红点，并且不再跟踪
        fs::remove_file(&tracked).unwrap();
        let got = w.scan(t0 + 2_000);
        assert!(
            got.iter().any(|s| s.kind == "resolved"),
            "删掉的文件要把等你的红点清掉：{got:?}"
        );
        assert!(
            !w.tracks.contains_key(&tracked),
            "删掉的文件不该继续留在跟踪表里"
        );
    }
}
