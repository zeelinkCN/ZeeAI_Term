//! herdr 窗格的 agent 状态 → 红点事件 + 卡片快照（口径 `docs/design-ai-board-v2.md` §10.6）。
//!
//! **这一路以前不做、现在做**（用户 2026-10-20 明确批准）：
//! herdr 的控制流（`terminal session observe`）只推**终端字节**，不推 agent 状态
//! （`herdr::classify_line` 只认 `bytes` / `terminal.closed`）。想看 blocked/done
//! 只能另起一条 `herdr agent list` —— 那是一次**新起的 ssh**，所以按以前"探测不自动亮"的
//! 口径它不亮。用户现在的原话是："**每台开了 herdr 的服务器，每 60 秒查一次
//! `herdr agent list` 来驱动红点**"。
//!
//! **边界（照着用户的原话划，别自己扩大）**：
//! - 红点：判定 / 去重 / 边沿检测一个字没动（`blocked` = 状态，`done` = 事件）；
//! - 卡片（2026-10-20 第二轮补充）：这一轮**顺带**把同一份 `agent list` 结果作为
//!   `zeeai://herdr-agents` **全量快照**发给前端，让卡片也能自动更新/创建，
//!   不用再点「刷新」。快照是这份探测的**副产品**（没有多一次 ssh、没有多一个命令），
//!   前端只读它；手动刷新那条口径（`App.tsx` 的 `refreshAiPanel`）**一点没动**；
//! - 只对 `profiles` 里 `ssh.herdrEnabled == true` 的服务器发请求；一台都没有就
//!   **一个请求都不发**（[`targets_from`] 是那道闸门，单测钉着它）；
//! - 失败静默：连不上 / 超时 / 没装 → 这一轮当"没看见"，只 `log::warn` 一行；
//!   不亮、不清、不弹、**也不发快照**（前端因此保留上一张卡，而不是把卡误删）；
//!   不因为失败就改成更短的重试（用户对噪音和性能都敏感）；
//! - 间隔 [`HERDR_DOT_POLL_MS`]（60 秒，**不许更密**）；启动后再等
//!   [`HERDR_DOT_STARTUP_DELAY_MS`]（12 秒）才跑第一轮，不和首屏/恢复会话抢那几秒。
//!
//! **不裸起进程**：每次探测都走**已有的** `commands::herdr_agents` —— 它内部是
//! `run_remote_capture`（20 秒超时）→ `ssh::ssh_exec_args` + `run_ssh_capture` →
//! `proc::hidden_command_async`（Windows 上带 `CREATE_NO_WINDOW`，用户看不到黑框），
//! 有密码时走 russh。本模块里**没有**裸起的子进程（连 `Command` 这个词都不出现），
//! 也不用标准库的 `process` 模块
//! （`herdr_dots_spawn_no_bare_command` 那条单测就是拿源码钉这件事的）。
//!
//! 说明：调的就是「刷新」用的那条 `commands::herdr_agents`（内部 `herdr::agents_command()`，
//! **含** `ENSURE_SERVER`）—— 轮询看到的状态必须和用户点刷新看到的是同一份，否则会出现
//! "红点亮着、刷新后卡片却没有这件事"。那条既有命令在 herdr 服务没跑时会像 herdr 自己
//! 那样把它带起来（不是本模块新加的副作用）；要严格只读就得另开一条不带 ENSURE_SERVER 的
//! 变体，那超出了这一次"复用已有链路"的范围。
//!
//! **状态机（§10.6，只从 herdr 第一手状态来）**：
//! - `blocked`（需要你）→ `needs-you`，key = `herdr|<server_profile_id>|<pane>`；
//!   **亮到它不再是 blocked**，那一次发 `resolved`（同一个 key）；
//! - `done`（跑完停下）→ `finished`，**只在"进入 done"的那一次**发 —— 边沿检测：
//!   拿每个窗格上一轮的状态比，上一轮已经是 done 就不发；`working` / `idle` 什么都不发；
//! - 状态回退（done → working）之后再 done，**可以再亮一次**（这是新的一次"跑完"）；
//! - 第一次看见某个窗格时只"垫"状态：`blocked` 是**状态**，该亮；
//!   `done` 是**事件**，不补报历史（否则每次重启都会多出一堆"未读"）；
//! - 窗格消失（agent 退出 / 窗格被关）如果它还亮着"需要你"，发一条 `resolved` ——
//!   否则红点会永远挂着一条已经不存在的事。消失**不算** `finished`。
//!
//! **去重跨轮**：Rust 侧 [`DotTracker`] 记住每个窗格上一轮的状态与当前那条 needs 的 key，
//! 所以同一状态不会每 60 秒重复亮；前端 `applyAiLogSignal` 还有一道按 key 的去重。
//! 应用退出时由 `lib.rs` 的 `RunEvent::Exit` 调 [`stop`] 置停止位，线程在下一个
//! 分片睡眠（最多 [`STOP_CHECK_MS`]）内干净退出，不会拖住退出流程。

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;

use super::ai_instance::{clip_chars, state_of_herdr, ACTIVITY_MAX_CHARS};
use super::herdr::HerdrAgent;

/// 红点信号的事件名。
///
/// **故意复用** `zeeai://ai-log`（本机 codex 日志那套）：两条链路的 payload 是同一个
/// "红点信号"概念（`needs-you` / `resolved` / `finished`），前端只能有**一个**写入红点
/// 状态的地方 —— 多开一个事件名、多一个 `listen`，迟早会出现"两条链路各判一套"。
/// herdr 信号靠 `source: "herdr"` + `serverName` 与前者的文案区分。
pub const EVENT_NAME: &str = "zeeai://ai-log";
/// 卡片快照的事件名（后端 → 前端）。
///
/// 为什么**不**复用 `zeeai://ai-log`：红点信号是"变了才发"的**边沿**（它靠 `resolved`
/// 清状态、靠 key 去重），而卡片快照是每轮都发的**全量状态**。混在同一个事件里，
/// 前端分不清"这条该按去重处理还是该整体覆盖"，两套判定迟早互相打架 ——
/// 所以另开一个名字：一个事件只表达一件事。
pub const SNAPSHOT_EVENT_NAME: &str = "zeeai://herdr-agents";
/// 轮询间隔：用户批的是"每 60 秒一次"，**这是下限**，不许为了"更灵"改小。
pub const HERDR_DOT_POLL_MS: u64 = 60_000;
/// 启动后先等这么久再跑第一轮：不和首屏渲染 / 恢复会话 / 更新检查抢。
pub const HERDR_DOT_STARTUP_DELAY_MS: u64 = 12_000;
/// 等待时按这个粒度分片睡：应用退出时最多这么久就能干净结束，而不是卡满 60 秒。
pub const STOP_CHECK_MS: u64 = 500;

/// herdr 的"需要你"状态
const STATUS_BLOCKED: &str = "blocked";
/// herdr 的"跑完停下"状态
const STATUS_DONE: &str = "done";
/// 信号来源标记（前端据此选文案；也是"这条不是本机日志"的证据）
pub const SOURCE_HERDR: &str = "herdr";
/// 停止位：`lib.rs` 的退出路径置位后，轮询线程在下一个分片睡眠内退出。
static STOP: AtomicBool = AtomicBool::new(false);

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 一台要轮询的服务器。
///
/// 单独抽出来（而不是轮询时直接传 `ConnectionProfile`）是为了让 [`DotTracker`]
/// 的单测不依赖 `store` / 网络：喂假数据就能验状态机。
#[derive(Clone, Debug, PartialEq)]
pub struct DotTarget {
    /// 服务器配置 id（key 的中间一段，也是前端 `lastHerdrAgents` 的索引）
    pub profile_id: String,
    /// 服务器显示名（只用于日志与前端文案）
    pub name: String,
}

/// 从服务器列表里挑出"开了 herdr 的 SSH 服务器"。
///
/// **这就是"没有 herdr 服务器就什么都不做"那道闸门**：返回空 => [`poll_once`] 的
/// for 循环一次都不进 => 一个 ssh 都不起。`herdrEnabled` 是用户自己在这台服务器上
/// 勾的"新会话默认用 herdr 打开"，没有 herdr 的机器不会勾。
pub fn targets_from(profiles: &[crate::store::ConnectionProfile]) -> Vec<DotTarget> {
    profiles
        .iter()
        .filter_map(|p| {
            let ssh = p.ssh.as_ref()?;
            if !ssh.herdr_enabled {
                return None;
            }
            Some(DotTarget {
                profile_id: p.id.clone(),
                name: p.name.clone(),
            })
        })
        .collect()
}

/// 红点信号。字段形状和 `ai_log_watch::AiLogSignal` 一致（前端复用同一个 `listen`），
/// 额外带 `source` / `server` / `serverName` 三个字段给 herdr 文案用。
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HerdrDotSignal {
    /// `needs-you` / `resolved` / `finished`
    pub kind: String,
    /// herdr 认出来的 agent 种类（codex / claude / ...）
    pub agent: String,
    /// herdr 没有"会话 id"这个概念，固定空串（前端类型要求有这个字段）
    pub session_id: String,
    /// 窗格当前工作目录
    pub cwd: String,
    /// 窗格号（herdr 里"这一次"的标识就是窗格）
    pub turn: String,
    /// 去重键：`herdr|<server_profile_id>|<pane>`。`resolved` 用的就是它对应那条 `needs-you` 的 key。
    pub key: String,
    /// 卡片级：这条信号对应的**实例标识** = 上面的 `key`。
    ///
    /// 为什么和 `key` 一样还要单独给一个：字段形状要和 `ai_log_watch::AiLogSignal`
    /// **保持同一份**（前端只有一条卡片更新路径），本机日志那边 `key` 是"轮次级"、
    /// `instanceKey` 才是"实例级"，两边对一个字段的不同含义比多一套判据更难维护。
    pub instance_key: String,
    /// 卡片级：这条信号想让卡片显示成什么（`working` / `needs-you` / `finished` / `idle`）。
    pub state: String,
    /// 卡片级：最后一段话 —— herdr 的 agent list 只有状态、没有"最后说了什么"，
    /// 所以固定空串（卡片的最后动作由快照里的窗格标题补，见 [`HerdrAgentSnapshot`]）。
    pub activity: String,
    /// 事件时间（Unix 毫秒）
    pub at_ms: i64,
    /// 给通知文案留的补充说明（herdr 只有状态、没有"最后一段话"，所以留空）
    pub message: String,
    /// 固定 [`SOURCE_HERDR`]：前端据此写"哪台服务器 · 哪个 agent"
    pub source: String,
    /// 服务器配置 id
    pub server: String,
    /// 服务器显示名
    pub server_name: String,
}

/// 快照里的一个窗格（字段就是 `herdr agent list` 已经给出来的那几样，**不额外探测**）。
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HerdrAgentSnapshot {
    /// 窗格号（形如 `w1:p1`）—— 卡片的锚，也是红点 key 的第三段
    pub pane: String,
    /// 原始状态词：working / blocked / done / idle / unknown
    pub status: String,
    /// agent 种类（codex / claude / ...）
    pub agent: String,
    /// 窗格当前工作目录
    pub cwd: String,
    /// 工作区号（形如 `w1`）—— 卡片上"在哪个工作区"的依据
    pub workspace: String,
    /// 标签页号（形如 `w1:t1`）
    pub tab: String,
    /// herdr 里显示的那个窗格标题
    pub title: String,
    pub focused: bool,
    /// 是不是在等我们做事（= blocked）
    pub attention: bool,
    /// 统一模型的状态词（`ai_instance::state_of_herdr` 映射好的）——
    /// 前端直接用它，别再自己判一遍（两套判定迟早不一致）。
    pub state: String,
    /// 最后动作：窗格标题；标题就是目录本身时留空（和 `observations_from_herdr` 同一口径）。
    pub activity: String,
}

/// 一台服务器这一轮的**全量** agent 快照（`zeeai://herdr-agents` 的 payload）。
///
/// 为什么整份发、而不是只发"变了的"：卡片是**状态**，不是事件 —— 前端拿全量覆盖
/// 自己的字段最简单、也最不容易漏；而且这份数据本来就在内存里，序列化一次不多花请求。
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HerdrAgentsSnapshot {
    /// 固定 [`SOURCE_HERDR`]（前端据此区分"这是 herdr 快照"）
    pub source: String,
    /// 服务器配置 id（卡片按钮要凭它开观察窗 / 接管）
    pub server: String,
    /// 服务器显示名（卡片的 `where` 第一段）
    pub server_name: String,
    /// 这一轮的时间（Unix 毫秒）
    pub at_ms: i64,
    /// 所有窗格（按窗格号排序：同一份数据两次发出的顺序一致，前端 key 也稳定）
    pub agents: Vec<HerdrAgentSnapshot>,
}

/// 一轮轮询的产出：红点信号（边沿）+ 卡片快照（每台服务器一份全量）。
#[derive(Default)]
pub struct PollOutcome {
    pub signals: Vec<HerdrDotSignal>,
    pub snapshots: Vec<HerdrAgentsSnapshot>,
}

/// 一个窗格上一轮的样子（边沿检测 + 清红点都要用到）
#[derive(Clone, Debug)]
struct PaneState {
    /// 上一轮 herdr 报的状态（working / blocked / done / idle / unknown）
    status: String,
    /// 上一轮的 agent 种类（窗格消失时清红点要用）
    agent: String,
    /// 上一轮的目录（同上）
    cwd: String,
    /// 当前还亮着的 `needs-you` 的 key（空 = 现在没在等你）
    needs_key: String,
}

/// 一台服务器上一轮看到的全部窗格
#[derive(Default)]
struct ServerState {
    name: String,
    panes: HashMap<String, PaneState>,
}

/// 红点状态机（纯内存、纯函数式输入 → 输出，单测不连网）。
///
/// 只在这里记"上一轮每个窗格是什么状态"：跨轮去重靠它，不靠前端、也不落盘
/// （重启后 blocked 会重新亮 —— 那是"状态"，本来就该亮；done 不会补报 —— 那是"事件"）。
#[derive(Default)]
pub struct DotTracker {
    servers: HashMap<String, ServerState>,
}

impl DotTracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// 吃一台服务器这一轮的 `herdr agent list` 结果，返回该发给前端的信号。
    ///
    /// `at_ms` 由调用方传（单测给固定值，不依赖真实时钟）。
    pub fn observe(
        &mut self,
        target: &DotTarget,
        agents: &[HerdrAgent],
        at_ms: i64,
    ) -> Vec<HerdrDotSignal> {
        let mut out: Vec<HerdrDotSignal> = Vec::new();
        // 先摘出来：后面要按"上一轮"读、再按"这一轮"写回
        let mut prev_server = self.servers.remove(&target.profile_id).unwrap_or_default();

        // 同一个窗格重复出现时**以最后一条为准**：一轮里不能亮两次、也不能把状态来回翻。
        let mut now: HashMap<String, &HerdrAgent> = HashMap::new();
        for a in agents {
            if a.pane_id.trim().is_empty() {
                continue;
            }
            now.insert(a.pane_id.clone(), a);
        }

        let mut next_panes: HashMap<String, PaneState> = HashMap::with_capacity(now.len());
        // 按窗格号排序再处理：HashMap 的遍历顺序是随机的，排一下让日志 / 测试里的信号顺序
        // 稳定（同一轮里"先清哪条、再亮哪条"可复现，排查时不至于每次都不一样）。
        let mut panes: Vec<&String> = now.keys().collect();
        panes.sort();
        for pane in panes {
            let Some(a) = now.get(pane) else {
                continue;
            };
            let key = dot_key(&target.profile_id, pane);
            let prev = prev_server.panes.get(pane);
            let mut needs_key = prev.map(|p| p.needs_key.clone()).unwrap_or_default();

            // ① `blocked` 是**状态**：亮到你处理为止（herdr 那边不再是 blocked 才清）。
            if a.status == STATUS_BLOCKED {
                if needs_key.is_empty() {
                    needs_key = key.clone();
                    out.push(signal(
                        "needs-you",
                        target,
                        pane,
                        &a.status,
                        &a.kind,
                        &a.cwd,
                        key.clone(),
                        at_ms,
                    ));
                }
            } else if !needs_key.is_empty() {
                // 不再是 blocked（working / done / idle / unknown）→ 清掉同 key 的红点。
                // 注意 `resolved` 的 key 必须用**旧**那个，不能用这一轮的 `key` 拼错。
                out.push(signal(
                    "resolved",
                    target,
                    pane,
                    &a.status,
                    &a.kind,
                    &a.cwd,
                    needs_key.clone(),
                    at_ms,
                ));
                needs_key.clear();
            }

            // ② `done` 是**事件**：只在"进入 done"的那一次亮（边沿检测）。
            //    - 上一轮也是 done → 不发（持续 done 不重复）；
            //    - 第一次看见就是 done → 不发（不补报历史）。
            let was = prev.map(|p| p.status.as_str());
            if a.status == STATUS_DONE && was.is_some() && was != Some(STATUS_DONE) {
                out.push(signal(
                    "finished",
                    target,
                    pane,
                    &a.status,
                    &a.kind,
                    &a.cwd,
                    key,
                    at_ms,
                ));
            }

            next_panes.insert(
                pane.clone(),
                PaneState {
                    status: a.status.clone(),
                    agent: a.kind.clone(),
                    cwd: a.cwd.clone(),
                    needs_key,
                },
            );
        }

        // ③ 窗格消失（agent 退出 / 窗格被关）：还在"等你"就必须清，否则红点永远挂着。
        //    消失**不算** `finished` —— "跑完停下"是 done，不是"看不见了"。
        for (pane, prev) in prev_server.panes.iter() {
            if next_panes.contains_key(pane) || prev.needs_key.is_empty() {
                continue;
            }
            // 状态传空串 = `unknown`：窗格已经没了，不能凭"上一轮是 blocked"就把卡片状态
            // 写成需要你（那是旧状态），也不能编成 idle / 已完成。
            out.push(signal(
                "resolved",
                target,
                pane,
                "",
                &prev.agent,
                &prev.cwd,
                prev.needs_key.clone(),
                at_ms,
            ));
        }

        prev_server.name = target.name.clone();
        prev_server.panes = next_panes;
        self.servers.insert(target.profile_id.clone(), prev_server);
        out
    }

    /// 这一轮的目标里已经没有某台服务器了（用户取消勾选 / 删了它）：
    /// 把它还亮着的 "需要你" 清掉 —— 否则红点会挂在活动栏上再也没人去清。
    pub fn prune(&mut self, active: &[DotTarget], at_ms: i64) -> Vec<HerdrDotSignal> {
        let live: HashSet<&str> = active.iter().map(|t| t.profile_id.as_str()).collect();
        let dead: Vec<String> = self
            .servers
            .keys()
            .filter(|id| !live.contains(id.as_str()))
            .cloned()
            .collect();
        let mut out = Vec::new();
        for id in dead {
            let Some(server) = self.servers.remove(&id) else {
                continue;
            };
            let target = DotTarget {
                profile_id: id,
                name: server.name,
            };
            for (pane, st) in server.panes {
                if st.needs_key.is_empty() {
                    continue;
                }
                out.push(signal(
                    "resolved",
                    &target,
                    &pane,
                    // 同上：服务器都不在目标里了，卡片状态只能是 unknown（不编旧状态）。
                    "",
                    &st.agent,
                    &st.cwd,
                    st.needs_key,
                    at_ms,
                ));
            }
        }
        out
    }
}

/// `herdr|<server_profile_id>|<pane>`。前端 `applyAiLogSignal` 按这个 key 去重/清红点。
fn dot_key(profile_id: &str, pane: &str) -> String {
    format!("herdr|{profile_id}|{pane}")
}

#[allow(clippy::too_many_arguments)]
fn signal(
    kind: &str,
    target: &DotTarget,
    pane: &str,
    status: &str,
    agent: &str,
    cwd: &str,
    key: String,
    at_ms: i64,
) -> HerdrDotSignal {
    let state = state_of_herdr(status);
    HerdrDotSignal {
        kind: kind.to_string(),
        agent: agent.to_string(),
        session_id: String::new(),
        cwd: cwd.to_string(),
        turn: pane.to_string(),
        key: key.clone(),
        instance_key: key,
        state: state.as_str().to_string(),
        // herdr 的 agent list 只有状态，没有"最后一段话"；卡片的最后动作由快照里的
        // 窗格标题补（`activity` 在快照那条路上才有内容）。
        activity: String::new(),
        at_ms,
        // herdr 的 agent list 只有状态，没有"最后一段话"；文案由前端按服务器 + 窗格拼。
        message: String::new(),
        source: SOURCE_HERDR.to_string(),
        server: target.profile_id.clone(),
        server_name: target.name.clone(),
    }
}

/// 这一轮的 `herdr agent list` → 卡片快照（**纯函数**：单测不连网）。
///
/// 只做形状转换，不做判断：状态词走 `ai_instance::state_of_herdr`、标题是否算"最后动作"
/// 和 `ai_instance::observations_from_herdr` 同一口径 —— 两处各判一套的话，
/// 同一张卡在"刷新后"和"轮询后"会显示成两件事。
pub fn snapshot_of(target: &DotTarget, agents: &[HerdrAgent], at_ms: i64) -> HerdrAgentsSnapshot {
    // 同一个窗格重复出现时以最后一条为准；按窗格号排序让两次发出的顺序一致。
    let mut by_pane: HashMap<&str, &HerdrAgent> = HashMap::new();
    for a in agents {
        if a.pane_id.trim().is_empty() {
            continue;
        }
        by_pane.insert(a.pane_id.as_str(), a);
    }
    let mut panes: Vec<&str> = by_pane.keys().copied().collect();
    panes.sort_unstable();

    let list = panes
        .into_iter()
        .filter_map(|pane| by_pane.get(pane).map(|a| (pane, *a)))
        .map(|(_, a)| {
            let state = state_of_herdr(&a.status);
            let title = a.title.trim();
            HerdrAgentSnapshot {
                pane: a.pane_id.clone(),
                status: a.status.clone(),
                agent: a.kind.clone(),
                cwd: a.cwd.clone(),
                workspace: a.workspace_id.clone(),
                tab: a.tab_id.clone(),
                title: a.title.clone(),
                focused: a.focused,
                attention: a.attention,
                state: state.as_str().to_string(),
                // 标题是目录本身时不算"最后动作"（卡片上会变成一句废话）。
                activity: if !title.is_empty() && title != a.cwd.trim() {
                    clip_chars(title, ACTIVITY_MAX_CHARS)
                } else {
                    String::new()
                },
            }
        })
        .collect();

    HerdrAgentsSnapshot {
        source: SOURCE_HERDR.to_string(),
        server: target.profile_id.clone(),
        server_name: target.name.clone(),
        at_ms,
        agents: list,
    }
}

/// 跑一轮：逐台调 `commands::herdr_agents`（已有的那条路，隐藏窗口、20 秒超时），
/// 返回这一轮该发给前端的**红点信号 + 卡片快照**。
///
/// 为什么串行不并发：一轮里同时开 N 条 ssh 会在网络差的时候挤在一起，
/// 而且这个轮询本来就不赶时间（60 秒一轮）。单台失败只影响它自己。
///
/// **失败静默**：只 `log::warn` 一行，这一轮跳过 —— 网络抖一下不代表"它不再等你了"，
/// 所以**不补发** `resolved`；**也不发快照**（前端拿不到这一轮的数据就保留上一张卡，
/// 而不是把"没看见"当成"没了"去删卡）。等下一轮真的拿到状态再对齐。
pub async fn poll_once(tracker: &mut DotTracker, targets: &[DotTarget]) -> PollOutcome {
    let at = now_ms();
    let mut out = PollOutcome {
        signals: tracker.prune(targets, at),
        snapshots: Vec::new(),
    };
    for t in targets {
        match crate::commands::herdr_agents(t.profile_id.clone(), None).await {
            Ok(agents) => {
                // 一次取"现在"给两份产出用：同一轮的红点和快照时间对得上。
                let now = now_ms();
                let sigs = tracker.observe(t, &agents, now);
                if !sigs.is_empty() {
                    log::info!(
                        "herdr 红点: {} 这一轮 {} 条信号（{} 个 agent）",
                        t.name,
                        sigs.len(),
                        agents.len()
                    );
                }
                out.signals.extend(sigs);
                // 卡片快照是**每轮都发**的（哪怕一条红点信号都没有）：卡片是状态，
                // 不是"变了才提醒"的事件 —— 首次启动、状态从 blocked 回到 working
                // 这些都不一定产生边沿信号，但卡片必须跟着变。
                out.snapshots.push(snapshot_of(t, &agents, now));
            }
            Err(e) => {
                log::warn!(
                    "herdr 红点: 查 {} 的 agent 列表失败（这一轮跳过，不亮也不清）：{e}",
                    t.name
                );
            }
        }
    }
    out
}

/// 起一条后台任务：每 [`HERDR_DOT_POLL_MS`] 把"开了 herdr 的服务器"的 agent 状态
/// 翻成红点信号 + 卡片快照 `emit` 给前端。
///
/// 用 `tauri::async_runtime::spawn` 而不是裸 `std::thread`：`commands::herdr_agents`
/// 本身是 async（russh / tokio 进程），在 Tauri 的运行时里跑最省事；
/// 线程生命周期与 `ai_log_watch` 相同（setup 里起、应用退出时结束），
/// 区别是这里有一个显式 [`stop`] 停止位（那一条只读本地文件、没有可清理的资源）。
pub fn spawn(app: tauri::AppHandle) {
    use tauri::Emitter;
    // 应用只 run 一次；这里复位是为了 selftest / 重启路径里复用同一进程时不残留停止位
    STOP.store(false, Ordering::SeqCst);
    tauri::async_runtime::spawn(async move {
        if sleep_unless_stopped(HERDR_DOT_STARTUP_DELAY_MS).await {
            return;
        }
        log::info!(
            "herdr 红点: 开始轮询（间隔 {} 秒，只查勾了 herdr 的服务器；失败只记 warn）",
            HERDR_DOT_POLL_MS / 1000
        );
        let mut tracker = DotTracker::new();
        loop {
            if STOP.load(Ordering::SeqCst) {
                log::info!("herdr 红点: 应用退出，轮询结束（没有残留请求）");
                return;
            }
            let t0 = std::time::Instant::now();
            // 每轮重新读一遍配置：用户可能在应用运行期间才勾上/取消某台服务器。
            // 注意：读的是本机那个小 JSON（不是探测），失败了就跳过这一轮，
            // **不要**把"读配置失败"当成"没有 herdr 服务器"去清红点。
            match crate::store::load() {
                Ok(profiles) => {
                    let targets = targets_from(&profiles);
                    let outcome = poll_once(&mut tracker, &targets).await;
                    // 先发卡片快照（全量、每轮都发），再发红点边沿信号。两个事件各管一件事：
                    // 前端不需要在同一个监听里猜"这条是快照还是边沿"。
                    for snap in outcome.snapshots {
                        log::info!(
                            "herdr 卡片快照: {} 这一轮 {} 个 agent",
                            snap.server_name,
                            snap.agents.len()
                        );
                        let _ = app.emit(SNAPSHOT_EVENT_NAME, &snap);
                    }
                    for sig in outcome.signals {
                        log::info!(
                            "herdr 红点: kind={} key={} server={}",
                            sig.kind,
                            sig.key,
                            sig.server_name
                        );
                        let _ = app.emit(EVENT_NAME, &sig);
                    }
                }
                Err(e) => log::warn!("herdr 红点: 读服务器配置失败，这一轮跳过：{e}"),
            }
            // 按"这一轮开始的时间 + 间隔"算下一次，保证 60 秒是**下限**
            //（一轮里 N 台服务器各自最多 20 秒超时，最坏情况会超过 60 秒，那就下一轮立刻开始）。
            let spent = t0.elapsed();
            let wait = Duration::from_millis(HERDR_DOT_POLL_MS).saturating_sub(spent);
            if sleep_unless_stopped(wait.as_millis() as u64).await {
                log::info!("herdr 红点: 应用退出，轮询结束（没有残留请求）");
                return;
            }
        }
    });
}

/// 让轮询线程能干净退出：`lib.rs` 的 `RunEvent::Exit` 里置位。
pub fn stop() {
    STOP.store(true, Ordering::SeqCst);
}

/// 分片睡眠：既保证间隔，又让退出最多等 [`STOP_CHECK_MS`] 而不是卡满一个周期。
/// 返回 `true` = 收到停止位，调用方应立刻结束。
async fn sleep_unless_stopped(ms: u64) -> bool {
    let mut left = ms;
    while left > 0 {
        if STOP.load(Ordering::SeqCst) {
            return true;
        }
        let chunk = left.min(STOP_CHECK_MS);
        tokio::time::sleep(Duration::from_millis(chunk)).await;
        left -= chunk;
    }
    STOP.load(Ordering::SeqCst)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(id: &str, name: &str) -> DotTarget {
        DotTarget {
            profile_id: id.to_string(),
            name: name.to_string(),
        }
    }

    fn agent(pane: &str, status: &str) -> HerdrAgent {
        HerdrAgent {
            kind: "codex".to_string(),
            status: status.to_string(),
            cwd: "/home/user/proj".to_string(),
            pane_id: pane.to_string(),
            tab_id: "w1:t1".to_string(),
            workspace_id: "w1".to_string(),
            title: "proj".to_string(),
            focused: false,
            attention: status == STATUS_BLOCKED,
        }
    }

    fn ssh_profile(id: &str, name: &str, herdr_enabled: bool) -> crate::store::ConnectionProfile {
        crate::store::ConnectionProfile {
            id: id.to_string(),
            kind: "ssh".to_string(),
            name: name.to_string(),
            group: "默认".to_string(),
            color: None,
            ssh: Some(crate::store::SshConfig {
                host: "10.0.0.1".to_string(),
                port: 22,
                user: "root".to_string(),
                auth_kind: "key".to_string(),
                allow_password: false,
                key_path: None,
                jump: None,
                tmux_enabled: true,
                herdr_enabled,
                tmux_template: "{host}-{user}".to_string(),
                start_dir: None,
            }),
            serial: None,
            local: None,
            highlight_set_id: None,
            term_scheme: None,
            term_scheme_custom: None,
        }
    }

    fn local_profile(id: &str) -> crate::store::ConnectionProfile {
        crate::store::ConnectionProfile {
            id: id.to_string(),
            kind: "local".to_string(),
            name: "本机".to_string(),
            group: "默认".to_string(),
            color: None,
            ssh: None,
            serial: None,
            local: Some(crate::store::LocalConfig {
                shell: "powershell".to_string(),
                distro: None,
                cwd: None,
            }),
            highlight_set_id: None,
            term_scheme: None,
            term_scheme_custom: None,
        }
    }

    /// ① `blocked` → needs-you（key 是 `herdr|<服务器>|<窗格>`）。
    #[test]
    fn blocked_lights_needs_you_with_herdr_key() {
        let mut tracker = DotTracker::new();
        let got = tracker.observe(&target("srv-1", "lz"), &[agent("w1:p1", "blocked")], 1_000);
        assert_eq!(got.len(), 1, "blocked 应该刚好亮一条：{got:?}");
        assert_eq!(got[0].kind, "needs-you");
        assert_eq!(got[0].key, "herdr|srv-1|w1:p1");
        assert_eq!(got[0].source, "herdr");
        assert_eq!(got[0].server, "srv-1");
        assert_eq!(got[0].server_name, "lz");
        assert_eq!(got[0].agent, "codex");
        assert_eq!(got[0].cwd, "/home/user/proj");
        assert_eq!(got[0].turn, "w1:p1");
        assert_eq!(got[0].at_ms, 1_000);
    }

    /// ② 持续 blocked：跨几轮都不重复亮（Rust 侧状态机记住"已经亮过"）。
    #[test]
    fn continuous_blocked_never_relights() {
        let mut tracker = DotTracker::new();
        let t = target("srv-1", "lz");
        assert_eq!(tracker.observe(&t, &[agent("w1:p1", "blocked")], 1_000).len(), 1);
        for at in [61_000, 121_000, 181_000] {
            let got = tracker.observe(&t, &[agent("w1:p1", "blocked")], at);
            assert!(got.is_empty(), "持续 blocked 不该重复亮（at={at}）：{got:?}");
        }
    }

    /// ③ blocked 消失 → 同一个 key 的 resolved（红点清掉）；之后再说 working 也不再发。
    #[test]
    fn leaving_blocked_resolves_same_key() {
        let mut tracker = DotTracker::new();
        let t = target("srv-1", "lz");
        let first = tracker.observe(&t, &[agent("w1:p1", "blocked")], 1_000);
        assert_eq!(first.len(), 1);
        let cleared = tracker.observe(&t, &[agent("w1:p1", "working")], 61_000);
        assert_eq!(cleared.len(), 1, "应该只发一条 resolved：{cleared:?}");
        assert_eq!(cleared[0].kind, "resolved");
        assert_eq!(cleared[0].key, first[0].key, "resolved 必须清同一个 key");
        assert!(
            tracker.observe(&t, &[agent("w1:p1", "working")], 121_000).is_empty(),
            "已经清过就不该再发"
        );
    }

    /// ④ 进入 done 亮一次 finished（working → done）。
    #[test]
    fn entering_done_lights_finished_once() {
        let mut tracker = DotTracker::new();
        let t = target("srv-1", "lz");
        assert!(
            tracker.observe(&t, &[agent("w1:p1", "working")], 1_000).is_empty(),
            "working 不亮"
        );
        let got = tracker.observe(&t, &[agent("w1:p1", "done")], 61_000);
        assert_eq!(got.len(), 1, "进入 done 应该亮一条 finished：{got:?}");
        assert_eq!(got[0].kind, "finished");
        assert_eq!(got[0].key, "herdr|srv-1|w1:p1");
    }

    /// ⑤ 持续 done 不重复亮（跑完是事件，不是"每轮都提醒一次"）。
    #[test]
    fn continuous_done_never_relights() {
        let mut tracker = DotTracker::new();
        let t = target("srv-1", "lz");
        tracker.observe(&t, &[agent("w1:p1", "working")], 1_000);
        assert_eq!(tracker.observe(&t, &[agent("w1:p1", "done")], 61_000).len(), 1);
        for at in [121_000, 181_000, 241_000] {
            let got = tracker.observe(&t, &[agent("w1:p1", "done")], at);
            assert!(got.is_empty(), "持续 done 不该重复亮（at={at}）：{got:?}");
        }
    }

    /// ⑥ done → working → done：回退之后再 done 是新的一次"跑完"，可以再亮一次。
    #[test]
    fn done_working_done_lights_again() {
        let mut tracker = DotTracker::new();
        let t = target("srv-1", "lz");
        tracker.observe(&t, &[agent("w1:p1", "working")], 1_000);
        let first = tracker.observe(&t, &[agent("w1:p1", "done")], 61_000);
        assert_eq!(first.len(), 1);
        assert!(
            tracker.observe(&t, &[agent("w1:p1", "working")], 121_000).is_empty(),
            "回退到 working 不亮（它只是在跑）"
        );
        let again = tracker.observe(&t, &[agent("w1:p1", "done")], 181_000);
        assert_eq!(again.len(), 1, "第二轮跑完应该再亮一次：{again:?}");
        assert_eq!(again[0].kind, "finished");
        assert_eq!(again[0].key, first[0].key, "同一个窗格的 key 不变");
    }

    /// ⑦ 没有开了 herdr 的服务器：一个目标都没有 → `poll_once` 里循环一次都不进，
    ///    也就**一个 ssh 请求都不会发**（纯函数判定，不连网）。
    #[tokio::test]
    async fn no_herdr_servers_means_no_request() {
        let profiles = [
            ssh_profile("srv-off", "hk", false),
            local_profile("local-1"),
        ];
        let targets = targets_from(&profiles);
        assert!(targets.is_empty(), "没勾 herdr 的机器不该成为目标：{targets:?}");

        // 这几行就是轮询线程每一轮真正走的路径：目标为空 => 不发请求、也不产出信号/快照。
        let mut tracker = DotTracker::new();
        let got = poll_once(&mut tracker, &targets).await;
        assert!(
            got.signals.is_empty() && got.snapshots.is_empty(),
            "没有目标就不该有任何红点信号 / 卡片快照：{:?}",
            got.signals
        );

        // 反过来：勾了 herdr 的 SSH 服务器才是目标（而且只挑它）
        let profiles = [
            ssh_profile("srv-on", "lz", true),
            ssh_profile("srv-off", "hk", false),
            local_profile("local-1"),
        ];
        let targets = targets_from(&profiles);
        assert_eq!(targets.len(), 1, "只该挑出勾了 herdr 的那台：{targets:?}");
        assert_eq!(targets[0].profile_id, "srv-on");
        assert_eq!(targets[0].name, "lz");
    }

    /// ⑧ 窗格消失（agent 退出）时还亮着"需要你" → 必须清掉，否则红点永远挂着。
    #[test]
    fn disappeared_pane_resolves_open_needs() {
        let mut tracker = DotTracker::new();
        let t = target("srv-1", "lz");
        let first = tracker.observe(
            &t,
            &[agent("w1:p1", "blocked"), agent("w1:p2", "working")],
            1_000,
        );
        assert_eq!(first.len(), 1);
        // w1:p1 的 agent 退出了，只剩 w1:p2
        let got = tracker.observe(&t, &[agent("w1:p2", "working")], 61_000);
        assert_eq!(got.len(), 1, "消失的窗格要清红点：{got:?}");
        assert_eq!(got[0].kind, "resolved");
        assert_eq!(got[0].key, first[0].key);
    }

    /// ⑨ 服务器被取消勾选 / 删掉：prune 把它还亮着的"需要你"清掉。
    #[test]
    fn removing_server_resolves_open_needs() {
        let mut tracker = DotTracker::new();
        let t = target("srv-1", "lz");
        assert_eq!(tracker.observe(&t, &[agent("w1:p1", "blocked")], 1_000).len(), 1);
        let got = tracker.prune(&[], 61_000);
        assert_eq!(got.len(), 1, "服务器没了要把红点收走：{got:?}");
        assert_eq!(got[0].kind, "resolved");
        assert_eq!(got[0].key, "herdr|srv-1|w1:p1");
        assert!(tracker.prune(&[], 121_000).is_empty(), "清过就不该重复发");
    }

    /// ⑩ 两次看见的状态一样（blocked）但换了窗格：各自独立，不互相吞。
    #[test]
    fn two_panes_are_tracked_independently() {
        let mut tracker = DotTracker::new();
        let t = target("srv-1", "lz");
        let got = tracker.observe(
            &t,
            &[agent("w1:p1", "blocked"), agent("w1:p2", "blocked")],
            1_000,
        );
        assert_eq!(got.len(), 2, "两个窗格各亮一条：{got:?}");
        assert_eq!(got[0].key, "herdr|srv-1|w1:p1");
        assert_eq!(got[1].key, "herdr|srv-1|w1:p2");
    }

    /// ⑪ 间隔是**用户批的 60 秒下限**，启动延迟 10–15 秒；谁改小谁把这条弄红。
    #[test]
    fn poll_interval_and_startup_delay_follow_the_rule() {
        assert!(
            HERDR_DOT_POLL_MS >= 60_000,
            "herdr 红点轮询不能比 60 秒更密（用户批的就是 60 秒）"
        );
        assert!(
            (10_000..=15_000).contains(&HERDR_DOT_STARTUP_DELAY_MS),
            "启动延迟应该在 10–15 秒（别和首屏抢）"
        );
    }

    /// ⑫ 本模块**不裸起进程**：只允许复用 `commands::herdr_agents`（内部走隐藏窗口的
    /// `proc::hidden_command_async` / russh）。拿源码钉住 —— 以后有人顺手写一条
    /// `Command::new("ssh")`，这条会红（那正是用户报的"黑窗一闪"）。
    #[test]
    fn herdr_dots_spawn_no_bare_command() {
        let src = include_str!("ai_herdr_dots.rs");
        let code = src.split("#[cfg(test)]").next().unwrap_or(src);
        assert!(
            !code.contains("Command::new") && !code.contains("std::process::"),
            "herdr 红点轮询必须复用 commands::herdr_agents（隐藏窗口），不许裸起进程"
        );
        assert!(
            code.contains("crate::commands::herdr_agents"),
            "探测必须走已有的 commands::herdr_agents 那条链路"
        );
    }

    // ---------- 卡片快照（2026-10-20：没点刷新也能更新/创建 herdr 卡片） ----------

    /// ⑬ 快照形状：服务器身份 + 每个窗格的 pane/status/agent/cwd/workspace 齐全；
    ///    状态走统一模型（blocked = needs-you、done = finished），顺序按窗格号稳定。
    #[test]
    fn snapshot_has_all_pane_fields_and_stable_order() {
        let t = target("srv-1", "lz");
        // 故意乱序 + 放进一个不存在的空窗格：排序要稳、空窗格要被丢掉。
        let mut empty = agent("", "working");
        empty.kind = "ghost".into();
        let snap = snapshot_of(
            &t,
            &[
                agent("w1:p2", "working"),
                empty,
                agent("w1:p1", "blocked"),
                agent("w1:p3", "done"),
            ],
            1_700_000_000_000,
        );

        assert_eq!(snap.source, "herdr");
        assert_eq!(snap.server, "srv-1");
        assert_eq!(snap.server_name, "lz");
        assert_eq!(snap.at_ms, 1_700_000_000_000);
        let panes: Vec<&str> = snap.agents.iter().map(|a| a.pane.as_str()).collect();
        assert_eq!(panes, vec!["w1:p1", "w1:p2", "w1:p3"], "按窗格号排序、空窗格丢掉");
        assert_eq!(snap.agents[0].state, "needs-you", "blocked → 需要你");
        assert_eq!(snap.agents[1].state, "working");
        assert_eq!(snap.agents[2].state, "finished", "done → 已完成（不是 idle）");
        for a in &snap.agents {
            assert_eq!(a.agent, "codex");
            assert_eq!(a.cwd, "/home/user/proj");
            assert_eq!(a.workspace, "w1");
            assert!(!a.pane.is_empty() && !a.tab.is_empty(), "pane/tab 都要带上");
            // 标题 "proj" 不是目录本身 → 可以当"最后动作"
            assert_eq!(a.activity, "proj");
        }

        // 序列化给前端：字段名是 camelCase（前端类型按这个写）。
        let v = serde_json::to_value(&snap).expect("快照必须可序列化");
        assert_eq!(v["serverName"], "lz");
        assert_eq!(v["atMs"], 1_700_000_000_000_i64);
        assert_eq!(v["agents"][0]["pane"], "w1:p1");
        assert_eq!(v["agents"][0]["workspace"], "w1");
        assert_eq!(v["agents"][0]["state"], "needs-you");
        assert!(v["agents"][0]["activity"].is_string());
    }

    /// ⑭ 空 agent 列表也要发一份快照（"这台机器这一轮没有 agent"是状态）；
    ///    标题就是目录本身时不算"最后动作"（和 `observations_from_herdr` 同一口径）。
    #[test]
    fn snapshot_handles_empty_list_and_directory_title() {
        let t = target("srv-2", "hk");
        let empty = snapshot_of(&t, &[], 42);
        assert!(empty.agents.is_empty(), "没有 agent 也要有一份空快照：{empty:?}");
        assert_eq!(empty.server_name, "hk");

        let mut a = agent("w2:p1", "idle");
        a.title = a.cwd.clone(); // 标题 == 目录 → 不是"最后动作"
        let snap = snapshot_of(&t, &[a], 43);
        assert_eq!(snap.agents[0].activity, "", "目录名不能当「最后动作」");
        assert_eq!(snap.agents[0].state, "idle");
    }
}
