// SSH 失败的"人话"：错误分类、密码模式提示、诊断结论、密钥路径比对。
//
// 为什么抽出来：这些判断是纯字符串逻辑（没有 state、没有 IPC），却决定了用户看到的
// 到底是"密钥不对"还是"主机密钥变了"——口径只该有一份。


/** 端口留空 = 0 = "没说"：交给 `~/.ssh/config` 的 Port（后端已支持）。 */

import type { ConnectionProfile, SshDiagnosis, SshEffectiveConfig } from "../types";

export function portOrZero(v: string): number {
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
export function splitErrText(text: string): { short: string; detail: string } {
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
export function looksLikeAuthFailure(text: string): boolean {
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
 *
 * `allowPassword`：这台服务器**已经**勾了「允许在终端里输入密码」时，就别再劝他去勾
 *（他勾了还是认证失败，问题在别处）—— 那种情况由 `explainSshFailure` 补"密码模式"提示。
 */
export function connErrorText(what: string, err: unknown, allowPassword?: boolean): string {
  const raw = String(err);
  const hint =
    !allowPassword && looksLikeAuthFailure(raw)
      ? "\n这台服务器可能要密码：在「编辑服务器」里勾上「允许在终端里输入密码」再连"
      : "";
  return `${what}：${raw}${hint}`;
}

/**
 * "密码模式提示"该不该出现：认证 / 权限 / 算法这类错误，正是"本机明明有免密配置、
 * 却被密码模式挡住了"的典型症状。网络错误（超时 / 连不上）跟密码无关，不提示。
 */
export function looksLikePasswordModeTrap(text: string): boolean {
  const low = text.toLowerCase();
  return (
    looksLikeAuthFailure(text) ||
    text.includes("算法不匹配") ||
    low.includes("no common algorithm") ||
    low.includes("no matching host key")
  );
}

/** 后端那句密码模式提示（只读常量；文案和后端 `ssh::PASSWORD_MODE_HINT` 保持一致） */
export const PASSWORD_MODE_HINT =
  "本机已有免密配置；密码模式不会使用 ~/.ssh/config 与 ssh-agent，若想免密请取消勾选「允许在终端里输入密码」";

/**
 * 要不要提示"你其实有免密配置，只是被密码模式挡住了"。
 *
 * 后端 `ssh::password_mode_hint` 的口径是：启用「允许输入密码」且（配了 keyPath 或
 * `ssh -G` 有 IdentityFile 或 ssh-agent 可用）。前端**拿不到 agent 的状态**（没有命令
 * 暴露它），所以这里只认"诊断证明本机真有密钥"这一条 —— 宁可少提示，也不要把
 * "本机已有免密配置"说在一台根本没钥匙的机器上（那会让用户去关一个救命的勾）。
 */
export function passwordModeHintFor(
  profile: ConnectionProfile | undefined,
  d: SshDiagnosis | undefined,
): string | null {
  if (!d || !profile?.ssh?.allowPassword) return null;
  const keys = Array.isArray(d.key_files) ? d.key_files : [];
  if (!keys.some((k) => k.exists)) return null;
  return PASSWORD_MODE_HINT;
}

/**
 * `ssh -G` 给的是 `~/.ssh/id_ed25519` 这种路径，后端 `key_files` 给的是展开后的
 * `C:\Users\你\.ssh\id_ed25519`。要按"同一个文件"比，就得把两边都归一成
 * `.ssh/` 之后那一段（`/id_ed25519`）—— 直接字符串相等永远比不上。
 */
export function keyPathKey(p: string): string {
  const s = p.replace(/\\/g, "/").toLowerCase();
  const home = /^(?:~|%userprofile%)(\/.*)$/.exec(s);
  if (home) {
    const i = home[1].lastIndexOf("/.ssh/");
    return i >= 0 ? home[1].slice(i + 5) : home[1];
  }
  const dotSsh = s.lastIndexOf("/.ssh/");
  if (dotSsh >= 0) return s.slice(dotSsh + 5);
  return s;
}

export function sameKeyPath(a: string, b: string): boolean {
  return keyPathKey(a) === keyPathKey(b);
}

/**
 * 取"配置里真实会用的密钥列表"。
 *
 * 后端字段是 `identityfile`（OpenSSH 配置项同名）；这里同时认 `identity_files`
 * 这种写法，免得字段哪天改名界面直接瞎掉。空串 / "none" 不算。
 */
export function identityFilesOf(effective: SshEffectiveConfig | undefined): string[] {
  if (!effective) return [];
  const e = effective as SshEffectiveConfig & { identity_files?: unknown };
  const raw = Array.isArray(e.identityfile) ? e.identityfile : e.identity_files;
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === "string" && x.trim() !== "");
}

/**
 * 一句人话结论 —— 用户不该自己对着 `ssh -G` 的输出推断"我到底会怎么登录"。
 *
 * 判定顺序（先看有没有能用的钥匙，再补一句"所以接下来会怎样"）：
 * 1. 找到存在的密钥 → 说清用哪一把；他手填的私钥不在时**必须点名**（否则他会一直
 *    以为在用那把，直到某天发现免密突然失效）；
 * 2. 一把都没有 + 填了私钥路径 → 「主机密钥文件不存在」（路径写错 / 密钥没拷过来）；
 * 3. 一把都没有 + 没填 → 「没找到本机密钥」，并点出最常见的原因（「主机」里填的不是别名）；
 * 最后统一追加登录方式：勾了「允许在终端里输入密码」就会转密码登录，否则直接认证失败。
 */
export function sshDiagnosisConclusion(
  d: SshDiagnosis,
  profile?: ConnectionProfile,
): { tone: "ok" | "warn" | "bad"; text: string } {
  const configured = (profile?.ssh?.keyPath ?? "").trim();
  const keys = Array.isArray(d.key_files) ? d.key_files : [];
  const existing = keys.filter((k) => k.exists);
  const configuredKey = configured
    ? keys.find((k) => sameKeyPath(k.path, configured))
    : undefined;
  const jump = String(d.effective?.proxyjump ?? "").trim();
  const viaJump = jump ? `；会先经过跳板机 ${jump}` : "";
  const pure = d.effective?.identitiesonly === "yes";

  if (existing.length > 0) {
    let tone: "ok" | "warn" = "ok";
    let text: string;
    if (configured && configuredKey && !configuredKey.exists) {
      tone = "warn";
      text = `你指定的私钥 ${configuredKey.path} 不存在，会改用 ${existing[0].path} 免密登录`;
    } else if (configured && configuredKey?.exists) {
      text = `会用 ${configuredKey.path} 免密登录`;
    } else if (configured && !configuredKey) {
      // 填了路径但后端候选列表里没有它（例如写成相对路径）：不能假装在用，提醒一句
      tone = "warn";
      text = `会用 ${existing[0].path} 免密登录；你填的 ${configured} 没在本机找到，确认一下路径`;
    } else {
      text = `会用 ${existing[0].path} 免密登录（来自 ~/.ssh/config 或系统默认密钥）`;
    }
    if (pure) {
      text += "。config 里开了 IdentitiesOnly：只用配置里列的密钥，不会去试 ssh-agent 里的";
    }
    return { tone, text: text + viaJump };
  }

  // 一把都不存在
  let text: string;
  if (configured) {
    text = `主机密钥文件不存在：${configuredKey?.path ?? configured}（本机找不到这个文件，连接会失败）`;
  } else {
    text =
      "没找到本机密钥，可能因为「主机」里填的不是 ~/.ssh/config 里的别名；也可能是这台机器还没配过 SSH 密钥";
  }
  if (profile?.ssh?.allowPassword) {
    text += "。你勾了「允许在终端里输入密码」，会改用密码登录";
  } else {
    text += "。而且没勾「允许在终端里输入密码」，连不上时会直接报认证失败";
  }
  if (pure) {
    text += "。config 里还开了 IdentitiesOnly，ssh-agent 里的钥匙也不会被拿来试";
  }
  return { tone: "bad", text: text + viaJump };
}




