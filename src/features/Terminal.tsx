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

// 小于这个尺寸的 resize 一律不发：界面首次布局时容器可能是 0 尺寸，
// 一旦把 12x4 这种尺寸发给 tmux，窗口会被压变形（表现为满屏花点）。
const MIN_COLS = 20;
const MIN_ROWS = 5;

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
      const webgl = new WebglAddon();
      // WebGL 上下文丢失时退回 canvas 渲染，避免出现花屏
      webgl.onContextLoss(() => {
        try {
          webgl.dispose();
        } catch {
          /* ignore */
        }
      });
      term.loadAddon(webgl);
    } catch {
      /* WebGL 不可用时自动回退到 canvas/dom 渲染 */
    }

    termRef.current = term;
    fitRef.current = fit;

    let disposed = false;
    const doFit = () => {
      if (disposed) return;
      try {
        fit.fit();
      } catch {
        return;
      }
      if (term.cols >= MIN_COLS && term.rows >= MIN_ROWS) {
        void sessionResize(sessionId, term.cols, term.rows);
      }
    };
    doFit();

    // 首次布局可能晚于挂载，多补几次，确保最终尺寸正确
    const timers = [80, 300, 900, 1800].map((ms) => window.setTimeout(doFit, ms));

    bus.attach(sessionId, (bytes) => term.write(bytes));
    const sub = term.onData((data) => {
      void sessionWrite(sessionId, bytesToB64(new TextEncoder().encode(data)));
    });

    const ro = new ResizeObserver(() => doFit());
    ro.observe(host);

    return () => {
      disposed = true;
      for (const t of timers) window.clearTimeout(t);
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
      const term = termRef.current;
      try {
        fitRef.current?.fit();
      } catch {
        /* ignore */
      }
      if (term.cols >= MIN_COLS && term.rows >= MIN_ROWS) {
        void sessionResize(sessionId, term.cols, term.rows);
      }
      term.focus();
    }
  }, [active, sessionId]);

  return <div className="terminal-host" ref={hostRef} />;
}
