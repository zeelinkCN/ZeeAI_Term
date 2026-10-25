// 1 秒的纯 UI 时钟（只用来重算看板标签，不是探测）。


/**
 * 1 秒的**纯 UI 时钟**：只用来重算看板标签，不是探测。
 *
 * 为什么要有：卡片要显示"这个会话最近还有没有输出"，而输出活动（`src/activity.ts`）
 * 是一个内存 Map，`markOutput` 只写时间戳、不触发 React 更新 —— 没有时钟，界面就会
 * 一直停在"上一帧"的推断上。所以这里每秒把 `Date.now()` 放进 state，逼着渲染重算一次。
 *
 * 三条纪律：
 * - **回调里只有 `setNow(Date.now())`**：不 I/O、不发 IPC、不起子进程（也不是定时探测）；
 * - **只在 AI 面板打开时走**：看不见的卡片不需要每秒重算，面板一关就 `clearInterval`，
 *   不给主线程留一个永远在跳的定时器；
 * - 打开那一刻先对齐一次时间：否则会拿"上次关闭时"的旧值去判断"最近 5 秒有没有输出"，
 *   卡片会先闪一下"空闲"，再被 tick 纠正 —— 那是界面在说谎。
 */

import { useEffect, useState } from "react";

export function useUiClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}




