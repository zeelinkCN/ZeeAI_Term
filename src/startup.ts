import { invoke } from "@tauri-apps/api/core";

/**
 * 启动节奏控制：**首屏只画"壳"，重活等首帧之后再做**。
 *
 * 为什么需要这个文件：用户报"启动瞬间一大一小两个相同画面重影 + 卡顿一下"。
 * `scripts/startup-probe.ps1` 实测（基线，5 次冷启动中位数）：窗口 ~373ms 就可见，
 * 但画面要到 ~1010ms 才稳定 —— 中间 600 多毫秒里，首屏渲染正跟这些活抢主线程：
 *   · WebGL 渲染器挂载（字形图集栅格化很贵）
 *   · AI 看板的远端 `ps` + 本机进程表扫描
 *   · rollout 会话快照轮询
 *   · 静默的更新检查（要发网络请求）
 *
 * 所以这里只做两件事，且都**不改变行为**，只改"什么时候做"：
 *   1. `afterFirstPaint` —— 等浏览器真的 present 了一帧（两次 rAF）再执行；
 *   2. `deferUntilIdle` —— 等主线程空下来（`requestIdleCallback`）再执行，最多等 1.5 秒。
 */

/**
 * 等"首屏可以拿出手了"再执行。
 *
 * ⚠️ 这里**不能只用 rAF**：窗口是先隐藏创建、等这条 ready 才显示的，
 * 而 Chromium 对**隐藏/被遮挡**的页面会节流甚至不给 `requestAnimationFrame` ——
 * 只靠 rAF 会变成"永远不 ready、只能等后端 5 秒兜底"，那就把启动拖慢了。
 * 所以三条路谁先到算谁：
 *   1. **字体就绪**（字体晚到会让首屏重排一次，正是"画面又变一下"的来源之一）；
 *   2. 可见时用**两次 rAF**（最准的"已经 present 到屏幕上"）；
 *   3. 兜底**一个宏任务**（不管可见性一定会跑）—— 它保证 React 首屏已提交、DOM/CSSOM 备齐，
 *      浏览器在窗口显示时能**一次画完**，而不是边算边画。
 */
export function afterFirstPaint(fn: () => void): void {
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    fn();
  };
  const fonts = (document as Document & { fonts?: { ready?: Promise<unknown> } }).fonts;
  if (fonts?.ready) {
    void fonts.ready.then(run).catch(run);
  }
  window.setTimeout(run, 300);
  if (document.visibilityState === "visible" && typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => requestAnimationFrame(run));
  }
}

/**
 * 主线程空下来再做（首屏之后）。
 * 没有 `requestIdleCallback` 的宿主（部分 WebView / 老内核）退回 `setTimeout`。
 */
export function deferUntilIdle(fn: () => void, timeoutMs = 1500): void {
  const ric = (window as unknown as {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  }).requestIdleCallback;
  if (typeof ric === "function") {
    ric(() => fn(), { timeout: timeoutMs });
    return;
  }
  window.setTimeout(fn, 300);
}

/**
 * 把一个函数包成"首帧之后再跑"，返回可直接给 `useEffect` 用的取消函数。
 * 例：`useEffect(() => deferUntilIdle(() => void refreshBoard()), [])`
 */
export function runAfterFirstPaint(fn: () => void, timeoutMs = 1500): () => void {
  let cancelled = false;
  afterFirstPaint(() => {
    if (!cancelled) deferUntilIdle(fn, timeoutMs);
  });
  return () => {
    cancelled = true;
  };
}

/**
 * 把"某个启动阶段好了"记进应用日志（后端 `startup_mark` 只写日志，不改行为）。
 * 失败一律吞掉：这些标记是给人对比启动耗时用的，不该影响启动本身。
 */
export function startupMark(name: string): void {
  void invoke("startup_mark", { name }).catch(() => {});
}
