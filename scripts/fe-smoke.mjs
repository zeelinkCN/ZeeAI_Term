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
// 测试必须能"启动即恢复会话"，否则后面几十条都会假失败（我踩过：用户在设置里把
// 「启动时恢复上次的工作空间」关掉之后，整轮 41/67 —— 看着像代码坏了，其实是设置变了）。
// 和上面给 lz 打开 herdrEnabled 是一个道理：只改测试用的这份副本，不动用户的文件。
settings.restoreWorkspace = true;
// 同理：终端那几个"习惯项"也**固定成默认值**再跑。
// 为什么：应用跑过之后会把这些值持久化进真实的 settings.json（我自己就撞到过：
// 某轮跑完 pasteToast=true / copyKey=select 留在文件里，下一轮"默认不勾"那两条断言假失败）。
// 测试要断言"默认行为"，就必须自己把默认值钉死；想测别的口径的用例用 settingsPatch 显式覆盖。
settings.pasteToast = false;
settings.pasteKey = "both";
settings.rightClick = "menu";
settings.copyKey = "ctrl-shift-c";
settings.pasteDir = "~/.zeeai/paste";
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
    herdrVersion: "0.9.1", herdrPath: "/home/user/.local/bin/herdr", agents: 1,
    protocol: 22, schemaVersion: 1, schemaFingerprint: "226d4ecb", compat: "ok",
  },
  herdrAgents: [{
    kind: "codex", status: "blocked", cwd: "/home/user/proj", paneId: "w2:p1",
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
    case "settings_get": return Object.assign({}, M.settings, S.settingsPatch || {});
    // 历史列表：herdrHistory = 带一条 herdr 会话（验证"从侧栏点开也进 herdr"）。
    // 注意三个入口（list/save/remove）都要走同一份 —— 应用启动时恢复会话会调 history_save，
    // 如果那里返回真实列表，就会把场景数据覆盖掉（我自己踩过）。
    case "history_list": case "history_save": case "history_remove":
      return window.__ZEEAI_SCENARIO__.herdrHistory ? [{
        id: "h-herdr-wD",
        profileId: (M.profiles.find((p) => p.ssh && p.ssh.herdrEnabled) || {}).id,
        profileName: "lz",
        host: "192.0.2.45",
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
        { paneId: "w2:p1", title: "lz", cwd: "/home/user", agent: "codex", status: "idle", focused: true },
        { paneId: "w9:p1", title: "lz", cwd: "/home/user", agent: "", status: "unknown", focused: false },
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
    case "fs_list": return { path: "/home/user", entries: [] };
    // 粘贴/拖拽那条链路：落盘（后端把字节写进临时文件）→ 上传 → 把远端路径插进输入行。
    // 这里只回一个假路径；真正"路径怎么拼"是前端算的，所以断言看的是 fs_upload 的参数
    // 和随后写进终端的那段文字。
    // 注意：这段假后端是用模板字符串注入页面的，反斜杠会被吃掉一层，
    // 所以这里用正斜杠 —— 前端的 basename 两种斜杠都切，不影响被测逻辑。
    case "paste_save_file": return "C:/Temp/zeeai-paste/paste-test.png";
    // 附件统一"收进"粘贴临时目录：上传 / 预览 / 清理都只认这一个目录
    case "paste_adopt_file": return "C:/Temp/zeeai-paste/paste-adopted.png";
    // 1×1 透明 PNG —— 够验证"缩略图真的渲染出来了"
    case "paste_read_thumb": return "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    case "paste_discard_file": return null;
    case "fs_mkdir": return null;
    case "fs_upload": return "上传完成";
    // 文件选择器（「＋ 添加图片 / 文件」）：返回一个假路径，交给同一条上传管道
    case "plugin:dialog|open": return "C:/Temp/zeeai-paste/picker-shot.png";
    case "open_external_url": case "open_in_explorer": return null;
    case "secret_has": return false;
    case "open_ssh": return {
      id: "mock-1", profileId: (window.__ZEEAI_SESSION__.sessions[0] || {}).profileId || "",
      // 跟真实后端一样：herdr 会话的标题里带上窗格号（用户要能一眼分清是哪个窗格）
      title:
        (args && (args.backend === "herdr-control" || args.backend === "herdr-pane") && args.tmuxName)
          ? "lz · herdr " + args.tmuxName
          : "lz · codex",
      kind: "ssh", tmuxSession: null, user: "lz", host: "192.0.2.45",
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
/** 带裁剪 + 缩放的截图：用来把一个小图标放大到看得清（例如细栏上那两条箭头） */
const shotClip = async (name, clip) => {
  const r = await send("Page.captureScreenshot", { format: "png", clip });
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
    // 覆盖设置（例如强制浅色主题）。**必须显式写 null**：注入脚本是累积的，
    // 少了这一条，下一个场景会继承上一个场景的主题。
    settingsPatch: null,
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
    herdrVersion: "0.9.1", herdrPath: "/home/user/.local/bin/herdr", agents: 1,
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

// ---------- 输入窗不许盖住终端（herdr 会话最容易踩：终端上方还有一条状态条） ----------
// 用户截图：收起态的细栏盖住了终端最后一行。根因是 `.terminal-host` 写死 height:100%，
// 按"整个框"算高度、忽略了同一层里的 `.herdr-bar`，而 `.term-wrap` 又没有 overflow:hidden
// → 多出来的那一条直接画到了下面的输入窗上。
const measureFit = () =>
  evaluate(`(() => {
    const wrap = [...document.querySelectorAll(".term-wrap")].find(
      (w) => w.offsetParent !== null && w.getBoundingClientRect().height > 0);
    const bar = document.querySelector(".composer");
    const host = wrap ? wrap.querySelector(".terminal-host") : null;
    if (!wrap || !bar || !host) return null;
    const w = wrap.getBoundingClientRect(), b = bar.getBoundingClientRect(), h = host.getBoundingClientRect();
    const ws = getComputedStyle(wrap), hs = getComputedStyle(host);
    return {
      wrapBottom: Math.round(w.bottom), wrapTop: Math.round(w.top), wrapH: Math.round(w.height),
      wrapDisplay: ws.display, wrapDir: ws.flexDirection, wrapOverflow: ws.overflow,
      barTop: Math.round(b.top), barH: Math.round(b.height),
      hostTop: Math.round(h.top), hostBottom: Math.round(h.bottom), hostH: Math.round(h.height),
      hostCss: hs.height, hostFlex: hs.flex,
    };
  })()`);
const fitCollapsed = await measureFit();
const shotFitCollapsed = await shot("18-composer-collapsed-fit.png");
await evaluate(`(() => {
  const b = document.querySelector(".composer-bar");
  if (b) b.click();
  return !!b;
})()`);
await sleep(800);
const fitOpen = await measureFit();
const shotFitOpen = await shot("19-composer-expanded-fit.png");
await evaluate(`(() => {
  const b = document.querySelector(".composer-bar");
  if (b) b.click();
  return !!b;
})()`);
await sleep(500);
// 把焦点还给"看得见那个终端"：上面点过输入窗细栏，焦点留在了按钮上，
// 不还回去的话后面"在终端里打字"的用例会打空（0 次调用）。
await evaluate(`(() => {
  const wrap = [...document.querySelectorAll(".term-wrap")].find((w) => w.offsetParent !== null);
  const ta = wrap && wrap.querySelector(".xterm-helper-textarea");
  if (ta) { ta.focus(); return true; }
  return false;
})()`);
check(
  "输入窗（收起态）不盖住终端：终端底边在细栏上边之上，终端高度 > 0",
  !!fitCollapsed &&
    fitCollapsed.wrapBottom <= fitCollapsed.barTop &&
    fitCollapsed.barH <= 32 &&
    fitCollapsed.hostH > 100,
  JSON.stringify(fitCollapsed),
);
check(
  "输入窗（展开态）不盖住终端：终端自己变矮，而不是被压住",
  !!fitOpen &&
    fitOpen.hostBottom <= fitOpen.barTop &&
    fitOpen.hostH > 80 &&
    fitOpen.hostH < (fitCollapsed?.hostH ?? 0),
  `${JSON.stringify(fitOpen)}（收起时 hostH=${fitCollapsed?.hostH}）`,
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

// 输入窗 → herdr 接管窗格：**文字与回车都要送出去，而且回车必须排在文字之后**。
//
// 2026-10-10 用户实测的 bug：在输入窗里打完字按回车，文字到了窗格的输入行，但 AI 不执行。
// 根因是回车走的是另一条 fire-and-forget 的异步调用（输入泵没建好时那条直接失败、错误还被
// catch 吞掉；泵建好了两条写入也会赛跑，回车可能先到）→ 于是"只有文字、没有回车"。
// 这条断言就是钉住顺序的：先 send-text（带 bracketed paste 包着正文），再单独一个 CR。
const herdrComposerSetup = await evaluate(`(() => {
  const bar = document.querySelector(".composer-bar");
  if (bar && !document.querySelector(".composer-input")) bar.click();
  return !!document.querySelector(".composer-input") || !!bar;
})()`);
await sleep(400);
await evaluate(`(() => {
  const ta = document.querySelector(".composer-input");
  if (!ta) return false;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
  setter.call(ta, "herdr 窗格里的回车测试");
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  return true;
})()`);
await sleep(1000);
const herdrSubmit = await evaluate(`(() => {
  // 注意：herdr_pane_type 的参数是**明文** text（base64 是 Rust 侧才做的），别再解码一次
  const calls = (window.__ZEEAI_CALLARGS__ || []).filter(
    (c) => c.cmd === "herdr_pane_type" || c.cmd === "herdr_pane_key",
  );
  const textOf = (c) => String((c.args || {}).text || "");
  const keyOf = (c) => String((c.args || {}).key || "");
  const idxText = calls.findIndex(
    (c) => c.cmd === "herdr_pane_type" && textOf(c).includes("herdr 窗格里的回车测试"),
  );
  // 回车：优先是 B 通道送的一个字面 CR（herdrPaneType("\\r")），退回才是 send-keys enter
  const idxEnter = calls.findIndex(
    (c, i) =>
      i > idxText &&
      ((c.cmd === "herdr_pane_type" && textOf(c) === "\\r") ||
        (c.cmd === "herdr_pane_key" && keyOf(c) === "enter")),
  );
  return {
    setup: ${herdrComposerSetup},
    total: calls.length,
    idxText,
    idxEnter,
    tail: calls.slice(-3).map((c) => c.cmd + ":" + JSON.stringify(textOf(c) || keyOf(c))),
  };
})()`);
check(
  "输入窗发给 herdr 接管窗格：文字与回车**都**送出去，且回车排在文字之后（曾经的 bug：只有文字）",
  herdrSubmit.idxText >= 0 && herdrSubmit.idxEnter > herdrSubmit.idxText,
  JSON.stringify(herdrSubmit).slice(0, 240),
);

// 收尾：把输入窗收起来、焦点还给终端。
// 后面还有"新建会话里打字"那几条用例 —— 输入窗开着会把它们的按键和焦点吃掉
//（我第一版就踩了：两条 tmux 命名断言莫名其妙变红）。
await evaluate(`(() => {
  const bar = document.querySelector(".composer-bar");
  if (bar && document.querySelector(".composer-input")) bar.click();
  const ta = document.querySelector(".xterm-helper-textarea");
  if (ta) ta.focus();
  return true;
})()`);
await sleep(400);

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
      kind: "codex", status: "blocked", cwd: "/home/user", paneId: "wQ:p1",
      tabId: "wQ:t1", workspaceId: "wQ", title: "lz", focused: true, attention: true,
    },
    {
      kind: "codex", status: "working", cwd: "/home/user", paneId: "wB:p1",
      tabId: "wB:t1", workspaceId: "wB", title: "lz", focused: false, attention: false,
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
  twoCards.some((c) => c.includes("wQ:p1")) && twoCards.some((c) => c.includes("wB:p1")),
  JSON.stringify(twoCards).slice(0, 240),
);
// 在 wQ:p1 那张卡上点「接管」→ 这个窗格作为标签开起来
await evaluate(`(() => {
  const c = [...document.querySelectorAll(".ai-panel .ai-task")].find((x) => (x.innerText || "").includes("wQ:p1"));
  const b = c && [...c.querySelectorAll("button")].find((x) => (x.innerText || "").trim() === "接管");
  if (b) b.click();
  return !!b;
})()`);
await sleep(2400);
const mapped = await evaluate(`(() => {
  const c = [...document.querySelectorAll(".ai-panel .ai-task")].find((x) => (x.innerText || "").includes("wQ:p1"));
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
  "标签名里窗格号不重复（`wQ:p1` 只出现一次）",
  mapped.tabs.some((t) => (t.match(/wQ:p1/g) || []).length === 1) &&
    !mapped.tabs.some((t) => (t.match(/wQ:p1/g) || []).length > 1),
  JSON.stringify(mapped.tabs),
);

// ---------- (D2) 看板只摆"任务"，不摆"窗格现状"（backlog 第 2 条 ②） ----------
//
// 用户实测：面板标题写着当前会话、下面却列着远端的卡，于是他以为"它在探测我的 PowerShell"；
// 而且两张 `空闲` / `已完成` 的陈旧窗格一直占着卡片位。
// 现在的口径：标题固定；`空闲 / 已完成` 收进一行折叠；那种卡不再摆"接管"（点了也切不过去）。
await setScenario({
  herdrAgents: [
    {
      kind: "codex", status: "working", cwd: "/home/user", paneId: "wB:p1",
      tabId: "wB:t1", workspaceId: "wB", title: "lz", focused: false, attention: false,
    },
    {
      kind: "codex", status: "idle", cwd: "/home/user", paneId: "w1Z:p1",
      tabId: "w1Z:t1", workspaceId: "w1Z", title: "lz", focused: false, attention: false,
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
const board2 = await evaluate(`(() => {
  const head = (document.querySelector(".ai-panel .ai-head")?.innerText || "").trim();
  const cards = [...document.querySelectorAll(".ai-panel .ai-task")].map((c) =>
    (c.innerText || "").replace(/\\n/g, " / "));
  const fold = [...document.querySelectorAll(".ai-panel button")].find((b) =>
    (b.innerText || "").includes("不活跃的窗格"));
  return { head, cards, fold: fold ? (fold.innerText || "").trim() : "" };
})()`);
check(
  "面板标题固定成「AI 任务看板」，不再跟着当前会话（远端卡片不再冒充本机）",
  board2.head.includes("AI 任务看板") && !board2.head.includes("AI Agent"),
  board2.head,
);
check(
  "「空闲」的窗格不占卡片位：收进一行折叠（正在跑的照常显示）",
  !board2.cards.some((c) => c.includes("w1Z:p1")) &&
    board2.cards.some((c) => c.includes("wB:p1")) &&
    board2.fold.includes("另有 1 个不活跃的窗格"),
  `卡片=${JSON.stringify(board2.cards).slice(0, 160)} 折叠行=${board2.fold}`,
);
check(
  "卡片上不再出现 `lz · lz · wB:p1` 这种服务器名/项目名重复",
  board2.cards.length > 0 && board2.cards.every((c) => !c.includes("lz · lz")),
  JSON.stringify(board2.cards).slice(0, 160),
);
await evaluate(`(() => {
  const b = [...document.querySelectorAll(".ai-panel button")].find((x) =>
    (x.innerText || "").includes("不活跃的窗格"));
  if (b) b.click();
  return !!b;
})()`);
await sleep(700);
const shotBoardFold = await shot("13-board-folded.png");
const unfolded = await evaluate(`(() => {
  const c = [...document.querySelectorAll(".ai-panel .ai-task")].find((x) =>
    (x.innerText || "").includes("w1Z:p1"));
  return {
    found: !!c,
    text: c ? (c.innerText || "").replace(/\\n/g, " / ") : "",
    buttons: c ? [...c.querySelectorAll("button")].map((b) => (b.innerText || "").trim()) : [],
  };
})()`);
check(
  "展开后能看到那个窗格，但只给「查看窗格」——不再摆一个点了也切不过去的「接管」",
  unfolded.found && unfolded.buttons.includes("查看窗格") && !unfolded.buttons.includes("接管"),
  JSON.stringify(unfolded).slice(0, 200),
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

// ---------- (G) 藏起来再切回来：终端必须自己重画，且不能崩 ----------
//
// 用户实测：开一个 WSL、关掉、切回 herdr 标签 → 字体花了（有的字没了、有的错位），
// 缩放一下窗口才恢复。根因是"重新可见"这件事没人通知终端：尺寸没变时原来那套
// "只在变了才刷"的逻辑什么都不做。现在切回来会无条件清图集 + 重画。
// 注意：无头 Edge 里终端可能是 canvas/WebGL 渲染，`.xterm-rows` 的 innerText 本来就是空的，
// 所以这里看"容器还在、尺寸正常、没有新报错"，而不是看文字（我第一版就测错了这一条）。
const errsBeforeSwitch = pageErrors.length;
const beforeSwitch = await evaluate(`(() => {
  const el = document.querySelector(".xterm");
  return { hasTerm: !!el, w: el ? el.clientWidth : 0 };
})()`);
// 切到别的模块（终端会被藏起来），再切回远程
await evaluate(`(() => {
  const b = [...document.querySelectorAll("button")].find((x) => (x.title || "").trim() === "WSL");
  if (b) b.click();
  return !!b;
})()`);
await sleep(900);
await evaluate(`(() => {
  const b = [...document.querySelectorAll("button")].find((x) => (x.title || "").trim() === "远程");
  if (b) b.click();
  return !!b;
})()`);
await sleep(1200);
const afterSwitch = await evaluate(`(() => {
  const el = document.querySelector(".xterm");
  return { hasTerm: !!el, w: el ? el.clientWidth : 0, h: el ? el.clientHeight : 0 };
})()`);
check(
  "切到别的模块再切回来：终端还在、尺寸正常、没有新报错（重新可见时自己重画）",
  beforeSwitch.hasTerm &&
    afterSwitch.hasTerm &&
    afterSwitch.w > 200 &&
    afterSwitch.h > 100 &&
    pageErrors.length === errsBeforeSwitch,
  `切前 w=${beforeSwitch.w} → 切后 ${JSON.stringify(afterSwitch)}；新报错 ${
    pageErrors.length - errsBeforeSwitch
  } 条`,
);

// ---------- (Z) 浅色主题下不能有「深底深字 / 浅底浅字」 ----------
// 用户截图报过：切到浅色主题后，设置面板里一排深灰色框（按钮、两个滑块）压在白底上，
// 文字是深色的 → 几乎读不出来（见 docs/backlog.md 第 1 条）。当时的结论是"下次一并改"，
// 这条断言就是那次改动的守门人：以后谁再把底色写成字面量，这里会立刻红。
//
// 判据是**真实计算样式里的对比度**（不是看代码、也不是看截图）：逐页翻设置面板，
// 把"直接装着文字"的元素找出来，取它的 color 与"最近一个有实底色的祖先"的 backgroundColor
// 算 WCAG 对比度，低于 4.0 就算不合格 —— 「深底深字」的对比度大约只有 1.1，必挂。
const CONTRAST_AUDIT = String.raw`(() => {
  const parse = (s) => {
    const m = /rgba?\(([^)]+)\)/.exec(s || "");
    if (!m) return null;
    const p = m[1].split(",").map((x) => parseFloat(x));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const ratio = (a, b) => {
    const x = lum(a), y = lum(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };
  const effBg = (el) => {
    let cur = el;
    while (cur) {
      const c = parse(getComputedStyle(cur).backgroundColor);
      if (c && c.a >= 0.9) return c;
      cur = cur.parentElement;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  };
  const root = document.querySelector(".modal");
  if (!root) return [{ tag: "-", cls: "", text: "设置面板没打开", fg: "", bg: "", ratio: 0 }];
  const bad = [];
  for (const el of root.querySelectorAll("*")) {
    if (el.tagName === "OPTION") continue;
    const st = getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden") continue;
    if (parseFloat(st.opacity) < 0.6) continue;   // 禁用态（opacity: .5）不算
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join("");
    if (!own) continue;
    const fg = parse(st.color);
    if (!fg) continue;
    const bg = effBg(el);
    const c = ratio(fg, bg);
    if (c < 4.0) {
      bad.push({
        tag: el.tagName,
        cls: String(el.className).slice(0, 44),
        text: own.slice(0, 18),
        fg: st.color,
        bg: "rgb(" + bg.r + "," + bg.g + "," + bg.b + ")",
        ratio: Math.round(c * 100) / 100,
      });
    }
  }
  return bad;
})()`;

const openSettings = async () =>
  evaluate(`(() => {
    const gear = [...document.querySelectorAll("button")].find((b) => (b.title || "").includes("设置"));
    if (gear) gear.click();
    return !!gear;
  })()`);
const clickSettingsTab = async (label) =>
  evaluate(`(() => {
    const nav = [...document.querySelectorAll(".settings-nav-item")].find((n) => (n.innerText || "").trim() === ${JSON.stringify(
      label,
    )});
    if (nav) nav.click();
    return !!nav;
  })()`);

// 让应用**直接以浅色主题启动**（比去点下拉框稳），再逐页查对比度
await setScenario({ settingsPatch: { theme: "light" } });
await reload();
await openSettings();
await sleep(900);
const settingsTabs = await evaluate(
  `[...document.querySelectorAll(".settings-nav-item")].map((n) => (n.innerText || "").trim())`,
);
const lightBad = [];
for (const tab of settingsTabs) {
  await clickSettingsTab(tab);
  await sleep(420);
  const bad = await evaluate(CONTRAST_AUDIT);
  if (bad.length) lightBad.push({ tab, bad: bad.slice(0, 6) });
}
check(
  "浅色主题：设置面板逐页没有「深底深字 / 浅底浅字」（按真实计算样式算对比度）",
  lightBad.length === 0,
  lightBad.length ? JSON.stringify(lightBad).slice(0, 500) : `${settingsTabs.length} 个页签全过`,
);

// 那两个滑块：以前没有任何样式，套用了 input 的深灰底 → 浅色下是一块深色方块
await clickSettingsTab("外观");
await sleep(420);
const shotLight = await shot("12-settings-light.png");
const sliders = await evaluate(`[...document.querySelectorAll(".modal input[type=range]")].map((i) => ({
  bg: getComputedStyle(i).backgroundColor,
  accent: getComputedStyle(i).accentColor,
  w: Math.round(i.getBoundingClientRect().width),
}))`);
check(
  "浅色主题：两个滑块不再是深灰方块（底色透明、滑块跟强调色）",
  sliders.length === 2 &&
    sliders.every((s) => s.bg === "rgba(0, 0, 0, 0)" || s.bg === "transparent") &&
    sliders.every((s) => s.accent !== "auto" && s.w > 100),
  JSON.stringify(sliders),
);

// 深色主题不回归：按钮仍是深底浅字（对比度审计也要过）
//
// 这里**显式指定 dark**，不能靠"用户 settings.json 里恰好是深色"：开发机上的主题是用户随手切的
// （实测跑挂过一次 —— 当时那份 settings.json 正好停在浅色，于是这条假失败）。
await setScenario({ settingsPatch: { theme: "dark" } });
await reload();
await openSettings();
await sleep(900);
const darkBtn = await evaluate(`(() => {
  const b = [...document.querySelectorAll(".modal .btn")][0];
  if (!b) return null;
  const st = getComputedStyle(b);
  return { bg: st.backgroundColor, fg: st.color, text: (b.innerText || "").trim().slice(0, 12) };
})()`);
const darkBad = await evaluate(CONTRAST_AUDIT);
check(
  "深色主题没回归：按钮仍是深底浅字（且对比度审计通过）",
  !!darkBtn && darkBtn.bg === "rgb(42, 45, 46)" && darkBad.length === 0,
  `${JSON.stringify(darkBtn)}；不合格 ${darkBad.length} 处`,
);

// 先验最核心的那条：**在终端里粘贴一张图**。
//
// 默认（设置里那个勾**不勾**）：图片**不进终端**，而是放进**输入窗**（自动展开）——
// 用户能确认粘对了没有、还能补一句话再发。勾上才走"插路径进终端 + 浮层"的快路径（下面另一条断言）。
// 无头环境没有真剪贴板，但 ClipboardEvent 支持构造注入 clipboardData，
// 所以这里能真的走一遍"paste 事件里带 file"的路径（真机上换成截图工具/复制的文件）。
const pasteEventScript = `(() => {
  const host = document.querySelector(".terminal-host");
  if (!host) return { ok: false, why: "没有终端" };
  let dt;
  try {
    dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([137, 80, 78, 71])], "shot.png", { type: "image/png" }));
  } catch (e) {
    return { ok: false, why: "建 DataTransfer 失败：" + String(e) };
  }
  let ev;
  try {
    ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
  } catch (e) {
    return { ok: false, why: "建 ClipboardEvent 失败：" + String(e) };
  }
  const notCancelled = host.dispatchEvent(ev);
  return { ok: true, cancelled: !notCancelled, files: (ev.clipboardData?.files || []).length };
})()`;
const pasteEvt = await evaluate(pasteEventScript);
await sleep(1800);
const pasteFlow = await evaluate(`(() => {
  const args = window.__ZEEAI_CALLARGS__ || [];
  const dec = (b64) => { try { return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))); } catch { return ""; } };
  const saved = args.filter((c) => c.cmd === "paste_save_file").pop();
  const up = args.filter((c) => c.cmd === "fs_upload").pop();
  const writes = args.filter((c) => c.cmd === "session_write").map((c) => dec((c.args || {}).dataB64 || ""));
  const cards = [...document.querySelectorAll(".composer-card")].map((c) => (c.innerText || "").replace(/\\n/g, " ").trim());
  return {
    savedName: saved && saved.args ? saved.args.name : null,
    uploadedLocal: up && up.args ? up.args.localPaths : null,
    inserted: writes.some((w) => w.includes("/home/user/.zeeai/paste/paste-test.png")),
    composerOpen: !!document.querySelector(".composer-input"),
    cards,
  };
})()`);
check(
  "终端里粘图（默认）：不往终端插路径，改成放进输入窗（卡片在那儿等你确认）",
  pasteEvt.ok && pasteEvt.cancelled && pasteEvt.files === 1 &&
    !!pasteFlow.savedName && String(pasteFlow.savedName).startsWith("paste-") &&
    !pasteFlow.inserted && pasteFlow.composerOpen && pasteFlow.cards.length === 1,
  `${JSON.stringify(pasteEvt)} ${JSON.stringify(pasteFlow)}`.slice(0, 300),
);
// 把输入窗收起，状态交还给后面的用例（后面要验"默认收起"）
await evaluate(`(() => {
  const bar = document.querySelector(".composer-bar");
  if (bar) bar.click();
  return !!bar;
})()`);
await sleep(600);
// 缩略图浮层：**默认不弹**。
//
// 用户明确要求"图片上传/粘贴不要在右下角弹消息"，所以 pasteToast 默认关掉。
// 这里验的是默认状态：不该出现浮层（静默）。
const pasteToastCard = await evaluate(`(() => {
  const card = document.querySelector(".paste-card");
  return {
    found: !!card,
    text: card ? (card.innerText || "").replace(/\\n/g, " ").trim() : "",
    thumb: !!(card && card.querySelector("img.paste-card-thumb")),
  };
})()`);
check(
  "默认不弹缩略图浮层（粘贴图片全程静默）",
  !pasteToastCard.found,
  JSON.stringify(pasteToastCard).slice(0, 200),
);
// 勾上那个开关 = 老快路径：直接插路径进终端 + 弹几秒缩略图
await setScenario({ settingsPatch: { pasteToast: true } });
await reload();
await sleep(2600);
const fastEvt = await evaluate(pasteEventScript);
await sleep(1800);
const fastFlow = await evaluate(`(() => {
  const args = window.__ZEEAI_CALLARGS__ || [];
  const dec = (b64) => { try { return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))); } catch { return ""; } };
  const writes = args.filter((c) => c.cmd === "session_write").map((c) => dec((c.args || {}).dataB64 || ""));
  const card = document.querySelector(".paste-card");
  return {
    inserted: writes.some((w) => w.includes("/home/user/.zeeai/paste/paste-test.png")),
    card: card ? (card.innerText || "").replace(/\\n/g, " ").trim() : "",
    thumb: !!(card && card.querySelector("img.paste-card-thumb")),
  };
})()`);
check(
  "勾上「快路径」后：路径直接插进终端 + 弹几秒缩略图（两种口径都能用）",
  fastEvt.ok && fastFlow.inserted && !!fastFlow.card,
  `${JSON.stringify(fastEvt)} ${JSON.stringify(fastFlow)}`.slice(0, 300),
);

// ---------- (Z2) 给 AI 发文件 / 发消息：输入窗 + 附件 ----------
//
// 用户要的两件事：① 粘贴 / 拖拽 / 选文件 → 上传到远端 → 把**远端路径**喂给 AI；
// ② 一个能拉出来的输入窗，慢慢写长提示词、带「＋」上传附件。
// 这里测的是**管道**：输入窗 → session_write 的内容对不对、附件有没有传到设置的目录里。
// 说明：原生文件对话框与真拖拽在无头环境里没法验（拖拽那一段只能真机看，见交付说明）。
await setScenario({});
await reload();
await sleep(1400);

const composerOpened = await evaluate(`(() => {
  const b = document.querySelector(".composer-bar");
  if (b) b.click();
  return !!b;
})()`);
await sleep(700);
const composerInfo = await evaluate(`(() => {
  const el = document.querySelector(".composer");
  return {
    open: !!el,
    head: el ? (el.querySelector(".composer-bar")?.innerText || "").replace(/\\n/g, " ").trim() : "",
    hasInput: !!document.querySelector(".composer-input"),
    hasPlus: !![...document.querySelectorAll(".composer-actions button")].find((b) =>
      (b.innerText || "").includes("添加图片")),
  };
})()`);
check(
  "点底部细栏能拉出输入窗（多行编辑框 + ＋ 按钮 + 写着发给谁）",
  composerOpened && composerInfo.open && composerInfo.hasInput && composerInfo.hasPlus &&
    composerInfo.head.includes("发给 AI"),
  JSON.stringify(composerInfo).slice(0, 200),
);

// 打字 + Enter 发送 → 后端收到 session_write，内容就是那段文字（附件的路径稍后单独验）
await evaluate(`(() => {
  const ta = document.querySelector(".composer-input");
  if (!ta) return false;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
  setter.call(ta, "帮我看下这两张图：第一张是报错，第二张是配置");
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  return true;
})()`);
await sleep(900);
const sentText = await evaluate(`(() => {
  const dec = (b64) => { try { return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))); } catch { return ""; } };
  const writes = (window.__ZEEAI_CALLARGS__ || []).filter((c) => c.cmd === "session_write")
    .map((c) => dec((c.args || {}).dataB64 || ""));
  // 回车也必须真的写出去，而且排在正文之后（"只有文字没有回车"是 2026-10-10 修过的 bug）
  const idxText = writes.findIndex((w) => w.includes("帮我看下这两张图"));
  const idxEnter = writes.findIndex((w, i) => i > idxText && w.includes("\\r"));
  return {
    writes,
    idxText,
    idxEnter,
    cleared: (document.querySelector(".composer-input")?.value || "") === "",
  };
})()`);
check(
  "输入窗里打完字按 Enter：文字与回车都写进会话、回车在文字之后，输入框自己清空、窗口不关",
  sentText.idxText >= 0 && sentText.idxEnter > sentText.idxText && sentText.cleared,
  `写入 ${JSON.stringify(sentText.writes.slice(-2)).slice(0, 160)} idx=${sentText.idxText}/${sentText.idxEnter}`,
);

// 发完**不要把焦点抢回终端**：用户多半还要接着写下一条，焦点该留在输入窗（2026-10-10 要求）
const focusAfterSend = await evaluate(`(() => {
  const el = document.activeElement;
  return {
    tag: el ? el.tagName : "",
    cls: el ? String(el.className) : "",
    inXterm: !!el && String(el.className).includes("xterm"),
  };
})()`);
check(
  "发完一条：焦点留在输入窗，不被抢回终端",
  !focusAfterSend.inXterm,
  `activeElement=${focusAfterSend.tag}.${focusAfterSend.cls}`,
);

// 「＋ 添加图片 / 文件」→ mock 的选择器返回一个假路径 → 应上传到 /home/user/.zeeai/paste
await evaluate(`(() => {
  const b = [...document.querySelectorAll(".composer-actions button")].find((x) =>
    (x.innerText || "").includes("添加图片"));
  if (b) b.click();
  return !!b;
})()`);
await sleep(1300);
const attach = await evaluate(`(() => {
  const up = (window.__ZEEAI_CALLARGS__ || []).filter((c) => c.cmd === "fs_upload");
  const last = up[up.length - 1];
  const card = document.querySelector(".composer-card");
  return {
    uploads: up.length,
    dir: last && last.args ? last.args.remoteDir : null,
    local: last && last.args ? last.args.localPaths : null,
    card: card ? (card.innerText || "").trim() : "",
    thumb: !!document.querySelector(".composer-card img.composer-thumb"),
    adopted: (window.__ZEEAI_CALLARGS__ || []).filter((c) => c.cmd === "paste_adopt_file").length,
  };
})()`);
check(
  "「＋ 添加图片 / 文件」先收进临时目录、再上传到设置里的目录，并变成**带缩略图**的附件卡片",
  attach.uploads > 0 && attach.dir === "/home/user/.zeeai/paste" &&
    attach.adopted > 0 && attach.card.includes("paste-adopted") && attach.thumb,
  JSON.stringify(attach).slice(0, 260),
);
const shotComposer = await shot("14-composer.png");

// 带附件发送：正文里必须带上**远端路径**（AI 靠它读文件）
await evaluate(`(() => {
  const ta = document.querySelector(".composer-input");
  if (!ta) return false;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
  setter.call(ta, "这张图里的报错是什么原因？");
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  const b = [...document.querySelectorAll(".composer-actions button")].find((x) =>
    (x.innerText || "").includes("发送"));
  if (b) b.click();
  return true;
})()`);
await sleep(900);
const sentWithFile = await evaluate(`(() => {
  const dec = (b64) => { try { return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))); } catch { return ""; } };
  const writes = (window.__ZEEAI_CALLARGS__ || []).filter((c) => c.cmd === "session_write")
    .map((c) => dec((c.args || {}).dataB64 || ""));
  const hit = writes.find((w) => w.includes("这张图里的报错") && w.includes("/home/user/.zeeai/paste/paste-adopted.png"));
  return { hit: hit || "", cards: document.querySelectorAll(".composer-card").length };
})()`);
check(
  "带附件的消息：正文里带上远端路径（AI 按路径读文件），发完附件清空",
  !!sentWithFile.hit && sentWithFile.cards === 0,
  JSON.stringify(sentWithFile).slice(0, 240),
);

// ---------- (Z2b) 底部细栏 + 双箭头 + 三个交互设置 ----------
// 用户的追加要求：① 输入窗**默认收起**，只剩终端底部一条细栏，点箭头才展开；
// ② 箭头要"两条叠着、看得出是两支"；③ 粘贴键 / 右键行为 / 复制方式可配。
await setScenario({});
await reload();
await sleep(1400);
const collapsed = await evaluate(`(() => {
  const bar = document.querySelector(".composer-bar");
  return {
    bar: !!bar,
    text: bar ? (bar.innerText || "").replace(/\\n/g, " ").trim() : "",
    chevrons: bar ? bar.querySelectorAll("svg path").length : 0,
    input: !!document.querySelector(".composer-input"),
  };
})()`);
check(
  "输入窗默认收起：只剩一条细栏（两条 chevron + 写着发给谁），编辑框不出现",
  collapsed.bar && !collapsed.input && collapsed.chevrons === 2 &&
    collapsed.text.includes("发给 AI"),
  JSON.stringify(collapsed).slice(0, 200),
);
// 放大截图：确认"两条箭头数得清"（交付前必须人眼看过，见交付说明）
const barBox = await evaluate(`(() => {
  const svg = document.querySelector(".composer-bar svg");
  if (!svg) return null;
  const r = svg.getBoundingClientRect();
  return { x: Math.round(r.x) - 3, y: Math.round(r.y) - 3, width: Math.round(r.width) + 6, height: Math.round(r.height) + 6 };
})()`);
const shotArrowZoom = barBox ? await shotClip("15-arrow-zoom.png", { ...barBox, scale: 4 }) : "";
const shotCollapsed = await shot("16-composer-collapsed.png");
await evaluate(`(() => { const b = document.querySelector(".composer-bar"); if (b) b.click(); return !!b; })()`);
await sleep(700);
const shotExpanded = await shot("17-composer-expanded.png");
const expanded = await evaluate(`(() => ({
  input: !!document.querySelector(".composer-input"),
  chevrons: document.querySelectorAll(".composer-bar svg path").length,
}))()`);
check(
  "点细栏展开（编辑框出现、箭头翻转成向下），再点一次收起",
  expanded.input && expanded.chevrons === 2,
  JSON.stringify(expanded),
);

// 移除附件要顺手删掉本地临时文件（不然 %TEMP% 里攒垃圾）
await evaluate(`(() => {
  const b = [...document.querySelectorAll(".composer-actions button")].find((x) =>
    (x.innerText || "").includes("添加图片"));
  if (b) b.click();
  return !!b;
})()`);
await sleep(1300);
const beforeRemove = await evaluate(`document.querySelectorAll(".composer-card").length`);
await evaluate(`(() => {
  const x = document.querySelector(".composer-card .composer-card-x");
  if (x) x.click();
  return !!x;
})()`);
await sleep(500);
const removed = await evaluate(`(() => ({
  cards: document.querySelectorAll(".composer-card").length,
  discards: (window.__ZEEAI_CALLARGS__ || []).filter((c) => c.cmd === "paste_discard_file").length,
}))()`);
check(
  "点附件卡片的 ✕：卡片消失，并且删掉了本地临时文件（paste_discard_file）",
  beforeRemove > 0 && removed.cards === 0 && removed.discards > 0,
  JSON.stringify(removed).slice(0, 160),
);

// 粘贴键设置：选 shift-insert 时，Ctrl+V 必须**原样送给远端**（^V），而不是粘贴
await setScenario({ settingsPatch: { pasteKey: "shift-insert" } });
await reload();
await sleep(1500);
const ctrlV = await evaluate(String.raw`(() => {
  const ta = document.querySelector(".xterm-helper-textarea");
  if (!ta) return { ok: false, why: "找不到 xterm 的输入区" };
  const ev = new KeyboardEvent("keydown", { key: "v", ctrlKey: true, bubbles: true, cancelable: true });
  // xterm 主要看 keyCode（合成事件带不上，只能自己挂一个）
  Object.defineProperty(ev, "keyCode", { get: () => 86 });
  Object.defineProperty(ev, "which", { get: () => 86 });
  ta.dispatchEvent(ev);
  const dec = (b64) => { try { return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))); } catch { return ""; } };
  const writes = (window.__ZEEAI_CALLARGS__ || []).filter((c) => c.cmd === "session_write")
    .map((c) => dec((c.args || {}).dataB64 || ""));
  return { ok: true, writes: writes.slice(-3), prevented: ev.defaultPrevented };
})()`);
await sleep(600);
const ctrlVAfter = await evaluate(String.raw`(() => {
  const dec = (b64) => { try { return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))); } catch { return ""; } };
  const writes = (window.__ZEEAI_CALLARGS__ || []).filter((c) => c.cmd === "session_write")
    .map((c) => dec((c.args || {}).dataB64 || ""));
  return { hit: writes.some((w) => w.includes("\u0016")), writes: writes.slice(-3) };
})()`);
check(
  "粘贴键设成 shift-insert 后：Ctrl+V 变成 ^V 送给远端（不再粘贴）",
  !!ctrlV.ok && ctrlVAfter.hit,
  `合成事件 ${JSON.stringify(ctrlV).slice(0, 140)}；之后 ${JSON.stringify(ctrlVAfter.writes).slice(0, 120)}`,
);

// 右键设置：paste 模式下右键**不能**只是弹菜单（要么粘贴成功，要么退回菜单并说明原因）
await setScenario({ settingsPatch: { rightClick: "paste" } });
await reload();
await sleep(1500);
await evaluate(`(() => {
  const host = document.querySelector(".terminal-host");
  if (!host) return false;
  const r = host.getBoundingClientRect();
  host.dispatchEvent(new MouseEvent("contextmenu", {
    bubbles: true, cancelable: true, clientX: r.x + 40, clientY: r.y + 40,
  }));
  return true;
})()`);
await sleep(900);
const rightClick = await evaluate(String.raw`(() => {
  const dec = (b64) => { try { return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))); } catch { return ""; } };
  const writes = (window.__ZEEAI_CALLARGS__ || []).filter((c) => c.cmd === "session_write")
    .map((c) => dec((c.args || {}).dataB64 || ""));
  return {
    wrote: writes.length > 0,
    menu: !!document.querySelector(".ctx-menu"),
    notice: (document.querySelector(".status-notice")?.innerText || "").trim(),
  };
})()`);
check(
  "右键设成「直接粘贴」：要么真的粘贴了文本，要么退回菜单并说明原因（不静默吞掉）",
  rightClick.wrote || (rightClick.menu && rightClick.notice.includes("剪贴板")),
  JSON.stringify(rightClick).slice(0, 200),
);

// ---------- (Z3) 输入窗在浅色主题下也得正常 ----------
// 这轮新加的界面同样必须跟主题走 —— 上一版就是"控件底色写死深灰，浅色下深底深字"。
await setScenario({ settingsPatch: { theme: "light" } });
await reload();
await sleep(1400);
const lightComposerOpened = await evaluate(`(() => {
  const b = document.querySelector(".composer-bar");
  if (b) b.click();
  return !!b;
})()`);
await sleep(700);
const composerContrast = await evaluate(String.raw`(() => {
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const parse = (s) => {
    const m = /rgba?\(([^)]+)\)/.exec(s || "");
    if (!m) return null;
    const p = m[1].split(",").map(Number);
    return p.length > 3 && p[3] < 0.9 ? null : [p[0], p[1], p[2]];
  };
  const el = document.querySelector(".composer-input");
  if (!el) return { ok: false, why: "输入框没找到" };
  const st = getComputedStyle(el);
  const bg = parse(st.backgroundColor) || parse(getComputedStyle(document.querySelector(".composer")).backgroundColor);
  const fg = parse(st.color);
  if (!bg || !fg) return { ok: false, why: "取不到颜色 " + st.backgroundColor + " / " + st.color };
  const x = lum(bg), y = lum(fg);
  const ratio = (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  return {
    ok: x > 0.5 && ratio >= 4.0,
    bg: st.backgroundColor,
    fg: st.color,
    ratio: Math.round(ratio * 100) / 100,
    lightBg: x > 0.5,
  };
})()`);
check(
  "浅色主题下输入窗是「浅底深字」（新界面也跟主题走，不是又一块深灰）",
  lightComposerOpened && composerContrast.ok,
  JSON.stringify(composerContrast),
);

// ---------- (Y) 设置面板：文案不许漏字面 markdown，新增 5 项要成组、提示要有间距 ----------
// 用户反馈"设置里的文字提示和排版乱乱的"，三条具体病：① 提示里漏出 `**粗体**` / 反引号
//（这个界面不渲染 markdown，用户看到的是星号本身）；② 新增 5 项和老设置混在一起没层次；
// ③ 提示是 inline span，给它加 padding-top 根本不生效 → 挤在控件下面。
await setScenario({ settingsPatch: { theme: "dark" } });
await reload();
await openSettings();
await sleep(900);
const settingsTabsAll = await evaluate(
  `[...document.querySelectorAll(".settings-nav-item")].map((n) => (n.innerText || "").trim())`,
);
const mdBad = [];
for (const tab of settingsTabsAll) {
  await clickSettingsTab(tab);
  await sleep(380);
  const txt = await evaluate(
    `(() => { const m = document.querySelector(".modal"); return m ? m.innerText : ""; })()`,
  );
  const hits = [];
  if (txt.includes("**")) hits.push("**");
  if (txt.includes("`")) hits.push("反引号");
  if (hits.length) mdBad.push({ tab, hits });
}
check(
  "设置面板里没有字面 markdown（星号 / 反引号不会被当正文显示）",
  mdBad.length === 0,
  mdBad.length ? JSON.stringify(mdBad) : `${settingsTabsAll.length} 个页签都干净`,
);

await clickSettingsTab("终端与会话");
await sleep(420);
const termLayout = await evaluate(`(() => {
  const modal = document.querySelector(".modal");
  if (!modal) return { ok: false, why: "没有设置面板" };
  const groups = [...modal.querySelectorAll(".tree-group")];
  const g = groups.find((n) => (n.innerText || "").includes("发给 AI"));
  if (!g) return { ok: false, why: "没有找到分组标题", groups: groups.map((n) => (n.innerText || "").trim()) };
  const after = [...modal.querySelectorAll("label")].filter(
    (l) => g.compareDocumentPosition(l) & Node.DOCUMENT_POSITION_FOLLOWING);
  const firstFive = after.slice(0, 5).map((l) => (l.innerText || "").trim().split("\\n")[0].trim());
  const want = [
    "图片 / 文件传到远端哪个目录",
    "粘贴用哪个键",
    "终端里点右键",
    "怎么复制",
    "在终端里直接粘图片：放进输入窗（勾上 = 直接插路径）",
  ];
  const hint = modal.querySelector(".modal-field > .hint");
  const hs = hint ? getComputedStyle(hint) : null;
  return {
    ok: true,
    title: (g.innerText || "").trim(),
    firstFive,
    allPresent: want.every((w) => firstFive.includes(w)),
    hintDisplay: hs ? hs.display : "(没有 hint)",
    hintMarginTop: hs ? hs.marginTop : "",
  };
})()`);
check(
  "新增 5 项收在「发给 AI（图片与文件）」分组里、顺序连贯",
  termLayout.ok && termLayout.allPresent,
  termLayout.ok ? `组标题=${termLayout.title}；组内前 5 项=${JSON.stringify(termLayout.firstFive)}` : JSON.stringify(termLayout),
);
check(
  "设置提示是块级且与控件留 4px（以前是 inline span，padding-top 不生效 → 挤在一起）",
  termLayout.ok && termLayout.hintDisplay === "block" && termLayout.hintMarginTop === "4px",
  `${termLayout.hintDisplay} / ${termLayout.hintMarginTop}`,
);

// 三段截图（顶 / 分组处 / 底），深色
const scrollSettings = async (to) =>
  evaluate(`(() => {
    const b = document.querySelector(".settings-split .modal-body");
    if (!b) return false;
    if (${JSON.stringify(to)} === "top") b.scrollTop = 0;
    else if (${JSON.stringify(to)} === "bottom") b.scrollTop = b.scrollHeight;
    else {
      const g = [...document.querySelectorAll(".modal .tree-group")].find((n) => (n.innerText || "").includes("发给 AI"));
      if (g) b.scrollTop = g.offsetTop - 10;
    }
    return true;
  })()`);
await scrollSettings("top");
await sleep(320);
const shotTop = await shot("20-settings-term-top.png");
await scrollSettings("group");
await sleep(320);
const shotGroup = await shot("21-settings-term-group.png");
await scrollSettings("bottom");
await sleep(320);
const shotBottom = await shot("22-settings-term-bottom.png");

// 浅色主题下再看一次分组处（颜色只能走主题变量，浅色下也得整齐）
await setScenario({ settingsPatch: { theme: "light" } });
await reload();
await openSettings();
await sleep(900);
await clickSettingsTab("终端与会话");
await sleep(420);
await scrollSettings("group");
await sleep(320);
const shotGroupLight = await shot("23-settings-term-group-light.png");

// ---------- (Z3) 「应用」页 + 终端配色"看得懂、撤得掉" + 两个写死深色的修复 ----------
// 用户反馈一串：① "关闭窗口时"这种应用级设置不该混在「终端与会话」里；② 改了终端配色"没反应"
//  —— 其实是这台机器/这一类终端早先钉过一套把全局默认盖住了，而界面一个字都不说；
// ③ 浅色主题下窗口缝隙/终端四周永远是深色（.app 不画底 + .pane 写死 #181818）。
await setScenario({ settingsPatch: { theme: "dark" } });
await reload();
await openSettings();
await sleep(900);
await clickSettingsTab("应用");
await sleep(420);
const appPage = await evaluate(`(() => {
  const m = document.querySelector(".modal");
  const t = m ? m.innerText : "";
  return { hasRestore: t.includes("启动时恢复上次的会话"), hasClose: t.includes("关闭窗口时") };
})()`);
await clickSettingsTab("终端与会话");
await sleep(420);
const termPage2 = await evaluate(`(() => {
  const m = document.querySelector(".modal");
  const t = m ? m.innerText : "";
  return { hasRestore: t.includes("启动时恢复上次的会话"), hasClose: t.includes("关闭窗口时") };
})()`);
check(
  "「应用」一级页放应用级设置（启动恢复会话 / 关闭窗口时），「终端与会话」里不再有这两条",
  appPage.hasRestore && appPage.hasClose && !termPage2.hasRestore && !termPage2.hasClose,
  `应用页=${JSON.stringify(appPage)} 终端页=${JSON.stringify(termPage2)}`,
);

// 终端配色：切到「远程 SSH」那一档 —— 必须给一个「跟随全局」，点了要真能把覆盖清掉
await clickSettingsTab("外观");
await sleep(420);
await evaluate(`(() => {
  const b = [...document.querySelectorAll(".modal .btn")].find((x) =>
    (x.innerText || "").includes("终端配色与关键字高亮"));
  if (b) b.click();
  return !!b;
})()`);
await sleep(700);
await evaluate(`(() => {
  const sel = [...document.querySelectorAll(".modal select")].find((s) =>
    [...s.options].some((o) => (o.textContent || "").includes("远程 SSH")));
  if (!sel) return false;
  sel.value = "kind:ssh";
  sel.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
})()`);
await sleep(700);
const followItem = await evaluate(`(() => {
  const items = [...document.querySelectorAll(".modal .tt-item")].map((b) => (b.innerText || "").trim());
  return { first: items[0] ?? "", all: items.length };
})()`);
check(
  "「某一类终端」那档第一项是「跟随全局」（以前设过就再也撤不回去）",
  followItem.first.includes("跟随全局"),
  JSON.stringify(followItem),
);
await evaluate(`(() => {
  const b = [...document.querySelectorAll(".modal .tt-item")].find((x) =>
    (x.innerText || "").includes("跟随全局"));
  if (b) b.click();
  return !!b;
})()`);
await sleep(700);
const clearedOverride = await evaluate(`(() => {
  const calls = (window.__ZEEAI_CALLARGS__ || []).filter((c) => c.cmd === "settings_set");
  const last = calls[calls.length - 1];
  const s = last && last.args && last.args.settings ? last.args.settings : null;
  const byKind = s && s.termSchemeByKind ? s.termSchemeByKind : null;
  return { calls: calls.length, byKind };
})()`);
check(
  "点「跟随全局」→ 该类型的覆盖被清掉（settings_set 里 termSchemeByKind 不再含 ssh）",
  !!clearedOverride.byKind && !("ssh" in clearedOverride.byKind),
  JSON.stringify(clearedOverride),
);
// 关掉配色对话框 + 设置面板
await evaluate(`(() => {
  const d = [...document.querySelectorAll(".modal")].find((m) => m.querySelector(".tt-list"));
  const b = d && [...d.querySelectorAll(".modal-actions .btn")].find((x) => (x.innerText || "").includes("完成"));
  if (b) b.click();
  return !!b;
})()`);
await sleep(500);
await evaluate(`(() => {
  const s = [...document.querySelectorAll(".modal")].find((m) => m.querySelector(".settings-split"));
  const b = s && [...s.querySelectorAll(".modal-actions .btn")].find((x) => (x.innerText || "").includes("完成"));
  if (b) b.click();
  return !!b;
})()`);
await sleep(500);

// 「全局默认（所有终端）」这一档必须**名副其实**：在这里改配色时，要把"按类型"那几层的
// 覆盖一并清掉 —— 否则用户在这里改了、SSH 那边纹丝不动，只能看到"改了没反应"（用户实测报过）。
await setScenario({
  settingsPatch: {
    theme: "dark",
    termScheme: "vscode-dark",
    termSchemeByKind: { ssh: "vscode-dark" },
    termSchemeCustom: "",
  },
});
await reload();
await sleep(2400);
await evaluate(`(() => {
  const gear = [...document.querySelectorAll("button")].find((b) => (b.title || "").includes("设置"));
  if (gear) gear.click();
  return !!gear;
})()`);
await sleep(900);
await clickSettingsTab("外观");
await sleep(420);
await evaluate(`(() => {
  const b = [...document.querySelectorAll(".modal .btn")].find((x) =>
    (x.innerText || "").includes("终端配色与关键字高亮"));
  if (b) b.click();
  return !!b;
})()`);
await sleep(700);
// 作用范围保持在默认的「全局默认（所有终端）」，点一套浅色
const pickedGlobal = await evaluate(`(() => {
  const b = [...document.querySelectorAll(".modal .tt-item")].find((x) =>
    (x.innerText || "").includes("VS Code 浅色"));
  if (b) b.click();
  return !!b;
})()`);
await sleep(700);
const clearedByGlobal = await evaluate(`(() => {
  const calls = (window.__ZEEAI_CALLARGS__ || []).filter((c) => c.cmd === "settings_set");
  const last = calls[calls.length - 1];
  const s = last && last.args && last.args.settings ? last.args.settings : null;
  return {
    termScheme: s ? s.termScheme : null,
    byKind: s && s.termSchemeByKind ? s.termSchemeByKind : null,
  };
})()`);
check(
  "在「全局默认（所有终端）」改配色 → 按类型那几层的覆盖被一并清掉（真的对所有终端生效）",
  pickedGlobal &&
    clearedByGlobal.termScheme === "vscode-light" &&
    !!clearedByGlobal.byKind &&
    Object.keys(clearedByGlobal.byKind).length === 0,
  JSON.stringify(clearedByGlobal),
);
// 关掉配色对话框 + 设置面板
await evaluate(`(() => {
  const d = [...document.querySelectorAll(".modal")].find((m) => m.querySelector(".tt-list"));
  const b = d && [...d.querySelectorAll(".modal-actions .btn")].find((x) => (x.innerText || "").includes("完成"));
  if (b) b.click();
  return !!b;
})()`);
await sleep(400);
await evaluate(`(() => {
  const s = [...document.querySelectorAll(".modal")].find((m) => m.querySelector(".settings-split"));
  const b = s && [...s.querySelectorAll(".modal-actions .btn")].find((x) => (x.innerText || "").includes("完成"));
  if (b) b.click();
  return !!b;
})()`);
await sleep(400);

// 浅色主题 + 浅色终端配色：窗口的底、终端画布的底都必须是浅的。
// 注意：**必须先把"按类型/按机器"的覆盖清掉**（settingsPatch 里给空表），否则生效的是
// 开发机 settings.json 里钉的那一层（实测：ssh 钉了 vscode-dark，它的背景正好也是 #181818，
// 于是断言会以为"没生效"）。
await setScenario({
  settingsPatch: {
    theme: "github",
    termScheme: "vscode-light",
    termSchemeByKind: {},
    termSchemeCustom: "",
  },
});
await reload();
await sleep(2400);
const lightFloors = await evaluate(`(() => {
  const app = document.querySelector(".app");
  const pane = document.querySelector(".pane");
  const cs = pane ? getComputedStyle(pane) : null;
  return {
    appBg: app ? getComputedStyle(app).backgroundColor : "",
    termBgVar: cs ? cs.getPropertyValue("--term-bg").trim() : "",
    paneBg: cs ? cs.backgroundColor : "",
  };
})()`);
check(
  "浅色主题下窗口的「底」也是浅的（.app 自己画底，以前缝隙永远是 body 的深色）",
  lightFloors.appBg === "rgb(255, 255, 255)",
  JSON.stringify(lightFloors),
);
check(
  "终端画布底色跟终端配色一致（浅色配色 → 白底，不再是写死的 #181818）",
  lightFloors.paneBg === "rgb(255, 255, 255)",
  JSON.stringify(lightFloors),
);
const shotLightFloor = await shot("24-light-floors.png");

// ---------- (N) 用户报的两个 bug ----------
//
// Bug 1：新建 tmux 会话时**自己填的名字**没生效（标签栏/列表显示成自动名）。
//   两个地方一起治：后端标题以前写死 `profile · host`（commands.rs），前端又优先用后端返回的
//   title —— 现在后端在"显式命名"时用那个名字，前端也优先用自己算出来的名字。
// Bug 2：重命名会话时**点到弹窗外面**，打好的字被静默丢掉（以前 backdrop 直接置空）。
await setScenario({});
await reload();
await evaluate(`(() => {
  const b = [...document.querySelectorAll("button")].find((x) => (x.innerText || "").includes("新建会话"));
  if (b) b.click();
  return !!b;
})()`);
await sleep(1500);
// 注意：fe-smoke 给所有 ssh 服务器都打开了 herdrEnabled，所以这个对话框默认**勾着**
// 「用 herdr 打开」—— 不先取消，走的就是 herdr 通道（tmuxName 被拿去当窗格号用），
// 跟"tmux 会话名"这条完全无关（我第一版就搭错了：断言里看到 tmuxName=w9:p1）。
await evaluate(`(() => {
  const row = [...document.querySelectorAll(".modal .form-check")].find((l) =>
    (l.innerText || "").includes("用 herdr 打开"));
  const cb = row && row.querySelector("input[type=checkbox]");
  if (cb && cb.checked) cb.click();
  return cb ? cb.checked : null;
})()`);
await sleep(700);
// 取消 herdr 之后 tmux 那条才会出现，勾上它
await evaluate(`(() => {
  const row = [...document.querySelectorAll(".modal .form-check")].find((l) =>
    (l.innerText || "").includes("使用 tmux"));
  const cb = row && row.querySelector("input[type=checkbox]");
  if (cb && !cb.checked) cb.click();
  return !!cb;
})()`);
await sleep(600);
await evaluate(`(() => {
  const r = [...document.querySelectorAll(".modal .tmux-choice .form-check")].find((x) =>
    (x.innerText || "").includes("新建 tmux 会话"));
  if (r) r.querySelector("input").click();
  return !!r;
})()`);
await sleep(500);
const typedTmuxName = "my-own-session";
await evaluate(`(() => {
  const inp = document.querySelector(".modal .tmux-choice input.modal-input");
  if (!inp) return false;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(inp, ${JSON.stringify("my-own-session")});
  inp.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
})()`);
await sleep(400);
await evaluate(`(() => {
  const b = [...document.querySelectorAll(".modal .modal-actions button")].find((x) => (x.innerText || "").trim() === "连接");
  if (b) b.click();
  return !!b;
})()`);
await sleep(2600);
const tmuxNamed = await evaluate(`(() => {
  const open = window.__ZEEAI_CALLARGS__.filter((c) => c.cmd === "open_ssh").pop();
  return {
    mode: open ? open.args.tmuxMode : null,
    name: open ? open.args.tmuxName : null,
    tabs: [...document.querySelectorAll(".session-tab")].map((t) => (t.innerText || "").trim()),
  };
})()`);
check(
  "新建 tmux 会话：自己填的名字真的传给了后端（tmuxMode=name + tmuxName）",
  tmuxNamed.mode === "name" && tmuxNamed.name === typedTmuxName,
  `tmuxMode=${tmuxNamed.mode} tmuxName=${tmuxNamed.name}`,
);
check(
  "新建 tmux 会话：标签栏显示的是自己填的名字（不是后端的自动名）",
  tmuxNamed.tabs.some((t) => t.includes(typedTmuxName)),
  JSON.stringify(tmuxNamed.tabs),
);

// Bug 2-a：点弹窗外面 = 保存
async function openSessionRename() {
  await evaluate(`(() => {
    const tab = document.querySelector(".session-tab");
    if (!tab) return false;
    tab.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 120, clientY: 60 }));
    return true;
  })()`);
  await sleep(600);
  await evaluate(`(() => {
    const mi = [...document.querySelectorAll(".ctx-menu .menu-item")].find((x) =>
      (x.innerText || "").includes("重命名会话"));
    if (mi) mi.click();
    return !!mi;
  })()`);
  await sleep(600);
}
const renameSel = ".modal input[placeholder*='后端调试']";
await openSessionRename();
const renameOpened = await evaluate(`!!document.querySelector(${JSON.stringify(renameSel)})`);
const renamedTo = "改过的会话名";
await evaluate(`(() => {
  const inp = document.querySelector(${JSON.stringify(renameSel)});
  if (!inp) return false;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(inp, ${JSON.stringify("改过的会话名")});
  inp.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
})()`);
await sleep(300);
await evaluate(`(() => {
  const bd = document.querySelector(".modal-backdrop");
  if (!bd) return false;
  bd.click();
  return true;
})()`);
await sleep(1000);
const afterOutside = await evaluate(`(() => ({
  tabs: [...document.querySelectorAll(".session-tab")].map((t) => (t.innerText || "").trim()),
  stillOpen: !!document.querySelector(${JSON.stringify(renameSel)}),
  typed: (document.querySelector(${JSON.stringify(renameSel)}) || {}).value ?? "",
  savedName: JSON.stringify(window.__ZEEAI_CALLARGS__.filter((c) => c.cmd === "history_save").slice(-1)),
}))()`);
check(
  "重命名：点到弹窗外面**不关也不丢**（弹窗留着、字留着、没写库）",
  renameOpened &&
    afterOutside.stillOpen &&
    afterOutside.typed === renamedTo &&
    !afterOutside.tabs.some((t) => t.includes(renamedTo)) &&
    !afterOutside.savedName.includes(renamedTo),
  `弹窗开过=${renameOpened} 还开着=${afterOutside.stillOpen} 输入框=${JSON.stringify(
    afterOutside.typed,
  )} 已落历史=${afterOutside.savedName.includes(renamedTo)}`,
);

// Bug 2-a2：写库只能靠「保存」/ Enter
await evaluate(`(() => {
  const btn = [...document.querySelectorAll(".modal-actions .btn")].find(
    (b) => (b.innerText || "").trim() === "保存");
  if (btn) btn.click();
  return !!btn;
})()`);
await sleep(900);
const afterSave = await evaluate(`(() => ({
  tabs: [...document.querySelectorAll(".session-tab")].map((t) => (t.innerText || "").trim()),
  stillOpen: !!document.querySelector(${JSON.stringify(renameSel)}),
  savedName: JSON.stringify(window.__ZEEAI_CALLARGS__.filter((c) => c.cmd === "history_save").slice(-1)),
}))()`);
check(
  "重命名：点「保存」才写库并关闭",
  !afterSave.stillOpen &&
    afterSave.tabs.some((t) => t.includes(renamedTo)) &&
    afterSave.savedName.includes(renamedTo),
  `还开着=${afterSave.stillOpen} tabs=${JSON.stringify(afterSave.tabs)}`,
);

// Bug 2-b：Esc = 取消（保留原名）
await openSessionRename();
await evaluate(`(() => {
  const inp = document.querySelector(${JSON.stringify(renameSel)});
  if (!inp) return false;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(inp, "不该保存的名字");
  inp.dispatchEvent(new Event("input", { bubbles: true }));
  inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  return true;
})()`);
await sleep(900);
const afterEsc = await evaluate(`(() => ({
  tabs: [...document.querySelectorAll(".session-tab")].map((t) => (t.innerText || "").trim()),
  stillOpen: !!document.querySelector(${JSON.stringify(renameSel)}),
}))()`);
check(
  "重命名：Esc = 取消（保留原名，不写入）",
  !afterEsc.stillOpen &&
    afterEsc.tabs.some((t) => t.includes(renamedTo)) &&
    !afterEsc.tabs.some((t) => t.includes("不该保存的名字")),
  JSON.stringify(afterEsc.tabs),
);

console.log("\n--- 页面控制台里的 error/warning ---");
for (const c of consoleMsgs.slice(0, 15)) console.log("  " + c.slice(0, 200));
console.log(`\n截图：${shot1}\n${shot2}\n${shot3}\n${shot4}\n${shotLight}（浅色主题·设置面板）\n${shotComposer}（AI 输入窗）\n${shotArrowZoom}（箭头放大 4×）\n${shotCollapsed}（收起态）\n${shotExpanded}（展开态）`);

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
