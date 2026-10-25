// 设置面板里每个分类的正文。
//
// 为什么按分类拆成小组件：每一类都是一串独立的开关（改一个不影响另一个），
// 塞进同一个函数只会让"改字体大小"和"改红点规则"互相挡路。
// 正文是**原样搬过来的 JSX**（className / 文案 / DOM 顺序都没动），
// 只把 updateSettings / notify 这些回调改成从 props 拿。

import { THEMES } from "../lib/app-consts";
import type { AppSettings } from "../types";

export interface SettingsLookFontTabProps {
  settings: AppSettings;
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>;

  /** 字号"立刻生效"的入口（不是普通设置项） */
  applyFontSize: (px: number) => void;
}

export function SettingsLookFontTab(props: SettingsLookFontTabProps) {
  const {
  settings, updateSettings, applyFontSize,
  } = props;
  return (
      <>
    <label className="modal-field">
      终端字体大小：{settings.fontSize}px（也可直接 Ctrl + 滚轮 或 Ctrl + ＋ / －）
      <input
        type="range"
        min={8}
        max={26}
        value={settings.fontSize}
        onChange={(e) => applyFontSize(Number(e.target.value))}
      />
    </label>

    <label className="modal-field">
      终端回滚行数：{settings.scrollback.toLocaleString()} 行
      <input
        type="range"
        min={1000}
        max={200000}
        step={1000}
        value={settings.scrollback}
        onChange={(e) => void updateSettings({ scrollback: Number(e.target.value) })}
      />
    </label>
    <div className="modal-inline-action" style={{ paddingBottom: 10 }}>
      {[2000, 10000, 50000, 200000].map((n) => (
        <button
          key={n}
          type="button"
          className="mini-btn"
          style={{ marginRight: 6 }}
          onClick={() => void updateSettings({ scrollback: n })}
        >
          {n >= 1000 ? `${n / 1000}k` : n}
        </button>
      ))}
      <span className="hint">
        往上能翻多少行历史。超出后最老的行会被丢掉（不会崩，只是看不到更早的）；
        要长期留存就开终端日志。
      </span>
    </div>
      </>

  );
}

export interface SettingsLogTabProps {
  settings: AppSettings;
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>;

  pickLogDir: () => Promise<void>;
  openLogDir: () => Promise<void>;
  /** 底部状态栏那条提示（"已恢复默认位置"） */
  notify: (text: string) => void;
}

export function SettingsLogTab(props: SettingsLogTabProps) {
  const {
  settings, updateSettings, pickLogDir, openLogDir, notify,
  } = props;
  return (
      <>
    <label className="form-check">
      <input
        type="checkbox"
        checked={settings.autoLog}
        onChange={(e) => void updateSettings({ autoLog: e.target.checked })}
      />
      <span>
        新建会话时自动记录终端日志（标签上会出现红点，右键标签可以停止或打开日志）
      </span>
    </label>

    <label className="modal-field">
      会话日志目录（留空 = 默认 %APPDATA%\ZeeAI-Terminal\logs\sessions）
      <input
        value={settings.logDir}
        placeholder="例如 D:\zeeai-logs"
        onChange={(e) => void updateSettings({ logDir: e.target.value })}
      />
    </label>
    <div className="modal-inline-action">
      <button type="button" className="mini-btn" onClick={() => void pickLogDir()}>
        选择目录…
      </button>
      <button type="button" className="mini-btn" onClick={() => void openLogDir()}>
        打开目录
      </button>
      {settings.logDir.trim() !== "" && (
        <button
          type="button"
          className="mini-btn"
          onClick={() => {
            void updateSettings({ logDir: "" });
            notify("日志目录已恢复为默认位置");
          }}
        >
          恢复默认
        </button>
      )}
    </div>
      </>

  );
}

export interface SettingsTermShellTabProps {
  settings: AppSettings;
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>;
}

export function SettingsTermShellTab(props: SettingsTermShellTabProps) {
  const {
  settings, updateSettings,
  } = props;
  return (
      <>
    <label className="modal-field">
      默认终端
      <select
        value={settings.defaultShell}
        onChange={(e) =>
          void updateSettings({
            defaultShell: e.target.value as AppSettings["defaultShell"],
          })
        }
      >
        <option value="powershell">PowerShell</option>
        <option value="cmd">CMD</option>
        <option value="wsl">WSL</option>
      </select>
    </label>

      </>

  );
}

export interface SettingsLookThemeTabProps {
  settings: AppSettings;
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>;

  setShowTermTheme: (open: boolean) => void;
  currentTermSchemeName: () => string;
}

export function SettingsLookThemeTab(props: SettingsLookThemeTabProps) {
  const {
  settings, updateSettings, setShowTermTheme, currentTermSchemeName,
  } = props;
  return (
      <>
    <label className="modal-field">
      主题配色
      <select
        value={settings.theme}
        onChange={(e) => void updateSettings({ theme: e.target.value })}
      >
        {THEMES.map((t) => (
          <option key={t.key} value={t.key}>
            {t.label}
          </option>
        ))}
      </select>
    </label>

    <div className="modal-inline-action">
      <button type="button" className="btn" onClick={() => setShowTermTheme(true)}>
        终端配色与关键字高亮…
      </button>
      <span className="hint" style={{ padding: "0 0 0 8px" }}>
        当前配色：{currentTermSchemeName()}（可在里面按"终端类型"分别设置）
      </span>
    </div>
      </>

  );
}

export interface SettingsAppTabProps {
  settings: AppSettings;
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>;
}

export function SettingsAppTab(props: SettingsAppTabProps) {
  const {
  settings, updateSettings,
  } = props;
  return (
      <>
    <label className="form-check">
      <input
        type="checkbox"
        checked={settings.restoreWorkspace}
        onChange={(e) => void updateSettings({ restoreWorkspace: e.target.checked })}
      />
      <span>启动时恢复上次的会话（SSH / 本地终端 / 串口；只记"怎么开回来"，不存文件内容）</span>
    </label>

    <label className="modal-field">
      关闭窗口时
      <select
        value={settings.closeAction}
        onChange={(e) =>
          void updateSettings({
            closeAction: e.target.value as AppSettings["closeAction"],
          })
        }
      >
        <option value="exit">退出应用</option>
        <option value="tray">收进系统托盘（后台继续运行）</option>
      </select>
    </label>

    <div className="hint" style={{ padding: "2px 14px 8px" }}>
      这两条是应用级行为，跟"终端怎么跑"无关。
    </div>
      </>

  );
}

export interface SettingsNotifyTabProps {
  settings: AppSettings;
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>;
}

export function SettingsNotifyTab(props: SettingsNotifyTabProps) {
  const {
  settings, updateSettings,
  } = props;
  return (
      <>
    <div className="tree-group">什么时候提醒我</div>
    <div className="hint" style={{ padding: "0 14px 6px" }}>
      AI 跑的小任务很多，默认不为"跑完了"打扰你，只报下面这两类要你动手的事。
    </div>
    <label className="form-check">
      <input
        type="checkbox"
        checked={settings.aiNotifyDocs}
        onChange={(e) => void updateSettings({ aiNotifyDocs: e.target.checked })}
      />
      <span>产出了文档（HTML / Markdown）就告诉我 —— 推荐</span>
    </label>
    <label className="form-check">
      <input
        type="checkbox"
        checked={settings.aiNotifyNeedsYou}
        onChange={(e) => void updateSettings({ aiNotifyNeedsYou: e.target.checked })}
      />
      <span>AI 等我做选择题（要批准 / 等回话）就告诉我 —— 推荐</span>
    </label>
    <label className="form-check">
      <input
        type="checkbox"
        checked={settings.aiNotifyComplete}
        onChange={(e) => void updateSettings({ aiNotifyComplete: e.target.checked })}
      />
      <span>每一轮跑完都告诉我（小任务多的话会很吵，默认关）</span>
    </label>
    <label className="form-check">
      <input
        type="checkbox"
        checked={settings.aiNotifyAllArtifacts}
        onChange={(e) =>
          void updateSettings({ aiNotifyAllArtifacts: e.target.checked })
        }
      />
      <span>所有新文件都算"产物"（关 = 只算 HTML / Markdown，默认）</span>
    </label>
    <div className="tree-group" style={{ marginTop: 8 }}>
      用哪种方式提醒
    </div>
    <label className="form-check">
      <input
        type="checkbox"
        checked={settings.aiNotifyTaskbar}
        onChange={(e) => void updateSettings({ aiNotifyTaskbar: e.target.checked })}
      />
      <span>
        窗口不在前台时闪 Windows 任务栏
      </span>
    </label>
    {/* 红点只为两种情况亮（docs/design-ai-board-v2.md §10.6）。
        以前这里是一条"跑完了就点红点"的总开关 —— 那样每次轮询都可能让它冒出来，
        用户的原话是"红点别吵"，所以拆成下面两条独立规则。 */}
    <label className="form-check">
      <input
        type="checkbox"
        checked={settings.aiNotifyNeedsYouBadge}
        onChange={(e) =>
          void updateSettings({ aiNotifyNeedsYouBadge: e.target.checked })
        }
      />
      <span>需要你处理时提醒（红点亮到你处理为止）</span>
    </label>
    <label className="form-check">
      <input
        type="checkbox"
        checked={settings.aiNotifyFinishedBadge}
        onChange={(e) =>
          void updateSettings({ aiNotifyFinishedBadge: e.target.checked })
        }
      />
      <span>跑完一轮并停下时提醒（点开面板就消，当未读）</span>
    </label>
    <div className="hint" style={{ padding: "2px 14px 8px" }}>
      红点规则：<b>需要你 → 亮到你处理；跑完停下 → 点开就消</b>。
      <br />
      其它情况不提醒：运行中、空闲、超过 10 分钟没动静、只产出文件但还在跑、探测不到
      —— 一个都不点红点。
    </div>
    <div className="hint" style={{ padding: "2px 14px 8px" }}>
      提醒只进底部状态栏（不会在窗口中间弹浮层）；点状态栏那条可以直接切过去。
    </div>
      </>

  );
}

export interface SettingsTermHabitTabProps {
  settings: AppSettings;
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>;
}

export function SettingsTermHabitTab(props: SettingsTermHabitTabProps) {
  const {
  settings, updateSettings,
  } = props;
  return (
      <>
    <label className="form-check">
      <input
        type="checkbox"
        checked={settings.tmuxDefault}
        onChange={(e) => void updateSettings({ tmuxDefault: e.target.checked })}
      />
      <span>新建连接时默认启用 tmux</span>
    </label>

    <label className="form-check">
      <input
        type="checkbox"
        checked={settings.recordHistory}
        onChange={(e) => void updateSettings({ recordHistory: e.target.checked })}
      />
      <span>记录会话历史</span>
    </label>

    <label className="form-check">
      <input
        type="checkbox"
        checked={settings.autoReconnect}
        onChange={(e) => void updateSettings({ autoReconnect: e.target.checked })}
      />
      <span>SSH 断开后自动重连（会重新附加 tmux，最多重试 5 次）</span>
    </label>

    {/* ---------- 发给 AI：图片与文件 ----------
        这 5 项是一件事的五个开关（落地目录 / 粘贴键 / 右键 / 复制 / 直粘走哪条路），
        所以收在一个分组里；正文只回答"这条是干什么的"，"为什么这么设计"一律进 title。
        提示一律纯文本 —— 这个界面不渲染 markdown，别写 ** 或反引号。 */}
    <div className="tree-group" style={{ marginTop: 4 }}>
      发给 AI（图片与文件）
    </div>

    <label
      className="modal-field"
      title="粘贴 / 拖进来的图片与文件会先传到服务器上，再把「远端路径」交给 AI —— CLI agent 只认路径，它自己会去读这个文件。"
    >
      图片 / 文件传到远端哪个目录
      <input
        type="text"
        value={settings.pasteDir}
        placeholder="~/.zeeai/paste"
        onChange={(e) => void updateSettings({ pasteDir: e.target.value })}
      />
      <span className="hint">默认 ~/.zeeai/paste；填 . = 跟随终端当前目录</span>
    </label>

    {/* 终端的三个"习惯项"：老终端用户各有各的肌肉记忆，做成可配比替他决定强 */}
    <label
      className="modal-field"
      title="没被选中的那个键会原样交给终端里的程序：Ctrl+V 变成 ^V（readline 的 quoted-insert、vim 的块选择），Shift+Insert 变成 Insert 键。选中的那个键走浏览器原生粘贴，图片也能直接粘。"
    >
      粘贴用哪个键
      <select
        value={settings.pasteKey}
        onChange={(e) => void updateSettings({ pasteKey: e.target.value })}
      >
        <option value="both">Ctrl+V 和 Shift+Insert 都能粘（默认）</option>
        <option value="ctrl-v">只用 Ctrl+V（Shift+Insert 送给远端）</option>
        <option value="shift-insert">只用 Shift+Insert（Ctrl+V 送 ^V 给远端）</option>
      </select>
      <span className="hint">默认两个键都能粘；没被选中的那个原样送给远端</span>
    </label>

    <label
      className="modal-field"
      title="选「直接粘贴」时 Shift+右键仍然弹菜单（想用菜单时不用改设置）；万一系统拒绝读剪贴板，会自动退回菜单并给一句提示。图片请用 Ctrl+V / Shift+Insert。"
    >
      终端里点右键
      <select
        value={settings.rightClick}
        onChange={(e) => void updateSettings({ rightClick: e.target.value })}
      >
        <option value="menu">弹菜单（默认）</option>
        <option value="paste">直接粘贴剪贴板文本</option>
      </select>
      <span className="hint">默认弹菜单；Shift+右键始终弹菜单</span>
    </label>

    <label
      className="modal-field"
      title="三种口径下 Ctrl+Shift+C 都是复制。「选中即复制」跟 X11 一个脾气：鼠标一划就走剪贴板（选中就写，不用按键）。"
    >
      怎么复制
      <select
        value={settings.copyKey}
        onChange={(e) => void updateSettings({ copyKey: e.target.value })}
      >
        <option value="ctrl-shift-c">Ctrl+Shift+C（默认；Ctrl+C 始终是中断）</option>
        <option value="ctrl-c-smart">Ctrl+C：有选中就复制，没选中才是中断</option>
        <option value="select">选中即复制（不用按键）</option>
      </select>
      <span className="hint">默认 Ctrl+Shift+C；选中即复制 = 划一下就走剪贴板</span>
    </label>

    <label
      className="form-check"
      title="不勾（默认）：图片先进输入窗，能确认粘对了没有、还能补一句话再发。勾上：快路径 —— 立刻把远端路径插进终端输入行，并弹几秒缩略图。纯文本粘贴两种情况下都按光标所在位置走。"
    >
      <input
        type="checkbox"
        checked={settings.pasteToast}
        onChange={(e) => void updateSettings({ pasteToast: e.target.checked })}
      />
      <span>在终端里直接粘图片：放进输入窗（勾上 = 直接插路径）</span>
    </label>

      </>

  );
}

export interface SettingsUpdateTabProps {
  /** 更新那一段由 App 渲染（版本检查的 state 都在它那儿） */
  renderUpdateSection: () => JSX.Element;
}

export function SettingsUpdateTab(props: SettingsUpdateTabProps) {
  const {
  renderUpdateSection,
  } = props;
  return (
    <>
      {renderUpdateSection()}
      <div className="hint">
        设置立即生效，保存在 %APPDATA%\ZeeAI-Terminal\settings.json。
      </div>
    </>

  );
}
