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
  fontSize?: number;
  light?: boolean;
  /** shell 通过 OSC 7 上报当前工作目录时回调（非 tmux 会话也能跟踪 cwd） */
  onCwd?: (path: string) => void;
}

/** 从 OSC 7 的内容里取出路径：file://host/path 或 file:///path */
export function parseOsc7(data: string): string | null {
  const m = /^file:\/\/[^/]*(\/.*)$/.exec(data.trim());
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
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

const LIGHT_THEME = {
  background: "#ffffff",
  foreground: "#1f1f1f",
  cursor: "#1f1f1f",
  selectionBackground: "#add6ff",
  black: "#000000",
  red: "#cd3131",
  green: "#00bc00",
  yellow: "#949800",
  blue: "#0451a5",
  magenta: "#bc05bc",
  cyan: "#0598bc",
  white: "#555555",
  brightBlack: "#666666",
  brightRed: "#cd3131",
  brightGreen: "#14ce14",
  brightYellow: "#b5ba00",
  brightBlue: "#0451a5",
  brightMagenta: "#bc05bc",
  brightCyan: "#0598bc",
  brightWhite: "#a5a5a5",
};

// 小于这个尺寸的 resize 一律不发：界面首次布局时容器可能是 0 尺寸，
// 一旦把 12x4 这种尺寸发给 tmux，窗口会被压变形（表现为满屏花点）。
const MIN_COLS = 20;
const MIN_ROWS = 5;

export default function TerminalView({
  sessionId,
  bus,
  active,
  fontSize = 13,
  light = false,
  onCwd,
}: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termRef = useRef<Terminal | null>(null);
  // 回调用 ref 存，避免因为父组件重渲染导致终端被重建
  const onCwdRef = useRef<Props["onCwd"]>(onCwd);
  onCwdRef.current = onCwd;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      fontFamily: '"Cascadia Mono", "Consolas", "Courier New", monospace',
      fontSize,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 10000,
      allowProposedApi: true,
      theme: light ? LIGHT_THEME : THEME,
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

    // OSC 7：shell 每次显示提示符时上报当前目录，例如
    // ESC ] 7 ; file://host/tmp/zeeai-demo ESC \
    const osc7 = term.parser.registerOscHandler(7, (data) => {
      const path = parseOsc7(data);
      if (path) onCwdRef.current?.(path);
      return true; // 已消费，不要在屏幕上打印
    });

    const ro = new ResizeObserver(() => doFit());
    ro.observe(host);

    return () => {
      disposed = true;
      for (const t of timers) window.clearTimeout(t);
      ro.disconnect();
      sub.dispose();
      osc7.dispose();
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

  // 字体大小 / 主题变化时热更新（不重建终端，保留回滚缓冲与连接状态）
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = fontSize;
    term.options.theme = light ? LIGHT_THEME : THEME;
    try {
      fitRef.current?.fit();
    } catch {
      /* ignore */
    }
    if (term.cols >= MIN_COLS && term.rows >= MIN_ROWS) {
      void sessionResize(sessionId, term.cols, term.rows);
    }
  }, [fontSize, light, sessionId]);

  return <div className="terminal-host" ref={hostRef} />;
}
