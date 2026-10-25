// 侧栏「会话」页：服务器分组 + 每台机器下面的会话历史 + tmux/herdr 管理入口。
//
// 为什么它是侧栏里最大的一块：一台机器上"开新会话 / 附加 tmux / 接管 herdr 窗格 /
// 管理已在跑的工作区"都挤在这棵树里。这里只摆界面，所有动作仍是 App 的回调。

import { IconChevronDown, IconChevronRight, IconPlus, IconServer, IconTerminal } from "../components/Icons";
import { DEFAULT_SERVER_GROUP, EMPTY_PROFILE } from "../lib/app-consts";
import { dedupPaneId } from "../lib/session-labels";
import type { CtxMenuState, HerdrMgrRow, HerdrMgrState, OpenSession } from "../lib/ui-model";
import type { ConnectionProfile, HistoryEntry, TmuxSession } from "../types";

export interface SidebarSessionsProps {
  sessions: OpenSession[];
  /** 只 SSH 服务器（串口 / 本地终端各自有自己的面板） */
  sshProfiles: ConnectionProfile[];
  /** 会话历史（按服务器 id 取） */
  history: HistoryEntry[];
  /** 服务器分组：[[组名, 服务器...]]，只有一个组时不显示组标题 */
  grouped: [string, ConnectionProfile[]][];
  showGroupHeaders: boolean;
  collapsedServers: string[];
  toggleServer: (id: string) => void;
  allServersExpanded: boolean;
  toggleAllServers: () => void;
  /** 「新建服务器」那张内联表单的草稿 */
  showForm: boolean;
  form: typeof EMPTY_PROFILE;
  setForm: (v: typeof EMPTY_PROFILE) => void;
  submitProfile: () => Promise<unknown>;
  setShowServers: (v: boolean) => void;
  openEditDialog: (profile?: ConnectionProfile) => void;
  openNewSessionDialog: (profile?: ConnectionProfile) => void;
  openSshSession: (
    profile: ConnectionProfile,
    tmuxMode?: "default" | "none" | "name",
    tmuxName?: string | null,
    userOverride?: string | null,
    titleOverride?: string | null,
    highlightSetId?: string | null,
    backend?: "tmux" | "herdr" | "herdr-pane" | "herdr-control",
    herdrPane?: string,
    herdrMode?: "observe" | "control",
  ) => Promise<unknown>;
  connectFromHistory: (h: HistoryEntry) => Promise<unknown>;
  removeHistoryEntry: (id: string) => Promise<unknown>;
  setCtxMenu: (v: CtxMenuState | null) => void;
  relTime: (secs: number) => string;
  /** tmux / herdr 面板对着哪台机器 */
  tmuxTarget: ConnectionProfile | null;
  setTmuxTarget: (v: ConnectionProfile | null) => void;
  tmuxSessions: TmuxSession[];
  tmuxLoading: boolean;
  refreshTmux: (profile: ConnectionProfile) => Promise<unknown>;
  killTmux: (profile: ConnectionProfile, name: string) => Promise<unknown>;
  herdrTarget: ConnectionProfile | null;
  setHerdrTarget: (v: ConnectionProfile | null) => void;
  herdrMgr: HerdrMgrState | null;
  setHerdrMgr: (v: HerdrMgrState | null) => void;
  herdrMgrLoading: boolean;
  refreshHerdrMgr: (profile: ConnectionProfile) => Promise<unknown>;
  herdrMgrRows: (profile: ConnectionProfile, mgr: HerdrMgrState) => HerdrMgrRow[];
  herdrMgrIdleCount: (profile: ConnectionProfile, mgr: HerdrMgrState) => number;
  herdrMgrArmed: string | null;
  setHerdrMgrArmed: (v: string | null) => void;
  setHerdrRowArmed: (v: string | null) => void;
  closeHerdrWorkspace: (profile: ConnectionProfile, ws: string) => Promise<unknown>;
  herdrStopArmed: boolean;
  setHerdrStopArmed: (v: boolean) => void;
  startHerdrServer: (pidOverride?: string, userOverride?: string | null) => Promise<unknown>;
  stopHerdrServer: (pidOverride?: string, userOverride?: string | null) => Promise<unknown>;
  openHerdrPane: (
    profileId: string,
    paneId: string,
    label?: string,
    userOverride?: string | null,
    mode?: "observe" | "control",
  ) => Promise<unknown>;
}

export function SidebarSessions(props: SidebarSessionsProps) {
  const {
  sessions, sshProfiles, history, grouped, showGroupHeaders, collapsedServers,
  toggleServer, allServersExpanded, toggleAllServers, showForm, form, setForm,
  submitProfile, setShowServers, openEditDialog, openNewSessionDialog, openSshSession, connectFromHistory,
  removeHistoryEntry, setCtxMenu, relTime, tmuxTarget, setTmuxTarget, tmuxSessions,
  tmuxLoading, refreshTmux, killTmux, herdrTarget, setHerdrTarget, herdrMgr,
  setHerdrMgr, herdrMgrLoading, refreshHerdrMgr, herdrMgrRows, herdrMgrIdleCount, herdrMgrArmed,
  setHerdrMgrArmed, setHerdrRowArmed, closeHerdrWorkspace, herdrStopArmed, setHerdrStopArmed,
  startHerdrServer, stopHerdrServer, openHerdrPane,
  } = props;
  return (
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
        <div className="hint">还没有服务器</div>
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
                  className="tree-item srv-node"
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
                    // 已打开的判定：tmux 按 tmux 会话名比；普通 shell 按"这台机器 + 没有 tmux 名"比
                    // 普通 shell 还必须**比名字** —— 否则同一台机器上随便开一个普通 shell，
                    // 它所有普通 shell 的历史行都会显示"已打开"（实测就是这个 bug）
                    // herdr：按**窗格号**比（和上面两个都不是一回事；
                    // 以前漏了这一支，于是 herdr 行会拿标题去比普通 shell，判得一塌糊涂）
                    const opened = sessions.find((s) =>
                      h.herdrPane
                        ? s.profileId === h.profileId && s.herdrPane === h.herdrPane
                        : h.tmuxSession
                        ? s.profileId === h.profileId && s.tmuxName === h.tmuxSession
                        : s.profileId === h.profileId &&
                          !s.tmuxName &&
                          (s.title ?? "").trim() === (h.title ?? "").trim(),
                    );
                    const rawTitle = h.title?.trim() || "";
                    const rowLabel = h.herdrPane
                      ? // herdr 行：去掉"服务器名 · "前缀（服务器就在上一级树里），
                        // 窗格号由左边的 H 标和悬停提示给出，行里不用再挤一遍
                        // 再把老版本拼重复的窗格号收掉（那时候正则漏了带字母的工作区号，
                        // 标题会变成 "… w1P:p1 w1P:p1"）
                        dedupPaneId(rawTitle.replace(/^[^·]*·\s*/, ""), h.herdrPane) ||
                        h.herdrPane
                      : rawTitle ||
                        h.tmuxSession ||
                        `${h.profileName || "服务器"} · 普通 shell`;
                    return (
                      <div
                        key={h.id}
                        className={"tree-item child" + (opened ? " opened" : "")}
                        onClick={() => void connectFromHistory(h)}
                        onContextMenu={(e) => {
                          // herdr 的行才给菜单：它对着的是"服务器上那个工作区"，
                          // 能就地决定留着还是回收（别的行没有服务器侧的东西要管）。
                          if (!h.herdrPane) return;
                          e.preventDefault();
                          setHerdrRowArmed(null);
                          setCtxMenu({ profile: p, x: e.clientX, y: e.clientY, herdrRow: h });
                        }}
                        title={
                          (h.herdrPane
                            ? `herdr 窗格 ${h.herdrPane}`
                            : h.tmuxSession ?? "普通 shell") +
                          `　${relTime(h.lastUsed)}` +
                          (opened ? "\n已经开着了 —— 点一下切到那个标签" : "") +
                          (h.herdrPane
                            ? "\n右键：只移除记录 / 在服务器上关掉这个工作区"
                            : "")
                        }
                      >
                        <span
                          className={"open-dot" + (opened ? " on" : "")}
                          title={opened ? "已打开" : "未打开"}
                        />
                        {/* 最前面标一下是不是 tmux 会话（用户要的"小 T 字图标"） */}
                        {h.tmuxSession && (
                          <span className="tmux-mark" title="tmux 会话（服务器上会一直活着）">
                            T
                          </span>
                        )}
                        {/* herdr 会话用一个小 H 标出来 —— 和上面那个 T 一个道理，
                            侧栏一眼就能看出这条是 herdr 管的窗格 */}
                        {h.herdrPane && (
                          <span
                            className="herdr-mark"
                            title={`herdr 窗格（服务器上的工作区/窗格：${h.herdrPane}）`}
                          >
                            H
                          </span>
                        )}
                        <IconTerminal size={13} />
                        <span className="grow ellipsis" title={rowLabel}>
                          {rowLabel}
                        </span>
                        {opened && <span className="tag">已打开</span>}
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
              placeholder="只是标签，不参与连接"
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </label>
          <label>
            主机
            <input
              value={form.host}
              placeholder="IP 或 ~/.ssh/config 里的别名（填别名才能带上 config 里的密钥/端口/用户）"
              onChange={(e) => setForm({ ...form, host: e.target.value })}
            />
          </label>
          <div className="row">
            <label className="grow">
              端口
              <input
                type="number"
                min={0}
                value={form.port}
                // 留空送 0（= "没说"）：后端不传 -p，交给 config。
                // 这里存字符串就是为了"能空着"；`Number("")` 是 0，不会变成 NaN。
                placeholder="留空则用 ~/.ssh/config 里的值（默认 22）"
                onChange={(e) => setForm({ ...form, port: e.target.value })}
              />
            </label>
            <label className="grow">
              用户
              <input
                value={form.user}
                placeholder="留空则用 ~/.ssh/config 里的值（默认当前用户名）"
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
        <div className="hint">还没有连接</div>
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
            <div className="hint">没有 tmux 会话</div>
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

      {/* ---------- 管理 herdr 工作区（服务器右键打开） ----------
          herdr 的工作区天生持久，关标签页不会回收 —— 所以必须有一个"就在服务器上
          看一遍、决定留哪个"的地方。 */}
      {herdrTarget && (
        <div className="tmux-panel herdr-panel">
          <div className="tmux-head">
            <span>herdr · {herdrTarget.name}</span>
            <span className="tmux-actions">
              <button
                type="button"
                className="mini-btn"
                onClick={() => void refreshHerdrMgr(herdrTarget)}
              >
                刷新
              </button>
              <button
                type="button"
                className="mini-btn"
                onClick={() => {
                  setHerdrTarget(null);
                  setHerdrMgr(null);
                  setHerdrMgrArmed(null);
                }}
              >
                关闭
              </button>
            </span>
          </div>
          {herdrMgrLoading && <div className="hint">正在读取…</div>}
          {!herdrMgrLoading && !herdrMgr && (
            <div className="hint">读不到 herdr 状态（这台机器可能没装，或没连上）</div>
          )}
          {!herdrMgrLoading && herdrMgr && (
            <>
              <div className="herdr-svc-row">
                <span className="grow">
                  {herdrMgr.server.running
                    ? `服务运行中 · ${herdrMgr.scan.panes.length} 个窗格`
                    : "服务没在跑"}
                </span>
                {herdrMgr.server.running ? (
                  herdrStopArmed ? (
                    <>
                      <button
                        type="button"
                        className="mini-btn danger"
                        title="停止 herdr 服务 —— 它管着的所有窗格都会关掉"
                        onClick={() =>
                          void stopHerdrServer(
                            herdrTarget.id,
                            herdrTarget.ssh?.user ?? null,
                          )
                        }
                      >
                        确认停止
                      </button>
                      <button
                        type="button"
                        className="mini-btn"
                        onClick={() => setHerdrStopArmed(false)}
                      >
                        取消
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="mini-btn"
                      onClick={() => setHerdrStopArmed(true)}
                    >
                      停止服务…
                    </button>
                  )
                ) : (
                  <button
                    type="button"
                    className="mini-btn"
                    onClick={() =>
                      void startHerdrServer(
                        herdrTarget.id,
                        herdrTarget.ssh?.user ?? null,
                      )
                    }
                  >
                    启动服务
                  </button>
                )}
              </div>
              {herdrMgr.scan.workspaces.length === 0 && (
                <div className="hint">服务器上没有 herdr 工作区</div>
              )}
              {herdrTarget &&
                herdrMgrRows(herdrTarget, herdrMgr).map((w) => (
                  <div key={w.ws} className="tmux-row herdr-ws-row">
                    <span className="herdr-mark">H</span>
                    <span className="grow ellipsis" title={w.detail}>
                      {w.ws}
                      <span className="dim"> · {w.summary}</span>
                    </span>
                    {w.inUse && <span className="tag">在用</span>}
                    {w.idle && <span className="tag">空壳</span>}
                    <button
                      type="button"
                      className="mini-btn"
                      title={`以可写方式接管 ${w.pane}`}
                      onClick={() =>
                        void openHerdrPane(
                          herdrTarget.id,
                          w.pane,
                          w.label,
                          herdrTarget.ssh?.user ?? null,
                          "control",
                        )
                      }
                    >
                      接管
                    </button>
                    <button
                      type="button"
                      className="mini-btn"
                      title={`只读观察 ${w.pane}`}
                      onClick={() =>
                        void openHerdrPane(
                          herdrTarget.id,
                          w.pane,
                          w.label,
                          herdrTarget.ssh?.user ?? null,
                          "observe",
                        )
                      }
                    >
                      观察
                    </button>
                    {herdrMgrArmed === w.ws ? (
                      <>
                        <button
                          type="button"
                          className="mini-btn danger"
                          title={`真的关掉 ${w.ws}（含里面的窗格）`}
                          onClick={() => void closeHerdrWorkspace(herdrTarget, w.ws)}
                        >
                          确认关掉 {w.ws}
                        </button>
                        <button
                          type="button"
                          className="mini-btn"
                          onClick={() => setHerdrMgrArmed(null)}
                        >
                          取消
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="mini-btn"
                        title={`关掉工作区 ${w.ws}（里面的窗格也会一起没）`}
                        onClick={() => setHerdrMgrArmed(w.ws)}
                      >
                        关掉
                      </button>
                    )}
                  </div>
                ))}
              {herdrTarget && herdrMgrIdleCount(herdrTarget, herdrMgr) > 0 && (
                <div className="herdr-svc-row">
                  <span className="grow hint">
                    其中 {herdrMgrIdleCount(herdrTarget, herdrMgr)} 个是空壳（只停着
                    shell，且不在任何已打开/历史会话里）
                  </span>
                </div>
              )}
            </>
          )}
        </div>
      )}

    </>

  );
}

