import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { sessionResize, sessionWrite } from "../ipc";
import { bytesToB64 } from "../util";
import type { SessionBus } from "../sessionBus";
import type { TermPalette } from "../termThemes";

interface Props {
  sessionId: string;
  bus: SessionBus;
  active: boolean;
  fontSize?: number;
  light?: boolean;
  /** 终端配色（来自设置里的方案）；不传就按 light 用内置默认 */
  palette?: TermPalette;
  /** 往上能翻多少行历史（回滚缓冲） */
  scrollback?: number;
  /** shell 通过 OSC 7 上报当前工作目录时回调（非 tmux 会话也能跟踪 cwd） */
  onCwd?: (path: string) => void;
  /** 需要给用户提示时回调（走状态栏，不弹浮层） */
  onNotice?: (text: string) => void;
  /** Ctrl + 鼠标滚轮缩放字号：+1 变大，-1 变小 */
  onZoom?: (delta: number) => void;
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
  palette,
  scrollback = 10000,
  onCwd,
  onNotice,
  onZoom,
}: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termRef = useRef<Terminal | null>(null);
  // 终端自己的右键菜单（复制/粘贴/清空/全选）—— 浏览器那套菜单已被全局屏蔽
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  // 回调用 ref 存，避免因为父组件重渲染导致终端被重建
  const onCwdRef = useRef<Props["onCwd"]>(onCwd);
  onCwdRef.current = onCwd;
  const onZoomRef = useRef<Props["onZoom"]>(onZoom);
  onZoomRef.current = onZoom;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      fontFamily: '"Cascadia Mono", "Consolas", "Courier New", monospace',
      fontSize,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback,
      allowProposedApi: true,
      theme: palette ?? (light ? LIGHT_THEME : THEME),
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

    // Ctrl + 鼠标滚轮 = 缩放字号（和浏览器/VS Code 一个习惯）。
    // 用 capture 阶段拦下来：xterm 自己的滚轮处理在冒泡阶段，
    // 这里 stopPropagation 之后它就不会顺手滚动缓冲，两者不会打架。
    let acc = 0;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) {
        acc = 0;
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      // 触摸板一次滑动会发很多小 deltaY，累计到一档再动，避免抖得太快
      acc += e.deltaY;
      const step = 40;
      if (Math.abs(acc) >= step) {
        onZoomRef.current?.(acc > 0 ? -1 : 1);
        acc = 0;
      }
    };
    host.addEventListener("wheel", onWheel, { passive: false, capture: true });

    return () => {
      disposed = true;
      for (const t of timers) window.clearTimeout(t);
      ro.disconnect();
      host.removeEventListener("wheel", onWheel, { capture: true });
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
    term.options.theme = palette ?? (light ? LIGHT_THEME : THEME);
    term.options.scrollback = scrollback;
    try {
      fitRef.current?.fit();
    } catch {
      /* ignore */
    }
    if (term.cols >= MIN_COLS && term.rows >= MIN_ROWS) {
      void sessionResize(sessionId, term.cols, term.rows);
    }
    // palette 每次渲染都是新对象时不该重建终端，所以用它的 JSON 当依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fontSize, light, palette && JSON.stringify(palette), scrollback, sessionId]);

  /** 终端右键菜单的动作 */
  async function copySelection() {
    const term = termRef.current;
    const text = term?.getSelection() ?? "";
    if (!text) {
      onNotice?.("没有选中内容");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      onNotice?.(`已复制 ${text.length} 个字符`);
    } catch (e) {
      onNotice?.("复制失败：" + String(e));
    }
  }

  async function pasteClipboard() {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return;
      void sessionWrite(sessionId, bytesToB64(new TextEncoder().encode(text)));
    } catch {
      // 剪贴板读取被拒绝时，告诉用户用 Ctrl+V（xterm 自己处理粘贴，不需要权限）
      onNotice?.("读取剪贴板被拒绝，请用 Ctrl+V 粘贴");
    }
  }

  return (
    <>
      <div
        className="terminal-host"
        ref={hostRef}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
      />
      {menu && (
        <div
          className="ctx-backdrop"
          onClick={() => setMenu(null)}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu(null);
          }}
        >
          <div
            className="ctx-menu"
            style={{
              left: Math.min(menu.x, Math.max(0, window.innerWidth - 170)),
              top: Math.min(menu.y, Math.max(0, window.innerHeight - 150)),
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                setMenu(null);
                void copySelection();
              }}
            >
              复制
            </button>
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                setMenu(null);
                void pasteClipboard();
              }}
            >
              粘贴
            </button>
            <div className="menu-sep" />
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                setMenu(null);
                termRef.current?.selectAll();
              }}
            >
              全选
            </button>
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                setMenu(null);
                termRef.current?.clear();
              }}
            >
              清屏
            </button>
          </div>
        </div>
      )}
    </>
  );
}
