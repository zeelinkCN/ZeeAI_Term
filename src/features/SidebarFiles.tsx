// 侧栏「文件」页：远端目录浏览（进目录 / 上传 / 下载 / 跟随终端 cwd）。

import { IconFile, IconFolder } from "../components/Icons";
import { humanSize, joinPath, parentOf } from "../lib/file-kind";
import type { FsMenuState, NameDialogState, OpenSession } from "../lib/ui-model";
import type { AppSettings, ConnectionProfile, RemoteEntry } from "../types";

export interface SidebarFilesProps {
  /** 当前会话（决定在看哪台机器、要不要跟随它的 cwd） */
  activeSession: OpenSession | null;
  activeTmuxName: string | undefined;
  fileProfile: ConnectionProfile | null;
  settings: AppSettings;
  updateSettings: (patch: Partial<AppSettings>) => Promise<unknown>;
  fsPath: string;
  fsInput: string;
  setFsInput: (v: string) => void;
  fsEntries: RemoteEntry[];
  fsLoading: boolean;
  fsBusy: boolean;
  loadDir: (profileId: string, path?: string) => Promise<unknown>;
  syncFsToTerminal: (profileId: string, tmuxName?: string, cwd?: string) => Promise<unknown>;
  uploadToRemote: (profileId: string) => Promise<unknown>;
  openRemoteFile: (profileId: string, name: string, sessionIdOverride?: string) => Promise<unknown>;
  setFsMenu: (v: FsMenuState | null) => void;
  setNameDialog: (v: NameDialogState | null) => void;
}

export function SidebarFiles(props: SidebarFilesProps) {
  const {
  activeSession, activeTmuxName, fileProfile, settings, updateSettings, fsPath,
  fsInput, setFsInput, fsEntries, fsLoading, fsBusy, loadDir,
  syncFsToTerminal, uploadToRemote, openRemoteFile, setFsMenu, setNameDialog,
  } = props;
  return (
    <>
      {!fileProfile && (
        <div className="hint">先打开一个 SSH 会话</div>
      )}
      {fileProfile && (
        <>
          <div className="fs-toolbar">
            <button
              type="button"
              className="mini-btn"
              onClick={() => void loadDir(fileProfile.id, parentOf(fsPath))}
            >
              ↑ 上级
            </button>
            <button
              type="button"
              className="mini-btn"
              title="重新读取当前目录"
              onClick={() => void loadDir(fileProfile.id, fsPath)}
            >
              刷新
            </button>
            <button
              type="button"
              className="mini-btn"
              title="跳到终端当前所在目录（你在终端里 cd 到哪儿就同步到哪儿）"
              onClick={() =>
                void syncFsToTerminal(
                  fileProfile.id,
                  activeTmuxName,
                  activeSession?.cwd,
                )
              }
            >
              ⤓ 同步终端目录
            </button>
            <button
              type="button"
              className="mini-btn"
              onClick={() => void loadDir(fileProfile.id, undefined)}
            >
              家目录
            </button>
            <button
              type="button"
              className="mini-btn"
              disabled={fsBusy}
              title="把本机文件上传到当前目录"
              onClick={() => void uploadToRemote(fileProfile.id)}
            >
              上传
            </button>
            <button
              type="button"
              className="mini-btn"
              disabled={fsBusy}
              title="在当前目录新建文件夹"
              onClick={() =>
                setNameDialog({
                  mode: "mkdir",
                  profileId: fileProfile.id,
                  dir: fsPath,
                  from: "",
                  value: "新建文件夹",
                })
              }
            >
              新建文件夹
            </button>
            <button
              type="button"
              className={"mini-btn" + (settings.fsFollowTerminal ? " active" : "")}
              title={
                settings.fsFollowTerminal
                  ? "已开启：刷新会跳到终端（tmux）当前所在目录"
                  : "已关闭：刷新只重读当前目录"
              }
              onClick={() =>
                void updateSettings({ fsFollowTerminal: !settings.fsFollowTerminal })
              }
            >
              {settings.fsFollowTerminal ? "✓ 跟随终端" : "跟随终端"}
            </button>
          </div>
          <input
            className="fs-path-input"
            value={fsInput}
            spellCheck={false}
            placeholder="/path/to/dir  回车跳转"
            onChange={(e) => setFsInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                void loadDir(fileProfile.id, fsInput.trim() || undefined);
              }
            }}
          />
          <div className="fs-list">
            {fsEntries.map((en) => (
              <div
                key={en.name}
                className="fs-row"
                onClick={() =>
                  en.isDir
                    ? void loadDir(fileProfile.id, joinPath(fsPath, en.name))
                    : void openRemoteFile(fileProfile.id, en.name)
                }
                onContextMenu={(e) => {
                  e.preventDefault();
                  setFsMenu({
                    profileId: fileProfile.id,
                    name: en.name,
                    isDir: en.isDir,
                    x: e.clientX,
                    y: e.clientY,
                  });
                }}
                title={
                  (en.isDir ? "进入目录" : "预览文件") +
                  "　（右键：下载 / 重命名 / 删除）"
                }
              >
                {en.isDir ? <IconFolder size={15} /> : <IconFile size={15} />}
                <span className="grow">{en.name}</span>
                <span className="dim">{en.isDir ? "" : humanSize(en.size)}</span>
                <button
                  type="button"
                  className="mini-x"
                  title="下载 / 重命名 / 删除"
                  onClick={(e) => {
                    e.stopPropagation();
                    const r = (e.target as HTMLElement).getBoundingClientRect();
                    setFsMenu({
                      profileId: fileProfile.id,
                      name: en.name,
                      isDir: en.isDir,
                      x: r.left - 150,
                      y: r.bottom + 4,
                    });
                  }}
                >
                  ⋯
                </button>
              </div>
            ))}
            {!fsLoading && fsEntries.length === 0 && (
              <div className="hint">空目录</div>
            )}
          </div>
        </>
      )}
    </>

  );
}

