// 远程文件面板的文件/目录右键菜单（打开 / 下载 / 改名 / 删除 / 新建）。

import { joinPath } from "../lib/file-kind";
import type { ConfirmDialogState, FsMenuState, NameDialogState } from "../lib/ui-model";

export interface FsMenuProps {
  fsMenu: FsMenuState;
  setFsMenu: (v: FsMenuState | null) => void;
  /** 删除 / 改名都先过确认框或输入框，菜单自己不做二次确认 */
  setConfirmDialog: (v: ConfirmDialogState | null) => void;
  setNameDialog: (v: NameDialogState | null) => void;
  /** 当前目录（删除/改名要给后端完整路径） */
  fsPath: string;
  openRemoteFile: (profileId: string, name: string, sessionIdOverride?: string) => Promise<void>;
  downloadFromRemote: (profileId: string, name: string) => Promise<void>;
  doRemoveRemote: (profileId: string, name: string) => Promise<void>;
}

export function FsMenu(props: FsMenuProps) {
  const {
  fsMenu, setFsMenu, setConfirmDialog, setNameDialog, fsPath, openRemoteFile,
  downloadFromRemote, doRemoveRemote,
  } = props;
  return (
    <div
      className="ctx-backdrop"
      onClick={() => setFsMenu(null)}
      onContextMenu={(e) => {
        e.preventDefault();
        setFsMenu(null);
      }}
    >
      <div
        className="ctx-menu"
        style={{
          left: Math.min(Math.max(0, fsMenu.x), Math.max(0, window.innerWidth - 210)),
          top: Math.min(Math.max(0, fsMenu.y), Math.max(0, window.innerHeight - 190)),
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="menu-head ellipsis" title={fsMenu.name}>
          {fsMenu.name}
        </div>
        {!fsMenu.isDir && (
          <button
            type="button"
            className="menu-item"
            onClick={() => {
              const m = fsMenu;
              setFsMenu(null);
              void openRemoteFile(m.profileId, m.name);
            }}
          >
            打开预览
          </button>
        )}
        <button
          type="button"
          className="menu-item"
          onClick={() => {
            const m = fsMenu;
            setFsMenu(null);
            void downloadFromRemote(m.profileId, m.name);
          }}
        >
          下载到本机…
        </button>
        <button
          type="button"
          className="menu-item"
          onClick={() => {
            const m = fsMenu;
            setFsMenu(null);
            setNameDialog({
              mode: "rename",
              profileId: m.profileId,
              dir: fsPath,
              from: m.name,
              value: m.name,
            });
          }}
        >
          重命名…
        </button>
        <div className="menu-sep" />
        <button
          type="button"
          className="menu-item"
          onClick={() => {
            const m = fsMenu;
            setFsMenu(null);
            setConfirmDialog({
              title: m.isDir ? "删除目录" : "删除文件",
              message:
                `确定要删除服务器上的 ${joinPath(fsPath, m.name)} 吗？` +
                (m.isDir ? "目录会被递归删除。" : "") +
                "此操作不可撤销。",
              onOk: () => void doRemoveRemote(m.profileId, m.name),
            });
          }}
        >
          删除（不可撤销）
        </button>
      </div>
    </div>

  );
}

