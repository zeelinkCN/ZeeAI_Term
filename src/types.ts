export type ConnType = "ssh" | "serial" | "adb" | "local";

export interface SshConfig {
  host: string;
  port: number;
  user: string;
  authKind: "password" | "key" | "agent";
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
