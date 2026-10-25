// 「新建会话」对话框：服务器 / 用户名 / tmux / herdr 三选一。
//
// 为什么这块最难搬也最值得搬：它是全应用交互最多的弹窗（勾 tmux → 要拉会话列表，
// 勾 herdr → 要探这台机器装没装、有没有可接管的窗格），
// 但所有这些动作本来就都是 App 的回调 —— 这里只摆界面。

import { IconTerminal } from "../components/Icons";
import { herdrStateLabel } from "../lib/ai-labels";
import type { NewSessionDialogState } from "../lib/ui-model";
import type { AiSourceInfo, ConnectionProfile, HerdrPane, TmuxSession } from "../types";

export interface NewSessionDialogProps {
  newDialog: NewSessionDialogState;
  setNewDialog: (v: NewSessionDialogState | null) => void;
  profiles: ConnectionProfile[];
  /** 当前要接管 shedr 目标那台服务器（从菜单进来时预设） */
  /** 「接管已有 tmux 会话」的列表（按需拉，可能还是空的） */
  dialogTmux: TmuxSession[];
  dialogBusy: boolean;
  dialogHerdr: HerdrPane[];
  setShowServers: (v: boolean) => void;
  setReopenNewAfterSave: (v: boolean) => void;
  /** 正在装 herdr 的服务器 → 进度文案（有值就显示"正在装…"） */
  herdrInstalling: Record<string, string>;
  probingHerdr: Record<string, boolean>;
  /** 这台机器的 herdr 探测结果（null = 还没探过） */
  newDialogHerdr: AiSourceInfo | null | undefined;
  newDialogCanHerdr: boolean;
  probeHerdrFor: (
    profileId: string,
    user?: string | null,
    force?: boolean,
  ) => Promise<AiSourceInfo | null | undefined>;
  installHerdrFor: (profileId: string, user?: string | null) => Promise<void>;
  openEditDialog: (profile?: ConnectionProfile) => void;
  defaultTmuxName: (profile: ConnectionProfile, userOverride?: string) => string;
  loadDialogTmux: (profileId: string, user?: string) => Promise<void>;
  loadDialogHerdr: (profileId: string, user?: string) => Promise<void>;
  confirmNewSession: () => Promise<void>;
  sshProfiles: ConnectionProfile[];
}

export function NewSessionDialog(props: NewSessionDialogProps) {
  const {
  newDialog, setNewDialog, profiles, dialogTmux, dialogBusy,
  dialogHerdr, setShowServers, setReopenNewAfterSave, herdrInstalling, probingHerdr, newDialogHerdr,
  newDialogCanHerdr, probeHerdrFor, installHerdrFor, openEditDialog, defaultTmuxName, loadDialogTmux,
  loadDialogHerdr, confirmNewSession, sshProfiles,
  } = props;
  return (
    <div className="modal-backdrop">
      {/* 输入型对话框：点外面不关（填了一半被手滑点掉很难受），只认右上角 ✕ / 取消 */}
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          新建会话
          <button
            type="button"
            className="mini-x"
            style={{ float: "right", opacity: 1 }}
            title="关闭"
            onClick={() => setNewDialog(null)}
          >
            ✕
          </button>
        </div>
        <div className="modal-body">
          <label className="modal-field">
            服务器
            <select
              value={newDialog.profileId}
              onChange={(e) => {
                const picked = profiles.find((x) => x.id === e.target.value);
                // 换服务器时，登录用户要跟着换成"这台服务器自己的用户"，
                // 不能沿用上一台的值（否则 tmux 名也会拿旧用户去拼 —— 实测就是这样错的）
                const nextUser = picked?.ssh?.user ?? "";
                setNewDialog({
                  ...newDialog,
                  profileId: e.target.value,
                  user: nextUser,
                  tmuxName: picked ? defaultTmuxName(picked, nextUser) : "",
                  attachTarget: "",
                });
                if (newDialog.useTmux)
                  void loadDialogTmux(e.target.value, nextUser);
              }}
            >
              {sshProfiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}（{p.ssh?.user}@{p.ssh?.host}）
                </option>
              ))}
            </select>
          </label>
          <div className="modal-inline-action">
            <button
              type="button"
              className="mini-btn"
              onClick={() => {
                setNewDialog(null);
                setReopenNewAfterSave(true);
                openEditDialog();
              }}
            >
              ＋ 新建服务器
            </button>
            <button
              type="button"
              className="mini-btn"
              style={{ marginLeft: 6 }}
              onClick={() => {
                const cur = profiles.find((p) => p.id === newDialog.profileId);
                setNewDialog(null);
                openEditDialog(cur);
              }}
            >
              编辑当前服务器
            </button>
            <button
              type="button"
              className="mini-btn"
              style={{ marginLeft: 6 }}
              onClick={() => {
                setNewDialog(null);
                setShowServers(true);
              }}
            >
              服务器管理
            </button>
          </div>

          <label className="modal-field">
            登录用户
            <input
              value={newDialog.user}
              placeholder="例如 root / ubuntu"
              onChange={(e) => {
                const nextUser = e.target.value;
                const picked = profiles.find((x) => x.id === newDialog.profileId);
                // tmux 名里带用户名（模板 {host}-{user}），所以改用户时跟着更新；
                // 只有当它还是"自动生成的那个"或为空时才覆盖，尊重手动改过的名字
                const auto = picked ? defaultTmuxName(picked, newDialog.user) : "";
                const keepManual =
                  newDialog.tmuxName.trim() !== "" && newDialog.tmuxName !== auto;
                setNewDialog({
                  ...newDialog,
                  user: nextUser,
                  tmuxName:
                    picked && !keepManual ? defaultTmuxName(picked, nextUser) : newDialog.tmuxName,
                });
              }}
            />
          </label>
          <div className="hint" style={{ padding: "0 0 8px 14px" }}>
            登录用户只对这次会话生效，不会改动服务器配置（要改配置请用「服务器管理」）
          </div>
          {/* 会话名字：留空 = 自动命名（普通 shell 会自动编号 1、2、3…），
              这样同一台机器开多个普通会话，历史列表里也能一一对应、不会互相覆盖 */}
          <label className="modal-field">
            会话名字（可留空）
            <input
              value={newDialog.title ?? ""}
              placeholder="留空 = 自动命名（普通 shell 会自动编号，不会重名）"
              onChange={(e) => setNewDialog({ ...newDialog, title: e.target.value })}
            />
          </label>

          {/* tmux 那条：勾了 herdr 就不再显示（两条是"用哪种方式开"，同时开没有意义） */}
          {!newDialog.useHerdr && (
            <label className="form-check">
              <input
                type="checkbox"
                checked={newDialog.useTmux}
                onChange={(e) => {
                  setNewDialog({ ...newDialog, useTmux: e.target.checked });
                  if (e.target.checked)
                    void loadDialogTmux(newDialog.profileId, newDialog.user);
                }}
              />
              <span>使用 tmux（断网后可回到同一个会话）</span>
            </label>
          )}

          {/* 用 herdr 打开这次会话。
              勾选默认值来自**这台服务器**的配置（「服务器管理」里那个"默认用 herdr 打开"），
              勾过一次就不用每次再点 —— 用户原话："我勾了默认打开就别再让我勾"。
              勾上就直接进她的环境（可读可写那条 control 流），不跑她自己的 TUI（会花屏）。 */}
          <label
            className="form-check"
            title={
              newDialogCanHerdr
                ? `${newDialogHerdr?.herdrPath || ""}\n协议 ${newDialogHerdr?.protocol} · schema v${newDialogHerdr?.schemaVersion}\n当前她在管 ${newDialogHerdr?.agents} 个 agent\n\n勾上 = 直接进她的环境（可读可写）；关掉标签时窗格留在服务器上，随时能回来`
                : newDialogHerdr === undefined
                  ? probingHerdr[newDialog.profileId]
                    ? "正在探测这台机器有没有 herdr…"
                    : "还没探测这台机器。点一下这行即可探测。"
                  : "这台机器上没有 herdr。没有它也能正常用 tmux 或普通 shell，只是看板少一路更准的状态。"
            }
            onClick={() => {
              if (newDialogHerdr === undefined) {
                void probeHerdrFor(newDialog.profileId, newDialog.user);
              }
            }}
          >
            <input
              type="checkbox"
              checked={newDialog.useHerdr}
              // **只有"确实探到没装"才禁**（`!!newDialogHerdr` 就是这道闸）：
              //   - undefined = 还没探 → 允许勾
              //   - null      = 探测失败（可以重试）→ 允许勾
              //   - {} 无版本 = 探到了、这台机器没装 → 才禁用
              // 以前是"探测没返回就禁用"，用户想勾也点不动，点连接就悄悄开了个普通 shell
              //（实测反馈"herdr 一直建不开"）。勾上之后点连接会强制再确认一次。
              disabled={!!newDialogHerdr && !newDialogCanHerdr}
              onChange={(e) => {
                setNewDialog({ ...newDialog, useHerdr: e.target.checked });
                // 只有"接管已有窗格"才需要列表；新建窗格不用拉
                if (e.target.checked && newDialog.herdrKind === "attach") {
                  void loadDialogHerdr(newDialog.profileId, newDialog.user);
                }
              }}
            />
            <span>
              用 herdr 打开
              {newDialogCanHerdr
                ? `（已装 ${newDialogHerdr?.herdrVersion} · 协议 ${newDialogHerdr?.protocol}）`
                : newDialogHerdr === undefined
                  ? probingHerdr[newDialog.profileId]
                    ? "（正在探测…可以先勾上）"
                    : "（未探测 · 点这行探测）"
                  // 探到"没装"和"探测失败"要分开说：前者是结论，后者是可以重试的
                  : newDialogHerdr === null
                    ? "（探测失败，可以先勾上，连接时会重试）"
                  : "（这台机器没装）"}
            </span>
          </label>

          {/* 探测结果是"没有 herdr"时，顺手给一个一键安装入口。
              安装过程由 Windows 侧下载 + 校验 sha256 后 scp 上去，不跑远端脚本、不要 root。 */}
          {/* 安装入口只在"**确认**这台机器没装 herdr"时出现；
              探测失败（null）不给 —— 那多半是网络一时不通，装什么装。 */}
          {!!newDialogHerdr && !newDialogCanHerdr ? (
            <div className="modal-inline-action" style={{ paddingLeft: 14 }}>
              {herdrInstalling[newDialog.profileId] ? (
                <span className="hint">
                  正在装 herdr：{herdrInstalling[newDialog.profileId]}
                </span>
              ) : (
                <button
                  type="button"
                  className="mini-btn"
                  title="从 herdr.dev 拿官方版本号与 sha256，Windows 侧下载并校验后上传到 ~/.local/bin/herdr（不需要 root）"
                  onClick={() => void installHerdrFor(newDialog.profileId, newDialog.user)}
                >
                  一键安装 herdr
                </button>
              )}
            </div>
          ) : null}

          {/* herdr 勾上之后：新开一个窗格，还是接管已有的（和 tmux 的"新建/附加"一个道理） */}
          {newDialog.useHerdr && newDialogCanHerdr && (
            <div className="tmux-choice">
              <label className="form-check">
                <input
                  type="radio"
                  checked={newDialog.herdrKind === "new"}
                  onChange={() => setNewDialog({ ...newDialog, herdrKind: "new" })}
                />
                <span>新建一个 herdr 窗格</span>
              </label>
              <label className="form-check">
                <input
                  type="radio"
                  checked={newDialog.herdrKind === "attach"}
                  onChange={() => {
                    setNewDialog({ ...newDialog, herdrKind: "attach" });
                    void loadDialogHerdr(newDialog.profileId, newDialog.user);
                  }}
                />
                <span>接管已有窗格</span>
              </label>
              {newDialog.herdrKind === "attach" && (
                <div className="attach-list">
                  {dialogBusy && <div className="hint">正在读取…</div>}
                  {!dialogBusy && dialogHerdr.length === 0 && (
                    <div className="hint">这台机器上 herdr 还没认出 agent。</div>
                  )}
                  {dialogHerdr.map((a) => (
                    <label
                      key={a.paneId}
                      className="form-check"
                      title={`${a.paneId}${a.cwd ? `　${a.cwd}` : ""}`}
                    >
                      <input
                        type="radio"
                        checked={newDialog.herdrTarget === a.paneId}
                        onChange={() =>
                          setNewDialog({ ...newDialog, herdrTarget: a.paneId })
                        }
                      />
                      <span>
                        {a.agent || "shell"} · {a.paneId} · {herdrStateLabel(a.status)}
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}

          {!newDialog.useHerdr && newDialog.useTmux && (
            <div className="tmux-choice">
              <label className="form-check">
                <input
                  type="radio"
                  checked={newDialog.tmuxKind === "new"}
                  onChange={() => setNewDialog({ ...newDialog, tmuxKind: "new" })}
                />
                <span>新建 tmux 会话</span>
              </label>
              {newDialog.tmuxKind === "new" && (
                <input
                  className="modal-input"
                  value={newDialog.tmuxName}
                  onChange={(e) =>
                    setNewDialog({ ...newDialog, tmuxName: e.target.value })
                  }
                  placeholder="会话名，例如 {host}-{user}"
                />
              )}

              <label className="form-check">
                <input
                  type="radio"
                  checked={newDialog.tmuxKind === "attach"}
                  onChange={() => {
                    setNewDialog({ ...newDialog, tmuxKind: "attach" });
                    void loadDialogTmux(newDialog.profileId, newDialog.user);
                  }}
                />
                <span>附加到已有 tmux 会话</span>
              </label>
              {newDialog.tmuxKind === "attach" && (
                <div className="attach-list">
                  {dialogBusy && <div className="hint">正在读取…</div>}
                  {!dialogBusy && dialogTmux.length === 0 && (
                    <div className="hint">这台服务器上还没有 tmux 会话。</div>
                  )}
                  {dialogTmux.map((t) => (
                    <label
                      key={t.name}
                      className={
                        "attach-item" + (newDialog.attachTarget === t.name ? " active" : "")
                      }
                    >
                      <input
                        type="radio"
                        checked={newDialog.attachTarget === t.name}
                        onChange={() =>
                          setNewDialog({ ...newDialog, attachTarget: t.name })
                        }
                      />
                      <IconTerminal size={14} />
                      <span className="grow">{t.name}</span>
                      <span className="dim">{t.windows} 窗口</span>
                      {t.attached && <span className="tag">已连接</span>}
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={() => setNewDialog(null)}>
            取消
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={dialogBusy}
            onClick={() => void confirmNewSession()}
          >
            连接
          </button>
        </div>
      </div>
    </div>

  );
}

