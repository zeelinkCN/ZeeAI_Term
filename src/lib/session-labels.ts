// 会话的外观口径：承载方式徽标（T/H/S）、shell 名字、配色/高亮规则的解析。
//
// 为什么抽出来：侧栏会话树、标签栏、状态栏都要算同一个"这个会话挂在什么上面"，
// 算错一处就会出现"侧栏写 tmux、标签栏写 SSH"这种自相矛盾。

import { resolveTermPalette } from "../termThemes";
import type { OpenSession } from "./ui-model";
import type { TermPalette } from "../termThemes";
import type { AppSettings, ConnectionProfile, HighlightRule, SessionState } from "../types";

export function shellLabelOf(kind: string): string {
  if (kind === "wsl") return "WSL";
  if (kind === "cmd") return "本机 CMD（仅状态）";
  return "本机 PowerShell";
}

/** 会话的承载方式：T = tmux、H = herdr、S = 纯 SSH（本地终端没有徽标） */
export type CarrierKey = "tmux" | "herdr" | "ssh";

export const CARRIER_LETTER: Record<CarrierKey, string> = {
  tmux: "T",
  herdr: "H",
  ssh: "S",
};

/** 悬停文案：必须把 tmux / herdr / SSH 三个词写清楚（用户要求） */
export const CARRIER_TITLE: Record<CarrierKey, string> = {
  tmux: "tmux —— 这个会话跑在 tmux 里（断线重连能回到同一个会话）",
  herdr: "herdr —— 这个会话是 herdr 里的窗格（观察 / 接管都算）",
  ssh: "SSH —— 纯 SSH 会话（没有 tmux / herdr）",
};

/**
 * 判定一个会话的承载方式 —— 只看会话对象里**已有的**承载字段，不靠标题猜：
 * - `herdrPane`：观察窗 / 接管窗格（后端建会话时写入的窗格号）；
 * - `tmuxName`：连上后后端返回的真实 tmux 会话名（`info.tmuxSession`）；
 * - `tmuxMode === "none"`：新建时明确选了"普通 shell / 纯 SSH"；
 * - `tmuxMode === "default"`：跟着服务器配置走（`ssh.tmuxEnabled`，默认是开）。
 *
 * 连接中的 tmux 会话还没拿到 `tmuxName`，先按这次选的打开方式标；连上后
 * `tmuxName` 一到就以它为准（见 openSshSession 里的 setSessions）。
 */
export function carrierOfSession(
  s: OpenSession,
  profile?: ConnectionProfile,
): CarrierKey | null {
  // 本地终端（PowerShell / CMD / WSL / Git / 串口 / ADB）不是 T/H/S 承载，不加徽标
  if (s.kind !== "remote") return null;
  if (s.herdrPane) return "herdr";
  if (s.tmuxName) return "tmux";
  if (s.tmuxMode === "none") return "ssh";
  if (s.tmuxMode === "default" && profile?.ssh?.tmuxEnabled === false) return "ssh";
  return "tmux";
}

/**
 * 一组"这就是个壳"的 shell 名字。
 *
 * 用来判断一个 herdr 窗格**是不是空壳**（前台进程就停在提示符上、没跑任何活）。
 * herdr 的 `pane process-info` 给的是前台进程名（`bash` / `codex` / …），
 * 拿它跟这张表比就行 —— 也是"清理工作区"唯一敢自动碰的情况。
 */
export const SHELL_NAMES = new Set([
  "bash", "sh", "zsh", "fish", "dash", "ksh", "tcsh", "csh", "ash", "nu", "busybox",
]);

/**
 * 从窗格号取工作区号：`w9:p1` → `w9`。
 *
 * herdr 是 workspace > tab > pane 三层，而**会在服务器上攒着的是工作区** ——
 * 回收的时候要按工作区来，所以这个转换到处都在用。
 */
export function paneWorkspace(paneId?: string | null): string {
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
export function herdrShortLabel(title?: string | null): string | undefined {
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
export function dedupPaneId(text: string, paneId?: string | null): string {
  const p = (paneId ?? "").trim();
  if (!p) return text;
  let out = text.split(`${p} ${p}`).join(p);
  // 极端情况：连着拼了三次
  while (out.includes(`${p} ${p}`)) out = out.split(`${p} ${p}`).join(p);
  return out.trim();
}

/** 路径 → 只留最后一段（卡片上显示"项目目录"用） */
export function dirBase(p: string): string {
  const t = p.replace(/[\\/]+$/, "");
  const parts = t.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

/**
 * 会话类型 → 我们对外暴露的 4 种"终端类型"（作用范围就用这几种）
 * remote=SSH；powershell/cmd/wsl 都是本地终端；serial=串口；adb=Android
 */
export function kindOfSession(kind: string): "ssh" | "local" | "serial" | "adb" {
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
export function highlightRulesFor(
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
export function termSchemeFor(
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
export function termPaletteFor(
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
export function sshTargetLabel(ssh: { host: string; user?: string; port?: number }): string {
  const user = (ssh.user ?? "").trim();
  const port = ssh.port ?? 0;
  return `${user ? user + "@" : ""}${ssh.host}${port ? ":" + port : ""}`;
}

/** 会话状态 → 状态栏/侧栏上那个词（口径只该有一份） */
export function stateText(s: SessionState): string {
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

