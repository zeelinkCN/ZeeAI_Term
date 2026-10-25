// 左侧活动栏：模块切换（远程/本地 shell/Git/串口/Android）+ AI 看板按钮 + 设置。
//
// 为什么单独一个文件：它是"导航"，每个按钮只有两件事（选中态 + 点一下切过去），
// 但如果留在 App 里，每次改模块都要和几千行 JSX 一起读一遍。

import { IconGear, IconSpark } from "../components/Icons";
import type { ModuleKey } from "../lib/ui-model";
import { AI_PANEL_HIDDEN } from "../lib/ai-labels";
import { MODULES } from "../lib/modules";

export interface ActivityBarProps {
  module: ModuleKey;
  activateModule: (key: ModuleKey) => void;
  aiPanelOpen: boolean;
  setAiPanelOpen: (v: boolean | ((prev: boolean) => boolean)) => void;
  /** AI 红点上的数字（0 = 不显示；面板停用时也不显示） */
  aiBadgeCount: number;
  /** 有可用更新时，齿轮旁边亮一个小红点 */
  updateOffer: { version: string } | null;
  setShowSettings: (v: boolean) => void;
}

export function ActivityBar(props: ActivityBarProps) {
  const {
  module, activateModule, aiPanelOpen, setAiPanelOpen, aiBadgeCount, updateOffer,
  setShowSettings,
  } = props;
  return (
    <nav className="activitybar">
      {MODULES.map((m) => (
        <button
          key={m.key}
          type="button"
          className={"act" + (module === m.key ? " active" : "")}
          title={m.label}
          onClick={() => activateModule(m.key)}
        >
          {m.node}
        </button>
      ))}
      <div className="act-sep" />
      <div className="act-foot">
        <button
          type="button"
          className={"act" + (aiPanelOpen ? " active" : "")}
          title="AI 任务看板（需要你 / 运行中 / 最近完成）"
          onClick={() => setAiPanelOpen((v) => !v)}
        >
          <IconSpark size={22} />
          {/* 有"要你处理/新消息"没看过时显示数字（设置里可关） */}
          {/* 红点只在两件事上亮（§10.6）：需要你（亮到你处理）、跑完停下（点开就消）。
              两条规则各有一个开关，所以这里不能再拿一个"总开关"去盖。 */}
          {/* 面板停用时红点逻辑照跑、但不渲染给人看（用户：「只看灰容器」；
              点开也看不到任何东西，亮个数字只会让人以为有地方可去） */}
          {!AI_PANEL_HIDDEN && aiBadgeCount > 0 && (
            <span className="act-badge">{aiBadgeCount > 9 ? "9+" : aiBadgeCount}</span>
          )}
        </button>
        <button
          type="button"
          className="act"
          title="设置"
          onClick={() => setShowSettings(true)}
        >
          <IconGear size={22} />
          {updateOffer && <span className="act-dot" />}
        </button>
      </div>
    </nav>

  );
}

