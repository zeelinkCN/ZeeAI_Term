// 会话标签的右键菜单 + 标签改名弹窗。
//
// 为什么两个放一起：改名就是从这张菜单里点出来的，它们共用"当前那个标签"
// 这一份数据；拆两个文件反而要各自再找一次会话。

import { openInExplorer, sessionLogDir } from "../ipc";
import type { Notify, OpenSession, SessionRenameState, TabMenuState } from "../lib/ui-model";

export interface TabContextMenuProps {
  tabMenu: TabMenuState;
  setTabMenu: (v: TabMenuState | null) => void;
  setSessionRename: (v: SessionRenameState | null) => void;
  /** 菜单项要按 id 找会话（标题 / 日志状态） */
  sessions: OpenSession[];
  startSessionLog: (s: { id: string; title: string }) => Promise<unknown>;
  stopSessionLog: (s: { id: string }) => Promise<void>;
  openSessionLog: (s: { logPath?: string }) => Promise<void>;
  notify: Notify;
  closeSession: (id: string) => Promise<void>;
  reconnectSession: (s: OpenSession) => Promise<void>;
}

export function TabContextMenu(props: TabContextMenuProps) {
  const {
  tabMenu, setTabMenu, setSessionRename, sessions, startSessionLog, stopSessionLog,
  openSessionLog, notify, closeSession, reconnectSession,
  } = props;
  return (
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

  );
}

export interface SessionRenameDialogProps {
  sessionRename: SessionRenameState;
  setSessionRename: (v: SessionRenameState | null) => void;
  renameSession: (sessionId: string, rawName: string) => Promise<void>;
}

export function SessionRenameDialog(props: SessionRenameDialogProps) {
  const {
  sessionRename, setSessionRename, renameSession,
  } = props;
  return (
    // 点弹窗**外面**：什么都不做 —— 用户明确要求"弹窗不手动叉掉就不要关闭"。
    // 弹窗留着、输入留着（既不保存也不丢弃）；只有三个出口能动它：
    // ✕/「取消」= 关掉不保存、Enter/「保存」= 保存、Esc = 取消。
    <div className="modal-backdrop">
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
                // Esc = 取消（保留原名）：这是"我改主意了"的正规出口
                if (e.key === "Escape") setSessionRename(null);
              }}
            />
          </label>
          <div className="hint" style={{ padding: "0 14px" }}>
            改完会同时记进「会话历史」（「保存」或 Enter 生效；Esc /「取消」放弃）。
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

  );
}


