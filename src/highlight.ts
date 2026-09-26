/**
 * 终端关键字高亮（v1）—— 走「数据流注入」路线：在 `term.write()` 之前，把命中关键词的
 * 文本包上 ANSI 颜色序列，再交给 xterm。
 *
 * 为什么这么做（而不是 xterm 的 decoration）：
 * - v1 要求「新到达的输出立刻变色」。decoration 是按单元格范围着色，要先知道行列号，
 *   还要在换行/重排/回滚时自己维护，工作量比注入大得多；
 * - 注入只影响**界面**：日志是后端从 PTY 的原始字节写的（落盘前已经剥掉 ANSI），
 *   所以界面上的高亮不会污染日志文件。
 *
 * 必须守住的几条：
 * 1. **不为了匹配把整行挂起**。交互式回显（你敲一个字符、shell 回显一个字符）是没有换行的，
 *    挂整行会让你打字像卡住。默认只挂住「尾巴上可能是某个关键词前缀」的那几个字符
 *    （N = 最长关键词长度 - 1），其余立刻写出去。
 * 2. **不切断转义序列**。ESC 开头的序列如果在这一片里没收完，整段挂起等下一片；
 *    我们插入的颜色序列也只插在普通文本里，不会插进别人的序列中间。
 * 3. **不把行内原本的颜色打回默认值**。输出本身带颜色时，插入一段高亮后要把
 *    「刚才程序设的颜色」恢复回去，所以这里跟了一份 SGR 状态（见 SgrState）。
 *
 * 已知取舍（v1）：
 * - 改规则不会给历史输出重新上色（那要靠 decoration，留到 v2）；
 * - 不支持正则 —— 用户写个 `.*` 就能让渲染卡死，留到 v2，且必须限量限长；
 * - 「整行高亮」规则需要等这一行结束（或短暂停顿）才知道要不要整行上色，
 *   所以勾了整行高亮的规则会带来一点点回显延迟；默认预设都不开整行，走流式不受影响。
 */

import type { HighlightRule } from "./types";

const ESC = "\u001b";

/** 转义序列最长扫到这么多字符就不再等（正常序列都很短，这纯粹是防呆） */
const MAX_ESCAPE_SCAN = 8192;
/** 数据停了这么久就把挂起的内容先吐出去（见「不为了高亮把回显卡住」） */
const IDLE_FLUSH_MS = 90;

/** 解析 #rgb / #rrggbb → [r,g,b]；不认识就返回 null */
export function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec((hex ?? "").trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** 一组前景/背景色对应的 ANSI 序列；两个都为空则返回空串（等于不插入任何东西） */
export function sgrStart(fg: string, bg: string): string {
  let s = "";
  const f = hexToRgb(fg);
  if (f) s += `${ESC}[38;2;${f[0]};${f[1]};${f[2]}m`;
  const b = hexToRgb(bg);
  if (b) s += `${ESC}[48;2;${b[0]};${b[1]};${b[2]}m`;
  return s;
}

/** 默认预设规则包：装上就能用，关键词/颜色都能自己改 */
export function presetRules(): HighlightRule[] {
  return [
    {
      id: "preset-error",
      name: "错误",
      keywords: ["ERROR", "FAIL", "Exception"],
      caseSensitive: false,
      fg: "#ff6b68",
      bg: "",
      wholeLine: false,
      enabled: true,
    },
    {
      id: "preset-warn",
      name: "警告",
      keywords: ["WARN"],
      caseSensitive: false,
      fg: "#ffcc66",
      bg: "",
      wholeLine: false,
      enabled: true,
    },
    {
      id: "preset-ok",
      name: "成功",
      keywords: ["OK", "SUCCESS"],
      // OK 只有两个字母，不分大小写的话 look / TOKEN 里都会亮，所以这里默认区分大小写
      // + 只认完整单词。
      caseSensitive: true,
      wholeWord: true,
      fg: "#4ec9b0",
      bg: "",
      wholeLine: false,
      enabled: true,
    },
    {
      id: "preset-fatal",
      name: "严重",
      keywords: ["panic", "assert", "watchdog"],
      caseSensitive: false,
      fg: "#ffffff",
      bg: "#7a1c1c",
      wholeLine: false,
      enabled: true,
    },
  ];
}

/**
 * 跟一份 SGR 状态，用来在插入高亮之后把「程序原本设的颜色」恢复回去。
 *
 * 不跟这份状态的话，`\x1b[31m…ERROR…\x1b[39m` 这种彩色输出里，我们插完高亮
 * 只能把颜色重置成默认值，后面半行就掉色了。
 */
export class SgrState {
  private flags = new Set<number>();
  private fg: string | null = null;
  private bg: string | null = null;

  /** 吃一条 CSI ... m 序列（其它序列别喂进来） */
  feed(seq: string) {
    const body = seq.slice(2, -1);
    const parts = body.length ? body.split(";") : ["0"];
    for (let i = 0; i < parts.length; i++) {
      const raw = parts[i].trim();
      const p = raw === "" ? 0 : Number(raw);
      if (!Number.isFinite(p)) continue;
      if (p === 0) {
        this.flags.clear();
        this.fg = null;
        this.bg = null;
      } else if (p >= 1 && p <= 9) {
        this.flags.add(p);
      } else if (p === 22) {
        this.flags.delete(1);
        this.flags.delete(2);
      } else if (p === 23) {
        this.flags.delete(3);
      } else if (p === 24) {
        this.flags.delete(4);
      } else if (p === 25) {
        this.flags.delete(5);
        this.flags.delete(6);
      } else if (p === 27) {
        this.flags.delete(7);
      } else if (p === 28) {
        this.flags.delete(8);
      } else if (p === 29) {
        this.flags.delete(9);
      } else if (p === 39) {
        this.fg = null;
      } else if (p === 49) {
        this.bg = null;
      } else if ((p >= 30 && p <= 37) || (p >= 90 && p <= 97)) {
        this.fg = String(p);
      } else if ((p >= 40 && p <= 47) || (p >= 100 && p <= 107)) {
        this.bg = String(p);
      } else if (p === 38 || p === 48) {
        const kind = (parts[i + 1] ?? "").trim();
        if (kind === "5") {
          const n = Number((parts[i + 2] ?? "").trim());
          if (Number.isFinite(n)) this.setColor(p, `${p};5;${n}`);
          i += 2;
        } else if (kind === "2") {
          const r = Number((parts[i + 2] ?? "").trim());
          const g = Number((parts[i + 3] ?? "").trim());
          const b = Number((parts[i + 4] ?? "").trim());
          if ([r, g, b].every(Number.isFinite)) this.setColor(p, `${p};2;${r};${g};${b}`);
          i += 4;
        }
      }
    }
  }

  private setColor(which: number, value: string) {
    if (which === 38) this.fg = value;
    else this.bg = value;
  }

  /** 当前状态的 ANSI 序列（不带前导的全清）；没有特殊状态就返回空串 */
  seq(): string {
    const attrs = [...this.flags].sort((a, b) => a - b).map(String);
    if (this.fg) attrs.push(this.fg);
    if (this.bg) attrs.push(this.bg);
    return attrs.length ? `${ESC}[${attrs.join(";")}m` : "";
  }

  /** 把终端拉回「当前状态」：先全清，再把这套属性装回去 */
  restore(): string {
    return `${ESC}[0m${this.seq()}`;
  }

  clear() {
    this.flags.clear();
    this.fg = null;
    this.bg = null;
  }
}

interface CompiledRule {
  fg: string;
  bg: string;
  wholeLine: boolean;
  wholeWord: boolean;
  caseSensitive: boolean;
  words: { text: string; lower: string }[];
}

function isWordChar(c: string): boolean {
  return c !== "" && /[0-9A-Za-z_]/.test(c);
}

/**
 * 从 text[i]（必须是 ESC）开始扫一条完整转义序列，返回「下一个字符」的下标；
 * 这一片里还没收完就返回 -1（调用方把剩下的整段挂起）。
 */
export function scanEscape(text: string, i: number): number {
  const n = text.length;
  if (i + 1 >= n) return -1;
  const kind = text[i + 1];
  if (kind === "[") {
    // CSI：参数字节 0x30-0x3F、中间字节 0x20-0x2F，最后一个 0x40-0x7E 收尾
    for (let j = i + 2; j < n; j++) {
      const c = text.charCodeAt(j);
      if (c >= 0x40 && c <= 0x7e) return j + 1;
      if (j - i > MAX_ESCAPE_SCAN) return j + 1;
    }
    return -1;
  }
  if (kind === "]" || kind === "P" || kind === "^" || kind === "_" || kind === "X") {
    // OSC / DCS / SOS / PM / APC：以 BEL 或 ST(ESC \) 结束
    for (let j = i + 2; j < n; j++) {
      const c = text.charCodeAt(j);
      if (c === 0x07) return j + 1;
      if (c === 0x1b) {
        if (j + 1 >= n) return -1; // 还得看下一个字符才知道是不是 ST
        return text[j + 1] === "\\" ? j + 2 : j + 1;
      }
      if (j - i > MAX_ESCAPE_SCAN) return j + 1;
    }
    return -1;
  }
  // ESC + 单字符（含 ESC ( B 这种三字节的字符集切换，这里按两字节处理，够用）
  return Math.min(i + 2, n);
}

/**
 * 高亮引擎：把原始字节喂进来，吐出去的是「可以直接 term.write 的字符串」。
 */
export class Highlighter {
  private sink: (data: string) => void;
  private decoder = new TextDecoder("utf-8", { fatal: false });
  private compiled: CompiledRule[] = [];
  /** 已解码但还没写出去的尾巴（可能是关键词前缀，也可能是没收完的转义序列） */
  private pending = "";
  /** 整行高亮模式下，当前这一行还没写出去的内容 */
  private lineBuf = "";
  private anyWholeLine = false;
  private maxKeywordLen = 0;
  private sgr = new SgrState();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(sink: (data: string) => void) {
    this.sink = sink;
  }

  /** 规则变了直接换（不重建终端，也不重新给历史输出上色 —— v1 的已知取舍） */
  setRules(rules: HighlightRule[]) {
    this.flush();
    const compiled: CompiledRule[] = [];
    let maxLen = 0;
    for (const r of rules) {
      if (!r || r.enabled === false) continue;
      const words = (r.keywords ?? [])
        .map((k) => (k ?? "").trim())
        .filter((k) => k.length > 0)
        .map((k) => ({ text: k, lower: k.toLowerCase() }));
      if (!words.length) continue;
      if (!sgrStart(r.fg, r.bg)) continue; // 没设任何颜色 = 这条规则什么也不做
      for (const w of words) maxLen = Math.max(maxLen, w.text.length);
      compiled.push({
        fg: r.fg,
        bg: r.bg,
        wholeLine: !!r.wholeLine,
        wholeWord: !!r.wholeWord,
        caseSensitive: !!r.caseSensitive,
        words,
      });
    }
    this.compiled = compiled;
    this.maxKeywordLen = maxLen;
    this.anyWholeLine = compiled.some((c) => c.wholeLine);
    if (!this.anyWholeLine && this.lineBuf) {
      // 从「整行」切回「只词」，把挂着的半行先按流式写出去
      const rest = this.lineBuf;
      this.lineBuf = "";
      this.emit(this.colorizeMixed(rest));
    }
  }

  get active(): boolean {
    return this.compiled.length > 0;
  }

  /** 终端收到一片数据 */
  push(bytes: Uint8Array) {
    if (this.disposed) return;
    const text = this.pending + this.decoder.decode(bytes, { stream: true });
    this.pending = "";
    if (this.anyWholeLine) this.pushWholeLine(text);
    else this.pushStream(text);
    this.armIdle();
  }

  /** 数据停了 / 规则变了 / 组件卸载：把挂起的内容先吐出去，别让用户等 */
  flush() {
    this.clearIdle();
    if (this.pending) {
      const p = this.pending;
      this.pending = "";
      if (this.anyWholeLine) this.lineBuf += p;
      else this.emit(this.colorizeMixed(p));
    }
    if (this.lineBuf) {
      const line = this.lineBuf;
      this.lineBuf = "";
      this.emit(this.colorizeMixed(line));
    }
  }

  dispose() {
    if (this.disposed) return;
    this.flush();
    this.disposed = true;
  }

  // ---------- 内部 ----------

  private emit(data: string) {
    if (data) this.sink(data);
  }

  private clearIdle() {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private armIdle() {
    if (this.idleTimer !== null) return; // 已经排上了，不重复排
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (!this.disposed) this.flush();
    }, IDLE_FLUSH_MS);
  }

  /** 流式（默认）：只在尾巴上挂住「可能是关键词前缀」的几个字符 */
  private pushStream(text: string) {
    const n = text.length;
    let i = 0;
    let out = "";
    while (i < n) {
      if (text.charCodeAt(i) === 0x1b) {
        const end = scanEscape(text, i);
        if (end < 0) {
          this.pending = text.slice(i);
          break;
        }
        const seq = text.slice(i, end);
        out += seq;
        if (isSgr(seq)) this.sgr.feed(seq);
        i = end;
        continue;
      }
      let j = i;
      while (j < n && text.charCodeAt(j) !== 0x1b) j++;
      let seg = text.slice(i, j);
      i = j;
      if (i >= n) {
        const hold = this.prefixHold(seg);
        if (hold > 0) {
          this.pending = seg.slice(seg.length - hold);
          seg = seg.slice(0, seg.length - hold);
        }
      }
      if (seg) out += this.colorize(seg);
    }
    this.emit(out);
  }

  /** 整行模式：按行攒，行结束（或停顿时）才决定要不要整行上色 */
  private pushWholeLine(text: string) {
    const n = text.length;
    let i = 0;
    while (i < n) {
      if (text.charCodeAt(i) === 0x1b) {
        const end = scanEscape(text, i);
        if (end < 0) {
          this.pending = text.slice(i);
          break;
        }
        const seq = text.slice(i, end);
        this.lineBuf += seq;
        if (isSgr(seq)) this.sgr.feed(seq);
        i = end;
        continue;
      }
      const nl = text.indexOf("\n", i);
      if (nl < 0) {
        this.lineBuf += text.slice(i);
        break;
      }
      this.lineBuf += text.slice(i, nl + 1);
      i = nl + 1;
      this.emitLine();
    }
  }

  private emitLine() {
    const line = this.lineBuf;
    this.lineBuf = "";
    if (!line) return;
    const hasNl = line.endsWith("\n");
    const body = hasNl ? line.slice(0, -1) : line;
    const wl = this.matchWholeLine(body);
    if (wl) {
      const start = sgrStart(wl.fg, wl.bg);
      this.emit(start + body + this.sgr.restore() + (hasNl ? "\n" : ""));
    } else {
      this.emit(this.colorizeMixed(line));
    }
  }

  /**
   * 把一段「可能混着转义序列」的文本按段处理：转义序列原样透传，
   * 只有普通文本才交给 colorize —— 否则往别人的转义序列里插颜色会把它弄坏。
   * （整行模式攒下来的一行里就混着转义序列，所以必须走这里。）
   */
  private colorizeMixed(text: string): string {
    const n = text.length;
    let out = "";
    let i = 0;
    while (i < n) {
      if (text.charCodeAt(i) === 0x1b) {
        const end = scanEscape(text, i);
        if (end < 0) {
          out += text.slice(i);
          break;
        }
        out += text.slice(i, end);
        i = end;
        continue;
      }
      let j = i;
      while (j < n && text.charCodeAt(j) !== 0x1b) j++;
      out += this.colorize(text.slice(i, j));
      i = j;
    }
    return out;
  }

  /** 尾部最多挂住「最长关键词长度 - 1」个字符（超出这个长度不可能是前缀） */
  private prefixHold(seg: string): number {
    if (!this.maxKeywordLen || !seg) return 0;
    const max = Math.min(seg.length, this.maxKeywordLen - 1);
    for (let k = max; k >= 1; k--) {
      const tail = seg.slice(seg.length - k);
      if (this.isPrefixOfAny(tail)) return k;
    }
    return 0;
  }

  private isPrefixOfAny(tail: string): boolean {
    const lower = tail.toLowerCase();
    for (const rule of this.compiled) {
      for (const w of rule.words) {
        if (w.text.length <= tail.length) continue;
        const head = rule.caseSensitive ? w.text.slice(0, tail.length) : w.lower.slice(0, tail.length);
        if (head === (rule.caseSensitive ? tail : lower)) return true;
      }
    }
    return false;
  }

  /** 在这段普通文本里把命中的关键词包上颜色 */
  private colorize(seg: string): string {
    if (!this.compiled.length || !seg) return seg;
    const n = seg.length;
    let out = "";
    let i = 0;
    while (i < n) {
      const hit = this.hitAt(seg, i);
      if (hit) {
        const start = sgrStart(hit.rule.fg, hit.rule.bg);
        out += start + seg.slice(i, i + hit.len) + `${ESC}[0m` + this.sgr.seq();
        i += hit.len;
      } else {
        out += seg[i];
        i++;
      }
    }
    return out;
  }

  private hitAt(seg: string, i: number): { rule: CompiledRule; len: number } | null {
    for (const rule of this.compiled) {
      for (const w of rule.words) {
        const len = w.text.length;
        if (i + len > seg.length) continue;
        const piece = seg.slice(i, i + len);
        const same = rule.caseSensitive ? piece === w.text : piece.toLowerCase() === w.lower;
        if (!same) continue;
        if (rule.wholeWord) {
          const before = i > 0 ? seg[i - 1] : "";
          const after = i + len < seg.length ? seg[i + len] : "";
          if (isWordChar(before) || isWordChar(after)) continue;
        }
        return { rule, len };
      }
    }
    return null;
  }

  private matchWholeLine(body: string): CompiledRule | null {
    for (const rule of this.compiled) {
      if (!rule.wholeLine) continue;
      for (const w of rule.words) {
        const hay = rule.caseSensitive ? body : body.toLowerCase();
        const needle = rule.caseSensitive ? w.text : w.lower;
        let from = 0;
        for (;;) {
          const at = hay.indexOf(needle, from);
          if (at < 0) break;
          if (
            !rule.wholeWord ||
            (!isWordChar(at > 0 ? body[at - 1] : "") &&
              !isWordChar(at + w.text.length < body.length ? body[at + w.text.length] : ""))
          ) {
            return rule;
          }
          from = at + 1;
        }
      }
    }
    return null;
  }
}

function isSgr(seq: string): boolean {
  return seq.length >= 3 && seq.charCodeAt(1) === 0x5b && seq.charCodeAt(seq.length - 1) === 0x6d;
}
