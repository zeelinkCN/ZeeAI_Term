// 会话标签栏：一个会话一个标签（承载徽标 T/H/S + 日志红点 + 状态点 + 关闭/重连）。
//
// 拖动排序用的是鼠标事件（HTML5 的 draggable 在 WebView2 里对 <button> 不生效），
// 所以这里有 setDragTabId / setDragPos —— 状态还在 App（全局 mousemove 的 effect 在那儿）。

import { IconClose } from "../components/Icons";
import { moduleIcon } from "../lib/modules";
import type { OpenSession, TabMenuState } from "../lib/ui-model";

export interface SessionTabsProps {
  sessions: OpenSession[];
  activeId: string | null;
  setActiveId: (v: string | null) => void;
  dragTabId: string | null;
  setDragTabId: (v: string | null) => void;
  setDragPos: (v: { x: number; y: number } | null) => void;
  setTabMenu: (v: TabMenuState | null) => void;
  carrierBadge: (s: OpenSession) => JSX.Element | null;
  closeSession: (id: string) => Promise<unknown>;
  reconnectSession: (s: OpenSession) => Promise<unknown>;
}

export function SessionTabs(props: SessionTabsProps) {
  const {
  sessions, activeId, setActiveId, dragTabId, setDragTabId, setDragPos,
  setTabMenu, carrierBadge, closeSession, reconnectSession,
  } = props;
  return (
    <div className="session-tabs">
      {sessions.map((s) => (
        <button
          key={s.id}
          type="button"
          className={
            "session-tab" +
            (s.id === activeId ? " active" : "") +
            (s.id === dragTabId ? " dragging" : "")
          }
          // 左右拖动排序：把一个标签拖到另一个上面，就插到它前面/后面
          data-tab-id={s.id}
          // 注意：HTML5 的 draggable 在 WebView2 里对 <button> 不生效，
          // 所以这里自己用鼠标事件做拖动（见下面那个全局 mousemove 的 effect）
          onMouseDown={(e) => {
            if (e.button === 0) {
              setDragTabId(s.id);
              setDragPos({ x: e.clientX, y: e.clientY });
            }
          }}
          onClick={() => setActiveId(s.id)}
          onContextMenu={(e) => {
            e.preventDefault();
            setActiveId(s.id);
            setTabMenu({ id: s.id, x: e.clientX, y: e.clientY });
          }}
          title={`${s.title}（右键可以重命名）`}
        >
          {moduleIcon(s.kind)}
          {carrierBadge(s)}
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

  );
}

