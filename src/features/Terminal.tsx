import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { sessionResize, sessionWrite } from "../ipc";
import { bytesToB64 } from "../util";
import { Highlighter } from "../highlight";
import type { SessionBus } from "../sessionBus";
import type { TermPalette } from "../termThemes";
import type { HighlightRule } from "../types";

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
  /**
   * shell 通过 OSC 133 上报"命令结束 + 退出码"时回调（G-02）。
   *
   * 只在我们注入过 PROMPT_COMMAND 的会话里有信号（普通 shell / WSL）；
   * tmux 会话因为注入不进去，收不到 —— 前端对此必须容忍"永远不回调"。
   */
  onCommandDone?: (exitCode: number) => void;
  /** 需要给用户提示时回调（走状态栏，不弹浮层） */
  onNotice?: (text: string) => void;
  /** Ctrl + 鼠标滚轮缩放字号：+1 变大，-1 变小 */
  onZoom?: (delta: number) => void;
  /** 关键字高亮总开关（SSH / 串口 / 本地终端共用同一份规则） */
  highlightEnabled?: boolean;
  /** 关键字高亮规则 */
  highlightRules?: HighlightRule[];
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

/**
 * 连续 resize 的合并窗口。
 *
 * 为什么要合并：拖动窗口边缘、拖侧栏宽度、开关右侧 AI 面板时，ResizeObserver 会**连着触发几十次**。
 * 每一次都立刻 fit + session_resize，等于给 tmux 发一串 SIGWINCH —— 全屏 TUI（codex）会跟着重画几十次，
 * 渲染器偶尔就在空白区留下一片"点"（用户截图里那种），而且老 tmux 还会跳出
 * "Size … from a smaller client"。合并到 150ms 之后，一次拖动只发一次真正的尺寸变化。
 */
const RESIZE_DEBOUNCE_MS = 150;

export default function TerminalView({
  sessionId,
  bus,
  active,
  fontSize = 13,
  light = false,
  palette,
  scrollback = 10000,
  onCwd,
  onCommandDone,
  onNotice,
  onZoom,
  highlightEnabled = false,
  highlightRules,
}: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const hlRef = useRef<Highlighter | null>(null);
  /** 统一走"合并 + 只在真的变了才发"的 resize；给下面几个 effect 复用 */
  const doFitRef = useRef<(() => void) | null>(null);
  // 终端自己的右键菜单（复制/粘贴/清空/全选）—— 浏览器那套菜单已被全局屏蔽
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  // 回调用 ref 存，避免因为父组件重渲染导致终端被重建
  const onCwdRef = useRef<Props["onCwd"]>(onCwd);
  onCwdRef.current = onCwd;
  const onCommandDoneRef = useRef<Props["onCommandDone"]>(onCommandDone);
  onCommandDoneRef.current = onCommandDone;
  const onZoomRef = useRef<Props["onZoom"]>(onZoom);
  onZoomRef.current = onZoom;
  // 高亮规则也在重建终端时读一次就行（后续变化走下面的热更新 effect）
  const hlRulesRef = useRef<HighlightRule[]>(highlightRules ?? []);
  hlRulesRef.current = highlightRules ?? [];
  const hlOnRef = useRef(highlightEnabled);
  hlOnRef.current = highlightEnabled;

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
    let resizeTimer: number | null = null;
    let lastSent = { cols: 0, rows: 0 };

    /** 把"当前尺寸"合并上报：连续变化只发最后一次，尺寸没变就不发 */
    const scheduleResize = () => {
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        resizeTimer = null;
        if (disposed) return;
        const cols = term.cols;
        const rows = term.rows;
        if (cols < MIN_COLS || rows < MIN_ROWS) return;
        if (cols === lastSent.cols && rows === lastSent.rows) return;
        lastSent = { cols, rows };
        void sessionResize(sessionId, cols, rows);
        // 尺寸变完强制重画一遍，清掉渲染器可能留下的残影（那种"一片点"）
        try {
          term.refresh(0, rows - 1);
        } catch {
          /* ignore */
        }
      }, RESIZE_DEBOUNCE_MS);
    };

    const doFit = () => {
      if (disposed) return;
      try {
        fit.fit();
      } catch {
        return;
      }
      scheduleResize();
    };
    doFitRef.current = doFit;
    doFit();

    // 首次布局可能晚于挂载，多补几次，确保最终尺寸正确
    const timers = [80, 300, 900, 1800].map((ms) => window.setTimeout(doFit, ms));

    // 关键字高亮：在 term.write 之前插一层（把命中的关键词包上 ANSI 颜色）。
    // 只影响界面 —— 日志是后端从 PTY 原始字节写的，落盘前早就剥掉了 ANSI。
    const hl = new Highlighter((data) => term.write(data));
    hl.setRules(hlOnRef.current ? hlRulesRef.current : []);
    hlRef.current = hl;
    bus.attach(sessionId, (bytes) => {
      // 没开高亮就完全走原路（原样把字节交给 xterm，零开销）
      if (hl.active) hl.push(bytes);
      else term.write(bytes);
    });
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

    // OSC 133（shell 集成的命令标记）：我们只关心 `D;<退出码>`。
    // 报上来之后交给上层 —— 卡片上显示"退出码 N"，并把这个时刻当成"这一轮真正结束"。
    const osc133 = term.parser.registerOscHandler(133, (data) => {
      const m = /^D;(-?\d+)/.exec(data.trim());
      if (m) onCommandDoneRef.current?.(Number(m[1]));
      return true;
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
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      for (const t of timers) window.clearTimeout(t);
      ro.disconnect();
      host.removeEventListener("wheel", onWheel, { capture: true });
      sub.dispose();
      osc7.dispose();
      osc133.dispose();
      bus.detach(sessionId);
      hl.dispose();
      hlRef.current = null;
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      doFitRef.current = null;
    };
  }, [sessionId, bus]);

  // 高亮规则/开关变了：热更新，不重建终端（v1 不会给历史输出重新上色，这是已知取舍）
  useEffect(() => {
    hlRef.current?.setRules(highlightEnabled ? (highlightRules ?? []) : []);
    // 规则数组每次渲染都可能是新对象，所以拿它的 JSON 当依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightEnabled, JSON.stringify(highlightRules ?? [])]);

  useEffect(() => {
    if (active && termRef.current) {
      // 走同一套"合并 + 变了才发"的逻辑，别在这里直接 session_resize
      doFitRef.current?.();
      termRef.current.focus();
    }
  }, [active, sessionId]);

  // 字体大小 / 主题变化时热更新（不重建终端，保留回滚缓冲与连接状态）
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = fontSize;
    term.options.theme = palette ?? (light ? LIGHT_THEME : THEME);
    term.options.scrollback = scrollback;
    // 字号/主题变了，尺寸多半也会跟着变 —— 仍然交给统一的合并逻辑
    try {
      fitRef.current?.fit();
    } catch {
      /* ignore */
    }
    doFitRef.current?.();
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
