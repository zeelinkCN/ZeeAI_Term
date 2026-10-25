// 侧栏两个设备类面板：串口连接、Android（adb / fastboot）设备。
//
// 为什么放一个文件：它们都是"列一串设备 + 新建一个会话"，加起来不到 120 行，
// 分两个文件反而让侧栏的 import 更长。

import { IconAndroid, IconPlus, IconSerial } from "../components/Icons";
import type { SerialMenuState } from "../lib/ui-model";
import type { AdbDevice, ConnectionProfile, SerialPortInfo } from "../types";

export interface SidebarSerialProps {
  serialProfiles: ConnectionProfile[];
  serialPorts: SerialPortInfo[];
  serialLoading: boolean;
  openSerialDialog: (profile?: ConnectionProfile) => void;
  openSerialSession: (profile: ConnectionProfile) => Promise<unknown>;
  setSerialMenu: (v: SerialMenuState | null) => void;
}

export function SidebarSerial(props: SidebarSerialProps) {
  const {
  serialProfiles, serialPorts, serialLoading, openSerialDialog, openSerialSession, setSerialMenu,
  } = props;
  return (
    <>
      <div className="side-actions">
        <button
          type="button"
          className="btn primary"
          onClick={() => openSerialDialog()}
        >
          <IconPlus size={14} /> 新建串口连接
        </button>
      </div>
      {serialLoading && <div className="hint">正在检测串口…</div>}
      {!serialLoading && serialProfiles.length === 0 && (
        <div className="hint">还没有串口连接</div>
      )}
      {serialProfiles.map((p) => {
        const cfg = p.serial;
        const alive = serialPorts.some((x) => x.path === cfg?.path);
        return (
          <div
            key={p.id}
            className="tree-item"
            onClick={() => void openSerialSession(p)}
            title={`${cfg?.path} · ${cfg?.baudRate} 波特率（点击打开）`}
          >
            <IconSerial size={15} />
            <span className="grow ellipsis">{p.name}</span>
            <span className="dim">{cfg?.baudRate}</span>
            {!alive && <span className="tag warn">未接入</span>}
            <button
              type="button"
              className="mini-x"
              title="编辑 / 复制 / 删除"
              onClick={(e) => {
                e.stopPropagation();
                const r = (e.target as HTMLElement).getBoundingClientRect();
                setSerialMenu({ profile: p, x: r.left - 170, y: r.bottom + 4 });
              }}
            >
              ⋯
            </button>
          </div>
        );
      })}
    </>

  );
}

export interface SidebarAdbProps {
  adbList: AdbDevice[];
  adbVer: string;
  adbLoading: boolean;
  fbList: AdbDevice[];
  fbVer: string;
  refreshAdb: () => Promise<unknown>;
  openAdbSession: (serial: string, mode?: "shell" | "logcat") => Promise<unknown>;
  /** 打开某台设备的文件管理（会把 adbSerial 设上） */
  setAdbSerial: (v: string | null) => void;
  refreshAdbFiles: (serial: string, path: string) => Promise<unknown>;
}

export function SidebarAdb(props: SidebarAdbProps) {
  const {
  adbList, adbVer, adbLoading, fbList, fbVer, refreshAdb,
  openAdbSession, setAdbSerial, refreshAdbFiles,
  } = props;
  return (
    <>
      <div className="side-actions">
        <button type="button" className="btn" onClick={() => void refreshAdb()}>
          <IconPlus size={14} /> 刷新设备
        </button>
      </div>
      <div className="hint">
        {adbVer
          ? "adb 已就绪"
          : adbLoading
            ? "正在检测 adb…"
            : "未检测到 adb"}
      </div>
      {!adbLoading && adbList.length === 0 && adbVer !== "" && (
        <div className="hint">没有已连接的设备</div>
      )}
      {adbList.map((d) => (
        <div
          key={d.serial}
          className="tree-item"
          onClick={() => void openAdbSession(d.serial)}
          title={`${d.serial} · ${d.state} — 点击打开 adb shell`}
        >
          <IconAndroid size={15} />
          <span className="grow">{d.model || d.serial}</span>
          <button
            type="button"
            className="mini-btn"
            title="打开设备文件管理（浏览 / 推送 / 拉取）"
            onClick={(e) => {
              e.stopPropagation();
              setAdbSerial(d.serial);
              void refreshAdbFiles(d.serial, "/sdcard");
            }}
          >
            文件
          </button>
          <button
            type="button"
            className="mini-btn"
            title="打开 logcat（实时日志）"
            onClick={(e) => {
              e.stopPropagation();
              void openAdbSession(d.serial, "logcat");
            }}
          >
            logcat
          </button>
          <span className={d.state === "device" ? "dot ok" : "dot off"} />
        </div>
      ))}
      {/* 只读探测：这里**只能看**（fastboot devices / --version），
          刷机、重启到 bootloader 这些命令都还没有 —— 所以标题写清楚，
          别让用户以为点了能刷（README 里同步说明）。 */}
      <div className="tree-group">Fastboot 设备（bootloader 模式 · 只读探测）</div>
      <div className="hint">
        {fbVer ? "fastboot 已就绪" : "未检测到 fastboot"}
      </div>
      {fbList.length === 0 && (
        <div className="hint">没有 fastboot 设备</div>
      )}
      {fbList.map((d) => (
        <div key={d.serial} className="tree-item" title={`${d.serial} · ${d.state}`}>
          <IconAndroid size={15} />
          <span className="grow ellipsis">{d.serial}</span>
          <span className="tag">fastboot</span>
        </div>
      ))}
    </>

  );
}

