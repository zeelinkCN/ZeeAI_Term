// 底部状态栏：会话 · 连通性 · 「需要你 N」· 传输（§10.3 只留这四件事）。
//
// 技术标识（编码 / 终端类型）收进 title 悬停 —— 状态栏不是调试面板。

import { IconActivity } from "../components/Icons";
import type { OpenFile, OpenSession, StatusMsg } from "../lib/ui-model";
import { AI_PANEL_HIDDEN, aiAgentLabel, aiInstanceWhere } from "../lib/ai-labels";
import { MODULE_LABEL } from "../lib/modules";
import { stateText } from "../lib/session-labels";
import type { AiInstance } from "../types";

export interface StatusBarProps {
  activeSession: OpenSession | null;
  activeFile: OpenFile | null;
  statusMsg: StatusMsg | null;
  setStatusMsg: (v: StatusMsg | null) => void;
  /** 需要你处理的实例 id（点一下开 AI 面板） */
  aiNeedIds: string[];
  boardInstances: AiInstance[];
  setAiPanelOpen: (v: boolean) => void;
  isAdminMode: boolean;
  /** 连接失败时状态栏上那个「诊断一下」 */
  openSshDiagnosis: (profileId: string, failure?: string) => Promise<unknown>;
}

export function StatusBar(props: StatusBarProps) {
  const {
  activeSession, activeFile, statusMsg, setStatusMsg, aiNeedIds, boardInstances,
  setAiPanelOpen, isAdminMode, openSshDiagnosis,
  } = props;
  return (
    <div
      className="statusbar"
      title="终端编码 UTF-8 · 终端类型 xterm-256color（右键终端可看「会话信息」）"
    >
      <span className="stat">
        <IconActivity size={14} />
        {activeSession
          ? `${MODULE_LABEL[activeSession.kind]} · ${activeSession.title} · ${stateText(activeSession.state)}`
          : "就绪"}
      </span>
      <span className="spacer" />
      {statusMsg && (
        <span
          className={"status-notice " + statusMsg.kind}
          // 悬停给**完整原文**：状态栏只显示中文短句（后端返回的是
          // 「中文短句｜原始信息：<英文>」，英文那段太长，挤在状态栏里没人读得下去）
          title={statusMsg.detail || statusMsg.text}
          onClick={() => setStatusMsg(null)}
        >
          {/* 文案单独一层：状态栏是 nowrap + 省略号，入口按钮不能被它挤出去 */}
          <span className="status-text">{statusMsg.text}</span>
          {statusMsg.diagProfileId && (
            <button
              type="button"
              className="status-diag"
              title="只读诊断：看本机实际会用哪个主机 / 端口 / 用户 / 密钥，不会再去连服务器"
              onClick={(e) => {
                // 别让点按钮顺手把提示关掉（外层 onClick 是"点一下关掉"）
                e.stopPropagation();
                const id = statusMsg.diagProfileId;
                const why = statusMsg.diagFailure;
                setStatusMsg(null);
                if (id) void openSshDiagnosis(id, why);
              }}
            >
              为什么会失败？诊断一下
            </button>
          )}
        </span>
      )}
      {activeFile && <span className="stat">{activeFile.path}</span>}
      {/* 状态栏只留四件事：会话 · 连通性 · 「需要你 N」· 传输（§10.3）。
          所以这里**只有**「需要你」那一个 chip —— "AI 已完成" 不再单独占一个
          （完成已经在面板的「最近完成 N 项」里，三处各说一遍是这轮要收掉的乱）。
          点它 = 打开面板；needs-you 是唯一真正值得打断用户的事。 */}
      {/* 面板停用时不渲染「需要你」chip：逻辑保留（状态还在算），只是没有面板可去，
          亮一个红色数字反而误导。恢复面板 = 把 AI_PANEL_DISABLED 改成 false。 */}
      {!AI_PANEL_HIDDEN && aiNeedIds.length > 0 && (
        <button
          type="button"
          className="stat ai-need-chip"
          title={`${boardInstances
            .filter((i) => i.state === "needs-you")
            .map((i) => `${aiAgentLabel(i.agent)} · ${aiInstanceWhere(i)} · ${i.badge}`)
            .join("\n")}\n\n点这里打开看板（红点亮到你处理为止）`}
          onClick={() => setAiPanelOpen(true)}
        >
          需要你 {aiNeedIds.length}
        </button>
      )}
      {isAdminMode && (
        <span
          className="stat admin"
          title="当前以管理员身份运行：新开的 PowerShell / CMD / WSL 都是管理员"
        >
          🛡 管理员
        </span>
      )}
    </div>

  );
}



