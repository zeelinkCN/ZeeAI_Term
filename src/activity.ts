/**
 * 会话的"最后一次输出时间"（纯内存）。
 *
 * 用途：让看板卡片**按输出活动推断**这条会话是不是还在跑 —— 收到输出 = 大概率在干活，
 * 静默一段时间 = 可能跑完了/在等输入。这是给 UI 的一层**推断**，不是第一手状态：
 * 真正的"运行中/等待输入/结束"要靠后端事件（OSC 133、进程退出、herdr 状态）那条线，
 * 这里的 Map 只做兜底和兜底之外的"最后一口气"。
 *
 * 刻意保持"三无"：**无定时器、无 I/O、无 IPC**。
 * 为什么：它被 xterm 的 onWriteParsed 每帧调用（终端刷屏时一秒可能几十上百次），
 * 里面只要有任何一个定时器/await，都会变成主线程上的噪音；而一个 Map 的 set 是 O(1)。
 * 也正因为无定时器，这里**不会自己过期** —— 判断"多久算静默"是调用方的事，它才知道
 * 每种会话的节奏（本地 shell 和 TUI 完全不是一回事）。
 */

/** sessionId -> 最后一次收到输出的时间戳（Date.now()） */
const lastOutputAt = new Map<string, number>();

/**
 * 记一次输出。
 *
 * `at` 默认取当下；留一个可传的参数，是为了测试/回放时能塞历史时间戳，
 * 也方便调用方（Terminal.tsx）在写入回调里用自己那一刻的 Date.now()。
 */
export function markOutput(sessionId: string, at: number = Date.now()): void {
  if (!sessionId) return;
  lastOutputAt.set(sessionId, at);
}

/** 最后一次输出时间；从没收到过输出（或已 clear）返回 undefined，调用方要当成"不知道"而不是 0 */
export function getLastOutput(sessionId: string): number | undefined {
  return lastOutputAt.get(sessionId);
}

/** 会话关掉/卸载时清掉，避免 Map 随着会话越来越多无限长（也没有必要保留已关闭会话的时间） */
export function clearOutput(sessionId: string): void {
  lastOutputAt.delete(sessionId);
}
