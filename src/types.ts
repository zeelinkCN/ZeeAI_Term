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
