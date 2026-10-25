// 侧栏「Git」页：工作空间 / 分支 / 改动列表 / 提交历史。

import { IconGit, IconPlus } from "../components/Icons";
import type { AppSettings, ConnectionProfile, GitBranch, GitCommit, GitStatus } from "../types";

export interface SidebarGitProps {
  settings: AppSettings;
  gitWorkspaces: ConnectionProfile[];
  gitPath: string;
  setGitPath: (v: string) => void;
  gitState: GitStatus | null;
  gitLoading: boolean;
  gitBusy: boolean;
  gitMessage: string;
  setGitMessage: (v: string) => void;
  gitCommits: GitCommit[];
  gitBranchList: GitBranch[];
  showBranches: boolean;
  setShowBranches: (v: boolean | ((prev: boolean) => boolean)) => void;
  newBranch: string;
  setNewBranch: (v: string) => void;
  /** 工作区改动（拆成"已暂存 / 未暂存"两份给界面用） */
  changedFiles: { path: string; st: string }[];
  stagedFiles: { path: string; st: string }[];
  refreshGitAll: (pathArg?: string) => Promise<unknown>;
  openGitWorkspace: () => Promise<unknown>;
  removeGitWorkspace: (p: ConnectionProfile) => Promise<unknown>;
  openGitTerminal: (dir: string, title?: string) => Promise<unknown>;
  openLocalSession: (
    shell: "powershell" | "pwsh" | "cmd" | "wsl",
    distro?: string,
    cwd?: string,
    titleOverride?: string,
  ) => Promise<unknown>;
  setGitInitDialog: (v: { path: string } | null) => void;
  doGitAdd: (files?: string[]) => Promise<unknown>;
  doGitUnstage: (files: string[]) => Promise<unknown>;
  askGitDiscard: (files: string[]) => void;
  doGitCommit: () => Promise<unknown>;
  doGitCheckout: (branch: string, create?: boolean) => Promise<unknown>;
  showFileDiff: (file: string, staged: boolean) => Promise<unknown>;
  showCommitDiff: (hash: string, subject: string) => Promise<unknown>;
}

export function SidebarGit(props: SidebarGitProps) {
  const {
  settings, gitWorkspaces, gitPath, setGitPath, gitState, gitLoading,
  gitBusy, gitMessage, setGitMessage, gitCommits, gitBranchList, showBranches,
  setShowBranches, newBranch, setNewBranch, changedFiles, stagedFiles, refreshGitAll,
  openGitWorkspace, removeGitWorkspace, openGitTerminal, openLocalSession, setGitInitDialog, doGitAdd,
  doGitUnstage, askGitDiscard, doGitCommit, doGitCheckout, showFileDiff, showCommitDiff,
  } = props;
  return (
    <>
      <div className="side-actions">
        <button
          type="button"
          className="btn primary"
          title="选一个本地仓库目录，直接在这个目录开一个本地终端（PowerShell / CMD / WSL 按设置来）"
          onClick={() => void openGitWorkspace()}
        >
          <IconPlus size={14} /> 打开本地仓库
        </button>
        <button
          type="button"
          className="btn"
          title="在一个目录里执行 git init，建好后直接打开终端"
          onClick={() => setGitInitDialog({ path: "" })}
        >
          新建仓库
        </button>
      </div>
      <div className="tree-group">Git 工作空间</div>
      {gitWorkspaces.length === 0 && (
        <div className="hint">还没有工作空间</div>
      )}
      {gitWorkspaces.map((p) => (
        <div
          key={p.id}
          className="tree-item"
          title={`${p.local?.cwd}（点击查看改动，右侧按钮开终端）`}
          onClick={() => {
            const dir = p.local?.cwd ?? "";
            setGitPath(dir);
            void refreshGitAll(dir);
          }}
        >
          <IconGit size={14} />
          <span className="grow ellipsis">{p.name}</span>
          <button
            type="button"
            className="mini-btn"
            title="在这个目录再开一个新的本地终端（可以开任意多个）"
            onClick={(e) => {
              e.stopPropagation();
              const dir = p.local?.cwd ?? "";
              void openLocalSession(
                p.local?.shell ?? settings.defaultShell,
                p.local?.distro,
                dir,
                `${p.name}`,
              );
            }}
          >
            新终端
          </button>
          <button
            type="button"
            className="mini-x"
            title="从工作空间里移除"
            onClick={(e) => {
              e.stopPropagation();
              void removeGitWorkspace(p);
            }}
          >
            ×
          </button>
        </div>
      ))}

      <div className="tree-group">快速查看某个仓库</div>
      <label className="modal-field" style={{ paddingTop: 4 }}>
        仓库路径
        <input
          value={gitPath}
          placeholder="D:\AI\ZeeAI_term"
          onChange={(e) => setGitPath(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void refreshGitAll();
          }}
        />
      </label>
      <div className="side-actions">
        <button
          type="button"
          className="btn"
          disabled={gitBusy}
          onClick={() => void refreshGitAll()}
        >
          {gitBusy ? "读取中…" : "刷新"}
        </button>
        <button
          type="button"
          className="btn"
          title="在当前仓库目录打开一个新的本地终端"
          onClick={() => void openGitTerminal(gitPath, undefined)}
        >
          开终端
        </button>
        <button
          type="button"
          className="btn"
          disabled={!gitState?.ok}
          onClick={() => {
            setShowBranches((v) => !v);
            if (!gitBranchList.length && gitState?.ok) void refreshGitAll();
          }}
        >
          分支 {gitState?.branch ? `(${gitState.branch})` : ""}
        </button>
      </div>
      {gitLoading && <div className="hint">正在读取…</div>}
      {!gitLoading && gitState && !gitState.ok && (
        <div className="hint">{gitState.message}</div>
      )}
      {!gitLoading && gitState?.ok && (
        <>
          {/* 分支列表 */}
          {showBranches && (
            <div className="git-branches">
              {gitBranchList.map((b) => (
                <div
                  key={b.name}
                  className={"tree-item" + (b.current ? " current" : "")}
                  title={`${b.name}${b.upstream ? ` → ${b.upstream}` : ""}　${b.when}`}
                  onClick={() => {
                    if (!b.current) void doGitCheckout(b.name);
                  }}
                >
                  <IconGit size={13} />
                  <span className="grow ellipsis">{b.name}</span>
                  {b.current && <span className="tag">当前</span>}
                  <span className="dim">{b.when}</span>
                </div>
              ))}
              <div className="git-newbranch">
                <input
                  value={newBranch}
                  placeholder="新分支名"
                  onChange={(e) => setNewBranch(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && newBranch.trim())
                      void doGitCheckout(newBranch, true);
                  }}
                />
                <button
                  type="button"
                  className="mini-btn"
                  disabled={!newBranch.trim()}
                  onClick={() => void doGitCheckout(newBranch, true)}
                >
                  新建并切换
                </button>
              </div>
            </div>
          )}

          <div className="git-commit-box">
            <textarea
              className="git-commit-msg"
              rows={2}
              placeholder="提交信息（Ctrl+Enter 提交）"
              value={gitMessage}
              onChange={(e) => setGitMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  void doGitCommit();
                }
              }}
            />
            <button
              type="button"
              className="btn primary git-commit-btn"
              disabled={gitBusy || !gitMessage.trim()}
              onClick={() => void doGitCommit()}
            >
              提交
            </button>
          </div>

          {/* 已暂存 */}
          {stagedFiles.length > 0 && (
            <>
              <div className="tree-group">
                已暂存（{stagedFiles.length}）
                <button
                  type="button"
                  className="mini-x"
                  style={{ marginLeft: "auto", opacity: 1 }}
                  title="全部取消暂存"
                  onClick={() => void doGitUnstage(stagedFiles.map((f) => f.path))}
                >
                  −
                </button>
              </div>
              {stagedFiles.map((f) => (
                <div
                  key={"s" + f.path}
                  className="tree-item git-file"
                  title={`${f.path}（点击看 diff）`}
                  onClick={() => void showFileDiff(f.path, true)}
                >
                  <span className="git-st staged">{f.st}</span>
                  <span className="grow ellipsis">{f.path}</span>
                  <button
                    type="button"
                    className="mini-x"
                    title="取消暂存"
                    onClick={(e) => {
                      e.stopPropagation();
                      void doGitUnstage([f.path]);
                    }}
                  >
                    −
                  </button>
                </div>
              ))}
            </>
          )}

          {/* 更改 */}
          <div className="tree-group">
            更改（{changedFiles.length}）
            <button
              type="button"
              className="mini-x"
              style={{ marginLeft: "auto", opacity: 1 }}
              title="全部暂存"
              onClick={() => void doGitAdd()}
            >
              ＋
            </button>
          </div>
          {changedFiles.length === 0 && (
            <div className="hint">没有未暂存的改动。</div>
          )}
          {changedFiles.map((f) => (
            <div
              key={"c" + f.path}
              className="tree-item git-file"
              title={`${f.path}（点击看 diff）`}
              onClick={() => void showFileDiff(f.path, false)}
            >
              <span className="git-st">{f.st}</span>
              <span className="grow ellipsis">{f.path}</span>
              <button
                type="button"
                className="mini-x"
                title="暂存这个文件"
                onClick={(e) => {
                  e.stopPropagation();
                  void doGitAdd([f.path]);
                }}
              >
                ＋
              </button>
              <button
                type="button"
                className="mini-x"
                title="丢弃改动（不可撤销）"
                onClick={(e) => {
                  e.stopPropagation();
                  askGitDiscard([f.path]);
                }}
              >
                ↺
              </button>
            </div>
          ))}

          <div className="hint">
            分支 {gitState.branch || "(未知)"}
            {gitState.upstream ? ` → ${gitState.upstream}` : ""}
            {gitState.ahead > 0 ? ` · 领先 ${gitState.ahead}` : ""}
            {gitState.behind > 0 ? ` · 落后 ${gitState.behind}` : ""}
          </div>

          {/* 历史 */}
          <div className="tree-group">提交历史（{gitCommits.length}）</div>
          {gitCommits.length === 0 && <div className="hint">还没有提交。</div>}
          {gitCommits.map((cm) => (
            <div
              key={cm.hash}
              className="tree-item git-commit"
              title={`${cm.hash}\n${cm.author} · ${cm.when}\n点击查看这次提交的 diff`}
              onClick={() => void showCommitDiff(cm.hash, cm.subject)}
            >
              <span className="git-hash">{cm.short}</span>
              <span className="grow ellipsis">{cm.subject}</span>
              <span className="dim">{cm.when}</span>
            </div>
          ))}
        </>
      )}
      {!gitLoading && !gitState && (
        <div className="hint">填一个本地仓库路径</div>
      )}
    </>

  );
}

