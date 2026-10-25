// 「发给 AI」输入窗草稿的跨重启持久化（只存纯文本）。
//
// 为什么在这里、而不是留在 App 里：读写 localStorage + 淘汰策略是纯函数，
// 和 React 一点关系都没有；留在组件里只会让它继续长。


// ---------------------------------------------------------------------------
// 「发给 AI」草稿的跨重启持久化（**只存纯文本**）
// ---------------------------------------------------------------------------
/**
 * 为什么按"会话身份键"而不是 sessionId：`sessionId` 是每次启动用 `uid()` 随机生成的，
 * 重启后必然对不上，存了也恢复不了。这里用 profileId + 承载方式 + 用户 + 标题拼一个
 * 稳定键 —— 这几项在「恢复工作区」时都是原样带回来的。
 *
 * **故意不拼 cwd**：cwd 会随用户在终端里 `cd` 而变，拼进键里一换目录就变成另一份草稿
 *（用户看到的现象就是"刚才写的话没了"）。标题已经足够区分同一台机器上的多个会话。
 *
 * 附件不持久化：上传产物是远端临时文件、本地那份也会被清理，重启后恢复出来也发不出去。
 */

import type { OpenSession } from "./ui-model";

export const DRAFT_STORE_KEY = "zeeai.composer-drafts.v1";
export const DRAFT_MAX_ENTRIES = 200;
/** 单条草稿上限（UTF-8 字节）。超过就**不落盘**（内存里那份仍然可用）——
 *  与其静默截断把用户写的话砍掉半句，不如不存。 */
export const DRAFT_MAX_BYTES = 20 * 1024;
export const DRAFT_SAVE_DEBOUNCE_MS = 300;
export const DRAFT_RESTORED_HINT = "已恢复上次的草稿";

export interface StoredComposerDraft {
  text: string;
  /** 最后编辑时间：超过 200 条时按它淘汰最旧的 */
  at: number;
}

export function composerDraftIdentity(s: OpenSession): string {
  // 承载方式：herdr 窗格 > tmux（用真实会话名，不同 tmux 会话算不同身份）> 新建时的模式。
  // 只看会话对象里已有的字段，不查 profiles（启动时 profiles 可能比会话晚到）。
  const carrier = s.herdrPane
    ? "herdr:" + s.herdrPane
    : s.tmuxName
      ? "tmux:" + s.tmuxName
      : s.tmuxMode
        ? "tmux-mode:" + s.tmuxMode
        : s.kind === "remote"
          ? "ssh"
          : "local";
  return [s.kind, s.profileId ?? "-", s.user ?? "-", carrier, s.title].join("|");
}

export function draftTextBytes(text: string): number {
  // 用 UTF-8 字节数算 20KB（中文一个字 3 字节，按 length 算会放得太松）
  return new TextEncoder().encode(text).length;
}

/** 淘汰：先扔掉空稿 / 超长稿，再按最后编辑时间从新到旧只留前 200 条 */
export function pruneStoredDrafts(
  entries: Map<string, StoredComposerDraft>,
): Map<string, StoredComposerDraft> {
  const kept = [...entries.entries()]
    .filter(
      ([, v]) =>
        v &&
        typeof v.text === "string" &&
        v.text.trim().length > 0 &&
        draftTextBytes(v.text) <= DRAFT_MAX_BYTES,
    )
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, DRAFT_MAX_ENTRIES);
  return new Map(kept);
}

export function loadStoredDrafts(): Map<string, StoredComposerDraft> {
  try {
    const raw = localStorage.getItem(DRAFT_STORE_KEY);
    if (!raw) return new Map();
    const parsed = JSON.parse(raw) as {
      version?: number;
      entries?: Record<string, StoredComposerDraft>;
    };
    if (!parsed || parsed.version !== 1 || !parsed.entries) return new Map();
    return pruneStoredDrafts(new Map(Object.entries(parsed.entries)));
  } catch {
    // 坏数据 / localStorage 不可用：当作没有草稿（不影响本次使用）
    return new Map();
  }
}

export function writeStoredDrafts(entries: Map<string, StoredComposerDraft>) {
  const pruned = pruneStoredDrafts(entries);
  entries.clear();
  for (const [k, v] of pruned) entries.set(k, v);
  try {
    localStorage.setItem(
      DRAFT_STORE_KEY,
      JSON.stringify({ version: 1, entries: Object.fromEntries(pruned) }),
    );
  } catch {
    /* 隐私模式 / 配额满：内存里的草稿照旧可用，只是重启后不恢复 */
  }
}




