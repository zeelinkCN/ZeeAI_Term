// 「关于」对话框：版本号 + 更新那一整段（更新段由 App 渲染后当节点传进来）。

import { IconLogoRadio } from "../components/Icons";
import { APP_VERSION } from "../lib/app-consts";

export interface AboutDialogProps {
  setShowAbout: (v: boolean) => void;
  /** 更新检查/一键升级那一段（版本状态的 state 都在 App 里） */
  renderUpdateSection: () => JSX.Element;
}

export function AboutDialog(props: AboutDialogProps) {
  const {
  setShowAbout, renderUpdateSection,
  } = props;
  return (
    <div className="modal-backdrop" onClick={() => setShowAbout(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">关于 ZeeAI Term</div>
        <div className="modal-body">
          <div className="about-row">
            <IconLogoRadio size={56} />
          </div>
          <div className="hint">
            <b>ZeeAI Term</b> {APP_VERSION}
            <br />
            Windows 多协议终端工作台：SSH（tmux 持久化）、远程文件与预览、本地终端。
            <br />
            <br />
            技术栈：Tauri 2 + Rust + React + xterm.js
          </div>
          <div className="about-sep" />
          {renderUpdateSection()}
        </div>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={() => setShowAbout(false)}>
            关闭
          </button>
        </div>
      </div>
    </div>

  );
}

