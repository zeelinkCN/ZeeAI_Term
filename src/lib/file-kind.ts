// 文件名 / 大小的纯计算：扩展名、预览类型、MIME、十进制大小、路径拼接。
//
// 为什么抽出来：文件面板、预览页、产物列表三处都要判"这个文件能不能预览"，
// 各判各的就会出现"面板里能点开、产物列表点不动"。


/**
 * 这个文件名算不算"要你去看的文档产物"？
 *
 * 用户的原话是"我选择只看生成的 HTML 或者 MD 文档"——所以默认口径里，
 * 只有 HTML / Markdown 才算"值得为它提醒一次"；其它文件（日志、临时脚本、图片…）
 * 一律不弹（想让它们也触发，去设置里把「产物范围」改成"所有文件"）。
 */

import { b64ToBytes } from "../util";
import type { FileKind } from "./ui-model";

export function isDocName(name: string): boolean {
  const n = name.trim().toLowerCase();
  return n.endsWith(".md") || n.endsWith(".markdown") || n.endsWith(".html") || n.endsWith(".htm");
}

export function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

export function fileKind(name: string): FileKind {
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

export function imgMime(name: string): string {
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

export function decodeB64Text(b64: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(b64ToBytes(b64));
  } catch {
    return "";
  }
}

export function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function joinPath(dir: string, name: string): string {
  if (!dir) return `/${name}`;
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

export function parentOf(path: string): string {
  if (!path || path === "/") return "/";
  const trimmed = path.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i <= 0 ? "/" : trimmed.slice(0, i);
}




