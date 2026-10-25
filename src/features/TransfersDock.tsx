// 右下角的文件传输列表（进度条 + 完成/失败）。

import { humanSize } from "../lib/file-kind";
import type { TransferItem } from "../lib/ui-model";

export interface TransfersDockProps {
  transfers: TransferItem[];
  setTransfers: (v: TransferItem[]) => void;
}

export function TransfersDock(props: TransfersDockProps) {
  const {
  transfers, setTransfers,
  } = props;
  return (
    <div className="transfer-dock">
      <div className="transfer-head">
        <span>文件传输（{transfers.filter((t) => t.status === "running").length} 进行中）</span>
        <button
          type="button"
          className="mini-x"
          style={{ opacity: 1 }}
          title="清空列表"
          onClick={() => setTransfers([])}
        >
          ✕
        </button>
      </div>
      {transfers.map((t) => {
        const pct =
          t.total > 0 ? Math.min(100, Math.round((t.done / t.total) * 100)) : 0;
        return (
          <div key={t.id} className={"transfer-item " + t.status}>
            <div className="transfer-line">
              <span className="grow ellipsis" title={t.name}>
                {t.name}
              </span>
              <span className="dim">
                {t.status === "done"
                  ? "完成"
                  : t.status === "failed"
                    ? "失败"
                    : `${pct}%`}
              </span>
            </div>
            <div className="transfer-bar">
              <div
                className="transfer-fill"
                style={{ width: t.status === "done" ? "100%" : `${pct}%` }}
              />
            </div>
            <div className="transfer-meta">
              {humanSize(t.done)}
              {t.total > 0 ? ` / ${humanSize(t.total)}` : ""}
              {t.message ? ` · ${t.message}` : ""}
            </div>
          </div>
        );
      })}
    </div>

  );
}

