// AI 看板/面板上所有"枚举 → 中文"的映射，以及几个只会算字符串的小函数。
//
// 为什么抽出来：同一个状态词在卡片、时间线、徽标、通知四五处都要显示，
// 各写一遍就会各错一遍；放在一处，改口径只改一行。

import { activityEvidenceOf } from "../boardActivity";
import type { AiAgentKind, AiCarrier, AiInstance, AiState } from "../types";

export const AI_TOOL_LABEL: Record<string, string> = {
  codex: "OpenAI Codex CLI",
  claude: "Claude Code",
  aider: "Aider",
  gemini: "Gemini CLI",
};

export function aiToolLabel(name: string): string {
  return AI_TOOL_LABEL[name] ?? name;
}

/**
 * ⚠️ AI 助手面板总开关（2026-10-24 用户要求暂时停用）。
 *
 * 用户原话：「AI 助手面板太鸡肋，先关闭；点星号打开只显示个 AI 任务面板」，
 * 追问后明确：「整个面板都停用，只留灰色容器」。
 *
 * 现在保留的是：右侧面板容器、活动栏星号按钮的开合、面板宽度（268px）、
 * 看板数据采集 / 红点逻辑 / 卡片代码 —— 只是**一条内容都不渲染**，
 * 面板里只有一块灰色背景（`.ai-panel.off`，用主题变量）。
 *
 * 为什么用开关位而不是删代码：用户说后续重构还要用这些代码（看板 v2 的
 * 两区、折叠行、承载健康、时间线、通知都在下面原样留着）。
 *
 * 恢复方法：把 `AI_PANEL_DISABLED` 改成 `false` 即可 —— 不需要动任何 JSX /
 * 逻辑 / 样式；面板体量/开合行为都还是原来的。
 */
export const AI_PANEL_DISABLED = true;

/**
 * 仅供无头回归测试的"临时把内容渲出来"开关（正常构建 / 正常启动**不存在**）。
 *
 * 为什么留这个口子：面板里那套看板有 50+ 条无头断言，是这些代码唯一的回归网；
 * 如果一刀切成空面板，它们会全部变红、被删掉，等以后重构时就没有任何东西兜底了。
 * `scripts/fe-smoke.mjs` 会在页面启动前设 `window.__ZEEAI_TEST_AI_PANEL__ = true`，
 * 只在那轮测试里渲染；用户打开应用时这个全局永远是 undefined → 面板仍是灰容器。
 */
export const AI_PANEL_TEST_ONLY_SHOW =
  typeof window !== "undefined" &&
  (window as Window & { __ZEEAI_TEST_AI_PANEL__?: boolean }).__ZEEAI_TEST_AI_PANEL__ === true;
/** 实际生效的"要不要藏内容"：停用开关 + 测试豁免 */
export const AI_PANEL_HIDDEN = AI_PANEL_DISABLED && !AI_PANEL_TEST_ONLY_SHOW;

/** 环境徽标：本地 / 远端 / WSL */
export function aiEnvLabel(env: string): string {
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
export function isActiveInstance(i: AiInstance): boolean {
  return i.state === "needs-you" || i.state === "working";
}

/**
 * 卡片上那句状态词（§3.1 的五个词 + §10.4 对裸 SSH 的一句如实降级）。
 *
 * 裸 SSH 的 working 是**进程推断**出来的：只能看到"有这么个进程"，
 * 看不到它在等谁、也看不出它是不是卡住了 —— 所以那句要写全：
 * 「运行中（进程推断，可能已卡住）」。其它承载照旧只写状态词，推断与否交给来源徽标说。
 */
export function aiStateLabelOf(i: AiInstance): string {
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
export function aiStateLabel(s: AiState): string {
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
export function herdrStateLabel(status: string): string {
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
export function aiCarrierLabel(c: AiCarrier): string {
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
export function aiAgentLabel(a: AiAgentKind): string {
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
export function herdrAgentLabel(agent: string): string {
  const known = aiAgentLabel(agent as AiAgentKind);
  return known === "未知工具" && agent.trim() ? agent.trim() : known;
}

/**
 * 后端 `AiInstance.badge` 里已经带了"谁说的 / 多久前 / 能不能证明"，
 * 但没带"在哪儿" —— 悬停写"怎么得出的"时，第一句要能回答"这是哪台机器 / 哪个目录"。
 */
export function aiInstanceWhere(i: AiInstance): string {
  const parts = i.where.split(" · ");
  return parts.slice(0, 2).filter(Boolean).join(" · ");
}

/**
 * 卡片上那个来源徽标的悬停文案（§3.3 的要求：**谁说的 / 多久前 / 能证明什么**）。
 *
 * `badge()` 已经把后两件事写全了（含"只能说明它在跑"、"可能已卡住"这些如实降级），
 * 这里只补三样：这是哪里、这句话是谁说的（枚举名）、一共几条证据。
 */
export function aiBadgeTitle(i: AiInstance): string {
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
export function aiBadgeCoversSource(i: AiInstance): boolean {
  if (!i.badge) return false;
  return !/只能说明它在跑/.test(i.badge);
}

/** 证据来源的中文短语（和后端 `EvidenceSource::label()` 对齐；认不出就写"未知来源"） */
export function aiEvidenceSourceLabel(s: string): string {
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
export function aiSourceLabelOf(source: string): string {
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
export function aiDurationText(ms: number): string {
  if (!ms || ms < 0) return "—";
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs} 秒`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return secs % 60 ? `${mins} 分 ${secs % 60} 秒` : `${mins} 分`;
  return `${Math.floor(mins / 60)} 小时 ${mins % 60} 分`;
}

/** Unix 秒 → 本地时间 HH:MM:SS */
export function clockText(sec: number): string {
  const d = new Date(sec * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}



/** 一行短文本（通知里用）：压成一行并截断 */
export function aiShorten(s: string, max: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : one.slice(0, max) + "…";
}

/** token 数 → 以「兆（M）」为单位显示，例如 1_234_567 → "1.23M" */
export function tokenM(n: number): string {
  if (!n || n < 0) return "0M";
  const m = n / 1_000_000;
  if (m >= 100) return `${Math.round(m)}M`;
  if (m >= 1) return `${m.toFixed(2)}M`;
  if (m >= 0.01) return `${m.toFixed(3)}M`;
  return "0.01M 以下";
}

/** herdr 原始状态 → 统一状态词（和后端 `ai_instance::state_of_herdr` 对齐）。 */
export function herdrStateOf(status: string): AiState {
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




