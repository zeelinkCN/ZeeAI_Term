// 文件预览：Markdown / HTML / 图片 / 纯文本，外加「下载到本机」。
//
// 为什么单独一个文件：预览是只读的（html 走 sandbox iframe、markdown 过 DOMPurify），
// 和主界面只通过 props 来往 —— 抽出来之后 App 不再背着 DOMPurify/markdown-it 的渲染逻辑。

import { open as openLocalDialog } from "@tauri-apps/plugin-dialog";
import { fsDownload } from "../ipc";
import DOMPurify from "dompurify";
import type { FileKind, MdStyle, OpenFile } from "../lib/ui-model";
import { decodeB64Text, imgMime } from "../lib/file-kind";
import { md } from "../lib/markdown";
import { useMemo, useState } from "react";

const MD_STYLES: { key: MdStyle; label: string }[] = [
  { key: "github", label: "GitHub" },
  { key: "minimal", label: "简洁" },
  { key: "dark", label: "深色" },
  { key: "paper", label: "文档" },
];

export function FileView({
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


