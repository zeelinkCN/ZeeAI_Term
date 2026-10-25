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
  // 默认不拖慢；只有验「刷新」按钮的「探测中…」状态时才临时打开（见下面的 resolveCmd）
  slowAi: false,
};
window.__ZEEAI_SESSION__ = ${JSON.stringify({
  version: 1,
  savedAt: Date.now(),
  activeIndex: 0,
  sessions: lz
    ? [{ kind: "remote", title: "lz · codex", profileId: lz.id, user: lz.ssh?.user, tmuxMode: "none" }]
    : [],
})};

// ---------- 看板 v2：把前端送进来的 BoardSources 合成为「AI 实例」 ----------
// 这是**后端 core/ai_instance.rs 的镜像**（口径 docs/design-ai-board-v2.md §10）。
// 为什么要有一份镜像：真合并逻辑在 Rust 里（有 16 条单测兜着），但无头测试要能验
// **前端**那一侧 —— 卡片是不是按统一模型渲染、红点是不是按两条规则亮。
// 所以这里只镜像语义（承载闸门 / 陈旧降级 / 一个实例一张卡），不追求逐字节一致。
const MOCK_STALE_MS = 10 * 60 * 1000;
const MOCK_CARRIER_SPEC = { herdr: 5, tmux: 4, "ssh-bare": 3, "local-powershell": 2, wsl: 1, "local-cmd": 0 };
const MOCK_CARRIER_KEY = {
  herdr: "herdr", tmux: "tmux", "ssh-bare": "ssh",
  "local-powershell": "local", wsl: "wsl", "local-cmd": "cmd",
};
const MOCK_CARRIER_LABEL = {
  herdr: "herdr \u7b2c\u4e00\u624b", tmux: "tmux \u7a97\u683c", "ssh-bare": "\u88f8 SSH",
  "local-powershell": "\u672c\u673a\u8fdb\u7a0b\u8868", wsl: "WSL \u8fdb\u7a0b\u626b\u63cf",
  "local-cmd": "\u672c\u673a CMD",
};
const MOCK_SRC_LABEL = {
  "herdr-agent-list": "herdr \u7b2c\u4e00\u624b", "app-ledger": "\u672c\u5e94\u7528\u8d26\u672c",
  rollout: "rollout \u65e5\u5fd7", "remote-tmux-ps": "\u8fdc\u7a0b\u8fdb\u7a0b\u626b\u63cf",
  "local-process-table": "\u672c\u673a\u8fdb\u7a0b\u8868", "wsl-ps": "WSL \u8fdb\u7a0b\u626b\u63cf",
};
const MOCK_SRC_RANK = {
  "herdr-agent-list": 5, "app-ledger": 4, rollout: 3, "remote-tmux-ps": 2,
  "local-process-table": 1, "wsl-ps": 0,
};
const MOCK_AGENT = { codex: "codex", claude: "claude", gemini: "gemini", aider: "aider" };
const mockAgentOf = (tool) => MOCK_AGENT[String(tool || "").trim().toLowerCase()] || (String(tool || "").trim() ? { other: String(tool).trim() } : "unknown");
const mockAgentKey = (a) => (a && typeof a === "object" ? String(a.other || "").toLowerCase() : String(a || ""));
const mockAllowsNeedsYou = (c) => c === "herdr";
const mockSanitize = (carrier, state) => {
  if (carrier === "local-cmd") return [state === "unknown" ? "unknown" : "unknown", state === "unknown" ? null : state];
  if (state === "needs-you" && !mockAllowsNeedsYou(carrier)) return ["working", "needs-you"];
  if (state === "finished" && (carrier === "ssh-bare" || carrier === "local-cmd")) return ["unknown", "finished"];
  return [state, null];
};
const mockHumanAge = (ms) => {
  const s = Math.floor((ms || 0) / 1000);
  if (s < 60) return s + " \u79d2\u524d";
  if (s < 3600) return Math.floor(s / 60) + " \u5206\u949f\u524d";
  return Math.floor(s / 3600) + " \u5c0f\u65f6\u524d";
};
const mockBadge = (inst) => {
  const evs = inst.evidence.slice().sort((a, b) =>
    (Number(b.confidence === "first-hand") - Number(a.confidence === "first-hand")) ||
    (MOCK_SRC_RANK[b.source] - MOCK_SRC_RANK[a.source]));
  const src = evs[0] ? evs[0].source : "local-process-table";
  let s = (MOCK_SRC_LABEL[src] || src) + " \u00b7 " + mockHumanAge(inst.ageMs);
  if (!inst.evidence.some((e) => e.confidence === "first-hand")) s += "\uff0c\u53ea\u80fd\u8bf4\u660e\u5b83\u5728\u8dd1";
  if (inst.state === "unknown" && inst.downgradedFrom === "working") s += "\uff1b\u8d85\u8fc7 10 \u5206\u949f\u6ca1\u6709\u65b0\u8bc1\u636e\uff0c\u53ef\u80fd\u5df2\u5361\u4f4f";
  return s;
};
const mockMergeBoard = (src, nowMs) => {
  const builders = [];
  const orphans = [];
  const push = (ob) => {
    const anchor = ob.anchor ? ob.anchor.kind + ":" + ob.anchor.value : null;
    if (!anchor) { orphans.push(ob); return; }
    const hit = builders.find((b) => b.carrier === ob.carrier && b.env === ob.env && b.anchor === anchor);
    if (hit) {
      hit.evidence.push({ source: ob.source, atMs: ob.atMs, confidence: ob.confidence });
      hit.claims.push({ source: ob.source, state: ob.state });
      hit.activity = Object.assign({}, hit.activity, ob.activity);
      if (!hit.sessionId) hit.sessionId = ob.sessionId;
    } else {
      builders.push({
        carrier: ob.carrier, agent: ob.agent, env: ob.env, cwd: ob.cwd, anchor: anchor,
        sessionId: ob.sessionId,
        evidence: [{ source: ob.source, atMs: ob.atMs, confidence: ob.confidence }],
        claims: [{ source: ob.source, state: ob.state }],
        activity: Object.assign({}, ob.activity),
      });
    }
  };
  const matchesIdentity = (b, ob) => b.env === ob.env && mockAgentKey(b.agent) === mockAgentKey(ob.agent) && !!b.cwd && !!ob.cwd && b.cwd === ob.cwd;
  const taskObs = (t) => {
    const env = t.env === "local" ? "\u672c\u673a" : t.env === "wsl" ? "WSL" : t.server;
    const pane = String(t.pane || "").trim();
    // cmdCarrier：场景显式声明"这是个 CMD 会话"（本机扫描其实看不出 CMD / PowerShell，
    // 所以真后端那边由前端按会话类型补）—— 用来验 §10.5 的空承载闸门。
    const carrier = t.cmdCarrier
      ? "local-cmd"
      : t.env === "local"
        ? "local-powershell"
        : t.env === "wsl"
          ? "wsl"
          : pane
            ? "tmux"
            : "ssh-bare";
    const source = t.source === "app" ? "app-ledger" : t.source === "winproc" ? "local-process-table" : (t.env === "local" ? "local-process-table" : t.env === "wsl" ? "wsl-ps" : "remote-tmux-ps");
    const state = t.state === "running" ? "working" : t.state === "done" ? "finished" : "unknown";
    const anchor = t.source === "app" && t.id ? { kind: "ledger", value: t.id } : pane ? { kind: "tmux", value: pane } : t.pid > 0 ? { kind: "pid", value: String(t.pid) } : null;
    return {
      carrier, agent: mockAgentOf(t.tool), env, cwd: (t.cwd || "").trim() || null, anchor, state, source,
      atMs: nowMs, confidence: source === "app-ledger" ? "first-hand" : "inferred", sessionId: null,
      activity: { lastLine: (t.command || "").trim() || null, artifacts: [] },
    };
  };
  (src.tasks || []).forEach((t) => push(taskObs(t)));
  (src.herdr || []).forEach((g) => {
    (g.agents || []).forEach((a) => {
      const st = { working: "working", blocked: "needs-you", done: "finished", idle: "idle" }[String(a.status || "").trim().toLowerCase()] || "unknown";
      push({
        carrier: "herdr", agent: mockAgentOf(a.kind), env: g.env, cwd: (a.cwd || "").trim() || null,
        anchor: a.paneId ? { kind: "herdr", value: a.paneId } : null, state: st,
        source: "herdr-agent-list", atMs: nowMs, confidence: "first-hand", sessionId: null,
        activity: {
          lastLine: a.title && a.title !== a.cwd ? a.title : null,
          artifacts: Array.isArray(a.artifacts) ? a.artifacts.slice() : [],
        },
      });
    });
  });
  (src.ledger || []).forEach((g) => {
    (g.items || []).forEach((it) => {
      const state = it.running ? "working" : "finished";
      const at = Math.min((it.last_running_at || 0) * 1000, nowMs);
      push({
        carrier: g.carrier || "local-powershell", agent: mockAgentOf(it.tool), env: g.env,
        cwd: g.cwd || null,
        anchor: g.herdrPane ? { kind: "herdr", value: g.herdrPane } : g.tmuxTarget ? { kind: "tmux", value: g.tmuxTarget } : { kind: "ledger", value: it.id },
        state, source: "app-ledger", atMs: at, confidence: "first-hand", sessionId: g.sessionId || null,
        activity: { lastLine: (it.command || "").trim() || null, artifacts: [] },
      });
    });
  });
  (src.rollouts || []).forEach((g) => {
    const s = g.snapshot || {};
    const cwd = (s.cwd || "").trim() || null;
    const state = { running: "working", idle: "idle", "needs-approval": "needs-you", "waiting-user": "needs-you" }[s.state] || "unknown";
    const env = g.env;
    push({
      carrier: g.carrier || (env === "\u672c\u673a" ? "local-powershell" : "ssh-bare"),
      agent: "codex", env, cwd, anchor: null, state, source: "rollout", atMs: nowMs,
      confidence: "inferred", sessionId: s.sessionId || null,
      activity: { lastLine: (s.lastMessage || s.lastAction || "").trim() || null, artifacts: (g.artifacts || []).slice() },
    });
  });
  orphans.forEach((ob) => {
    const cands = builders.filter((b) => matchesIdentity(b, ob));
    if (cands.length === 1) {
      const b = cands[0];
      b.evidence.push({ source: ob.source, atMs: ob.atMs, confidence: ob.confidence });
      b.claims.push({ source: ob.source, state: ob.state });
      b.activity = Object.assign({}, b.activity, ob.activity);
      if (!b.sessionId) b.sessionId = ob.sessionId;
    } else {
      builders.push({
        carrier: ob.carrier, agent: ob.agent, env: ob.env, cwd: ob.cwd, anchor: null,
        sessionId: ob.sessionId,
        evidence: [{ source: ob.source, atMs: ob.atMs, confidence: ob.confidence }],
        claims: [{ source: ob.source, state: ob.state }],
        activity: Object.assign({}, ob.activity),
      });
    }
  });
  const merged = [];
  builders.slice()
    .sort((a, b) => (MOCK_CARRIER_SPEC[b.carrier] || 0) - (MOCK_CARRIER_SPEC[a.carrier] || 0))
    .forEach((b) => {
      const dup = merged.find((m) =>
        m.env === b.env && mockAgentKey(m.agent) === mockAgentKey(b.agent) && m.cwd === b.cwd &&
        (MOCK_CARRIER_SPEC[m.carrier] || 0) > (MOCK_CARRIER_SPEC[b.carrier] || 0) &&
        m.carrier === "herdr" && b.carrier !== "herdr");
      if (dup) {
        b.evidence.forEach((e) => { if (!dup.evidence.some((x) => x.source === e.source && x.atMs === e.atMs)) dup.evidence.push(e); });
        dup.claims = dup.claims.concat(b.claims);
        dup.activity = Object.assign({}, dup.activity, b.activity);
        if (!dup.sessionId) dup.sessionId = b.sessionId;
      } else {
        merged.push(b);
      }
    });
  const out = [];
  merged.forEach((b) => {
    let best = null;
    b.evidence.forEach((e) => {
      const key = [e.confidence === "first-hand" ? 1 : 0, MOCK_SRC_RANK[e.source] || 0, e.atMs];
      if (!best || key[0] > best.key[0] || (key[0] === best.key[0] && (key[1] > best.key[1] || (key[1] === best.key[1] && key[2] > best.key[2])))) best = { key: key, ev: e };
    });
    const claimed = best ? (b.claims.find((c) => c.source === best.ev.source) || {}).state || "unknown" : "unknown";
    const san = mockSanitize(b.carrier, claimed);
    let state = san[0];
    let downgraded = san[1];
    const latest = b.evidence.reduce((a, e) => Math.max(a, e.atMs), 0);
    if (state === "working" && nowMs - latest > MOCK_STALE_MS) { downgraded = downgraded || "working"; state = "unknown"; }
    if (b.carrier === "local-cmd") return;
    if (mockAgentKey(b.agent) === "") return;
    const anchorKey = (b.anchor || "log").split(":").slice(0, 1)[0] + ":" + (b.anchor || "log");
    const whereParts = [b.env];
    if (b.cwd) whereParts.push(b.cwd);
    whereParts.push(b.anchor ? b.anchor.replace(":", ":") : "log");
    const inst = {
      id: (MOCK_CARRIER_KEY[b.carrier] || b.carrier) + ":" + whereParts.join("/") + ":" + anchorKey,
      carrier: b.carrier, agent: b.agent, where: whereParts.join(" \u00b7 "), state: state,
      evidence: b.evidence, activity: b.activity, sessionId: b.sessionId || null,
      downgradedFrom: downgraded, ageMs: Math.max(0, nowMs - latest),
    };
    inst.badge = mockBadge(inst);
    out.push(inst);
  });
  const rank = { "needs-you": 0, working: 1, finished: 2, idle: 3, unknown: 4 };
  // ⚠️ 必须给兜底值：rank[x] - rank[y] 里只要有一个 undefined 就是 NaN，
  //    而 [].sort 的比较函数返回 NaN 时**排序结果不确定**、元素可能被丢掉
  //（这里真踩过：idle 的实例从看板上凭空消失）。
  const rankOf = (x) => (rank[x] === undefined ? 9 : rank[x]);
  out.sort((a, b) => (rankOf(a.state) - rankOf(b.state)) || mockAgentKey(a.agent).localeCompare(mockAgentKey(b.agent)) || a.id.localeCompare(b.id));
  return out;
};

const noop = () => {};
const resolveCmd = (cmd, args, opts) => {
  const M = window.__ZEEAI_MOCK__;
  const S = window.__ZEEAI_SCENARIO__;
  // slowAi：把一次探测拖慢 1.2 秒，用来验证「刷新」按钮的「探测中…」状态。
  // 真后端这些命令都要 ssh / 枚举进程，绝不止几毫秒；mock 默认是瞬时返回，看不到中间态。
  // opts.fast 是内部重入标记，避免自己递归自己。
  if (
    S.slowAi &&
    !(opts && opts.fast) &&
    ["ai_probe", "ai_source_probe", "ai_tasks_remote", "ai_instances"].includes(cmd)
  ) {
    return new Promise((r) => setTimeout(() => r(resolveCmd(cmd, args, { fast: true })), 1200));
  }
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
    case "ai_timeline_list": return S.timeline || [];
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
    // 看板 v2 的场景任务（herdrTasks）：假的"远端 tmux+ps 扫描结果"。
    // 真后端那两条路是 ssh 出去跑 tmux/ps，无头测试里没法真跑，所以用场景数据代替；
    // 它们走的仍然是**同一条链路**（前端采集 → BoardSources → ai_instances）。
    case "ai_tasks_remote": return (S.herdrTasks || []).concat(S.tasks || []);
    // 看板 v2：合并 + 承载闸门 + 陈旧降级都在"后端"（这里是镜像），前端只画
    case "ai_instances": {
      const merged = mockMergeBoard(args && args.sources ? args.sources : {}, Date.now());
      // 调试用：把"后端"合出来的东西留一份，断言失败时能直接看
      window.__ZEEAI_LAST_BOARD__ = merged;
      window.__ZEEAI_LAST_SOURCES__ = args && args.sources ? args.sources : {};
      return merged;
    }
    // 本机进程扫描：和真后端一样返回 AiTask[]。默认空 —— 需要验"本机卡片"的用例
    // （例如按输出活动推断运行中）显式放 localTasks，和远端那条路分开，互不污染。
    case "ai_tasks_local": return S.localTasks || [];
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
    case "ssh_diagnose": {
      if (S.diagError) {
        return Promise.reject(new Error("系统没有 OpenSSH 客户端（请先在 Windows 可选功能里安装 OpenSSH 客户端）"));
      }
      return mockDiagnosis(!!S.diagNoKey);
    }
    case "open_ssh": {
      // 认证失败场景：模拟"本机有密钥、却还是被服务器拒了"（勾了允许输入密码那种）。
      // 用真后端同款文案（中文短句｜原始信息：<英文>），前端才会走"密码模式提示"那条路。
      if (S.openSshFail) {
        return Promise.reject(
          new Error("认证失败（用户名、密码或密钥不对，或服务器不允许这种登录方式）｜原始信息：Permission denied (publickey)"),
        );
      }
      // 记下这条会话的 Channel id：测试要用它模拟"终端真的收到输出"（见 __ZEEAI_TERM_DATA__）。
      if (args && args.id && args.onEvent) window.__ZEEAI_SESSION_CHANNELS__[args.id] = args.onEvent.id;
      return {
        id: "mock-1", profileId: (window.__ZEEAI_SESSION__.sessions[0] || {}).profileId || "",
        // 跟真实后端一样：herdr 会话的标题里带上窗格号（用户要能一眼分清是哪个窗格）
        title:
          (args && (args.backend === "herdr-control" || args.backend === "herdr-pane") && args.tmuxName)
            ? "lz · herdr " + args.tmuxName
            : "lz · codex",
        kind: "ssh", tmuxSession: null, user: "lz", host: "192.0.2.45",
      };
    }
    case "open_local": {
      if (args && args.id && args.onEvent) window.__ZEEAI_SESSION_CHANNELS__[args.id] = args.onEvent.id;
      return { id: "mock-1", profileId: "", title: "PowerShell", kind: "local", tmuxSession: null, user: null, host: null };
    }
    case "session_write": case "session_resize": case "session_close": return null;
    case "plugin:event|listen": {
      // 事件通道要**真的记住 handler**：红点那条链路的自动来源就是后端事件，
      // 测试里用 window.__ZEEAI_EMIT__ 模拟"后端推来一条 zeeai://ai-log"。
      // tauri 的 listen() 走 invoke('plugin:event|listen', {event, handler: <callback id>})，
      // handler 已经被 transformCallback 存进 window["_"+id]。
      const ev = (args && args.event) || "";
      const set = window.__ZEEAI_LISTENERS__[ev] || (window.__ZEEAI_LISTENERS__[ev] = new Set());
      set.add(args && args.handler);
      return 1;
    }
    case "plugin:event|unlisten": {
      const set = window.__ZEEAI_LISTENERS__[(args && args.event) || ""];
      if (set) set.clear();
      return null;
    }
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
// 模拟"后端 emit 了一条事件"（红点断言用）。
// 走的是和真 Tauri 一样的回调形状：{event, id, payload}。
window.__ZEEAI_LISTENERS__ = {};
window.__ZEEAI_EMIT__ = (event, payload) => {
  const set = window.__ZEEAI_LISTENERS__[event];
  if (!set) return 0;
  let n = 0;
  for (const id of Array.from(set)) {
    const cb = window["_" + id];
    if (typeof cb === "function") {
      try {
        cb({ event, id: 1, payload });
        n++;
      } catch (e) {
        console.error(e);
      }
    }
  }
  return n;
};
// ---------- 模拟"终端真的收到输出"（给"按输出活动推断运行中"那组断言用） ----------
//
// 真链路上会话的输出是 Rust 侧通过 Channel<SessionEvent> 推过来的；这里拿到的是
// open_local / open_ssh 的 onEvent Channel 对象，它的 id 由 transformCallback 登记过，
// 所以可以直接按 Channel 的协议形状（{index, message}）回调 —— 数据会走
// bus.push → xterm.write → onWriteParsed → markOutput，和用户终端里一模一样。
// 注意：**不直接调 markOutput**，否则测的就不是"输出真的进了终端"这条链路了。
window.__ZEEAI_SESSION_CHANNELS__ = {};
window.__ZEEAI_CHANNEL_INDEX__ = {};
window.__ZEEAI_TERM_EVENT__ = (sessionId, message) => {
  const channelId = window.__ZEEAI_SESSION_CHANNELS__[sessionId];
  const cb = channelId !== undefined ? window["_" + channelId] : null;
  if (typeof cb !== "function") return false;
  const index = window.__ZEEAI_CHANNEL_INDEX__[channelId] || 0;
  window.__ZEEAI_CHANNEL_INDEX__[channelId] = index + 1;
  cb({ index, message });
  return true;
};
window.__ZEEAI_TERM_DATA__ = (sessionId, text) => {
  const bytes = new TextEncoder().encode(String(text || ""));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return window.__ZEEAI_TERM_EVENT__(sessionId, { type: "data", data: btoa(bin) });
};
window.__ZEEAI_TERM_CWD__ = (sessionId, path) =>
  window.__ZEEAI_TERM_EVENT__(sessionId, { type: "cwd", path });
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
// 只挑真正的页面 target：新 profile 的 Edge 有时会额外开一条 edge://sync-confirmation-dialog，
// 如果它在列表前面，连过去之后窗口尺寸/页面都不是被测应用（表现为所有布局断言都怪怪的）。
const page =
  targets.find((t) => t.type === "page" && !/^(edge|chrome|devtools):/.test(t.url)) ??
  targets.find((t) => t.type === "page");
if (!page) throw new Error("无头浏览器里找不到页面 target");
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
    // 把一次 AI 探测拖慢（只给「刷新」按钮的中间态用例用）；每个场景显式归零，
    // 否则下一段会一直慢 1.2 秒。
    slowAi: false,
    // 连接诊断 / 密码模式提示那组（Z3）用的开关：每个场景显式归零，避免漏到下一段
    openSshFail: false,
    diagNoKey: false,
    diagError: false,
    allowPassword: false,
    // 看板 v2 的场景数据（前端只采集、后端合并 —— 假后端那份合并见 mockMergeBoard）。
    // ⚠️ herdrTasks / herdrScan **故意不在这里重置**：注入脚本是累积的，每轮都写 null
    //    会把前面场景放进去的任务清空（我踩过一次：D2 那条用例的卡片突然只剩 herdr 的）。
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

// ---------- 手动「刷新」小工具（这一轮把 AI 面板的定时探测全删了） ----------
// 以前面板打开后数据是定时器自动刷进来的，测试只要 sleep 一下；现在必须自己点「刷新」。
// 这样也顺便保证测试走的就是用户的那条路：打开面板 → 点刷新 → 看结果。
/** 打开 AI 面板（已经开着就不动），**不触发任何探测** */
const openAiPanel = async () => {
  if (await evaluate(`!!document.querySelector(".ai-panel")`)) return true;
  await evaluate(`(() => {
    const btns = [...document.querySelectorAll("button")];
    const b = btns.find((x) => (x.title || "").includes("AI")) || btns.find((x) => x.className.includes("ai"));
    if (!b) return false;
    b.click();
    return true;
  })()`);
  await sleep(300);
  return await evaluate(`!!document.querySelector(".ai-panel")`);
};
/** 收起 AI 面板（红点那条"点开即清"的断言要重新走一次打开动作） */
const closeAiPanel = async () => {
  await evaluate(`(() => {
    const b = document.querySelector(".ai-panel .ai-head .mini-x");
    if (b) b.click();
    return !!b;
  })()`);
  await sleep(250);
};
/** 读标题栏那个「刷新」按钮的当前文字 / 是否禁用 */
const readRefreshButton = async () =>
  evaluate(`(() => {
    const p = document.querySelector(".ai-panel");
    const b = p && [...p.querySelectorAll(".ai-head button")].find((x) =>
      ["刷新", "探测中…"].includes((x.textContent || "").trim()));
    return b ? { text: (b.textContent || "").trim(), disabled: !!b.disabled } : { text: "", disabled: false };
  })()`);
/** 点标题栏的「刷新」（只找文字**正好**是「刷新」的那个按钮） */
const clickRefreshButton = async () =>
  evaluate(`(() => {
    const p = document.querySelector(".ai-panel");
    if (!p) return { found: false };
    const b = [...p.querySelectorAll(".ai-head button")].find((x) => (x.textContent || "").trim() === "刷新");
    if (!b) return { found: false, head: [...p.querySelectorAll(".ai-head button")].map((x) => (x.textContent || "").trim()) };
    b.click();
    return { found: true };
  })()`);
/** 点「刷新」并等这一轮探测跑完（按钮从「探测中…」恢复成「刷新」） */
const refreshAiPanel = async (timeoutMs = 25000) => {
  const clicked = await clickRefreshButton();
  if (!clicked.found) return clicked;
  // 先给 React 一个渲染「探测中…」的机会；mock 快时可能已经跑完，所以下面按文字判断
  await sleep(150);
  const t0 = Date.now();
  for (;;) {
    const st = await readRefreshButton();
    if (st.text === "刷新") return { ...clicked, ok: true };
    if (Date.now() - t0 > timeoutMs) return { ...clicked, ok: false, state: st };
    await sleep(100);
  }
};
/** 打开面板 + 手动刷新一次 + 等卡片渲染完 */
const openAiPanelAndRefresh = async () => {
  const opened = await openAiPanel();
  const refreshed = await refreshAiPanel();
  await sleep(500);
  return { opened, refreshed };
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

// ================= 手动「刷新」：这一轮把 AI 面板的定时探测全删了 =================
// 用户原话：「把这个功能去掉算了，不探测了，影响电脑性能」→ 确认后：「保留手动刷新，
// 按钮就叫做刷新」。所以下面先钉住反面：不点刷新时 AI 探测命令一次都不许自己跑。
const AI_PROBE_CMDS = [
  "ai_probe", "ai_source_probe", "ai_session_snapshot", "ai_task_artifacts",
  "ai_tasks_remote", "ai_tasks_local", "ai_instances", "ai_timeline_list",
  "herdr_agents", "herdr_server_status", "herdr_workspace_scan",
];
const countAiProbes = () =>
  evaluate(`(() => {
    const want = ${JSON.stringify(AI_PROBE_CMDS)};
    return (window.__ZEEAI_CALLARGS__ || []).filter((c) => want.includes(c.cmd)).length;
  })()`);
const probesAtStart = await countAiProbes();
// 等 12 秒：以前的 8s / 10s 定时器在这个窗口里至少会跑一轮
await sleep(12000);
const probesAfterIdle = await countAiProbes();
check(
  "不点「刷新」：12 秒内 AI 探测命令一次都没被调用（8s/10s/20s/30s 定时器已删）",
  probesAfterIdle === probesAtStart,
  `${probesAtStart} → ${probesAfterIdle}`,
);

// 打开面板本身也不探测 —— "点了才查一次"
const panelOpened = await openAiPanel();
await sleep(1200);
const probesAfterOpen = await countAiProbes();
const panelEmpty = await evaluate(`(() => {
  const p = document.querySelector(".ai-panel");
  if (!p) return null;
  const b = [...p.querySelectorAll(".ai-head button")].find((x) => ["刷新", "探测中…"].includes((x.textContent || "").trim()));
  return { text: p.innerText, button: b ? (b.textContent || "").trim() : "" };
})()`);
check(
  "打开 AI 面板本身不触发探测（只有点「刷新」才查一次）",
  panelOpened && probesAfterOpen === probesAtStart,
  `open=${panelOpened} 探测调用 ${probesAtStart} → ${probesAfterOpen}`,
);
check(
  "面板没数据时提示「点「刷新」看看本机 / 服务器上现在有没有 AI 在跑」",
  !!panelEmpty && panelEmpty.text.includes("点「刷新」看看本机 / 服务器上现在有没有 AI 在跑"),
  panelEmpty ? panelEmpty.text.split("\n").slice(0, 8).join(" / ") : "(面板没打开)",
);
check(
  "标题栏那个按钮文字就是「刷新」",
  !!panelEmpty && panelEmpty.button === "刷新",
  panelEmpty ? `按钮=${panelEmpty.button}` : "",
);

// ③ 点刷新后的「探测中…」状态：用 slowAi 把 mock 探测拖慢 1.2 秒才看得到中间态。
await setScenario({ slowAi: true });
await reload();
await openAiPanel();
const beforeSlow = await countAiProbes();
const slowClicked = await clickRefreshButton();
await sleep(250);
const slowDuring = await readRefreshButton();
check(
  "点「刷新」后按钮变成「探测中…」且不可再点",
  slowClicked.found && slowDuring.text === "探测中…" && slowDuring.disabled,
  JSON.stringify(slowDuring),
);
await sleep(4600);
const slowAfter = await readRefreshButton();
const afterSlow = await countAiProbes();
check(
  "探测跑完后按钮恢复成「刷新」，而且探测命令确实被调用了",
  slowAfter.text === "刷新" && afterSlow > beforeSlow,
  `按钮=${slowAfter.text} 探测调用 ${beforeSlow} → ${afterSlow}`,
);

// 回到正常 mock：手动刷新一次，把面板数据拉出来（原来自动轮询会给的那份）
await setScenario({ slowAi: false });
await reload();
await openAiPanelAndRefresh();
const shot2 = await shot("02-ai-panel.png");
const panel = await evaluate("document.querySelector('.ai-panel') ? document.querySelector('.ai-panel').innerText : ''");
check("AI 面板能打开并刷出数据", panel.length > 0, `面板 ${panel.length} 字`);
check(
  "面板第一眼只有「需要你」「运行中」两个区（§10.2）",
  panel.includes("需要你 1") && panel.includes("运行中 0"),
  panel.split("\n").slice(0, 6).join(" / "),
);
// 卡片本身要显示"需要你"（不是靠面板顶部那条通知文字）：
// 用 `.ai-task.needs-approval` 直接看那一张卡，标签写的是 "OpenAI Codex CLI"。
const needsCardText = await evaluate(`(() => {
  const cards = [...document.querySelectorAll(".ai-panel .ai-task.needs-approval")];
  return cards.map((c) => (c.innerText || "").replace(/\\n/g, " / "));
})()`);
check(
  "herdr 卡片显示「需要你」（§10.6 唯一值得亮红点的那件事）",
  needsCardText.length === 1 &&
    needsCardText[0].includes("OpenAI Codex CLI") &&
    needsCardText[0].includes("需要你"),
  JSON.stringify(needsCardText).slice(0, 220),
);
check("herdr 卡片带「查看窗格」入口", panel.includes("查看窗格"));
check(
  "卡片标了来源 = herdr 第一手（后端 badge()）",
  panel.includes("herdr 第一手"),
  panel.split("\n").find((l) => l.includes("herdr 第一手")) ?? "",
);
check("装了 herdr 时不显示一键安装", !panel.includes("一键安装"));

// ---------- herdr 服务生命周期：可见 + 可控（停止要二段确认） ----------
// 承载健康那一块只在"有异常"时出现（上面默认场景里有 3 个工作区没在用 / 2 个空壳）。
// 这里把工作区扫成"一个都没有"，健康块就回到正常态：只剩服务那一行。
// 注意 setScenario 只对**下一次加载**生效，所以必须 reload 再重新打开面板 + 手动刷新。
await setScenario({ herdrScan: { workspaces: [], panes: [] } });
await reload();
await openAiPanelAndRefresh();
const panelHealth = await evaluate("document.querySelector('.ai-panel') ? document.querySelector('.ai-panel').innerText : ''");
check(
  "没有异常时「承载健康」不常驻：面板里不再有「herdr 工作区」「探测失败」这些行（§10.2）",
  !panelHealth.includes("herdr 工作区") && !panelHealth.includes("探测失败"),
  panelHealth.split("\n").filter((l) => l.includes("承载") || l.includes("工作区")).join(" / "),
);
check(
  "装了 herdr 时「服务：运行中」仍在（只是折起来，不占常驻位置）",
  panelHealth.includes("herdr 服务：运行中"),
  panelHealth.split("\n").find((l) => l.includes("herdr 服务")) ?? "",
);
// 把工作区扫描恢复成默认场景（后面的清理空壳用例还要用它）。
// 注意不能写 null：假后端是 `S.herdrScan || {默认}`，null 会被兜底吃掉、
// 继续沿用上一场景那个空数组。
await setScenario({
  herdrScan: {
    workspaces: ["w9", "wD", "wE"],
    panes: [
      { paneId: "w9:p1", procName: "bash" },
      { paneId: "wD:p1", procName: "bash" },
      { paneId: "wE:p1", procName: "claude" },
    ],
  },
});
// 恢复只对**下一次加载**生效，所以这里 reload 一次、重新打开面板并手动刷新。
// 这一步顺带验证"承载健康只在异常时出现"的**互斥**：有工作区要清理时，
// 面板上只给清理入口（不把"停止服务"也堆出来 —— 那正是它要收掉的乱）。
await reload();
await openAiPanelAndRefresh();
const healthRowNow = await evaluate(`(() => {
  const p = document.querySelector(".ai-panel");
  const all = [...p.querySelectorAll("button")];
  return {
    clean: all.some((x) => (x.textContent || "").includes("清理空壳")),
    stop: all.some((x) => (x.textContent || "").includes("停止服务")),
  };
})()`);
check(
  "有工作区要清理时，承载健康只给清理入口（不把「停止服务」也堆上来）",
  healthRowNow.clean && !healthRowNow.stop,
  JSON.stringify(healthRowNow),
);
// ---------- herdr 工作区生命周期：挑出"空壳" + 二段确认清理 ----------
// 这一段验的是"异常时才出现"的那块：默认场景里 3 个工作区没在用、其中 2 个是空壳，
// 所以承载健康那一行会带着清理入口出现（正常态它是收起的，见上面那两条断言）。
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

// ---------- 「停止服务」二段确认 ----------
// 放在工作区清理之后：清干净了健康块才回到"只有服务那一行"的形态，
// 那个开关才会露出来（有东西要清理时优先让用户清理，两行不堆一起 —— §10.2）。
const stopArmed = await evaluate(`(() => {
  // 用 textContent 而不是 innerText：那张"服务运行中"的折叠块（<details>）收起时
  // innerText 是空的，但里面的按钮照样点得动。
  const all = [...document.querySelectorAll(".ai-panel button")];
  const b = all.find((x) => (x.textContent || "").includes("停止服务"));
  if (!b) return { found: false, texts: all.map((x) => (x.textContent || "").trim()).slice(0, 14) };
  b.click();
  return { found: true };
})()`);
await new Promise((r) => setTimeout(r, 600));
const armed = await evaluate(`[...document.querySelectorAll(".ai-panel button")].map((b) => (b.textContent || "").trim())`);
check(
  "「停止服务」要二段确认（会关掉所有 herdr 窗格）",
  stopArmed.found && armed.some((x) => x.includes("确认停止")),
  `found=${stopArmed.found} ${JSON.stringify(stopArmed.texts || armed.slice(0, 14))}`,
);
// 取消掉，别把后面的用例带进"确认态"
await evaluate(`(() => {
  const b = [...document.querySelectorAll(".ai-panel button")].find((x) => (x.innerText || "").trim() === "取消");
  if (b) b.click();
})()`);

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

// 切成"没装 herdr"，再点一次「刷新」（只有手动刷新会重探状态来源）
await evaluate(`window.__ZEEAI_SCENARIO__.herdr = { herdrVersion: "", herdrPath: "", agents: 0, protocol: 0, schemaVersion: 0, schemaFingerprint: "", compat: "unknown" };`);
const missingRefresh = await refreshAiPanel();
await sleep(400);
const panel2 = await evaluate("document.querySelector('.ai-panel').innerText");
const shot3 = await shot("03-herdr-missing.png");
check(
  "没装 herdr 时给出「一键安装 herdr」",
  missingRefresh.ok && panel2.includes("一键安装 herdr"),
  panel2.split("\n").find((l) => l.includes("herdr")) ?? "",
);

// 新建会话对话框：herdr 那行不该再有"代替 tmux"的勾
// 先把场景切回"这台机器装了 herdr"（上面为了验证"没装时给安装入口"临时改成过没装），
// 并再点一次「刷新」强制重探，让应用里那份按服务器缓存的结果也刷新过来。
await evaluate(`(() => {
  window.__ZEEAI_SCENARIO__.herdr = {
    herdrVersion: "0.9.1", herdrPath: "/home/user/.local/bin/herdr", agents: 1,
    protocol: 22, schemaVersion: 1, schemaFingerprint: "226d4ecb", compat: "ok",
  };
  return true;
})()`);
await refreshAiPanel();
await sleep(400);
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

// ---------- 输入窗 → **本地 PowerShell**：正文与回车都要写进 PTY ----------
//
// 用户报（2026-10-16）：远程 SSH 的输入窗正常，**本地 PowerShell 回车发不过去**。
// 后端已用真机探针排除（`examples/local_enter_probe.rs`：原文+CR、bracketed paste+CR 都能执行，
// 只有 LF 不执行），所以这里钉住前端：本地会话必须和远程一样，正文与回车都送到。
const localComposerSend = await evaluate(`(async () => {
  const bar = document.querySelector(".composer-bar");
  if (bar && !document.querySelector(".composer-input")) bar.click();
  await new Promise((r) => setTimeout(r, 350));
  const ta = document.querySelector(".composer-input");
  if (!ta) return { error: "输入窗没打开", bar: !!bar };
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
  setter.call(ta, "本地回车的标记词");
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  const before = window.__ZEEAI_CALLARGS__.length;
  ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 900));
  const calls = window.__ZEEAI_CALLARGS__.slice(before).filter((c) => c.cmd === "session_write");
  const dec = (b64) => {
    try {
      return new TextDecoder().decode(Uint8Array.from(atob(String(b64 || "")), (ch) => ch.charCodeAt(0)));
    } catch (e) {
      return "<解码失败>";
    }
  };
  const payloads = calls.map((c) => dec((c.args || {}).dataB64));
  const textIdx = payloads.findIndex((p) => p.includes("本地回车的标记词"));
  const crIdx = payloads.findIndex((p) => p === "\\r");
  return {
    count: calls.length,
    ids: [...new Set(calls.map((c) => String((c.args || {}).id || "")))],
    payloads: payloads.map((p) => JSON.stringify(p)),
    textIdx,
    crIdx,
    trailing: crIdx >= 0 ? payloads.length - crIdx - 1 : -1,
  };
})()`);
check(
  "输入窗发给本地 PowerShell：正文与回车**分两次写**、回车在后且是最后一次写入",
  localComposerSend.textIdx === 0 &&
    localComposerSend.crIdx > localComposerSend.textIdx &&
    localComposerSend.trailing === 0,
  JSON.stringify(localComposerSend).slice(0, 320),
);
await evaluate(`(() => {
  const bar = document.querySelector(".composer-bar");
  if (bar && document.querySelector(".composer-input")) bar.click();
  const ta = document.querySelector(".xterm-helper-textarea");
  if (ta) ta.focus();
  return true;
})()`);
await sleep(300);

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
await openAiPanelAndRefresh();
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
await openAiPanelAndRefresh();
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
await openAiPanelAndRefresh();
const board2 = await evaluate(`(() => {
  const head = (document.querySelector(".ai-panel .ai-head")?.innerText || "").trim();
  const cards = [...document.querySelectorAll(".ai-panel .ai-task")].map((c) =>
    (c.innerText || "").replace(/\\n/g, " / "));
  const fold = [...document.querySelectorAll(".ai-panel .ai-fold")].find((b) =>
    (b.innerText || "").includes("空闲"));
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
    board2.fold.includes("▸ 空闲 1 项"),
  `卡片=${JSON.stringify(board2.cards).slice(0, 140)} 折叠行=${board2.fold}`
);
check(
  "卡片上不再出现 `lz · lz · wB:p1` 这种服务器名/项目名重复",
  board2.cards.length > 0 && board2.cards.every((c) => !c.includes("lz · lz")),
  JSON.stringify(board2.cards).slice(0, 160),
);
await evaluate(`(() => {
  const b = [...document.querySelectorAll(".ai-panel .ai-fold")].find((x) =>
    (x.innerText || "").includes("空闲"));
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
// 先打开 AI 面板（工具坞挂在它上面）并手动刷新一次
await openAiPanelAndRefresh();
// 诊断开关：假后端这一轮到底合出了什么（排查"卡片的断言挂了"时很有用）
if (process.env.ZEEAI_FE_DEBUG_BOARD) {
  const dbg = await evaluate(
    `JSON.stringify({ board: window.__ZEEAI_LAST_BOARD__ || null, herdr: (window.__ZEEAI_LAST_SOURCES__ || {}).herdr || null })`,
  );
  console.log("---- [debug] 假后端这一轮合出来的看板 ----\n" + dbg);
}
// 右下角的「AI 工具 / AI 命令行工具」坞已经整体删掉：按钮、浮层、悬停提示都不该再出现。
// 为什么要在真实渲染里查：这类入口很容易只删了 JSX、样式或状态里还留着一半。
const dockGone = await evaluate(`(() => {
  const p = document.querySelector(".ai-panel");
  const titles = [...document.querySelectorAll("button")]
    .map((b) => b.getAttribute("title") || "")
    .filter((t) => t.includes("AI 工具") || t.includes("命令行工具"));
  return {
    dock: !!document.querySelector(".tool-dock, .tool-dock-btn, .tool-dock-body, .ai-tool, .ai-tool-line"),
    text: (p ? p.innerText : document.body.innerText).includes("AI 工具"),
    titles,
  };
})()`);
check(
  "界面上找不到 AI 工具坞（右下角按钮 / 浮层 / 悬停提示都不存在）",
  !dockGone.dock && !dockGone.text && dockGone.titles.length === 0,
  JSON.stringify(dockGone),
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

// 清掉上一块场景留下的"进程扫描结果"（herdrTasks 是跨块累积的：注入脚本只覆盖
// 它显式写到的键，不写就等于沿用上一块 —— 不显式清会让卡片数一直涨）。
const clearBoardTasks = () => setScenario({ herdrTasks: null, herdrScan: null });

// ---------- (F0) 看板 v2 §10：两区 + 折叠行 + 徽标 + 闸门（界面照 docs/mockups/ai-board-v2.html） ----------
//
// 这一批断言就是"不能再退回去"的那几条：
//   §10.1 独立时间线列表不存在，只剩折叠一行（收起时不渲染明细）
//   §10.2 面板默认只有「需要你」「运行中」两个区；完成/空闲各一行折叠
//   §10.4 裸 SSH 永不出现「需要你」
//   §10.5 没跑 agent 的承载（CMD）不上板
//   §10.6 红点只认"需要你 / 跑完停下"
//
// 这一段要在"四个状态都有东西"的场景下验：补两条进程扫描结果 ——
// 一条远端裸 SSH（进「运行中」）、一条 tmux 已完成（进「最近完成」那一行）。
await setScenario({
  herdrScan: {
    workspaces: ["w9", "wD", "wE"],
    panes: [
      { paneId: "w9:p1", procName: "bash" },
      { paneId: "wD:p1", procName: "bash" },
      { paneId: "wE:p1", procName: "claude" },
    ],
  },
  herdrTasks: [
    { id: "ps:lz:9001", env: "remote", server: "lz", tool: "claude", command: "claude",
      cwd: "/srv/idle", pane: "", source: "ps", state: "running", durationMs: 3_000,
      pid: 9001, startedAt: null, exitCode: null },
    { id: "tmux:lz:web:0.1", env: "remote", server: "lz", tool: "gemini", command: "gemini",
      cwd: "/srv/web", pane: "web:0.1", source: "tmux", state: "done", durationMs: 60_000,
      pid: 0, startedAt: null, exitCode: null },
  ],
});
await reload();
await openAiPanelAndRefresh();
const v2 = await evaluate(`(() => {
  const p = document.querySelector(".ai-panel");
  if (!p) return { missing: true };
  const secs = [...p.querySelectorAll(".ai-section")].map((e) => (e.innerText || "").trim());
  const cards = [...p.querySelectorAll(".ai-task")];
  const folds = [...p.querySelectorAll(".ai-fold")].map((e) => (e.innerText || "").trim());
  const badges = [...p.querySelectorAll(".ai-task .ai-badge-owner")];
  return {
    secs,
    headCardCount: cards.length,
    folds,
    foldText: folds.join(" | "),
    badgeCount: badges.length,
    badgeText: badges.map((e) => (e.innerText || "").trim()),
    badgeTitle: badges.map((e) => e.getAttribute("title") || ""),
    hasTimeline: !!p.querySelector(".ai-timeline"),
    detailW1Z: cards.some((c) => (c.innerText || "").includes("w1Z:p1")),
    cardText: cards.map((c) => (c.innerText || "").replace(/\\n/g, " / ")),
    panelText: p.innerText,
  };
})()`);
const v2Folds = v2.folds || [];
check(
  "面板只有两个区：需要你 / 运行中（§10.2）",
  (v2.secs || []).some((s) => s.startsWith("需要你")) &&
    (v2.secs || []).some((s) => s.startsWith("运行中")) &&
    !(v2.secs || []).some((s) => s === "任务卡片"),
  JSON.stringify(v2.secs),
);
check(
  "没有独立的时间线列表：收起时 .ai-timeline 根本不存在（§10.1）",
  v2.hasTimeline === false,
  `hasTimeline=${v2.hasTimeline}`,
);
check(
  "「最近完成」「空闲」各折成一行，收起时不渲染明细（§10.1 / §10.2）",
  v2Folds.some((f) => f.startsWith("▸ 最近完成")) &&
    v2Folds.some((f) => f.startsWith("▸ 空闲")) &&
    v2.detailW1Z === false,
  v2.foldText,
);
await evaluate(`(() => {
  const b = [...document.querySelectorAll(".ai-panel .ai-fold")].find((x) =>
    (x.innerText || "").includes("空闲"));
  if (b) b.click();
})()`);
await sleep(400);
const v2Open = await evaluate(`(() => {
  const p = document.querySelector(".ai-panel");
  return {
    folds: [...p.querySelectorAll(".ai-fold")].map((e) => (e.innerText || "").trim()),
    cards: [...p.querySelectorAll(".ai-task")].map((c) => (c.innerText || "").replace(/\\n/g, " / ")),
  };
})()`);
check(
  "点开那一行才渲染明细（空闲的窗格这时才出现，且只给「查看窗格」）",
  v2Open.folds.some((f) => f.startsWith("▾ 空闲")) &&
    v2Open.cards.some((c) => c.includes("w1Z:p1")) &&
    !v2Open.cards.some((c) => c.includes("w1Z:p1") && c.includes("接管")),
  JSON.stringify(v2Open.cards).slice(0, 200),
);
check(
  "每张卡都有来源徽标（谁说的 / 多久前 / 能证明什么）（§3.3 / §10.2）",
  v2.badgeCount >= 1 &&
    v2.badgeText.every((b) => b.includes("前")) &&
    v2.badgeTitle.every((t) => t.includes("怎么得出的") && t.includes("谁说的") && t.includes("能证明什么")),
  `徽标=${JSON.stringify(v2.badgeText)} 悬停=${JSON.stringify(v2.badgeTitle[0] || "").slice(0, 90)}`,
);

// ---------- (F0b) 「最近完成」默认收起：哪怕落盘历史有 23 条，明细也不许先画出来 ----------
// 用户截图里就是「▸ 最近完成 23 项」下面跟着一堆明细。这里钉住两件事：
// ① 初始 / 刷新后都保持收起（.ai-timeline 与明细行都不存在）；
// ② 只有点标题才展开（▾ + 23 行）。
const timelineRows = Array.from({ length: 23 }, (_, i) => ({
  id: `tl-${i}`,
  env: "remote",
  server: "lz",
  sessionTitle: "lz · codex",
  cwd: "/srv/app",
  tool: "codex",
  completedAt: 1_760_000_000 + i * 60,
  durationMs: 60_000 + i * 1000,
  message: `第 ${i + 1} 轮完成`,
  tokensTotal: 1000 + i,
  artifacts: [],
}));
await setScenario({ timeline: timelineRows });
await reload();
await openAiPanelAndRefresh();
const readTimelineFold = () =>
  evaluate(`(() => {
    const p = document.querySelector(".ai-panel");
    if (!p) return { missing: true };
    const b = [...p.querySelectorAll(".ai-section button.mini-btn")].find((x) =>
      (x.innerText || "").includes("最近完成"));
    return {
      text: b ? (b.innerText || "").trim() : "",
      hasTimeline: !!p.querySelector(".ai-timeline"),
      rows: p.querySelectorAll(".ai-timeline .ai-tl-row").length,
    };
  })()`);
const timelineClosed = await readTimelineFold();
check(
  "「最近完成」默认收起：23 条历史只显示一行标题，明细不渲染",
  timelineClosed.text.startsWith("▸ 最近完成 23 项") &&
    timelineClosed.hasTimeline === false &&
    timelineClosed.rows === 0,
  JSON.stringify(timelineClosed),
);
// 点「刷新」再读一次：刷新不能把折叠状态顺手改成展开。
await refreshAiPanel();
const timelineAfterRefresh = await readTimelineFold();
check(
  "点「刷新」后「最近完成」仍然是收起的",
  timelineAfterRefresh.text.startsWith("▸ 最近完成 23 项") &&
    timelineAfterRefresh.hasTimeline === false,
  JSON.stringify(timelineAfterRefresh),
);
await evaluate(`(() => {
  const p = document.querySelector(".ai-panel");
  const b = [...p.querySelectorAll(".ai-section button.mini-btn")].find((x) =>
    (x.innerText || "").includes("最近完成"));
  if (b) b.click();
  return !!b;
})()`);
await sleep(400);
const timelineExpanded = await readTimelineFold();
check(
  "点「最近完成」标题才展开：箭头变 ▾ 并渲染出 23 条明细",
  timelineExpanded.text.startsWith("▾ 最近完成 23 项") &&
    timelineExpanded.hasTimeline === true &&
    timelineExpanded.rows === 23,
  JSON.stringify(timelineExpanded),
);
// 场景里的 23 条只服务这一块，清掉，别让后面的面板断言读到它。
await setScenario({ timeline: null });

// ---------- (F1) mock 裸 SSH 会话：永不出现「需要你」；CMD 空承载不上板（§10.4 / §10.5） ----------
await clearBoardTasks();
await setScenario({
  herdrScan: { workspaces: [], panes: [] },
  herdrTasks: [
    { id: "ssh:lz:4242", env: "remote", server: "lz", tool: "codex", command: "codex --full-auto",
      cwd: "/srv/app", pane: "", source: "ps", state: "running", durationMs: 12_000, pid: 4242,
      startedAt: null, exitCode: null },
    { id: "cmd:local:9", env: "local", server: "本机 CMD", tool: "codex", command: "codex",
      cwd: "C:/work", pane: "", source: "winproc", state: "running", durationMs: 1_000, pid: 9,
      startedAt: null, exitCode: null, cmdCarrier: true },
  ],
});
await reload();
await openAiPanelAndRefresh();
const bare = await evaluate(`(() => {
  const p = document.querySelector(".ai-panel");
  const cards = [...p.querySelectorAll(".ai-task")];
  const texts = cards.map((c) => (c.innerText || "").replace(/\\n/g, " / "));
  // 只看"进程扫描那条路"上来的卡（带 herdr 徽标的那张是上一段场景留下的，
  // 不显式清就让卡片数一直涨 —— 见 clearBoardTasks 的说明）
  const scanned = texts.filter((x) => !x.includes("herdr 第一手"));
  return {
    cardCount: scanned.length,
    sshCard: scanned.find((x) => x.includes("进程推断")) || "",
    cards: texts,
    panelText: p.innerText,
  };
})()`);
check(
  "mock 裸 SSH 会话不出现「需要你」：只说「运行中（进程推断，可能已卡住）」（§10.4）",
  bare.sshCard.includes("运行中（进程推断，可能已卡住）") &&
    !bare.sshCard.includes("需要你") &&
    !bare.sshCard.includes("等你处理"),
  (bare.sshCard || "(没有裸 SSH 卡)") + " 全部卡=" + JSON.stringify(bare.cards).slice(0, 300),
);
check(
  "CMD 空承载不在板上占行（§10.5）",
  bare.cardCount === 1 && !bare.panelText.includes("CMD"),
  `卡片数=${bare.cardCount} ${JSON.stringify(bare.cards).slice(0, 160)}`,
);

// ---------- (F2) 红点规则（§10.6 + 用户 2026-10-20 的口径） ----------
//
// 用户定的规则（原话）：
//   「还是只在 herdr tmux 等等可以**直接读** AI 的情况下**自动显示**红点，
//     手动刷新出现红点这种宁可不要」
// 可以自动亮的来源：herdr 接管窗格 / 本应用启动的任务 / **本机 codex 的 rollout 日志**；
// 进程扫描 / ssh ps / tmux / 裸 SSH / CMD 一律不亮。
// 本实现里 herdr 目前不自动（它的状态只能靠 `agent list` 新起一条 ssh 拉，见交付说明），
// 所以这一段验的就是：**手动刷新绝不产生红点**；本机日志事件（后端 emit `zeeai://ai-log`）
// 自动亮 / 自动清。
const readAiDot = async () =>
  evaluate(`(() => { const b = document.querySelector(".act-badge"); return b ? (b.innerText || "").trim() : ""; })()`);
/** 读 AI 面板里的分区标题与卡片（判断"卡片出来了没有"） */
const readPanelBoard = async () =>
  evaluate(`(() => {
    const p = document.querySelector(".ai-panel");
    if (!p) return { missing: true, secs: [], cards: [] };
    return {
      secs: [...p.querySelectorAll(".ai-section")].map((e) => (e.innerText || "").trim()),
      cards: [...p.querySelectorAll(".ai-task")].map((c) => (c.innerText || "").replace(/\\n/g, " / ")),
    };
  })()`);
/** 模拟"后端推来一条本机日志红点信号"（真链路由 core/ai_log_watch.rs emit） */
const emitAiLog = async (payload) =>
  evaluate(`window.__ZEEAI_EMIT__("zeeai://ai-log", ${JSON.stringify(payload)})`);

// ① 手动点「刷新」：卡片照常出来，但**红点一个都不许亮**。
// 场景里故意放一个 herdr `blocked`（第一手"需要你"）—— 即便这样，刷新也不亮：
// 那是"这一次快照"的结果，不是自动来源推来的信号。
await clearBoardTasks();
await setScenario({
  herdrScan: { workspaces: [], panes: [] },
  herdrAgents: [
    { kind: "codex", status: "blocked", cwd: "/home/user/proj", paneId: "w7:p1",
      tabId: "w7:t1", workspaceId: "w7", title: "proj", focused: true, attention: true },
    { kind: "claude", status: "done", cwd: "/home/user/proj", paneId: "w7:p2",
      tabId: "w7:t2", workspaceId: "w7", title: "proj2", focused: false, attention: false },
  ],
});
await reload();
const dotBeforeRefresh = await readAiDot();
await openAiPanelAndRefresh();
const dotAfterRefresh = await readAiDot();
const refreshedPanel = await readPanelBoard();
check(
  "① 点「刷新」：卡片出来了，但红点**不亮**（手动刷新不产生红点，用户明确否掉）",
  dotBeforeRefresh === "" && dotAfterRefresh === "" &&
    refreshedPanel.secs.some((s) => s.startsWith("需要你 1")) &&
    refreshedPanel.cards.length >= 1,
  `刷新前="${dotBeforeRefresh}" 刷新后="${dotAfterRefresh}" 分区=${JSON.stringify(refreshedPanel.secs)} 卡片=${refreshedPanel.cards.length}`,
);

// ② 本机日志"这一轮跑完并停下" → 红点**自动**亮，中间没有点任何刷新。
// 先把面板收起：否则"已经看到"了，按规则不该记未读。
await closeAiPanel();
const callsBeforeLog = await evaluate(
  `window.__ZEEAI_CALLARGS__.filter((c) => c.cmd === "ai_instances").length`,
);
const deliveredFinish = await emitAiLog({
  kind: "finished", agent: "codex", sessionId: "s-log-1", cwd: "/work/proj",
  turn: "t1", key: "log|rollout-2026-10-20-t1.jsonl|t1",
  atMs: Date.now(), message: "我把报告写好了",
});
await sleep(500);
const dotFinished = await readAiDot();
const callsAfterLog = await evaluate(
  `window.__ZEEAI_CALLARGS__.filter((c) => c.cmd === "ai_instances").length`,
);
check(
  "② 本机日志新增一条「跑完并停下」→ 红点自动亮（没点刷新、没起探测）",
  deliveredFinish > 0 && dotFinished === "1" && callsAfterLog === callsBeforeLog,
  `送达=${deliveredFinish} 红点="${dotFinished}" ai_instances ${callsBeforeLog}→${callsAfterLog}`,
);

// 同一条事件再送一次：同一实例同一轮只亮一次（后端与前端各有一道去重）。
await emitAiLog({
  kind: "finished", agent: "codex", sessionId: "s-log-1", cwd: "/work/proj",
  turn: "t1", key: "log|rollout-2026-10-20-t1.jsonl|t1",
  atMs: Date.now(), message: "我把报告写好了",
});
await sleep(400);
const dotFinishedDup = await readAiDot();
check(
  "③ 同一实例同一轮重复送达 → 红点不叠加（去重键 = 日志文件 + 轮次）",
  dotFinishedDup === "1",
  `重复送达后红点="${dotFinishedDup}"`,
);

// ④ 点开面板 → "跑完"那条未读即清（§10.6 规则②）
await openAiPanel();
await sleep(600);
const dotAfterOpen = await readAiDot();
check(
  "④ 点开面板 → 「跑完停下」那条红点即清（当未读处理）",
  dotAfterOpen === "",
  `点开后红点="${dotAfterOpen}"`,
);

// ⑤ "需要你"是状态不是未读：亮到你处理为止 —— 打开/关闭面板都不清，只有日志说
//    "不再等你"（resolved）才清。
const deliveredNeeds = await emitAiLog({
  kind: "needs-you", agent: "codex", sessionId: "s-log-2", cwd: "/work/proj",
  turn: "t2", key: "log|rollout-2026-10-20-t2.jsonl|t2",
  atMs: Date.now(), message: "等你批准：rm -rf build",
});
await sleep(500);
const dotNeeds1 = await readAiDot();
await closeAiPanel();
await openAiPanel();
await sleep(500);
const dotNeeds2 = await readAiDot();
check(
  "⑤ 「需要你」事件 → 红点亮；打开面板**仍然亮**（亮到你处理为止）",
  deliveredNeeds > 0 && dotNeeds1 === "1" && dotNeeds2 === "1",
  `送达=${deliveredNeeds} 亮起="${dotNeeds1}" 点开后="${dotNeeds2}"`,
);

// ⑥ 「需要你」亮着时点刷新：既不能被清掉、也不能涨 —— 手动刷新与红点彻底解耦。
const callsBeforeRefresh2 = await evaluate(
  `window.__ZEEAI_CALLARGS__.filter((c) => c.cmd === "ai_instances").length`,
);
const refreshed2 = await refreshAiPanel();
const dotNeeds3 = await readAiDot();
const callsAfterRefresh2 = await evaluate(
  `window.__ZEEAI_CALLARGS__.filter((c) => c.cmd === "ai_instances").length`,
);
check(
  "⑥ 需要你亮着时点「刷新」：红点不被清、也不涨（刷新只更新卡片）",
  refreshed2.found && dotNeeds3 === dotNeeds1 && callsAfterRefresh2 > callsBeforeRefresh2,
  `刷新前后="${dotNeeds1}"→"${dotNeeds3}"（ai_instances ${callsBeforeRefresh2}→${callsAfterRefresh2}）`,
);

// ⑦ 后端说"不再等你"（resolved）→ 同一个 key 的红点被清掉
await emitAiLog({
  kind: "resolved", agent: "codex", sessionId: "s-log-2", cwd: "/work/proj",
  turn: "t2", key: "log|rollout-2026-10-20-t2.jsonl|t2",
  atMs: Date.now(), message: "",
});
await sleep(400);
const dotResolved = await readAiDot();
check(
  "⑦ 日志里出现「不再等你」→ 同一个 key 的红点自动清掉（不用点刷新）",
  dotResolved === "",
  `resolved 后红点="${dotResolved}"`,
);

// ⑧ 运行中 / 只产出文件但还没停 → 不亮（刷新也不亮）
await clearBoardTasks();
await setScenario({
  herdrScan: { workspaces: [], panes: [] },
  herdrAgents: [
    { kind: "codex", status: "working", cwd: "/home/user/proj", paneId: "w7:p1",
      tabId: "w7:t1", workspaceId: "w7", title: "proj", focused: true, attention: false,
      artifacts: ["report.md", "index.html"] },
  ],
});
await reload();
await openAiPanelAndRefresh();
const dotDocs = await readAiDot();
check(
  "⑧ 运行中 / 只产出文件但还没停 → 不亮红点（刷新也不亮，§10.6 / §10.9）",
  dotDocs === "",
  `红点="${dotDocs}"`,
);

// ---------- (F2b) herdr 红点轮询（用户 2026-10-20 批准的新自动来源） ----------
//
// 真链路在 Rust：`core/ai_herdr_dots.rs` 每 60 秒对**勾了 herdr 的服务器**查一次
// `herdr agent list`，把 blocked / done 翻成和本机日志**同形状**的事件
// （`source: "herdr"`，key = `herdr|<服务器>|<窗格>`），走同一个 `zeeai://ai-log`。
// 这里注入的就是那个形状（不启应用、不连网）。要验的四件事：
//   ① blocked 是**状态**：亮到你处理为止 —— 打开面板**不清**；
//   ② done 是**事件**：亮一次、当未读 —— 点开面板即清；
//   ③ 同一事件重复送达不叠加（前端按 key 去重；后端还有边沿检测/跨轮去重）；
//   ④ 手动「刷新」仍然不产生红点（上一段①已用 herdr blocked 场景验过，这里再确认解耦没被破坏）。
await closeAiPanel();
/** 模拟"herdr 红点轮询推来一条信号"（真链路由 core/ai_herdr_dots.rs emit） */
const emitHerdrDot = async (payload) =>
  emitAiLog({
    source: "herdr",
    agent: "claude",
    sessionId: "",
    cwd: "/home/user/proj",
    message: "",
    server: "p-lz",
    serverName: "lz",
    ...payload,
  });

// ① herdr blocked → needs-you 红点亮；打开面板后**仍然亮**。
const deliveredHerdrNeeds = await emitHerdrDot({
  kind: "needs-you",
  key: "herdr|p-lz|w7:p1",
  turn: "w7:p1",
});
await sleep(500);
const dotHerdrNeeds1 = await readAiDot();
await openAiPanel();
await sleep(500);
const dotHerdrNeeds2 = await readAiDot();
check(
  "⑨ herdr「blocked」→ needs-you 红点；打开面板**仍然亮**（状态，亮到不再是 blocked）",
  deliveredHerdrNeeds > 0 && dotHerdrNeeds1 === "1" && dotHerdrNeeds2 === "1",
  `送达=${deliveredHerdrNeeds} 亮起="${dotHerdrNeeds1}" 点开后="${dotHerdrNeeds2}"`,
);

// herdr 那边不再是 blocked → 后端按同一个 key 发 resolved，红点必须清掉。
await emitHerdrDot({ kind: "resolved", key: "herdr|p-lz|w7:p1", turn: "w7:p1" });
await sleep(400);
const dotHerdrResolved = await readAiDot();
check(
  "⑩ herdr 不再 blocked（resolved）→ 同一个 key 的红点自动清掉",
  dotHerdrResolved === "",
  `resolved 后红点="${dotHerdrResolved}"`,
);

// ② herdr done → finished 红点亮；③ 同一事件重复送达不涨；② 点开面板即清。
await closeAiPanel();
await emitHerdrDot({ kind: "finished", key: "herdr|p-lz|w7:p2", turn: "w7:p2" });
await sleep(500);
const dotHerdrFinish = await readAiDot();
await emitHerdrDot({ kind: "finished", key: "herdr|p-lz|w7:p2", turn: "w7:p2" });
await sleep(400);
const dotHerdrFinishDup = await readAiDot();
await openAiPanel();
await sleep(500);
const dotHerdrFinishOpen = await readAiDot();
check(
  "⑪ herdr「done」→ finished 红点亮、重复送达不叠加（不涨）；点开面板即清",
  dotHerdrFinish === "1" && dotHerdrFinishDup === "1" && dotHerdrFinishOpen === "",
  `亮起="${dotHerdrFinish}" 重复后="${dotHerdrFinishDup}" 点开后="${dotHerdrFinishOpen}"`,
);

// ④ 手动「刷新」仍然不产生红点：清空之后点刷新（场景里还有 herdr 卡片），红点必须还是空。
await closeAiPanel();
const herdrRefresh = await openAiPanelAndRefresh();
const dotAfterHerdrRefresh = await readAiDot();
check(
  "⑫ 清空后再点「刷新」：卡片照常出来，但红点仍是空（手动刷新与红点解耦没被破坏）",
  herdrRefresh.refreshed.ok && dotAfterHerdrRefresh === "",
  `刷新 ok=${herdrRefresh.refreshed.ok} 红点="${dotAfterHerdrRefresh}"`,
);

// ---------- (F2c) 自动事件 → 卡片（不点刷新、也不多调一次 ai_instances） ----------
//
// 用户 2026-10-20 拍板的最终形态：本机 codex 日志 / herdr 轮询这两路"能直接读"的来源
// **卡片也自动更新**；进程扫描 / 远程 ps / 裸 SSH / tmux / 手动刷新只更新卡片、永不亮红点。
// 真链路：
//   · `core/ai_log_watch.rs` 每 2.5 秒把带 `instanceKey` / `state` / `activity` 的信号
//     emit 到 `zeeai://ai-log`；
//   · `core/ai_herdr_dots.rs` 每 60 秒把 `herdr agent list` 的结果额外 emit 一份
//     `zeeai://herdr-agents` 全量快照（没有多一次 ssh）。
// 这里注入的就是这两个形状（不启应用、不连网）。要钉住四件事：
//   ① 日志事件带卡片字段 → 卡片自动出现/更新，且**没有**多调一次 `ai_instances`；
//   ② herdr 快照 → herdr 卡片自动出现，状态跟着 blocked → working 就地变；
//   ③ 不点刷新时卡片状态随事件变化（同一实例不会多出一张）；
//   ④ 点「刷新」后以 `ai_instances` 全量数据为准（自动建的卡被替换、徽标不再带「自动更新」）；
//   ⑤ 手动刷新仍然**不产生红点**（既有断言之外再确认一遍，红点没有被卡片这条路径带出来）。
const callsAiInstances = () =>
  evaluate(`window.__ZEEAI_CALLARGS__.filter((c) => c.cmd === "ai_instances").length`);
/** 读看板：分区标题 + 折叠行 + 已渲染卡片 + 来源徽标 */
const readAutoBoard = async () =>
  evaluate(`(() => {
    const p = document.querySelector(".ai-panel");
    if (!p) return { missing: true, secs: [], folds: [], cards: [], badges: [], emptyHint: false };
    return {
      secs: [...p.querySelectorAll(".ai-section")].map((e) => (e.innerText || "").trim()),
      folds: [...p.querySelectorAll(".ai-fold")].map((e) => (e.innerText || "").trim()),
      cards: [...p.querySelectorAll(".ai-task")].map((c) => (c.innerText || "").replace(/\\n/g, " / ")),
      badges: [...p.querySelectorAll(".ai-badge-owner")].map((b) => (b.innerText || "").trim()),
      emptyHint: (p.innerText || "").includes("点「刷新」看看本机"),
    };
  })()`);
/** 模拟"herdr 轮询推来一份卡片快照"（真链路由 core/ai_herdr_dots.rs emit） */
const emitHerdrSnapshot = async (payload) =>
  evaluate(`window.__ZEEAI_EMIT__("zeeai://herdr-agents", ${JSON.stringify(payload)})`);

await clearBoardTasks();
await setScenario({
  herdrAgents: [
    { kind: "codex", status: "blocked", cwd: "/home/user/proj", paneId: "w7:p1",
      tabId: "w7:t1", workspaceId: "w7", title: "改登录", focused: true, attention: true },
  ],
  herdrScan: { workspaces: [], panes: [] },
});
await reload();
await openAiPanel(); // 只看，**不点刷新**
const autoCalls0 = await callsAiInstances();
const autoBefore = await readAutoBoard();

// ① 本机日志事件（带卡片字段）→ 卡片出现；ai_instances 一次都没多调。
const autoLogCwd = "C:/work/zeeai-auto";
const autoLogBase = {
  agent: "codex", sessionId: "s-auto-1", cwd: autoLogCwd,
  instanceKey: "local|codex|C:/work/zeeai-auto",
};
const deliveredAutoLog = await emitAiLog({
  ...autoLogBase,
  kind: "needs-you",
  turn: "t-auto-1",
  key: "log|rollout-auto-1.jsonl|t-auto-1",
  atMs: Date.now(),
  message: "等你批准：npm test",
  state: "needs-you",
  activity: "等你批准：npm test",
});
await sleep(700);
const autoAfterLog = await readAutoBoard();
const autoCalls1 = await callsAiInstances();
check(
  "① 没点刷新时收到本机日志事件（带卡片字段）→ 卡片自动出现，且没有因此多调一次 ai_instances",
  deliveredAutoLog > 0 &&
    autoBefore.cards.length === 0 &&
    autoCalls1 === autoCalls0 &&
    autoAfterLog.cards.length === 1 &&
    autoAfterLog.cards[0].includes("zeeai-auto") &&
    autoAfterLog.badges.some((b) => b.includes("rollout 日志") && b.includes("自动更新")) &&
    autoAfterLog.cards[0].includes("该承载看不到「需要你」"),
  `送达=${deliveredAutoLog} ai_instances ${autoCalls0}→${autoCalls1} 卡片=${JSON.stringify(autoAfterLog.cards).slice(0, 200)} 徽标=${JSON.stringify(autoAfterLog.badges)}`,
);

// ③ 同一实例再来一条"跑完停下" → 卡片状态跟着变（进「最近完成」折叠行），仍然没有 ai_instances。
await emitAiLog({
  ...autoLogBase,
  kind: "finished",
  turn: "t-auto-2",
  key: "log|rollout-auto-1.jsonl|t-auto-2",
  atMs: Date.now(),
  message: "报告写好了",
  state: "finished",
  activity: "报告写好了",
});
await sleep(700);
const autoAfterFinish = await readAutoBoard();
const autoCalls2 = await callsAiInstances();
check(
  "③ 不点刷新时卡片状态随事件变化：同一实例从运行中挪进「最近完成」，ai_instances 仍然没涨",
  autoCalls2 === autoCalls0 &&
    autoAfterFinish.secs.some((s) => s === "运行中 0") &&
    autoAfterFinish.folds.some((f) => f.includes("最近完成 1 项")),
  `分区=${JSON.stringify(autoAfterFinish.secs)} 折叠=${JSON.stringify(autoAfterFinish.folds)} ai_instances ${autoCalls0}→${autoCalls2}`,
);

// ② herdr 快照（新事件）→ 该窗格的卡片自动出现；再发一次 working → 就地更新，不多一张卡。
const herdrSnap = {
  source: "herdr",
  server: "p-lz",
  serverName: "lz",
  atMs: Date.now(),
  agents: [
    { pane: "w7:p3", status: "blocked", agent: "claude", cwd: "/home/user/herdr-auto",
      workspace: "w7", tab: "w7:t1", title: "改登录", focused: true, attention: true,
      state: "needs-you", activity: "改登录" },
  ],
};
const deliveredHerdrSnap = await emitHerdrSnapshot(herdrSnap);
await sleep(700);
const autoAfterHerdr = await readAutoBoard();
const autoCalls3 = await callsAiInstances();
check(
  "② herdr 轮询快照 → 没点刷新就出现该窗格的卡片（需要你、带「查看窗格」），ai_instances 没涨",
  deliveredHerdrSnap > 0 &&
    autoCalls3 === autoCalls0 &&
    autoAfterHerdr.secs.some((s) => s === "需要你 1") &&
    autoAfterHerdr.cards.some((c) => c.includes("w7:p3") && c.includes("herdr-auto") && c.includes("查看窗格")) &&
    autoAfterHerdr.badges.some((b) => b.includes("herdr 第一手") && b.includes("自动更新")),
  `送达=${deliveredHerdrSnap} 分区=${JSON.stringify(autoAfterHerdr.secs)} 卡片=${JSON.stringify(autoAfterHerdr.cards).slice(0, 220)} 徽标=${JSON.stringify(autoAfterHerdr.badges)}`,
);

await emitHerdrSnapshot({
  ...herdrSnap,
  atMs: Date.now(),
  agents: [{ ...herdrSnap.agents[0], status: "working", state: "working", attention: false }],
});
await sleep(700);
const autoHerdrMoved = await readAutoBoard();
const autoCalls4 = await callsAiInstances();
check(
  "③b herdr 快照把同一个窗格从 blocked 改成 working → 卡片就地更新（没多出第二张卡）",
  autoCalls4 === autoCalls0 &&
    autoHerdrMoved.secs.some((s) => s === "需要你 0") &&
    autoHerdrMoved.secs.some((s) => s === "运行中 1") &&
    autoHerdrMoved.cards.filter((c) => c.includes("w7:p3")).length === 1,
  `分区=${JSON.stringify(autoHerdrMoved.secs)} 卡片=${JSON.stringify(autoHerdrMoved.cards).slice(0, 200)}`,
);

// ④ 点「刷新」→ 以 ai_instances 的全量数据为准：自动建的卡被替换、徽标不再带「自动更新」。
// ⚠️ 这里必须改**当前页面**的场景对象（`setScenario` 只对下一次 navigate 生效 ——
//    我第一版就写错在这里，刷新拿到的是上一段场景的 blocked，看起来像"刷新没覆盖"）。
await evaluate(`(() => {
  window.__ZEEAI_SCENARIO__.herdrAgents = [
    { kind: "codex", status: "idle", cwd: "/home/user/from-refresh", paneId: "w9:p1",
      tabId: "w9:t1", workspaceId: "w9", title: "刷新来的", focused: false, attention: false },
  ];
  return true;
})()`);
const autoRefresh = await refreshAiPanel();
await sleep(700);
const autoAfterRefresh = await readAutoBoard();
const autoCalls5 = await callsAiInstances();
check(
  "④ 点「刷新」后以 ai_instances 全量数据为准：自动建的卡被替换、徽标不再带「自动更新」",
  autoRefresh.ok &&
    autoCalls5 > autoCalls4 &&
    autoAfterRefresh.secs.some((s) => s === "需要你 0") &&
    autoAfterRefresh.secs.some((s) => s === "运行中 0") &&
    autoAfterRefresh.folds.some((f) => f.includes("空闲 1 项")) &&
    autoAfterRefresh.badges.every((b) => !b.includes("自动更新")),
  `刷新 ok=${autoRefresh.ok} ai_instances ${autoCalls4}→${autoCalls5} 分区=${JSON.stringify(autoAfterRefresh.secs)} 折叠=${JSON.stringify(autoAfterRefresh.folds)} 徽标=${JSON.stringify(autoAfterRefresh.badges)}`,
);

// ⑤ 卡片自动更新接上之后，手动「刷新」仍然**不产生红点**（干净场景重来一遍）。
await closeAiPanel();
await setScenario({
  herdrAgents: [
    { kind: "codex", status: "blocked", cwd: "/home/user/proj", paneId: "w8:p1",
      tabId: "w8:t1", workspaceId: "w8", title: "proj", focused: true, attention: true },
  ],
});
await reload();
await openAiPanelAndRefresh();
const dotAfterAutoRefresh = await readAiDot();
check(
  "⑤ 自动卡片接上之后，手动「刷新」仍然不产生红点（刷到 blocked 也不亮）",
  dotAfterAutoRefresh === "",
  `刷新后红点="${dotAfterAutoRefresh}"`,
);

// ---------- (F2d) 实时推断：终端"还有输出" → 卡片运行中（推断，不是探测） ----------
//
// 用户原话：「点击刷新探测AI的执行状态不太好，根本不够实时」。
// 解法不是加一个更快的定时探测，而是用**本来就在收的终端输出流**：
// `Terminal.tsx` 的 `onWriteParsed` 把"最后一次输出时间"记进内存 Map（`src/activity.ts`），
// `App.tsx` 一个 1 秒的**纯 UI 时钟**只重算标签（不 IPC / 不起进程）。
// 这一段从"真的往终端送字节"开始 —— 测的就是用户那条链路，而不是直接改内存。
await clearBoardTasks();
await setScenario({
  herdrAgents: [],
  herdrScan: { workspaces: [], panes: [] },
  herdrTasks: [],
  // 本机进程扫描这条路的假数据（真后端由 `ai_tasks_local` 返回）。
  // 两张卡：只有 `C:/work/infer` 这张对应得上一条真实终端会话；另一张故意对不上。
  localTasks: [
    { id: "winproc:infer", env: "local", server: "本机 PowerShell", tool: "codex",
      command: "codex", cwd: "C:/work/infer", pane: "", source: "winproc", state: "unknown",
      durationMs: 0, pid: 6101, startedAt: null, exitCode: null },
    { id: "winproc:no-session", env: "local", server: "本机 PowerShell", tool: "claude",
      command: "claude", cwd: "C:/work/no-session", pane: "", source: "winproc", state: "unknown",
      durationMs: 0, pid: 6102, startedAt: null, exitCode: null },
  ],
});
await reload();
// 先热一次刷新（这时还没有本地会话）：herdr 的"第一次探测"会在这一轮里排队补刷一次，
// 补刷会跳过 60 秒一次的本机进程扫描。把它消化掉，后面那次刷新才是"一次就够"，
// 不会出现"第一轮有本机卡片、第二轮被补刷覆盖掉"的假失败。
await openAiPanelAndRefresh();
await sleep(1500);
// 开一个本地 PowerShell（真终端）：输出活动必须来自挂着的 xterm，不能靠测试伪造。
await evaluate(`(() => {
  const nav = [...document.querySelectorAll("button")].find((b) => (b.title || "").includes("PowerShell"));
  if (nav) nav.click();
  return !!nav;
})()`);
await sleep(700);
await evaluate(`(() => {
  const b = [...document.querySelectorAll(".local-module .side-actions button")]
    .find((x) => (x.innerText || "").includes("PowerShell 7"));
  if (b) b.click();
  return !!b;
})()`);
await sleep(1400);
const inferSession = await evaluate(`(() => {
  const calls = (window.__ZEEAI_CALLARGS__ || []).filter((c) => c.cmd === "open_local");
  const last = calls.length ? calls[calls.length - 1].args : null;
  return last ? { id: last.id, channel: !!window.__ZEEAI_SESSION_CHANNELS__[last.id] } : null;
})()`);
// 会话上报 cwd：卡片 → 会话只认"where 里的 cwd 与某个已开终端**唯一**相等"。
// 对不上 / 对上多个都不推断 —— 这就是"不瞎猜"。
await evaluate(
  `window.__ZEEAI_TERM_CWD__(${JSON.stringify(inferSession && inferSession.id)}, "C:/work/infer")`,
);
await sleep(700);
// 面板已经开着（上面热刷新时打开的），这里只需要再刷一次让本机扫描的卡片进来。
const inferRefresh = await refreshAiPanel();
await sleep(700);
const inferCalls0 = await callsAiInstances();
const dotInfer = await readAiDot();
const inferBase = await readAutoBoard();
check(
  "④ 手动刷新仍然不产生红点（推断这条链路不碰红点）",
  inferRefresh.ok && dotInfer === "" && inferBase.folds.some((f) => f.includes("空闲 2 项")),
  `刷新 ok=${inferRefresh.ok} 红点="${dotInfer}" 折叠=${JSON.stringify(inferBase.folds)} ai_instances=${inferCalls0}`,
);

// ① 给这条会话送一段真实输出 → 1 秒时钟重算 → 对应的卡变成「运行中」+「推断 · 输出活动」。
const injected = await evaluate(
  `window.__ZEEAI_TERM_DATA__(${JSON.stringify(inferSession && inferSession.id)}, "codex> thinking...")`,
);
await sleep(1500);
const inferOn = await readAutoBoard();
const inferCalls1 = await callsAiInstances();
check(
  "① 会话刚有输出（≤5 秒）→ 对应卡片显示运行中，并如实标「推断 · 输出活动」",
  injected === true &&
    !!inferSession &&
    inferSession.channel === true &&
    inferOn.secs.some((s) => s === "运行中 1") &&
    inferOn.cards.some(
      (c) => c.includes("infer") && c.includes("运行中") && c.includes("推断 · 输出活动"),
    ),
  `送字节=${injected} 会话=${JSON.stringify(inferSession)} 分区=${JSON.stringify(inferOn.secs)} 卡片=${JSON.stringify(inferOn.cards).slice(0, 280)}`,
);
check(
  "①b 1 秒时钟只重算标签：没有因此多调 ai_instances / 发任何探测",
  inferCalls1 === inferCalls0,
  `ai_instances ${inferCalls0}→${inferCalls1}`,
);
check(
  "⑤ 没有对应会话的卡片不参与推断（不瞎猜）：它仍在「空闲」里，也没有推断标",
  !inferOn.cards.some((c) => c.includes("no-session")) &&
    inferOn.folds.some((f) => f.includes("空闲 1 项")) &&
    !inferOn.cards.some((c) => c.includes("no-session") && c.includes("推断")),
  `折叠=${JSON.stringify(inferOn.folds)} 卡片=${JSON.stringify(inferOn.cards).slice(0, 220)}`,
);

// ② 输出停了超过阈值 → 不再显示运行中；回落成原来的「空闲/未知」，
//    **不会**推断成跑完（最近完成）或需要你。这里同时再等几秒，确认时钟自己在走。
await sleep(6200);
const inferOff = await readAutoBoard();
const inferCalls2 = await callsAiInstances();
check(
  "② 输出停下（>5 秒）→ 不再显示运行中；回落到原来的空闲/未知，**不会**变成跑完 / 需要你",
  inferOff.secs.some((s) => s === "运行中 0") &&
    inferOff.secs.every((s) => !s.startsWith("需要你 1")) &&
    inferOff.folds.some((f) => f.includes("空闲 2 项")) &&
    !inferOff.folds.some((f) => f.includes("最近完成")) &&
    inferOff.cards.every((c) => !c.includes("推断 · 输出活动")) &&
    inferCalls2 === inferCalls0,
  `分区=${JSON.stringify(inferOff.secs)} 折叠=${JSON.stringify(inferOff.folds)} 卡片=${JSON.stringify(inferOff.cards)}`,
);

// ③ 再让输出"活"一次，然后在它还新鲜（≤5 秒）时送一条第一手事件：
//    事件必须立刻覆盖推断（卡片变「已完成」，推断标消失），而不是等 5 秒过期。
const reinjected = await evaluate(
  `window.__ZEEAI_TERM_DATA__(${JSON.stringify(inferSession && inferSession.id)}, "done, summarizing")`,
);
await sleep(1400);
const inferBack = await readAutoBoard();
await emitAiLog({
  agent: "codex",
  sessionId: inferSession && inferSession.id,
  cwd: "C:/work/infer",
  instanceKey: "local|codex|C:/work/infer",
  kind: "finished",
  turn: "t-infer",
  key: "log|rollout-infer.jsonl|t-infer",
  atMs: Date.now(),
  message: "这一轮结束了",
  state: "finished",
  activity: "这一轮结束了",
});
await sleep(1500);
const inferEvent = await readAutoBoard();
// 展开「最近完成」确认那张卡的文字（完成态默认折叠，不展开就看不到明细）
await evaluate(`(() => {
  const b = [...document.querySelectorAll(".ai-panel .ai-fold")]
    .find((x) => (x.innerText || "").includes("最近完成"));
  if (b) b.click();
  return !!b;
})()`);
await sleep(500);
const inferEventOpen = await evaluate(`(() => {
  const p = document.querySelector(".ai-panel");
  return [...p.querySelectorAll(".ai-task")].map((c) => (c.innerText || "").replace(/\\n/g, " / "));
})()`);
check(
  "③ 第一手事件（本机日志：这一轮结束）到达 → 覆盖推断：卡片变「已完成」、推断标消失",
  reinjected === true &&
    inferBack.cards.some((c) => c.includes("推断 · 输出活动")) &&
    inferEvent.secs.every((s) => !s.startsWith("运行中 1")) &&
    inferEvent.folds.some((f) => f.includes("最近完成 1 项")) &&
    inferEventOpen.some(
      (c) => c.includes("infer") && c.includes("已完成") && !c.includes("推断 · 输出活动"),
    ),
  `注入=${reinjected} 覆盖前=${JSON.stringify(inferBack.cards).slice(0, 160)} 分区=${JSON.stringify(inferEvent.secs)} 折叠=${JSON.stringify(inferEvent.folds)} 卡片=${JSON.stringify(inferEventOpen).slice(0, 260)}`,
);

// 这一段的两张本机卡只服务上面的断言；清掉（含当前页面那份），别让后面的用例
// 在打开 AI 面板刷新时凭空多出两张卡。
await evaluate(`if (window.__ZEEAI_SCENARIO__) window.__ZEEAI_SCENARIO__.localTasks = [];`);
await setScenario({ localTasks: [] });

// ---------- (F3) 状态栏只留四件事：不含 UTF-8 / xterm-256color（§10.3） ----------
const statusLine = await evaluate(
  `(() => { const s = document.querySelector(".statusbar"); return s ? (s.innerText || "").replace(/\\n/g, " / ") : ""; })()`,
);
const statusTip = await evaluate(
  `(() => { const s = document.querySelector(".statusbar"); return s ? (s.getAttribute("title") || "") : ""; })()`,
);
check(
  "状态栏不含 UTF-8 / xterm-256color（技术标识收进悬停）（§10.3）",
  !statusLine.includes("UTF-8") &&
    !statusLine.includes("xterm-256color") &&
    statusTip.includes("UTF-8") &&
    statusTip.includes("xterm-256color"),
  `状态栏=${statusLine} 悬停=${statusTip.slice(0, 80)}`,
);

// ---------- (F4) 12 个实例混在一起：那一屏还读得下来（截图 24 / 25） ----------
await clearBoardTasks();
await setScenario({
  herdrTasks: [
    { id: "ssh:lz:4242", env: "remote", server: "lz", tool: "codex", command: "codex",
      cwd: "/srv/app", pane: "", source: "ps", state: "running", durationMs: 7_000, pid: 4242,
      startedAt: null, exitCode: null },
    { id: "ssh:ali:77", env: "remote", server: "Ali_root", tool: "claude", command: "claude",
      cwd: "/root/api", pane: "", source: "ps", state: "running", durationMs: 2_000, pid: 77,
      startedAt: null, exitCode: null },
    { id: "cmd:local:9", env: "local", server: "本机 CMD", tool: "codex", command: "codex",
      cwd: "C:/work", pane: "", source: "winproc", state: "running", durationMs: 1_000, pid: 9,
      startedAt: null, exitCode: null, cmdCarrier: true },
    { id: "tmux:lz:work:0.1", env: "remote", server: "lz", tool: "gemini", command: "gemini",
      cwd: "/srv/build", pane: "work:0.1", source: "tmux", state: "running", durationMs: 9_000,
      pid: 0, startedAt: null, exitCode: null },
    { id: "tmux:lz:build:0.2", env: "remote", server: "lz", tool: "claude", command: "claude",
      cwd: "/srv/web", pane: "build:0.2", source: "tmux", state: "done", durationMs: 120_000,
      pid: 0, startedAt: null, exitCode: null },
  ],
  herdrAgents: [
    { kind: "codex", status: "blocked", cwd: "/home/user/proj", paneId: "w1:p1",
      tabId: "w1:t1", workspaceId: "w1", title: "改登录", focused: true, attention: true },
    { kind: "codex", status: "working", cwd: "/home/user/proj", paneId: "w1:p2",
      tabId: "w1:t1", workspaceId: "w1", title: "proj", focused: false, attention: false },
    { kind: "claude", status: "idle", cwd: "/home/user/proj", paneId: "w1:p3",
      tabId: "w1:t1", workspaceId: "w1", title: "proj", focused: false, attention: false },
    { kind: "gemini", status: "done", cwd: "/home/user/proj", paneId: "w2:p1",
      tabId: "w2:t1", workspaceId: "w2", title: "proj", focused: false, attention: false },
  ],
  herdrScan: { workspaces: [], panes: [] },
});
await reload();
await openAiPanelAndRefresh();
const mixed = await evaluate(`(() => {
  const p = document.querySelector(".ai-panel");
  const secs = [...p.querySelectorAll(".ai-section")].map((e) => (e.innerText || "").trim());
  const folds = [...p.querySelectorAll(".ai-fold")].map((e) => (e.innerText || "").trim());
  const cards = [...p.querySelectorAll(".ai-task")].map((c) => (c.innerText || "").replace(/\\n/g, " / "));
  return {
    secs, folds, cards,
    badgeCount: [...p.querySelectorAll(".ai-badge-owner")].length,
    panelText: p.innerText,
  };
})()`);
check(
  "12 个实例混在一起时：需要你只 1 张卡，其余运行中一行一张、完成与空闲各一行折叠（§10.2）",
  (mixed.secs || []).some((s) => s === "需要你 1") &&
    (mixed.secs || []).some((s) => s === "运行中 4") &&
    mixed.folds.some((f) => f.includes("最近完成")) &&
    mixed.folds.some((f) => f.includes("空闲")),
  `区=${JSON.stringify(mixed.secs)} 折叠=${JSON.stringify(mixed.folds)}`,
);
check(
  "这一屏里没有 CMD 卡、也没有裸 SSH 的「需要你」（§10.4 / §10.5）",
  !mixed.panelText.includes("CMD") &&
    mixed.cards.filter((c) => c.includes("进程推断")).every((c) => !c.includes("需要你")),
  `卡片=${JSON.stringify(mixed.cards).slice(0, 200)}`,
);
const shotMixedDark = await shot("24-board-mixed-dark.png");
await setScenario({ settingsPatch: { theme: "light" } });
await reload();
await openAiPanelAndRefresh();
const shotMixedLight = await shot("25-board-mixed-light.png");
await setScenario({ settingsPatch: { theme: "dark" } });
check(
  "混排那一屏在深色 / 浅色下都截了图（给人看的）",
  shotMixedDark.endsWith("24-board-mixed-dark.png") && shotMixedLight.endsWith("25-board-mixed-light.png"),
  `${shotMixedDark} / ${shotMixedLight}`,
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

// ---------- (Z2) SSH 表单：留空 = 交给 ~/.ssh/config，文案要说清 ----------
// 用户报障（后端已改成"端口 0 不传 -p、用户名空只给 host"）：界面上原来默认填着
// 22 / root，那会把 ~/.ssh/config 里的 Port / User 顶掉 —— "我明明配了别名却连不上"。
// 这里验前端那一半：默认留空、留空能存成 0，以及三处文案一致。
await setScenario({});
await reload();
// 先把「连接」模块切出来（服务器列表在那个侧栏里），再点「＋ 新建服务器」
await evaluate(`(() => {
  const b = [...document.querySelectorAll("button")].find((x) =>
    /连接|服务器/.test((x.innerText || "") + (x.title || "")));
  if (b) b.click();
  return !!b;
})()`);
await sleep(800);
const openEditDialogNow = async () => {
  const clicked = await evaluate(`(() => {
    const b = [...document.querySelectorAll("button")].find((x) =>
      (x.innerText || "").trim().includes("＋ 新建服务器"));
    if (b) { b.click(); return (b.innerText || "").trim(); }
    return "";
  })()`);
  await sleep(800);
  return clicked;
};
const clickedNewServer = await openEditDialogNow();
const sshForm = await evaluate(`(() => {
  const m = document.querySelector(".modal");
  if (!m) return { open: false };
  const fields = [...m.querySelectorAll(".modal-field, .modal-row .modal-field")].map((f) => {
    const lab = (f.innerText || "").trim().split("\\n")[0].trim();
    const inp = f.querySelector("input");
    return { lab: lab, value: inp ? inp.value : null, ph: inp ? (inp.placeholder || "") : "" };
  });
  const byLabel = {};
  for (const f of fields) if (!(f.lab in byLabel)) byLabel[f.lab] = f;
  return { open: true, fields: fields, byLabel: byLabel, head: (m.innerText || "").split("\\n")[0] };
})()`);
if (process.env.ZEEAI_FE_DEBUG_FORM) {
  console.log("---- [debug] 新建服务器表单 ----\n" + JSON.stringify(sshForm, null, 2));
}
const fHost = sshForm.byLabel?.["主机"] ?? {};
const fName = sshForm.byLabel?.["名称"] ?? {};
const fPort = sshForm.byLabel?.["端口"] ?? {};
const fUser = sshForm.byLabel?.["用户名"] ?? {};
const fKey = sshForm.byLabel?.["私钥路径（可选，留空则用默认密钥 / ~/.ssh/config）"] ?? {};
check(
  "新建服务器：主机那一行说清「填别名才能带上 config 里的密钥/端口/用户」",
  (fHost.ph || "").includes("~/.ssh/config 里的别名") && (fHost.ph || "").includes("密钥/端口/用户"),
  JSON.stringify(fHost),
);
check(
  "新建服务器：名称那一行说清「只是标签，不参与连接」",
  (fName.ph || "").includes("只是标签，不参与连接"),
  JSON.stringify(fName),
);
check(
  "新建服务器：端口 / 用户名**默认留空**（留空 = 用 config 里的值），并各自写清默认是什么",
  fPort.value === "" && fUser.value === "" &&
    (fPort.ph || "").includes("留空则用 ~/.ssh/config 里的值（默认 22）") &&
    (fUser.ph || "").includes("留空则用 ~/.ssh/config 里的值（默认当前用户名）"),
  JSON.stringify({ port: fPort, user: fUser }),
);
check(
  "新建服务器：私钥路径的措辞是「留空则用默认密钥 / ~/.ssh/config」（两处同名文案一致）",
  (fKey.ph || "").length > 0,
  JSON.stringify(fKey),
);
// 只填别名 + 名称，端口/用户名留空 → 存进后端的 port 必须是 0、user 必须是空串
await evaluate(`(() => {
  const setV = (inp, v) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(inp, v);
    inp.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const m = document.querySelector(".modal");
  const field = (lab) => [...m.querySelectorAll(".modal-field")].find((f) => (f.innerText || "").trim().startsWith(lab));
  const h = field("主机") && field("主机").querySelector("input");
  const n = field("名称") && field("名称").querySelector("input");
  if (h) setV(h, "myalias");
  if (n) setV(n, "别名测试机");
  return true;
})()`);
await sleep(300);
await evaluate(`(() => {
  const b = [...document.querySelectorAll(".modal-actions .btn")].find((x) =>
    (x.innerText || "").trim() === "保存");
  if (b) b.click();
  return !!b;
})()`);
await sleep(900);
const savedProfile = await evaluate(`(() => {
  const calls = window.__ZEEAI_CALLARGS__.filter((c) => c.cmd === "save_profile");
  const last = calls.length ? calls[calls.length - 1].args.profile : null;
  return last ? { host: last.ssh.host, port: last.ssh.port, user: last.ssh.user } : null;
})()`);
check(
  "留空的端口 / 用户名存下去是 0 / 空串（不是 22 / root，也不是 NaN）",
  savedProfile && savedProfile.host === "myalias" && savedProfile.port === 0 &&
    savedProfile.user === "",
  JSON.stringify(savedProfile),
);
// 错误展示那条（后端返回的是「中文短句｜原始信息：<英文>」）：
// 无头页面里没法真造一次 SSH 认证失败，所以这里扫构建产物 + 源码，钉住三件事 ——
// 中英分离、原文进悬停、认证失败时补一句能照做的话（默认 BatchMode=yes 下最常踩的坑）。
const errUi = await evaluate(`(async () => {
  const html = await (await fetch("/assets/" + [...document.querySelectorAll("script")]
    .map((s) => (s.src || "").split("/").pop()).find((f) => f && f.startsWith("index-")))).text();
  return {
    split: html.includes("｜原始信息："),
    authHint: html.includes("这台服务器可能要密码：在「编辑服务器」里勾上「允许在终端里输入密码」再连"),
  };
})()`);
check(
  "错误展示：中文短句直接显示、原始信息收进悬停，且「认证失败/权限拒绝」会补一句可照做的提示",
  errUi.split && errUi.authHint,
  JSON.stringify(errUi),
);

console.log("\n--- 页面控制台里的 error/warning ---");
// ---------- (Z3) SSH 连接诊断 ----------
//
// 用户报障：「~/.ssh/config 里明明配了别名和密钥，界面填别名就是连不上」——
// 以前界面上只有一条英文原始错误，用户只能自己猜。这一组按用户路径验四件事：
//   ① 编辑服务器里点「连接诊断」→ 弹窗有 summary / 实际主机 / 端口 / 用户 / 密钥存在状态；
//   ② 一把钥匙都没有时，人话结论说「没找到本机密钥」（不是丢一堆 JSON 给用户）；
//   ③ 认证失败 + 本机有钥匙 + 勾了密码模式 → 错误提示里出「密码模式」那句，并且能点进诊断；
//   ④ 弹窗能关（右上角 ✕ / 关闭按钮 / 点遮罩）。
const openServerManager = async () => {
  const r = await evaluate(`(() => {
    const b = [...document.querySelectorAll(".side-btn, button")].find(
      (x) => (x.innerText || "").trim() === "服务器管理",
    );
    if (b) { b.click(); return true; }
    return false;
  })()`);
  await sleep(700);
  return r;
};
/** 点开服务器管理里第一台的「编辑」 */
const openFirstEditDialog = async () => {
  const r = await evaluate(`(() => {
    const managers = [...document.querySelectorAll(".modal.wide")];
    const m = managers[managers.length - 1];
    if (!m) return { ok: false, why: "没有服务器管理弹窗" };
    const b = [...m.querySelectorAll("button")].find((x) => (x.innerText || "").trim() === "编辑");
    if (b) { b.click(); return { ok: true }; }
    return { ok: false, why: "没有编辑按钮" };
  })()`);
  await sleep(700);
  return r;
};
/** 在最后那个弹窗里找「连接诊断」并点开 */
const clickDiagnoseInModal = async () => {
  const r = await evaluate(`(() => {
    const modals = [...document.querySelectorAll(".modal")];
    const m = modals[modals.length - 1];
    const b = m
      ? [...m.querySelectorAll("button")].find((x) => (x.innerText || "").includes("连接诊断"))
      : null;
    if (!b) return { found: false };
    const disabled = !!b.disabled;
    if (!disabled) b.click();
    return { found: true, disabled: disabled };
  })()`);
  await sleep(900);
  return r;
};
const readDiagModal = async () =>
  evaluate(`(() => {
    const m = document.querySelector(".diag-modal");
    if (!m) return { open: false };
    const text = m.innerText || "";
    const row = (label) => {
      const r = [...m.querySelectorAll(".diag-row")].find(
        (x) => ((x.querySelector("span") || {}).innerText || "").trim() === label,
      );
      return r ? ((r.querySelector("b") || {}).innerText || "").trim() : "";
    };
    return {
      open: true,
      summary: ((m.querySelector(".diag-summary") || {}).innerText || "").trim(),
      verdict: ((m.querySelector(".diag-verdict") || {}).innerText || "").trim(),
      hint: ((m.querySelector(".diag-hint") || {}).innerText || "").trim(),
      failure: ((m.querySelector(".diag-failure") || {}).innerText || "").trim(),
      host: row("实际主机"),
      port: row("端口"),
      user: row("用户"),
      jump: row("跳板机"),
      keys: [...m.querySelectorAll(".diag-key")].map((k) => ({
        flag: ((k.querySelector(".diag-key-flag") || {}).innerText || "").trim(),
        path: ((k.querySelector(".diag-key-path") || {}).innerText || "").trim(),
      })),
      rawJson: text.includes("key_files") || text.includes("identityfile") || text.includes('"effective"'),
    };
  })()`);

// ① 编辑服务器里的入口（有密钥、有跳板机的固定诊断数据）
await setScenario({ diagNoKey: false, openSshFail: false, allowPassword: false });
await reload();
const diagMgrOpened = await openServerManager();
const editOpened = await openFirstEditDialog();
const diagEntry = await clickDiagnoseInModal();
const diagUi = await readDiagModal();
check(
  "连接诊断入口①：编辑服务器里点「连接诊断」→ 弹窗显示 summary / 实际主机 / 端口 2222 / 用户 alice",
  diagMgrOpened &&
    editOpened.ok &&
    diagEntry.found &&
    !diagEntry.disabled &&
    diagUi.open &&
    diagUi.summary.includes("将使用 alice@203.0.113.10:2222") &&
    diagUi.host === "203.0.113.10" &&
    diagUi.port === "2222" &&
    diagUi.user === "alice",
  JSON.stringify({
    diagMgrOpened,
    editOpened,
    diagEntry,
    open: diagUi.open,
    summary: diagUi.summary,
    host: diagUi.host,
    port: diagUi.port,
    user: diagUi.user,
  }),
);
check(
  "连接诊断弹窗：密钥列表按 key_files 的 exists 标 ✓存在 / ✗不存在（~ 与展开后的绝对路径认成同一个文件）",
  diagUi.keys.length === 2 &&
    diagUi.keys[0].flag.includes("✓ 存在") &&
    diagUi.keys[0].path.includes("id_ed25519") &&
    diagUi.keys[1].flag.includes("✗ 不存在") &&
    diagUi.keys[1].path.includes("id_rsa"),
  JSON.stringify(diagUi.keys),
);
check(
  "连接诊断弹窗：有跳板机才显示跳板机；人话结论说「会用 … 免密登录」；界面上没有原始 JSON",
  diagUi.jump.includes("bastion.example:2200") &&
    diagUi.verdict.includes("免密登录") &&
    !diagUi.rawJson,
  JSON.stringify({ jump: diagUi.jump, verdict: diagUi.verdict, rawJson: diagUi.rawJson }),
);
// ④ 点遮罩关掉（弹窗开着的时候点外面）
const closedByBackdrop = await evaluate(`(() => {
  const m = document.querySelector(".diag-modal");
  const back = m && m.closest(".modal-backdrop");
  if (back) { back.click(); return true; }
  return false;
})()`);
await sleep(400);
const diagGoneByBackdrop = await evaluate(`!document.querySelector(".diag-modal")`);
check(
  "连接诊断弹窗：点遮罩能关掉",
  closedByBackdrop && diagGoneByBackdrop,
  `clicked=${closedByBackdrop} gone=${diagGoneByBackdrop}`,
);

// ② 一把钥匙都不存在 → 「没找到本机密钥」
await setScenario({ diagNoKey: true, openSshFail: false, allowPassword: false });
await reload();
await openServerManager();
await openFirstEditDialog();
await clickDiagnoseInModal();
const noKeyUi = await readDiagModal();
check(
  "连接诊断入口②：密钥不存在时人话结论是「没找到本机密钥」，每一项都标 ✗ 不存在",
  noKeyUi.open &&
    noKeyUi.verdict.includes("没找到本机密钥") &&
    noKeyUi.keys.length > 0 &&
    noKeyUi.keys.every((k) => k.flag.includes("✗ 不存在")),
  JSON.stringify({ verdict: noKeyUi.verdict, keys: noKeyUi.keys }),
);
// 关掉，别挡住下一段（✕ 也是用户会点的那个）
const closedByX = await evaluate(`(() => {
  const x = document.querySelector(".diag-modal .mini-x");
  if (x) { x.click(); return true; }
  return false;
})()`);
await sleep(400);
check(
  "连接诊断弹窗：右上角 ✕ 能关掉",
  closedByX && (await evaluate(`!document.querySelector(".diag-modal")`)),
);

// ③ 认证失败 + 本机有钥匙 + 勾了「允许在终端里输入密码」→ 错误提示里出「密码模式」那句
await setScenario({ openSshFail: true, diagNoKey: false, allowPassword: true });
await reload();
// 启动时会恢复上次的工作区 → 自动开一次 SSH（假后端直接以"认证失败"拒掉）→
// 状态栏出现带「诊断一下」的报错。万一没恢复（用户设置里关过），走"新建会话 → 连接"同样的路。
await sleep(2500);
const readFailBar = async () =>
  evaluate(`(() => {
    const bar = document.querySelector(".statusbar .status-notice");
    return bar
      ? {
          text: (bar.innerText || "").trim(),
          title: bar.getAttribute("title") || "",
          buttons: [...bar.querySelectorAll("button")].map((b) => (b.innerText || "").trim()),
        }
      : null;
  })()`);
let failBar = await readFailBar();
if (!failBar || !failBar.buttons.length) {
  await evaluate(`(() => {
    const b = [...document.querySelectorAll("button")].find((x) => (x.innerText || "").includes("新建会话"));
    if (b) b.click();
    return !!b;
  })()`);
  await sleep(1500);
  await evaluate(`(() => {
    const b = [...document.querySelectorAll(".modal .modal-actions button")].find(
      (x) => (x.innerText || "").trim() === "连接",
    );
    if (b) b.click();
    return !!b;
  })()`);
  await sleep(2200);
  failBar = await readFailBar();
}
check(
  "连接失败提示：认证失败时给「为什么会失败？诊断一下」按钮，并补一句「密码模式」提示",
  !!failBar &&
    failBar.text.includes("认证失败") &&
    failBar.buttons.some((t) => t.includes("为什么会失败？诊断一下")) &&
    failBar.text.includes("本机已有免密配置"),
  JSON.stringify(failBar),
);
const clickedFromBar = await evaluate(`(() => {
  const bar = document.querySelector(".statusbar .status-notice");
  const b = bar
    ? [...bar.querySelectorAll("button")].find((x) => (x.innerText || "").includes("诊断一下"))
    : null;
  if (b) { b.click(); return true; }
  return false;
})()`);
await sleep(900);
const failDiagUi = await readDiagModal();
check(
  "连接诊断入口③：从失败提示点进来，弹窗带刚才的错误 + 「密码模式」那句提示",
  clickedFromBar &&
    failDiagUi.open &&
    failDiagUi.failure.includes("认证失败") &&
    failDiagUi.hint.includes("本机已有免密配置") &&
    failDiagUi.hint.includes("密码模式不会使用"),
  JSON.stringify({ failDiagUi }),
);
// ④ 关闭按钮
const closedByBtn = await evaluate(`(() => {
  const b = [...document.querySelectorAll(".diag-modal .modal-actions button")].find(
    (x) => (x.innerText || "").trim() === "关闭",
  );
  if (b) { b.click(); return true; }
  return false;
})()`);
await sleep(400);
check(
  "连接诊断弹窗：「关闭」按钮能关掉（失败之后不会一直挡着）",
  closedByBtn && (await evaluate(`!document.querySelector(".diag-modal")`)),
);

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
