// 写死的默认值与本机常量：出厂设置、设置分类、tmux/herdr 动作表、主题列表。
//
// 为什么单独一个文件：这些常量被 App 与拆出去的设置面板/侧栏共用，
// 而它们只是数据（改一行不该牵动任何逻辑）。

import type { AppSettings } from "../types";

export const EMPTY_PROFILE = {
  name: "",
  host: "",
  /**
   * 端口 / 用户**默认留空**（"没说"）。
   *
   * 为什么不留 22 / root：这两个值一旦填上，后端就会拼出 `ssh -p 22 root@myalias` ——
   * 实测这会把 `~/.ssh/config` 里的 `Port` / `User` **顶掉**，于是"本机配了免密别名"
   * 的用户永远连不上（2026-10 用户报障）。留空时后端不传 `-p`、只给 `host`，
   * config 才生效（默认 22 / 当前用户名）。显式填了仍然是我们说了算。
   *
   * port 存**字符串**而不是数字：`<input type="number">` 清空时 `Number("")` 是 0，
   * 但界面上得能看见"空"，数字类型一存就变成 `NaN` 或被迫回填 22（两种都出过）。
   */
  port: "",
  user: "",
  group: "默认",
  keyPath: "",
};

/**
 * 「tmux 快捷操作」面板上的按钮。
 *
 * 刻意做成按钮而不是帮用户改 `Ctrl+B`：`Ctrl+B` 是 tmux 的默认前缀，
 * 动它会毁掉所有 tmux 用户的手感。这里是把**前缀 + 某个键**对应的 tmux 命令
 * 做成可点的按钮（`title` 里写着等价快捷键，顺便当教学）。
 */
/**
 * 服务器没填分组时用的分组名。
 *
 * 这个值只用来"归类"，界面上**不显示** —— 只有一台服务器都不填分组时，
 * 列表里出现一行莫名其妙的「默认」反而让人看不懂。多个分组同时存在时，
 * 它才以「未分组」的名义出现，用来区分其它自建分组。
 */
export const DEFAULT_SERVER_GROUP = "默认";

/** 设置对话框左侧的分类（点一下就跳到右边对应内容） */
export const SETTINGS_TABS: { key: string; label: string }[] = [
  { key: "look", label: "外观" },
  { key: "term", label: "终端与会话" },
  { key: "log", label: "会话日志" },
  // 应用级行为（启动恢复会话 / 关闭窗口时）—— 跟"终端怎么跑"是两件事，单独一页
  { key: "app", label: "应用" },
  { key: "notify", label: "通知" },
  { key: "update", label: "更新与关于" },
];

export const TMUX_ACTIONS: { key: string; label: string; title: string }[] = [
  { key: "new-window", label: "新建窗口", title: "等价于 Ctrl+B c" },
  { key: "split-h", label: "左右分屏", title: "等价于 Ctrl+B %" },
  { key: "split-v", label: "上下分屏", title: '等价于 Ctrl+B "' },
  { key: "prev-window", label: "上个窗口", title: "等价于 Ctrl+B p" },
  { key: "next-window", label: "下个窗口", title: "等价于 Ctrl+B n" },
  { key: "zoom", label: "放大/还原", title: "等价于 Ctrl+B z" },
  { key: "next-layout", label: "换布局", title: "等价于 Ctrl+B 空格" },
  { key: "pane-left", label: "窗格 ←", title: "等价于 Ctrl+B ←" },
  { key: "pane-up", label: "窗格 ↑", title: "等价于 Ctrl+B ↑" },
  { key: "pane-down", label: "窗格 ↓", title: "等价于 Ctrl+B ↓" },
  { key: "pane-right", label: "窗格 →", title: "等价于 Ctrl+B →" },
  { key: "copy-mode", label: "滚动查看", title: "等价于 Ctrl+B [（进入滚动/复制模式）" },
  { key: "copy-mode-exit", label: "退出滚动", title: "等价于 Ctrl+B q 或 Esc" },
  { key: "rename-window", label: "重命名窗口", title: "等价于 Ctrl+B ," },
  { key: "kill-pane", label: "关闭窗格", title: "等价于 Ctrl+B x" },
  { key: "kill-window", label: "关闭窗口", title: "等价于 Ctrl+B &" },
  { key: "detach", label: "脱离会话", title: "等价于 Ctrl+B d：断开但会话继续在服务器上跑" },
];

/**
 * 「herdr 快捷操作」面板上的按钮。
 *
 * 和上面 tmux 那份是同一个思路：**不模拟按键**，而是另开一条 ssh 去跑 herdr 自己的
 * socket API（白名单见后端 core/herdr.rs::action_command）。所以它不会碰任何快捷键，
 * 也不管窗格里此刻在跑什么。herdr 没有"上一个/下一个工作区"这种指令，就没有这两项；
 * 它的滚动是观察端自己做的（我们用 xterm 的滚动条），所以也没有复制模式那两项。
 */
export const HERDR_ACTIONS: { key: string; label: string; title: string }[] = [
  { key: "new-workspace", label: "新建工作区", title: "在服务器上新开一个工作区（窗格会留在服务器上，随时能回来）" },
  { key: "split-right", label: "右分屏", title: "把当前窗格左右分成两块" },
  { key: "split-down", label: "下分屏", title: "把当前窗格上下分成两块" },
  { key: "zoom", label: "放大/还原", title: "当前窗格占满（再点还原）" },
  { key: "pane-left", label: "窗格 ←", title: "把焦点移到左边那个窗格" },
  { key: "pane-up", label: "窗格 ↑", title: "把焦点移到上边那个窗格" },
  { key: "pane-down", label: "窗格 ↓", title: "把焦点移到下边那个窗格" },
  { key: "pane-right", label: "窗格 →", title: "把焦点移到右边那个窗格" },
  { key: "rename-pane", label: "重命名窗格", title: "给这个窗格起个名字（herdr 里显示的名字）" },
  { key: "close-pane", label: "关闭窗格", title: "关掉当前窗格（会问一次）" },
  { key: "close-workspace", label: "关闭工作区", title: "关掉整个工作区，连同里面的窗格（会问一次）" },
];

export const DEFAULT_SETTINGS: AppSettings = {
  fontSize: 13,
  defaultShell: "powershell",
  recordHistory: true,
  tmuxDefault: true,
  theme: "dark",
  closeAction: "exit",
  updateUrl: "https://api.github.com/repos/zeelinkCN/ZeeAI_Term/releases/latest",
  autoReconnect: true,
  fsFollowTerminal: true,
  restoreWorkspace: true,
  scrollback: 10000,
  autoLog: false,
  lastUpdateCheck: 0,
  ignoredUpdateVersion: "",
  termScheme: "vscode-dark",
  termSchemeCustom: "",
  logDir: "",
  highlightEnabled: true,
  // 预设规则由后端给（core::highlight::presets），前端这里只留空；
  // 设置读回来之后就有内容了，用户也可以自己改。
  highlightRules: [],
  // 规则集由后端给（core::highlight::presets 兜底），前端启动后就有内容
  highlightRuleSets: [],
  termSchemeByKind: {},
  highlightSetByKind: {},
  // 通知分层：默认只在活动栏 AI 图标点红点；闪任务栏 / 右下角提示由用户自己开
  aiNotifyTaskbar: false,
  aiNotifyBadge: true,
  // 红点只为两种情况亮（docs/design-ai-board-v2.md §10.6）：
  // ① 有人需要你 → 亮到你处理；② 跑完一轮并停下 → 点开就消。其它情况不提醒。
  aiNotifyNeedsYouBadge: true,
  aiNotifyFinishedBadge: true,
  // 「什么时候才提醒我」的默认口径（和后端 store.rs 保持一致）：
  // 小任务太多，跑完就弹会很吵 → 默认关；
  // 真正要人接手的两种（产出了 HTML/MD 文档、AI 在等你做选择题）默认开。
  aiNotifyComplete: false,
  aiNotifyDocs: true,
  aiNotifyNeedsYou: true,
  aiNotifyAllArtifacts: false,
  // AI 面板暂停中：后端两条被动监视线程（本机日志 / herdr 红点轮询）默认都不起。
  // 前端不由这个开关控制任何界面，只负责把它**原样带回去**（见 types.ts 的说明）。
  aiWatchEnabled: false,
  // 粘贴/拖进来的图片、文件在远端落到哪个目录；`.` = 跟随终端当前目录
  pasteDir: "~/.zeeai/paste",
  // 终端的三个习惯项（和后端 store.rs 的默认值保持一致）：
  // 两个键都能粘、右键弹菜单、Ctrl+Shift+C 复制 —— 跟大多数人预期一致
  pasteKey: "both",
  rightClick: "menu",
  copyKey: "ctrl-shift-c",
  // 直接粘进终端（不经过输入窗）时是否给一眼缩略图。
  // **默认关**：用户明确要求"图片上传/粘贴不要在右下角弹消息"——要确认粘对了没有，
  // 看输入行里那串路径就够了（想开的人可以在设置里打开）。
  pasteToast: false,
};

export const APP_VERSION = "0.1.14";
/** 本机进程表扫描的最小间隔：这个探针要起 PowerShell 枚举进程，比远端探针贵得多 */
export const LOCAL_SCAN_MIN_INTERVAL_MS = 60_000;

/** 比较 a、b 两个版本号：a 新返回 1，相同返回 0，a 旧返回 -1（忽略 v 前缀与预发布后缀） */
export function compareVersion(a: string, b: string): number {
  const nums = (v: string) =>
    v
      .trim()
      .replace(/^v/i, "")
      .split(/[.+\-]/)
      .map((x) => parseInt(x, 10))
      .filter((n) => Number.isFinite(n));
  const A = nums(a);
  const B = nums(b);
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const x = A[i] ?? 0;
    const y = B[i] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/** 各种分屏布局对应几个窗格 */
export function paneCount(layout: "single" | "v2" | "h2" | "v3" | "grid4"): number {
  switch (layout) {
    case "v2":
    case "h2":
      return 2;
    case "v3":
      return 3;
    case "grid4":
      return 4;
    default:
      return 1;
  }
}

export const THEMES: { key: string; label: string; kind: "dark" | "light" }[] = [
  { key: "dark", label: "VS Code 深色", kind: "dark" },
  { key: "one", label: "One Dark Pro", kind: "dark" },
  { key: "tokyo", label: "Tokyo Night", kind: "dark" },
  { key: "nord", label: "Nord 蓝灰", kind: "dark" },
  { key: "dracula", label: "Dracula", kind: "dark" },
  { key: "monokai", label: "Monokai", kind: "dark" },
  { key: "wechat", label: "微信绿", kind: "dark" },
  { key: "teams", label: "Teams 紫", kind: "dark" },
  { key: "teal", label: "青瓷（暗）", kind: "dark" },
  { key: "light", label: "VS Code 浅色", kind: "light" },
  { key: "github", label: "GitHub 浅色", kind: "light" },
  { key: "paper", label: "纸白（护眼）", kind: "light" },
  { key: "sakura", label: "樱花粉", kind: "light" },
  { key: "mint", label: "薄荷绿", kind: "light" },
];

export function themeKind(key: string): "dark" | "light" {
  return THEMES.find((t) => t.key === key)?.kind ?? "dark";
}

export const SHELL_LABEL: Record<AppSettings["defaultShell"], string> = {
  powershell: "PowerShell",
  cmd: "CMD",
  wsl: "WSL",
};




