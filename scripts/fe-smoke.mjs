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
// 临时目录：优先用固定的 zeeai-fe-test；如果上一轮的 Edge 还占着（清理失败），
// 就换一个带时间戳的目录 —— 宁可换目录，也不要因为清理失败整轮跑不起来。
let OUT = join(tmpdir(), "zeeai-fe-test");
try {
  rmSync(OUT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
} catch {
  OUT = join(tmpdir(), `zeeai-fe-test-${Date.now()}`);
}
const SITE = join(OUT, "site");
const PORT = 8791;
// CDP 端口随机 + 每次一个新的 Edge profile 目录：
// 上一轮万一留下 Edge 进程（或用户自己在开 Edge），都不会和我们抢端口/抢 profile。
const CDP_PORT = 9300 + Math.floor(Math.random() * 650);
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
const resolveCmd = (cmd, args) => {
  const M = window.__ZEEAI_MOCK__;
  const S = window.__ZEEAI_SCENARIO__;
  switch (cmd) {
    case "list_profiles": return M.profiles;
    case "settings_get": return M.settings;
    // 历史列表：herdrHistory = 带一条 herdr 会话（验证"从侧栏点开也进 herdr"）。
    // 注意三个入口（list/save/remove）都要走同一份 —— 应用启动时恢复会话会调 history_save，
    // 如果那里返回真实列表，就会把场景数据覆盖掉（我自己踩过）。
    case "history_list": case "history_save": case "history_remove":
      return window.__ZEEAI_SCENARIO__.herdrHistory ? [{
        id: "h-herdr-wD",
        profileId: (M.profiles.find((p) => p.ssh && p.ssh.herdrEnabled) || {}).id,
        profileName: "lz",
        host: "47.99.241.168",
        tmuxSession: null,
        herdrPane: "wD:p1",
        herdrMode: "control",
        title: "lz · herdr wD:p1",
        lastUsed: 0,
      }] : M.history;
    // restoreHerdr = 让快照里带一条 herdr 会话（验证"重启后仍以 herdr 方式恢复"）
    case "workspace_load":
      return JSON.stringify(
        window.__ZEEAI_SCENARIO__.restoreHerdr
          ? {
              version: 1,
              savedAt: Date.now(),
              activeIndex: 0,
              sessions: [
                {
                  kind: "remote",
                  title: "lz · herdr wD:p1",
                  profileId: (window.__ZEEAI_MOCK__.profiles.find((p) => p.ssh && p.ssh.herdrEnabled) || {}).id,
                  user: "lz",
                  tmuxMode: "name",
                  herdrPane: "wD:p1",
                  herdrMode: "control",
                },
              ],
            }
          : window.__ZEEAI_SESSION__,
      );
    case "workspace_save": return null;
    case "update_install_kind": return "portable";
    case "update_take_result": return null;
    case "is_admin": return false;
    case "session_log_dir": return "C:\\\\Temp\\\\zeeai-logs";
    case "session_log_start": return "C:\\\\Temp\\\\zeeai-logs\\\\mock.log";
    case "session_log_stop": case "session_log_status": return null;
    case "ai_timeline_list": return [];
    case "ai_timeline_add": return false;
    // herdrProbePending = "探测一直不返回"（用来验证勾选框不会被禁用）
    case "ai_source_probe":
      if (S.herdrProbePending) return new Promise(() => {});
      // herdrProbeFail = "这一下没连上"（探测抛错 → 界面应显示可重试，而不是"没装"）
      if (S.herdrProbeFail) return Promise.reject(new Error("mock 探测失败"));
      // herdrNotInstalled = "探到了、但这台机器没装"（用来验证安装入口）
      if (S.herdrNotInstalled) {
        return { herdrVersion: "", herdrPath: "", agents: 0, protocol: 0, schemaVersion: 0, schemaFingerprint: "", compat: "unknown" };
      }
      return S.herdr;
    case "herdr_agents": return S.herdrAgents;
    // 接管列表用的是**所有窗格**（含没有 agent 的空壳窗格）
    case "herdr_panes":
      return S.herdrPanes || [
        { paneId: "w2:p1", title: "lz", cwd: "/home/lz", agent: "codex", status: "idle", focused: true },
        { paneId: "w9:p1", title: "lz", cwd: "/home/lz", agent: "", status: "unknown", focused: false },
      ];
    // herdr 服务状态（"装了"和"在跑"是两件事）
    case "herdr_server_status":
      return S.herdrServer || { running: true, panes: 3, raw: "status: running" };
    case "herdr_server_start": return "status: running";
    case "herdr_server_stop": return "stopped";
    // 服务器上的工作区 + 每个窗格的前台进程（"我们开着的会话"是另一回事；
    // 差集里那些「只停着 shell」的才算空壳，才允许被清理）
    case "herdr_workspace_scan":
      return S.herdrScan || {
        workspaces: ["w9", "wD", "wE"],
        panes: [
          { paneId: "w9:p1", procName: "bash" },
          { paneId: "wD:p1", procName: "bash" },
          { paneId: "wE:p1", procName: "claude" },
        ],
      };
    case "herdr_workspace_close": {
      const w = args?.workspaceId;
      if (S.herdrScan) S.herdrScan.workspaces = S.herdrScan.workspaces.filter((x) => x !== w);
      return "closed " + w;
    }
    case "herdr_pane_input_start": case "herdr_pane_type": case "herdr_pane_key":
    case "herdr_pane_resize": case "herdr_pane_input": return null;
    // herdr 快捷操作（白名单动作）
    case "herdr_pane_action": return "ok " + (args && args.action);
    case "herdr_workspace_create":
      if (window.__ZEEAI_SCENARIO__.createFails) {
        return Promise.reject(new Error("mock：建窗格失败"));
      }
      return "w9:p1";
    case "herdr_install":
      return {
        version: "0.9.1", protocol: 22, platform: "linux-x86_64",
        source: "官方·直连", sha256: "2a02fed1", bytes: 26207464, path: "$HOME/.local/bin/herdr",
      };
    case "settings_set": return null;
    case "ai_tasks_remote": return S.tasks;
    case "ai_tasks_local": return [];
    case "ai_tasks_clear_finished": return null;
    case "ai_session_snapshot": return null;
    case "ai_task_artifacts": return [];
    // 和真后端一样摆四个：两个默认（Codex / Claude）+ 两个"没听过"的（Aider / Gemini），
    // 用来验证"没装的、又不在默认名单里的不显示"
    case "ai_probe": return {
      npm: "10.0.0",
      running: [],
      tools: [
        { name: "codex", label: "OpenAI Codex CLI", installed: true, version: "0.9.1", installCmd: "npm i -g @openai/codex", runCmd: "codex" },
        { name: "claude", label: "Claude Code", installed: false, version: "", installCmd: "npm i -g @anthropic-ai/claude-code", runCmd: "claude" },
        { name: "aider", label: "Aider", installed: false, version: "", installCmd: "pip install aider-chat", runCmd: "aider" },
        { name: "gemini", label: "Gemini CLI", installed: false, version: "", installCmd: "npm i -g @google/gemini-cli", runCmd: "gemini" },
      ],
    };
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

try {
  rmSync(OUT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
} catch {
  /* 上一轮的残留占着也无所谓：下面 copyDir 会覆盖 */
}
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
const profileDir = join(OUT, "edge-profile-" + Date.now());
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
// 通用小工具（后面的多轮场景都会用）
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 重新加载页面：每一条新场景都从"刚启动"的干净状态开始 */
const reload = async () => {
  await send("Page.navigate", { url: targetUrl });
  await sleep(2600);
};
/**
 * 给"下一页"设一组场景开关。
 *
 * 关键点：注入的脚本是**累积**的（每次 navigate 都会按顺序跑一遍），所以每个场景都必须
 * 把**所有**开关显式写一遍 —— 否则上一个场景留下的开关会污染下一个场景
 *（我刚踩过：安装场景的 herdrNotInstalled 漏到接管场景，导致 herdr 勾选框变灰）。
 */
const setScenario = async (flags) => {
  const all = {
    herdrProbePending: false,
    herdrProbeFail: false,
    herdrNotInstalled: false,
    createFails: false,
    restoreHerdr: false,
    herdrHistory: false,
    ...flags,
  };
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: `if (window.__ZEEAI_SCENARIO__) Object.assign(window.__ZEEAI_SCENARIO__, ${JSON.stringify(all)});`,
  });
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

// ---------- herdr 服务生命周期：可见 + 可控（停止要二段确认） ----------
check(
  "AI 面板显示 herdr 服务状态（运行中 + 窗格数）",
  panel.includes("herdr 服务：运行中"),
  panel.split("\n").find((l) => l.includes("herdr 服务")) ?? "",
);
const stopArmed = await evaluate(`(() => {
  const b = [...document.querySelectorAll(".ai-panel button")].find((x) => (x.innerText || "").includes("停止服务"));
  if (!b) return { found: false };
  b.click();
  return { found: true };
})()`);
await new Promise((r) => setTimeout(r, 400));
const armed = await evaluate(`[...document.querySelectorAll(".ai-panel button")].map((b) => (b.innerText || "").trim())`);
check(
  "「停止服务」要二段确认（会关掉所有 herdr 窗格）",
  stopArmed.found && armed.some((t) => t.includes("确认停止")),
  armed.filter((t) => t.includes("停止") || t.includes("取消")).join(" | "),
);
// 取消掉，别把后面的用例带进"确认态"
await evaluate(`(() => {
  const b = [...document.querySelectorAll(".ai-panel button")].find((x) => (x.innerText || "").trim() === "取消");
  if (b) b.click();
})()`);

// ---------- herdr 工作区生命周期：挑出"空壳" + 二段确认清理 ----------
const wsLine = await evaluate(`(() => {
  const el = [...document.querySelectorAll(".ai-panel .hint")].find((x) => (x.innerText || "").includes("herdr 工作区"));
  return el ? (el.innerText || "").replace(/\\n/g, " / ") : "";
})()`);
check(
  "面板列出 herdr 工作区总数 + 没在用的数量",
  wsLine.includes("herdr 工作区：3 个") && wsLine.includes("3 个没在用"),
  wsLine || "(找不到那一行)",
);
const cleanBtnText = await evaluate(`(() => {
  const b = [...document.querySelectorAll(".ai-panel button")].find((x) => (x.innerText || "").includes("清理空壳"));
  return b ? (b.innerText || "").trim() : "";
})()`);
check(
  "3 个都没在用，但只有 2 个是空壳（wE 上跑着 claude，不许碰）",
  cleanBtnText.includes("清理空壳（2）"),
  cleanBtnText || "(没有清理按钮)",
);
const cleanArmed = await evaluate(`(() => {
  const b = [...document.querySelectorAll(".ai-panel button")].find((x) => (x.innerText || "").includes("清理空壳"));
  if (!b) return { found: false };
  b.click();
  return { found: true };
})()`);
await new Promise((r) => setTimeout(r, 400));
const cleanBtns = await evaluate(`[...document.querySelectorAll(".ai-panel button")].map((b) => (b.innerText || "").trim())`);
check(
  "清理工作区也要二段确认，并且把要关的工作区号写出来",
  cleanArmed.found && cleanBtns.some((t) => t.includes("确认清理") && t.includes("wD")),
  cleanBtns.filter((t) => t.includes("清理") || t.includes("取消")).join(" | "),
);
await evaluate(`(() => {
  const b = [...document.querySelectorAll(".ai-panel button")].find((x) => (x.innerText || "").includes("确认清理"));
  if (b) b.click();
})()`);
await new Promise((r) => setTimeout(r, 500));
const cleanResult = await evaluate(`(() => {
  const closeCalls = (window.__ZEEAI_CALLARGS__ || []).filter((c) => c.cmd === "herdr_workspace_close");
  return {
    calls: closeCalls.map((c) => c.args && c.args.workspaceId),
    status: (document.querySelector(".status-bar") || {}).innerText || "",
    others: (window.__ZEEAI_CALLARGS__ || []).filter((c) => c.cmd === "herdr_server_stop").length,
  };
})()`);
check(
  "确认后只关那 2 个空壳（正在跑 claude 的 wE 一个字节都不碰）",
  JSON.stringify(cleanResult.calls.slice().sort()) === JSON.stringify(["w9", "wD"]) &&
    cleanResult.others === 0,
  JSON.stringify(cleanResult),
);

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
// herdr 会话终端上方要有一条"一眼可见"的状态条（像 tmux 的状态栏）。
// 注意：标签栏是都渲染出来的，`.herdr-bar` 会有好几条（观察窗那条也有），
// 所以要看"可写那条"的文字 —— 也就是含「接管中（可写）」的那一条。
const herdrBar = await evaluate(`(() => {
  const bars = [...document.querySelectorAll(".herdr-bar")].map((b) => (b.innerText || "").trim());
  const ctrl = bars.find((t) => t.includes("接管中")) || "";
  return { ctrl, all: bars };
})()`);
check(
  "可写 herdr 会话上方有状态条（一眼看出进了 herdr、进的是哪个窗格）",
  herdrBar.ctrl.includes("herdr") &&
    herdrBar.ctrl.includes("w9:p1") &&
    herdrBar.ctrl.includes("接管中（可写）") &&
    herdrBar.ctrl.includes("服务运行中"),
  JSON.stringify(herdrBar).replace(/\\n/g, " / ").slice(0, 300),
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

// ---------- herdr 快捷操作栏（和 tmux 那条同构）----------
const herdrDock = await evaluate(`(() => {
  const dock = document.querySelector(".herdr-dock");
  if (!dock) return { found: false };
  return {
    found: true,
    head: (dock.querySelector(".tmux-head") || {}).innerText || "",
    btns: [...dock.querySelectorAll(".tmux-btn")].map((b) => (b.innerText || "").trim()),
    note: (dock.querySelector(".tmux-sub") || {}).innerText || "",
  };
})()`);
check(
  "当前会话是 herdr 时，左下角出现可折叠的「herdr 快捷操作」栏",
  herdrDock.found &&
    herdrDock.head.includes("herdr 快捷操作") &&
    herdrDock.head.includes("w9:p1") &&
    herdrDock.btns.includes("新建工作区") &&
    herdrDock.btns.includes("右分屏") &&
    herdrDock.btns.includes("关闭窗格"),
  JSON.stringify(herdrDock).slice(0, 280),
);
// 点「右分屏」→ 走 herdr_pane_action(split-right)，而且是那个窗格
await evaluate(`(() => {
  const dock = document.querySelector(".herdr-dock");
  const b = dock && [...dock.querySelectorAll(".tmux-btn")].find((x) => (x.innerText || "").trim() === "右分屏");
  if (b) b.click();
  return !!b;
})()`);
await sleep(700);
const actionCall = await evaluate(`(() => {
  const c = (window.__ZEEAI_CALLARGS__ || []).filter((x) => x.cmd === "herdr_pane_action").pop();
  return c ? { action: c.args.action, pane: c.args.pane, profileId: c.args.profileId } : null;
})()`);
check(
  "点「右分屏」→ 后端收到 herdr_pane_action(split-right) + 当前窗格",
  !!actionCall && actionCall.action === "split-right" && actionCall.pane === "w9:p1",
  JSON.stringify(actionCall),
);
// 会关东西的动作要二段确认：第一次点只是"上膛"
await evaluate(`(() => {
  const dock = document.querySelector(".herdr-dock");
  const b = dock && [...dock.querySelectorAll(".tmux-btn")].find((x) => (x.innerText || "").trim() === "关闭窗格");
  if (b) b.click();
  return !!b;
})()`);
await sleep(300);
const armedDock = await evaluate(`(() => {
  const dock = document.querySelector(".herdr-dock");
  return {
    btns: dock ? [...dock.querySelectorAll(".tmux-btn")].map((b) => (b.innerText || "").trim()) : [],
    calls: (window.__ZEEAI_CALLARGS__ || []).filter((x) => x.cmd === "herdr_pane_action").length,
  };
})()`);
check(
  "「关闭窗格」要二段确认（第一次点不会真的关）",
  armedDock.btns.includes("确认？") && armedDock.calls === 1,
  JSON.stringify(armedDock).slice(0, 200),
);
// 取消上膛，别把后面的用例带进去
await evaluate(`(() => {
  const dock = document.querySelector(".herdr-dock");
  const b = dock && [...dock.querySelectorAll(".tmux-btn")].find((x) => (x.innerText || "").trim() === "确认？");
  if (b) b.click();
})()`);
await sleep(500);
const afterConfirm = await evaluate(
  `(window.__ZEEAI_CALLARGS__ || []).filter((x) => x.cmd === "herdr_pane_action").map((x) => x.args.action)`,
);
check(
  "再点一次「确认？」才真的执行关闭窗格",
  Array.isArray(afterConfirm) && afterConfirm.includes("close-pane"),
  JSON.stringify(afterConfirm),
);
// 重命名走自绘输入框，不弹浏览器 prompt
await evaluate(`(() => {
  const dock = document.querySelector(".herdr-dock");
  const b = dock && [...dock.querySelectorAll(".tmux-btn")].find((x) => (x.innerText || "").trim() === "重命名窗格");
  if (b) b.click();
  return !!b;
})()`);
await sleep(300);
const renameBox = await evaluate(
  `(() => { const i = document.querySelector(".herdr-dock .tmux-rename input"); return i ? { found: true, value: i.value } : { found: false }; })()`,
);
check(
  "「重命名窗格」用自绘输入框（不弹浏览器 prompt）",
  renameBox.found,
  JSON.stringify(renameBox),
);

// ---------- PowerShell 面板：并排两个"新建"按钮（5.1 / 7）----------
await evaluate(`(() => {
  const nav = [...document.querySelectorAll("button")].find((b) => (b.title || "").includes("PowerShell"));
  if (nav) nav.click();
  return true;
})()`);
await new Promise((r) => setTimeout(r, 900));
const pwshBar = await evaluate(`[...document.querySelectorAll(".local-module .side-actions button")]
  .map((b) => ({ text: (b.innerText || "").trim(), title: b.title || "" }))`);
check(
  "PowerShell 面板有两个并排的新建按钮（5.1 / 7）",
  pwshBar.some((b) => b.text.includes("新建 PowerShell")) &&
    pwshBar.some((b) => b.text.includes("PowerShell 7")),
  pwshBar.map((b) => b.text).join(" | "),
);
await evaluate(`(() => {
  const b = [...document.querySelectorAll(".local-module .side-actions button")]
    .find((x) => (x.innerText || "").includes("PowerShell 7"));
  if (b) b.click();
  return !!b;
})()`);
await new Promise((r) => setTimeout(r, 1200));
const pwshCall = await evaluate(`(() => {
  const calls = window.__ZEEAI_CALLARGS__.filter((c) => c.cmd === "open_local");
  const last = calls.length ? calls[calls.length - 1].args : null;
  return last ? { shell: last.shell } : null;
})()`);
check(
  "点「PowerShell 7」时后端收到 shell=pwsh",
  !!pwshCall && pwshCall.shell === "pwsh",
  JSON.stringify(pwshCall),
);
const shot7 = await shot("07-powershell-7.png");

// ---------- (A4) 一键安装按钮：点了要真的调 herdr_install ----------
await setScenario({ herdrNotInstalled: true });
await reload();
await evaluate(`(() => {
  const b = [...document.querySelectorAll("button")].find((x) => (x.innerText || "").includes("新建会话"));
  if (b) b.click();
  return true;
})()`);
await sleep(2000);
const installBtn = await evaluate(`(() => {
  const b = [...document.querySelectorAll(".modal button")].find((x) => (x.innerText || "").includes("一键安装 herdr"));
  if (!b) return { found: false, text: (document.querySelector(".modal")?.innerText || "").slice(0, 200) };
  b.click();
  return { found: true };
})()`);
await sleep(1500);
const installCalled = await evaluate(
  `window.__ZEEAI_CALLARGS__.filter((c) => c.cmd === "herdr_install").length`,
);
check(
  "没装时点「一键安装 herdr」会真的发起安装",
  installBtn.found && installCalled >= 1,
  `按钮=${installBtn.found} 调用=${installCalled}`,
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
  oldName: document.body.innerText.includes("ZeeAI Terminal") || document.body.innerText.includes("ZEEAI TERM"),
  newName: document.body.innerText.includes("ZeeAI Term"),
})`);
check(
  "产品名统一成 ZeeAI Term（不再出现全大写或 Terminal 全称）",
  !naming.oldName && naming.newName,
  `出现 ZeeAI Term=${naming.newName}`,
);

// ---------- 回归：探测还没返回时，herdr 勾选框**必须能点** ----------
// （这正是用户"新建 herdr 窗口一直建不开"的根因：以前探测没回来就禁用，
//   用户点不动那个勾，点连接就悄悄开了个普通 shell。）
await setScenario({ herdrProbePending: true });
await reload();
await evaluate(`(() => {
  const b = [...document.querySelectorAll("button")].find((x) => (x.innerText || "").includes("新建会话"));
  if (b) b.click();
  return true;
})()`);
await new Promise((r) => setTimeout(r, 1500));
const pendingBox = await evaluate(`(() => {
  const labels = [...document.querySelectorAll(".modal .form-check")];
  const row = labels.find((l) => (l.innerText || "").includes("用 herdr 打开"));
  if (!row) return { found: false };
  const cb = row.querySelector("input[type=checkbox]");
  return { found: true, disabled: !!cb && cb.disabled, text: (row.innerText || "").trim() };
})()`);
check(
  "探测未返回时 herdr 勾选框仍可点（不再禁用）",
  pendingBox.found && pendingBox.disabled === false && pendingBox.text.includes("探测"),
  `disabled=${pendingBox.disabled} ${pendingBox.text}`,
);
const shot8 = await shot("08-herdr-probing.png");

// ================= 第二轮：把 herdr 剩下的 UI 路径全铺一遍 =================
// ---------- (A) 接管已有窗格：不能新建、要拿列表、要带 --takeover ----------
await setScenario({});
await reload();
await evaluate(`(() => {
  const b = [...document.querySelectorAll("button")].find((x) => (x.innerText || "").includes("新建会话"));
  if (b) b.click();
  return true;
})()`);
await sleep(1600);
await evaluate(`(() => {
  const radios = [...document.querySelectorAll(".modal .tmux-choice .form-check")];
  const r = radios.find((x) => (x.innerText || "").includes("接管已有窗格"));
  if (r) r.click();
  return !!r;
})()`);
await sleep(1200);
const takeoverList = await evaluate(`(() => {
  const items = [...document.querySelectorAll(".modal .attach-list .form-check")]
    .map((l) => (l.innerText || "").trim());
  const panes = window.__ZEEAI_CALLARGS__.filter((c) => c.cmd === "herdr_panes").length;
  return { items, panes };
})()`);
check(
  "选「接管已有窗格」会列出**所有窗格**（含没有 agent 的空壳窗格）",
  takeoverList.panes >= 1 &&
    takeoverList.items.some((t) => t.includes("w2:p1")) &&
    takeoverList.items.some((t) => t.includes("w9:p1")),
  `pane 调用 ${takeoverList.panes} 次；列表=${takeoverList.items.join(" | ")}`,
);
await evaluate(`(() => {
  const items = [...document.querySelectorAll(".modal .attach-list .form-check")];
  const t = items.find((l) => (l.innerText || "").includes("w2:p1"));
  if (t) t.querySelector("input").click();
  return !!t;
})()`);
await sleep(400);
const beforeCreate = await evaluate(
  `window.__ZEEAI_CALLARGS__.filter((c) => c.cmd === "herdr_workspace_create").length`,
);
await evaluate(`(() => {
  const b = [...document.querySelectorAll(".modal .modal-actions button")].find((x) => (x.innerText || "").trim() === "连接");
  if (b) b.click();
  return true;
})()`);
await sleep(2500);
const takeoverOpen = await evaluate(`(() => {
  const calls = window.__ZEEAI_CALLARGS__;
  const open = calls.filter((c) => c.cmd === "open_ssh").pop();
  return {
    backend: open ? open.args.backend : null,
    pane: open ? open.args.tmuxName : null,
    created: calls.filter((c) => c.cmd === "herdr_workspace_create").length,
  };
})()`);
check(
  "接管已有窗格：不新建，直接以 herdr-control 打开那个窗格",
  takeoverOpen.backend === "herdr-control" &&
    takeoverOpen.pane === "w2:p1" &&
    takeoverOpen.created === beforeCreate,
  JSON.stringify(takeoverOpen),
);
const shot9 = await shot("09-herdr-takeover.png");

// ---------- (A2) 从左侧会话列表点开 herdr 会话：也要进 herdr（不是普通 shell） ----------
await setScenario({ herdrHistory: true });
await reload();
await sleep(1200);
const historyRow = await evaluate(`(() => {
  const scen = "herdrHistory=" + window.__ZEEAI_SCENARIO__.herdrHistory;
  const rows = [...document.querySelectorAll(".tree-item")];
  const r = rows.find((x) => (x.innerText || "").includes("herdr wD:p1"));
  if (!r) return { found: false, scen, hist: JSON.stringify(window.__ZEEAI_MOCK__.history).slice(0, 120), all: rows.map((x) => (x.innerText || "").trim()).slice(0, 12) };
  r.click();
  return { found: true };
})()`);
await sleep(2500);
const fromHistory = await evaluate(`(() => {
  const open = window.__ZEEAI_CALLARGS__.filter((c) => c.cmd === "open_ssh").pop();
  return open ? { backend: open.args.backend, pane: open.args.tmuxName } : null;
})()`);
check(
  "从侧栏历史点开 herdr 会话 → 仍以 herdr 打开",
  historyRow.found && !!fromHistory && fromHistory.backend === "herdr-control" && fromHistory.pane === "wD:p1",
  `找到行=${historyRow.found} 结果=${JSON.stringify(fromHistory)} 场景=${historyRow.scen} 行文本=${JSON.stringify(historyRow.all)}`,
);
const hMark = await evaluate(
  `(() => { const m = document.querySelector(".tree-item .herdr-mark"); return m ? (m.getAttribute("title") || "") : ""; })()`,
);
check("侧栏会话列表用 H 标记 herdr 会话（像 tmux 的 T）", hMark.includes("herdr"), hMark.slice(0, 60));

// ---------- (A3) 新建窗格失败必须有可见报错（不能"卡着不动"） ----------
await setScenario({ createFails: true });
await reload();
await evaluate(`(() => {
  const b = [...document.querySelectorAll("button")].find((x) => (x.innerText || "").includes("新建会话"));
  if (b) b.click();
  return true;
})()`);
await sleep(1600);
await evaluate(`(() => {
  const b = [...document.querySelectorAll(".modal .modal-actions button")].find((x) => (x.innerText || "").trim() === "连接");
  if (b) b.click();
  return true;
})()`);
await sleep(2500);
const failNotice = await evaluate(`(() => {
  const bar = document.querySelector(".statusbar .status-notice");
  return { text: bar ? (bar.innerText || "").trim() : "", kind: bar ? bar.className : "", modalOpen: !!document.querySelector(".modal") };
})()`);
check(
  "新建窗格失败时状态栏给出报错（对话框不再无声卡住）",
  failNotice.text.includes("新建会话失败") && failNotice.kind.includes("error"),
  JSON.stringify(failNotice),
);
const shot11 = await shot("11-create-fail.png");

// ---------- (B) 看板卡片上的「接管」 ----------
await reload();
await evaluate(`(() => {
  const b = [...document.querySelectorAll("button")].find((x) => (x.title || "").includes("AI"));
  if (b) b.click();
  return !!b;
})()`);
await sleep(2600);
const cardButtons = await evaluate(`[...document.querySelectorAll(".ai-panel .ai-task-actions button")].map((b) => (b.innerText || "").trim())`);
await evaluate(`(() => {
  const b = [...document.querySelectorAll(".ai-panel .ai-task-actions button")].find((x) => (x.innerText || "").trim() === "接管");
  if (b) b.click();
  return !!b;
})()`);
await sleep(2200);
const cardTakeover = await evaluate(`(() => {
  const open = window.__ZEEAI_CALLARGS__.filter((c) => c.cmd === "open_ssh").pop();
  return open ? { backend: open.args.backend, pane: open.args.tmuxName } : null;
})()`);
check(
  "看板卡片「接管」→ herdr-control + 那个窗格",
  !!cardTakeover && cardTakeover.backend === "herdr-control" && cardTakeover.pane === "w2:p1",
  `按钮=${cardButtons.join(",")} 结果=${JSON.stringify(cardTakeover)}`,
);

// ---------- (C) 重启恢复：快照里的 herdr 会话要以 herdr 方式打开 ----------
await setScenario({ restoreHerdr: true });
await reload();
await sleep(2000);
const restored = await evaluate(`(() => {
  const calls = window.__ZEEAI_CALLARGS__;
  const opens = calls.filter((c) => c.cmd === "open_ssh");
  const last = opens.length ? opens[opens.length - 1] : null;
  return {
    count: opens.length,
    backend: last ? last.args.backend : null,
    pane: last ? last.args.tmuxName : null,
    tabs: [...document.querySelectorAll(".session-tab")].map((t) => (t.innerText || "").trim()),
  };
})()`);
check(
  "重启后 herdr 会话仍以 herdr 打开（不会被当成 tmux/普通 shell）",
  restored.backend === "herdr-control" && restored.pane === "wD:p1",
  JSON.stringify(restored),
);
const shot10 = await shot("10-restore-herdr.png");

// ---------- (D) 探测失败（null）：可以勾、点连接会强制重探 ----------
await setScenario({ herdrProbeFail: true });
await reload();
await evaluate(`(() => {
  const b = [...document.querySelectorAll("button")].find((x) => (x.innerText || "").includes("新建会话"));
  if (b) b.click();
  return true;
})()`);
await sleep(2200);
const failedProbeBox = await evaluate(`(() => {
  const row = [...document.querySelectorAll(".modal .form-check")].find((l) => (l.innerText || "").includes("用 herdr 打开"));
  if (!row) return { found: false };
  const cb = row.querySelector("input[type=checkbox]");
  return { found: true, disabled: !!cb && cb.disabled, text: (row.innerText || "").trim() };
})()`);
check(
  "探测失败时勾选框仍可点，并说明会重试",
  failedProbeBox.found && failedProbeBox.disabled === false && failedProbeBox.text.includes("探测失败"),
  `disabled=${failedProbeBox.disabled} ${failedProbeBox.text}`,
);
const probeCallsBefore = await evaluate(
  `window.__ZEEAI_CALLARGS__.filter((c) => c.cmd === "ai_source_probe").length`,
);
await evaluate(`(() => {
  const b = [...document.querySelectorAll(".modal .modal-actions button")].find((x) => (x.innerText || "").trim() === "连接");
  if (b) b.click();
  return true;
})()`);
await sleep(2500);
const retry = await evaluate(`(() => {
  const calls = window.__ZEEAI_CALLARGS__;
  const open = calls.filter((c) => c.cmd === "open_ssh").pop();
  return {
    probes: calls.filter((c) => c.cmd === "ai_source_probe").length,
    backend: open ? open.args.backend : null,
  };
})()`);
check(
  "点了连接会**强制重探**一次（不再被一次失败挡住）",
  retry.probes > probeCallsBefore,
  `ai_source_probe ${probeCallsBefore} → ${retry.probes}，open backend=${retry.backend}`,
);

// ---------- (D) 看板 ↔ 标签栏的映射：同一台机器上两个窗格 = 两张卡 ----------
//
// 用户实测：明明开了两个 codex（两个终端），看板上只有一个 —— 因为以前合并的粒度是
// 「环境+服务器+工具+目录」，同一个目录下的两个 codex 被并成了一张。
// setScenario 只对"下一次加载"生效，所以这里必须 reload 一次。
await setScenario({
  herdrAgents: [
    {
      kind: "codex", status: "blocked", cwd: "/home/lz", paneId: "w1P:p1",
      tabId: "w1P:t1", workspaceId: "w1P", title: "lz", focused: true, attention: true,
    },
    {
      kind: "codex", status: "working", cwd: "/home/lz", paneId: "w1R:p1",
      tabId: "w1R:t1", workspaceId: "w1R", title: "lz", focused: false, attention: false,
    },
  ],
});
await reload();
await evaluate(`(() => {
  const b = [...document.querySelectorAll("button")].find((x) => (x.title || "").includes("AI"));
  if (b) b.click();
  return !!b;
})()`);
await sleep(2600);
const twoCards = await evaluate(
  `[...document.querySelectorAll(".ai-panel .ai-task")].map((c) => (c.innerText || "").replace(/\\n/g, " / "))`,
);
check(
  "同一台机器、同一个目录里的两个 codex 显示成两张卡（不再并成一张）",
  twoCards.some((c) => c.includes("w1P:p1")) && twoCards.some((c) => c.includes("w1R:p1")),
  JSON.stringify(twoCards).slice(0, 240),
);
// 在 w1P:p1 那张卡上点「接管」→ 这个窗格作为标签开起来
await evaluate(`(() => {
  const c = [...document.querySelectorAll(".ai-panel .ai-task")].find((x) => (x.innerText || "").includes("w1P:p1"));
  const b = c && [...c.querySelectorAll("button")].find((x) => (x.innerText || "").trim() === "接管");
  if (b) b.click();
  return !!b;
})()`);
await sleep(2400);
const mapped = await evaluate(`(() => {
  const c = [...document.querySelectorAll(".ai-panel .ai-task")].find((x) => (x.innerText || "").includes("w1P:p1"));
  const tabs = [...document.querySelectorAll(".session-tab")].map((t) => (t.innerText || "").trim());
  return { card: c ? (c.innerText || "").replace(/\\n/g, " / ") : "", tabs: tabs.slice(0, 4) };
})()`);
check(
  "卡片写清它对着哪个终端标签，并把按钮换成「切到标签」",
  mapped.card.includes("已开在「") && mapped.card.includes("切到标签"),
  JSON.stringify(mapped).slice(0, 260),
);
// 打开过的窗格标签名里**不该出现两次窗格号**（以前 `w\\d+` 的坑：herdr 的号里有字母）
check(
  "标签名里窗格号不重复（`w1P:p1` 只出现一次）",
  mapped.tabs.some((t) => (t.match(/w1P:p1/g) || []).length === 1) &&
    !mapped.tabs.some((t) => (t.match(/w1P:p1/g) || []).length > 1),
  JSON.stringify(mapped.tabs),
);

// ---------- (E) 服务器右键 → 管理 herdr 工作区 ----------
await setScenario({});
await reload();
// 先打开 AI 面板（工具坞挂在它上面）
await evaluate(`(() => {
  const b = [...document.querySelectorAll("button")].find((x) => (x.title || "").includes("AI"));
  if (b) b.click();
  return !!b;
})()`);
await sleep(2200);
// 「AI 命令行工具」现在收在右下角：默认只剩一个小按钮，点开才展开
const dockClosed = await evaluate(`(() => {
  const b = document.querySelector(".tool-dock-btn");
  return { found: !!b, open: !!document.querySelector(".tool-dock-body"), text: b ? (b.innerText || "").trim() : "" };
})()`);
check(
  "「AI 命令行工具」默认收成右下角一个小按钮（不占看板空间）",
  dockClosed.found && !dockClosed.open,
  JSON.stringify(dockClosed),
);
await evaluate(`(() => {
  const b = document.querySelector(".tool-dock-btn");
  if (b) b.click();
})()`);
await sleep(400);
const dockOpen = await evaluate(`(() => {
  const body = document.querySelector(".tool-dock-body");
  if (!body) return { open: false, tools: [] };
  return { open: true, tools: [...body.querySelectorAll(".ai-tool-line .grow")].map((x) => (x.innerText || "").trim()) };
})()`);
check(
  "点开后列出工具，且没装的 Aider / Gemini 不再摆出来",
  dockOpen.open && !dockOpen.tools.some((t) => t.includes("Aider") || t.includes("Gemini")),
  JSON.stringify(dockOpen),
);

const mgrOpened = await evaluate(`(() => {
  const srv = document.querySelector(".tree-item.srv-node");
  if (!srv) return { found: false };
  srv.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 40, clientY: 40 }));
  return { found: true };
})()`);
await sleep(400);
const menuText = await evaluate(
  `[...document.querySelectorAll(".ctx-menu .menu-item")].map((b) => (b.innerText || "").trim())`,
);
check(
  "服务器右键菜单里有「管理 herdr 工作区」（和「管理 tmux 会话」并排）",
  mgrOpened.found && menuText.some((t) => t.includes("管理 herdr 工作区")) && menuText.some((t) => t.includes("管理 tmux 会话")),
  menuText.join(" | ").slice(0, 200),
);
await evaluate(`(() => {
  const b = [...document.querySelectorAll(".ctx-menu .menu-item")].find((x) => (x.innerText || "").includes("管理 herdr 工作区"));
  if (b) b.click();
  return !!b;
})()`);
await sleep(1600);
const mgr = await evaluate(`(() => {
  const p = document.querySelector(".herdr-panel");
  if (!p) return { found: false };
  return {
    found: true,
    rows: [...p.querySelectorAll(".herdr-ws-row")].map((r) => (r.innerText || "").replace(/\\n/g, " / ")),
    svc: (p.querySelector(".herdr-svc-row") || {}).innerText || "",
  };
})()`);
check(
  "「管理 herdr 工作区」列出这台机器上的每个工作区 + 服务状态",
  mgr.found &&
    mgr.rows.length === 3 &&
    mgr.rows.some((r) => r.includes("wD")) &&
    mgr.rows.some((r) => r.includes("claude")) &&
    mgr.svc.includes("服务运行中"),
  JSON.stringify(mgr).slice(0, 320),
);
// 「关掉」要二段确认（会连带关掉里面的窗格），并且把工作区号写在按钮上
await evaluate(`(() => {
  const r = [...document.querySelectorAll(".herdr-panel .herdr-ws-row")].find((x) => (x.innerText || "").includes("w9"));
  const b = r && [...r.querySelectorAll("button")].find((x) => (x.innerText || "").trim() === "关掉");
  if (b) b.click();
  return !!b;
})()`);
await sleep(400);
const armedRow = await evaluate(
  `[...document.querySelectorAll(".herdr-panel .herdr-ws-row button")].map((b) => (b.innerText || "").trim())`,
);
check(
  "管理面板里「关掉工作区」要二段确认，且按钮上写出要关的工作区号",
  armedRow.some((t) => t.includes("确认关掉 w9")),
  armedRow.join(" | ").slice(0, 160),
);

// ---------- (F) 尺寸闸门：整个跑测过程中不许出现"小得离谱"的 resize ----------
//
// 用户截图里那几个"折叠"的提示符，就是某一次按很窄的宽度排版留下的。
// 这里把跑测期间发给后端的所有尺寸都翻一遍。
const sizeCalls = await evaluate(`(() => {
  const bad = [];
  const all = [];
  for (const c of (window.__ZEEAI_CALLARGS__ || [])) {
    if (c.cmd !== "session_resize" && c.cmd !== "herdr_pane_resize") continue;
    const cols = c.args && (c.args.cols !== undefined ? c.args.cols : c.args[1]);
    const rows = c.args && (c.args.rows !== undefined ? c.args.rows : c.args[2]);
    all.push([c.cmd, cols, rows]);
    if (typeof cols === "number" && (cols < 40 || rows < 12)) bad.push([c.cmd, cols, rows]);
  }
  return { bad, n: all.length, sample: all.slice(0, 5) };
})()`);
check(
  "发给后端的尺寸没有小得离谱的（<40 列 / <12 行一律不发）",
  sizeCalls.bad.length === 0,
  `共 ${sizeCalls.n} 次，异常 ${JSON.stringify(sizeCalls.bad)} 抽样 ${JSON.stringify(sizeCalls.sample)}`,
);

console.log("\n--- 页面控制台里的 error/warning ---");
for (const c of consoleMsgs.slice(0, 15)) console.log("  " + c.slice(0, 200));
console.log(`\n截图：${shot1}\n${shot2}\n${shot3}\n${shot4}`);

ws.close();
// 结束整棵 Edge 进程树（只 kill 父进程会留下子进程占着 profile 目录和工作目录）
try {
  spawn("taskkill", ["/PID", String(edge.pid), "/T", "/F"], { stdio: "ignore" });
} catch {
  edge.kill();
}
server.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n结果：${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
