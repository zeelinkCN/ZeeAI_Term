// 整棵 React 树的兜底：把渲染异常变成一张能操作的错误页，而不是一片白屏。
//
// 为什么放在最外层（App 默认导出里包着）：以前任何一处渲染异常都会让 React 卸载整棵树，
// WebView 里只剩白屏，用户只能杀进程。`TestOnlyCrashProbe` 是 fe-smoke 的注入点
//（正常启动永远不抛，见它自己的说明）。


/**
 * 只给无头测试用的"渲染即抛错"探针。
 *
 * fe-smoke 在页面里写 `sessionStorage["zeeai:test:crash"] = "1"` 后 reload，
 * 下一帧就会抛错，用来验证 ErrorBoundary 真的接住了渲染异常。
 * **正常启动时这个键永远不存在**（生产代码里没有任何地方写它），所以不影响正常路径。
 */

import { fallbackThemeIsLight } from "../lib/theme-ui";
import { Component, useState } from "react";
import type { ErrorInfo, ReactNode } from "react";

export const TEST_CRASH_STORAGE_KEY = "zeeai:test:crash";

export function TestOnlyCrashProbe(): null {
  let crash = false;
  try {
    crash = sessionStorage.getItem(TEST_CRASH_STORAGE_KEY) === "1";
  } catch {
    crash = false;
  }
  if (crash) throw new Error("fe-smoke 注入的渲染异常（仅无头测试）");
  return null;
}

export interface AppErrorBoundaryState {
  error: Error | null;
}

/** 捕获整棵 React 树的渲染异常，显示可操作的错误页，而不是一片白。 */
export class AppErrorBoundary extends Component<
  { children: ReactNode },
  AppErrorBoundaryState
> {
  state: AppErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // 控制台留完整现场：错误页只给摘要，排查还得看栈
    console.error("[ZeeAI] 界面渲染异常", error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error) return <AppErrorFallback error={this.state.error} />;
    return this.props.children;
  }
}

async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* 没有剪贴板权限（或非安全上下文）：用老办法兜底 */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    ta.style.top = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/**
 * 错误页（fallback）。导出是为了让"错误页长什么样"能被单独引用/断言；
 * 正常路径只会在 ErrorBoundary 接住异常时渲染它。
 */
export function AppErrorFallback({ error }: { error: Error }) {
  const [copied, setCopied] = useState(false);
  const light = fallbackThemeIsLight();
  const message = error?.message || String(error);
  const stack = error?.stack || "";
  const full = `${error?.name || "Error"}: ${message}\n\n${stack}`;
  const shown =
    full.length > 6000 ? `${full.slice(0, 6000)}\n…（已截断，点「复制错误信息」拿完整内容）` : full;

  return (
    <div className={"error-boundary" + (light ? " light" : "")} role="alert">
      <div className="error-card">
        <div className="error-kicker">ZeeAI Term</div>
        <h1 className="error-title">界面出了点问题</h1>
        <p className="error-lead">
          这不是你的操作造成的 —— 是界面在渲染时遇到了一个错误。先点「重新加载」；
          如果反复出现，把下面的错误信息发给开发者。
        </p>
        <div className="error-actions">
          <button
            type="button"
            className="btn primary"
            onClick={() => window.location.reload()}
          >
            重新加载
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              void copyTextToClipboard(full).then((ok) => {
                if (ok) setCopied(true);
              });
            }}
          >
            {copied ? "已复制" : "复制错误信息"}
          </button>
        </div>
        <details className="error-details">
          <summary>错误摘要</summary>
          <pre className="error-pre">{shown}</pre>
        </details>
        <p className="error-note">会话和后端进程不受影响；重新加载后会按「恢复工作区」的设置回来。</p>
      </div>
    </div>
  );
}





