// 「串口连接」编辑对话框（新建 / 修改一条用户自己的串口配置）。
//
// 为什么单独一个文件：串口配置只有 5 个字段，但还要列本机 COM 口、
// 保存后再决定要不要立刻连上去 —— 这些都在它自己身上，跟主界面无关。

import type { SerialDialogState } from "../lib/ui-model";
import type { ConnectionProfile, SerialConfig, SerialPortInfo } from "../types";

export interface SerialProfileDialogProps {
  /** isNew 决定标题与"保存后是否连上去"的默认动作 */
  serialDialog: SerialDialogState;
  setSerialDialog: (v: SerialDialogState | null) => void;
  /** 本机串口列表（点「刷新」重扫） */
  serialPorts: SerialPortInfo[];
  serialLoading: boolean;
  patchSerialDraft: (
    patch: Partial<ConnectionProfile>,
    serialPatch?: Partial<SerialConfig>,
  ) => void;
  saveSerialDialog: (openAfter: boolean) => Promise<void>;
  refreshSerial: () => Promise<void>;
}

export function SerialProfileDialog(props: SerialProfileDialogProps) {
  const {
  serialDialog, setSerialDialog, serialPorts, serialLoading, patchSerialDraft, saveSerialDialog,
  refreshSerial,
  } = props;
  return (
    <div className="modal-backdrop">
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          {serialDialog.isNew ? "新建串口连接" : "编辑串口连接"}
          <button
            type="button"
            className="mini-x"
            style={{ float: "right", opacity: 1 }}
            title="关闭"
            onClick={() => setSerialDialog(null)}
          >
            ✕
          </button>
        </div>
        <div className="modal-body">
          <label className="modal-field">
            名称
            <input
              value={serialDialog.draft.name}
              placeholder="比如：ESP32 调试口"
              onChange={(e) => patchSerialDraft({ name: e.target.value })}
            />
          </label>

          <label className="modal-field">
            端口
            <select
              value={
                serialPorts.some((p) => p.path === serialDialog.draft.serial?.path)
                  ? serialDialog.draft.serial?.path
                  : "__custom__"
              }
              onChange={(e) => {
                if (e.target.value !== "__custom__") {
                  patchSerialDraft({}, { path: e.target.value });
                }
              }}
            >
              {serialPorts.map((p) => (
                <option key={p.path} value={p.path}>
                  {p.path} — {p.label}
                </option>
              ))}
              <option value="__custom__">
                {serialPorts.length === 0 ? "（没检测到串口，手动输入）" : "手动输入…"}
              </option>
            </select>
          </label>
          <label className="modal-field">
            端口名（也可以直接手填）
            <input
              value={serialDialog.draft.serial?.path ?? ""}
              placeholder="COM5"
              onChange={(e) => patchSerialDraft({}, { path: e.target.value })}
            />
          </label>
          <div className="modal-inline-action" style={{ paddingBottom: 8 }}>
            <button
              type="button"
              className="mini-btn"
              disabled={serialLoading}
              onClick={() => void refreshSerial()}
            >
              {serialLoading ? "检测中…" : "重新检测串口"}
            </button>
            <span className="hint" style={{ marginLeft: 8 }}>
              检测到 {serialPorts.length} 个口（含蓝牙/虚拟串口，按需选）
            </span>
          </div>

          <div className="modal-row">
            <label className="modal-field">
              波特率
              <select
                value={
                  [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600].includes(
                    serialDialog.draft.serial?.baudRate ?? 115200,
                  )
                    ? String(serialDialog.draft.serial?.baudRate)
                    : "__custom__"
                }
                onChange={(e) => {
                  if (e.target.value !== "__custom__") {
                    patchSerialDraft({}, { baudRate: Number(e.target.value) });
                  }
                }}
              >
                {[9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600].map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
                <option value="__custom__">自定义…</option>
              </select>
            </label>
            <label className="modal-field">
              自定义波特率
              <input
                value={serialDialog.draft.serial?.baudRate ?? 115200}
                onChange={(e) =>
                  patchSerialDraft({}, { baudRate: Number(e.target.value) || 115200 })
                }
              />
            </label>
          </div>

          <div className="modal-row">
            <label className="modal-field">
              数据位
              <select
                value={serialDialog.draft.serial?.dataBits ?? 8}
                onChange={(e) => patchSerialDraft({}, { dataBits: Number(e.target.value) })}
              >
                {[5, 6, 7, 8].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <label className="modal-field">
              停止位
              <select
                value={serialDialog.draft.serial?.stopBits ?? 1}
                onChange={(e) => patchSerialDraft({}, { stopBits: Number(e.target.value) })}
              >
                <option value={1}>1</option>
                <option value={2}>2</option>
              </select>
            </label>
          </div>

          <div className="modal-row">
            <label className="modal-field">
              校验位
              <select
                value={serialDialog.draft.serial?.parity ?? "none"}
                onChange={(e) =>
                  patchSerialDraft({}, {
                    parity: e.target.value as SerialConfig["parity"],
                  })
                }
              >
                <option value="none">无 (None)</option>
                <option value="odd">奇校验 (Odd)</option>
                <option value="even">偶校验 (Even)</option>
              </select>
            </label>
            <label className="modal-field">
              流控
              <select
                value={serialDialog.draft.serial?.flowControl ?? "none"}
                onChange={(e) =>
                  patchSerialDraft({}, {
                    flowControl: e.target.value as SerialConfig["flowControl"],
                  })
                }
              >
                <option value="none">无</option>
                <option value="software">软件 (XON/XOFF)</option>
                <option value="hardware">硬件 (RTS/CTS)</option>
              </select>
            </label>
          </div>

          <div className="hint" style={{ padding: "0 14px" }}>
            这些参数只影响这条连接
          </div>
        </div>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={() => setSerialDialog(null)}>
            取消
          </button>
          <button type="button" className="btn" onClick={() => void saveSerialDialog(false)}>
            仅保存
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={() => void saveSerialDialog(true)}
          >
            保存并打开
          </button>
        </div>
      </div>
    </div>

  );
}

