import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { sessionWrite } from "../ipc";
import { bytesToB64 } from "../util";
import type { SessionBus } from "../sessionBus";
import type { AppSettings, HerdrAgent, SessionState } from "../types";
import type { OpenSession } from "./ui-model";
import { AiMonitorStore, monitorSessionKey, uniqueMonitorSessions, type MonitorNotice, type MonitorView } from "./ai-monitor";
import { ProgramStatusParser } from "./program-status";

interface Options {
  bus: SessionBus;
  sessions: OpenSession[];
  enabled: boolean;
  panelOpen: boolean;
  settings: AppSettings;
  onNotice: (notice: MonitorNotice) => void;
}
interface HerdrSnapshot {
  sessionIds: string[];
  atMs: number;
  agents: HerdrAgent[];
  error: string | null;
}

/** Native PTY events + backend scoped herdr events. No frontend polling or process scans. */
export function useAiMonitor(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const store = useRef(new AiMonitorStore());
  const parsers = useRef(new Map<string, ProgramStatusParser>());
  const replies = useRef(new Map<string, { at: number; count: number }>());
  // Channel events can arrive in one batch, before React commits connected.
  // Keep that wire state until the rendered sessions have caught up.
  const wireStates = useRef(new Map<string, SessionState>());
  const [views, setViews] = useState<MonitorView[]>([]);
  const [transportError, setTransportError] = useState("");
  const [scopeRevision, setScopeRevision] = useState(0);
  const scopeQueue = useRef(Promise.resolve());
  const scopeKey = JSON.stringify(options.sessions.filter((s) => s.kind === "remote")
    .map((s) => [s.id, s.state, s.herdrPane ?? "", s.profileId, s.user, s.herdrMode]));

  function remoteSessions() {
    return latest.current.sessions.filter((s) => s.kind === "remote")
      .map((s) => ({ ...s, state: wireStates.current.get(s.id) ?? s.state }));
  }

  function syncStore() {
    store.current.sync(uniqueMonitorSessions(latest.current.enabled ? remoteSessions() : [])
      .map((s) => ({ id: monitorSessionKey(s), connected: s.state === "connected", herdr: !!s.herdrPane })));
  }

  function currentViews() {
    const sessions = uniqueMonitorSessions(remoteSessions());
    return store.current.views().flatMap((view) => {
      const session = sessions.find((s) => monitorSessionKey(s) === view.sessionId);
      return session ? [{ ...view, sessionId: session.id }] : [];
    });
  }

  function publish(notices: MonitorNotice[] = []) {
    if (latest.current.panelOpen) store.current.acknowledge();
    setViews(currentViews());
    for (const notice of notices) {
      const settings = latest.current.settings;
      const target = uniqueMonitorSessions(remoteSessions())
        .find((s) => monitorSessionKey(s) === notice.sessionId);
      if (!target) continue;
      if ((notice.kind === "done" && settings.aiNotifyComplete) ||
        (notice.kind !== "done" && settings.aiNotifyNeedsYou)) latest.current.onNotice({ ...notice, sessionId: target.id });
    }
  }

  useEffect(() => {
    for (const [id, state] of wireStates.current) {
      const session = latest.current.sessions.find((s) => s.id === id);
      if (!session || session.state === state) wireStates.current.delete(id);
    }
    const remote = remoteSessions();
    const scoped = latest.current.enabled ? remote : [];
    syncStore();
    if (!latest.current.enabled) store.current.clear();
    for (const id of parsers.current.keys()) {
      if (!scoped.some((s) => s.id === id && s.state === "connected")) {
        parsers.current.delete(id);
        replies.current.delete(id);
      }
    }
    publish();
    const enabled = latest.current.enabled;
    const sessionIds = scoped.filter((s) => s.herdrPane && s.state === "connected").map((s) => s.id);
    // Keep scope mutations ordered even when IPC replies arrive out of order.
    scopeQueue.current = scopeQueue.current.catch(() => {}).then(async () => {
      try {
        await invoke("ai_monitor_sessions_set", { sessionIds, enabled });
        setTransportError("");
      } catch {
        if (enabled && sessionIds.length) setTransportError("herdr 状态通道暂不可用；终端连接不受影响");
      }
    });
  }, [scopeKey, options.enabled, scopeRevision]);

  useEffect(() => options.bus.observeOutput((sessionId, bytes) => {
    const current = latest.current;
    const session = remoteSessions().find((s) => s.id === sessionId);
    // herdr owns its terminal capability negotiation; read-only observation never writes to it.
    if (!session || session.herdrPane || !["connecting", "connected"].includes(session.state)) return;
    let parser = parsers.current.get(sessionId);
    if (!parser) { parser = new ProgramStatusParser(); parsers.current.set(sessionId, parser); }
    const notices: MonitorNotice[] = [];
    let changed = false;
    for (const event of parser.push(bytes)) {
      if (event.type === "query") {
        const now = Date.now();
        const previous = replies.current.get(sessionId);
        const budget = previous && now - previous.at < 1000 ? previous : { at: now, count: 0 };
        if (budget.count++ < 8) {
          void sessionWrite(sessionId, bytesToB64(new TextEncoder().encode(event.reply))).catch(() => {});
        }
        replies.current.set(sessionId, budget);
      } else if (!current.enabled) {
        continue;
      } else if (event.type === "prompt") {
        store.current.prompt(sessionId);
        changed = true;
      } else {
        notices.push(...store.current.report(sessionId, event.report, Date.now()));
        changed = true;
      }
    }
    if (changed) publish(notices);
  }), [options.bus]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<HerdrSnapshot>("zeeai://ai-monitor-herdr", (event) => {
      const current = latest.current;
      if (!current.enabled) return;
      const snap = event.payload;
      const notices: MonitorNotice[] = [];
      for (const id of snap.sessionIds) {
        const session = remoteSessions().find((s) => s.id === id && !!s.herdrPane && s.state === "connected");
        if (!session) continue;
        const agent = snap.agents.find((a) => a.paneId === session.herdrPane);
        notices.push(...store.current.herdr(monitorSessionKey(session), agent?.kind, agent?.status, snap.atMs, snap.error));
      }
      publish(notices);
    }).then((stop) => { if (disposed) stop(); else unlisten = stop; }).catch(() => {
      setTransportError("状态事件通道暂不可用；请重新打开应用");
    });
    return () => { disposed = true; unlisten?.(); };
  }, []);

  useEffect(() => {
    if (options.panelOpen) { store.current.acknowledge(); setViews(currentViews()); }
  }, [options.panelOpen]);

  useEffect(() => () => {
    void scopeQueue.current.catch(() => {}).then(() => invoke("ai_monitor_sessions_set", { sessionIds: [], enabled: false })).catch(() => {});
  }, []);

  const needs = views.filter((v) => v.state === "blocked" || v.state === "error");
  return { views, needs, transportError,
    connectionChanged: (sessionId?: string, state?: SessionState) => {
      if (sessionId && state) {
        wireStates.current.set(sessionId, state);
        syncStore();
        if (state !== "connected" && state !== "connecting") {
          parsers.current.delete(sessionId);
          replies.current.delete(sessionId);
        }
        publish();
      }
      setScopeRevision((v) => v + 1);
    },
    badgeCount: (options.settings.aiNotifyNeedsYouBadge ? needs.length : 0) +
      (options.settings.aiNotifyFinishedBadge ? views.filter((v) => v.unread).length : 0) };
}
