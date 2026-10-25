// 「编辑服务器」对话框（新建走同一块：editDialog.isNew 区分）。
//
// 为什么它是这次拆分里最该搬的一块：连接参数 + 外观 + 诊断入口 + 密码凭据，
// 两百多行全在改"一份草稿"，而草稿本身还在 App（保存时才落盘）。

import { secretDelete, secretSet } from "../ipc";
import { TERM_SCHEMES } from "../termThemes";
import { termSchemeFor } from "../lib/session-labels";
import { portOrZero } from "../lib/ssh-text";
import type { EditDialogState, Notify } from "../lib/ui-model";
import type { AppSettings, ConnectionProfile } from "../types";

export interface ServerEditDialogProps {
  /** 草稿 + 是不是新建（新建时保存语义不同） */
  editDialog: EditDialogState;
  setEditDialog: (v: EditDialogState | null) => void;
  /** 密码不回显：只记"这次新填的"和"服务器上有没有存过" */
  editPassword: string;
  setEditPassword: (v: string) => void;
  editHasPassword: boolean;
  setEditHasPassword: (v: boolean) => void;
  /** 引用全局默认（外观是否跟随全局 / 默认 tmux 模板） */
  settings: AppSettings;
  notify: Notify;
  openSshDiagnosis: (profileId: string, failure?: string) => Promise<void>;
  saveEditDialog: () => Promise<void>;
  patchDraft: (
    patch: Partial<ConnectionProfile>,
    sshPatch?: Partial<NonNullable<ConnectionProfile["ssh"]>>,
  ) => void;
}

export function ServerEditDialog(props: ServerEditDialogProps) {
  const {
  editDialog, setEditDialog, editPassword, setEditPassword, editHasPassword, setEditHasPassword,
  settings, notify, openSshDiagnosis, saveEditDialog, patchDraft,
  } = props;
  return (
    <div className="modal-backdrop">
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          {editDialog.isNew ? "新建服务器" : "编辑服务器"}
          <button
            type="button"
            className="mini-x"
            style={{ float: "right", opacity: 1 }}
            title="关闭"
            onClick={() => setEditDialog(null)}
          >
            ✕
          </button>
        </div>
        <div className="modal-body">
          <label className="modal-field">
            名称
            <input
              value={editDialog.draft.name}
              placeholder="只是标签，不参与连接"
              onChange={(e) => patchDraft({ name: e.target.value })}
            />
          </label>
          <label className="modal-field">
            分组（可留空；留空就归到「未分组」）
            <input
              value={editDialog.draft.group}
              placeholder="例如：生产环境 / 测试机"
              onChange={(e) => patchDraft({ group: e.target.value })}
            />
          </label>
          {/* 外观：勾上=跟着"整体设置里那一类终端"走（全局一改它就跟着变）；
              取消勾选=这台机器独立一套，以后全局怎么改都不动它 */}
          <label className="form-check">
            <input
              type="checkbox"
              checked={!editDialog.draft.termScheme && !editDialog.draft.highlightSetId}
              onChange={(e) => {
                if (e.target.checked) {
                  patchDraft({ termScheme: null, termSchemeCustom: null, highlightSetId: null });
                } else {
                  // 独立：从"当前生效的那套"起步，方便微调
                  const kind = editDialog.draft.type === "serial" ? "serial" : "ssh";
                  const cur = termSchemeFor(settings, undefined, kind);
                  const curSet = settings.highlightSetByKind?.[kind] ?? "";
                  patchDraft({ termScheme: cur.key, highlightSetId: curSet || null });
                }
              }}
            />
            <span>
              外观跟随全局设置（{editDialog.draft.type === "serial" ? "串口设备" : "远程 SSH"}那一档）；
              取消勾选就是独立一套，以后改全局不会动它
            </span>
          </label>
          {(!editDialog.draft.termScheme && !editDialog.draft.highlightSetId) === false && (
            <div className="modal-inline-action" style={{ paddingBottom: 8 }}>
              <select
                value={editDialog.draft.termScheme ?? ""}
                onChange={(e) => patchDraft({ termScheme: e.target.value || null })}
                title="这台机器独立的配色方案"
              >
                <option value="">（跟随全局那档）</option>
                {TERM_SCHEMES.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.name}
                  </option>
                ))}
              </select>
              <select
                style={{ marginLeft: 6 }}
                value={editDialog.draft.highlightSetId ?? ""}
                onChange={(e) => patchDraft({ highlightSetId: e.target.value || null })}
                title="这台机器独立的高亮规则集"
              >
                <option value="">（跟随全局那档）</option>
                {settings.highlightRuleSets.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name || "(未命名)"}
                  </option>
                ))}
              </select>
            </div>
          )}
          <label className="modal-field">
            主机
            <input
              value={editDialog.draft.ssh?.host ?? ""}
              placeholder="IP 或 ~/.ssh/config 里的别名（填别名才能带上 config 里的密钥/端口/用户）"
              onChange={(e) => patchDraft({}, { host: e.target.value })}
            />
          </label>
          <div className="modal-row">
            <label className="modal-field">
              端口
              <input
                type="number"
                min={0}
                // 0 显示成空：0 是"没说"（后端不传 -p），不是"端口 0"
                value={editDialog.draft.ssh?.port || ""}
                placeholder="留空则用 ~/.ssh/config 里的值（默认 22）"
                // 以前这里 `Number(...) || 22` 会把清空**打回 22** —— 用户想留空反而被填上，
                // 于是 config 里的 Port 被 22 顶掉（"我明明配了别名"就是这么坏掉的）。
                onChange={(e) => patchDraft({}, { port: portOrZero(e.target.value) })}
              />
            </label>
            <label className="modal-field">
              用户名
              <input
                value={editDialog.draft.ssh?.user ?? ""}
                placeholder="留空则用 ~/.ssh/config 里的值（默认当前用户名）"
                onChange={(e) => patchDraft({}, { user: e.target.value })}
              />
            </label>
          </div>
          <label className="modal-field">
            私钥路径（可选，留空则用默认密钥 / ~/.ssh/config）
            <input
              value={editDialog.draft.ssh?.keyPath ?? ""}
              placeholder="C:\Users\me\.ssh\id_ed25519"
              onChange={(e) => patchDraft({}, { keyPath: e.target.value })}
            />
          </label>
          {/* 连接诊断：只读跑一次本机 ssh -G，看**实际**会用的主机/端口/用户/密钥。
              用户报障时不用再猜"我填的别名到底生效了没有""钥匙到底在哪找"。 */}
          <div className="modal-inline-action" style={{ paddingBottom: 10 }}>
            <button
              type="button"
              className="mini-btn"
              disabled={!editDialog.draft.id}
              title={
                editDialog.draft.id
                  ? "只读：看看本机会用哪个主机 / 端口 / 用户 / 密钥，不会去连服务器"
                  : "先保存这台服务器再诊断（诊断是按已保存的配置跑的）"
              }
              onClick={() => {
                if (editDialog.draft.id) void openSshDiagnosis(editDialog.draft.id);
              }}
            >
              连接诊断（看看本机会用哪把钥匙）
            </button>
            <span className="hint" style={{ marginLeft: 8 }}>
              只读，不会去连服务器（按已保存的配置诊断）
            </span>
          </div>
          <label className="modal-field">
            跳板机（可选，写法同 ssh -J：user@jump-host 或 user@jump-host:22）
            <input
              value={editDialog.draft.ssh?.jump ?? ""}
              placeholder="root@10.0.0.1 —— 留空就是直连"
              onChange={(e) => patchDraft({}, { jump: e.target.value })}
            />
          </label>
          <label className="modal-field">
            tmux 会话名模板
            <input
              value={editDialog.draft.ssh?.tmuxTemplate ?? "{host}-{user}"}
              onChange={(e) => patchDraft({}, { tmuxTemplate: e.target.value })}
            />
          </label>
          <label className="form-check">
            <input
              type="checkbox"
              checked={editDialog.draft.ssh?.tmuxEnabled ?? true}
              onChange={(e) => patchDraft({}, { tmuxEnabled: e.target.checked })}
            />
            <span>默认使用 tmux（新建会话时仍可临时改）</span>
          </label>
          {/* 这台服务器"默认用 herdr 打开"。
              勾上之后新建会话里 herdr 那个勾会默认打上，不再每次问你。
              没装 herdr 的机器上勾了也没关系：真去开会话时探测到没装会明确告诉你。 */}
          <label className="form-check">
            <input
              type="checkbox"
              checked={editDialog.draft.ssh?.herdrEnabled ?? false}
              onChange={(e) => patchDraft({}, { herdrEnabled: e.target.checked })}
            />
            <span>默认用 herdr 打开（新建会话时仍可临时取消）</span>
          </label>
          <label className="form-check">
            <input
              type="checkbox"
              checked={editDialog.draft.ssh?.allowPassword ?? false}
              onChange={(e) => patchDraft({}, { allowPassword: e.target.checked })}
            />
            <span>
              允许在终端里输入密码（默认关闭：只用密钥/agent，连不上直接报错而不是卡住）
            </span>
          </label>
          {/* 密码存 Windows 凭据管理器：这样「只能用密码」的服务器也能读远程文件 / 列 tmux */}
          <label className="modal-field">
            密码（存在 Windows 凭据管理器，不会写进配置文件）
            <input
              type="password"
              value={editPassword}
              placeholder={
                editHasPassword
                  ? "已保存密码 · 输入新密码可覆盖"
                  : "留空则不用密码登录"
              }
              onChange={(e) => setEditPassword(e.target.value)}
            />
          </label>
          <div className="modal-inline-action" style={{ paddingBottom: 10 }}>
            <button
              type="button"
              className="mini-btn"
              disabled={!editPassword || !editDialog.draft.id}
              title={
                editDialog.draft.id
                  ? "存进 Windows 凭据管理器（控制面板 → 凭据管理器里可以看到并删除）"
                  : "先保存这台服务器，再设置密码"
              }
              onClick={() => {
                const id = editDialog.draft.id;
                if (!id) {
                  notify("先保存这台服务器，再来设置密码");
                  return;
                }
                void (async () => {
                  try {
                    await secretSet(id, editPassword);
                    setEditHasPassword(true);
                    setEditPassword("");
                    notify("密码已存进 Windows 凭据管理器");
                  } catch (e) {
                    notify("保存密码失败：" + String(e));
                  }
                })();
              }}
            >
              保存密码
            </button>
            <button
              type="button"
              className="mini-btn"
              style={{ marginLeft: 6 }}
              disabled={!editHasPassword || !editDialog.draft.id}
              onClick={() => {
                const id = editDialog.draft.id;
                void (async () => {
                  try {
                    await secretDelete(id);
                    setEditHasPassword(false);
                    notify("已删除保存的密码");
                  } catch (e) {
                    notify("删除密码失败：" + String(e));
                  }
                })();
              }}
            >
              清除密码
            </button>
            <span className="hint" style={{ marginLeft: 8 }}>
              {editHasPassword ? "✓ 已保存密码" : "未保存密码"}
            </span>
          </div>
          <label className="modal-field">
            标签颜色（可选，显示在服务器名前）
            <input
              type="color"
              className="color-input"
              value={editDialog.draft.color ?? "#4f8cff"}
              onChange={(e) => patchDraft({ color: e.target.value })}
            />
          </label>
        </div>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={() => setEditDialog(null)}>
            取消
          </button>
          <button type="button" className="btn primary" onClick={() => void saveEditDialog()}>
            保存
          </button>
        </div>
      </div>
    </div>

  );
}

