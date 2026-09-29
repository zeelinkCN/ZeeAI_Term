/**
 * 记住"最近一次量到的终端行列数"，给下一次开会话当**初始尺寸**用。
 *
 * 为什么需要它：会话是先在 Rust 侧把 PTY / herdr 流起起来、再把终端挂上去的 ——
 * 开流那一刻前端还没量出尺寸，于是后端只能用一个写死的默认值（110x30），
 * 等前端量完再发一次 resize。中间这一小段时间里远端已经在按 110 列排版了：
 *
 * - 普通 shell / tmux：头几个提示符是按 110 列画出来的，一 resize 就"折叠"在一起
 *   （用户原话："头几个命令提示符都不是在一行，而是折叠在一块儿的"）；
 * - herdr 的**可写**流更明显：`terminal session control --cols/--rows` 会**真的去改
 *   那个窗格的尺寸**，窗格先被撑成 110 再被收到真实宽度，里面的 tmux / 全屏程序会跟着
 *   重排两次，屏幕上就留下一条宽度对不上的竖条。
 *
 * 同一台机器、同一个窗口，这次的尺寸和下次几乎一定一样，所以"上次量到的"就是最好的
 * 初始值：开流时直接用它，后面那次 resize 常常就变成空操作，全程只有一次排版。
 */
let last: { cols: number; rows: number } | null = null;

/** 存到 localStorage 的键：这样**重启应用后**的第一条会话也是对的尺寸 */
const KEY = "zeeai.lastTerminalSize";

/**
 * 认这个尺寸是"像个正常终端"的最低门槛。
 *
 * 比 Terminal.tsx 里那对闸门还严一点：那份是我自己算出来的、当场就要用；
 * 这份是**跨重启存下来的**，可能来自很老的版本或某个瞬间的坏布局 ——
 * 宁可退回"不知道"（让后端用自己的默认值），也不要拿一个 20 列的值去开新会话。
 */
const MIN_SAVED_COLS = 40;
const MIN_SAVED_ROWS = 12;

// 启动时先读一次上次存的（还没量过任何终端的时候就用它）
try {
  const raw = localStorage.getItem(KEY);
  if (raw) {
    const v = JSON.parse(raw) as { cols?: number; rows?: number };
    if (
      typeof v.cols === "number" &&
      typeof v.rows === "number" &&
      v.cols >= MIN_SAVED_COLS &&
      v.rows >= MIN_SAVED_ROWS
    ) {
      last = { cols: v.cols, rows: v.rows };
    }
  }
} catch {
  /* 读不到就当没有 */
}

/** 记下刚量到的尺寸（只有像样的值才记：避免把"还没布局好"的 0 记进来） */
export function rememberTerminalSize(cols: number, rows: number): void {
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) return;
  if (cols < MIN_SAVED_COLS || rows < MIN_SAVED_ROWS) return;
  if (last && last.cols === cols && last.rows === rows) return;
  last = { cols, rows };
  try {
    localStorage.setItem(KEY, JSON.stringify(last));
  } catch {
    /* 存不下也无所谓：这次会话期间记住就够了 */
  }
}

/** 上一次量到的尺寸；从来没有过就返回 undefined（那种情况后端会用自己的默认值） */
export function lastTerminalSize(): { cols: number; rows: number } | undefined {
  return last ?? undefined;
}
