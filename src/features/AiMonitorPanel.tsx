import { useState } from "react";
import type { AppSettings, ConnectionProfile } from "../types";
import type { OpenSession } from "../lib/ui-model";
import type { MonitorView } from "../lib/ai-monitor";

interface Props {
  views: MonitorView[];
  sessions: OpenSession[];
  profiles: ConnectionProfile[];
  settings: AppSettings;
  transportError: string;
  onClose: () => void;
  onSelect: (id: string) => void;
  onSettings: (patch: Partial<AppSettings>) => Promise<void>;
}

export function monitorStateText(view: MonitorView): string {
  if (view.state === "blocked") return view.kind ? ({ permission: "等待批准", question: "等待回答", auth: "等待登录" } as const)[view.kind] : "等待你处理";
  return ({ working: "正在运行", done: "本轮已完成", error: "运行出错", idle: "等待新任务", unknown: "状态待确认" } as const)[view.state];
}

export function AiMonitorPanel({ views, sessions, profiles, settings, transportError, onClose, onSelect, onSettings }: Props) {
  const [optionsOpen, setOptionsOpen] = useState(false);
  const needs = views.filter((v) => ["blocked", "error"].includes(v.state));
  const working = views.filter((v) => v.state === "working");
  const recent = views.filter((v) => v.state === "done").sort((a, b) => b.atMs - a.atMs);
  const other = views.filter((v) => ["idle", "unknown"].includes(v.state));
  const card = (view: MonitorView) => {
    const session = sessions.find((s) => s.id === view.sessionId);
    if (!session) return null;
    const server = profiles.find((p) => p.id === session.profileId)?.name ?? session.title;
    const source = view.source === "osc" ? "CLI 实时上报" : view.source === "herdr" ? "herdr 状态" : session.herdrPane ? "等待 herdr 状态" : "等待 CLI 状态";
    const elapsed = view.atMs ? new Date(view.atMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
    const health = ["connecting", "reconnecting"].includes(session.state) ? "正在连接，等待状态…" : view.health;
    return <article key={view.sessionId} className={`ai-monitor-card ${view.state}`} data-session-id={view.sessionId}>
      <div className="ai-monitor-card-head">
        <strong>{view.agent === "claude" ? "Claude Code" : view.agent === "codex" ? "Codex" : "AI 会话"}</strong>
        <span className="ai-monitor-state">{monitorStateText(view)}</span>
      </div>
      <div className="ai-monitor-location" title={`${server}\n${session.title}\n${session.cwd ?? ""}`}>
        <span>{server}</span><span>{session.title}</span>
        {session.cwd && <span>{session.cwd}</span>}
      </div>
      {health ? <p className="ai-monitor-health">{health}</p> : view.message ? <p className="ai-monitor-message">{view.message}</p> : null}
      {view.state === "unknown" && !health && <p className="ai-monitor-message">
        {session.herdrPane ? "仅观察已在 ZeeAI 打开的窗格，每分钟更新。" : session.tmuxName || session.tmuxMode !== "none"
          ? "尚未收到状态。tmux 的协议支持取决于版本；需要更完整的观察时，可用 herdr 打开会话。"
          : "在此终端运行支持状态上报的 Claude Code 或 Codex，状态会自动出现。"}
      </p>}
      {view.progress !== undefined && ["working", "blocked"].includes(view.state) && <div className="ai-monitor-progress">
        <progress value={view.progress} max={100} aria-label="CLI 上报的进度" /><span>{view.progress}%</span>
      </div>}
      <div className="ai-monitor-meta"><span title={view.source === "herdr" ? "由 herdr 识别状态，准确性取决于服务端版本和适配；不读取对话正文。" : "程序通过终端状态协议主动报告；不根据输出多少或安静时间猜测。"}>{source}</span>
        <span>{elapsed && `${elapsed} 更新`}</span>
      </div>
      <div className="ai-monitor-actions">
        <button type="button" className="mini-btn" onClick={() => onSelect(session.id)}>切到终端</button>
        {session.herdrMode === "observe" && <span className="dim">只读观察</span>}
      </div>
    </article>;
  };
  return <aside className="ai-panel ai-monitor" aria-label="AI 状态监控">
    <div className="ai-head"><strong className="grow">AI 状态</strong>
      <button type="button" className="mini-btn" aria-expanded={optionsOpen} onClick={() => setOptionsOpen(!optionsOpen)}>设置</button>
      <button type="button" className="mini-x" title="收起 AI 面板（继续观察）" onClick={onClose}>✕</button>
    </div>
    <div className="ai-monitor-summary">{!settings.aiMonitorEnabled ? "观察已暂停" : needs.length ? `${needs.length} 个会话需要你` : working.length ? `${working.length} 个会话运行中` : "只观察 ZeeAI 内的远端会话"}</div>
    {optionsOpen && <div className="ai-monitor-options">
      <label><input type="checkbox" checked={settings.aiMonitorEnabled} onChange={(e) => void onSettings({ aiMonitorEnabled: e.target.checked })} />启用 AI 状态观察</label>
      <label><input type="checkbox" checked={settings.aiNotifyNeedsYou} onChange={(e) => void onSettings({ aiNotifyNeedsYou: e.target.checked })} />等待处理或出错时提醒</label>
      <label><input type="checkbox" checked={settings.aiNotifyComplete} onChange={(e) => void onSettings({ aiNotifyComplete: e.target.checked })} />每轮完成时提醒</label>
      <label><input type="checkbox" checked={settings.aiNotifyTaskbar} onChange={(e) => void onSettings({ aiNotifyTaskbar: e.target.checked })} />离开窗口时提醒我回来</label>
      <p>收起面板会继续观察。关闭会话或退出 ZeeAI 后停止观察；远端任务是否继续由会话环境决定。</p>
    </div>}
    {transportError && <p className="ai-monitor-health" role="status">{transportError}</p>}
    <div className="ai-monitor-body">
      {!settings.aiMonitorEnabled ? <div className="ai-monitor-empty"><strong>需要时再打开</strong><p>启用后，只为当前 ZeeAI 会话接收状态。</p><button type="button" className="btn" onClick={() => void onSettings({ aiMonitorEnabled: true })}>启用观察</button></div> : <>
        {needs.length > 0 && <section aria-label="需要你"><h3>需要你 <span>{needs.length}</span></h3>{needs.map(card)}</section>}
        {working.length > 0 && <section aria-label="运行中"><h3>运行中 <span>{working.length}</span></h3>{working.map(card)}</section>}
        {!needs.length && !working.length && !recent.length && <div className="ai-monitor-empty"><strong>{views.length ? "等待 AI 状态" : "从一个远端会话开始"}</strong><p>{views.length ? "支持协议的 CLI 会自动报告；herdr 会提供已打开窗格的状态。" : "打开服务器终端，再运行 Claude Code 或 Codex。使用 herdr 时也可打开已有窗格。"}</p></div>}
        {recent.length > 0 && <details className="ai-monitor-fold"><summary>最近完成 <span>{recent.length}</span></summary>{recent.map(card)}</details>}
        {other.length > 0 && <details className="ai-monitor-fold"><summary>空闲与待确认 <span>{other.length}</span></summary>{other.map(card)}</details>}
        <div className="ai-monitor-footnote">状态来自 CLI 或 herdr。完成代表本轮结束；批准、回答和登录均在原终端处理。</div>
        <details className="ai-monitor-fold"><summary>如何接收状态</summary><div className="ai-monitor-footnote">普通 SSH 终端支持 OSC 7501，建议使用 Claude Code 2.1.295 或更新版本、Codex CLI 0.163.0 或更新版本。tmux 可能阻挡协议，单改 passthrough 不保证生效；可使用 herdr 窗格获得其状态识别。没有收到状态不代表 AI 没有运行。</div></details>
      </>}
    </div>
  </aside>;
}
