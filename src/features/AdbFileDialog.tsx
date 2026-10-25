// ADB 设备的文件管理器（列目录 / 上传 / 下载 / 新建 / 删除）。
//
// 为什么整块搬走：它是一台设备上的一个小浏览器，状态全是 adb* 那几项，
// 和主界面的会话/标签没有交集。

import { IconFile, IconFolder } from "../components/Icons";
import { humanSize } from "../lib/file-kind";
import type { AdbFile } from "../types";

export interface AdbFileDialogProps {
  /** 当前设备序列号（对话框只在有设备时挂载） */
  adbSerial: string;
  setAdbSerial: (v: string | null) => void;
  adbPath: string;
  setAdbPath: (v: string) => void;
  adbFiles: AdbFile[];
  adbNewName: string;
  setAdbNewName: (v: string) => void;
  adbLoading: boolean;
  joinRemote: (dir: string, name: string) => string;
  refreshAdbFiles: (serial: string, path: string) => Promise<void>;
  adbUpload: (serial: string) => Promise<void>;
  adbDownload: (serial: string, name: string) => Promise<void>;
  adbMkdirNow: (serial: string, name: string) => Promise<void>;
  adbDelete: (serial: string, name: string, isDir: boolean) => Promise<void>;
}

export function AdbFileDialog(props: AdbFileDialogProps) {
  const {
  adbSerial, setAdbSerial, adbPath, setAdbPath, adbFiles, adbNewName,
  setAdbNewName, adbLoading, joinRemote, refreshAdbFiles, adbUpload, adbDownload,
  adbMkdirNow, adbDelete,
  } = props;
  return (
    <div className="modal-backdrop" onClick={() => setAdbSerial(null)}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">设备文件 · {adbSerial}</div>
        <div className="modal-body">
          <div className="side-actions">
            <button
              type="button"
              className="mini-btn"
              title="回到 /sdcard"
              onClick={() => void refreshAdbFiles(adbSerial, "/sdcard")}
            >
              /sdcard
            </button>
            <button
              type="button"
              className="mini-btn"
              title="上一级"
              onClick={() => {
                const parent = adbPath.replace(/\/+$/, "").split("/").slice(0, -1).join("/");
                void refreshAdbFiles(adbSerial, parent.startsWith("/") ? parent : "/");
              }}
            >
              上一级
            </button>
            <button
              type="button"
              className="mini-btn"
              onClick={() => void refreshAdbFiles(adbSerial, adbPath)}
            >
              刷新
            </button>
            <button
              type="button"
              className="mini-btn"
              title="把本机文件推到当前目录"
              onClick={() => void adbUpload(adbSerial)}
            >
              推送文件
            </button>
          </div>
          <div className="modal-inline-action" style={{ paddingBottom: 8 }}>
            <input
              className="modal-input"
              style={{ flex: 1 }}
              value={adbPath}
              spellCheck={false}
              onChange={(e) => setAdbPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && adbSerial) void refreshAdbFiles(adbSerial, adbPath);
              }}
            />
          </div>
          <div className="modal-inline-action" style={{ paddingBottom: 8 }}>
            <input
              className="modal-input"
              style={{ flex: 1 }}
              placeholder="新建文件夹的名字"
              value={adbNewName}
              onChange={(e) => setAdbNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && adbSerial) void adbMkdirNow(adbSerial, adbNewName);
              }}
            />
            <button
              type="button"
              className="mini-btn"
              style={{ marginLeft: 6 }}
              disabled={!adbNewName.trim()}
              onClick={() => adbSerial && void adbMkdirNow(adbSerial, adbNewName)}
            >
              新建文件夹
            </button>
          </div>
          {adbLoading && <div className="hint">正在读取设备目录…</div>}
          {!adbLoading && adbFiles.length === 0 && (
            <div className="hint">空目录</div>
          )}
          {adbFiles.map((f) => (
            <div
              key={f.name}
              className="tree-item"
              title={f.isDir ? "进入目录" : "下载到本机"}
              onClick={() =>
                adbSerial &&
                (f.isDir
                  ? void refreshAdbFiles(adbSerial, joinRemote(adbPath, f.name))
                  : void adbDownload(adbSerial, f.name))
              }
            >
              {f.isDir ? <IconFolder size={14} /> : <IconFile size={14} />}
              <span className="grow ellipsis">{f.name}</span>
              <span className="dim">{f.isDir ? "" : humanSize(f.size)}</span>
              <button
                type="button"
                className="mini-x"
                title="删除"
                onClick={(e) => {
                  e.stopPropagation();
                  if (adbSerial) void adbDelete(adbSerial, f.name, f.isDir);
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={() => setAdbSerial(null)}>
            关闭
          </button>
        </div>
      </div>
    </div>

  );
}

