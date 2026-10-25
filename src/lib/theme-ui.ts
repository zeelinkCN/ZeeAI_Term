// 白屏兜底（ErrorBoundary）唯一能读到的那条主题线索。
//
// 为什么单独存一条：错误页在 `.app` 外面 —— App 崩了就没有 settings、没有 `.app.light`，
// fallback 只剩 localStorage 这一条能知道"上次是深色还是浅色"。


// ---------------------------------------------------------------------------
// 白屏兜底（ErrorBoundary）
// ---------------------------------------------------------------------------
/**
 * 最近一次界面是深色还是浅色。
 *
 * 为什么单独记一条：ErrorBoundary 在 `.app` 外面 —— 一旦 App 渲染崩了，`settings`
 * 和 `.app.light` 都没了，fallback 没有别的地方能知道主题。这里在正常渲染时把
 * 主题记到 localStorage；错误页只读这一条，读不到就跟随系统。
 */


export const UI_THEME_KEY = "zeeai.ui.theme-kind";

export function fallbackThemeIsLight(): boolean {
  try {
    const saved = localStorage.getItem(UI_THEME_KEY);
    if (saved === "light") return true;
    if (saved === "dark") return false;
  } catch {
    /* localStorage 不可用：往下走系统偏好 */
  }
  try {
    return window.matchMedia("(prefers-color-scheme: light)").matches;
  } catch {
    return false;
  }
}




