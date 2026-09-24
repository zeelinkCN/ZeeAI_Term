export type ConnType = "ssh" | "serial" | "adb" | "local";

export interface SshConfig {
  host: string;
  port: number;
  user: string;
  authKind: "password" | "key" | "agent";
  allowPassword?: boolean;
  keyPath?: string;
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
  serial?: { path: string; baudRate: number };
  local?: { shell: "powershell" | "cmd" | "wsl"; distro?: string };
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

export interface AdbDevice {
  serial: string;
  state: string;
  model?: string | null;
}

export interface SerialPortInfo {
  path: string;
  label: string;
}
