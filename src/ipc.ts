import { invoke, Channel } from "@tauri-apps/api/core";
import type {
  ConnectionProfile,
  SessionEvent,
  SessionInfo,
  TmuxSession,
  TmuxWindow,
  RemoteListing,
  HistoryEntry,
  AppSettings,
  AdbDevice,
  SerialPortInfo,
  GitStatus,
  GitCommit,
  GitBranch,
  AdbFile,
  AiProbe,
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
  mode?: "shell" | "logcat",
): Promise<SessionInfo> {
  const ch = new Channel<SessionEvent>();
  ch.onmessage = onEvent;
  return invoke<SessionInfo>("open_adb_shell", {
    id,
    serial,
    mode: mode ?? "shell",
    cols: cols ?? null,
    rows: rows ?? null,
    onEvent: ch,
  });
}

/** 列设备上的目录 */
export async function adbLs(serial: string, path?: string): Promise<AdbFile[]> {
  return invoke<AdbFile[]>("adb_ls", { serial, path: path ?? null });
}

export async function adbPull(
  serial: string,
  remote: string,
  localDir: string,
): Promise<string> {
  return invoke<string>("adb_pull", { serial, remote, localDir });
}

export async function adbPush(
  serial: string,
  localPaths: string[],
  remoteDir: string,
): Promise<string> {
  return invoke<string>("adb_push", { serial, localPaths, remoteDir });
}

export async function adbRm(serial: string, path: string, isDir: boolean): Promise<void> {
  return invoke("adb_rm", { serial, path, isDir });
}

export async function adbMkdir(serial: string, path: string): Promise<void> {
  return invoke("adb_mkdir", { serial, path });
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

/** 在指定目录 git init（目录不存在时自动创建） */
export async function gitInit(path: string, createDir?: boolean): Promise<string> {
  return invoke<string>("git_init", { path, createDir: createDir ?? true });
}

/** 暂存（files 为空表示全部） */
export async function gitAdd(path: string, files?: string[]): Promise<void> {
  return invoke("git_add", { path, files: files && files.length ? files : null });
}

export async function gitUnstage(path: string, files: string[]): Promise<void> {
  return invoke("git_unstage", { path, files });
}

export async function gitDiscard(path: string, files: string[]): Promise<void> {
  return invoke("git_discard", { path, files });
}

export async function gitCommit(path: string, message: string): Promise<string> {
  return invoke<string>("git_commit", { path, message });
}

export async function gitLog(path: string, limit?: number): Promise<GitCommit[]> {
  return invoke<GitCommit[]>("git_log", { path, limit: limit ?? null });
}

export async function gitBranches(path: string): Promise<GitBranch[]> {
  return invoke<GitBranch[]>("git_branches", { path });
}

export async function gitCheckout(
  path: string,
  branch: string,
  create?: boolean,
): Promise<string> {
  return invoke<string>("git_checkout", { path, branch, create: create ?? false });
}

export async function gitDiff(path: string, file: string, staged?: boolean): Promise<string> {
  return invoke<string>("git_diff", { path, file, staged: staged ?? false });
}

export async function gitShow(path: string, rev: string): Promise<string> {
  return invoke<string>("git_show", { path, rev });
}

/** 把密码存进 Windows 凭据管理器（传空字符串等于删除） */
export async function secretSet(profileId: string, password: string): Promise<void> {
  return invoke("secret_set", { profileId, password });
}

export async function secretHas(profileId: string): Promise<boolean> {
  return invoke<boolean>("secret_has", { profileId });
}

export async function secretDelete(profileId: string): Promise<void> {
  return invoke("secret_delete", { profileId });
}

/** 保存工作区快照（前端序列化成 JSON） */
export async function workspaceSave(data: string): Promise<void> {
  return invoke("workspace_save", { data });
}

/** 读取上次的工作区快照 */
export async function workspaceLoad(): Promise<string | null> {
  return invoke<string | null>("workspace_load");
}

/** 探测服务器上的 AI 命令行工具 */
export async function aiProbe(
  profileId: string,
  userOverride?: string | null,
): Promise<AiProbe> {
  return invoke<AiProbe>("ai_probe", { profileId, userOverride: userOverride ?? null });
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

/** 列出某个 tmux 会话里的窗口 */
export async function tmuxWindows(
  profileId: string,
  session: string,
  userOverride?: string | null,
): Promise<TmuxWindow[]> {
  return invoke<TmuxWindow[]>("tmux_windows", {
    profileId,
    session,
    userOverride: userOverride ?? null,
  });
}

/**
 * 执行一个 tmux 快捷操作（白名单动作，后端映射成具体 tmux 命令）。
 * 走另开一条 ssh 跑命令，不抢 `Ctrl+B` 前缀、也不依赖终端焦点。
 */
export async function tmuxAction(
  profileId: string,
  session: string,
  action: string,
  arg?: string | null,
  userOverride?: string | null,
): Promise<string> {
  return invoke<string>("tmux_action", {
    profileId,
    session,
    action,
    arg: arg ?? null,
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
  taskId?: string,
): Promise<string> {
  return invoke<string>("fs_upload", {
    profileId,
    localPaths,
    remoteDir,
    userOverride: userOverride ?? null,
    taskId: taskId ?? null,
  });
}

/** 把远端文件/目录下载到本机目录 */
export async function fsDownload(
  profileId: string,
  remotePaths: string[],
  localDir: string,
  userOverride?: string | null,
  taskId?: string,
): Promise<string> {
  return invoke<string>("fs_download", {
    profileId,
    remotePaths,
    localDir,
    userOverride: userOverride ?? null,
    taskId: taskId ?? null,
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

/** 开始记录某个会话的终端日志，返回日志文件路径 */
export async function sessionLogStart(id: string, fileName?: string): Promise<string> {
  return invoke<string>("session_log_start", { id, fileName: fileName ?? null });
}

/** 停止记录，返回刚写过的文件路径 */
export async function sessionLogStop(id: string): Promise<string | null> {
  return invoke<string | null>("session_log_stop", { id });
}

/** 这个会话正在记日志吗？是的话返回文件路径 */
export async function sessionLogStatus(id: string): Promise<string | null> {
  return invoke<string | null>("session_log_status", { id });
}

/** 会话日志目录（不存在会创建） */
export async function sessionLogDir(): Promise<string> {
  return invoke<string>("session_log_dir");
}

/** 用资源管理器打开文件或目录 */
export async function openInExplorer(path: string): Promise<void> {
  return invoke("open_in_explorer", { path });
}

/** 用系统默认浏览器打开 http/https 链接 */
export async function openExternalUrl(url: string): Promise<void> {
  return invoke("open_external_url", { url });
}

/** 当前这份是怎么装上的：nsis / msi / portable（决定能不能一键覆盖升级） */
export async function updateInstallKind(): Promise<string> {
  return invoke<string>("update_install_kind");
}

/**
 * 一键升级：下载新版安装包 → 校验 → 静默覆盖安装 → 自动重启应用。
 * 下载进度通过 `zeeai://transfer` 事件推送（右下角进度面板）。
 */
export async function updateDownloadInstall(
  url: string,
  expectedSize: number,
  version: string,
): Promise<string> {
  return invoke<string>("update_download_install", { url, expectedSize, version });
}
