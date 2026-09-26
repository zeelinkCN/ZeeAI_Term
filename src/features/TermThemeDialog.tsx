import { useState } from "react";
import {
  CUSTOM_SCHEME_KEY,
  DEFAULT_PALETTE,
  TERM_SCHEMES,
  mergePalette,
  normalizeColor,
  type TermPalette,
} from "../termThemes";

interface Props {
  /** 当前生效的配色（已经算好，包含自定义解析结果） */
  palette: TermPalette;
  /** 当前选中的方案 key */
  schemeKey: string;
  /** 自定义方案的 JSON */
  customJson: string;
  /** 选择某套方案（立即生效） */
  onPick: (key: string, customJson?: string) => void;
  onClose: () => void;
  /** 出错信息（走底部状态栏） */
  onNotice: (text: string) => void;
  /** 作用范围（全局默认 / 本地三类 shell / 每台服务器 / 每个串口） */
  scopeOptions?: { key: string; label: string }[];
  scopeKey?: string;
  onScopeChange?: (key: string) => void;
  /** 该范围绑定的高亮规则集（只在非全局范围显示这一行） */
  setOptions?: { id: string; name: string }[];
  boundSetId?: string;
  onBindSet?: (id: string) => void;
  /** 关键字高亮的总开关与"编辑规则"入口（收进这个对话框，不再单独占一个一级按钮） */
  highlightEnabled?: boolean;
  onHighlightEnabled?: (v: boolean) => void;
  onOpenHighlightRules?: () => void;
}

/** 16 色预览条：一眼看出这套配色长什么样 */
function SwatchStrip({ palette }: { palette: TermPalette }) {
  const colors = [
    palette.black,
    palette.red,
    palette.green,
    palette.yellow,
    palette.blue,
    palette.magenta,
    palette.cyan,
    palette.white,
    palette.brightBlack,
    palette.brightRed,
    palette.brightGreen,
    palette.brightYellow,
    palette.brightBlue,
    palette.brightMagenta,
    palette.brightCyan,
    palette.brightWhite,
  ];
  return (
    <span className="tt-strip">
      {colors.map((c, i) => (
        <i key={i} style={{ background: c }} />
      ))}
    </span>
  );
}

/** 用真实 ANSI 转义序列渲染一小段示例，能直观看到"有颜色提示"的效果 */
function Preview({ palette }: { palette: TermPalette }) {
  const rows: { text: string; color: string }[] = [
    { text: "user@server", color: palette.brightGreen },
    { text: ":", color: palette.foreground },
    { text: "~/project", color: palette.brightBlue },
    { text: "$ ", color: palette.foreground },
    { text: "ls -l", color: palette.foreground },
  ];
  const out = [
    { text: "drwxr-xr-x  src/", color: palette.brightBlue },
    { text: "  -rw-r--r--  README.md", color: palette.foreground },
    { text: "  -rwxr-xr-x  run.sh", color: palette.brightGreen },
    { text: "  -rw-r--r--  config.toml", color: palette.brightYellow },
  ];
  return (
    <div className="tt-preview" style={{ background: palette.background }}>
      <div style={{ marginBottom: 6 }}>
        {rows.map((r, i) => (
          <span key={i} style={{ color: r.color }}>
            {r.text}
          </span>
        ))}
      </div>
      {out.map((r, i) => (
        <div key={i} style={{ color: r.color }}>
          {r.text}
        </div>
      ))}
      <div style={{ color: palette.brightRed, marginTop: 6 }}>
        error: something went wrong
      </div>
      <div style={{ color: palette.brightMagenta }}>warning: check the log</div>
      <div style={{ color: palette.brightCyan }}>info: all good</div>
      <div style={{ color: palette.cursor }}>
        <span style={{ background: palette.cursor, color: palette.background }}> </span>
      </div>
    </div>
  );
}

const COLOR_FIELDS: { key: keyof TermPalette; label: string }[] = [
  { key: "background", label: "背景" },
  { key: "foreground", label: "正文" },
  { key: "cursor", label: "光标" },
  { key: "selectionBackground", label: "选区内" },
  { key: "black", label: "黑" },
  { key: "red", label: "红" },
  { key: "green", label: "绿" },
  { key: "yellow", label: "黄" },
  { key: "blue", label: "蓝" },
  { key: "magenta", label: "洋红" },
  { key: "cyan", label: "青" },
  { key: "white", label: "白" },
  { key: "brightBlack", label: "亮黑" },
  { key: "brightRed", label: "亮红" },
  { key: "brightGreen", label: "亮绿" },
  { key: "brightYellow", label: "亮黄" },
  { key: "brightBlue", label: "亮蓝" },
  { key: "brightMagenta", label: "亮洋红" },
  { key: "brightCyan", label: "亮青" },
  { key: "brightWhite", label: "亮白" },
];

export default function TermThemeDialog({
  palette,
  schemeKey,
  customJson,
  onPick,
  onClose,
  onNotice,
  scopeOptions,
  scopeKey,
  onScopeChange,
  setOptions,
  boundSetId,
  onBindSet,
  highlightEnabled,
  onHighlightEnabled,
  onOpenHighlightRules,
}: Props) {
  // 自定义配色：从当前生效值起步（用户改到一半切走也不丢，因为每次都写进 settings）
  const [customDraft, setCustomDraft] = useState<TermPalette>(() =>
    mergePalette(palette, undefined),
  );
  const [importText, setImportText] = useState("");

  const isCustom = schemeKey === CUSTOM_SCHEME_KEY;

  function applyCustomDraft(next: TermPalette) {
    setCustomDraft(next);
    onPick(CUSTOM_SCHEME_KEY, JSON.stringify(next));
  }

  function setField(key: keyof TermPalette, value: string) {
    const next = { ...customDraft, [key]: normalizeColor(value, customDraft[key]) };
    applyCustomDraft(next);
  }

  function importFromJson() {
    const text = importText.trim();
    if (!text) {
      onNotice("请先把配色 JSON 粘进来");
      return;
    }
    try {
      const data = JSON.parse(text) as unknown;
      const merged = mergePalette(customDraft, data);
      applyCustomDraft(merged);
      onNotice("已应用这段配色（可继续微调颜色）");
    } catch (e) {
      onNotice("配色 JSON 解析失败：" + String(e));
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">终端配色</div>
        <div className="modal-body">
          {/* 先选"给谁配"：全局一套，或者按终端分开配（配色 + 高亮规则集一起） */}
          {scopeOptions && scopeOptions.length > 0 && (
            <div className="modal-inline-action" style={{ paddingBottom: 8 }}>
              <span className="hint" style={{ padding: "0 6px 0 0" }}>
                作用范围
              </span>
              <select value={scopeKey} onChange={(e) => onScopeChange?.(e.target.value)}>
                {scopeOptions.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.label}
                  </option>
                ))}
              </select>
              {onBindSet && (
                <>
                  <span className="hint" style={{ padding: "0 6px 0 12px" }}>
                    高亮规则
                  </span>
                  <select value={boundSetId ?? ""} onChange={(e) => onBindSet(e.target.value)}>
                    <option value="">跟随默认那套</option>
                    {(setOptions ?? []).map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </>
              )}
            </div>
          )}
          {/* 关键字高亮收在这里（原来在设置里单独占一个一级按钮，字又小、很难找） */}
          {onHighlightEnabled && (
            <div className="modal-inline-action" style={{ paddingBottom: 8 }}>
              <label className="form-check" style={{ padding: 0 }}>
                <input
                  type="checkbox"
                  checked={highlightEnabled ?? false}
                  onChange={(e) => onHighlightEnabled(e.target.checked)}
                />
                <span>关键字高亮</span>
              </label>
              <button
                type="button"
                className="mini-btn"
                style={{ marginLeft: 10 }}
                onClick={() => onOpenHighlightRules?.()}
              >
                编辑高亮规则…
              </button>
            </div>
          )}
          <Preview palette={isCustom ? customDraft : palette} />

          <div className="hint" style={{ marginTop: 8 }}>
            配色决定终端<strong>怎么渲染颜色</strong>（红/绿/黄/蓝这些）。如果远端 shell 本身没输出颜色码，
            提示符仍然是素色的 —— 那种情况要在服务器上开彩色（例如 <code>alias ls='ls --color=auto'</code>
            ，或把 <code>PS1</code> 加上颜色）。
          </div>

          <div className="tt-list">
            {TERM_SCHEMES.map((s) => (
              <button
                key={s.key}
                type="button"
                className={"tt-item" + (schemeKey === s.key ? " active" : "")}
                onClick={() => onPick(s.key)}
              >
                <span style={{ color: isLightPaletteFn(s.palette) ? "#111" : "#eee" }}>
                  <SwatchStrip palette={s.palette} />
                </span>
                <span className="tt-name">{s.name}</span>
                <span className="tt-kind">{s.kind === "light" ? "浅" : "深"}</span>
              </button>
            ))}
            <button
              type="button"
              className={"tt-item" + (isCustom ? " active" : "")}
              onClick={() => onPick(CUSTOM_SCHEME_KEY, customJson || JSON.stringify(customDraft))}
            >
              <span>
                <SwatchStrip palette={customDraft} />
              </span>
              <span className="tt-name">自定义（自己调颜色）</span>
              <span className="tt-kind">自定义</span>
            </button>
          </div>

          {isCustom && (
            <div className="tt-custom">
              <div className="tt-grid">
                {COLOR_FIELDS.map((f) => (
                  <label key={f.key} className="tt-field">
                    <input
                      type="color"
                      value={customDraft[f.key]}
                      onChange={(e) => setField(f.key, e.target.value)}
                    />
                    <span>{f.label}</span>
                    <code>{customDraft[f.key]}</code>
                  </label>
                ))}
              </div>

              <label className="modal-field">
                粘贴配色 JSON（支持 Windows Terminal 的 scheme 写法，字段名如
                background / foreground / red / brightBlue …）
                <textarea
                  rows={4}
                  value={importText}
                  placeholder='{"background":"#0c0c0c","foreground":"#cccccc","red":"#c50f1f"}'
                  onChange={(e) => setImportText(e.target.value)}
                />
              </label>
              <div className="modal-inline-action">
                <button type="button" className="mini-btn" onClick={importFromJson}>
                  应用这段配色
                </button>
                <button
                  type="button"
                  className="mini-btn"
                  onClick={() => {
                    setImportText("");
                    applyCustomDraft(DEFAULT_PALETTE);
                    onNotice("自定义配色已恢复成默认值");
                  }}
                >
                  恢复默认颜色
                </button>
              </div>
            </div>
          )}
        </div>
        <div className="modal-actions">
          <button type="button" className="btn primary" onClick={onClose}>
            完成
          </button>
        </div>
      </div>
    </div>
  );
}

/** 局部用到的小工具（避免为了一个判断把整个 termThemes 都 import 进来） */
function isLightPaletteFn(p: TermPalette): boolean {
  const hex = normalizeColor(p.background, "#000000").slice(1);
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 > 140;
}
