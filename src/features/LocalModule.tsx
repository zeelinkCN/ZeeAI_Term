// 本地终端模块（PowerShell / CMD / WSL）的侧栏。
//
// 为什么单独一个文件：三个本地模块共用同一块界面，只是 label / 会话过滤不同；
// 它只认 props，和 App 的其它状态没有来往。
/**
 * 本地终端模块（PowerShell / CMD / WSL）的侧栏。
 * 关键点：这里要**列出这个模块已经打开的会话**，点一下就切过去，
 * 不用去顶部标签栏一个个找。
 */

import { IconClose, IconPlus, IconTerminal } from "../components/Icons";
import type { OpenSession } from "../lib/ui-model";

export function LocalModule({
  label,
  sessions,
  activeId,
  onOpen,
  secondary,
  onActivate,
  onClose,
}: {
  label: string;
  sessions: OpenSession[];
  activeId: string | null;
  onOpen: () => void;
  /** 并排的第二个"新建"按钮（目前只有 PowerShell 7 用得上） */
  secondary?: { label: string; title?: string; onClick: () => void };
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
}) {
  return (
    <div className="local-module">
      {/* 有第二个按钮时改成竖排：两个按钮同宽同高、各占一行（并排会挤到折行，很难看） */}
      <div className={"side-actions" + (secondary ? " stack" : "")}>
        <button type="button" className="btn primary grow" onClick={onOpen}>
          <IconPlus size={14} /> 新建 {label}
        </button>
        {secondary && (
          <button
            type="button"
            className="btn"
            title={secondary.title}
            onClick={secondary.onClick}
          >
            <IconPlus size={14} /> 新建 {secondary.label}
          </button>
        )}
      </div>
      <div className="tree-group">已打开的 {label}（{sessions.length}）</div>
      {sessions.length === 0 && <div className="hint">还没有打开</div>}
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


