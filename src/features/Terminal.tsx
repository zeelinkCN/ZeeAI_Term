import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { sessionResize, sessionWrite } from "../ipc";
import { herdrPaneInput, herdrPaneKey, herdrPaneResize, herdrPaneType } from "../ipc";
import { bytesToB64 } from "../util";
import { rememberTerminalSize } from "./terminalSize";
import { Highlighter } from "../highlight";
import type { SessionBus } from "../sessionBus";
import type { TermPalette } from "../termThemes";
import type { HighlightRule } from "../types";

interface Props {
  sessionId: string;
  bus: SessionBus;
  active: boolean;
  /**
   * 这条终端现在**看得见**吗。
   *
   * 和 `active` 的区别：分屏时只有一个是"焦点"（active），但几个窗格都看得见；
   * 单窗格模式下藏起来的会话则是两者都 false。WebGL 渲染器只给看得见的挂
   * （见下面 attachWebgl 那段说明）。不传按看得见处理。
   */
  visible?: boolean;
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
  /**
   * herdr 窗格：这个终端的输出来自 herdr 的终端流。
   *
   * - `mode = "observe"`：**只读**。输入得走 herdr 的 `pane send-text` / `pane send-keys`
   *   （另开一条常驻 ssh），不能写进本地的 PTY；
   * - `mode = "control"`：**可读可写**，等于进了她的环境。输入直接以
   *   `{"type":"terminal.input","bytes":…}` 写进这条会话的 stdin 即可。
   *
   * 为什么这么设计见 core/herdr.rs 顶部：不在标签页里跑 herdr 的 TUI。
   */
  herdrPane?: { paneId: string; mode?: "observe" | "control" };
  /** 输入通道还没建好/断了时，让上层去建（同一个会话只会建一次） */
  onHerdrInputNeeded?: () => void;
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
//
// 门槛从 20x5 提到 40x12：20 列这种"能过闸但明显不合理"的值照样有害 ——
// 本地会按 20 列换行、远端会真的按 20 列重排，用户看到的就是
// "启动时几个提示符折叠在一起"（而且远端那一份会永久留在滚动区里）。
const MIN_COLS = 40;
const MIN_ROWS = 12;

// 容器小到这个像素尺寸就认为"还没布局好"，这一轮干脆不 fit。
//
// 为什么不能只靠上面的列数闸门：容器在首帧可能是几十像素宽，fit() 照样能算出
// 一个"通过闸门但离谱"的列数（实测能到 10~20 列），然后被写进终端。
// 一次都不发，比发一个错的值好得多 —— 后面还有 80/300/900/1800ms 几次补 fit。
const MIN_FIT_W = 160;
const MIN_FIT_H = 80;

/**
 * 连续 resize 的合并窗口。
 *
 * 为什么要合并：拖动窗口边缘、拖侧栏宽度、开关右侧 AI 面板时，ResizeObserver 会**连着触发几十次**。
 * 每一次都立刻 fit + session_resize，等于给 tmux 发一串 SIGWINCH —— 全屏 TUI（codex）会跟着重画几十次，
 * 渲染器偶尔就在空白区留下一片"点"（用户截图里那种），而且老 tmux 还会跳出
 * "Size … from a smaller client"。合并到 150ms 之后，一次拖动只发一次真正的尺寸变化。
 */
const RESIZE_DEBOUNCE_MS = 150;

/** 这台机器能不能用 WebGL2（不能就别挂 WebglAddon，原因见上面那段说明） */
function webgl2Available(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!c.getContext("webgl2");
  } catch {
    return false;
  }
}

/**
 * xterm 的 `onData` 给的是**字节序列**（`\r`、`\x1b[A`…），而 herdr 要的是**逻辑按键名**
 * （`enter`、`up`…）。这里做一次翻译。
 *
 * 拆成"一串动作"而不是"一个动作"：一次粘贴/一次快速敲击可能一次塞进来好几个字符，
 * 里面还可能混着回车 —— 拆开之后每一段用最合适的方式送（文本走 send-text，按键走 send-keys）。
 */
export function herdrActions(
  data: string,
): ({ kind: "key"; key: string } | { kind: "text"; text: string })[] {
  const seqKeys: Record<string, string> = {
    "\x1b[A": "up",
    "\x1b[B": "down",
    "\x1b[C": "right",
    "\x1b[D": "left",
    "\x1b[H": "home",
    "\x1b[F": "end",
    "\x1b[3~": "delete",
  };
  const ctrlKeys: Record<string, string> = {
    "\x03": "ctrl+c",
    "\x04": "ctrl+d",
    "\x1a": "ctrl+z",
    "\x0c": "ctrl+l",
    "\x01": "ctrl+a",
    "\x05": "ctrl+e",
    "\x0b": "ctrl+k",
    "\x15": "ctrl+u",
  };
  const out: ({ kind: "key"; key: string } | { kind: "text"; text: string })[] = [];
  let text = "";
  const flush = () => {
    if (text) {
      out.push({ kind: "text", text });
      text = "";
    }
  };
  for (let i = 0; i < data.length; i++) {
    const c = data[i];
    if (c === "\x1b") {
      const four = data.slice(i, i + 4);
      const three = data.slice(i, i + 3);
      const k = seqKeys[three] ?? seqKeys[four];
      flush();
      out.push({ kind: "key", key: k ?? "esc" });
      i += k ? (seqKeys[four] ? 3 : 2) : 0;
      continue;
    }
    if (c === "\r" || c === "\n") {
      flush();
      out.push({ kind: "key", key: "enter" });
      continue;
    }
    if (c === "\x7f") {
      flush();
      out.push({ kind: "key", key: "backspace" });
      continue;
    }
    if (c === "\t") {
      flush();
      out.push({ kind: "key", key: "tab" });
      continue;
    }
    if (ctrlKeys[c]) {
      flush();
      out.push({ kind: "key", key: ctrlKeys[c] });
      continue;
    }
    // 其它控制字符不认识 —— 宁可这一个键丢掉，也不要瞎猜一个按键名发过去
    if (c < " ") continue;
    text += c;
  }
  flush();
  return out;
}

export default function TerminalView({
  sessionId,
  bus,
  active,
  visible = true,
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
  herdrPane,
  onHerdrInputNeeded,
}: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const hlRef = useRef<Highlighter | null>(null);
  /** WebGL 渲染器（重绘时要清它的字形图集，否则会留下"一片点"那种残影） */
  const webglRef = useRef<WebglAddon | null>(null);
  /** 挂 / 摘 WebGL 渲染器（不重建终端）；由 mount effect 填，可见性变化时调用 */
  const attachWebglRef = useRef<(() => void) | null>(null);
  const detachWebglRef = useRef<(() => void) | null>(null);
  /** 当前是不是看得见（WebGL 只给看得见的挂；上下文丢失自愈时也要看它） */
  const visibleRef = useRef(visible);
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
  // herdr 观察窗标记也放 ref：终端只建一次（deps 里没有它），改会话类型不该重建终端
  const herdrPaneRef = useRef<Props["herdrPane"]>(herdrPane);
  herdrPaneRef.current = herdrPane;
  const needHerdrInputRef = useRef<Props["onHerdrInputNeeded"]>(onHerdrInputNeeded);
  needHerdrInputRef.current = onHerdrInputNeeded;
  /**
   * 可写 herdr 流的输入通道是否已经断了。
   *
   * 为什么要有它：通道断了之后**每一次按键都会失败**，如果每次都弹一条状态栏提示，
   * 用户随便敲几下就被刷屏了。所以第一次失败提示一次，之后就不再发、也不再报。
   */
  const herdrInputDeadRef = useRef(false);

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
      // 先自己问一句"这台机器到底有没有 WebGL2"，有才挂 addon。
      //
      // 为什么不能"挂了再说"：WebglAddon 在**激活到一半**失败时（没有 WebGL2 的机器，
      // 比如无显卡加速的虚拟机 / 远程桌面 / 无头环境），xterm 内部的渲染器可能已经被
      // 换掉、尺寸又没算出来，随后任何一次 refresh 都会抛
      // `Cannot read properties of undefined (reading 'dimensions')` —— 终端整块不动了。
      // （这是用无头浏览器跑功能测试时实测到的，不是猜的。）
      // 只有**看得见**的终端才占一个 GPU 上下文。
      //
      // 为什么：单窗格模式下所有会话都挂载着（用 display:none 藏着，这样回滚缓冲不丢），
      // 而 WebGL 上下文数量有上限 —— 以前每条会话都 `new WebglAddon()`，开十几个会话就会
      // 把最早的上下文挤掉，那条终端从此花屏/退回慢渲染（beta 线上那条 87e0ceb 治的是
      // "丢了不自愈"，这里治的是"根本不该同时占那么多"）。现在：可见才挂（单窗格 1 个、
      // 分屏最多 4 个），藏起来时摘掉退回 DOM 渲染 —— 缓冲和连接都还在，只是不占 GPU。
      let webglTries = 0;
      const detachWebgl = () => {
        try {
          webglRef.current?.dispose();
        } catch {
          /* ignore */
        }
        webglRef.current = null;
      };
      const attachWebgl = () => {
        if (webglRef.current) return; // 已经挂着，别重复挂
        if (!webgl2Available()) return;
        // 上下文丢失时**重建**渲染器，而不是一丢了之。
        //
        // 以前这里只 dispose 就完事 —— 后果是这条终端**永久**退回慢的 DOM 渲染，
        // 一直慢到重启应用/重启电脑（用户实测："重启电脑就好了"、"本地/远端全都慢"、
        // "关掉高亮也还是慢"）。GPU 上下文会因为驱动重置、远程桌面切换、长时间运行、
        // 显存压力等原因丢失，所以必须能自愈。
        //
        // 这条修复是从工作空间那条线（D:\AI\ZeeAI_term-beta，commit 87e0ceb）搬过来的。
        try {
          const webgl = new WebglAddon();
          webgl.onContextLoss(() => {
            try {
              webgl.dispose();
            } catch {
              /* ignore */
            }
            webglRef.current = null;
            // 200ms 后重建；最多试 5 次，避免真的没有 WebGL 时无限重试
            if (webglTries < 5) {
              webglTries += 1;
              window.setTimeout(() => {
                // 已经切走或终端已经销毁：不要再抢上下文（不然又回到"开 N 个占 N 个"）
                if (!visibleRef.current || termRef.current !== term) return;
                try {
                  attachWebgl();
                } catch {
                  /* 重建失败：保持默认渲染 */
                }
              }, 200);
            }
          });
          term.loadAddon(webgl);
          webglRef.current = webgl;
        } catch {
          /* WebGL 真的不可用：退回默认渲染 */
        }
      };
      attachWebglRef.current = attachWebgl;
      detachWebglRef.current = detachWebgl;
      if (visibleRef.current) attachWebgl();
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
        // 顺手记下来：下一次开新会话时用它当**初始尺寸**，省掉"先 110 列排版再 resize"
        // 那一次（那正是"头几个提示符折叠"和"一条竖条宽度不对"的来源）
        rememberTerminalSize(cols, rows);
        if (cols === lastSent.cols && rows === lastSent.rows) return;
        lastSent = { cols, rows };
        if (herdrPaneRef.current) {
          // herdr 观察窗：行列数是在"开流时"声明的，所以这里让后端把流按新尺寸重开一次
          // （重开**不会**去改窗格本身的尺寸，也不会影响别的客户端）
          void herdrPaneResize(sessionId, cols, rows);
          return;
        }
        void sessionResize(sessionId, cols, rows);
        // 尺寸变完之后做一次"硬重绘"：
        // 1) 清掉 WebGL 的字形图集 —— 缩放/换宽之后图集里可能留着按旧单元格尺寸栅格化的字形，
        //    空白区域会被画成"一片点"，这正是用户截图里的现象；
        // 2) 再让 xterm 按新尺寸整屏重画一次。
        try {
          webglRef.current?.clearTextureAtlas();
        } catch {
          /* 没有 WebGL（回退到 canvas/dom 渲染）时忽略 */
        }
        try {
          term.refresh(0, rows - 1);
        } catch {
          /* ignore */
        }
      }, RESIZE_DEBOUNCE_MS);
    };

    const doFit = () => {
      if (disposed) return;
      // 元素还没布局好（首帧常常是 0 宽或几十像素）时不要 fit：
      // 这时候算出来的列数会非常离谱，一旦按它去 resize，远端会真的按那个宽度重排、
      // 本地也会按那个宽度换行 —— 用户看到的就是"启动时几个提示符折叠在一起"
      //（用户截图里那段 `[lz@iZbp13 / lx01nj91v3 / 7nkv2uZ ~]` 就是这么来的）。
      const box = hostRef.current;
      if (!box || box.clientWidth < MIN_FIT_W || box.clientHeight < MIN_FIT_H) return;
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
      const pane = herdrPaneRef.current;
      if (pane) {
        // 可写那条（control）：这条会话的 stdin 就是 herdr 的输入口，
        // 直接把原始字节交上去（回车之类都由 herdr 那边按终端语义处理）
        if (pane.mode === "control") {
          if (herdrInputDeadRef.current) return; // 通道已断：不再逐键重试/报错
          void herdrPaneInput(sessionId, bytesToB64(new TextEncoder().encode(data))).catch(
            () => {
              herdrInputDeadRef.current = true;
              onNotice?.("这个窗格的输入送不出去了（可能已被别的客户端接管，或窗格已关闭）");
            },
          );
          return;
        }
        // 只读观察窗：输入不能写进本地 PTY（那条 PTY 只是 observe 的输出管道），
        // 得走 herdr 自己的 `pane send-text` / `pane send-keys`
        for (const a of herdrActions(data)) {
          if (a.kind === "text") {
            void herdrPaneType(sessionId, a.text).catch(() => needHerdrInputRef.current?.());
          } else {
            void herdrPaneKey(sessionId, a.key).catch(() => needHerdrInputRef.current?.());
          }
        }
        return;
      }
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
      webglRef.current = null;
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      doFitRef.current = null;
      attachWebglRef.current = null;
      detachWebglRef.current = null;
    };
  }, [sessionId, bus]);

  /**
   * 可见性变化：挂 / 摘 WebGL 渲染器。
   *
   * 摘掉只是**换渲染器**（退回 DOM），终端本体、回滚缓冲、连接都不动 —— 所以
   * "开 20 个会话"不再等于"占 20 个 GPU 上下文"（见 mount effect 里那段说明）。
   */
  useEffect(() => {
    visibleRef.current = visible;
    if (!visible) {
      detachWebglRef.current?.();
      return;
    }
    attachWebglRef.current?.();
    // 重新挂上渲染器后整屏重画一次（跟"切回来"那条 effect 同一个道理：
    // 藏起来这段时间画布是停的，不重画可能停在半坏状态）
    try {
      const term = termRef.current;
      if (term) term.refresh(0, term.rows - 1);
    } catch {
      /* ignore */
    }
  }, [visible]);

  // 高亮规则/开关变了：热更新，不重建终端（v1 不会给历史输出重新上色，这是已知取舍）
  useEffect(() => {
    hlRef.current?.setRules(highlightEnabled ? (highlightRules ?? []) : []);
    // 规则数组每次渲染都可能是新对象，所以拿它的 JSON 当依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightEnabled, JSON.stringify(highlightRules ?? [])]);

  useEffect(() => {
    const term = termRef.current;
    if (!active || !term) return;
    /**
     * 这个标签**重新可见**了 —— 这一条 effect 是唯一能收到这个通知的地方。
     *
     * 为什么要无条件重画：终端被 `display:none` 藏起来时 WebGL 画布不再重绘，
     * 字形图集也可能被浏览器丢掉；再显示出来时如果窗口尺寸没变，下面那套
     * "只在尺寸真的变了才发/才刷" 的逻辑就**什么都不做**，画面停在半坏的状态 ——
     * 用户看到的就是"切回 herdr 标签后字体花了（有的字没了、有的错位），
     * 缩放一下/拉一下窗口才恢复"。所以这里固定做三件事：清图集 → 重新 fit → 整屏重画。
     */
    const repaint = () => {
      try {
        // 图集里可能留着按旧单元格尺寸栅格化的字形（换字号/换宽之后），先清掉
        webglRef.current?.clearTextureAtlas();
      } catch {
        /* 没挂 WebGL（回退到 canvas/dom 渲染）时没有图集可清 */
      }
      try {
        // 走同一套"合并 + 变了才发"的逻辑，别在这里直接 session_resize
        doFitRef.current?.();
      } catch {
        /* ignore */
      }
      try {
        term.refresh(0, term.rows - 1);
      } catch {
        /* ignore */
      }
      term.focus();
    };
    // 等一帧再画：刚切过来时容器可能还没拿到最终尺寸，立刻 fit 出来的列数会不准
    const raf = window.requestAnimationFrame(repaint);
    return () => window.cancelAnimationFrame(raf);
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
                // 「清屏并重画」= 把终端状态整个重置回干净态：
                // 全屏 TUI（codex / herdr / vim）异常退出后偶尔会留下花屏或"一片点"，
                // reset 会把字符集、颜色、鼠标模式、备用屏这些统统复位，
                // 再用 refresh 让渲染器按当前尺寸整屏重画一次。
                const term = termRef.current;
                if (!term) return;
                try {
                  term.reset();
                  try {
                    webglRef.current?.clearTextureAtlas();
                  } catch {
                    /* 没有 WebGL 时忽略 */
                  }
                  term.refresh(0, term.rows - 1);
                } catch {
                  /* ignore */
                }
                onNotice?.("已清屏并重画");
              }}
            >
              清屏并重画
            </button>
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
