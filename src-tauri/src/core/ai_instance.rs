//! AI 看板 v2 的统一实体：**AI 实例**（`AiInstance`）。
//!
//! 为什么要有这个模块：老看板把五套来源（herdr 第一手 / 远端 tmux+ps / 本机进程表 /
//! WSL ps / App 自己的账本 / rollout 日志）画成同一种卡，再用"两趟打补丁"的合并规则
//! 去逼近"一个实例一张卡"（`App.tsx` 里的 `taskKeyOf` + 第二趟并组）。那套规则的问题是
//! **实体定义错了**：主键里既掺了"环境/服务器/工具/目录"，又掺了"窗格"，于是
//! "两个 codex 只剩一张卡"这类毛病只能靠补丁修。
//!
//! 这里的做法是：**先定实体，再谈合并**——
//!   1. 每条观测（`Observation`）都带"谁说的"（`EvidenceSource`）与"多可信"（`Confidence`）；
//!   2. 实体主键 = **承载 + 环境 + 实例锚**（herdr 窗格 / tmux 目标 / pid / 账本 id）；
//!   3. 没有锚的观测（例如只知道"这台机器上有个 codex 在跑"）**只在候选唯一时**并进锚实体，
//!      候选不唯一就**单独成卡**——宁可多一张卡，也不许把两个实例合成一个；
//!   4. 状态取**可信度最高**的那条证据，然后过一遍**承载能力闸门**（`sanitize_state`）：
//!      **推断绝不说成事实**（`docs/design-ai-board-v2.md` §3.3 / §10.4 / §10.5）。
//!
//! 口径以设计文档 **§10「最终口径」** 为准，与 §3/§4 冲突处以 §10 为准。

use serde::{Deserialize, Serialize};

/// `working` 超过这么久没有任何新证据 → 降级成 `unknown`，并在卡上写"可能已卡住"。
/// （设计文档 §3.5-3：10 分钟。）
pub const STALE_AFTER_MS: u64 = 10 * 60 * 1000;

/// `finished` 在「最近完成」顶部保留这么久，之后只在折叠区/时间线里（§3.5-1）。
pub const RECENT_FINISHED_MS: u64 = 30 * 60 * 1000;

/// 这条实例**跑在什么承载上**：界面按它决定"能承诺什么状态"（§3.3）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Carrier {
    /// 本机 PowerShell / pwsh 会话。
    LocalPowershell,
    /// 本机 CMD：什么都没有可扫，**只标"仅状态"且不上板**（§10.5）。
    LocalCmd,
    /// WSL：进 WSL 内部跑 ps。
    Wsl,
    /// 远端**裸 SSH**（没有 tmux / herdr）：只能看到"有进程"。
    SshBare,
    /// 远端 tmux：拿得到会话/窗口/窗格与前台进程。
    Tmux,
    /// 远端 herdr：**唯一能第一手给出 `needs-you` 的承载**。
    Herdr,
}

impl Carrier {
    /// 越具体越可信：合并时实体保留最具体的那个承载（herdr > tmux > 裸 SSH）。
    fn specificity(self) -> u8 {
        match self {
            Carrier::Herdr => 5,
            Carrier::Tmux => 4,
            Carrier::SshBare => 3,
            Carrier::LocalPowershell => 2,
            Carrier::Wsl => 1,
            Carrier::LocalCmd => 0,
        }
    }

    /// 这个承载**有没有资格**说"有人需要你"。
    ///
    /// 只有 herdr 有第一手状态机（`herdr.rs` 的 working/blocked/done/idle）。
    /// 裸 SSH / tmux / 本地都只能看到"有进程"，看到"输出停了"不等于"它在等你"——
    /// 两次误报就是这么来的（§10.4）。将来接了 OSC 7501（§10.7）再放开这条。
    pub fn allows_needs_you(self) -> bool {
        matches!(self, Carrier::Herdr)
    }

    /// 这个承载能不能说"已完成"：裸 SSH 连"还在不在跑"都只能靠进程表，不能下这个结论（§3.3）。
    pub fn allows_finished(self) -> bool {
        !matches!(self, Carrier::SshBare | Carrier::LocalCmd)
    }
}

/// 跑的是什么 agent。认不出来也要能表达（不许编一个最像的）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentKind {
    Codex,
    Claude,
    Gemini,
    Aider,
    /// 认识了但不是上面这些（保留原始进程名，别丢信息）。
    Other(String),
    /// 没认出来。
    Unknown,
}

impl AgentKind {
    /// 从进程名/命令猜一下 —— 只做明确匹配，**猜不出就 Unknown**。
    pub fn from_process_name(name: &str) -> AgentKind {
        let n = name.to_ascii_lowercase();
        let base = n.rsplit(['/', '\\']).next().unwrap_or(&n);
        let base = base.strip_suffix(".exe").unwrap_or(base);
        match base {
            "codex" => AgentKind::Codex,
            "claude" | "claude-code" => AgentKind::Claude,
            "gemini" | "gemini-cli" => AgentKind::Gemini,
            "aider" => AgentKind::Aider,
            _ => AgentKind::Unknown,
        }
    }
}

/// 界面只用这五个词（§3.1）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AiState {
    NeedsYou,
    Working,
    Finished,
    Idle,
    Unknown,
}

impl AiState {
    /// 统一状态 → 前端那个词（§3.1 的五个词，和 serde 的 kebab-case 完全一致）。
    ///
    /// 为什么要有它：自动来源的信号（`ai_log_watch::AiLogSignal`、herdr 的卡片快照）
    /// 用的是**普通字符串字段**（前端类型也一样），直接写 `"needs-you"` 会多出第二份字面量；
    /// 这里给一个出口，让"状态词"只有一处定义。
    pub fn as_str(self) -> &'static str {
        match self {
            AiState::NeedsYou => "needs-you",
            AiState::Working => "working",
            AiState::Finished => "finished",
            AiState::Idle => "idle",
            AiState::Unknown => "unknown",
        }
    }

    /// 面板排序：需要你 → 运行中 → 最近完成 → 空闲/未知。
    fn panel_rank(self) -> u8 {
        match self {
            AiState::NeedsYou => 0,
            AiState::Working => 1,
            AiState::Finished => 2,
            AiState::Idle => 3,
            AiState::Unknown => 4,
        }
    }
}

/// 这条结论**是谁说的**（悬停里要写清"怎么得出的"，§3.3）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EvidenceSource {
    /// herdr `agent list`：第一手状态机。
    HerdrAgentList,
    /// 远端 tmux + ps。
    RemoteTmuxPs,
    /// 本机 Windows 进程表。
    LocalProcessTable,
    /// 进 WSL 跑 ps。
    WslPs,
    /// 本应用自己的账本（只对"我们自己启动的"精确）。
    AppLedger,
    /// codex rollout 日志（状态 + 最后一句话 + token + 产物）。
    Rollout,
}

impl EvidenceSource {
    /// 来源自身的可信度：herdr 与账本是第一手；进程表/rollout 是推断。
    pub fn confidence(self) -> Confidence {
        match self {
            EvidenceSource::HerdrAgentList | EvidenceSource::AppLedger => Confidence::FirstHand,
            EvidenceSource::RemoteTmuxPs
            | EvidenceSource::LocalProcessTable
            | EvidenceSource::WslPs
            | EvidenceSource::Rollout => Confidence::Inferred,
        }
    }

    /// 同一置信度内的先后：herdr > 账本 > rollout > 进程表。
    fn rank(self) -> u8 {
        match self {
            EvidenceSource::HerdrAgentList => 5,
            EvidenceSource::AppLedger => 4,
            EvidenceSource::Rollout => 3,
            EvidenceSource::RemoteTmuxPs => 2,
            EvidenceSource::LocalProcessTable => 1,
            EvidenceSource::WslPs => 0,
        }
    }

    /// 中文短语，给悬停/徽标用。
    fn label(self) -> &'static str {
        match self {
            EvidenceSource::HerdrAgentList => "herdr 第一手",
            EvidenceSource::AppLedger => "本应用账本",
            EvidenceSource::Rollout => "rollout 日志",
            EvidenceSource::RemoteTmuxPs => "远端进程扫描",
            EvidenceSource::LocalProcessTable => "本机进程表",
            EvidenceSource::WslPs => "WSL 进程扫描",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Confidence {
    /// 第一手：对面自己说的（herdr 状态机 / 我们的账本）。
    FirstHand,
    /// 推断：进程表、日志推出来的 —— 界面上必须能看出来是推断。
    Inferred,
}

/// 一条证据：谁说的 + 什么时候 + 多可信。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Evidence {
    pub source: EvidenceSource,
    pub at_ms: u64,
    pub confidence: Confidence,
}

impl Evidence {
    pub fn new(source: EvidenceSource, at_ms: u64) -> Self {
        Self { source, at_ms, confidence: source.confidence() }
    }
}

/// 实例锚：同一承载里"哪个东西"。
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Anchor {
    /// herdr 窗格（形如 `w1:p1`）。
    HerdrPane(String),
    /// tmux 目标（形如 `work:0.1`）。
    TmuxTarget(String),
    /// 进程号。
    Pid(u32),
    /// 本应用账本 id（我们启动时生成的）。
    LedgerId(String),
}

impl Anchor {
    fn as_key(&self) -> String {
        match self {
            Anchor::HerdrPane(v) => format!("herdr:{v}"),
            Anchor::TmuxTarget(v) => format!("tmux:{v}"),
            Anchor::Pid(v) => format!("pid:{v}"),
            Anchor::LedgerId(v) => format!("ledger:{v}"),
        }
    }
}

/// 最后动作/产出（可选字段 —— 拿不到就留空，**不许编**，§3.1 取舍）。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Activity {
    /// 最后一句/最后一个动作。
    pub last_line: Option<String>,
    pub started_at_ms: Option<u64>,
    pub duration_ms: Option<u64>,
    pub tokens: Option<u64>,
    /// 产物文件（相对路径即可）。
    pub artifacts: Vec<String>,
}

impl Activity {
    /// 合并两份来源的活动信息：有值的覆盖空值，产物取并集。
    fn absorb(&mut self, other: &Activity) {
        if other.last_line.is_some() {
            self.last_line = other.last_line.clone();
        }
        if other.started_at_ms.is_some() {
            self.started_at_ms = other.started_at_ms;
        }
        if other.duration_ms.is_some() {
            self.duration_ms = other.duration_ms;
        }
        if other.tokens.is_some() {
            self.tokens = other.tokens;
        }
        for a in &other.artifacts {
            if !self.artifacts.contains(a) {
                self.artifacts.push(a.clone());
            }
        }
    }

}

/// 一条**观测**（某个来源在某个时刻看到的东西）。
///
/// 观测不是卡片：卡片是合并之后的 `AiInstance`。五个来源各自产出观测，合并逻辑只认这里的字段。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Observation {
    pub carrier: Carrier,
    pub agent: AgentKind,
    /// 环境：`本机` / `WSL` / 服务器名。
    pub env: String,
    pub cwd: Option<String>,
    /// 实例锚；拿不到锚就留 `None`（合并时只在候选唯一时并进去）。
    pub anchor: Option<Anchor>,
    pub state: AiState,
    pub source: EvidenceSource,
    pub at_ms: u64,
    pub activity: Activity,
    /// 对应的本应用会话 id（能一键切过去）。
    pub session_id: Option<String>,
}

impl Observation {
    fn evidence(&self) -> Evidence {
        Evidence::new(self.source, self.at_ms)
    }

    /// herdr `agent list`：第一手，带窗格。
    pub fn herdr(
        env: &str,
        agent: AgentKind,
        pane: &str,
        state: AiState,
        cwd: Option<&str>,
        at_ms: u64,
    ) -> Self {
        Self {
            carrier: Carrier::Herdr,
            agent,
            env: env.to_string(),
            cwd: cwd.map(str::to_string),
            anchor: Some(Anchor::HerdrPane(pane.to_string())),
            state,
            source: EvidenceSource::HerdrAgentList,
            at_ms,
            activity: Activity::default(),
            session_id: None,
        }
    }

    /// tmux 窗格（进程 + 前台命令推断）。
    pub fn tmux(
        env: &str,
        agent: AgentKind,
        target: &str,
        state: AiState,
        cwd: Option<&str>,
        at_ms: u64,
    ) -> Self {
        Self {
            carrier: Carrier::Tmux,
            agent,
            env: env.to_string(),
            cwd: cwd.map(str::to_string),
            anchor: Some(Anchor::TmuxTarget(target.to_string())),
            state,
            source: EvidenceSource::RemoteTmuxPs,
            at_ms,
            activity: Activity::default(),
            session_id: None,
        }
    }

    /// 远端裸 SSH 上的进程。
    pub fn ssh_proc(env: &str, agent: AgentKind, pid: u32, cwd: Option<&str>, at_ms: u64) -> Self {
        Self {
            carrier: Carrier::SshBare,
            agent,
            env: env.to_string(),
            cwd: cwd.map(str::to_string),
            anchor: Some(Anchor::Pid(pid)),
            state: AiState::Working,
            source: EvidenceSource::RemoteTmuxPs,
            at_ms,
            activity: Activity::default(),
            session_id: None,
        }
    }

    /// 本机进程表。
    pub fn local_proc(agent: AgentKind, pid: u32, cwd: Option<&str>, at_ms: u64) -> Self {
        Self {
            carrier: Carrier::LocalPowershell,
            agent,
            env: "本机".to_string(),
            cwd: cwd.map(str::to_string),
            anchor: Some(Anchor::Pid(pid)),
            state: AiState::Working,
            source: EvidenceSource::LocalProcessTable,
            at_ms,
            activity: Activity::default(),
            session_id: None,
        }
    }

    /// 进 WSL 内部跑 ps 看到的进程。
    pub fn wsl_proc(agent: AgentKind, pid: u32, cwd: Option<&str>, at_ms: u64) -> Self {
        Self {
            carrier: Carrier::Wsl,
            agent,
            env: "WSL".to_string(),
            cwd: cwd.map(str::to_string),
            anchor: Some(Anchor::Pid(pid)),
            state: AiState::Working,
            source: EvidenceSource::WslPs,
            at_ms,
            activity: Activity::default(),
            session_id: None,
        }
    }

    /// 本应用账本：我们自己启动的任务，第一手知道"这是我起的"。
    pub fn app_ledger(
        env: &str,
        agent: AgentKind,
        ledger_id: &str,
        state: AiState,
        at_ms: u64,
        session_id: Option<&str>,
    ) -> Self {
        Self {
            carrier: if env == "本机" { Carrier::LocalPowershell } else { Carrier::SshBare },
            agent,
            env: env.to_string(),
            cwd: None,
            anchor: Some(Anchor::LedgerId(ledger_id.to_string())),
            state,
            source: EvidenceSource::AppLedger,
            at_ms,
            activity: Activity::default(),
            session_id: session_id.map(str::to_string),
        }
    }

    /// codex rollout 日志：没有锚，只有"谁 + 在哪 + 什么状态 + 干了什么"。
    ///
    /// 这条**必须**靠 env+agent+cwd 去认领一个已有实例；认不到就单独成卡（会标成"仅日志"）。
    pub fn rollout(
        env: &str,
        agent: AgentKind,
        cwd: Option<&str>,
        state: AiState,
        at_ms: u64,
        activity: Activity,
    ) -> Self {
        Self {
            carrier: if env == "本机" { Carrier::LocalPowershell } else { Carrier::SshBare },
            agent,
            env: env.to_string(),
            cwd: cwd.map(str::to_string),
            anchor: None,
            state,
            source: EvidenceSource::Rollout,
            at_ms,
            activity,
            session_id: None,
        }
    }

}

/// 合并之后的一张卡。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AiInstance {
    /// 稳定 id：`承载:环境:锚`（同一实例在多次轮询之间保持不变）。
    pub id: String,
    pub carrier: Carrier,
    pub agent: AgentKind,
    /// 环境 + 目录 + 窗格/工作区（界面直接显示）。
    #[serde(rename = "where")]
    pub where_: String,
    pub state: AiState,
    /// 所有支撑这张卡的证据（≥1；卡上每个结论都要能追到这里）。
    pub evidence: Vec<Evidence>,
    pub activity: Activity,
    /// 本应用会话 id（能一键切过去）。
    pub session_id: Option<String>,
    /// 状态被承载能力闸门降级过的话，这里记原值 —— 界面可写"有来源声称 X，但该承载看不到 Y"。
    pub downgraded_from: Option<AiState>,
    /// 最新证据距今多久（毫秒）。
    pub age_ms: u64,
}

impl AiInstance {
    /// 最新一条证据的时间。
    pub fn latest_at_ms(&self) -> u64 {
        self.evidence.iter().map(|e| e.at_ms).max().unwrap_or(0)
    }

    /// 有没有第一手证据（而非全靠推断）。
    pub fn has_first_hand(&self) -> bool {
        self.evidence.iter().any(|e| e.confidence == Confidence::FirstHand)
    }

    /// 徽标文字：写清"谁说的、多久前、能证明什么"（§3.3 的悬停要求）。
    pub fn badge(&self) -> String {
        let src = self
            .evidence
            .iter()
            .max_by_key(|e| (e.confidence == Confidence::FirstHand, e.source.rank()))
            .map(|e| e.source)
            .unwrap_or(EvidenceSource::LocalProcessTable);
        let age = human_age(self.age_ms);
        let mut s = format!("{} · {}", src.label(), age);
        if !self.has_first_hand() {
            s.push_str("，只能说明它在跑");
        }
        if self.state == AiState::Unknown && self.downgraded_from == Some(AiState::Working) {
            s.push_str("；超过 10 分钟没有新证据，可能已卡住");
        }
        s
    }

    /// **要不要上看板**：空承载（CMD 之类没有 agent 的）不上板（§10.5）。
    pub fn on_board(&self) -> bool {
        self.carrier != Carrier::LocalCmd && self.agent != AgentKind::Unknown
    }

    /// 要不要占「最近完成」顶部（`finished` 只留 30 分钟，§3.5-1）。
    pub fn in_recent_finished(&self) -> bool {
        self.state == AiState::Finished && self.age_ms <= RECENT_FINISHED_MS
    }
}

fn human_age(ms: u64) -> String {
    let s = ms / 1000;
    if s < 60 {
        format!("{s} 秒前")
    } else if s < 3600 {
        format!("{} 分钟前", s / 60)
    } else {
        format!("{} 小时前", s / 3600)
    }
}

/// 卡片上"最后一句 / 最后一个动作"最多留这么多**字符**（不是字节）。
///
/// 240 字足够覆盖"一句话结论 + 它刚跑的那条命令"；再长就会把卡片撑成一整屏。
pub const ACTIVITY_MAX_CHARS: usize = 240;

/// 把一段文本截到最多 `max` 个字符（超了用 `…` 结尾）。
///
/// 为什么按**字符**切而不是按字节切：中文一句话几百字很常见，按字节切会劈出半个
/// UTF-8 序列（Rust 的 `String` 根本存不了；前端也会显示成 `�`）。截断只影响卡片上
/// 那句"最后动作"，不参与任何状态判定 —— 所以宁可少显示几个字，也不能改结论。
pub fn clip_chars(s: &str, max: usize) -> String {
    let s = s.trim();
    if max == 0 {
        return String::new();
    }
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// 承载能力闸门：**推断绝不说成事实**（§3.3 / §10.4 / §10.5）。
///
/// 返回（允许对外表达的状态, 被降级时的原值）。
fn sanitize_state(carrier: Carrier, state: AiState) -> (AiState, Option<AiState>) {
    // CMD：什么都扫不到 → 永远只说"不知道"（而且它本来就不上板）。
    if carrier == Carrier::LocalCmd {
        return (AiState::Unknown, (state != AiState::Unknown).then_some(state));
    }
    if state == AiState::NeedsYou && !carrier.allows_needs_you() {
        // 裸 SSH / tmux / 本地：看到"输出停了"不等于"它在等你"。
        // 降级成 working 而不是 unknown：至少知道有东西在跑；原值记在 downgraded_from 里。
        return (AiState::Working, Some(state));
    }
    if state == AiState::Finished && !carrier.allows_finished() {
        return (AiState::Unknown, Some(state));
    }
    (state, None)
}

/// 合并观测 → 卡片列表。
///
/// `now_ms` 传进来是为了"陈旧判定"可测（生产里传当前时间）。
pub fn merge(observations: Vec<Observation>, now_ms: u64) -> Vec<AiInstance> {
    struct Builder {
        carrier: Carrier,
        agent: AgentKind,
        env: String,
        cwd: Option<String>,
        anchor: Option<Anchor>,
        session_id: Option<String>,
        evidence: Vec<Evidence>,
        /// 每条证据各自声称的状态（挑最高可信度那条当结论）。
        claims: Vec<(EvidenceSource, AiState)>,
        activity: Activity,
    }

    impl Builder {
        /// 认领条件：环境 + agent + 目录都一样；**目录两边都必须知道** ——
        /// 一边不知道就不算"同一个"（宁可多一张卡，也不许把两个实例合成一个）。
        fn matches_identity(&self, ob: &Observation) -> bool {
            self.env == ob.env
                && self.agent == ob.agent
                && match (&self.cwd, &ob.cwd) {
                    (Some(a), Some(b)) => a == b,
                    _ => false,
                }
        }

        fn best_claim(&self) -> AiState {
            // 先比置信度，再比来源内部优先级，最后比时间（新的赢）。
            let mut best: Option<(&Evidence, AiState)> = None;
            for ev in &self.evidence {
                let state = self
                    .claims
                    .iter()
                    .find(|(s, _)| *s == ev.source)
                    .map(|(_, st)| *st)
                    .unwrap_or(AiState::Unknown);
                let better = match best {
                    None => true,
                    Some((cur, _)) => {
                        let key = |e: &Evidence| (e.confidence == Confidence::FirstHand, e.source.rank(), e.at_ms);
                        key(ev) > key(cur)
                    }
                };
                if better {
                    best = Some((ev, state));
                }
            }
            best.map(|(_, st)| st).unwrap_or(AiState::Unknown)
        }

        fn into_instance(self, now_ms: u64) -> AiInstance {
            let claimed = self.best_claim();
            let (state, downgraded_from) = sanitize_state(self.carrier, claimed);
            let latest = self.evidence.iter().map(|e| e.at_ms).max().unwrap_or(0);
            let mut state = state;
            let mut downgraded_from = downgraded_from;
            // 陈旧：working 超过 10 分钟没有新证据 → unknown（§3.5-3）。
            if state == AiState::Working && now_ms.saturating_sub(latest) > STALE_AFTER_MS {
                downgraded_from = downgraded_from.or(Some(AiState::Working));
                state = AiState::Unknown;
            }
            let anchor_key = self.anchor.as_ref().map(|a| a.as_key()).unwrap_or_else(|| "log".to_string());
            let mut where_parts = vec![self.env.clone()];
            if let Some(c) = &self.cwd {
                where_parts.push(c.clone());
            }
            if let Some(a) = &self.anchor {
                where_parts.push(a.as_key());
            }
            AiInstance {
                id: format!("{}:{}", carrier_key(self.carrier), format!("{}:{}", where_parts.join("/"), anchor_key)),
                carrier: self.carrier,
                agent: self.agent,
                where_: where_parts.join(" · "),
                state,
                evidence: self.evidence,
                activity: self.activity,
                session_id: self.session_id,
                downgraded_from,
                age_ms: now_ms.saturating_sub(latest),
            }
        }
    }

    fn carrier_key(c: Carrier) -> &'static str {
        match c {
            Carrier::Herdr => "herdr",
            Carrier::Tmux => "tmux",
            Carrier::SshBare => "ssh",
            Carrier::LocalPowershell => "local",
            Carrier::Wsl => "wsl",
            Carrier::LocalCmd => "cmd",
        }
    }

    let mut builders: Vec<Builder> = Vec::new();

    // 第一趟：有锚的观测各自起一个实体（同锚同承载同环境 → 同一个实体）。
    let mut orphans: Vec<Observation> = Vec::new();
    for ob in observations {
        let Some(anchor) = ob.anchor.clone() else {
            orphans.push(ob);
            continue;
        };
        let found = builders.iter_mut().find(|b| {
            b.carrier == ob.carrier && b.env == ob.env && b.anchor.as_ref() == Some(&anchor)
        });
        match found {
            Some(b) => {
                b.evidence.push(ob.evidence());
                b.claims.push((ob.source, ob.state));
                b.activity.absorb(&ob.activity);
                if b.session_id.is_none() {
                    b.session_id = ob.session_id.clone();
                }
            }
            None => builders.push(Builder {
                carrier: ob.carrier,
                agent: ob.agent.clone(),
                env: ob.env.clone(),
                cwd: ob.cwd.clone(),
                anchor: Some(anchor),
                session_id: ob.session_id.clone(),
                evidence: vec![ob.evidence()],
                claims: vec![(ob.source, ob.state)],
                activity: ob.activity.clone(),
            }),
        }
    }

    // 第二趟：没锚的观测（rollout 之类）——**只在候选唯一时**认领一个实体。
    // 候选不唯一（两个 codex 在同一个目录）就单独成卡：宁可多一张，也不许把两个实例合成一个。
    for ob in orphans {
        let candidates: Vec<usize> = builders
            .iter()
            .enumerate()
            // 认领条件 = 环境 + agent + 目录都一样（`identity_matches`），
            // 且**目录必须两边都知道** —— 一边不知道就不算"同一个"（宁可多一张卡）。
            .filter(|(_, b)| b.matches_identity(&ob))
            .map(|(i, _)| i)
            .collect();
        if candidates.len() == 1 {
            let b = &mut builders[candidates[0]];
            b.evidence.push(ob.evidence());
            b.claims.push((ob.source, ob.state));
            b.activity.absorb(&ob.activity);
            if b.session_id.is_none() {
                b.session_id = ob.session_id.clone();
            }
        } else {
            builders.push(Builder {
                carrier: ob.carrier,
                agent: ob.agent.clone(),
                env: ob.env.clone(),
                cwd: ob.cwd.clone(),
                anchor: None,
                session_id: ob.session_id.clone(),
                evidence: vec![ob.evidence()],
                claims: vec![(ob.source, ob.state)],
                activity: ob.activity.clone(),
            });
        }
    }

    // 承载去重：同一台机器的同一件事，herdr 实体比裸 SSH 进程实体更具体。
    // （观测里如果既有 herdr 窗格、又有该服务器上"说不出窗格"的进程，
    //   `ssh_proc` 是带 pid 锚的，会各自成卡 —— 这一层负责把它们并起来。）
    let mut merged: Vec<Builder> = Vec::new();
    builders.sort_by(|a, b| b.carrier.specificity().cmp(&a.carrier.specificity()));
    for b in builders {
        let host_of = |x: &Builder| x.env.clone();
        let dup = merged.iter_mut().find(|m| {
            host_of(m) == host_of(&b)
                && m.agent == b.agent
                && m.cwd == b.cwd
                && m.carrier.specificity() > b.carrier.specificity()
                && (m.carrier == Carrier::Herdr && b.carrier != Carrier::Herdr)
        });
        match dup {
            Some(m) => {
                for ev in b.evidence {
                    if !m.evidence.contains(&ev) {
                        m.evidence.push(ev);
                    }
                }
                m.claims.extend(b.claims);
                m.activity.absorb(&b.activity);
                if m.session_id.is_none() {
                    m.session_id = b.session_id;
                }
            }
            None => merged.push(b),
        }
    }

    let mut out: Vec<AiInstance> = merged
        .into_iter()
        .map(|b| b.into_instance(now_ms))
        .filter(|i| i.on_board())
        .collect();
    out.sort_by(|a, b| {
        a.state
            .panel_rank()
            .cmp(&b.state.panel_rank())
            .then_with(|| a.agent_key().cmp(&b.agent_key()))
            .then_with(|| a.id.cmp(&b.id))
    });
    out
}

impl AiInstance {
    fn agent_key(&self) -> String {
        match &self.agent {
            AgentKind::Codex => "codex".into(),
            AgentKind::Claude => "claude".into(),
            AgentKind::Gemini => "gemini".into(),
            AgentKind::Aider => "aider".into(),
            AgentKind::Other(n) => n.to_ascii_lowercase(),
            AgentKind::Unknown => "zzz".into(),
        }
    }
}

// ============================================================================
// 适配器：把五套**真实**来源映射成观测（`Observation`）
// ============================================================================
//
// 只做映射，不做判断：**拿不到的字段就留空**，绝不用别的字段去凑。
// 例如进程扫描拿不到"它最后说了什么"，那 `last_line` 就只能是命令行本身，
// 不能在这里编一句"正在改代码"。

use super::ai_sessions::AiSessionSnapshot;
use super::ai_tasks::{AiTask, AppTask};
use super::herdr::HerdrAgent;

/// 工具名 → agent。
///
/// 认识但不在枚举里的名字用 `Other` **保留原名** —— 归成 `Unknown` 会让它
/// 直接掉出看板（`on_board()` 要求 agent != Unknown），那是丢信息，不是保守。
pub fn agent_of_tool(tool: &str) -> AgentKind {
    let k = AgentKind::from_process_name(tool);
    if k == AgentKind::Unknown && !tool.trim().is_empty() {
        AgentKind::Other(tool.trim().to_string())
    } else {
        k
    }
}

/// 扫描结果里的 `source` → 证据种类。
///
/// `AiTask.source` 的取值是现成的（`app` / `tmux` / `ps` / `winproc`），但映射
/// **必须结合 `env`**：同样是 `ps`，在 WSL 里是 `WslPs`，在远端才是 `RemoteTmuxPs`。
fn evidence_of_task(task: &AiTask) -> EvidenceSource {
    match task.source.as_str() {
        "app" => EvidenceSource::AppLedger,
        "winproc" => EvidenceSource::LocalProcessTable,
        _ => match task.env.as_str() {
            "local" => EvidenceSource::LocalProcessTable,
            "wsl" => EvidenceSource::WslPs,
            _ => EvidenceSource::RemoteTmuxPs,
        },
    }
}

/// `AiTask` 的承载。
///
/// ⚠️ **已知拿不到的字段**：本机扫描只按进程名过滤，看不出这个进程是 CMD 还是
/// PowerShell 起的 —— 所以本机一律按 `LocalPowershell` 处理（`LocalCmd` 只能由
/// 前端在"它明确知道"时使用）。这影响徽标文案，不影响状态闸门：两者都不允许
/// `needs-you`，也都不能给裸 SSH / CMD 下"已完成"的结论。
pub fn carrier_of_task(task: &AiTask) -> Carrier {
    match task.env.as_str() {
        "local" => Carrier::LocalPowershell,
        "wsl" => Carrier::Wsl,
        _ if task.pane.trim().is_empty() => Carrier::SshBare,
        _ => Carrier::Tmux,
    }
}

/// 扫描结果里的 `state`（只有 `running` / `done` 两档）→ 统一状态。
pub fn state_of_task(task: &AiTask) -> AiState {
    match task.state.as_str() {
        "running" => AiState::Working,
        "done" => AiState::Finished,
        _ => AiState::Unknown,
    }
}

fn activity_of_task(task: &AiTask) -> Activity {
    Activity {
        // 如实填命令行：这是进程扫描唯一能拿到的"它在干什么"。
        last_line: (!task.command.trim().is_empty()).then(|| task.command.clone()),
        started_at_ms: task.started_at.map(|s| (s.max(0) as u64).saturating_mul(1000)),
        duration_ms: (task.duration_ms > 0).then_some(task.duration_ms as u64),
        tokens: None,
        artifacts: Vec::new(),
    }
}

fn anchor_of_task(task: &AiTask) -> Option<Anchor> {
    // 账本 id 比 pid 稳（pid 会被系统复用，跨轮询容易串卡）。
    if task.source == "app" && !task.id.trim().is_empty() {
        return Some(Anchor::LedgerId(task.id.clone()));
    }
    if !task.pane.trim().is_empty() {
        return Some(Anchor::TmuxTarget(task.pane.clone()));
    }
    (task.pid > 0).then_some(Anchor::Pid(task.pid))
}

/// 进程/窗格扫描（本机 / WSL / 远端 tmux / 裸 SSH）→ 观测。
pub fn observations_from_tasks(tasks: &[AiTask], now_ms: u64) -> Vec<Observation> {
    tasks
        .iter()
        .map(|t| {
            let carrier = carrier_of_task(t);
            let agent = agent_of_tool(&t.tool);
            let cwd = (!t.cwd.trim().is_empty()).then_some(t.cwd.as_str());
            let mut ob = match carrier {
                Carrier::Wsl => Observation::wsl_proc(agent, t.pid, cwd, now_ms),
                Carrier::Tmux => {
                    Observation::tmux(&t.server, agent, &t.pane, AiState::Working, cwd, now_ms)
                }
                Carrier::SshBare => Observation::ssh_proc(&t.server, agent, t.pid, cwd, now_ms),
                _ => Observation::local_proc(agent, t.pid, cwd, now_ms),
            };
            ob.anchor = anchor_of_task(t);
            ob.state = state_of_task(t);
            ob.source = evidence_of_task(t);
            ob.at_ms = now_ms;
            ob.activity = activity_of_task(t);
            ob
        })
        .collect()
}

/// herdr 的原始状态词 → 统一状态。
///
/// ⚠️ **不能用 `herdr::board_state()`**：它把 `idle` 和 `done` 都压成 `"done"` ——
/// 那是老看板"两档"的遗留口径；统一模型里 `idle`（空闲）与 `finished`（跑完了）
/// 是两件事（§3.1 的五个状态词）。
pub fn state_of_herdr(status: &str) -> AiState {
    match status.trim().to_ascii_lowercase().as_str() {
        "working" => AiState::Working,
        "blocked" => AiState::NeedsYou,
        "done" => AiState::Finished,
        "idle" => AiState::Idle,
        _ => AiState::Unknown,
    }
}

/// herdr `agent list` → 观测。**这是唯一能给 `needs-you` 的来源**（第一手，§10.4）。
pub fn observations_from_herdr(env: &str, agents: &[HerdrAgent], now_ms: u64) -> Vec<Observation> {
    agents
        .iter()
        .map(|a| {
            let anchor = (!a.pane_id.trim().is_empty()).then(|| Anchor::HerdrPane(a.pane_id.clone()));
            let cwd = (!a.cwd.trim().is_empty()).then_some(a.cwd.as_str());
            let mut ob = Observation::herdr(
                env,
                agent_of_tool(&a.kind),
                &a.pane_id,
                state_of_herdr(&a.status),
                cwd,
                now_ms,
            );
            // 窗格标题只有在"它确实是一句人话、且不是目录本身"时才当最后动作，
            // 否则卡片上会出现"最后动作 = /srv/app"这种废话。
            ob.anchor = anchor;
            ob.activity.last_line =
                (!a.title.trim().is_empty() && a.title.trim() != a.cwd.trim()).then(|| a.title.clone());
            ob
        })
        .collect()
}

/// 本应用账本（"这是我们自己启动的"）→ 观测。
///
/// 账本自己只知道 env + server + tool，**不知道它跑在哪个窗格**。前端知道
/// （它就是从这个会话里启动的），所以 `carrier` / `cwd` / `session_id` 由调用方补：
/// 补上 `cwd` 之后，它才能和同目录的 herdr 第一手观测合成**一张**卡（见 `merge` 的去重）。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerGroup {
    pub env: String,
    #[serde(default)]
    pub carrier: Option<Carrier>,
    /// herdr 窗格 id（形如 `w1:p1`）—— 前端知道就带上：带上之后它和该窗格的第一手观测
    /// **锚相同**，第一趟合并就会并成一张卡（不需要模型层"按目录猜"那种危险规则）。
    #[serde(default)]
    pub herdr_pane: Option<String>,
    /// tmux 目标（形如 `work:0.1`），同上。
    #[serde(default)]
    pub tmux_target: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub items: Vec<AppTask>,
}

pub fn observations_from_ledger(group: &LedgerGroup, now_ms: u64) -> Vec<Observation> {
    group
        .items
        .iter()
        .map(|it| {
            let state = if it.running { AiState::Working } else { AiState::Finished };
            // 账本的时间戳精确到秒；`last_running_at` 比 `started_at` 更接近"最后一次看到它"。
            // 夹一下上界：时钟回拨/未来时间戳不该让一张卡比"现在"还新。
            let at_ms = ((it.last_running_at.max(0) as u64).saturating_mul(1000)).min(now_ms);
            let mut ob = Observation::app_ledger(
                &group.env,
                agent_of_tool(&it.tool),
                &it.id,
                state,
                at_ms,
                group.session_id.as_deref(),
            );
            if let Some(c) = group.carrier {
                ob.carrier = c;
            }
            // 前端知道窗格 → 用窗格锚（比账本 id 更能和第一手观测对齐）；
            // 不知道就保留 `LedgerId` 兜底。
            let anchor = group
                .herdr_pane
                .as_ref()
                .map(|p| Anchor::HerdrPane(p.clone()))
                .or_else(|| group.tmux_target.as_ref().map(|t| Anchor::TmuxTarget(t.clone())));
            if let Some(a) = anchor {
                ob.anchor = Some(a);
            }
            ob.cwd = group.cwd.clone();
            ob.activity = Activity {
                last_line: (!it.command.trim().is_empty()).then(|| it.command.clone()),
                started_at_ms: Some((it.started_at.max(0) as u64).saturating_mul(1000)),
                duration_ms: (!it.running && it.last_running_at > it.started_at)
                    .then(|| (it.last_running_at - it.started_at).max(0) as u64 * 1000),
                tokens: None,
                artifacts: Vec::new(),
            };
            ob
        })
        .collect()
}

/// rollout 快照（codex 会话日志）→ 观测。
///
/// ⚠️ 两个已知限制，别在这里"补"：① 目前只有 **codex** 写 rollout，所以 agent 只能填
/// `Codex`；② rollout 里**没有窗格/pid**，所以没有锚 —— 只能靠"环境 + agent + 目录"
/// 去认领一个已有实例，认不到就单独成卡（界面会标成"仅日志"）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RolloutGroup {
    pub env: String,
    pub snapshot: AiSessionSnapshot,
    /// 调用方已知的承载（例如这个会话其实跑在 herdr 窗格里）—— 不知道就留空。
    #[serde(default)]
    pub carrier: Option<Carrier>,
    #[serde(default)]
    pub artifacts: Vec<String>,
}

/// rollout 里的状态词（`running` / `idle` / `needs-approval` / `waiting-user`）→ 统一状态。
pub fn state_of_rollout(state: &str) -> AiState {
    match state.trim().to_ascii_lowercase().as_str() {
        "running" => AiState::Working,
        "needs-approval" | "waiting-user" => AiState::NeedsYou,
        "idle" => AiState::Idle,
        _ => AiState::Unknown,
    }
}

pub fn observation_from_rollout(group: &RolloutGroup, now_ms: u64) -> Observation {
    let s = &group.snapshot;
    let cwd = (!s.cwd.trim().is_empty()).then_some(s.cwd.as_str());
    let mut activity = Activity::default();
    if !s.last_message.trim().is_empty() {
        activity.last_line = Some(s.last_message.clone());
    } else if !s.last_action.trim().is_empty() {
        activity.last_line = Some(s.last_action.clone());
    }
    activity.duration_ms = (s.last_turn_duration_ms > 0).then_some(s.last_turn_duration_ms as u64);
    activity.tokens = s.usage.as_ref().map(|u| u.total).filter(|t| *t > 0);
    activity.artifacts = group.artifacts.clone();
    if s.last_turn_completed_at > 0 {
        let done_ms = (s.last_turn_completed_at.max(0) as u64).saturating_mul(1000);
        activity.started_at_ms = Some(done_ms.saturating_sub(activity.duration_ms.unwrap_or(0)));
    }
    let mut ob = Observation::rollout(
        &group.env,
        AgentKind::Codex,
        cwd,
        state_of_rollout(&s.state),
        now_ms,
        activity,
    );
    if let Some(c) = group.carrier {
        ob.carrier = c;
    }
    if !s.session_id.trim().is_empty() {
        ob.session_id = Some(s.session_id.clone());
    }
    ob
}

/// 一台机器/本机的一组 herdr agent。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HerdrGroup {
    pub env: String,
    #[serde(default)]
    pub agents: Vec<HerdrAgent>,
}

/// 一次轮询里前端采集到的**全部来源**。
///
/// 为什么让前端把数据送回来、由 Rust 合并：可信度闸门 / 陈旧降级 / "一个实例一张卡"
/// 这三条口径**只能有一份实现**（老看板在前端 JS 里合并，于是出现了两趟打补丁）。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardSources {
    #[serde(default)]
    pub tasks: Vec<AiTask>,
    #[serde(default)]
    pub herdr: Vec<HerdrGroup>,
    #[serde(default)]
    pub ledger: Vec<LedgerGroup>,
    #[serde(default)]
    pub rollouts: Vec<RolloutGroup>,
}

/// 全部来源 → 看板卡片。
pub fn board_from_sources(src: BoardSources, now_ms: u64) -> Vec<AiInstance> {
    let mut obs = observations_from_tasks(&src.tasks, now_ms);
    for g in &src.herdr {
        obs.extend(observations_from_herdr(&g.env, &g.agents, now_ms));
    }
    for g in &src.ledger {
        obs.extend(observations_from_ledger(g, now_ms));
    }
    for g in &src.rollouts {
        obs.push(observation_from_rollout(g, now_ms));
    }
    merge(obs, now_ms)
}

#[cfg(test)]
mod tests {
    use super::*;

    const T: u64 = 1_800_000_000_000;

    fn codex() -> AgentKind {
        AgentKind::Codex
    }

    /// 1) herdr 窗格 + 同一台机器上的进程扫描 → **一张实例、证据 ≥2**，状态取第一手那条。
    #[test]
    fn herdr_pane_and_process_scan_become_one_instance_with_two_evidence() {
        let obs = vec![
            // herdr 说这个窗格在等你
            Observation::herdr("lz", codex(), "w1:p1", AiState::NeedsYou, Some("/srv/app"), T - 5_000),
            // 同一台机器、同一目录的进程扫描（说不出窗格）
            Observation::ssh_proc("lz", codex(), 4242, Some("/srv/app"), T - 50_000),
        ];
        let list = merge(obs, T);
        assert_eq!(list.len(), 1, "同一件事必须只有一张卡");
        let inst = &list[0];
        assert_eq!(inst.state, AiState::NeedsYou, "第一手说'在等你'，就该显示在等你");
        assert!(inst.has_first_hand());
        assert!(inst.evidence.len() >= 2, "两条来源都要留下痕迹：{:?}", inst.evidence);
        assert!(inst.badge().contains("herdr 第一手"), "徽标要写清谁说的：{}", inst.badge());
    }

    /// 2) 两个本地 codex（不同目录）→ **两张实例**（历史上被错并成一张）。
    #[test]
    fn two_local_codex_in_different_dirs_stay_two_instances() {
        let obs = vec![
            Observation::local_proc(codex(), 1111, Some("C:/work/a"), T - 1_000),
            Observation::local_proc(codex(), 2222, Some("C:/work/b"), T - 1_000),
        ];
        let list = merge(obs, T);
        assert_eq!(list.len(), 2, "两个实例不能被合成一张");
        assert_ne!(list[0].id, list[1].id);
    }

    /// 3) 裸 SSH **永不出现 needs-you**（哪怕某个来源声称在等）。
    #[test]
    fn bare_ssh_never_reports_needs_you() {
        let mut ob = Observation::ssh_proc("lz", codex(), 7, Some("/srv/x"), T);
        ob.state = AiState::NeedsYou; // 模拟"有来源乱说"
        let list = merge(vec![ob], T);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].state, AiState::Working, "只能降级成'在跑'");
        assert_eq!(list[0].downgraded_from, Some(AiState::NeedsYou), "原值要留痕");
    }

    /// 4) CMD 这种"什么都扫不到"的承载 → `unknown`，而且**不上板**（§10.5）。
    #[test]
    fn cmd_carrier_is_unknown_and_off_board() {
        let mut ob = Observation::local_proc(AgentKind::Unknown, 9, None, T);
        ob.carrier = Carrier::LocalCmd;
        ob.env = "本机".into();
        let inst_raw = AiInstance {
            id: "cmd:x".into(),
            carrier: Carrier::LocalCmd,
            agent: AgentKind::Unknown,
            where_: "本机".into(),
            state: AiState::Unknown,
            evidence: vec![Evidence::new(EvidenceSource::LocalProcessTable, T)],
            activity: Activity::default(),
            session_id: None,
            downgraded_from: None,
            age_ms: 0,
        };
        assert!(!inst_raw.on_board(), "空承载不上板");
        assert!(merge(vec![ob], T).is_empty(), "看板列表里不该有它");
    }

    /// 5) 陈旧：working 超过 10 分钟没有新证据 → unknown（不许一直显示"在跑"）。
    #[test]
    fn stale_working_downgrades_to_unknown() {
        let ob = Observation::local_proc(codex(), 555, Some("C:/work/c"), T - STALE_AFTER_MS - 1);
        let list = merge(vec![ob], T);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].state, AiState::Unknown);
        assert!(list[0].badge().contains("可能已卡住"), "要说清为什么：{}", list[0].badge());
    }

    /// 6) 第一手优先：herdr 说 finished、进程扫描说 working → 取 finished。
    #[test]
    fn first_hand_wins_over_inferred() {
        let obs = vec![
            Observation::herdr("lz", codex(), "w2:p1", AiState::Finished, Some("/srv/y"), T - 2_000),
            Observation::ssh_proc("lz", codex(), 88, Some("/srv/y"), T - 1_000),
        ];
        let list = merge(obs, T);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].state, AiState::Finished, "进程扫描不能说'还没跑完'推翻第一手");
        assert!(list[0].in_recent_finished());
    }

    /// 7) 没有锚的观测：候选唯一时认领，候选不唯一时**单独成卡**（宁可多一张）。
    #[test]
    fn orphan_observation_merges_only_when_unique() {
        let activity = Activity { last_line: Some("改完了 3 个文件".into()), ..Default::default() };
        // 唯一候选 → 并进去
        let unique = merge(
            vec![
                Observation::local_proc(codex(), 10, Some("C:/only"), T - 1_000),
                Observation::rollout("本机", codex(), Some("C:/only"), AiState::Working, T - 500, activity.clone()),
            ],
            T,
        );
        assert_eq!(unique.len(), 1);
        assert_eq!(unique[0].evidence.len(), 2);
        assert_eq!(unique[0].activity.last_line.as_deref(), Some("改完了 3 个文件"));

        // 同目录两个实例 → 认不出来，单独成卡
        let ambiguous = merge(
            vec![
                Observation::local_proc(codex(), 11, Some("C:/same"), T - 1_000),
                Observation::local_proc(codex(), 12, Some("C:/same"), T - 1_000),
                Observation::rollout("本机", codex(), Some("C:/same"), AiState::Working, T - 500, activity),
            ],
            T,
        );
        assert_eq!(ambiguous.len(), 3, "认不出来就不要硬认");
    }

    /// 8) 没跑 agent 的承载 / 未知 agent 不上板，但实例本身仍然存在（可在承载健康里查到）。
    #[test]
    fn instances_without_agent_are_off_board() {
        let ob = Observation::local_proc(AgentKind::Unknown, 13, Some("C:/x"), T);
        assert!(merge(vec![ob], T).is_empty());
    }

    /// 9) 进程名 → agent 只做明确匹配，猜不出就是 Unknown。
    #[test]
    fn process_name_mapping_is_conservative() {
        assert_eq!(AgentKind::from_process_name("codex.exe"), AgentKind::Codex);
        assert_eq!(AgentKind::from_process_name("C:\\x\\claude"), AgentKind::Claude);
        assert_eq!(AgentKind::from_process_name("bash"), AgentKind::Unknown);
        assert_eq!(AgentKind::from_process_name("node"), AgentKind::Unknown);
    }

    // ---------- 适配器：把真实来源映射成观测（10–16） ----------

    use super::super::ai_sessions::AiUsage;

    fn task(env: &str, server: &str, tool: &str, cwd: &str, pane: &str, source: &str, pid: u32) -> AiTask {
        AiTask {
            id: format!("{env}:{server}:{tool}:{pid}"),
            env: env.into(),
            server: server.into(),
            tool: tool.into(),
            command: format!("{tool} --full-auto"),
            cwd: cwd.into(),
            pane: pane.into(),
            source: source.into(),
            state: "running".into(),
            duration_ms: 12_000,
            pid,
            started_at: None,
            exit_code: None,
        }
    }

    /// 10) herdr 第一手：状态词逐个映射（`idle` 与 `done` **不许**合成一档），pane 进锚。
    #[test]
    fn herdr_adapter_maps_states_and_keeps_pane_anchor() {
        assert_eq!(state_of_herdr("working"), AiState::Working);
        assert_eq!(state_of_herdr("blocked"), AiState::NeedsYou);
        assert_eq!(state_of_herdr("done"), AiState::Finished);
        assert_eq!(state_of_herdr("idle"), AiState::Idle);
        // ⚠️ 老看板的 `herdr::board_state()` 把 idle 和 done 压成同一档；
        // 统一模型里"空闲"与"跑完了"是两件事，这条断言防止有人"顺手"用回老函数。
        assert_ne!(state_of_herdr("idle"), state_of_herdr("done"));
        assert_eq!(state_of_herdr("什么鬼"), AiState::Unknown);

        let agents = vec![
            HerdrAgent {
                kind: "codex".into(),
                status: "blocked".into(),
                pane_id: "w1:p1".into(),
                cwd: "/srv/app".into(),
                title: "改登录".into(),
                ..Default::default()
            },
            HerdrAgent {
                kind: "claude".into(),
                status: "idle".into(),
                pane_id: "w1:p2".into(),
                cwd: "/srv/app".into(),
                ..Default::default()
            },
        ];
        let obs = observations_from_herdr("lz", &agents, T);
        assert_eq!(obs.len(), 2);
        assert_eq!(obs[0].carrier, Carrier::Herdr);
        assert_eq!(obs[0].source, EvidenceSource::HerdrAgentList);
        assert_eq!(obs[0].anchor, Some(Anchor::HerdrPane("w1:p1".into())));
        assert_eq!(obs[0].state, AiState::NeedsYou);
        assert_eq!(obs[0].activity.last_line.as_deref(), Some("改登录"));
        // 标题为空时不许把 cwd 当"最后动作"（那是废话）。
        assert_eq!(obs[1].activity.last_line, None);

        let list = merge(obs, T);
        assert_eq!(list.len(), 2, "两个窗格 = 两张卡");
        assert!(list[0].has_first_hand());
        assert_eq!(list[0].state, AiState::NeedsYou, "只有 herdr 能给 needs-you");
    }

    /// 11) tmux / 裸 SSH / 本机的扫描：承载与证据种类对得上，且**永远不给 needs-you**。
    #[test]
    fn task_adapter_is_inferred_and_bare_ssh_never_needs_you() {
        let tasks = vec![
            task("remote", "lz", "codex", "/srv/app", "work:0.1", "tmux", 100),
            task("remote", "other", "codex", "/srv/api", "", "ps", 200),
            task("local", "本机 PowerShell", "claude", "C:/work", "", "winproc", 300),
        ];
        let obs = observations_from_tasks(&tasks, T);
        assert_eq!(obs[0].carrier, Carrier::Tmux);
        assert_eq!(obs[0].source, EvidenceSource::RemoteTmuxPs);
        assert_eq!(obs[0].anchor, Some(Anchor::TmuxTarget("work:0.1".into())));
        assert_eq!(obs[1].carrier, Carrier::SshBare);
        assert_eq!(obs[2].carrier, Carrier::LocalPowershell);
        assert_eq!(obs[2].source, EvidenceSource::LocalProcessTable);
        assert_eq!(obs[2].anchor, Some(Anchor::Pid(300)));
        // 进程扫描拿不到"最后说了什么" → 如实填命令行，不编人话。
        assert_eq!(obs[1].activity.last_line.as_deref(), Some("codex --full-auto"));

        // 就算有来源声称"在等你"，非 herdr 承载也只能降级成"在跑"。
        let mut lying = obs[1].clone();
        lying.state = AiState::NeedsYou;
        let list = merge(vec![lying], T);
        assert_eq!(list[0].state, AiState::Working);
        assert_eq!(list[0].downgraded_from, Some(AiState::NeedsYou));
        // 裸 SSH 也不能说"已完成"。
        let mut done = obs[1].clone();
        done.state = AiState::Finished;
        assert_eq!(merge(vec![done], T)[0].state, AiState::Unknown);
    }

    /// 12) 两个本地 codex（不同目录）→ 两张卡（走适配器这条路也不能被并）。
    #[test]
    fn two_local_tasks_in_different_dirs_stay_two_instances() {
        let tasks = vec![
            task("local", "本机 PowerShell", "codex", "C:/work/a", "", "winproc", 11),
            task("local", "本机 PowerShell", "codex", "C:/work/b", "", "winproc", 22),
        ];
        let src = BoardSources { tasks, ..Default::default() };
        assert_eq!(board_from_sources(src, T).len(), 2);
    }

    /// 13) rollout 没有锚：候选唯一时认领，并把"最后一句 / token / 产物 / 会话 id"带上来。
    #[test]
    fn rollout_claims_unique_candidate_and_carries_activity() {
        let snap = AiSessionSnapshot {
            session_id: "sess-1".into(),
            cwd: "C:/only".into(),
            last_message: "改完了 3 个文件".into(),
            last_turn_duration_ms: 4_200,
            state: "running".into(),
            usage: Some(AiUsage { total: 12_345, ..Default::default() }),
            ..Default::default()
        };
        let src = BoardSources {
            tasks: vec![task("local", "本机 PowerShell", "codex", "C:/only", "", "winproc", 33)],
            rollouts: vec![RolloutGroup {
                env: "本机".into(),
                snapshot: snap,
                carrier: None,
                artifacts: vec!["report.md".into()],
            }],
            ..Default::default()
        };
        let list = board_from_sources(src, T);
        assert_eq!(list.len(), 1, "唯一候选必须认领，不许冒第二张卡：{list:?}");
        assert_eq!(list[0].evidence.len(), 2);
        assert_eq!(list[0].activity.last_line.as_deref(), Some("改完了 3 个文件"));
        assert_eq!(list[0].activity.tokens, Some(12_345));
        assert_eq!(list[0].activity.artifacts, vec!["report.md".to_string()]);
        assert_eq!(list[0].session_id.as_deref(), Some("sess-1"), "要能一键切过去");

        // 同目录两个实例：认不出来就别硬认（宁可多一张）。
        let src = BoardSources {
            tasks: vec![
                task("local", "本机 PowerShell", "codex", "C:/same", "", "winproc", 44),
                task("local", "本机 PowerShell", "codex", "C:/same", "", "winproc", 55),
            ],
            rollouts: vec![RolloutGroup {
                env: "本机".into(),
                snapshot: AiSessionSnapshot { cwd: "C:/same".into(), state: "running".into(), ..Default::default() },
                carrier: None,
                artifacts: Vec::new(),
            }],
            ..Default::default()
        };
        assert_eq!(board_from_sources(src, T).len(), 3, "认不出来就不要硬认");
    }

    /// 14) 账本（我们自己启动的）与 herdr 第一手**同锚** → 合成一张卡、证据 ≥2。
    #[test]
    fn ledger_merges_into_herdr_card_when_anchor_is_known() {
        let src = BoardSources {
            herdr: vec![HerdrGroup {
                env: "lz".into(),
                agents: vec![HerdrAgent {
                    kind: "codex".into(),
                    status: "working".into(),
                    pane_id: "w1:p1".into(),
                    cwd: "/srv/app".into(),
                    ..Default::default()
                }],
            }],
            ledger: vec![LedgerGroup {
                env: "lz".into(),
                carrier: Some(Carrier::Herdr),
                herdr_pane: Some("w1:p1".into()),
                tmux_target: None,
                cwd: Some("/srv/app".into()),
                session_id: Some("tab-7".into()),
                items: vec![AppTask {
                    id: "app:remote:lz:codex:100".into(),
                    env: "remote".into(),
                    server: "lz".into(),
                    tool: "codex".into(),
                    command: "codex --full-auto".into(),
                    started_at: 1_800_000_000,
                    last_running_at: 1_800_000_010,
                    running: true,
                }],
            }],
            ..Default::default()
        };
        let list = board_from_sources(src, T);
        assert_eq!(list.len(), 1, "同一件事只能一张卡：{list:?}");
        assert!(list[0].evidence.len() >= 2, "两条证据都要留痕：{:?}", list[0].evidence);
        assert!(list[0].has_first_hand());
        assert_eq!(list[0].session_id.as_deref(), Some("tab-7"));
        assert_eq!(list[0].activity.last_line.as_deref(), Some("codex --full-auto"));
        assert_eq!(list[0].state, AiState::Working);
    }

    /// 15) 工具名映射：认识但不在枚举里 → `Other`（**不许**归成 Unknown 掉出看板）。
    #[test]
    fn unknown_tool_name_is_kept_as_other() {
        assert_eq!(agent_of_tool("codex"), AgentKind::Codex);
        assert_eq!(agent_of_tool("aider"), AgentKind::Aider);
        assert_eq!(agent_of_tool("myagent"), AgentKind::Other("myagent".into()));
        assert_eq!(agent_of_tool(""), AgentKind::Unknown);
        assert!(merge(vec![Observation::local_proc(agent_of_tool("myagent"), 1, Some("C:/x"), T)], T).len() == 1);
        assert!(merge(vec![Observation::local_proc(agent_of_tool(""), 2, Some("C:/y"), T)], T).is_empty());
    }

    /// 16) 陈旧判定走适配器这条路也要生效：账本里"11 分钟前最后一次看到它还在跑" → unknown。
    ///
    /// （进程扫描那条路不会陈旧：它的时间戳**就是这次扫描的时间** —— 前端只送新鲜数据；
    ///  真正会"放旧"的是账本/rollout 这种自带时间戳的来源。）
    #[test]
    fn stale_ledger_entry_downgrades_to_unknown() {
        let now_s = (T / 1000) as i64;
        let src = BoardSources {
            ledger: vec![LedgerGroup {
                env: "本机".into(),
                carrier: Some(Carrier::LocalPowershell),
                herdr_pane: None,
                tmux_target: None,
                cwd: Some("C:/stale".into()),
                session_id: None,
                items: vec![AppTask {
                    id: "app:local:本机:codex:1".into(),
                    env: "local".into(),
                    server: "本机".into(),
                    tool: "codex".into(),
                    command: "codex".into(),
                    started_at: now_s - 1_200,
                    last_running_at: now_s - (STALE_AFTER_MS as i64 / 1000) - 60,
                    running: true,
                }],
            }],
            ..Default::default()
        };
        let list = board_from_sources(src, T);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].state, AiState::Unknown, "不许一直显示'在跑'");
        assert!(list[0].badge().contains("可能已卡住"), "要说清为什么：{}", list[0].badge());
    }
}
