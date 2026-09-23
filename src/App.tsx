import { useEffect, useMemo, useRef, useState } from "react";
import TerminalView from "./features/Terminal";
import { SessionBus } from "./sessionBus";
import {
  deleteProfile,
  listProfiles,
  openLocal,
  openSsh,
  saveProfile,
  sessionClose,
  tmuxKill,
  tmuxList,
} from "./ipc";
import { b64ToBytes, uid } from "./util";
import type {
  ConnectionProfile,
  SessionEvent,
  SessionState,
  TmuxSession,
} from "./types";
import {
  IconActivity,
  IconCable,
  IconClose,
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

interface OpenSession {
  id: string;
  title: string;
  kind: ModuleKey;
  profileId?: string;
  state: SessionState;
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

const EMPTY_PROFILE = {
  name: "",
  host: "",
  port: 22,
  user: "root",
  group: "默认",
};

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

  useEffect(() => {
    void refresh();
  }, []);

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
          prev.map((s) =>
            s.id === sessionId ? { ...s, title: e.title || s.title } : s,
          ),
        );
        break;
      case "error":
        setToast(e.message);
        setSessions((prev) =>
          prev.map((s) =>
            s.id === sessionId ? { ...s, state: "error" } : s,
          ),
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
  ) {
    const id = uid();
    const title =
      shell === "wsl"
        ? "WSL" + (distro ? " · " + distro : "")
        : shell === "cmd"
          ? "命令提示符"
          : "PowerShell";
    addSession({ id, title, kind: shell, state: "connecting" });
    try {
      const info = await openLocal(id, shell, (e) => handleEvent(id, e), distro);
      setSessions((prev) =>
        prev.map((s) =>
          s.id === id ? { ...s, title: info.title || title } : s,
        ),
      );
    } catch (e) {
      setToast("打开本地终端失败：" + String(e));
    }
  }

  async function openSshSession(profile: ConnectionProfile) {
    const id = uid();
    addSession({
      id,
      title: profile.name,
      kind: "remote",
      profileId: profile.id,
      state: "connecting",
    });
    try {
      const info = await openSsh(id, profile.id, (e) => handleEvent(id, e));
      setSessions((prev) =>
        prev.map((s) =>
          s.id === id ? { ...s, title: info.title || profile.name } : s,
        ),
      );
    } catch (e) {
      setToast("SSH 连接失败：" + String(e));
      setSessions((prev) =>
        prev.map((s) => (s.id === id ? { ...s, state: "error" } : s)),
      );
    }
  }

  async function closeSession(id: string) {
    try {
      await sessionClose(id);
    } catch {
      /* 已经断开则忽略 */
    }
    bus.drop(id);
    setSessions((prev) => prev.filter((s) => s.id !== id));
    setActiveId((cur) => (cur === id ? null : cur));
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
        tmuxEnabled: true,
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

  async function attachTmux(profile: ConnectionProfile, name: string) {
    const id = uid();
    addSession({
      id,
      title: `${profile.name} · ${name}`,
      kind: "remote",
      profileId: profile.id,
      state: "connecting",
    });
    try {
      await openSsh(id, profile.id, (e) => handleEvent(id, e), name);
    } catch (e) {
      setToast("附加 tmux 会话失败：" + String(e));
      setSessions((prev) =>
        prev.map((s) => (s.id === id ? { ...s, state: "error" } : s)),
      );
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

  const grouped = useMemo(() => {
    const map = new Map<string, ConnectionProfile[]>();
    for (const p of profiles) {
      const g = p.group || "默认";
      map.set(g, [...(map.get(g) ?? []), p]);
    }
    return Array.from(map.entries());
  }, [profiles]);

  const activeSession = sessions.find((s) => s.id === activeId) ?? null;

  return (
    <div className="app">
      <div className="titlebar">
        <div className="menus">
          <span>文件</span>
          <span>编辑</span>
          <span>视图</span>
          <span>连接</span>
          <span>终端</span>
          <span>帮助</span>
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
            <button type="button" className="act" title="设置">
              <IconGear size={22} />
            </button>
          </div>
        </nav>

        <aside className="sidebar">
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
                    className="btn"
                    onClick={() => setShowForm((v) => !v)}
                  >
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
                        onChange={(e) =>
                          setForm({ ...form, name: e.target.value })
                        }
                      />
                    </label>
                    <label>
                      主机
                      <input
                        value={form.host}
                        placeholder="例如 203.0.113.10"
                        onChange={(e) =>
                          setForm({ ...form, host: e.target.value })
                        }
                      />
                    </label>
                    <div className="row">
                      <label className="grow">
                        端口
                        <input
                          value={form.port}
                          onChange={(e) =>
                            setForm({ ...form, port: Number(e.target.value) })
                          }
                        />
                      </label>
                      <label className="grow">
                        用户
                        <input
                          value={form.user}
                          onChange={(e) =>
                            setForm({ ...form, user: e.target.value })
                          }
                        />
                      </label>
                    </div>
                    <label>
                      分组
                      <input
                        value={form.group}
                        onChange={(e) =>
                          setForm({ ...form, group: e.target.value })
                        }
                      />
                    </label>
                    <button
                      type="button"
                      className="btn primary"
                      onClick={() => void submitProfile()}
                    >
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
                      <span>tmux 会话 · {tmuxTarget.name}</span>
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
                      <div className="hint">
                        没有 tmux 会话（或服务器未安装 tmux）。
                      </div>
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
                          onClick={() => void attachTmux(tmuxTarget, s.name)}
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
                {grouped.map(([group, list]) => (
                  <div key={group}>
                    <div className="tree-group">{group}</div>
                    {list.map((p) => (
                      <div
                        key={p.id}
                        className="tree-item"
                        onClick={() => void openSshSession(p)}
                        title={`${p.ssh?.user}@${p.ssh?.host}:${p.ssh?.port}`}
                      >
                        <IconServer size={15} />
                        <span className="grow">{p.name}</span>
                        {p.ssh?.tmuxEnabled && <span className="tag">tmux</span>}
                        <button
                          type="button"
                          className="mini-x"
                          title="tmux 会话"
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
                          title="删除"
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
              </>
            )}

            {module === "remote" && sideTab === "files" && (
              <div className="hint">
                远程文件窗格（M3）。
                <br />
                打开一个 SSH 会话后，这里会显示该会话工作目录的文件。
              </div>
            )}

            {module === "powershell" && (
              <LocalModule
                label="PowerShell"
                onOpen={() => void openLocalSession("powershell")}
              />
            )}
            {module === "cmd" && (
              <LocalModule
                label="命令提示符"
                onOpen={() => void openLocalSession("cmd")}
              />
            )}
            {module === "wsl" && (
              <LocalModule
                label="WSL"
                onOpen={() => void openLocalSession("wsl")}
              />
            )}
            {module === "git" && (
              <div className="hint">Git 面板（M5）。</div>
            )}
            {module === "serial" && (
              <div className="hint">串口（M4）。</div>
            )}
            {module === "adb" && <div className="hint">ADB（M4）。</div>}
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
                  style={{ display: s.id === activeId ? "block" : "none" }}
                >
                  <TerminalView
                    sessionId={s.id}
                    bus={bus}
                    active={s.id === activeId}
                  />
                </div>
              ))
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
        <span className="stat">UTF-8</span>
        <span className="stat">xterm-256color</span>
      </div>

      {toast && (
        <div className="toast" onClick={() => setToast(null)}>
          {toast}
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

function LocalModule({
  label,
  onOpen,
}: {
  label: string;
  onOpen: () => void;
}) {
  return (
    <div className="local-module">
      <button type="button" className="btn primary" onClick={onOpen}>
        <IconPlus size={14} /> 新建 {label} 会话
      </button>
      <div className="hint">本地终端也可以开多个，各自是独立的工作区。</div>
    </div>
  );
}
