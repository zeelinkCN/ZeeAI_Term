// 命令面板（Ctrl+P 那种）：输入过滤 + 回车执行。
//
// 命令表本身在 App（allCommands 里有大量动作），这里只负责"列出来 + 过滤 + 选中"。


export interface CommandPaletteProps {
  setPaletteOpen: (v: boolean) => void;
  /** 输入框的过滤词（App 里用它算 paletteItems，所以状态留在 App） */
  paletteQuery: string;
  setPaletteQuery: (v: string) => void;
  paletteItems: { label: string; group: string; run: () => void }[];
}

export function CommandPalette(props: CommandPaletteProps) {
  const {
  setPaletteOpen, paletteQuery, setPaletteQuery, paletteItems,
  } = props;
  return (
    <div className="modal-backdrop palette-backdrop" onClick={() => setPaletteOpen(false)}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <input
          autoFocus
          className="palette-input"
          placeholder="输入命令名，回车执行（Esc 关闭）"
          value={paletteQuery}
          onChange={(e) => setPaletteQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setPaletteOpen(false);
            if (e.key === "Enter") {
              const first = paletteItems[0];
              if (first) {
                setPaletteOpen(false);
                first.run();
              }
            }
          }}
        />
        <div className="palette-list">
          {paletteItems.length === 0 && (
            <div className="hint" style={{ padding: "8px 12px" }}>
              没有匹配的命令。
            </div>
          )}
          {paletteItems.slice(0, 40).map((c, i) => (
            <button
              key={c.group + c.label}
              type="button"
              className={"palette-item" + (i === 0 ? " first" : "")}
              onClick={() => {
                setPaletteOpen(false);
                c.run();
              }}
            >
              <span className="grow ellipsis">{c.label}</span>
              <span className="dim">{c.group}</span>
            </button>
          ))}
        </div>
      </div>
    </div>

  );
}

