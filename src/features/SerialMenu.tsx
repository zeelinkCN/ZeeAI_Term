// 侧栏「串口」那一行的右键菜单。
//
// 一个只读的小菜单：每一项都是"对着这条串口连接做一件事"，
// 所以它只需要拿到那条连接和几个动作，不需要知道 App 的其它状态。

import type { ConfirmDialogState, SerialMenuState } from "../lib/ui-model";
import type { ConnectionProfile } from "../types";

export interface SerialMenuProps {
  /** 对着哪条串口连接、在屏幕哪一点弹（坐标是 fixed 定位的菜单用的） */
  serialMenu: SerialMenuState;
  setSerialMenu: (v: SerialMenuState | null) => void;
  /** 「删除」要先过一道确认框（会真的删配置） */
  setConfirmDialog: (v: ConfirmDialogState | null) => void;
  openSerialDialog: (profile?: ConnectionProfile) => void;
  openSerialSession: (profile: ConnectionProfile) => Promise<unknown>;
  removeSerialProfile: (p: ConnectionProfile) => Promise<void>;
  duplicateProfile: (p: ConnectionProfile) => Promise<void>;
}

export function SerialMenu(props: SerialMenuProps) {
  const {
  serialMenu, setSerialMenu, setConfirmDialog, openSerialDialog, openSerialSession, removeSerialProfile,
  duplicateProfile,
  } = props;
  return (
    <div
      className="ctx-backdrop"
      onClick={() => setSerialMenu(null)}
      onContextMenu={(e) => {
        e.preventDefault();
        setSerialMenu(null);
      }}
    >
      <div
        className="ctx-menu"
        style={{
          left: Math.min(Math.max(0, serialMenu.x), Math.max(0, window.innerWidth - 210)),
          top: Math.min(Math.max(0, serialMenu.y), Math.max(0, window.innerHeight - 190)),
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="menu-head ellipsis">{serialMenu.profile.name}</div>
        <button
          type="button"
          className="menu-item"
          onClick={() => {
            const p = serialMenu.profile;
            setSerialMenu(null);
            void openSerialSession(p);
          }}
        >
          打开串口终端
        </button>
        <button
          type="button"
          className="menu-item"
          onClick={() => {
            const p = serialMenu.profile;
            setSerialMenu(null);
            openSerialDialog(p);
          }}
        >
          编辑（端口 / 波特率 / 校验…）
        </button>
        <button
          type="button"
          className="menu-item"
          onClick={() => {
            const p = serialMenu.profile;
            setSerialMenu(null);
            void duplicateProfile(p);
          }}
        >
          复制
        </button>
        <div className="menu-sep" />
        <button
          type="button"
          className="menu-item"
          onClick={() => {
            const p = serialMenu.profile;
            setSerialMenu(null);
            setConfirmDialog({
              title: "删除串口连接",
              message: `确定删除「${p.name}」这条串口连接吗？`,
              onOk: () => void removeSerialProfile(p),
            });
          }}
        >
          删除
        </button>
      </div>
    </div>

  );
}


