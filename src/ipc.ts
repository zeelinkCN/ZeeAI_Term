import { invoke, Channel } from "@tauri-apps/api/core";
import type {
  ConnectionProfile,
  SessionEvent,
  SessionInfo,
  TmuxSession,
  RemoteListing,
  HistoryEntry,
  AppSettings,
  AdbDevice,
  SerialPortInfo,
  GitStatus,
} from "./types";

export async function listProfiles(): Promise<ConnectionProfile[]> {
  return invoke<ConnectionProfile[]>("list_profiles");
}

export async function saveProfile(profile: ConnectionProfile): Promise<void> {
  return invoke("save_profile", { profile });
}

export async function deleteProfile(id: string): Promise<void> {
  return invoke("delete_profile", { id });
}

/** 打开本地终端（powershell / cmd / wsl）。id 由前端生成，便于事件在终端挂载前就能正确路由。 */
export async function openLocal(
  id: string,
  shell: string,
  onEvent: (e: SessionEvent) => void,
  distro?: string,
  cols?: number,
  rows?: number,
  cwd?: string,
): Promise<SessionInfo> {
  const ch = new Channel<SessionEvent>();
  ch.onmessage = onEvent;
  return invoke<SessionInfo>("open_local", {
    id,
    shell,
    distro: distro ?? null,
    cwd: cwd ?? null,
    cols: cols ?? null,
    rows: rows ?? null,
    onEvent: ch,
  });
}

/** 打开 SSH 会话（可选 tmux） */
export async function openSsh(
  id: string,
  profileId: string,
  onEvent: (e: SessionEvent) => void,
  tmuxMode: "default" | "none" | "name" = "default",
  tmuxName?: string | null,
  cols?: number,
  rows?: number,
  userOverride?: string | null,
): Promise<SessionInfo> {
  const ch = new Channel<SessionEvent>();
  ch.onmessage = onEvent;
  return invoke<SessionInfo>("open_ssh", {
    id,
    profileId,
    tmuxMode,
    tmuxName: tmuxName ?? null,
    userOverride: userOverride ?? null,
    cols: cols ?? null,
    rows: rows ?? null,
    onEvent: ch,
  });
}

export async function historyList(): Promise<HistoryEntry[]> {
  return invoke<HistoryEntry[]>("history_list");
}

export async function historySave(entry: HistoryEntry): Promise<HistoryEntry[]> {
  return invoke<HistoryEntry[]>("history_save", { entry });
}

export async function historyRemove(id: string): Promise<HistoryEntry[]> {
  return invoke<HistoryEntry[]>("history_remove", { id });
}

export async function settingsGet(): Promise<AppSettings> {
  return invoke<AppSettings>("settings_get");
}

export async function settingsSet(settings: AppSettings): Promise<void> {
  return invoke("settings_set", { settings });
}

export async function adbVersion(): Promise<string> {
  return invoke<string>("adb_version");
}

export async function adbDevices(): Promise<AdbDevice[]> {
  return invoke<AdbDevice[]>("adb_devices");
}

export async function openAdbShell(
  id: string,
  serial: string,
  onEvent: (e: SessionEvent) => void,
  cols?: number,
  rows?: number,
): Promise<SessionInfo> {
  const ch = new Channel<SessionEvent>();
  ch.onmessage = onEvent;
  return invoke<SessionInfo>("open_adb_shell", {
    id,
    serial,
    cols: cols ?? null,
    rows: rows ?? null,
    onEvent: ch,
  });
}

export async function serialList(): Promise<SerialPortInfo[]> {
  return invoke<SerialPortInfo[]>("serial_list");
}

export async function openSerial(
  id: string,
  path: string,
  baud: number,
  onEvent: (e: SessionEvent) => void,
  extra?: {
    dataBits?: number;
    stopBits?: number;
    parity?: string;
    flowControl?: string;
  },
): Promise<SessionInfo> {
  const ch = new Channel<SessionEvent>();
  ch.onmessage = onEvent;
  return invoke<SessionInfo>("open_serial", {
    id,
    path,
    baud,
    dataBits: extra?.dataBits ?? null,
    stopBits: extra?.stopBits ?? null,
    parity: extra?.parity ?? null,
    flowControl: extra?.flowControl ?? null,
    onEvent: ch,
  });
}

/** 问服务器上这个 tmux 会话当前在哪个目录 */
export async function remotePwd(
  profileId: string,
  tmuxSession?: string | null,
  userOverride?: string | null,
): Promise<string> {
  return invoke<string>("remote_pwd", {
    profileId,
    tmuxSession: tmuxSession ?? null,
    userOverride: userOverride ?? null,
  });
}

export async function fastbootVersion(): Promise<string> {
  return invoke<string>("fastboot_version");
}

export async function fastbootDevices(): Promise<AdbDevice[]> {
  return invoke<AdbDevice[]>("fastboot_devices");
}

export async function gitStatus(path: string): Promise<GitStatus> {
  return invoke<GitStatus>("git_status", { path });
}

/** 列出服务器上的 tmux 会话 */
export async function tmuxList(
  profileId: string,
  userOverride?: string | null,
): Promise<TmuxSession[]> {
  return invoke<TmuxSession[]>("tmux_list", {
    profileId,
    userOverride: userOverride ?? null,
  });
}

/** 结束服务器上的某个 tmux 会话 */
export async function tmuxKill(
  profileId: string,
  name: string,
  userOverride?: string | null,
): Promise<void> {
  return invoke("tmux_kill", {
    profileId,
    name,
    userOverride: userOverride ?? null,
  });
}

/** 列出远端目录；path 传 null 表示登录后的家目录 */
export async function fsList(
  profileId: string,
  path?: string,
  userOverride?: string | null,
): Promise<RemoteListing> {
  return invoke<RemoteListing>("fs_list", {
    profileId,
    path: path ?? null,
    userOverride: userOverride ?? null,
  });
}

/** 读取远端文件，返回 base64 */
export async function fsRead(
  profileId: string,
  path: string,
  maxBytes?: number,
  userOverride?: string | null,
): Promise<string> {
  return invoke<string>("fs_read", {
    profileId,
    path,
    maxBytes: maxBytes ?? null,
    userOverride: userOverride ?? null,
  });
}

/** 上传本机文件（或整个目录）到远端目录 */
export async function fsUpload(
  profileId: string,
  localPaths: string[],
  remoteDir: string,
  userOverride?: string | null,
): Promise<string> {
  return invoke<string>("fs_upload", {
    profileId,
    localPaths,
    remoteDir,
    userOverride: userOverride ?? null,
  });
}

/** 把远端文件/目录下载到本机目录 */
export async function fsDownload(
  profileId: string,
  remotePaths: string[],
  localDir: string,
  userOverride?: string | null,
): Promise<string> {
  return invoke<string>("fs_download", {
    profileId,
    remotePaths,
    localDir,
    userOverride: userOverride ?? null,
  });
}

export async function fsMkdir(
  profileId: string,
  path: string,
  userOverride?: string | null,
): Promise<void> {
  return invoke("fs_mkdir", { profileId, path, userOverride: userOverride ?? null });
}

export async function fsRemove(
  profileId: string,
  path: string,
  userOverride?: string | null,
): Promise<void> {
  return invoke("fs_remove", { profileId, path, userOverride: userOverride ?? null });
}

export async function fsRename(
  profileId: string,
  from: string,
  to: string,
  userOverride?: string | null,
): Promise<void> {
  return invoke("fs_rename", { profileId, from, to, userOverride: userOverride ?? null });
}

export async function sessionWrite(id: string, dataB64: string): Promise<void> {
  return invoke("session_write", { id, dataB64 });
}

export async function sessionResize(
  id: string,
  cols: number,
  rows: number,
): Promise<void> {
  return invoke("session_resize", { id, cols, rows });
}

export async function sessionClose(id: string): Promise<void> {
  return invoke("session_close", { id });
}
