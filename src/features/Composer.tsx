// 「发给 AI」输入窗：默认收起成一条细栏，点箭头才展开。
//
// 为什么收起态也必须存在：终端才是主角，收起时只占 26px；
// 草稿按会话存（切标签不串），这部分状态仍在 App（composerDraft* 那几个函数）。

import { IconChevronsDown, IconChevronsUp } from "../components/Icons";
import { pasteDiscardFile, pasteSaveFile } from "../ipc";
import { bytesToB64 } from "../util";
import { DRAFT_RESTORED_HINT } from "../lib/composer-draft";
import type { ComposerFile, Notify, OpenSession } from "../lib/ui-model";

export interface ComposerProps {
  activeSession: OpenSession;
  composerOpen: boolean;
  setComposerOpen: (v: boolean | ((prev: boolean) => boolean)) => void;
  composerText: string;
  changeComposerText: (value: string) => void;
  composerFiles: ComposerFile[];
  composerBusy: boolean;
  composerRestoredHint: boolean;
  removeComposerFile: (sessionId: string, remote: string) => void;
  composerAttachPaths: (
    session: OpenSession,
    paths: string[],
    alreadyLocal?: boolean,
  ) => Promise<unknown>;
  composerPickFiles: (session: OpenSession) => Promise<unknown>;
  sendComposer: () => Promise<unknown>;
  pasteName: (name: string) => string;
  notify: Notify;
}

export function Composer(props: ComposerProps) {
  const {
  activeSession, composerOpen, setComposerOpen, composerText, changeComposerText, composerFiles,
  composerBusy, composerRestoredHint, removeComposerFile, composerAttachPaths, composerPickFiles, sendComposer,
  pasteName, notify,
  } = props;
  return (
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
                  removeComposerFile(activeSession.id, f.remote);
                }}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      {composerRestoredHint && (
        <div className="composer-restored-hint" role="status">
          {DRAFT_RESTORED_HINT}（只恢复了文字；附件不会保存）
        </div>
      )}
      <textarea
        className="composer-input"
        placeholder="写给 AI 的话…（Enter 发送 / Shift+Enter 换行；可直接 Ctrl+V 粘图片，或把文件拖进来）"
        value={composerText}
        autoFocus
        onChange={(e) => changeComposerText(e.target.value)}
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

  );
}

