import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openLocalDialog } from "@tauri-apps/plugin-dialog";
import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";
import TerminalView from "./features/Terminal";
import { lastTerminalSize } from "./features/terminalSize";
import TermThemeDialog from "./features/TermThemeDialog";
import HighlightDialog from "./features/HighlightDialog";
import { SessionBus } from "./sessionBus";
import { activityEvidenceOf, withOutputActivity } from "./boardActivity";
import { deferUntilIdle } from "./startup";
import {
  adbDevices,
  adbVersion,
  adbLs,
  adbPull,
  adbPush,
  adbRm,
  adbMkdir,
  aiTasksClearFinished,
  aiTasksLocal,
  aiTasksRemote,
  aiInstances,
  aiSessionSnapshot,
  aiTaskArtifacts,
  aiTimelineAdd,
  aiTimelineClear,
  aiTimelineList,
  aiSourceProbe,
  herdrAgents,
  herdrInstall,
  herdrPanes,
  herdrServerStart,
  herdrServerStatus,
  herdrServerStop,
  herdrPaneAction,
  herdrWorkspaceClose,
  herdrWorkspaceScan,
  herdrWorkspaceCreate,
  herdrPaneInputStart,
  herdrPaneKey,
  herdrPaneType,
  isAdmin,
  openAdminShell,
  restartAsAdmin,
  fastbootDevices,
  fastbootVersion,
  gitStatus,
  gitInit,
  gitAdd,
  gitUnstage,
  gitDiscard,
  gitCommit,
  gitLog,
  gitBranches,
  gitCheckout,
  gitDiff,
  gitShow,
  deleteProfile,
  fsList,
  fsRead,
  fsUpload,
  fsDownload,
  fsMkdir,
  fsRemove,
  fsRename,
  historyList,
  historyRemove,
  historySave,
  listProfiles,
  openLocal,
  openAdbShell,
  openSerial,
  openSsh,
  remotePwd,
  secretSet,
  secretHas,
  secretDelete,
  workspaceSave,
  workspaceLoad,
  saveProfile,
  sessionClose,
  sessionLogStart,
  sessionLogStop,
  sessionLogStatus,
  sessionLogDir,
  openInExplorer,
  openExternalUrl,
  pasteAdoptFile,
  pasteDiscardFile,
  pasteReadThumb,
  pasteSaveFile,
  updateDownloadInstall,
  updateInstallKind,
  updateTakeResult,
  serialList,
  sessionWrite,
  settingsGet,
  settingsSet,
  tmuxKill,
  tmuxList,
  tmuxWindows,
  tmuxAction,
} from "./ipc";
import { b64ToBytes, bytesToB64, uid } from "./util";
import {
  CUSTOM_SCHEME_KEY,
  TERM_SCHEMES,
  resolveTermPalette,
  type TermPalette,
} from "./termThemes";
import type {
  AdbDevice,
  AdbFile,
  AiSessionSnapshot,
  AiArtifact,
  AiTask,
  AiActivity,
  AiAgentKind,
  AiCarrier,
  AiEvidence,
  AiHerdrGroup,
  AiInstance,
  AiLedgerGroup,
  AiLogSignal,
  AiRolloutGroup,
  AiState,
  BoardSources,
  HerdrAgent,
  HerdrAgentsSnapshot,
  HerdrPane,
  HerdrServerStatus,
  HerdrWorkspaceScan,
  AiTurnRecord,
  AiSourceInfo,
  AppSettings,
  ConnectionProfile,
  GitBranch,
  GitCommit,
  GitStatus,
  HighlightRule,
  HistoryEntry,
  RemoteEntry,
  SerialConfig,
  SerialPortInfo,
  SessionEvent,
  SessionState,
  TmuxSession,
  TmuxWindow,
  TransferEvent,
} from "./types";
import {
  IconActivity,
  IconAndroid,
  IconChevronDown,
  IconChevronRight,
  IconChevronsDown,
  IconChevronsUp,
  IconClose,
  IconCmd,
  IconFile,
  IconFolder,
  IconGear,
  IconGit,
  IconLogoRadio,
  IconPlus,
  IconPowerShell,
  IconSerial,
  IconServer,
  IconSpark,
  IconTerminal,
  IconWsl,
} from "./components/Icons";

type ModuleKey = "remote" | "powershell" | "cmd" | "wsl" | "git" | "serial" | "adb";
type FileKind = "md" | "html" | "img" | "code" | "text";
type MdStyle = "github" | "minimal" | "dark" | "paper";

interface OpenFile {
  name: string;
  path: string;
  kind: FileKind;
  b64: string;
}

interface OpenSession {
  id: string;
  title: string;
  kind: ModuleKey;
  profileId?: string;
  /** 这个会话临时选的高亮规则集（空 = 跟着服务器绑定走） */
  highlightSetId?: string | null;
  /** 该会话实际登录的用户名（可能来自新建会话时的临时覆盖） */
  user?: string;
  tmuxName?: string;
  tmuxMode?: "default" | "none" | "name";
  /**
   * herdr 观察窗：这个标签页看的是哪个窗格（形如 w1:p1）。
   * 有它就说明这是"只看不跑 TUI"的观察窗（见 core/herdr.rs 顶部说明）。
   */
  herdrPane?: string;
  /** herdr 窗格的打开方式：observe = 只读观察；control = 可读可写（进她的环境里干活） */
  herdrMode?: "observe" | "control";
  /** 终端当前工作目录（OSC 7 或 tmux 上报） */
  cwd?: string;
  /** 正在记录终端日志时的文件路径（没记录就是 undefined） */
  logPath?: string;
  state: SessionState;
  openFiles: OpenFile[];
  activeTab: string; // "terminal" 或文件名
}

/** 工作区快照里存的一个会话（只存"怎么把它开回来"，不存文件内容） */
interface SavedSession {
  kind: ModuleKey;
  title: string;
  profileId?: string;
  user?: string;
  tmuxName?: string;
  tmuxMode?: "default" | "none" | "name";
  /**
   * herdr 窗格会话：恢复时必须带上这两项，否则重启后会被当成 tmux/普通 shell 打开
   * （实测踩过：恢复了才发现"根本不在 herdr 里面"，服务器上还多出一个假 tmux 会话）。
   */
  herdrPane?: string;
  herdrMode?: "observe" | "control";
  cwd?: string;
}

interface SavedWorkspace {
  version: number;
  savedAt: number;
  activeIndex: number;
  sessions: SavedSession[];
}

interface MenuItem {
  sep: boolean;
  label?: string;
  action?: () => void;
}

const MODULES: { key: ModuleKey; label: string; node: JSX.Element }[] = [
  { key: "remote", label: "远程", node: <IconServer size={22} /> },
  { key: "powershell", label: "PowerShell", node: <IconPowerShell size={22} /> },
  { key: "cmd", label: "CMD", node: <IconCmd size={22} /> },
  { key: "wsl", label: "WSL", node: <IconWsl size={22} /> },
  { key: "git", label: "Git", node: <IconGit size={22} /> },
  { key: "serial", label: "串口", node: <IconSerial size={22} /> },
  { key: "adb", label: "ADB", node: <IconAndroid size={22} /> },
];

const MODULE_LABEL: Record<ModuleKey, string> = {
  remote: "远程",
  powershell: "PowerShell",
  cmd: "CMD",
  wsl: "WSL",
  git: "Git",
  serial: "串口",
  adb: "ADB",
};

/** 本地终端在 AI 看板里显示成哪个"服务器" */
function shellLabelOf(kind: string): string {
  if (kind === "wsl") return "WSL";
  if (kind === "cmd") return "本机 CMD（仅状态）";
  return "本机 PowerShell";
}

const AI_TOOL_LABEL: Record<string, string> = {
  codex: "OpenAI Codex CLI",
  claude: "Claude Code",
  aider: "Aider",
  gemini: "Gemini CLI",
};

/**
 * 默认就摆出来的两个 AI 命令行工具。
 *
 * 用户反馈：面板上默认列了四种，后两种（Aider / Gemini CLI）他压根没听过，看着像噪音。
 * 所以**没装的、又不在这个名单里的就不显示**；真装了才出现 —— 那时候它代表
 * "你这台机器上确实有这个东西"，是有用的信息，不是噪音。
 */
const DEFAULT_AI_TOOLS = new Set(["codex", "claude"]);

function aiToolLabel(name: string): string {
  return AI_TOOL_LABEL[name] ?? name;
}

/**
 * 一组"这就是个壳"的 shell 名字。
 *
 * 用来判断一个 herdr 窗格**是不是空壳**（前台进程就停在提示符上、没跑任何活）。
 * herdr 的 `pane process-info` 给的是前台进程名（`bash` / `codex` / …），
 * 拿它跟这张表比就行 —— 也是"清理工作区"唯一敢自动碰的情况。
 */
const SHELL_NAMES = new Set([
  "bash", "sh", "zsh", "fish", "dash", "ksh", "tcsh", "csh", "ash", "nu", "busybox",
]);

/**
 * 从窗格号取工作区号：`w9:p1` → `w9`。
 *
 * herdr 是 workspace > tab > pane 三层，而**会在服务器上攒着的是工作区** ——
 * 回收的时候要按工作区来，所以这个转换到处都在用。
 */
function paneWorkspace(paneId?: string | null): string {
  return paneId ? paneId.split(":")[0] : "";
}

/**
 * 从"存下来的会话名"里摘出给标签用的短名。
 *
 * 存下来的形如 `lz · codex w1P:p1`，而标签里还会再拼一次服务器名和窗格号，
 * 所以两段都要摘掉。**注意 herdr 的工作区号是带字母的**（`w1P` / `wD` / `wE`）——
 * 以前这里写成 `w\d+`，字母那种摘不掉，于是标签变成
 * `lz · codex w1P:p1 w1P:p1`（用户截图里那个重复的标签就是它）。
 */
function herdrShortLabel(title?: string | null): string | undefined {
  const t = (title ?? "").trim();
  if (!t) return undefined;
  const stripped = t
    .replace(/^.*·\s*/, "")
    .replace(/\s*w[0-9A-Za-z]+:p\d+.*$/, "")
    .trim();
  return stripped || undefined;
}

/**
 * 把标题里**重复出现的窗格号**收成一个：`codex w1P:p1 w1P:p1` → `codex w1P:p1`。
 *
 * 这是老版本留下的脏数据：当时摘窗格号的正则写成 `w\d+`，而 herdr 的工作区号带字母
 * （`w1P`/`wD`/`wE`），摘不掉就又拼了一遍。历史记录里那些名字现在还是脏的，
 * 重新打开一次才会写干净，所以显示的时候顺手收一下。
 */
function dedupPaneId(text: string, paneId?: string | null): string {
  const p = (paneId ?? "").trim();
  if (!p) return text;
  let out = text.split(`${p} ${p}`).join(p);
  // 极端情况：连着拼了三次
  while (out.includes(`${p} ${p}`)) out = out.split(`${p} ${p}`).join(p);
  return out.trim();
}

/** 环境徽标：本地 / 远端 / WSL */
function aiEnvLabel(env: string): string {
  if (env === "remote") return "远端";
  if (env === "wsl") return "WSL";
  return "本地";
}

/**
 * 这张卡该不该占「需要你 / 运行中」两个区（口径 docs/design-ai-board-v2.md §10.2）。
 *
 * 「空闲 / 最近完成」是**窗格/实例现状**，不是"有个任务在跑" —— 摆在卡片区就变成
 * "历史上哪些窗格跑过 codex"，用户实测因此以为"它在探测我的 PowerShell"。
 *
 * 这里只说"占不占大卡位"：**状态的判定不在这里** —— 统一状态由后端模型给
 * （`AiState` / 承载能力闸门），前端不再自己推。
 */
function isActiveInstance(i: AiInstance): boolean {
  return i.state === "needs-you" || i.state === "working";
}

/**
 * 卡片上那句状态词（§3.1 的五个词 + §10.4 对裸 SSH 的一句如实降级）。
 *
 * 裸 SSH 的 working 是**进程推断**出来的：只能看到"有这么个进程"，
 * 看不到它在等谁、也看不出它是不是卡住了 —— 所以那句要写全：
 * 「运行中（进程推断，可能已卡住）」。其它承载照旧只写状态词，推断与否交给来源徽标说。
 */
function aiStateLabelOf(i: AiInstance): string {
  // 输出活动推断出来的 working：状态词就写「运行中」，**推断这件事由卡片上的
  // 「推断 · 输出活动」标负责**（见 boardCard）。这里不能再套「进程推断，可能已卡住」——
  // 那句说的是"进程表只看到有这么个进程"，和"终端还在刷输出"是两回事，混着写等于说错原因。
  if (activityEvidenceOf(i)) return "运行中";
  const firstHand = i.evidence.some((e) => e.confidence === "first-hand");
  if (i.carrier === "ssh-bare" && i.state === "working" && !firstHand) {
    return "运行中（进程推断，可能已卡住）";
  }
  return aiStateLabel(i.state);
}

/** 统一状态 → 卡片上那句中文（只有这五个词，§3.1） */
function aiStateLabel(s: AiState): string {
  switch (s) {
    case "needs-you":
      return "需要你";
    case "working":
      return "运行中";
    case "finished":
      return "已完成";
    case "idle":
      return "空闲";
    default:
      return "状态未知";
  }
}

/**
 * herdr 的原始状态词 → 界面上那句中文（「接管已有窗格」那一列还在用它）。
 *
 * 口径和后端 `ai_instance::state_of_herdr` 对齐：`blocked` = **需要你**（不是"跑完了"），
 * `idle` 与 `done` 是两件事（老看板把两者都压成"已完成"，那是错的）。
 */
function herdrStateLabel(status: string): string {
  switch ((status || "").trim().toLowerCase()) {
    case "working":
      return "运行中";
    case "blocked":
      return "需要你";
    case "done":
      return "已完成";
    case "idle":
      return "空闲";
    default:
      return "状态未知";
  }
}

/**
 * 概览徽标：承载（"它是怎么被看见的"）。
 *
 * §10.4：裸 SSH 只能说"运行中（进程推断，可能已卡住）"—— 那句话在卡片上是**承载 + 状态**
 * 合起来说的，所以这里由承载决定前缀。
 */
function aiCarrierLabel(c: AiCarrier): string {
  switch (c) {
    case "herdr":
      return "herdr 第一手";
    case "tmux":
      return "tmux 窗格";
    case "ssh-bare":
      return "裸 SSH";
    case "wsl":
      return "WSL";
    case "local-cmd":
      return "本机 CMD";
    default:
      return "本机 PowerShell";
  }
}

/** agent 枚举（含带数据的 `{other}` 变体）→ 界面文字 */
function aiAgentLabel(a: AiAgentKind): string {
  if (a && typeof a === "object") return a.other || "未知工具";
  switch (a) {
    case "codex":
      return "codex";
    case "claude":
      return "claude";
    case "gemini":
      return "gemini";
    case "aider":
      return "aider";
    default:
      return "未知工具";
  }
}

/**
 * herdr 报的 agent 种类 → 界面文字。
 *
 * herdr 会给出我们枚举里没有的种类（opencode / qwen / …）。认不出来时**把 herdr 的原名
 * 写出来**，而不是像看板卡片那样兜底成"未知工具" —— 红点提示里"哪台机器上的谁在等你"
 * 必须能一眼认出来，写"未知工具"等于把这条信息丢了。
 */
function herdrAgentLabel(agent: string): string {
  const known = aiAgentLabel(agent as AiAgentKind);
  return known === "未知工具" && agent.trim() ? agent.trim() : known;
}

/**
 * 后端 `AiInstance.badge` 里已经带了"谁说的 / 多久前 / 能不能证明"，
 * 但没带"在哪儿" —— 悬停写"怎么得出的"时，第一句要能回答"这是哪台机器 / 哪个目录"。
 */
function aiInstanceWhere(i: AiInstance): string {
  const parts = i.where.split(" · ");
  return parts.slice(0, 2).filter(Boolean).join(" · ");
}

/**
 * 卡片上那个来源徽标的悬停文案（§3.3 的要求：**谁说的 / 多久前 / 能证明什么**）。
 *
 * `badge()` 已经把后两件事写全了（含"只能说明它在跑"、"可能已卡住"这些如实降级），
 * 这里只补三样：这是哪里、这句话是谁说的（枚举名）、一共几条证据。
 */
function aiBadgeTitle(i: AiInstance): string {
  const source = i.evidence
    .map(
      (e) =>
        `${aiEvidenceSourceLabel(e.source)}（${e.confidence === "first-hand" ? "第一手" : "推断"}）`,
    )
    .join("、");
  const activity = activityEvidenceOf(i);
  return (
    `${aiInstanceWhere(i)}\n` +
    `${aiAgentLabel(i.agent)} · ${aiCarrierLabel(i.carrier)}\n` +
    `怎么得出的：${i.badge}\n` +
    // 卡片上那枚徽标末尾带「自动更新」= 这条是自动事件直接改的（没点刷新）；
    // 手动刷新后整份数据来自后端 `ai_instances`，不再带这个后缀。
    (i.badge.includes("自动更新")
      ? "来源方式：自动事件（本机日志 / herdr 轮询）直接更新，不是点「刷新」拿到的\n"
      : "来源方式：「刷新」时后端合并出来的全量数据\n") +
    `谁说的：${source || "（没有证据）"} · 共 ${i.evidence.length} 条\n` +
    `能证明什么：${
      i.evidence.some((e) => e.confidence === "first-hand")
        ? "对面自己报的状态"
        : "只能说明有这么个进程在跑，说不了它在等谁 / 跑完没"
    }` +
    // 推断必须自己说清楚"能证明到哪一步"。这一段只在卡片是按输出活动补成运行中时出现。
    (activity
      ? "\n其中「终端输出活动」是推断：最近 5 秒这条会话的终端还有输出 —— " +
        "只能说明界面在动，看不出它是跑完了在收尾、还是卡在等你按回车。" +
        "所以只在 5 秒内显示成「运行中」，herdr / 日志 / 刷新给出状态就立刻让位。"
      : "")
  );
}

/**
 * 卡片上那枚来源徽标（`badge()`）**已经说过的**来源，就别在下面那行再说一遍。
 *
 * 为什么：§9① 用户抱怨的原话就是"同一件事说了三遍"。徽标写的是"谁说的"
 *（herdr 第一手 / 本应用账本 / rollout 日志），只有"进程扫描"这一类它写成
 * "只能说明它在跑"、没点明是哪张进程表 —— 所以这时才在下面补一句。
 */
function aiBadgeCoversSource(i: AiInstance): boolean {
  if (!i.badge) return false;
  return !/只能说明它在跑/.test(i.badge);
}

/** 证据来源的中文短语（和后端 `EvidenceSource::label()` 对齐；认不出就写"未知来源"） */
function aiEvidenceSourceLabel(s: string): string {
  switch (s) {
    case "herdr-agent-list":
      return "herdr 第一手";
    case "app-ledger":
      return "本应用账本";
    case "rollout":
      return "rollout 日志";
    case "remote-tmux-ps":
      return "远端进程扫描";
    case "local-process-table":
      return "本机进程表";
    case "wsl-ps":
      return "WSL 进程扫描";
    // 前端独有（后端不会出这一条）：按终端输出活动推断的运行中，见 boardActivity.ts
    case "terminal-activity":
      return "终端输出活动";
    default:
      return "未知来源";
  }
}

/** 后端观测来源 → 旧的卡片文案（卡片上那行 `耗时 X · 来源` 还在用） */
function aiSourceLabelOf(source: string): string {
  switch (source) {
    case "app-ledger":
      return "App 启动（最准）";
    case "herdr-agent-list":
      return "herdr 第一手";
    case "rollout":
      return "rollout 日志";
    case "remote-tmux-ps":
      return "tmux / ps 扫描";
    case "local-process-table":
      return "Windows 进程表";
    case "wsl-ps":
      return "WSL 进程扫描";
    default:
      return "ps 扫描";
  }
}

/** 毫秒 →「1 分 23 秒」；拿不到就显示「—」 */
function aiDurationText(ms: number): string {
  if (!ms || ms < 0) return "—";
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs} 秒`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return secs % 60 ? `${mins} 分 ${secs % 60} 秒` : `${mins} 分`;
  return `${Math.floor(mins / 60)} 小时 ${mins % 60} 分`;
}

/** Unix 秒 → 本地时间 HH:MM:SS */
function clockText(sec: number): string {
  const d = new Date(sec * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 这个文件名算不算"要你去看的文档产物"？
 *
 * 用户的原话是"我选择只看生成的 HTML 或者 MD 文档"——所以默认口径里，
 * 只有 HTML / Markdown 才算"值得为它提醒一次"；其它文件（日志、临时脚本、图片…）
 * 一律不弹（想让它们也触发，去设置里把「产物范围」改成"所有文件"）。
 */
function isDocName(name: string): boolean {
  const n = name.trim().toLowerCase();
  return n.endsWith(".md") || n.endsWith(".markdown") || n.endsWith(".html") || n.endsWith(".htm");
}

/** 一行短文本（通知里用）：压成一行并截断 */
function aiShorten(s: string, max: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : one.slice(0, max) + "…";
}

/** token 数 → 以「兆（M）」为单位显示，例如 1_234_567 → "1.23M" */
function tokenM(n: number): string {
  if (!n || n < 0) return "0M";
  const m = n / 1_000_000;
  if (m >= 100) return `${Math.round(m)}M`;
  if (m >= 1) return `${m.toFixed(2)}M`;
  if (m >= 0.01) return `${m.toFixed(3)}M`;
  return "0.01M 以下";
}

/** 路径 → 只留最后一段（卡片上显示"项目目录"用） */
function dirBase(p: string): string {
  const t = p.replace(/[\\/]+$/, "");
  const parts = t.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

/**
 * 会话类型 → 我们对外暴露的 4 种"终端类型"（作用范围就用这几种）
 * remote=SSH；powershell/cmd/wsl 都是本地终端；serial=串口；adb=Android
 */
function kindOfSession(kind: string): "ssh" | "local" | "serial" | "adb" {
  if (kind === "remote") return "ssh";
  if (kind === "serial") return "serial";
  if (kind === "adb") return "adb";
  return "local";
}

/**
 * 某个会话该用哪一套高亮规则：
 * 这台服务器/设备**独立**设过 → 用它自己的（全局怎么改都不动它）；
 * 没设过（= 在服务器配置里勾了「跟随全局」）→ 用"该终端类型"那一档 → 再兜底到全局默认。
 */
function highlightRulesFor(
  settings: AppSettings,
  profile: ConnectionProfile | undefined,
  terminalKind?: string,
): HighlightRule[] {
  const byKind = terminalKind ? settings.highlightSetByKind?.[terminalKind] : "";
  // profile 上存了值 = 这台机器选了"独立"，优先级最高（这正是用户要的：独立的不被全局覆盖）
  const id = (profile?.highlightSetId || byKind || "").trim();
  const set = id ? settings.highlightRuleSets.find((s) => s.id === id) : undefined;
  if (set) return set.rules;
  const fallback = settings.highlightRuleSets.find((s) => s.id === "default");
  return fallback?.rules ?? settings.highlightRules;
}

/**
 * 某个会话该用哪套终端配色（16 色）：
 * 这台服务器/设备独立设过 → 用它自己的；否则用"该终端类型"那一档 → 全局那套。
 *
 * `from` 是**这套值是从哪一层来的**，给界面用：用户改"全局默认"却被上层盖住时，
 * 必须能看见"现在真正生效的是谁、谁定的"（否则就是"改了没反应"的困惑，实测踩过）。
 */
function termSchemeFor(
  settings: AppSettings,
  profile: ConnectionProfile | undefined,
  terminalKind?: string,
): { key: string; custom?: string; from: "profile" | "kind" | "global" } {
  const byKind = terminalKind ? settings.termSchemeByKind?.[terminalKind] : "";
  const own = (profile?.termScheme ?? "").trim();
  const from: "profile" | "kind" | "global" = own
    ? "profile"
    : (byKind ?? "").trim()
      ? "kind"
      : "global";
  const key = (own || byKind || settings.termScheme || "").trim();
  const custom = profile?.termSchemeCustom ?? settings.termSchemeCustom;
  return { key: key || settings.termScheme, custom, from };
}

/** 直接算出某个会话该用的 16 色配色 */
function termPaletteFor(
  settings: AppSettings,
  profile: ConnectionProfile | undefined,
  terminalKind?: string,
): TermPalette {
  const look = termSchemeFor(settings, profile, terminalKind);
  return resolveTermPalette(look.key, look.custom);
}

/**
 * 服务器列表上那一行「谁@哪台机器:端口」。
 *
 * 端口/用户留空是**合法**的（= 交给 `~/.ssh/config`），所以不能原样拼出
 * `@myalias:0` 这种看不懂的东西 —— 那种显示会让人以为配置坏了。
 */
function sshTargetLabel(ssh: { host: string; user?: string; port?: number }): string {
  const user = (ssh.user ?? "").trim();
  const port = ssh.port ?? 0;
  return `${user ? user + "@" : ""}${ssh.host}${port ? ":" + port : ""}`;
}

const EMPTY_PROFILE = {
  name: "",
  host: "",
  /**
   * 端口 / 用户**默认留空**（"没说"）。
   *
   * 为什么不留 22 / root：这两个值一旦填上，后端就会拼出 `ssh -p 22 root@myalias` ——
   * 实测这会把 `~/.ssh/config` 里的 `Port` / `User` **顶掉**，于是"本机配了免密别名"
   * 的用户永远连不上（2026-10 用户报障）。留空时后端不传 `-p`、只给 `host`，
   * config 才生效（默认 22 / 当前用户名）。显式填了仍然是我们说了算。
   *
   * port 存**字符串**而不是数字：`<input type="number">` 清空时 `Number("")` 是 0，
   * 但界面上得能看见"空"，数字类型一存就变成 `NaN` 或被迫回填 22（两种都出过）。
   */
  port: "",
  user: "",
  group: "默认",
  keyPath: "",
};

/** 端口留空 = 0 = "没说"：交给 `~/.ssh/config` 的 Port（后端已支持）。 */
function portOrZero(v: string): number {
  const n = Number(String(v).trim());
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

/**
 * 把后端的报错拆成「中文短句」+「原始信息」两半。
 *
 * 后端（russh 那条路）现在返回的是 `中文短句｜原始信息：<英文>` 这种形状。
 * 界面上只该看见中文那半（英文原文一长串，挤在状态栏里没人读得下去），
 * 但排查问题又必须能拿到原文 —— 所以原文进悬停（`title`）。
 */
function splitErrText(text: string): { short: string; detail: string } {
  const i = text.indexOf("｜原始信息：");
  if (i < 0) return { short: text, detail: text };
  return { short: text.slice(0, i).trim(), detail: text };
}

/**
 * 错误看着像"认证失败 / 权限拒绝"吗？
 *
 * 为什么要单独判：默认 `BatchMode=yes`（见 `src-tauri/src/commands.rs` 里 `open_ssh` 的
 * `!cfg.allow_password`）—— 不勾「允许在终端里输入密码」时，密码登录**根本不会问你**，
 * 直接以 `Permission denied (publickey,password)` 收场。用户看到"认证失败"只会以为
 * 是密钥配错了，其实只差一个勾。所以这种情况必须**给一句能照做的话**。
 */
function looksLikeAuthFailure(text: string): boolean {
  const low = text.toLowerCase();
  return (
    text.includes("认证失败") ||
    text.includes("权限拒绝") ||
    text.includes("拒绝访问") ||
    low.includes("permission denied") ||
    low.includes("publickey") ||
    low.includes("authentication failed")
  );
}

/**
 * 连接类报错 → 状态栏那一行文字。
 *
 * `what` 是我们自己的上下文（"SSH 连接失败"这种），后面接后端的原始报错；
 * 原始信息部分会在 `notify` 里被挪进悬停。
 */
function connErrorText(what: string, err: unknown): string {
  const raw = String(err);
  const hint = looksLikeAuthFailure(raw)
    ? "\n这台服务器可能要密码：在「编辑服务器」里勾上「允许在终端里输入密码」再连"
    : "";
  return `${what}：${raw}${hint}`;
}

/** GitHub Release 里的一个附件（检查更新时用来挑安装包） */
interface Asset {
  name?: string;
  size?: number;
  browser_download_url?: string;
  /** GitHub 会给的 sha256（形如 "sha256:...."），用来校验下载到的包 */
  digest?: string;
}

/**
 * 「tmux 快捷操作」面板上的按钮。
 *
 * 刻意做成按钮而不是帮用户改 `Ctrl+B`：`Ctrl+B` 是 tmux 的默认前缀，
 * 动它会毁掉所有 tmux 用户的手感。这里是把**前缀 + 某个键**对应的 tmux 命令
 * 做成可点的按钮（`title` 里写着等价快捷键，顺便当教学）。
 */
/**
 * 服务器没填分组时用的分组名。
 *
 * 这个值只用来"归类"，界面上**不显示** —— 只有一台服务器都不填分组时，
 * 列表里出现一行莫名其妙的「默认」反而让人看不懂。多个分组同时存在时，
 * 它才以「未分组」的名义出现，用来区分其它自建分组。
 */
const DEFAULT_SERVER_GROUP = "默认";

/** 设置对话框左侧的分类（点一下就跳到右边对应内容） */
const SETTINGS_TABS: { key: string; label: string }[] = [
  { key: "look", label: "外观" },
  { key: "term", label: "终端与会话" },
  { key: "log", label: "会话日志" },
  // 应用级行为（启动恢复会话 / 关闭窗口时）—— 跟"终端怎么跑"是两件事，单独一页
  { key: "app", label: "应用" },
  { key: "notify", label: "通知" },
  { key: "update", label: "更新与关于" },
];

const TMUX_ACTIONS: { key: string; label: string; title: string }[] = [
  { key: "new-window", label: "新建窗口", title: "等价于 Ctrl+B c" },
  { key: "split-h", label: "左右分屏", title: "等价于 Ctrl+B %" },
  { key: "split-v", label: "上下分屏", title: '等价于 Ctrl+B "' },
  { key: "prev-window", label: "上个窗口", title: "等价于 Ctrl+B p" },
  { key: "next-window", label: "下个窗口", title: "等价于 Ctrl+B n" },
  { key: "zoom", label: "放大/还原", title: "等价于 Ctrl+B z" },
  { key: "next-layout", label: "换布局", title: "等价于 Ctrl+B 空格" },
  { key: "pane-left", label: "窗格 ←", title: "等价于 Ctrl+B ←" },
  { key: "pane-up", label: "窗格 ↑", title: "等价于 Ctrl+B ↑" },
  { key: "pane-down", label: "窗格 ↓", title: "等价于 Ctrl+B ↓" },
  { key: "pane-right", label: "窗格 →", title: "等价于 Ctrl+B →" },
  { key: "copy-mode", label: "滚动查看", title: "等价于 Ctrl+B [（进入滚动/复制模式）" },
  { key: "copy-mode-exit", label: "退出滚动", title: "等价于 Ctrl+B q 或 Esc" },
  { key: "rename-window", label: "重命名窗口", title: "等价于 Ctrl+B ," },
  { key: "kill-pane", label: "关闭窗格", title: "等价于 Ctrl+B x" },
  { key: "kill-window", label: "关闭窗口", title: "等价于 Ctrl+B &" },
  { key: "detach", label: "脱离会话", title: "等价于 Ctrl+B d：断开但会话继续在服务器上跑" },
];

/**
 * 「herdr 快捷操作」面板上的按钮。
 *
 * 和上面 tmux 那份是同一个思路：**不模拟按键**，而是另开一条 ssh 去跑 herdr 自己的
 * socket API（白名单见后端 core/herdr.rs::action_command）。所以它不会碰任何快捷键，
 * 也不管窗格里此刻在跑什么。herdr 没有"上一个/下一个工作区"这种指令，就没有这两项；
 * 它的滚动是观察端自己做的（我们用 xterm 的滚动条），所以也没有复制模式那两项。
 */
const HERDR_ACTIONS: { key: string; label: string; title: string }[] = [
  { key: "new-workspace", label: "新建工作区", title: "在服务器上新开一个工作区（窗格会留在服务器上，随时能回来）" },
  { key: "split-right", label: "右分屏", title: "把当前窗格左右分成两块" },
  { key: "split-down", label: "下分屏", title: "把当前窗格上下分成两块" },
  { key: "zoom", label: "放大/还原", title: "当前窗格占满（再点还原）" },
  { key: "pane-left", label: "窗格 ←", title: "把焦点移到左边那个窗格" },
  { key: "pane-up", label: "窗格 ↑", title: "把焦点移到上边那个窗格" },
  { key: "pane-down", label: "窗格 ↓", title: "把焦点移到下边那个窗格" },
  { key: "pane-right", label: "窗格 →", title: "把焦点移到右边那个窗格" },
  { key: "rename-pane", label: "重命名窗格", title: "给这个窗格起个名字（herdr 里显示的名字）" },
  { key: "close-pane", label: "关闭窗格", title: "关掉当前窗格（会问一次）" },
  { key: "close-workspace", label: "关闭工作区", title: "关掉整个工作区，连同里面的窗格（会问一次）" },
];

const DEFAULT_SETTINGS: AppSettings = {
  fontSize: 13,
  defaultShell: "powershell",
  recordHistory: true,
  tmuxDefault: true,
  theme: "dark",
  closeAction: "exit",
  updateUrl: "https://api.github.com/repos/zeelinkCN/ZeeAI_Term/releases/latest",
  autoReconnect: true,
  fsFollowTerminal: true,
  restoreWorkspace: true,
  scrollback: 10000,
  autoLog: false,
  lastUpdateCheck: 0,
  ignoredUpdateVersion: "",
  termScheme: "vscode-dark",
  termSchemeCustom: "",
  logDir: "",
  highlightEnabled: true,
  // 预设规则由后端给（core::highlight::presets），前端这里只留空；
  // 设置读回来之后就有内容了，用户也可以自己改。
  highlightRules: [],
  // 规则集由后端给（core::highlight::presets 兜底），前端启动后就有内容
  highlightRuleSets: [],
  termSchemeByKind: {},
  highlightSetByKind: {},
  // 通知分层：默认只在活动栏 AI 图标点红点；闪任务栏 / 右下角提示由用户自己开
  aiNotifyTaskbar: false,
  aiNotifyBadge: true,
  // 红点只为两种情况亮（docs/design-ai-board-v2.md §10.6）：
  // ① 有人需要你 → 亮到你处理；② 跑完一轮并停下 → 点开就消。其它情况不提醒。
  aiNotifyNeedsYouBadge: true,
  aiNotifyFinishedBadge: true,
  // 「什么时候才提醒我」的默认口径（和后端 store.rs 保持一致）：
  // 小任务太多，跑完就弹会很吵 → 默认关；
  // 真正要人接手的两种（产出了 HTML/MD 文档、AI 在等你做选择题）默认开。
  aiNotifyComplete: false,
  aiNotifyDocs: true,
  aiNotifyNeedsYou: true,
  aiNotifyAllArtifacts: false,
  // 粘贴/拖进来的图片、文件在远端落到哪个目录；`.` = 跟随终端当前目录
  pasteDir: "~/.zeeai/paste",
  // 终端的三个习惯项（和后端 store.rs 的默认值保持一致）：
  // 两个键都能粘、右键弹菜单、Ctrl+Shift+C 复制 —— 跟大多数人预期一致
  pasteKey: "both",
  rightClick: "menu",
  copyKey: "ctrl-shift-c",
  // 直接粘进终端（不经过输入窗）时是否给一眼缩略图。
  // **默认关**：用户明确要求"图片上传/粘贴不要在右下角弹消息"——要确认粘对了没有，
  // 看输入行里那串路径就够了（想开的人可以在设置里打开）。
  pasteToast: false,
  // 一个"额外启动参数"都没有：默认不动用户装好的 CLI 的启动方式
  agentLaunchArgs: {},
};

const APP_VERSION = "0.1.12";
/** 本机进程表扫描的最小间隔：这个探针要起 PowerShell 枚举进程，比远端探针贵得多 */
const LOCAL_SCAN_MIN_INTERVAL_MS = 60_000;

/** 比较 a、b 两个版本号：a 新返回 1，相同返回 0，a 旧返回 -1（忽略 v 前缀与预发布后缀） */
function compareVersion(a: string, b: string): number {
  const nums = (v: string) =>
    v
      .trim()
      .replace(/^v/i, "")
      .split(/[.+\-]/)
      .map((x) => parseInt(x, 10))
      .filter((n) => Number.isFinite(n));
  const A = nums(a);
  const B = nums(b);
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const x = A[i] ?? 0;
    const y = B[i] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/** 各种分屏布局对应几个窗格 */
function paneCount(layout: "single" | "v2" | "h2" | "v3" | "grid4"): number {
  switch (layout) {
    case "v2":
    case "h2":
      return 2;
    case "v3":
      return 3;
    case "grid4":
      return 4;
    default:
      return 1;
  }
}

const THEMES: { key: string; label: string; kind: "dark" | "light" }[] = [
  { key: "dark", label: "VS Code 深色", kind: "dark" },
  { key: "one", label: "One Dark Pro", kind: "dark" },
  { key: "tokyo", label: "Tokyo Night", kind: "dark" },
  { key: "nord", label: "Nord 蓝灰", kind: "dark" },
  { key: "dracula", label: "Dracula", kind: "dark" },
  { key: "monokai", label: "Monokai", kind: "dark" },
  { key: "wechat", label: "微信绿", kind: "dark" },
  { key: "teams", label: "Teams 紫", kind: "dark" },
  { key: "teal", label: "青瓷（暗）", kind: "dark" },
  { key: "light", label: "VS Code 浅色", kind: "light" },
  { key: "github", label: "GitHub 浅色", kind: "light" },
  { key: "paper", label: "纸白（护眼）", kind: "light" },
  { key: "sakura", label: "樱花粉", kind: "light" },
  { key: "mint", label: "薄荷绿", kind: "light" },
];

function themeKind(key: string): "dark" | "light" {
  return THEMES.find((t) => t.key === key)?.kind ?? "dark";
}

const SHELL_LABEL: Record<AppSettings["defaultShell"], string> = {
  powershell: "PowerShell",
  cmd: "CMD",
  wsl: "WSL",
};

const md = new MarkdownIt({ html: false, linkify: true, breaks: false });

function moduleIcon(kind: ModuleKey, size = 14): JSX.Element {
  switch (kind) {
    case "remote":
      return <IconServer size={size} />;
    case "cmd":
      return <IconCmd size={size} />;
    case "wsl":
      return <IconWsl size={size} />;
    case "git":
      return <IconGit size={size} />;
    case "serial":
      return <IconSerial size={size} />;
    case "adb":
      return <IconAndroid size={size} />;
    default:
      return <IconTerminal size={size} />;
  }
}

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

function fileKind(name: string): FileKind {
  const ext = extOf(name);
  if (ext === "md" || ext === "markdown") return "md";
  if (ext === "html" || ext === "htm") return "html";
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico"].includes(ext)) return "img";
  if (
    [
      "json", "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "sh", "bash", "rs", "go",
      "java", "c", "cc", "cpp", "h", "hpp", "yml", "yaml", "toml", "ini", "conf",
      "css", "scss", "sql", "xml", "env", "gitignore", "dockerfile",
    ].includes(ext)
  ) {
    return "code";
  }
  return "text";
}

function imgMime(name: string): string {
  switch (extOf(name)) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "bmp":
      return "image/bmp";
    case "svg":
      return "image/svg+xml";
    case "ico":
      return "image/x-icon";
    default:
      return "application/octet-stream";
  }
}

function decodeB64Text(b64: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(b64ToBytes(b64));
  } catch {
    return "";
  }
}

function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function joinPath(dir: string, name: string): string {
  if (!dir) return `/${name}`;
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

function parentOf(path: string): string {
  if (!path || path === "/") return "/";
  const trimmed = path.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i <= 0 ? "/" : trimmed.slice(0, i);
}

/** herdr 原始状态 → 统一状态词（和后端 `ai_instance::state_of_herdr` 对齐）。 */
function herdrStateOf(status: string): AiState {
  switch ((status || "").trim().toLowerCase()) {
    case "working":
      return "working";
    case "blocked":
      return "needs-you";
    case "done":
      return "finished";
    case "idle":
      return "idle";
    default:
      return "unknown";
  }
}

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
function useUiClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

/**
 * 一条"自动事件"归一之后的样子（本机日志信号 / herdr 卡片快照都先转成它）。
 *
 * 为什么先归一：两路事件字段形状不一样（日志给 cwd/turn，herdr 给 server/pane），
 * 但"更新哪张卡、改成什么状态"这件事**只能有一套实现** —— 否则迟早出现
 * "日志那条会把 herdr 的卡改坏"这种互相打架。
 */
interface AutoCardEvent {
  /** 来源：日志 = 只读本机 rollout；herdr = 轮询 `herdr agent list` */
  source: "log" | "herdr";
  /** 实例标识（跨轮不变）：日志 `local|codex|<cwd>`；herdr `herdr|<服务器>|<窗格>` */
  key: string;
  carrier: AiCarrier;
  agent: AiAgentKind;
  /** `where` 的第一段：`本机` / 服务器显示名 */
  env: string;
  cwd: string;
  state: AiState;
  activity: string;
  atMs: number;
  /** herdr 专用：窗格号 / 服务器配置 id / 原始状态词 */
  pane?: string;
  profileId?: string;
  status?: string;
  attention?: boolean;
  /** 本机 codex 日志带会话 id（点卡片能切过去） */
  sessionId?: string | null;
}

export default function App() {
  const busRef = useRef(new SessionBus());
  const bus = busRef.current;

  const [module, setModule] = useState<ModuleKey>("remote");
  const [sideTab, setSideTab] = useState<"sessions" | "files">("sessions");
  const [profiles, setProfiles] = useState<ConnectionProfile[]>([]);
  const [sessions, setSessions] = useState<OpenSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  /**
   * 所有提示都只走底部状态栏（`statusMsg`）。
   * 曾经有过一个中央浮层 toast，用户明确要求"不要在这里悬浮任何消息"——已彻底移除。
   */
  const [statusMsg, setStatusMsg] = useState<{
    /** 状态栏上显示的那一行（只看中文短句） */
    text: string;
    /** 悬停时看的完整原文（含 `｜原始信息：<英文>`；没有额外原文时等于 text） */
    detail: string;
    at: number;
    kind: "info" | "warn" | "error";
  } | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ ...EMPTY_PROFILE });

  // 记录「被折叠」的服务器（默认全展开，新加的服务器也是展开的）
  const [collapsedServers, setCollapsedServers] = useState<string[]>([]);
  const [ctxMenu, setCtxMenu] = useState<{
    profile: ConnectionProfile;
    x: number;
    y: number;
    /**
     * 这条菜单是**对着某一条会话记录**（侧栏服务器下面那一行）打开的时候带上它。
     *
     * 为什么要区分：服务器那一栏的菜单是"管理这台机器"，而 herdr 的窗格是**会攒的**
     * （每开一次新会话就多一个），用户需要能"就在这一行上"把它回收掉，而不是先记住
     * 窗格号再跑去别的地方找。
     */
    herdrRow?: HistoryEntry;
  } | null>(null);
  const [editDialog, setEditDialog] = useState<{
    draft: ConnectionProfile;
    isNew: boolean;
  } | null>(null);

  const [tmuxTarget, setTmuxTarget] = useState<ConnectionProfile | null>(null);
  const [tmuxSessions, setTmuxSessions] = useState<TmuxSession[]>([]);
  const [tmuxLoading, setTmuxLoading] = useState(false);
  /** 「管理 herdr 工作区」面板对着的那台服务器（和上面的 tmuxTarget 一个道理） */
  const [herdrTarget, setHerdrTarget] = useState<ConnectionProfile | null>(null);
  /** 那台机器上的工作区 + 每个窗格的前台进程 + 服务状态（三样一起刷） */
  const [herdrMgr, setHerdrMgr] = useState<{
    scan: HerdrWorkspaceScan;
    panes: HerdrPane[];
    server: HerdrServerStatus;
  } | null>(null);
  const [herdrMgrLoading, setHerdrMgrLoading] = useState(false);
  /** 正在等"再点一次确认"的工作区号（关掉工作区会连带关掉里面的窗格） */
  const [herdrMgrArmed, setHerdrMgrArmed] = useState<string | null>(null);
  /** 会话行右键菜单里"确认在服务器上关掉"的那一下（和上面那个二段确认一个道理） */
  const [herdrRowArmed, setHerdrRowArmed] = useState<string | null>(null);

  const [history, setHistory] = useState<HistoryEntry[]>([]);
  /** 供异步流程读最新历史（自动编号要数"这台机器已有几个普通 shell"） */
  const historyRef = useRef<HistoryEntry[]>(history);
  historyRef.current = history;
  const [newDialog, setNewDialog] = useState<{
    profileId: string;
    useTmux: boolean;
    tmuxKind: "new" | "attach";
    tmuxName: string;
    attachTarget: string;
    /** 用 herdr 打开这次会话（默认值跟着服务器配置走，勾上就直接进她的环境） */
    useHerdr: boolean;
    /** herdr：新开一个窗格，还是接管已有的 */
    herdrKind: "new" | "attach";
    /** herdr：要接管的窗格号（形如 w1:p1） */
    herdrTarget: string;
    user: string;
    rememberUser: boolean;
    /** 会话名字（留空 = 自动命名；普通 shell 会自动编号） */
    title?: string;
    /** 这次会话临时选的高亮规则集（空 = 跟随服务器绑定） */
    highlightSetId?: string | null;
  } | null>(null);
  const [dialogTmux, setDialogTmux] = useState<TmuxSession[]>([]);
  const [dialogBusy, setDialogBusy] = useState(false);
  /** 「接管已有 herdr 窗格」时列出来的窗格（按需加载；含没有 agent 的空壳窗格） */
  const [dialogHerdr, setDialogHerdr] = useState<HerdrPane[]>([]);

  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [settingsReady, setSettingsReady] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  /** 设置对话框左边选中的分类（二级菜单） */
  const [settingsTab, setSettingsTab] = useState("look");
  const [showAbout, setShowAbout] = useState(false);
  // 终端配色对话框（视图菜单 / 设置里都能打开）
  const [showTermTheme, setShowTermTheme] = useState(false);
  /** 「终端配色」对话框当前在给谁配：global / shell:powershell… / p:<profileId> */
  const [lookScope, setLookScope] = useState("global");
  // 关键字高亮对话框（视图菜单 / 设置里都能打开）
  const [showHighlight, setShowHighlight] = useState(false);
  const [showServers, setShowServers] = useState(false);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  // 在「新建会话」弹窗里点「＋ 新建服务器」时，保存后要回到新建会话弹窗
  const [reopenNewAfterSave, setReopenNewAfterSave] = useState(false);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [showSidebar, setShowSidebar] = useState(true);
  // 分屏：paneLayout 决定有几格，panes 存每格放哪个会话
  const [paneLayout, setPaneLayout] = useState<"single" | "v2" | "h2" | "v3" | "grid4">(
    "single",
  );
  const [panes, setPanes] = useState<(string | null)[]>([]);
  const [focusedPane, setFocusedPane] = useState(0);
  // 命令面板（Ctrl+Shift+P）
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  // 右侧 AI Agent 面板
  const [aiPanelOpen, setAiPanelOpen] = useState(false);
  /**
   * 看板卡片的 1 秒重算时钟（只在面板打开时走）。
   *
   * 它**不是探测**：只把 `Date.now()` 放进 state，让"最近 5 秒还有没有终端输出"
   * 这件事被重新算一遍（见 `useUiClock` 与 `boardActivity.ts`）。
   */
  const aiUiNow = useUiClock(aiPanelOpen);
  const [aiNotices, setAiNotices] = useState<{ id: string; text: string; time: number }[]>([]);
  // AI 任务看板（v2）：本地 / WSL / 远端正在跑（或刚跑完）的 AI 汇总成卡片。
  //
  // ⚠️ `boardTasks` 是**渲染用的扁平形状**（沿用老卡片样式，界面先不大改），
  // 它是从后端的 `AiInstance` 映射出来的 —— 合并/去重/判状态都在后端做完了。
  const [boardTasks, setBoardTasks] = useState<AiTask[]>([]);
  /** AI 任务时间线（落盘的历史，G-01） */
  const [timeline, setTimeline] = useState<AiTurnRecord[]>([]);
  /** 看板快照（给"这条提醒该算在哪个窗口头上"用） */
  const boardTasksRef = useRef<AiTask[]>([]);
  /**
   * 最近一次采集到的**原始来源**（rollout 快照 / 这一轮的产物）。
   *
   * 为什么要留一份：`refreshBoard` 把它们当 `BoardSources` 送回后端（那边才能算陈旧、
   * 才能把 rollout 认领到某个实例上）；而快照和看板是**同一次手动刷新里先后采集**的
   * （先快照、后看板，见 `refreshAiPanel`），时间上对得上。
   */
  const snapshotRef = useRef<{
    session: OpenSession;
    snapshot: AiSessionSnapshot;
    artifacts: AiArtifact[];
  } | null>(null);
  /** 各会话最近一次命令的退出码（G-02：只有注入过 shell 集成的会话才有） */
  const [cmdExit, setCmdExit] = useState<Record<string, { exit: number; at: number }>>({});
  /** 这台机器的「AI 状态来源」：装了 herdr 就是它的 agent 状态机，否则是我们自己的探测 */
  const [aiSource, setAiSource] = useState<AiSourceInfo | null>(null);
  /** 正在探测（点那行来源时要给反馈，否则"没变化"会被当成"没生效"） */
  const [aiSourceProbing, setAiSourceProbing] = useState(false);
  /**
   * 手动点「刷新」后这一整轮探测是否还在跑（按钮上显示「探测中…」）。
   *
   * 注意它只是**一次点击的进度**，不是定时器：跑完立刻恢复成「刷新」。
   */
  const [aiRefreshing, setAiRefreshing] = useState(false);
  /** 防连点（state 更新是异步的，连点两下会在同一个 tick 里各跑一遍） */
  const aiRefreshBusy = useRef(false);
  /**
   * 有没有真的探测过「状态来源」。
   *
   * 为什么要单独记：以前面板一打开就自动探，所以「aiSource === null」可以等同于
   * "探了但没连上"；现在只在用户点「刷新」时才探 —— 没点过就显示「探测失败」是在冤枉人。
   */
  const [aiSourceProbed, setAiSourceProbed] = useState(false);
  /**
   * 每台机器探测一次就记住（key = profileId / 本地终端类型）。
   *
   * 为什么不用定时节流：这台机器装没装 herdr 不会自己变，而"装/不装"只在
   * 用户打开「新建会话」、点「刷新」、或点「重试/重探」时才需要知道。
   * 所以**缓存就够了，不需要时间窗口**：换会话、重开面板都不会再 ssh 一次。
   */
  const aiSourceCache = useRef<Map<string, AiSourceInfo>>(new Map());
  /** 各服务器有没有可用的 herdr（「新建会话」里据此决定 herdr 能不能勾） */
  const [herdrAvail, setHerdrAvail] = useState<Record<string, AiSourceInfo | null>>({});
  /**
   * `herdrAvail` 的 ref 镜像。
   *
   * 为什么必须有：`refreshBoard` 会在「刷新」和启动 AI 等多个异步流程里跑，
   * 它读到的是**那一次渲染的闭包**。
   * 只用 state 的话，探针刚回来的结果它看不见 —— 于是会**反复**去探、反复排队重刷
   * （我第一版就是这样，直接把界面刷成死循环；无头测试当场抓住了）。
   * 探测/缓存/安装都同时更新这份 ref，读的人永远看到最新值。
   */
  const herdrAvailRef = useRef<Record<string, AiSourceInfo | null>>({});
  /** 「正在探这台机器」也要用 ref —— 同上，闭包里的 state 会是旧值 */
  const probingHerdrRef = useRef<Record<string, boolean>>({});

  /** 记下某台机器的 herdr 探测结果（state 给界面，ref 给异步流程读） */
  function rememberHerdrAvail(profileId: string, info: AiSourceInfo | null) {
    herdrAvailRef.current = { ...herdrAvailRef.current, [profileId]: info };
    setHerdrAvail((m) => ({ ...m, [profileId]: info }));
  }

  /**
   * 写会话历史列表时的**唯一入口**。
   *
   * 为什么不让调用方直接 `setHistory(x)`：侧栏渲染里有 `history.filter(...)`，
   * 一旦某次拿到的是空值，**整个界面会白屏**（不是侧栏局部出错，是 React 整棵树崩）。
   * 这个坑是真被无头功能测试逼出来的：假后端少实现一个 `history_save` 就复现了。
   * 所以这里统一挡一道：不是数组就保留旧列表，宁可少一条记录，也不能把界面打崩。
   */
  function applyHistory(next: unknown) {
    if (Array.isArray(next)) {
      setHistory(next as HistoryEntry[]);
    }
  }
  /** 已经建好输入通道的观察窗会话（一个会话只建一次；断了会从这里删掉再重连） */
  const herdrInputs = useRef<Set<string>>(new Set());
  /** 「停止 herdr 服务」是个会关掉所有 herdr 窗格的动作 → 二段确认（不弹窗、不打断） */
  const [herdrStopArmed, setHerdrStopArmed] = useState(false);
  /** herdr 服务状态（只读探测；面板打开时刷新） */
  const [herdrServer, setHerdrServer] = useState<HerdrServerStatus | null>(null);
  /** 服务器上**真实存在**的 herdr 工作区 + 每个窗格的前台进程（只读探测） */
  const [herdrScan, setHerdrScan] = useState<HerdrWorkspaceScan | null>(null);
  /** 「清理没在用的工作区」会关掉服务器上的东西 → 也是二段确认 */
  const [herdrCleanArmed, setHerdrCleanArmed] = useState(false);
  /** 已经探过服务状态的服务器：换服务器时才再探一次，同一台机器来回切标签不重复 ssh */
  const herdrProbedFor = useRef<string | null>(null);
  /** 「探到 herdr 之后要不要再刷一次看板」的排队标记（见 refreshBoard 的 finally） */
  const boardRefreshQueued = useRef(false);
  /** 正在安装 herdr 的服务器（防重复点击；同时给界面显示"进行到哪一步"） */
  const [herdrInstalling, setHerdrInstalling] = useState<Record<string, string>>({});
  /** 正在探的服务器（避免"打开对话框"和"切服务器"同时发起两次探测） */
  const [probingHerdr, setProbingHerdr] = useState<Record<string, boolean>>({});
  const newDialogHerdr = newDialog ? herdrAvail[newDialog.profileId] : undefined;
  const newDialogCanHerdr =
    !!newDialogHerdr && !!newDialogHerdr.herdrVersion && newDialogHerdr.compat !== "too_old";
  const boardBusy = useRef(false);
  /** 上次扫本机进程表的时刻（本机扫描比远端探针贵得多，单独限流） */
  const lastLocalScan = useRef(0);
  // 会话日志快照（有新消息/在等你/耗时/token 都从这儿来）
  const [aiSnapshot, setAiSnapshot] = useState<AiSessionSnapshot | null>(null);
  /// 已经通知过的那一轮 —— **按会话分别记**（共用一个 key 会让两个会话互相"看起来是新的"，数字会一直涨）
  const aiTurnKey = useRef<Record<string, string>>({});
  const aiSeeded = useRef<Record<string, boolean>>({});
  /**
   * 已经"处理过"的 AI 轮次（记的是**任务**的身份，不是标签页的）。
   *
   * 为什么必须是全局一份：同一台服务器上多个标签拿到的是同一份 rollout 快照，
   * 按标签去重会导致"一个任务被记两次 / 提醒两次"（实测踩过）。
   */
  const aiHandledTurns = useRef<Set<string>>(new Set());
  /// 这一轮跑完之后的产物（卡片下面那排文件名）
  const [aiArtifacts, setAiArtifacts] = useState<AiArtifact[]>([]);
  /// 「AI 命令行工具」那段默认收起（上面看板才是主角）
  const [toolListOpen, setToolListOpen] = useState(false);
  /// 「最近任务」默认只露 3 条，想看全部点一下展开（不在那小框里上下拖）
  const [timelineAll, setTimelineAll] = useState(false);
  /**
   * 「最近完成 N 项」/「空闲 N 项」两行折叠（§10.1 / §10.2）。
   *
   * 默认都收起：**收起时不渲染明细**（不是 display:none —— 那样"展开前明细不可见"
   * 这条断言就成了看样式，看板也不该为看不见的东西干活）。
   */
  const [finishedOpen, setFinishedOpen] = useState(false);
  const [idleOpen, setIdleOpen] = useState(false);
  /**
   * 后端合并出来的**统一模型**（AI 实例）。
   *
   * 看板卡片从此只认这一份数据：前端不再自己合并/去重/判状态
   * （老看板的 `taskKeyOf` / `betterTask` / `absorbTask` 两趟补丁已删）。
   * 口径 docs/design-ai-board-v2.md §10；`badge()` 也是后端拼好的。
   */
  const [boardInstances, setBoardInstances] = useState<AiInstance[]>([]);
  /**
   * 红点规则 ①（§10.6）：当前**还在等你**的实例（存的是后端算好的去重 `key`）。
   *
   * 只由**自动来源**写入：本机 codex 日志的 `needs-you`（key `log|…`）、
   * herdr 红点轮询的 `blocked`（key `herdr|<服务器>|<窗格>`）；收到同一 key 的
   * `resolved` 才清 —— 所以"打开面板"不会把它清掉（亮到你处理为止）。
   * ⚠️ 手动点「刷新」**不碰它**（见 `refreshBoard` 里的说明）。
   */
  const [aiNeedIds, setAiNeedIds] = useState<string[]>([]);
  /**
   * 红点规则 ②（§10.6）：**跑完并停下**、你还没点开面板看的那几轮（按 key 去重）。
   * 打开面板即清 —— 它是一条"未读"。同样只由自动来源写入（本机日志的 `finished`；
   * herdr 的 done **只在"进入 done"的那一次**发，后端做边沿检测）。
   */
  const [aiPendingFinish, setAiPendingFinish] = useState<string[]>([]);
  /** AI 面板是否开着 —— 给事件回调读（effect 的依赖是 []，不能用 state 闭包） */
  const aiPanelOpenRef = useRef(false);
  /**
   * 这一轮刚采集到的 herdr agent（profileId → agents）。
   *
   * 为什么要留一份：后端的 `AiInstance` 只带"服务器名 + 窗格号"（它不知道本应用的
   * 连接配置 id），而"查看窗格 / 接管"两个按钮**必须要 profileId**；
   * 这份索引就是那条对应关系，不涉及任何合并逻辑。
   */
  const lastHerdrAgents = useRef<Record<string, HerdrAgent[]>>({});
  /**
   * 活动栏 AI 图标上的红点数字（§10.6）。
   *
   * 它只由两件事决定，而且两条规则各有一个开关：
   * ① 还在等你处理的有几个（亮到你处理为止）；② 跑完停下、还没点开面板的有几轮。
   * 运行中 / 空闲 / 陈旧 / 只产出文件 / 探测不到 —— **一个都不算**。
   */
  const aiBadgeCount =
    (settings.aiNotifyNeedsYouBadge ? aiNeedIds.length : 0) +
    (settings.aiNotifyFinishedBadge ? aiPendingFinish.length : 0);
  /**
   * AI 输入窗（状态栏「✍ 发给 AI」拉出来的那个）：多行编辑 + 附件。
   *
   * 为什么要有它：在 TUI 里敲长提示词很难受（不能点鼠标改、粘多行还容易被当成连按回车）。
   * 这里编辑好，发送时走 `bus.sendInput` → `term.paste()`（自动带 bracketed paste），
   * 多行提示词才会被 codex / claude 当成**一条**消息。
   */
  /**
   * 输入窗是否**展开**。默认收起 —— 收起时终端最下面只留一条细栏（点它展开）。
   * 终端才是主角，输入窗是"要用时才拿出来的工具"。
   */
  const [composerOpen, setComposerOpen] = useState(false);
  const [composerText, setComposerText] = useState("");
  /**
   * 已上传的附件：显示名 + 远端绝对路径（发送时把路径拼进正文）
   * + 本地临时路径（用完删）+ 缩略图 data URL（只用于"发送前确认粘对了没有"）。
   */
  const [composerFiles, setComposerFiles] = useState<
    { name: string; local: string; remote: string; thumb?: string; size?: number }[]
  >([]);
  const [composerBusy, setComposerBusy] = useState(false);

  /**
   * Ctrl+Alt+A：展开 / 收起底部的 AI 输入窗（键盘党的入口）。
   * 用捕获阶段 + preventDefault：免得这个组合键被别处（终端/浏览器）先吃掉。
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || !e.altKey || e.key.toLowerCase() !== "a") return;
      e.preventDefault();
      setComposerOpen((v) => !v);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  /**
   * 「直接粘进终端」时的缩略图浮层（几秒后自己消失）。
   *
   * 为什么不走输入窗就不给预览：那条路是"粘完就发"，用户没有任何别的地方能确认粘对没有 ——
   * 一张图比一行日志有用得多。这个设置（pasteToast）现在管的是"在终端区直接粘图片走哪条路"：
   * 不勾 = 放进输入窗（默认，能确认能补话）；勾上 = 插路径进终端 + 弹这张浮层。
   */
  const [pasteCard, setPasteCard] = useState<{
    thumb?: string;
    name: string;
    remote: string;
  } | null>(null);
  const pasteCardTimer = useRef<number | null>(null);
  /**
   * 当前会话的 ref：原生拖拽回调只订阅一次，但每次都要发给**当时**那个会话。
   * （在 activeSession 算出来之后赋值，见下面的 `activeSessionRef.current = activeSession`）
   */
  const activeSessionRef = useRef<OpenSession | null>(null);
  const [updateMsg, setUpdateMsg] = useState("");
  const [updateBusy, setUpdateBusy] = useState(false);
  /** 检查到新版本时记下可下载的产物，设置面板里会给出「立即下载」按钮 */
  const [updateOffer, setUpdateOffer] = useState<{
    version: string;
    installerUrl: string;
    installerSize: number;
    /** 官方 sha256（GitHub Release API 的 digest），下载后必须对得上 */
    installerSha: string;
    msiUrl: string;
    msiSize: number;
    msiSha: string;
    zipUrl: string;
    pageUrl: string;
  } | null>(null);
  /** 当前这份是怎么装上的：nsis / msi / portable */
  const [installKind, setInstallKind] = useState<string>("");
  /** 当前是不是以管理员身份在跑（状态栏显示一个标） */
  const [isAdminMode, setIsAdminMode] = useState(false);
  const [updateApplying, setUpdateApplying] = useState(false);
  // tmux 快捷操作面板（只在当前会话是 tmux 会话时出现）
  const [tmuxDockOpen, setTmuxDockOpen] = useState(true);
  const [tmuxWinList, setTmuxWinList] = useState<TmuxWindow[]>([]);
  const [tmuxBusy, setTmuxBusy] = useState(false);
  // 正在重命名窗口时的临时输入（用自绘输入框，不弹浏览器 prompt）
  const [tmuxRename, setTmuxRename] = useState<string | null>(null);
  // herdr 快捷操作面板（只在当前会话是 herdr 窗格时出现）——和上面那份 tnux 的对位关系一模一样
  const [herdrDockOpen, setHerdrDockOpen] = useState(true);
  const [herdrBusy, setHerdrBusy] = useState(false);
  /** 正在重命名窗格时的临时输入（自绘，不弹浏览器 prompt） */
  const [herdrRename, setHerdrRename] = useState<string | null>(null);
  /** 会真的关掉东西的动作 → 二段确认（第一次点只是把按钮变成"确认…"） */
  const [herdrArmed, setHerdrArmed] = useState<string | null>(null);

  const [adbList, setAdbList] = useState<AdbDevice[]>([]);
  const [adbVer, setAdbVer] = useState("");
  const [adbLoading, setAdbLoading] = useState(false);
  const [fbVer, setFbVer] = useState("");
  const [fbList, setFbList] = useState<AdbDevice[]>([]);
  const [serialPorts, setSerialPorts] = useState<SerialPortInfo[]>([]);
  const [serialLoading, setSerialLoading] = useState(false);
  // ADB 文件浏览器
  const [adbSerial, setAdbSerial] = useState<string | null>(null);
  const [adbPath, setAdbPath] = useState("/sdcard");
  const [adbFiles, setAdbFiles] = useState<AdbFile[]>([]);
  const [adbNewName, setAdbNewName] = useState("");
  const [serialDialog, setSerialDialog] = useState<{
    isNew: boolean;
    draft: ConnectionProfile;
  } | null>(null);
  const [serialMenu, setSerialMenu] = useState<{
    profile: ConnectionProfile;
    x: number;
    y: number;
  } | null>(null);

  const [fsPath, setFsPath] = useState("");
  const [fsInput, setFsInput] = useState("");
  const [fsEntries, setFsEntries] = useState<RemoteEntry[]>([]);
  const [fsLoading, setFsLoading] = useState(false);
  const [fsBusy, setFsBusy] = useState(false);
  const [fsMenu, setFsMenu] = useState<{
    profileId: string;
    name: string;
    isDir: boolean;
    x: number;
    y: number;
  } | null>(null);
  const [nameDialog, setNameDialog] = useState<{
    mode: "mkdir" | "rename";
    profileId: string;
    dir: string;
    from: string;
    value: string;
  } | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<{
    title: string;
    message: string;
    okLabel?: string;
    onOk: () => void;
  } | null>(null);
  const [tabMenu, setTabMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [sessionRename, setSessionRename] = useState<{ id: string; value: string } | null>(null);
  /** 正在被拖动的标签（用来实现左右拖动排序） */
  const [dragTabId, setDragTabId] = useState<string | null>(null);
  /** 拖动时鼠标的位置（画一个跟着鼠标的"虚影"，VSCode 那样看得见在拖） */
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  /** 侧栏宽度（可拖动调整，存 localStorage，下次打开还是你调好的宽度） */
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    // localStorage 在配额满/隐私模式下会抛异常；读和写都要兜住，
    // 否则一个存宽度的小功能能把整个渲染提交打断。
    try {
      const v = Number(localStorage.getItem("zeeai.sidebarWidth"));
      return v >= 180 && v <= 620 ? v : 240;
    } catch {
      return 240;
    }
  });
  // 拖动结束后把宽度记下来（下次打开还是你调好的宽度）
  useEffect(() => {
    try {
      localStorage.setItem("zeeai.sidebarWidth", String(sidebarWidth));
    } catch {
      /* 存不下就算了，不影响使用 */
    }
  }, [sidebarWidth]);
  // 供异步流程（如自动演示）读取最新路径，避免闭包拿到旧值
  const fsPathRef = useRef(fsPath);
  fsPathRef.current = fsPath;
  const sessionsRef = useRef<OpenSession[]>(sessions);
  sessionsRef.current = sessions;
  const profilesRef = useRef<ConnectionProfile[]>(profiles);
  profilesRef.current = profiles;
  // 自动检查更新用的是定时器回调，闭包里的 settings 会过期，所以这里存一份最新的
  const settingsRef = useRef<AppSettings>(settings);
  settingsRef.current = settings;
  // 字号（Ctrl + 滚轮 / Ctrl + +/- 用）：ref 里放"还没落盘"的临时值，避免连点时读到旧值
  const fontRef = useRef<number | null>(null);
  const fontSaveTimer = useRef<number | null>(null);
  const serialPortsRef = useRef<SerialPortInfo[]>([]);
  // 远程文件浏览器属于「当前会话」，所以读目录/读文件也要用当前会话实际登录的用户
  const activeUserRef = useRef<string | undefined>(undefined);
  const reconnectTimers = useRef<Record<string, number>>({});
  const reconnectTries = useRef<Record<string, number>>({});

  const [gitPath, setGitPath] = useState("");
  const [gitState, setGitState] = useState<GitStatus | null>(null);
  const [gitLoading, setGitLoading] = useState(false);
  const [gitInitDialog, setGitInitDialog] = useState<{ path: string } | null>(null);
  const [gitMessage, setGitMessage] = useState("");
  const [gitCommits, setGitCommits] = useState<GitCommit[]>([]);
  const [gitBranchList, setGitBranchList] = useState<GitBranch[]>([]);
  const [gitBusy, setGitBusy] = useState(false);
  const [showBranches, setShowBranches] = useState(false);
  const [newBranch, setNewBranch] = useState("");
  const [diffDialog, setDiffDialog] = useState<{ title: string; text: string } | null>(null);
  // 密码（存在 Windows 凭据管理器里，不写进配置文件）
  const [editPassword, setEditPassword] = useState("");
  const [editHasPassword, setEditHasPassword] = useState(false);
  // 文件传输进度（右下角那个小面板）
  const [transfers, setTransfers] = useState<
    {
      id: string;
      name: string;
      done: number;
      total: number;
      status: "running" | "done" | "failed";
      message?: string;
    }[]
  >([]);

  useEffect(() => {
    void refresh();
    void (async () => {
      try {
        setSettings({ ...DEFAULT_SETTINGS, ...(await settingsGet()) });
      } catch {
        /* 设置读取失败就用默认值 */
      } finally {
        setSettingsReady(true);
      }
    })();
    // 一次性问清楚"这份是怎么装上的"，决定后面给不给一键升级按钮
    void updateInstallKind()
      .then(setInstallKind)
      .catch(() => setInstallKind("portable"));
    // 是不是管理员模式（决定状态栏要不要标一下、菜单里那句要不要变）
    void isAdmin()
      .then(setIsAdminMode)
      .catch(() => setIsAdminMode(false));
    // 上一次自动升级的结果：升级脚本会写一行日志（安装器退出码 + 失败原因），
    // 这里读一次就清掉，只往底部状态栏提示 —— 免得再出现"点了升级，什么都没有"。
    void updateTakeResult()
      .then((r) => {
        if (!r) return;
        if (/ins.*exit=0/i.test(r) || r.includes("installer exit=0")) {
          notify("上次自动升级已安装完成");
        } else {
          notify(`上次自动升级没装成功（${r}）—— 已丢弃那个安装包，可直接再点一次「一键升级」`);
        }
      })
      .catch(() => {});
  }, []);

  /**
   * 后台自动检查更新。
   *
   * 时机：开机/启动应用时如果距上次检查超过 6 小时就查一次；之后每 30 分钟看一次表，
   * 仍然要求间隔满 6 小时才真的发请求 —— 也就是「一天最多几次」，不会来回骚扰。
   */
  useEffect(() => {
    if (!settingsReady) return;
    const MIN_INTERVAL_SECS = 6 * 3600;
    const due = () =>
      Date.now() / 1000 - (settingsRef.current.lastUpdateCheck ?? 0) > MIN_INTERVAL_SECS;
    // 静默的更新检查要发网络请求 —— 别让它挤在启动那一下
    if (due()) deferUntilIdle(() => void checkForUpdates({ silent: true }));
    const timer = window.setInterval(
      () => {
        if (due()) void checkForUpdates({ silent: true });
      },
      30 * 60 * 1000,
    );
    return () => window.clearInterval(timer);
    // 只在"设置读好了"这一刻挂上定时器，之后靠 settingsRef 取最新值
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsReady]);

  // ---------- 右侧 AI 面板：看板 / 完成通知 ----------
  function pushAiNotice(text: string) {
    const item = { id: uid(), text, time: Date.now() };
    setAiNotices((prev) => [item, ...prev].slice(0, 20));
    // 只进状态栏 + AI 面板的列表，不弹中央 toast（那玩意儿挡视线）
    notify(text);
  }

  /** 会话 → 看板上的「环境 + 服务器」 */
  function boardEnvOf(s: OpenSession): { env: string; server: string } {
    if (s.kind === "remote") {
      const name = profilesRef.current.find((p) => p.id === s.profileId)?.name ?? s.title;
      return { env: "remote", server: name };
    }
    return { env: s.kind === "wsl" ? "wsl" : "local", server: shellLabelOf(s.kind) };
  }

  /**
   * 刷新 AI 任务看板。
   *
   * 信号源按可靠度分层（越靠前越准）：App 自己启动的 > 远端 tmux 窗格 > 远端 ps 扫描 >
   * 本机进程表。几条必须守住的取舍：
   * - WSL 里的进程从 Windows 侧看不见（只有 wslhost/vmmem），所以交给后端**进 WSL 里查**；
   * - CMD 没有脚本钩子 → 只给「仅状态」，不为它扫全进程表；
   * - Windows 全进程表扫描偏重 → 只有真有本机会话时才调，而且手动刷新最多 60 秒一次；
   * - 卡片上只给「运行中 / 已结束 + 耗时」，**不做进度条**（TUI 没有百分比可拿）。
   */
  /**
   * 后端的 `AiInstance[]` → 卡片渲染用的扁平形状。
   *
   * 这是**纯形状转换 + 找回"点它能去哪"的凭据**（窗格号、对应的会话标签），
   * 不带任何合并/去重/判状态 —— 那些都在后端做完了。
   *
   * 两个字段需要在这里补：
   * - `pane`：herdr 实例的锚就是窗格号；从 `where`（`环境 · 目录 · herdr:w1:p1`）里取回来，
   *   它是"查看窗格 / 接管"这两个按钮唯一的凭据。取不到就留空 —— **不编**。
   * - `herdrProfileId`：后端不知道 profileId（那是本应用的连接配置），
   *   但前端刚把 herdr agent list 送进去过，按「服务器名 + 窗格号」查得回来。
   */
  function instanceTasks(list: AiInstance[]): AiTask[] {
    /**
     * 按「服务器 + 窗格号」索引**这一轮刚采集到的** herdr agent。
     *
     * 为什么不用探测缓存（`herdrAvail`）：那份只有"装了没/几个 agent"，没有窗格列表；
     * 而这里要的是 profileId（后端不知道本应用的连接配置 id，只有服务器名）。
     */
    const paneIndex = new Map<
      string,
      { profileId: string; paneId: string; agentStatus: string; attention: boolean }
    >();
    for (const [pid, agents] of Object.entries(lastHerdrAgents.current)) {
      const server =
        profilesRef.current.find((p) => p.id === pid)?.name ?? String(pid);
      for (const a of agents) {
        if (!a.paneId) continue;
        paneIndex.set(`${server}|${a.paneId}`, {
          profileId: pid,
          paneId: a.paneId,
          agentStatus: a.status,
          attention: !!a.attention,
        });
      }
    }
    return list.map((i) => {
      const parts = i.where.split(" · ");
      const pane = parts.length >= 3 ? parts[parts.length - 1].replace(/^[a-z]+:/, "") : "";
      const hit = pane ? paneIndex.get(`${parts[0]}|${pane}`) : undefined;
      const activity: AiActivity = i.activity ?? { artifacts: [] };
      const source =
        i.evidence
          .map((e) => e.source)
          .sort(
            (a, b) =>
              Number(b === "herdr-agent-list") - Number(a === "herdr-agent-list") ||
              Number(b === "app-ledger") - Number(a === "app-ledger"),
          )[0] ?? "local-process-table";
      return {
        id: i.id,
        env: parts[0] === "本机" ? "local" : parts[0] === "WSL" ? "wsl" : "remote",
        server: parts[0] ?? "",
        tool: aiAgentLabel(i.agent),
        command: activity.lastLine ?? "",
        cwd: parts[1] ?? "",
        pane: hit?.paneId ?? pane,
        source,
        // 老卡片样式只认 running / done 两档；**状态的判定不在这里**——
        // 它来自后端（承载能力闸门 + 陈旧降级），这里只做显示映射。
        state: i.state === "needs-you" || i.state === "working" ? "running" : "done",
        durationMs: activity.durationMs ?? 0,
        pid: 0,
        startedAt:
          activity.startedAtMs !== null && activity.startedAtMs !== undefined
            ? Math.round(activity.startedAtMs / 1000)
            : null,
        exitCode: null,
        herdrPane: hit?.paneId ?? null,
        herdrProfileId: hit?.profileId ?? null,
        herdrMode: hit?.paneId ? "control" : null,
        agentStatus: hit?.agentStatus ?? null,
        attention: i.state === "needs-you",
        // v2 新带上的几个字段（卡片上要显示来源徽标与悬停说明）
        badge: i.badge,
        activityLastLine: activity.lastLine ?? null,
        activityTokens: activity.tokens ?? null,
        activityStartedAtMs: activity.startedAtMs ?? null,
        where: i.where,
        carrier: i.carrier,
        evidenceCount: i.evidence.length,
      };
    });
  }

  /**
   * 红点（口径 docs/design-ai-board-v2.md §10.6，以及用户 2026-10-20 的原话）。
   *
   * **只有两件事值得亮**，而且都只能来自**自动来源**：
   * ① `needs-you` → 亮到**你处理为止**（后端看到"不再等你"才发 `resolved`）；
   * ② `finished`（这一轮跑完**而且停下**）→ 当"未读"，**点开面板即清**。
   *
   * **不亮**：运行中、空闲、陈旧、只产出文件还没停、探测不到，以及
   * **手动点「刷新」得到的任何东西** —— 用户明确说"手动刷新出现红点这种宁可不要"。
   *
   * 现在有**两条**自动来源，共用这一个入口（所以红点状态只有一份、判定只有一套）：
   * - `core/ai_log_watch.rs`：本机 codex rollout 日志（只读文件）；
   * - `core/ai_herdr_dots.rs`：herdr 窗格的 agent 状态（用户 2026-10-20 批准：
   *   每台勾了 herdr 的服务器 60 秒查一次 `herdr agent list`）。它的信号带
   *   `source: "herdr"`，key 是 `herdr|<服务器>|<窗格>`；`needs-you` 的提示文案
   *   因此要写"哪台机器 · 哪个 agent"。
   * 两条的**红点**判定都只在这一处；卡片是另一条路径（见下面 `applySignalCard` /
   * `applyHerdrSnapshot`，只更新卡片、不碰红点），两边互不影响。
   * ⚠️ 手动「刷新」永远不进这里（见 `refreshBoard` 的说明）。
   *
   * 去重：`key` 由后端算好（日志 `log|<文件>|<轮次>`；herdr `herdr|<服务器>|<窗格>`），
   * 同一 key 重复送达不会让数字往上涨；后端自己也跨轮去重。
   */
  function applyAiLogSignal(sig: AiLogSignal) {
    if (!sig || typeof sig.key !== "string" || !sig.key) return;
    if (sig.kind === "needs-you") {
      if (!settingsRef.current.aiNotifyNeedsYouBadge) return;
      setAiNeedIds((prev) => (prev.includes(sig.key) ? prev : [...prev, sig.key]));
      // "需要你"是唯一真正值得打断用户的事（§10.6）：除了红点，也在面板通知列表里
      // 留一句"是哪台机器 / 哪个目录 / 在等什么"。同一轮由后端去重；`resolved` 之后
      // 再次进入等待（同一轮里又要批准）会重新发一次 —— 这时候应该再提醒一次。
      if (settingsRef.current.aiNotifyNeedsYou) {
        // herdr 的 blocked 只有第一手状态、没有"最后一段话"，所以文案用
        // 「服务器 · agent + cwd」；本机日志保持原来的 codex 文案。
        const who =
          sig.source === "herdr"
            ? `${sig.serverName || sig.server || "服务器"} · ${herdrAgentLabel(sig.agent)}`
            : aiAgentLabel("codex");
        raiseAiAttention(
          `${who} 在等你处理${sig.cwd ? `（${sig.cwd}）` : ""}${
            sig.message ? "：" + sig.message : ""
          }`,
        );
      }
      return;
    }
    if (sig.kind === "resolved") {
      // 只清"需要你"那一条：它表示这一轮 / 这个窗格已经不再等你了
      // （herdr 的 blocked 消失、窗格被关、服务器被取消勾选，后端都会发同一个 key）
      setAiNeedIds((prev) => prev.filter((k) => k !== sig.key));
      return;
    }
    if (sig.kind === "finished") {
      if (!settingsRef.current.aiNotifyFinishedBadge) return;
      // 面板开着**而且窗口在前台** = 你正在看这一块，不必再记一条"未读"
      // （等价于"点开面板即清"；窗口在后台时照常亮，免得你回来才发现）。
      if (aiPanelOpenRef.current && document.hasFocus()) return;
      setAiPendingFinish((prev) => (prev.includes(sig.key) ? prev : [...prev, sig.key]));
    }
  }

  // ==========================================================================
  // 自动事件 → 卡片（2026-10-20：卡片也接上，不再只靠手动「刷新」）
  //
  // 用户拍板的最终形态：本机 codex 日志 / herdr 轮询这两路"能直接读"的来源
  // **红点和卡片都自动**；进程扫描 / 远程 ps / 裸 SSH / tmux / 手动刷新只更新卡片、
  // **永不产生红点**。所以下面这些函数只碰卡片，**不碰** `aiNeedIds` / `aiPendingFinish`
  // （红点仍归上面的 `applyAiLogSignal`，通知仍按原规则）。
  //
  // 三条铁律：
  // - **不调 `ai_instances`**：那等于把「刷新」按钮自动点一遍（会起进程 / ssh），
  //   用户明确反对隐形轮询 —— 事件里带的字段够画卡，就不该再探测；
  // - 对**已有卡片**只改 `state` / `activity` / 时间 / 徽标，`where` / 载体 / 证据 /
  //   产物这些"刷新拿到的完整字段"一律不动（事件里没有，编不出来）；
  // - 卡片不存在时建一张**最小卡** —— 这就是"没点刷新也能看到正在跑的本地 AI"。
  // ==========================================================================

  /** 毫秒 →「N 秒前 / N 分钟前 / N 小时前」（和后端 `human_age` 一个口径：徽标里那个"多久前"） */
  function autoAgeText(ms: number): string {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s} 秒前`;
    if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
    return `${Math.floor(s / 3600)} 小时前`;
  }

  /**
   * 自动更新/自动创建时那张卡的来源徽标。
   *
   * 为什么前端要自己拼：徽标里的"多久前"是后端 `badge()` 在合并那一刻算的；被动事件
   * 不经过后端，原样留着旧徽标就会出现"卡片刚更新、徽标却写 17 分钟前"。
   * 口径（谁说的 + 多久前 + 能不能说成事实）和后端 `AiInstance::badge()` 一致；
   * 末尾那句「自动更新」就是"这条是自动来的、不是点「刷新」拿到的"标记 ——
   * 手动刷新后后端徽标会整段覆盖，不再带这个后缀。
   */
  function autoBadgeText(source: "log" | "herdr", atMs: number): string {
    const age = autoAgeText(Date.now() - atMs);
    return source === "herdr"
      ? `herdr 第一手 · ${age} · 自动更新`
      : `rollout 日志 · ${age}，只能说明它在跑 · 自动更新`;
  }

  /** tool 名 → 统一 agent；认不出来的用 `{ other }` **保留原名**（和后端 `agent_of_tool` 一致）。 */
  function aiAgentOfTool(tool: string): AiAgentKind {
    const t = (tool || "").trim();
    if (!t) return "unknown";
    const k = t.toLowerCase();
    if (k === "codex" || k === "claude" || k === "gemini" || k === "aider") {
      return k as AiAgentKind;
    }
    return { other: t };
  }

  /**
   * 承载能力闸门（只给"被动事件建/改的卡"用）。
   *
   * 口径和后端 `ai_instance::sanitize_state` **一致**：推断绝不说成事实。
   * 本机 PowerShell 承载看不到"需要你"（§10.4，只有 herdr 有第一手状态机），
   * 所以日志说"在等你"时卡片只能显示"运行中"，原值记进 `downgradedFrom` 让界面如实提示。
   * ⚠️ 红点不受这条影响：日志说等你，红点照样亮 —— 那是另一条规则。
   */
  function autoGate(
    carrier: AiCarrier,
    state: AiState,
  ): { state: AiState; downgradedFrom: AiState | null } {
    if (carrier === "local-cmd") {
      return { state: "unknown", downgradedFrom: state === "unknown" ? null : state };
    }
    if (state === "needs-you" && carrier !== "herdr") {
      return { state: "working", downgradedFrom: "needs-you" };
    }
    if (state === "finished" && carrier === "ssh-bare") {
      return { state: "unknown", downgradedFrom: "finished" };
    }
    return { state, downgradedFrom: null };
  }

  /** `where`（`环境 · 目录 · 锚`）按后端那三段拆开（只拆，不改） */
  function whereOf(where: string): string[] {
    return (where || "").split(" · ");
  }

  /** 这条事件说的实例，是不是就是这张卡（按"跨轮不变的身份"比，不按 id 比） */
  function autoMatchesInstance(i: AiInstance, ev: AutoCardEvent): boolean {
    if (ev.carrier === "herdr") {
      if (i.carrier !== "herdr" || !ev.pane) return false;
      const parts = whereOf(i.where);
      // 后端 `AiInstance.where` 的形状：`<服务器名> · <cwd> · herdr:<窗格>`
      return parts[0] === ev.env && parts[2] === `herdr:${ev.pane}`;
    }
    // 本机 codex 日志：只有"本机 + codex + 同一目录"才算同一个实例
    //（和后端认领 rollout 观测的条件一字不差）。
    if (i.carrier !== "local-powershell") return false;
    if (aiAgentLabel(i.agent) !== "codex") return false;
    return !!ev.cwd && whereOf(i.where)[1] === ev.cwd;
  }

  /** 渲染用的扁平行（AiTask）和实例的对应：先认自己建的那张，再按身份认 */
  function autoMatchesTask(t: AiTask, ev: AutoCardEvent): boolean {
    if (t.id === `auto|${ev.key}`) return true;
    if (ev.carrier === "herdr") {
      return !!ev.pane && t.server === ev.env && (t.herdrPane ?? t.pane) === ev.pane;
    }
    return t.env === "local" && t.cwd === ev.cwd && t.tool === "codex";
  }

  /** 用事件里的信息建一张**最小卡**：只填事件确实带来的字段，其它留空（**不编**） */
  function autoInstance(ev: AutoCardEvent, atMs: number): AiInstance {
    const parts = [ev.env];
    if (ev.cwd) parts.push(ev.cwd);
    if (ev.carrier === "herdr" && ev.pane) parts.push(`herdr:${ev.pane}`);
    const gated = autoGate(ev.carrier, ev.state);
    // 证据来源按现有模型口径：herdr 是它自己报的（第一手），rollout 日志是推断。
    const source: AiEvidence["source"] = ev.source === "herdr" ? "herdr-agent-list" : "rollout";
    const evidence: AiEvidence = {
      source,
      atMs,
      confidence: ev.source === "herdr" ? "first-hand" : "inferred",
    };
    return {
      // id 只用来做 React key / 找渲染行：点「刷新」之后会整份换成后端算的 id，
      // 所以这里用"auto + 事件标识"就够（同一实例每轮都稳定，不会闪出两张卡）。
      id: `auto|${ev.key}`,
      carrier: ev.carrier,
      agent: ev.agent,
      where: parts.join(" · "),
      state: gated.state,
      evidence: [evidence],
      activity: {
        lastLine: ev.activity || null,
        startedAtMs: null,
        durationMs: null,
        tokens: null,
        artifacts: [],
      },
      sessionId: ev.sessionId ?? null,
      downgradedFrom: gated.downgradedFrom,
      ageMs: Math.max(0, Date.now() - atMs),
      badge: autoBadgeText(ev.source, atMs),
    };
  }

  /**
   * 把一条自动事件应用到看板：已有卡片就地改，没有就建最小卡。
   *
   * ⚠️ 这条路径**只碰卡片**：不写红点、不弹通知、不发任何探测命令。
   */
  function applyAutoCard(ev: AutoCardEvent) {
    if (!ev?.key) return;
    const at = ev.atMs > 0 ? ev.atMs : Date.now();
    const gated = autoGate(ev.carrier, ev.state);
    setBoardInstances((prev) => {
      const idx = prev.findIndex((i) => autoMatchesInstance(i, ev));
      if (idx < 0) return [...prev, autoInstance(ev, at)];
      const cur = prev[idx];
      const next: AiInstance = {
        ...cur,
        state: gated.state,
        downgradedFrom: gated.downgradedFrom,
        activity: {
          ...cur.activity,
          lastLine: ev.activity || cur.activity.lastLine || null,
        },
        ageMs: Math.max(0, Date.now() - at),
        badge: autoBadgeText(ev.source, at),
      };
      const out = prev.slice();
      out[idx] = next;
      return out;
    });
    setBoardTasks((prev) => {
      const idx = prev.findIndex((t) => autoMatchesTask(t, ev));
      const running = gated.state === "needs-you" || gated.state === "working";
      if (idx < 0) {
        // 用同一份"实例 → 扁平行"映射（`instanceTasks`）建行：这样卡片上的
        // 「查看窗格 / 接管」拿得到 herdrPane / herdrProfileId，不会因为少字段失效。
        const mapped = instanceTasks([autoInstance(ev, at)])[0];
        if (!mapped) return prev;
        // 事件本身就知道服务器 id / 窗格号 —— 直接钉上：服务器改过名时
        // `instanceTasks` 按名字反查会落空，按钮就点不动了（这条兜底不改变任何判定）。
        const row: AiTask = {
          ...mapped,
          herdrPane: ev.pane ?? mapped.herdrPane ?? null,
          herdrProfileId: ev.profileId ?? mapped.herdrProfileId ?? null,
          agentStatus: ev.status ?? mapped.agentStatus ?? null,
        };
        return [...prev, row];
      }
      const cur = prev[idx];
      const next: AiTask = {
        ...cur,
        state: running ? "running" : "done",
        attention: gated.state === "needs-you",
        agentStatus: ev.status ?? cur.agentStatus ?? null,
        herdrPane: ev.pane ?? cur.herdrPane ?? null,
        herdrProfileId: ev.profileId ?? cur.herdrProfileId ?? null,
        command: ev.activity || cur.command,
        activityLastLine: ev.activity || cur.activityLastLine || null,
      };
      const out = prev.slice();
      out[idx] = next;
      return out;
    });
  }

  /**
   * `zeeai://ai-log` 里带卡片字段的那几条（本机日志）→ 更新/创建卡片。
   *
   * 老的 herdr 红点信号 / 更早的 payload 没有 `instanceKey`，这里直接跳过：
   * 它们只影响红点，绝不能凭"猜"去建卡。红点逻辑仍在 `applyAiLogSignal` 里，原样不动。
   */
  function applySignalCard(sig: AiLogSignal) {
    if (!sig || typeof sig.instanceKey !== "string" || !sig.instanceKey) return;
    if (!sig.state) return;
    const isHerdr = sig.source === "herdr";
    applyAutoCard({
      source: isHerdr ? "herdr" : "log",
      key: sig.instanceKey,
      carrier: isHerdr ? "herdr" : "local-powershell",
      agent: isHerdr ? aiAgentOfTool(sig.agent) : "codex",
      env: isHerdr ? sig.serverName || sig.server || "服务器" : "本机",
      cwd: sig.cwd || "",
      state: sig.state,
      activity: sig.activity || "",
      atMs: sig.atMs,
      pane: isHerdr ? sig.turn : undefined,
      profileId: isHerdr ? sig.server : undefined,
      sessionId: sig.sessionId,
    });
  }

  /**
   * `zeeai://herdr-agents`：herdr 每一轮的全量卡片快照 → 更新/创建 herdr 卡片。
   *
   * 只读数据，不调任何命令（这份快照是后端 60 秒那次 `herdr agent list` 的副产品）。
   * 空列表**不删卡**：一张卡消失通常意味着"窗格被关了"，但网络抖动 / 服务刚重启也会
   * 暂时读不到；凭一次"没看见"删卡会让用户以为任务没了 —— 状态交给下一轮快照与红点信号。
   */
  function applyHerdrSnapshot(snap: HerdrAgentsSnapshot) {
    if (!snap || !Array.isArray(snap.agents) || !snap.server) return;
    // 先记一份 agent 索引：卡片上的「查看窗格 / 接管」要凭 profileId 才能开观察窗，
    // 而后端 `AiInstance.where` 里只有服务器显示名（前端 `instanceTasks` 靠这张表找回 id）。
    lastHerdrAgents.current = {
      ...lastHerdrAgents.current,
      [snap.server]: snap.agents.map((a) => ({
        kind: a.agent,
        status: a.status,
        cwd: a.cwd,
        paneId: a.pane,
        tabId: a.tab,
        workspaceId: a.workspace,
        title: a.title,
        focused: !!a.focused,
        attention: !!a.attention,
      })),
    };
    const at = snap.atMs > 0 ? snap.atMs : Date.now();
    const env = snap.serverName || snap.server;
    for (const a of snap.agents) {
      // 没有窗格 / 没有 agent 的条目连卡片都画不出来（也点不了「查看窗格」）—— 跳过。
      if (!a || !a.pane || !a.agent) continue;
      applyAutoCard({
        source: "herdr",
        key: `herdr|${snap.server}|${a.pane}`,
        carrier: "herdr",
        agent: aiAgentOfTool(a.agent),
        env,
        cwd: a.cwd || "",
        state: a.state || herdrStateOf(a.status),
        activity: a.activity || "",
        atMs: at,
        pane: a.pane,
        profileId: snap.server,
        status: a.status,
        attention: !!a.attention,
        sessionId: "",
      });
    }
  }

  /**
   * 自动来源的事件入口（前端**没有任何定时器**，全部由 Rust 侧推）。
   *
   * 两个事件，各管一件事：
   * - `zeeai://ai-log`：本机 codex 日志（2.5 秒 stat，只读文件）与 herdr 红点轮询
   *   （每台勾了 herdr 的服务器 60 秒一次，走隐藏窗口的 `commands::herdr_agents`）。
   *   → **红点**仍归 `applyAiLogSignal`（判定只有那一份）；同一 payload 里如果带了
   *   `instanceKey` / `state`（本机日志那一路），再顺手更新/创建卡片（`applySignalCard`）。
   * - `zeeai://herdr-agents`：herdr 每轮那份 `agent list` 的**全量快照** →
   *   更新/创建 herdr 卡片（`applyHerdrSnapshot`）。它不碰红点。
   *
   * 为什么不用前端定时器：用户对"短周期探测"极其敏感（0.1.12 的真机报障就是每 20 秒
   * 拉子进程弹黑框），而且 herdr 那条要起 ssh —— 定时器、失败重试、跨轮去重都必须
   * 留在 Rust 侧（那边有状态机），前端只负责"收到什么就画什么"。
   * ⚠️ App.tsx 里**不要**再为红点/卡片加 setInterval / setTimeout 轮询。
   */
  useEffect(() => {
    let disposed = false;
    const unlistens: (() => void)[] = [];
    /** 挂一个监听（页面卸载时统一摘掉；事件通道坏了不该影响界面） */
    const on = <T,>(event: string, handler: (payload: T) => void) => {
      void listen<T>(event, (ev) => handler(ev.payload))
        .then((u) => {
          if (disposed) u();
          else unlistens.push(u);
        })
        .catch(() => {
          // 事件通道坏了不该影响界面（红点/卡片只是锦上添花）
        });
    };
    on<AiLogSignal>("zeeai://ai-log", (sig) => {
      // ① 红点：原样（两条自动来源共用这一个入口、一套判定）
      applyAiLogSignal(sig);
      // ② 卡片：只认带卡片字段的信号（本机日志）；herdr 的全量快照走下面那个事件
      applySignalCard(sig);
    });
    on<HerdrAgentsSnapshot>("zeeai://herdr-agents", (snap) => applyHerdrSnapshot(snap));
    return () => {
      disposed = true;
      for (const u of unlistens) u();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * 采集一份 `BoardSources` 用的原始数据（**只采不管**）。
   *
   * 这里刻意不做任何合并/去重/判状态：那三条口径只能有一份实现，在后端
   * （`core/ai_instance.rs`；见 §10 与 `commands::ai_instances` 的注释）。
   */
  function collectBoardSources() {
    const sources: BoardSources = { tasks: [], herdr: [], ledger: [], rollouts: [] };
    const jobs: Promise<void>[] = [];
    const seenRemote = new Set<string>();
    const seenLocal = new Set<string>();
    const now = Date.now();
    for (const s of sessionsRef.current) {
      if (s.kind === "remote" && s.profileId) {
        const key = `${s.profileId}|${s.user ?? ""}`;
        if (seenRemote.has(key)) continue;
        seenRemote.add(key);
        const server = boardEnvOf(s).server;
        jobs.push(
          aiTasksRemote(s.profileId, server, s.user ?? null)
            .then((list) => {
              sources.tasks.push(...list);
            })
            .catch(() => {}),
        );
        // herdr 是"第一手"状态源：装了它的机器上，`agent list` 能给出 working / blocked
        // 这种我们扫进程拿不到的判定，还能直接定位到窗格（点卡片就能开观察窗）。
        // 没装（或还没探过）就照旧只看 ps/tmux 那两条路 —— 探测结果按服务器缓存，不会反复 ssh。
        const src = herdrAvailRef.current[s.profileId];
        if (src === undefined) {
          // 第一次遇到这台机器：探测是异步的，这一轮看板还拿不到 herdr 的 agent。
          // 探完再补刷一次，不然这一次「刷新」里就少一台机器的 herdr 状态。
          const pid0 = s.profileId;
          jobs.push(
            probeHerdrFor(s.profileId, s.user).then(() => {
              // 只有"这一次真的把结果拿到了"才补刷；否则（比如同一台机器已经在探）
              // 交给那个在飞的探针去收尾，免得两边互相触发、把看板刷成死循环。
              if (herdrAvailRef.current[pid0] !== undefined) {
                boardRefreshQueued.current = true;
              }
            }),
          );
        } else if (src && src.herdrVersion && src.compat !== "too_old") {
          const pid = s.profileId; // 闭包里 TS 认不出上面的非空收窄，这里钉一下
          jobs.push(
            herdrAgents(pid, s.user ?? null)
              .then((agents) => {
                lastHerdrAgents.current = { ...lastHerdrAgents.current, [pid]: agents };
                if (agents.length) sources.herdr.push({ env: server, agents });
              })
              .catch(() => {}),
          );
        }
      } else if (s.kind === "powershell" || s.kind === "wsl" || s.kind === "cmd") {
        // 每种本地终端只扫一次（多开几个 PowerShell 没必要扫好几遍进程表）
        if (seenLocal.has(s.kind)) continue;
        seenLocal.add(s.kind);
        // 本机扫描要起一个 PowerShell 去枚举进程（实测 0.6~1 秒），比远端探针贵得多，
        // 所以单独限流：最多 60 秒一次。看板对"本机多出来了哪个 AI"并不需要秒级新鲜度。
        if (now - lastLocalScan.current < LOCAL_SCAN_MIN_INTERVAL_MS) continue;
        lastLocalScan.current = now;
        jobs.push(
          aiTasksLocal(s.kind, shellLabelOf(s.kind), null)
            .then((list) => {
              sources.tasks.push(...list);
            })
            .catch(() => {}),
        );
      }
    }
    return { sources, jobs };
  }

  /**
   * 刷新 AI 任务看板（口径 docs/design-ai-board-v2.md §10.1 / §10.2 / §10.5）。
   *
   * 数据怎么走：**前端只采集**（herdr agent list / 远端 tmux+ps / 本机 winproc / WSL /
   * App 账本 / rollout 快照）→ 原样送进 `BoardSources` → 后端合并成 `AiInstance[]` →
   * 前端只负责画。
   *
   * 为什么合并必须在后端：**可信度闸门**（推断不许说成事实）、**陈旧降级**、
   * **一个实例一张卡** 这三条口径只能有一份实现 —— 老看板在前端 JS 里用两趟补丁逼近，
   * 于是留下过"同一目录两个 codex 只剩一张卡"这种毛病。
   *
   * 几条必须守住的取舍（没变过）：
   * - WSL 里的进程从 Windows 侧看不见（只有 wslhost/vmmem），所以交给后端**进 WSL 里查**；
   * - CMD 没有脚本钩子 → 空承载**不上板**（§10.5，只在承载健康里可查）；
   * - Windows 全进程表扫描偏重 → 只有真有本机会话时才调，而且 60 秒才一次；
   * - 卡片上只给「运行中 / 已结束 + 耗时」，**不做进度条**（TUI 没有百分比可拿）。
   */
  async function refreshBoard() {
    if (boardBusy.current) return;
    boardBusy.current = true;
    try {
      const { sources, jobs } = collectBoardSources();
      await Promise.all(jobs);
      // App 账本：只挑我们自己启动的那批（`source == "app"`），按"环境 + 承载/窗格"分组。
      // 分组时把**前端才知道的**窗格信息带上：带上之后它和该窗格的第一手观测**锚相同**，
      // 后端第一趟合并就会并成一张卡（不需要模型层"按目录猜"那种危险规则）。
      const ledgerByKey = new Map<string, AiLedgerGroup>();
      for (const t of sources.tasks) {
        if (t.source !== "app") continue;
        const pane = t.herdrPane ?? t.pane ?? "";
        const carrier: AiCarrier =
          t.env === "local" || t.env === "wsl"
            ? t.env === "wsl"
              ? "wsl"
              : "local-powershell"
            : t.herdrPane
              ? "herdr"
              : pane
                ? "tmux"
                : "ssh-bare";
        const key = `${t.env}|${carrier}|${pane}`;
        let g = ledgerByKey.get(key);
        if (!g) {
          g = {
            env: t.server,
            carrier,
            herdrPane: t.herdrPane ?? null,
            tmuxTarget: t.herdrPane ? null : t.pane || null,
            cwd: t.cwd || null,
            sessionId: null,
            items: [],
          };
          ledgerByKey.set(key, g);
        }
        g.items.push({
          id: t.id,
          env: t.env,
          server: t.server,
          tool: t.tool,
          command: t.command,
          // AiTask.startedAt 是 **Unix 秒**，账本那层是 snake_case 的秒
          started_at: t.startedAt ?? 0,
          last_running_at: t.startedAt ?? 0,
          running: t.state === "running",
        });
      }
      sources.ledger = Array.from(ledgerByKey.values());
      // rollout 快照：**当前会话那一份**（codex 日志）。它没有窗格锚，
      // 后端只在"环境 + agent + 目录"候选唯一时认领一个已有实例，认不到就单独成卡。
      const snap = snapshotRef.current;
      if (snap?.session) {
        const ss = snap.snapshot;
        const carrier: AiCarrier =
          snap.session.kind === "remote"
            ? snap.session.herdrPane
              ? "herdr"
              : snap.session.tmuxMode && snap.session.tmuxMode !== "none"
                ? "tmux"
                : "ssh-bare"
            : snap.session.kind === "wsl"
              ? "wsl"
              : "local-powershell";
        const rollout: AiRolloutGroup = {
          env: boardEnvOf(snap.session).server,
          snapshot: ss,
          carrier,
          artifacts: snap.artifacts.map((a) => a.name),
        };
        sources.rollouts = [rollout];
      }
      // 合并 + 闸门 + 排序全在后端（这里只等结果）
      const list = await aiInstances(sources);
      const out = instanceTasks(list);
      setBoardInstances(list);
      setBoardTasks(out);
      boardTasksRef.current = out;
      // ⚠️ 这里**绝不碰红点**（§10.6 + 用户 2026-10-20 的原话）。
      //
      // 红点只允许来自"能直接读"的自动来源（本机 codex rollout 日志 + herdr 窗格状态，
      // 见 `applyAiLogSignal` / `core/ai_log_watch.rs` / `core/ai_herdr_dots.rs`）。
      // 手动点「刷新」得到的数据是**一次性快照**：把它变成红点就是伪信号 ——
      // 用户原话："手动刷新出现红点这种宁可不要"。
      // 所以 `refreshBoard` 只负责卡片/看板；以前这里那句 `applyBoardAlerts(list)`
      // 已经删掉了，别再加回来。
      // （卡片自动更新走的是事件那条路，和这里无关；刷新后卡片以 `ai_instances` 为准。）
    } finally {
      boardBusy.current = false;
      // 这一轮里"探测 herdr 完事"是异步回来的：等当前这轮真的结束再补刷，避免互相顶掉
      if (boardRefreshQueued.current) {
        boardRefreshQueued.current = false;
        void refreshBoard();
      }
    }
  }

  /** 清掉看板上「已结束」的卡片（还在跑的不动） */
  async function clearFinishedTasks() {
    const envs = new Map<string, { env: string; server: string }>();
    for (const t of boardTasks) {
      if (t.state === "done") envs.set(`${t.env}|${t.server}`, { env: t.env, server: t.server });
    }
    for (const { env, server } of envs.values()) {
      await aiTasksClearFinished(env, server).catch(() => {});
    }
    await refreshBoard();
  }

  /** 读一次落盘的任务时间线（G-01） */
  async function loadTimeline() {
    try {
      setTimeline(await aiTimelineList());
    } catch {
      // 读不到就当空列表，不打扰用户（第一次运行本来就没有）
    }
  }

  /**
   * 探测这台机器的「AI 状态来源」——装了 herdr 就用它的 agent 状态机（working / blocked / done，
   * 第一手），没装就用我们自己的进程扫描 + 日志解析（第二手）。
   *
   * 只读探测（跑 `herdr --version` / `agent list`），**不启动、不安装、不改远程任何东西**。
   * 装没装这种事不会天天变，所以按机器缓存（同一进程内不重复 ssh；点「刷新」时强制重探）。
   */
  async function refreshAiSource(force = false) {
    const cur = sessionsRef.current.find((s) => s.id === activeId);
    if (!cur) {
      setAiSource(null);
      return;
    }
    const key = cur.profileId ?? cur.kind;
    const cached = aiSourceCache.current.get(key);
    if (cached && !force) {
      setAiSource(cached);
      return;
    }
    setAiSourceProbing(true);
    try {
      const info = await aiSourceProbe(cur.profileId ?? null, cur.user ?? null);
      aiSourceCache.current.set(key, info);
      setAiSource(info);
      // 顺手同步给"看板那份"：面板顶上的来源和卡片上的 herdr 状态应该是同一份事实
      if (cur.profileId) rememberHerdrAvail(cur.profileId, info);
      // 强制重探时给一句回执 —— 否则结果和上次一样，用户会以为"点了没反应"（实测反馈）
      if (force) {
        notify(
          info.herdrVersion
            ? `重新探测完成：herdr ${info.herdrVersion}（协议 ${info.protocol}，agent ${info.agents}）`
            : "重新探测完成：这台机器上没有 herdr",
        );
      }
    } catch {
      // 探不到就当"没有 herdr"处理：看板会显示来源不明确，但功能照旧
      setAiSource(null);
      if (cur.profileId) rememberHerdrAvail(cur.profileId, null);
      if (force) notify("探测 herdr 失败，已按「没有 herdr」处理");
    } finally {
      // 探过（不管成没成）才允许界面说"探测失败"；没点过刷新时这块不出现
      setAiSourceProbed(true);
      setAiSourceProbing(false);
    }
  }

  /**
   * 为「新建会话」对话框探一下目标服务器有没有可用的 herdr。
   *
   * 注意要按**对话框里选的那台服务器**探（不是当前会话那台）—— 用户可能在对话框里切服务器。
   * 命中缓存就不重复 ssh；结果存进 herdrAvail，供那个复选框决定能不能勾。
   */
  async function probeHerdrFor(
    profileId: string,
    user?: string | null,
    /** true = 绕开成功缓存、**强制重探一次**（用户明确要用 herdr 时走这条） */
    force = false,
  ): Promise<AiSourceInfo | null | undefined> {
    if (!force) {
      const cached = aiSourceCache.current.get(profileId);
      if (cached) {
        rememberHerdrAvail(profileId, cached);
        return cached;
      }
    }
    if (probingHerdrRef.current[profileId]) {
      // 已经在探了，别重复 ssh；把当前已知的结果先给调用方
      return herdrAvailRef.current[profileId];
    }
    probingHerdrRef.current = { ...probingHerdrRef.current, [profileId]: true };
    setProbingHerdr((m) => ({ ...m, [profileId]: true }));
    try {
      const info = await aiSourceProbe(profileId, user ?? null);
      aiSourceCache.current.set(profileId, info);
      rememberHerdrAvail(profileId, info);
      return info;
    } catch {
      // **失败不写进成功缓存**（一次网络抖动不该让这台机器整场都"没装 herdr"）；
      // 只记一条"探测失败"，界面据此提示可以重试。
      rememberHerdrAvail(profileId, null);
      return null;
    } finally {
      probingHerdrRef.current = { ...probingHerdrRef.current, [profileId]: false };
      setProbingHerdr((m) => ({ ...m, [profileId]: false }));
    }
  }

  /**
   * 给一个 herdr 观察窗建输入通道（同一个会话只建一次；失败会记录下来下次重试）。
   *
   * 为什么输入要单独一条通道：观察窗的"输出"是 herdr 的只读流，那条 PTY 不能写；
   * 按键得由 herdr 自己去敲（`pane send-text` / `pane send-keys`），所以后端常驻一条
   * ssh 专门收指令（见 commands.rs::herdr_pane_input_start）。
   */
  /**
   * 刷新 herdr **服务**状态（只读）。
   *
   * 「装了 herdr」和「herdr 服务在跑」是两件事：服务没在跑时窗格/工作区都取不到。
   * 界面必须把这两种状态分开说，并且让用户能显式启动/停止。
   */
  async function refreshHerdrServer(profileId?: string | null, user?: string | null) {
    const pid = profileId ?? activeSession?.profileId;
    if (!pid) {
      setHerdrServer(null);
      setHerdrScan(null);
      return;
    }
    // 只有"当前会话那台机器"的结果才配写进面板/状态条的状态里。
    // 「管理 herdr 工作区」面板管的是**右键选中的那台**，它不一定是当前打开着会话的那台；
    // 那种情况下面板自己有 herdrMgr 那份状态，别把别人的数字糊到状态条上。
    const forActive = pid === activeSession?.profileId;
    try {
      // 「装了」≠「服务在跑」≠「有工作区」≠「我们开着的会话」——这四件事分开说，
      // 顺手把工作区 + 前台进程也拿回来，好跟我们会话列表对比出"没在用且是空壳"的那些。
      const [status, scan] = await Promise.all([
        herdrServerStatus(pid, user ?? null),
        herdrWorkspaceScan(pid, user ?? null),
      ]);
      if (!forActive) return;
      setHerdrServer(status);
      setHerdrScan(scan);
    } catch {
      if (!forActive) return;
      // 探不到就当"不知道"，界面不显示这两行（不影响别的功能）
      setHerdrServer(null);
      setHerdrScan(null);
    }
  }

  /**
   * 服务器上**没在用**的 herdr 工作区。
   *
   * herdr 的工作区天生是持久的（这正是它比 tmux 强的地方），但每开一次 herdr 会话就多一个，
   * **关掉标签页并不会回收它们** —— 攒久了服务器上会留一串空工作区（用户撞见过十几条，还
   * 因此以为"一台机器上只能有一个 herdr"）。这里把"服务器上真实存在的"减去"我们这边引用到的"
   * （开着的标签 + 历史记录 + AI 看板里的任务）才叫没在用；清理动作**只碰这些**。
   */
  function herdrOrphans(): string[] {
    const pid = activeSession?.profileId;
    if (!herdrScan || !pid) return [];
    const used = new Set<string>();
    const ws = (p?: string | null) => (p ? p.split(":")[0] : "");
    for (const s of sessions) {
      if (s.profileId !== pid) continue;
      const w = ws(s.herdrPane);
      if (w) used.add(w);
    }
    for (const h of history) {
      if (h.profileId !== pid) continue;
      const w = ws(h.herdrPane);
      if (w) used.add(w);
    }
    for (const t of boardTasks) {
      if (t.herdrProfileId !== pid) continue;
      const w = ws(t.herdrPane);
      if (w) used.add(w);
    }
    return herdrScan.workspaces.filter((w) => !used.has(w));
  }

  /**
   * 上面那些"没在用"的里面，哪些是**空壳**。
   *
   * 空壳 = 这个工作区里每个窗格的**前台进程都是 shell**（我扫回来的就是它 --
   * `herdr pane process-info` 给的 foreground_processes[].name）。只要有一个窗格
   * 里跑着别的东西（codex / vim / 编译 / 一个没退出的命令），这个工作区就**不算空壳**，
   * 再没在用也不会被清理 —— 关掉它等于直接毁掉用户正在干的活，不干这种事。
   *
   * 取不到进程名（空串）当"不知道"，也按不安全处理。
   */
  function herdrCleanable(): string[] {
    if (!herdrScan) return [];
    const busy = new Set<string>();
    const seen = new Set<string>();
    for (const p of herdrScan.panes) {
      const w = p.paneId.split(":")[0];
      if (!w) continue;
      seen.add(w);
      if (!SHELL_NAMES.has((p.procName || "").trim().toLowerCase())) busy.add(w);
    }
    return herdrOrphans().filter((w) => seen.has(w) && !busy.has(w));
  }

  /** 清理**空壳** herdr 工作区（只有用户二段确认之后才会走到这里）。 */
  async function cleanHerdrOrphans() {
    const pid = activeSession?.profileId;
    setHerdrCleanArmed(false);
    if (!pid) return;
    const doomed = herdrCleanable();
    if (!doomed.length) {
      notify("没有可以清理的空壳 herdr 工作区");
      return;
    }
    const user = activeSession?.user ?? null;
    const failed: string[] = [];
    // 一个一个关：某一个关不掉（刚好有人在用）不影响其它
    for (const w of doomed) {
      try {
        await herdrWorkspaceClose(pid, w, user);
      } catch {
        failed.push(w);
      }
    }
    const ok = doomed.length - failed.length;
    notify(
      failed.length
        ? `已清理 ${ok} 个空壳 herdr 工作区；${failed.join("、")} 没关掉（可能正被别的客户端用着）`
        : `已清理 ${ok} 个空壳 herdr 工作区`,
    );
    void refreshHerdrServer();
  }

  /**
   * 读一台服务器上的 herdr 现状（给「管理 herdr 工作区」面板用）。
   *
   * 三样一起拿：有哪些工作区 + 每个窗格上跑着什么（前台进程）、窗格本身的标题/目录/agent
   * 状态（`herdr pane list` 那份）、以及服务在不在跑。少了任何一样，用户就没法判断
   * "哪个是我要的、哪个是可以关掉的"。
   */
  async function refreshHerdrMgr(profile: ConnectionProfile) {
    const user = profile.ssh?.user ?? null;
    setHerdrMgrLoading(true);
    try {
      const [scan, panes, server] = await Promise.all([
        herdrWorkspaceScan(profile.id, user),
        herdrPanes(profile.id, user),
        herdrServerStatus(profile.id, user),
      ]);
      setHerdrMgr({ scan, panes, server });
    } catch (e) {
      notify("读取 herdr 工作区失败：" + String(e));
      setHerdrMgr(null);
    } finally {
      setHerdrMgrLoading(false);
    }
  }

  /**
   * 在服务器上**关掉一个 herdr 工作区**（连带里面的窗格）。
   *
   * 这是"会在远端真的动手"的动作，所以在界面上必须二段确认：第一次点只是把按钮
   * 变成确认态（并把窗格号写出来），再点一次才真关。
   */
  async function closeHerdrWorkspace(profile: ConnectionProfile, ws: string) {
    const user = profile.ssh?.user ?? null;
    setHerdrMgrArmed(null);
    try {
      await herdrWorkspaceClose(profile.id, ws, user);
      notify(`已在服务器上关掉 herdr 工作区 ${ws}`);
    } catch (e) {
      notify(`关掉 herdr 工作区 ${ws} 失败：` + String(e));
    }
    // 关掉之后本地那几条指向它的会话/历史就没意义了；但**不删记录**（用户可能还想留个痕），
    // 只是把"服务器上还在"这个前提去掉了 —— 打开它会走我们新加的那条"窗格没了"的人话路径。
    if (herdrTarget?.id === profile.id) void refreshHerdrMgr(profile);
    void refreshHerdrServer(profile.id, user);
  }

  /**
   * 启动 herdr 服务（后台起来，不挂在我们这条 ssh 上）。
   *
   * 不传参数 = 针对**当前会话**那台机器；传了就是"管理面板"里选中的那台
   * （面板管理的服务器不一定是当前打开着会话的那台）。
   */
  async function startHerdrServer(pidOverride?: string, userOverride?: string | null) {
    const pid = pidOverride ?? activeSession?.profileId;
    if (!pid) return;
    const user = userOverride ?? (pidOverride ? null : activeSession?.user ?? null);
    try {
      const out = await herdrServerStart(pid, user);
      notify(`herdr 服务已启动（${out || "ok"}）`);
    } catch (e) {
      notify("启动 herdr 服务失败：" + String(e));
    }
    void refreshHerdrServer(pid, user);
  }

  /**
   * 停止 herdr 服务。**会关掉它管着的所有窗格**（包括别的客户端正在用的），
   * 所以走"二段确认"：第一次点只是把按钮变成确认态，再点一次才真停。
   */
  async function stopHerdrServer(pidOverride?: string, userOverride?: string | null) {
    const pid = pidOverride ?? activeSession?.profileId;
    if (!pid) return;
    const user = userOverride ?? (pidOverride ? null : activeSession?.user ?? null);
    try {
      const out = await herdrServerStop(pid, user);
      notify(`已停止 herdr 服务（${out || "ok"}）—— 它管着的窗格都关掉了`);
    } catch (e) {
      notify("停止 herdr 服务失败：" + String(e));
    }
    setHerdrStopArmed(false);
    void refreshHerdrServer(pid, user);
  }

  async function ensureHerdrInput(
    id: string,
    profileId: string,
    user: string | null,
    paneId: string,
  ) {
    if (herdrInputs.current.has(id)) return;
    herdrInputs.current.add(id);
    try {
      await herdrPaneInputStart(id, profileId, user, paneId);
    } catch (e) {
      herdrInputs.current.delete(id);
      notify("观察窗的输入通道没建起来：" + String(e));
    }
  }

  /**
   * 打开一个 herdr 窗格会话。
   *
   * - `mode = "observe"`（默认）：**只读观察窗**，可多开、不抢键盘也不抢尺寸；
   * - `mode = "control"`：**可读可写**，等于"进到她的环境里干活"（会接管那个窗格的输入，
   *   所以后端带 `--takeover`；关标签时会主动交还控制权，窗格本身留在服务器上）。
   *
   * 为什么都不是"attach 她的 TUI"：TUI 退出时会把终端留在花屏状态，而且它自己会跟别的
   * 客户端抢窗格尺寸（用户截图里那两件事）。
   */
  async function openHerdrPane(
    profileId: string,
    paneId: string,
    label?: string,
    userOverride?: string | null,
    mode: "observe" | "control" = "observe",
  ) {
    const profile = profiles.find((p) => p.id === profileId);
    if (!profile) {
      notify("这台服务器的配置已经不在了");
      return;
    }
    const user = userOverride ?? profile.ssh?.user ?? null;
    // 标题里带上窗格号：同一台机器上开了两个 codex 时，光看"lz · codex"分不清点的是哪个；
    // 可写的那条再标一个"接管"，免得跟只读观察窗混起来
    const title = `${profile.name} · ${(label ?? "").trim() || "herdr"} ${paneId}${
      mode === "control" ? "（接管）" : ""
    }`;
    const id = await openSshSession(
      profile,
      "name",
      paneId,
      user,
      title,
      null,
      mode === "control" ? "herdr-control" : "herdr-pane",
      paneId,
      mode,
    );
    // 可写那条的输入直接走它自己的流，不需要另建输入泵
    if (mode === "observe") await ensureHerdrInput(id, profileId, user, paneId);
  }

  /**
   * 一键安装 herdr（Windows 侧下载 → 校验 sha256 → scp 到 ~/.local/bin）。
   *
   * 为什么由我们下载再传：服务器上直连 GitHub 经常只有十几 KB/s（官方 install.sh 的
   * 10 秒超时必然失败，用户手动装就是这么失败的）；而 herdr.dev 和镜像在国内都快得多。
   * 不管走哪条路，都拿**官方清单里的 sha256** 校验，对不上就删掉重来 —— 来源可以换，字节不能换。
   */
  async function installHerdrFor(profileId: string, user?: string | null) {
    const profile = profiles.find((p) => p.id === profileId);
    if (!profile) return;
    if (herdrInstalling[profileId]) {
      notify("这台服务器正在装 herdr，别急");
      return;
    }
    setHerdrInstalling((m) => ({ ...m, [profileId]: "准备中…" }));
    try {
      const rep = await herdrInstall(profileId, user ?? null, (s) =>
        setHerdrInstalling((m) => ({ ...m, [profileId]: s })),
      );
      notify(
        `herdr 装好了：v${rep.version}（协议 ${rep.protocol}）来自 ${rep.source}，sha256 已核对`,
      );
      // 重新探一次，让「新建会话」里那个勾和看板的来源标注立刻变成可用
      aiSourceCache.current.delete(profileId);
      const info = await aiSourceProbe(profileId, user ?? null).catch(() => null);
      if (info) {
        aiSourceCache.current.set(profileId, info);
        rememberHerdrAvail(profileId, info);
        setAiSource((cur) => (cur === null ? info : cur));
      }
    } catch (e) {
      notify("安装 herdr 失败：" + String(e));
    } finally {
      setHerdrInstalling((m) => {
        const next = { ...m };
        delete next[profileId];
        return next;
      });
    }
  }

  /**
   * 拉着看当前会话的 Codex 日志，决定"要不要提醒你"。
   *
   * 这是通知的主判据（比"进程还在不在"准得多）：
   * - `needs-approval` / `waiting-user` → 在等你，必须提醒（红点 + 按设置闪任务栏/右下角）；
   * - 新一轮 `task_complete`（带 AI 最后一段话）→ 有结果了，提醒一次，并按轮去重；
   * - 其它（在跑、空闲）→ 不打扰。
   * 另外：如果你正开着那个会话的终端、窗口也在前台，就当你已经看到了，不提醒。
   */
  async function refreshSnapshot() {
    const cur = sessionsRef.current.find((s) => s.id === activeId);
    if (!cur) {
      setAiSnapshot(null);
      return;
    }
    try {
      const snap = await aiSessionSnapshot(
        cur.profileId ?? null,
        cur.user ?? null,
        cur.kind === "remote" ? null : cur.kind,
        null,
      );
      setAiSnapshot(snap);
      // 留给 `refreshBoard` 当 rollout 观测（手动刷新时先采快照、再刷看板）
      if (snap) snapshotRef.current = { session: cur, snapshot: snap, artifacts: [] };
      else snapshotRef.current = null;
      // 同样要"算到真正在跑 AI 的那个窗口头上"：当前窗口可能是普通 shell，
      // 而 AI 在同一个服务器的 tmux 窗口里跑（用户实测就是这么被带错的）。
      if (snap) considerSnapshot(pickAiSession(boardEnvOf(cur).server) ?? cur, snap);
    } catch {
      // 读不到日志很正常（比如这台机器还没跑过 Codex），静默即可
    }
  }

  /**
   * 找这一轮的产物：用"会话工作目录 + 这一轮的起止时间"去目录里翻。
   * AI 不会告诉你它写了哪些文件，但这两样一对上，答案基本就在那儿。
   */
  async function refreshArtifacts(cur: OpenSession, snap: AiSessionSnapshot): Promise<AiArtifact[]> {
    const startedAt = snap.lastTurnCompletedAt - Math.ceil(snap.lastTurnDurationMs / 1000) - 5;
    if (!snap.cwd || startedAt <= 0) {
      setAiArtifacts([]);
      return [];
    }
    try {
      const list = await aiTaskArtifacts(
        cur.profileId ?? null,
        cur.user ?? null,
        cur.kind === "remote" ? null : cur.kind,
        null,
        snap.cwd,
        startedAt,
      );
      // 只有"当前会话"的产物才铺到看板卡片上（后台会话只是用来提醒）
      if (cur.id === activeId) {
        setAiArtifacts(list);
        if (snapshotRef.current?.session.id === cur.id) {
          snapshotRef.current = { ...snapshotRef.current, artifacts: list };
        }
      }
      return list;
    } catch {
      setAiArtifacts([]);
      return [];
    }
  }

  /**
   * 这条快照应该算在**哪个窗口**头上（决定提醒挂谁的名字、以及"切过去"跳哪儿）。
   *
   * 为什么需要：快照是"**这台服务器上最新的那份 rollout**"，跟窗口无关 —— 同一台机器上
   * 开着 codexAAA 和「普通 shell 1」时，两个窗口读到的是同一份快照。以前谁先轮询到，
   * 提醒就挂谁的名字上，于是"在 tmux 里跑的 AI，提醒却让你去普通 shell 看"（用户实测报过）。
   *
   * 判定顺序：① 用看板里这台机器上**有 tmux 窗格**的 AI 任务，拿窗格名（codexAAA:0.0）
   * 去匹配会话的 tmux 名 → 最准；② 匹配不上就优先 tmux 会话（AI 基本都跑在 tmux 里）；
   * ③ 再不行才退回第一个候选。
   */
  function pickAiSession(server: string): OpenSession | null {
    const cands = sessionsRef.current.filter((s) => boardEnvOf(s).server === server);
    if (cands.length <= 1) return cands[0] ?? null;
    const pane = boardTasksRef.current.find((t) => t.server === server && t.pane)?.pane ?? "";
    const sessName = pane.split(":")[0];
    if (sessName) {
      const hit = cands.find((s) => (s.tmuxName ?? "") === sessName);
      if (hit) return hit;
    }
    const tmuxOnes = cands.filter((s) => s.tmuxName);
    return tmuxOnes[0] ?? cands[0];
  }

  /**
   * 顺带看一眼**其它开着的会话**（只在手动刷新时跑一次）。
   * 这样你切到 ADB / CMD / 别的服务器上干活时，一样能收到"那个 AI 已经干完了"的提示。
   */
  async function refreshOtherSnapshots() {
    // 同一台服务器只探一次（快照本来就是"那台机器上最新的那一份"），
    // 探完把结果算到"真正在跑 AI 的那个窗口"头上。
    const done = new Set<string>();
    for (const s of sessionsRef.current) {
      if (s.id === activeId) continue;
      if (s.kind === "cmd" || s.kind === "serial" || s.kind === "adb") continue;
      const key = s.profileId ?? s.kind;
      if (done.has(key)) continue;
      done.add(key);
      try {
        const snap = await aiSessionSnapshot(
          s.profileId ?? null,
          s.user ?? null,
          s.kind === "remote" ? null : s.kind,
          null,
        );
        if (snap) await considerSnapshot(pickAiSession(boardEnvOf(s).server) ?? s, snap);
      } catch {
        // 单个会话读不到（没跑过 Codex / 网络抖动）不影响其它
      }
    }
  }

  /**
   * 手动刷新 AI 面板：**只有用户点「刷新」时才跑这一遍**。
   *
   * 用户明确要求「把这个功能去掉算了，不探测了，影响电脑性能」，最后确认的口径是
   * 「保留手动刷新，按钮就叫做刷新」。所以原来挂在 App 里的四个常驻定时器
   * （8s 的 ai_probe、10s + 30s 的会话快照、20s 的看板扫描）全部删掉了 ——
   * 以前面板关着也每个周期起子进程（本机枚举进程 / 远端 ps、tmux / herdr agent list），
   * 那正是用户感觉"影响电脑性能"的来源。
   *
   * 顺序：先刷当前会话的 rollout 快照（`refreshBoard` 会把它当 rollouts 来源），
   * 再刷看板；状态来源 / 服务状态 / 时间线互不依赖，并行跑，失败互不影响。
   * 这里不做任何自动触发（面板打开、启动应用、切会话都不会自动走到这里）。
   *
   * ⚠️ **红点与手动刷新彻底解耦**（§10.6 + 用户 2026-10-20 的口径）：
   * 这条路径只更新卡片/看板，**不得**调用任何"设置红点"的代码 —— 手动刷新得到的是
   * 一次性快照，把它变成红点就是伪信号（用户原话："手动刷新出现红点这种宁可不要"）。
   * 红点由本机日志信号（`applyAiLogSignal`）独立驱动。
   *
   * ⚠️ 以后真要加新的探测命令：后端一律走 `core/proc.rs` 的 `hidden_command`
   * （CREATE_NO_WINDOW），别再改回裸 `Command::new` —— 那会反复弹控制台黑框。
   */
  async function refreshAiPanel() {
    if (aiRefreshBusy.current) return;
    aiRefreshBusy.current = true;
    setAiRefreshing(true);
    try {
      await Promise.all([
        // true = 用户这次点刷新就**强制重探**，不吃"同一进程内只探一次"的缓存
        refreshAiSource(true),
        refreshHerdrServer(),
        loadTimeline(),
      ]);
      await refreshSnapshot();
      await refreshOtherSnapshots();
      await refreshBoard();
    } finally {
      aiRefreshBusy.current = false;
      setAiRefreshing(false);
    }
  }

  /** 打开一个产物：远端会话走应用内的 MD / HTML 预览，本地或其它类型用资源管理器 */
  async function openArtifact(session: OpenSession, cwd: string, a: AiArtifact) {
    const base = cwd.replace(/[\\/]+$/, "");
    const isAbs = a.path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(a.path);
    const abs = isAbs ? a.path : `${base}/${a.path}`;
    const kind = fileKind(a.name);
    if (session.profileId) {
      try {
        const b64 = await fsRead(session.profileId, abs, 1024 * 1024, session.user ?? null);
        if (b64) {
          setSessions((prev) =>
            prev.map((s) => {
              if (s.id !== session.id) return s;
              const exists = s.openFiles.some((f) => f.path === abs);
              const openFiles = exists
                ? s.openFiles
                : [...s.openFiles, { name: a.name, path: abs, kind, b64 }];
              return { ...s, openFiles, activeTab: a.name };
            }),
          );
          return;
        }
      } catch (e) {
        notify("读取产物失败：" + String(e));
        return;
      }
    }
    try {
      await openInExplorer(abs);
      notify("已用资源管理器打开：" + abs);
    } catch (e) {
      notify("打开产物失败：" + String(e));
    }
  }

  async function considerSnapshot(cur: OpenSession, snap: AiSessionSnapshot) {
    const needsMe = snap.state === "needs-approval" || snap.state === "waiting-user";
    const hasMessage = snap.lastTurnCompletedAt > 0 && snap.lastMessage.trim().length > 0;
    // ⚠️ 这里必须按"**这一轮 AI 任务**"去重，而不是按"我们这个标签页"。
    //
    // 踩过的坑：同一台服务器上开着两个标签（比如 lz · codexAAA 和 lz · 普通 shell 1）时，
    // 两个标签拿到的是**同一份** rollout 快照（快照是"那台机器上最新的 rollout"，跟标签无关），
    // 而"处理过没有"如果按标签记，两个标签就会各记一条 —— 时间线上出现两条一模一样的记录
    // （用户实测截图证实：两条只差 sessionTitle 一个字段）。
    // 同一个毛病还会让"等你批准"在以前每 10 秒重复提醒一次（那是定时器时代红点数字自己往上涨的老问题）。
    const server = boardEnvOf(cur).server;
    const turnKey = `${snap.sessionId || server}|${snap.lastTurnCompletedAt}|${snap.lastMessage.length}`;
    // 第一次拿到**这个会话**的快照时只记下来，不提醒（否则一开应用就会把上一轮翻出来弹）
    if (!aiSeeded.current[cur.id]) {
      aiSeeded.current[cur.id] = true;
      aiTurnKey.current[cur.id] = turnKey;
      aiHandledTurns.current.add(turnKey);
      return;
    }
    // "新一轮跑完"只认全局没见过的那一轮
    const freshTurn = hasMessage && !aiHandledTurns.current.has(turnKey);
    // "在等你"同样要按"同一件事"去重，否则每次轮询都会再提醒一遍
    const askKey = needsMe ? `ask|${server}|${snap.state}|${snap.lastAction}` : "";
    const freshAsk = needsMe && askKey !== "" && !aiHandledTurns.current.has(askKey);
    if (!freshAsk && !freshTurn) return;

    // 人就在看这个终端（窗口在前台 + 正打开它）→ 一般不打扰；
    // 但"这一轮产出了文件"是另一回事：那是要你去看的东西，照样提醒。
    const watching =
      document.hasFocus() && cur.id === activeId && cur.activeTab === "terminal" && aiPanelOpen;
    if (freshTurn) {
      aiTurnKey.current[cur.id] = turnKey;
      aiHandledTurns.current.add(turnKey);
    }
    if (freshAsk) aiHandledTurns.current.add(askKey);

    if (freshTurn) {
      // 有新消息时顺手把"这一轮产出的文件"翻出来，提示里带上数量（列表在卡片下面）
      const board = boardEnvOf(cur);
      void refreshArtifacts(cur, snap).then((list) => {
        // G-01：不管最后提不提醒，都先把"这一轮跑完了"记进**落盘**的时间线。
        // 这样"我离开电脑再回来"才能回看昨晚跑了什么 —— 看板本身只有当前这一轮。
        void aiTimelineAdd({
          id: "",
          env: board.env,
          server: board.server,
          sessionTitle: cur.title,
          cwd: snap.cwd ?? "",
          tool: "codex",
          completedAt: snap.lastTurnCompletedAt,
          durationMs: snap.lastTurnDurationMs,
          message: snap.lastMessage,
          tokensTotal: snap.usage?.total ?? 0,
          artifacts: list.map((a) => a.name),
        })
          .then((isNew) => {
            if (isNew) void loadTimeline();
          })
          .catch(() => {});

        // ---------- 「什么时候才提醒我」 ----------
        //
        // 用户的原话：每跑一个小任务都弹一条很烦，他要的是——
        //   ① 产出了 HTML / Markdown 文档（那才是要他去看的成果）
        //   ② 这一轮 AI 真的跑完了
        //   ③ AI 在等他做选择题（批准 / 回话）
        // 前两条各有一个开关（默认只留"文档"那条开着），第三条见下面 freshAsk 分支。
        const cfgNow = settingsRef.current;
        const docs = list.filter((a) => isDocName(a.name));
        const interesting = cfgNow.aiNotifyAllArtifacts ? list : docs;
        const wantDocs = cfgNow.aiNotifyDocs && interesting.length > 0;
        const wantComplete = cfgNow.aiNotifyComplete;
        if (!wantDocs && !wantComplete) return;
        // 人就在看这个终端、而且这一轮又没产出要看的文档 → 不打扰
        if (watching && !wantDocs) return;
        if (wantDocs) {
          const names = interesting
            .slice(0, 3)
            .map((a) => a.name)
            .join("、");
          raiseAiAttention(
            `「${cur.title}」产出了 ${interesting.length} 个文档：${names}${
              interesting.length > 3 ? " 等" : ""
            }（卡片下面可点开）`,
          );
          return;
        }
        raiseAiAttention(
          `「${cur.title}」这一轮跑完了：${aiShorten(snap.lastMessage, 60)}`,
        );
      });
      return;
    }
    // ③ 「AI 在等你做选择题」—— 这条默认开着，而且**不看你是否正在看**
    //（等你批准 / 等你回话是必须打断的；用户明确要这一类提醒）
    if (!settingsRef.current.aiNotifyNeedsYou) return;
    if (watching && !needsMe) return;
    raiseAiAttention(
      snap.state === "needs-approval"
        ? `「${cur.title}」等你批准：${snap.lastAction}`
        : `「${cur.title}」等你回话`,
    );
  }

  /**
   * 打扰用户一下：进面板里的通知列表 + 按设置闪任务栏。
   *
   * ⚠️ **不在这里动红点**（§10.6）：红点只认「需要你 / 跑完停下」两条规则，
   * 而且只由自动来源（`applyAiLogSignal`：本机日志 / herdr 轮询）写入；
   * 这里只负责"响一声"（面板通知 + 按设置闪任务栏）。
   */
  function raiseAiAttention(text: string) {
    pushAiNotice(text);
    if (settingsRef.current.aiNotifyTaskbar && !document.hasFocus()) {
      // 只在窗口不在前台时闪（前台闪没有意义）；回到窗口时下面那个 effect 会取消
      void getCurrentWindow()
        .requestUserAttention(UserAttentionType.Critical)
        .catch(() => {});
    }
  }

  // ---------- AI 探测：没有任何定时器，只有手动「刷新」 ----------
  //
  // 用户明确要求「把这个功能去掉算了，不探测了，影响电脑性能」，最后确认的口径是
  // 「保留手动刷新，按钮就叫做刷新」。这里以前挂着四个常驻定时器：
  //   · 8s 的 `refreshAi`（ai_probe：本机/远端有没有 AI 进程在跑）
  //   · 10s 的 `refreshSnapshot` + 30s 的 `refreshOtherSnapshots`（读 rollout / 日志）
  //   · 20s 的 `refreshBoard`（远端 ps、tmux + 本机进程表枚举）
  // 它们每一轮都会起子进程，而且面板关着也照跑 —— 那正是"影响电脑性能"的来源。
  //
  // 现在全部删掉：AI 面板/看板只在用户点标题栏「刷新」时走一次 `refreshAiPanel`。
  // 启动应用、打开面板都不会自动探测；切会话时那次 herdr 服务状态探测是状态条
  // 要用的另一条链路（见下面切 herdr 会话的 effect），不属于看板轮询。
  //
  // **保留的自动链路只有两条**，而且都在 Rust 侧（前端一个定时器都没有）：
  //   ① 本机 codex rollout 日志：`core/ai_log_watch.rs`，2.5 秒 stat 一次、只读文件、
  //      不起子进程 → `zeeai://ai-log`（红点 + 卡片增量）；
  //   ② herdr 窗格状态：`core/ai_herdr_dots.rs`，只对勾了 herdr 的服务器、60 秒一轮
  //      查 `herdr agent list`（用户 2026-10-20 批准），失败静默 →
  //      `zeeai://ai-log`（红点）+ `zeeai://herdr-agents`（卡片全量快照）。
  // 两条都**不会多起探测**：用的就是上面那几个既有命令的结果，前端只负责画。
  // ⚠️ 不要在这里加回任何 setInterval / 启动时自动探测；要加探测先问用户（§10.8）。

  // 打开 AI 面板 = 你已经看到了 → 清掉「跑完停下」那几条未读（§10.6 规则②）。
  // ⚠️ 只清这一种：**「需要你」的红点亮到你处理为止**，打开面板不算处理
  // （那条由后端的 `resolved` 信号清，这里碰它就会变成"点开就消失"）。
  // 清的是整个 `aiPendingFinish`，所以本机日志和 herdr 两条来源的 `finished` **一起清** ——
  // 对用户来说"面板打开了"就是看过了，不需要分来源记两套未读。
  useEffect(() => {
    aiPanelOpenRef.current = aiPanelOpen;
    if (aiPanelOpen) setAiPendingFinish([]);
  }, [aiPanelOpen, activeId]);

  /**
   * 「新建会话」对话框里**只要选中了某台服务器**就探一下她那台机器有没有 herdr。
   *
   * 为什么用 effect 而不是只在"打开对话框"时探：用户会**在对话框里切服务器**，
   * 而切换那条路以前没触发探测 —— 结果那一格永远停在"探测中"、复选框永远点不动（实测 bug）。
   * 按 profileId 缓存，所以切来切去也只探一次。
   */
  useEffect(() => {
    const pid = newDialog?.profileId;
    if (!pid) return;
    if (herdrAvail[pid] !== undefined) return; // 已经有结果了（null 也算结果）
    void probeHerdrFor(pid, newDialog?.user);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newDialog?.profileId]);

  // 回到窗口时把任务栏闪烁停掉（闪的目的就是叫你回来）
  useEffect(() => {
    const onFocus = () => {
      void getCurrentWindow().requestUserAttention(null).catch(() => {});
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  /** 在当前会话的终端里启动 AI（就是把命令敲进去，你能看到它跑） */
  function aiStartTool(tool: string, isRun: boolean) {
    const cur = sessionsRef.current.find((s) => s.id === activeId);
    if (!cur) {
      notify("先打开一个会话");
      return;
    }
    // 注意：Windows 的 PowerShell / CMD 需要回车 \r 才会执行命令，
    // 发 \n 只会得到续行提示符（Linux 下 \r 一样能提交）。统一用 \r。
    void sessionWrite(cur.id, bytesToB64(new TextEncoder().encode(`${tool}\r`)));
    aiWasRunning.current = true;
    if (isRun) {
      // 记一笔"App 自己启动的"——看板里这一层最准（开始时间/跑完与否都由 App 判）
      const { env, server } = boardEnvOf(cur);
      void aiTaskNoteStart(env, server, tool.trim(), tool.trim())
        .then(() => {
          void refreshBoard();
        })
        .catch(() => {});
    }
    // 启动只在状态栏留一行 —— 以前这里会弹一条通知，等于"每启动一次就打扰一次"
    notify(`已在「${cur.title}」里启动 ${tool}（跑完/需要你时我才会提醒）`);
  }

  /**
   * 干掉 WebView2 / Edge **自带的**右键菜单。
   * 用户看到的那些"刷新""从左到右书写""从右到左书写""语音"全都是浏览器菜单，
   * 不是我们做的 —— 对一个终端工具来说纯属噪音。
   * 我们自己的菜单是自己画的（组件里 onContextMenu → preventDefault → 渲染自定义菜单），
   * React 的事件委托挂在 #root 上，会比这里的 document 监听先执行，所以不受影响。
   */
  useEffect(() => {
    const blockNativeMenu = (e: MouseEvent) => {
      e.preventDefault();
    };
    document.addEventListener("contextmenu", blockNativeMenu);
    return () => document.removeEventListener("contextmenu", blockNativeMenu);
  }, []);

  // 命令面板：Ctrl+Shift+P 打开，输入过滤，回车执行
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && (e.key === "P" || e.key === "p" || e.code === "KeyP")) {
        e.preventDefault();
        setPaletteQuery("");
        setPaletteOpen((v) => !v);
      } else if (e.key === "Escape") {
        setPaletteOpen(false);
      } else if (e.ctrlKey && !e.altKey) {
        // 字体缩放：Ctrl + ＋ / － / 0（和浏览器、VS Code 一个习惯）
        // 这几个组合键在 shell / tmux 里都没有含义，抢过来不会影响终端输入
        const k = e.key;
        if (k === "+" || k === "=" || e.code === "NumpadAdd") {
          e.preventDefault();
          bumpFont(1);
        } else if (k === "-" || k === "_" || e.code === "NumpadSubtract") {
          e.preventDefault();
          bumpFont(-1);
        } else if (k === "0" || e.code === "Numpad0") {
          e.preventDefault();
          applyFontSize(13);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /** 命令面板里能搜到的所有命令：菜单里的每一项 + 几个常用操作 */
  function allCommands(): { label: string; group: string; run: () => void }[] {
    const out: { label: string; group: string; run: () => void }[] = [];
    for (const menu of buildMenus()) {
      for (const item of menu.items) {
        if (!item.sep && item.label && item.action) {
          out.push({ label: item.label, group: menu.label, run: item.action });
        }
      }
    }
    out.push(
      { label: "打开设置", group: "首选项", run: () => setShowSettings(true) },
      { label: "终端配色与关键字高亮", group: "首选项", run: () => setShowTermTheme(true) },
      { label: "服务器管理", group: "首选项", run: () => setShowServers(true) },
      {
        label: "文件面板：同步到终端目录",
        group: "远程文件",
        run: () => {
          if (fileProfileId) void syncFsToTerminal(fileProfileId, activeTmuxName, activeSession?.cwd);
        },
      },
      {
        label: "文件面板：上传文件到当前目录",
        group: "远程文件",
        run: () => {
          if (fileProfileId) void uploadToRemote(fileProfileId);
        },
      },
      { label: "Git：打开本地仓库", group: "Git", run: () => void openGitWorkspace() },
      { label: "Git：新建仓库（git init）", group: "Git", run: () => setGitInitDialog({ path: "" }) },
      { label: "关闭全部本地终端", group: "终端", run: () => void closeSessions(localTerminals, "本地终端") },
      { label: "关闭全部会话", group: "终端", run: () => void closeSessions(sessions, "会话") },
      { label: "关于 ZeeAI Term", group: "帮助", run: () => setShowAbout(true) },
      {
        label: "检查更新",
        group: "帮助",
        run: () => {
          setShowAbout(true);
          void checkForUpdates();
        },
      },
    );
    return out;
  }

  /**
   * 兜底：只要还有会话，主区域就不该是空的。
   * 关闭标签、批量关会话、会话异常退出……任何路径让 activeId 失效时，
   * 这里都会把它接到最后一个会话上（以前会留下一片黑）。
   */
  useEffect(() => {
    if (sessions.length === 0) {
      if (activeId !== null) setActiveId(null);
      return;
    }
    if (!activeId || !sessions.some((s) => s.id === activeId)) {
      setActiveId(sessions[sessions.length - 1].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, activeId]);

  // ---------- 工作区恢复：退出前存快照，下次打开时把会话重新拉起来 ----------
  const restoredRef = useRef(false);
  // 恢复流程结束前不许写快照，否则启动 1 秒内就把"待恢复的快照"覆盖成空的
  const [restoreDone, setRestoreDone] = useState(false);
  const [workspaceHint, setWorkspaceHint] = useState<string | null>(null);

  useEffect(() => {
    if (!settingsReady || restoredRef.current) return;
    restoredRef.current = true;
    if (!settings.restoreWorkspace) {
      setRestoreDone(true);
      return;
    }
    void (async () => {
      let raw: string | null = null;
      try {
        raw = await workspaceLoad();
      } catch {
        setRestoreDone(true);
        return;
      }
      if (!raw) {
        setRestoreDone(true);
        return;
      }
      let data: SavedWorkspace;
      try {
        data = JSON.parse(raw) as SavedWorkspace;
      } catch {
        setRestoreDone(true);
        return;
      }
      const list = profilesRef.current;
      // 上限：快照里如果攒了很多（比如演示反复跑），一次全开会把服务器的
      // sshd 打满（MaxStartups）而且标签栏会炸，所以只恢复最近的 8 个。
      const MAX_RESTORE = 8;
      const allSaved = data.sessions ?? [];
      const saved = allSaved.slice(-MAX_RESTORE);
      if (saved.length === 0) {
        setRestoreDone(true);
        return;
      }
      setWorkspaceHint(`正在恢复上次的 ${saved.length} 个会话…`);
      const ids: string[] = [];
      for (let i = 0; i < saved.length; i++) {
        const s = saved[i];
        // 一条一条来，中间留一点间隔，避免瞬间并发一堆 SSH 连接
        if (i > 0) await new Promise((r) => setTimeout(r, 250));
        try {
          if (s.kind === "remote" && s.profileId) {
            const p = list.find((x) => x.id === s.profileId);
            if (!p) continue;
            // herdr 窗格会话：**必须原样恢复成 herdr**（同一个窗格、同一种方式）。
            // 不这么做的话它会走 tmux/普通 shell 那条路 —— 用户看到的是一个"裸 shell"，
            // 现象就是"重启之后根本不在 herdr 里面"（实测踩过）。
            const id = s.herdrPane
              ? await openSshSession(
                  p,
                  "name",
                  s.herdrPane,
                  s.user ?? null,
                  s.title ?? null,
                  null,
                  s.herdrMode === "control" ? "herdr-control" : "herdr-pane",
                  s.herdrPane,
                  s.herdrMode ?? "observe",
                )
              : await openSshSession(
                  p,
                  s.tmuxMode ?? "default",
                  s.tmuxName ?? null,
                  s.user ?? null,
                  s.title ?? null,
                );
            ids.push(id);
            if (s.herdrPane && s.herdrMode !== "control") {
              await ensureHerdrInput(id, p.id, s.user ?? null, s.herdrPane);
            }
          } else if (s.kind === "powershell" || s.kind === "cmd" || s.kind === "wsl") {
            const id = await openLocalSession(s.kind, undefined, s.cwd, s.title);
            ids.push(id);
          } else if (s.kind === "serial") {
            const p = list.find((x) => x.type === "serial" && x.name === s.title);
            if (!p) continue;
            const id = await openSerialSession(p);
            ids.push(id);
          }
        } catch {
          /* 单个会话恢复失败不影响其它 */
        }
      }
      if (ids.length > 0) {
        const idx = Math.min(Math.max(data.activeIndex ?? 0, 0), ids.length - 1);
        setActiveId(ids[idx]);
      }
      setWorkspaceHint(null);
      setRestoreDone(true);
      if (ids.length > 0) {
        notify(
          allSaved.length > MAX_RESTORE
            ? `已恢复最近 ${ids.length} 个会话（快照里还有 ${allSaved.length - MAX_RESTORE} 个更早的没开）`
            : `已恢复上次的 ${ids.length} 个会话`,
        );
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsReady]);

  // 会话有变化就把快照写下去（防抖，不写文件内容）
  useEffect(() => {
    if (!settingsReady || !settings.restoreWorkspace || !restoreDone) return;
    const snapshot: SavedWorkspace = {
      version: 1,
      savedAt: Date.now(),
      activeIndex: Math.max(
        0,
        sessions.findIndex((s) => s.id === activeId),
      ),
      sessions: sessions.map((s) => ({
        kind: s.kind,
        title: s.title,
        profileId: s.profileId,
        user: s.user,
        tmuxName: s.tmuxName,
        tmuxMode: s.tmuxMode,
        herdrPane: s.herdrPane,
        herdrMode: s.herdrMode,
        cwd: s.cwd,
      })),
    };
    const t = window.setTimeout(() => {
      void workspaceSave(JSON.stringify(snapshot)).catch(() => {
        /* 存不下就算了，不影响使用 */
      });
    }, 700);
    return () => window.clearTimeout(t);
  }, [sessions, activeId, settingsReady, settings.restoreWorkspace, restoreDone]);

  // 文件传输进度：后端用 emit 推过来，这里维护右下角那个进度面板
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void listen<TransferEvent>("zeeai://transfer", (ev) => {
      const e = ev.payload;
      if (e.kind === "allDone") {
        // 整批结束后留一会儿再收起来，让用户看得到结果
        window.setTimeout(() => {
          setTransfers((cur) => cur.filter((t) => !t.id.startsWith(`${e.task}:`)));
        }, 3500);
        return;
      }
      const key = `${e.task}:${e.name}`;
      setTransfers((prev) => {
        const idx = prev.findIndex((t) => t.id === key);
        const next = [...prev];
        if (e.kind === "start") {
          if (idx < 0) {
            next.push({
              id: key,
              name: e.name,
              done: 0,
              total: e.total,
              status: "running",
            });
          }
          return next;
        }
        if (idx < 0) {
          next.push({ id: key, name: e.name, done: 0, total: 0, status: "running" });
        }
        const i = next.findIndex((t) => t.id === key);
        if (e.kind === "progress") {
          next[i] = { ...next[i], done: e.done, total: e.total, status: "running" };
        } else if (e.kind === "fileDone") {
          next[i] = {
            ...next[i],
            done: e.bytes || next[i].done,
            total: next[i].total || e.bytes,
            status: "done",
          };
        } else if (e.kind === "fileFailed") {
          next[i] = { ...next[i], status: "failed", message: e.message };
        }
        return next;
      });
    }).then((f) => {
      unlisten = f;
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  // 让 Windows 原生的标题栏（最上面那条）也跟着主题走。
  // 不设置的话，即使应用里是深色，标题栏还是系统浅色的白条。
  useEffect(() => {
    const kind = themeKind(settings.theme);
    void getCurrentWindow()
      .setTheme(kind)
      .catch(() => {
        /* 某些系统上不支持就忽略，不影响主界面 */
      });
  }, [settings.theme]);

  useEffect(() => {
    void (async () => {
      try {
        applyHistory(await historyList());
      } catch {
        /* 历史读取失败不影响主流程 */
      }
    })();
  }, []);

  useEffect(() => {
    // 只探测版本（不会启动 adb server，也就不会弹防火墙授权框）；
    // 设备列表要等用户主动点「刷新设备」——那一步才会启动 adb server。
    if (module === "adb") {
      void (async () => {
        try {
          setAdbVer(await adbVersion());
        } catch {
          setAdbVer("");
        }
      })();
    }
    if (module === "serial") void refreshSerial();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [module]);

  // 自动化演示（ZEEAI_AUTODEMO=1）：连接 → 切到文件 → 打开 md/html 预览，
  // 供无人值守截图验证。仅在演示模式下触发，正常使用不会走到这里。
  const demoRef = useRef({ profiles, started: false });
  demoRef.current.profiles = profiles;
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void listen("zeeai://autodemo", () => {
      void (async () => {
        if (demoRef.current.started) return;
        demoRef.current.started = true;
        const list = demoRef.current.profiles;
        const profile = list.find((p) => p.ssh) ?? list[0];
        if (!profile) return;
        const id = await openSshSession(profile);
        await new Promise((r) => setTimeout(r, 15000));
        setSideTab("files");
        // 演示「文件面板跟随终端目录」：先真的在终端里 cd，再点刷新
        await sessionWrite(id, bytesToB64(new TextEncoder().encode("cd /tmp/zeeai-demo\n")));
        await new Promise((r) => setTimeout(r, 3000));
        const tmux = sessionsRef.current.find((s) => s.id === id)?.tmuxName;
        await refreshFs(profile.id, tmux, undefined);
        await new Promise((r) => setTimeout(r, 8000));
        await openRemoteFile(profile.id, "README-demo.md", id);
        await new Promise((r) => setTimeout(r, 10000));
        await openRemoteFile(profile.id, "demo.html", id);
        await new Promise((r) => setTimeout(r, 10000));
        // 顺便把 ADB 面板、菜单、设置界面都展示一遍，便于无人值守截图验证
        setModule("adb");
        await new Promise((r) => setTimeout(r, 12000));
        setModule("serial");
        await new Promise((r) => setTimeout(r, 14000));
        // 注意：演示**不再自动打开串口终端**。
        // 用户机器上的串口（比如 COM5）可能正被别的项目占用，自动化脚本去打开它会把人家的程序踢掉。
        // 串口面板本身的截图仍然保留（列表是只读枚举，不占用端口）。
        // Git 面板 + Git 工作空间（在仓库目录起本地终端）
        setModule("git");
        const repo = "D:\\AI\\ZeeAI_term";
        setGitPath(repo);
        setGitLoading(true);
        try {
          setGitState(await gitStatus(repo));
        } catch {
          /* 演示用，读不到就算了 */
        }
        setGitLoading(false);
        const demoWs: ConnectionProfile = {
          id: uid(),
          type: "local",
          name: "ZeeAI_term · git",
          group: "Git 工作空间",
          local: { shell: settings.defaultShell, cwd: repo },
        };
        try {
          // 演示重复跑的时候别把同一条工作空间塞进去好几次
          const cur = await listProfiles();
          if (!cur.some((p) => p.type === "local" && p.local?.cwd === repo)) {
            await saveProfile(demoWs);
            await refresh();
          }
        } catch {
          /* 演示用 */
        }
        await openLocalSession(settings.defaultShell, undefined, repo, "ZeeAI_term · git");
        await new Promise((r) => setTimeout(r, 14000));
        // 本地终端模块：开几个会话，验证侧栏能列出「已打开的会话」
        setModule("powershell");
        await openLocalSession("powershell", undefined, repo);
        await new Promise((r) => setTimeout(r, 8000));
        setModule("cmd");
        await openLocalSession("cmd", undefined, repo);
        await new Promise((r) => setTimeout(r, 8000));
        setModule("powershell");
        await new Promise((r) => setTimeout(r, 10000));
        // 终端日志端到端验证：开一个终端 -> 开始记录 -> 打点东西 -> 停止
        {
          const logSid = await openLocalSession("powershell", undefined, repo, "日志验证");
          await new Promise((r) => setTimeout(r, 3000));
          await startSessionLog({ id: logSid, title: "日志验证" });
          await new Promise((r) => setTimeout(r, 1000));
          await sessionWrite(
            logSid,
            bytesToB64(
              new TextEncoder().encode("echo ZEEAI-LOG-CHECK-12345; echo 第二行中文\r"),
            ),
          );
          await new Promise((r) => setTimeout(r, 3000));
          await stopSessionLog({ id: logSid });
          await new Promise((r) => setTimeout(r, 2000));
        }
        // 验证「关掉当前标签后应自动切到相邻会话」：关掉第一个标签再截图
        const firstTab = sessionsRef.current[0];
        if (firstTab) {
          setActiveId(firstTab.id);
          await new Promise((r) => setTimeout(r, 2000));
          await closeSession(firstTab.id);
        }
        await new Promise((r) => setTimeout(r, 8000));
        // 分屏演示：左右两分屏（左边 SSH，右边本地 PowerShell）
        setPaneLayout("v2");
        await new Promise((r) => setTimeout(r, 10000));
        setPaneLayout("single");
        await new Promise((r) => setTimeout(r, 4000));
        // AI Agent 面板
        setAiPanelOpen(true);
        await new Promise((r) => setTimeout(r, 14000));
        // 命令面板（Ctrl+Shift+P）
        setPaletteQuery("");
        setPaletteOpen(true);
        await new Promise((r) => setTimeout(r, 12000));
        setPaletteOpen(false);
        setModule("remote");
        setSideTab("sessions");
        // 演示文件传输进度条：把一个十几 MB 的文件传上去，进度能看清楚
        try {
          const bigLocal = "D:\\AI\\ZeeAI_term\\src-tauri\\target\\release\\zeeai-terminal.exe";
          await fsUpload(profile.id, [bigLocal], "/tmp/zeeai-demo", null, uid());
        } catch {
          /* 演示用：传不上去也不影响后面流程 */
        }
        await new Promise((r) => setTimeout(r, 12000));
        openNewSessionDialog(profile);
        await new Promise((r) => setTimeout(r, 16000));
        setNewDialog(null);
        setShowServers(true);
        await new Promise((r) => setTimeout(r, 16000));
        setShowServers(false);
        setShowSettings(true);
        await new Promise((r) => setTimeout(r, 18000));
        setShowSettings(false);
        await new Promise((r) => setTimeout(r, 1500));
        // 验证：终端右键应该弹出我们自己的菜单（复制/粘贴/全选/清屏），
        // 而不是 WebView2 自带的"刷新 / 从左到右书写 / 语音"
        const termHost = document.querySelector(".terminal-host") as HTMLElement | null;
        termHost?.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: 600,
            clientY: 420,
          }),
        );
        await new Promise((r) => setTimeout(r, 15000));
        const backdrop = document.querySelector(".ctx-backdrop") as HTMLElement | null;
        backdrop?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        // 验证：错误提示只出现在底部状态栏（红底 + 闪一下），不再有中央浮层
        notify("测试：这是一条错误提示 —— 应该出现在底部状态栏并闪红，而不是悬浮在窗口中间");
        await new Promise((r) => setTimeout(r, 15000));
      })();
    }).then((f) => {
      unlisten = f;
    });
    return () => {
      if (unlisten) unlisten();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeSession = sessions.find((s) => s.id === activeId) ?? null;
  // 拖拽回调只订阅一次，所以"当前会话"要放进 ref（见下面的 onDragDropEvent）
  activeSessionRef.current = activeSession;
  /**
   * 终端画布的底色 —— 跟**终端配色**（那个 16 色板）走，而不是界面主题。
   *
   * 为什么要有：`.pane` / `.pane-cell` 以前写死深色，于是用户把"终端配色"选成浅色时，
   * 终端四周那圈 padding 仍然是黑的，看着像"配色没生效"。分屏时每个格子用自己的会话配色。
   */
  const termBgOf = (s: OpenSession | null | undefined) =>
    s
      ? termPaletteFor(
          settings,
          profiles.find((p) => p.id === s.profileId),
          kindOfSession(s.kind),
        ).background
      : undefined;
  // 看板只摆两个区：**需要你** + **运行中**（§10.2）。
  // 「最近完成」「空闲」各折成一行，点开才渲染明细；承载健康只在异常时出现。
  //
  // `boardShown` 是"渲染用的那一份"：在 `boardInstances`（刷新 / 日志 / herdr 给的状态）之上，
  // 由 `withOutputActivity` 补一层**推断**（该会话最近 5 秒还有终端输出 → 运行中）。
  // 为什么单独一份、不改 `boardInstances`：推断必须能随时**消失**（输出一停就回落），
  // 而第一手状态永远是原值；`aiUiNow` 每秒变一次，这里就每秒重算一次 —— 纯内存计算。
  const boardShown = withOutputActivity(boardInstances, {
    sessions,
    // 后端 `where` 第一段用的是服务器显示名；profileId → 名字的对应关系只有前端知道
    profileName: (id) => profiles.find((p) => p.id === id)?.name,
    nowMs: aiUiNow,
  });
  const boardNeedsYou = boardShown.filter((i) => i.state === "needs-you");
  const boardWorking = boardShown.filter((i) => i.state === "working");
  const boardFinished = boardShown.filter((i) => i.state === "finished");
  const boardIdle = boardShown.filter((i) => i.state === "idle" || i.state === "unknown");
  /** 卡片渲染用的扁平行（保序：后端的排序就是需要你 → 运行中 → …） */
  const taskOfInstance = new Map(boardTasks.map((t) => [t.id, t]));
  /**
   * 面板上要显示的"没在用"和"可清理"（只读计算，不产生任何副作用）。
   *
   * 放在这里（而不是下面用它的地方）：承载健康那一行、管理面板、调试输出都要用同一份，
   * 早算一次就够了 —— 各算各的容易让界面自相矛盾。
   */
  const herdrOrphanList = herdrOrphans();
  const herdrCleanList = herdrCleanable();

  /**
   * 看板卡片（两个区共用）。
   *
   * 样式沿用现有的 `ai-task` 那一套，这一轮先把**数据来源**换成统一模型 ——
   * 状态、要不要上板、来源徽标全部来自后端 `AiInstance`，前端不再自己判
   * （口径 docs/design-ai-board-v2.md §10）。
   */
  function boardCard(i: AiInstance) {
    const t = taskOfInstance.get(i.id);
    // 后端刚给过这张卡，理论上一定找得到；万一没有就整张不画（**不编**一张假的）
    if (!t) return null;
    const active = isActiveInstance(i);
    const attention = i.state === "needs-you";
    const project = dirBase(t.cwd || "");
    // 这张卡对着的**终端标签**（看板 ↔ 标签栏的对应关系）。
    // 分开两个概念：
    // - `linkedControl`：这个窗格已经**可写**地开着 → 按钮变成"切到标签"，
    //   点了就走过去，而不是再开一条（再开一条会跟它抢输入和尺寸）；
    // - `linkedAny`：只读观察窗也算"已经开在标签里"，用来告诉用户卡和标签的对应。
    const same = (s: OpenSession) =>
      s.profileId === t.herdrProfileId && s.herdrPane === t.herdrPane;
    const linkedControl = t.herdrPane
      ? sessions.find((s) => same(s) && s.herdrMode === "control")
      : undefined;
    const linkedAny = t.herdrPane ? linkedControl ?? sessions.find(same) : undefined;
    // 会话日志快照只有"当前会话"这一份 → 只往它自己那张卡上挂
    const withSnap =
      !!aiSnapshot &&
      (i.state === "working" || attention) &&
      (aiSnapshot.cwd ? aiSnapshot.cwd === t.cwd : false);
    const usage = withSnap ? aiSnapshot?.usage : undefined;
    const pct =
      usage && usage.contextWindow > 0
        ? Math.min(100, Math.round((usage.total / usage.contextWindow) * 100))
        : 0;
    return (
      <div
        className={"ai-task " + (attention ? "needs-approval" : active ? "running" : "done")}
        key={i.id}
      >
        {/* 第一行：谁（agent）+ 状态。`t.server` / 窗格号在下面那行"在哪"，这里不重复。 */}
        <div className="ai-task-line">
          <span className={"dot " + (attention ? "warn" : active ? "ok" : "idle")} />
          <span className="grow ellipsis">{aiToolLabel(t.tool)}</span>
          <span className="ai-tag">{aiEnvLabel(t.env)}</span>
          <span
            className={"ai-state " + (attention ? "needs-approval" : active ? "running" : "done")}
          >
            {aiStateLabelOf(i)}
          </span>
        </div>
        {/* 来源徽标（§3.3 / §10.2：每张卡都要有）：
            文字直接用后端 `badge()`，悬停写清**谁说的 / 多久前 / 能证明什么**。
            裸 SSH 只写「运行中（进程推断，可能已卡住）」—— 永不显示"需要你"（§10.4）。 */}
        <div className="ai-task-meta">
          <span className="ai-badge-owner" title={aiBadgeTitle(i)}>
            {i.badge}
          </span>
          {/* 输出活动推断出来的「运行中」：**必须自己承认是推断**。
              文案不写"正在执行"、只写"输出活动"，悬停写清它证明不了什么
              （见 `aiBadgeTitle` 最后那段）—— 推断绝不说成事实。 */}
          {activityEvidenceOf(i) ? (
            <span
              className="ai-infer-badge"
              title={
                "推断，不是事实：这条卡对应的终端最近 5 秒内还有输出。\n" +
                "输出只能说明界面在动 —— 看不出它是跑完了在收尾、还是卡在等你按回车；\n" +
                "所以只在 5 秒内显示成「运行中」，一旦 herdr / 日志 / 刷新给出状态就以那边为准。"
              }
            >
              推断 · 输出活动
            </span>
          ) : null}
          {i.downgradedFrom ? (
            <span
              title={
                "有来源声称它是「" +
                aiStateLabel(i.downgradedFrom) +
                "」，但这个承载看不到这个状态 —— 推断绝不说成事实（§10.4 / §10.5）"
              }
            >
              {" "}
              · 该承载看不到「{aiStateLabel(i.downgradedFrom)}」
            </span>
          ) : null}
        </div>
        {/* 第三行只给"在哪台机器、哪个项目"；完整命令行放悬停提示 */}
        <div className="ai-task-meta ellipsis">
          {t.server}
          {/* 项目名跟服务器名一样时别重复一遍：远端窗格的 cwd 常常就是 /home/<user>，
              目录名正好等于服务器名，卡片上就出现 `lz · lz · w1Q:p1`（用户报过的脏标签） */}
          {project && project !== t.server ? ` · ${project}` : ""}
          {t.herdrPane ? ` · ${t.herdrPane}` : t.pane ? ` · ${t.pane}` : ""}
          {linkedAny
            ? ` · 已开在「${linkedAny.title}」${linkedControl ? "" : "（只读）"}`
            : ""}
        </div>
        {withSnap && aiSnapshot && usage ? (
          <div className="ai-task-meta">
            token {tokenM(usage.total)}
            {pct >= 1 ? ` · 上下文 ${pct}%` : ""}
            {aiSnapshot.lastTurnDurationMs > 0
              ? ` · 上一轮 ${aiDurationText(aiSnapshot.lastTurnDurationMs)}`
              : ""}
          </div>
        ) : null}
        {withSnap && aiSnapshot?.lastAction ? (
          <div className="ai-task-cmd ellipsis" title={aiSnapshot.lastAction}>
            {aiSnapshot.lastAction}
          </div>
        ) : null}
        {/* 自动事件更新/建出来的卡：把"最后一句 / 最后一个动作"直接显示出来。
            为什么只给这类卡：刷新来的卡沿用老版式（命令行只在悬停里），
            这一行只为"没点刷新也能看到它在干什么"服务，不改既有卡片的布局。 */}
        {i.badge.includes("自动更新") && t.activityLastLine ? (
          <div className="ai-task-cmd ellipsis" title={t.activityLastLine}>
            {t.activityLastLine}
          </div>
        ) : null}
        {/* G-02：shell 集成报上来的退出码（只有注入过 PROMPT_COMMAND 的会话才有；
            tmux 会话拿不到，那一侧受限于老 tmux，见 core/ssh.rs 里的说明） */}
        {withSnap && activeId && cmdExit[activeId] ? (
          <div
            className="ai-task-meta"
            title={new Date(cmdExit[activeId].at).toLocaleString("zh-CN")}
          >
            最近一条命令退出码 {cmdExit[activeId].exit}
            {cmdExit[activeId].exit === 0 ? "（成功）" : "（失败）"}
          </div>
        ) : null}
        <div
          className="ai-task-meta ellipsis"
          title={`${t.command || "（拿不到命令行）"}\n${aiSourceLabelOf(t.source)} · 证据 ${
            t.evidenceCount ?? 1
          } 条`}
        >
          耗时 {aiDurationText(t.durationMs)}
          {/* 来源已经在上面那枚徽标里说过了就不重复（§9①"同一件事说了三遍"就是这毛病）；
              徽标只写"谁说的"，所以这里补的是"读的是哪种数据"。 */}
          {aiBadgeCoversSource(i) ? "" : ` · ${aiSourceLabelOf(t.source)}`}
        </div>
        {/* herdr 卡片能直接开观察窗：只看那个窗格的实时画面，不抢它的尺寸、
            也不会像 attach TUI 那样退出时花屏（见 core/herdr.rs 顶部说明） */}
        {t.herdrPane ? (
          <div className="ai-task-actions">
            <button
              type="button"
              className="mini-btn"
              onClick={() => void openHerdrPane(t.herdrProfileId ?? "", t.herdrPane ?? "", t.tool)}
              title="开一个只读观察窗（不会影响窗格本身的尺寸）"
            >
              查看窗格
            </button>
            {/* 「接管」只在"这确实是个活任务"或"已经开着标签"时才给。
                空闲 / 已完成摆两个看起来都能点的按钮，用户实测会以为"点了能过去"
                （其实切不过去）—— 那种卡只留「查看窗格」。 */}
            {(active || linkedControl) && (
              <button
                type="button"
                className="mini-btn"
                onClick={() =>
                  linkedControl
                    ? // 这个窗格已经作为标签开着了：**切过去**，
                      // 而不是再开一个（再开一个会跟它抢输入/尺寸）
                      setActiveId(linkedControl.id)
                    : void openHerdrPane(
                        t.herdrProfileId ?? "",
                        t.herdrPane ?? "",
                        t.tool,
                        null,
                        "control",
                      )
                }
                title={
                  linkedControl
                    ? `这张卡对应的终端标签已经开着了：「${linkedControl.title}」`
                    : "接管这个窗格：可读可写，能直接回答它的选择题（会抢过输入；关掉标签就交还，窗格留在服务器上）"
                }
              >
                {linkedControl ? "切到标签" : "接管"}
              </button>
            )}
          </div>
        ) : null}
        {/* 这一轮产出的文件（统一模型带的产物）：点一下直接看
            （远端走应用内预览，本地用资源管理器） */}
        {withSnap && aiArtifacts.length > 0 && activeSession && aiSnapshot ? (
          <div className="ai-artifacts">
            {aiArtifacts.map((a) => (
              <button
                key={a.path}
                type="button"
                className="ai-artifact"
                title={`${a.path} · ${humanSize(a.size)}`}
                onClick={() => void openArtifact(activeSession, aiSnapshot.cwd, a)}
              >
                📄 {a.name}
              </button>
            ))}
          </div>
        ) : null}
        {/* 后端带上来的产物清单（可能来自 rollout，不一定在本地打开得了）：
            只列名字，点开文件由上面那一排负责 —— 这里**不编**一个点了没反应的按钮 */}
        {!withSnap && i.activity.artifacts.length > 0 ? (
          <div className="ai-artifacts">
            {i.activity.artifacts.slice(0, 6).map((name) => (
              <span className="ai-tag" key={name} title={name}>
                📄 {name}
              </span>
            ))}
            {i.activity.artifacts.length > 6 ? (
              <span className="dim">+{i.activity.artifacts.length - 6}</span>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }
  const activeFile =
    activeSession && activeSession.activeTab !== "terminal"
      ? activeSession.openFiles.find((f) => f.name === activeSession.activeTab) ?? null
      : null;

  const fileProfileId = activeSession?.profileId ?? null;
  const fileProfile = profiles.find((p) => p.id === fileProfileId) ?? null;
  activeUserRef.current = activeSession?.user;
  serialPortsRef.current = serialPorts;
  const activeTmuxName = activeSession?.tmuxName ?? undefined;

  useEffect(() => {
    if (!fileProfileId) {
      setFsPath("");
      setFsEntries([]);
      return;
    }
    void refreshFs(fileProfileId, activeTmuxName, activeSession?.cwd, undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileProfileId, activeId, activeTmuxName, settings.fsFollowTerminal]);

  async function refresh() {
    try {
      setProfiles(await listProfiles());
    } catch (e) {
      notify("读取连接配置失败：" + String(e));
    }
  }

  function handleEvent(sessionId: string, e: SessionEvent) {
    switch (e.type) {
      case "data":
        bus.push(sessionId, b64ToBytes(e.data));
        break;
      case "state":
        setSessions((prev) =>
          prev.map((s) => (s.id === sessionId ? { ...s, state: e.state } : s)),
        );
        if (e.state === "closed") scheduleReconnect(sessionId);
        break;
      case "title":
        setSessions((prev) =>
          prev.map((s) => (s.id === sessionId ? { ...s, title: e.title || s.title } : s)),
        );
        break;
      case "error":
        // 后端给的是「中文短句｜原始信息：<英文>」（见 core::ssh::friendly_ssh_error）：
        // 中文那半直接显示，英文原文自动进悬停（notify 里做），这里不用再加工。
        notify(e.message);
        setSessions((prev) =>
          prev.map((s) => (s.id === sessionId ? { ...s, state: "error" } : s)),
        );
        break;
      case "cwd":
        setSessions((prev) =>
          prev.map((s) => (s.id === sessionId ? { ...s, cwd: e.path } : s)),
        );
        break;
    }
  }

  /**
   * shell 通过 OSC 7 上报的当前目录（非 tmux 会话也能拿到）。
   * 只更新会话状态，不主动跳转目录——跳转由「同步终端目录」按钮触发。
   */
  function handleTerminalCwd(sessionId: string, path: string) {
    const clean = path.replace(/\/+$/, "") || "/";
    setSessions((prev) => {
      const cur = prev.find((s) => s.id === sessionId);
      if (!cur || cur.cwd === clean) return prev;
      return prev.map((s) => (s.id === sessionId ? { ...s, cwd: clean } : s));
    });
  }

  function addSession(s: OpenSession) {
    setSessions((prev) => [...prev, s]);
    setActiveId(s.id);
  }

  // ---------- 终端日志（SecureCRT 那种会话记录） ----------

  /** 日志文件名：会话名 + 本地时间（后端只负责落盘，命名由前端给，省一个日期库） */
  function logFileName(title: string) {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    return `${title}-${stamp}`;
  }

  async function startSessionLog(s: { id: string; title: string }) {
    try {
      const path = await sessionLogStart(s.id, logFileName(s.title));
      setSessions((prev) =>
        prev.map((x) => (x.id === s.id ? { ...x, logPath: path } : x)),
      );
      notify(`已开始记录日志：${path}`);
      return path;
    } catch (e) {
      notify("开始记录日志失败：" + String(e));
      return null;
    }
  }

  async function stopSessionLog(s: { id: string }) {
    try {
      const path = await sessionLogStop(s.id);
      setSessions((prev) =>
        prev.map((x) => (x.id === s.id ? { ...x, logPath: undefined } : x)),
      );
      notify(path ? `已停止记录日志：${path}` : "这个会话没有在记日志");
    } catch (e) {
      notify("停止记录日志失败：" + String(e));
    }
  }

  /** 打开日志文件；没在记就打开日志目录 */
  async function openSessionLog(s: { logPath?: string }) {
    try {
      if (s.logPath) {
        await openInExplorer(s.logPath);
      } else {
        await openInExplorer(await sessionLogDir());
      }
    } catch (e) {
      notify("打开日志失败：" + String(e));
    }
  }

  /** 新会话按设置决定要不要自动开日志 */
  function maybeAutoLog(s: { id: string; title: string }) {
    if (settings.autoLog) void startSessionLog(s);
  }

  /**
   * 统一的提示入口 —— **只写底部状态栏，不做任何悬浮弹层**。
   * 按内容分成三档，用颜色/符号区分：
   *   info  完成类（已上传、已删除、AI 跑完…）→ ✓
   *   warn  需要留意但不致命（还没好、已重试 N 次…）→ ⚠ 琥珀黄
   *   error 出错（失败、无法、请先…）→ ❗ 红底加粗并闪一下
   */
  function notify(text: string) {
    // 后半句"这台服务器可能要密码…"是**给用户照做的**，不能被切掉 —— 所以先把它摘出来，
    // 只把「中文短句｜原始信息：…」那一半送进拆分逻辑（见 splitErrText）。
    const nl = text.indexOf("\n");
    const head = nl >= 0 ? text.slice(0, nl) : text;
    const tail = nl >= 0 ? text.slice(nl) : "";
    const { short, detail } = splitErrText(head);
    const kind: "info" | "warn" | "error" = /失败|错误|不能|请|无法|不支持|被拒绝|不正确|超时|不存在|为空/.test(
      text,
    )
      ? "error"
      : /还没|没有|已尝试|重试|注意|不可|未/.test(text)
        ? "warn"
        : "info";
    setStatusMsg({ text: short + tail, detail: detail + tail, at: Date.now(), kind });
  }

  // ---------- 给 AI 发文件 / 发消息（粘贴、拖拽、「✍ 发给 AI」输入窗共用这一套） ----------

  /** 粘贴文件的落盘名：`paste-20261009-213045-原名`（本地时间，一眼看得出先后，且不撞名） */
  function pasteName(name: string): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    const ts = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(
      d.getMinutes(),
    )}${p(d.getSeconds())}`;
    const suffix = (name || "paste.png").replace(/[\\/]/g, "_");
    return `paste-${ts}-${suffix}`;
  }

  /** 路径最后一段（本地是 `\`、远端是 `/`，两种都要切） */
  function baseName(p: string): string {
    const parts = p.split(/[\\/]/);
    return parts[parts.length - 1] || p;
  }

  /** Windows 路径 → WSL 路径：`C:\a\b.png` → `/mnt/c/a/b.png` */
  function toWslPath(p: string): string {
    const m = /^([a-zA-Z]):[\\/](.*)$/.exec(p);
    if (!m) return p.replace(/\\/g, "/");
    return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}`;
  }

  /**
   * 把本地文件送到"AI 读得到的地方"，返回它该用的路径。
   *
   * - **远端**：上传到设置里的目录（默认 `~/.zeeai/paste`；填 `.` 就跟终端当前目录），
   *   返回**远端绝对路径** —— CLI agent 只认路径，不认你本机的文件；
   * - **WSL**：不用传，返回 `/mnt/c/...`；
   * - **本机 PowerShell / CMD**：原样返回（本地 agent 读的就是这个路径）。
   */
  async function uploadToSession(session: OpenSession, localPaths: string[]): Promise<string[]> {
    if (session.kind !== "remote" || !session.profileId) {
      return session.kind === "wsl" ? localPaths.map(toWslPath) : localPaths;
    }
    const profileId = session.profileId;
    const user = session.user ?? null;
    // fs_list 不带路径时，返回的是登录后的**家目录绝对路径**（后端 canonicalize(".")）
    const home = (await fsList(profileId, undefined, user)).path;
    const cfg = (settingsRef.current.pasteDir || "").trim() || "~/.zeeai/paste";
    const dir =
      cfg === "." ? session.cwd || home : cfg.startsWith("~/") ? home + cfg.slice(1) : cfg;
    try {
      await fsMkdir(profileId, dir, user);
    } catch {
      // "已存在"也会报错，属正常；新目录是两层的（~/.zeeai/paste）时补建父目录再试一次
      const parent = dir.replace(/\/[^/]*$/, "");
      if (parent && parent !== dir) {
        try {
          await fsMkdir(profileId, parent, user);
        } catch {
          /* 忽略：父目录多半已存在 */
        }
        try {
          await fsMkdir(profileId, dir, user);
        } catch {
          /* 忽略：后面 upload 失败会给出真正的错误 */
        }
      }
    }
    await fsUpload(profileId, localPaths, dir, user);
    return localPaths.map((p) => `${dir}/${baseName(p)}`);
  }

  /**
   * 往会话的输入行插一段文本；`submit = true` 表示插完**再敲一次回车**（把消息交给 AI）。
   * 返回是否真的送到。
   *
   * 普通 / tmux 会话走 `bus.sendInput` → `term.paste()`：xterm 会按远端有没有开
   * bracketed paste 决定要不要包转义序列（多行提示词才不会被 TUI 当成连按回车）。
   *
   * herdr 窗格走 B 通道（`pane send-text`）。**文本与回车必须是同一个 await 序列**：
   * 2026-10-10 用户实测"文字到了、但 AI 不执行"，根因就在这里原来是 fire-and-forget
   * —— `submitLine()` 紧跟着发回车，两条异步调用赛跑：输入泵还没建起来时回车那条
   * 直接失败（错误还被 catch 吞掉），泵建好了回车也可能**先于**文本写进去（等于敲了个空行）。
   */
  async function insertText(
    session: OpenSession,
    text: string,
    submit = false,
  ): Promise<boolean> {
    const pane = session.herdrPane;
    if (pane && session.herdrMode !== "control") {
      notify("这是只读观察窗，发不了字：先在卡片上点「接管」再发");
      return false;
    }
    if (pane) {
      // 走 **B 通道**（herdr 的 `pane send-text` = herdrPaneType），不要用 herdrPaneInput：
      //
      // 2026-10-09 在真机上用 `head -3 > 文件` 实测（载荷 `\x1b[200~第一行\n第二行\n第三行\n\x1b[201~`，42 字节）：
      // A 通道（herdr_pane_input，写窗格流）**结尾标记 `\x1b[201~` 被 herdr 吃掉**、换行被当成逐个回车
      // → 一段多行提示词会被 shell 当成两条命令执行；B 通道逐字节透明（42 字节原样到达）。
      // 所以多行/粘贴一律走 B，并且自己带上 bracketed paste 的包裹。
      try {
        // 顺序不能换、也不能不 await：见上面那段踩坑说明
        await ensureHerdrInput(session.id, session.profileId ?? "", session.user ?? null, pane);
        await herdrPaneType(session.id, `\x1b[200~${text}\x1b[201~`);
        if (submit) await submitHerdrPane(session.id);
        return true;
      } catch (e) {
        notify("窗格输入送不出去（可能已被别的客户端接管，或窗格已关闭）：" + String(e));
        return false;
      }
    }
    if (bus.sendInput(session.id, text, submit)) return true;
    // 终端还没挂载（极少见，例如刚恢复的会话）：退回直接写 PTY。
    // 这条路上没有 bracketed paste，多行会被当成多次回车 —— 总比什么都不发生强。
    // 注意两点：
    //   1) 回车**必须一起写**（以前这里只写文本，于是"消息发出去了但没执行"）；
    //   2) 正文与回车**分两次写、中间隔 40ms**：本地 ConPTY 会把挨着的两次写入合成
    //      同一次 read（真机实测：假 TUI 只收到一段 `正文 + \r`），远程 ssh 却是分开到的。
    //      隔开一点，本地和远程就一样了（见 Terminal.tsx 输入通道那段说明）。
    void (async () => {
      try {
        await sessionWrite(session.id, bytesToB64(new TextEncoder().encode(text)));
        if (submit) {
          await new Promise((r) => setTimeout(r, 40));
          await sessionWrite(session.id, bytesToB64(new TextEncoder().encode("\r")));
        }
      } catch (e) {
        // 不许静默：写失败要让人看见（这条兜底路走到的都是"终端没挂载"的怪状态）
        notify("这条会话的输入送不进去：" + String(e));
      }
    })();
    return true;
  }

  /**
   * 在 herdr 窗格里敲一次回车。
   *
   * 先用 B 通道送**一个字面 CR**：`\r` 就是键盘回车在 PTY 上的字节，而 B 通道是实测
   * 逐字节透明的 —— 这样不依赖 herdr 的按键名表（`pane send-keys` 认不认 `enter` 没验过，
   * 而且泵里那条命令是 `>/dev/null 2>&1`，失败也看不见）。只有这条 IPC 自己失败时才退回
   * `pane send-keys enter`。**两条都失败一定要报出来，不能静默**（用户上次就是这么踩的）。
   */
  async function submitHerdrPane(id: string) {
    try {
      await herdrPaneType(id, "\r");
      return;
    } catch {
      /* 落到下面的按键通道再试一次 */
    }
    try {
      await herdrPaneKey(id, "enter");
    } catch (e) {
      notify("回车没送出去（窗格可能已被接管或关闭）：" + String(e));
    }
  }

  /**
   * 附件的缩略图（data URL）。**只对图片后缀尝试** —— 别的文件读出来也没法显示，
   * 白花一次 IPC。失败一律静默：没有预览而已，不该为这个弹提示。
   */
  async function thumbFor(local: string, name: string): Promise<string | undefined> {
    if (!/\.(png|jpe?g|gif|webp|bmp)$/i.test(name)) return undefined;
    try {
      const b64 = await pasteReadThumb(local);
      const mime = /\.jpe?g$/i.test(name)
        ? "image/jpeg"
        : /\.gif$/i.test(name)
          ? "image/gif"
          : /\.webp$/i.test(name)
            ? "image/webp"
            : /\.bmp$/i.test(name)
              ? "image/bmp"
              : "image/png";
      return `data:${mime};base64,${b64}`;
    } catch {
      return undefined; // 超过 4MB / 读不到：没有预览而已，不打扰
    }
  }

  /** 弹一张"刚上传了什么"的小卡片，几秒后自己消失（可在设置里关掉） */
  function showPasteCard(card: { thumb?: string; name: string; remote: string }) {
    if (!settingsRef.current.pasteToast) return;
    if (pasteCardTimer.current !== null) window.clearTimeout(pasteCardTimer.current);
    setPasteCard(card);
    pasteCardTimer.current = window.setTimeout(() => {
      pasteCardTimer.current = null;
      setPasteCard(null);
    }, 4500);
  }

  /** 本地已存在的文件（拖拽进来的 / 文件选择器选的）→ 上传 → 把远端路径插进输入行 */
  async function handleIncomingPaths(session: OpenSession, paths: string[]) {
    if (!paths.length) return;
    try {
      // 先"收进"粘贴临时目录：上传、预览、用完删除都只认那一个目录（守卫只写一次）
      const locals: string[] = [];
      for (const p of paths) {
        try {
          locals.push(await pasteAdoptFile(p));
        } catch (e) {
          notify("收不了这个文件：" + String(e));
        }
      }
      if (!locals.length) return;
      // 「在终端区直接粘图片/文件」走哪条路，由设置里的 pasteToast 决定（默认不勾）：
      //   不勾 = **放进输入窗**：能确认粘对了没有，还能补一句话再发；不往终端里插路径。
      //   勾上 = 快路径：立刻把远端路径插进终端输入行 + 弹几秒缩略图。
      // 纯文本不受这个设置影响 —— 它永远按焦点走（焦点在终端就进终端）。
      if (!settingsRef.current.pasteToast) {
        setComposerOpen(true);
        await composerAttachPaths(session, locals, true); // 已经在粘贴临时目录里了，不用再收一遍
        return;
      }
      const name = baseName(locals[0]);
      const thumb = await thumbFor(locals[0], name);
      const remotes = await uploadToSession(session, locals);
      void insertText(session, remotes.join(" ") + " ");
      notify(`已上传 ${remotes.length} 个文件：${remotes[0]}${remotes.length > 1 ? " 等" : ""}`);
      showPasteCard({ thumb, name: baseName(remotes[0]), remote: remotes[0] });
      for (const l of locals) void pasteDiscardFile(l).catch(() => {});
    } catch (e) {
      notify("上传失败：" + String(e));
    }
  }

  /**
   * 剪贴板里的文件（截图工具塞进来的位图 / 资源管理器里复制的文件）→ 落盘 → 上传 → 插路径。
   *
   * 不做二段确认、不弹窗：粘贴的语义就是"现在就发"，错了删掉重来即可。
   * 但会给一张几秒的缩略图卡片 —— 没有它，用户根本不知道自己粘对了没有。
   */
  async function handleIncomingFiles(
    session: OpenSession,
    files: { name: string; bytes: Uint8Array }[],
  ) {
    if (!files.length) return;
    try {
      const locals: string[] = [];
      for (const f of files) locals.push(await pasteSaveFile(pasteName(f.name), bytesToB64(f.bytes)));
      // 同 handleIncomingPaths：默认（不勾 pasteToast）**放进输入窗**，勾上才走"插路径 + 浮层"的快路径
      if (!settingsRef.current.pasteToast) {
        setComposerOpen(true);
        await composerAttachPaths(session, locals, true);
        return;
      }
      const name = baseName(locals[0]);
      const thumb = await thumbFor(locals[0], name);
      const remotes = await uploadToSession(session, locals);
      void insertText(session, remotes.join(" ") + " ");
      notify(`已上传 ${remotes.length} 个文件：${remotes[0]}`);
      showPasteCard({ thumb, name: baseName(remotes[0]), remote: remotes[0] });
      for (const l of locals) void pasteDiscardFile(l).catch(() => {});
    } catch (e) {
      notify("粘贴上传失败：" + String(e));
    }
  }

  /**
   * 输入窗：把文件上传后只加"附件"（不插进终端 —— 用户还没点发送）。
   *
   * `alreadyLocal = true` 表示传进来的路径**已经在粘贴临时目录里**（例如从剪贴板粘的），
   * 不用再 copy 一遍。
   */
  async function composerAttachPaths(
    session: OpenSession,
    paths: string[],
    alreadyLocal = false,
  ) {
    if (!paths.length) return;
    setComposerBusy(true);
    try {
      const locals: string[] = [];
      for (const p of paths) {
        try {
          locals.push(alreadyLocal ? p : await pasteAdoptFile(p));
        } catch (e) {
          notify("收不了这个文件：" + String(e));
        }
      }
      if (!locals.length) return;
      const remotes = await uploadToSession(session, locals);
      const cards: {
        name: string;
        local: string;
        remote: string;
        thumb?: string;
      }[] = [];
      for (let i = 0; i < locals.length; i++) {
        const name = baseName(locals[i]);
        // 顺序要紧：**先取缩略图再删本地文件**，否则预览就没了
        const thumb = await thumbFor(locals[i], name);
        cards.push({ name, local: locals[i], remote: remotes[i], thumb });
        void pasteDiscardFile(locals[i]).catch(() => {});
      }
      setComposerFiles((prev) => [...prev, ...cards]);
      notify(`附件已就绪：${remotes[0]}${remotes.length > 1 ? " 等" : ""}`);
    } catch (e) {
      notify("附件上传失败：" + String(e));
    } finally {
      setComposerBusy(false);
    }
  }

  /** 输入窗：点「＋」选本地文件 */
  async function composerPickFiles(session: OpenSession) {
    try {
      const picked = await openLocalDialog({
        multiple: true,
        title: "选择要发给 AI 的文件（图片 / 文本都行）",
      });
      if (!picked) return;
      const paths = Array.isArray(picked) ? picked : [picked];
      await composerAttachPaths(session, paths);
    } catch (e) {
      notify("选文件失败：" + String(e));
    }
  }

  /**
   * 输入窗：发送。
   *
   * 正文 = 用户写的字 +（有附件时）空行 + 每个附件的**远端路径各占一行** ——
   * codex / claude 都能按路径读文件，这是"给终端里的 AI 发图"唯一稳的做法。
   * 发完**不关窗**（方便接着发下一条），只清空内容。
   */
  async function sendComposer() {
    const session = activeSessionRef.current;
    if (!session || composerBusy) return;
    const text = composerText.trim();
    if (!text && composerFiles.length === 0) {
      notify("先写点内容，或点「＋」加个附件");
      return;
    }
    const paths = composerFiles.map((f) => f.remote).join("\n");
    const body = composerFiles.length ? (text ? `${text}\n\n${paths}` : paths) : text;
    // 文本与回车**在同一个 await 里一次做完**（herdr 那条通道顺序敏感，见 insertText 的说明）
    if (!(await insertText(session, body, true))) return; // 只读观察窗之类：别接着敲回车
    setComposerText("");
    setComposerFiles([]);
  }

  /**
   * 拖拽：把文件拖进窗口 → 上传到当前会话 + 把远端路径插进输入行。
   *
   * 用的是 Tauri 的**原生**拖拽事件（拿得到真实本地路径），不是 HTML5 那套
   *（WebView 里 HTML5 的 drop 拿不到路径）。
   */
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    try {
      void getCurrentWebview()
        .onDragDropEvent((event) => {
          if (event.payload.type !== "drop") return;
          const cur = activeSessionRef.current;
          if (!cur) return;
          void handleIncomingPaths(cur, event.payload.paths);
        })
        .then((f) => {
          unlisten = f;
        })
        .catch(() => {
          /* 拿不到原生拖拽事件就算了（不拖拽也不影响其它功能） */
        });
    } catch {
      /* 这个环境下没有原生拖拽（例如无头测试）：同样不影响其它功能 */
    }
    return () => {
      if (unlisten) unlisten();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 状态栏提示自动消失（错误留久一点，让你看清）
  useEffect(() => {
    if (!statusMsg) return;
    const ttl = statusMsg.kind === "error" ? 12000 : 8000;
    const t = window.setTimeout(() => {
      setStatusMsg((cur) => (cur && cur.at === statusMsg.at ? null : cur));
    }, ttl);
    return () => window.clearTimeout(t);
  }, [statusMsg]);

  async function openLocalSession(
    /** "pwsh" = PowerShell 7（pwsh.exe）；"powershell" = 系统自带的 Windows PowerShell 5.1 */
    shell: "powershell" | "pwsh" | "cmd" | "wsl",
    distro?: string,
    cwd?: string,
    titleOverride?: string,
  ): Promise<string> {
    const id = uid();
    // pwsh 归到「PowerShell」这个面板下（kind 还是 powershell），这样侧栏只多一个按钮、
    // 不多一个模块；但标题/编号按各自的口味分开算，不会出现两个都叫"PowerShell 2"。
    const kind: OpenSession["kind"] = shell === "pwsh" ? "powershell" : shell;
    const base =
      shell === "wsl"
        ? "WSL" + (distro ? " · " + distro : "")
        : shell === "cmd"
          ? "命令提示符"
          : shell === "pwsh"
            ? "PowerShell 7"
            : "PowerShell";
    // 同一个模块开多个时编号，方便在侧栏/标签里区分（PowerShell、PowerShell 2、…）
    const sameKind =
      sessionsRef.current.filter((s) => s.kind === kind && (s.title ?? "").startsWith(base))
        .length + 1;
    const title = titleOverride?.trim() || (sameKind > 1 ? `${base} ${sameKind}` : base);
    addSession({
      id,
      title,
      kind,
      cwd,
      state: "connecting",
      openFiles: [],
      activeTab: "terminal",
    });
    maybeAutoLog({ id, title });
    try {
      // 初始尺寸同上：用上一次量到的，省掉"先按默认列数画一遍再 resize"（本地端一样会
      // 把提示符按错宽度画出来再重排）
      const info = await openLocal(
        id,
        shell,
        (e) => handleEvent(id, e),
        distro,
        lastTerminalSize()?.cols,
        lastTerminalSize()?.rows,
        cwd,
      );
      setSessions((prev) =>
        // 本地终端保留我们算好的名字（带编号）：后端只会给一个笼统的"PowerShell"，
        // 拿它覆盖会把编号吃掉 → 侧栏里几个 PowerShell 又分不清了。
        prev.map((s) =>
          s.id === id ? { ...s, title: s.title || info.title || title } : s,
        ),
      );
    } catch (e) {
      notify("打开本地终端失败：" + String(e));
    }
    return id;
  }

  async function openSshSession(
    profile: ConnectionProfile,
    tmuxMode: "default" | "none" | "name" = "default",
    tmuxName?: string | null,
    userOverride?: string | null,
    titleOverride?: string | null,
    /** 这次会话临时选的高亮规则集（空 = 跟着服务器绑定走） */
    highlightSetId?: string | null,
    /** 会话后端：tmux（默认）/ herdr */
    backend?: "tmux" | "herdr" | "herdr-pane" | "herdr-control",
    /** herdr 观察窗要看哪个窗格（backend = "herdr-pane" 时必填） */
    herdrPane?: string,
    /** herdr 窗格的打开方式（observe = 只读观察，control = 可读可写） */
    herdrMode?: "observe" | "control",
  ): Promise<string> {
    const id = uid();
    const explicitName = tmuxMode === "name" && tmuxName ? tmuxName : null;
    // 普通 shell 自动编号：不管是走"新建会话"对话框，还是从服务器右键 / 图标直接开，
    // 名字都不能重复 —— 否则历史记录按名字去重时会互相覆盖（表现为"开了好几个只看到一行"）
    const plainTitle = () => {
      // 硬保证不重名：从"已有记录数 + 1"开始，如果这个名字已被占用就继续往后顺延。
      // （之前只按数量算，计数一旦过期就会反复生成同一个名字 → 又覆盖同一条记录，
      //   于是"开了好几个却只有一条、永远显示 普通 shell 2"）
      const rows = historyRef.current.filter((h) => h.profileId === profile.id);
      const taken = new Set(
        rows.map((h) => (h.title ?? "").trim()).filter((t) => t !== ""),
      );
      let n = rows.filter((h) => !h.tmuxSession).length + 1;
      while (taken.has(`${profile.name} · 普通 shell ${n}`)) n++;
      return `${profile.name} · 普通 shell ${n}`;
    };
    const title =
      titleOverride?.trim() ||
      (explicitName ? `${profile.name} · ${explicitName}` : plainTitle());

    // ---------- 同一个会话不开第二份（这是"终端显示不全 / 历史被压窄"的根因） ----------
    //
    // 为什么必须挡在这里：应用用的是 `tmux new-session -A -s <name>`（没有 `-d`），
    // 同一个 tmux 会话被 attach 第二次时，两个客户端会**同时挂着**；老的 tmux（比如 2.7）
    // 会把窗口尺寸按**最小的客户端**算，于是 pane 被压窄、全屏 TUI 按窄宽度重画，
    // 那一段历史就永久坏掉（详细分析见 docs/review/bug-tmux-scrollback-narrow.md）。
    //
    // 以前只在「点会话历史」那条路上做了去重（connectFromHistory），
    // 但 tmux 管理面板的「连接」按钮、以及"新建会话 tmux 新建 + 名字留空"这两条路没挡 ——
    // 同一个默认名（模板 {host}-{user}）点两次就是两个客户端。现在统一提到这里，
    // 所有入口一次性生效。
    const wantedTmux =
      tmuxMode === "none"
        ? null
        : explicitName ?? defaultTmuxName(profile, userOverride ?? undefined);
    const alreadyOpen = sessionsRef.current.find((s) => {
      if (s.profileId !== profile.id) return false;
      // herdr 窗格：同一个窗格、同一种打开方式只开一个
      //（只读观察和可写接管是两回事，允许各开一个）
      if (backend === "herdr-pane" || backend === "herdr-control") {
        return s.herdrPane === herdrPane && (s.herdrMode ?? "observe") === (herdrMode ?? "observe");
      }
      if (wantedTmux) return s.tmuxName === wantedTmux;
      // 普通 shell：只有"名字完全相同"才算同一个（自动编号的名字不会撞，所以不受影响）
      return !s.tmuxName && (s.title ?? "").trim() === title.trim();
    });
    if (alreadyOpen) {
      setActiveId(alreadyOpen.id);
      notify(
        backend === "herdr-pane"
          ? `「${alreadyOpen.title}」的观察窗已经开着了，直接切过去`
          : `「${alreadyOpen.title}」已经开着了，直接帮你切过去（同一会话开两个客户端会把画面挤变形）`,
      );
      return alreadyOpen.id;
    }

    addSession({
      id,
      title,
      kind: "remote",
      profileId: profile.id,
      user: userOverride ?? profile.ssh?.user,
      // 观察窗的"名字"是 herdr 窗格号，不记进 tmuxName（那个字段是给 tmux 面板用的）
      tmuxName:
        backend === "herdr-pane" || backend === "herdr-control"
          ? undefined
          : explicitName ?? undefined,
      herdrPane:
        backend === "herdr-pane" || backend === "herdr-control" ? herdrPane : undefined,
      herdrMode:
        backend === "herdr-pane" || backend === "herdr-control"
          ? herdrMode ?? "observe"
          : undefined,
      tmuxMode,
      highlightSetId: highlightSetId ?? null,
      state: "connecting",
      openFiles: [],
      activeTab: "terminal",
    });
    maybeAutoLog({ id, title });
    try {
      const info = await openSsh(
        id,
        profile.id,
        (e) => handleEvent(id, e),
        // herdr 窗格靠 tmuxName 这个参数把窗格号带给后端（后端拿它当 pane id 用）
        backend === "herdr-pane" || backend === "herdr-control" ? "name" : tmuxMode,
        backend === "herdr-pane" || backend === "herdr-control"
          ? herdrPane ?? null
          : tmuxName ?? null,
        // 初始尺寸用"上一次量到的"（同一台机器同一个窗口，尺寸几乎一定一样）。
        // 不传的话后端会用一个写死的 110x30 起流，等前端量完再 resize —— 远端会先把
        // 提示符按 110 列画一遍再重排，看起来就是"头几个提示符折叠在一起"；
        // herdr 的可写流还会真的把那个窗格撑成 110 再收回来，屏幕上留一条宽度不对的竖条。
        lastTerminalSize()?.cols,
        lastTerminalSize()?.rows,
        userOverride ?? null,
        backend ?? "tmux",
      );
      // 最终显示名算一次、两处都用：标签上显示什么，历史里就存什么。
      // （以前历史存的是 setSessions 之前的 title，于是 herdr 会话出现了两条记录：
      //   标签/后端叫 "lz · herdr w9:p1"，历史里却躺着 "lz · w9:p1" —— 用户实测踩到。）
      //
      // 用户**显式给了 tmux 会话名**时（explicitName），一律用它拼标题，不采用后端返回的
      // title —— 后端的 title 曾经固定是 `profile · host`，用户会以为"我填的名字没生效"。
      const finalTitle = titleOverride?.trim()
        ? title
        : explicitName
          ? title
          : tmuxMode === "none"
            ? title
            : info.title || title;
      setSessions((prev) =>
        prev.map((s) =>
          s.id === id
            ? {
                ...s,
                // 标签标题的三条规则（以前普通 shell 也被 info.title 覆盖，
                // 于是标签显示成"lz · 192.0.2.45"，和历史里的"普通 shell 2"对不上）：
                // 1) 用户手填的名字 → 用用户的；
                // 2) 普通 shell（没 tmux）→ 用我们算好的自动编号名字；
                // 3) tmux / herdr → 用后端回来的真实名字（herdr 那条带着窗格号）。
                title: finalTitle,
                tmuxName: info.tmuxSession ?? undefined,
                user: info.user ?? s.user,
              }
            : s,
        ),
      );
      // 记录到会话历史（可在设置里关闭，也可在侧栏里逐条删除）
      if (settings.recordHistory) {
        try {
          applyHistory(
            await historySave({
              id: "",
              profileId: profile.id,
              profileName: profile.name,
              host: profile.ssh?.host ?? "",
              tmuxSession: info.tmuxSession ?? null,
              // herdr 会话要把窗格号也记下来 —— 否则从侧栏列表点开它会开出普通 shell
              herdrPane: herdrPane && (backend === "herdr-pane" || backend === "herdr-control")
                ? herdrPane
                : null,
              herdrMode: backend === "herdr-control" ? "control" : backend === "herdr-pane" ? "observe" : null,
              // 存"最终显示名"（自动编号的「普通 shell N」也要存下来；herdr 会话要带 herdr+窗格号）。
              // 之前这里写的是 titleOverride（只存用户手填的名字），自动编号的名字被丢成 null，
              // 于是所有普通 shell 的去重键都变成同一个空值 → 又互相覆盖 → 永远不增数。
              title: finalTitle || null,
              lastUsed: 0,
            }),
          );
        } catch {
          /* 历史写入失败不影响会话使用 */
        }
      }
    } catch (e) {
      notify(connErrorText("SSH 连接失败", e));
      setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, state: "error" } : s)));
    }
    return id;
  }

  async function closeSession(id: string) {
    // 关标签时顺手清掉拖动状态
    setDragTabId(null);
    // 观察窗的输入通道跟着会话一起收（后端会把那条常驻 ssh 的 stdin 关掉）
    herdrInputs.current.delete(id);
    // 先记下它在标签栏里的位置，关掉之后要顶上来一个
    const list = sessionsRef.current;
    const idx = list.findIndex((s) => s.id === id);
    try {
      await sessionClose(id);
    } catch {
      /* 已断开则忽略 */
    }
    bus.drop(id);
    const next = list.filter((s) => s.id !== id);
    setSessions(next);
    setActiveId((cur) => {
      if (cur !== id) return cur;
      if (next.length === 0) return null;
      // 关掉的是当前标签：优先接右边那个，没有右边就接最后一个（最右边的）
      const at = idx < 0 ? next.length - 1 : Math.min(idx, next.length - 1);
      return next[at].id;
    });
  }

 /** 一次关掉一批会话（「关闭全部本地终端」「关闭全部会话」用这个） */
  /**
   * 把 `fromId` 这个标签挪到 `toId` 那个的位置 —— 标签左右拖动排序用。
   * 顺序保存在 sessions 数组里，而工作区快照就是按这个顺序存的，所以**下次打开还是你排的序**。
   */
  function moveTab(fromId: string | null, toId: string) {
    if (!fromId || fromId === toId) return;
    setSessions((prev) => {
      const from = prev.findIndex((s) => s.id === fromId);
      const to = prev.findIndex((s) => s.id === toId);
      if (from < 0 || to < 0) return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }

  /**
   * 标签拖动排序（自己实现，不用 HTML5 拖拽 —— 那套在 WebView2 里对 button 不生效）：
   * 按住标签往左右挪，鼠标经过别的标签时**实时让它俩换位**，松手就停。
   * 效果上就是"拖着排"，而且所见即所得。
   */
  useEffect(() => {
    if (!dragTabId) return;
    const onMove = (e: MouseEvent) => {
      setDragPos({ x: e.clientX, y: e.clientY }); // 让"跟着鼠标的虚影"动起来
      const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      const over = el?.closest("[data-tab-id]")?.getAttribute("data-tab-id") ?? "";
      if (over && over !== dragTabId) moveTab(dragTabId, over);
    };
    const onUp = () => {
      setDragTabId(null);
      setDragPos(null);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragTabId]);

  async function closeSessions(list: OpenSession[], what: string) {
    if (list.length === 0) {
      notify(`现在没有打开的${what}`);
      return;
    }
    const reallyDo = async () => {
      for (const s of list) {
        try {
          await sessionClose(s.id);
        } catch {
          /* 已经断开 */
        }
        bus.drop(s.id);
      }
      const ids = new Set(list.map((s) => s.id));
      const remaining = sessionsRef.current.filter((s) => !ids.has(s.id));
      setSessions(remaining);
      setActiveId((cur) => {
        if (!cur || !ids.has(cur)) return cur;
        // 当前会话被关掉了：落到剩下的最后一个，别把主区域留空
        return remaining.length > 0 ? remaining[remaining.length - 1].id : null;
      });
      notify(`已关闭 ${list.length} 个${what}`);
    };
    if (list.length === 1) {
      await reallyDo();
      return;
    }
    setConfirmDialog({
      title: `关闭全部${what}`,
      message:
        `要关闭这 ${list.length} 个${what}吗？` +
        (what === "会话" ? "\n（SSH 里的 tmux 会话还在服务器上，重连就能回来）" : ""),
      okLabel: "全部关闭",
      onOk: () => void reallyDo(),
    });
  }

  /** 断线后重连：复用同一个会话 id 与终端，替换后端已被 kill 的进程。 */
  async function reconnectSession(s: OpenSession) {
    if (!s.profileId) return;
    try {
      await sessionClose(s.id);
    } catch {
      /* 已经断开 */
    }
    setSessions((prev) =>
      prev.map((x) => (x.id === s.id ? { ...x, state: "reconnecting" } : x)),
    );
    try {
      await openSsh(
        s.id,
        s.profileId,
        (e) => handleEvent(s.id, e),
        s.tmuxMode ?? "default",
        s.tmuxName ?? null,
        undefined,
        undefined,
        s.user ?? null,
      );
    } catch (e) {
      notify(connErrorText("重连失败", e));
      setSessions((prev) => prev.map((x) => (x.id === s.id ? { ...x, state: "error" } : x)));
    }
  }

  async function submitProfile() {
    if (!form.host.trim()) {
      notify("请填写主机地址");
      return;
    }
    const p: ConnectionProfile = {
      id: uid(),
      type: "ssh",
      name: form.name.trim() || form.host.trim(),
      group: form.group.trim() || "默认",
      ssh: {
        host: form.host.trim(),
        // 留空的端口/用户 = "没说"：后端不传 -p、只给 host，让 ~/.ssh/config 生效
        // （显式填了仍然是我们说了算）。类型仍是 u16 / String，不用改 store。
        port: portOrZero(form.port),
        user: form.user.trim(),
        authKind: "key",
        keyPath: form.keyPath.trim() || undefined,
        tmuxEnabled: settings.tmuxDefault,
        tmuxTemplate: "{host}-{user}",
        herdrEnabled: false,
      },
    };
    try {
      await saveProfile(p);
      setForm({ ...EMPTY_PROFILE });
      setShowForm(false);
      await refresh();
    } catch (e) {
      notify("保存失败：" + String(e));
    }
  }

  async function removeProfile(p: ConnectionProfile) {
    try {
      await deleteProfile(p.id);
      await refresh();
    } catch (e) {
      notify("删除失败：" + String(e));
    }
  }

  function toggleServer(id: string) {
    setCollapsedServers((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  function openEditDialog(profile?: ConnectionProfile) {
    if (profile) {
      setEditDialog({ draft: JSON.parse(JSON.stringify(profile)), isNew: false });
      setEditPassword("");
      void secretHas(profile.id)
        .then(setEditHasPassword)
        .catch(() => setEditHasPassword(false));
      return;
    }
    setEditPassword("");
    setEditHasPassword(false);
    setEditDialog({
      isNew: true,
      draft: {
        id: "",
        type: "ssh",
        name: "",
        group: "默认",
        ssh: {
          host: "",
          // 留空 = "没说"（见 EMPTY_PROFILE 上那段说明：填了就顶掉 ~/.ssh/config）
          port: 0,
          user: "",
          authKind: "key",
          tmuxEnabled: settings.tmuxDefault,
          tmuxTemplate: "{host}-{user}",
          herdrEnabled: false,
        },
      },
    });
  }

  async function saveEditDialog() {
    if (!editDialog) return;
    const p = editDialog.draft;
    if (!p.ssh?.host.trim()) {
      notify("请填写主机地址");
      return;
    }
    const finalProfile: ConnectionProfile = {
      ...p,
      id: p.id || uid(),
      name: p.name.trim() || p.ssh.host.trim(),
      group: p.group.trim() || "默认",
    };
    try {
      await saveProfile(finalProfile);
      setEditDialog(null);
      await refresh();
      if (reopenNewAfterSave) {
        setReopenNewAfterSave(false);
        openNewSessionDialog(finalProfile);
      }
    } catch (e) {
      notify("保存失败：" + String(e));
    }
  }

  async function duplicateProfile(p: ConnectionProfile) {
    const copy: ConnectionProfile = {
      ...JSON.parse(JSON.stringify(p)),
      id: uid(),
      name: `${p.name} 副本`,
    };
    try {
      await saveProfile(copy);
      await refresh();
    } catch (e) {
      notify("复制失败：" + String(e));
    }
  }

  function patchDraft(
    patch: Partial<ConnectionProfile>,
    sshPatch?: Partial<NonNullable<ConnectionProfile["ssh"]>>,
  ) {
    setEditDialog((prev) => {
      if (!prev) return prev;
      const draft: ConnectionProfile = { ...prev.draft, ...patch };
      if (sshPatch && draft.ssh) {
        draft.ssh = { ...draft.ssh, ...sshPatch };
      }
      return { ...prev, draft };
    });
  }

  async function refreshTmux(profile: ConnectionProfile) {
    setTmuxLoading(true);
    try {
      setTmuxSessions(await tmuxList(profile.id, profile.ssh?.user ?? null));
    } catch (e) {
      notify("读取 tmux 会话失败：" + String(e));
      setTmuxSessions([]);
    } finally {
      setTmuxLoading(false);
    }
  }

  async function killTmux(profile: ConnectionProfile, name: string) {
    try {
      await tmuxKill(profile.id, name, profile.ssh?.user ?? null);
      await refreshTmux(profile);
    } catch (e) {
      notify("结束 tmux 会话失败：" + String(e));
    }
  }

  function defaultTmuxName(profile: ConnectionProfile, userOverride?: string): string {
    const host = profile.ssh?.host ?? "";
    const user = userOverride?.trim() || profile.ssh?.user || "";
    const tpl = profile.ssh?.tmuxTemplate || "{host}-{user}";
    return tpl
      .replace("{host}", host)
      .replace("{user}", user)
      .replace(/[.:/\\ ]/g, "-");
  }

  // ---------- 串口连接（用户自己建的那几条，不再罗列系统里所有 COM 口） ----------

  function openSerialDialog(profile?: ConnectionProfile) {
    if (profile) {
      setSerialDialog({ isNew: false, draft: JSON.parse(JSON.stringify(profile)) });
      void refreshSerial();
      return;
    }
    // 新建议一个默认值：优先挑 USB 串口（蓝牙虚拟串口一般用不上）
    const first =
      serialPorts.find((p) => /usb|ch3|cp21|ftdi|silicon|prolific/i.test(p.label)) ??
      serialPorts[0];
    setSerialDialog({
      isNew: true,
      draft: {
        id: "",
        type: "serial",
        name: first ? `${first.path} · 115200` : "",
        group: "串口",
        serial: {
          path: first?.path ?? "",
          baudRate: 115200,
          dataBits: 8,
          stopBits: 1,
          parity: "none",
          flowControl: "none",
        },
      },
    });
    void refreshSerial();
  }

  function patchSerialDraft(
    patch: Partial<ConnectionProfile>,
    serialPatch?: Partial<SerialConfig>,
  ) {
    setSerialDialog((prev) => {
      if (!prev) return prev;
      const draft: ConnectionProfile = { ...prev.draft, ...patch };
      if (serialPatch && draft.serial) {
        draft.serial = { ...draft.serial, ...serialPatch };
      }
      return { ...prev, draft };
    });
  }

  async function saveSerialDialog(openAfter: boolean) {
    if (!serialDialog) return;
    const p = serialDialog.draft;
    const cfg = p.serial;
    if (!cfg?.path.trim()) {
      notify("请选择或填写串口（例如 COM5）");
      return;
    }
    const finalProfile: ConnectionProfile = {
      ...p,
      id: p.id || uid(),
      name: p.name.trim() || `${cfg.path} · ${cfg.baudRate}`,
      group: p.group.trim() || "串口",
      serial: { ...cfg, path: cfg.path.trim().toUpperCase() },
    };
    try {
      await saveProfile(finalProfile);
      setSerialDialog(null);
      await refresh();
      if (openAfter) await openSerialSession(finalProfile);
    } catch (e) {
      notify("保存失败：" + String(e));
    }
  }

  async function removeSerialProfile(p: ConnectionProfile) {
    try {
      await deleteProfile(p.id);
      await refresh();
    } catch (e) {
      notify("删除失败：" + String(e));
    }
  }

  async function loadDialogTmux(profileId: string, user?: string) {
    setDialogBusy(true);
    try {
      setDialogTmux(await tmuxList(profileId, user ?? null));
    } catch (e) {
      notify("读取 tmux 会话失败：" + String(e));
      setDialogTmux([]);
    } finally {
      setDialogBusy(false);
    }
  }

  function openNewSessionDialog(profile?: ConnectionProfile) {
    const target = profile ?? sshProfiles[0];
    if (!target) {
      notify("还没有服务器配置，先去「连接 → 服务器管理」里加一台");
      return;
    }
    const useTmux = target.ssh?.tmuxEnabled ?? settings.tmuxDefault;
    // herdr 的默认值来自**这台服务器**的配置（用户要的就是"我在这个服务器上勾了默认，
    // 就别每次再问我"）。没装 herdr 的话那个勾是灰的，探测结果回来后自动变成不可勾。
    const useHerdr = target.ssh?.herdrEnabled ?? false;
    setNewDialog({
      profileId: target.id,
      useTmux,
      tmuxKind: "new",
      tmuxName: defaultTmuxName(target),
      attachTarget: "",
      useHerdr,
      herdrKind: "new",
      herdrTarget: "",
      user: target.ssh?.user ?? "",
      rememberUser: true,
      title: "",
    });
    if (useTmux) void loadDialogTmux(target.id, target.ssh?.user);
    // 顺便看看这台机器有没有 herdr（决定新会话里 herdr 能不能勾）
    void probeHerdrFor(target.id, target.ssh?.user);
  }

  /** 读一下这台机器上 herdr 的**所有窗格**（「接管已有窗格」用，按需加载） */
  async function loadDialogHerdr(profileId: string, user?: string) {
    setDialogBusy(true);
    try {
      // 用 pane list 而不是 agent list：空壳窗格（AI 已退出/刚开的）也得能选，
      // 否则用户会看到"没东西可接管"（实测反馈）。
      setDialogHerdr(await herdrPanes(profileId, user ?? null));
    } catch (e) {
      notify("读取 herdr 窗格失败：" + String(e));
      setDialogHerdr([]);
    } finally {
      setDialogBusy(false);
    }
  }

  async function confirmNewSession() {
    if (!newDialog) return;
    const profile = profiles.find((p) => p.id === newDialog.profileId);
    if (!profile) return;
    if (newDialog.useTmux && newDialog.tmuxKind === "attach" && !newDialog.attachTarget) {
      notify("请选择一个要附加的 tmux 会话");
      return;
    }
    if (newDialog.useHerdr && newDialog.herdrKind === "attach" && !newDialog.herdrTarget) {
      notify("请选择一个要接管的 herdr 窗格");
      return;
    }
    setDialogBusy(true);
    try {
      // 勾了「用 herdr 打开」就一定要拿到**可信的**结论再决定：
      //   - 没探过 → 探一次；
      //   - 上次探失败（null）→ **强制重探**（以前这里直接认为"没有 herdr"，
      //     一次网络抖动就把用户挡在门外，日志里就是这么发生的）；
      //   - 探到确实没装 → 明确降级到 tmux / 普通 shell，并在状态栏说清楚。
      let srcNow: AiSourceInfo | null | undefined =
        herdrAvailRef.current[newDialog.profileId];
      if (newDialog.useHerdr && (!srcNow || !srcNow.herdrVersion)) {
        srcNow = await probeHerdrFor(newDialog.profileId, newDialog.user, true);
      }
      const canHerdrNow = !!srcNow && !!srcNow.herdrVersion && srcNow.compat !== "too_old";
      const useHerdr = newDialog.useHerdr && canHerdrNow;
      if (newDialog.useHerdr && !canHerdrNow) {
        notify("没探到可用的 herdr（这台机器没装或这一下没连上），这次改用 tmux / 普通 shell 打开");
      }
      const wantedUser = newDialog.user.trim();
      // 这里**不再写回服务器配置**：以前那个"把用户名保存到配置里"的勾选，
      // 一不小心填错就把整台服务器的登录用户改掉了，风险远大于便利。
      // 现在登录用户只作为"这次会话的临时覆盖"，配置里的用户永远由「服务器管理」里改。
      const userOverride = wantedUser || null;
      // 会话名字：填了就用；普通 shell 留空则**自动编号**（同一台机器开多个也能分得清，
      // 而且历史记录按名字分开存，不会再互相覆盖）
      const wantedTitle = (newDialog.title ?? "").trim();
      // 注意：这里**不要自己算自动名字**。名字的唯一性由 openSshSession 里那段
      // "撞名就顺延"的逻辑保证；对话框一旦自己算了个名字传过去，就会把那套逻辑跳过，
      // 结果就是每次都生成同一个「普通 shell 2」（实测踩过）。
      // herdr 优先：勾了"用 herdr 打开"就直接进她的环境，不再走 tmux / 普通 shell 那两条
      if (useHerdr) {
        let pane = newDialog.herdrTarget;
        if (newDialog.herdrKind === "new") {
          notify("正在 herdr 里新建一个窗格…");
          pane = await herdrWorkspaceCreate(profile.id, userOverride);
        }
        // 名字一定要带上"herdr"和窗格号：
        // 光看 "lz · w9:p1" 谁也认不出这是 herdr 的窗格（用户实测就是被这个坑到的）。
        const herdrTitle = wantedTitle || `${profile.name} · herdr ${pane}`;
        await openSshSession(
          profile,
          "name",
          pane,
          userOverride,
          herdrTitle,
          newDialog.highlightSetId,
          "herdr-control",
          pane,
          "control",
        );
        notify(`已进入 herdr 的窗格 ${pane}（它是 herdr 管的那个终端，留在服务器上、随时能回来）`);
        // 刚多了一个工作区，顺手把服务状态/工作区清单刷新一下（状态条和面板上那句
        // 「N 个窗格 / N 个工作区」要跟着变，不然用户会以为没生效）
        herdrProbedFor.current = profile.id;
        void refreshHerdrServer(profile.id, userOverride);
      } else if (!newDialog.useTmux) {
        await openSshSession(
          profile,
          "none",
          null,
          userOverride,
          wantedTitle || null,
          newDialog.highlightSetId,
        );
      } else if (newDialog.tmuxKind === "new") {
        const name = newDialog.tmuxName.trim() || defaultTmuxName(profile);
        await openSshSession(
          profile,
          "name",
          name,
          userOverride,
          wantedTitle || null,
          newDialog.highlightSetId,
        );
      } else {
        await openSshSession(
          profile,
          "name",
          newDialog.attachTarget,
          userOverride,
          wantedTitle || null,
          newDialog.highlightSetId,
        );
      }
      setNewDialog(null);
    } catch (e) {
      // 以前这里没有 catch：`herdr workspace create` 之类一旦抛错，异常就被吞掉，
      // 对话框一动不动、也不报错 —— 用户看到的就是"一直建不开"（实测反馈）。
      notify("新建会话失败：" + String(e));
    } finally {
      setDialogBusy(false);
    }
  }

  async function connectFromHistory(h: HistoryEntry) {
    const profile = profiles.find((p) => p.id === h.profileId);
    if (!profile) {
      notify("这条历史对应的连接配置已被删除");
      return;
    }
    // 已经在标签里开着的：直接切过去，不要再开一个。
    // - tmux：同一个会话被两个客户端 attach 会互相挤窗口尺寸（"显示不全"那次的根因）；
    // - 普通 shell：一台机器开一排一模一样的"普通 shell"纯属重复，切过去就够了
    //   （真要再开一个，用「新建会话」按钮或服务器右键）。
    const opened = sessions.find((s) =>
      // herdr 会话按"同一个窗格 + 同一种方式"判重（和 openSshSession 里那套一致）
      h.herdrPane
        ? s.profileId === h.profileId &&
          s.herdrPane === h.herdrPane &&
          (s.herdrMode ?? "observe") === (h.herdrMode ?? "control")
        : h.tmuxSession
          ? s.profileId === h.profileId && s.tmuxName === h.tmuxSession
          : s.profileId === h.profileId &&
            !s.tmuxName &&
            (s.title ?? "").trim() === (h.title ?? "").trim(),
    );
    if (opened) {
      setActiveId(opened.id);
      notify(
        `「${h.title?.trim() || h.herdrPane || h.tmuxSession || "普通 shell"}」已经开着了，已帮你切过去`,
      );
      return;
    }
    const custom = h.title?.trim() || undefined;
    if (h.herdrPane) {
      // herdr 会话：按原来的方式重开那个窗格（以前这里会开出**普通 shell**，是个 bug）
      await openHerdrPane(
        h.profileId,
        h.herdrPane,
        herdrShortLabel(custom),
        null,
        h.herdrMode === "observe" ? "observe" : "control",
      );
    } else if (h.tmuxSession) {
      await openSshSession(profile, "name", h.tmuxSession, null, custom);
    } else {
      // 普通 shell：带上这条历史的名字重开 —— 名字一样，历史记录还是同一条（不会又长出新的编号）
      await openSshSession(profile, "none", null, null, custom ?? null);
    }
  }

  async function removeHistoryEntry(id: string) {
    try {
      applyHistory(await historyRemove(id));
    } catch (e) {
      notify("删除历史失败：" + String(e));
    }
  }

  async function refreshAdb() {
    setAdbLoading(true);
    try {
      setAdbVer(await adbVersion());
      setAdbList(await adbDevices());
      setFbVer(await fastbootVersion());
      setFbList(await fastbootDevices());
    } catch (e) {
      notify("ADB 不可用：" + String(e));
      setAdbVer("");
      setAdbList([]);
    } finally {
      setAdbLoading(false);
    }
  }

  async function refreshSerial() {
    setSerialLoading(true);
    try {
      setSerialPorts(await serialList());
    } catch (e) {
      notify("枚举串口失败：" + String(e));
      setSerialPorts([]);
    } finally {
      setSerialLoading(false);
    }
  }

  async function refreshGit() {
    const path = gitPath.trim();
    if (!path) {
      notify("请先填写仓库路径");
      return;
    }
    setGitLoading(true);
    try {
      setGitState(await gitStatus(path));
    } catch (e) {
      notify("读取 Git 状态失败：" + String(e));
      setGitState(null);
    } finally {
      setGitLoading(false);
    }
  }

  /** 刷新 Git 的全部信息：工作区状态 + 提交历史 + 分支 */
  async function refreshGitAll(pathArg?: string) {
    const path = (pathArg ?? gitPath).trim();
    if (!path) {
      notify("请先选一个仓库");
      return;
    }
    setGitBusy(true);
    try {
      const st = await gitStatus(path);
      setGitState(st);
      if (st.ok) {
        const [log, brs] = await Promise.all([gitLog(path, 30), gitBranches(path)]);
        setGitCommits(log);
        setGitBranchList(brs);
      } else {
        setGitCommits([]);
        setGitBranchList([]);
      }
    } catch (e) {
      notify("读取 Git 状态失败：" + String(e));
    } finally {
      setGitBusy(false);
    }
  }

  async function doGitAdd(files?: string[]) {
    const path = gitPath.trim();
    if (!path) return;
    try {
      await gitAdd(path, files);
      await refreshGitAll(path);
    } catch (e) {
      notify("暂存失败：" + String(e));
    }
  }

  async function doGitUnstage(files: string[]) {
    const path = gitPath.trim();
    if (!path) return;
    try {
      await gitUnstage(path, files);
      await refreshGitAll(path);
    } catch (e) {
      notify("取消暂存失败：" + String(e));
    }
  }

  function askGitDiscard(files: string[]) {
    setConfirmDialog({
      title: "丢弃改动",
      message: `确定丢弃这些文件的未提交改动吗？\n${files.join("\n")}\n\n改完就找不回来了。`,
      onOk: () => void doGitDiscard(files),
    });
  }

  async function doGitDiscard(files: string[]) {
    const path = gitPath.trim();
    if (!path) return;
    try {
      await gitDiscard(path, files);
      await refreshGitAll(path);
      notify("已丢弃改动");
    } catch (e) {
      notify("丢弃失败：" + String(e));
    }
  }

  async function doGitCommit() {
    const path = gitPath.trim();
    if (!path) return;
    if (!gitMessage.trim()) {
      notify("先写提交信息");
      return;
    }
    setGitBusy(true);
    try {
      const out = await gitCommit(path, gitMessage);
      setGitMessage("");
      notify(out.split("\n")[0] || "已提交");
      await refreshGitAll(path);
    } catch (e) {
      notify("提交失败：" + String(e));
    } finally {
      setGitBusy(false);
    }
  }

  async function doGitCheckout(branch: string, create = false) {
    const path = gitPath.trim();
    if (!path || !branch.trim()) return;
    setGitBusy(true);
    try {
      const out = await gitCheckout(path, branch, create);
      setNewBranch("");
      notify(out.trim().split("\n").pop() || `已切到 ${branch}`);
      await refreshGitAll(path);
    } catch (e) {
      notify("切换分支失败：" + String(e));
    } finally {
      setGitBusy(false);
    }
  }

  async function showFileDiff(file: string, staged: boolean) {
    const path = gitPath.trim();
    if (!path) return;
    try {
      const text = await gitDiff(path, file, staged);
      setDiffDialog({
        title: `${staged ? "已暂存 · " : ""}${file}`,
        text: text || "(没有 diff，可能已提交或只有模式变化)",
      });
    } catch (e) {
      notify("读取 diff 失败：" + String(e));
    }
  }

  async function showCommitDiff(hash: string, subject: string) {
    const path = gitPath.trim();
    if (!path) return;
    try {
      const text = await gitShow(path, hash);
      setDiffDialog({ title: `${hash.slice(0, 8)} ${subject}`, text });
    } catch (e) {
      notify("读取提交失败：" + String(e));
    }
  }

  /**
   * 「打开本地 Git 仓库」：选一个本地目录 → 确认是 Git 仓库 →
   * 存成一个工作空间（本地终端就起在这个目录），并顺手打开它的终端。
   */
  async function openGitWorkspace() {
    const picked = await openLocalDialog({
      directory: true,
      title: "选择本地 Git 仓库目录",
    });
    if (!picked || Array.isArray(picked)) return;
    const dir = picked;
    setGitPath(dir);
    setGitLoading(true);
    let status: GitStatus | null = null;
    try {
      status = await gitStatus(dir);
      setGitState(status);
    } catch (e) {
      notify("读取 Git 状态失败：" + String(e));
      setGitLoading(false);
      return;
    }
    setGitLoading(false);
    if (!status?.ok) {
      notify(status?.message || "这个目录不是 Git 仓库");
      return;
    }

    const name = dir.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || dir;
    const shell = settings.defaultShell;
    const existing = profiles.find((p) => p.type === "local" && p.local?.cwd === dir);
    if (!existing) {
      const profile: ConnectionProfile = {
        id: uid(),
        type: "local",
        name: `${name} · git`,
        group: "Git 工作空间",
        local: { shell, cwd: dir },
      };
      try {
        await saveProfile(profile);
        await refresh();
      } catch (e) {
        notify("保存工作空间失败：" + String(e));
      }
    }
    await openLocalSession(shell, undefined, dir, `${name} · git`);
    notify(`已在 ${dir} 打开 Git 工作空间（终端 + git 命令行）`);
  }

  async function removeGitWorkspace(p: ConnectionProfile) {
    try {
      await deleteProfile(p.id);
      await refresh();
    } catch (e) {
      notify("删除失败：" + String(e));
    }
  }

  /** 在一个目录里新建 git 仓库（git init），然后存成工作空间并开终端 */
  async function createGitRepo(rawPath: string) {
    const dir = rawPath.trim();
    if (!dir) {
      notify("请先填要创建仓库的目录，例如 D:\\code\\my-repo");
      return;
    }
    try {
      await gitInit(dir, true);
    } catch (e) {
      notify("git init 失败：" + String(e));
      return;
    }
    setGitInitDialog(null);
    setGitPath(dir);
    try {
      setGitState(await gitStatus(dir));
    } catch {
      /* 刚 init 的仓库状态读不到也无所谓 */
    }
    const name = dir.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || dir;
    const shell = settings.defaultShell;
    if (!profiles.some((p) => p.type === "local" && p.local?.cwd === dir)) {
      try {
        await saveProfile({
          id: uid(),
          type: "local",
          name: `${name} · git`,
          group: "Git 工作空间",
          local: { shell, cwd: dir },
        });
        await refresh();
      } catch (e) {
        notify("保存工作空间失败：" + String(e));
      }
    }
    await openLocalSession(shell, undefined, dir, `${name} · git`);
    notify(`已在 ${dir} 建好仓库并打开终端（可以 git add . 然后 commit）`);
  }

  /** 在某个目录直接开一个新的本地终端（Git 面板用） */
  async function openGitTerminal(dir: string, title?: string) {
    if (!dir.trim()) {
      notify("先选一个仓库目录");
      return;
    }
    await openLocalSession(settings.defaultShell, undefined, dir, title);
  }

  /** 远程会话意外断开时自动重连（会重新附加 tmux），最多 5 次指数退避。 */
  function scheduleReconnect(sessionId: string) {
    const s = sessionsRef.current.find((x) => x.id === sessionId);
    if (!s || !s.profileId) return;
    // herdr 窗格会话**不自动重连**：
    // - 只读观察窗的流断了多半是"窗格/她的 server 那边的事"，立刻重连也是再断一次；
    // - 可写那条更危险：它带 `--takeover`，自动重连会把控制权从"刚接管的那个客户端"手里
    //   抢回来，变成两边互相抢（用户明确说过不要跟别的客户端打架）。
    // 所以这类会话只标成"已断开"，要重开就手动点标签上的 ↻（那条路会按 herdr 的方式重开）。
    if (s.herdrPane) return;
    if (!settings.autoReconnect) return;
    const tries = reconnectTries.current[sessionId] ?? 0;
    if (tries >= 5) {
      notify("自动重连已尝试 5 次，先停下。点标签上的 ↻ 可以手动重试。");
      return;
    }
    reconnectTries.current[sessionId] = tries + 1;
    const delay = Math.min(3000 * (tries + 1), 15000);
    setSessions((prev) =>
      prev.map((x) => (x.id === sessionId ? { ...x, state: "reconnecting" } : x)),
    );
    window.clearTimeout(reconnectTimers.current[sessionId]);
    reconnectTimers.current[sessionId] = window.setTimeout(() => {
      void doReconnect(sessionId);
    }, delay);
  }

  async function doReconnect(sessionId: string) {
    const s = sessionsRef.current.find((x) => x.id === sessionId);
    if (!s || !s.profileId) return;
    // herdr 窗格：照原样重开（同一个窗格、同一种打开方式）
    if (s.herdrPane) {
      try {
        await sessionClose(sessionId);
      } catch {
        /* 已经断开 */
      }
      setSessions((prev) =>
        prev.map((x) => (x.id === sessionId ? { ...x, state: "connecting" } : x)),
      );
      try {
        await openSsh(
          sessionId,
          s.profileId,
          (e) => handleEvent(sessionId, e),
          "name",
          s.herdrPane,
          undefined,
          undefined,
          s.user ?? null,
          s.herdrMode === "control" ? "herdr-control" : "herdr-pane",
        );
        if (s.herdrMode !== "control") {
          await ensureHerdrInput(sessionId, s.profileId, s.user ?? null, s.herdrPane);
        }
      } catch (e) {
        notify("重开这个 herdr 窗格失败：" + String(e));
      }
      return;
    }
    try {
      await sessionClose(sessionId);
    } catch {
      /* 已经断开 */
    }
    try {
      await openSsh(
        sessionId,
        s.profileId,
        (e) => handleEvent(sessionId, e),
        s.tmuxMode ?? "default",
        s.tmuxName ?? null,
      );
      reconnectTries.current[sessionId] = 0;
    } catch {
      scheduleReconnect(sessionId);
    }
  }

  /** 用「串口连接」里存好的参数打开一个串口终端 */
  async function openSerialSession(profile: ConnectionProfile) {
    const cfg = profile.serial;
    if (!cfg?.path) {
      notify("这个串口连接没有配置端口");
      return "";
    }
    const id = uid();
    addSession({
      id,
      title: profile.name,
      kind: "serial",
      state: "connecting",
      openFiles: [],
      activeTab: "terminal",
    });
    maybeAutoLog({ id, title: profile.name });
    try {
      const info = await openSerial(id, cfg.path, cfg.baudRate, (e) => handleEvent(id, e), {
        dataBits: cfg.dataBits,
        stopBits: cfg.stopBits,
        parity: cfg.parity,
        flowControl: cfg.flowControl,
      });
      setSessions((prev) =>
        prev.map((s) => (s.id === id ? { ...s, title: profile.name || info.title || s.title } : s)),
      );
    } catch (e) {
      notify("打开串口失败：" + String(e));
      setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, state: "error" } : s)));
    }
    return id;
  }

  async function openAdbSession(serial: string, mode: "shell" | "logcat" = "shell") {
    const id = uid();
    addSession({
      id,
      title: mode === "logcat" ? `logcat · ${serial}` : `ADB · ${serial}`,
      kind: "adb",
      state: "connecting",
      openFiles: [],
      activeTab: "terminal",
    });
    maybeAutoLog({
      id,
      title: mode === "logcat" ? `logcat-${serial}` : `adb-${serial}`,
    });
    try {
      await openAdbShell(id, serial, (e) => handleEvent(id, e), undefined, undefined, mode);
    } catch (e) {
      notify(`打开 ${mode === "logcat" ? "logcat" : "ADB shell"} 失败：` + String(e));
      setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, state: "error" } : s)));
    }
  }

  // ---------- ADB 文件管理 ----------

  function joinRemote(dir: string, name: string) {
    return `${dir.replace(/\/+$/, "")}/${name}`;
  }

  async function refreshAdbFiles(serial: string, path: string) {
    setAdbLoading(true);
    try {
      setAdbFiles(await adbLs(serial, path));
      setAdbPath(path);
    } catch (e) {
      notify("读取设备目录失败：" + String(e));
      setAdbFiles([]);
    } finally {
      setAdbLoading(false);
    }
  }

  async function adbUpload(serial: string) {
    const picked = await openLocalDialog({
      multiple: true,
      title: "选择要推送到设备的文件",
    });
    if (!picked) return;
    const paths = Array.isArray(picked) ? picked : [picked];
    try {
      notify(await adbPush(serial, paths, adbPath));
      await refreshAdbFiles(serial, adbPath);
    } catch (e) {
      notify("推送失败：" + String(e));
    }
  }

  async function adbDownload(serial: string, name: string) {
    const dir = await openLocalDialog({ directory: true, title: `选择保存「${name}」的目录` });
    if (!dir || Array.isArray(dir)) return;
    try {
      notify(await adbPull(serial, joinRemote(adbPath, name), dir));
    } catch (e) {
      notify("下载失败：" + String(e));
    }
  }

  async function adbMkdirNow(serial: string, name: string) {
    const target = joinRemote(adbPath, name.trim());
    if (!name.trim()) return;
    try {
      await adbMkdir(serial, target);
      setAdbNewName("");
      await refreshAdbFiles(serial, adbPath);
      notify(`已在设备上新建 ${target}`);
    } catch (e) {
      notify("新建文件夹失败：" + String(e));
    }
  }

  async function adbDelete(serial: string, name: string, isDir: boolean) {
    try {
      await adbRm(serial, joinRemote(adbPath, name), isDir);
      await refreshAdbFiles(serial, adbPath);
      notify(`已删除 ${name}`);
    } catch (e) {
      notify("删除失败：" + String(e));
    }
  }

  function relTime(secs: number): string {
    if (!secs) return "";
    const diff = Math.max(0, Math.floor(Date.now() / 1000) - secs);
    if (diff < 60) return "刚刚";
    if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
    return `${Math.floor(diff / 86400)} 天前`;
  }

  async function updateSettings(patch: Partial<AppSettings>) {
    // 基于 settingsRef（最新值）合并，而不是闭包里的 settings。
    // 后者在"同一拍里连着改两次设置"时，第二次会拿渲染时的旧对象去覆盖第一次的结果
    // （典型：外观对话框里连着调 updateSettings + setLookSet）。
    // 顺手把 ref 也更新掉，这样同一拍内的下一次调用能立刻看到这一次的结果。
    const next = { ...settingsRef.current, ...patch };
    settingsRef.current = next;
    setSettings(next);
    try {
      await settingsSet(next);
    } catch (e) {
      notify("保存设置失败：" + String(e));
    }
  }

  function bumpFont(delta: number) {
    applyFontSize(currentFontSize() + delta);
  }

  /** 当前字号：优先用"还没落盘的临时值"，保证滚轮连点时每次都在前一档上加减 */
  function currentFontSize(): number {
    return fontRef.current ?? settingsRef.current.fontSize ?? 13;
  }

  /**
   * 立刻改字号（界面马上生效），落盘延后 400ms。
   *
   * 为什么不一格一格直接写设置：`Ctrl + 鼠标滚轮` 一滚就是十几次事件，
   * 每次都写一遍 settings.json 既没必要也伤盘。
   */
  function applyFontSize(next: number) {
    const v = Math.min(26, Math.max(8, next));
    if (v === currentFontSize()) return;
    fontRef.current = v;
    setSettings((s) => ({ ...s, fontSize: v }));
    if (fontSaveTimer.current !== null) window.clearTimeout(fontSaveTimer.current);
    fontSaveTimer.current = window.setTimeout(() => {
      fontSaveTimer.current = null;
      fontRef.current = null;
      void settingsSet({ ...settingsRef.current }).catch((e) =>
        notify("保存字号失败：" + String(e)),
      );
    }, 400);
  }

  function clearActiveTerminal() {
    if (!activeSession) {
      notify("当前没有会话");
      return;
    }
    void sessionWrite(activeSession.id, bytesToB64(new TextEncoder().encode("\u000c")));
  }

  /**
   * 检查更新。
   *
   * - 手动点按钮（设置 / 关于对话框）→ `silent` 不传，界面会写"正在检查 / 已是最新"；
   * - 后台自动检查 → `silent: true`：成功不吭声（只在发现新版时亮小红点），
   *   失败也不吭声（没网是常态，不该拿红色报错烦人）。
   */
  async function checkForUpdates(opts?: { silent?: boolean }) {
    const silent = opts?.silent === true;
    const url = settingsRef.current.updateUrl.trim();
    if (!url) {
      if (!silent) setUpdateMsg("请先填写更新源地址（返回 JSON，含 tag_name 或 version 字段）。");
      return;
    }
    if (!silent) {
      setUpdateBusy(true);
      setUpdateMsg("正在检查…");
    }
    setUpdateOffer(null);
    try {
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as Record<string, unknown>;
      const latest = String(data.tag_name ?? data.version ?? data.latest ?? "")
        .replace(/^v/i, "")
        .trim();
      if (!latest) throw new Error("返回内容里没有 tag_name / version 字段");
      // 记录检查时间：自动检查靠它做节流（不要每次开窗都去问 GitHub）
      const stamp = Math.floor(Date.now() / 1000);
      if (Math.abs((settingsRef.current.lastUpdateCheck ?? 0) - stamp) > 60) {
        void updateSettings({ lastUpdateCheck: stamp });
      }
      if (compareVersion(latest, APP_VERSION) <= 0) {
        if (!silent) setUpdateMsg(`已是最新版本（${APP_VERSION}）`);
        return;
      }
      // 用户明确说过"这个版本我暂时不升"→ 不再闪小红点（手动检查时仍然显示）
      if (silent && latest === settingsRef.current.ignoredUpdateVersion) return;
      // 从 release 里挑出三种产物：NSIS 安装包 / MSI / 便携版 zip。
      // 一键升级要用哪一个是按"当前这份是怎么装上的"决定的（见 update_install_kind）。
      const assets = (Array.isArray(data.assets) ? data.assets : []) as Asset[];
      const find = (test: (n: string) => boolean) =>
        assets.find((a) => test(String(a.name ?? "").toLowerCase()));
      const setup =
        find((n) => n.endsWith(".exe") && n.includes("setup")) ?? find((n) => n.endsWith(".exe"));
      const msi = find((n) => n.endsWith(".msi"));
      const zip = find((n) => n.endsWith(".zip"));
      const pageUrl = String(data.html_url ?? url);
      setUpdateOffer({
        version: latest,
        installerUrl: setup?.browser_download_url ?? "",
        installerSize: setup?.size ?? 0,
        installerSha: setup?.digest ?? "",
        msiUrl: msi?.browser_download_url ?? "",
        msiSize: msi?.size ?? 0,
        msiSha: msi?.digest ?? "",
        zipUrl: zip?.browser_download_url ?? "",
        pageUrl,
      });
      setUpdateMsg(`发现新版本 ${latest}（当前 ${APP_VERSION}）`);
      if (silent) notify(`发现新版本 ${latest}，在「设置 → 检查更新」里可以一键下载`);
    } catch (e) {
      if (!silent) setUpdateMsg("检查失败：" + String(e));
    } finally {
      if (!silent) setUpdateBusy(false);
    }
  }

  /**
   * 当前会话对应的 tmux 会话名（普通 shell 会话是空串）。
   * 「tmux 快捷操作」面板只在这个不为空时出现。
   */
  const curTmuxSession = activeSession?.tmuxName ?? "";
  const curTmuxProfileId = activeSession?.profileId ?? "";

  /** 读一下这个 tmux 会话里现在有哪些窗口 */
  async function refreshTmuxWindows() {
    if (!curTmuxSession || !curTmuxProfileId) {
      setTmuxWinList([]);
      return;
    }
    try {
      const list = await tmuxWindows(
        curTmuxProfileId,
        curTmuxSession,
        activeSession?.user ?? null,
      );
      setTmuxWinList(list);
    } catch {
      // 读不到就先空着（服务器断开等），别拿红字刷状态栏
      setTmuxWinList([]);
    }
  }

  /**
   * 执行一个 tmux 快捷操作。
   *
   * 走的是另开一条 ssh 跑 `tmux xxx`，**不是**往终端里塞按键 ——
   * 所以不抢 Ctrl+B，也不受"当前窗格正在跑程序"的影响。
   */
  async function runTmuxAction(action: string, arg?: string) {
    if (!curTmuxSession || !curTmuxProfileId) return;
    setTmuxBusy(true);
    try {
      const out = await tmuxAction(
        curTmuxProfileId,
        curTmuxSession,
        action,
        arg ?? null,
        activeSession?.user ?? null,
      );
      if (out.trim()) notify(out.trim());
      await refreshTmuxWindows();
    } catch (e) {
      notify("tmux 操作失败：" + String(e));
    } finally {
      setTmuxBusy(false);
    }
  }

  /**
   * 执行一个 herdr 快捷操作。
   *
   * 和上面 tmux 那条完全同构：**另开一条 ssh 跑 herdr 的白名单动作**，
   * 不往终端里塞按键 —— 既不抢快捷键，也不管窗格里此刻在跑什么。
   */
  async function runHerdrAction(action: string, arg?: string) {
    const pane = activeSession?.herdrPane;
    const pid = activeSession?.profileId;
    if (!pane || !pid) return;
    setHerdrArmed(null);
    setHerdrBusy(true);
    try {
      const out = await herdrPaneAction(pid, pane, action, arg ?? null, activeSession?.user ?? null);
      if (out.trim()) notify(out.trim());
      // 分屏/新建工作区/关掉之后，服务那边的窗格数就变了 —— 顺手刷一下
      void refreshHerdrServer(pid, activeSession?.user ?? null);
    } catch (e) {
      notify("herdr 操作失败：" + String(e));
    } finally {
      setHerdrBusy(false);
    }
  }

  /**
   * 切到别的 tmux 会话、或者把面板展开时，读一次窗口列表。
   *
   * 以前这里每 10 秒对一次表（"你在终端里自己按 Ctrl+B 切了窗口，面板也能跟上"），
   * 但那等于每分钟 6 次 ssh + tmux 子进程，属于用户明确要砍掉的"周期性探测"。
   * 现在只在用户动作（切会话 / 展开面板）时读一次；想手动同步就点列表右边那个 ↻。
   */
  useEffect(() => {
    if (!curTmuxSession || !tmuxDockOpen) {
      setTmuxWinList([]);
      return;
    }
    deferUntilIdle(() => void refreshTmuxWindows());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curTmuxSession, curTmuxProfileId, tmuxDockOpen]);

  /**
   * 点活动栏图标（VS Code 的行为，而不是"只能切模块"）：
   * - 点的就是当前这个模块，且侧栏正展开 → **折叠**侧栏；
   * - 其它情况（点了别的模块，或侧栏本来收着）→ 切到该模块并**展开**侧栏。
   *
   * 所以"藏/显示侧栏"不用再专门去「视图」菜单点，日常顺手点图标就行；
   * 视图菜单里那一项保留，作为备选入口。
   */
  function activateModule(key: ModuleKey) {
    if (module === key && showSidebar) {
      setShowSidebar(false);
      return;
    }
    setModule(key);
    if (key !== "remote") setSideTab("sessions");
    setShowSidebar(true);
  }

  /** 打开更新相关的外链（走系统浏览器），失败只写底部状态栏 */
  async function openUpdateLink(url: string, what: string) {
    try {
      await openExternalUrl(url);
    } catch (e) {
      notify(`打开${what}失败：` + String(e));
    }
  }

  /** 设置里显示"当前终端配色"用 */
  function currentTermSchemeName(): string {
    if (settings.termScheme === CUSTOM_SCHEME_KEY) return "自定义";
    return TERM_SCHEMES.find((s) => s.key === settings.termScheme)?.name ?? "VS Code 深色（默认）";
  }

  /** 选择会话日志目录（空 = 用默认位置） */
  async function pickLogDir() {
    const dir = await openLocalDialog({
      directory: true,
      title: "选择会话日志保存目录",
    });
    if (!dir || Array.isArray(dir)) return;
    await updateSettings({ logDir: dir });
    notify("日志目录已改为 " + dir);
  }

  /** 打开目录（查看已经写下去的日志） */
  async function openLogDir() {
    try {
      const dir = await sessionLogDir();
      await openInExplorer(dir);
    } catch (e) {
      notify("打开日志目录失败：" + String(e));
    }
  }

  /** 用户选择「忽略此版本」：记住版本号，之后自动检查不再为它亮小红点 */
  function ignoreUpdateVersion(version: string) {
    void updateSettings({ ignoredUpdateVersion: version });
    setUpdateOffer(null);
    setUpdateMsg(`已忽略 ${version}，等下一个版本再提醒`);
  }

  /**
   * 一键升级：下载新版安装包 → 校验 → 静默覆盖安装 → 自动重启。
   *
   * - 安装版（NSIS）：`安装包 /S /R`，全程无窗口，装完自己把应用拉起来；
   * - MSI 版：`msiexec /i ... /qb /norestart`，会弹一次 UAC（因为 MSI 是 perMachine）；
   * - 便携版：没有覆盖安装这一说，按钮会退化成"下载 zip 手动替换"。
   */
  async function runOneClickUpgrade() {
    if (!updateOffer) return;
    const isMsi = installKind === "msi";
    const url = isMsi ? updateOffer.msiUrl : updateOffer.installerUrl;
    const expected = isMsi ? updateOffer.msiSize : updateOffer.installerSize;
    const sha = isMsi ? updateOffer.msiSha : updateOffer.installerSha;
    if (!url) {
      notify(isMsi ? "这个版本没有提供 MSI 安装包" : "这个版本没有提供安装包，请打开发布页");
      return;
    }
    setUpdateApplying(true);
    notify(`正在下载 ${updateOffer.version} 安装包…下载进度见右下角`);
    try {
      await updateDownloadInstall(url, expected, updateOffer.version, sha || null);
      notify(
        isMsi
          ? `已开始升级到 ${updateOffer.version}（MSI 安装可能会弹一次 UAC，请点“是”）`
          : `已开始安装 ${updateOffer.version}，应用会自动重启`,
      );
    } catch (e) {
      notify("一键升级失败：" + String(e));
      setUpdateApplying(false);
    }
  }

  /**
   * 「检查更新」区块 —— 设置对话框和关于对话框共用同一套 UI，
   * 免得两个地方行为不一致（这也是上一版"看到新版本却没地方点"的根因）。
   */
  function renderUpdateSection() {
    // 只有"安装版"才能一键覆盖升级：NSIS 走 setup.exe，MSI 走 msiexec；便携版只能手动替换
    const canOneClick =
      (installKind === "nsis" && !!updateOffer?.installerUrl) ||
      (installKind === "msi" && !!updateOffer?.msiUrl);
    return (
      <>
        <label className="modal-field">
          更新源（返回 JSON 的地址，含 tag_name 或 version 字段）
          <input
            value={settings.updateUrl}
            placeholder="https://api.github.com/repos/you/zeeai-terminal/releases/latest"
            onChange={(e) => void updateSettings({ updateUrl: e.target.value })}
          />
        </label>
        <div className="modal-inline-action">
          <button
            type="button"
            className="mini-btn"
            disabled={updateBusy}
            onClick={() => void checkForUpdates()}
          >
            {updateBusy ? "检查中…" : "检查更新"}
          </button>
          <span className="hint" style={{ padding: "0 0 0 8px" }}>
            当前版本 {APP_VERSION}
          </span>
          {updateMsg && <div className="hint">{updateMsg}</div>}
        </div>
        {updateOffer && (
          <>
            {canOneClick ? (
              <div className="modal-inline-action" style={{ marginTop: 6 }}>
                <button
                  type="button"
                  className="btn primary"
                  disabled={updateApplying}
                  onClick={() => void runOneClickUpgrade()}
                  title={
                    installKind === "msi"
                      ? "下载 MSI 后静默升级并自动重启（会弹一次 UAC）"
                      : "下载安装包后静默覆盖安装并自动重启"
                  }
                >
                  {updateApplying
                    ? "正在下载更新包…"
                    : installKind === "msi"
                      ? `一键升级到 ${updateOffer.version}（会弹 UAC）`
                      : `一键升级到 ${updateOffer.version} 并重启`}
                </button>
                <button
                  type="button"
                  className="mini-btn"
                  onClick={() => void openUpdateLink(updateOffer.pageUrl, "发布页")}
                >
                  打开发布页
                </button>
                <button
                  type="button"
                  className="mini-btn"
                  onClick={() => ignoreUpdateVersion(updateOffer.version)}
                >
                  忽略此版本
                </button>
              </div>
            ) : (
              <div className="modal-inline-action" style={{ marginTop: 6 }}>
                {updateOffer.zipUrl && (
                  <button
                    type="button"
                    className="btn primary"
                    onClick={() => void openUpdateLink(updateOffer.zipUrl, "便携版下载")}
                  >
                    {`下载便携版 ${updateOffer.version}`}
                  </button>
                )}
                {updateOffer.installerUrl && (
                  <button
                    type="button"
                    className="mini-btn"
                    onClick={() => void openUpdateLink(updateOffer.installerUrl, "安装包下载")}
                  >
                    下载安装包
                  </button>
                )}
                <button
                  type="button"
                  className="mini-btn"
                  onClick={() => void openUpdateLink(updateOffer.pageUrl, "发布页")}
                >
                  打开发布页
                </button>
                <button
                  type="button"
                  className="mini-btn"
                  onClick={() => ignoreUpdateVersion(updateOffer.version)}
                >
                  忽略此版本
                </button>
              </div>
            )}
            <div className="hint">
              {canOneClick
                ? installKind === "msi"
                  ? "MSI 是给企业批量部署用的（装在 Program Files，需要管理员），所以升级时会弹一次 UAC 授权；升级过程会自动结束当前应用并在装完后重新打开。"
                  : "会静默完成覆盖安装并自动重启应用；tmux 会话不受影响，重开后可以重新附加。"
                : "当前是便携版：解压在哪个目录就替换哪个目录里的文件即可，配置不会丢。"}
            </div>
          </>
        )}
      </>
    );
  }

  /**
   * 以管理员身份重启整个应用。
   *
   * 为什么不是"只提权某一个标签页"：终端是我们用 ConPTY 建的，伪控制台和管道都挂在
   * 我们这个普通权限进程上，Windows 不允许管理员子进程挂进来。所以走"整个应用提权"
   * （Windows Terminal 的「以管理员身份运行」也是这个模型）：过一次 UAC，之后开的
   * PowerShell / CMD / WSL **天然都是管理员**。
   */
  async function doRestartAsAdmin() {
    if (isAdminMode) {
      notify("当前已经是管理员模式了");
      return;
    }
    try {
      await restartAsAdmin();
      notify("正在以管理员身份重启…请在 UAC 窗口里点「是」");
    } catch (e) {
      notify("以管理员身份重启失败：" + String(e));
    }
  }

  /** 折中方案：以管理员身份单独开一个 PowerShell / CMD 窗口（独立窗口，不在标签里） */
  async function doOpenAdminShell(shell: "powershell" | "cmd") {
    try {
      await openAdminShell(shell);
      notify(
        `已请求打开管理员 ${shell === "cmd" ? "CMD" : "PowerShell"}（UAC 点「是」后会在独立窗口打开）`,
      );
    } catch (e) {
      notify("打开管理员终端失败：" + String(e));
    }
  }

  function buildMenus(): { key: string; label: string; items: MenuItem[] }[] {
    const openConnectionForm = () => {
      setModule("remote");
      setSideTab("sessions");
      openEditDialog();
    };
    return [
      {
        key: "file",
        label: "文件",
        items: [
          { sep: false, label: "新建会话…", action: () => openNewSessionDialog() },
          { sep: false, label: "新建连接", action: openConnectionForm },
          { sep: true },
          {
            sep: false,
            label: "退出",
            action: () => {
              void getCurrentWindow().close();
            },
          },
        ],
      },
      {
        key: "edit",
        label: "编辑",
        items: [
          { sep: false, label: "清空当前终端", action: clearActiveTerminal },
          {
            sep: false,
            label: "重新连接当前会话",
            action: () => {
              if (activeSession) void reconnectSession(activeSession);
            },
          },
        ],
      },
      {
        key: "view",
        label: "视图",
        items: [
          // 快捷键提示写进标签，顺便当教学（Ctrl + 滚轮 也管用）
          { sep: false, label: "放大字体（Ctrl + ＋）", action: () => bumpFont(1) },
          { sep: false, label: "缩小字体（Ctrl + －）", action: () => bumpFont(-1) },
          { sep: false, label: "重置字体（Ctrl + 0）", action: () => applyFontSize(13) },
          // 配色和关键字高亮在同一个对话框里（"作用范围"里可以按终端类型分开设）
          { sep: false, label: "终端配色与关键字高亮…", action: () => setShowTermTheme(true) },
          { sep: true },
          {
            sep: false,
            // 更贴近 VS Code 的说法；日常其实直接点左侧图标就能折叠/展开
            label: showSidebar ? "折叠侧栏" : "展开侧栏",
            action: () => setShowSidebar((v) => !v),
          },
          { sep: true },
          {
            sep: false,
            label: `${paneLayout === "single" ? "● " : ""}单窗格（不分割）`,
            action: () => setPaneLayout("single"),
          },
          {
            sep: false,
            label: `${paneLayout === "v2" ? "● " : ""}左右两分屏`,
            action: () => setPaneLayout("v2"),
          },
          {
            sep: false,
            label: `${paneLayout === "h2" ? "● " : ""}上下两分屏`,
            action: () => setPaneLayout("h2"),
          },
          {
            sep: false,
            label: `${paneLayout === "v3" ? "● " : ""}三分屏（竖排三列）`,
            action: () => setPaneLayout("v3"),
          },
          {
            sep: false,
            label: `${paneLayout === "grid4" ? "● " : ""}四分屏（2×2）`,
            action: () => setPaneLayout("grid4"),
          },
          { sep: true },
          {
            sep: false,
            label: settings.theme === "dark" ? "切换到浅色主题" : "切换到深色主题",
            action: () =>
              void updateSettings({ theme: settings.theme === "dark" ? "light" : "dark" }),
          },
        ],
      },
      {
        key: "conn",
        label: "连接",
        items: [
          { sep: false, label: "新建会话…", action: () => openNewSessionDialog() },
          { sep: false, label: "新建服务器…", action: openConnectionForm },
          { sep: false, label: "服务器管理…", action: () => setShowServers(true) },
          { sep: true },
          { sep: false, label: "设置…", action: () => setShowSettings(true) },
        ],
      },
      {
        key: "term",
        label: "终端",
        items: [
          {
            sep: false,
            label: `新建默认终端（${SHELL_LABEL[settings.defaultShell]}）`,
            action: () => void openLocalSession(settings.defaultShell),
          },
          { sep: false, label: "新建 PowerShell", action: () => void openLocalSession("powershell") },
          {
            sep: false,
            label: "新建 PowerShell 7（pwsh）",
            action: () => void openLocalSession("pwsh"),
          },
          { sep: false, label: "新建 CMD", action: () => void openLocalSession("cmd") },
          { sep: false, label: "新建 WSL", action: () => void openLocalSession("wsl") },
          { sep: true },
          {
            sep: false,
            label: isAdminMode
              ? "已以管理员身份运行（本地终端都是管理员）"
              : "以管理员身份重启…（UAC；之后本地终端都是管理员）",
            action: () => void doRestartAsAdmin(),
          },
          {
            sep: false,
            label: "以管理员身份打开 PowerShell（独立窗口）",
            action: () => void doOpenAdminShell("powershell"),
          },
          {
            sep: false,
            label: "以管理员身份打开 CMD（独立窗口）",
            action: () => void doOpenAdminShell("cmd"),
          },
          { sep: true },
          {
            sep: false,
            label: "关闭当前会话",
            action: () => {
              if (activeId) void closeSession(activeId);
            },
          },
          {
            sep: false,
            label: `关闭全部本地终端（${localTerminals.length}）`,
            action: () => void closeSessions(localTerminals, "本地终端"),
          },
          {
            sep: false,
            label: `关闭全部会话（${sessions.length}，含 SSH）`,
            action: () => void closeSessions(sessions, "会话"),
          },
        ],
      },
      {
        key: "help",
        label: "帮助",
        items: [{ sep: false, label: "关于 ZeeAI Term", action: () => setShowAbout(true) }],
      },
    ];
  }

  /**
   * 刷新文件面板。
   * 打开「跟随终端目录」时，会去问 tmux 这个会话的 pane 当前在哪个目录
   * （就是你终端里 `pwd` 的那个），然后直接列那里——这样在终端里 cd 完，
   * 点一下刷新文件列表就跟过去了，不用手输路径。
   */
  /**
   * 问终端要当前目录。两条路：
   * 1) shell 自己用 OSC 7 上报过（普通 shell 也有）→ 直接用；
   * 2) tmux 会话 → 问 tmux 的 pane_current_path。
   * 都拿不到就返回 null。
   */
  async function resolveTerminalCwd(
    profileId: string,
    tmuxName?: string,
    cwd?: string,
  ): Promise<string | null> {
    if (cwd) return cwd;
    if (!tmuxName) return null;
    try {
      return await remotePwd(profileId, tmuxName, activeUserRef.current ?? null);
    } catch {
      return null;
    }
  }

  /** 切换会话时自动同步（受「跟随终端」开关控制） */
  async function refreshFs(
    profileId: string,
    tmuxName?: string,
    cwd?: string,
    fallback?: string,
  ) {
    if (!settings.fsFollowTerminal) {
      await loadDir(profileId, fallback);
      return;
    }
    const target = await resolveTerminalCwd(profileId, tmuxName, cwd);
    await loadDir(profileId, target ?? fallback);
  }

  /** 「同步终端目录」按钮：一键跳到终端当前所在目录 */
  async function syncFsToTerminal(
    profileId: string,
    tmuxName?: string,
    cwd?: string,
  ) {
    const target = await resolveTerminalCwd(profileId, tmuxName, cwd);
    if (!target) {
      notify("这个会话还没上报工作目录：在终端里按一下回车，或先 cd 一次再点同步");
      return;
    }
    await loadDir(profileId, target);
    notify(`已同步到终端目录：${target}`);
  }

  async function loadDir(profileId: string, path?: string) {
    setFsLoading(true);
    try {
      const listing = await fsList(profileId, path, activeUserRef.current ?? null);
      setFsPath(listing.path);
      setFsInput(listing.path);
      setFsEntries(listing.entries);
    } catch (e) {
      notify("读取远端目录失败：" + String(e));
      setFsEntries([]);
    } finally {
      setFsLoading(false);
    }
  }

  async function openRemoteFile(
    profileId: string,
    name: string,
    sessionIdOverride?: string,
  ) {
    const sessionId = sessionIdOverride ?? activeId;
    if (!sessionId) {
      notify("请先打开一个 SSH 会话");
      return;
    }
    const path = joinPath(fsPathRef.current, name);
    const kind = fileKind(name);
    try {
      const b64 = await fsRead(profileId, path, 1024 * 1024, activeUserRef.current ?? null);
      if (!b64) {
        notify("文件为空或无法读取（可能是目录或二进制文件）");
        return;
      }
      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== sessionId) return s;
          const exists = s.openFiles.some((f) => f.path === path);
          const openFiles = exists ? s.openFiles : [...s.openFiles, { name, path, kind, b64 }];
          return { ...s, openFiles, activeTab: name };
        }),
      );
    } catch (e) {
      notify("读取文件失败：" + String(e));
    }
  }

  function selectTab(sessionId: string, tab: string) {
    setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, activeTab: tab } : s)));
  }

  /** 上传本机文件/文件夹到当前远端目录 */
  async function uploadToRemote(profileId: string) {
    const picked = await openLocalDialog({
      multiple: true,
      title: "选择要上传到服务器的文件（可多选；选中的文件夹会整个上传）",
    });
    if (!picked) return;
    const localPaths = Array.isArray(picked) ? picked : [picked];
    if (localPaths.length === 0) return;
    setFsBusy(true);
    try {
      const msg = await fsUpload(
        profileId,
        localPaths,
        fsPathRef.current,
        activeUserRef.current ?? null,
        uid(),
      );
      notify(msg);
      await loadDir(profileId, fsPathRef.current);
    } catch (e) {
      notify("上传失败：" + String(e));
    } finally {
      setFsBusy(false);
    }
  }

  /** 把远端某个文件/目录下载到本机目录 */
  async function downloadFromRemote(profileId: string, name: string) {
    const dir = await openLocalDialog({
      directory: true,
      title: `选择保存「${name}」的本机目录`,
    });
    if (!dir || Array.isArray(dir)) return;
    setFsBusy(true);
    try {
      const msg = await fsDownload(
        profileId,
        [joinPath(fsPath, name)],
        dir,
        activeUserRef.current ?? null,
        uid(),
      );
      notify(msg);
    } catch (e) {
      notify("下载失败：" + String(e));
    } finally {
      setFsBusy(false);
    }
  }

  function closeFile(sessionId: string, name: string) {
    setSessions((prev) =>
      prev.map((s) => {
        if (s.id !== sessionId) return s;
        const openFiles = s.openFiles.filter((f) => f.name !== name);
        const activeTab = s.activeTab === name ? "terminal" : s.activeTab;
        return { ...s, openFiles, activeTab };
      }),
    );
  }

  /**
   * 给会话改名：既改标签上的名字，也写进会话历史，
   * 下次从「会话历史」点进来还是你起的名字。
   */
  async function renameSession(sessionId: string, rawName: string) {
    const title = rawName.trim();
    if (!title) {
      notify("会话名不能为空");
      return;
    }
    const s = sessionsRef.current.find((x) => x.id === sessionId);
    setSessions((prev) => prev.map((x) => (x.id === sessionId ? { ...x, title } : x)));
    if (!s?.profileId) {
      setSessionRename(null);
      return;
    }
    const p = profiles.find((x) => x.id === s.profileId);
    try {
      applyHistory(
        await historySave({
          id: "",
          profileId: s.profileId,
          profileName: p?.name ?? title,
          host: p?.ssh?.host ?? "",
          tmuxSession: s.tmuxName ?? null,
          title,
          lastUsed: 0,
        }),
      );
      notify(`会话已命名为「${title}」`);
    } catch (e) {
      notify("改名字失败：" + String(e));
    }
    setSessionRename(null);
  }

  /** 新建远端文件夹 / 重命名，共用一个输入弹窗 */
  async function confirmNameDialog() {
    if (!nameDialog) return;
    const value = nameDialog.value.trim();
    if (!value) {
      notify("名字不能为空");
      return;
    }
    const dir = nameDialog.dir;
    setFsBusy(true);
    try {
      if (nameDialog.mode === "mkdir") {
        await fsMkdir(nameDialog.profileId, joinPath(dir, value), activeUserRef.current ?? null);
        notify(`已新建 ${value}`);
      } else {
        await fsRename(
          nameDialog.profileId,
          joinPath(dir, nameDialog.from),
          joinPath(dir, value),
          activeUserRef.current ?? null,
        );
        notify(`已重命名为 ${value}`);
      }
      setNameDialog(null);
      await loadDir(nameDialog.profileId, dir);
    } catch (e) {
      notify("操作失败：" + String(e));
    } finally {
      setFsBusy(false);
    }
  }

  async function doRemoveRemote(profileId: string, name: string) {
    setFsBusy(true);
    try {
      await fsRemove(profileId, joinPath(fsPath, name), activeUserRef.current ?? null);
      notify(`已删除 ${name}`);
      await loadDir(profileId, fsPath);
    } catch (e) {
      notify("删除失败：" + String(e));
    } finally {
      setFsBusy(false);
    }
  }

  const grouped = useMemo(() => {
    const map = new Map<string, ConnectionProfile[]>();
    for (const p of profiles) {
      // 「已保存的服务器」只放 SSH 服务器；串口连接归串口面板自己管，
      // 不要混进服务器列表里，否则会让人以为是同一类东西。
      if (p.type !== "ssh") continue;
      const g = p.group || "默认";
      map.set(g, [...(map.get(g) ?? []), p]);
    }
    return Array.from(map.entries());
  }, [profiles]);

  /** 只有 SSH 服务器（给「新建会话」「服务器管理」用） */
  const sshProfiles = useMemo(() => profiles.filter((p) => p.type === "ssh"), [profiles]);

  /** 会话历史分组标题：只有一个分组时不显示（避免一行没意义的「默认」） */
  const showGroupHeaders = grouped.length > 1;

  /** 所有服务器的会话历史是不是都展开着（决定「展开/折叠全部」按钮显示哪个动作） */
  const allServersExpanded =
    sshProfiles.length > 0 && sshProfiles.every((p) => !collapsedServers.includes(p.id));

  /** 一键展开 / 折叠所有服务器的会话历史 */
  function toggleAllServers() {
    setCollapsedServers(allServersExpanded ? sshProfiles.map((p) => p.id) : []);
  }

  /** 用户自己建过的串口连接（不是系统里所有 COM 口） */
  const serialProfiles = useMemo(
    () => profiles.filter((p) => p.type === "serial" && !!p.serial?.path),
    [profiles],
  );

  /** 本地 Git 工作空间（type=local 且带 cwd） */
  const gitWorkspaces = useMemo(
    () => profiles.filter((p) => p.type === "local" && !!p.local?.cwd),
    [profiles],
  );

  /** 已经打开的本地终端（PowerShell / CMD / WSL） */
  const localTerminals = useMemo(
    () => sessions.filter((s) => s.kind === "powershell" || s.kind === "cmd" || s.kind === "wsl"),
    [sessions],
  );

  /** 当前生效的终端配色（视图 → 终端配色 里选的那套） */
  const termPalette = useMemo(
    () => resolveTermPalette(settings.termScheme, settings.termSchemeCustom),
    [settings.termScheme, settings.termSchemeCustom],
  );

  // ---------- 「终端配色」对话框：先选作用范围，再给这个范围配色 + 绑高亮规则集 ----------
  const lookScopes = useMemo(
    () => [
      // 只按"一种终端一个类型"分：SSH 就是 SSH，本地都算本地，不按单台设备再拆
      { key: "global", label: "全局默认（所有终端）" },
      { key: "kind:ssh", label: "远程 SSH" },
      { key: "kind:local", label: "本地终端（PowerShell / CMD / WSL）" },
      { key: "kind:serial", label: "串口设备" },
      { key: "kind:adb", label: "Android（ADB）" },
    ],
    [],
  );
  const lookKind = lookScope.startsWith("kind:") ? lookScope.slice(5) : "";
  /** 当前作用范围实际生效的配色（用作对话框里"当前"的显示） */
  const lookPalette = termPaletteFor(settings, undefined, lookKind || undefined);
  const lookScheme = termSchemeFor(settings, undefined, lookKind || undefined);
  /** 全局那套叫什么名字（「跟随全局」那一项要写出来，用户才知道会跟到哪套） */
  const globalSchemeName =
    TERM_SCHEMES.find((s) => s.key === settings.termScheme)?.name ?? settings.termScheme;
  /** 「按类型」这档现在是不是"跟随全局"（= 该类型没有自己的覆盖） */
  const kindFollowsGlobal = !!lookKind && !(settings.termSchemeByKind?.[lookKind] ?? "").trim();

  /**
   * 作用范围 =「全局默认」、但**当前会话实际被更具体的层盖住**时，给对话框一行提示：
   * 现在真正生效的是哪套、是谁定的。
   *
   * 为什么要这一行：用户改完"全局默认"发现没反应 —— 因为这台机器/这一类终端早先钉过一套，
   * 而界面对此一个字都不说（实测踩过：2 分钟里连试 5 套主题以为坏了）。
   */
  /**
   * 「按类型」那档的「跟随全局」：删掉该类型的覆盖，回到全局那套
   */
  async function kindFollowGlobalNow() {
    if (!lookKind) return;
    const next = { ...(settings.termSchemeByKind ?? {}) };
    delete next[lookKind];
    void updateSettings({ termSchemeByKind: next });
  }

  /** 给当前作用范围（全局 / 某类终端）选配色方案 */
  async function setLookScheme(key: string, custom?: string) {
    if (lookKind) {
      void updateSettings({
        termSchemeByKind: { ...settings.termSchemeByKind, [lookKind]: key },
      });
      return;
    }
    // 这一档写的是「全局默认（所有终端）」—— 那就**真的**对所有终端生效：
    // 把"按类型"那几层的覆盖一并清掉。否则用户在这里改了、SSH 那边纹丝不动，
    // 只能看到"改了没反应"（用户实测报过）。
    // 单台机器自己钉的 `profile.termScheme` **不动** —— 那是"这台就这样"，
    // 留给「编辑服务器」里按需撤。
    const hadKindOverrides = Object.keys(settings.termSchemeByKind ?? {}).length > 0;
    void updateSettings({
      termScheme: key,
      ...(custom !== undefined ? { termSchemeCustom: custom } : {}),
      ...(hadKindOverrides ? { termSchemeByKind: {} } : {}),
    });
    if (hadKindOverrides) notify("已同步到所有终端类型（原来的按类型配色已清掉）");
  }

  /** 给当前作用范围（某类终端）绑高亮规则集 */
  async function setLookSet(id: string) {
    if (lookKind) {
      void updateSettings({
        highlightSetByKind: { ...settings.highlightSetByKind, [lookKind]: id },
      });
    }
  }

  // ---------- 分屏 ----------
  const paneSlots = useMemo(() => {
    const n = paneCount(paneLayout);
    const out: (string | null)[] = [];
    for (let i = 0; i < n; i++) out.push(panes[i] ?? null);
    return out;
  }, [panes, paneLayout]);

  // 命令面板的过滤结果。必须在 localTerminals 等所有 const 之后才算，
  // 因为 buildMenus() 会读它们（提前读会 TDZ 报错、整页黑屏）。
  const paletteItems = useMemo(() => {
    const q = paletteQuery.trim().toLowerCase();
    const all = allCommands();
    if (!q) return all;
    return all.filter(
      (c) => c.label.toLowerCase().includes(q) || c.group.toLowerCase().includes(q),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paletteQuery, sessions, profiles, paneLayout, settings, showSidebar, activeId]);

  // 布局变化：保留还能用的格子，把当前会话放进去
  useEffect(() => {
    if (paneLayout === "single") return;
    setPanes((prev) => {
      const n = paneCount(paneLayout);
      const next: (string | null)[] = [];
      const used = new Set<string>();
      for (let i = 0; i < n; i++) {
        const sid = prev[i] ?? null;
        if (sid && sessions.some((s) => s.id === sid) && !used.has(sid)) {
          next.push(sid);
          used.add(sid);
        } else {
          next.push(null);
        }
      }
      if (activeId && !used.has(activeId)) {
        const empty = next.findIndex((x) => x === null);
        next[empty >= 0 ? empty : 0] = activeId;
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneLayout, sessions.length]);

  // 当前会话被切换时，让它出现在某个窗格里
  useEffect(() => {
    if (paneLayout === "single" || !activeId) return;
    setPanes((prev) => {
      const n = paneCount(paneLayout);
      const next = [...prev];
      while (next.length < n) next.push(null);
      if (next.includes(activeId)) return next;
      const empty = next.findIndex((x) => x === null);
      next[empty >= 0 ? empty : Math.min(focusedPane, n - 1)] = activeId;
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, paneLayout, focusedPane]);

  // 把 git status 的结果拆成「已暂存」「未暂存/未跟踪」两组（VS Code 那种分法）
  const stagedFiles = useMemo(() => {
    if (!gitState?.ok) return [];
    const seen = new Set<string>();
    const out: { path: string; st: string }[] = [];
    for (const f of gitState.files) {
      const idx = f.status[0] ?? " ";
      if (idx !== " " && idx !== "?" && !seen.has(f.path)) {
        seen.add(f.path);
        out.push({ path: f.path, st: idx.trim() || "M" });
      }
    }
    return out;
  }, [gitState]);

  const changedFiles = useMemo(() => {
    if (!gitState?.ok) return [];
    const seen = new Set<string>();
    const out: { path: string; st: string }[] = [];
    for (const f of gitState.files) {
      const idx = f.status[0] ?? " ";
      const work = f.status[1] ?? " ";
      const isUntracked = idx === "?";
      if ((isUntracked || work !== " ") && !seen.has(f.path)) {
        seen.add(f.path);
        out.push({ path: f.path, st: isUntracked ? "U" : work.trim() || "M" });
      }
    }
    return out;
  }, [gitState]);

  /**
   * 把「管理 herdr 工作区」面板的两份数据合起来：**每个工作区一行**。
   *
   * 为什么要合：`workspace scan` 给的是"有哪些工作区 + 每个窗格的前台进程"，
   * `pane list` 给的是"每个窗格的标题 / cwd / agent 状态"。少了前者分不出空壳，
   * 少了后者你认不出哪个窗格是哪个 —— 用户的原话就是"创建了无数个 herdr 都忘了"。
   */
  function herdrMgrRows(profile: ConnectionProfile, mgr: NonNullable<typeof herdrMgr>) {
    const wsOf = (p?: string | null) => (p ? p.split(":")[0] : "");
    const used = new Set<string>();
    for (const s of sessions) {
      if (s.profileId !== profile.id) continue;
      const w = wsOf(s.herdrPane);
      if (w) used.add(w);
    }
    for (const h of history) {
      if (h.profileId !== profile.id) continue;
      const w = wsOf(h.herdrPane);
      if (w) used.add(w);
    }
    for (const t of boardTasks) {
      if (t.herdrProfileId !== profile.id) continue;
      const w = wsOf(t.herdrPane);
      if (w) used.add(w);
    }
    const procOf = new Map(
      mgr.scan.panes.map((p) => [p.paneId, (p.procName || "").trim().toLowerCase()] as const),
    );
    const isShell = (id: string) => SHELL_NAMES.has(procOf.get(id) ?? "");
    return mgr.scan.workspaces.map((ws) => {
      const known = mgr.panes.filter((p) => wsOf(p.paneId) === ws);
      const ids = (known.length ? known.map((p) => p.paneId) : mgr.scan.panes.filter((p) => wsOf(p.paneId) === ws).map((p) => p.paneId));
      const first = known[0];
      const pane = ids[0] ?? `${ws}:p1`;
      // "空壳"的条件：① 每个窗格的前台进程都是 shell（取不到进程名的不算）② 不在这台机器
      // 任何已打开/历史/AI 看板的引用里。两条都满足才敢让人一键回收。
      const allShell = ids.length > 0 && ids.every(isShell);
      const running = ids.filter((id) => !isShell(id));
      const status =
        first?.status === "blocked"
          ? "等你处理"
          : first?.status === "idle"
            ? "空闲"
            : first?.agent
              ? aiToolLabel(first.agent)
              : "";
      const proc = [...new Set(ids.map((id) => procOf.get(id) || "?"))].join(" + ");
      return {
        ws,
        pane,
        label: (first?.title ?? "").trim() || first?.agent || "herdr",
        inUse: used.has(ws),
        idle: !used.has(ws) && allShell,
        summary: [proc, status].filter(Boolean).join(" · "),
        detail: [
          `工作区 ${ws}`,
          ...known.map(
            (p) =>
              `　窗格 ${p.paneId}｜前台 ${procOf.get(p.paneId) || "?"}` +
              `${p.agent ? `｜agent ${aiToolLabel(p.agent)}（${p.status}）` : ""}` +
              `${p.cwd ? `｜${p.cwd}` : ""}`,
          ),
          `在用：${used.has(ws) ? "是（有会话/历史/看板卡片指着它）" : "否"}`,
          running.length ? `还有东西在跑：${running.join("、")}` : "空壳（只停着 shell）",
        ].join("\n"),
      };
    });
  }

  /** 管理面板里"能直接回收"的工作区个数（空壳）；按钮上要写这个数 */
  function herdrMgrIdleCount(profile: ConnectionProfile, mgr: NonNullable<typeof herdrMgr>) {
    return herdrMgrRows(profile, mgr).filter((r) => r.idle).length;
  }

  /**
   * 「AI 命令行工具」里要列哪些。
   *
   * 只默认摆 Codex CLI / Claude Code，别的**装了才显示**（见 DEFAULT_AI_TOOLS 的说明）。
   */
  function aiToolsVisible(tools: AiTool[]): AiTool[] {
    return tools.filter((t) => t.installed || DEFAULT_AI_TOOLS.has(t.name));
  }

  // 切到 herdr 会话时顺手探一次**那台机器**的服务状态：这样状态条上那句
  // 「服务运行中 · N 个窗格」不用先打开 AI 面板就有。只在换了服务器时才探，
  // 同一台机器来回切标签不会反复 ssh。
  useEffect(() => {
    const s = sessions.find((x) => x.id === activeId) ?? null;
    const pid = s?.herdrPane ? s.profileId : null;
    if (!pid || herdrProbedFor.current === pid) return;
    herdrProbedFor.current = pid;
    void refreshHerdrServer(pid, s?.user ?? null);
  }, [activeId, sessions]);

  return (
    <div
      className={
        "app theme-" + settings.theme + (themeKind(settings.theme) === "light" ? " light" : "")
      }
    >
      <div className="titlebar">
        <div className="menus">
          {buildMenus().map((menu) => (
            <div key={menu.key} className="menu">
              <span
                className={"menu-label" + (openMenu === menu.key ? " open" : "")}
                onClick={() => setOpenMenu(openMenu === menu.key ? null : menu.key)}
              >
                {menu.label}
                {menu.key === "help" && updateOffer && <span className="menu-dot" />}
              </span>
              {openMenu === menu.key && (
                <div className="menu-drop">
                  {menu.items.map((item, i) =>
                    item.sep ? (
                      <div key={"sep" + i} className="menu-sep" />
                    ) : (
                      <button
                        key={item.label}
                        type="button"
                        className="menu-item"
                        onClick={() => {
                          setOpenMenu(null);
                          item.action?.();
                        }}
                      >
                        {item.label}
                      </button>
                    ),
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="title">
          ZeeAI Term{activeSession ? " — " + activeSession.title : ""}
        </div>
        <div className="win-controls" aria-hidden="true">
          <span className="wbtn" />
          <span className="wbtn" />
          <span className="wbtn" />
        </div>
      </div>

      <div className="workbench">
        <nav className="activitybar">
          {MODULES.map((m) => (
            <button
              key={m.key}
              type="button"
              className={"act" + (module === m.key ? " active" : "")}
              title={m.label}
              onClick={() => activateModule(m.key)}
            >
              {m.node}
            </button>
          ))}
          <div className="act-sep" />
          <div className="act-foot">
            <button
              type="button"
              className={"act" + (aiPanelOpen ? " active" : "")}
              title="AI Agent（探测/安装/启动 AI 命令行工具）"
              onClick={() => setAiPanelOpen((v) => !v)}
            >
              <IconSpark size={22} />
              {/* 有"要你处理/新消息"没看过时显示数字（设置里可关） */}
              {/* 红点只在两件事上亮（§10.6）：需要你（亮到你处理）、跑完停下（点开就消）。
                  两条规则各有一个开关，所以这里不能再拿一个"总开关"去盖。 */}
              {aiBadgeCount > 0 && (
                <span className="act-badge">{aiBadgeCount > 9 ? "9+" : aiBadgeCount}</span>
              )}
            </button>
            <button
              type="button"
              className="act"
              title="设置"
              onClick={() => setShowSettings(true)}
            >
              <IconGear size={22} />
              {updateOffer && <span className="act-dot" />}
            </button>
          </div>
        </nav>

      <aside
        className="sidebar"
        style={{ display: showSidebar ? undefined : "none", width: sidebarWidth }}
      >
        {/* 侧栏右边缘的拖动条：按住左右拖可以调宽度 */}
        <div
          className="sidebar-resizer"
          title="左右拖动调整侧栏宽度"
          onMouseDown={(e) => {
            e.preventDefault();
            const startX = e.clientX;
            const startW = sidebarWidth;
            const onMove = (ev: MouseEvent) =>
              setSidebarWidth(Math.min(620, Math.max(180, startW + ev.clientX - startX)));
            const onUp = () => {
              window.removeEventListener("mousemove", onMove);
              window.removeEventListener("mouseup", onUp);
            };
            window.addEventListener("mousemove", onMove);
            window.addEventListener("mouseup", onUp);
          }}
        />
        {/* 右边缘可以左右拖，调侧栏宽度（名字长的时候很有用） */}
          <div className="side-head">{MODULE_LABEL[module]}</div>

          {module === "remote" && (
            <div className="side-subtabs">
              <button
                type="button"
                className={sideTab === "sessions" ? "active" : ""}
                onClick={() => setSideTab("sessions")}
              >
                会话
              </button>
              <button
                type="button"
                className={sideTab === "files" ? "active" : ""}
                onClick={() => setSideTab("files")}
              >
                文件
              </button>
            </div>
          )}

          <div className="side-body">
            {module === "remote" && sideTab === "sessions" && (
              <>
                <div className="side-head-row">
                  <span className="side-head-title">服务器</span>
                  <button
                    type="button"
                    className="side-btn"
                    title="新建一台服务器（SSH）"
                    onClick={() => openEditDialog()}
                  >
                    <IconPlus size={12} /> 新建
                  </button>
                  <button
                    type="button"
                    className="side-btn"
                    title="服务器管理：编辑 / 复制 / 删除"
                    onClick={() => setShowServers(true)}
                  >
                    服务器管理
                  </button>
                </div>
                {grouped.length === 0 && (
                  <div className="hint">还没有服务器</div>
                )}
                {sshProfiles.length > 0 && (
                  <button type="button" className="side-allbtn" onClick={() => toggleAllServers()}>
                    {allServersExpanded ? "▾ 折叠全部会话" : "▸ 展开全部会话"}
                  </button>
                )}
                {grouped.map(([group, list]) => (
                  <div key={group}>
                    {showGroupHeaders && (
                      <div className="tree-subgroup">
                        {group === DEFAULT_SERVER_GROUP ? "未分组" : group}
                      </div>
                    )}
                    {list.map((p) => {
                      const items = history.filter((h) => h.profileId === p.id);
                      const expanded = !collapsedServers.includes(p.id);
                      return (
                        <div key={p.id}>
                          <div
                            className="tree-item srv-node"
                            onClick={() => toggleServer(p.id)}
                            onDoubleClick={() => openEditDialog(p)}
                            onContextMenu={(e) => {
                              e.preventDefault();
                              setCtxMenu({ profile: p, x: e.clientX, y: e.clientY });
                            }}
                            title={`${p.ssh?.user}@${p.ssh?.host}:${p.ssh?.port}\n单击：展开/收起会话历史　双击或右键：服务器设置`}
                          >
                            <span
                              className="chev"
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleServer(p.id);
                              }}
                            >
                              {expanded ? (
                                <IconChevronDown size={12} />
                              ) : (
                                <IconChevronRight size={12} />
                              )}
                            </span>
                            <IconServer size={15} />
                            {p.color && (
                              <span className="color-dot" style={{ background: p.color }} />
                            )}
                            <span className="grow ellipsis">{p.name}</span>
                            {p.ssh?.tmuxEnabled && <span className="tag">tmux</span>}
                            {items.length > 0 && (
                              <span className="dim count">{items.length}</span>
                            )}
                            <button
                              type="button"
                              className="mini-x"
                              title="服务器管理（编辑 / 复制 / 删除）"
                              onClick={(e) => {
                                e.stopPropagation();
                                const r = (e.target as HTMLElement).getBoundingClientRect();
                                setCtxMenu({ profile: p, x: r.left - 170, y: r.bottom + 4 });
                              }}
                            >
                              ⋯
                            </button>
                          </div>
                          {expanded &&
                            items.map((h) => {
                              // tmux 会话能精确判断"是不是已经在标签里开着"
                              // 已打开的判定：tmux 按 tmux 会话名比；普通 shell 按"这台机器 + 没有 tmux 名"比
                              // 普通 shell 还必须**比名字** —— 否则同一台机器上随便开一个普通 shell，
                              // 它所有普通 shell 的历史行都会显示"已打开"（实测就是这个 bug）
                              // herdr：按**窗格号**比（和上面两个都不是一回事；
                              // 以前漏了这一支，于是 herdr 行会拿标题去比普通 shell，判得一塌糊涂）
                              const opened = sessions.find((s) =>
                                h.herdrPane
                                  ? s.profileId === h.profileId && s.herdrPane === h.herdrPane
                                  : h.tmuxSession
                                  ? s.profileId === h.profileId && s.tmuxName === h.tmuxSession
                                  : s.profileId === h.profileId &&
                                    !s.tmuxName &&
                                    (s.title ?? "").trim() === (h.title ?? "").trim(),
                              );
                              const rawTitle = h.title?.trim() || "";
                              const rowLabel = h.herdrPane
                                ? // herdr 行：去掉"服务器名 · "前缀（服务器就在上一级树里），
                                  // 窗格号由左边的 H 标和悬停提示给出，行里不用再挤一遍
                                  // 再把老版本拼重复的窗格号收掉（那时候正则漏了带字母的工作区号，
                                  // 标题会变成 "… w1P:p1 w1P:p1"）
                                  dedupPaneId(rawTitle.replace(/^[^·]*·\s*/, ""), h.herdrPane) ||
                                  h.herdrPane
                                : rawTitle ||
                                  h.tmuxSession ||
                                  `${h.profileName || "服务器"} · 普通 shell`;
                              return (
                                <div
                                  key={h.id}
                                  className={"tree-item child" + (opened ? " opened" : "")}
                                  onClick={() => void connectFromHistory(h)}
                                  onContextMenu={(e) => {
                                    // herdr 的行才给菜单：它对着的是"服务器上那个工作区"，
                                    // 能就地决定留着还是回收（别的行没有服务器侧的东西要管）。
                                    if (!h.herdrPane) return;
                                    e.preventDefault();
                                    setHerdrRowArmed(null);
                                    setCtxMenu({ profile: p, x: e.clientX, y: e.clientY, herdrRow: h });
                                  }}
                                  title={
                                    (h.herdrPane
                                      ? `herdr 窗格 ${h.herdrPane}`
                                      : h.tmuxSession ?? "普通 shell") +
                                    `　${relTime(h.lastUsed)}` +
                                    (opened ? "\n已经开着了 —— 点一下切到那个标签" : "") +
                                    (h.herdrPane
                                      ? "\n右键：只移除记录 / 在服务器上关掉这个工作区"
                                      : "")
                                  }
                                >
                                  <span
                                    className={"open-dot" + (opened ? " on" : "")}
                                    title={opened ? "已打开" : "未打开"}
                                  />
                                  {/* 最前面标一下是不是 tmux 会话（用户要的"小 T 字图标"） */}
                                  {h.tmuxSession && (
                                    <span className="tmux-mark" title="tmux 会话（服务器上会一直活着）">
                                      T
                                    </span>
                                  )}
                                  {/* herdr 会话用一个小 H 标出来 —— 和上面那个 T 一个道理，
                                      侧栏一眼就能看出这条是 herdr 管的窗格 */}
                                  {h.herdrPane && (
                                    <span
                                      className="herdr-mark"
                                      title={`herdr 窗格（服务器上的工作区/窗格：${h.herdrPane}）`}
                                    >
                                      H
                                    </span>
                                  )}
                                  <IconTerminal size={13} />
                                  <span className="grow ellipsis" title={rowLabel}>
                                    {rowLabel}
                                  </span>
                                  {opened && <span className="tag">已打开</span>}
                                  <button
                                    type="button"
                                    className="mini-x"
                                    title="从历史中移除"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      void removeHistoryEntry(h.id);
                                    }}
                                  >
                                    ×
                                  </button>
                                </div>
                              );
                            })}
                          {expanded && items.length === 0 && (
                            <div className="tree-item child hint child-empty">
                              还没有会话历史。双击服务器可以新建/编辑连接。
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ))}

                <div className="side-actions">
                  <button
                    type="button"
                    className="btn primary"
                    onClick={() => openNewSessionDialog()}
                  >
                    <IconPlus size={14} /> 新建会话
                  </button>
                </div>

                {showForm && (
                  <div className="form">
                    <label>
                      名称
                      <input
                        value={form.name}
                        placeholder="只是标签，不参与连接"
                        onChange={(e) => setForm({ ...form, name: e.target.value })}
                      />
                    </label>
                    <label>
                      主机
                      <input
                        value={form.host}
                        placeholder="IP 或 ~/.ssh/config 里的别名（填别名才能带上 config 里的密钥/端口/用户）"
                        onChange={(e) => setForm({ ...form, host: e.target.value })}
                      />
                    </label>
                    <div className="row">
                      <label className="grow">
                        端口
                        <input
                          type="number"
                          min={0}
                          value={form.port}
                          // 留空送 0（= "没说"）：后端不传 -p，交给 config。
                          // 这里存字符串就是为了"能空着"；`Number("")` 是 0，不会变成 NaN。
                          placeholder="留空则用 ~/.ssh/config 里的值（默认 22）"
                          onChange={(e) => setForm({ ...form, port: e.target.value })}
                        />
                      </label>
                      <label className="grow">
                        用户
                        <input
                          value={form.user}
                          placeholder="留空则用 ~/.ssh/config 里的值（默认当前用户名）"
                          onChange={(e) => setForm({ ...form, user: e.target.value })}
                        />
                      </label>
                    </div>
                    <label>
                      分组
                      <input
                        value={form.group}
                        onChange={(e) => setForm({ ...form, group: e.target.value })}
                      />
                    </label>
                    <label>
                      私钥路径（可选，留空则用默认密钥 / ~/.ssh/config）
                      <input
                        value={form.keyPath}
                        placeholder="C:\Users\me\.ssh\id_ed25519"
                        onChange={(e) => setForm({ ...form, keyPath: e.target.value })}
                      />
                    </label>
                    <button type="button" className="btn primary" onClick={() => void submitProfile()}>
                      保存
                    </button>
                  </div>
                )}

                {grouped.length === 0 && !showForm && (
                  <div className="hint">还没有连接</div>
                )}

                {tmuxTarget && (
                  <div className="tmux-panel">
                    <div className="tmux-head">
                      <span>tmux · {tmuxTarget.name}</span>
                      <span className="tmux-actions">
                        <button
                          type="button"
                          className="mini-btn"
                          onClick={() => void refreshTmux(tmuxTarget)}
                        >
                          刷新
                        </button>
                        <button
                          type="button"
                          className="mini-btn"
                          onClick={() => setTmuxTarget(null)}
                        >
                          关闭
                        </button>
                      </span>
                    </div>
                    {tmuxLoading && <div className="hint">正在读取…</div>}
                    {!tmuxLoading && tmuxSessions.length === 0 && (
                      <div className="hint">没有 tmux 会话</div>
                    )}
                    {tmuxSessions.map((s) => (
                      <div key={s.name} className="tmux-row">
                        <IconTerminal size={14} />
                        <span className="grow">{s.name}</span>
                        <span className="dim">{s.windows} 窗口</span>
                        {s.attached && <span className="tag">已连接</span>}
                        <button
                          type="button"
                          className="mini-btn"
                          onClick={() => void openSshSession(tmuxTarget, "name", s.name)}
                        >
                          连接
                        </button>
                        <button
                          type="button"
                          className="mini-btn"
                          onClick={() => void killTmux(tmuxTarget, s.name)}
                        >
                          结束
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {/* ---------- 管理 herdr 工作区（服务器右键打开） ----------
                    herdr 的工作区天生持久，关标签页不会回收 —— 所以必须有一个"就在服务器上
                    看一遍、决定留哪个"的地方。 */}
                {herdrTarget && (
                  <div className="tmux-panel herdr-panel">
                    <div className="tmux-head">
                      <span>herdr · {herdrTarget.name}</span>
                      <span className="tmux-actions">
                        <button
                          type="button"
                          className="mini-btn"
                          onClick={() => void refreshHerdrMgr(herdrTarget)}
                        >
                          刷新
                        </button>
                        <button
                          type="button"
                          className="mini-btn"
                          onClick={() => {
                            setHerdrTarget(null);
                            setHerdrMgr(null);
                            setHerdrMgrArmed(null);
                          }}
                        >
                          关闭
                        </button>
                      </span>
                    </div>
                    {herdrMgrLoading && <div className="hint">正在读取…</div>}
                    {!herdrMgrLoading && !herdrMgr && (
                      <div className="hint">读不到 herdr 状态（这台机器可能没装，或没连上）</div>
                    )}
                    {!herdrMgrLoading && herdrMgr && (
                      <>
                        <div className="herdr-svc-row">
                          <span className="grow">
                            {herdrMgr.server.running
                              ? `服务运行中 · ${herdrMgr.scan.panes.length} 个窗格`
                              : "服务没在跑"}
                          </span>
                          {herdrMgr.server.running ? (
                            herdrStopArmed ? (
                              <>
                                <button
                                  type="button"
                                  className="mini-btn danger"
                                  title="停止 herdr 服务 —— 它管着的所有窗格都会关掉"
                                  onClick={() =>
                                    void stopHerdrServer(
                                      herdrTarget.id,
                                      herdrTarget.ssh?.user ?? null,
                                    )
                                  }
                                >
                                  确认停止
                                </button>
                                <button
                                  type="button"
                                  className="mini-btn"
                                  onClick={() => setHerdrStopArmed(false)}
                                >
                                  取消
                                </button>
                              </>
                            ) : (
                              <button
                                type="button"
                                className="mini-btn"
                                onClick={() => setHerdrStopArmed(true)}
                              >
                                停止服务…
                              </button>
                            )
                          ) : (
                            <button
                              type="button"
                              className="mini-btn"
                              onClick={() =>
                                void startHerdrServer(
                                  herdrTarget.id,
                                  herdrTarget.ssh?.user ?? null,
                                )
                              }
                            >
                              启动服务
                            </button>
                          )}
                        </div>
                        {herdrMgr.scan.workspaces.length === 0 && (
                          <div className="hint">服务器上没有 herdr 工作区</div>
                        )}
                        {herdrTarget &&
                          herdrMgrRows(herdrTarget, herdrMgr).map((w) => (
                            <div key={w.ws} className="tmux-row herdr-ws-row">
                              <span className="herdr-mark">H</span>
                              <span className="grow ellipsis" title={w.detail}>
                                {w.ws}
                                <span className="dim"> · {w.summary}</span>
                              </span>
                              {w.inUse && <span className="tag">在用</span>}
                              {w.idle && <span className="tag">空壳</span>}
                              <button
                                type="button"
                                className="mini-btn"
                                title={`以可写方式接管 ${w.pane}`}
                                onClick={() =>
                                  void openHerdrPane(
                                    herdrTarget.id,
                                    w.pane,
                                    w.label,
                                    herdrTarget.ssh?.user ?? null,
                                    "control",
                                  )
                                }
                              >
                                接管
                              </button>
                              <button
                                type="button"
                                className="mini-btn"
                                title={`只读观察 ${w.pane}`}
                                onClick={() =>
                                  void openHerdrPane(
                                    herdrTarget.id,
                                    w.pane,
                                    w.label,
                                    herdrTarget.ssh?.user ?? null,
                                    "observe",
                                  )
                                }
                              >
                                观察
                              </button>
                              {herdrMgrArmed === w.ws ? (
                                <>
                                  <button
                                    type="button"
                                    className="mini-btn danger"
                                    title={`真的关掉 ${w.ws}（含里面的窗格）`}
                                    onClick={() => void closeHerdrWorkspace(herdrTarget, w.ws)}
                                  >
                                    确认关掉 {w.ws}
                                  </button>
                                  <button
                                    type="button"
                                    className="mini-btn"
                                    onClick={() => setHerdrMgrArmed(null)}
                                  >
                                    取消
                                  </button>
                                </>
                              ) : (
                                <button
                                  type="button"
                                  className="mini-btn"
                                  title={`关掉工作区 ${w.ws}（里面的窗格也会一起没）`}
                                  onClick={() => setHerdrMgrArmed(w.ws)}
                                >
                                  关掉
                                </button>
                              )}
                            </div>
                          ))}
                        {herdrTarget && herdrMgrIdleCount(herdrTarget, herdrMgr) > 0 && (
                          <div className="herdr-svc-row">
                            <span className="grow hint">
                              其中 {herdrMgrIdleCount(herdrTarget, herdrMgr)} 个是空壳（只停着
                              shell，且不在任何已打开/历史会话里）
                            </span>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}

              </>
            )}

            {module === "remote" && sideTab === "files" && (
              <>
                {!fileProfile && (
                  <div className="hint">先打开一个 SSH 会话</div>
                )}
                {fileProfile && (
                  <>
                    <div className="fs-toolbar">
                      <button
                        type="button"
                        className="mini-btn"
                        onClick={() => void loadDir(fileProfile.id, parentOf(fsPath))}
                      >
                        ↑ 上级
                      </button>
                      <button
                        type="button"
                        className="mini-btn"
                        title="重新读取当前目录"
                        onClick={() => void loadDir(fileProfile.id, fsPath)}
                      >
                        刷新
                      </button>
                      <button
                        type="button"
                        className="mini-btn"
                        title="跳到终端当前所在目录（你在终端里 cd 到哪儿就同步到哪儿）"
                        onClick={() =>
                          void syncFsToTerminal(
                            fileProfile.id,
                            activeTmuxName,
                            activeSession?.cwd,
                          )
                        }
                      >
                        ⤓ 同步终端目录
                      </button>
                      <button
                        type="button"
                        className="mini-btn"
                        onClick={() => void loadDir(fileProfile.id, undefined)}
                      >
                        家目录
                      </button>
                      <button
                        type="button"
                        className="mini-btn"
                        disabled={fsBusy}
                        title="把本机文件上传到当前目录"
                        onClick={() => void uploadToRemote(fileProfile.id)}
                      >
                        上传
                      </button>
                      <button
                        type="button"
                        className="mini-btn"
                        disabled={fsBusy}
                        title="在当前目录新建文件夹"
                        onClick={() =>
                          setNameDialog({
                            mode: "mkdir",
                            profileId: fileProfile.id,
                            dir: fsPath,
                            from: "",
                            value: "新建文件夹",
                          })
                        }
                      >
                        新建文件夹
                      </button>
                      <button
                        type="button"
                        className={"mini-btn" + (settings.fsFollowTerminal ? " active" : "")}
                        title={
                          settings.fsFollowTerminal
                            ? "已开启：刷新会跳到终端（tmux）当前所在目录"
                            : "已关闭：刷新只重读当前目录"
                        }
                        onClick={() =>
                          void updateSettings({ fsFollowTerminal: !settings.fsFollowTerminal })
                        }
                      >
                        {settings.fsFollowTerminal ? "✓ 跟随终端" : "跟随终端"}
                      </button>
                    </div>
                    <input
                      className="fs-path-input"
                      value={fsInput}
                      spellCheck={false}
                      placeholder="/path/to/dir  回车跳转"
                      onChange={(e) => setFsInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          void loadDir(fileProfile.id, fsInput.trim() || undefined);
                        }
                      }}
                    />
                    <div className="fs-list">
                      {fsEntries.map((en) => (
                        <div
                          key={en.name}
                          className="fs-row"
                          onClick={() =>
                            en.isDir
                              ? void loadDir(fileProfile.id, joinPath(fsPath, en.name))
                              : void openRemoteFile(fileProfile.id, en.name)
                          }
                          onContextMenu={(e) => {
                            e.preventDefault();
                            setFsMenu({
                              profileId: fileProfile.id,
                              name: en.name,
                              isDir: en.isDir,
                              x: e.clientX,
                              y: e.clientY,
                            });
                          }}
                          title={
                            (en.isDir ? "进入目录" : "预览文件") +
                            "　（右键：下载 / 重命名 / 删除）"
                          }
                        >
                          {en.isDir ? <IconFolder size={15} /> : <IconFile size={15} />}
                          <span className="grow">{en.name}</span>
                          <span className="dim">{en.isDir ? "" : humanSize(en.size)}</span>
                          <button
                            type="button"
                            className="mini-x"
                            title="下载 / 重命名 / 删除"
                            onClick={(e) => {
                              e.stopPropagation();
                              const r = (e.target as HTMLElement).getBoundingClientRect();
                              setFsMenu({
                                profileId: fileProfile.id,
                                name: en.name,
                                isDir: en.isDir,
                                x: r.left - 150,
                                y: r.bottom + 4,
                              });
                            }}
                          >
                            ⋯
                          </button>
                        </div>
                      ))}
                      {!fsLoading && fsEntries.length === 0 && (
                        <div className="hint">空目录</div>
                      )}
                    </div>
                  </>
                )}
              </>
            )}

            {module === "powershell" && (
              <LocalModule
                label="PowerShell"
                sessions={sessions.filter((s) => s.kind === "powershell")}
                activeId={activeId}
                onOpen={() => void openLocalSession("powershell")}
                // 并排两个按钮：左边长的 = 系统自带的 Windows PowerShell 5.1，
                // 右边短的 = PowerShell 7（pwsh.exe）。两者语法/编码不一样，让用户自己挑。
                secondary={{
                  label: "PowerShell 7",
                  title: "用 PowerShell 7（pwsh.exe）新建——本机要先装 PowerShell 7",
                  onClick: () => void openLocalSession("pwsh"),
                }}
                onActivate={setActiveId}
                onClose={(id) => void closeSession(id)}
              />
            )}
            {module === "cmd" && (
              <LocalModule
                label="命令提示符"
                sessions={sessions.filter((s) => s.kind === "cmd")}
                activeId={activeId}
                onOpen={() => void openLocalSession("cmd")}
                onActivate={setActiveId}
                onClose={(id) => void closeSession(id)}
              />
            )}
            {module === "wsl" && (
              <LocalModule
                label="WSL"
                sessions={sessions.filter((s) => s.kind === "wsl")}
                activeId={activeId}
                onOpen={() => void openLocalSession("wsl")}
                onActivate={setActiveId}
                onClose={(id) => void closeSession(id)}
              />
            )}
            {module === "git" && (
              <>
                <div className="side-actions">
                  <button
                    type="button"
                    className="btn primary"
                    title="选一个本地仓库目录，直接在这个目录开一个本地终端（PowerShell / CMD / WSL 按设置来）"
                    onClick={() => void openGitWorkspace()}
                  >
                    <IconPlus size={14} /> 打开本地仓库
                  </button>
                  <button
                    type="button"
                    className="btn"
                    title="在一个目录里执行 git init，建好后直接打开终端"
                    onClick={() => setGitInitDialog({ path: "" })}
                  >
                    新建仓库
                  </button>
                </div>
                <div className="tree-group">Git 工作空间</div>
                {gitWorkspaces.length === 0 && (
                  <div className="hint">还没有工作空间</div>
                )}
                {gitWorkspaces.map((p) => (
                  <div
                    key={p.id}
                    className="tree-item"
                    title={`${p.local?.cwd}（点击查看改动，右侧按钮开终端）`}
                    onClick={() => {
                      const dir = p.local?.cwd ?? "";
                      setGitPath(dir);
                      void refreshGitAll(dir);
                    }}
                  >
                    <IconGit size={14} />
                    <span className="grow ellipsis">{p.name}</span>
                    <button
                      type="button"
                      className="mini-btn"
                      title="在这个目录再开一个新的本地终端（可以开任意多个）"
                      onClick={(e) => {
                        e.stopPropagation();
                        const dir = p.local?.cwd ?? "";
                        void openLocalSession(
                          p.local?.shell ?? settings.defaultShell,
                          p.local?.distro,
                          dir,
                          `${p.name}`,
                        );
                      }}
                    >
                      新终端
                    </button>
                    <button
                      type="button"
                      className="mini-x"
                      title="从工作空间里移除"
                      onClick={(e) => {
                        e.stopPropagation();
                        void removeGitWorkspace(p);
                      }}
                    >
                      ×
                    </button>
                  </div>
                ))}

                <div className="tree-group">快速查看某个仓库</div>
                <label className="modal-field" style={{ paddingTop: 4 }}>
                  仓库路径
                  <input
                    value={gitPath}
                    placeholder="D:\AI\ZeeAI_term"
                    onChange={(e) => setGitPath(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void refreshGitAll();
                    }}
                  />
                </label>
                <div className="side-actions">
                  <button
                    type="button"
                    className="btn"
                    disabled={gitBusy}
                    onClick={() => void refreshGitAll()}
                  >
                    {gitBusy ? "读取中…" : "刷新"}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    title="在当前仓库目录打开一个新的本地终端"
                    onClick={() => void openGitTerminal(gitPath, undefined)}
                  >
                    开终端
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={!gitState?.ok}
                    onClick={() => {
                      setShowBranches((v) => !v);
                      if (!gitBranchList.length && gitState?.ok) void refreshGitAll();
                    }}
                  >
                    分支 {gitState?.branch ? `(${gitState.branch})` : ""}
                  </button>
                </div>
                {gitLoading && <div className="hint">正在读取…</div>}
                {!gitLoading && gitState && !gitState.ok && (
                  <div className="hint">{gitState.message}</div>
                )}
                {!gitLoading && gitState?.ok && (
                  <>
                    {/* 分支列表 */}
                    {showBranches && (
                      <div className="git-branches">
                        {gitBranchList.map((b) => (
                          <div
                            key={b.name}
                            className={"tree-item" + (b.current ? " current" : "")}
                            title={`${b.name}${b.upstream ? ` → ${b.upstream}` : ""}　${b.when}`}
                            onClick={() => {
                              if (!b.current) void doGitCheckout(b.name);
                            }}
                          >
                            <IconGit size={13} />
                            <span className="grow ellipsis">{b.name}</span>
                            {b.current && <span className="tag">当前</span>}
                            <span className="dim">{b.when}</span>
                          </div>
                        ))}
                        <div className="git-newbranch">
                          <input
                            value={newBranch}
                            placeholder="新分支名"
                            onChange={(e) => setNewBranch(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && newBranch.trim())
                                void doGitCheckout(newBranch, true);
                            }}
                          />
                          <button
                            type="button"
                            className="mini-btn"
                            disabled={!newBranch.trim()}
                            onClick={() => void doGitCheckout(newBranch, true)}
                          >
                            新建并切换
                          </button>
                        </div>
                      </div>
                    )}

                    <div className="git-commit-box">
                      <textarea
                        className="git-commit-msg"
                        rows={2}
                        placeholder="提交信息（Ctrl+Enter 提交）"
                        value={gitMessage}
                        onChange={(e) => setGitMessage(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                            e.preventDefault();
                            void doGitCommit();
                          }
                        }}
                      />
                      <button
                        type="button"
                        className="btn primary git-commit-btn"
                        disabled={gitBusy || !gitMessage.trim()}
                        onClick={() => void doGitCommit()}
                      >
                        提交
                      </button>
                    </div>

                    {/* 已暂存 */}
                    {stagedFiles.length > 0 && (
                      <>
                        <div className="tree-group">
                          已暂存（{stagedFiles.length}）
                          <button
                            type="button"
                            className="mini-x"
                            style={{ marginLeft: "auto", opacity: 1 }}
                            title="全部取消暂存"
                            onClick={() => void doGitUnstage(stagedFiles.map((f) => f.path))}
                          >
                            −
                          </button>
                        </div>
                        {stagedFiles.map((f) => (
                          <div
                            key={"s" + f.path}
                            className="tree-item git-file"
                            title={`${f.path}（点击看 diff）`}
                            onClick={() => void showFileDiff(f.path, true)}
                          >
                            <span className="git-st staged">{f.st}</span>
                            <span className="grow ellipsis">{f.path}</span>
                            <button
                              type="button"
                              className="mini-x"
                              title="取消暂存"
                              onClick={(e) => {
                                e.stopPropagation();
                                void doGitUnstage([f.path]);
                              }}
                            >
                              −
                            </button>
                          </div>
                        ))}
                      </>
                    )}

                    {/* 更改 */}
                    <div className="tree-group">
                      更改（{changedFiles.length}）
                      <button
                        type="button"
                        className="mini-x"
                        style={{ marginLeft: "auto", opacity: 1 }}
                        title="全部暂存"
                        onClick={() => void doGitAdd()}
                      >
                        ＋
                      </button>
                    </div>
                    {changedFiles.length === 0 && (
                      <div className="hint">没有未暂存的改动。</div>
                    )}
                    {changedFiles.map((f) => (
                      <div
                        key={"c" + f.path}
                        className="tree-item git-file"
                        title={`${f.path}（点击看 diff）`}
                        onClick={() => void showFileDiff(f.path, false)}
                      >
                        <span className="git-st">{f.st}</span>
                        <span className="grow ellipsis">{f.path}</span>
                        <button
                          type="button"
                          className="mini-x"
                          title="暂存这个文件"
                          onClick={(e) => {
                            e.stopPropagation();
                            void doGitAdd([f.path]);
                          }}
                        >
                          ＋
                        </button>
                        <button
                          type="button"
                          className="mini-x"
                          title="丢弃改动（不可撤销）"
                          onClick={(e) => {
                            e.stopPropagation();
                            askGitDiscard([f.path]);
                          }}
                        >
                          ↺
                        </button>
                      </div>
                    ))}

                    <div className="hint">
                      分支 {gitState.branch || "(未知)"}
                      {gitState.upstream ? ` → ${gitState.upstream}` : ""}
                      {gitState.ahead > 0 ? ` · 领先 ${gitState.ahead}` : ""}
                      {gitState.behind > 0 ? ` · 落后 ${gitState.behind}` : ""}
                    </div>

                    {/* 历史 */}
                    <div className="tree-group">提交历史（{gitCommits.length}）</div>
                    {gitCommits.length === 0 && <div className="hint">还没有提交。</div>}
                    {gitCommits.map((cm) => (
                      <div
                        key={cm.hash}
                        className="tree-item git-commit"
                        title={`${cm.hash}\n${cm.author} · ${cm.when}\n点击查看这次提交的 diff`}
                        onClick={() => void showCommitDiff(cm.hash, cm.subject)}
                      >
                        <span className="git-hash">{cm.short}</span>
                        <span className="grow ellipsis">{cm.subject}</span>
                        <span className="dim">{cm.when}</span>
                      </div>
                    ))}
                  </>
                )}
                {!gitLoading && !gitState && (
                  <div className="hint">填一个本地仓库路径</div>
                )}
              </>
            )}
            {module === "serial" && (
              <>
                <div className="side-actions">
                  <button
                    type="button"
                    className="btn primary"
                    onClick={() => openSerialDialog()}
                  >
                    <IconPlus size={14} /> 新建串口连接
                  </button>
                </div>
                {serialLoading && <div className="hint">正在检测串口…</div>}
                {!serialLoading && serialProfiles.length === 0 && (
                  <div className="hint">还没有串口连接</div>
                )}
                {serialProfiles.map((p) => {
                  const cfg = p.serial;
                  const alive = serialPorts.some((x) => x.path === cfg?.path);
                  return (
                    <div
                      key={p.id}
                      className="tree-item"
                      onClick={() => void openSerialSession(p)}
                      title={`${cfg?.path} · ${cfg?.baudRate} 波特率（点击打开）`}
                    >
                      <IconSerial size={15} />
                      <span className="grow ellipsis">{p.name}</span>
                      <span className="dim">{cfg?.baudRate}</span>
                      {!alive && <span className="tag warn">未接入</span>}
                      <button
                        type="button"
                        className="mini-x"
                        title="编辑 / 复制 / 删除"
                        onClick={(e) => {
                          e.stopPropagation();
                          const r = (e.target as HTMLElement).getBoundingClientRect();
                          setSerialMenu({ profile: p, x: r.left - 170, y: r.bottom + 4 });
                        }}
                      >
                        ⋯
                      </button>
                    </div>
                  );
                })}
              </>
            )}
            {module === "adb" && (
              <>
                <div className="side-actions">
                  <button type="button" className="btn" onClick={() => void refreshAdb()}>
                    <IconPlus size={14} /> 刷新设备
                  </button>
                </div>
                <div className="hint">
                  {adbVer
                    ? "adb 已就绪"
                    : adbLoading
                      ? "正在检测 adb…"
                      : "未检测到 adb"}
                </div>
                {!adbLoading && adbList.length === 0 && adbVer !== "" && (
                  <div className="hint">没有已连接的设备</div>
                )}
                {adbList.map((d) => (
                  <div
                    key={d.serial}
                    className="tree-item"
                    onClick={() => void openAdbSession(d.serial)}
                    title={`${d.serial} · ${d.state} — 点击打开 adb shell`}
                  >
                    <IconAndroid size={15} />
                    <span className="grow">{d.model || d.serial}</span>
                    <button
                      type="button"
                      className="mini-btn"
                      title="打开设备文件管理（浏览 / 推送 / 拉取）"
                      onClick={(e) => {
                        e.stopPropagation();
                        setAdbSerial(d.serial);
                        void refreshAdbFiles(d.serial, "/sdcard");
                      }}
                    >
                      文件
                    </button>
                    <button
                      type="button"
                      className="mini-btn"
                      title="打开 logcat（实时日志）"
                      onClick={(e) => {
                        e.stopPropagation();
                        void openAdbSession(d.serial, "logcat");
                      }}
                    >
                      logcat
                    </button>
                    <span className={d.state === "device" ? "dot ok" : "dot off"} />
                  </div>
                ))}
                {/* 只读探测：这里**只能看**（fastboot devices / --version），
                    刷机、重启到 bootloader 这些命令都还没有 —— 所以标题写清楚，
                    别让用户以为点了能刷（README 里同步说明）。 */}
                <div className="tree-group">Fastboot 设备（bootloader 模式 · 只读探测）</div>
                <div className="hint">
                  {fbVer ? "fastboot 已就绪" : "未检测到 fastboot"}
                </div>
                {fbList.length === 0 && (
                  <div className="hint">没有 fastboot 设备</div>
                )}
                {fbList.map((d) => (
                  <div key={d.serial} className="tree-item" title={`${d.serial} · ${d.state}`}>
                    <IconAndroid size={15} />
                    <span className="grow ellipsis">{d.serial}</span>
                    <span className="tag">fastboot</span>
                  </div>
                ))}
              </>
            )}
          </div>

          {/* tmux 快捷操作：只在当前会话是 tmux 会话时出现，钉在侧栏底部 */}
          {module === "remote" && curTmuxSession !== "" && (
            <div className="tmux-dock">
              <button
                type="button"
                className="tmux-head"
                title="不想记 Ctrl+B 的话，点这里的按钮就行（Ctrl+B 本身照旧可用）"
                onClick={() => setTmuxDockOpen((v) => !v)}
              >
                {tmuxDockOpen ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}
                <span className="grow">tmux 快捷操作</span>
                <span className="tag">{curTmuxSession}</span>
              </button>

              {tmuxDockOpen && (
                <div className="tmux-body">
                  <div className="tmux-grid">
                    {TMUX_ACTIONS.map((a) => (
                      <button
                        key={a.key}
                        type="button"
                        className="mini-btn tmux-btn"
                        title={a.title}
                        disabled={tmuxBusy}
                        onClick={() => {
                          if (a.key === "rename-window") {
                            const cur = tmuxWinList.find((w) => w.active);
                            setTmuxRename(cur?.name ?? "");
                            return;
                          }
                          void runTmuxAction(a.key);
                        }}
                      >
                        {a.label}
                      </button>
                    ))}
                  </div>

                  {tmuxRename !== null && (
                    <div className="tmux-rename">
                      <input
                        autoFocus
                        value={tmuxRename}
                        placeholder="给当前窗口起个名字"
                        onChange={(e) => setTmuxRename(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            void runTmuxAction("rename-window", tmuxRename);
                            setTmuxRename(null);
                          } else if (e.key === "Escape") {
                            setTmuxRename(null);
                          }
                        }}
                      />
                      <button
                        type="button"
                        className="mini-btn"
                        onClick={() => {
                          void runTmuxAction("rename-window", tmuxRename);
                          setTmuxRename(null);
                        }}
                      >
                        确定
                      </button>
                    </div>
                  )}

                  <div className="tmux-sub">
                    <span className="grow">窗口（点一下切过去）</span>
                    <button
                      type="button"
                      className="mini-x"
                      style={{ opacity: 1 }}
                      title="刷新窗口列表"
                      onClick={() => void refreshTmuxWindows()}
                    >
                      ↻
                    </button>
                  </div>
                  <div className="tmux-wins">
                    {tmuxWinList.length === 0 && (
                      <div className="hint" style={{ padding: "2px 8px" }}>
                        没读到窗口（服务器可能刚断开，点 ↻ 重试）
                      </div>
                    )}
                    {tmuxWinList.map((w) => (
                      <button
                        key={w.index}
                        type="button"
                        className={"tmux-win" + (w.active ? " active" : "")}
                        title={w.panes > 1 ? `${w.panes} 个窗格` : undefined}
                        onClick={() => void runTmuxAction("select-window", String(w.index))}
                      >
                        <span className="dim">{w.index}</span>
                        <span className="grow ellipsis">{w.name || "—"}</span>
                        {w.panes > 1 && <span className="tag">{w.panes} 格</span>}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* herdr 快捷操作：和上面 tmux 那条同构 —— 只在当前会话是 herdr 窗格时出现，
              按钮走的是 herdr 自己的 socket API（另开一条 ssh），不模拟按键。 */}
          {module === "remote" && activeSession?.herdrPane && (
            <div className="tmux-dock herdr-dock">
              <button
                type="button"
                className="tmux-head"
                title="不想记 herdr 的快捷键的话，点这里的按钮就行（herdr 自己的快捷键照旧可用）"
                onClick={() => setHerdrDockOpen((v) => !v)}
              >
                {herdrDockOpen ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}
                <span className="grow">herdr 快捷操作</span>
                <span className="tag herdr">{activeSession.herdrPane}</span>
              </button>

              {herdrDockOpen && (
                <div className="tmux-body">
                  <div className="tmux-grid">
                    {HERDR_ACTIONS.map((a) => {
                      const destructive = a.key === "close-pane" || a.key === "close-workspace";
                      const armed = herdrArmed === a.key;
                      return (
                        <button
                          key={a.key}
                          type="button"
                          className={"mini-btn tmux-btn" + (armed ? " danger" : "")}
                          title={armed ? "再点一次就是真的关掉了" : a.title}
                          disabled={herdrBusy}
                          onClick={() => {
                            if (a.key === "rename-pane") {
                              setHerdrRename(activeSession.herdrPane ?? "");
                              return;
                            }
                            // 会真的关掉东西的两个动作：第一次点只是"上膛"，再点才执行
                            if (destructive && !armed) {
                              setHerdrArmed(a.key);
                              return;
                            }
                            void runHerdrAction(a.key);
                          }}
                        >
                          {armed ? "确认？" : a.label}
                        </button>
                      );
                    })}
                  </div>

                  {herdrRename !== null && (
                    <div className="tmux-rename">
                      <input
                        autoFocus
                        value={herdrRename}
                        placeholder="窗格名字（留空 = 清掉）"
                        onChange={(e) => setHerdrRename(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            void runHerdrAction("rename-pane", herdrRename);
                            setHerdrRename(null);
                          } else if (e.key === "Escape") {
                            setHerdrRename(null);
                          }
                        }}
                      />
                      <button
                        type="button"
                        className="mini-btn"
                        onClick={() => {
                          void runHerdrAction("rename-pane", herdrRename);
                          setHerdrRename(null);
                        }}
                      >
                        确定
                      </button>
                      <button type="button" className="mini-btn" onClick={() => setHerdrRename(null)}>
                        取消
                      </button>
                    </div>
                  )}

                  <div className="tmux-sub">
                    <span className="grow hint">
                      这些按钮是让服务器上的 herdr 去做（另开一条 ssh），不碰你的键盘
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}
        </aside>

        <main className="main">
          <div className="session-tabs">
            {sessions.map((s) => (
              <button
                key={s.id}
                type="button"
                className={
                  "session-tab" +
                  (s.id === activeId ? " active" : "") +
                  (s.id === dragTabId ? " dragging" : "")
                }
                // 左右拖动排序：把一个标签拖到另一个上面，就插到它前面/后面
                data-tab-id={s.id}
                // 注意：HTML5 的 draggable 在 WebView2 里对 <button> 不生效，
                // 所以这里自己用鼠标事件做拖动（见下面那个全局 mousemove 的 effect）
                onMouseDown={(e) => {
                  if (e.button === 0) {
                    setDragTabId(s.id);
                    setDragPos({ x: e.clientX, y: e.clientY });
                  }
                }}
                onClick={() => setActiveId(s.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setActiveId(s.id);
                  setTabMenu({ id: s.id, x: e.clientX, y: e.clientY });
                }}
                title={`${s.title}（右键可以重命名）`}
              >
                {moduleIcon(s.kind)}
                <span>{s.title}</span>
                {s.logPath && <span className="rec-dot" title="正在记录终端日志" />}
                <span className={"status-dot " + s.state} />
                {(s.state === "closed" || s.state === "error") && s.profileId && (
                  <span
                    className="tab-x"
                    title="重新连接"
                    onClick={(e) => {
                      e.stopPropagation();
                      void reconnectSession(s);
                    }}
                  >
                    ↻
                  </span>
                )}
                <span
                  className="tab-x"
                  onClick={(e) => {
                    e.stopPropagation();
                    void closeSession(s.id);
                  }}
                >
                  <IconClose size={12} />
                </span>
              </button>
            ))}
            {sessions.length === 0 && (
              <span className="session-tab placeholder">没有打开的会话</span>
            )}
          </div>

          {/* 拖动标签时跟着鼠标走的"虚影"（VSCode 那种手感：拖起来就看得见） */}
          {dragTabId && dragPos && (
            <div
              className="tab-drag-ghost"
              style={{ left: dragPos.x + 14, top: dragPos.y + 12 }}
            >
              {sessions.find((s) => s.id === dragTabId)?.title ?? "标签"}
            </div>
          )}

          {activeSession && activeSession.openFiles.length > 0 && (
            <div className="sub-tabs">
              <button
                type="button"
                className={"sub-tab term" + (activeSession.activeTab === "terminal" ? " active" : "")}
                onClick={() => selectTab(activeSession.id, "terminal")}
              >
                <IconTerminal size={14} /> 终端
              </button>
              {/* 分隔：左边是"终端"，右边是打开的文件 —— 不分开真的分不清哪个是哪个 */}
              <span className="sub-tab-sep" />
              <span className="sub-tabs-label">文件</span>
              {activeSession.openFiles.map((f) => (
                <button
                  key={f.path}
                  type="button"
                  className={"sub-tab file" + (activeSession.activeTab === f.name ? " active" : "")}
                  onClick={() => selectTab(activeSession.id, f.name)}
                >
                  <IconFile size={14} />
                  <span>{f.name}</span>
                  <span
                    className="tab-x"
                    onClick={(e) => {
                      e.stopPropagation();
                      closeFile(activeSession.id, f.name);
                    }}
                  >
                    <IconClose size={11} />
                  </span>
                </button>
              ))}
            </div>
          )}

          <div
            className="pane"
            style={{ "--term-bg": termBgOf(activeSession) } as CSSProperties}
          >
            {paneLayout !== "single" && (
              <div className={"pane-grid " + paneLayout}>
                {paneSlots.map((sid, i) => {
                  const ps = sid ? sessions.find((s) => s.id === sid) : null;
                  return (
                    <div
                      key={i}
                      className={"pane-cell" + (i === focusedPane ? " focused" : "")}
                      style={{ "--term-bg": termBgOf(ps) } as CSSProperties}
                      onClick={() => {
                        setFocusedPane(i);
                        if (sid) setActiveId(sid);
                      }}
                    >
                      <div className="pane-cell-head">
                        <span className="grow ellipsis">
                          {ps ? `${MODULE_LABEL[ps.kind]} · ${ps.title}` : `窗格 ${i + 1}（空）`}
                        </span>
                        {sid && (
                          <button
                            type="button"
                            className="mini-x"
                            style={{ opacity: 1 }}
                            title="把这个窗格空出来（不会关闭会话）"
                            onClick={(e) => {
                              e.stopPropagation();
                              setPanes((prev) => {
                                const next = [...prev];
                                next[i] = null;
                                return next;
                              });
                            }}
                          >
                            ✕
                          </button>
                        )}
                      </div>
                      <div className="pane-cell-body">
                        {ps ? (
                          <TerminalView
                            key={ps.id}
                            sessionId={ps.id}
                            bus={bus}
                            active={i === focusedPane}
                            onPasteFiles={(files) => void handleIncomingFiles(ps, files)}
                            pasteKey={settings.pasteKey}
                            rightClick={settings.rightClick}
                            copyKey={settings.copyKey}
                            fontSize={settings.fontSize}
                            scrollback={settings.scrollback}
                            light={themeKind(settings.theme) === "light"}
                            palette={termPaletteFor(
                              settings,
                              profiles.find((p) => p.id === ps.profileId),
                              kindOfSession(ps.kind),
                            )}
                            highlightEnabled={settings.highlightEnabled}
                            highlightRules={highlightRulesFor(
                              settings,
                              profiles.find((p) => p.id === ps.profileId),
                              kindOfSession(ps.kind),
                            )}
                            onCwd={(path) => handleTerminalCwd(ps.id, path)}
                            onCommandDone={(code) =>
                              setCmdExit((prev) => ({ ...prev, [ps.id]: { exit: code, at: Date.now() } }))
                            }
                            onNotice={notify}
                            onZoom={bumpFont}
                            herdrPane={
                              ps.herdrPane
                                ? { paneId: ps.herdrPane, mode: ps.herdrMode ?? "observe" }
                                : undefined
                            }
                            onHerdrInputNeeded={() =>
                              void ensureHerdrInput(
                                ps.id,
                                ps.profileId ?? "",
                                ps.user ?? null,
                                ps.herdrPane ?? "",
                              )
                            }
                          />
                        ) : (
                          <div className="pane-empty">
                            点左侧「会话」里的任意一个会话，它就会出现在这个窗格。
                            <br />
                            分屏只是多开几个视口，会话本身还是一个。
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {paneLayout === "single" && sessions.length === 0 ? (
              <div className="empty">
                <div className="empty-title">ZeeAI Term</div>
                <div className="empty-sub">
                  左侧「远程」里选一台服务器，或用 PowerShell / CMD / WSL 打开本地终端。
                </div>
              </div>
            ) : paneLayout === "single" ? (
              sessions.map((s) => (
                <div
                  key={s.id}
                  className="term-wrap"
                  style={{
                    // 用 flex（不是 block）：`.term-wrap` 里除了终端还可能有一条 `.herdr-bar`，
                    // 靠 flex 把高度**分**给两者。写成 block 会让 `.terminal-host` 的 flex:1 失效、
                    // 终端按自己的内容高度撑开，最后一行就被下面的输入窗盖住了（用户报的 bug）。
                    // 这里只管"显不显示"，布局规则在 styles.css 的 .term-wrap 里。
                    display:
                      s.id === activeId && s.activeTab === "terminal" ? "flex" : "none",
                  }}
                >
                  {/* herdr 会话：终端上方挂一条**一眼可见**的状态条（像 tmux 的状态栏那样），
                      避免"到底进没进 herdr"这种疑惑。 */}
                  {s.herdrPane && (
                    <div className="herdr-bar" title={`${s.title}\nherdr 工作区/窗格：${s.herdrPane}`}>
                      <span className="tag herdr">herdr</span>
                      <span>{s.herdrMode === "control" ? "接管中（可写）" : "只读观察"}</span>
                      <span className="dim">{s.herdrPane}</span>
                      <span className="grow" />
                      <span className="dim">
                        {herdrServer
                          ? herdrServer.running
                            ? `服务运行中 · ${herdrServer.panes} 个窗格`
                            : "服务没在跑"
                          : ""}
                      </span>
                    </div>
                  )}
                  <TerminalView
                    sessionId={s.id}
                    bus={bus}
                    active={s.id === activeId && s.activeTab === "terminal"}
                    onPasteFiles={(files) => void handleIncomingFiles(s, files)}
                    pasteKey={settings.pasteKey}
                    rightClick={settings.rightClick}
                    copyKey={settings.copyKey}
                    // 单窗格模式下**所有**会话都挂着（用 display:none 藏着，为了不丢回滚缓冲），
                    // 但只有当前这条看得见 —— WebGL 渲染器只给看得见的挂，
                    // 否则开 N 个会话就占 N 个 GPU 上下文（见 Terminal.tsx 里那段说明）
                    visible={s.id === activeId && s.activeTab === "terminal"}
                    fontSize={settings.fontSize}
                    scrollback={settings.scrollback}
                    light={themeKind(settings.theme) === "light"}
                    palette={termPaletteFor(
                      settings,
                      profiles.find((p) => p.id === s.profileId),
                      kindOfSession(s.kind),
                    )}
                    highlightEnabled={settings.highlightEnabled}
                    highlightRules={highlightRulesFor(
                      settings,
                      profiles.find((p) => p.id === s.profileId),
                      kindOfSession(s.kind),
                    )}
                    onCwd={(path) => handleTerminalCwd(s.id, path)}
                    onCommandDone={(code) =>
                      setCmdExit((prev) => ({ ...prev, [s.id]: { exit: code, at: Date.now() } }))
                    }
                    onNotice={notify}
                    onZoom={bumpFont}
                    herdrPane={
                      s.herdrPane
                        ? { paneId: s.herdrPane, mode: s.herdrMode ?? "observe" }
                        : undefined
                    }
                    onHerdrInputNeeded={() =>
                      void ensureHerdrInput(
                        s.id,
                        s.profileId ?? "",
                        s.user ?? null,
                        s.herdrPane ?? "",
                      )
                    }
                  />
                </div>
              ))
            ) : null}
            {paneLayout === "single" && activeFile && (
              <div className="file-wrap">
                <FileView
                  key={activeFile.path}
                  file={activeFile}
                  profileId={activeSession?.profileId}
                  userOverride={activeSession?.user ?? null}
                  onNotice={notify}
                />
              </div>
            )}
          </div>

          {/* ---------- AI 输入窗：**默认收起**成一条细栏，点箭头才拉出来慢慢写 ----------
              终端才是主角：收起时只占 26px，你照旧直接在 SSH 里敲字；
              要用它写长提示词 / 传图片时再展开（展开后终端会自动重排，见 Terminal 的 ResizeObserver）。 */}
          {activeSession && (
            <div className={"composer" + (composerOpen ? " open" : " collapsed")}>
              <button
                type="button"
                className="composer-bar"
                title={
                  composerOpen
                    ? "收起输入窗（Esc 或 Ctrl+Alt+A）"
                    : "拉出输入窗：多行编辑、可粘贴 / 上传图片，Enter 发送（Ctrl+Alt+A）"
                }
                onClick={() => setComposerOpen((v) => !v)}
              >
                {composerOpen ? <IconChevronsDown size={16} /> : <IconChevronsUp size={16} />}
                <span className="grow ellipsis" style={{ textAlign: "left" }}>
                  发给 AI · {activeSession.title}
                  <span className="dim">
                    {activeSession.herdrPane
                      ? activeSession.herdrMode === "control"
                        ? " · herdr 接管窗格"
                        : " · herdr 只读观察窗（发不了字，先接管）"
                      : activeSession.kind === "remote"
                        ? " · SSH"
                        : " · 本机"}
                  </span>
                </span>
                {!composerOpen && <span className="dim">点这里展开</span>}
              </button>
              {composerOpen && (
                <>
              {composerFiles.length > 0 && (
                <div className="composer-files">
                  {composerFiles.map((f) => (
                    <div className="composer-card" key={f.remote} title={`${f.name}\n${f.remote}`}>
                      {f.thumb ? (
                        <img className="composer-thumb" src={f.thumb} alt={f.name} />
                      ) : (
                        <div className="composer-thumb composer-thumb-file">📄</div>
                      )}
                      <span className="composer-card-name ellipsis">{f.name}</span>
                      <button
                        type="button"
                        className="mini-x composer-card-x"
                        style={{ opacity: 1 }}
                        title="移除这个附件（顺手删掉本地临时文件）"
                        onClick={() => {
                          void pasteDiscardFile(f.local).catch(() => {});
                          setComposerFiles((prev) => prev.filter((x) => x.remote !== f.remote));
                        }}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <textarea
                className="composer-input"
                placeholder="写给 AI 的话…（Enter 发送 / Shift+Enter 换行；可直接 Ctrl+V 粘图片，或把文件拖进来）"
                value={composerText}
                autoFocus
                onChange={(e) => setComposerText(e.target.value)}
                onPaste={(e) => {
                  const files = Array.from(e.clipboardData?.files ?? []);
                  if (!files.length) return; // 纯文本：照旧粘进编辑框，不拦
                  e.preventDefault();
                  e.stopPropagation();
                  void (async () => {
                    const out: { name: string; bytes: Uint8Array }[] = [];
                    for (const f of files) {
                      try {
                        out.push({
                          name: f.name || "paste.png",
                          bytes: new Uint8Array(await f.arrayBuffer()),
                        });
                      } catch {
                        /* 单个读失败就跳过 */
                      }
                    }
                    if (!out.length) return;
                    try {
                      const locals: string[] = [];
                      for (const f of out)
                        locals.push(await pasteSaveFile(pasteName(f.name), bytesToB64(f.bytes)));
                      await composerAttachPaths(activeSession, locals, true);
                    } catch (err) {
                      notify("粘贴上传失败：" + String(err));
                    }
                  })();
                }}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setComposerOpen(false);
                    return;
                  }
                  // Enter 发送、Shift+Enter 换行 —— 和 VS Code / 主流聊天框一致。
                  // **有意这么选**：写长提示词时换行比发送更常用，所以把修饰键留给换行。
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void sendComposer();
                  }
                }}
              />
              <div className="composer-actions">
                <button
                  type="button"
                  className="mini-btn"
                  disabled={composerBusy}
                  title="选本地文件（图片 / 文本都行）：先上传到远端，再把路径一起发给 AI"
                  onClick={() => void composerPickFiles(activeSession)}
                >
                  ＋ 添加图片 / 文件
                </button>
                {composerBusy && <span className="hint">正在上传…</span>}
                <span className="hint">Enter 发送 · Shift+Enter 换行 · 可直接 Ctrl+V 粘图片</span>
                <span className="grow" />
                <button
                  type="button"
                  className="btn primary"
                  disabled={composerBusy}
                  onClick={() => void sendComposer()}
                >
                  发送
                </button>
              </div>
                </>
              )}
            </div>
          )}

          {/* 直接粘进终端时的缩略图浮层：几秒后自己消失（没有它，用户不知道粘对没有） */}
          {pasteCard && (
            <div className="paste-card" onClick={() => setPasteCard(null)} title="点一下关掉">
              {pasteCard.thumb ? (
                <img className="paste-card-thumb" src={pasteCard.thumb} alt={pasteCard.name} />
              ) : null}
              <div className="paste-card-meta">
                <span className="ellipsis">已上传：{pasteCard.name}</span>
                <span className="dim ellipsis" title={pasteCard.remote}>
                  {pasteCard.remote}
                </span>
              </div>
            </div>
          )}
        </main>

        {aiPanelOpen && (
          <aside className="ai-panel">
            <div className="ai-head">
              {/* 标题**固定**，不再跟着当前会话走。
                  以前写「AI Agent · PowerShell」，下面列的却是远端的卡 —— 用户实测因此以为
                  "它探测到我的 PowerShell 里有 Codex"。面板里的卡片本来就是全环境的，
                  所以标题只说这是什么，环境归属交给每张卡自己标（docs/backlog.md 第 2 条 ②）。 */}
              <span className="grow ellipsis" title="全环境（本机 / WSL / 各台服务器）的 AI 任务">
                AI 任务看板
              </span>
              <button
                type="button"
                className="mini-btn"
                style={{ opacity: 1 }}
                title="探测一次：本机 / 服务器上现在有没有 AI 在跑（只在你点的时候查，不会自动探测）"
                disabled={aiRefreshing}
                onClick={() => void refreshAiPanel()}
              >
                {aiRefreshing ? "探测中…" : "刷新"}
              </button>
              <button
                type="button"
                className="mini-x"
                style={{ opacity: 1 }}
                title="收起面板"
                onClick={() => setAiPanelOpen(false)}
              >
                ✕
              </button>
            </div>

            {/* ---------- AI 任务看板：多环境汇总 ---------- */}
            {/* 口径 §10.2：**承载健康只在异常时出现**。
                "herdr 服务：运行中 · 3 个窗格"这种正常状态看一眼就再也不需要了，
                常驻等于每一层都在抢同一块注意力 —— 所以没异常时整块不渲染，
                能查的东西（服务 / 工作区 / 来源明细）都在下面的折叠行与悬停里。 */}
            <div className="ai-section">需要你 {boardNeedsYou.length}</div>
            {boardInstances.length === 0 ? (
              <div className="hint" style={{ padding: "2px 12px 8px" }}>
                点「刷新」看看本机 / 服务器上现在有没有 AI 在跑
              </div>
            ) : null}
            {boardNeedsYou.length > 0 && (
              <div className="ai-board">{boardNeedsYou.map((i) => boardCard(i))}</div>
            )}

            <div className="ai-section">运行中 {boardWorking.length}</div>
            {boardWorking.length > 0 && (
              <div className="ai-board">{boardWorking.map((i) => boardCard(i))}</div>
            )}

            {/* 「最近完成」「空闲」各折成一行（§10.1 / §10.2）：点开才渲染明细。
                数据一直落盘（`ai_turns.json`），不显示 ≠ 丢掉。 */}
            {boardFinished.length > 0 && (
              <button
                type="button"
                className="ai-fold"
                title="最近完成的实例：谁 / 什么时候 / 有什么产物（点开才看）"
                onClick={() => setFinishedOpen((v) => !v)}
              >
                {finishedOpen ? "▾" : "▸"} 最近完成 {boardFinished.length} 项
              </button>
            )}
            {finishedOpen &&
              boardFinished.map((i) => (
                <div className="ai-board" key={i.id}>
                  {boardCard(i)}
                </div>
              ))}

            {boardIdle.length > 0 && (
              <button
                type="button"
                className="ai-fold"
                title="空闲 / 状态未知的实例：它们是现状，不是任务（点开才看）"
                onClick={() => setIdleOpen((v) => !v)}
              >
                {idleOpen ? "▾" : "▸"} 空闲 {boardIdle.length} 项
              </button>
            )}
            {idleOpen &&
              boardIdle.map((i) => (
                <div className="ai-board" key={i.id}>
                  {boardCard(i)}
                </div>
              ))}

            {/* ---------- L4 承载健康：**只在异常时出现**（§10.2 / §10.5） ----------
                为什么只在异常时：`herdr 服务：运行中 · 3 个窗格` 这种正常状态用户看一眼就
                再也不需要了，常驻等于每一层都在抢同一块注意力。
                进这一块的条件只有三类：探测失败 / herdr 太旧 / 有工作区要清理。
                （服务没在跑由 herdr 自己按需拉起，所以不算异常。）
                没跑 agent 的承载（CMD 这类空承载，§10.5 **不上板**）也在这块的悬停里查。 */}
            {/* 没点过「刷新」就不显示承载健康：`aiSource === null` 现在也可能是"还没探"，
                直接写"探测失败"会冤枉一台好好的机器。 */}
            {!aiSourceProbed ? null : aiSourceProbing ? null : !aiSource ? (
              <div
                className="ai-source-line warn"
                role="button"
                title="探测这台服务器时没连上（可能是网络/sshd 一时拥塞）。点击重试。"
                onClick={() => void refreshAiSource(true)}
              >
                承载健康 · 探测失败（没连上，不代表没装）· 点一下重试
              </div>
            ) : aiSource.herdrVersion && aiSource.compat === "too_old" ? (
              <div
                className="ai-source-line warn"
                role="button"
                title={`herdr ${aiSource.herdrVersion} 的协议是 ${aiSource.protocol}（< 20），太旧 → 已回退到本机探测。点击重新探测。`}
                onClick={() => void refreshAiSource(true)}
              >
                承载健康 · herdr {aiSource.herdrVersion} 太旧（协议 {aiSource.protocol} &lt; 20）
                → 已回退到本机探测
              </div>
            ) : herdrCleanList.length > 0 ? (
              <div className="modal-inline-action" style={{ padding: "2px 12px 8px" }}>
                <span
                  className="hint"
                  title={
                    // 「我开了哪些承载」查得到的落点（§10.5）：
                    // 服务器上所有 herdr 工作区 + 没在用的 + 能安全清理的 + 空承载清单
                    `服务器上的工作区：${herdrScan?.workspaces.join("、") || "（没有）"}\n` +
                    `没在用（不在任何已打开/历史会话里）：${herdrOrphanList.join("、") || "（没有）"}\n` +
                    `其中是空壳（只停在提示符上，可以安全清理）：${herdrCleanList.join("、")}\n` +
                    `承载与状态来源（没跑 agent 的不上看板，§10.5）：${
                      boardInstances
                        .map((i) => `${aiAgentLabel(i.agent)}@${aiCarrierLabel(i.carrier)}`)
                        .join("、") || "（无）"
                    }`
                  }
                >
                  承载健康 · herdr 工作区：{herdrScan?.workspaces.length ?? 0} 个
                  {herdrOrphanList.length ? `（${herdrOrphanList.length} 个没在用）` : "（都在用）"}
                </span>
                {herdrCleanArmed ? (
                  <>
                    <button
                      type="button"
                      className="mini-btn danger"
                      title={`会关掉：${herdrCleanList.join("、")}\n（都是停在提示符上的空壳工作区；里面正跑着东西的一个都不会碰）`}
                      onClick={() => void cleanHerdrOrphans()}
                    >
                      确认清理（{herdrCleanList.join("、")}）
                    </button>
                    <button
                      type="button"
                      className="mini-btn"
                      onClick={() => setHerdrCleanArmed(false)}
                    >
                      取消
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="mini-btn"
                    title="只关掉「不属于任何已打开/历史会话」而且「里面只停着 shell」的工作区"
                    onClick={() => setHerdrCleanArmed(true)}
                  >
                    清理空壳（{herdrCleanList.length}）…
                  </button>
                )}
              </div>
            ) : null}
            {/* 装了 herdr 时：服务的生命周期（停止会关掉它管着的所有窗格 → 二段确认）。
                只在"当前会话那台机器"上给这个开关；正常运行时它是折叠的。
                注意和上面那条互斥：有工作区要清理时先让用户清理（两行挤一起就不是"只在异常时出现"了）。 */}
            {aiSource?.herdrVersion &&
            herdrServer?.running &&
            herdrCleanList.length === 0 &&
            (activeSession?.profileId || herdrScan) ? (
              <details className="ai-health" open={false}>
                <summary title="承载健康：herdr 服务 / 工作区 / 探测明细（正常时不占位置）">
                  herdr 服务：运行中 · {herdrServer.panes} 个窗格
                </summary>
                <div className="modal-inline-action" style={{ padding: "6px 0 2px" }}>
                  {herdrStopArmed ? (
                    <>
                      <button
                        type="button"
                        className="mini-btn danger"
                        title={
                          "停止 herdr 服务 —— 它管着的所有窗格都会关掉，" +
                          "里面正在跑的 AI 也会一起没；看板上这些窗格的卡片会跟着变准不了。\n" +
                          "（只想腾地方的话，用「清理空壳工作区」一个个关更稳）"
                        }
                        onClick={() => void stopHerdrServer()}
                      >
                        确认停止（会关掉所有 herdr 窗格）
                      </button>
                      <button
                        type="button"
                        className="mini-btn"
                        onClick={() => setHerdrStopArmed(false)}
                      >
                        取消
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="mini-btn"
                      onClick={() => setHerdrStopArmed(true)}
                    >
                      停止服务…
                    </button>
                  )}
                </div>
              </details>
            ) : null}
            {/* 没装 herdr 时给一个"一键安装"入口：由 Windows 侧下载 → 校验 sha256 →
                scp 到 ~/.local/bin（不执行远端脚本、不要 root）。已经装了就不显示。 */}
            {aiSource && !aiSource.herdrVersion && activeSession?.profileId ? (
              <div className="modal-inline-action" style={{ padding: "2px 12px 8px" }}>
                {herdrInstalling[activeSession.profileId] ? (
                  <span className="hint">正在装 herdr：{herdrInstalling[activeSession.profileId]}</span>
                ) : (
                  <button
                    type="button"
                    className="mini-btn"
                    title="从 herdr.dev 拿官方版本号与 sha256，在 Windows 侧下载并校验后上传到 ~/.local/bin/herdr（不需要 root）"
                    onClick={() =>
                      void installHerdrFor(activeSession.profileId ?? "", activeSession.user ?? null)
                    }
                  >
                    一键安装 herdr
                  </button>
                )}
              </div>
            ) : null}

            {/* ---------- AI 任务时间线（G-01）：落盘的历史，应用重启后还在 ---------- */}
            {/* 口径 docs/design-ai-board-v2.md §10.1：不要再有常驻列表，
                只留折叠一行（默认收起，点开才看明细；记录一直落盘） */}
            <div className="ai-section">
              <button
                type="button"
                className="mini-btn"
                style={{ opacity: 1 }}
                title="点开看明细（记录一直落盘，重启应用也还在）"
                onClick={() => setTimelineAll((v) => !v)}
              >
                {timelineAll ? "▾" : "▸"} 最近完成 {timeline.length} 项
              </button>
              <button
                type="button"
                className="mini-x"
                style={{ marginLeft: "auto", opacity: 1 }}
                title="刷新"
                onClick={() => void loadTimeline()}
              >
                ⟳
              </button>
              {timeline.length > 0 && (
                <button
                  type="button"
                  className="mini-x"
                  style={{ opacity: 1 }}
                  title="清空时间线（只删记录，不动会话和文件）"
                  onClick={() => {
                    void aiTimelineClear()
                      .then(() => setTimeline([]))
                      .catch(() => {});
                    notify("已清空 AI 任务时间线");
                  }}
                >
                  ✕
                </button>
              )}
            </div>
            {!timelineAll ? null : timeline.length === 0 ? (
              <div className="hint" style={{ padding: "2px 12px 8px" }}>
                还没有记录。AI 跑完一轮会记在这里（重启应用也还在）。
              </div>
            ) : (
              // 不在这么小的框里让人上下拖：默认只露 3 条，下面给一个"展开全部"，
              // 展开后整块跟着面板滚（而不是在那个 260px 的小窗里拖）
              <>
              <div className={"ai-timeline" + (timelineAll ? " all" : "")}>
                {(timelineAll ? timeline.slice(0, 60) : timeline.slice(0, 3)).map((r) => {
                  // 能不能"切过去"：找标题相同的已打开会话
                  const target = sessions.find(
                    (s) => (s.title ?? "").trim() === (r.sessionTitle ?? "").trim(),
                  );
                  return (
                    <div className="ai-tl-row" key={r.id}>
                      <div className="ai-tl-line">
                        <span className="grow ellipsis" title={r.sessionTitle}>
                          {new Date(r.completedAt * 1000).toLocaleString("zh-CN", {
                            month: "2-digit",
                            day: "2-digit",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                          {` · ${r.server}`}
                          {r.cwd ? ` · ${dirBase(r.cwd)}` : ""}
                        </span>
                        <span className="dim">
                          {r.durationMs > 0 ? aiDurationText(r.durationMs) : ""}
                        </span>
                      </div>
                      <div className="ai-tl-msg ellipsis" title={r.message}>
                        {r.message || "（这一轮没有留下文字）"}
                      </div>
                      <div className="ai-tl-actions">
                        {r.artifacts.slice(0, 3).map((n) => (
                          <span className="ai-tag" key={n}>
                            📄 {n}
                          </span>
                        ))}
                        {r.artifacts.length > 3 && (
                          <span className="dim">+{r.artifacts.length - 3}</span>
                        )}
                        {target ? (
                          <button
                            type="button"
                            className="mini-btn"
                            title={`切到「${target.title}」`}
                            onClick={() => {
                              setActiveId(target.id);
                              notify(`已切到「${target.title}」`);
                            }}
                          >
                            切过去
                          </button>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
              </>
            )}

            {aiNotices.length > 0 && (
              <div className="ai-notices">
                <div className="ai-section">
                  消息通知（{aiNotices.length}）
                  <button
                    type="button"
                    className="mini-x"
                    style={{ marginLeft: "auto", opacity: 1 }}
                    title="清空"
                    onClick={() => setAiNotices([])}
                  >
                    ✕
                  </button>
                </div>
                {aiNotices.slice(0, 4).map((n) => (
                  <div className="ai-notice" key={n.id}>
                    <span className="dot ok" />
                    <span className="grow ellipsis" title={n.text}>
                      {n.text}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {!activeSession?.profileId && (
              <div className="hint" style={{ padding: "10px 12px" }}>
                先打开一个 SSH 会话
              </div>
            )}

          </aside>
        )}
      </div>

      {/* 「AI 命令行工具」不再占着整块空间：收成右下角一个小按钮，点了才展开。
          展开的面板贴着右下角（不挡中间），再点一次或点空白就收起。 */}
      {aiPanelOpen && activeSession?.profileId && (
        <div className={"tool-dock" + (toolListOpen ? " open" : "")}>
          {toolListOpen && (
            <div className="tool-dock-body">
              <div className="tool-dock-head">
                <span className="grow">AI 命令行工具</span>
                <span className="dim">
                  {(aiState?.tools ?? []).filter((t) => t.installed).length} 个已安装
                </span>
              </div>
              {aiToolsVisible(aiState?.tools ?? []).map((t) => {
                    const running = aiState?.running.includes(t.name) ?? false;
                    return (
                      <div className="ai-tool" key={t.name}>
                      <div className="ai-tool-line">
                        <span className={"dot " + (running ? "ok" : t.installed ? "idle" : "off")} />
                        <span className="grow ellipsis">{t.label}</span>
                        <span className="dim">
                          {running ? "运行中" : t.installed ? "已安装" : "未安装"}
                        </span>
                      </div>
                      <div className="ai-tool-meta ellipsis" title={t.version || t.installCmd}>
                        {t.version || t.installCmd}
                      </div>
                      <div className="ai-tool-actions">
                        {!t.installed && (
                          <span className="ai-install-hint">未安装 —— 先装</span>
                        )}
                        <button
                          type="button"
                          className={"mini-btn" + (t.installed ? " primary" : "")}
                          title={
                            t.installed
                              ? "把启动命令敲进当前终端并回车，AI 跑完会通知你"
                              : "把安装命令敲进当前终端并回车，进度你自己看"
                          }
                          disabled={!activeSession}
                          onClick={() =>
                            aiStartTool(t.installed ? t.runCmd : t.installCmd, t.installed)
                          }
                        >
                          {t.installed ? "在终端启动" : "在终端安装"}
                        </button>
                      </div>
                      </div>
                    );
                  })}
              {!aiState && <div className="hint">正在探测这台服务器…</div>}
            </div>
          )}
          <button
            type="button"
            className="tool-dock-btn"
            title="AI 命令行工具（安装与在终端启动）"
            onClick={() => setToolListOpen((v) => !v)}
          >
            {toolListOpen ? "▾" : "▴"} AI 工具
            <span className="dim">
              {(aiState?.tools ?? []).filter((t) => t.installed).length}
            </span>
          </button>
        </div>
      )}

      {/* 口径 docs/design-ai-board-v2.md §10.3：技术标识（编码 / 终端类型）收进悬停，
          状态栏只留：会话 · 连通性 · 需要你 · 传输 */}
      <div
        className="statusbar"
        title="终端编码 UTF-8 · 终端类型 xterm-256color（右键终端可看「会话信息」）"
      >
        <span className="stat">
          <IconActivity size={14} />
          {activeSession
            ? `${MODULE_LABEL[activeSession.kind]} · ${activeSession.title} · ${stateText(activeSession.state)}`
            : "就绪"}
        </span>
        <span className="spacer" />
        {statusMsg && (
          <span
            className={"status-notice " + statusMsg.kind}
            // 悬停给**完整原文**：状态栏只显示中文短句（后端返回的是
            // 「中文短句｜原始信息：<英文>」，英文那段太长，挤在状态栏里没人读得下去）
            title={statusMsg.detail || statusMsg.text}
            onClick={() => setStatusMsg(null)}
          >
            {statusMsg.text}
          </span>
        )}
        {activeFile && <span className="stat">{activeFile.path}</span>}
        {/* 状态栏只留四件事：会话 · 连通性 · 「需要你 N」· 传输（§10.3）。
            所以这里**只有**「需要你」那一个 chip —— "AI 已完成" 不再单独占一个
            （完成已经在面板的「最近完成 N 项」里，三处各说一遍是这轮要收掉的乱）。
            点它 = 打开面板；needs-you 是唯一真正值得打断用户的事。 */}
        {aiNeedIds.length > 0 && (
          <button
            type="button"
            className="stat ai-need-chip"
            title={`${boardInstances
              .filter((i) => i.state === "needs-you")
              .map((i) => `${aiAgentLabel(i.agent)} · ${aiInstanceWhere(i)} · ${i.badge}`)
              .join("\n")}\n\n点这里打开看板（红点亮到你处理为止）`}
            onClick={() => setAiPanelOpen(true)}
          >
            需要你 {aiNeedIds.length}
          </button>
        )}
        {isAdminMode && (
          <span
            className="stat admin"
            title="当前以管理员身份运行：新开的 PowerShell / CMD / WSL 都是管理员"
          >
            🛡 管理员
          </span>
        )}
      </div>

      {transfers.length > 0 && (
        <div className="transfer-dock">
          <div className="transfer-head">
            <span>文件传输（{transfers.filter((t) => t.status === "running").length} 进行中）</span>
            <button
              type="button"
              className="mini-x"
              style={{ opacity: 1 }}
              title="清空列表"
              onClick={() => setTransfers([])}
            >
              ✕
            </button>
          </div>
          {transfers.map((t) => {
            const pct =
              t.total > 0 ? Math.min(100, Math.round((t.done / t.total) * 100)) : 0;
            return (
              <div key={t.id} className={"transfer-item " + t.status}>
                <div className="transfer-line">
                  <span className="grow ellipsis" title={t.name}>
                    {t.name}
                  </span>
                  <span className="dim">
                    {t.status === "done"
                      ? "完成"
                      : t.status === "failed"
                        ? "失败"
                        : `${pct}%`}
                  </span>
                </div>
                <div className="transfer-bar">
                  <div
                    className="transfer-fill"
                    style={{ width: t.status === "done" ? "100%" : `${pct}%` }}
                  />
                </div>
                <div className="transfer-meta">
                  {humanSize(t.done)}
                  {t.total > 0 ? ` / ${humanSize(t.total)}` : ""}
                  {t.message ? ` · ${t.message}` : ""}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {openMenu && <div className="menu-overlay" onClick={() => setOpenMenu(null)} />}

      {serialMenu && (
        <div
          className="ctx-backdrop"
          onClick={() => setSerialMenu(null)}
          onContextMenu={(e) => {
            e.preventDefault();
            setSerialMenu(null);
          }}
        >
          <div
            className="ctx-menu"
            style={{
              left: Math.min(Math.max(0, serialMenu.x), Math.max(0, window.innerWidth - 210)),
              top: Math.min(Math.max(0, serialMenu.y), Math.max(0, window.innerHeight - 190)),
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="menu-head ellipsis">{serialMenu.profile.name}</div>
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                const p = serialMenu.profile;
                setSerialMenu(null);
                void openSerialSession(p);
              }}
            >
              打开串口终端
            </button>
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                const p = serialMenu.profile;
                setSerialMenu(null);
                openSerialDialog(p);
              }}
            >
              编辑（端口 / 波特率 / 校验…）
            </button>
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                const p = serialMenu.profile;
                setSerialMenu(null);
                void duplicateProfile(p);
              }}
            >
              复制
            </button>
            <div className="menu-sep" />
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                const p = serialMenu.profile;
                setSerialMenu(null);
                setConfirmDialog({
                  title: "删除串口连接",
                  message: `确定删除「${p.name}」这条串口连接吗？`,
                  onOk: () => void removeSerialProfile(p),
                });
              }}
            >
              删除
            </button>
          </div>
        </div>
      )}

      {adbSerial && (
        <div className="modal-backdrop" onClick={() => setAdbSerial(null)}>
          <div className="modal wide" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">设备文件 · {adbSerial}</div>
            <div className="modal-body">
              <div className="side-actions">
                <button
                  type="button"
                  className="mini-btn"
                  title="回到 /sdcard"
                  onClick={() => void refreshAdbFiles(adbSerial, "/sdcard")}
                >
                  /sdcard
                </button>
                <button
                  type="button"
                  className="mini-btn"
                  title="上一级"
                  onClick={() => {
                    const parent = adbPath.replace(/\/+$/, "").split("/").slice(0, -1).join("/");
                    void refreshAdbFiles(adbSerial, parent.startsWith("/") ? parent : "/");
                  }}
                >
                  上一级
                </button>
                <button
                  type="button"
                  className="mini-btn"
                  onClick={() => void refreshAdbFiles(adbSerial, adbPath)}
                >
                  刷新
                </button>
                <button
                  type="button"
                  className="mini-btn"
                  title="把本机文件推到当前目录"
                  onClick={() => void adbUpload(adbSerial)}
                >
                  推送文件
                </button>
              </div>
              <div className="modal-inline-action" style={{ paddingBottom: 8 }}>
                <input
                  className="modal-input"
                  style={{ flex: 1 }}
                  value={adbPath}
                  spellCheck={false}
                  onChange={(e) => setAdbPath(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && adbSerial) void refreshAdbFiles(adbSerial, adbPath);
                  }}
                />
              </div>
              <div className="modal-inline-action" style={{ paddingBottom: 8 }}>
                <input
                  className="modal-input"
                  style={{ flex: 1 }}
                  placeholder="新建文件夹的名字"
                  value={adbNewName}
                  onChange={(e) => setAdbNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && adbSerial) void adbMkdirNow(adbSerial, adbNewName);
                  }}
                />
                <button
                  type="button"
                  className="mini-btn"
                  style={{ marginLeft: 6 }}
                  disabled={!adbNewName.trim()}
                  onClick={() => adbSerial && void adbMkdirNow(adbSerial, adbNewName)}
                >
                  新建文件夹
                </button>
              </div>
              {adbLoading && <div className="hint">正在读取设备目录…</div>}
              {!adbLoading && adbFiles.length === 0 && (
                <div className="hint">空目录</div>
              )}
              {adbFiles.map((f) => (
                <div
                  key={f.name}
                  className="tree-item"
                  title={f.isDir ? "进入目录" : "下载到本机"}
                  onClick={() =>
                    adbSerial &&
                    (f.isDir
                      ? void refreshAdbFiles(adbSerial, joinRemote(adbPath, f.name))
                      : void adbDownload(adbSerial, f.name))
                  }
                >
                  {f.isDir ? <IconFolder size={14} /> : <IconFile size={14} />}
                  <span className="grow ellipsis">{f.name}</span>
                  <span className="dim">{f.isDir ? "" : humanSize(f.size)}</span>
                  <button
                    type="button"
                    className="mini-x"
                    title="删除"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (adbSerial) void adbDelete(adbSerial, f.name, f.isDir);
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setAdbSerial(null)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {gitInitDialog && (
        <div className="modal-backdrop" onClick={() => setGitInitDialog(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">新建 Git 仓库</div>
            <div className="modal-body">
              <label className="modal-field">
                仓库目录（不存在会自动创建）
                <input
                  autoFocus
                  value={gitInitDialog.path}
                  placeholder="D:\code\my-repo"
                  onChange={(e) => setGitInitDialog({ path: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void createGitRepo(gitInitDialog.path);
                    if (e.key === "Escape") setGitInitDialog(null);
                  }}
                />
              </label>
              <div className="modal-inline-action" style={{ paddingBottom: 8 }}>
                <button
                  type="button"
                  className="mini-btn"
                  onClick={() => {
                    void (async () => {
                      const picked = await openLocalDialog({
                        directory: true,
                        title: "选一个目录（可以是空目录）",
                      });
                      if (picked && !Array.isArray(picked)) {
                        setGitInitDialog({ path: picked });
                      }
                    })();
                  }}
                >
                  浏览目录…
                </button>
                <span className="hint" style={{ marginLeft: 8 }}>
                  会在该目录执行 <code>git init -b main</code>，然后开一个终端。
                </span>
              </div>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setGitInitDialog(null)}>
                取消
              </button>
              <button
                type="button"
                className="btn primary"
                onClick={() => void createGitRepo(gitInitDialog.path)}
              >
                创建并打开终端
              </button>
            </div>
          </div>
        </div>
      )}

      {diffDialog && (
        <div className="modal-backdrop" onClick={() => setDiffDialog(null)}>
          <div className="modal wide diff-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head ellipsis" title={diffDialog.title}>
              {diffDialog.title}
            </div>
            <div className="modal-body diff-body">
              <pre className="diff-pre">
                {diffDialog.text.split("\n").map((line, i) => (
                  <div
                    key={i}
                    className={
                      "diff-line" +
                      (line.startsWith("+") && !line.startsWith("+++")
                        ? " add"
                        : line.startsWith("-") && !line.startsWith("---")
                          ? " del"
                          : line.startsWith("@@")
                            ? " hunk"
                            : line.startsWith("diff ") ||
                                line.startsWith("index ") ||
                                line.startsWith("commit ")
                              ? " meta"
                              : "")
                    }
                  >
                    {line || " "}
                  </div>
                ))}
              </pre>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setDiffDialog(null)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {serialDialog && (
        <div className="modal-backdrop">
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              {serialDialog.isNew ? "新建串口连接" : "编辑串口连接"}
              <button
                type="button"
                className="mini-x"
                style={{ float: "right", opacity: 1 }}
                title="关闭"
                onClick={() => setSerialDialog(null)}
              >
                ✕
              </button>
            </div>
            <div className="modal-body">
              <label className="modal-field">
                名称
                <input
                  value={serialDialog.draft.name}
                  placeholder="比如：ESP32 调试口"
                  onChange={(e) => patchSerialDraft({ name: e.target.value })}
                />
              </label>

              <label className="modal-field">
                端口
                <select
                  value={
                    serialPorts.some((p) => p.path === serialDialog.draft.serial?.path)
                      ? serialDialog.draft.serial?.path
                      : "__custom__"
                  }
                  onChange={(e) => {
                    if (e.target.value !== "__custom__") {
                      patchSerialDraft({}, { path: e.target.value });
                    }
                  }}
                >
                  {serialPorts.map((p) => (
                    <option key={p.path} value={p.path}>
                      {p.path} — {p.label}
                    </option>
                  ))}
                  <option value="__custom__">
                    {serialPorts.length === 0 ? "（没检测到串口，手动输入）" : "手动输入…"}
                  </option>
                </select>
              </label>
              <label className="modal-field">
                端口名（也可以直接手填）
                <input
                  value={serialDialog.draft.serial?.path ?? ""}
                  placeholder="COM5"
                  onChange={(e) => patchSerialDraft({}, { path: e.target.value })}
                />
              </label>
              <div className="modal-inline-action" style={{ paddingBottom: 8 }}>
                <button
                  type="button"
                  className="mini-btn"
                  disabled={serialLoading}
                  onClick={() => void refreshSerial()}
                >
                  {serialLoading ? "检测中…" : "重新检测串口"}
                </button>
                <span className="hint" style={{ marginLeft: 8 }}>
                  检测到 {serialPorts.length} 个口（含蓝牙/虚拟串口，按需选）
                </span>
              </div>

              <div className="modal-row">
                <label className="modal-field">
                  波特率
                  <select
                    value={
                      [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600].includes(
                        serialDialog.draft.serial?.baudRate ?? 115200,
                      )
                        ? String(serialDialog.draft.serial?.baudRate)
                        : "__custom__"
                    }
                    onChange={(e) => {
                      if (e.target.value !== "__custom__") {
                        patchSerialDraft({}, { baudRate: Number(e.target.value) });
                      }
                    }}
                  >
                    {[9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600].map((b) => (
                      <option key={b} value={b}>
                        {b}
                      </option>
                    ))}
                    <option value="__custom__">自定义…</option>
                  </select>
                </label>
                <label className="modal-field">
                  自定义波特率
                  <input
                    value={serialDialog.draft.serial?.baudRate ?? 115200}
                    onChange={(e) =>
                      patchSerialDraft({}, { baudRate: Number(e.target.value) || 115200 })
                    }
                  />
                </label>
              </div>

              <div className="modal-row">
                <label className="modal-field">
                  数据位
                  <select
                    value={serialDialog.draft.serial?.dataBits ?? 8}
                    onChange={(e) => patchSerialDraft({}, { dataBits: Number(e.target.value) })}
                  >
                    {[5, 6, 7, 8].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="modal-field">
                  停止位
                  <select
                    value={serialDialog.draft.serial?.stopBits ?? 1}
                    onChange={(e) => patchSerialDraft({}, { stopBits: Number(e.target.value) })}
                  >
                    <option value={1}>1</option>
                    <option value={2}>2</option>
                  </select>
                </label>
              </div>

              <div className="modal-row">
                <label className="modal-field">
                  校验位
                  <select
                    value={serialDialog.draft.serial?.parity ?? "none"}
                    onChange={(e) =>
                      patchSerialDraft({}, {
                        parity: e.target.value as SerialConfig["parity"],
                      })
                    }
                  >
                    <option value="none">无 (None)</option>
                    <option value="odd">奇校验 (Odd)</option>
                    <option value="even">偶校验 (Even)</option>
                  </select>
                </label>
                <label className="modal-field">
                  流控
                  <select
                    value={serialDialog.draft.serial?.flowControl ?? "none"}
                    onChange={(e) =>
                      patchSerialDraft({}, {
                        flowControl: e.target.value as SerialConfig["flowControl"],
                      })
                    }
                  >
                    <option value="none">无</option>
                    <option value="software">软件 (XON/XOFF)</option>
                    <option value="hardware">硬件 (RTS/CTS)</option>
                  </select>
                </label>
              </div>

              <div className="hint" style={{ padding: "0 14px" }}>
                这些参数只影响这条连接
              </div>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setSerialDialog(null)}>
                取消
              </button>
              <button type="button" className="btn" onClick={() => void saveSerialDialog(false)}>
                仅保存
              </button>
              <button
                type="button"
                className="btn primary"
                onClick={() => void saveSerialDialog(true)}
              >
                保存并打开
              </button>
            </div>
          </div>
        </div>
      )}

      {tabMenu && (
        <div
          className="ctx-backdrop"
          onClick={() => setTabMenu(null)}
          onContextMenu={(e) => {
            e.preventDefault();
            setTabMenu(null);
          }}
        >
          <div
            className="ctx-menu"
            style={{
              left: Math.min(Math.max(0, tabMenu.x), Math.max(0, window.innerWidth - 210)),
              top: Math.min(Math.max(0, tabMenu.y), Math.max(0, window.innerHeight - 170)),
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                const m = tabMenu;
                const s = sessions.find((x) => x.id === m.id);
                setTabMenu(null);
                setSessionRename({ id: m.id, value: s?.title ?? "" });
              }}
            >
              重命名会话…
            </button>
            {(() => {
              const s = sessions.find((x) => x.id === tabMenu.id);
              if (!s?.profileId) return null;
              return (
                <button
                  type="button"
                  className="menu-item"
                  onClick={() => {
                    setTabMenu(null);
                    if (s) void reconnectSession(s);
                  }}
                >
                  重新连接
                </button>
              );
            })()}
            {(() => {
              const s = sessions.find((x) => x.id === tabMenu.id);
              if (!s) return null;
              return s.logPath ? (
                <>
                  <button
                    type="button"
                    className="menu-item"
                    onClick={() => {
                      setTabMenu(null);
                      void stopSessionLog(s);
                    }}
                  >
                    停止记录终端日志
                  </button>
                  <button
                    type="button"
                    className="menu-item"
                    onClick={() => {
                      setTabMenu(null);
                      void openSessionLog(s);
                    }}
                  >
                    打开日志文件
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="menu-item"
                  onClick={() => {
                    setTabMenu(null);
                    void startSessionLog(s);
                  }}
                >
                  开始记录终端日志
                </button>
              );
            })()}
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                setTabMenu(null);
                void (async () => {
                  try {
                    await openInExplorer(await sessionLogDir());
                  } catch (e) {
                    notify("打开日志目录失败：" + String(e));
                  }
                })();
              }}
            >
              打开日志目录
            </button>
            <div className="menu-sep" />
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                const m = tabMenu;
                setTabMenu(null);
                void closeSession(m.id);
              }}
            >
              关闭会话
            </button>
          </div>
        </div>
      )}

      {sessionRename && (() => {
        // 点弹窗**外面**：什么都不做 —— 用户明确要求"弹窗不手动叉掉就不要关闭"。
        // 弹窗留着、输入留着（既不保存也不丢弃）；只有三个出口能动它：
        // ✕/「取消」= 关掉不保存、Enter/「保存」= 保存、Esc = 取消。
        return (
        <div className="modal-backdrop">
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">重命名会话</div>
            <div className="modal-body">
              <label className="modal-field">
                显示名字
                <input
                  autoFocus
                  value={sessionRename.value}
                  placeholder="比如：后端调试 / AI 写文档"
                  onChange={(e) =>
                    setSessionRename({ ...sessionRename, value: e.target.value })
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void renameSession(sessionRename.id, sessionRename.value);
                    // Esc = 取消（保留原名）：这是"我改主意了"的正规出口
                    if (e.key === "Escape") setSessionRename(null);
                  }}
                />
              </label>
              <div className="hint" style={{ padding: "0 14px" }}>
                改完会同时记进「会话历史」（「保存」或 Enter 生效；Esc /「取消」放弃）。
              </div>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setSessionRename(null)}>
                取消
              </button>
              <button
                type="button"
                className="btn primary"
                onClick={() => void renameSession(sessionRename.id, sessionRename.value)}
              >
                保存
              </button>
            </div>
          </div>
        </div>
        );
      })()}

      {fsMenu && (
        <div
          className="ctx-backdrop"
          onClick={() => setFsMenu(null)}
          onContextMenu={(e) => {
            e.preventDefault();
            setFsMenu(null);
          }}
        >
          <div
            className="ctx-menu"
            style={{
              left: Math.min(Math.max(0, fsMenu.x), Math.max(0, window.innerWidth - 210)),
              top: Math.min(Math.max(0, fsMenu.y), Math.max(0, window.innerHeight - 190)),
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="menu-head ellipsis" title={fsMenu.name}>
              {fsMenu.name}
            </div>
            {!fsMenu.isDir && (
              <button
                type="button"
                className="menu-item"
                onClick={() => {
                  const m = fsMenu;
                  setFsMenu(null);
                  void openRemoteFile(m.profileId, m.name);
                }}
              >
                打开预览
              </button>
            )}
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                const m = fsMenu;
                setFsMenu(null);
                void downloadFromRemote(m.profileId, m.name);
              }}
            >
              下载到本机…
            </button>
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                const m = fsMenu;
                setFsMenu(null);
                setNameDialog({
                  mode: "rename",
                  profileId: m.profileId,
                  dir: fsPath,
                  from: m.name,
                  value: m.name,
                });
              }}
            >
              重命名…
            </button>
            <div className="menu-sep" />
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                const m = fsMenu;
                setFsMenu(null);
                setConfirmDialog({
                  title: m.isDir ? "删除目录" : "删除文件",
                  message:
                    `确定要删除服务器上的 ${joinPath(fsPath, m.name)} 吗？` +
                    (m.isDir ? "目录会被递归删除。" : "") +
                    "此操作不可撤销。",
                  onOk: () => void doRemoveRemote(m.profileId, m.name),
                });
              }}
            >
              删除（不可撤销）
            </button>
          </div>
        </div>
      )}

      {nameDialog && (
        <div className="modal-backdrop" onClick={() => setNameDialog(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              {nameDialog.mode === "mkdir" ? "新建文件夹" : "重命名"}
            </div>
            <div className="modal-body">
              <label className="modal-field">
                {nameDialog.mode === "mkdir" ? "文件夹名" : "新名字"}
                <input
                  autoFocus
                  value={nameDialog.value}
                  onChange={(e) => setNameDialog({ ...nameDialog, value: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void confirmNameDialog();
                    if (e.key === "Escape") setNameDialog(null);
                  }}
                />
              </label>
              <div className="hint" style={{ padding: "0 14px" }}>
                位置：{nameDialog.dir || "/"}
              </div>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setNameDialog(null)}>
                取消
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={fsBusy}
                onClick={() => void confirmNameDialog()}
              >
                确定
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmDialog && (
        <div className="modal-backdrop" onClick={() => setConfirmDialog(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">{confirmDialog.title}</div>
            <div className="modal-body">
              <div className="hint" style={{ padding: "0 14px" }}>
                {confirmDialog.message}
              </div>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setConfirmDialog(null)}>
                取消
              </button>
              <button
                type="button"
                className="btn primary"
                onClick={() => {
                  const fn = confirmDialog.onOk;
                  setConfirmDialog(null);
                  fn();
                }}
              >
                {confirmDialog.okLabel ?? "确定"}
              </button>
            </div>
          </div>
        </div>
      )}

      {ctxMenu && (
        <div
          className="ctx-backdrop"
          onClick={() => setCtxMenu(null)}
          onContextMenu={(e) => {
            e.preventDefault();
            setCtxMenu(null);
          }}
        >
          <div
            className="ctx-menu"
            style={{
              left: Math.min(ctxMenu.x, Math.max(0, window.innerWidth - 230)),
              top: Math.min(ctxMenu.y, Math.max(0, window.innerHeight - 220)),
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* 对着**一条 herdr 会话**右键时，菜单是"这一条"的：herdr 的窗格会在服务器上攒着，
                用户需要能就在这一行上决定"留着 / 回收"（菜单里不弹窗，第二次点才是确认）。 */}
            {ctxMenu.herdrRow ? (
              <>
                <div className="menu-title">{ctxMenu.herdrRow.herdrPane}</div>
                <button
                  type="button"
                  className="menu-item"
                  onClick={() => {
                    const h = ctxMenu.herdrRow!;
                    setCtxMenu(null);
                    void connectFromHistory(h);
                  }}
                >
                  打开这个会话
                </button>
                <button
                  type="button"
                  className="menu-item"
                  onClick={() => {
                    const h = ctxMenu.herdrRow!;
                    setCtxMenu(null);
                    void removeHistoryEntry(h.id);
                  }}
                >
                  只从列表移除（服务器上留着）
                </button>
                <div className="menu-sep" />
                {herdrRowArmed === ctxMenu.herdrRow.herdrPane ? (
                  <>
                    <button
                      type="button"
                      className="menu-item danger"
                      onClick={() => {
                        const h = ctxMenu.herdrRow!;
                        setCtxMenu(null);
                        setHerdrRowArmed(null);
                        void closeHerdrWorkspace(
                          ctxMenu.profile,
                          paneWorkspace(h.herdrPane),
                        );
                      }}
                    >
                      确认在服务器上关掉 {paneWorkspace(ctxMenu.herdrRow.herdrPane)}
                    </button>
                    <button
                      type="button"
                      className="menu-item"
                      onClick={() => {
                        setHerdrRowArmed(null);
                        setCtxMenu(null);
                      }}
                    >
                      取消
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="menu-item"
                    onClick={() => setHerdrRowArmed(ctxMenu.herdrRow!.herdrPane ?? null)}
                  >
                    在服务器上关掉这个工作区…
                  </button>
                )}
              </>
            ) : (
              <>
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                const p = ctxMenu.profile;
                setCtxMenu(null);
                openNewSessionDialog(p);
              }}
            >
              新建会话
            </button>
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                const p = ctxMenu.profile;
                setCtxMenu(null);
                openEditDialog(p);
              }}
            >
              编辑服务器…
            </button>
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                const p = ctxMenu.profile;
                setCtxMenu(null);
                void duplicateProfile(p);
              }}
            >
              复制服务器
            </button>
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                const p = ctxMenu.profile;
                setCtxMenu(null);
                setTmuxTarget(p);
                void refreshTmux(p);
              }}
            >
              管理 tmux 会话
            </button>
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                const p = ctxMenu.profile;
                setCtxMenu(null);
                setHerdrTarget(p);
                setHerdrMgrArmed(null);
                void refreshHerdrMgr(p);
              }}
            >
              管理 herdr 工作区
            </button>
            <div className="menu-sep" />
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                const p = ctxMenu.profile;
                setCtxMenu(null);
                void removeProfile(p);
              }}
            >
              删除服务器
            </button>
              </>
            )}
          </div>
        </div>
      )}

      {showServers && (
        <div className="modal-backdrop" onClick={() => setShowServers(false)}>
          <div className="modal wide" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">服务器管理</div>
            <div className="modal-body">
              <div className="srv-toolbar">
                <button type="button" className="btn primary" onClick={() => openEditDialog()}>
                  ＋ 新建服务器
                </button>
                <span className="hint">共 {sshProfiles.length} 台</span>
              </div>
              {sshProfiles.length === 0 && (
                <div className="hint" style={{ padding: "0 14px" }}>
                  还没有服务器，点「＋ 新建服务器」添加第一台。
                </div>
              )}
              {sshProfiles.map((p) => (
                <div className="srv-row" key={p.id}>
                  <span
                    className="color-dot"
                    style={{ background: p.color ?? "#4f8cff" }}
                  />
                  <div className="srv-main">
                    <div className="srv-name">
                      <span className="ellipsis">{p.name}</span>
                      {p.ssh?.tmuxEnabled && <span className="tag">tmux</span>}
                    </div>
                    <div className="srv-meta">
                      {p.ssh
                        ? sshTargetLabel(p.ssh)
                        : p.type.toUpperCase()}
                      {p.group ? ` · ${p.group}` : ""}
                      {p.ssh
                        ? p.ssh.allowPassword
                          ? " · 允许输入密码"
                          : " · 只用密钥/agent"
                        : ""}
                    </div>
                  </div>
                  <div className="srv-actions">
                    <button
                      type="button"
                      className="mini-btn"
                      title="用这台服务器开一个新会话"
                      onClick={() => {
                        setShowServers(false);
                        openNewSessionDialog(p);
                      }}
                    >
                      新建会话
                    </button>
                    <button
                      type="button"
                      className="mini-btn"
                      title="编辑名称 / 主机 / 用户 / 密钥 / tmux"
                      onClick={() => openEditDialog(p)}
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      className="mini-btn"
                      onClick={() => void duplicateProfile(p)}
                    >
                      复制
                    </button>
                    {confirmDel === p.id ? (
                      <>
                        <button
                          type="button"
                          className="mini-btn danger"
                          onClick={() => {
                            setConfirmDel(null);
                            void removeProfile(p);
                          }}
                        >
                          确认删除
                        </button>
                        <button
                          type="button"
                          className="mini-btn"
                          onClick={() => setConfirmDel(null)}
                        >
                          取消
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="mini-btn"
                        onClick={() => setConfirmDel(p.id)}
                      >
                        删除
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setShowServers(false)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {editDialog && (
        <div className="modal-backdrop">
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              {editDialog.isNew ? "新建服务器" : "编辑服务器"}
              <button
                type="button"
                className="mini-x"
                style={{ float: "right", opacity: 1 }}
                title="关闭"
                onClick={() => setEditDialog(null)}
              >
                ✕
              </button>
            </div>
            <div className="modal-body">
              <label className="modal-field">
                名称
                <input
                  value={editDialog.draft.name}
                  placeholder="只是标签，不参与连接"
                  onChange={(e) => patchDraft({ name: e.target.value })}
                />
              </label>
              <label className="modal-field">
                分组（可留空；留空就归到「未分组」）
                <input
                  value={editDialog.draft.group}
                  placeholder="例如：生产环境 / 测试机"
                  onChange={(e) => patchDraft({ group: e.target.value })}
                />
              </label>
              {/* 外观：勾上=跟着"整体设置里那一类终端"走（全局一改它就跟着变）；
                  取消勾选=这台机器独立一套，以后全局怎么改都不动它 */}
              <label className="form-check">
                <input
                  type="checkbox"
                  checked={!editDialog.draft.termScheme && !editDialog.draft.highlightSetId}
                  onChange={(e) => {
                    if (e.target.checked) {
                      patchDraft({ termScheme: null, termSchemeCustom: null, highlightSetId: null });
                    } else {
                      // 独立：从"当前生效的那套"起步，方便微调
                      const kind = editDialog.draft.type === "serial" ? "serial" : "ssh";
                      const cur = termSchemeFor(settings, undefined, kind);
                      const curSet = settings.highlightSetByKind?.[kind] ?? "";
                      patchDraft({ termScheme: cur.key, highlightSetId: curSet || null });
                    }
                  }}
                />
                <span>
                  外观跟随全局设置（{editDialog.draft.type === "serial" ? "串口设备" : "远程 SSH"}那一档）；
                  取消勾选就是独立一套，以后改全局不会动它
                </span>
              </label>
              {(!editDialog.draft.termScheme && !editDialog.draft.highlightSetId) === false && (
                <div className="modal-inline-action" style={{ paddingBottom: 8 }}>
                  <select
                    value={editDialog.draft.termScheme ?? ""}
                    onChange={(e) => patchDraft({ termScheme: e.target.value || null })}
                    title="这台机器独立的配色方案"
                  >
                    <option value="">（跟随全局那档）</option>
                    {TERM_SCHEMES.map((s) => (
                      <option key={s.key} value={s.key}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                  <select
                    style={{ marginLeft: 6 }}
                    value={editDialog.draft.highlightSetId ?? ""}
                    onChange={(e) => patchDraft({ highlightSetId: e.target.value || null })}
                    title="这台机器独立的高亮规则集"
                  >
                    <option value="">（跟随全局那档）</option>
                    {settings.highlightRuleSets.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name || "(未命名)"}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <label className="modal-field">
                主机
                <input
                  value={editDialog.draft.ssh?.host ?? ""}
                  placeholder="IP 或 ~/.ssh/config 里的别名（填别名才能带上 config 里的密钥/端口/用户）"
                  onChange={(e) => patchDraft({}, { host: e.target.value })}
                />
              </label>
              <div className="modal-row">
                <label className="modal-field">
                  端口
                  <input
                    type="number"
                    min={0}
                    // 0 显示成空：0 是"没说"（后端不传 -p），不是"端口 0"
                    value={editDialog.draft.ssh?.port || ""}
                    placeholder="留空则用 ~/.ssh/config 里的值（默认 22）"
                    // 以前这里 `Number(...) || 22` 会把清空**打回 22** —— 用户想留空反而被填上，
                    // 于是 config 里的 Port 被 22 顶掉（"我明明配了别名"就是这么坏掉的）。
                    onChange={(e) => patchDraft({}, { port: portOrZero(e.target.value) })}
                  />
                </label>
                <label className="modal-field">
                  用户名
                  <input
                    value={editDialog.draft.ssh?.user ?? ""}
                    placeholder="留空则用 ~/.ssh/config 里的值（默认当前用户名）"
                    onChange={(e) => patchDraft({}, { user: e.target.value })}
                  />
                </label>
              </div>
              <label className="modal-field">
                私钥路径（可选，留空则用默认密钥 / ~/.ssh/config）
                <input
                  value={editDialog.draft.ssh?.keyPath ?? ""}
                  placeholder="C:\Users\me\.ssh\id_ed25519"
                  onChange={(e) => patchDraft({}, { keyPath: e.target.value })}
                />
              </label>
              <label className="modal-field">
                跳板机（可选，写法同 ssh -J：user@jump-host 或 user@jump-host:22）
                <input
                  value={editDialog.draft.ssh?.jump ?? ""}
                  placeholder="root@10.0.0.1 —— 留空就是直连"
                  onChange={(e) => patchDraft({}, { jump: e.target.value })}
                />
              </label>
              <label className="modal-field">
                tmux 会话名模板
                <input
                  value={editDialog.draft.ssh?.tmuxTemplate ?? "{host}-{user}"}
                  onChange={(e) => patchDraft({}, { tmuxTemplate: e.target.value })}
                />
              </label>
              <label className="form-check">
                <input
                  type="checkbox"
                  checked={editDialog.draft.ssh?.tmuxEnabled ?? true}
                  onChange={(e) => patchDraft({}, { tmuxEnabled: e.target.checked })}
                />
                <span>默认使用 tmux（新建会话时仍可临时改）</span>
              </label>
              {/* 这台服务器"默认用 herdr 打开"。
                  勾上之后新建会话里 herdr 那个勾会默认打上，不再每次问你。
                  没装 herdr 的机器上勾了也没关系：真去开会话时探测到没装会明确告诉你。 */}
              <label className="form-check">
                <input
                  type="checkbox"
                  checked={editDialog.draft.ssh?.herdrEnabled ?? false}
                  onChange={(e) => patchDraft({}, { herdrEnabled: e.target.checked })}
                />
                <span>默认用 herdr 打开（新建会话时仍可临时取消）</span>
              </label>
              <label className="form-check">
                <input
                  type="checkbox"
                  checked={editDialog.draft.ssh?.allowPassword ?? false}
                  onChange={(e) => patchDraft({}, { allowPassword: e.target.checked })}
                />
                <span>
                  允许在终端里输入密码（默认关闭：只用密钥/agent，连不上直接报错而不是卡住）
                </span>
              </label>
              {/* 密码存 Windows 凭据管理器：这样「只能用密码」的服务器也能读远程文件 / 列 tmux */}
              <label className="modal-field">
                密码（存在 Windows 凭据管理器，不会写进配置文件）
                <input
                  type="password"
                  value={editPassword}
                  placeholder={
                    editHasPassword
                      ? "已保存密码 · 输入新密码可覆盖"
                      : "留空则不用密码登录"
                  }
                  onChange={(e) => setEditPassword(e.target.value)}
                />
              </label>
              <div className="modal-inline-action" style={{ paddingBottom: 10 }}>
                <button
                  type="button"
                  className="mini-btn"
                  disabled={!editPassword || !editDialog.draft.id}
                  title={
                    editDialog.draft.id
                      ? "存进 Windows 凭据管理器（控制面板 → 凭据管理器里可以看到并删除）"
                      : "先保存这台服务器，再设置密码"
                  }
                  onClick={() => {
                    const id = editDialog.draft.id;
                    if (!id) {
                      notify("先保存这台服务器，再来设置密码");
                      return;
                    }
                    void (async () => {
                      try {
                        await secretSet(id, editPassword);
                        setEditHasPassword(true);
                        setEditPassword("");
                        notify("密码已存进 Windows 凭据管理器");
                      } catch (e) {
                        notify("保存密码失败：" + String(e));
                      }
                    })();
                  }}
                >
                  保存密码
                </button>
                <button
                  type="button"
                  className="mini-btn"
                  style={{ marginLeft: 6 }}
                  disabled={!editHasPassword || !editDialog.draft.id}
                  onClick={() => {
                    const id = editDialog.draft.id;
                    void (async () => {
                      try {
                        await secretDelete(id);
                        setEditHasPassword(false);
                        notify("已删除保存的密码");
                      } catch (e) {
                        notify("删除密码失败：" + String(e));
                      }
                    })();
                  }}
                >
                  清除密码
                </button>
                <span className="hint" style={{ marginLeft: 8 }}>
                  {editHasPassword ? "✓ 已保存密码" : "未保存密码"}
                </span>
              </div>
              <label className="modal-field">
                标签颜色（可选，显示在服务器名前）
                <input
                  type="color"
                  className="color-input"
                  value={editDialog.draft.color ?? "#4f8cff"}
                  onChange={(e) => patchDraft({ color: e.target.value })}
                />
              </label>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setEditDialog(null)}>
                取消
              </button>
              <button type="button" className="btn primary" onClick={() => void saveEditDialog()}>
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {showSettings && (
        <div className="modal-backdrop">
          {/* 点外面**不关**：设置要反复对照着改，误点一下全没了很难受；只认右上角 ✕ / 完成 */}
          <div className="modal wide" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              设置
              <button
                type="button"
                className="mini-x"
                style={{ float: "right", opacity: 1 }}
                title="关闭设置"
                onClick={() => setShowSettings(false)}
              >
                ✕
              </button>
            </div>
            <div className="settings-split">
              {/* 左边：分类。点一下右边就只显示这一类（像微信设置那样） */}
              <div className="settings-nav">
                {SETTINGS_TABS.map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    className={"settings-nav-item" + (settingsTab === t.key ? " active" : "")}
                    onClick={() => setSettingsTab(t.key)}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
              <div className="modal-body">
              {settingsTab === "look" && (
                <>
              <label className="modal-field">
                终端字体大小：{settings.fontSize}px（也可直接 Ctrl + 滚轮 或 Ctrl + ＋ / －）
                <input
                  type="range"
                  min={8}
                  max={26}
                  value={settings.fontSize}
                  onChange={(e) => applyFontSize(Number(e.target.value))}
                />
              </label>

              <label className="modal-field">
                终端回滚行数：{settings.scrollback.toLocaleString()} 行
                <input
                  type="range"
                  min={1000}
                  max={200000}
                  step={1000}
                  value={settings.scrollback}
                  onChange={(e) => void updateSettings({ scrollback: Number(e.target.value) })}
                />
              </label>
              <div className="modal-inline-action" style={{ paddingBottom: 10 }}>
                {[2000, 10000, 50000, 200000].map((n) => (
                  <button
                    key={n}
                    type="button"
                    className="mini-btn"
                    style={{ marginRight: 6 }}
                    onClick={() => void updateSettings({ scrollback: n })}
                  >
                    {n >= 1000 ? `${n / 1000}k` : n}
                  </button>
                ))}
                <span className="hint">
                  往上能翻多少行历史。超出后最老的行会被丢掉（不会崩，只是看不到更早的）；
                  要长期留存就开终端日志。
                </span>
              </div>
                </>
              )}

              {settingsTab === "log" && (
                <>
              <label className="form-check">
                <input
                  type="checkbox"
                  checked={settings.autoLog}
                  onChange={(e) => void updateSettings({ autoLog: e.target.checked })}
                />
                <span>
                  新建会话时自动记录终端日志（标签上会出现红点，右键标签可以停止或打开日志）
                </span>
              </label>

              <label className="modal-field">
                会话日志目录（留空 = 默认 %APPDATA%\ZeeAI-Terminal\logs\sessions）
                <input
                  value={settings.logDir}
                  placeholder="例如 D:\zeeai-logs"
                  onChange={(e) => void updateSettings({ logDir: e.target.value })}
                />
              </label>
              <div className="modal-inline-action">
                <button type="button" className="mini-btn" onClick={() => void pickLogDir()}>
                  选择目录…
                </button>
                <button type="button" className="mini-btn" onClick={() => void openLogDir()}>
                  打开目录
                </button>
                {settings.logDir.trim() !== "" && (
                  <button
                    type="button"
                    className="mini-btn"
                    onClick={() => {
                      void updateSettings({ logDir: "" });
                      notify("日志目录已恢复为默认位置");
                    }}
                  >
                    恢复默认
                  </button>
                )}
              </div>
                </>
              )}

              {settingsTab === "term" && (
                <>
              <label className="modal-field">
                默认终端
                <select
                  value={settings.defaultShell}
                  onChange={(e) =>
                    void updateSettings({
                      defaultShell: e.target.value as AppSettings["defaultShell"],
                    })
                  }
                >
                  <option value="powershell">PowerShell</option>
                  <option value="cmd">CMD</option>
                  <option value="wsl">WSL</option>
                </select>
              </label>

                </>
              )}

              {settingsTab === "look" && (
                <>
              <label className="modal-field">
                主题配色
                <select
                  value={settings.theme}
                  onChange={(e) => void updateSettings({ theme: e.target.value })}
                >
                  {THEMES.map((t) => (
                    <option key={t.key} value={t.key}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </label>

              <div className="modal-inline-action">
                <button type="button" className="btn" onClick={() => setShowTermTheme(true)}>
                  终端配色与关键字高亮…
                </button>
                <span className="hint" style={{ padding: "0 0 0 8px" }}>
                  当前配色：{currentTermSchemeName()}（可在里面按"终端类型"分别设置）
                </span>
              </div>
                </>
              )}

              {settingsTab === "app" && (
                <>
              <label className="form-check">
                <input
                  type="checkbox"
                  checked={settings.restoreWorkspace}
                  onChange={(e) => void updateSettings({ restoreWorkspace: e.target.checked })}
                />
                <span>启动时恢复上次的会话（SSH / 本地终端 / 串口；只记"怎么开回来"，不存文件内容）</span>
              </label>

              <label className="modal-field">
                关闭窗口时
                <select
                  value={settings.closeAction}
                  onChange={(e) =>
                    void updateSettings({
                      closeAction: e.target.value as AppSettings["closeAction"],
                    })
                  }
                >
                  <option value="exit">退出应用</option>
                  <option value="tray">收进系统托盘（后台继续运行）</option>
                </select>
              </label>

              <div className="hint" style={{ padding: "2px 14px 8px" }}>
                这两条是应用级行为，跟"终端怎么跑"无关。
              </div>
                </>
              )}

              {settingsTab === "notify" && (
                <>
              <div className="tree-group">什么时候提醒我</div>
              <div className="hint" style={{ padding: "0 14px 6px" }}>
                AI 跑的小任务很多，默认不为"跑完了"打扰你，只报下面这两类要你动手的事。
              </div>
              <label className="form-check">
                <input
                  type="checkbox"
                  checked={settings.aiNotifyDocs}
                  onChange={(e) => void updateSettings({ aiNotifyDocs: e.target.checked })}
                />
                <span>产出了文档（HTML / Markdown）就告诉我 —— 推荐</span>
              </label>
              <label className="form-check">
                <input
                  type="checkbox"
                  checked={settings.aiNotifyNeedsYou}
                  onChange={(e) => void updateSettings({ aiNotifyNeedsYou: e.target.checked })}
                />
                <span>AI 等我做选择题（要批准 / 等回话）就告诉我 —— 推荐</span>
              </label>
              <label className="form-check">
                <input
                  type="checkbox"
                  checked={settings.aiNotifyComplete}
                  onChange={(e) => void updateSettings({ aiNotifyComplete: e.target.checked })}
                />
                <span>每一轮跑完都告诉我（小任务多的话会很吵，默认关）</span>
              </label>
              <label className="form-check">
                <input
                  type="checkbox"
                  checked={settings.aiNotifyAllArtifacts}
                  onChange={(e) =>
                    void updateSettings({ aiNotifyAllArtifacts: e.target.checked })
                  }
                />
                <span>所有新文件都算"产物"（关 = 只算 HTML / Markdown，默认）</span>
              </label>
              <div className="tree-group" style={{ marginTop: 8 }}>
                用哪种方式提醒
              </div>
              <label className="form-check">
                <input
                  type="checkbox"
                  checked={settings.aiNotifyTaskbar}
                  onChange={(e) => void updateSettings({ aiNotifyTaskbar: e.target.checked })}
                />
                <span>
                  窗口不在前台时闪 Windows 任务栏
                </span>
              </label>
              {/* 红点只为两种情况亮（docs/design-ai-board-v2.md §10.6）。
                  以前这里是一条"跑完了就点红点"的总开关 —— 那样每次轮询都可能让它冒出来，
                  用户的原话是"红点别吵"，所以拆成下面两条独立规则。 */}
              <label className="form-check">
                <input
                  type="checkbox"
                  checked={settings.aiNotifyNeedsYouBadge}
                  onChange={(e) =>
                    void updateSettings({ aiNotifyNeedsYouBadge: e.target.checked })
                  }
                />
                <span>需要你处理时提醒（红点亮到你处理为止）</span>
              </label>
              <label className="form-check">
                <input
                  type="checkbox"
                  checked={settings.aiNotifyFinishedBadge}
                  onChange={(e) =>
                    void updateSettings({ aiNotifyFinishedBadge: e.target.checked })
                  }
                />
                <span>跑完一轮并停下时提醒（点开面板就消，当未读）</span>
              </label>
              <div className="hint" style={{ padding: "2px 14px 8px" }}>
                红点规则：<b>需要你 → 亮到你处理；跑完停下 → 点开就消</b>。
                <br />
                其它情况不提醒：运行中、空闲、超过 10 分钟没动静、只产出文件但还在跑、探测不到
                —— 一个都不点红点。
              </div>
              <div className="hint" style={{ padding: "2px 14px 8px" }}>
                提醒只进底部状态栏（不会在窗口中间弹浮层）；点状态栏那条可以直接切过去。
              </div>
                </>
              )}

              {settingsTab === "term" && (
                <>
              <label className="form-check">
                <input
                  type="checkbox"
                  checked={settings.tmuxDefault}
                  onChange={(e) => void updateSettings({ tmuxDefault: e.target.checked })}
                />
                <span>新建连接时默认启用 tmux</span>
              </label>

              <label className="form-check">
                <input
                  type="checkbox"
                  checked={settings.recordHistory}
                  onChange={(e) => void updateSettings({ recordHistory: e.target.checked })}
                />
                <span>记录会话历史</span>
              </label>

              <label className="form-check">
                <input
                  type="checkbox"
                  checked={settings.autoReconnect}
                  onChange={(e) => void updateSettings({ autoReconnect: e.target.checked })}
                />
                <span>SSH 断开后自动重连（会重新附加 tmux，最多重试 5 次）</span>
              </label>

              {/* ---------- 发给 AI：图片与文件 ----------
                  这 5 项是一件事的五个开关（落地目录 / 粘贴键 / 右键 / 复制 / 直粘走哪条路），
                  所以收在一个分组里；正文只回答"这条是干什么的"，"为什么这么设计"一律进 title。
                  提示一律纯文本 —— 这个界面不渲染 markdown，别写 ** 或反引号。 */}
              <div className="tree-group" style={{ marginTop: 4 }}>
                发给 AI（图片与文件）
              </div>

              <label
                className="modal-field"
                title="粘贴 / 拖进来的图片与文件会先传到服务器上，再把「远端路径」交给 AI —— CLI agent 只认路径，它自己会去读这个文件。"
              >
                图片 / 文件传到远端哪个目录
                <input
                  type="text"
                  value={settings.pasteDir}
                  placeholder="~/.zeeai/paste"
                  onChange={(e) => void updateSettings({ pasteDir: e.target.value })}
                />
                <span className="hint">默认 ~/.zeeai/paste；填 . = 跟随终端当前目录</span>
              </label>

              {/* 终端的三个"习惯项"：老终端用户各有各的肌肉记忆，做成可配比替他决定强 */}
              <label
                className="modal-field"
                title="没被选中的那个键会原样交给终端里的程序：Ctrl+V 变成 ^V（readline 的 quoted-insert、vim 的块选择），Shift+Insert 变成 Insert 键。选中的那个键走浏览器原生粘贴，图片也能直接粘。"
              >
                粘贴用哪个键
                <select
                  value={settings.pasteKey}
                  onChange={(e) => void updateSettings({ pasteKey: e.target.value })}
                >
                  <option value="both">Ctrl+V 和 Shift+Insert 都能粘（默认）</option>
                  <option value="ctrl-v">只用 Ctrl+V（Shift+Insert 送给远端）</option>
                  <option value="shift-insert">只用 Shift+Insert（Ctrl+V 送 ^V 给远端）</option>
                </select>
                <span className="hint">默认两个键都能粘；没被选中的那个原样送给远端</span>
              </label>

              <label
                className="modal-field"
                title="选「直接粘贴」时 Shift+右键仍然弹菜单（想用菜单时不用改设置）；万一系统拒绝读剪贴板，会自动退回菜单并给一句提示。图片请用 Ctrl+V / Shift+Insert。"
              >
                终端里点右键
                <select
                  value={settings.rightClick}
                  onChange={(e) => void updateSettings({ rightClick: e.target.value })}
                >
                  <option value="menu">弹菜单（默认）</option>
                  <option value="paste">直接粘贴剪贴板文本</option>
                </select>
                <span className="hint">默认弹菜单；Shift+右键始终弹菜单</span>
              </label>

              <label
                className="modal-field"
                title="三种口径下 Ctrl+Shift+C 都是复制。「选中即复制」跟 X11 一个脾气：鼠标一划就走剪贴板（选中就写，不用按键）。"
              >
                怎么复制
                <select
                  value={settings.copyKey}
                  onChange={(e) => void updateSettings({ copyKey: e.target.value })}
                >
                  <option value="ctrl-shift-c">Ctrl+Shift+C（默认；Ctrl+C 始终是中断）</option>
                  <option value="ctrl-c-smart">Ctrl+C：有选中就复制，没选中才是中断</option>
                  <option value="select">选中即复制（不用按键）</option>
                </select>
                <span className="hint">默认 Ctrl+Shift+C；选中即复制 = 划一下就走剪贴板</span>
              </label>

              <label
                className="form-check"
                title="不勾（默认）：图片先进输入窗，能确认粘对了没有、还能补一句话再发。勾上：快路径 —— 立刻把远端路径插进终端输入行，并弹几秒缩略图。纯文本粘贴两种情况下都按光标所在位置走。"
              >
                <input
                  type="checkbox"
                  checked={settings.pasteToast}
                  onChange={(e) => void updateSettings({ pasteToast: e.target.checked })}
                />
                <span>在终端里直接粘图片：放进输入窗（勾上 = 直接插路径）</span>
              </label>

                </>
              )}

              {settingsTab === "update" && (
                <>
                  {renderUpdateSection()}
                  <div className="hint">
                    设置立即生效，保存在 %APPDATA%\ZeeAI-Terminal\settings.json。
                  </div>
                </>
              )}
              </div>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn primary" onClick={() => setShowSettings(false)}>
                完成
              </button>
            </div>
          </div>
        </div>
      )}

      {paletteOpen && (
        <div className="modal-backdrop palette-backdrop" onClick={() => setPaletteOpen(false)}>
          <div className="palette" onClick={(e) => e.stopPropagation()}>
            <input
              autoFocus
              className="palette-input"
              placeholder="输入命令名，回车执行（Esc 关闭）"
              value={paletteQuery}
              onChange={(e) => setPaletteQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setPaletteOpen(false);
                if (e.key === "Enter") {
                  const first = paletteItems[0];
                  if (first) {
                    setPaletteOpen(false);
                    first.run();
                  }
                }
              }}
            />
            <div className="palette-list">
              {paletteItems.length === 0 && (
                <div className="hint" style={{ padding: "8px 12px" }}>
                  没有匹配的命令。
                </div>
              )}
              {paletteItems.slice(0, 40).map((c, i) => (
                <button
                  key={c.group + c.label}
                  type="button"
                  className={"palette-item" + (i === 0 ? " first" : "")}
                  onClick={() => {
                    setPaletteOpen(false);
                    c.run();
                  }}
                >
                  <span className="grow ellipsis">{c.label}</span>
                  <span className="dim">{c.group}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {showAbout && (
        <div className="modal-backdrop" onClick={() => setShowAbout(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">关于 ZeeAI Term</div>
            <div className="modal-body">
              <div className="about-row">
                <IconLogoRadio size={56} />
              </div>
              <div className="hint">
                <b>ZeeAI Term</b> {APP_VERSION}
                <br />
                Windows 多协议终端工作台：SSH（tmux 持久化）、远程文件与预览、本地终端。
                <br />
                <br />
                技术栈：Tauri 2 + Rust + React + xterm.js
              </div>
              <div className="about-sep" />
              {renderUpdateSection()}
            </div>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setShowAbout(false)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {showTermTheme && (
        <TermThemeDialog
          palette={lookScope === "global" ? termPalette : lookPalette}
          schemeKey={lookScheme.key}
          customJson={lookScheme.custom ?? ""}
          scopeOptions={lookScopes}
          scopeKey={lookScope}
          onScopeChange={setLookScope}
          setOptions={settings.highlightRuleSets.map((s) => ({ id: s.id, name: s.name || "(未命名)" }))}
          boundSetId={lookKind ? settings.highlightSetByKind[lookKind] ?? "" : ""}
          onBindSet={lookKind ? (id) => void setLookSet(id) : undefined}
          highlightEnabled={settings.highlightEnabled}
          onHighlightEnabled={(v) => void updateSettings({ highlightEnabled: v })}
          onOpenHighlightRules={() => setShowHighlight(true)}
          onPick={(key, custom) => void setLookScheme(key, custom)}
          followGlobal={
            lookKind
              ? {
                  active: kindFollowsGlobal,
                  name: globalSchemeName,
                  palette: resolveTermPalette(settings.termScheme, settings.termSchemeCustom),
                }
              : undefined
          }
          onFollowGlobal={lookKind ? () => void kindFollowGlobalNow() : undefined}
          onClose={() => setShowTermTheme(false)}
          onNotice={notify}
        />
      )}

      {showHighlight && (
        <HighlightDialog
          sets={
            settings.highlightRuleSets.length > 0
              ? settings.highlightRuleSets
              : [{ id: "default", name: "默认", rules: settings.highlightRules }]
          }
          enabled={settings.highlightEnabled}
          onEnabledChange={(v) => void updateSettings({ highlightEnabled: v })}
          onChange={(sets) =>
            void updateSettings({
              highlightRuleSets: sets,
              // 兼容：把「默认」那套的规则也写回旧字段，老逻辑/兜底都还能用
              highlightRules: sets.find((s) => s.id === "default")?.rules ?? settings.highlightRules,
            })
          }
          onClose={() => setShowHighlight(false)}
          onNotice={notify}
        />
      )}

      {newDialog && (
        <div className="modal-backdrop">
          {/* 输入型对话框：点外面不关（填了一半被手滑点掉很难受），只认右上角 ✕ / 取消 */}
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              新建会话
              <button
                type="button"
                className="mini-x"
                style={{ float: "right", opacity: 1 }}
                title="关闭"
                onClick={() => setNewDialog(null)}
              >
                ✕
              </button>
            </div>
            <div className="modal-body">
              <label className="modal-field">
                服务器
                <select
                  value={newDialog.profileId}
                  onChange={(e) => {
                    const picked = profiles.find((x) => x.id === e.target.value);
                    // 换服务器时，登录用户要跟着换成"这台服务器自己的用户"，
                    // 不能沿用上一台的值（否则 tmux 名也会拿旧用户去拼 —— 实测就是这样错的）
                    const nextUser = picked?.ssh?.user ?? "";
                    setNewDialog({
                      ...newDialog,
                      profileId: e.target.value,
                      user: nextUser,
                      tmuxName: picked ? defaultTmuxName(picked, nextUser) : "",
                      attachTarget: "",
                    });
                    if (newDialog.useTmux)
                      void loadDialogTmux(e.target.value, nextUser);
                  }}
                >
                  {sshProfiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}（{p.ssh?.user}@{p.ssh?.host}）
                    </option>
                  ))}
                </select>
              </label>
              <div className="modal-inline-action">
                <button
                  type="button"
                  className="mini-btn"
                  onClick={() => {
                    setNewDialog(null);
                    setReopenNewAfterSave(true);
                    openEditDialog();
                  }}
                >
                  ＋ 新建服务器
                </button>
                <button
                  type="button"
                  className="mini-btn"
                  style={{ marginLeft: 6 }}
                  onClick={() => {
                    const cur = profiles.find((p) => p.id === newDialog.profileId);
                    setNewDialog(null);
                    openEditDialog(cur);
                  }}
                >
                  编辑当前服务器
                </button>
                <button
                  type="button"
                  className="mini-btn"
                  style={{ marginLeft: 6 }}
                  onClick={() => {
                    setNewDialog(null);
                    setShowServers(true);
                  }}
                >
                  服务器管理
                </button>
              </div>

              <label className="modal-field">
                登录用户
                <input
                  value={newDialog.user}
                  placeholder="例如 root / ubuntu"
                  onChange={(e) => {
                    const nextUser = e.target.value;
                    const picked = profiles.find((x) => x.id === newDialog.profileId);
                    // tmux 名里带用户名（模板 {host}-{user}），所以改用户时跟着更新；
                    // 只有当它还是"自动生成的那个"或为空时才覆盖，尊重手动改过的名字
                    const auto = picked ? defaultTmuxName(picked, newDialog.user) : "";
                    const keepManual =
                      newDialog.tmuxName.trim() !== "" && newDialog.tmuxName !== auto;
                    setNewDialog({
                      ...newDialog,
                      user: nextUser,
                      tmuxName:
                        picked && !keepManual ? defaultTmuxName(picked, nextUser) : newDialog.tmuxName,
                    });
                  }}
                />
              </label>
              <div className="hint" style={{ padding: "0 0 8px 14px" }}>
                登录用户只对这次会话生效，不会改动服务器配置（要改配置请用「服务器管理」）
              </div>
              {/* 会话名字：留空 = 自动命名（普通 shell 会自动编号 1、2、3…），
                  这样同一台机器开多个普通会话，历史列表里也能一一对应、不会互相覆盖 */}
              <label className="modal-field">
                会话名字（可留空）
                <input
                  value={newDialog.title ?? ""}
                  placeholder="留空 = 自动命名（普通 shell 会自动编号，不会重名）"
                  onChange={(e) => setNewDialog({ ...newDialog, title: e.target.value })}
                />
              </label>

              {/* tmux 那条：勾了 herdr 就不再显示（两条是"用哪种方式开"，同时开没有意义） */}
              {!newDialog.useHerdr && (
                <label className="form-check">
                  <input
                    type="checkbox"
                    checked={newDialog.useTmux}
                    onChange={(e) => {
                      setNewDialog({ ...newDialog, useTmux: e.target.checked });
                      if (e.target.checked)
                        void loadDialogTmux(newDialog.profileId, newDialog.user);
                    }}
                  />
                  <span>使用 tmux（断网后可回到同一个会话）</span>
                </label>
              )}

              {/* 用 herdr 打开这次会话。
                  勾选默认值来自**这台服务器**的配置（「服务器管理」里那个"默认用 herdr 打开"），
                  勾过一次就不用每次再点 —— 用户原话："我勾了默认打开就别再让我勾"。
                  勾上就直接进她的环境（可读可写那条 control 流），不跑她自己的 TUI（会花屏）。 */}
              <label
                className="form-check"
                title={
                  newDialogCanHerdr
                    ? `${newDialogHerdr?.herdrPath || ""}\n协议 ${newDialogHerdr?.protocol} · schema v${newDialogHerdr?.schemaVersion}\n当前她在管 ${newDialogHerdr?.agents} 个 agent\n\n勾上 = 直接进她的环境（可读可写）；关掉标签时窗格留在服务器上，随时能回来`
                    : newDialogHerdr === undefined
                      ? probingHerdr[newDialog.profileId]
                        ? "正在探测这台机器有没有 herdr…"
                        : "还没探测这台机器。点一下这行即可探测。"
                      : "这台机器上没有 herdr。没有它也能正常用 tmux 或普通 shell，只是看板少一路更准的状态。"
                }
                onClick={() => {
                  if (newDialogHerdr === undefined) {
                    void probeHerdrFor(newDialog.profileId, newDialog.user);
                  }
                }}
              >
                <input
                  type="checkbox"
                  checked={newDialog.useHerdr}
                  // **只有"确实探到没装"才禁**（`!!newDialogHerdr` 就是这道闸）：
                  //   - undefined = 还没探 → 允许勾
                  //   - null      = 探测失败（可以重试）→ 允许勾
                  //   - {} 无版本 = 探到了、这台机器没装 → 才禁用
                  // 以前是"探测没返回就禁用"，用户想勾也点不动，点连接就悄悄开了个普通 shell
                  //（实测反馈"herdr 一直建不开"）。勾上之后点连接会强制再确认一次。
                  disabled={!!newDialogHerdr && !newDialogCanHerdr}
                  onChange={(e) => {
                    setNewDialog({ ...newDialog, useHerdr: e.target.checked });
                    // 只有"接管已有窗格"才需要列表；新建窗格不用拉
                    if (e.target.checked && newDialog.herdrKind === "attach") {
                      void loadDialogHerdr(newDialog.profileId, newDialog.user);
                    }
                  }}
                />
                <span>
                  用 herdr 打开
                  {newDialogCanHerdr
                    ? `（已装 ${newDialogHerdr?.herdrVersion} · 协议 ${newDialogHerdr?.protocol}）`
                    : newDialogHerdr === undefined
                      ? probingHerdr[newDialog.profileId]
                        ? "（正在探测…可以先勾上）"
                        : "（未探测 · 点这行探测）"
                      // 探到"没装"和"探测失败"要分开说：前者是结论，后者是可以重试的
                      : newDialogHerdr === null
                        ? "（探测失败，可以先勾上，连接时会重试）"
                      : "（这台机器没装）"}
                </span>
              </label>

              {/* 探测结果是"没有 herdr"时，顺手给一个一键安装入口。
                  安装过程由 Windows 侧下载 + 校验 sha256 后 scp 上去，不跑远端脚本、不要 root。 */}
              {/* 安装入口只在"**确认**这台机器没装 herdr"时出现；
                  探测失败（null）不给 —— 那多半是网络一时不通，装什么装。 */}
              {!!newDialogHerdr && !newDialogCanHerdr ? (
                <div className="modal-inline-action" style={{ paddingLeft: 14 }}>
                  {herdrInstalling[newDialog.profileId] ? (
                    <span className="hint">
                      正在装 herdr：{herdrInstalling[newDialog.profileId]}
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="mini-btn"
                      title="从 herdr.dev 拿官方版本号与 sha256，Windows 侧下载并校验后上传到 ~/.local/bin/herdr（不需要 root）"
                      onClick={() => void installHerdrFor(newDialog.profileId, newDialog.user)}
                    >
                      一键安装 herdr
                    </button>
                  )}
                </div>
              ) : null}

              {/* herdr 勾上之后：新开一个窗格，还是接管已有的（和 tmux 的"新建/附加"一个道理） */}
              {newDialog.useHerdr && newDialogCanHerdr && (
                <div className="tmux-choice">
                  <label className="form-check">
                    <input
                      type="radio"
                      checked={newDialog.herdrKind === "new"}
                      onChange={() => setNewDialog({ ...newDialog, herdrKind: "new" })}
                    />
                    <span>新建一个 herdr 窗格</span>
                  </label>
                  <label className="form-check">
                    <input
                      type="radio"
                      checked={newDialog.herdrKind === "attach"}
                      onChange={() => {
                        setNewDialog({ ...newDialog, herdrKind: "attach" });
                        void loadDialogHerdr(newDialog.profileId, newDialog.user);
                      }}
                    />
                    <span>接管已有窗格</span>
                  </label>
                  {newDialog.herdrKind === "attach" && (
                    <div className="attach-list">
                      {dialogBusy && <div className="hint">正在读取…</div>}
                      {!dialogBusy && dialogHerdr.length === 0 && (
                        <div className="hint">这台机器上 herdr 还没认出 agent。</div>
                      )}
                      {dialogHerdr.map((a) => (
                        <label
                          key={a.paneId}
                          className="form-check"
                          title={`${a.paneId}${a.cwd ? `　${a.cwd}` : ""}`}
                        >
                          <input
                            type="radio"
                            checked={newDialog.herdrTarget === a.paneId}
                            onChange={() =>
                              setNewDialog({ ...newDialog, herdrTarget: a.paneId })
                            }
                          />
                          <span>
                            {a.agent || "shell"} · {a.paneId} · {herdrStateLabel(a.status)}
                          </span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {!newDialog.useHerdr && newDialog.useTmux && (
                <div className="tmux-choice">
                  <label className="form-check">
                    <input
                      type="radio"
                      checked={newDialog.tmuxKind === "new"}
                      onChange={() => setNewDialog({ ...newDialog, tmuxKind: "new" })}
                    />
                    <span>新建 tmux 会话</span>
                  </label>
                  {newDialog.tmuxKind === "new" && (
                    <input
                      className="modal-input"
                      value={newDialog.tmuxName}
                      onChange={(e) =>
                        setNewDialog({ ...newDialog, tmuxName: e.target.value })
                      }
                      placeholder="会话名，例如 {host}-{user}"
                    />
                  )}

                  <label className="form-check">
                    <input
                      type="radio"
                      checked={newDialog.tmuxKind === "attach"}
                      onChange={() => {
                        setNewDialog({ ...newDialog, tmuxKind: "attach" });
                        void loadDialogTmux(newDialog.profileId, newDialog.user);
                      }}
                    />
                    <span>附加到已有 tmux 会话</span>
                  </label>
                  {newDialog.tmuxKind === "attach" && (
                    <div className="attach-list">
                      {dialogBusy && <div className="hint">正在读取…</div>}
                      {!dialogBusy && dialogTmux.length === 0 && (
                        <div className="hint">这台服务器上还没有 tmux 会话。</div>
                      )}
                      {dialogTmux.map((t) => (
                        <label
                          key={t.name}
                          className={
                            "attach-item" + (newDialog.attachTarget === t.name ? " active" : "")
                          }
                        >
                          <input
                            type="radio"
                            checked={newDialog.attachTarget === t.name}
                            onChange={() =>
                              setNewDialog({ ...newDialog, attachTarget: t.name })
                            }
                          />
                          <IconTerminal size={14} />
                          <span className="grow">{t.name}</span>
                          <span className="dim">{t.windows} 窗口</span>
                          {t.attached && <span className="tag">已连接</span>}
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setNewDialog(null)}>
                取消
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={dialogBusy}
                onClick={() => void confirmNewSession()}
              >
                连接
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function stateText(s: SessionState): string {
  switch (s) {
    case "connecting":
      return "连接中";
    case "connected":
      return "已连接";
    case "reconnecting":
      return "重连中";
    case "closed":
      return "已关闭";
    default:
      return "错误";
  }
}

/**
 * 本地终端模块（PowerShell / CMD / WSL）的侧栏。
 * 关键点：这里要**列出这个模块已经打开的会话**，点一下就切过去，
 * 不用去顶部标签栏一个个找。
 */
function LocalModule({
  label,
  sessions,
  activeId,
  onOpen,
  secondary,
  onActivate,
  onClose,
}: {
  label: string;
  sessions: OpenSession[];
  activeId: string | null;
  onOpen: () => void;
  /** 并排的第二个"新建"按钮（目前只有 PowerShell 7 用得上） */
  secondary?: { label: string; title?: string; onClick: () => void };
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
}) {
  return (
    <div className="local-module">
      {/* 有第二个按钮时改成竖排：两个按钮同宽同高、各占一行（并排会挤到折行，很难看） */}
      <div className={"side-actions" + (secondary ? " stack" : "")}>
        <button type="button" className="btn primary grow" onClick={onOpen}>
          <IconPlus size={14} /> 新建 {label}
        </button>
        {secondary && (
          <button
            type="button"
            className="btn"
            title={secondary.title}
            onClick={secondary.onClick}
          >
            <IconPlus size={14} /> 新建 {secondary.label}
          </button>
        )}
      </div>
      <div className="tree-group">已打开的 {label}（{sessions.length}）</div>
      {sessions.length === 0 && <div className="hint">还没有打开</div>}
      {sessions.map((s) => (
        <div
          key={s.id}
          className={"tree-item" + (s.id === activeId ? " current" : "")}
          onClick={() => onActivate(s.id)}
          title={`${s.title}　点击切换到该会话`}
        >
          <IconTerminal size={14} />
          <span className="grow ellipsis">{s.title}</span>
          <span className={"status-dot " + s.state} />
          <button
            type="button"
            className="mini-x"
            title="关闭这个会话"
            onClick={(e) => {
              e.stopPropagation();
              onClose(s.id);
            }}
          >
            <IconClose size={11} />
          </button>
        </div>
      ))}
      <div className="hint">本地终端可以开多个，各自是独立的工作区。</div>
    </div>
  );
}

const MD_STYLES: { key: MdStyle; label: string }[] = [
  { key: "github", label: "GitHub" },
  { key: "minimal", label: "简洁" },
  { key: "dark", label: "深色" },
  { key: "paper", label: "文档" },
];

function FileView({
  file,
  profileId,
  userOverride,
  onNotice,
}: {
  file: OpenFile;
  /** 这个文件在哪台服务器上（本地文件没有，就不显示下载按钮） */
  profileId?: string;
  userOverride?: string | null;
  onNotice?: (text: string) => void;
}) {
  const [preview, setPreview] = useState(true);
  const [mdStyle, setMdStyle] = useState<MdStyle>("github");
  const [saving, setSaving] = useState(false);

  /** 把远端文件下载到本机（选一个目录，文件名保持原样） */
  async function download() {
    if (!profileId) return;
    const dir = await openLocalDialog({ directory: true, multiple: false, title: "下载到哪个目录" });
    if (!dir || typeof dir !== "string") return;
    setSaving(true);
    try {
      const saved = await fsDownload(profileId, [file.path], dir, userOverride ?? null);
      onNotice?.(`已下载：${saved || file.name}`);
    } catch (e) {
      onNotice?.("下载失败：" + String(e));
    } finally {
      setSaving(false);
    }
  }

  const isMd = file.kind === "md";
  const isHtml = file.kind === "html";
  const isImg = file.kind === "img";
  const text = isImg ? "" : decodeB64Text(file.b64);

  const mdHtml = useMemo(
    () => (isMd ? DOMPurify.sanitize(md.render(text)) : ""),
    [isMd, text],
  );
  const htmlDoc = useMemo(() => {
    if (!isHtml) return "";
    const clean = DOMPurify.sanitize(text, { FORBID_TAGS: ["script"], FORBID_ATTR: ["srcdoc"] });
    return `<!doctype html><html><head><meta charset="utf-8"><style>
      body{margin:16px;font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif;color:#222;background:#fff;}
      pre{background:#f5f5f5;padding:10px;border-radius:6px;overflow:auto;}
      a{color:#0b6cff;} img{max-width:100%;}
    </style></head><body>${clean}</body></html>`;
  }, [isHtml, text]);

  return (
    <div className="file-view">
      <div className="file-toolbar">
        <span className="file-name" title={file.path}>
          {file.name}
        </span>
        <span className="grow" />
        {isMd && preview && (
          <span className="md-styles">
            {MD_STYLES.map((s) => (
              <button
                key={s.key}
                type="button"
                className={"md-style" + (mdStyle === s.key ? " active" : "")}
                onClick={() => setMdStyle(s.key)}
              >
                {s.label}
              </button>
            ))}
          </span>
        )}
        {(isMd || isHtml) && (
          <button
            type="button"
            className={"mini-btn" + (preview ? " active" : "")}
            onClick={() => setPreview((v) => !v)}
          >
            {preview ? "预览" : "源码"}
          </button>
        )}
        {/* 远端文件：直接在这里下载，不用去文件面板里找 */}
        {profileId && (
          <button
            type="button"
            className="mini-btn primary"
            style={{ marginLeft: 6 }}
            disabled={saving}
            title="把这个文件下载到本机（选目标目录，文件名不变）"
            onClick={() => void download()}
          >
            {saving ? "下载中…" : "⬇ 下载"}
          </button>
        )}
        <span className="file-kind">{kindLabel(file.kind)}</span>
      </div>

      <div className="file-body">
        {isImg && (
          <div className="img-preview">
            <img src={`data:${imgMime(file.name)};base64,${file.b64}`} alt={file.name} />
          </div>
        )}

        {isMd &&
          (preview ? (
            <div className={"md-preview md-" + mdStyle} dangerouslySetInnerHTML={{ __html: mdHtml }} />
          ) : (
            <pre className="src-view">{text}</pre>
          ))}

        {isHtml &&
          (preview ? (
            <iframe className="html-preview" sandbox="" srcDoc={htmlDoc} title={file.name} />
          ) : (
            <pre className="src-view">{text}</pre>
          ))}

        {(file.kind === "code" || file.kind === "text") && (
          <pre className="src-view">{text}</pre>
        )}
      </div>
    </div>
  );
}

function kindLabel(kind: FileKind): string {
  switch (kind) {
    case "md":
      return "Markdown";
    case "html":
      return "HTML";
    case "img":
      return "图片";
    case "code":
      return "代码";
    default:
      return "文本";
  }
}
