// 右侧 AI 任务看板（**面板这一版整体停用**，见 lib/ai-labels 的 AI_PANEL_DISABLED）。
//
// 为什么照样抽出来：它现在只渲染一个灰容器，但逻辑（红点、通知、时间线、herdr 管理）
// 全都还在跑 —— 抽成组件能让 App 瘦一大圈，等恢复面板时改动也只落在这一个文件里。

import { aiTimelineClear } from "../ipc";
import type { Notify, OpenSession } from "../lib/ui-model";
import { AI_PANEL_HIDDEN, aiAgentLabel, aiCarrierLabel, aiDurationText } from "../lib/ai-labels";
import { dirBase } from "../lib/session-labels";
import type { AiInstance, AiSourceInfo, AiTurnRecord, HerdrServerStatus, HerdrWorkspaceScan } from "../types";

export interface AiPanelProps {
  activeSession: OpenSession | null;
  sessions: OpenSession[];
  setActiveId: (v: string | null) => void;
  setAiPanelOpen: (v: boolean) => void;
  /** 四组实例（需要你 / 运行中 / 最近完成 / 没在用） */
  boardNeedsYou: AiInstance[];
  boardWorking: AiInstance[];
  boardFinished: AiInstance[];
  boardIdle: AiInstance[];
  boardInstances: AiInstance[];
  finishedOpen: boolean;
  setFinishedOpen: (v: boolean | ((prev: boolean) => boolean)) => void;
  idleOpen: boolean;
  setIdleOpen: (v: boolean | ((prev: boolean) => boolean)) => void;
  boardCard: (i: AiInstance) => JSX.Element | null;
  /** 底部通知气泡（几秒后自己消失，App 里有定时清理） */
  aiNotices: { id: string; text: string; time: number }[];
  setAiNotices: (v: { id: string; text: string; time: number }[]) => void;
  /** 观察来源（装了 herdr 就是它的状态机，否则是自己的探测） */
  aiSource: AiSourceInfo | null;
  aiSourceProbed: boolean;
  aiSourceProbing: boolean;
  aiRefreshing: boolean;
  refreshAiSource: (force?: boolean) => Promise<unknown>;
  refreshAiPanel: () => Promise<unknown>;
  /** herdr 服务状态与可回收的工作区 */
  herdrServer: HerdrServerStatus | null;
  herdrScan: HerdrWorkspaceScan | null;
  herdrOrphanList: string[];
  herdrCleanList: string[];
  herdrCleanArmed: boolean;
  setHerdrCleanArmed: (v: boolean) => void;
  herdrStopArmed: boolean;
  setHerdrStopArmed: (v: boolean) => void;
  herdrInstalling: Record<string, string>;
  cleanHerdrOrphans: () => Promise<unknown>;
  stopHerdrServer: (pidOverride?: string, userOverride?: string | null) => Promise<unknown>;
  installHerdrFor: (profileId: string, user?: string | null) => Promise<unknown>;
  /** 落盘的任务时间线（应用重启后还在） */
  timeline: AiTurnRecord[];
  timelineAll: boolean;
  setTimelineAll: (v: boolean | ((prev: boolean) => boolean)) => void;
  setTimeline: (v: AiTurnRecord[] | ((prev: AiTurnRecord[]) => AiTurnRecord[])) => void;
  loadTimeline: () => Promise<unknown>;
  notify: Notify;
}

export function AiPanel(props: AiPanelProps) {
  const {
  activeSession, sessions, setActiveId, setAiPanelOpen, boardNeedsYou,
  boardWorking, boardFinished, boardIdle, boardInstances, finishedOpen, setFinishedOpen,
  idleOpen, setIdleOpen, boardCard, aiNotices, setAiNotices, aiSource,
  aiSourceProbed, aiSourceProbing, aiRefreshing, refreshAiSource, refreshAiPanel, herdrServer,
  herdrScan, herdrOrphanList, herdrCleanList, herdrCleanArmed, setHerdrCleanArmed, herdrStopArmed,
  setHerdrStopArmed, herdrInstalling, cleanHerdrOrphans, stopHerdrServer, installHerdrFor, timeline,
  timelineAll, setTimelineAll, setTimeline, loadTimeline, notify,
  } = props;
  return (
    <aside className={"ai-panel" + (AI_PANEL_HIDDEN ? " off" : "")}>
      {/* ---------- 面板整体停用（开关在上面的 AI_PANEL_DISABLED） ----------
          用户 2026-10-24：「整个面板都停用，只留灰色容器」。
          保留：容器 / 开合 / 宽度；**内容一条都不渲染** —— 不是 CSS 藏起来，
          是这里直接不挂 DOM（看板卡片、按钮、提示、刷新入口全都不会出现）。
          代码原样包在下面这个条件里；把常量改回 false 就全回来。
          唯一例外：无头测试注入 `__ZEEAI_TEST_AI_PANEL__` 时临时渲染（见上方
          `AI_PANEL_TEST_ONLY_SHOW` 的说明），正常启动没有这个全局。
          `aiPanelOpen` 还照旧控制"有没有这块灰板"，活动栏星号也照旧能开合。 */}
      {AI_PANEL_HIDDEN ? null : (
        <>
      <div className="ai-head">
        {/* 标题**固定**，不再跟着当前会话走。
            以前写「AI Agent · PowerShell」，下面列的却是远端的卡 —— 用户实测因此以为
            "它探测到我的 PowerShell 里有 Codex"。面板里的卡片本来就是全环境的，
            所以标题只说这是什么，环境归属交给每张卡自己标（docs/backlog.md 第 2 条 ②）。 */}
        <span className="grow ellipsis" title="全环境（本机 / WSL / 各台服务器）的 AI 任务">
          AI 任务看板
        </span>
        <button
          type="button"
          className="mini-btn"
          style={{ opacity: 1 }}
          title="探测一次：本机 / 服务器上现在有没有 AI 在跑（只在你点的时候查，不会自动探测）"
          disabled={aiRefreshing}
          onClick={() => void refreshAiPanel()}
        >
          {aiRefreshing ? "探测中…" : "刷新"}
        </button>
        <button
          type="button"
          className="mini-x"
          style={{ opacity: 1 }}
          title="收起面板"
          onClick={() => setAiPanelOpen(false)}
        >
          ✕
        </button>
      </div>

      {/* ---------- AI 任务看板：多环境汇总 ---------- */}
      {/* 口径 §10.2：**承载健康只在异常时出现**。
          "herdr 服务：运行中 · 3 个窗格"这种正常状态看一眼就再也不需要了，
          常驻等于每一层都在抢同一块注意力 —— 所以没异常时整块不渲染，
          能查的东西（服务 / 工作区 / 来源明细）都在下面的折叠行与悬停里。 */}
      <div className="ai-section">需要你 {boardNeedsYou.length}</div>
      {boardInstances.length === 0 ? (
        <div className="hint" style={{ padding: "2px 12px 8px" }}>
          点「刷新」看看本机 / 服务器上现在有没有 AI 在跑
        </div>
      ) : null}
      {boardNeedsYou.length > 0 && (
        <div className="ai-board">{boardNeedsYou.map((i) => boardCard(i))}</div>
      )}

      <div className="ai-section">运行中 {boardWorking.length}</div>
      {boardWorking.length > 0 && (
        <div className="ai-board">{boardWorking.map((i) => boardCard(i))}</div>
      )}

      {/* 「最近完成」「空闲」各折成一行（§10.1 / §10.2）：点开才渲染明细。
          数据一直落盘（`ai_turns.json`），不显示 ≠ 丢掉。 */}
      {boardFinished.length > 0 && (
        <button
          type="button"
          className="ai-fold"
          title="最近完成的实例：谁 / 什么时候 / 有什么产物（点开才看）"
          onClick={() => setFinishedOpen((v) => !v)}
        >
          {finishedOpen ? "▾" : "▸"} 最近完成 {boardFinished.length} 项
        </button>
      )}
      {finishedOpen &&
        boardFinished.map((i) => (
          <div className="ai-board" key={i.id}>
            {boardCard(i)}
          </div>
        ))}

      {boardIdle.length > 0 && (
        <button
          type="button"
          className="ai-fold"
          title="空闲 / 状态未知的实例：它们是现状，不是任务（点开才看）"
          onClick={() => setIdleOpen((v) => !v)}
        >
          {idleOpen ? "▾" : "▸"} 空闲 {boardIdle.length} 项
        </button>
      )}
      {idleOpen &&
        boardIdle.map((i) => (
          <div className="ai-board" key={i.id}>
            {boardCard(i)}
          </div>
        ))}

      {/* ---------- L4 承载健康：**只在异常时出现**（§10.2 / §10.5） ----------
          为什么只在异常时：`herdr 服务：运行中 · 3 个窗格` 这种正常状态用户看一眼就
          再也不需要了，常驻等于每一层都在抢同一块注意力。
          进这一块的条件只有三类：探测失败 / herdr 太旧 / 有工作区要清理。
          （服务没在跑由 herdr 自己按需拉起，所以不算异常。）
          没跑 agent 的承载（CMD 这类空承载，§10.5 **不上板**）也在这块的悬停里查。 */}
      {/* 没点过「刷新」就不显示承载健康：`aiSource === null` 现在也可能是"还没探"，
          直接写"探测失败"会冤枉一台好好的机器。 */}
      {!aiSourceProbed ? null : aiSourceProbing ? null : !aiSource ? (
        <div
          className="ai-source-line warn"
          role="button"
          title="探测这台服务器时没连上（可能是网络/sshd 一时拥塞）。点击重试。"
          onClick={() => void refreshAiSource(true)}
        >
          承载健康 · 探测失败（没连上，不代表没装）· 点一下重试
        </div>
      ) : aiSource.herdrVersion && aiSource.compat === "too_old" ? (
        <div
          className="ai-source-line warn"
          role="button"
          title={`herdr ${aiSource.herdrVersion} 的协议是 ${aiSource.protocol}（< 20），太旧 → 已回退到本机探测。点击重新探测。`}
          onClick={() => void refreshAiSource(true)}
        >
          承载健康 · herdr {aiSource.herdrVersion} 太旧（协议 {aiSource.protocol} &lt; 20）
          → 已回退到本机探测
        </div>
      ) : herdrCleanList.length > 0 ? (
        <div className="modal-inline-action" style={{ padding: "2px 12px 8px" }}>
          <span
            className="hint"
            title={
              // 「我开了哪些承载」查得到的落点（§10.5）：
              // 服务器上所有 herdr 工作区 + 没在用的 + 能安全清理的 + 空承载清单
              `服务器上的工作区：${herdrScan?.workspaces.join("、") || "（没有）"}\n` +
              `没在用（不在任何已打开/历史会话里）：${herdrOrphanList.join("、") || "（没有）"}\n` +
              `其中是空壳（只停在提示符上，可以安全清理）：${herdrCleanList.join("、")}\n` +
              `承载与状态来源（没跑 agent 的不上看板，§10.5）：${
                boardInstances
                  .map((i) => `${aiAgentLabel(i.agent)}@${aiCarrierLabel(i.carrier)}`)
                  .join("、") || "（无）"
              }`
            }
          >
            承载健康 · herdr 工作区：{herdrScan?.workspaces.length ?? 0} 个
            {herdrOrphanList.length ? `（${herdrOrphanList.length} 个没在用）` : "（都在用）"}
          </span>
          {herdrCleanArmed ? (
            <>
              <button
                type="button"
                className="mini-btn danger"
                title={`会关掉：${herdrCleanList.join("、")}\n（都是停在提示符上的空壳工作区；里面正跑着东西的一个都不会碰）`}
                onClick={() => void cleanHerdrOrphans()}
              >
                确认清理（{herdrCleanList.join("、")}）
              </button>
              <button
                type="button"
                className="mini-btn"
                onClick={() => setHerdrCleanArmed(false)}
              >
                取消
              </button>
            </>
          ) : (
            <button
              type="button"
              className="mini-btn"
              title="只关掉「不属于任何已打开/历史会话」而且「里面只停着 shell」的工作区"
              onClick={() => setHerdrCleanArmed(true)}
            >
              清理空壳（{herdrCleanList.length}）…
            </button>
          )}
        </div>
      ) : null}
      {/* 装了 herdr 时：服务的生命周期（停止会关掉它管着的所有窗格 → 二段确认）。
          只在"当前会话那台机器"上给这个开关；正常运行时它是折叠的。
          注意和上面那条互斥：有工作区要清理时先让用户清理（两行挤一起就不是"只在异常时出现"了）。 */}
      {aiSource?.herdrVersion &&
      herdrServer?.running &&
      herdrCleanList.length === 0 &&
      (activeSession?.profileId || herdrScan) ? (
        <details className="ai-health" open={false}>
          <summary title="承载健康：herdr 服务 / 工作区 / 探测明细（正常时不占位置）">
            herdr 服务：运行中 · {herdrServer.panes} 个窗格
          </summary>
          <div className="modal-inline-action" style={{ padding: "6px 0 2px" }}>
            {herdrStopArmed ? (
              <>
                <button
                  type="button"
                  className="mini-btn danger"
                  title={
                    "停止 herdr 服务 —— 它管着的所有窗格都会关掉，" +
                    "里面正在跑的 AI 也会一起没；看板上这些窗格的卡片会跟着变准不了。\n" +
                    "（只想腾地方的话，用「清理空壳工作区」一个个关更稳）"
                  }
                  onClick={() => void stopHerdrServer()}
                >
                  确认停止（会关掉所有 herdr 窗格）
                </button>
                <button
                  type="button"
                  className="mini-btn"
                  onClick={() => setHerdrStopArmed(false)}
                >
                  取消
                </button>
              </>
            ) : (
              <button
                type="button"
                className="mini-btn"
                onClick={() => setHerdrStopArmed(true)}
              >
                停止服务…
              </button>
            )}
          </div>
        </details>
      ) : null}
      {/* 没装 herdr 时给一个"一键安装"入口：由 Windows 侧下载 → 校验 sha256 →
          scp 到 ~/.local/bin（不执行远端脚本、不要 root）。已经装了就不显示。 */}
      {aiSource && !aiSource.herdrVersion && activeSession?.profileId ? (
        <div className="modal-inline-action" style={{ padding: "2px 12px 8px" }}>
          {herdrInstalling[activeSession.profileId] ? (
            <span className="hint">正在装 herdr：{herdrInstalling[activeSession.profileId]}</span>
          ) : (
            <button
              type="button"
              className="mini-btn"
              title="从 herdr.dev 拿官方版本号与 sha256，在 Windows 侧下载并校验后上传到 ~/.local/bin/herdr（不需要 root）"
              onClick={() =>
                void installHerdrFor(activeSession.profileId ?? "", activeSession.user ?? null)
              }
            >
              一键安装 herdr
            </button>
          )}
        </div>
      ) : null}

      {/* ---------- AI 任务时间线（G-01）：落盘的历史，应用重启后还在 ---------- */}
      {/* 口径 docs/design-ai-board-v2.md §10.1：不要再有常驻列表，
          只留折叠一行（默认收起，点开才看明细；记录一直落盘） */}
      <div className="ai-section">
        <button
          type="button"
          className="mini-btn"
          style={{ opacity: 1 }}
          title="点开看明细（记录一直落盘，重启应用也还在）"
          onClick={() => setTimelineAll((v) => !v)}
        >
          {timelineAll ? "▾" : "▸"} 最近完成 {timeline.length} 项
        </button>
        <button
          type="button"
          className="mini-x"
          style={{ marginLeft: "auto", opacity: 1 }}
          title="刷新"
          onClick={() => void loadTimeline()}
        >
          ⟳
        </button>
        {timeline.length > 0 && (
          <button
            type="button"
            className="mini-x"
            style={{ opacity: 1 }}
            title="清空时间线（只删记录，不动会话和文件）"
            onClick={() => {
              void aiTimelineClear()
                .then(() => setTimeline([]))
                .catch(() => {});
              notify("已清空 AI 任务时间线");
            }}
          >
            ✕
          </button>
        )}
      </div>
      {!timelineAll ? null : timeline.length === 0 ? (
        <div className="hint" style={{ padding: "2px 12px 8px" }}>
          还没有记录。AI 跑完一轮会记在这里（重启应用也还在）。
        </div>
      ) : (
        // 不在这么小的框里让人上下拖：默认只露 3 条，下面给一个"展开全部"，
        // 展开后整块跟着面板滚（而不是在那个 260px 的小窗里拖）
        <>
        <div className={"ai-timeline" + (timelineAll ? " all" : "")}>
          {(timelineAll ? timeline.slice(0, 60) : timeline.slice(0, 3)).map((r) => {
            // 能不能"切过去"：找标题相同的已打开会话
            const target = sessions.find(
              (s) => (s.title ?? "").trim() === (r.sessionTitle ?? "").trim(),
            );
            return (
              <div className="ai-tl-row" key={r.id}>
                <div className="ai-tl-line">
                  <span className="grow ellipsis" title={r.sessionTitle}>
                    {new Date(r.completedAt * 1000).toLocaleString("zh-CN", {
                      month: "2-digit",
                      day: "2-digit",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                    {` · ${r.server}`}
                    {r.cwd ? ` · ${dirBase(r.cwd)}` : ""}
                  </span>
                  <span className="dim">
                    {r.durationMs > 0 ? aiDurationText(r.durationMs) : ""}
                  </span>
                </div>
                <div className="ai-tl-msg ellipsis" title={r.message}>
                  {r.message || "（这一轮没有留下文字）"}
                </div>
                <div className="ai-tl-actions">
                  {r.artifacts.slice(0, 3).map((n) => (
                    <span className="ai-tag" key={n}>
                      📄 {n}
                    </span>
                  ))}
                  {r.artifacts.length > 3 && (
                    <span className="dim">+{r.artifacts.length - 3}</span>
                  )}
                  {target ? (
                    <button
                      type="button"
                      className="mini-btn"
                      title={`切到「${target.title}」`}
                      onClick={() => {
                        setActiveId(target.id);
                        notify(`已切到「${target.title}」`);
                      }}
                    >
                      切过去
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
        </>
      )}

      {aiNotices.length > 0 && (
        <div className="ai-notices">
          <div className="ai-section">
            消息通知（{aiNotices.length}）
            <button
              type="button"
              className="mini-x"
              style={{ marginLeft: "auto", opacity: 1 }}
              title="清空"
              onClick={() => setAiNotices([])}
            >
              ✕
            </button>
          </div>
          {aiNotices.slice(0, 4).map((n) => (
            <div className="ai-notice" key={n.id}>
              <span className="dot ok" />
              <span className="grow ellipsis" title={n.text}>
                {n.text}
              </span>
            </div>
          ))}
        </div>
      )}

      {!activeSession?.profileId && (
        <div className="hint" style={{ padding: "10px 12px" }}>
          先打开一个 SSH 会话
        </div>
      )}

        </>
      )}
    </aside>

  );
}



