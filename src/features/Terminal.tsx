import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { sessionResize, sessionWrite } from "../ipc";
import { bytesToB64 } from "../util";
import type { SessionBus } from "../sessionBus";

interface Props {
  sessionId: string;
  bus: SessionBus;
  active: boolean;
}

const THEME = {
  background: "#181818",
  foreground: "#d4d4d4",
  cursor: "#d4d4d4",
  selectionBackground: "#264f78",
  black: "#000000",
  red: "#cd3131",
  green: "#0dbc79",
  yellow: "#e5e510",
  blue: "#2472c8",
  magenta: "#bc3fbc",
  cyan: "#11a8cd",
  white: "#e5e5e5",
  brightBlack: "#666666",
  brightRed: "#f14c4c",
  brightGreen: "#23d18b",
  brightYellow: "#f5f543",
  brightBlue: "#3b8eea",
  brightMagenta: "#d670d6",
  brightCyan: "#29b8db",
  brightWhite: "#e5e5e5",
};

export default function TerminalView({ sessionId, bus, active }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termRef = useRef<Terminal | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      fontFamily: '"Cascadia Mono", "Consolas", "Courier New", monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 10000,
      allowProposedApi: true,
      theme: THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    try {
      term.loadAddon(new WebglAddon());
    } catch {
      // WebGL 不可用时自动回退到 canvas/dom 渲染
    }
    termRef.current = term;
    fitRef.current = fit;

    const doFit = () => {
      try {
        fit.fit();
      } catch {
        /* 容器尺寸为 0 时忽略 */
      }
      void sessionResize(sessionId, term.cols, term.rows);
    };
    doFit();

    bus.attach(sessionId, (bytes) => term.write(bytes));
    const sub = term.onData((data) => {
      void sessionWrite(sessionId, bytesToB64(new TextEncoder().encode(data)));
    });

    const ro = new ResizeObserver(() => doFit());
    ro.observe(host);

    return () => {
      ro.disconnect();
      sub.dispose();
      bus.detach(sessionId);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [sessionId, bus]);

  useEffect(() => {
    if (active && termRef.current) {
      try {
        fitRef.current?.fit();
      } catch {
        /* ignore */
      }
      termRef.current.focus();
    }
  }, [active]);

  return <div className="terminal-host" ref={hostRef} />;
}
