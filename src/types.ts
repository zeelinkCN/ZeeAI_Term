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
  | { type: "data"; data: string } // base64 编码的字节流
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
  /** 是否在左侧活动栏的 AI 星号上显示红点 / 数字 */
  aiNotifyBadge: boolean;
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
