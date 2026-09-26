import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openLocalDialog } from "@tauri-apps/plugin-dialog";
import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";
import TerminalView from "./features/Terminal";
import TermThemeDialog from "./features/TermThemeDialog";
import { SessionBus } from "./sessionBus";
import {
  adbDevices,
  adbVersion,
  adbLs,
  adbPull,
  adbPush,
  adbRm,
  adbMkdir,
  aiProbe,
  fastbootDevices,
  fastbootVersion,
  gitStatus,
  gitInit,
  gitAdd,
  gitUnstage,
  gitDiscard,
  gitCommit,
  gitLog,
  gitBranches,
  gitCheckout,
  gitDiff,
  gitShow,
  deleteProfile,
  fsList,
  fsRead,
  fsUpload,
  fsDownload,
  fsMkdir,
  fsRemove,
  fsRename,
  historyList,
  historyRemove,
  historySave,
  listProfiles,
  openLocal,
  openAdbShell,
  openSerial,
  openSsh,
  remotePwd,
  secretSet,
  secretHas,
  secretDelete,
  workspaceSave,
  workspaceLoad,
  saveProfile,
  sessionClose,
  sessionLogStart,
  sessionLogStop,
  sessionLogStatus,
  sessionLogDir,
  openInExplorer,
  openExternalUrl,
  updateDownloadInstall,
  updateInstallKind,
  serialList,
  sessionWrite,
  settingsGet,
  settingsSet,
  tmuxKill,
  tmuxList,
  tmuxWindows,
  tmuxAction,
} from "./ipc";
import { b64ToBytes, bytesToB64, uid } from "./util";
import {
  CUSTOM_SCHEME_KEY,
  TERM_SCHEMES,
  resolveTermPalette,
} from "./termThemes";
import type {
  AdbDevice,
  AdbFile,
  AiProbe,
  AppSettings,
  ConnectionProfile,
  GitBranch,
  GitCommit,
  GitStatus,
  HistoryEntry,
  RemoteEntry,
  SerialConfig,
  SerialPortInfo,
  SessionEvent,
  SessionState,
  TmuxSession,
  TmuxWindow,
  TransferEvent,
} from "./types";
import {
  IconActivity,
  IconAndroid,
  IconChevronDown,
  IconChevronRight,
  IconClose,
  IconCmd,
  IconFile,
  IconFolder,
  IconGear,
  IconGit,
  IconLogoRadio,
  IconPlus,
  IconPowerShell,
  IconSerial,
  IconServer,
  IconSpark,
  IconTerminal,
  IconWsl,
} from "./components/Icons";

type ModuleKey = "remote" | "powershell" | "cmd" | "wsl" | "git" | "serial" | "adb";
type FileKind = "md" | "html" | "img" | "code" | "text";
type MdStyle = "github" | "minimal" | "dark" | "paper";

interface OpenFile {
  name: string;
  path: string;
  kind: FileKind;
  b64: string;
}

interface OpenSession {
  id: string;
  title: string;
  kind: ModuleKey;
  profileId?: string;
  /** 该会话实际登录的用户名（可能来自新建会话时的临时覆盖） */
  user?: string;
  tmuxName?: string;
  tmuxMode?: "default" | "none" | "name";
  /** 终端当前工作目录（OSC 7 或 tmux 上报） */
  cwd?: string;
  /** 正在记录终端日志时的文件路径（没记录就是 undefined） */
  logPath?: string;
  state: SessionState;
  openFiles: OpenFile[];
  activeTab: string; // "terminal" 或文件名
}

/** 工作区快照里存的一个会话（只存"怎么把它开回来"，不存文件内容） */
interface SavedSession {
  kind: ModuleKey;
  title: string;
  profileId?: string;
  user?: string;
  tmuxName?: string;
  tmuxMode?: "default" | "none" | "name";
  cwd?: string;
}

interface SavedWorkspace {
  version: number;
  savedAt: number;
  activeIndex: number;
  sessions: SavedSession[];
}

interface MenuItem {
  sep: boolean;
  label?: string;
  action?: () => void;
}

const MODULES: { key: ModuleKey; label: string; node: JSX.Element }[] = [
  { key: "remote", label: "远程", node: <IconServer size={22} /> },
  { key: "powershell", label: "PowerShell", node: <IconPowerShell size={22} /> },
  { key: "cmd", label: "CMD", node: <IconCmd size={22} /> },
  { key: "wsl", label: "WSL", node: <IconWsl size={22} /> },
  { key: "git", label: "Git", node: <IconGit size={22} /> },
  { key: "serial", label: "串口", node: <IconSerial size={22} /> },
  { key: "adb", label: "ADB", node: <IconAndroid size={22} /> },
];

const MODULE_LABEL: Record<ModuleKey, string> = {
  remote: "远程",
  powershell: "PowerShell",
  cmd: "CMD",
  wsl: "WSL",
  git: "Git",
  serial: "串口",
  adb: "ADB",
};

const EMPTY_PROFILE = {
  name: "",
  host: "",
  port: 22,
  user: "root",
  group: "默认",
  keyPath: "",
};

/** GitHub Release 里的一个附件（检查更新时用来挑安装包） */
interface Asset {
  name?: string;
  size?: number;
  browser_download_url?: string;
}

/**
 * 「tmux 快捷操作」面板上的按钮。
 *
 * 刻意做成按钮而不是帮用户改 `Ctrl+B`：`Ctrl+B` 是 tmux 的默认前缀，
 * 动它会毁掉所有 tmux 用户的手感。这里是把**前缀 + 某个键**对应的 tmux 命令
 * 做成可点的按钮（`title` 里写着等价快捷键，顺便当教学）。
 */
/**
 * 服务器没填分组时用的分组名。
 *
 * 这个值只用来"归类"，界面上**不显示** —— 只有一台服务器都不填分组时，
 * 列表里出现一行莫名其妙的「默认」反而让人看不懂。多个分组同时存在时，
 * 它才以「未分组」的名义出现，用来区分其它自建分组。
 */
const DEFAULT_SERVER_GROUP = "默认";

const TMUX_ACTIONS: { key: string; label: string; title: string }[] = [
  { key: "new-window", label: "新建窗口", title: "等价于 Ctrl+B c" },
  { key: "split-h", label: "左右分屏", title: "等价于 Ctrl+B %" },
  { key: "split-v", label: "上下分屏", title: '等价于 Ctrl+B "' },
  { key: "prev-window", label: "上个窗口", title: "等价于 Ctrl+B p" },
  { key: "next-window", label: "下个窗口", title: "等价于 Ctrl+B n" },
  { key: "zoom", label: "放大/还原", title: "等价于 Ctrl+B z" },
  { key: "next-layout", label: "换布局", title: "等价于 Ctrl+B 空格" },
  { key: "pane-left", label: "窗格 ←", title: "等价于 Ctrl+B ←" },
  { key: "pane-up", label: "窗格 ↑", title: "等价于 Ctrl+B ↑" },
  { key: "pane-down", label: "窗格 ↓", title: "等价于 Ctrl+B ↓" },
  { key: "pane-right", label: "窗格 →", title: "等价于 Ctrl+B →" },
  { key: "copy-mode", label: "滚动查看", title: "等价于 Ctrl+B [（进入滚动/复制模式）" },
  { key: "copy-mode-exit", label: "退出滚动", title: "等价于 Ctrl+B q 或 Esc" },
  { key: "rename-window", label: "重命名窗口", title: "等价于 Ctrl+B ," },
  { key: "kill-pane", label: "关闭窗格", title: "等价于 Ctrl+B x" },
  { key: "kill-window", label: "关闭窗口", title: "等价于 Ctrl+B &" },
  { key: "detach", label: "脱离会话", title: "等价于 Ctrl+B d：断开但会话继续在服务器上跑" },
];

const DEFAULT_SETTINGS: AppSettings = {
  fontSize: 13,
  defaultShell: "powershell",
  recordHistory: true,
  tmuxDefault: true,
  theme: "dark",
  closeAction: "exit",
  updateUrl: "https://api.github.com/repos/zeelinkCN/ZeeAI_Term/releases/latest",
  autoReconnect: true,
  fsFollowTerminal: true,
  restoreWorkspace: true,
  scrollback: 10000,
  autoLog: false,
  lastUpdateCheck: 0,
  ignoredUpdateVersion: "",
  termScheme: "vscode-dark",
  termSchemeCustom: "",
  logDir: "",
};

const APP_VERSION = "0.1.4";

/** 比较 a、b 两个版本号：a 新返回 1，相同返回 0，a 旧返回 -1（忽略 v 前缀与预发布后缀） */
function compareVersion(a: string, b: string): number {
  const nums = (v: string) =>
    v
      .trim()
      .replace(/^v/i, "")
      .split(/[.+\-]/)
      .map((x) => parseInt(x, 10))
      .filter((n) => Number.isFinite(n));
  const A = nums(a);
  const B = nums(b);
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const x = A[i] ?? 0;
    const y = B[i] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/** 各种分屏布局对应几个窗格 */
function paneCount(layout: "single" | "v2" | "h2" | "v3" | "grid4"): number {
  switch (layout) {
    case "v2":
    case "h2":
      return 2;
    case "v3":
      return 3;
    case "grid4":
      return 4;
    default:
      return 1;
  }
}

const THEMES: { key: string; label: string; kind: "dark" | "light" }[] = [
  { key: "dark", label: "VS Code 深色", kind: "dark" },
  { key: "one", label: "One Dark Pro", kind: "dark" },
  { key: "tokyo", label: "Tokyo Night", kind: "dark" },
  { key: "nord", label: "Nord 蓝灰", kind: "dark" },
  { key: "dracula", label: "Dracula", kind: "dark" },
  { key: "monokai", label: "Monokai", kind: "dark" },
  { key: "wechat", label: "微信绿", kind: "dark" },
  { key: "teams", label: "Teams 紫", kind: "dark" },
  { key: "teal", label: "青瓷（暗）", kind: "dark" },
  { key: "light", label: "VS Code 浅色", kind: "light" },
  { key: "github", label: "GitHub 浅色", kind: "light" },
  { key: "paper", label: "纸白（护眼）", kind: "light" },
  { key: "sakura", label: "樱花粉", kind: "light" },
  { key: "mint", label: "薄荷绿", kind: "light" },
];

function themeKind(key: string): "dark" | "light" {
  return THEMES.find((t) => t.key === key)?.kind ?? "dark";
}

const SHELL_LABEL: Record<AppSettings["defaultShell"], string> = {
  powershell: "PowerShell",
  cmd: "CMD",
  wsl: "WSL",
};

const md = new MarkdownIt({ html: false, linkify: true, breaks: false });

function moduleIcon(kind: ModuleKey, size = 14): JSX.Element {
  switch (kind) {
    case "remote":
      return <IconServer size={size} />;
    case "cmd":
      return <IconCmd size={size} />;
    case "wsl":
      return <IconWsl size={size} />;
    case "git":
      return <IconGit size={size} />;
    case "serial":
      return <IconSerial size={size} />;
    case "adb":
      return <IconAndroid size={size} />;
    default:
      return <IconTerminal size={size} />;
  }
}

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

function fileKind(name: string): FileKind {
  const ext = extOf(name);
  if (ext === "md" || ext === "markdown") return "md";
  if (ext === "html" || ext === "htm") return "html";
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico"].includes(ext)) return "img";
  if (
    [
      "json", "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "sh", "bash", "rs", "go",
      "java", "c", "cc", "cpp", "h", "hpp", "yml", "yaml", "toml", "ini", "conf",
      "css", "scss", "sql", "xml", "env", "gitignore", "dockerfile",
    ].includes(ext)
  ) {
    return "code";
  }
  return "text";
}

function imgMime(name: string): string {
  switch (extOf(name)) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "bmp":
      return "image/bmp";
    case "svg":
      return "image/svg+xml";
    case "ico":
      return "image/x-icon";
    default:
      return "application/octet-stream";
  }
}

function decodeB64Text(b64: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(b64ToBytes(b64));
  } catch {
    return "";
  }
}

function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function joinPath(dir: string, name: string): string {
  if (!dir) return `/${name}`;
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

function parentOf(path: string): string {
  if (!path || path === "/") return "/";
  const trimmed = path.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i <= 0 ? "/" : trimmed.slice(0, i);
}

export default function App() {
  const busRef = useRef(new SessionBus());
  const bus = busRef.current;

  const [module, setModule] = useState<ModuleKey>("remote");
  const [sideTab, setSideTab] = useState<"sessions" | "files">("sessions");
  const [profiles, setProfiles] = useState<ConnectionProfile[]>([]);
  const [sessions, setSessions] = useState<OpenSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  /**
   * 所有提示都只走底部状态栏（`statusMsg`）。
   * 曾经有过一个中央浮层 toast，用户明确要求"不要在这里悬浮任何消息"——已彻底移除。
   */
  const [statusMsg, setStatusMsg] = useState<{
    text: string;
    at: number;
    kind: "info" | "warn" | "error";
  } | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ ...EMPTY_PROFILE });

  // 记录「被折叠」的服务器（默认全展开，新加的服务器也是展开的）
  const [collapsedServers, setCollapsedServers] = useState<string[]>([]);
  const [ctxMenu, setCtxMenu] = useState<{
    profile: ConnectionProfile;
    x: number;
    y: number;
  } | null>(null);
  const [editDialog, setEditDialog] = useState<{
    draft: ConnectionProfile;
    isNew: boolean;
  } | null>(null);

  const [tmuxTarget, setTmuxTarget] = useState<ConnectionProfile | null>(null);
  const [tmuxSessions, setTmuxSessions] = useState<TmuxSession[]>([]);
  const [tmuxLoading, setTmuxLoading] = useState(false);

  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [newDialog, setNewDialog] = useState<{
    profileId: string;
    useTmux: boolean;
    tmuxKind: "new" | "attach";
    tmuxName: string;
    attachTarget: string;
    user: string;
    rememberUser: boolean;
  } | null>(null);
  const [dialogTmux, setDialogTmux] = useState<TmuxSession[]>([]);
  const [dialogBusy, setDialogBusy] = useState(false);

  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [settingsReady, setSettingsReady] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  // 终端配色对话框（视图菜单 / 设置里都能打开）
  const [showTermTheme, setShowTermTheme] = useState(false);
  const [showServers, setShowServers] = useState(false);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  // 在「新建会话」弹窗里点「＋ 新建服务器」时，保存后要回到新建会话弹窗
  const [reopenNewAfterSave, setReopenNewAfterSave] = useState(false);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [showSidebar, setShowSidebar] = useState(true);
  // 分屏：paneLayout 决定有几格，panes 存每格放哪个会话
  const [paneLayout, setPaneLayout] = useState<"single" | "v2" | "h2" | "v3" | "grid4">(
    "single",
  );
  const [panes, setPanes] = useState<(string | null)[]>([]);
  const [focusedPane, setFocusedPane] = useState(0);
  // 命令面板（Ctrl+Shift+P）
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  // 右侧 AI Agent 面板
  const [aiPanelOpen, setAiPanelOpen] = useState(false);
  const [aiState, setAiState] = useState<AiProbe | null>(null);
  const [aiNotices, setAiNotices] = useState<{ id: string; text: string; time: number }[]>([]);
  const aiWasRunning = useRef(false);
  const [updateMsg, setUpdateMsg] = useState("");
  const [updateBusy, setUpdateBusy] = useState(false);
  /** 检查到新版本时记下可下载的产物，设置面板里会给出「立即下载」按钮 */
  const [updateOffer, setUpdateOffer] = useState<{
    version: string;
    installerUrl: string;
    installerSize: number;
    msiUrl: string;
    msiSize: number;
    zipUrl: string;
    pageUrl: string;
  } | null>(null);
  /** 当前这份是怎么装上的：nsis / msi / portable */
  const [installKind, setInstallKind] = useState<string>("");
  const [updateApplying, setUpdateApplying] = useState(false);
  // tmux 快捷操作面板（只在当前会话是 tmux 会话时出现）
  const [tmuxDockOpen, setTmuxDockOpen] = useState(true);
  const [tmuxWinList, setTmuxWinList] = useState<TmuxWindow[]>([]);
  const [tmuxBusy, setTmuxBusy] = useState(false);
  // 正在重命名窗口时的临时输入（用自绘输入框，不弹浏览器 prompt）
  const [tmuxRename, setTmuxRename] = useState<string | null>(null);

  const [adbList, setAdbList] = useState<AdbDevice[]>([]);
  const [adbVer, setAdbVer] = useState("");
  const [adbLoading, setAdbLoading] = useState(false);
  const [fbVer, setFbVer] = useState("");
  const [fbList, setFbList] = useState<AdbDevice[]>([]);
  const [serialPorts, setSerialPorts] = useState<SerialPortInfo[]>([]);
  const [serialLoading, setSerialLoading] = useState(false);
  // ADB 文件浏览器
  const [adbSerial, setAdbSerial] = useState<string | null>(null);
  const [adbPath, setAdbPath] = useState("/sdcard");
  const [adbFiles, setAdbFiles] = useState<AdbFile[]>([]);
  const [adbNewName, setAdbNewName] = useState("");
  const [serialDialog, setSerialDialog] = useState<{
    isNew: boolean;
    draft: ConnectionProfile;
  } | null>(null);
  const [serialMenu, setSerialMenu] = useState<{
    profile: ConnectionProfile;
    x: number;
    y: number;
  } | null>(null);

  const [fsPath, setFsPath] = useState("");
  const [fsInput, setFsInput] = useState("");
  const [fsEntries, setFsEntries] = useState<RemoteEntry[]>([]);
  const [fsLoading, setFsLoading] = useState(false);
  const [fsBusy, setFsBusy] = useState(false);
  const [fsMenu, setFsMenu] = useState<{
    profileId: string;
    name: string;
    isDir: boolean;
    x: number;
    y: number;
  } | null>(null);
  const [nameDialog, setNameDialog] = useState<{
    mode: "mkdir" | "rename";
    profileId: string;
    dir: string;
    from: string;
    value: string;
  } | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<{
    title: string;
    message: string;
    okLabel?: string;
    onOk: () => void;
  } | null>(null);
  const [tabMenu, setTabMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [sessionRename, setSessionRename] = useState<{ id: string; value: string } | null>(null);
  // 供异步流程（如自动演示）读取最新路径，避免闭包拿到旧值
  const fsPathRef = useRef(fsPath);
  fsPathRef.current = fsPath;
  const sessionsRef = useRef<OpenSession[]>(sessions);
  sessionsRef.current = sessions;
  const profilesRef = useRef<ConnectionProfile[]>(profiles);
  profilesRef.current = profiles;
  // 自动检查更新用的是定时器回调，闭包里的 settings 会过期，所以这里存一份最新的
  const settingsRef = useRef<AppSettings>(settings);
  settingsRef.current = settings;
  // 字号（Ctrl + 滚轮 / Ctrl + +/- 用）：ref 里放"还没落盘"的临时值，避免连点时读到旧值
  const fontRef = useRef<number | null>(null);
  const fontSaveTimer = useRef<number | null>(null);
  const serialPortsRef = useRef<SerialPortInfo[]>([]);
  // 远程文件浏览器属于「当前会话」，所以读目录/读文件也要用当前会话实际登录的用户
  const activeUserRef = useRef<string | undefined>(undefined);
  const reconnectTimers = useRef<Record<string, number>>({});
  const reconnectTries = useRef<Record<string, number>>({});

  const [gitPath, setGitPath] = useState("");
  const [gitState, setGitState] = useState<GitStatus | null>(null);
  const [gitLoading, setGitLoading] = useState(false);
  const [gitInitDialog, setGitInitDialog] = useState<{ path: string } | null>(null);
  const [gitMessage, setGitMessage] = useState("");
  const [gitCommits, setGitCommits] = useState<GitCommit[]>([]);
  const [gitBranchList, setGitBranchList] = useState<GitBranch[]>([]);
  const [gitBusy, setGitBusy] = useState(false);
  const [showBranches, setShowBranches] = useState(false);
  const [newBranch, setNewBranch] = useState("");
  const [diffDialog, setDiffDialog] = useState<{ title: string; text: string } | null>(null);
  // 密码（存在 Windows 凭据管理器里，不写进配置文件）
  const [editPassword, setEditPassword] = useState("");
  const [editHasPassword, setEditHasPassword] = useState(false);
  // 文件传输进度（右下角那个小面板）
  const [transfers, setTransfers] = useState<
    {
      id: string;
      name: string;
      done: number;
      total: number;
      status: "running" | "done" | "failed";
      message?: string;
    }[]
  >([]);

  useEffect(() => {
    void refresh();
    void (async () => {
      try {
        setSettings({ ...DEFAULT_SETTINGS, ...(await settingsGet()) });
      } catch {
        /* 设置读取失败就用默认值 */
      } finally {
        setSettingsReady(true);
      }
    })();
    // 一次性问清楚"这份是怎么装上的"，决定后面给不给一键升级按钮
    void updateInstallKind()
      .then(setInstallKind)
      .catch(() => setInstallKind("portable"));
  }, []);

  /**
   * 后台自动检查更新。
   *
   * 时机：开机/启动应用时如果距上次检查超过 6 小时就查一次；之后每 30 分钟看一次表，
   * 仍然要求间隔满 6 小时才真的发请求 —— 也就是「一天最多几次」，不会来回骚扰。
   */
  useEffect(() => {
    if (!settingsReady) return;
    const MIN_INTERVAL_SECS = 6 * 3600;
    const due = () =>
      Date.now() / 1000 - (settingsRef.current.lastUpdateCheck ?? 0) > MIN_INTERVAL_SECS;
    if (due()) void checkForUpdates({ silent: true });
    const timer = window.setInterval(
      () => {
        if (due()) void checkForUpdates({ silent: true });
      },
      30 * 60 * 1000,
    );
    return () => window.clearInterval(timer);
    // 只在"设置读好了"这一刻挂上定时器，之后靠 settingsRef 取最新值
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsReady]);

  // ---------- 右侧 AI 面板：探测 / 安装 / 启动 / 完成通知 ----------
  async function refreshAi() {
    const cur = sessionsRef.current.find((s) => s.id === activeId);
    if (!cur?.profileId) {
      setAiState(null);
      return;
    }
    try {
      const probe = await aiProbe(cur.profileId, cur.user ?? null);
      setAiState(probe);
      // 之前有 AI 在跑、现在没有了 → 认为这一轮跑完，给个通知
      const running = probe.running.length > 0;
      if (aiWasRunning.current && !running) {
        pushAiNotice("AI 任务看起来已经跑完了（进程已退出）");
      }
      aiWasRunning.current = running;
    } catch (e) {
      setAiState(null);
      console.warn("ai_probe 失败：" + String(e));
    }
  }

  function pushAiNotice(text: string) {
    const item = { id: uid(), text, time: Date.now() };
    setAiNotices((prev) => [item, ...prev].slice(0, 20));
    // 只进状态栏 + AI 面板的列表，不弹中央 toast（那玩意儿挡视线）
    notify(text);
  }

  // 面板打开时探测一次，之后每 8 秒刷一次（既看安装状态，也看有没有跑完）
  useEffect(() => {
    if (!aiPanelOpen) return;
    void refreshAi();
    const t = window.setInterval(() => void refreshAi(), 8000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiPanelOpen, activeId]);

  /** 在当前会话的终端里启动 AI（就是把命令敲进去，你能看到它跑） */
  function aiStartTool(tool: string) {
    const cur = sessionsRef.current.find((s) => s.id === activeId);
    if (!cur) {
      notify("先打开一个会话");
      return;
    }
    // 注意：Windows 的 PowerShell / CMD 需要回车 \r 才会执行命令，
    // 发 \n 只会得到续行提示符（Linux 下 \r 一样能提交）。统一用 \r。
    void sessionWrite(cur.id, bytesToB64(new TextEncoder().encode(`${tool}\r`)));
    aiWasRunning.current = true;
    pushAiNotice(`已在「${cur.title}」里启动 ${tool}，它跑完我会提醒你`);
  }

  /**
   * 干掉 WebView2 / Edge **自带的**右键菜单。
   * 用户看到的那些"刷新""从左到右书写""从右到左书写""语音"全都是浏览器菜单，
   * 不是我们做的 —— 对一个终端工具来说纯属噪音。
   * 我们自己的菜单是自己画的（组件里 onContextMenu → preventDefault → 渲染自定义菜单），
   * React 的事件委托挂在 #root 上，会比这里的 document 监听先执行，所以不受影响。
   */
  useEffect(() => {
    const blockNativeMenu = (e: MouseEvent) => {
      e.preventDefault();
    };
    document.addEventListener("contextmenu", blockNativeMenu);
    return () => document.removeEventListener("contextmenu", blockNativeMenu);
  }, []);

  // 命令面板：Ctrl+Shift+P 打开，输入过滤，回车执行
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && (e.key === "P" || e.key === "p" || e.code === "KeyP")) {
        e.preventDefault();
        setPaletteQuery("");
        setPaletteOpen((v) => !v);
      } else if (e.key === "Escape") {
        setPaletteOpen(false);
      } else if (e.ctrlKey && !e.altKey) {
        // 字体缩放：Ctrl + ＋ / － / 0（和浏览器、VS Code 一个习惯）
        // 这几个组合键在 shell / tmux 里都没有含义，抢过来不会影响终端输入
        const k = e.key;
        if (k === "+" || k === "=" || e.code === "NumpadAdd") {
          e.preventDefault();
          bumpFont(1);
        } else if (k === "-" || k === "_" || e.code === "NumpadSubtract") {
          e.preventDefault();
          bumpFont(-1);
        } else if (k === "0" || e.code === "Numpad0") {
          e.preventDefault();
          applyFontSize(13);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /** 命令面板里能搜到的所有命令：菜单里的每一项 + 几个常用操作 */
  function allCommands(): { label: string; group: string; run: () => void }[] {
    const out: { label: string; group: string; run: () => void }[] = [];
    for (const menu of buildMenus()) {
      for (const item of menu.items) {
        if (!item.sep && item.label && item.action) {
          out.push({ label: item.label, group: menu.label, run: item.action });
        }
      }
    }
    out.push(
      { label: "打开设置", group: "首选项", run: () => setShowSettings(true) },
      { label: "终端配色", group: "首选项", run: () => setShowTermTheme(true) },
      { label: "服务器管理", group: "首选项", run: () => setShowServers(true) },
      {
        label: "文件面板：同步到终端目录",
        group: "远程文件",
        run: () => {
          if (fileProfileId) void syncFsToTerminal(fileProfileId, activeTmuxName, activeSession?.cwd);
        },
      },
      {
        label: "文件面板：上传文件到当前目录",
        group: "远程文件",
        run: () => {
          if (fileProfileId) void uploadToRemote(fileProfileId);
        },
      },
      { label: "Git：打开本地仓库", group: "Git", run: () => void openGitWorkspace() },
      { label: "Git：新建仓库（git init）", group: "Git", run: () => setGitInitDialog({ path: "" }) },
      { label: "关闭全部本地终端", group: "终端", run: () => void closeSessions(localTerminals, "本地终端") },
      { label: "关闭全部会话", group: "终端", run: () => void closeSessions(sessions, "会话") },
      { label: "关于 ZeeAI Terminal", group: "帮助", run: () => setShowAbout(true) },
      {
        label: "检查更新",
        group: "帮助",
        run: () => {
          setShowAbout(true);
          void checkForUpdates();
        },
      },
    );
    return out;
  }

  /**
   * 兜底：只要还有会话，主区域就不该是空的。
   * 关闭标签、批量关会话、会话异常退出……任何路径让 activeId 失效时，
   * 这里都会把它接到最后一个会话上（以前会留下一片黑）。
   */
  useEffect(() => {
    if (sessions.length === 0) {
      if (activeId !== null) setActiveId(null);
      return;
    }
    if (!activeId || !sessions.some((s) => s.id === activeId)) {
      setActiveId(sessions[sessions.length - 1].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, activeId]);

  // ---------- 工作区恢复：退出前存快照，下次打开时把会话重新拉起来 ----------
  const restoredRef = useRef(false);
  // 恢复流程结束前不许写快照，否则启动 1 秒内就把"待恢复的快照"覆盖成空的
  const [restoreDone, setRestoreDone] = useState(false);
  const [workspaceHint, setWorkspaceHint] = useState<string | null>(null);

  useEffect(() => {
    if (!settingsReady || restoredRef.current) return;
    restoredRef.current = true;
    if (!settings.restoreWorkspace) {
      setRestoreDone(true);
      return;
    }
    void (async () => {
      let raw: string | null = null;
      try {
        raw = await workspaceLoad();
      } catch {
        setRestoreDone(true);
        return;
      }
      if (!raw) {
        setRestoreDone(true);
        return;
      }
      let data: SavedWorkspace;
      try {
        data = JSON.parse(raw) as SavedWorkspace;
      } catch {
        setRestoreDone(true);
        return;
      }
      const list = profilesRef.current;
      // 上限：快照里如果攒了很多（比如演示反复跑），一次全开会把服务器的
      // sshd 打满（MaxStartups）而且标签栏会炸，所以只恢复最近的 8 个。
      const MAX_RESTORE = 8;
      const allSaved = data.sessions ?? [];
      const saved = allSaved.slice(-MAX_RESTORE);
      if (saved.length === 0) {
        setRestoreDone(true);
        return;
      }
      setWorkspaceHint(`正在恢复上次的 ${saved.length} 个会话…`);
      const ids: string[] = [];
      for (let i = 0; i < saved.length; i++) {
        const s = saved[i];
        // 一条一条来，中间留一点间隔，避免瞬间并发一堆 SSH 连接
        if (i > 0) await new Promise((r) => setTimeout(r, 250));
        try {
          if (s.kind === "remote" && s.profileId) {
            const p = list.find((x) => x.id === s.profileId);
            if (!p) continue;
            const id = await openSshSession(
              p,
              s.tmuxMode ?? "default",
              s.tmuxName ?? null,
              s.user ?? null,
              s.title ?? null,
            );
            ids.push(id);
          } else if (s.kind === "powershell" || s.kind === "cmd" || s.kind === "wsl") {
            const id = await openLocalSession(s.kind, undefined, s.cwd, s.title);
            ids.push(id);
          } else if (s.kind === "serial") {
            const p = list.find((x) => x.type === "serial" && x.name === s.title);
            if (!p) continue;
            const id = await openSerialSession(p);
            ids.push(id);
          }
        } catch {
          /* 单个会话恢复失败不影响其它 */
        }
      }
      if (ids.length > 0) {
        const idx = Math.min(Math.max(data.activeIndex ?? 0, 0), ids.length - 1);
        setActiveId(ids[idx]);
      }
      setWorkspaceHint(null);
      setRestoreDone(true);
      if (ids.length > 0) {
        notify(
          allSaved.length > MAX_RESTORE
            ? `已恢复最近 ${ids.length} 个会话（快照里还有 ${allSaved.length - MAX_RESTORE} 个更早的没开）`
            : `已恢复上次的 ${ids.length} 个会话`,
        );
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsReady]);

  // 会话有变化就把快照写下去（防抖，不写文件内容）
  useEffect(() => {
    if (!settingsReady || !settings.restoreWorkspace || !restoreDone) return;
    const snapshot: SavedWorkspace = {
      version: 1,
      savedAt: Date.now(),
      activeIndex: Math.max(
        0,
        sessions.findIndex((s) => s.id === activeId),
      ),
      sessions: sessions.map((s) => ({
        kind: s.kind,
        title: s.title,
        profileId: s.profileId,
        user: s.user,
        tmuxName: s.tmuxName,
        tmuxMode: s.tmuxMode,
        cwd: s.cwd,
      })),
    };
    const t = window.setTimeout(() => {
      void workspaceSave(JSON.stringify(snapshot)).catch(() => {
        /* 存不下就算了，不影响使用 */
      });
    }, 700);
    return () => window.clearTimeout(t);
  }, [sessions, activeId, settingsReady, settings.restoreWorkspace, restoreDone]);

  // 文件传输进度：后端用 emit 推过来，这里维护右下角那个进度面板
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void listen<TransferEvent>("zeeai://transfer", (ev) => {
      const e = ev.payload;
      if (e.kind === "allDone") {
        // 整批结束后留一会儿再收起来，让用户看得到结果
        window.setTimeout(() => {
          setTransfers((cur) => cur.filter((t) => !t.id.startsWith(`${e.task}:`)));
        }, 3500);
        return;
      }
      const key = `${e.task}:${e.name}`;
      setTransfers((prev) => {
        const idx = prev.findIndex((t) => t.id === key);
        const next = [...prev];
        if (e.kind === "start") {
          if (idx < 0) {
            next.push({
              id: key,
              name: e.name,
              done: 0,
              total: e.total,
              status: "running",
            });
          }
          return next;
        }
        if (idx < 0) {
          next.push({ id: key, name: e.name, done: 0, total: 0, status: "running" });
        }
        const i = next.findIndex((t) => t.id === key);
        if (e.kind === "progress") {
          next[i] = { ...next[i], done: e.done, total: e.total, status: "running" };
        } else if (e.kind === "fileDone") {
          next[i] = {
            ...next[i],
            done: e.bytes || next[i].done,
            total: next[i].total || e.bytes,
            status: "done",
          };
        } else if (e.kind === "fileFailed") {
          next[i] = { ...next[i], status: "failed", message: e.message };
        }
        return next;
      });
    }).then((f) => {
      unlisten = f;
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  // 让 Windows 原生的标题栏（最上面那条）也跟着主题走。
  // 不设置的话，即使应用里是深色，标题栏还是系统浅色的白条。
  useEffect(() => {
    const kind = themeKind(settings.theme);
    void getCurrentWindow()
      .setTheme(kind)
      .catch(() => {
        /* 某些系统上不支持就忽略，不影响主界面 */
      });
  }, [settings.theme]);

  useEffect(() => {
    void (async () => {
      try {
        setHistory(await historyList());
      } catch {
        /* 历史读取失败不影响主流程 */
      }
    })();
  }, []);

  useEffect(() => {
    // 只探测版本（不会启动 adb server，也就不会弹防火墙授权框）；
    // 设备列表要等用户主动点「刷新设备」——那一步才会启动 adb server。
    if (module === "adb") {
      void (async () => {
        try {
          setAdbVer(await adbVersion());
        } catch {
          setAdbVer("");
        }
      })();
    }
    if (module === "serial") void refreshSerial();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [module]);

  // 自动化演示（ZEEAI_AUTODEMO=1）：连接 → 切到文件 → 打开 md/html 预览，
  // 供无人值守截图验证。仅在演示模式下触发，正常使用不会走到这里。
  const demoRef = useRef({ profiles, started: false });
  demoRef.current.profiles = profiles;
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void listen("zeeai://autodemo", () => {
      void (async () => {
        if (demoRef.current.started) return;
        demoRef.current.started = true;
        const list = demoRef.current.profiles;
        const profile = list.find((p) => p.ssh) ?? list[0];
        if (!profile) return;
        const id = await openSshSession(profile);
        await new Promise((r) => setTimeout(r, 15000));
        setSideTab("files");
        // 演示「文件面板跟随终端目录」：先真的在终端里 cd，再点刷新
        await sessionWrite(id, bytesToB64(new TextEncoder().encode("cd /tmp/zeeai-demo\n")));
        await new Promise((r) => setTimeout(r, 3000));
        const tmux = sessionsRef.current.find((s) => s.id === id)?.tmuxName;
        await refreshFs(profile.id, tmux, undefined);
        await new Promise((r) => setTimeout(r, 8000));
        await openRemoteFile(profile.id, "README-demo.md", id);
        await new Promise((r) => setTimeout(r, 10000));
        await openRemoteFile(profile.id, "demo.html", id);
        await new Promise((r) => setTimeout(r, 10000));
        // 顺便把 ADB 面板、菜单、设置界面都展示一遍，便于无人值守截图验证
        setModule("adb");
        await new Promise((r) => setTimeout(r, 12000));
        setModule("serial");
        await new Promise((r) => setTimeout(r, 14000));
        // 注意：演示**不再自动打开串口终端**。
        // 用户机器上的串口（比如 COM5）可能正被别的项目占用，自动化脚本去打开它会把人家的程序踢掉。
        // 串口面板本身的截图仍然保留（列表是只读枚举，不占用端口）。
        // Git 面板 + Git 工作空间（在仓库目录起本地终端）
        setModule("git");
        const repo = "D:\\AI\\ZeeAI_term";
        setGitPath(repo);
        setGitLoading(true);
        try {
          setGitState(await gitStatus(repo));
        } catch {
          /* 演示用，读不到就算了 */
        }
        setGitLoading(false);
        const demoWs: ConnectionProfile = {
          id: uid(),
          type: "local",
          name: "ZeeAI_term · git",
          group: "Git 工作空间",
          local: { shell: settings.defaultShell, cwd: repo },
        };
        try {
          // 演示重复跑的时候别把同一条工作空间塞进去好几次
          const cur = await listProfiles();
          if (!cur.some((p) => p.type === "local" && p.local?.cwd === repo)) {
            await saveProfile(demoWs);
            await refresh();
          }
        } catch {
          /* 演示用 */
        }
        await openLocalSession(settings.defaultShell, undefined, repo, "ZeeAI_term · git");
        await new Promise((r) => setTimeout(r, 14000));
        // 本地终端模块：开几个会话，验证侧栏能列出「已打开的会话」
        setModule("powershell");
        await openLocalSession("powershell", undefined, repo);
        await new Promise((r) => setTimeout(r, 8000));
        setModule("cmd");
        await openLocalSession("cmd", undefined, repo);
        await new Promise((r) => setTimeout(r, 8000));
        setModule("powershell");
        await new Promise((r) => setTimeout(r, 10000));
        // 终端日志端到端验证：开一个终端 -> 开始记录 -> 打点东西 -> 停止
        {
          const logSid = await openLocalSession("powershell", undefined, repo, "日志验证");
          await new Promise((r) => setTimeout(r, 3000));
          await startSessionLog({ id: logSid, title: "日志验证" });
          await new Promise((r) => setTimeout(r, 1000));
          await sessionWrite(
            logSid,
            bytesToB64(
              new TextEncoder().encode("echo ZEEAI-LOG-CHECK-12345; echo 第二行中文\r"),
            ),
          );
          await new Promise((r) => setTimeout(r, 3000));
          await stopSessionLog({ id: logSid });
          await new Promise((r) => setTimeout(r, 2000));
        }
        // 验证「关掉当前标签后应自动切到相邻会话」：关掉第一个标签再截图
        const firstTab = sessionsRef.current[0];
        if (firstTab) {
          setActiveId(firstTab.id);
          await new Promise((r) => setTimeout(r, 2000));
          await closeSession(firstTab.id);
        }
        await new Promise((r) => setTimeout(r, 8000));
        // 分屏演示：左右两分屏（左边 SSH，右边本地 PowerShell）
        setPaneLayout("v2");
        await new Promise((r) => setTimeout(r, 10000));
        setPaneLayout("single");
        await new Promise((r) => setTimeout(r, 4000));
        // AI Agent 面板
        setAiPanelOpen(true);
        await new Promise((r) => setTimeout(r, 14000));
        // 命令面板（Ctrl+Shift+P）
        setPaletteQuery("");
        setPaletteOpen(true);
        await new Promise((r) => setTimeout(r, 12000));
        setPaletteOpen(false);
        setModule("remote");
        setSideTab("sessions");
        // 演示文件传输进度条：把一个十几 MB 的文件传上去，进度能看清楚
        try {
          const bigLocal = "D:\\AI\\ZeeAI_term\\src-tauri\\target\\release\\zeeai-terminal.exe";
          await fsUpload(profile.id, [bigLocal], "/tmp/zeeai-demo", null, uid());
        } catch {
          /* 演示用：传不上去也不影响后面流程 */
        }
        await new Promise((r) => setTimeout(r, 12000));
        openNewSessionDialog(profile);
        await new Promise((r) => setTimeout(r, 16000));
        setNewDialog(null);
        setShowServers(true);
        await new Promise((r) => setTimeout(r, 16000));
        setShowServers(false);
        setShowSettings(true);
        await new Promise((r) => setTimeout(r, 18000));
        setShowSettings(false);
        await new Promise((r) => setTimeout(r, 1500));
        // 验证：终端右键应该弹出我们自己的菜单（复制/粘贴/全选/清屏），
        // 而不是 WebView2 自带的"刷新 / 从左到右书写 / 语音"
        const termHost = document.querySelector(".terminal-host") as HTMLElement | null;
        termHost?.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: 600,
            clientY: 420,
          }),
        );
        await new Promise((r) => setTimeout(r, 15000));
        const backdrop = document.querySelector(".ctx-backdrop") as HTMLElement | null;
        backdrop?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        // 验证：错误提示只出现在底部状态栏（红底 + 闪一下），不再有中央浮层
        notify("测试：这是一条错误提示 —— 应该出现在底部状态栏并闪红，而不是悬浮在窗口中间");
        await new Promise((r) => setTimeout(r, 15000));
      })();
    }).then((f) => {
      unlisten = f;
    });
    return () => {
      if (unlisten) unlisten();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeSession = sessions.find((s) => s.id === activeId) ?? null;
  const activeFile =
    activeSession && activeSession.activeTab !== "terminal"
      ? activeSession.openFiles.find((f) => f.name === activeSession.activeTab) ?? null
      : null;

  const fileProfileId = activeSession?.profileId ?? null;
  const fileProfile = profiles.find((p) => p.id === fileProfileId) ?? null;
  activeUserRef.current = activeSession?.user;
  serialPortsRef.current = serialPorts;
  const activeTmuxName = activeSession?.tmuxName ?? undefined;

  useEffect(() => {
    if (!fileProfileId) {
      setFsPath("");
      setFsEntries([]);
      return;
    }
    void refreshFs(fileProfileId, activeTmuxName, activeSession?.cwd, undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileProfileId, activeId, activeTmuxName, settings.fsFollowTerminal]);

  async function refresh() {
    try {
      setProfiles(await listProfiles());
    } catch (e) {
      notify("读取连接配置失败：" + String(e));
    }
  }

  function handleEvent(sessionId: string, e: SessionEvent) {
    switch (e.type) {
      case "data":
        bus.push(sessionId, b64ToBytes(e.data));
        break;
      case "state":
        setSessions((prev) =>
          prev.map((s) => (s.id === sessionId ? { ...s, state: e.state } : s)),
        );
        if (e.state === "closed") scheduleReconnect(sessionId);
        break;
      case "title":
        setSessions((prev) =>
          prev.map((s) => (s.id === sessionId ? { ...s, title: e.title || s.title } : s)),
        );
        break;
      case "error":
        notify(e.message);
        setSessions((prev) =>
          prev.map((s) => (s.id === sessionId ? { ...s, state: "error" } : s)),
        );
        break;
      case "cwd":
        setSessions((prev) =>
          prev.map((s) => (s.id === sessionId ? { ...s, cwd: e.path } : s)),
        );
        break;
    }
  }

  /**
   * shell 通过 OSC 7 上报的当前目录（非 tmux 会话也能拿到）。
   * 只更新会话状态，不主动跳转目录——跳转由「同步终端目录」按钮触发。
   */
  function handleTerminalCwd(sessionId: string, path: string) {
    const clean = path.replace(/\/+$/, "") || "/";
    setSessions((prev) => {
      const cur = prev.find((s) => s.id === sessionId);
      if (!cur || cur.cwd === clean) return prev;
      return prev.map((s) => (s.id === sessionId ? { ...s, cwd: clean } : s));
    });
  }

  function addSession(s: OpenSession) {
    setSessions((prev) => [...prev, s]);
    setActiveId(s.id);
  }

  // ---------- 终端日志（SecureCRT 那种会话记录） ----------

  /** 日志文件名：会话名 + 本地时间（后端只负责落盘，命名由前端给，省一个日期库） */
  function logFileName(title: string) {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    return `${title}-${stamp}`;
  }

  async function startSessionLog(s: { id: string; title: string }) {
    try {
      const path = await sessionLogStart(s.id, logFileName(s.title));
      setSessions((prev) =>
        prev.map((x) => (x.id === s.id ? { ...x, logPath: path } : x)),
      );
      notify(`已开始记录日志：${path}`);
      return path;
    } catch (e) {
      notify("开始记录日志失败：" + String(e));
      return null;
    }
  }

  async function stopSessionLog(s: { id: string }) {
    try {
      const path = await sessionLogStop(s.id);
      setSessions((prev) =>
        prev.map((x) => (x.id === s.id ? { ...x, logPath: undefined } : x)),
      );
      notify(path ? `已停止记录日志：${path}` : "这个会话没有在记日志");
    } catch (e) {
      notify("停止记录日志失败：" + String(e));
    }
  }

  /** 打开日志文件；没在记就打开日志目录 */
  async function openSessionLog(s: { logPath?: string }) {
    try {
      if (s.logPath) {
        await openInExplorer(s.logPath);
      } else {
        await openInExplorer(await sessionLogDir());
      }
    } catch (e) {
      notify("打开日志失败：" + String(e));
    }
  }

  /** 新会话按设置决定要不要自动开日志 */
  function maybeAutoLog(s: { id: string; title: string }) {
    if (settings.autoLog) void startSessionLog(s);
  }

  /**
   * 统一的提示入口 —— **只写底部状态栏，不做任何悬浮弹层**。
   * 按内容分成三档，用颜色/符号区分：
   *   info  完成类（已上传、已删除、AI 跑完…）→ ✓
   *   warn  需要留意但不致命（还没好、已重试 N 次…）→ ⚠ 琥珀黄
   *   error 出错（失败、无法、请先…）→ ❗ 红底加粗并闪一下
   */
  function notify(text: string) {
    const kind: "info" | "warn" | "error" = /失败|错误|不能|请|无法|不支持|被拒绝|不正确|超时|不存在|为空/.test(
      text,
    )
      ? "error"
      : /还没|没有|已尝试|重试|注意|不可|未/.test(text)
        ? "warn"
        : "info";
    setStatusMsg({ text, at: Date.now(), kind });
  }

  // 状态栏提示自动消失（错误留久一点，让你看清）
  useEffect(() => {
    if (!statusMsg) return;
    const ttl = statusMsg.kind === "error" ? 12000 : 8000;
    const t = window.setTimeout(() => {
      setStatusMsg((cur) => (cur && cur.at === statusMsg.at ? null : cur));
    }, ttl);
    return () => window.clearTimeout(t);
  }, [statusMsg]);

  async function openLocalSession(
    shell: "powershell" | "cmd" | "wsl",
    distro?: string,
    cwd?: string,
    titleOverride?: string,
  ): Promise<string> {
    const id = uid();
    const base =
      shell === "wsl" ? "WSL" + (distro ? " · " + distro : "") : shell === "cmd" ? "命令提示符" : "PowerShell";
    // 同一个模块开多个时编号，方便在侧栏/标签里区分（PowerShell、PowerShell 2、…）
    const sameKind = sessionsRef.current.filter((s) => s.kind === shell).length + 1;
    const title = titleOverride?.trim() || (sameKind > 1 ? `${base} ${sameKind}` : base);
    addSession({
      id,
      title,
      kind: shell,
      cwd,
      state: "connecting",
      openFiles: [],
      activeTab: "terminal",
    });
    maybeAutoLog({ id, title });
    try {
      const info = await openLocal(id, shell, (e) => handleEvent(id, e), distro, undefined, undefined, cwd);
      setSessions((prev) =>
        prev.map((s) => (s.id === id ? { ...s, title: titleOverride?.trim() ? title : info.title || title } : s)),
      );
    } catch (e) {
      notify("打开本地终端失败：" + String(e));
    }
    return id;
  }

  async function openSshSession(
    profile: ConnectionProfile,
    tmuxMode: "default" | "none" | "name" = "default",
    tmuxName?: string | null,
    userOverride?: string | null,
    titleOverride?: string | null,
  ): Promise<string> {
    const id = uid();
    const explicitName = tmuxMode === "name" && tmuxName ? tmuxName : null;
    const title =
      titleOverride?.trim() ||
      (explicitName ? `${profile.name} · ${explicitName}` : profile.name);
    addSession({
      id,
      title,
      kind: "remote",
      profileId: profile.id,
      user: userOverride ?? profile.ssh?.user,
      tmuxName: explicitName ?? undefined,
      tmuxMode,
      state: "connecting",
      openFiles: [],
      activeTab: "terminal",
    });
    maybeAutoLog({ id, title });
    try {
      const info = await openSsh(
        id,
        profile.id,
        (e) => handleEvent(id, e),
        tmuxMode,
        tmuxName ?? null,
        undefined,
        undefined,
        userOverride ?? null,
      );
      setSessions((prev) =>
        prev.map((s) =>
          s.id === id
            ? {
                ...s,
                title: titleOverride?.trim() ? title : explicitName ? title : info.title || title,
                tmuxName: info.tmuxSession ?? undefined,
                user: info.user ?? s.user,
              }
            : s,
        ),
      );
      // 记录到会话历史（可在设置里关闭，也可在侧栏里逐条删除）
      if (settings.recordHistory) {
        try {
          setHistory(
            await historySave({
              id: "",
              profileId: profile.id,
              profileName: profile.name,
              host: profile.ssh?.host ?? "",
              tmuxSession: info.tmuxSession ?? null,
              title: titleOverride?.trim() || null,
              lastUsed: 0,
            }),
          );
        } catch {
          /* 历史写入失败不影响会话使用 */
        }
      }
    } catch (e) {
      notify("SSH 连接失败：" + String(e));
      setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, state: "error" } : s)));
    }
    return id;
  }

  async function closeSession(id: string) {
    // 先记下它在标签栏里的位置，关掉之后要顶上来一个
    const list = sessionsRef.current;
    const idx = list.findIndex((s) => s.id === id);
    try {
      await sessionClose(id);
    } catch {
      /* 已断开则忽略 */
    }
    bus.drop(id);
    const next = list.filter((s) => s.id !== id);
    setSessions(next);
    setActiveId((cur) => {
      if (cur !== id) return cur;
      if (next.length === 0) return null;
      // 关掉的是当前标签：优先接右边那个，没有右边就接最后一个（最右边的）
      const at = idx < 0 ? next.length - 1 : Math.min(idx, next.length - 1);
      return next[at].id;
    });
  }

  /** 一次关掉一批会话（「关闭全部本地终端」「关闭全部会话」用这个） */
  async function closeSessions(list: OpenSession[], what: string) {
    if (list.length === 0) {
      notify(`现在没有打开的${what}`);
      return;
    }
    const reallyDo = async () => {
      for (const s of list) {
        try {
          await sessionClose(s.id);
        } catch {
          /* 已经断开 */
        }
        bus.drop(s.id);
      }
      const ids = new Set(list.map((s) => s.id));
      const remaining = sessionsRef.current.filter((s) => !ids.has(s.id));
      setSessions(remaining);
      setActiveId((cur) => {
        if (!cur || !ids.has(cur)) return cur;
        // 当前会话被关掉了：落到剩下的最后一个，别把主区域留空
        return remaining.length > 0 ? remaining[remaining.length - 1].id : null;
      });
      notify(`已关闭 ${list.length} 个${what}`);
    };
    if (list.length === 1) {
      await reallyDo();
      return;
    }
    setConfirmDialog({
      title: `关闭全部${what}`,
      message:
        `要关闭这 ${list.length} 个${what}吗？` +
        (what === "会话" ? "\n（SSH 里的 tmux 会话还在服务器上，重连就能回来）" : ""),
      okLabel: "全部关闭",
      onOk: () => void reallyDo(),
    });
  }

  /** 断线后重连：复用同一个会话 id 与终端，替换后端已被 kill 的进程。 */
  async function reconnectSession(s: OpenSession) {
    if (!s.profileId) return;
    try {
      await sessionClose(s.id);
    } catch {
      /* 已经断开 */
    }
    setSessions((prev) =>
      prev.map((x) => (x.id === s.id ? { ...x, state: "reconnecting" } : x)),
    );
    try {
      await openSsh(
        s.id,
        s.profileId,
        (e) => handleEvent(s.id, e),
        s.tmuxMode ?? "default",
        s.tmuxName ?? null,
        undefined,
        undefined,
        s.user ?? null,
      );
    } catch (e) {
      notify("重连失败：" + String(e));
      setSessions((prev) => prev.map((x) => (x.id === s.id ? { ...x, state: "error" } : x)));
    }
  }

  async function submitProfile() {
    if (!form.host.trim()) {
      notify("请填写主机地址");
      return;
    }
    const p: ConnectionProfile = {
      id: uid(),
      type: "ssh",
      name: form.name.trim() || form.host.trim(),
      group: form.group.trim() || "默认",
      ssh: {
        host: form.host.trim(),
        port: Number(form.port) || 22,
        user: form.user.trim() || "root",
        authKind: "key",
        keyPath: form.keyPath.trim() || undefined,
        tmuxEnabled: settings.tmuxDefault,
        tmuxTemplate: "{host}-{user}",
      },
    };
    try {
      await saveProfile(p);
      setForm({ ...EMPTY_PROFILE });
      setShowForm(false);
      await refresh();
    } catch (e) {
      notify("保存失败：" + String(e));
    }
  }

  async function removeProfile(p: ConnectionProfile) {
    try {
      await deleteProfile(p.id);
      await refresh();
    } catch (e) {
      notify("删除失败：" + String(e));
    }
  }

  function toggleServer(id: string) {
    setCollapsedServers((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  function openEditDialog(profile?: ConnectionProfile) {
    if (profile) {
      setEditDialog({ draft: JSON.parse(JSON.stringify(profile)), isNew: false });
      setEditPassword("");
      void secretHas(profile.id)
        .then(setEditHasPassword)
        .catch(() => setEditHasPassword(false));
      return;
    }
    setEditPassword("");
    setEditHasPassword(false);
    setEditDialog({
      isNew: true,
      draft: {
        id: "",
        type: "ssh",
        name: "",
        group: "默认",
        ssh: {
          host: "",
          port: 22,
          user: "root",
          authKind: "key",
          tmuxEnabled: settings.tmuxDefault,
          tmuxTemplate: "{host}-{user}",
        },
      },
    });
  }

  async function saveEditDialog() {
    if (!editDialog) return;
    const p = editDialog.draft;
    if (!p.ssh?.host.trim()) {
      notify("请填写主机地址");
      return;
    }
    const finalProfile: ConnectionProfile = {
      ...p,
      id: p.id || uid(),
      name: p.name.trim() || p.ssh.host.trim(),
      group: p.group.trim() || "默认",
    };
    try {
      await saveProfile(finalProfile);
      setEditDialog(null);
      await refresh();
      if (reopenNewAfterSave) {
        setReopenNewAfterSave(false);
        openNewSessionDialog(finalProfile);
      }
    } catch (e) {
      notify("保存失败：" + String(e));
    }
  }

  async function duplicateProfile(p: ConnectionProfile) {
    const copy: ConnectionProfile = {
      ...JSON.parse(JSON.stringify(p)),
      id: uid(),
      name: `${p.name} 副本`,
    };
    try {
      await saveProfile(copy);
      await refresh();
    } catch (e) {
      notify("复制失败：" + String(e));
    }
  }

  function patchDraft(
    patch: Partial<ConnectionProfile>,
    sshPatch?: Partial<NonNullable<ConnectionProfile["ssh"]>>,
  ) {
    setEditDialog((prev) => {
      if (!prev) return prev;
      const draft: ConnectionProfile = { ...prev.draft, ...patch };
      if (sshPatch && draft.ssh) {
        draft.ssh = { ...draft.ssh, ...sshPatch };
      }
      return { ...prev, draft };
    });
  }

  async function refreshTmux(profile: ConnectionProfile) {
    setTmuxLoading(true);
    try {
      setTmuxSessions(await tmuxList(profile.id, profile.ssh?.user ?? null));
    } catch (e) {
      notify("读取 tmux 会话失败：" + String(e));
      setTmuxSessions([]);
    } finally {
      setTmuxLoading(false);
    }
  }

  async function killTmux(profile: ConnectionProfile, name: string) {
    try {
      await tmuxKill(profile.id, name, profile.ssh?.user ?? null);
      await refreshTmux(profile);
    } catch (e) {
      notify("结束 tmux 会话失败：" + String(e));
    }
  }

  function defaultTmuxName(profile: ConnectionProfile, userOverride?: string): string {
    const host = profile.ssh?.host ?? "";
    const user = userOverride?.trim() || profile.ssh?.user || "";
    const tpl = profile.ssh?.tmuxTemplate || "{host}-{user}";
    return tpl
      .replace("{host}", host)
      .replace("{user}", user)
      .replace(/[.:/\\ ]/g, "-");
  }

  // ---------- 串口连接（用户自己建的那几条，不再罗列系统里所有 COM 口） ----------

  function openSerialDialog(profile?: ConnectionProfile) {
    if (profile) {
      setSerialDialog({ isNew: false, draft: JSON.parse(JSON.stringify(profile)) });
      void refreshSerial();
      return;
    }
    // 新建议一个默认值：优先挑 USB 串口（蓝牙虚拟串口一般用不上）
    const first =
      serialPorts.find((p) => /usb|ch3|cp21|ftdi|silicon|prolific/i.test(p.label)) ??
      serialPorts[0];
    setSerialDialog({
      isNew: true,
      draft: {
        id: "",
        type: "serial",
        name: first ? `${first.path} · 115200` : "",
        group: "串口",
        serial: {
          path: first?.path ?? "",
          baudRate: 115200,
          dataBits: 8,
          stopBits: 1,
          parity: "none",
          flowControl: "none",
        },
      },
    });
    void refreshSerial();
  }

  function patchSerialDraft(
    patch: Partial<ConnectionProfile>,
    serialPatch?: Partial<SerialConfig>,
  ) {
    setSerialDialog((prev) => {
      if (!prev) return prev;
      const draft: ConnectionProfile = { ...prev.draft, ...patch };
      if (serialPatch && draft.serial) {
        draft.serial = { ...draft.serial, ...serialPatch };
      }
      return { ...prev, draft };
    });
  }

  async function saveSerialDialog(openAfter: boolean) {
    if (!serialDialog) return;
    const p = serialDialog.draft;
    const cfg = p.serial;
    if (!cfg?.path.trim()) {
      notify("请选择或填写串口（例如 COM5）");
      return;
    }
    const finalProfile: ConnectionProfile = {
      ...p,
      id: p.id || uid(),
      name: p.name.trim() || `${cfg.path} · ${cfg.baudRate}`,
      group: p.group.trim() || "串口",
      serial: { ...cfg, path: cfg.path.trim().toUpperCase() },
    };
    try {
      await saveProfile(finalProfile);
      setSerialDialog(null);
      await refresh();
      if (openAfter) await openSerialSession(finalProfile);
    } catch (e) {
      notify("保存失败：" + String(e));
    }
  }

  async function removeSerialProfile(p: ConnectionProfile) {
    try {
      await deleteProfile(p.id);
      await refresh();
    } catch (e) {
      notify("删除失败：" + String(e));
    }
  }

  async function loadDialogTmux(profileId: string, user?: string) {
    setDialogBusy(true);
    try {
      setDialogTmux(await tmuxList(profileId, user ?? null));
    } catch (e) {
      notify("读取 tmux 会话失败：" + String(e));
      setDialogTmux([]);
    } finally {
      setDialogBusy(false);
    }
  }

  function openNewSessionDialog(profile?: ConnectionProfile) {
    const target = profile ?? sshProfiles[0];
    if (!target) {
      notify("还没有服务器配置，先去「连接 → 服务器管理」里加一台");
      return;
    }
    const useTmux = target.ssh?.tmuxEnabled ?? settings.tmuxDefault;
    setNewDialog({
      profileId: target.id,
      useTmux,
      tmuxKind: "new",
      tmuxName: defaultTmuxName(target),
      attachTarget: "",
      user: target.ssh?.user ?? "",
      rememberUser: true,
    });
    if (useTmux) void loadDialogTmux(target.id, target.ssh?.user);
  }

  async function confirmNewSession() {
    if (!newDialog) return;
    const profile = profiles.find((p) => p.id === newDialog.profileId);
    if (!profile) return;
    if (newDialog.useTmux && newDialog.tmuxKind === "attach" && !newDialog.attachTarget) {
      notify("请选择一个要附加的 tmux 会话");
      return;
    }
    setDialogBusy(true);
    try {
      const wantedUser = newDialog.user.trim();
      if (wantedUser && wantedUser !== (profile.ssh?.user ?? "") && newDialog.rememberUser) {
        await saveProfile({
          ...profile,
          ssh: { ...(profile.ssh as NonNullable<ConnectionProfile["ssh"]>), user: wantedUser },
        });
        await refresh();
      }
      const userOverride = wantedUser || null;
      if (!newDialog.useTmux) {
        await openSshSession(profile, "none", null, userOverride);
      } else if (newDialog.tmuxKind === "new") {
        const name = newDialog.tmuxName.trim() || defaultTmuxName(profile);
        await openSshSession(profile, "name", name, userOverride);
      } else {
        await openSshSession(profile, "name", newDialog.attachTarget, userOverride);
      }
      setNewDialog(null);
    } finally {
      setDialogBusy(false);
    }
  }

  async function connectFromHistory(h: HistoryEntry) {
    const profile = profiles.find((p) => p.id === h.profileId);
    if (!profile) {
      notify("这条历史对应的连接配置已被删除");
      return;
    }
    // 已经在标签里开着的 tmux 会话：直接切过去，不要再 attach 一次。
    // 理由：同一个 tmux 会话被两个客户端 attach 时，tmux 会把窗口尺寸
    // 迁就最小的那个客户端，两边会互相挤（就是我们之前遇到的"显示不全"）。
    if (h.tmuxSession) {
      const opened = sessions.find(
        (s) => s.profileId === h.profileId && s.tmuxName === h.tmuxSession,
      );
      if (opened) {
        setActiveId(opened.id);
        notify(`「${h.title?.trim() || h.tmuxSession}」已经开着了，已帮你切过去`);
        return;
      }
    }
    const custom = h.title?.trim() || undefined;
    if (h.tmuxSession) {
      await openSshSession(profile, "name", h.tmuxSession, null, custom);
    } else {
      await openSshSession(profile, "none", null, null, custom);
    }
  }

  async function removeHistoryEntry(id: string) {
    try {
      setHistory(await historyRemove(id));
    } catch (e) {
      notify("删除历史失败：" + String(e));
    }
  }

  async function refreshAdb() {
    setAdbLoading(true);
    try {
      setAdbVer(await adbVersion());
      setAdbList(await adbDevices());
      setFbVer(await fastbootVersion());
      setFbList(await fastbootDevices());
    } catch (e) {
      notify("ADB 不可用：" + String(e));
      setAdbVer("");
      setAdbList([]);
    } finally {
      setAdbLoading(false);
    }
  }

  async function refreshSerial() {
    setSerialLoading(true);
    try {
      setSerialPorts(await serialList());
    } catch (e) {
      notify("枚举串口失败：" + String(e));
      setSerialPorts([]);
    } finally {
      setSerialLoading(false);
    }
  }

  async function refreshGit() {
    const path = gitPath.trim();
    if (!path) {
      notify("请先填写仓库路径");
      return;
    }
    setGitLoading(true);
    try {
      setGitState(await gitStatus(path));
    } catch (e) {
      notify("读取 Git 状态失败：" + String(e));
      setGitState(null);
    } finally {
      setGitLoading(false);
    }
  }

  /** 刷新 Git 的全部信息：工作区状态 + 提交历史 + 分支 */
  async function refreshGitAll(pathArg?: string) {
    const path = (pathArg ?? gitPath).trim();
    if (!path) {
      notify("请先选一个仓库");
      return;
    }
    setGitBusy(true);
    try {
      const st = await gitStatus(path);
      setGitState(st);
      if (st.ok) {
        const [log, brs] = await Promise.all([gitLog(path, 30), gitBranches(path)]);
        setGitCommits(log);
        setGitBranchList(brs);
      } else {
        setGitCommits([]);
        setGitBranchList([]);
      }
    } catch (e) {
      notify("读取 Git 状态失败：" + String(e));
    } finally {
      setGitBusy(false);
    }
  }

  async function doGitAdd(files?: string[]) {
    const path = gitPath.trim();
    if (!path) return;
    try {
      await gitAdd(path, files);
      await refreshGitAll(path);
    } catch (e) {
      notify("暂存失败：" + String(e));
    }
  }

  async function doGitUnstage(files: string[]) {
    const path = gitPath.trim();
    if (!path) return;
    try {
      await gitUnstage(path, files);
      await refreshGitAll(path);
    } catch (e) {
      notify("取消暂存失败：" + String(e));
    }
  }

  function askGitDiscard(files: string[]) {
    setConfirmDialog({
      title: "丢弃改动",
      message: `确定丢弃这些文件的未提交改动吗？\n${files.join("\n")}\n\n改完就找不回来了。`,
      onOk: () => void doGitDiscard(files),
    });
  }

  async function doGitDiscard(files: string[]) {
    const path = gitPath.trim();
    if (!path) return;
    try {
      await gitDiscard(path, files);
      await refreshGitAll(path);
      notify("已丢弃改动");
    } catch (e) {
      notify("丢弃失败：" + String(e));
    }
  }

  async function doGitCommit() {
    const path = gitPath.trim();
    if (!path) return;
    if (!gitMessage.trim()) {
      notify("先写提交信息");
      return;
    }
    setGitBusy(true);
    try {
      const out = await gitCommit(path, gitMessage);
      setGitMessage("");
      notify(out.split("\n")[0] || "已提交");
      await refreshGitAll(path);
    } catch (e) {
      notify("提交失败：" + String(e));
    } finally {
      setGitBusy(false);
    }
  }

  async function doGitCheckout(branch: string, create = false) {
    const path = gitPath.trim();
    if (!path || !branch.trim()) return;
    setGitBusy(true);
    try {
      const out = await gitCheckout(path, branch, create);
      setNewBranch("");
      notify(out.trim().split("\n").pop() || `已切到 ${branch}`);
      await refreshGitAll(path);
    } catch (e) {
      notify("切换分支失败：" + String(e));
    } finally {
      setGitBusy(false);
    }
  }

  async function showFileDiff(file: string, staged: boolean) {
    const path = gitPath.trim();
    if (!path) return;
    try {
      const text = await gitDiff(path, file, staged);
      setDiffDialog({
        title: `${staged ? "已暂存 · " : ""}${file}`,
        text: text || "(没有 diff，可能已提交或只有模式变化)",
      });
    } catch (e) {
      notify("读取 diff 失败：" + String(e));
    }
  }

  async function showCommitDiff(hash: string, subject: string) {
    const path = gitPath.trim();
    if (!path) return;
    try {
      const text = await gitShow(path, hash);
      setDiffDialog({ title: `${hash.slice(0, 8)} ${subject}`, text });
    } catch (e) {
      notify("读取提交失败：" + String(e));
    }
  }

  /**
   * 「打开本地 Git 仓库」：选一个本地目录 → 确认是 Git 仓库 →
   * 存成一个工作空间（本地终端就起在这个目录），并顺手打开它的终端。
   */
  async function openGitWorkspace() {
    const picked = await openLocalDialog({
      directory: true,
      title: "选择本地 Git 仓库目录",
    });
    if (!picked || Array.isArray(picked)) return;
    const dir = picked;
    setGitPath(dir);
    setGitLoading(true);
    let status: GitStatus | null = null;
    try {
      status = await gitStatus(dir);
      setGitState(status);
    } catch (e) {
      notify("读取 Git 状态失败：" + String(e));
      setGitLoading(false);
      return;
    }
    setGitLoading(false);
    if (!status?.ok) {
      notify(status?.message || "这个目录不是 Git 仓库");
      return;
    }

    const name = dir.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || dir;
    const shell = settings.defaultShell;
    const existing = profiles.find((p) => p.type === "local" && p.local?.cwd === dir);
    if (!existing) {
      const profile: ConnectionProfile = {
        id: uid(),
        type: "local",
        name: `${name} · git`,
        group: "Git 工作空间",
        local: { shell, cwd: dir },
      };
      try {
        await saveProfile(profile);
        await refresh();
      } catch (e) {
        notify("保存工作空间失败：" + String(e));
      }
    }
    await openLocalSession(shell, undefined, dir, `${name} · git`);
    notify(`已在 ${dir} 打开 Git 工作空间（终端 + git 命令行）`);
  }

  async function removeGitWorkspace(p: ConnectionProfile) {
    try {
      await deleteProfile(p.id);
      await refresh();
    } catch (e) {
      notify("删除失败：" + String(e));
    }
  }

  /** 在一个目录里新建 git 仓库（git init），然后存成工作空间并开终端 */
  async function createGitRepo(rawPath: string) {
    const dir = rawPath.trim();
    if (!dir) {
      notify("请先填要创建仓库的目录，例如 D:\\code\\my-repo");
      return;
    }
    try {
      await gitInit(dir, true);
    } catch (e) {
      notify("git init 失败：" + String(e));
      return;
    }
    setGitInitDialog(null);
    setGitPath(dir);
    try {
      setGitState(await gitStatus(dir));
    } catch {
      /* 刚 init 的仓库状态读不到也无所谓 */
    }
    const name = dir.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || dir;
    const shell = settings.defaultShell;
    if (!profiles.some((p) => p.type === "local" && p.local?.cwd === dir)) {
      try {
        await saveProfile({
          id: uid(),
          type: "local",
          name: `${name} · git`,
          group: "Git 工作空间",
          local: { shell, cwd: dir },
        });
        await refresh();
      } catch (e) {
        notify("保存工作空间失败：" + String(e));
      }
    }
    await openLocalSession(shell, undefined, dir, `${name} · git`);
    notify(`已在 ${dir} 建好仓库并打开终端（可以 git add . 然后 commit）`);
  }

  /** 在某个目录直接开一个新的本地终端（Git 面板用） */
  async function openGitTerminal(dir: string, title?: string) {
    if (!dir.trim()) {
      notify("先选一个仓库目录");
      return;
    }
    await openLocalSession(settings.defaultShell, undefined, dir, title);
  }

  /** 远程会话意外断开时自动重连（会重新附加 tmux），最多 5 次指数退避。 */
  function scheduleReconnect(sessionId: string) {
    const s = sessionsRef.current.find((x) => x.id === sessionId);
    if (!s || !s.profileId) return;
    if (!settings.autoReconnect) return;
    const tries = reconnectTries.current[sessionId] ?? 0;
    if (tries >= 5) {
      notify("自动重连已尝试 5 次，先停下。点标签上的 ↻ 可以手动重试。");
      return;
    }
    reconnectTries.current[sessionId] = tries + 1;
    const delay = Math.min(3000 * (tries + 1), 15000);
    setSessions((prev) =>
      prev.map((x) => (x.id === sessionId ? { ...x, state: "reconnecting" } : x)),
    );
    window.clearTimeout(reconnectTimers.current[sessionId]);
    reconnectTimers.current[sessionId] = window.setTimeout(() => {
      void doReconnect(sessionId);
    }, delay);
  }

  async function doReconnect(sessionId: string) {
    const s = sessionsRef.current.find((x) => x.id === sessionId);
    if (!s || !s.profileId) return;
    try {
      await sessionClose(sessionId);
    } catch {
      /* 已经断开 */
    }
    try {
      await openSsh(
        sessionId,
        s.profileId,
        (e) => handleEvent(sessionId, e),
        s.tmuxMode ?? "default",
        s.tmuxName ?? null,
      );
      reconnectTries.current[sessionId] = 0;
    } catch {
      scheduleReconnect(sessionId);
    }
  }

  /** 用「串口连接」里存好的参数打开一个串口终端 */
  async function openSerialSession(profile: ConnectionProfile) {
    const cfg = profile.serial;
    if (!cfg?.path) {
      notify("这个串口连接没有配置端口");
      return "";
    }
    const id = uid();
    addSession({
      id,
      title: profile.name,
      kind: "serial",
      state: "connecting",
      openFiles: [],
      activeTab: "terminal",
    });
    maybeAutoLog({ id, title: profile.name });
    try {
      const info = await openSerial(id, cfg.path, cfg.baudRate, (e) => handleEvent(id, e), {
        dataBits: cfg.dataBits,
        stopBits: cfg.stopBits,
        parity: cfg.parity,
        flowControl: cfg.flowControl,
      });
      setSessions((prev) =>
        prev.map((s) => (s.id === id ? { ...s, title: profile.name || info.title || s.title } : s)),
      );
    } catch (e) {
      notify("打开串口失败：" + String(e));
      setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, state: "error" } : s)));
    }
    return id;
  }

  async function openAdbSession(serial: string, mode: "shell" | "logcat" = "shell") {
    const id = uid();
    addSession({
      id,
      title: mode === "logcat" ? `logcat · ${serial}` : `ADB · ${serial}`,
      kind: "adb",
      state: "connecting",
      openFiles: [],
      activeTab: "terminal",
    });
    maybeAutoLog({
      id,
      title: mode === "logcat" ? `logcat-${serial}` : `adb-${serial}`,
    });
    try {
      await openAdbShell(id, serial, (e) => handleEvent(id, e), undefined, undefined, mode);
    } catch (e) {
      notify(`打开 ${mode === "logcat" ? "logcat" : "ADB shell"} 失败：` + String(e));
      setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, state: "error" } : s)));
    }
  }

  // ---------- ADB 文件管理 ----------

  function joinRemote(dir: string, name: string) {
    return `${dir.replace(/\/+$/, "")}/${name}`;
  }

  async function refreshAdbFiles(serial: string, path: string) {
    setAdbLoading(true);
    try {
      setAdbFiles(await adbLs(serial, path));
      setAdbPath(path);
    } catch (e) {
      notify("读取设备目录失败：" + String(e));
      setAdbFiles([]);
    } finally {
      setAdbLoading(false);
    }
  }

  async function adbUpload(serial: string) {
    const picked = await openLocalDialog({
      multiple: true,
      title: "选择要推送到设备的文件",
    });
    if (!picked) return;
    const paths = Array.isArray(picked) ? picked : [picked];
    try {
      notify(await adbPush(serial, paths, adbPath));
      await refreshAdbFiles(serial, adbPath);
    } catch (e) {
      notify("推送失败：" + String(e));
    }
  }

  async function adbDownload(serial: string, name: string) {
    const dir = await openLocalDialog({ directory: true, title: `选择保存「${name}」的目录` });
    if (!dir || Array.isArray(dir)) return;
    try {
      notify(await adbPull(serial, joinRemote(adbPath, name), dir));
    } catch (e) {
      notify("下载失败：" + String(e));
    }
  }

  async function adbMkdirNow(serial: string, name: string) {
    const target = joinRemote(adbPath, name.trim());
    if (!name.trim()) return;
    try {
      await adbMkdir(serial, target);
      setAdbNewName("");
      await refreshAdbFiles(serial, adbPath);
      notify(`已在设备上新建 ${target}`);
    } catch (e) {
      notify("新建文件夹失败：" + String(e));
    }
  }

  async function adbDelete(serial: string, name: string, isDir: boolean) {
    try {
      await adbRm(serial, joinRemote(adbPath, name), isDir);
      await refreshAdbFiles(serial, adbPath);
      notify(`已删除 ${name}`);
    } catch (e) {
      notify("删除失败：" + String(e));
    }
  }

  function relTime(secs: number): string {
    if (!secs) return "";
    const diff = Math.max(0, Math.floor(Date.now() / 1000) - secs);
    if (diff < 60) return "刚刚";
    if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
    return `${Math.floor(diff / 86400)} 天前`;
  }

  async function updateSettings(patch: Partial<AppSettings>) {
    const next = { ...settings, ...patch };
    setSettings(next);
    try {
      await settingsSet(next);
    } catch (e) {
      notify("保存设置失败：" + String(e));
    }
  }

  function bumpFont(delta: number) {
    applyFontSize(currentFontSize() + delta);
  }

  /** 当前字号：优先用"还没落盘的临时值"，保证滚轮连点时每次都在前一档上加减 */
  function currentFontSize(): number {
    return fontRef.current ?? settingsRef.current.fontSize ?? 13;
  }

  /**
   * 立刻改字号（界面马上生效），落盘延后 400ms。
   *
   * 为什么不一格一格直接写设置：`Ctrl + 鼠标滚轮` 一滚就是十几次事件，
   * 每次都写一遍 settings.json 既没必要也伤盘。
   */
  function applyFontSize(next: number) {
    const v = Math.min(26, Math.max(8, next));
    if (v === currentFontSize()) return;
    fontRef.current = v;
    setSettings((s) => ({ ...s, fontSize: v }));
    if (fontSaveTimer.current !== null) window.clearTimeout(fontSaveTimer.current);
    fontSaveTimer.current = window.setTimeout(() => {
      fontSaveTimer.current = null;
      fontRef.current = null;
      void settingsSet({ ...settingsRef.current }).catch((e) =>
        notify("保存字号失败：" + String(e)),
      );
    }, 400);
  }

  function clearActiveTerminal() {
    if (!activeSession) {
      notify("当前没有会话");
      return;
    }
    void sessionWrite(activeSession.id, bytesToB64(new TextEncoder().encode("\u000c")));
  }

  /**
   * 检查更新。
   *
   * - 手动点按钮（设置 / 关于对话框）→ `silent` 不传，界面会写"正在检查 / 已是最新"；
   * - 后台自动检查 → `silent: true`：成功不吭声（只在发现新版时亮小红点），
   *   失败也不吭声（没网是常态，不该拿红色报错烦人）。
   */
  async function checkForUpdates(opts?: { silent?: boolean }) {
    const silent = opts?.silent === true;
    const url = settingsRef.current.updateUrl.trim();
    if (!url) {
      if (!silent) setUpdateMsg("请先填写更新源地址（返回 JSON，含 tag_name 或 version 字段）。");
      return;
    }
    if (!silent) {
      setUpdateBusy(true);
      setUpdateMsg("正在检查…");
    }
    setUpdateOffer(null);
    try {
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as Record<string, unknown>;
      const latest = String(data.tag_name ?? data.version ?? data.latest ?? "")
        .replace(/^v/i, "")
        .trim();
      if (!latest) throw new Error("返回内容里没有 tag_name / version 字段");
      // 记录检查时间：自动检查靠它做节流（不要每次开窗都去问 GitHub）
      const stamp = Math.floor(Date.now() / 1000);
      if (Math.abs((settingsRef.current.lastUpdateCheck ?? 0) - stamp) > 60) {
        void updateSettings({ lastUpdateCheck: stamp });
      }
      if (compareVersion(latest, APP_VERSION) <= 0) {
        if (!silent) setUpdateMsg(`已是最新版本（${APP_VERSION}）`);
        return;
      }
      // 用户明确说过"这个版本我暂时不升"→ 不再闪小红点（手动检查时仍然显示）
      if (silent && latest === settingsRef.current.ignoredUpdateVersion) return;
      // 从 release 里挑出三种产物：NSIS 安装包 / MSI / 便携版 zip。
      // 一键升级要用哪一个是按"当前这份是怎么装上的"决定的（见 update_install_kind）。
      const assets = (Array.isArray(data.assets) ? data.assets : []) as Asset[];
      const find = (test: (n: string) => boolean) =>
        assets.find((a) => test(String(a.name ?? "").toLowerCase()));
      const setup =
        find((n) => n.endsWith(".exe") && n.includes("setup")) ?? find((n) => n.endsWith(".exe"));
      const msi = find((n) => n.endsWith(".msi"));
      const zip = find((n) => n.endsWith(".zip"));
      const pageUrl = String(data.html_url ?? url);
      setUpdateOffer({
        version: latest,
        installerUrl: setup?.browser_download_url ?? "",
        installerSize: setup?.size ?? 0,
        msiUrl: msi?.browser_download_url ?? "",
        msiSize: msi?.size ?? 0,
        zipUrl: zip?.browser_download_url ?? "",
        pageUrl,
      });
      setUpdateMsg(`发现新版本 ${latest}（当前 ${APP_VERSION}）`);
      if (silent) notify(`发现新版本 ${latest}，在「设置 → 检查更新」里可以一键下载`);
    } catch (e) {
      if (!silent) setUpdateMsg("检查失败：" + String(e));
    } finally {
      if (!silent) setUpdateBusy(false);
    }
  }

  /**
   * 当前会话对应的 tmux 会话名（普通 shell 会话是空串）。
   * 「tmux 快捷操作」面板只在这个不为空时出现。
   */
  const curTmuxSession = activeSession?.tmuxName ?? "";
  const curTmuxProfileId = activeSession?.profileId ?? "";

  /** 读一下这个 tmux 会话里现在有哪些窗口 */
  async function refreshTmuxWindows() {
    if (!curTmuxSession || !curTmuxProfileId) {
      setTmuxWinList([]);
      return;
    }
    try {
      const list = await tmuxWindows(
        curTmuxProfileId,
        curTmuxSession,
        activeSession?.user ?? null,
      );
      setTmuxWinList(list);
    } catch {
      // 读不到就先空着（服务器断开等），别拿红字刷状态栏
      setTmuxWinList([]);
    }
  }

  /**
   * 执行一个 tmux 快捷操作。
   *
   * 走的是另开一条 ssh 跑 `tmux xxx`，**不是**往终端里塞按键 ——
   * 所以不抢 Ctrl+B，也不受"当前窗格正在跑程序"的影响。
   */
  async function runTmuxAction(action: string, arg?: string) {
    if (!curTmuxSession || !curTmuxProfileId) return;
    setTmuxBusy(true);
    try {
      const out = await tmuxAction(
        curTmuxProfileId,
        curTmuxSession,
        action,
        arg ?? null,
        activeSession?.user ?? null,
      );
      if (out.trim()) notify(out.trim());
      await refreshTmuxWindows();
    } catch (e) {
      notify("tmux 操作失败：" + String(e));
    } finally {
      setTmuxBusy(false);
    }
  }

  /**
   * 切到别的 tmux 会话、或者把面板展开时，读一次窗口列表；
   * 之后每 10 秒对一次表，这样你在终端里自己按 Ctrl+B 切了窗口，面板也能跟上。
   * （只在面板展开时才轮询，收起就完全不打扰服务器。）
   */
  useEffect(() => {
    if (!curTmuxSession || !tmuxDockOpen) {
      setTmuxWinList([]);
      return;
    }
    void refreshTmuxWindows();
    const timer = window.setInterval(() => void refreshTmuxWindows(), 10000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curTmuxSession, curTmuxProfileId, tmuxDockOpen]);

  /**
   * 点活动栏图标（VS Code 的行为，而不是"只能切模块"）：
   * - 点的就是当前这个模块，且侧栏正展开 → **折叠**侧栏；
   * - 其它情况（点了别的模块，或侧栏本来收着）→ 切到该模块并**展开**侧栏。
   *
   * 所以"藏/显示侧栏"不用再专门去「视图」菜单点，日常顺手点图标就行；
   * 视图菜单里那一项保留，作为备选入口。
   */
  function activateModule(key: ModuleKey) {
    if (module === key && showSidebar) {
      setShowSidebar(false);
      return;
    }
    setModule(key);
    if (key !== "remote") setSideTab("sessions");
    setShowSidebar(true);
  }

  /** 打开更新相关的外链（走系统浏览器），失败只写底部状态栏 */
  async function openUpdateLink(url: string, what: string) {
    try {
      await openExternalUrl(url);
    } catch (e) {
      notify(`打开${what}失败：` + String(e));
    }
  }

  /** 设置里显示"当前终端配色"用 */
  function currentTermSchemeName(): string {
    if (settings.termScheme === CUSTOM_SCHEME_KEY) return "自定义";
    return TERM_SCHEMES.find((s) => s.key === settings.termScheme)?.name ?? "VS Code 深色（默认）";
  }

  /** 选择会话日志目录（空 = 用默认位置） */
  async function pickLogDir() {
    const dir = await openLocalDialog({
      directory: true,
      title: "选择会话日志保存目录",
    });
    if (!dir || Array.isArray(dir)) return;
    await updateSettings({ logDir: dir });
    notify("日志目录已改为 " + dir);
  }

  /** 打开目录（查看已经写下去的日志） */
  async function openLogDir() {
    try {
      const dir = await sessionLogDir();
      await openInExplorer(dir);
    } catch (e) {
      notify("打开日志目录失败：" + String(e));
    }
  }

  /** 用户选择「忽略此版本」：记住版本号，之后自动检查不再为它亮小红点 */
  function ignoreUpdateVersion(version: string) {
    void updateSettings({ ignoredUpdateVersion: version });
    setUpdateOffer(null);
    setUpdateMsg(`已忽略 ${version}，等下一个版本再提醒`);
  }

  /**
   * 一键升级：下载新版安装包 → 校验 → 静默覆盖安装 → 自动重启。
   *
   * - 安装版（NSIS）：`安装包 /S /R`，全程无窗口，装完自己把应用拉起来；
   * - MSI 版：`msiexec /i ... /qb /norestart`，会弹一次 UAC（因为 MSI 是 perMachine）；
   * - 便携版：没有覆盖安装这一说，按钮会退化成"下载 zip 手动替换"。
   */
  async function runOneClickUpgrade() {
    if (!updateOffer) return;
    const isMsi = installKind === "msi";
    const url = isMsi ? updateOffer.msiUrl : updateOffer.installerUrl;
    const expected = isMsi ? updateOffer.msiSize : updateOffer.installerSize;
    if (!url) {
      notify(isMsi ? "这个版本没有提供 MSI 安装包" : "这个版本没有提供安装包，请打开发布页");
      return;
    }
    setUpdateApplying(true);
    notify(`正在下载 ${updateOffer.version} 安装包…下载进度见右下角`);
    try {
      await updateDownloadInstall(url, expected, updateOffer.version);
      notify(
        isMsi
          ? `已开始升级到 ${updateOffer.version}（MSI 安装可能会弹一次 UAC，请点“是”）`
          : `已开始安装 ${updateOffer.version}，应用会自动重启`,
      );
    } catch (e) {
      notify("一键升级失败：" + String(e));
      setUpdateApplying(false);
    }
  }

  /**
   * 「检查更新」区块 —— 设置对话框和关于对话框共用同一套 UI，
   * 免得两个地方行为不一致（这也是上一版"看到新版本却没地方点"的根因）。
   */
  function renderUpdateSection() {
    // 只有"安装版"才能一键覆盖升级：NSIS 走 setup.exe，MSI 走 msiexec；便携版只能手动替换
    const canOneClick =
      (installKind === "nsis" && !!updateOffer?.installerUrl) ||
      (installKind === "msi" && !!updateOffer?.msiUrl);
    return (
      <>
        <label className="modal-field">
          更新源（返回 JSON 的地址，含 tag_name 或 version 字段）
          <input
            value={settings.updateUrl}
            placeholder="https://api.github.com/repos/you/zeeai-terminal/releases/latest"
            onChange={(e) => void updateSettings({ updateUrl: e.target.value })}
          />
        </label>
        <div className="modal-inline-action">
          <button
            type="button"
            className="mini-btn"
            disabled={updateBusy}
            onClick={() => void checkForUpdates()}
          >
            {updateBusy ? "检查中…" : "检查更新"}
          </button>
          <span className="hint" style={{ padding: "0 0 0 8px" }}>
            当前版本 {APP_VERSION}
          </span>
          {updateMsg && <div className="hint">{updateMsg}</div>}
        </div>
        {updateOffer && (
          <>
            {canOneClick ? (
              <div className="modal-inline-action" style={{ marginTop: 6 }}>
                <button
                  type="button"
                  className="btn primary"
                  disabled={updateApplying}
                  onClick={() => void runOneClickUpgrade()}
                  title={
                    installKind === "msi"
                      ? "下载 MSI 后静默升级并自动重启（会弹一次 UAC）"
                      : "下载安装包后静默覆盖安装并自动重启"
                  }
                >
                  {updateApplying
                    ? "正在下载更新包…"
                    : installKind === "msi"
                      ? `一键升级到 ${updateOffer.version}（会弹 UAC）`
                      : `一键升级到 ${updateOffer.version} 并重启`}
                </button>
                <button
                  type="button"
                  className="mini-btn"
                  onClick={() => void openUpdateLink(updateOffer.pageUrl, "发布页")}
                >
                  打开发布页
                </button>
                <button
                  type="button"
                  className="mini-btn"
                  onClick={() => ignoreUpdateVersion(updateOffer.version)}
                >
                  忽略此版本
                </button>
              </div>
            ) : (
              <div className="modal-inline-action" style={{ marginTop: 6 }}>
                {updateOffer.zipUrl && (
                  <button
                    type="button"
                    className="btn primary"
                    onClick={() => void openUpdateLink(updateOffer.zipUrl, "便携版下载")}
                  >
                    {`下载便携版 ${updateOffer.version}`}
                  </button>
                )}
                {updateOffer.installerUrl && (
                  <button
                    type="button"
                    className="mini-btn"
                    onClick={() => void openUpdateLink(updateOffer.installerUrl, "安装包下载")}
                  >
                    下载安装包
                  </button>
                )}
                <button
                  type="button"
                  className="mini-btn"
                  onClick={() => void openUpdateLink(updateOffer.pageUrl, "发布页")}
                >
                  打开发布页
                </button>
                <button
                  type="button"
                  className="mini-btn"
                  onClick={() => ignoreUpdateVersion(updateOffer.version)}
                >
                  忽略此版本
                </button>
              </div>
            )}
            <div className="hint">
              {canOneClick
                ? installKind === "msi"
                  ? "MSI 是给企业批量部署用的（装在 Program Files，需要管理员），所以升级时会弹一次 UAC 授权；升级过程会自动结束当前应用并在装完后重新打开。"
                  : "会静默完成覆盖安装并自动重启应用；tmux 会话不受影响，重开后可以重新附加。"
                : "当前是便携版：解压在哪个目录就替换哪个目录里的文件即可，配置不会丢。"}
            </div>
          </>
        )}
      </>
    );
  }

  function buildMenus(): { key: string; label: string; items: MenuItem[] }[] {
    const openConnectionForm = () => {
      setModule("remote");
      setSideTab("sessions");
      openEditDialog();
    };
    return [
      {
        key: "file",
        label: "文件",
        items: [
          { sep: false, label: "新建会话…", action: () => openNewSessionDialog() },
          { sep: false, label: "新建连接", action: openConnectionForm },
          { sep: true },
          {
            sep: false,
            label: "退出",
            action: () => {
              void getCurrentWindow().close();
            },
          },
        ],
      },
      {
        key: "edit",
        label: "编辑",
        items: [
          { sep: false, label: "清空当前终端", action: clearActiveTerminal },
          {
            sep: false,
            label: "重新连接当前会话",
            action: () => {
              if (activeSession) void reconnectSession(activeSession);
            },
          },
        ],
      },
      {
        key: "view",
        label: "视图",
        items: [
          // 快捷键提示写进标签，顺便当教学（Ctrl + 滚轮 也管用）
          { sep: false, label: "放大字体（Ctrl + ＋）", action: () => bumpFont(1) },
          { sep: false, label: "缩小字体（Ctrl + －）", action: () => bumpFont(-1) },
          { sep: false, label: "重置字体（Ctrl + 0）", action: () => applyFontSize(13) },
          { sep: false, label: "终端配色…", action: () => setShowTermTheme(true) },
          { sep: true },
          {
            sep: false,
            // 更贴近 VS Code 的说法；日常其实直接点左侧图标就能折叠/展开
            label: showSidebar ? "折叠侧栏" : "展开侧栏",
            action: () => setShowSidebar((v) => !v),
          },
          { sep: true },
          {
            sep: false,
            label: `${paneLayout === "single" ? "● " : ""}单窗格（不分割）`,
            action: () => setPaneLayout("single"),
          },
          {
            sep: false,
            label: `${paneLayout === "v2" ? "● " : ""}左右两分屏`,
            action: () => setPaneLayout("v2"),
          },
          {
            sep: false,
            label: `${paneLayout === "h2" ? "● " : ""}上下两分屏`,
            action: () => setPaneLayout("h2"),
          },
          {
            sep: false,
            label: `${paneLayout === "v3" ? "● " : ""}三分屏（竖排三列）`,
            action: () => setPaneLayout("v3"),
          },
          {
            sep: false,
            label: `${paneLayout === "grid4" ? "● " : ""}四分屏（2×2）`,
            action: () => setPaneLayout("grid4"),
          },
          { sep: true },
          {
            sep: false,
            label: settings.theme === "dark" ? "切换到浅色主题" : "切换到深色主题",
            action: () =>
              void updateSettings({ theme: settings.theme === "dark" ? "light" : "dark" }),
          },
        ],
      },
      {
        key: "conn",
        label: "连接",
        items: [
          { sep: false, label: "新建会话…", action: () => openNewSessionDialog() },
          { sep: false, label: "新建服务器…", action: openConnectionForm },
          { sep: false, label: "服务器管理…", action: () => setShowServers(true) },
          { sep: true },
          { sep: false, label: "设置…", action: () => setShowSettings(true) },
        ],
      },
      {
        key: "term",
        label: "终端",
        items: [
          {
            sep: false,
            label: `新建默认终端（${SHELL_LABEL[settings.defaultShell]}）`,
            action: () => void openLocalSession(settings.defaultShell),
          },
          { sep: false, label: "新建 PowerShell", action: () => void openLocalSession("powershell") },
          { sep: false, label: "新建 CMD", action: () => void openLocalSession("cmd") },
          { sep: false, label: "新建 WSL", action: () => void openLocalSession("wsl") },
          { sep: true },
          {
            sep: false,
            label: "关闭当前会话",
            action: () => {
              if (activeId) void closeSession(activeId);
            },
          },
          {
            sep: false,
            label: `关闭全部本地终端（${localTerminals.length}）`,
            action: () => void closeSessions(localTerminals, "本地终端"),
          },
          {
            sep: false,
            label: `关闭全部会话（${sessions.length}，含 SSH）`,
            action: () => void closeSessions(sessions, "会话"),
          },
        ],
      },
      {
        key: "help",
        label: "帮助",
        items: [{ sep: false, label: "关于 ZeeAI Terminal", action: () => setShowAbout(true) }],
      },
    ];
  }

  /**
   * 刷新文件面板。
   * 打开「跟随终端目录」时，会去问 tmux 这个会话的 pane 当前在哪个目录
   * （就是你终端里 `pwd` 的那个），然后直接列那里——这样在终端里 cd 完，
   * 点一下刷新文件列表就跟过去了，不用手输路径。
   */
  /**
   * 问终端要当前目录。两条路：
   * 1) shell 自己用 OSC 7 上报过（普通 shell 也有）→ 直接用；
   * 2) tmux 会话 → 问 tmux 的 pane_current_path。
   * 都拿不到就返回 null。
   */
  async function resolveTerminalCwd(
    profileId: string,
    tmuxName?: string,
    cwd?: string,
  ): Promise<string | null> {
    if (cwd) return cwd;
    if (!tmuxName) return null;
    try {
      return await remotePwd(profileId, tmuxName, activeUserRef.current ?? null);
    } catch {
      return null;
    }
  }

  /** 切换会话时自动同步（受「跟随终端」开关控制） */
  async function refreshFs(
    profileId: string,
    tmuxName?: string,
    cwd?: string,
    fallback?: string,
  ) {
    if (!settings.fsFollowTerminal) {
      await loadDir(profileId, fallback);
      return;
    }
    const target = await resolveTerminalCwd(profileId, tmuxName, cwd);
    await loadDir(profileId, target ?? fallback);
  }

  /** 「同步终端目录」按钮：一键跳到终端当前所在目录 */
  async function syncFsToTerminal(
    profileId: string,
    tmuxName?: string,
    cwd?: string,
  ) {
    const target = await resolveTerminalCwd(profileId, tmuxName, cwd);
    if (!target) {
      notify("这个会话还没上报工作目录：在终端里按一下回车，或先 cd 一次再点同步");
      return;
    }
    await loadDir(profileId, target);
    notify(`已同步到终端目录：${target}`);
  }

  async function loadDir(profileId: string, path?: string) {
    setFsLoading(true);
    try {
      const listing = await fsList(profileId, path, activeUserRef.current ?? null);
      setFsPath(listing.path);
      setFsInput(listing.path);
      setFsEntries(listing.entries);
    } catch (e) {
      notify("读取远端目录失败：" + String(e));
      setFsEntries([]);
    } finally {
      setFsLoading(false);
    }
  }

  async function openRemoteFile(
    profileId: string,
    name: string,
    sessionIdOverride?: string,
  ) {
    const sessionId = sessionIdOverride ?? activeId;
    if (!sessionId) {
      notify("请先打开一个 SSH 会话");
      return;
    }
    const path = joinPath(fsPathRef.current, name);
    const kind = fileKind(name);
    try {
      const b64 = await fsRead(profileId, path, 1024 * 1024, activeUserRef.current ?? null);
      if (!b64) {
        notify("文件为空或无法读取（可能是目录或二进制文件）");
        return;
      }
      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== sessionId) return s;
          const exists = s.openFiles.some((f) => f.path === path);
          const openFiles = exists ? s.openFiles : [...s.openFiles, { name, path, kind, b64 }];
          return { ...s, openFiles, activeTab: name };
        }),
      );
    } catch (e) {
      notify("读取文件失败：" + String(e));
    }
  }

  function selectTab(sessionId: string, tab: string) {
    setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, activeTab: tab } : s)));
  }

  /** 上传本机文件/文件夹到当前远端目录 */
  async function uploadToRemote(profileId: string) {
    const picked = await openLocalDialog({
      multiple: true,
      title: "选择要上传到服务器的文件（可多选；选中的文件夹会整个上传）",
    });
    if (!picked) return;
    const localPaths = Array.isArray(picked) ? picked : [picked];
    if (localPaths.length === 0) return;
    setFsBusy(true);
    try {
      const msg = await fsUpload(
        profileId,
        localPaths,
        fsPathRef.current,
        activeUserRef.current ?? null,
        uid(),
      );
      notify(msg);
      await loadDir(profileId, fsPathRef.current);
    } catch (e) {
      notify("上传失败：" + String(e));
    } finally {
      setFsBusy(false);
    }
  }

  /** 把远端某个文件/目录下载到本机目录 */
  async function downloadFromRemote(profileId: string, name: string) {
    const dir = await openLocalDialog({
      directory: true,
      title: `选择保存「${name}」的本机目录`,
    });
    if (!dir || Array.isArray(dir)) return;
    setFsBusy(true);
    try {
      const msg = await fsDownload(
        profileId,
        [joinPath(fsPath, name)],
        dir,
        activeUserRef.current ?? null,
        uid(),
      );
      notify(msg);
    } catch (e) {
      notify("下载失败：" + String(e));
    } finally {
      setFsBusy(false);
    }
  }

  function closeFile(sessionId: string, name: string) {
    setSessions((prev) =>
      prev.map((s) => {
        if (s.id !== sessionId) return s;
        const openFiles = s.openFiles.filter((f) => f.name !== name);
        const activeTab = s.activeTab === name ? "terminal" : s.activeTab;
        return { ...s, openFiles, activeTab };
      }),
    );
  }

  /**
   * 给会话改名：既改标签上的名字，也写进会话历史，
   * 下次从「会话历史」点进来还是你起的名字。
   */
  async function renameSession(sessionId: string, rawName: string) {
    const title = rawName.trim();
    if (!title) {
      notify("会话名不能为空");
      return;
    }
    const s = sessionsRef.current.find((x) => x.id === sessionId);
    setSessions((prev) => prev.map((x) => (x.id === sessionId ? { ...x, title } : x)));
    if (!s?.profileId) {
      setSessionRename(null);
      return;
    }
    const p = profiles.find((x) => x.id === s.profileId);
    try {
      setHistory(
        await historySave({
          id: "",
          profileId: s.profileId,
          profileName: p?.name ?? title,
          host: p?.ssh?.host ?? "",
          tmuxSession: s.tmuxName ?? null,
          title,
          lastUsed: 0,
        }),
      );
      notify(`会话已命名为「${title}」`);
    } catch (e) {
      notify("改名字失败：" + String(e));
    }
    setSessionRename(null);
  }

  /** 新建远端文件夹 / 重命名，共用一个输入弹窗 */
  async function confirmNameDialog() {
    if (!nameDialog) return;
    const value = nameDialog.value.trim();
    if (!value) {
      notify("名字不能为空");
      return;
    }
    const dir = nameDialog.dir;
    setFsBusy(true);
    try {
      if (nameDialog.mode === "mkdir") {
        await fsMkdir(nameDialog.profileId, joinPath(dir, value), activeUserRef.current ?? null);
        notify(`已新建 ${value}`);
      } else {
        await fsRename(
          nameDialog.profileId,
          joinPath(dir, nameDialog.from),
          joinPath(dir, value),
          activeUserRef.current ?? null,
        );
        notify(`已重命名为 ${value}`);
      }
      setNameDialog(null);
      await loadDir(nameDialog.profileId, dir);
    } catch (e) {
      notify("操作失败：" + String(e));
    } finally {
      setFsBusy(false);
    }
  }

  async function doRemoveRemote(profileId: string, name: string) {
    setFsBusy(true);
    try {
      await fsRemove(profileId, joinPath(fsPath, name), activeUserRef.current ?? null);
      notify(`已删除 ${name}`);
      await loadDir(profileId, fsPath);
    } catch (e) {
      notify("删除失败：" + String(e));
    } finally {
      setFsBusy(false);
    }
  }

  const grouped = useMemo(() => {
    const map = new Map<string, ConnectionProfile[]>();
    for (const p of profiles) {
      // 「已保存的服务器」只放 SSH 服务器；串口连接归串口面板自己管，
      // 不要混进服务器列表里，否则会让人以为是同一类东西。
      if (p.type !== "ssh") continue;
      const g = p.group || "默认";
      map.set(g, [...(map.get(g) ?? []), p]);
    }
    return Array.from(map.entries());
  }, [profiles]);

  /** 只有 SSH 服务器（给「新建会话」「服务器管理」用） */
  const sshProfiles = useMemo(() => profiles.filter((p) => p.type === "ssh"), [profiles]);

  /** 会话历史分组标题：只有一个分组时不显示（避免一行没意义的「默认」） */
  const showGroupHeaders = grouped.length > 1;

  /** 所有服务器的会话历史是不是都展开着（决定「展开/折叠全部」按钮显示哪个动作） */
  const allServersExpanded =
    sshProfiles.length > 0 && sshProfiles.every((p) => !collapsedServers.includes(p.id));

  /** 一键展开 / 折叠所有服务器的会话历史 */
  function toggleAllServers() {
    setCollapsedServers(allServersExpanded ? sshProfiles.map((p) => p.id) : []);
  }

  /** 用户自己建过的串口连接（不是系统里所有 COM 口） */
  const serialProfiles = useMemo(
    () => profiles.filter((p) => p.type === "serial" && !!p.serial?.path),
    [profiles],
  );

  /** 本地 Git 工作空间（type=local 且带 cwd） */
  const gitWorkspaces = useMemo(
    () => profiles.filter((p) => p.type === "local" && !!p.local?.cwd),
    [profiles],
  );

  /** 已经打开的本地终端（PowerShell / CMD / WSL） */
  const localTerminals = useMemo(
    () => sessions.filter((s) => s.kind === "powershell" || s.kind === "cmd" || s.kind === "wsl"),
    [sessions],
  );

  /** 当前生效的终端配色（视图 → 终端配色 里选的那套） */
  const termPalette = useMemo(
    () => resolveTermPalette(settings.termScheme, settings.termSchemeCustom),
    [settings.termScheme, settings.termSchemeCustom],
  );

  // ---------- 分屏 ----------
  const paneSlots = useMemo(() => {
    const n = paneCount(paneLayout);
    const out: (string | null)[] = [];
    for (let i = 0; i < n; i++) out.push(panes[i] ?? null);
    return out;
  }, [panes, paneLayout]);

  // 命令面板的过滤结果。必须在 localTerminals 等所有 const 之后才算，
  // 因为 buildMenus() 会读它们（提前读会 TDZ 报错、整页黑屏）。
  const paletteItems = useMemo(() => {
    const q = paletteQuery.trim().toLowerCase();
    const all = allCommands();
    if (!q) return all;
    return all.filter(
      (c) => c.label.toLowerCase().includes(q) || c.group.toLowerCase().includes(q),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paletteQuery, sessions, profiles, paneLayout, settings, showSidebar, activeId]);

  // 布局变化：保留还能用的格子，把当前会话放进去
  useEffect(() => {
    if (paneLayout === "single") return;
    setPanes((prev) => {
      const n = paneCount(paneLayout);
      const next: (string | null)[] = [];
      const used = new Set<string>();
      for (let i = 0; i < n; i++) {
        const sid = prev[i] ?? null;
        if (sid && sessions.some((s) => s.id === sid) && !used.has(sid)) {
          next.push(sid);
          used.add(sid);
        } else {
          next.push(null);
        }
      }
      if (activeId && !used.has(activeId)) {
        const empty = next.findIndex((x) => x === null);
        next[empty >= 0 ? empty : 0] = activeId;
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneLayout, sessions.length]);

  // 当前会话被切换时，让它出现在某个窗格里
  useEffect(() => {
    if (paneLayout === "single" || !activeId) return;
    setPanes((prev) => {
      const n = paneCount(paneLayout);
      const next = [...prev];
      while (next.length < n) next.push(null);
      if (next.includes(activeId)) return next;
      const empty = next.findIndex((x) => x === null);
      next[empty >= 0 ? empty : Math.min(focusedPane, n - 1)] = activeId;
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, paneLayout, focusedPane]);

  // 把 git status 的结果拆成「已暂存」「未暂存/未跟踪」两组（VS Code 那种分法）
  const stagedFiles = useMemo(() => {
    if (!gitState?.ok) return [];
    const seen = new Set<string>();
    const out: { path: string; st: string }[] = [];
    for (const f of gitState.files) {
      const idx = f.status[0] ?? " ";
      if (idx !== " " && idx !== "?" && !seen.has(f.path)) {
        seen.add(f.path);
        out.push({ path: f.path, st: idx.trim() || "M" });
      }
    }
    return out;
  }, [gitState]);

  const changedFiles = useMemo(() => {
    if (!gitState?.ok) return [];
    const seen = new Set<string>();
    const out: { path: string; st: string }[] = [];
    for (const f of gitState.files) {
      const idx = f.status[0] ?? " ";
      const work = f.status[1] ?? " ";
      const isUntracked = idx === "?";
      if ((isUntracked || work !== " ") && !seen.has(f.path)) {
        seen.add(f.path);
        out.push({ path: f.path, st: isUntracked ? "U" : work.trim() || "M" });
      }
    }
    return out;
  }, [gitState]);

  return (
    <div
      className={
        "app theme-" + settings.theme + (themeKind(settings.theme) === "light" ? " light" : "")
      }
    >
      <div className="titlebar">
        <div className="menus">
          {buildMenus().map((menu) => (
            <div key={menu.key} className="menu">
              <span
                className={"menu-label" + (openMenu === menu.key ? " open" : "")}
                onClick={() => setOpenMenu(openMenu === menu.key ? null : menu.key)}
              >
                {menu.label}
                {menu.key === "help" && updateOffer && <span className="menu-dot" />}
              </span>
              {openMenu === menu.key && (
                <div className="menu-drop">
                  {menu.items.map((item, i) =>
                    item.sep ? (
                      <div key={"sep" + i} className="menu-sep" />
                    ) : (
                      <button
                        key={item.label}
                        type="button"
                        className="menu-item"
                        onClick={() => {
                          setOpenMenu(null);
                          item.action?.();
                        }}
                      >
                        {item.label}
                      </button>
                    ),
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="title">
          ZeeAI Terminal{activeSession ? " — " + activeSession.title : ""}
        </div>
        <div className="win-controls" aria-hidden="true">
          <span className="wbtn" />
          <span className="wbtn" />
          <span className="wbtn" />
        </div>
      </div>

      <div className="workbench">
        <nav className="activitybar">
          {MODULES.map((m) => (
            <button
              key={m.key}
              type="button"
              className={"act" + (module === m.key ? " active" : "")}
              title={m.label}
              onClick={() => activateModule(m.key)}
            >
              {m.node}
            </button>
          ))}
          <div className="act-sep" />
          <div className="act-foot">
            <button
              type="button"
              className={"act" + (aiPanelOpen ? " active" : "")}
              title="AI Agent（探测/安装/启动 AI 命令行工具）"
              onClick={() => setAiPanelOpen((v) => !v)}
            >
              <IconSpark size={22} />
              {aiNotices.length > 0 && <span className="act-badge">{aiNotices.length}</span>}
            </button>
            <button
              type="button"
              className="act"
              title="设置"
              onClick={() => setShowSettings(true)}
            >
              <IconGear size={22} />
              {updateOffer && <span className="act-dot" />}
            </button>
          </div>
        </nav>

      <aside className="sidebar" style={{ display: showSidebar ? undefined : "none" }}>
          <div className="side-head">{MODULE_LABEL[module]}</div>

          {module === "remote" && (
            <div className="side-subtabs">
              <button
                type="button"
                className={sideTab === "sessions" ? "active" : ""}
                onClick={() => setSideTab("sessions")}
              >
                会话
              </button>
              <button
                type="button"
                className={sideTab === "files" ? "active" : ""}
                onClick={() => setSideTab("files")}
              >
                文件
              </button>
            </div>
          )}

          <div className="side-body">
            {module === "remote" && sideTab === "sessions" && (
              <>
                <div className="side-head-row">
                  <span className="side-head-title">服务器</span>
                  <button
                    type="button"
                    className="side-btn"
                    title="新建一台服务器（SSH）"
                    onClick={() => openEditDialog()}
                  >
                    <IconPlus size={12} /> 新建
                  </button>
                  <button
                    type="button"
                    className="side-btn"
                    title="服务器管理：编辑 / 复制 / 删除"
                    onClick={() => setShowServers(true)}
                  >
                    服务器管理
                  </button>
                </div>
                {grouped.length === 0 && (
                  <div className="hint">
                    还没有服务器。点上面的「新建」，或者新建会话时直接加一台。
                  </div>
                )}
                {sshProfiles.length > 0 && (
                  <button type="button" className="side-allbtn" onClick={() => toggleAllServers()}>
                    {allServersExpanded ? "▾ 折叠全部会话" : "▸ 展开全部会话"}
                  </button>
                )}
                {grouped.map(([group, list]) => (
                  <div key={group}>
                    {showGroupHeaders && (
                      <div className="tree-subgroup">
                        {group === DEFAULT_SERVER_GROUP ? "未分组" : group}
                      </div>
                    )}
                    {list.map((p) => {
                      const items = history.filter((h) => h.profileId === p.id);
                      const expanded = !collapsedServers.includes(p.id);
                      return (
                        <div key={p.id}>
                          <div
                            className="tree-item"
                            onClick={() => toggleServer(p.id)}
                            onDoubleClick={() => openEditDialog(p)}
                            onContextMenu={(e) => {
                              e.preventDefault();
                              setCtxMenu({ profile: p, x: e.clientX, y: e.clientY });
                            }}
                            title={`${p.ssh?.user}@${p.ssh?.host}:${p.ssh?.port}\n单击：展开/收起会话历史　双击或右键：服务器设置`}
                          >
                            <span
                              className="chev"
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleServer(p.id);
                              }}
                            >
                              {expanded ? (
                                <IconChevronDown size={12} />
                              ) : (
                                <IconChevronRight size={12} />
                              )}
                            </span>
                            <IconServer size={15} />
                            {p.color && (
                              <span className="color-dot" style={{ background: p.color }} />
                            )}
                            <span className="grow ellipsis">{p.name}</span>
                            {p.ssh?.tmuxEnabled && <span className="tag">tmux</span>}
                            {items.length > 0 && (
                              <span className="dim count">{items.length}</span>
                            )}
                            <button
                              type="button"
                              className="mini-x"
                              title="服务器管理（编辑 / 复制 / 删除）"
                              onClick={(e) => {
                                e.stopPropagation();
                                const r = (e.target as HTMLElement).getBoundingClientRect();
                                setCtxMenu({ profile: p, x: r.left - 170, y: r.bottom + 4 });
                              }}
                            >
                              ⋯
                            </button>
                          </div>
                          {expanded &&
                            items.map((h) => {
                              // tmux 会话能精确判断"是不是已经在标签里开着"
                              const opened = h.tmuxSession
                                ? sessions.find(
                                    (s) =>
                                      s.profileId === h.profileId &&
                                      s.tmuxName === h.tmuxSession,
                                  )
                                : undefined;
                              return (
                                <div
                                  key={h.id}
                                  className={"tree-item child" + (opened ? " opened" : "")}
                                  onClick={() => void connectFromHistory(h)}
                                  title={
                                    (h.tmuxSession ?? "普通 shell") +
                                    `　${relTime(h.lastUsed)}` +
                                    (opened ? "\n已经开着了 —— 点一下切到那个标签" : "")
                                  }
                                >
                                  <span
                                    className={"open-dot" + (opened ? " on" : "")}
                                    title={opened ? "已打开" : "未打开"}
                                  />
                                  <IconTerminal size={13} />
                                  <span className="grow ellipsis">
                                    {h.title?.trim() || h.tmuxSession || "普通 shell"}
                                  </span>
                                  {opened && <span className="tag">已打开</span>}
                                  <span className="dim">{relTime(h.lastUsed)}</span>
                                  <button
                                    type="button"
                                    className="mini-x"
                                    title="从历史中移除"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      void removeHistoryEntry(h.id);
                                    }}
                                  >
                                    ×
                                  </button>
                                </div>
                              );
                            })}
                          {expanded && items.length === 0 && (
                            <div className="tree-item child hint child-empty">
                              还没有会话历史。双击服务器可以新建/编辑连接。
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ))}

                <div className="side-actions">
                  <button
                    type="button"
                    className="btn primary"
                    onClick={() => openNewSessionDialog()}
                  >
                    <IconPlus size={14} /> 新建会话
                  </button>
                </div>

                {showForm && (
                  <div className="form">
                    <label>
                      名称
                      <input
                        value={form.name}
                        placeholder="可留空"
                        onChange={(e) => setForm({ ...form, name: e.target.value })}
                      />
                    </label>
                    <label>
                      主机
                      <input
                        value={form.host}
                        placeholder="例如 203.0.113.10"
                        onChange={(e) => setForm({ ...form, host: e.target.value })}
                      />
                    </label>
                    <div className="row">
                      <label className="grow">
                        端口
                        <input
                          value={form.port}
                          onChange={(e) => setForm({ ...form, port: Number(e.target.value) })}
                        />
                      </label>
                      <label className="grow">
                        用户
                        <input
                          value={form.user}
                          onChange={(e) => setForm({ ...form, user: e.target.value })}
                        />
                      </label>
                    </div>
                    <label>
                      分组
                      <input
                        value={form.group}
                        onChange={(e) => setForm({ ...form, group: e.target.value })}
                      />
                    </label>
                    <label>
                      私钥路径（可选，留空则用默认密钥 / ~/.ssh/config）
                      <input
                        value={form.keyPath}
                        placeholder="C:\Users\me\.ssh\id_ed25519"
                        onChange={(e) => setForm({ ...form, keyPath: e.target.value })}
                      />
                    </label>
                    <button type="button" className="btn primary" onClick={() => void submitProfile()}>
                      保存
                    </button>
                  </div>
                )}

                {grouped.length === 0 && !showForm && (
                  <div className="hint">
                    还没有连接。点「新建连接」添加一台服务器，
                    <br />
                    认证使用你本机已配置的 SSH 密钥。
                  </div>
                )}

                {tmuxTarget && (
                  <div className="tmux-panel">
                    <div className="tmux-head">
                      <span>tmux · {tmuxTarget.name}</span>
                      <span className="tmux-actions">
                        <button
                          type="button"
                          className="mini-btn"
                          onClick={() => void refreshTmux(tmuxTarget)}
                        >
                          刷新
                        </button>
                        <button
                          type="button"
                          className="mini-btn"
                          onClick={() => setTmuxTarget(null)}
                        >
                          关闭
                        </button>
                      </span>
                    </div>
                    {tmuxLoading && <div className="hint">正在读取…</div>}
                    {!tmuxLoading && tmuxSessions.length === 0 && (
                      <div className="hint">没有 tmux 会话（或服务器未安装 tmux）。</div>
                    )}
                    {tmuxSessions.map((s) => (
                      <div key={s.name} className="tmux-row">
                        <IconTerminal size={14} />
                        <span className="grow">{s.name}</span>
                        <span className="dim">{s.windows} 窗口</span>
                        {s.attached && <span className="tag">已连接</span>}
                        <button
                          type="button"
                          className="mini-btn"
                          onClick={() => void openSshSession(tmuxTarget, "name", s.name)}
                        >
                          连接
                        </button>
                        <button
                          type="button"
                          className="mini-btn"
                          onClick={() => void killTmux(tmuxTarget, s.name)}
                        >
                          结束
                        </button>
                      </div>
                    ))}
                  </div>
                )}

              </>
            )}

            {module === "remote" && sideTab === "files" && (
              <>
                {!fileProfile && (
                  <div className="hint">
                    先打开一个 SSH 会话。
                    <br />
                    「文件」窗格会跟随当前会话所在服务器的目录。
                  </div>
                )}
                {fileProfile && (
                  <>
                    <div className="fs-toolbar">
                      <button
                        type="button"
                        className="mini-btn"
                        onClick={() => void loadDir(fileProfile.id, parentOf(fsPath))}
                      >
                        ↑ 上级
                      </button>
                      <button
                        type="button"
                        className="mini-btn"
                        title="重新读取当前目录"
                        onClick={() => void loadDir(fileProfile.id, fsPath)}
                      >
                        刷新
                      </button>
                      <button
                        type="button"
                        className="mini-btn"
                        title="跳到终端当前所在目录（你在终端里 cd 到哪儿就同步到哪儿）"
                        onClick={() =>
                          void syncFsToTerminal(
                            fileProfile.id,
                            activeTmuxName,
                            activeSession?.cwd,
                          )
                        }
                      >
                        ⤓ 同步终端目录
                      </button>
                      <button
                        type="button"
                        className="mini-btn"
                        onClick={() => void loadDir(fileProfile.id, undefined)}
                      >
                        家目录
                      </button>
                      <button
                        type="button"
                        className="mini-btn"
                        disabled={fsBusy}
                        title="把本机文件上传到当前目录"
                        onClick={() => void uploadToRemote(fileProfile.id)}
                      >
                        上传
                      </button>
                      <button
                        type="button"
                        className="mini-btn"
                        disabled={fsBusy}
                        title="在当前目录新建文件夹"
                        onClick={() =>
                          setNameDialog({
                            mode: "mkdir",
                            profileId: fileProfile.id,
                            dir: fsPath,
                            from: "",
                            value: "新建文件夹",
                          })
                        }
                      >
                        新建文件夹
                      </button>
                      <button
                        type="button"
                        className={"mini-btn" + (settings.fsFollowTerminal ? " active" : "")}
                        title={
                          settings.fsFollowTerminal
                            ? "已开启：刷新会跳到终端（tmux）当前所在目录"
                            : "已关闭：刷新只重读当前目录"
                        }
                        onClick={() =>
                          void updateSettings({ fsFollowTerminal: !settings.fsFollowTerminal })
                        }
                      >
                        {settings.fsFollowTerminal ? "✓ 跟随终端" : "跟随终端"}
                      </button>
                    </div>
                    <input
                      className="fs-path-input"
                      value={fsInput}
                      spellCheck={false}
                      placeholder="/path/to/dir  回车跳转"
                      onChange={(e) => setFsInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          void loadDir(fileProfile.id, fsInput.trim() || undefined);
                        }
                      }}
                    />
                    <div className="fs-list">
                      {fsEntries.map((en) => (
                        <div
                          key={en.name}
                          className="fs-row"
                          onClick={() =>
                            en.isDir
                              ? void loadDir(fileProfile.id, joinPath(fsPath, en.name))
                              : void openRemoteFile(fileProfile.id, en.name)
                          }
                          onContextMenu={(e) => {
                            e.preventDefault();
                            setFsMenu({
                              profileId: fileProfile.id,
                              name: en.name,
                              isDir: en.isDir,
                              x: e.clientX,
                              y: e.clientY,
                            });
                          }}
                          title={
                            (en.isDir ? "进入目录" : "预览文件") +
                            "　（右键：下载 / 重命名 / 删除）"
                          }
                        >
                          {en.isDir ? <IconFolder size={15} /> : <IconFile size={15} />}
                          <span className="grow">{en.name}</span>
                          <span className="dim">{en.isDir ? "" : humanSize(en.size)}</span>
                          <button
                            type="button"
                            className="mini-x"
                            title="下载 / 重命名 / 删除"
                            onClick={(e) => {
                              e.stopPropagation();
                              const r = (e.target as HTMLElement).getBoundingClientRect();
                              setFsMenu({
                                profileId: fileProfile.id,
                                name: en.name,
                                isDir: en.isDir,
                                x: r.left - 150,
                                y: r.bottom + 4,
                              });
                            }}
                          >
                            ⋯
                          </button>
                        </div>
                      ))}
                      {!fsLoading && fsEntries.length === 0 && (
                        <div className="hint">目录为空，或没有读取权限。</div>
                      )}
                    </div>
                  </>
                )}
              </>
            )}

            {module === "powershell" && (
              <LocalModule
                label="PowerShell"
                sessions={sessions.filter((s) => s.kind === "powershell")}
                activeId={activeId}
                onOpen={() => void openLocalSession("powershell")}
                onActivate={setActiveId}
                onClose={(id) => void closeSession(id)}
              />
            )}
            {module === "cmd" && (
              <LocalModule
                label="命令提示符"
                sessions={sessions.filter((s) => s.kind === "cmd")}
                activeId={activeId}
                onOpen={() => void openLocalSession("cmd")}
                onActivate={setActiveId}
                onClose={(id) => void closeSession(id)}
              />
            )}
            {module === "wsl" && (
              <LocalModule
                label="WSL"
                sessions={sessions.filter((s) => s.kind === "wsl")}
                activeId={activeId}
                onOpen={() => void openLocalSession("wsl")}
                onActivate={setActiveId}
                onClose={(id) => void closeSession(id)}
              />
            )}
            {module === "git" && (
              <>
                <div className="side-actions">
                  <button
                    type="button"
                    className="btn primary"
                    title="选一个本地仓库目录，直接在这个目录开一个本地终端（PowerShell / CMD / WSL 按设置来）"
                    onClick={() => void openGitWorkspace()}
                  >
                    <IconPlus size={14} /> 打开本地仓库
                  </button>
                  <button
                    type="button"
                    className="btn"
                    title="在一个目录里执行 git init，建好后直接打开终端"
                    onClick={() => setGitInitDialog({ path: "" })}
                  >
                    新建仓库
                  </button>
                </div>
                <div className="tree-group">Git 工作空间</div>
                <div className="hint" style={{ paddingTop: 0 }}>
                  在某个仓库目录下起一个本地终端，可以直接敲 git 命令。
                </div>
                {gitWorkspaces.length === 0 && (
                  <div className="hint">
                    还没有工作空间。点「＋ 打开本地仓库」选一个已有仓库，或用「新建仓库」git init 一个。
                  </div>
                )}
                {gitWorkspaces.map((p) => (
                  <div
                    key={p.id}
                    className="tree-item"
                    title={`${p.local?.cwd}（点击查看改动，右侧按钮开终端）`}
                    onClick={() => {
                      const dir = p.local?.cwd ?? "";
                      setGitPath(dir);
                      void refreshGitAll(dir);
                    }}
                  >
                    <IconGit size={14} />
                    <span className="grow ellipsis">{p.name}</span>
                    <button
                      type="button"
                      className="mini-btn"
                      title="在这个目录再开一个新的本地终端（可以开任意多个）"
                      onClick={(e) => {
                        e.stopPropagation();
                        const dir = p.local?.cwd ?? "";
                        void openLocalSession(
                          p.local?.shell ?? settings.defaultShell,
                          p.local?.distro,
                          dir,
                          `${p.name}`,
                        );
                      }}
                    >
                      新终端
                    </button>
                    <button
                      type="button"
                      className="mini-x"
                      title="从工作空间里移除"
                      onClick={(e) => {
                        e.stopPropagation();
                        void removeGitWorkspace(p);
                      }}
                    >
                      ×
                    </button>
                  </div>
                ))}

                <div className="tree-group">快速查看某个仓库</div>
                <label className="modal-field" style={{ paddingTop: 4 }}>
                  仓库路径
                  <input
                    value={gitPath}
                    placeholder="D:\AI\ZeeAI_term"
                    onChange={(e) => setGitPath(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void refreshGitAll();
                    }}
                  />
                </label>
                <div className="side-actions">
                  <button
                    type="button"
                    className="btn"
                    disabled={gitBusy}
                    onClick={() => void refreshGitAll()}
                  >
                    {gitBusy ? "读取中…" : "刷新"}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    title="在当前仓库目录打开一个新的本地终端"
                    onClick={() => void openGitTerminal(gitPath, undefined)}
                  >
                    开终端
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={!gitState?.ok}
                    onClick={() => {
                      setShowBranches((v) => !v);
                      if (!gitBranchList.length && gitState?.ok) void refreshGitAll();
                    }}
                  >
                    分支 {gitState?.branch ? `(${gitState.branch})` : ""}
                  </button>
                </div>
                {gitLoading && <div className="hint">正在读取…</div>}
                {!gitLoading && gitState && !gitState.ok && (
                  <div className="hint">{gitState.message}</div>
                )}
                {!gitLoading && gitState?.ok && (
                  <>
                    {/* 分支列表 */}
                    {showBranches && (
                      <div className="git-branches">
                        {gitBranchList.map((b) => (
                          <div
                            key={b.name}
                            className={"tree-item" + (b.current ? " current" : "")}
                            title={`${b.name}${b.upstream ? ` → ${b.upstream}` : ""}　${b.when}`}
                            onClick={() => {
                              if (!b.current) void doGitCheckout(b.name);
                            }}
                          >
                            <IconGit size={13} />
                            <span className="grow ellipsis">{b.name}</span>
                            {b.current && <span className="tag">当前</span>}
                            <span className="dim">{b.when}</span>
                          </div>
                        ))}
                        <div className="git-newbranch">
                          <input
                            value={newBranch}
                            placeholder="新分支名"
                            onChange={(e) => setNewBranch(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && newBranch.trim())
                                void doGitCheckout(newBranch, true);
                            }}
                          />
                          <button
                            type="button"
                            className="mini-btn"
                            disabled={!newBranch.trim()}
                            onClick={() => void doGitCheckout(newBranch, true)}
                          >
                            新建并切换
                          </button>
                        </div>
                      </div>
                    )}

                    <div className="git-commit-box">
                      <textarea
                        className="git-commit-msg"
                        rows={2}
                        placeholder="提交信息（Ctrl+Enter 提交）"
                        value={gitMessage}
                        onChange={(e) => setGitMessage(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                            e.preventDefault();
                            void doGitCommit();
                          }
                        }}
                      />
                      <button
                        type="button"
                        className="btn primary git-commit-btn"
                        disabled={gitBusy || !gitMessage.trim()}
                        onClick={() => void doGitCommit()}
                      >
                        提交
                      </button>
                    </div>

                    {/* 已暂存 */}
                    {stagedFiles.length > 0 && (
                      <>
                        <div className="tree-group">
                          已暂存（{stagedFiles.length}）
                          <button
                            type="button"
                            className="mini-x"
                            style={{ marginLeft: "auto", opacity: 1 }}
                            title="全部取消暂存"
                            onClick={() => void doGitUnstage(stagedFiles.map((f) => f.path))}
                          >
                            −
                          </button>
                        </div>
                        {stagedFiles.map((f) => (
                          <div
                            key={"s" + f.path}
                            className="tree-item git-file"
                            title={`${f.path}（点击看 diff）`}
                            onClick={() => void showFileDiff(f.path, true)}
                          >
                            <span className="git-st staged">{f.st}</span>
                            <span className="grow ellipsis">{f.path}</span>
                            <button
                              type="button"
                              className="mini-x"
                              title="取消暂存"
                              onClick={(e) => {
                                e.stopPropagation();
                                void doGitUnstage([f.path]);
                              }}
                            >
                              −
                            </button>
                          </div>
                        ))}
                      </>
                    )}

                    {/* 更改 */}
                    <div className="tree-group">
                      更改（{changedFiles.length}）
                      <button
                        type="button"
                        className="mini-x"
                        style={{ marginLeft: "auto", opacity: 1 }}
                        title="全部暂存"
                        onClick={() => void doGitAdd()}
                      >
                        ＋
                      </button>
                    </div>
                    {changedFiles.length === 0 && (
                      <div className="hint">没有未暂存的改动。</div>
                    )}
                    {changedFiles.map((f) => (
                      <div
                        key={"c" + f.path}
                        className="tree-item git-file"
                        title={`${f.path}（点击看 diff）`}
                        onClick={() => void showFileDiff(f.path, false)}
                      >
                        <span className="git-st">{f.st}</span>
                        <span className="grow ellipsis">{f.path}</span>
                        <button
                          type="button"
                          className="mini-x"
                          title="暂存这个文件"
                          onClick={(e) => {
                            e.stopPropagation();
                            void doGitAdd([f.path]);
                          }}
                        >
                          ＋
                        </button>
                        <button
                          type="button"
                          className="mini-x"
                          title="丢弃改动（不可撤销）"
                          onClick={(e) => {
                            e.stopPropagation();
                            askGitDiscard([f.path]);
                          }}
                        >
                          ↺
                        </button>
                      </div>
                    ))}

                    <div className="hint">
                      分支 {gitState.branch || "(未知)"}
                      {gitState.upstream ? ` → ${gitState.upstream}` : ""}
                      {gitState.ahead > 0 ? ` · 领先 ${gitState.ahead}` : ""}
                      {gitState.behind > 0 ? ` · 落后 ${gitState.behind}` : ""}
                    </div>

                    {/* 历史 */}
                    <div className="tree-group">提交历史（{gitCommits.length}）</div>
                    {gitCommits.length === 0 && <div className="hint">还没有提交。</div>}
                    {gitCommits.map((cm) => (
                      <div
                        key={cm.hash}
                        className="tree-item git-commit"
                        title={`${cm.hash}\n${cm.author} · ${cm.when}\n点击查看这次提交的 diff`}
                        onClick={() => void showCommitDiff(cm.hash, cm.subject)}
                      >
                        <span className="git-hash">{cm.short}</span>
                        <span className="grow ellipsis">{cm.subject}</span>
                        <span className="dim">{cm.when}</span>
                      </div>
                    ))}
                  </>
                )}
                {!gitLoading && !gitState && (
                  <div className="hint">
                    填一个本地仓库路径（本机需安装 Git），回车或点「刷新状态」查看分支与改动。
                  </div>
                )}
              </>
            )}
            {module === "serial" && (
              <>
                <div className="side-actions">
                  <button
                    type="button"
                    className="btn primary"
                    onClick={() => openSerialDialog()}
                  >
                    <IconPlus size={14} /> 新建串口连接
                  </button>
                </div>
                <div className="hint" style={{ paddingTop: 0 }}>
                  这里只列你**自己建过**的串口连接。系统里那些蓝牙 / 虚拟串口不会出现在这里，
                  免得点错——要用哪些口，你自己加。
                </div>
                {serialLoading && <div className="hint">正在检测串口…</div>}
                {!serialLoading && serialProfiles.length === 0 && (
                  <div className="hint">
                    还没有串口连接。
                    <br />
                    点上面「＋ 新建串口连接」，选好端口和波特率，保存后就会出现在这里。
                  </div>
                )}
                {serialProfiles.map((p) => {
                  const cfg = p.serial;
                  const alive = serialPorts.some((x) => x.path === cfg?.path);
                  return (
                    <div
                      key={p.id}
                      className="tree-item"
                      onClick={() => void openSerialSession(p)}
                      title={`${cfg?.path} · ${cfg?.baudRate} 波特率（点击打开）`}
                    >
                      <IconSerial size={15} />
                      <span className="grow ellipsis">{p.name}</span>
                      <span className="dim">{cfg?.baudRate}</span>
                      {!alive && <span className="tag warn">未接入</span>}
                      <button
                        type="button"
                        className="mini-x"
                        title="编辑 / 复制 / 删除"
                        onClick={(e) => {
                          e.stopPropagation();
                          const r = (e.target as HTMLElement).getBoundingClientRect();
                          setSerialMenu({ profile: p, x: r.left - 170, y: r.bottom + 4 });
                        }}
                      >
                        ⋯
                      </button>
                    </div>
                  );
                })}
              </>
            )}
            {module === "adb" && (
              <>
                <div className="side-actions">
                  <button type="button" className="btn" onClick={() => void refreshAdb()}>
                    <IconPlus size={14} /> 刷新设备
                  </button>
                </div>
                <div className="hint">
                  {adbVer
                    ? `adb 已就绪：${adbVer}`
                    : adbLoading
                      ? "正在检测 adb…"
                      : "未检测到 adb（应内置在应用里）"}
                </div>
                {!adbLoading && adbList.length === 0 && adbVer !== "" && (
                  <div className="hint">
                    没有已连接的 Android 设备。
                    <br />
                    用 USB 连接手机并打开「USB 调试」后再刷新。
                  </div>
                )}
                {adbList.map((d) => (
                  <div
                    key={d.serial}
                    className="tree-item"
                    onClick={() => void openAdbSession(d.serial)}
                    title={`${d.serial} · ${d.state} — 点击打开 adb shell`}
                  >
                    <IconAndroid size={15} />
                    <span className="grow">{d.model || d.serial}</span>
                    <button
                      type="button"
                      className="mini-btn"
                      title="打开设备文件管理（浏览 / 推送 / 拉取）"
                      onClick={(e) => {
                        e.stopPropagation();
                        setAdbSerial(d.serial);
                        void refreshAdbFiles(d.serial, "/sdcard");
                      }}
                    >
                      文件
                    </button>
                    <button
                      type="button"
                      className="mini-btn"
                      title="打开 logcat（实时日志）"
                      onClick={(e) => {
                        e.stopPropagation();
                        void openAdbSession(d.serial, "logcat");
                      }}
                    >
                      logcat
                    </button>
                    <span className={d.state === "device" ? "dot ok" : "dot off"} />
                  </div>
                ))}
                <div className="tree-group">Fastboot（bootloader 模式）</div>
                <div className="hint">
                  {fbVer ? `fastboot 已就绪：${fbVer}` : "未检测到 fastboot"}
                </div>
                {fbList.length === 0 && (
                  <div className="hint">
                    没有 fastboot 设备。手机进 bootloader（`adb reboot bootloader`）后点「刷新设备」。
                  </div>
                )}
                {fbList.map((d) => (
                  <div key={d.serial} className="tree-item" title={`${d.serial} · ${d.state}`}>
                    <IconAndroid size={15} />
                    <span className="grow ellipsis">{d.serial}</span>
                    <span className="tag">fastboot</span>
                  </div>
                ))}
              </>
            )}
          </div>

          {/* tmux 快捷操作：只在当前会话是 tmux 会话时出现，钉在侧栏底部 */}
          {module === "remote" && curTmuxSession !== "" && (
            <div className="tmux-dock">
              <button
                type="button"
                className="tmux-head"
                title="不想记 Ctrl+B 的话，点这里的按钮就行（Ctrl+B 本身照旧可用）"
                onClick={() => setTmuxDockOpen((v) => !v)}
              >
                {tmuxDockOpen ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}
                <span className="grow">tmux 快捷操作</span>
                <span className="tag">{curTmuxSession}</span>
              </button>

              {tmuxDockOpen && (
                <div className="tmux-body">
                  <div className="tmux-grid">
                    {TMUX_ACTIONS.map((a) => (
                      <button
                        key={a.key}
                        type="button"
                        className="mini-btn tmux-btn"
                        title={a.title}
                        disabled={tmuxBusy}
                        onClick={() => {
                          if (a.key === "rename-window") {
                            const cur = tmuxWinList.find((w) => w.active);
                            setTmuxRename(cur?.name ?? "");
                            return;
                          }
                          void runTmuxAction(a.key);
                        }}
                      >
                        {a.label}
                      </button>
                    ))}
                  </div>

                  {tmuxRename !== null && (
                    <div className="tmux-rename">
                      <input
                        autoFocus
                        value={tmuxRename}
                        placeholder="给当前窗口起个名字"
                        onChange={(e) => setTmuxRename(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            void runTmuxAction("rename-window", tmuxRename);
                            setTmuxRename(null);
                          } else if (e.key === "Escape") {
                            setTmuxRename(null);
                          }
                        }}
                      />
                      <button
                        type="button"
                        className="mini-btn"
                        onClick={() => {
                          void runTmuxAction("rename-window", tmuxRename);
                          setTmuxRename(null);
                        }}
                      >
                        确定
                      </button>
                    </div>
                  )}

                  <div className="tmux-sub">
                    <span className="grow">窗口（点一下切过去）</span>
                    <button
                      type="button"
                      className="mini-x"
                      style={{ opacity: 1 }}
                      title="刷新窗口列表"
                      onClick={() => void refreshTmuxWindows()}
                    >
                      ↻
                    </button>
                  </div>
                  <div className="tmux-wins">
                    {tmuxWinList.length === 0 && (
                      <div className="hint" style={{ padding: "2px 8px" }}>
                        没读到窗口（服务器可能刚断开，点 ↻ 重试）
                      </div>
                    )}
                    {tmuxWinList.map((w) => (
                      <button
                        key={w.index}
                        type="button"
                        className={"tmux-win" + (w.active ? " active" : "")}
                        title={w.panes > 1 ? `${w.panes} 个窗格` : undefined}
                        onClick={() => void runTmuxAction("select-window", String(w.index))}
                      >
                        <span className="dim">{w.index}</span>
                        <span className="grow ellipsis">{w.name || "—"}</span>
                        {w.panes > 1 && <span className="tag">{w.panes} 格</span>}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </aside>

        <main className="main">
          <div className="session-tabs">
            {sessions.map((s) => (
              <button
                key={s.id}
                type="button"
                className={"session-tab" + (s.id === activeId ? " active" : "")}
                onClick={() => setActiveId(s.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setActiveId(s.id);
                  setTabMenu({ id: s.id, x: e.clientX, y: e.clientY });
                }}
                title={`${s.title}（右键可以重命名）`}
              >
                {moduleIcon(s.kind)}
                <span>{s.title}</span>
                {s.logPath && <span className="rec-dot" title="正在记录终端日志" />}
                <span className={"status-dot " + s.state} />
                {(s.state === "closed" || s.state === "error") && s.profileId && (
                  <span
                    className="tab-x"
                    title="重新连接"
                    onClick={(e) => {
                      e.stopPropagation();
                      void reconnectSession(s);
                    }}
                  >
                    ↻
                  </span>
                )}
                <span
                  className="tab-x"
                  onClick={(e) => {
                    e.stopPropagation();
                    void closeSession(s.id);
                  }}
                >
                  <IconClose size={12} />
                </span>
              </button>
            ))}
            {sessions.length === 0 && (
              <span className="session-tab placeholder">没有打开的会话</span>
            )}
          </div>

          {activeSession && activeSession.openFiles.length > 0 && (
            <div className="sub-tabs">
              <button
                type="button"
                className={"sub-tab term" + (activeSession.activeTab === "terminal" ? " active" : "")}
                onClick={() => selectTab(activeSession.id, "terminal")}
              >
                <IconTerminal size={14} /> 终端
              </button>
              {activeSession.openFiles.map((f) => (
                <button
                  key={f.path}
                  type="button"
                  className={"sub-tab file" + (activeSession.activeTab === f.name ? " active" : "")}
                  onClick={() => selectTab(activeSession.id, f.name)}
                >
                  <IconFile size={14} />
                  <span>{f.name}</span>
                  <span
                    className="tab-x"
                    onClick={(e) => {
                      e.stopPropagation();
                      closeFile(activeSession.id, f.name);
                    }}
                  >
                    <IconClose size={11} />
                  </span>
                </button>
              ))}
            </div>
          )}

          <div className="pane">
            {paneLayout !== "single" && (
              <div className={"pane-grid " + paneLayout}>
                {paneSlots.map((sid, i) => {
                  const ps = sid ? sessions.find((s) => s.id === sid) : null;
                  return (
                    <div
                      key={i}
                      className={"pane-cell" + (i === focusedPane ? " focused" : "")}
                      onClick={() => {
                        setFocusedPane(i);
                        if (sid) setActiveId(sid);
                      }}
                    >
                      <div className="pane-cell-head">
                        <span className="grow ellipsis">
                          {ps ? `${MODULE_LABEL[ps.kind]} · ${ps.title}` : `窗格 ${i + 1}（空）`}
                        </span>
                        {sid && (
                          <button
                            type="button"
                            className="mini-x"
                            style={{ opacity: 1 }}
                            title="把这个窗格空出来（不会关闭会话）"
                            onClick={(e) => {
                              e.stopPropagation();
                              setPanes((prev) => {
                                const next = [...prev];
                                next[i] = null;
                                return next;
                              });
                            }}
                          >
                            ✕
                          </button>
                        )}
                      </div>
                      <div className="pane-cell-body">
                        {ps ? (
                          <TerminalView
                            key={ps.id}
                            sessionId={ps.id}
                            bus={bus}
                            active={i === focusedPane}
                            fontSize={settings.fontSize}
                            scrollback={settings.scrollback}
                            light={themeKind(settings.theme) === "light"}
                            palette={termPalette}
                            onCwd={(path) => handleTerminalCwd(ps.id, path)}
                            onNotice={notify}
                            onZoom={bumpFont}
                          />
                        ) : (
                          <div className="pane-empty">
                            点左侧「会话」里的任意一个会话，它就会出现在这个窗格。
                            <br />
                            分屏只是多开几个视口，会话本身还是一个。
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {paneLayout === "single" && sessions.length === 0 ? (
              <div className="empty">
                <div className="empty-title">ZeeAI Terminal</div>
                <div className="empty-sub">
                  左侧「远程」里选一台服务器，或用 PowerShell / CMD / WSL 打开本地终端。
                </div>
              </div>
            ) : paneLayout === "single" ? (
              sessions.map((s) => (
                <div
                  key={s.id}
                  className="term-wrap"
                  style={{
                    display:
                      s.id === activeId && s.activeTab === "terminal" ? "block" : "none",
                  }}
                >
                  <TerminalView
                    sessionId={s.id}
                    bus={bus}
                    active={s.id === activeId && s.activeTab === "terminal"}
                    fontSize={settings.fontSize}
                    scrollback={settings.scrollback}
                    light={themeKind(settings.theme) === "light"}
                    palette={termPalette}
                    onCwd={(path) => handleTerminalCwd(s.id, path)}
                    onNotice={notify}
                    onZoom={bumpFont}
                  />
                </div>
              ))
            ) : null}
            {paneLayout === "single" && activeFile && (
              <div className="file-wrap">
                <FileView key={activeFile.path} file={activeFile} />
              </div>
            )}
          </div>
        </main>

        {aiPanelOpen && (
          <aside className="ai-panel">
            <div className="ai-head">
              <span className="grow ellipsis" title={activeSession?.title}>
                AI Agent{activeSession ? ` · ${activeSession.title}` : ""}
              </span>
              <button
                type="button"
                className="mini-x"
                style={{ opacity: 1 }}
                title="刷新"
                onClick={() => void refreshAi()}
              >
                ⟳
              </button>
              <button
                type="button"
                className="mini-x"
                style={{ opacity: 1 }}
                title="收起面板"
                onClick={() => setAiPanelOpen(false)}
              >
                ✕
              </button>
            </div>

            {aiNotices.length > 0 && (
              <div className="ai-notices">
                <div className="ai-section">
                  消息通知（{aiNotices.length}）
                  <button
                    type="button"
                    className="mini-x"
                    style={{ marginLeft: "auto", opacity: 1 }}
                    title="清空"
                    onClick={() => setAiNotices([])}
                  >
                    ✕
                  </button>
                </div>
                {aiNotices.slice(0, 4).map((n) => (
                  <div className="ai-notice" key={n.id}>
                    <span className="dot ok" />
                    <span className="grow ellipsis" title={n.text}>
                      {n.text}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {!activeSession?.profileId && (
              <div className="hint" style={{ padding: "10px 12px" }}>
                AI 面板是跟着**当前会话所在的服务器**走的。
                <br />
                先打开一个 SSH 会话，再回来这里探测 / 安装 / 启动。
              </div>
            )}

            {activeSession?.profileId && (
              <>
                <div className="hint" style={{ padding: "8px 12px 4px" }}>
                  npm：{aiState?.npm ? aiState.npm : "未检测到（装 Node.js 才能装 Codex/Claude/Gemini）"}
                  {aiState?.running.length ? `　运行中：${aiState.running.join(", ")}` : ""}
                </div>
                <div className="ai-section">AI 命令行工具</div>
                {(aiState?.tools ?? []).map((t) => {
                  const running = aiState?.running.includes(t.name) ?? false;
                  return (
                    <div className="ai-tool" key={t.name}>
                      <div className="ai-tool-line">
                        <span className={"dot " + (running ? "ok" : t.installed ? "idle" : "off")} />
                        <span className="grow ellipsis">{t.label}</span>
                        <span className="dim">
                          {running ? "运行中" : t.installed ? "已安装" : "未安装"}
                        </span>
                      </div>
                      <div className="ai-tool-meta ellipsis" title={t.version || t.installCmd}>
                        {t.version || t.installCmd}
                      </div>
                      <div className="ai-tool-actions">
                        {!t.installed && (
                          <span className="ai-install-hint">未安装 —— 先装</span>
                        )}
                        <button
                          type="button"
                          className={"mini-btn" + (t.installed ? " primary" : "")}
                          title={
                            t.installed
                              ? "把启动命令敲进当前终端并回车，AI 跑完会通知你"
                              : "把安装命令敲进当前终端并回车，进度你自己看"
                          }
                          disabled={!activeSession}
                          onClick={() => aiStartTool(t.installed ? t.runCmd : t.installCmd)}
                        >
                          {t.installed ? "在终端启动" : "在终端安装"}
                        </button>
                      </div>
                    </div>
                  );
                })}
                {!aiState && (
                  <div className="hint" style={{ padding: "8px 12px" }}>
                    正在探测这台服务器…
                  </div>
                )}
                <div className="hint" style={{ padding: "10px 12px" }}>
                  这些按钮只是**把命令敲进当前终端**，装/跑的过程你自己看得见。
                  <br />
                  AI 跑完（进程退出）我会在这里给你一条消息通知。
                </div>
              </>
            )}
          </aside>
        )}
      </div>

      <div className="statusbar">
        <span className="stat">
          <IconActivity size={14} />
          {activeSession
            ? `${MODULE_LABEL[activeSession.kind]} · ${activeSession.title} · ${stateText(activeSession.state)}`
            : "就绪"}
        </span>
        <span className="spacer" />
        {statusMsg && (
          <span
            className={"status-notice " + statusMsg.kind}
            title={statusMsg.text}
            onClick={() => setStatusMsg(null)}
          >
            {statusMsg.text}
          </span>
        )}
        {activeFile && <span className="stat">{activeFile.path}</span>}
        <span className="stat">UTF-8</span>
        <span className="stat">xterm-256color</span>
      </div>

      {transfers.length > 0 && (
        <div className="transfer-dock">
          <div className="transfer-head">
            <span>文件传输（{transfers.filter((t) => t.status === "running").length} 进行中）</span>
            <button
              type="button"
              className="mini-x"
              style={{ opacity: 1 }}
              title="清空列表"
              onClick={() => setTransfers([])}
            >
              ✕
            </button>
          </div>
          {transfers.map((t) => {
            const pct =
              t.total > 0 ? Math.min(100, Math.round((t.done / t.total) * 100)) : 0;
            return (
              <div key={t.id} className={"transfer-item " + t.status}>
                <div className="transfer-line">
                  <span className="grow ellipsis" title={t.name}>
                    {t.name}
                  </span>
                  <span className="dim">
                    {t.status === "done"
                      ? "完成"
                      : t.status === "failed"
                        ? "失败"
                        : `${pct}%`}
                  </span>
                </div>
                <div className="transfer-bar">
                  <div
                    className="transfer-fill"
                    style={{ width: t.status === "done" ? "100%" : `${pct}%` }}
                  />
                </div>
                <div className="transfer-meta">
                  {humanSize(t.done)}
                  {t.total > 0 ? ` / ${humanSize(t.total)}` : ""}
                  {t.message ? ` · ${t.message}` : ""}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {openMenu && <div className="menu-overlay" onClick={() => setOpenMenu(null)} />}

      {serialMenu && (
        <div
          className="ctx-backdrop"
          onClick={() => setSerialMenu(null)}
          onContextMenu={(e) => {
            e.preventDefault();
            setSerialMenu(null);
          }}
        >
          <div
            className="ctx-menu"
            style={{
              left: Math.min(Math.max(0, serialMenu.x), Math.max(0, window.innerWidth - 210)),
              top: Math.min(Math.max(0, serialMenu.y), Math.max(0, window.innerHeight - 190)),
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="menu-head ellipsis">{serialMenu.profile.name}</div>
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                const p = serialMenu.profile;
                setSerialMenu(null);
                void openSerialSession(p);
              }}
            >
              打开串口终端
            </button>
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                const p = serialMenu.profile;
                setSerialMenu(null);
                openSerialDialog(p);
              }}
            >
              编辑（端口 / 波特率 / 校验…）
            </button>
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                const p = serialMenu.profile;
                setSerialMenu(null);
                void duplicateProfile(p);
              }}
            >
              复制
            </button>
            <div className="menu-sep" />
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                const p = serialMenu.profile;
                setSerialMenu(null);
                setConfirmDialog({
                  title: "删除串口连接",
                  message: `确定删除「${p.name}」这条串口连接吗？`,
                  onOk: () => void removeSerialProfile(p),
                });
              }}
            >
              删除
            </button>
          </div>
        </div>
      )}

      {adbSerial && (
        <div className="modal-backdrop" onClick={() => setAdbSerial(null)}>
          <div className="modal wide" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">设备文件 · {adbSerial}</div>
            <div className="modal-body">
              <div className="side-actions">
                <button
                  type="button"
                  className="mini-btn"
                  title="回到 /sdcard"
                  onClick={() => void refreshAdbFiles(adbSerial, "/sdcard")}
                >
                  /sdcard
                </button>
                <button
                  type="button"
                  className="mini-btn"
                  title="上一级"
                  onClick={() => {
                    const parent = adbPath.replace(/\/+$/, "").split("/").slice(0, -1).join("/");
                    void refreshAdbFiles(adbSerial, parent.startsWith("/") ? parent : "/");
                  }}
                >
                  上一级
                </button>
                <button
                  type="button"
                  className="mini-btn"
                  onClick={() => void refreshAdbFiles(adbSerial, adbPath)}
                >
                  刷新
                </button>
                <button
                  type="button"
                  className="mini-btn"
                  title="把本机文件推到当前目录"
                  onClick={() => void adbUpload(adbSerial)}
                >
                  推送文件
                </button>
              </div>
              <div className="modal-inline-action" style={{ paddingBottom: 8 }}>
                <input
                  className="modal-input"
                  style={{ flex: 1 }}
                  value={adbPath}
                  spellCheck={false}
                  onChange={(e) => setAdbPath(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && adbSerial) void refreshAdbFiles(adbSerial, adbPath);
                  }}
                />
              </div>
              <div className="modal-inline-action" style={{ paddingBottom: 8 }}>
                <input
                  className="modal-input"
                  style={{ flex: 1 }}
                  placeholder="新建文件夹的名字"
                  value={adbNewName}
                  onChange={(e) => setAdbNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && adbSerial) void adbMkdirNow(adbSerial, adbNewName);
                  }}
                />
                <button
                  type="button"
                  className="mini-btn"
                  style={{ marginLeft: 6 }}
                  disabled={!adbNewName.trim()}
                  onClick={() => adbSerial && void adbMkdirNow(adbSerial, adbNewName)}
                >
                  新建文件夹
                </button>
              </div>
              {adbLoading && <div className="hint">正在读取设备目录…</div>}
              {!adbLoading && adbFiles.length === 0 && (
                <div className="hint">这个目录是空的（或者没有读取权限，试试 /sdcard）。</div>
              )}
              {adbFiles.map((f) => (
                <div
                  key={f.name}
                  className="tree-item"
                  title={f.isDir ? "进入目录" : "下载到本机"}
                  onClick={() =>
                    adbSerial &&
                    (f.isDir
                      ? void refreshAdbFiles(adbSerial, joinRemote(adbPath, f.name))
                      : void adbDownload(adbSerial, f.name))
                  }
                >
                  {f.isDir ? <IconFolder size={14} /> : <IconFile size={14} />}
                  <span className="grow ellipsis">{f.name}</span>
                  <span className="dim">{f.isDir ? "" : humanSize(f.size)}</span>
                  <button
                    type="button"
                    className="mini-x"
                    title="删除"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (adbSerial) void adbDelete(adbSerial, f.name, f.isDir);
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setAdbSerial(null)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {gitInitDialog && (
        <div className="modal-backdrop" onClick={() => setGitInitDialog(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">新建 Git 仓库</div>
            <div className="modal-body">
              <label className="modal-field">
                仓库目录（不存在会自动创建）
                <input
                  autoFocus
                  value={gitInitDialog.path}
                  placeholder="D:\code\my-repo"
                  onChange={(e) => setGitInitDialog({ path: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void createGitRepo(gitInitDialog.path);
                    if (e.key === "Escape") setGitInitDialog(null);
                  }}
                />
              </label>
              <div className="modal-inline-action" style={{ paddingBottom: 8 }}>
                <button
                  type="button"
                  className="mini-btn"
                  onClick={() => {
                    void (async () => {
                      const picked = await openLocalDialog({
                        directory: true,
                        title: "选一个目录（可以是空目录）",
                      });
                      if (picked && !Array.isArray(picked)) {
                        setGitInitDialog({ path: picked });
                      }
                    })();
                  }}
                >
                  浏览目录…
                </button>
                <span className="hint" style={{ marginLeft: 8 }}>
                  会在该目录执行 <code>git init -b main</code>，然后开一个终端。
                </span>
              </div>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setGitInitDialog(null)}>
                取消
              </button>
              <button
                type="button"
                className="btn primary"
                onClick={() => void createGitRepo(gitInitDialog.path)}
              >
                创建并打开终端
              </button>
            </div>
          </div>
        </div>
      )}

      {diffDialog && (
        <div className="modal-backdrop" onClick={() => setDiffDialog(null)}>
          <div className="modal wide diff-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head ellipsis" title={diffDialog.title}>
              {diffDialog.title}
            </div>
            <div className="modal-body diff-body">
              <pre className="diff-pre">
                {diffDialog.text.split("\n").map((line, i) => (
                  <div
                    key={i}
                    className={
                      "diff-line" +
                      (line.startsWith("+") && !line.startsWith("+++")
                        ? " add"
                        : line.startsWith("-") && !line.startsWith("---")
                          ? " del"
                          : line.startsWith("@@")
                            ? " hunk"
                            : line.startsWith("diff ") ||
                                line.startsWith("index ") ||
                                line.startsWith("commit ")
                              ? " meta"
                              : "")
                    }
                  >
                    {line || " "}
                  </div>
                ))}
              </pre>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setDiffDialog(null)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {serialDialog && (
        <div className="modal-backdrop" onClick={() => setSerialDialog(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              {serialDialog.isNew ? "新建串口连接" : "编辑串口连接"}
            </div>
            <div className="modal-body">
              <label className="modal-field">
                名称
                <input
                  value={serialDialog.draft.name}
                  placeholder="比如：ESP32 调试口"
                  onChange={(e) => patchSerialDraft({ name: e.target.value })}
                />
              </label>

              <label className="modal-field">
                端口
                <select
                  value={
                    serialPorts.some((p) => p.path === serialDialog.draft.serial?.path)
                      ? serialDialog.draft.serial?.path
                      : "__custom__"
                  }
                  onChange={(e) => {
                    if (e.target.value !== "__custom__") {
                      patchSerialDraft({}, { path: e.target.value });
                    }
                  }}
                >
                  {serialPorts.map((p) => (
                    <option key={p.path} value={p.path}>
                      {p.path} — {p.label}
                    </option>
                  ))}
                  <option value="__custom__">
                    {serialPorts.length === 0 ? "（没检测到串口，手动输入）" : "手动输入…"}
                  </option>
                </select>
              </label>
              <label className="modal-field">
                端口名（也可以直接手填）
                <input
                  value={serialDialog.draft.serial?.path ?? ""}
                  placeholder="COM5"
                  onChange={(e) => patchSerialDraft({}, { path: e.target.value })}
                />
              </label>
              <div className="modal-inline-action" style={{ paddingBottom: 8 }}>
                <button
                  type="button"
                  className="mini-btn"
                  disabled={serialLoading}
                  onClick={() => void refreshSerial()}
                >
                  {serialLoading ? "检测中…" : "重新检测串口"}
                </button>
                <span className="hint" style={{ marginLeft: 8 }}>
                  检测到 {serialPorts.length} 个口（含蓝牙/虚拟串口，按需选）
                </span>
              </div>

              <div className="modal-row">
                <label className="modal-field">
                  波特率
                  <select
                    value={
                      [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600].includes(
                        serialDialog.draft.serial?.baudRate ?? 115200,
                      )
                        ? String(serialDialog.draft.serial?.baudRate)
                        : "__custom__"
                    }
                    onChange={(e) => {
                      if (e.target.value !== "__custom__") {
                        patchSerialDraft({}, { baudRate: Number(e.target.value) });
                      }
                    }}
                  >
                    {[9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600].map((b) => (
                      <option key={b} value={b}>
                        {b}
                      </option>
                    ))}
                    <option value="__custom__">自定义…</option>
                  </select>
                </label>
                <label className="modal-field">
                  自定义波特率
                  <input
                    value={serialDialog.draft.serial?.baudRate ?? 115200}
                    onChange={(e) =>
                      patchSerialDraft({}, { baudRate: Number(e.target.value) || 115200 })
                    }
                  />
                </label>
              </div>

              <div className="modal-row">
                <label className="modal-field">
                  数据位
                  <select
                    value={serialDialog.draft.serial?.dataBits ?? 8}
                    onChange={(e) => patchSerialDraft({}, { dataBits: Number(e.target.value) })}
                  >
                    {[5, 6, 7, 8].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="modal-field">
                  停止位
                  <select
                    value={serialDialog.draft.serial?.stopBits ?? 1}
                    onChange={(e) => patchSerialDraft({}, { stopBits: Number(e.target.value) })}
                  >
                    <option value={1}>1</option>
                    <option value={2}>2</option>
                  </select>
                </label>
              </div>

              <div className="modal-row">
                <label className="modal-field">
                  校验位
                  <select
                    value={serialDialog.draft.serial?.parity ?? "none"}
                    onChange={(e) =>
                      patchSerialDraft({}, {
                        parity: e.target.value as SerialConfig["parity"],
                      })
                    }
                  >
                    <option value="none">无 (None)</option>
                    <option value="odd">奇校验 (Odd)</option>
                    <option value="even">偶校验 (Even)</option>
                  </select>
                </label>
                <label className="modal-field">
                  流控
                  <select
                    value={serialDialog.draft.serial?.flowControl ?? "none"}
                    onChange={(e) =>
                      patchSerialDraft({}, {
                        flowControl: e.target.value as SerialConfig["flowControl"],
                      })
                    }
                  >
                    <option value="none">无</option>
                    <option value="software">软件 (XON/XOFF)</option>
                    <option value="hardware">硬件 (RTS/CTS)</option>
                  </select>
                </label>
              </div>

              <div className="hint" style={{ padding: "0 14px" }}>
                这些参数是**这条连接自己的**，不会影响别的串口。
              </div>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setSerialDialog(null)}>
                取消
              </button>
              <button type="button" className="btn" onClick={() => void saveSerialDialog(false)}>
                仅保存
              </button>
              <button
                type="button"
                className="btn primary"
                onClick={() => void saveSerialDialog(true)}
              >
                保存并打开
              </button>
            </div>
          </div>
        </div>
      )}

      {tabMenu && (
        <div
          className="ctx-backdrop"
          onClick={() => setTabMenu(null)}
          onContextMenu={(e) => {
            e.preventDefault();
            setTabMenu(null);
          }}
        >
          <div
            className="ctx-menu"
            style={{
              left: Math.min(Math.max(0, tabMenu.x), Math.max(0, window.innerWidth - 210)),
              top: Math.min(Math.max(0, tabMenu.y), Math.max(0, window.innerHeight - 170)),
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                const m = tabMenu;
                const s = sessions.find((x) => x.id === m.id);
                setTabMenu(null);
                setSessionRename({ id: m.id, value: s?.title ?? "" });
              }}
            >
              重命名会话…
            </button>
            {(() => {
              const s = sessions.find((x) => x.id === tabMenu.id);
              if (!s?.profileId) return null;
              return (
                <button
                  type="button"
                  className="menu-item"
                  onClick={() => {
                    setTabMenu(null);
                    if (s) void reconnectSession(s);
                  }}
                >
                  重新连接
                </button>
              );
            })()}
            {(() => {
              const s = sessions.find((x) => x.id === tabMenu.id);
              if (!s) return null;
              return s.logPath ? (
                <>
                  <button
                    type="button"
                    className="menu-item"
                    onClick={() => {
                      setTabMenu(null);
                      void stopSessionLog(s);
                    }}
                  >
                    停止记录终端日志
                  </button>
                  <button
                    type="button"
                    className="menu-item"
                    onClick={() => {
                      setTabMenu(null);
                      void openSessionLog(s);
                    }}
                  >
                    打开日志文件
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="menu-item"
                  onClick={() => {
                    setTabMenu(null);
                    void startSessionLog(s);
                  }}
                >
                  开始记录终端日志
                </button>
              );
            })()}
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                setTabMenu(null);
                void (async () => {
                  try {
                    await openInExplorer(await sessionLogDir());
                  } catch (e) {
                    notify("打开日志目录失败：" + String(e));
                  }
                })();
              }}
            >
              打开日志目录
            </button>
            <div className="menu-sep" />
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                const m = tabMenu;
                setTabMenu(null);
                void closeSession(m.id);
              }}
            >
              关闭会话
            </button>
          </div>
        </div>
      )}

      {sessionRename && (
        <div className="modal-backdrop" onClick={() => setSessionRename(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">重命名会话</div>
            <div className="modal-body">
              <label className="modal-field">
                显示名字
                <input
                  autoFocus
                  value={sessionRename.value}
                  placeholder="比如：后端调试 / AI 写文档"
                  onChange={(e) =>
                    setSessionRename({ ...sessionRename, value: e.target.value })
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void renameSession(sessionRename.id, sessionRename.value);
                    if (e.key === "Escape") setSessionRename(null);
                  }}
                />
              </label>
              <div className="hint" style={{ padding: "0 14px" }}>
                改完会同时记进「会话历史」，下次从历史点进来还是这个名字。
              </div>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setSessionRename(null)}>
                取消
              </button>
              <button
                type="button"
                className="btn primary"
                onClick={() => void renameSession(sessionRename.id, sessionRename.value)}
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {fsMenu && (
        <div
          className="ctx-backdrop"
          onClick={() => setFsMenu(null)}
          onContextMenu={(e) => {
            e.preventDefault();
            setFsMenu(null);
          }}
        >
          <div
            className="ctx-menu"
            style={{
              left: Math.min(Math.max(0, fsMenu.x), Math.max(0, window.innerWidth - 210)),
              top: Math.min(Math.max(0, fsMenu.y), Math.max(0, window.innerHeight - 190)),
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="menu-head ellipsis" title={fsMenu.name}>
              {fsMenu.name}
            </div>
            {!fsMenu.isDir && (
              <button
                type="button"
                className="menu-item"
                onClick={() => {
                  const m = fsMenu;
                  setFsMenu(null);
                  void openRemoteFile(m.profileId, m.name);
                }}
              >
                打开预览
              </button>
            )}
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                const m = fsMenu;
                setFsMenu(null);
                void downloadFromRemote(m.profileId, m.name);
              }}
            >
              下载到本机…
            </button>
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                const m = fsMenu;
                setFsMenu(null);
                setNameDialog({
                  mode: "rename",
                  profileId: m.profileId,
                  dir: fsPath,
                  from: m.name,
                  value: m.name,
                });
              }}
            >
              重命名…
            </button>
            <div className="menu-sep" />
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                const m = fsMenu;
                setFsMenu(null);
                setConfirmDialog({
                  title: m.isDir ? "删除目录" : "删除文件",
                  message:
                    `确定要删除服务器上的 ${joinPath(fsPath, m.name)} 吗？` +
                    (m.isDir ? "目录会被递归删除。" : "") +
                    "此操作不可撤销。",
                  onOk: () => void doRemoveRemote(m.profileId, m.name),
                });
              }}
            >
              删除（不可撤销）
            </button>
          </div>
        </div>
      )}

      {nameDialog && (
        <div className="modal-backdrop" onClick={() => setNameDialog(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              {nameDialog.mode === "mkdir" ? "新建文件夹" : "重命名"}
            </div>
            <div className="modal-body">
              <label className="modal-field">
                {nameDialog.mode === "mkdir" ? "文件夹名" : "新名字"}
                <input
                  autoFocus
                  value={nameDialog.value}
                  onChange={(e) => setNameDialog({ ...nameDialog, value: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void confirmNameDialog();
                    if (e.key === "Escape") setNameDialog(null);
                  }}
                />
              </label>
              <div className="hint" style={{ padding: "0 14px" }}>
                位置：{nameDialog.dir || "/"}
              </div>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setNameDialog(null)}>
                取消
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={fsBusy}
                onClick={() => void confirmNameDialog()}
              >
                确定
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmDialog && (
        <div className="modal-backdrop" onClick={() => setConfirmDialog(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">{confirmDialog.title}</div>
            <div className="modal-body">
              <div className="hint" style={{ padding: "0 14px" }}>
                {confirmDialog.message}
              </div>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setConfirmDialog(null)}>
                取消
              </button>
              <button
                type="button"
                className="btn primary"
                onClick={() => {
                  const fn = confirmDialog.onOk;
                  setConfirmDialog(null);
                  fn();
                }}
              >
                {confirmDialog.okLabel ?? "确定"}
              </button>
            </div>
          </div>
        </div>
      )}

      {ctxMenu && (
        <div
          className="ctx-backdrop"
          onClick={() => setCtxMenu(null)}
          onContextMenu={(e) => {
            e.preventDefault();
            setCtxMenu(null);
          }}
        >
          <div
            className="ctx-menu"
            style={{
              left: Math.min(ctxMenu.x, Math.max(0, window.innerWidth - 230)),
              top: Math.min(ctxMenu.y, Math.max(0, window.innerHeight - 220)),
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                const p = ctxMenu.profile;
                setCtxMenu(null);
                openNewSessionDialog(p);
              }}
            >
              新建会话
            </button>
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                const p = ctxMenu.profile;
                setCtxMenu(null);
                openEditDialog(p);
              }}
            >
              编辑服务器…
            </button>
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                const p = ctxMenu.profile;
                setCtxMenu(null);
                void duplicateProfile(p);
              }}
            >
              复制服务器
            </button>
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                const p = ctxMenu.profile;
                setCtxMenu(null);
                setTmuxTarget(p);
                void refreshTmux(p);
              }}
            >
              管理 tmux 会话
            </button>
            <div className="menu-sep" />
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                const p = ctxMenu.profile;
                setCtxMenu(null);
                void removeProfile(p);
              }}
            >
              删除服务器
            </button>
          </div>
        </div>
      )}

      {showServers && (
        <div className="modal-backdrop" onClick={() => setShowServers(false)}>
          <div className="modal wide" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">服务器管理</div>
            <div className="modal-body">
              <div className="srv-toolbar">
                <button type="button" className="btn primary" onClick={() => openEditDialog()}>
                  ＋ 新建服务器
                </button>
                <span className="hint">共 {sshProfiles.length} 台</span>
              </div>
              {sshProfiles.length === 0 && (
                <div className="hint" style={{ padding: "0 14px" }}>
                  还没有服务器，点「＋ 新建服务器」添加第一台。
                </div>
              )}
              {sshProfiles.map((p) => (
                <div className="srv-row" key={p.id}>
                  <span
                    className="color-dot"
                    style={{ background: p.color ?? "#4f8cff" }}
                  />
                  <div className="srv-main">
                    <div className="srv-name">
                      <span className="ellipsis">{p.name}</span>
                      {p.ssh?.tmuxEnabled && <span className="tag">tmux</span>}
                    </div>
                    <div className="srv-meta">
                      {p.ssh
                        ? `${p.ssh.user}@${p.ssh.host}:${p.ssh.port}`
                        : p.type.toUpperCase()}
                      {p.group ? ` · ${p.group}` : ""}
                      {p.ssh
                        ? p.ssh.allowPassword
                          ? " · 允许输入密码"
                          : " · 只用密钥/agent"
                        : ""}
                    </div>
                  </div>
                  <div className="srv-actions">
                    <button
                      type="button"
                      className="mini-btn"
                      title="用这台服务器开一个新会话"
                      onClick={() => {
                        setShowServers(false);
                        openNewSessionDialog(p);
                      }}
                    >
                      新建会话
                    </button>
                    <button
                      type="button"
                      className="mini-btn"
                      title="编辑名称 / 主机 / 用户 / 密钥 / tmux"
                      onClick={() => openEditDialog(p)}
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      className="mini-btn"
                      onClick={() => void duplicateProfile(p)}
                    >
                      复制
                    </button>
                    {confirmDel === p.id ? (
                      <>
                        <button
                          type="button"
                          className="mini-btn danger"
                          onClick={() => {
                            setConfirmDel(null);
                            void removeProfile(p);
                          }}
                        >
                          确认删除
                        </button>
                        <button
                          type="button"
                          className="mini-btn"
                          onClick={() => setConfirmDel(null)}
                        >
                          取消
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="mini-btn"
                        onClick={() => setConfirmDel(p.id)}
                      >
                        删除
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setShowServers(false)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {editDialog && (
        <div className="modal-backdrop" onClick={() => setEditDialog(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              {editDialog.isNew ? "新建服务器" : "编辑服务器"}
            </div>
            <div className="modal-body">
              <label className="modal-field">
                名称
                <input
                  value={editDialog.draft.name}
                  placeholder="显示名，如 生产 Web"
                  onChange={(e) => patchDraft({ name: e.target.value })}
                />
              </label>
              <label className="modal-field">
                分组（可留空；留空就归到「未分组」）
                <input
                  value={editDialog.draft.group}
                  placeholder="例如：生产环境 / 测试机"
                  onChange={(e) => patchDraft({ group: e.target.value })}
                />
              </label>
              <label className="modal-field">
                主机
                <input
                  value={editDialog.draft.ssh?.host ?? ""}
                  placeholder="IP 或域名"
                  onChange={(e) => patchDraft({}, { host: e.target.value })}
                />
              </label>
              <div className="modal-row">
                <label className="modal-field">
                  端口
                  <input
                    value={editDialog.draft.ssh?.port ?? 22}
                    onChange={(e) =>
                      patchDraft({}, { port: Number(e.target.value) || 22 })
                    }
                  />
                </label>
                <label className="modal-field">
                  用户名
                  <input
                    value={editDialog.draft.ssh?.user ?? ""}
                    onChange={(e) => patchDraft({}, { user: e.target.value })}
                  />
                </label>
              </div>
              <label className="modal-field">
                私钥路径（可选，留空则用 ~/.ssh 默认密钥）
                <input
                  value={editDialog.draft.ssh?.keyPath ?? ""}
                  placeholder="C:\Users\me\.ssh\id_ed25519"
                  onChange={(e) => patchDraft({}, { keyPath: e.target.value })}
                />
              </label>
              <label className="modal-field">
                跳板机（可选，写法同 ssh -J：user@jump-host 或 user@jump-host:22）
                <input
                  value={editDialog.draft.ssh?.jump ?? ""}
                  placeholder="root@10.0.0.1 —— 留空就是直连"
                  onChange={(e) => patchDraft({}, { jump: e.target.value })}
                />
              </label>
              <label className="modal-field">
                tmux 会话名模板
                <input
                  value={editDialog.draft.ssh?.tmuxTemplate ?? "{host}-{user}"}
                  onChange={(e) => patchDraft({}, { tmuxTemplate: e.target.value })}
                />
              </label>
              <label className="form-check">
                <input
                  type="checkbox"
                  checked={editDialog.draft.ssh?.tmuxEnabled ?? true}
                  onChange={(e) => patchDraft({}, { tmuxEnabled: e.target.checked })}
                />
                <span>默认使用 tmux（新建会话时仍可临时改）</span>
              </label>
              <label className="form-check">
                <input
                  type="checkbox"
                  checked={editDialog.draft.ssh?.allowPassword ?? false}
                  onChange={(e) => patchDraft({}, { allowPassword: e.target.checked })}
                />
                <span>
                  允许在终端里输入密码（默认关闭：只用密钥/agent，连不上直接报错而不是卡住）
                </span>
              </label>
              {/* 密码存 Windows 凭据管理器：这样「只能用密码」的服务器也能读远程文件 / 列 tmux */}
              <label className="modal-field">
                密码（存在 Windows 凭据管理器，不会写进配置文件）
                <input
                  type="password"
                  value={editPassword}
                  placeholder={
                    editHasPassword
                      ? "已保存密码 · 输入新密码可覆盖"
                      : "留空则不用密码登录"
                  }
                  onChange={(e) => setEditPassword(e.target.value)}
                />
              </label>
              <div className="modal-inline-action" style={{ paddingBottom: 10 }}>
                <button
                  type="button"
                  className="mini-btn"
                  disabled={!editPassword || !editDialog.draft.id}
                  title={
                    editDialog.draft.id
                      ? "存进 Windows 凭据管理器（控制面板 → 凭据管理器里可以看到并删除）"
                      : "先保存这台服务器，再设置密码"
                  }
                  onClick={() => {
                    const id = editDialog.draft.id;
                    if (!id) {
                      notify("先保存这台服务器，再来设置密码");
                      return;
                    }
                    void (async () => {
                      try {
                        await secretSet(id, editPassword);
                        setEditHasPassword(true);
                        setEditPassword("");
                        notify("密码已存进 Windows 凭据管理器");
                      } catch (e) {
                        notify("保存密码失败：" + String(e));
                      }
                    })();
                  }}
                >
                  保存密码
                </button>
                <button
                  type="button"
                  className="mini-btn"
                  style={{ marginLeft: 6 }}
                  disabled={!editHasPassword || !editDialog.draft.id}
                  onClick={() => {
                    const id = editDialog.draft.id;
                    void (async () => {
                      try {
                        await secretDelete(id);
                        setEditHasPassword(false);
                        notify("已删除保存的密码");
                      } catch (e) {
                        notify("删除密码失败：" + String(e));
                      }
                    })();
                  }}
                >
                  清除密码
                </button>
                <span className="hint" style={{ marginLeft: 8 }}>
                  {editHasPassword ? "✓ 已保存密码" : "未保存密码"}
                </span>
              </div>
              <label className="modal-field">
                标签颜色（可选，显示在服务器名前）
                <input
                  type="color"
                  className="color-input"
                  value={editDialog.draft.color ?? "#4f8cff"}
                  onChange={(e) => patchDraft({ color: e.target.value })}
                />
              </label>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setEditDialog(null)}>
                取消
              </button>
              <button type="button" className="btn primary" onClick={() => void saveEditDialog()}>
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {showSettings && (
        <div className="modal-backdrop" onClick={() => setShowSettings(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">设置</div>
            <div className="modal-body">
              <label className="modal-field">
                终端字体大小：{settings.fontSize}px（也可直接 Ctrl + 滚轮 或 Ctrl + ＋ / －）
                <input
                  type="range"
                  min={8}
                  max={26}
                  value={settings.fontSize}
                  onChange={(e) => applyFontSize(Number(e.target.value))}
                />
              </label>

              <label className="modal-field">
                终端回滚行数：{settings.scrollback.toLocaleString()} 行
                <input
                  type="range"
                  min={1000}
                  max={200000}
                  step={1000}
                  value={settings.scrollback}
                  onChange={(e) => void updateSettings({ scrollback: Number(e.target.value) })}
                />
              </label>
              <div className="modal-inline-action" style={{ paddingBottom: 10 }}>
                {[2000, 10000, 50000, 200000].map((n) => (
                  <button
                    key={n}
                    type="button"
                    className="mini-btn"
                    style={{ marginRight: 6 }}
                    onClick={() => void updateSettings({ scrollback: n })}
                  >
                    {n >= 1000 ? `${n / 1000}k` : n}
                  </button>
                ))}
                <span className="hint">
                  往上能翻多少行历史。超出后最老的行会被丢掉（不会崩，只是看不到更早的）；
                  要长期留存就开终端日志。
                </span>
              </div>

              <label className="form-check">
                <input
                  type="checkbox"
                  checked={settings.autoLog}
                  onChange={(e) => void updateSettings({ autoLog: e.target.checked })}
                />
                <span>
                  新建会话时自动记录终端日志（标签上会出现红点，右键标签可以停止或打开日志）
                </span>
              </label>

              <label className="modal-field">
                会话日志目录（留空 = 默认 %APPDATA%\ZeeAI-Terminal\logs\sessions）
                <input
                  value={settings.logDir}
                  placeholder="例如 D:\zeeai-logs"
                  onChange={(e) => void updateSettings({ logDir: e.target.value })}
                />
              </label>
              <div className="modal-inline-action">
                <button type="button" className="mini-btn" onClick={() => void pickLogDir()}>
                  选择目录…
                </button>
                <button type="button" className="mini-btn" onClick={() => void openLogDir()}>
                  打开目录
                </button>
                {settings.logDir.trim() !== "" && (
                  <button
                    type="button"
                    className="mini-btn"
                    onClick={() => {
                      void updateSettings({ logDir: "" });
                      notify("日志目录已恢复为默认位置");
                    }}
                  >
                    恢复默认
                  </button>
                )}
              </div>

              <label className="modal-field">
                默认终端
                <select
                  value={settings.defaultShell}
                  onChange={(e) =>
                    void updateSettings({
                      defaultShell: e.target.value as AppSettings["defaultShell"],
                    })
                  }
                >
                  <option value="powershell">PowerShell</option>
                  <option value="cmd">CMD</option>
                  <option value="wsl">WSL</option>
                </select>
              </label>

              <label className="modal-field">
                主题配色
                <select
                  value={settings.theme}
                  onChange={(e) => void updateSettings({ theme: e.target.value })}
                >
                  {THEMES.map((t) => (
                    <option key={t.key} value={t.key}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </label>

              <div className="modal-inline-action">
                <button type="button" className="mini-btn" onClick={() => setShowTermTheme(true)}>
                  终端配色…
                </button>
                <span className="hint" style={{ padding: "0 0 0 8px" }}>
                  当前：{currentTermSchemeName()}
                </span>
              </div>

              <label className="form-check">
                <input
                  type="checkbox"
                  checked={settings.tmuxDefault}
                  onChange={(e) => void updateSettings({ tmuxDefault: e.target.checked })}
                />
                <span>新建连接时默认启用 tmux</span>
              </label>

              <label className="form-check">
                <input
                  type="checkbox"
                  checked={settings.recordHistory}
                  onChange={(e) => void updateSettings({ recordHistory: e.target.checked })}
                />
                <span>记录会话历史</span>
              </label>

              <label className="form-check">
                <input
                  type="checkbox"
                  checked={settings.autoReconnect}
                  onChange={(e) => void updateSettings({ autoReconnect: e.target.checked })}
                />
                <span>SSH 断开后自动重连（会重新附加 tmux，最多重试 5 次）</span>
              </label>

              <label className="form-check">
                <input
                  type="checkbox"
                  checked={settings.restoreWorkspace}
                  onChange={(e) => void updateSettings({ restoreWorkspace: e.target.checked })}
                />
                <span>
                  退出时保存工作区，下次打开自动恢复上次的会话（SSH / 本地终端 / 串口；
                  只存"怎么开回来"，不存文件内容）
                </span>
              </label>

              <label className="modal-field">
                关闭窗口时
                <select
                  value={settings.closeAction}
                  onChange={(e) =>
                    void updateSettings({
                      closeAction: e.target.value as AppSettings["closeAction"],
                    })
                  }
                >
                  <option value="exit">退出应用</option>
                  <option value="tray">收进系统托盘（后台继续运行）</option>
                </select>
              </label>

              {renderUpdateSection()}

              <div className="hint">
                设置立即生效，保存在 %APPDATA%\ZeeAI-Terminal\settings.json。
              </div>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn primary" onClick={() => setShowSettings(false)}>
                完成
              </button>
            </div>
          </div>
        </div>
      )}

      {paletteOpen && (
        <div className="modal-backdrop palette-backdrop" onClick={() => setPaletteOpen(false)}>
          <div className="palette" onClick={(e) => e.stopPropagation()}>
            <input
              autoFocus
              className="palette-input"
              placeholder="输入命令名，回车执行（Esc 关闭）"
              value={paletteQuery}
              onChange={(e) => setPaletteQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setPaletteOpen(false);
                if (e.key === "Enter") {
                  const first = paletteItems[0];
                  if (first) {
                    setPaletteOpen(false);
                    first.run();
                  }
                }
              }}
            />
            <div className="palette-list">
              {paletteItems.length === 0 && (
                <div className="hint" style={{ padding: "8px 12px" }}>
                  没有匹配的命令。
                </div>
              )}
              {paletteItems.slice(0, 40).map((c, i) => (
                <button
                  key={c.group + c.label}
                  type="button"
                  className={"palette-item" + (i === 0 ? " first" : "")}
                  onClick={() => {
                    setPaletteOpen(false);
                    c.run();
                  }}
                >
                  <span className="grow ellipsis">{c.label}</span>
                  <span className="dim">{c.group}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {showAbout && (
        <div className="modal-backdrop" onClick={() => setShowAbout(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">关于 ZeeAI Terminal</div>
            <div className="modal-body">
              <div className="about-row">
                <IconLogoRadio size={56} />
              </div>
              <div className="hint">
                <b>ZeeAI Terminal</b> 0.1.4
                <br />
                Windows 多协议终端工作台：SSH（tmux 持久化）、远程文件与预览、本地终端。
                <br />
                <br />
                技术栈：Tauri 2 + Rust + React + xterm.js
              </div>
              <div className="about-sep" />
              {renderUpdateSection()}
            </div>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setShowAbout(false)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {showTermTheme && (
        <TermThemeDialog
          palette={termPalette}
          schemeKey={settings.termScheme}
          customJson={settings.termSchemeCustom}
          onPick={(key, custom) =>
            void updateSettings({
              termScheme: key,
              ...(custom !== undefined ? { termSchemeCustom: custom } : {}),
            })
          }
          onClose={() => setShowTermTheme(false)}
          onNotice={notify}
        />
      )}

      {newDialog && (
        <div className="modal-backdrop" onClick={() => setNewDialog(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">新建会话</div>
            <div className="modal-body">
              <label className="modal-field">
                服务器
                <select
                  value={newDialog.profileId}
                  onChange={(e) => {
                    const picked = profiles.find((x) => x.id === e.target.value);
                    setNewDialog({
                      ...newDialog,
                      profileId: e.target.value,
                      tmuxName: picked
                        ? defaultTmuxName(picked, newDialog.user)
                        : newDialog.tmuxName,
                      attachTarget: "",
                    });
                    if (newDialog.useTmux)
                      void loadDialogTmux(e.target.value, newDialog.user);
                  }}
                >
                  {sshProfiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}（{p.ssh?.user}@{p.ssh?.host}）
                    </option>
                  ))}
                </select>
              </label>
              <div className="modal-inline-action">
                <button
                  type="button"
                  className="mini-btn"
                  onClick={() => {
                    setNewDialog(null);
                    setReopenNewAfterSave(true);
                    openEditDialog();
                  }}
                >
                  ＋ 新建服务器
                </button>
                <button
                  type="button"
                  className="mini-btn"
                  style={{ marginLeft: 6 }}
                  onClick={() => {
                    const cur = profiles.find((p) => p.id === newDialog.profileId);
                    setNewDialog(null);
                    openEditDialog(cur);
                  }}
                >
                  编辑当前服务器
                </button>
                <button
                  type="button"
                  className="mini-btn"
                  style={{ marginLeft: 6 }}
                  onClick={() => {
                    setNewDialog(null);
                    setShowServers(true);
                  }}
                >
                  服务器管理
                </button>
              </div>

              <label className="modal-field">
                登录用户
                <input
                  value={newDialog.user}
                  placeholder="例如 root / ubuntu"
                  onChange={(e) => {
                    const nextUser = e.target.value;
                    const picked = profiles.find((x) => x.id === newDialog.profileId);
                    setNewDialog({
                      ...newDialog,
                      user: nextUser,
                      tmuxName: picked
                        ? defaultTmuxName(picked, nextUser)
                        : newDialog.tmuxName,
                    });
                  }}
                />
              </label>
              <label className="form-check">
                <input
                  type="checkbox"
                  checked={newDialog.rememberUser}
                  onChange={(e) =>
                    setNewDialog({ ...newDialog, rememberUser: e.target.checked })
                  }
                />
                <span>把这个用户名保存到该服务器的配置里</span>
              </label>

              <label className="form-check">
                <input
                  type="checkbox"
                  checked={newDialog.useTmux}
                  onChange={(e) => {
                    setNewDialog({ ...newDialog, useTmux: e.target.checked });
                    if (e.target.checked)
                      void loadDialogTmux(newDialog.profileId, newDialog.user);
                  }}
                />
                <span>使用 tmux（断网后可回到同一个会话）</span>
              </label>

              {newDialog.useTmux && (
                <div className="tmux-choice">
                  <label className="form-check">
                    <input
                      type="radio"
                      checked={newDialog.tmuxKind === "new"}
                      onChange={() => setNewDialog({ ...newDialog, tmuxKind: "new" })}
                    />
                    <span>新建 tmux 会话</span>
                  </label>
                  {newDialog.tmuxKind === "new" && (
                    <input
                      className="modal-input"
                      value={newDialog.tmuxName}
                      onChange={(e) =>
                        setNewDialog({ ...newDialog, tmuxName: e.target.value })
                      }
                      placeholder="会话名，例如 {host}-{user}"
                    />
                  )}

                  <label className="form-check">
                    <input
                      type="radio"
                      checked={newDialog.tmuxKind === "attach"}
                      onChange={() => {
                        setNewDialog({ ...newDialog, tmuxKind: "attach" });
                        void loadDialogTmux(newDialog.profileId, newDialog.user);
                      }}
                    />
                    <span>附加到已有 tmux 会话</span>
                  </label>
                  {newDialog.tmuxKind === "attach" && (
                    <div className="attach-list">
                      {dialogBusy && <div className="hint">正在读取…</div>}
                      {!dialogBusy && dialogTmux.length === 0 && (
                        <div className="hint">这台服务器上还没有 tmux 会话。</div>
                      )}
                      {dialogTmux.map((t) => (
                        <label
                          key={t.name}
                          className={
                            "attach-item" + (newDialog.attachTarget === t.name ? " active" : "")
                          }
                        >
                          <input
                            type="radio"
                            checked={newDialog.attachTarget === t.name}
                            onChange={() =>
                              setNewDialog({ ...newDialog, attachTarget: t.name })
                            }
                          />
                          <IconTerminal size={14} />
                          <span className="grow">{t.name}</span>
                          <span className="dim">{t.windows} 窗口</span>
                          {t.attached && <span className="tag">已连接</span>}
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setNewDialog(null)}>
                取消
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={dialogBusy}
                onClick={() => void confirmNewSession()}
              >
                连接
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function stateText(s: SessionState): string {
  switch (s) {
    case "connecting":
      return "连接中";
    case "connected":
      return "已连接";
    case "reconnecting":
      return "重连中";
    case "closed":
      return "已关闭";
    default:
      return "错误";
  }
}

/**
 * 本地终端模块（PowerShell / CMD / WSL）的侧栏。
 * 关键点：这里要**列出这个模块已经打开的会话**，点一下就切过去，
 * 不用去顶部标签栏一个个找。
 */
function LocalModule({
  label,
  sessions,
  activeId,
  onOpen,
  onActivate,
  onClose,
}: {
  label: string;
  sessions: OpenSession[];
  activeId: string | null;
  onOpen: () => void;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
}) {
  return (
    <div className="local-module">
      <div className="side-actions">
        <button type="button" className="btn primary" onClick={onOpen}>
          <IconPlus size={14} /> 新建 {label}
        </button>
      </div>
      <div className="tree-group">已打开的 {label}（{sessions.length}）</div>
      {sessions.length === 0 && (
        <div className="hint">
          还没有打开。点上面「新建 {label}」开一个，开多少个都会列在这里。
        </div>
      )}
      {sessions.map((s) => (
        <div
          key={s.id}
          className={"tree-item" + (s.id === activeId ? " current" : "")}
          onClick={() => onActivate(s.id)}
          title={`${s.title}　点击切换到该会话`}
        >
          <IconTerminal size={14} />
          <span className="grow ellipsis">{s.title}</span>
          <span className={"status-dot " + s.state} />
          <button
            type="button"
            className="mini-x"
            title="关闭这个会话"
            onClick={(e) => {
              e.stopPropagation();
              onClose(s.id);
            }}
          >
            <IconClose size={11} />
          </button>
        </div>
      ))}
      <div className="hint">本地终端可以开多个，各自是独立的工作区。</div>
    </div>
  );
}

const MD_STYLES: { key: MdStyle; label: string }[] = [
  { key: "github", label: "GitHub" },
  { key: "minimal", label: "简洁" },
  { key: "dark", label: "深色" },
  { key: "paper", label: "文档" },
];

function FileView({ file }: { file: OpenFile }) {
  const [preview, setPreview] = useState(true);
  const [mdStyle, setMdStyle] = useState<MdStyle>("github");

  const isMd = file.kind === "md";
  const isHtml = file.kind === "html";
  const isImg = file.kind === "img";
  const text = isImg ? "" : decodeB64Text(file.b64);

  const mdHtml = useMemo(
    () => (isMd ? DOMPurify.sanitize(md.render(text)) : ""),
    [isMd, text],
  );
  const htmlDoc = useMemo(() => {
    if (!isHtml) return "";
    const clean = DOMPurify.sanitize(text, { FORBID_TAGS: ["script"], FORBID_ATTR: ["srcdoc"] });
    return `<!doctype html><html><head><meta charset="utf-8"><style>
      body{margin:16px;font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif;color:#222;background:#fff;}
      pre{background:#f5f5f5;padding:10px;border-radius:6px;overflow:auto;}
      a{color:#0b6cff;} img{max-width:100%;}
    </style></head><body>${clean}</body></html>`;
  }, [isHtml, text]);

  return (
    <div className="file-view">
      <div className="file-toolbar">
        <span className="file-name" title={file.path}>
          {file.name}
        </span>
        <span className="grow" />
        {isMd && preview && (
          <span className="md-styles">
            {MD_STYLES.map((s) => (
              <button
                key={s.key}
                type="button"
                className={"md-style" + (mdStyle === s.key ? " active" : "")}
                onClick={() => setMdStyle(s.key)}
              >
                {s.label}
              </button>
            ))}
          </span>
        )}
        {(isMd || isHtml) && (
          <button
            type="button"
            className={"mini-btn" + (preview ? " active" : "")}
            onClick={() => setPreview((v) => !v)}
          >
            {preview ? "预览" : "源码"}
          </button>
        )}
        <span className="file-kind">{kindLabel(file.kind)}</span>
      </div>

      <div className="file-body">
        {isImg && (
          <div className="img-preview">
            <img src={`data:${imgMime(file.name)};base64,${file.b64}`} alt={file.name} />
          </div>
        )}

        {isMd &&
          (preview ? (
            <div className={"md-preview md-" + mdStyle} dangerouslySetInnerHTML={{ __html: mdHtml }} />
          ) : (
            <pre className="src-view">{text}</pre>
          ))}

        {isHtml &&
          (preview ? (
            <iframe className="html-preview" sandbox="" srcDoc={htmlDoc} title={file.name} />
          ) : (
            <pre className="src-view">{text}</pre>
          ))}

        {(file.kind === "code" || file.kind === "text") && (
          <pre className="src-view">{text}</pre>
        )}
      </div>
    </div>
  );
}

function kindLabel(kind: FileKind): string {
  switch (kind) {
    case "md":
      return "Markdown";
    case "html":
      return "HTML";
    case "img":
      return "图片";
    case "code":
      return "代码";
    default:
      return "文本";
  }
}
