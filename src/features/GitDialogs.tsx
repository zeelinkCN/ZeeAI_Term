// Git 面板的两个小弹窗：「这个目录还不是仓库」和「看 diff」。
//
// 两个都是纯展示 + 一个动作，放进一个文件是因为它们共用同一个入口
//（Git 面板），拆成两个文件只会多两次跳转。

import { open as openLocalDialog } from "@tauri-apps/plugin-dialog";

export interface GitInitDialogProps {
  /** 要 git init 的目录（对话框只在有值时挂载） */
  gitInitDialog: { path: string };
  setGitInitDialog: (v: { path: string } | null) => void;
  createGitRepo: (rawPath: string) => Promise<void>;
}

export function GitInitDialog(props: GitInitDialogProps) {
  const {
  gitInitDialog, setGitInitDialog, createGitRepo,
  } = props;
  return (
    <div className="modal-backdrop" onClick={() => setGitInitDialog(null)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">新建 Git 仓库</div>
        <div className="modal-body">
          <label className="modal-field">
            仓库目录（不存在会自动创建）
            <input
              autoFocus
              value={gitInitDialog.path}
              placeholder="D:\code\my-repo"
              onChange={(e) => setGitInitDialog({ path: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") void createGitRepo(gitInitDialog.path);
                if (e.key === "Escape") setGitInitDialog(null);
              }}
            />
          </label>
          <div className="modal-inline-action" style={{ paddingBottom: 8 }}>
            <button
              type="button"
              className="mini-btn"
              onClick={() => {
                void (async () => {
                  const picked = await openLocalDialog({
                    directory: true,
                    title: "选一个目录（可以是空目录）",
                  });
                  if (picked && !Array.isArray(picked)) {
                    setGitInitDialog({ path: picked });
                  }
                })();
              }}
            >
              浏览目录…
            </button>
            <span className="hint" style={{ marginLeft: 8 }}>
              会在该目录执行 <code>git init -b main</code>，然后开一个终端。
            </span>
          </div>
        </div>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={() => setGitInitDialog(null)}>
            取消
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={() => void createGitRepo(gitInitDialog.path)}
          >
            创建并打开终端
          </button>
        </div>
      </div>
    </div>

  );
}

export interface DiffDialogProps {
  /** 标题 + 已经是纯文本的 diff 内容（后端给什么就显示什么） */
  diffDialog: { title: string; text: string };
  setDiffDialog: (v: { title: string; text: string } | null) => void;
}

export function DiffDialog(props: DiffDialogProps) {
  const {
  diffDialog, setDiffDialog,
  } = props;
  return (
    <div className="modal-backdrop" onClick={() => setDiffDialog(null)}>
      <div className="modal wide diff-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head ellipsis" title={diffDialog.title}>
          {diffDialog.title}
        </div>
        <div className="modal-body diff-body">
          <pre className="diff-pre">
            {diffDialog.text.split("\n").map((line, i) => (
              <div
                key={i}
                className={
                  "diff-line" +
                  (line.startsWith("+") && !line.startsWith("+++")
                    ? " add"
                    : line.startsWith("-") && !line.startsWith("---")
                      ? " del"
                      : line.startsWith("@@")
                        ? " hunk"
                        : line.startsWith("diff ") ||
                            line.startsWith("index ") ||
                            line.startsWith("commit ")
                          ? " meta"
                          : "")
                }
              >
                {line || " "}
              </div>
            ))}
          </pre>
        </div>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={() => setDiffDialog(null)}>
            关闭
          </button>
        </div>
      </div>
    </div>

  );
}


