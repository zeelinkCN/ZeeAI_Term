// 侧栏服务器行的右键菜单（管理这台机器的 tmux / herdr / 配置）。
//
// 菜单里两个"会真的关掉服务器上东西"的动作（关 herdr 工作区、在服务器上关窗格）
// 走二段确认，所以它需要 armed 那两个 state —— 状态仍留在 App，这里只读+回调。

import { paneWorkspace } from "../lib/session-labels";
import type { CtxMenuState } from "../lib/ui-model";
import type { ConnectionProfile, HistoryEntry } from "../types";

export interface SessionContextMenuProps {
  ctxMenu: CtxMenuState;
  setCtxMenu: (v: CtxMenuState | null) => void;
  setTmuxTarget: (v: ConnectionProfile | null) => void;
  setHerdrTarget: (v: ConnectionProfile | null) => void;
  setHerdrMgrArmed: (v: string | null) => void;
  /** 已经点过一次「确认关掉」的那个窗格号（二段确认的第二下） */
  herdrRowArmed: string | null;
  setHerdrRowArmed: (v: string | null) => void;
  refreshHerdrMgr: (profile: ConnectionProfile) => Promise<void>;
  closeHerdrWorkspace: (profile: ConnectionProfile, ws: string) => Promise<void>;
  removeProfile: (p: ConnectionProfile) => Promise<void>;
  openEditDialog: (profile?: ConnectionProfile) => void;
  duplicateProfile: (p: ConnectionProfile) => Promise<void>;
  refreshTmux: (profile: ConnectionProfile) => Promise<void>;
  openNewSessionDialog: (profile?: ConnectionProfile) => void;
  connectFromHistory: (h: HistoryEntry) => Promise<void>;
  removeHistoryEntry: (id: string) => Promise<void>;
  /** 「服务器管理」是从这张菜单里点开的 */
}

export function SessionContextMenu(props: SessionContextMenuProps) {
  const {
  ctxMenu, setCtxMenu, setTmuxTarget, setHerdrTarget, setHerdrMgrArmed, herdrRowArmed,
  setHerdrRowArmed, refreshHerdrMgr, closeHerdrWorkspace, removeProfile, openEditDialog, duplicateProfile,
  refreshTmux, openNewSessionDialog, connectFromHistory, removeHistoryEntry,
  } = props;
  return (
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
        {/* 对着**一条 herdr 会话**右键时，菜单是"这一条"的：herdr 的窗格会在服务器上攒着，
            用户需要能就在这一行上决定"留着 / 回收"（菜单里不弹窗，第二次点才是确认）。 */}
        {ctxMenu.herdrRow ? (
          <>
            <div className="menu-title">{ctxMenu.herdrRow.herdrPane}</div>
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                const h = ctxMenu.herdrRow!;
                setCtxMenu(null);
                void connectFromHistory(h);
              }}
            >
              打开这个会话
            </button>
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                const h = ctxMenu.herdrRow!;
                setCtxMenu(null);
                void removeHistoryEntry(h.id);
              }}
            >
              只从列表移除（服务器上留着）
            </button>
            <div className="menu-sep" />
            {herdrRowArmed === ctxMenu.herdrRow.herdrPane ? (
              <>
                <button
                  type="button"
                  className="menu-item danger"
                  onClick={() => {
                    const h = ctxMenu.herdrRow!;
                    setCtxMenu(null);
                    setHerdrRowArmed(null);
                    void closeHerdrWorkspace(
                      ctxMenu.profile,
                      paneWorkspace(h.herdrPane),
                    );
                  }}
                >
                  确认在服务器上关掉 {paneWorkspace(ctxMenu.herdrRow.herdrPane)}
                </button>
                <button
                  type="button"
                  className="menu-item"
                  onClick={() => {
                    setHerdrRowArmed(null);
                    setCtxMenu(null);
                  }}
                >
                  取消
                </button>
              </>
            ) : (
              <button
                type="button"
                className="menu-item"
                onClick={() => setHerdrRowArmed(ctxMenu.herdrRow!.herdrPane ?? null)}
              >
                在服务器上关掉这个工作区…
              </button>
            )}
          </>
        ) : (
          <>
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
        <button
          type="button"
          className="menu-item"
          onClick={() => {
            const p = ctxMenu.profile;
            setCtxMenu(null);
            setHerdrTarget(p);
            setHerdrMgrArmed(null);
            void refreshHerdrMgr(p);
          }}
        >
          管理 herdr 工作区
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
          </>
        )}
      </div>
    </div>

  );
}

