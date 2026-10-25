export type ConnType = "ssh" | "serial" | "adb" | "local";

export interface SshConfig {
  host: string;
  port: number;
  user: string;
  authKind: "password" | "key" | "agent";
  allowPassword?: boolean;
  keyPath?: string;
  /** 跳板机，写法同 `ssh -J`：user@host 或 user@host:port */
  jump?: string | null;
  tmuxEnabled: boolean;
  tmuxTemplate: string;
  /**
   * 这台服务器的新会话**默认用 herdr 打开**（和 tmuxEnabled 一个性质）。
   * 勾上之后，新建会话时 herdr 那个勾会**默认打勾**，不再每次问你。
   */
  herdrEnabled: boolean;
  startDir?: string;
}

export interface ConnectionProfile {
  id: string;
  type: ConnType;
  name: string;
  group: string;
  color?: string;
  /** 这台服务器 / 串口 / 本地终端用哪一套高亮规则集（空 = 用全局默认那套） */
  highlightSetId?: string | null;
  /** 这台服务器 / 串口 / 本地终端用哪套终端配色（空 = 用全局那套） */
  termScheme?: string | null;
  /** 配合 termScheme = "custom" 的自定义配色 JSON */
  termSchemeCustom?: string | null;
  ssh?: SshConfig;
  serial?: SerialConfig;
  local?: { shell: "powershell" | "cmd" | "wsl"; distro?: string; cwd?: string };
}

/** 串口连接参数：每个串口自己一套，不再是全局共用一个波特率 */
export interface SerialConfig {
  path: string;
  baudRate: number;
  /** 5 / 6 / 7 / 8 */
  dataBits?: number;
  /** 1 / 2 */
  stopBits?: number;
  parity?: "none" | "odd" | "even";
  flowControl?: "none" | "software" | "hardware";
}

export type SessionState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "closed"
  | "error";

export interface SessionInfo {
  id: string;
  profileId: string;
  title: string;
  kind: ConnType;
  tmuxSession?: string | null;
  /** SSH 会话实际使用的登录用户名（可能来自本次会话的临时覆盖） */
  user?: string | null;
  host?: string | null;
}

export type SessionEvent =
  // base64 编码的字节流。seq 只有 PTY 输出泵会带：前端写进 xterm 后要
  // 用 sessionOutputAck 回传，后端据此做「最多 2 批未确认」的背压。
  | { type: "data"; data: string; seq?: number }
  | { type: "state"; state: SessionState }
  | { type: "error"; message: string }
  | { type: "cwd"; path: string }
  | { type: "title"; title: string };

export interface OpenSession {
  info: SessionInfo;
  state: SessionState;
}

export interface TmuxSession {
  name: string;
  windows: number;
  attached: boolean;
}

/** tmux 会话里的一个窗口（「tmux 快捷操作」面板用来列出来点着切） */
export interface TmuxWindow {
  index: number;
  name: string;
  active: boolean;
  panes: number;
}

export interface RemoteEntry {
  name: string;
  isDir: boolean;
  size: number;
}

export interface RemoteListing {
  path: string;
  entries: RemoteEntry[];
}

export interface HistoryEntry {
  id: string;
  profileId: string;
  profileName: string;
  host: string;
  tmuxSession?: string | null;
  /** herdr 会话：要打开的窗格号（形如 w1:p1）；空 = 不是 herdr 会话 */
  herdrPane?: string | null;
  /** herdr 会话的打开方式：observe（只读）/ control（可写） */
  herdrMode?: "observe" | "control" | null;
  /** 用户给这个会话起的名字 */
  title?: string | null;
  lastUsed: number;
}

/**
 * 一套命名的高亮规则集（服务器 / 串口 / 本地终端各自绑定一套）。
 */
export interface HighlightRuleSet {
  id: string;
  name: string;
  rules: HighlightRule[];
}

/**
 * 终端关键字高亮的一条规则。
 *
 * 一条规则 = 一组关键词 + 一套颜色 + 作用范围（只给关键词上色 / 整行上色）。
 * SSH / 串口 / 本地终端共用同一份规则表。
 */
export interface HighlightRule {
  id: string;
  /** 规则名（只是标签，方便你在列表里认出来） */
  name: string;
  keywords: string[];
  /** true = 区分大小写 */
  caseSensitive: boolean;
  /** 前景色 #rrggbb；空串 = 不改前景 */
  fg: string;
  /** 背景色 #rrggbb；空串 = 不改背景 */
  bg: string;
  /** true = 命中后整行上色；false = 只给关键词本身 */
  wholeLine: boolean;
  /**
   * true = 关键词两侧必须是词边界。
   * 预设「OK」默认打开（不打开的话 look / TOKEN 里也会亮），界面上没暴露这个开关。
   */
  wholeWord?: boolean;
  enabled: boolean;
}

/** AI 任务看板上的一张卡片 */
export interface AiTask {
  id: string;
  /** 环境：local（本机）/ remote（服务器）/ wsl */
  env: string;
  /** 环境名：远端是服务器名，本地是「本机 PowerShell」这类 */
  server: string;
  /** 命中的工具：codex / claude / aider / gemini */
  tool: string;
  /** 命令行（长了会截断） */
  command: string;
  /** 进程的工作目录（卡片上显示"项目目录"用）；拿不到是空串 */
  cwd: string;
  /** tmux 窗格标签（形如 main:0.1）；不是 tmux 会话就是空串 */
  pane: string;
  /** 信号来源：app（App 自己启动的）/ tmux / ps / winproc */
  source: string;
  /** running / done */
  state: string;
  /** 已运行（运行中）或总共运行（已结束）的毫秒数 */
  durationMs: number;
  /** 进程号；探测不到是 0 */
  pid: number;
  /** 开始时间（Unix 秒）；只有 App 自己启动的那批是精确的 */
  startedAt?: number | null;
  /** 退出码；v1 拿不到就是 null */
  exitCode?: number | null;
  /**
   * herdr 给的窗格号（形如 w1:p1）；这张卡不是来自 herdr 就是空。
   * 有它就能开「观察窗」直接看这个窗格。
   */
  herdrPane?: string | null;
  /** 这张 herdr 卡片属于哪台服务器配置（开观察窗要用） */
  herdrProfileId?: string | null;
  /**
   * herdr 的原始状态：working / blocked / done / idle / unknown。
   * 有了它卡片能显示成「等你处理」——这是我们自己扫进程永远拿不到的那一档。
   */
  agentStatus?: string | null;
  /** 这一条是不是在"等人接手"（= herdr 说 blocked） */
  attention?: boolean;
  // ---------- 看板 v2 从统一模型带上来的字段（后端 `AiInstance`） ----------
  /** 后端拼好的来源徽标：谁说的 · 多久前 · 能证明什么 */
  badge?: string;
  /** 实例的"环境 · 目录 · 窗格"（后端 `where`） */
  where?: string;
  /** 承载（决定"能承诺什么状态"） */
  carrier?: AiCarrier;
  /** 支撑这张卡的证据条数 */
  evidenceCount?: number;
  /** 最后一句 / 最后一个动作（进程扫描拿不到就是空） */
  activityLastLine?: string | null;
  /** 这一轮的 token 数（只有 rollout 有） */
  activityTokens?: number | null;
}

// ============================================================================
// AI 看板 v2 的统一实体 —— 和后端 `core/ai_instance.rs` 一一对应
// （口径见 docs/design-ai-board-v2.md §10；字段名以 serde 的实际输出为准）
// ============================================================================

/** 这条实例跑在什么承载上（§3.3：界面按它决定"能承诺什么状态"） */
export type AiCarrier = "local-powershell" | "local-cmd" | "wsl" | "ssh-bare" | "tmux" | "herdr";

/**
 * 跑的是什么 agent。
 *
 * 后端是 Rust 枚举：单元变体序列化成字符串（`"codex"`），带数据的变体序列化成
 * 单键对象（`{ other: "myagent" }`）—— 所以这里必须两种都收，认不出来是 `"unknown"`。
 */
export type AiAgentKind = "codex" | "claude" | "gemini" | "aider" | { other: string } | "unknown";

/** 界面只用这五个词（§3.1） */
export type AiState = "needs-you" | "working" | "finished" | "idle" | "unknown";

/**
 * 这条结论是谁说的（悬停里要写清"怎么得出的"）。
 *
 * `terminal-activity` 是**前端独有**的一条：看板卡片按"该会话最近还有终端输出"
 * 推断出来的运行中（见 `boardActivity.ts`）。它只会以 `confidence: "inferred"`
 * 出现，后端不会产生它 —— 加进这个联合类型是为了让徽标/悬停能如实写出"这是推断"。
 */
export type AiEvidenceSource =
  | "herdr-agent-list"
  | "remote-tmux-ps"
  | "local-process-table"
  | "wsl-ps"
  | "app-ledger"
  | "rollout"
  | "terminal-activity";

export type AiConfidence = "first-hand" | "inferred";

export interface AiEvidence {
  source: AiEvidenceSource;
  atMs: number;
  confidence: AiConfidence;
}

/** 最后动作/产出：拿不到就留空，**不许编**（§3.1 取舍） */
export interface AiActivity {
  lastLine?: string | null;
  startedAtMs?: number | null;
  durationMs?: number | null;
  tokens?: number | null;
  artifacts: string[];
}

/**
 * 合并之后的一张卡（后端 `AiInstance`）。
 *
 * `badge` 是**后端算好的**（谁说的 / 多久前 / 能证明什么）—— 前端别自己再拼一份：
 * 口径只能有一份实现，这正是这轮重构要收掉的东西。
 */
export interface AiInstance {
  id: string;
  carrier: AiCarrier;
  agent: AiAgentKind;
  /** 环境 + 目录 + 窗格/工作区（界面直接显示） */
  where: string;
  state: AiState;
  evidence: AiEvidence[];
  activity: AiActivity;
  sessionId?: string | null;
  /** 被承载能力闸门降级过的话，这里记原值（界面可写"有来源声称 X"） */
  downgradedFrom?: AiState | null;
  /** 最新证据距今多久（毫秒） */
  ageMs: number;
  /** 后端拼好的徽标文案，直接显示 + 放进悬停 */
  badge: string;
}

/**
 * 本应用自己启动的 AI 任务（账本条目，`ai_tasks.rs::AppTask`）。
 *
 * **snake_case 是故意的**：这层是原样透传给后端的，不在这里做风格转换
 * （转一道就等于多一份映射，正是老看板"两趟打补丁"的起点）。
 */
export interface AiLedgerItem {
  id: string;
  env: string;
  server: string;
  tool: string;
  command: string;
  started_at: number;
  last_running_at: number;
  running: boolean;
}

/** 账本按"环境 + 承载"分组：前端知道它跑在哪个窗格就带上（能和第一手观测同锚合并） */
export interface AiLedgerGroup {
  env: string;
  carrier?: AiCarrier | null;
  herdrPane?: string | null;
  tmuxTarget?: string | null;
  cwd?: string | null;
  sessionId?: string | null;
  items: AiLedgerItem[];
}

/**
 * 红点信号：后端**自动来源**推来的一条"要亮 / 要清"。
 *
 * 现在有两条自动来源，走**同一个事件名** `zeeai://ai-log`、同一个 `applyAiLogSignal`
 * 入口（前端只能有一个地方写红点状态）：
 * - 本机 codex rollout 日志（`core/ai_log_watch.rs`，只读文件、不启动进程）；
 * - herdr 窗格的 agent 状态（`core/ai_herdr_dots.rs`，每台勾了 herdr 的服务器 60 秒查一次
 *   `herdr agent list`；`source === "herdr"`，key 形如 `herdr|<服务器>|<窗格>`）。
 *
 * 三个 kind：
 * - `needs-you`：等你批准/回话 → 亮到你处理为止（打开面板不清）；
 * - `resolved`：不再等你了 → 清掉同一个 `key` 的红点；
 * - `finished`：这一轮跑完并停下 → 当"未读"，点开面板即清。
 *
 * `key` 是后端算好的去重键（本机日志 `log|<文件>|<轮次>`；herdr `herdr|<服务器>|<窗格>`）；
 * 前端不要再拼别的键，否则 `resolved` 就对不上 `needs-you` 了。
 */
export interface AiLogSignal {
  kind: "needs-you" | "resolved" | "finished";
  agent: string;
  sessionId: string;
  cwd: string;
  turn: string;
  key: string;
  atMs: number;
  message: string;
  /**
   * 这条信号从哪来：`"herdr"` = herdr 红点轮询；缺省 / `"log"` = 本机 codex 日志。
   * 只影响提示文案（要不要带上服务器名），**不影响**红点判定。
   */
  source?: "log" | "herdr";
  /** herdr 信号带的服务器配置 id（本机日志信号没有） */
  server?: string;
  /** herdr 信号带的服务器显示名（提示里写"哪台机器"，省得前端再查 profiles） */
  serverName?: string;
  /**
   * 卡片级：这条信号对应的**实例标识**，跨轮不变（本机日志 = `local|codex|<cwd>`；
   * herdr 红点 = `herdr|<服务器>|<窗格>`，和它的 `key` 一样）。
   *
   * 为什么除了 `key` 还要它：`key` 是"这一轮"的去重键（`log|<文件>|<轮次>`），下一轮就变了；
   * 卡片是实例级，要按一个稳定的东西去找同一张卡。缺省（老 payload）就只走红点、不碰卡片。
   */
  instanceKey?: string;
  /** 卡片级：这条信号想让卡片显示成什么（措辞同 `AiState`；缺省就不更新卡片状态） */
  state?: AiState;
  /** 卡片级：最后一句 / 最后一个动作（后端已按字符截断；拿不到是空串） */
  activity?: string;
}

/** herdr 卡片快照里的一个窗格（后端 `core/ai_herdr_dots.rs::HerdrAgentSnapshot`） */
export interface HerdrAgentSnapshot {
  /** 窗格号（形如 `w1:p1`）—— 卡片锚点，也是红点 key 的第三段 */
  pane: string;
  /** 原始状态词：working / blocked / done / idle / unknown */
  status: string;
  /** agent 种类（codex / claude / …） */
  agent: string;
  cwd: string;
  /** 工作区号（形如 `w1`） */
  workspace: string;
  /** 标签页号（形如 `w1:t1`） */
  tab: string;
  title: string;
  focused: boolean;
  /** 在等你（= blocked） */
  attention: boolean;
  /** 统一模型的状态词（后端已经映射好，前端别再自己判一遍） */
  state: AiState;
  /** 最后动作（herdr 只有窗格标题；标题就是目录时后端留空） */
  activity: string;
}

/**
 * herdr 轮询每一轮推来的一份**全量**卡片快照（`zeeai://herdr-agents`）。
 *
 * 为什么和红点信号分开一个事件名：红点是"变了才发"的**边沿**，快照是每轮都发的
 * **状态**；混在一个事件里，前端分不清"该去重还是该整体覆盖"，迟早两套判定打架。
 * 它只是那次 `herdr agent list` 的副产品 —— 没有多一次 ssh。
 */
export interface HerdrAgentsSnapshot {
  source: "herdr";
  /** 服务器配置 id（卡片上的「查看窗格 / 接管」要靠它开观察窗） */
  server: string;
  /** 服务器显示名（卡片 `where` 的第一段） */
  serverName: string;
  atMs: number;
  /** 按窗格号排序（后端保证顺序稳定） */
  agents: HerdrAgentSnapshot[];
}

/** 一台机器/本机的一组 herdr agent */
export interface AiHerdrGroup {
  env: string;
  agents: HerdrAgent[];
}

/** rollout 快照（codex 会话日志）→ 观测；没有窗格锚，靠"环境 + agent + 目录"认领 */
export interface AiRolloutGroup {
  env: string;
  snapshot: AiSessionSnapshot;
  carrier?: AiCarrier | null;
  artifacts: string[];
}

/**
 * 一次轮询里前端采集到的**全部来源**（后端 `BoardSources`）。
 *
 * 为什么让前端送、后端合：**可信度闸门 / 陈旧降级 / "一个实例一张卡"** 这三条口径
 * 只能有一份实现（老看板在前端 JS 里合并，于是出现了两趟打补丁 + "两个 codex 只剩一张卡"）。
 */
export interface BoardSources {
  tasks: AiTask[];
  herdr: AiHerdrGroup[];
  ledger: AiLedgerGroup[];
  rollouts: AiRolloutGroup[];
}

/** herdr 认出来的一个 agent（来自 `herdr agent list`） */
export interface HerdrAgent {
  kind: string;
  /** working / blocked / done / idle / unknown */
  status: string;
  cwd: string;
  /** 窗格号（形如 w1:p1），同时也是给它发命令用的"名字" */
  paneId: string;
  tabId: string;
  workspaceId: string;
  title: string;
  focused: boolean;
  /** 在等我们做事（= blocked） */
  attention: boolean;
}

/**
 * herdr 里的一个窗格（**不管里面有没有 agent**）。
 *
 * 「接管已有窗格」的列表用它：光有 `agent list` 的话，AI 已退出/刚开的空壳窗格
 * 是不出现的 —— 用户就会觉得"没东西可接管"（实测发现）。
 */
export interface HerdrPane {
  paneId: string;
  title: string;
  cwd: string;
  /** 里面跑着什么 agent；空串 = 普通 shell */
  agent: string;
  /** working / blocked / done / idle / unknown */
  status: string;
  focused: boolean;
}

/**
 * herdr **服务**的状态。
 *
 * 为什么单独有它：「装了 herdr」和「herdr 服务在跑」是两件事 ——
 * 服务没在跑时窗格/工作区都取不到，界面必须能让用户看见这个区别，
 * 并且允许他显式启动/停止（停止会关掉所有 herdr 窗格）。
 */
export interface HerdrServerStatus {
  running: boolean;
  /** `herdr status server` 打的那一行，悬停可看 */
  raw: string;
  /** 这套服务里现在有多少个窗格 */
  panes: number;
}

/** 服务器上一个 herdr 窗格 + 它的前台进程名（`bash` / `codex` / …） */
export interface HerdrPaneProc {
  paneId: string;
  procName: string;
}

/**
 * 一次 herdr 工作区扫描的结果。
 *
 * 为什么要带"前台进程"：清理工作区时必须分清**空壳**（停在提示符上的 shell）和
 * **里面正跑着东西**（codex / vim / 编译…）—— 只有空壳才允许被一键清理。
 */
export interface HerdrWorkspaceScan {
  workspaces: string[];
  panes: HerdrPaneProc[];
}

/** 一键安装 herdr 的结果 */
export interface HerdrInstallReport {
  version: string;
  protocol: number;
  platform: string;
  /** 这份安装文件是从哪条路拿到的（官方 / 镜像，直连 / 代理） */
  source: string;
  sha256: string;
  bytes: number;
  /** 装到哪了（固定是 ~/.local/bin/herdr） */
  path: string;
}

/** Codex 会话日志里读出来的用量（token 以"个"为单位，界面自己折成 M 显示） */
export interface AiUsage {
  input: number;
  cachedInput: number;
  output: number;
  reasoning: number;
  /** 整个会话累计 */
  total: number;
  /** 最近一次请求 */
  lastTotal: number;
  /** 模型上下文窗口（算占用百分比用） */
  contextWindow: number;
}

/**
 * 一个 Codex 会话的实时快照（从 `~/.codex/sessions` 的日志里读出来的）。
 * 比"进程还在不在"准得多：有新消息、在跑还是在等你，都能看出来。
 */
export interface AiSessionSnapshot {
  sessionId: string;
  cwd: string;
  /** AI 最近一轮结束时的最后一段话 */
  lastMessage: string;
  lastTurnDurationMs: number;
  lastTurnCompletedAt: number;
  usage?: AiUsage | null;
  /** running / idle / needs-approval / waiting-user */
  state: string;
  /** 一行"现在在干什么" */
  lastAction: string;
  approvalPolicy: string;
  updatedAt: number;
  linesSeen: number;
}

/** AI 任务产物：这一轮跑完之后新增/修改的文件（远端相对会话目录的路径） */
export interface AiArtifact {
  path: string;
  name: string;
  size: number;
  mtime: number;
}

/**
 * AI 任务时间线的一条记录（G-01）。
 *
 * 看板只有"当前这一轮"，这份是**落盘**的历史 —— 应用重启后还在，
 * 用来回答"昨晚我不在的时候它跑完了哪些活、产出了什么"。
 */
export interface AiTurnRecord {
  id: string;
  env: string;
  server: string;
  sessionTitle: string;
  cwd: string;
  tool: string;
  /** 这一轮结束时间（Unix 秒） */
  completedAt: number;
  durationMs: number;
  message: string;
  tokensTotal: number;
  /** 这一轮产出的文件（名字，点开走已有预览） */
  artifacts: string[];
}

/**
 * 这台机器的「AI 状态来源」：装了 herdr 就用它的 agent 状态机（第一手），
 * 没装就用我们自己的进程扫描 + 日志解析（第二手）。看板上要标出来，
 * 否则用户没法判断状态准不准。
 */
export interface AiSourceInfo {
  /** herdr 版本；空字符串 = 这台机器没有 herdr */
  herdrVersion: string;
  herdrPath: string;
  /** 它当前认识的 agent 数量（0 也可能是 server 没在跑） */
  agents: number;
  /** herdr 自报的协议号（0 = 拿不到）。我们对接的是它，不是版本号 */
  protocol: number;
  /** 协议 schema 版本号 */
  schemaVersion: number;
  /** `api schema --json` 的 sha256 前 8 位：协议号没变但 schema 变了也能发现 */
  schemaFingerprint: string;
  /** ok / untested / too_old / unknown */
  compat: string;
  /** 探测时的远端原始输出（前 300 字符）—— 用来分辨"没装"和"没连上" */
  raw?: string;
  /** herdr 服务现在在不在跑（装了 ≠ 在跑） */
  serverRunning?: boolean;
}

export interface AppSettings {
  fontSize: number;
  defaultShell: "powershell" | "cmd" | "wsl";
  recordHistory: boolean;
  tmuxDefault: boolean;
  theme: string;
  closeAction: "exit" | "tray";
  updateUrl: string;
  autoReconnect: boolean;
  /** 文件面板是否跟随终端当前目录 */
  fsFollowTerminal: boolean;
  /** 退出时保存工作区、启动时恢复上次的会话 */
  restoreWorkspace: boolean;
  /** 终端回滚缓冲行数（往上能翻多少行历史） */
  scrollback: number;
  /** 新建会话时自动开始记录终端日志 */
  autoLog: boolean;
  /** 上次检查更新成功的时间（Unix 秒）；0 = 从未检查 */
  lastUpdateCheck: number;
  /** 用户选择「忽略此版本」的版本号 */
  ignoredUpdateVersion: string;
  /** 终端配色方案 key（见 termThemes.ts）；"custom" 表示用下面的自定义配色 */
  termScheme: string;
  /** 自定义配色的 JSON */
  termSchemeCustom: string;
  /** 会话日志目录；空 = 默认 %APPDATA%\ZeeAI-Terminal\logs\sessions */
  logDir: string;
  /**
   * 粘贴 / 拖进来的图片、文件在**远端**落到哪个目录。
   *
   * 默认 `~/.zeeai/paste`；填 `.` = 跟随终端当前目录（文件落进项目里，
   * 对 CLI agent 的沙箱最友好 —— 有些 agent 只肯读工作区内的文件）。
   */
  pasteDir: string;
  /**
   * 哪个键负责粘贴：`both`（默认）/ `ctrl-v` / `shift-insert`。
   *
   * 语义是"**哪个键留给终端**"：没被选中的那个会原样送给远端
   *（Ctrl+V → `^V`，readline 的 quoted-insert；Shift+Insert → Insert 键）。
   */
  pasteKey: string;
  /** 终端里点右键：`menu`（默认，弹菜单）/ `paste`（直接粘贴文本；Shift+右键仍弹菜单） */
  rightClick: string;
  /** 复制方式：`ctrl-shift-c`（默认）/ `ctrl-c-smart`（有选中就复制）/ `select`（选中即复制） */
  copyKey: string;
  /** 直接粘进终端（不经过输入窗）时，弹几秒缩略图预览；默认开 */
  pasteToast: boolean;
  /** 终端关键字高亮总开关（SSH / 串口 / 本地终端共用） */
  highlightEnabled: boolean;
  /** 终端关键字高亮规则 */
  highlightRules: HighlightRule[];
  /** 命名规则集：服务器 / 串口 / 本地终端可各绑一套 */
  highlightRuleSets: HighlightRuleSet[];
  /** 按终端类型各绑的配色方案 key（ssh / local / serial / adb） */
  termSchemeByKind: Record<string, string>;
  /** 按终端类型各绑的高亮规则集 id（ssh / local / serial / adb） */
  highlightSetByKind: Record<string, string>;
  /** AI 有需要你处理的事情时，除活动栏红点外再闪 Windows 任务栏 */
  aiNotifyTaskbar: boolean;
  /**
   * 旧的那条总开关（"跑完了就点红点"）。
   *
   * 已被下面两条独立开关取代（口径 docs/design-ai-board-v2.md §10.6：红点只为两种情况亮）。
   * 字段留着只为**读得懂老配置**，界面不再用它 —— 别在新代码里引用。
   */
  aiNotifyBadge: boolean;
  /** 红点规则 ①：有实例在「需要你」时亮 —— **亮到你处理为止**（默认开） */
  aiNotifyNeedsYouBadge: boolean;
  /** 红点规则 ②：某一轮跑完并停下时亮一个未读 —— **点开面板即清**（默认开） */
  aiNotifyFinishedBadge: boolean;
  /**
   * 通知策略：**每一轮跑完**就提醒。
   * 默认关 —— 用户原话"跑的小任务太多，每跑一个都弹一条，很烦"。
   */
  aiNotifyComplete: boolean;
  /** 通知策略：这一轮产出了文档（HTML / Markdown）才提醒。默认开 */
  aiNotifyDocs: boolean;
  /** 通知策略：AI 在等你（批准 / 回话 / 做选择题）时提醒。默认开（这条最不该漏） */
  aiNotifyNeedsYou: boolean;
  /** 产物范围：true = 任何新文件都算；false = 只算 HTML / Markdown 文档（默认） */
  aiNotifyAllArtifacts: boolean;
}

export interface GitFile {
  status: string;
  path: string;
}

export interface GitStatus {
  ok: boolean;
  branch: string;
  upstream: string;
  ahead: number;
  behind: number;
  files: GitFile[];
  message: string;
}

export interface GitCommit {
  hash: string;
  short: string;
  author: string;
  when: string;
  subject: string;
}

export interface GitBranch {
  name: string;
  current: boolean;
  upstream: string;
  when: string;
}

/** 文件传输进度事件（后端通过 zeeai://transfer 推过来） */
export type TransferEvent =
  | { kind: "start"; task: string; name: string; total: number }
  | { kind: "progress"; task: string; name: string; done: number; total: number }
  | { kind: "fileDone"; task: string; name: string; bytes: number }
  | { kind: "fileFailed"; task: string; name: string; message: string }
  | { kind: "allDone"; task: string; ok: number; failed: number };

export interface AdbDevice {
  serial: string;
  state: string;
  model?: string | null;
}

export interface AdbFile {
  name: string;
  isDir: boolean;
  size: number;
}

export interface AiTool {
  name: string;
  label: string;
  installed: boolean;
  version: string;
  installCmd: string;
  runCmd: string;
}

export interface AiProbe {
  tools: AiTool[];
  npm: string;
  running: string[];
}

export interface SerialPortInfo {
  path: string;
  label: string;
}

// ---------------------------------------------------------------------------
// SSH 连接诊断（后端 `ssh_diagnose`：跑一次只读的 `ssh -G`，不连服务器）
// ---------------------------------------------------------------------------

/**
 * `ssh -G` 解析出来的「实际生效」配置。
 *
 * 字段名沿用 OpenSSH 配置项的小写写法（`identityfile` / `proxyjump` …）——
 * 后端结构体就是这么序列化的，**不是** `identity_files`。取密钥列表请用
 * `App.tsx` 里的 `identityFilesOf()`，它两种都认，免得以后后端改名前端就瞎。
 */
export interface SshEffectiveConfig {
  hostname: string;
  /** 0 不会出现：后端解析完会落回 22 */
  port: number;
  /** 可能是空串（= 用户名交给系统当前用户） */
  user: string;
  /** 可能有多条（配置里的 IdentityFile + OpenSSH 的系统默认值） */
  identityfile: string[];
  /** 空 / undefined = 没配；后端会把 "none" 归一成 undefined */
  proxyjump?: string | null;
  proxycommand?: string | null;
  /** "yes" / "no" / ""（空 = 本机配置里没写） */
  identitiesonly: string;
  /** "yes" / "no" / ""（空 = 本机配置里没写） */
  batchmode: string;
}

/** 一个候选密钥文件：`exists` 是后端在本机 `Path::exists()` 的真实结果 */
export interface SshKeyFile {
  path: string;
  exists: boolean;
}

/** `ssh_diagnose` 的返回值：生效配置 + 每个候选密钥是否存在 + 后端给的一句中文总结 */
export interface SshDiagnosis {
  effective: SshEffectiveConfig;
  key_files: SshKeyFile[];
  summary: string;
}
