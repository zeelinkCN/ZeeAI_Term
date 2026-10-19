/**
 * 看板卡片的「实时推断」——用**终端输出活动**回答"它现在是不是还在跑"。
 *
 * 为什么有这一层（用户 2026-10-20 的原话）：
 * 「点击刷新探测AI的执行状态不太好，根本不够实时」。
 * 结论不是把探测调快，而是用**本来就在收的终端输出流**：
 * `Terminal.tsx` 的 `onWriteParsed` 已经在往 `src/activity.ts` 记"最后一次输出时间"了。
 * 这里只做纯计算：**不起进程、不发 IPC、不读文件**，连时钟都不归它管
 * （1 秒的重算时钟在 App 里，且只在 AI 面板打开时走）。
 *
 * 三条纪律（都是从"推断绝不说成事实"这条口径来的）：
 * - **只升不降**：输出只能把卡片"补成运行中"，停了就什么都不做（回落由调用方保留的原状态决定）。
 *   绝不推断成"跑完 / 需要你"—— 那两件事只有日志 / herdr / 进程退出能说。
 * - **第一手优先**：带 `first-hand` 证据的卡（herdr）、以及被动事件刚写过的卡
 *   （徽标带「自动更新」，见 App.tsx `autoBadgeText`）一律不碰。它们本来就是实时的，
 *   推断不该去改一个由对面自己报出来的状态。
 * - **不瞎猜**：一张卡对应哪条终端会话，只认三种**确定性**证据（显式 sessionId / herdr 窗格 /
 *   `where` 里的 cwd），而且候选必须**唯一**；对不上或对上多个就不要推断。
 */

import { getLastOutput } from "./activity";
import type { AiCarrier, AiEvidence, AiInstance } from "./types";

/**
 * "多久之内有输出"算还在跑（毫秒）。
 *
 * 5 秒是保守值：AI TUI 在思考时通常至少几秒会刷一次界面（转圈/计时/流式输出），
 * 而一次 `ls` 之类的瞬时输出也只影响 5 秒 —— 宁可少报"运行中"，也不要把已经停下的
 * 任务一直装作在跑。这个值只影响**这一层推断**，不改任何第一手状态。
 */
export const OUTPUT_ACTIVE_MS = 5000;

/** 推断证据的 source（不是后端枚举里的东西：它只存在于前端这一层） */
const ACTIVITY_SOURCE = "terminal-activity" as const;

/** 这条推断在 `evidence` 里的那一条（`undefined` = 这张卡不是推断出来的运行中） */
export function activityEvidenceOf(i: AiInstance): AiEvidence | undefined {
  return i.evidence.find((e) => e.source === ACTIVITY_SOURCE);
}

/**
 * 推断需要的会话信息（`App.tsx` 的 `OpenSession` 结构上就满足它）。
 *
 * 故意只收这几个字段：匹配逻辑要用的就这些；收窄之后这段逻辑也能被单独读/测，
 * 不会悄悄依赖会话上的别的东西。
 */
export interface ActivitySessionLike {
  id: string;
  /** remote / powershell / cmd / wsl / …（`OpenSession.kind`） */
  kind: string;
  profileId?: string;
  /** 终端上报的当前目录（OSC 7 / tmux）；没上报就是空 */
  cwd?: string;
  /** herdr 观察窗/接管窗看的是哪个窗格（形如 w1:p1） */
  herdrPane?: string;
}

export interface OutputActivityOptions {
  sessions: readonly ActivitySessionLike[];
  /** profileId → 服务器显示名（必须和 `AiInstance.where` 第一段同一个口径） */
  profileName: (profileId: string | undefined) => string | undefined;
  /** 这一帧的时间（来自 App 的 1 秒 UI 时钟；不是另起一个计时器） */
  nowMs: number;
  /** 测试/回放时可注入；默认就是 `activity.ts` 那份内存 Map */
  lastOutputOf?: (sessionId: string) => number | undefined;
}

/** `where` 的形状是 `环境 · 目录 · 锚`（和后端 `AiInstance::where_` 一致） */
function whereParts(where: string): string[] {
  return (where || "").split(" · ");
}

/**
 * 会话属于哪个"环境"。
 *
 * 为什么不能直接用 `boardEnvOf` 的 server 名：本地会话的 server 是「本机 PowerShell」，
 * 而 `AiInstance.where` 第一段是「本机」（后端 `Observation::local_proc` 写死的）——
 * 拿 server 名去比会永远对不上，于是本地卡片永远推断不出东西。
 */
function sessionEnv(s: ActivitySessionLike, profileName: OutputActivityOptions["profileName"]): string {
  if (s.kind === "remote") return (s.profileId && profileName(s.profileId)) || "";
  if (s.kind === "wsl") return "WSL";
  // pwsh 也归在 powershell 这个 kind 下（见 App.tsx openLocalSession 的说明）
  if (s.kind === "powershell" || s.kind === "cmd") return "本机";
  return "";
}

/**
 * 每种承载只允许匹配**同类**的终端会话。
 *
 * 为什么：同一台服务器上可能同时开着远程终端和本地 PowerShell，cwd 恰好都叫 `C:/work`
 * （或都叫 `/home/x`）的情况并不罕见。跨类型匹配是"看着像就认"，也就是瞎猜。
 */
const SESSION_KINDS_OF: Record<AiCarrier, readonly string[]> = {
  "local-powershell": ["powershell", "cmd"],
  "local-cmd": ["cmd"],
  wsl: ["wsl"],
  "ssh-bare": ["remote"],
  tmux: ["remote"],
  herdr: ["remote"],
};

/**
 * 路径归一化。
 *
 * 本地要折大小写（Windows 路径 `C:\Work` 和 `c:/work` 是同一个目录）；
 * 远端 / WSL 保持大小写敏感 —— Linux 上 `/Home/x` 和 `/home/x` 是两个目录，
 * 折了反而会把两条不同的会话合成"唯一候选"，那是错的。
 */
function normalizePath(p: string, foldCase: boolean): string {
  const s = p.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return foldCase ? s.toLowerCase() : s;
}

/**
 * 这张卡对应哪个终端会话（找不到 / 不唯一都返回 `undefined`，表示"不推断"）。
 *
 * 认的顺序就是"可信度从高到低"：
 * 1. 卡片自己带的 `sessionId`（后端/事件明确指的，最可信）；
 * 2. herdr：`where` 第三段是 `herdr:<窗格>`，按窗格 + 服务器名找；
 * 3. 其它承载：`where` 第二段是进程 cwd，按"同类型会话 + 同环境 + 归一化后的 cwd 相等"找。
 *
 * 第 2、3 步都要求**候选唯一**。两条会话同 cwd（例如同一目录开了两个 PowerShell）时
 * 分不清输出是谁的，那就不推断 —— 少一个「运行中」，比给错卡片贴标签好。
 */
export function resolveInstanceSessionId(
  inst: Pick<AiInstance, "carrier" | "where" | "sessionId">,
  opts: OutputActivityOptions,
): string | undefined {
  const { sessions } = opts;
  // ① 显式 sessionId：只要那条会话还开着就直接用（后端比前端更知道它指的是哪条 PTY）
  if (inst.sessionId) {
    const hit = sessions.find((s) => s.id === inst.sessionId);
    if (hit) return hit.id;
  }
  const parts = whereParts(inst.where);
  const env = parts[0] ?? "";
  const wantKinds = SESSION_KINDS_OF[inst.carrier] ?? [];
  // ② herdr：窗格号是它自己的锚，比 cwd 稳（同一目录下可以有好几个窗格）
  if (inst.carrier === "herdr") {
    const anchor = parts[2] ?? "";
    const pane = anchor.startsWith("herdr:") ? anchor.slice("herdr:".length) : "";
    if (!pane) return undefined;
    const hits = sessions.filter(
      (s) =>
        s.kind === "remote" &&
        s.herdrPane === pane &&
        (!env || sessionEnv(s, opts.profileName) === env),
    );
    return hits.length === 1 ? hits[0].id : undefined;
  }
  // ③ 其它承载：只按 cwd 认，且要求"同类型 + 同环境 + 唯一"
  const cwd = parts[1] ?? "";
  if (!cwd) return undefined;
  const foldCase = inst.carrier === "local-powershell" || inst.carrier === "local-cmd";
  const want = normalizePath(cwd, foldCase);
  const hits = sessions.filter(
    (s) =>
      wantKinds.includes(s.kind) &&
      (!env || sessionEnv(s, opts.profileName) === env) &&
      !!s.cwd &&
      normalizePath(s.cwd, foldCase) === want,
  );
  return hits.length === 1 ? hits[0].id : undefined;
}

/** 对面自己报的 / 被动事件刚写的状态：这两种是"实时源"，推断必须让路 */
function hasNonInferredState(i: AiInstance): boolean {
  if (i.evidence.some((e) => e.confidence === "first-hand")) return true;
  // 被动事件（日志 / herdr 快照）更新过的卡，徽标末尾带「自动更新」——
  // 这是 App.tsx 里 `autoBadgeText` 的约定，也是"事件到了就覆盖推断值"的落点。
  return i.badge.includes("自动更新");
}

/**
 * 给卡片补上"输出活动 → 运行中"的推断（纯函数，返回新数组，不改入参）。
 *
 * 只会做一件事：**把新鲜输出对应的卡片的 state 改成 working，并追加一条推断证据**。
 * 输出停了、找不到会话、第一手状态已存在 —— 都原样返回，回落完全交给调用方
 * 手里那份 `boardInstances`（刷新 / 日志 / herdr 给的状态），所以不会出现
 * "输出一停就变成跑完/需要你"。
 */
export function withOutputActivity(
  instances: readonly AiInstance[],
  opts: OutputActivityOptions,
): AiInstance[] {
  const lastOutputOf = opts.lastOutputOf ?? getLastOutput;
  return instances.map((i) => {
    // 需要你 / 第一手 / 事件刚写过：一个都不碰（推断绝不说成事实）
    if (i.state === "needs-you") return i;
    if (hasNonInferredState(i)) return i;
    const sessionId = resolveInstanceSessionId(i, opts);
    if (!sessionId) return i;
    const last = lastOutputOf(sessionId);
    if (typeof last !== "number") return i;
    // 时钟可能比 markOutput 的那一刻旧（本帧先渲染、下一次 tick 才把 now 推上来），
    // 所以只挡"太旧"，负的差值是正常的，不能当成过期。
    if (opts.nowMs - last > OUTPUT_ACTIVE_MS) return i;
    // 防御：同一份推导被跑了两次时别把证据追加两遍（真实的证据列表只会有一条）
    if (i.evidence.some((e) => e.source === ACTIVITY_SOURCE)) return i;
    return {
      ...i,
      state: "working",
      evidence: [
        ...i.evidence,
        // 和别的推断证据同一个形状；`confidence: "inferred"` 就是"这不是对面说的"
        { source: ACTIVITY_SOURCE, atMs: last, confidence: "inferred" as const },
      ],
    };
  });
}
