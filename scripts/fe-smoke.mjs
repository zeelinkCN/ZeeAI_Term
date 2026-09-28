// 前端功能测试（无头、零依赖、不弹窗口）
//
// 为什么这么写：
// - 界面是 React + Tauri IPC。要"不打扰用户地测界面"，就得把真实构建产物（dist/）
//   放到无头浏览器里跑，并且把 Tauri 的 invoke 换成一份可控的假后端；
// - 不引第三方依赖：静态服务用 node:http，浏览器用系统自带的 Edge（--headless=new），
//   驱动走 CDP（Node 24 自带 WebSocket）；
// - 断言用"页面里真实渲染出来的文字/元素"，不是看代码——测的是用户看到的东西。
//
// 用法：
//   npm run build          # 先产出 dist（脚本测的就是这份"要发出去的东西"）
//   npm run fe:smoke       # 跑一遍，截图落在 %TEMP%\zeeai-fe-test\
//
// 它会真的去点界面：打开 AI 面板、点「查看窗格」、在观察窗里敲键，
// 然后检查"后端收到的调用"是不是走对了通道 —— 全程不弹可见窗口。
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync, readdirSync, statSync } from "node:fs";
import { join, extname, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

// 仓库根目录 = 本文件的上一级（这样从任何目录调用都能跑）
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(tmpdir(), "zeeai-fe-test");
const SITE = join(OUT, "site");
const PORT = 8791;
const CDP_PORT = 9333;
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

const appData = join(process.env.APPDATA ?? "", "ZeeAI-Terminal");
const readJson = (name, fallback) => {
  try {
    return JSON.parse(readFileSync(join(appData, name), "utf8"));
  } catch {
    return fallback;
  }
};

const profiles = readJson("profiles.json", []);
// 为了验证"服务器配置里勾了默认用 herdr"这条链路：把 lz 那台的 herdrEnabled 打开
for (const p of profiles) {
  if (p.ssh) p.ssh.herdrEnabled = true;
}
const settings = readJson("settings.json", {});
const history = readJson("history.json", []);
// 诊断开关：把假后端换成"全空"，用来判断崩溃是"数据形状不对"还是"代码本身"
const MINIMAL = !!process.env.ZEEAI_FE_TEST_MINIMAL;
const KEEP = (process.env.ZEEAI_FE_TEST_KEEP ?? "profiles,settings,history").split(",");
if (MINIMAL) {
  console.log("（诊断模式：所有假后端返回空数据）");
}
const lz = profiles.find((p) => p.ssh && String(p.name).toLowerCase().includes("lz")) ?? profiles.find((p) => p.ssh);

// ---------- 1) 把 dist 拷出来，并在最前面注入"假后端" ----------
function copyDir(from, to) {
  mkdirSync(to, { recursive: true });
  for (const e of readdirSync(from)) {
    const a = join(from, e);
    const b = join(to, e);
    if (statSync(a).isDirectory()) copyDir(a, b);
    else {
      mkdirSync(dirname(b), { recursive: true });
      copyFileSync(a, b);
    }
  }
}

const mockScript = `
window.__ZEEAI_CALLS__ = [];
window.__ZEEAI_CALLARGS__ = [];
window.__ZEEAI_MOCK__ = ${JSON.stringify({
  profiles:
    MINIMAL || !KEEP.includes("profiles")
      ? []
      : process.env.ZEEAI_FE_TEST_PROFILE_TYPE
        ? profiles.filter((p) => p.type === process.env.ZEEAI_FE_TEST_PROFILE_TYPE)
        : profiles,
  settings: MINIMAL || !KEEP.includes("settings") ? {} : settings,
  history: MINIMAL || !KEEP.includes("history") ? [] : history,
})};
window.__ZEEAI_SCENARIO__ = {
  herdr: {
    herdrVersion: "0.9.1", herdrPath: "/home/lz/.local/bin/herdr", agents: 1,
    protocol: 22, schemaVersion: 1, schemaFingerprint: "226d4ecb", compat: "ok",
  },
  herdrAgents: [{
    kind: "codex", status: "blocked", cwd: "/home/lz/proj", paneId: "w2:p1",
    tabId: "w2:t1", workspaceId: "w2", title: "proj", focused: true, attention: true,
  }],
  tasks: [],
};
window.__ZEEAI_SESSION__ = ${JSON.stringify({
  version: 1,
  savedAt: Date.now(),
  activeIndex: 0,
  sessions: lz
    ? [{ kind: "remote", title: "lz · codex", profileId: lz.id, user: lz.ssh?.user, tmuxMode: "none" }]
    : [],
})};

const noop = () => {};
const resolveCmd = (cmd) => {
  const M = window.__ZEEAI_MOCK__;
  const S = window.__ZEEAI_SCENARIO__;
  switch (cmd) {
    case "list_profiles": return M.profiles;
    case "settings_get": return M.settings;
    case "history_list": return M.history;
    case "history_save": case "history_remove": return M.history;
    case "workspace_load": return JSON.stringify(window.__ZEEAI_SESSION__);
    case "workspace_save": return null;
    case "update_install_kind": return "portable";
    case "update_take_result": return null;
    case "is_admin": return false;
    case "session_log_dir": return "C:\\\\Temp\\\\zeeai-logs";
    case "session_log_start": return "C:\\\\Temp\\\\zeeai-logs\\\\mock.log";
    case "session_log_stop": case "session_log_status": return null;
    case "ai_timeline_list": return [];
    case "ai_timeline_add": return false;
    case "ai_source_probe": return S.herdr;
    case "herdr_agents": return S.herdrAgents;
    case "herdr_pane_input_start": case "herdr_pane_type": case "herdr_pane_key":
    case "herdr_pane_resize": case "herdr_pane_input": return null;
    case "herdr_workspace_create": return "w9:p1";
    case "settings_set": return null;
    case "ai_tasks_remote": return S.tasks;
    case "ai_tasks_local": return [];
    case "ai_tasks_clear_finished": return null;
    case "ai_session_snapshot": return null;
    case "ai_task_artifacts": return [];
    case "ai_probe": return { tools: [], npm: false, running: [] };
    case "tmux_list": return [];
    case "tmux_windows": return [];
    case "serial_list": return [];
    case "adb_version": return "1.0.41";
    case "adb_devices": return [];
    case "fastboot_version": return "";
    case "fastboot_devices": return [];
    case "fs_list": return { path: "/home/lz", entries: [] };
    case "open_external_url": case "open_in_explorer": return null;
    case "secret_has": return false;
    case "open_ssh": return {
      id: "mock-1", profileId: (window.__ZEEAI_SESSION__.sessions[0] || {}).profileId || "",
      // 跟真实后端一样：herdr 会话的标题里带上窗格号（用户要能一眼分清是哪个窗格）
      title:
        (args && (args.backend === "herdr-control" || args.backend === "herdr-pane") && args.tmuxName)
          ? "lz · herdr " + args.tmuxName
          : "lz · codex",
      kind: "ssh", tmuxSession: null, user: "lz", host: "47.99.241.168",
    };
    case "open_local": return { id: "mock-1", profileId: "", title: "PowerShell", kind: "local", tmuxSession: null, user: null, host: null };
    case "session_write": case "session_resize": case "session_close": return null;
    case "plugin:event|listen": return 1;
    case "plugin:event|unlisten": return null;
    default: return null;
  }
};
window.__TAURI_INTERNALS__ = {
  invoke: (cmd, args, options) => {
    window.__ZEEAI_CALLS__.push(cmd);
    window.__ZEEAI_CALLARGS__.push({ cmd, args: args ?? {} });
    return Promise.resolve(resolveCmd(cmd, args, options));
  },
  transformCallback: (cb, once) => {
    const id = Math.floor(Math.random() * 1e9);
    window["_" + id] = cb;
    return id;
  },
  convertFileSrc: (p) => p,
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
};
window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: noop };
`;

rmSync(OUT, { recursive: true, force: true });
copyDir(join(ROOT, "dist"), SITE);
// 用 CDP 的 addScriptToEvaluateOnNewDocument 注入（比改 HTML 更稳，dev server 也能用）

// ---------- 2) 静态服务（没有外部 URL 时用 dist） ----------
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" };
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  let file = join(SITE, decodeURIComponent(url.pathname));
  if (url.pathname === "/" || !existsSync(file)) file = join(SITE, "index.html");
  res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(PORT, r));

// ---------- 3) 无头 Edge + CDP ----------
const profileDir = join(OUT, "edge-profile");
const edge = spawn(
  EDGE,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${CDP_PORT}`,
    "--window-size=1400,900",
    "about:blank",
  ],
  { stdio: "ignore" },
);

async function waitJson(path, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}${path}`);
      if (r.ok) return await r.json();
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("无头浏览器没起来（CDP 连不上）");
}

const targets = await waitJson("/json/list");
const page = targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => {
  ws.onopen = r;
  ws.onerror = j;
});

let msgId = 0;
const pending = new Map();
const consoleMsgs = [];
const pageErrors = [];
let pausedFrameId = null;
let pausedFrames = [];
let pauseWaiters = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    return;
  }
  if (m.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(m.params.type)) {
    consoleMsgs.push(`[${m.params.type}] ` + m.params.args.map((a) => a.value ?? a.description ?? a.type).join(" "));
  }
  if (m.method === "Runtime.exceptionThrown") {
    pageErrors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
  }
  if (m.method === "Log.entryAdded" && m.params.entry.level === "error") {
    consoleMsgs.push(`[log] ${m.params.entry.text} ${m.params.entry.url ?? ""}`.trim());
  }
  if (m.method === "Debugger.paused") {
    pausedFrameId = m.params.callFrames[0].callFrameId;
    pausedFrames = m.params.callFrames.slice(0, 6).map((f) => ({
      fn: f.functionName || "(anon)",
      where: `${f.url || ""}:${f.location.lineNumber + 1}:${f.location.columnNumber + 1}`,
    }));
    pauseWaiters.splice(0).forEach((r) => r());
  }
};
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

await send("Runtime.enable");
await send("Log.enable");
await send("Page.enable");
await send("Page.addScriptToEvaluateOnNewDocument", { source: mockScript });
const targetUrl = process.env.ZEEAI_FE_TEST_URL || `http://127.0.0.1:${PORT}/`;
const DEBUG = !!process.env.ZEEAI_FE_TEST_DEBUG;
if (DEBUG) {
  await send("Debugger.enable");
  await send("Debugger.setPauseOnExceptions", { state: "uncaught" });
}
await send("Page.navigate", { url: targetUrl });
await new Promise((r) => setTimeout(r, 3500));

if (DEBUG && pausedFrameId) {
  console.log("---- 异常现场（真实位置 + 变量）----");
  for (const f of pausedFrames) console.log(`  ${f.fn} @ ${f.where}`);
  for (const expr of [
    "typeof history",
    "Array.isArray(history)",
    "typeof list",
    "typeof p",
    "typeof profiles",
    "typeof settings",
    "JSON.stringify(Object.keys(settings || {}).slice(0,40))",
  ]) {
    try {
      const r = await send("Debugger.evaluateOnCallFrame", {
        callFrameId: pausedFrameId,
        expression: expr,
        returnByValue: true,
      });
      console.log(`  ${expr} = ${JSON.stringify(r.result?.value ?? r.result?.description ?? null)}`);
    } catch (e) {
      console.log(`  ${expr} = <失败 ${String(e).slice(0, 80)}>`);
    }
  }
  await send("Debugger.resume");
  await new Promise((r) => setTimeout(r, 1200));
}

const evaluate = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "evaluate 失败");
  return r.result.value;
};
const shot = async (name) => {
  const r = await send("Page.captureScreenshot", { format: "png" });
  const p = join(OUT, name);
  writeFileSync(p, Buffer.from(r.data, "base64"));
  return p;
};

// ---------- 4) 断言 ----------
const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok, extra });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  | " + extra : ""}`);
};

const shot1 = await shot("01-default.png");
const text1 = await evaluate("document.body.innerText");
const buttons = await evaluate(
  `[...document.querySelectorAll("button")].map((b) => ((b.title || "") + "|" + (b.innerText || "").trim().slice(0, 12) + "|" + b.className).slice(0, 70)).slice(0, 40)`,
);
console.log("---- 页面上的按钮（title|文字|class）----");
for (const b of buttons) console.log("  " + b);
check("启动后渲染出界面（不是白屏）", text1.includes("ZeeAI") || text1.includes("终端"), `${text1.length} 字`);
check("没有 JS 崩溃", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 300));
if (pageErrors.length) {
  console.log("---- 崩溃栈（完整）----");
  console.log(pageErrors[0].split("\n").slice(0, 12).join("\n"));
}
if (consoleMsgs.length) {
  console.log("---- 页面控制台（诊断）----");
  for (const c of consoleMsgs.slice(0, 8)) console.log("  " + c.replace(/\n/g, "\n  ").slice(0, 900));
}
const calls = await evaluate("window.__ZEEAI_CALLS__");
check("启动时的后端调用都在预期内", calls.includes("list_profiles") && calls.includes("settings_get"), [...new Set(calls)].join(","));

// 打开 AI 面板（点左侧活动栏的 AI 按钮）
const opened = await evaluate(`(() => {
  const btns = [...document.querySelectorAll("button")];
  const b = btns.find((x) => (x.title || "").includes("AI")) || btns.find((x) => x.className.includes("ai"));
  if (!b) return "no-button";
  b.click();
  return "clicked";
})()`);
await new Promise((r) => setTimeout(r, 2500));
const shot2 = await shot("02-ai-panel.png");
const panel = await evaluate("document.querySelector('.ai-panel') ? document.querySelector('.ai-panel').innerText : ''");
check("AI 面板能打开", opened === "clicked" && panel.length > 0, `打开方式=${opened}`);
check("面板显示状态来源 = herdr", panel.includes("状态来源：herdr 0.9.1"), panel.split("\n").find((l) => l.includes("herdr")) ?? "");
check("herdr 卡片显示「等你处理」", panel.includes("等你处理"));
check("herdr 卡片带「查看窗格」入口", panel.includes("查看窗格"));
check("卡片标了来源 = herdr 状态", panel.includes("herdr 状态"));
check("装了 herdr 时不显示一键安装", !panel.includes("一键安装"));

// ---------- 点「查看窗格」：应当开一个 herdr-pane 观察窗，并建立输入通道 ----------
const clickedPane = await evaluate(`(() => {
  const p = document.querySelector(".ai-panel");
  const b = [...p.querySelectorAll("button")].find((x) => (x.innerText || "").includes("查看窗格"));
  if (!b) return false;
  b.click();
  return true;
})()`);
await new Promise((r) => setTimeout(r, 2500));
const afterPane = await evaluate(`(() => {
  const calls = window.__ZEEAI_CALLARGS__;
  const open = calls.filter((c) => c.cmd === "open_ssh").pop();
  return {
    openBackend: open ? open.args.backend : null,
    openPane: open ? (open.args.tmuxName ?? null) : null,
    inputStart: calls.filter((c) => c.cmd === "herdr_pane_input_start").map((c) => c.args.paneId),
    tabs: [...document.querySelectorAll(".session-tab")].map((t) => (t.innerText || "").trim()),
    hasTerm: !!document.querySelector(".xterm"),
  };
})()`);
check("「查看窗格」开出的是只读观察窗", clickedPane && afterPane.openBackend === "herdr-pane", `backend=${afterPane.openBackend} pane=${afterPane.openPane}`);
check("观察窗建立了输入通道", afterPane.inputStart.includes("w2:p1"), afterPane.inputStart.join(","));
check("观察窗标签出现在标签栏", afterPane.tabs.some((t) => t.includes("codex")), afterPane.tabs.join(" / "));
const shot5 = await shot("05-herdr-pane.png");

// ---------- 在观察窗里打字：应当走 herdrPaneType/Key，而不是写本地 PTY ----------
await evaluate(`(() => {
  const ta = document.querySelector(".xterm-helper-textarea");
  if (ta) ta.focus();
  return !!ta;
})()`);
for (const ch of ["h", "i"]) {
  await send("Input.dispatchKeyEvent", { type: "keyDown", text: ch, key: ch, unmodifiedText: ch });
}
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
await new Promise((r) => setTimeout(r, 1200));
const typed = await evaluate(`(() => {
  const t = window.__ZEEAI_CALLARGS__.filter((c) => c.cmd === "herdr_pane_type");
  const k = window.__ZEEAI_CALLARGS__.filter((c) => c.cmd === "herdr_pane_key");
  const w = window.__ZEEAI_CALLARGS__.filter((c) => c.cmd === "session_write");
  return { text: t.map((c) => c.args.text).join(""), keys: k.map((c) => c.args.key), writes: w.length };
})()`);
check(
  "观察窗里的按键走 herdr 自己的通道（没写本地 PTY）",
  typed.text.includes("hi") && typed.keys.includes("enter") && typed.writes === 0,
  `文本=${JSON.stringify(typed.text)} 按键=${typed.keys.join(",")} 本地写入=${typed.writes}`,
);

// 切成"没装 herdr"，再看安装入口是否出现
await evaluate(`window.__ZEEAI_SCENARIO__.herdr = { herdrVersion: "", herdrPath: "", agents: 0, protocol: 0, schemaVersion: 0, schemaFingerprint: "", compat: "unknown" };`);
await evaluate(`(() => {
  const p = document.querySelector(".ai-panel");
  const b = [...p.querySelectorAll("button")].find((x) => (x.title || "").includes("重新探测") || (x.title || "").includes("刷新"));
  const src = p.querySelector(".ai-source-line");
  if (src) src.click(); else if (b) b.click();
  return true;
})()`);
await new Promise((r) => setTimeout(r, 2000));
const panel2 = await evaluate("document.querySelector('.ai-panel').innerText");
const shot3 = await shot("03-herdr-missing.png");
check("没装 herdr 时给出「一键安装 herdr」", panel2.includes("一键安装 herdr"), panel2.split("\n").find((l) => l.includes("herdr")) ?? "");

// 新建会话对话框：herdr 那行不该再有"代替 tmux"的勾
// 先把场景切回"这台机器装了 herdr"（上面为了验证"没装时给安装入口"临时改成过没装），
// 并点一次"状态来源"强制重探，让应用里那份按服务器缓存的结果也刷新过来。
await evaluate(`(() => {
  window.__ZEEAI_SCENARIO__.herdr = {
    herdrVersion: "0.9.1", herdrPath: "/home/lz/.local/bin/herdr", agents: 1,
    protocol: 22, schemaVersion: 1, schemaFingerprint: "226d4ecb", compat: "ok",
  };
  const src = document.querySelector(".ai-panel .ai-source-line");
  if (src) src.click();
  return true;
})()`);
await new Promise((r) => setTimeout(r, 1800));
const dialog = await evaluate(`(() => {
  const btns = [...document.querySelectorAll("button")];
  const b = btns.find((x) => (x.innerText || "").trim() === "新建会话");
  if (!b) return null;
  b.click();
  return true;
})()`);
await new Promise((r) => setTimeout(r, 1500));
const shot4 = await shot("04-new-session.png");
const modalText = await evaluate("document.querySelector('.modal') ? document.querySelector('.modal').innerText : ''");
check("新建会话里不再出现「用 herdr 代替 tmux」", !modalText.includes("代替 tmux"), modalText.split("\n").find((l) => l.toLowerCase().includes("herdr")) ?? "");

// ---------- herdr 勾选框 / 默认值（服务器配置决定）/ 直接进她的环境 ----------
const herdrBox = await evaluate(`(() => {
  const labels = [...document.querySelectorAll(".modal .form-check")];
  const row = labels.find((l) => (l.innerText || "").includes("用 herdr 打开"));
  if (!row) return { found: false };
  const cb = row.querySelector("input[type=checkbox]");
  return { found: true, checked: !!cb && cb.checked, disabled: !!cb && cb.disabled, text: (row.innerText || "").trim() };
})()`);
check(
  "herdr 是真勾选框，且按服务器配置默认打勾",
  herdrBox.found && herdrBox.checked && !herdrBox.disabled,
  `checked=${herdrBox.checked} disabled=${herdrBox.disabled} ${herdrBox.text}`,
);
const kinds = await evaluate(
  `[...document.querySelectorAll(".modal .tmux-choice .form-check")].map((l) => (l.innerText || "").trim())`,
);
check(
  "勾了 herdr 之后给「新建窗格 / 接管已有窗格」两个选择",
  kinds.some((t) => t.includes("新建一个 herdr 窗格")) &&
    kinds.some((t) => t.includes("接管已有窗格")),
  kinds.join(" | "),
);
check("勾了 herdr 就不显示 tmux 那条", !modalText.includes("使用 tmux（断网后可回到同一个会话）"), "");
const shot4b = await shot("04b-herdr-checked.png");

// 点「连接」：应当先 herdr_workspace_create 新建窗格，再用 herdr-control 打开它
await evaluate(`(() => {
  const b = [...document.querySelectorAll(".modal .modal-actions button")].find(
    (x) => (x.innerText || "").trim() === "连接",
  );
  if (b) b.click();
  return true;
})()`);
await new Promise((r) => setTimeout(r, 2500));
const controlSession = await evaluate(`(() => {
  const calls = window.__ZEEAI_CALLARGS__;
  const created = calls.filter((c) => c.cmd === "herdr_workspace_create").length;
  const open = calls.filter((c) => c.cmd === "open_ssh").pop();
  return {
    created,
    backend: open ? open.args.backend : null,
    pane: open ? (open.args.tmuxName ?? null) : null,
    tabs: [...document.querySelectorAll(".session-tab")].map((t) => (t.innerText || "").trim()),
  };
})()`);
check(
  "连接时先新建 herdr 窗格，再以可写方式打开",
  controlSession.created >= 1 &&
    controlSession.backend === "herdr-control" &&
    controlSession.pane === "w9:p1",
  `create=${controlSession.created} backend=${controlSession.backend} pane=${controlSession.pane}`,
);
check(
  "标签栏出现这个可写 herdr 会话",
  controlSession.tabs.some((t) => t.includes("w9:p1")),
  controlSession.tabs.join(" / "),
);

// 在可写会话里打字：应当走 herdr_pane_input（原始字节），而不是观察窗那条 send-text
await evaluate(`(() => {
  const ta = document.querySelector(".xterm-helper-textarea");
  if (ta) ta.focus();
  return !!ta;
})()`);
// 观察窗那边刚才已经打过字（那走的是 herdr_pane_type），所以这里要**看增量**
const typeCallsBefore = await evaluate(
  `window.__ZEEAI_CALLARGS__.filter((c) => c.cmd === "herdr_pane_type").length`,
);
await send("Input.dispatchKeyEvent", { type: "keyDown", text: "l", key: "l", unmodifiedText: "l" });
await send("Input.dispatchKeyEvent", {
  type: "keyDown",
  key: "Enter",
  code: "Enter",
  windowsVirtualKeyCode: 13,
  text: "\r",
});
await new Promise((r) => setTimeout(r, 1000));
const typedInControl = await evaluate(`(() => {
  const inp = window.__ZEEAI_CALLARGS__.filter((c) => c.cmd === "herdr_pane_input");
  const txt = window.__ZEEAI_CALLARGS__.filter((c) => c.cmd === "herdr_pane_type");
  return { inputBytes: inp.length, first: inp.length ? inp[0].args.dataB64 : null, typeCalls: txt.length };
})()`);
check(
  "可写 herdr 会话里的按键走 herdr_pane_input（不是观察窗那条）",
  typedInControl.inputBytes >= 2 && typedInControl.typeCalls === typeCallsBefore,
  `input=${typedInControl.inputBytes} type 增量=${typedInControl.typeCalls - typeCallsBefore} 首个=${typedInControl.first}`,
);

// ---------- 通知策略可配 ----------
const openedSettings = await evaluate(`(() => {
  const gear = [...document.querySelectorAll("button")].find((b) => (b.title || "").includes("设置"));
  if (gear) gear.click();
  return !!gear;
})()`);
await new Promise((r) => setTimeout(r, 900));
const clickedNav = await evaluate(`(() => {
  const nav = [...document.querySelectorAll(".settings-nav-item")].find((n) =>
    (n.innerText || "").includes("通知"),
  );
  if (nav) nav.click();
  return !!nav;
})()`);
await new Promise((r) => setTimeout(r, 900));
const notifyBoxes = await evaluate(`[...document.querySelectorAll(".modal input[type=checkbox]")]
  .map((i) => ({ checked: i.checked, label: (i.closest("label")?.innerText || "").trim() }))
  .filter((b) => b.label.includes("告诉我") || b.label.includes("产物"))`);
const shot6 = await shot("06-settings-notify.png");
const pick = (kw) => notifyBoxes.find((b) => b.label.includes(kw));
check(
  "设置里能配通知：默认「产出文档提醒 + 等你做选择题」开着",
  !!pick("产出了文档")?.checked && !!pick("等我做选择题")?.checked,
  notifyBoxes.map((b) => `${b.label.slice(0, 14)}=${b.checked}`).join(" | "),
);
check(
  "「每一轮跑完都告诉我」默认关（小任务不再吵）",
  pick("每一轮跑完")?.checked === false,
  pick("每一轮跑完")?.label ?? "没找到这一项",
);
await evaluate(`(() => {
  const boxes = [...document.querySelectorAll(".modal input[type=checkbox]")];
  const t = boxes.find((i) => (i.closest("label")?.innerText || "").includes("每一轮跑完"));
  if (t) { t.click(); return true; }
  return false;
})()`);
await new Promise((r) => setTimeout(r, 900));
const settingsWrite = await evaluate(`(() => {
  const calls = window.__ZEEAI_CALLARGS__.filter((c) => c.cmd === "settings_set");
  const last = calls.length ? calls[calls.length - 1].args.settings : null;
  return last ? { complete: last.aiNotifyComplete, docs: last.aiNotifyDocs, needs: last.aiNotifyNeedsYou } : null;
})()`);
check(
  "改动立刻写回设置（aiNotifyComplete=true）",
  !!settingsWrite && settingsWrite.complete === true,
  JSON.stringify(settingsWrite),
);
const naming = await evaluate(`({
  oldName: document.body.innerText.includes("ZeeAI Terminal"),
  newName: document.body.innerText.includes("ZEEAI TERM"),
})`);
check("界面文案统一成 ZEEAI TERM（不再出现 ZeeAI Terminal）", !naming.oldName, `ZEEAI TERM=${naming.newName}`);

console.log("\n--- 页面控制台里的 error/warning ---");
for (const c of consoleMsgs.slice(0, 15)) console.log("  " + c.slice(0, 200));
console.log(`\n截图：${shot1}\n${shot2}\n${shot3}\n${shot4}`);

ws.close();
edge.kill();
server.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n结果：${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
