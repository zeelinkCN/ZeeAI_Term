// 标签栏下面那排「打开的文件」小标签（点一下切到该文件预览，✕ 关掉）。

import { IconClose, IconFile, IconTerminal } from "../components/Icons";
import type { OpenSession } from "../lib/ui-model";

export interface FileSubTabsProps {
  activeSession: OpenSession;
  carrierBadge: (s: OpenSession) => JSX.Element | null;
  selectTab: (sessionId: string, tab: string) => void;
  closeFile: (sessionId: string, name: string) => void;
}

export function FileSubTabs(props: FileSubTabsProps) {
  const {
  activeSession, carrierBadge, selectTab, closeFile,
  } = props;
  return (
    <div className="sub-tabs">
      <button
        type="button"
        className={"sub-tab term" + (activeSession.activeTab === "terminal" ? " active" : "")}
        onClick={() => selectTab(activeSession.id, "terminal")}
      >
        {carrierBadge(activeSession)}
        <IconTerminal size={14} /> 终端
      </button>
      {/* 分隔：左边是"终端"，右边是打开的文件 —— 不分开真的分不清哪个是哪个 */}
      <span className="sub-tab-sep" />
      <span className="sub-tabs-label">文件</span>
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

  );
}

