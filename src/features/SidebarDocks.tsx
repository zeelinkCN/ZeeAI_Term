// 侧栏底部的两条快捷操作栏（tmux 与 herdr 同构：一排按钮 + 改名）。
//
// 为什么钉在侧栏底部：它们只对"当前这个会话"有意义，跟着标签走而不是跟着服务器走。

import { IconChevronDown, IconChevronRight } from "../components/Icons";
import type { OpenSession } from "../lib/ui-model";
import { HERDR_ACTIONS, TMUX_ACTIONS } from "../lib/app-consts";
import type { TmuxWindow } from "../types";

export interface TmuxDockProps {
  curTmuxSession: string;
  tmuxDockOpen: boolean;
  setTmuxDockOpen: (v: boolean | ((prev: boolean) => boolean)) => void;
  tmuxBusy: boolean;
  tmuxWinList: TmuxWindow[];
  tmuxRename: string | null;
  setTmuxRename: (v: string | null) => void;
  refreshTmuxWindows: () => Promise<unknown>;
  runTmuxAction: (action: string, arg?: string) => Promise<unknown>;
}

export function TmuxDock(props: TmuxDockProps) {
  const {
  curTmuxSession, tmuxDockOpen, setTmuxDockOpen, tmuxBusy, tmuxWinList, tmuxRename,
  setTmuxRename, refreshTmuxWindows, runTmuxAction,
  } = props;
  return (
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

  );
}

export interface HerdrDockProps {
  /** 当前会话的 herdr 窗格（有值才显示这条栏；调用点上已经判过非空） */
  activeSession: OpenSession;
  herdrDockOpen: boolean;
  setHerdrDockOpen: (v: boolean | ((prev: boolean) => boolean)) => void;
  herdrBusy: boolean;
  herdrRename: string | null;
  setHerdrRename: (v: string | null) => void;
  herdrArmed: string | null;
  setHerdrArmed: (v: string | null) => void;
  runHerdrAction: (action: string, arg?: string) => Promise<unknown>;
}

export function HerdrDock(props: HerdrDockProps) {
  const {
  activeSession, herdrDockOpen, setHerdrDockOpen, herdrBusy, herdrRename, setHerdrRename,
  herdrArmed, setHerdrArmed, runHerdrAction,
  } = props;
  return (
    <div className="tmux-dock herdr-dock">
      <button
        type="button"
        className="tmux-head"
        title="不想记 herdr 的快捷键的话，点这里的按钮就行（herdr 自己的快捷键照旧可用）"
        onClick={() => setHerdrDockOpen((v) => !v)}
      >
        {herdrDockOpen ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}
        <span className="grow">herdr 快捷操作</span>
        <span className="tag herdr">{activeSession.herdrPane}</span>
      </button>

      {herdrDockOpen && (
        <div className="tmux-body">
          <div className="tmux-grid">
            {HERDR_ACTIONS.map((a) => {
              const destructive = a.key === "close-pane" || a.key === "close-workspace";
              const armed = herdrArmed === a.key;
              return (
                <button
                  key={a.key}
                  type="button"
                  className={"mini-btn tmux-btn" + (armed ? " danger" : "")}
                  title={armed ? "再点一次就是真的关掉了" : a.title}
                  disabled={herdrBusy}
                  onClick={() => {
                    if (a.key === "rename-pane") {
                      setHerdrRename(activeSession.herdrPane ?? "");
                      return;
                    }
                    // 会真的关掉东西的两个动作：第一次点只是"上膛"，再点才执行
                    if (destructive && !armed) {
                      setHerdrArmed(a.key);
                      return;
                    }
                    void runHerdrAction(a.key);
                  }}
                >
                  {armed ? "确认？" : a.label}
                </button>
              );
            })}
          </div>

          {herdrRename !== null && (
            <div className="tmux-rename">
              <input
                autoFocus
                value={herdrRename}
                placeholder="窗格名字（留空 = 清掉）"
                onChange={(e) => setHerdrRename(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    void runHerdrAction("rename-pane", herdrRename);
                    setHerdrRename(null);
                  } else if (e.key === "Escape") {
                    setHerdrRename(null);
                  }
                }}
              />
              <button
                type="button"
                className="mini-btn"
                onClick={() => {
                  void runHerdrAction("rename-pane", herdrRename);
                  setHerdrRename(null);
                }}
              >
                确定
              </button>
              <button type="button" className="mini-btn" onClick={() => setHerdrRename(null)}>
                取消
              </button>
            </div>
          )}

          <div className="tmux-sub">
            <span className="grow hint">
              这些按钮是让服务器上的 herdr 去做（另开一条 ssh），不碰你的键盘
            </span>
          </div>
        </div>
      )}
    </div>

  );
}



