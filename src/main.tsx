import React from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import App from "./App";
import { afterFirstPaint } from "./startup";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";

// 安全护栏：预览里的链接/拖放不能让整个应用窗口被导航走。
// （远端文档内容一律视为不可信；后续可改成用系统浏览器打开。）
document.addEventListener("click", (e) => {
  const anchor = (e.target as HTMLElement | null)?.closest?.("a[href]");
  if (anchor) {
    e.preventDefault();
  }
});
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => e.preventDefault());

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// 首屏画好了：摘掉 index.html 里那块静态启动屏（它只为盖住"WebView2 还没画出来"的那一下），
// 再告诉后端"我画完了"（后端拿它记启动阶段耗时；窗口本身是可见创建的，原因见 lib.rs 的说明）。
// `.catch` 是给 fe-smoke 那种没有真后端的环境用的：这条命令不该让任何东西挂掉。
afterFirstPaint(() => {
  document.getElementById("boot")?.remove();
  void invoke("frontend_ready", { atMs: Math.round(performance.now()) }).catch(() => {});
});
