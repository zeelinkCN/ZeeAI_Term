// 终端区：单窗格 / 分屏网格，以及"当前标签是一个打开的文件"时的文件预览。
//
// 这一块是**唯一必须和 Terminal 组件贴在一起**的地方：它负责把每个会话
// 接到自己的 TerminalView 上（bus / 尺寸 / cwd / 命令退出码 / herdr 输入通道）。
// 状态仍在 App（TerminalView 的 key 是会话 id，重挂载会丢终端状态），这里只做接线。

import { SessionBus } from "../sessionBus";
import TerminalView from "./Terminal";
import type { Notify, OpenFile, OpenSession } from "../lib/ui-model";
import { themeKind } from "../lib/app-consts";
import { MODULE_LABEL } from "../lib/modules";
import { highlightRulesFor, kindOfSession, termPaletteFor } from "../lib/session-labels";
import { FileView } from "./FileView";
import type { AppSettings, ConnectionProfile, HerdrServerStatus } from "../types";
import type { CSSProperties } from "react";

export interface TerminalAreaProps {
  activeSession: OpenSession | null;
  activeFile: OpenFile | null;
  sessions: OpenSession[];
  profiles: ConnectionProfile[];
  settings: AppSettings;
  bus: SessionBus;
  activeId: string | null;
  setActiveId: (v: string | null) => void;
  paneLayout: "single" | "v2" | "h2" | "v3" | "grid4";
  paneSlots: (string | null)[];
  focusedPane: number;
  setFocusedPane: (v: number) => void;
  setPanes: (v: (string | null)[] | ((prev: (string | null)[]) => (string | null)[])) => void;
  setCmdExit: (v: Record<string, { exit: number; at: number }> | ((prev: Record<string, { exit: number; at: number }>) => Record<string, { exit: number; at: number }>)) => void;
  herdrServer: HerdrServerStatus | null;
  termBgOf: (s: OpenSession | null | undefined) => string | undefined;
  handleTerminalCwd: (sessionId: string, path: string) => void;
  handleIncomingFiles: (
    session: OpenSession,
    files: { name: string; bytes: Uint8Array }[],
  ) => Promise<unknown>;
  ensureHerdrInput: (
    id: string,
    profileId: string,
    user: string | null,
    paneId: string,
  ) => Promise<unknown>;
  notify: Notify;
  bumpFont: (delta: number) => void;
}

export function TerminalArea(props: TerminalAreaProps) {
  const {
  activeSession, activeFile, sessions, profiles, settings, bus,
  activeId, setActiveId, paneLayout, paneSlots, focusedPane, setFocusedPane,
  setPanes, setCmdExit, herdrServer, termBgOf, handleTerminalCwd, handleIncomingFiles,
  ensureHerdrInput, notify, bumpFont,
  } = props;
  return (
    <div
      className="pane"
      style={{ "--term-bg": termBgOf(activeSession) } as CSSProperties}
    >
      {paneLayout !== "single" && (
        <div className={"pane-grid " + paneLayout}>
          {paneSlots.map((sid, i) => {
            const ps = sid ? sessions.find((s) => s.id === sid) : null;
            return (
              <div
                key={i}
                className={"pane-cell" + (i === focusedPane ? " focused" : "")}
                style={{ "--term-bg": termBgOf(ps) } as CSSProperties}
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
                      onPasteFiles={(files) => void handleIncomingFiles(ps, files)}
                      pasteKey={settings.pasteKey}
                      rightClick={settings.rightClick}
                      copyKey={settings.copyKey}
                      fontSize={settings.fontSize}
                      scrollback={settings.scrollback}
                      light={themeKind(settings.theme) === "light"}
                      palette={termPaletteFor(
                        settings,
                        profiles.find((p) => p.id === ps.profileId),
                        kindOfSession(ps.kind),
                      )}
                      highlightEnabled={settings.highlightEnabled}
                      highlightRules={highlightRulesFor(
                        settings,
                        profiles.find((p) => p.id === ps.profileId),
                        kindOfSession(ps.kind),
                      )}
                      onCwd={(path) => handleTerminalCwd(ps.id, path)}
                      onCommandDone={(code) =>
                        setCmdExit((prev) => ({ ...prev, [ps.id]: { exit: code, at: Date.now() } }))
                      }
                      onNotice={notify}
                      onZoom={bumpFont}
                      herdrPane={
                        ps.herdrPane
                          ? { paneId: ps.herdrPane, mode: ps.herdrMode ?? "observe" }
                          : undefined
                      }
                      onHerdrInputNeeded={() =>
                        void ensureHerdrInput(
                          ps.id,
                          ps.profileId ?? "",
                          ps.user ?? null,
                          ps.herdrPane ?? "",
                        )
                      }
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
          <div className="empty-title">ZeeAI Term</div>
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
              // 用 flex（不是 block）：`.term-wrap` 里除了终端还可能有一条 `.herdr-bar`，
              // 靠 flex 把高度**分**给两者。写成 block 会让 `.terminal-host` 的 flex:1 失效、
              // 终端按自己的内容高度撑开，最后一行就被下面的输入窗盖住了（用户报的 bug）。
              // 这里只管"显不显示"，布局规则在 styles.css 的 .term-wrap 里。
              display:
                s.id === activeId && s.activeTab === "terminal" ? "flex" : "none",
            }}
          >
            {/* herdr 会话：终端上方挂一条**一眼可见**的状态条（像 tmux 的状态栏那样），
                避免"到底进没进 herdr"这种疑惑。 */}
            {s.herdrPane && (
              <div className="herdr-bar" title={`${s.title}\nherdr 工作区/窗格：${s.herdrPane}`}>
                <span className="tag herdr">herdr</span>
                <span>{s.herdrMode === "control" ? "接管中（可写）" : "只读观察"}</span>
                <span className="dim">{s.herdrPane}</span>
                <span className="grow" />
                <span className="dim">
                  {herdrServer
                    ? herdrServer.running
                      ? `服务运行中 · ${herdrServer.panes} 个窗格`
                      : "服务没在跑"
                    : ""}
                </span>
              </div>
            )}
            <TerminalView
              sessionId={s.id}
              bus={bus}
              active={s.id === activeId && s.activeTab === "terminal"}
              onPasteFiles={(files) => void handleIncomingFiles(s, files)}
              pasteKey={settings.pasteKey}
              rightClick={settings.rightClick}
              copyKey={settings.copyKey}
              // 单窗格模式下**所有**会话都挂着（用 display:none 藏着，为了不丢回滚缓冲），
              // 但只有当前这条看得见 —— WebGL 渲染器只给看得见的挂，
              // 否则开 N 个会话就占 N 个 GPU 上下文（见 Terminal.tsx 里那段说明）
              visible={s.id === activeId && s.activeTab === "terminal"}
              fontSize={settings.fontSize}
              scrollback={settings.scrollback}
              light={themeKind(settings.theme) === "light"}
              palette={termPaletteFor(
                settings,
                profiles.find((p) => p.id === s.profileId),
                kindOfSession(s.kind),
              )}
              highlightEnabled={settings.highlightEnabled}
              highlightRules={highlightRulesFor(
                settings,
                profiles.find((p) => p.id === s.profileId),
                kindOfSession(s.kind),
              )}
              onCwd={(path) => handleTerminalCwd(s.id, path)}
              onCommandDone={(code) =>
                setCmdExit((prev) => ({ ...prev, [s.id]: { exit: code, at: Date.now() } }))
              }
              onNotice={notify}
              onZoom={bumpFont}
              herdrPane={
                s.herdrPane
                  ? { paneId: s.herdrPane, mode: s.herdrMode ?? "observe" }
                  : undefined
              }
              onHerdrInputNeeded={() =>
                void ensureHerdrInput(
                  s.id,
                  s.profileId ?? "",
                  s.user ?? null,
                  s.herdrPane ?? "",
                )
              }
            />
          </div>
        ))
      ) : null}
      {paneLayout === "single" && activeFile && (
        <div className="file-wrap">
          <FileView
            key={activeFile.path}
            file={activeFile}
            profileId={activeSession?.profileId}
            userOverride={activeSession?.user ?? null}
            onNotice={notify}
          />
        </div>
      )}
    </div>

  );
}



