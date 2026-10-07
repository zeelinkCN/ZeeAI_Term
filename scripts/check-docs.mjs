// 文档 × 实现的"漂移"守门人（发版前跑，见 scripts/publish-release.ps1 第 1.5 步）。
//
// 为什么要有它：README / 界面里那几句承诺是**手工维护**的，而实现会变。用户已经踩过两次：
//   - README 写着便携版"可一键升级"，实现里便携版是**明确拒绝**的（没有安装目录可写）；
//   - README 写着"14 套终端配色"，实际是 15 套；
//   - Fastboot 只做了"看设备/看版本"，但界面和 README 的措辞让人以为能刷机。
// 这类漂移不会让任何测试变红，只会让用户在第一天就不信这个工具 —— 所以让发版脚本拦住它。
//
// 用法：node scripts/check-docs.mjs      （全过 exit 0，有漂移 exit 1）

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  | " + extra : ""}`);
};

const readme = read("README.md");
const app = read("src/App.tsx");
const commands = read("src-tauri/src/commands.rs");

// ---------- 1) 套数：README 说的 == 代码里真有的 ----------
const m = /(\d+)\s*套界面主题\s*\+\s*(\d+)\s*套终端配色/.exec(readme);
const uiThemes = (app.match(/\{ key: "[a-z0-9-]+", label: "[^"]+", kind: "(?:dark|light)" \}/g) ?? [])
  .length;
const termSchemes = (read("src/termThemes.ts").match(/^\s*key:\s*"[^"]+"/gm) ?? []).length;
check(
  `README 的界面主题套数与代码一致（README ${m?.[1] ?? "?"} / 实际 ${uiThemes}）`,
  !!m && Number(m[1]) === uiThemes,
);
check(
  `README 的终端配色套数与代码一致（README ${m?.[2] ?? "?"} / 实际 ${termSchemes}）`,
  !!m && Number(m[2]) === termSchemes,
);

// ---------- 2) 便携版能不能"应用内一键升级" ----------
const implRejectsPortable = /当前是便携版，无法自动覆盖升级/.test(commands);
const portableNote = (readme.match(/>\s*便携版：[\s\S]*?(?=\n\s*\n)/) ?? [""])[0];
const noteSaysNoUpgrade = /(没有|不支持)[^。\n]*一键升级/.test(portableNote);
const noteClaimsUpgrade = /可一键升级/.test(portableNote);
check(
  "便携版升级口径一致（实现拒绝便携版 → README 必须写明「不支持」）",
  implRejectsPortable ? noteSaysNoUpgrade && !noteClaimsUpgrade : true,
  `实现拒绝=${implRejectsPortable}，README 说明不支持=${noteSaysNoUpgrade}，README 仍承诺=${noteClaimsUpgrade}`,
);

// ---------- 3) Fastboot 的能力与措辞 ----------
const fastbootCmds = [...commands.matchAll(/pub (?:async )?fn (fastboot_\w+)/g)].map((x) => x[1]);
const canFlash = fastbootCmds.some((c) => /flash|reboot|update|erase/.test(c));
const uiReadOnly = /Fastboot 设备（bootloader 模式 · 只读探测）/.test(app);
const readmeReadOnly = /Fastboot 设备探测（[^）]*不刷机/.test(readme);
check(
  "Fastboot 措辞与能力一致（只探测 → 界面/README 都写明只读）",
  canFlash ? true : uiReadOnly && readmeReadOnly,
  `后端命令=${fastbootCmds.join("/") || "（无）"}，界面只读=${uiReadOnly}，README 只读=${readmeReadOnly}`,
);

// ---------- 4) 自检/演示代码不许进发布二进制 ----------
const cargo = read("src-tauri/Cargo.toml");
const lib = read("src-tauri/src/lib.rs");
const featureDeclared = /^\s*selftest\s*=\s*\[\s*\]/m.test(cargo);
const gated =
  /#\[cfg\(feature = "selftest"\)\][\s\S]{0,200}?ZEEAI_SELFTEST/.test(lib) &&
  /#\[cfg\(feature = "selftest"\)\][\s\S]{0,200}?ZEEAI_AUTODEMO/.test(lib);
check(
  'ZEEAI_SELFTEST / ZEEAI_AUTODEMO 是特性门控的（默认不编进发布二进制）',
  featureDeclared && gated,
  `Cargo.toml 有 selftest feature=${featureDeclared}，lib.rs 门控=${gated}`,
);

const failed = results.filter((r) => !r.ok).length;
console.log(`\n结果：${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
