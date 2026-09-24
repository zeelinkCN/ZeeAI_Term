import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";
import TerminalView from "./features/Terminal";
import { SessionBus } from "./sessionBus";
import {
  adbDevices,
  adbVersion,
  deleteProfile,
  fsList,
  fsRead,
  historyList,
  historyRemove,
  historySave,
  listProfiles,
  openLocal,
  openAdbShell,
  openSsh,
  saveProfile,
  sessionClose,
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
  HistoryEntry,
  RemoteEntry,
  SessionEvent,
  SessionState,
  TmuxSession,
} from "./types";
import {
  IconActivity,
  IconCable,
  IconClose,
  IconFile,
  IconFolder,
  IconGear,
  IconGit,
  IconLinux,
  IconPhone,
  IconPlus,
  IconServer,
  IconTerminal,
  IconWindow,
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
  { key: "powershell", label: "PowerShell", node: <IconTerminal size={22} /> },
  { key: "cmd", label: "CMD", node: <IconWindow size={22} /> },
  { key: "wsl", label: "WSL", node: <IconLinux size={22} /> },
  { key: "git", label: "Git", node: <IconGit size={22} /> },
  { key: "serial", label: "串口", node: <IconCable size={22} /> },
  { key: "adb", label: "ADB", node: <IconPhone size={22} /> },
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
};

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
      return <IconWindow size={size} />;
    case "wsl":
      return <IconLinux size={size} />;
    case "git":
      return <IconGit size={size} />;
    case "serial":
      return <IconCable size={size} />;
    case "adb":
      return <IconPhone size={size} />;
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
  } | null>(null);
  const [dialogTmux, setDialogTmux] = useState<TmuxSession[]>([]);
  const [dialogBusy, setDialogBusy] = useState(false);

  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [showSettings, setShowSettings] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [showSidebar, setShowSidebar] = useState(true);

  const [adbList, setAdbList] = useState<AdbDevice[]>([]);
  const [adbVer, setAdbVer] = useState("");
  const [adbLoading, setAdbLoading] = useState(false);

  const [fsPath, setFsPath] = useState("");
  const [fsInput, setFsInput] = useState("");
  const [fsEntries, setFsEntries] = useState<RemoteEntry[]>([]);
  const [fsLoading, setFsLoading] = useState(false);
  // 供异步流程（如自动演示）读取最新路径，避免闭包拿到旧值
  const fsPathRef = useRef(fsPath);
  fsPathRef.current = fsPath;

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
        await new Promise((r) => setTimeout(r, 13000));
        setSideTab("files");
        await loadDir(profile.id, "/tmp/zeeai-demo");
        await new Promise((r) => setTimeout(r, 5000));
        await openRemoteFile(profile.id, "README-demo.md", id);
        await new Promise((r) => setTimeout(r, 7000));
        await openRemoteFile(profile.id, "demo.html", id);
        await new Promise((r) => setTimeout(r, 6000));
        // 顺便把 ADB 面板、菜单、设置界面都展示一遍，便于无人值守截图验证
        setModule("adb");
        await new Promise((r) => setTimeout(r, 9000));
        setOpenMenu("conn");
        await new Promise((r) => setTimeout(r, 6000));
        setOpenMenu(null);
        setShowSettings(true);
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

  useEffect(() => {
    if (!fileProfileId) {
      setFsPath("");
      setFsEntries([]);
      return;
    }
    void loadDir(fileProfileId, undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileProfileId]);

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

  async function openLocalSession(shell: "powershell" | "cmd" | "wsl", distro?: string) {
    const id = uid();
    const title =
      shell === "wsl" ? "WSL" + (distro ? " · " + distro : "") : shell === "cmd" ? "命令提示符" : "PowerShell";
    addSession({ id, title, kind: shell, state: "connecting", openFiles: [], activeTab: "terminal" });
    try {
      const info = await openLocal(id, shell, (e) => handleEvent(id, e), distro);
      setSessions((prev) =>
        prev.map((s) => (s.id === id ? { ...s, title: info.title || title } : s)),
      );
    } catch (e) {
      setToast("打开本地终端失败：" + String(e));
    }
  }

  async function openSshSession(
    profile: ConnectionProfile,
    tmuxMode: "default" | "none" | "name" = "default",
    tmuxName?: string | null,
  ): Promise<string> {
    const id = uid();
    const explicitName = tmuxMode === "name" && tmuxName ? tmuxName : null;
    const title = explicitName ? `${profile.name} · ${explicitName}` : profile.name;
    addSession({
      id,
      title,
      kind: "remote",
      profileId: profile.id,
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
      );
      setSessions((prev) =>
        prev.map((s) =>
          s.id === id
            ? {
                ...s,
                title: explicitName ? title : info.title || title,
                tmuxName: info.tmuxSession ?? undefined,
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

  async function refreshTmux(profile: ConnectionProfile) {
    setTmuxLoading(true);
    try {
      setTmuxSessions(await tmuxList(profile.id));
    } catch (e) {
      setToast("读取 tmux 会话失败：" + String(e));
      setTmuxSessions([]);
    } finally {
      setTmuxLoading(false);
    }
  }

  async function killTmux(profile: ConnectionProfile, name: string) {
    try {
      await tmuxKill(profile.id, name);
      await refreshTmux(profile);
    } catch (e) {
      setToast("结束 tmux 会话失败：" + String(e));
    }
  }

  function defaultTmuxName(profile: ConnectionProfile): string {
    const host = profile.ssh?.host ?? "";
    const user = profile.ssh?.user ?? "";
    const tpl = profile.ssh?.tmuxTemplate || "{host}-{user}";
    return tpl
      .replace("{host}", host)
      .replace("{user}", user)
      .replace(/[.:/\\ ]/g, "-");
  }

  async function loadDialogTmux(profileId: string) {
    setDialogBusy(true);
    try {
      setDialogTmux(await tmuxList(profileId));
    } catch (e) {
      setToast("读取 tmux 会话失败：" + String(e));
      setDialogTmux([]);
    } finally {
      setDialogBusy(false);
    }
  }

  function openNewSessionDialog(profile?: ConnectionProfile) {
    const target = profile ?? profiles[0];
    if (!target) {
      setToast("请先新建一个连接配置");
      return;
    }
    const useTmux = target.ssh?.tmuxEnabled ?? settings.tmuxDefault;
    setNewDialog({
      profileId: target.id,
      useTmux,
      tmuxKind: "new",
      tmuxName: defaultTmuxName(target),
      attachTarget: "",
    });
    if (useTmux) void loadDialogTmux(target.id);
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
      if (!newDialog.useTmux) {
        await openSshSession(profile, "none");
      } else if (newDialog.tmuxKind === "new") {
        const name = newDialog.tmuxName.trim() || defaultTmuxName(profile);
        await openSshSession(profile, "name", name);
      } else {
        await openSshSession(profile, "name", newDialog.attachTarget);
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
    if (h.tmuxSession) {
      await openSshSession(profile, "name", h.tmuxSession);
    } else {
      await openSshSession(profile, "none");
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
    } catch (e) {
      setToast("ADB 不可用：" + String(e));
      setAdbVer("");
      setAdbList([]);
    } finally {
      setAdbLoading(false);
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

  function buildMenus(): { key: string; label: string; items: MenuItem[] }[] {
    const openConnectionForm = () => {
      setModule("remote");
      setSideTab("sessions");
      setShowForm(true);
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
          { sep: false, label: "新建连接", action: openConnectionForm },
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

  async function loadDir(profileId: string, path?: string) {
    setFsLoading(true);
    try {
      const listing = await fsList(profileId, path);
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
      const b64 = await fsRead(profileId, path, 1024 * 1024);
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

  const grouped = useMemo(() => {
    const map = new Map<string, ConnectionProfile[]>();
    for (const p of profiles) {
      const g = p.group || "默认";
      map.set(g, [...(map.get(g) ?? []), p]);
    }
    return Array.from(map.entries());
  }, [profiles]);

  return (
    <div className={"app" + (settings.theme === "light" ? " light" : "")}>
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
                  <button type="button" className="btn" onClick={() => setShowForm((v) => !v)}>
                    <IconPlus size={14} /> 新建连接
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

                <div className="tree-group">已保存的服务器</div>
                {grouped.length === 0 && (
                  <div className="hint">还没有服务器。点上面的「新建连接」添加一台。</div>
                )}
                {grouped.map(([group, list]) => (
                  <div key={group}>
                    <div className="tree-subgroup">{group}</div>
                    {list.map((p) => (
                      <div
                        key={p.id}
                        className="tree-item"
                        onClick={() => openNewSessionDialog(p)}
                        title={`${p.ssh?.user}@${p.ssh?.host}:${p.ssh?.port} — 点击新建会话`}
                      >
                        <IconServer size={15} />
                        <span className="grow">{p.name}</span>
                        {p.ssh?.tmuxEnabled && <span className="tag">tmux</span>}
                        <button
                          type="button"
                          className="mini-x"
                          title="管理服务器上的 tmux 会话"
                          onClick={(e) => {
                            e.stopPropagation();
                            setTmuxTarget(p);
                            void refreshTmux(p);
                          }}
                        >
                          ≡
                        </button>
                        <button
                          type="button"
                          className="mini-x"
                          title="删除连接"
                          onClick={(e) => {
                            e.stopPropagation();
                            void removeProfile(p);
                          }}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                ))}

                <div className="tree-group">会话历史</div>
                {history.length === 0 && (
                  <div className="hint">还没有会话历史。连接过之后会出现在这里。</div>
                )}
                {history.map((h) => (
                  <div
                    key={h.id}
                    className="tree-item"
                    onClick={() => void connectFromHistory(h)}
                    title={h.host}
                  >
                    <IconTerminal size={15} />
                    <span className="grow">
                      {h.profileName}
                      {h.tmuxSession ? ` · ${h.tmuxSession}` : ""}
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
                        onClick={() => void loadDir(fileProfile.id, fsPath)}
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
                          title={en.isDir ? "进入目录" : "预览文件"}
                        >
                          {en.isDir ? <IconFolder size={15} /> : <IconFile size={15} />}
                          <span className="grow">{en.name}</span>
                          <span className="dim">{en.isDir ? "" : humanSize(en.size)}</span>
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
            {module === "git" && <div className="hint">Git 面板（M5，尚未实现）。</div>}
            {module === "serial" && <div className="hint">串口（M4，尚未实现）。</div>}
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
                    <IconPhone size={15} />
                    <span className="grow">{d.model || d.serial}</span>
                    <span className={d.state === "device" ? "dot ok" : "dot off"} />
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
                    light={settings.theme === "light"}
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
                主题
                <select
                  value={settings.theme}
                  onChange={(e) =>
                    void updateSettings({ theme: e.target.value as AppSettings["theme"] })
                  }
                >
                  <option value="dark">深色</option>
                  <option value="light">浅色</option>
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

              <div className="hint">设置立即生效，保存在 %APPDATA%\ZeeAI-Terminal\settings.json。</div>
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
                      tmuxName: picked ? defaultTmuxName(picked) : newDialog.tmuxName,
                      attachTarget: "",
                    });
                    if (newDialog.useTmux) void loadDialogTmux(e.target.value);
                  }}
                >
                  {profiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}（{p.ssh?.user}@{p.ssh?.host}）
                    </option>
                  ))}
                </select>
              </label>

              <label className="form-check">
                <input
                  type="checkbox"
                  checked={newDialog.useTmux}
                  onChange={(e) => {
                    setNewDialog({ ...newDialog, useTmux: e.target.checked });
                    if (e.target.checked) void loadDialogTmux(newDialog.profileId);
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
                        void loadDialogTmux(newDialog.profileId);
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
