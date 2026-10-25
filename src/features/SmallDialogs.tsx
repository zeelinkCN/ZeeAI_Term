// 两个到处都用的小弹窗：输入名字（新建目录 / 重命名）和通用确认。
//
// 为什么合在一个文件：它们都只有"一句话 + 一两个按钮"，
// 分别建文件反而让 import 列表变长。

import type { ConfirmDialogState, NameDialogState } from "../lib/ui-model";

export interface NameDialogProps {
  nameDialog: NameDialogState;
  setNameDialog: (v: NameDialogState | null) => void;
  /** 上传/删除进行中时不让确认，避免同一目录并发改 */
  fsBusy: boolean;
  confirmNameDialog: () => Promise<void>;
}

export function NameDialog(props: NameDialogProps) {
  const {
  nameDialog, setNameDialog, fsBusy, confirmNameDialog,
  } = props;
  return (
    <div className="modal-backdrop" onClick={() => setNameDialog(null)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          {nameDialog.mode === "mkdir" ? "新建文件夹" : "重命名"}
        </div>
        <div className="modal-body">
          <label className="modal-field">
            {nameDialog.mode === "mkdir" ? "文件夹名" : "新名字"}
            <input
              autoFocus
              value={nameDialog.value}
              onChange={(e) => setNameDialog({ ...nameDialog, value: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") void confirmNameDialog();
                if (e.key === "Escape") setNameDialog(null);
              }}
            />
          </label>
          <div className="hint" style={{ padding: "0 14px" }}>
            位置：{nameDialog.dir || "/"}
          </div>
        </div>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={() => setNameDialog(null)}>
            取消
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={fsBusy}
            onClick={() => void confirmNameDialog()}
          >
            确定
          </button>
        </div>
      </div>
    </div>

  );
}

export interface ConfirmDialogProps {
  confirmDialog: ConfirmDialogState;
  setConfirmDialog: (v: ConfirmDialogState | null) => void;
}

export function ConfirmDialog(props: ConfirmDialogProps) {
  const {
  confirmDialog, setConfirmDialog,
  } = props;
  return (
    <div className="modal-backdrop" onClick={() => setConfirmDialog(null)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">{confirmDialog.title}</div>
        <div className="modal-body">
          <div className="hint" style={{ padding: "0 14px" }}>
            {confirmDialog.message}
          </div>
        </div>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={() => setConfirmDialog(null)}>
            取消
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={() => {
              const fn = confirmDialog.onOk;
              setConfirmDialog(null);
              fn();
            }}
          >
            {confirmDialog.okLabel ?? "确定"}
          </button>
        </div>
      </div>
    </div>

  );
}

