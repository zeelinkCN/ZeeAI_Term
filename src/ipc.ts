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
  AiTurnRecord,
  AiSourceInfo,
  GitCommit,
  GitBranch,
  AdbFile,
  AiProbe,
  AiTask,
  AiSessionSnapshot,
  AiArtifact,
  AiInstance,
  BoardSources,
  HighlightRule,
  HerdrAgent,
  HerdrPane,
  HerdrServerStatus,
  HerdrWorkspaceScan,
  HerdrInstallReport,
  SshDiagnosis,
} from "./types";

/**
 * PTY 输出批次的 seq 旁路队列。
 *
 * 为什么需要它：`SessionEvent.data` 里带了 seq，但 App.tsx 的 handleEvent 只把
 * `e.data` 解码成字节后 `bus.push`，没有把 seq 传给终端。我们不改 App（并行开发），
 * 所以在**创建 Channel 的地方**先把 seq 按到达顺序排进队列；Terminal 的 bus sink
 * 每收到一片字节就取一个 seq。队列和 bus 的字节顺序严格一一对应，而且终端晚挂载
 * / 卸载再挂载也不会错位（bus 会缓冲字节，这里同样保留 seq）。
 *
 * 数据事件一定是「先入队 seq，再调用原 onEvent」，所以 Terminal 在 bus sink 里
 * 同步取 seq 时一定拿得到。
 */
const outputSeqs = new Map<string, number[]>();

function makeSessionChannel(
  id: string,
  onEvent: (e: SessionEvent) => void,
): Channel<SessionEvent> {
  const ch = new Channel<SessionEvent>();
  ch.onmessage = (e) => {
    if (e.type === "data" && typeof e.seq === "number") {
      const q = outputSeqs.get(id) ?? [];
      q.push(e.seq);
      outputSeqs.set(id, q);
    }
    onEvent(e);
  };
  return ch;
}

/** Terminal 收到一片输出时取走它的批次号；没有（串口/herdr）返回 undefined。 */
export function takeOutputSeq(id: string): number | undefined {
  const q = outputSeqs.get(id);
  if (!q || q.length === 0) return undefined;
  const seq = q.shift();
  if (q.length === 0) outputSeqs.delete(id);
  return seq;
}

/** 会话关闭时丢掉还没消费的批次号，避免 Map 里留下一条永远不用的队列。 */
export function dropOutputSeq(id: string): void {
  outputSeqs.delete(id);
}

/**
 * 告诉后端「seq 及之前的输出已经写进 xterm」。
 *
 * 累积语义：一次 ack 可以同时确认之前所有批次。失败可以忽略（例如会话已经关了）——
 * 后端有 1 秒 ack 超时兜底，不会永久卡住。
 */
export async function sessionOutputAck(id: string, seq: number): Promise<void> {
  return invoke("session_output_ack", { sessionId: id, seq });
}

export async function listProfiles(): Promise<ConnectionProfile[]> {
  return invoke<ConnectionProfile[]>("list_profiles");
}

export async function saveProfile(profile: ConnectionProfile): Promise<void> {
  return invoke("save_profile", { profile });
}

export async function deleteProfile(id: string): Promise<void> {
  return invoke("delete_profile", { id });
}

/**
 * SSH 连接诊断：让后端跑一次只读的 `ssh -G`，看本机*实际*会用的
 * hostname / port / user / IdentityFile / ProxyJump，以及每个候选密钥是否存在。
 *
 * **不会连接服务器**、不改任何配置；系统没装 OpenSSH 客户端会抛出明确中文错误。
 * 参数是**已保存**的服务器 id（后端按 id 读配置），所以新建未保存的服务器不能诊断。
 */
export async function sshDiagnose(profileId: string): Promise<SshDiagnosis> {
  return invoke<SshDiagnosis>("ssh_diagnose", { profileId });
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
  const ch = makeSessionChannel(id, onEvent);
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
  /**
   * 会话后端：
   * - `tmux`（默认）/ `herdr`：跑一个真终端；
   * - `herdr-pane`：**只读观察窗** —— 用 herdr 的 observe 通道看某个窗格；
   * - `herdr-control`：**可读可写** —— 用 herdr 的 control 通道直接进她的环境里干活。
   * 后两条都不跑 herdr 自己的 TUI（那条路会花屏、还会跟别的客户端抢尺寸）。
   */
  backend?: "tmux" | "herdr" | "herdr-pane" | "herdr-control" | null,
): Promise<SessionInfo> {
  const ch = makeSessionChannel(id, onEvent);
  return invoke<SessionInfo>("open_ssh", {
    id,
    profileId,
    tmuxMode,
    tmuxName: tmuxName ?? null,
    backend: backend ?? "tmux",
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
  const ch = makeSessionChannel(id, onEvent);
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
  const ch = makeSessionChannel(id, onEvent);
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

/** 探测服务器上的 AI CLI 进程 */
export async function aiProbe(
  profileId: string,
  userOverride?: string | null,
): Promise<AiProbe> {
  return invoke<AiProbe>("ai_probe", { profileId, userOverride: userOverride ?? null });
}

/** 终端关键字高亮的预设规则包（「载入预设规则」按钮用） */
export async function highlightPresets(): Promise<HighlightRule[]> {
  return invoke<HighlightRule[]>("highlight_presets");
}

/** 当前应用是不是以管理员身份在跑 */
export async function isAdmin(): Promise<boolean> {
  return invoke<boolean>("is_admin");
}

/**
 * 以管理员身份重启整个应用（弹一次 UAC）。
 * 之后开的 PowerShell / CMD 天然都是管理员 —— ConPTY 挂在我们的进程上，
 * 没法只给单个标签页提权。
 */
export async function restartAsAdmin(): Promise<void> {
  return invoke("restart_as_admin");
}

/** 以管理员身份单独开一个 PowerShell / CMD 窗口（独立窗口，不在标签里） */
export async function openAdminShell(shell: "powershell" | "cmd"): Promise<void> {
  return invoke("open_admin_shell", { shell });
}

/**
 * 记一笔「App 自己在某个会话里启动了某个 AI 进程」。
 * 这是 AI 任务看板里最精确的一层信号（开始时间、跑完没跑完都由 App 自己判）。
 */
export async function aiTaskNoteStart(
  env: string,
  server: string,
  tool: string,
  command: string,
): Promise<AiTask> {
  return invoke<AiTask>("ai_task_note_start", { env, server, tool, command });
}

/** AI 任务看板：远端快照（tmux 窗格 + ps 扫描 + App 自己启动的那批） */
export async function aiTasksRemote(
  profileId: string,
  server: string,
  userOverride?: string | null,
): Promise<AiTask[]> {
  return invoke<AiTask[]>("ai_tasks_remote", {
    profileId,
    server,
    userOverride: userOverride ?? null,
  });
}

/** AI 任务看板：本机 / WSL 快照（cmd 走「仅状态」，不扫进程表） */
export async function aiTasksLocal(
  shell: string,
  server: string,
  distro?: string | null,
): Promise<AiTask[]> {
  return invoke<AiTask[]>("ai_tasks_local", { shell, server, distro: distro ?? null });
}

/** 清掉某个环境里「已结束」的卡片 */
export async function aiTasksClearFinished(env: string, server: string): Promise<void> {
  return invoke("ai_tasks_clear_finished", { env, server });
}

/**
 * AI 看板 v2：把前端**已经采集到**的五套来源送进后端，换回合并好的「AI 实例」列表。
 *
 * 为什么前端不再自己合并（`taskKeyOf` / `betterTask` / `absorbTask` 已删）：
 * **可信度闸门**（推断不许说成事实）、**陈旧降级**、**一个实例一张卡** 这三条口径
 * 只能有一份实现 —— 老看板在前端 JS 里合并，于是留下过"同一目录两个 codex 只剩一张卡"。
 *
 * `nowMs` 不传：让后端用自己的时钟，避免前端时钟被改过时把"陈旧判定"算歪。
 */
export async function aiInstances(sources: BoardSources): Promise<AiInstance[]> {
  return invoke<AiInstance[]>("ai_instances", { sources });
}

/**
 * 读 Codex 会话日志，拿到"有没有新消息 / 在跑还是在等你 / 耗时 / token"。
 * 远端读服务器上的 `~/.codex/sessions`（一条 ssh 命令取最新 rollout 的尾巴）。
 */
export async function aiSessionSnapshot(
  profileId?: string | null,
  userOverride?: string | null,
  shell?: string | null,
  distro?: string | null,
): Promise<AiSessionSnapshot | null> {
  return invoke<AiSessionSnapshot | null>("ai_session_snapshot", {
    profileId: profileId ?? null,
    userOverride: userOverride ?? null,
    shell: shell ?? null,
    distro: distro ?? null,
  });
}

/** 任务产物：cwd 下在 since（Unix 秒）之后新增/修改的文件 */
export async function aiTaskArtifacts(
  profileId: string | null,
  userOverride: string | null,
  shell: string | null,
  distro: string | null,
  cwd: string,
  since: number,
): Promise<AiArtifact[]> {
  return invoke<AiArtifact[]>("ai_task_artifacts", {
    profileId,
    userOverride,
    shell,
    distro,
    cwd,
    since,
  });
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

/**
 * 把从剪贴板 / 拖拽拿到的文件落到本地临时文件，返回**绝对路径**（随后交给 fsUpload）。
 *
 * 为什么要绕这一下：WebView 的 paste 事件能直接拿到文件字节，而上传走的是 fs_upload，
 * 它要本地路径 —— 中间只差这一步落盘。后端会把文件名洗干净（空格/引号换成 `_`，中文保留）。
 */
export async function pasteSaveFile(name: string, dataB64: string): Promise<string> {
  return invoke<string>("paste_save_file", { name, dataB64 });
}

/**
 * 把用户**选中 / 拖进来**的本地文件收进粘贴临时目录（带时间戳改名），返回新路径。
 *
 * 为什么所有附件都要"收进一个目录"：上传、缩略图预览、用完清理这三件事就只认一个目录，
 * 守卫写一次就够；也不用给应用开"读任意路径"的权限。
 */
export async function pasteAdoptFile(path: string): Promise<string> {
  return invoke<string>("paste_adopt_file", { path });
}

/**
 * 读一张预览图（base64）。只认粘贴临时目录、最多 4MB（缩略图不需要原图）。
 * 拿不到就静默降级成"没有预览"，不要打扰用户。
 */
export async function pasteReadThumb(path: string): Promise<string> {
  return invoke<string>("paste_read_thumb", { path });
}

/** 删掉粘贴临时文件（上传成功后清理，或用户移除附件时）。只认那个临时目录。 */
export async function pasteDiscardFile(path: string): Promise<void> {
  return invoke("paste_discard_file", { path });
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
  try {
    return await invoke("session_close", { id });
  } finally {
    // 会话没了，seq 队列也不可能再被消费（终端卸载时也会自己清理一次）
    dropOutputSeq(id);
  }
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
 * 上一次「一键升级」的结果（安装器退出码 / 失败原因）。
 * 升级脚本写的 `apply_update.log`，读一次就删掉。
 */
export async function updateTakeResult(): Promise<string | null> {
  return invoke<string | null>("update_take_result");
}

/**
 * 一键升级：下载新版安装包 → 校验 → 静默覆盖安装 → 自动重启应用。
 * 下载进度通过 `zeeai://transfer` 事件推送（右下角进度面板）。
 */
export async function updateDownloadInstall(
  url: string,
  expectedSize: number,
  version: string,
  expectedSha?: string | null,
): Promise<string> {
  return invoke<string>("update_download_install", {
    url,
    expectedSize,
    version,
    expectedSha: expectedSha ?? null,
  });
}

// ---------- AI 任务时间线（G-01） ----------

/** 读落盘的任务时间线（新的在前） */
export async function aiTimelineList(): Promise<AiTurnRecord[]> {
  return invoke<AiTurnRecord[]>("ai_timeline_list");
}

/** 记一条"这一轮跑完了"；返回是否是新的（前端据此刷新列表） */
export async function aiTimelineAdd(entry: AiTurnRecord): Promise<boolean> {
  return invoke<boolean>("ai_timeline_add", { entry });
}

/** 清空时间线 */
export async function aiTimelineClear(): Promise<void> {
  return invoke("ai_timeline_clear");
}

/** 探测这台机器的 AI 状态来源（有没有 herdr）。只读，不装任何东西。 */
export async function aiSourceProbe(
  profileId?: string | null,
  userOverride?: string | null,
): Promise<AiSourceInfo> {
  return invoke<AiSourceInfo>("ai_source_probe", {
    profileId: profileId ?? null,
    userOverride: userOverride ?? null,
  });
}

// ---------- herdr ----------

/** 读这台服务器上 herdr 认得的 agent（只读；这台机器没装 herdr 时返回空数组） */
export async function herdrAgents(
  profileId: string,
  userOverride?: string | null,
): Promise<HerdrAgent[]> {
  return invoke<HerdrAgent[]>("herdr_agents", {
    profileId,
    userOverride: userOverride ?? null,
  });
}

/** 读这台服务器上 herdr 的**所有窗格**（含没有 agent 的空壳窗格）—— 接管列表用 */
export async function herdrPanes(
  profileId: string,
  userOverride?: string | null,
): Promise<HerdrPane[]> {
  return invoke<HerdrPane[]>("herdr_panes", {
    profileId,
    userOverride: userOverride ?? null,
  });
}

/** herdr 服务状态（只读；不会顺手启动它） */
export async function herdrServerStatus(
  profileId: string,
  userOverride?: string | null,
): Promise<HerdrServerStatus> {
  return invoke<HerdrServerStatus>("herdr_server_status", {
    profileId,
    userOverride: userOverride ?? null,
  });
}

/** 启动 herdr 服务（后台起来，不挂在这条 ssh 上） */
export async function herdrServerStart(
  profileId: string,
  userOverride?: string | null,
): Promise<string> {
  return invoke<string>("herdr_server_start", {
    profileId,
    userOverride: userOverride ?? null,
  });
}

/** 停止 herdr 服务 —— **会关掉它管着的所有窗格**，调用前必须让用户确认 */
export async function herdrServerStop(
  profileId: string,
  userOverride?: string | null,
): Promise<string> {
  return invoke<string>("herdr_server_stop", {
    profileId,
    userOverride: userOverride ?? null,
  });
}

/** 扫一遍服务器上的 herdr 工作区 + 每个窗格的前台进程（只读）—— 用来挑出"空壳"的那些 */
export async function herdrWorkspaceScan(
  profileId: string,
  userOverride?: string | null,
): Promise<HerdrWorkspaceScan> {
  return invoke<HerdrWorkspaceScan>("herdr_workspace_scan", {
    profileId,
    userOverride: userOverride ?? null,
  });
}

/** 关掉一个 herdr 工作区（连带它的窗格）—— **必须让用户确认后**再调用 */
export async function herdrWorkspaceClose(
  profileId: string,
  workspaceId: string,
  userOverride?: string | null,
): Promise<string> {
  return invoke<string>("herdr_workspace_close", {
    profileId,
    workspaceId,
    userOverride: userOverride ?? null,
  });
}

/**
 * 「herdr 快捷操作」面板上的一个动作。
 *
 * 只传**动作名**（后端白名单），不传命令 —— 和 tmux 那条一样，这个接口不能变成
 * "在前端拼任意远端命令"的口子。后端是另开一条 ssh 跑 herdr 的 socket API，
 * 不往终端里塞按键（所以不抢快捷键、也不受"窗格里正在跑程序"的影响）。
 */
export async function herdrPaneAction(
  profileId: string,
  pane: string,
  action: string,
  arg?: string | null,
  userOverride?: string | null,
): Promise<string> {
  return invoke<string>("herdr_pane_action", {
    profileId,
    pane,
    action,
    arg: arg ?? null,
    userOverride: userOverride ?? null,
  });
}

/** 观察窗尺寸变了：让后端把 observe 流按新尺寸重开一次 */
export async function herdrPaneResize(id: string, cols: number, rows: number): Promise<void> {
  return invoke("herdr_pane_resize", { id, cols, rows });
}

/** 给观察窗建一条常驻输入通道（同一个会话只需要建一次） */
export async function herdrPaneInputStart(
  id: string,
  profileId: string,
  userOverride: string | null,
  paneId: string,
): Promise<void> {
  return invoke("herdr_pane_input_start", { id, profileId, userOverride, paneId });
}

/** 往观察窗里按字面送一段文本 */
export async function herdrPaneType(id: string, text: string): Promise<void> {
  return invoke("herdr_pane_type", { id, text });
}

/** 往观察窗里送一个逻辑按键（enter / esc / ctrl+c / up …） */
export async function herdrPaneKey(id: string, key: string): Promise<void> {
  return invoke("herdr_pane_key", { id, key });
}

/**
 * 往**可写**的 herdr 窗格（herdr-control）里送原始字节。
 *
 * 和上面两个的区别：观察窗的输入得另开一条 ssh 去敲（`pane send-text`），
 * 而 control 流的 stdin 就是它的输入口，直接把 JSON 指令写进这条会话即可。
 */
export async function herdrPaneInput(id: string, dataB64: string): Promise<void> {
  return invoke("herdr_pane_input", { id, dataB64 });
}

/** 在服务器上新建一个 herdr 工作区，返回新窗格号（形如 w5:p1） */
export async function herdrWorkspaceCreate(
  profileId: string,
  userOverride?: string | null,
): Promise<string> {
  return invoke<string>("herdr_workspace_create", {
    profileId,
    userOverride: userOverride ?? null,
  });
}

/** 一键安装 herdr：Windows 侧下载 → 校验 sha256 → scp 到 ~/.local/bin */
export async function herdrInstall(
  profileId: string,
  userOverride: string | null,
  onProgress: (text: string) => void,
): Promise<HerdrInstallReport> {
  const ch = new Channel<string>();
  ch.onmessage = onProgress;
  return invoke<HerdrInstallReport>("herdr_install", {
    profileId,
    userOverride,
    onProgress: ch,
  });
}
