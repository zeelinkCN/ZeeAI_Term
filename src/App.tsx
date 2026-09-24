import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openLocalDialog } from "@tauri-apps/plugin-dialog";
import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";
import TerminalView from "./features/Terminal";
import { SessionBus } from "./sessionBus";
import {
  adbDevices,
  adbVersion,
  fastbootDevices,
  fastbootVersion,
  gitStatus,
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
  saveProfile,
  sessionClose,
  serialList,
  sessionWrite,
  settingsGet,
  settingsSet,
  tmuxKill,
  tmuxList,
} from "./ipc";
import { b64ToBytes, bytesToB64, uid } from "./util";
import type {
  AdbDevice,
  AppSettings,
  ConnectionProfile,
  GitStatus,
  HistoryEntry,
  RemoteEntry,
  SerialConfig,
  SerialPortInfo,
  SessionEvent,
  SessionState,
  TmuxSession,
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
  IconLogoTile,
  IconPlus,
  IconPowerShell,
  IconSerial,
  IconServer,
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
  state: SessionState;
  openFiles: OpenFile[];
  activeTab: string; // "terminal" 或文件名
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

const DEFAULT_SETTINGS: AppSettings = {
  fontSize: 13,
  defaultShell: "powershell",
  recordHistory: true,
  tmuxDefault: true,
  theme: "dark",
  closeAction: "exit",
  updateUrl: "",
  autoReconnect: true,
  fsFollowTerminal: true,
};

const APP_VERSION = "0.1.0";

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
  const [toast, setToast] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ ...EMPTY_PROFILE });

  const [expandedServers, setExpandedServers] = useState<string[]>([]);
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
  const [showSettings, setShowSettings] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [showServers, setShowServers] = useState(false);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  // 在「新建会话」弹窗里点「＋ 新建服务器」时，保存后要回到新建会话弹窗
  const [reopenNewAfterSave, setReopenNewAfterSave] = useState(false);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [showSidebar, setShowSidebar] = useState(true);
  const [updateMsg, setUpdateMsg] = useState("");
  const [updateBusy, setUpdateBusy] = useState(false);

  const [adbList, setAdbList] = useState<AdbDevice[]>([]);
  const [adbVer, setAdbVer] = useState("");
  const [adbLoading, setAdbLoading] = useState(false);
  const [fbVer, setFbVer] = useState("");
  const [fbList, setFbList] = useState<AdbDevice[]>([]);
  const [serialPorts, setSerialPorts] = useState<SerialPortInfo[]>([]);
  const [serialLoading, setSerialLoading] = useState(false);
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
    onOk: () => void;
  } | null>(null);
  const [tabMenu, setTabMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [sessionRename, setSessionRename] = useState<{ id: string; value: string } | null>(null);
  // 供异步流程（如自动演示）读取最新路径，避免闭包拿到旧值
  const fsPathRef = useRef(fsPath);
  fsPathRef.current = fsPath;
  const sessionsRef = useRef<OpenSession[]>(sessions);
  sessionsRef.current = sessions;
  const serialPortsRef = useRef<SerialPortInfo[]>([]);
  // 远程文件浏览器属于「当前会话」，所以读目录/读文件也要用当前会话实际登录的用户
  const activeUserRef = useRef<string | undefined>(undefined);
  const reconnectTimers = useRef<Record<string, number>>({});
  const reconnectTries = useRef<Record<string, number>>({});

  const [gitPath, setGitPath] = useState("");
  const [gitState, setGitState] = useState<GitStatus | null>(null);
  const [gitLoading, setGitLoading] = useState(false);

  useEffect(() => {
    void refresh();
    void (async () => {
      try {
        setSettings({ ...DEFAULT_SETTINGS, ...(await settingsGet()) });
      } catch {
        /* 设置读取失败就用默认值 */
      }
    })();
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
        // 接上一块真实开发板（比如 ESP32）时，把串口日志也开一个终端，
        // 截图里就能看到真实设备输出的启动日志。
        const sp =
          serialPortsRef.current.find((p) => /usb|ch3|cp21|ftdi|silicon/i.test(p.label)) ??
          serialPortsRef.current.find((p) => !/蓝牙|bluetooth/i.test(p.label));
        if (sp) {
          const demoSerial: ConnectionProfile = {
            id: uid(),
            type: "serial",
            name: `${sp.path} · 115200`,
            group: "串口",
            serial: {
              path: sp.path,
              baudRate: 115200,
              dataBits: 8,
              stopBits: 1,
              parity: "none",
              flowControl: "none",
            },
          };
          try {
            await saveProfile(demoSerial);
            await refresh();
          } catch {
            /* 演示用，存不下也继续 */
          }
          await openSerialSession(demoSerial);
          await new Promise((r) => setTimeout(r, 14000));
        }
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
          await saveProfile(demoWs);
          await refresh();
        } catch {
          /* 演示用 */
        }
        await openLocalSession(settings.defaultShell, undefined, repo, "ZeeAI_term · git");
        await new Promise((r) => setTimeout(r, 14000));
        setModule("remote");
        setSideTab("sessions");
        openNewSessionDialog(profile);
        await new Promise((r) => setTimeout(r, 16000));
        setNewDialog(null);
        setShowServers(true);
        await new Promise((r) => setTimeout(r, 16000));
        setShowServers(false);
        setShowSettings(true);
        await new Promise((r) => setTimeout(r, 16000));
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
    void refreshFs(fileProfileId, activeTmuxName, undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileProfileId, activeId, activeTmuxName, settings.fsFollowTerminal]);

  async function refresh() {
    try {
      setProfiles(await listProfiles());
    } catch (e) {
      setToast("读取连接配置失败：" + String(e));
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
        setToast(e.message);
        setSessions((prev) =>
          prev.map((s) => (s.id === sessionId ? { ...s, state: "error" } : s)),
        );
        break;
      case "cwd":
        break;
    }
  }

  function addSession(s: OpenSession) {
    setSessions((prev) => [...prev, s]);
    setActiveId(s.id);
  }

  async function openLocalSession(
    shell: "powershell" | "cmd" | "wsl",
    distro?: string,
    cwd?: string,
    titleOverride?: string,
  ) {
    const id = uid();
    const base =
      shell === "wsl" ? "WSL" + (distro ? " · " + distro : "") : shell === "cmd" ? "命令提示符" : "PowerShell";
    const title = titleOverride?.trim() || base;
    addSession({ id, title, kind: shell, state: "connecting", openFiles: [], activeTab: "terminal" });
    try {
      const info = await openLocal(id, shell, (e) => handleEvent(id, e), distro, undefined, undefined, cwd);
      setSessions((prev) =>
        prev.map((s) => (s.id === id ? { ...s, title: titleOverride?.trim() ? title : info.title || title } : s)),
      );
    } catch (e) {
      setToast("打开本地终端失败：" + String(e));
    }
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
      setToast("SSH 连接失败：" + String(e));
      setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, state: "error" } : s)));
    }
    return id;
  }

  async function closeSession(id: string) {
    try {
      await sessionClose(id);
    } catch {
      /* 已断开则忽略 */
    }
    bus.drop(id);
    setSessions((prev) => prev.filter((s) => s.id !== id));
    setActiveId((cur) => (cur === id ? null : cur));
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
      setToast("重连失败：" + String(e));
      setSessions((prev) => prev.map((x) => (x.id === s.id ? { ...x, state: "error" } : x)));
    }
  }

  async function submitProfile() {
    if (!form.host.trim()) {
      setToast("请填写主机地址");
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
      setToast("保存失败：" + String(e));
    }
  }

  async function removeProfile(p: ConnectionProfile) {
    try {
      await deleteProfile(p.id);
      await refresh();
    } catch (e) {
      setToast("删除失败：" + String(e));
    }
  }

  function toggleServer(id: string) {
    setExpandedServers((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  function openEditDialog(profile?: ConnectionProfile) {
    if (profile) {
      setEditDialog({ draft: JSON.parse(JSON.stringify(profile)), isNew: false });
      return;
    }
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
      setToast("请填写主机地址");
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
      setToast("保存失败：" + String(e));
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
      setToast("复制失败：" + String(e));
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
      setToast("读取 tmux 会话失败：" + String(e));
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
      setToast("结束 tmux 会话失败：" + String(e));
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
      setToast("请选择或填写串口（例如 COM5）");
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
      setToast("保存失败：" + String(e));
    }
  }

  async function removeSerialProfile(p: ConnectionProfile) {
    try {
      await deleteProfile(p.id);
      await refresh();
    } catch (e) {
      setToast("删除失败：" + String(e));
    }
  }

  async function loadDialogTmux(profileId: string, user?: string) {
    setDialogBusy(true);
    try {
      setDialogTmux(await tmuxList(profileId, user ?? null));
    } catch (e) {
      setToast("读取 tmux 会话失败：" + String(e));
      setDialogTmux([]);
    } finally {
      setDialogBusy(false);
    }
  }

  function openNewSessionDialog(profile?: ConnectionProfile) {
    const target = profile ?? sshProfiles[0];
    if (!target) {
      setToast("还没有服务器配置，先去「连接 → 服务器管理」里加一台");
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
      setToast("请选择一个要附加的 tmux 会话");
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
      setToast("这条历史对应的连接配置已被删除");
      return;
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
      setToast("删除历史失败：" + String(e));
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
      setToast("ADB 不可用：" + String(e));
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
      setToast("枚举串口失败：" + String(e));
      setSerialPorts([]);
    } finally {
      setSerialLoading(false);
    }
  }

  async function refreshGit() {
    const path = gitPath.trim();
    if (!path) {
      setToast("请先填写仓库路径");
      return;
    }
    setGitLoading(true);
    try {
      setGitState(await gitStatus(path));
    } catch (e) {
      setToast("读取 Git 状态失败：" + String(e));
      setGitState(null);
    } finally {
      setGitLoading(false);
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
      setToast("读取 Git 状态失败：" + String(e));
      setGitLoading(false);
      return;
    }
    setGitLoading(false);
    if (!status?.ok) {
      setToast(status?.message || "这个目录不是 Git 仓库");
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
        setToast("保存工作空间失败：" + String(e));
      }
    }
    await openLocalSession(shell, undefined, dir, `${name} · git`);
    setToast(`已在 ${dir} 打开 Git 工作空间（终端 + git 命令行）`);
  }

  async function removeGitWorkspace(p: ConnectionProfile) {
    try {
      await deleteProfile(p.id);
      await refresh();
    } catch (e) {
      setToast("删除失败：" + String(e));
    }
  }

  /** 远程会话意外断开时自动重连（会重新附加 tmux），最多 5 次指数退避。 */
  function scheduleReconnect(sessionId: string) {
    const s = sessionsRef.current.find((x) => x.id === sessionId);
    if (!s || !s.profileId) return;
    if (!settings.autoReconnect) return;
    const tries = reconnectTries.current[sessionId] ?? 0;
    if (tries >= 5) {
      setToast("自动重连已尝试 5 次，先停下。点标签上的 ↻ 可以手动重试。");
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
      setToast("这个串口连接没有配置端口");
      return;
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
      setToast("打开串口失败：" + String(e));
      setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, state: "error" } : s)));
    }
  }

  async function openAdbSession(serial: string) {
    const id = uid();
    addSession({
      id,
      title: `ADB · ${serial}`,
      kind: "adb",
      state: "connecting",
      openFiles: [],
      activeTab: "terminal",
    });
    try {
      await openAdbShell(id, serial, (e) => handleEvent(id, e));
    } catch (e) {
      setToast("打开 ADB shell 失败：" + String(e));
      setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, state: "error" } : s)));
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
      setToast("保存设置失败：" + String(e));
    }
  }

  function bumpFont(delta: number) {
    const next = Math.min(26, Math.max(8, settings.fontSize + delta));
    void updateSettings({ fontSize: next });
  }

  function clearActiveTerminal() {
    if (!activeSession) {
      setToast("当前没有会话");
      return;
    }
    void sessionWrite(activeSession.id, bytesToB64(new TextEncoder().encode("\u000c")));
  }

  async function checkForUpdates() {
    const url = settings.updateUrl.trim();
    if (!url) {
      setUpdateMsg("请先填写更新源地址（返回 JSON，含 tag_name 或 version 字段）。");
      return;
    }
    setUpdateBusy(true);
    setUpdateMsg("正在检查…");
    try {
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as Record<string, unknown>;
      const latest = String(data.tag_name ?? data.version ?? data.latest ?? "")
        .replace(/^v/i, "")
        .trim();
      if (!latest) throw new Error("返回内容里没有 tag_name / version 字段");
      setUpdateMsg(
        latest === APP_VERSION
          ? `已是最新版本（${APP_VERSION}）`
          : `发现新版本 ${latest}（当前 ${APP_VERSION}）`,
      );
    } catch (e) {
      setUpdateMsg("检查失败：" + String(e));
    } finally {
      setUpdateBusy(false);
    }
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
          { sep: false, label: "放大字体", action: () => bumpFont(1) },
          { sep: false, label: "缩小字体", action: () => bumpFont(-1) },
          { sep: false, label: "重置字体", action: () => void updateSettings({ fontSize: 13 }) },
          { sep: true },
          {
            sep: false,
            label: showSidebar ? "隐藏侧栏" : "显示侧栏",
            action: () => setShowSidebar((v) => !v),
          },
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
  async function refreshFs(profileId: string, tmuxName?: string, fallback?: string) {
    if (!settings.fsFollowTerminal || !tmuxName) {
      await loadDir(profileId, fallback);
      return;
    }
    try {
      const pwd = await remotePwd(profileId, tmuxName, activeUserRef.current ?? null);
      await loadDir(profileId, pwd);
    } catch {
      // 拿不到就保持原来的位置，别把用户扔到别处
      await loadDir(profileId, fallback);
    }
  }

  async function loadDir(profileId: string, path?: string) {
    setFsLoading(true);
    try {
      const listing = await fsList(profileId, path, activeUserRef.current ?? null);
      setFsPath(listing.path);
      setFsInput(listing.path);
      setFsEntries(listing.entries);
    } catch (e) {
      setToast("读取远端目录失败：" + String(e));
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
      setToast("请先打开一个 SSH 会话");
      return;
    }
    const path = joinPath(fsPathRef.current, name);
    const kind = fileKind(name);
    try {
      const b64 = await fsRead(profileId, path, 1024 * 1024, activeUserRef.current ?? null);
      if (!b64) {
        setToast("文件为空或无法读取（可能是目录或二进制文件）");
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
      setToast("读取文件失败：" + String(e));
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
      );
      setToast(msg);
      await loadDir(profileId, fsPathRef.current);
    } catch (e) {
      setToast("上传失败：" + String(e));
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
      );
      setToast(msg);
    } catch (e) {
      setToast("下载失败：" + String(e));
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
      setToast("会话名不能为空");
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
      setToast(`会话已命名为「${title}」`);
    } catch (e) {
      setToast("改名字失败：" + String(e));
    }
    setSessionRename(null);
  }

  /** 新建远端文件夹 / 重命名，共用一个输入弹窗 */
  async function confirmNameDialog() {
    if (!nameDialog) return;
    const value = nameDialog.value.trim();
    if (!value) {
      setToast("名字不能为空");
      return;
    }
    const dir = nameDialog.dir;
    setFsBusy(true);
    try {
      if (nameDialog.mode === "mkdir") {
        await fsMkdir(nameDialog.profileId, joinPath(dir, value), activeUserRef.current ?? null);
        setToast(`已新建 ${value}`);
      } else {
        await fsRename(
          nameDialog.profileId,
          joinPath(dir, nameDialog.from),
          joinPath(dir, value),
          activeUserRef.current ?? null,
        );
        setToast(`已重命名为 ${value}`);
      }
      setNameDialog(null);
      await loadDir(nameDialog.profileId, dir);
    } catch (e) {
      setToast("操作失败：" + String(e));
    } finally {
      setFsBusy(false);
    }
  }

  async function doRemoveRemote(profileId: string, name: string) {
    setFsBusy(true);
    try {
      await fsRemove(profileId, joinPath(fsPath, name), activeUserRef.current ?? null);
      setToast(`已删除 ${name}`);
      await loadDir(profileId, fsPath);
    } catch (e) {
      setToast("删除失败：" + String(e));
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
              onClick={() => {
                setModule(m.key);
                if (m.key !== "remote") setSideTab("sessions");
              }}
            >
              {m.node}
            </button>
          ))}
          <div className="act-sep" />
          <div className="act-foot">
            <button
              type="button"
              className="act"
              title="设置"
              onClick={() => setShowSettings(true)}
            >
              <IconGear size={22} />
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

                <div className="tree-group">
                  已保存的服务器
                  <button
                    type="button"
                    className="mini-x"
                    style={{ marginLeft: "auto", opacity: 1 }}
                    title="新建服务器"
                    onClick={() => openEditDialog()}
                  >
                    ＋
                  </button>
                  <button
                    type="button"
                    className="mini-x"
                    style={{ opacity: 1 }}
                    title="服务器管理（编辑 / 复制 / 删除）"
                    onClick={() => setShowServers(true)}
                  >
                    ⋯
                  </button>
                </div>
                {grouped.length === 0 && (
                  <div className="hint">还没有服务器。点「新建会话」时可以直接新建一台。</div>
                )}
                {grouped.map(([group, list]) => (
                  <div key={group}>
                    <div className="tree-subgroup">{group}</div>
                    {list.map((p) => {
                      const items = history.filter((h) => h.profileId === p.id);
                      const expanded = expandedServers.includes(p.id);
                      return (
                        <div key={p.id}>
                          <div
                            className="tree-item"
                            onClick={() => openNewSessionDialog(p)}
                            onContextMenu={(e) => {
                              e.preventDefault();
                              setCtxMenu({ profile: p, x: e.clientX, y: e.clientY });
                            }}
                            title={`${p.ssh?.user}@${p.ssh?.host}:${p.ssh?.port}\n左键：新建会话　右键：编辑服务器`}
                          >
                            <span
                              className={"chev" + (items.length ? "" : " empty")}
                              onClick={(e) => {
                                e.stopPropagation();
                                if (items.length) toggleServer(p.id);
                              }}
                            >
                              {items.length > 0 &&
                                (expanded ? (
                                  <IconChevronDown size={12} />
                                ) : (
                                  <IconChevronRight size={12} />
                                ))}
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
                            items.map((h) => (
                              <div
                                key={h.id}
                                className="tree-item child"
                                onClick={() => void connectFromHistory(h)}
                                title={`${h.tmuxSession ?? "普通 shell"}　${relTime(h.lastUsed)}`}
                              >
                                <IconTerminal size={13} />
                                <span className="grow ellipsis">
                                  {h.title?.trim() || h.tmuxSession || "普通 shell"}
                                </span>
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
                            ))}
                        </div>
                      );
                    })}
                  </div>
                ))}
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
                        title="跟随终端目录时，会跳到 tmux 会话当前的目录"
                        onClick={() => void refreshFs(fileProfile.id, activeTmuxName, fsPath)}
                      >
                        刷新
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
              <LocalModule label="PowerShell" onOpen={() => void openLocalSession("powershell")} />
            )}
            {module === "cmd" && (
              <LocalModule label="命令提示符" onOpen={() => void openLocalSession("cmd")} />
            )}
            {module === "wsl" && (
              <LocalModule label="WSL" onOpen={() => void openLocalSession("wsl")} />
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
                </div>
                <div className="tree-group">Git 工作空间</div>
                <div className="hint" style={{ paddingTop: 0 }}>
                  在某个仓库目录下起一个本地终端，可以直接敲 git 命令。
                </div>
                {gitWorkspaces.length === 0 && (
                  <div className="hint">
                    还没有工作空间。点「＋ 打开本地仓库」选一个目录即可。
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
                      void (async () => {
                        setGitLoading(true);
                        try {
                          setGitState(await gitStatus(dir));
                        } catch (e) {
                          setToast("读取 Git 状态失败：" + String(e));
                        } finally {
                          setGitLoading(false);
                        }
                      })();
                    }}
                  >
                    <IconGit size={14} />
                    <span className="grow ellipsis">{p.name}</span>
                    <button
                      type="button"
                      className="mini-btn"
                      title="在这个目录打开本地终端"
                      onClick={(e) => {
                        e.stopPropagation();
                        const dir = p.local?.cwd ?? "";
                        void openLocalSession(
                          p.local?.shell ?? settings.defaultShell,
                          p.local?.distro,
                          dir,
                          p.name,
                        );
                      }}
                    >
                      终端
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
                      if (e.key === "Enter") void refreshGit();
                    }}
                  />
                </label>
                <div className="side-actions">
                  <button type="button" className="btn" onClick={() => void refreshGit()}>
                    <IconPlus size={14} /> 刷新状态
                  </button>
                </div>
                {gitLoading && <div className="hint">正在读取…</div>}
                {!gitLoading && gitState && !gitState.ok && (
                  <div className="hint">{gitState.message}</div>
                )}
                {!gitLoading && gitState?.ok && (
                  <>
                    <div className="hint">
                      分支 {gitState.branch || "(未知)"}
                      {gitState.upstream ? ` → ${gitState.upstream}` : ""}
                      {gitState.ahead > 0 ? ` · 领先 ${gitState.ahead}` : ""}
                      {gitState.behind > 0 ? ` · 落后 ${gitState.behind}` : ""}
                    </div>
                    {gitState.files.length === 0 && (
                      <div className="hint">没有未提交的改动。</div>
                    )}
                    {gitState.files.map((f) => (
                      <div key={f.path} className="tree-item" title={f.path}>
                        <span className="git-st">{f.status}</span>
                        <span className="grow ellipsis">{f.path}</span>
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
            {sessions.length === 0 ? (
              <div className="empty">
                <div className="empty-title">ZeeAI Terminal</div>
                <div className="empty-sub">
                  左侧「远程」里选一台服务器，或用 PowerShell / CMD / WSL 打开本地终端。
                </div>
              </div>
            ) : (
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
                    light={themeKind(settings.theme) === "light"}
                  />
                </div>
              ))
            )}
            {activeFile && (
              <div className="file-wrap">
                <FileView key={activeFile.path} file={activeFile} />
              </div>
            )}
          </div>
        </main>
      </div>

      <div className="statusbar">
        <span className="stat">
          <IconActivity size={14} />
          {activeSession
            ? `${MODULE_LABEL[activeSession.kind]} · ${activeSession.title} · ${stateText(activeSession.state)}`
            : "就绪"}
        </span>
        <span className="spacer" />
        {activeFile && <span className="stat">{activeFile.path}</span>}
        <span className="stat">UTF-8</span>
        <span className="stat">xterm-256color</span>
      </div>

      {toast && (
        <div className="toast" onClick={() => setToast(null)}>
          {toast}
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
                确定删除
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
                分组
                <input
                  value={editDialog.draft.group}
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
                终端字体大小：{settings.fontSize}px
                <input
                  type="range"
                  min={8}
                  max={26}
                  value={settings.fontSize}
                  onChange={(e) => void updateSettings({ fontSize: Number(e.target.value) })}
                />
              </label>

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

      {showAbout && (
        <div className="modal-backdrop" onClick={() => setShowAbout(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">关于 ZeeAI Terminal</div>
            <div className="modal-body">
              <div className="about-row">
                <IconLogoTile size={56} />
              </div>
              <div className="hint">
                <b>ZeeAI Terminal</b> 0.1.0
                <br />
                Windows 多协议终端工作台：SSH（tmux 持久化）、远程文件与预览、本地终端。
                <br />
                <br />
                技术栈：Tauri 2 + Rust + React + xterm.js
              </div>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setShowAbout(false)}>
                关闭
              </button>
            </div>
          </div>
        </div>
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

function LocalModule({ label, onOpen }: { label: string; onOpen: () => void }) {
  return (
    <div className="local-module">
      <button type="button" className="btn primary" onClick={onOpen}>
        <IconPlus size={14} /> 新建 {label} 会话
      </button>
      <div className="hint">本地终端也可以开多个，各自是独立的工作区。</div>
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
