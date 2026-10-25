// 「连接诊断」弹窗：编辑服务器里的按钮 和 连接失败提示 共用这一个。
//
// 为什么抽成组件：它是一块只读展示（拿到 SshDiagView 就画），
// 唯一的交互是"关掉"，跟 App 的 state 没有任何别的来往。


/**
 * 连接诊断弹窗 —— 「编辑服务器」里的按钮 和 连接失败提示 共用这一个。
 *
 * 只展示人看得懂的东西：一句总结（大字）、实际生效的主机/端口/用户、每个密钥存在与否、
 * 有才显示的跳板机 / ProxyCommand / IdentitiesOnly / BatchMode，以及前端算出来的人话结论。
 * **不摆原始 JSON** —— 那是给排查问题的人看的，普通用户只会被吓到。
 */

import { identityFilesOf, passwordModeHintFor, sameKeyPath, sshDiagnosisConclusion } from "../lib/ssh-text";
import type { SshDiagView } from "../lib/ui-model";

export function SshDiagnosisModal(props: {
  view: SshDiagView;
  onClose: () => void;
  onRetry: () => void;
}): JSX.Element {
  const { view, onClose, onRetry } = props;
  const d = view.data;
  const conclusion = d ? sshDiagnosisConclusion(d, view.profile) : null;
  const hint = passwordModeHintFor(view.profile, d);
  const idFiles = identityFilesOf(d?.effective);
  const keyFiles = Array.isArray(d?.key_files) ? d!.key_files : [];
  /** 某个路径在本机上到底存不存在；后端没给这一条时返回 undefined（不瞎猜） */
  const existsOf = (path: string): boolean | undefined => {
    const hit = keyFiles.find((k) => sameKeyPath(k.path, path));
    return hit ? hit.exists : undefined;
  };
  const mainKeys =
    idFiles.length > 0
      ? idFiles.map((path) => ({ path, exists: existsOf(path) }))
      : keyFiles.map((k) => ({ path: k.path, exists: k.exists as boolean | undefined }));
  // 配置里没列、但本机真的有的密钥：用户最常问"我 ~/.ssh 里明明有钥匙，为什么没用上"
  const otherKeys = keyFiles.filter(
    (k) => k.exists && !mainKeys.some((m) => sameKeyPath(m.path, k.path)),
  );
  const extras: { label: string; value: string }[] = [];
  if (d) {
    const e = d.effective;
    const jump = String(e?.proxyjump ?? "").trim();
    const proxyCmd = String(e?.proxycommand ?? "").trim();
    if (jump) extras.push({ label: "跳板机", value: jump });
    if (proxyCmd) extras.push({ label: "ProxyCommand", value: proxyCmd });
    // 这两个 OpenSSH 默认就是 no / 空：只有用户/配置真写了才说，别拿默认值凑数
    if (e?.identitiesonly) {
      extras.push({
        label: "IdentitiesOnly（只用配置里列的密钥）",
        value: e.identitiesonly === "yes" ? "是" : "否",
      });
    }
    if (e?.batchmode) {
      extras.push({
        label: "BatchMode（不弹密码提示）",
        value: e.batchmode === "yes" ? "是" : "否",
      });
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal diag-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          连接诊断{view.name ? ` · ${view.name}` : ""}
          <button
            type="button"
            className="mini-x"
            style={{ float: "right", opacity: 1 }}
            title="关闭"
            onClick={onClose}
          >
            ✕
          </button>
        </div>
        <div className="modal-body">
          {view.failure && (
            <div className="diag-failure">刚才的连接错误：{view.failure}</div>
          )}
          {view.loading && (
            <div className="hint">正在读取本机 SSH 配置…（只读，不会连接服务器）</div>
          )}
          {view.error && (
            <div className="diag-error">读不到本机 SSH 配置：{view.error}</div>
          )}
          {d && (
            <>
              <div className="diag-summary">{d.summary}</div>
              {conclusion && (
                <div className={"diag-verdict " + conclusion.tone}>{conclusion.text}</div>
              )}
              {hint && <div className="diag-hint">⚠ {hint}</div>}
              <div className="diag-rows">
                <div className="diag-row">
                  <span>实际主机</span>
                  <b>{d.effective?.hostname || "（未知）"}</b>
                </div>
                <div className="diag-row">
                  <span>端口</span>
                  <b>{d.effective?.port || 22}</b>
                </div>
                <div className="diag-row">
                  <span>用户</span>
                  <b>{d.effective?.user || "（本机当前用户名）"}</b>
                </div>
                {extras.map((x) => (
                  <div className="diag-row" key={x.label}>
                    <span>{x.label}</span>
                    <b>{x.value}</b>
                  </div>
                ))}
              </div>
              <div className="diag-section">本机密钥（配置里列的 + 系统默认位置）</div>
              {mainKeys.length === 0 ? (
                <div className="hint">配置里没有 IdentityFile，也没在默认位置找到密钥</div>
              ) : (
                <div className="diag-keys">
                  {mainKeys.map((k) => (
                    <div
                      className={
                        "diag-key " + (k.exists === true ? "ok" : k.exists === false ? "missing" : "")
                      }
                      key={k.path}
                    >
                      <span className="diag-key-flag">
                        {k.exists === true ? "✓ 存在" : k.exists === false ? "✗ 不存在" : "? 无法确认"}
                      </span>
                      <span className="diag-key-path" title={k.path}>
                        {k.path}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {otherKeys.length > 0 && (
                <>
                  <div className="diag-section">本机找到的其他密钥（没在配置里，但可以用）</div>
                  <div className="diag-keys">
                    {otherKeys.map((k) => (
                      <div className="diag-key ok" key={k.path}>
                        <span className="diag-key-flag">✓ 存在</span>
                        <span className="diag-key-path" title={k.path}>
                          {k.path}
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </div>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onRetry} disabled={view.loading}>
            重新诊断
          </button>
          <button type="button" className="btn primary" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}




