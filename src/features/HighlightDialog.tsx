import { useEffect, useRef, useState } from "react";
import { highlightPresets } from "../ipc";
import { uid } from "../util";
import type { HighlightRule, HighlightRuleSet } from "../types";

interface Props {
  /** 全部规则集（每套有名字，服务器/串口/本地终端各自绑定一套） */
  sets: HighlightRuleSet[];
  enabled: boolean;
  onEnabledChange: (v: boolean) => void;
  onChange: (sets: HighlightRuleSet[]) => void;
  onClose: () => void;
  /** 提示只走底部状态栏（不弹浮层） */
  onNotice: (text: string) => void;
}

/** 关键词输入框里的文本 ↔ 关键词数组（逗号/顿号/空格/换行都能分隔） */
function parseKeywords(text: string): string[] {
  return text
    .split(/[,，、\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function keywordsToText(list: string[]): string {
  return (list ?? []).join(", ");
}

/** 规则卡片里的一行颜色设置：前景色 / 背景色（空 = 不改这一项） */
function ColorRow({
  label,
  value,
  fallback,
  onChange,
}: {
  label: string;
  value: string;
  fallback: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="hl-color">
      <span className="hl-color-label">{label}</span>
      {value ? (
        <>
          <input
            type="color"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            title="点这里改颜色"
          />
          <code>{value}</code>
          <button
            type="button"
            className="mini-x"
            style={{ opacity: 1 }}
            title="不改这一项（跟随终端原本的颜色）"
            onClick={() => onChange("")}
          >
            ✕
          </button>
        </>
      ) : (
        <button
          type="button"
          className="mini-btn"
          onClick={() => onChange(fallback)}
          title="不改这一项（跟随终端原本的颜色）"
        >
          不设置
        </button>
      )}
    </div>
  );
}

/**
 * 终端关键字高亮设置。
 *
 * 一个要点：改规则**只对之后新到达的输出生效**（v1 不做历史重着色，那需要
 * xterm 的 decoration，留到 v2）。所以这里改了颜色是看不到"历史变色的"，
 * 得让终端再吐几行才看得出来 —— 对话框里给了实时预览，不用去终端里试。
 */
export default function HighlightDialog({
  sets,
  enabled,
  onEnabledChange,
  onChange,
  onClose,
  onNotice,
}: Props) {
  const [draft, setDraft] = useState<HighlightRuleSet[]>(sets ?? []);
  const [activeId, setActiveId] = useState<string>((sets ?? [])[0]?.id ?? "default");

  // 每次改动都写盘太勤（连着拖颜色选择器会写爆），这里攒 300ms 再落一次
  const timer = useRef<number | null>(null);
  const pending = useRef<HighlightRuleSet[] | null>(null);
  const commitRef = useRef(onChange);
  commitRef.current = onChange;

  function flush() {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    if (pending.current) {
      const next = pending.current;
      pending.current = null;
      commitRef.current(next);
    }
  }

  function update(next: HighlightRuleSet[]) {
    setDraft(next);
    pending.current = next;
    if (timer.current === null) {
      timer.current = window.setTimeout(() => {
        timer.current = null;
        flush();
      }, 300);
    }
  }

  // 关掉对话框（或组件卸载）时把还没落盘的那次改动补上
  useEffect(() => () => flush(), []);

  const activeSet = draft.find((s) => s.id === activeId) ?? draft[0];
  const rules: HighlightRule[] = activeSet?.rules ?? [];

  /** 改"当前这套规则集"里的规则 */
  function updateRules(next: HighlightRule[]) {
    if (!activeSet) return;
    update(draft.map((s) => (s.id === activeSet.id ? { ...s, rules: next } : s)));
  }

  function patch(id: string, part: Partial<HighlightRule>) {
    updateRules(rules.map((r) => (r.id === id ? { ...r, ...part } : r)));
  }

  function remove(id: string) {
    updateRules(rules.filter((r) => r.id !== id));
  }

  function addRule() {
    updateRules([
      ...rules,
      {
        id: uid(),
        name: "新规则",
        keywords: [],
        caseSensitive: false,
        fg: "#ffcc66",
        bg: "",
        wholeLine: false,
        enabled: true,
      },
    ]);
  }

  /** 新建 / 复制 / 删除规则集 */
  function addSet(copyCurrent: boolean) {
    const id = uid();
    update([
      ...draft,
      {
        id,
        name: copyCurrent && activeSet ? `${activeSet.name} 副本` : "新规则集",
        rules: copyCurrent && activeSet ? activeSet.rules.map((r) => ({ ...r, id: uid() })) : [],
      },
    ]);
    setActiveId(id);
  }

  function removeSet() {
    if (draft.length <= 1) {
      onNotice("至少要留一套规则集");
      return;
    }
    const rest = draft.filter((s) => s.id !== activeSet?.id);
    update(rest);
    setActiveId(rest[0].id);
  }

  function renameSet(name: string) {
    if (!activeSet) return;
    update(draft.map((s) => (s.id === activeSet.id ? { ...s, name } : s)));
  }

  async function loadPresets() {
    try {
      const presets = await highlightPresets();
      // 同名（同 id）的预设直接覆盖，用户自己加的规则保留
      const byId = new Map(rules.map((r) => [r.id, r]));
      for (const p of presets) byId.set(p.id, p);
      updateRules([...byId.values()]);
      onNotice(`已载入 ${presets.length} 套预设规则`);
    } catch (e) {
      onNotice("载入预设失败：" + String(e));
    }
  }

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">终端关键字高亮</div>
        <div className="modal-body">
          <label className="form-check">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => onEnabledChange(e.target.checked)}
            />
            <span>
              打开关键字高亮（SSH / 串口 / 本地终端共用同一份规则）
            </span>
          </label>

          <div className="hint" style={{ padding: "6px 0 10px" }}>
            高亮只在**界面**上生效：日志文件仍然是原来的纯文本（落盘前就剥掉了颜色码）。
            <br />
            改规则**只影响之后新到达的输出**，历史输出不会重新上色（留到 v2 用 decoration 做）。
            不支持正则语法（写 <code>.*</code> 会把渲染拖死，v2 再加且会限量限长）。
          </div>

          <div className="modal-inline-action" style={{ paddingBottom: 10 }}>
            {/* 规则集：服务器 / 串口 / 本地终端可以各绑一套 */}
            <select
              value={activeSet?.id ?? ""}
              onChange={(e) => setActiveId(e.target.value)}
              title="选择要编辑的规则集"
            >
              {draft.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name || "(未命名)"}（{s.rules.length} 条）
                </option>
              ))}
            </select>
            <input
              style={{ width: 130, marginLeft: 6 }}
              value={activeSet?.name ?? ""}
              onChange={(e) => renameSet(e.target.value)}
              placeholder="规则集名字"
              title="给这套规则改个名字（比如「生产机」「串口调试」）"
            />
            <button type="button" className="mini-btn" style={{ marginLeft: 6 }} onClick={() => addSet(false)}>
              ＋ 新建
            </button>
            <button type="button" className="mini-btn" style={{ marginLeft: 6 }} onClick={() => addSet(true)}>
              复制
            </button>
            <button type="button" className="mini-btn" style={{ marginLeft: 6 }} onClick={removeSet}>
              删除
            </button>
          </div>

          <div className="modal-inline-action" style={{ paddingBottom: 10 }}>
            <button type="button" className="mini-btn" onClick={() => void loadPresets()}>
              载入预设规则
            </button>
            <button
              type="button"
              className="mini-btn"
              style={{ marginLeft: 6 }}
              onClick={addRule}
            >
              ＋ 新增规则
            </button>
          </div>

          <div className="hl-list">
            {rules.map((r) => (
              <div className={"hl-rule" + (r.enabled ? "" : " off")} key={r.id}>
                <div className="hl-rule-head">
                  <input
                    type="checkbox"
                    checked={r.enabled}
                    onChange={(e) => patch(r.id, { enabled: e.target.checked })}
                    title="这条规则是否生效"
                  />
                  <input
                    className="hl-name"
                    value={r.name}
                    onChange={(e) => patch(r.id, { name: e.target.value })}
                    placeholder="规则名（只是标签）"
                  />
                  <span className="hl-sample">
                    {r.keywords.length > 0 ? (
                      <span style={{ color: r.fg || undefined, background: r.bg || undefined }}>
                        {r.keywords[0]}
                      </span>
                    ) : (
                      <span className="dim">（还没填关键词）</span>
                    )}
                  </span>
                  <button
                    type="button"
                    className="mini-x"
                    style={{ opacity: 1 }}
                    title="删掉这条规则"
                    onClick={() => remove(r.id)}
                  >
                    ✕
                  </button>
                </div>

                <label className="hl-field">
                  关键词（逗号或空格分隔）
                  <input
                    value={keywordsToText(r.keywords)}
                    placeholder="例如：ERROR, FAIL, Exception"
                    onChange={(e) => patch(r.id, { keywords: parseKeywords(e.target.value) })}
                  />
                </label>

                <div className="hl-opts">
                  <label className="form-check">
                    <input
                      type="checkbox"
                      checked={r.caseSensitive}
                      onChange={(e) => patch(r.id, { caseSensitive: e.target.checked })}
                    />
                    <span>区分大小写</span>
                  </label>
                  <label className="form-check">
                    <input
                      type="checkbox"
                      checked={r.wholeLine}
                      onChange={(e) => patch(r.id, { wholeLine: e.target.checked })}
                    />
                    <span>
                      整行高亮
                      <span className="dim">
                        （整行要等这一行结束才知道，会略微延迟回显；默认只给关键词上色）
                      </span>
                    </span>
                  </label>
                </div>

                <div className="hl-colors">
                  <ColorRow
                    label="前景"
                    value={r.fg}
                    fallback="#ff6b68"
                    onChange={(v) => patch(r.id, { fg: v })}
                  />
                  <ColorRow
                    label="背景"
                    value={r.bg}
                    fallback="#7a1c1c"
                    onChange={(v) => patch(r.id, { bg: v })}
                  />
                </div>
              </div>
            ))}
            {rules.length === 0 && (
              <div className="hint" style={{ padding: "8px 2px" }}>
                还没有规则。点「载入预设规则」拿一份 ERROR / WARN / OK / panic 的开箱配置，
                或者自己「新增规则」。
              </div>
            )}
          </div>
        </div>
        <div className="modal-actions">
          <button type="button" className="btn primary" onClick={close}>
            完成
          </button>
        </div>
      </div>
    </div>
  );

  function close() {
    flush();
    onClose();
  }
}
