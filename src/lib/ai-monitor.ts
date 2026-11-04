import type { ProgramStatus } from "./program-status";

export type MonitorAgent = "claude" | "codex";
export type MonitorState = "working" | "blocked" | "done" | "error" | "idle" | "unknown";
export interface MonitorSession {
  id: string;
  connected: boolean;
  herdr: boolean;
}
export interface MonitorRecord {
  sessionId: string;
  id: string;
  agent: MonitorAgent;
  state: Exclude<MonitorState, "unknown">;
  source: "osc" | "herdr";
  kind?: ProgramStatus["kind"];
  message: string;
  progress?: number;
  atMs: number;
}
export interface MonitorView {
  sessionId: string;
  agent?: MonitorAgent;
  state: MonitorState;
  source?: "osc" | "herdr";
  kind?: ProgramStatus["kind"];
  message: string;
  progress?: number;
  atMs: number;
  connected: boolean;
  health?: string;
  unread: boolean;
  records: number;
}
export interface MonitorNotice {
  sessionId: string;
  kind: "blocked" | "done" | "error";
  agent: MonitorAgent;
}

interface SessionIdentity { id: string; profileId?: string; user?: string; herdrPane?: string; herdrMode?: string; state: string }
export function monitorSessionKey(session: SessionIdentity): string {
  return session.herdrPane ? JSON.stringify(["herdr", session.profileId ?? "", session.user ?? "", session.herdrPane]) : session.id;
}

/** Observe/control tabs for the same pane are one task; prefer its connected writable tab. */
export function uniqueMonitorSessions<T extends SessionIdentity>(sessions: T[]): T[] {
  const result = new Map<string, T>();
  const score = (s: T) => Number(s.state === "connected") * 2 + Number(s.herdrMode === "control");
  for (const session of sessions) {
    const key = monitorSessionKey(session);
    const old = result.get(key);
    if (!old || score(session) > score(old)) result.set(key, session);
  }
  return [...result.values()];
}

export function monitorAgent(app?: string): MonitorAgent | undefined {
  const name = (app ?? "").trim().toLowerCase();
  if (["claude", "claude-code", "claude_code", "claude code"].includes(name)) return "claude";
  if (["codex", "codex-cli", "codex_cli", "openai-codex", "openai codex"].includes(name)) return "codex";
  return undefined;
}

const priority: Record<MonitorState, number> = { blocked: 6, error: 5, working: 4, done: 3, idle: 2, unknown: 0 };

/** Session-scoped state. Terminal output, silence and transport exit never imply completion. */
export class AiMonitorStore {
  private sessions = new Map<string, MonitorSession>();
  private records = new Map<string, Map<string, MonitorRecord>>();
  private health = new Map<string, string>();
  private unread = new Set<string>();

  sync(sessions: MonitorSession[]) {
    const next = new Map(sessions.map((s) => [s.id, s]));
    for (const id of this.sessions.keys()) {
      if (!next.has(id)) {
        this.records.delete(id);
        this.health.delete(id);
        this.unread.delete(id);
      }
    }
    for (const s of sessions) {
      const old = this.sessions.get(s.id);
      if (old && !old.connected && s.connected) {
        // A new connection must establish its own baseline; never replay old alerts.
        this.records.delete(s.id);
        this.health.delete(s.id);
        this.unread.delete(s.id);
      }
    }
    this.sessions = next;
  }

  clear() {
    this.records.clear();
    this.health.clear();
    this.unread.clear();
  }

  acknowledge() { this.unread.clear(); }

  private pick(sessionId: string): MonitorRecord | undefined {
    const all = [...(this.records.get(sessionId)?.values() ?? [])];
    const native = all.filter((r) => r.source === "osc");
    return (native.length ? native : all).sort((a, b) => priority[b.state] - priority[a.state] || b.atMs - a.atMs)[0];
  }

  private transition(before: MonitorRecord | undefined, after: MonitorRecord | undefined, allowDone: boolean): MonitorNotice[] {
    if (!after) return [];
    const changed = before?.state !== after.state || before.agent !== after.agent;
    if (after.state === "blocked" && (changed || before?.kind !== after.kind)) {
      return [{ sessionId: after.sessionId, kind: "blocked", agent: after.agent }];
    }
    if (after.state === "error" && changed) {
      return [{ sessionId: after.sessionId, kind: "error", agent: after.agent }];
    }
    if (allowDone && after.state === "done" && before && ["working", "blocked"].includes(before.state) && changed) {
      this.unread.add(after.sessionId);
      return [{ sessionId: after.sessionId, kind: "done", agent: after.agent }];
    }
    return [];
  }

  report(sessionId: string, report: ProgramStatus, atMs: number): MonitorNotice[] {
    const session = this.sessions.get(sessionId);
    if (!session?.connected || session.herdr) return [];
    const rows = this.records.get(sessionId) ?? new Map<string, MonitorRecord>();
    const before = this.pick(sessionId);
    const id = report.id ?? "";
    if (report.state === "clear") {
      for (const key of rows.keys()) if (!id || key === id || key.startsWith(id + "/")) rows.delete(key);
      this.records.set(sessionId, rows);
      if (this.pick(sessionId)?.state !== "done") this.unread.delete(sessionId);
      return [];
    }
    let agent = monitorAgent(report.app);
    if (!report.app) {
      // Children may omit app; only inherit from an explicitly identified ancestor.
      let ancestor = id;
      while (!agent) {
        agent = rows.get(ancestor)?.agent;
        if (!ancestor) break;
        ancestor = ancestor.includes("/") ? ancestor.slice(0, ancestor.lastIndexOf("/")) : "";
      }
    }
    if (!agent) {
      // Another foreground program replaces the record, rather than inheriting an AI label.
      for (const key of rows.keys()) if (key === id || (!id || key.startsWith(id + "/"))) rows.delete(key);
      this.records.set(sessionId, rows);
      if (this.pick(sessionId)?.state !== "done") this.unread.delete(sessionId);
      return [];
    }
    if (report.state === "working") {
      this.unread.delete(sessionId);
      if (["done", "error", "idle"].includes(rows.get(id)?.state ?? "")) {
        for (const key of rows.keys()) if (key !== id && (!id || key.startsWith(id + "/"))) rows.delete(key);
      }
    }
    // A terminal cannot create an unbounded number of retained task IDs.
    if (!rows.has(id) && rows.size >= 128) return [];
    rows.set(id, { sessionId, id, agent, state: report.state, source: "osc", kind: report.kind,
      message: report.message ?? "", progress: report.progress, atMs });
    this.records.set(sessionId, rows);
    this.health.delete(sessionId);
    return this.transition(before, this.pick(sessionId), report.state === "done");
  }

  prompt(sessionId: string) {
    const rows = this.records.get(sessionId);
    if (!rows) return;
    // Shell prompt/terminal reset ends live program status, but is not a finished event.
    for (const [id, row] of rows) if (!["done", "error"].includes(row.state)) rows.delete(id);
  }

  herdr(sessionId: string, agentName: string | undefined, status: string | undefined, atMs: number, error?: string | null): MonitorNotice[] {
    const session = this.sessions.get(sessionId);
    if (!session?.connected || !session.herdr) return [];
    if (error) {
      this.health.set(sessionId, error);
      return [];
    }
    const before = this.pick(sessionId);
    const agent = monitorAgent(agentName);
    const states: Record<string, MonitorRecord["state"]> = { working: "working", blocked: "blocked", done: "done", idle: "idle", error: "error" };
    const state = states[status ?? ""];
    this.health.delete(sessionId);
    if (!agent || !state) {
      this.records.delete(sessionId);
      this.unread.delete(sessionId);
      return [];
    }
    if (state === "working") this.unread.delete(sessionId);
    this.records.set(sessionId, new Map([["", { sessionId, id: "", agent, state, source: "herdr", message: "", atMs }]]));
    return this.transition(before, this.pick(sessionId), true);
  }

  views(): MonitorView[] {
    return [...this.sessions.values()].map((session) => {
      const record = this.pick(session.id);
      const health = this.health.get(session.id);
      return { sessionId: session.id, agent: record?.agent,
        state: !session.connected || health ? "unknown" : record?.state ?? "unknown",
        source: record?.source, kind: record?.kind, message: record?.message ?? "",
        progress: record?.progress, atMs: record?.atMs ?? 0, connected: session.connected,
        health: !session.connected ? "连接已断开，状态待确认" : health,
        unread: this.unread.has(session.id), records: this.records.get(session.id)?.size ?? 0 };
    });
  }
}
