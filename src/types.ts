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
  startDir?: string;
}

export interface ConnectionProfile {
  id: string;
  type: ConnType;
  name: string;
  group: string;
  color?: string;
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
  /** 用户给这个会话起的名字 */
  title?: string | null;
  lastUsed: number;
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
  /** AI 有需要你处理的事情时，除活动栏红点外再闪 Windows 任务栏 */
  aiNotifyTaskbar: boolean;
  /** AI 有需要你处理的事情时，在右下角显示一条提示 */
  aiNotifyCorner: boolean;
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
