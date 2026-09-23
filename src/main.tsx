import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
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
