// 「服务器管理」列表：改名 / 复制 / 删除 / 打开会话。

import { sshTargetLabel } from "../lib/session-labels";
import type { ConnectionProfile } from "../types";

export interface ServersDialogProps {
  setShowServers: (v: boolean) => void;
  /** 已点过一次「删除」的那台（二段确认，不弹窗） */
  confirmDel: string | null;
  setConfirmDel: (v: string | null) => void;
  removeProfile: (p: ConnectionProfile) => Promise<void>;
  openEditDialog: (profile?: ConnectionProfile) => void;
  duplicateProfile: (p: ConnectionProfile) => Promise<void>;
  openNewSessionDialog: (profile?: ConnectionProfile) => void;
  /** 只列 SSH 服务器（串口/AI 那些不走这里） */
  sshProfiles: ConnectionProfile[];
}

export function ServersDialog(props: ServersDialogProps) {
  const {
  setShowServers, confirmDel, setConfirmDel, removeProfile, openEditDialog,
  duplicateProfile, openNewSessionDialog, sshProfiles,
  } = props;
  return (
    <div className="modal-backdrop" onClick={() => setShowServers(false)}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">服务器管理</div>
        <div className="modal-body">
          <div className="srv-toolbar">
            <button type="button" className="btn primary" onClick={() => openEditDialog()}>
              ＋ 新建服务器
            </button>
            <span className="hint">共 {sshProfiles.length} 台</span>
          </div>
          {sshProfiles.length === 0 && (
            <div className="hint" style={{ padding: "0 14px" }}>
              还没有服务器，点「＋ 新建服务器」添加第一台。
            </div>
          )}
          {sshProfiles.map((p) => (
            <div className="srv-row" key={p.id}>
              <span
                className="color-dot"
                style={{ background: p.color ?? "#4f8cff" }}
              />
              <div className="srv-main">
                <div className="srv-name">
                  <span className="ellipsis">{p.name}</span>
                  {p.ssh?.tmuxEnabled && <span className="tag">tmux</span>}
                </div>
                <div className="srv-meta">
                  {p.ssh
                    ? sshTargetLabel(p.ssh)
                    : p.type.toUpperCase()}
                  {p.group ? ` · ${p.group}` : ""}
                  {p.ssh
                    ? p.ssh.allowPassword
                      ? " · 允许输入密码"
                      : " · 只用密钥/agent"
                    : ""}
                </div>
              </div>
              <div className="srv-actions">
                <button
                  type="button"
                  className="mini-btn"
                  title="用这台服务器开一个新会话"
                  onClick={() => {
                    setShowServers(false);
                    openNewSessionDialog(p);
                  }}
                >
                  新建会话
                </button>
                <button
                  type="button"
                  className="mini-btn"
                  title="编辑名称 / 主机 / 用户 / 密钥 / tmux"
                  onClick={() => openEditDialog(p)}
                >
                  编辑
                </button>
                <button
                  type="button"
                  className="mini-btn"
                  onClick={() => void duplicateProfile(p)}
                >
                  复制
                </button>
                {confirmDel === p.id ? (
                  <>
                    <button
                      type="button"
                      className="mini-btn danger"
                      onClick={() => {
                        setConfirmDel(null);
                        void removeProfile(p);
                      }}
                    >
                      确认删除
                    </button>
                    <button
                      type="button"
                      className="mini-btn"
                      onClick={() => setConfirmDel(null)}
                    >
                      取消
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="mini-btn"
                    onClick={() => setConfirmDel(p.id)}
                  >
                    删除
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={() => setShowServers(false)}>
            关闭
          </button>
        </div>
      </div>
    </div>

  );
}

