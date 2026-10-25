// 界面层的数据形状：会话 / 打开的文件 / 工作区快照 / 诊断视图 / "自动事件"。
//
// 为什么单独一个文件：这些类型被 App 和拆出去的组件共用。组件只认形状、不认 App ——
// 让组件反过来 import App 会成环（App import 组件、组件 import App），
// 一组循环依赖在打包后就是"某个模块初始化时拿到 undefined"。

import type { AiAgentKind, AiCarrier, AiState, ConnectionProfile, HerdrPane, HerdrServerStatus, HerdrWorkspaceScan, HistoryEntry, SessionState, SshDiagnosis } from "../types";

export type ModuleKey = "remote" | "powershell" | "cmd" | "wsl" | "git" | "serial" | "adb";
export type FileKind = "md" | "html" | "img" | "code" | "text";
export type MdStyle = "github" | "minimal" | "dark" | "paper";

export interface OpenFile {
  name: string;
  path: string;
  kind: FileKind;
  b64: string;
}

export interface OpenSession {
  id: string;
  title: string;
  kind: ModuleKey;
  profileId?: string;
  /** 这个会话临时选的高亮规则集（空 = 跟着服务器绑定走） */
  highlightSetId?: string | null;
  /** 该会话实际登录的用户名（可能来自新建会话时的临时覆盖） */
  user?: string;
  tmuxName?: string;
  tmuxMode?: "default" | "none" | "name";
  /**
   * herdr 观察窗：这个标签页看的是哪个窗格（形如 w1:p1）。
   * 有它就说明这是"只看不跑 TUI"的观察窗（见 core/herdr.rs 顶部说明）。
   */
  herdrPane?: string;
  /** herdr 窗格的打开方式：observe = 只读观察；control = 可读可写（进她的环境里干活） */
  herdrMode?: "observe" | "control";
  /** 终端当前工作目录（OSC 7 或 tmux 上报） */
  cwd?: string;
  /** 正在记录终端日志时的文件路径（没记录就是 undefined） */
  logPath?: string;
  state: SessionState;
  openFiles: OpenFile[];
  activeTab: string; // "terminal" 或文件名
}

/** 「发给 AI」输入窗里的一个附件（图片 / 文件）：发送时只把远端路径拼进正文 */
export interface ComposerFile {
  name: string;
  local: string;
  remote: string;
  thumb?: string;
  size?: number;
}

/** 一个会话自己的输入窗草稿（正文 + 附件）—— 切标签时按会话保存 / 恢复，互不串 */
export interface ComposerDraft {
  text: string;
  files: ComposerFile[];
}

export interface SavedSession {
  kind: ModuleKey;
  title: string;
  profileId?: string;
  user?: string;
  tmuxName?: string;
  tmuxMode?: "default" | "none" | "name";
  /**
   * herdr 窗格会话：恢复时必须带上这两项，否则重启后会被当成 tmux/普通 shell 打开
   * （实测踩过：恢复了才发现"根本不在 herdr 里面"，服务器上还多出一个假 tmux 会话）。
   */
  herdrPane?: string;
  herdrMode?: "observe" | "control";
  cwd?: string;
}

export interface SavedWorkspace {
  version: number;
  savedAt: number;
  activeIndex: number;
  sessions: SavedSession[];
}

export interface MenuItem {
  sep: boolean;
  label?: string;
  action?: () => void;
}


/** 一次连接诊断在界面上的状态（「编辑服务器」按钮 / 连接失败提示 两个入口共用） */
export interface SshDiagView {
  profileId: string;
  /** 服务器名：弹窗标题带上，免得连错机器 */
  name: string;
  /** 发起诊断时的那份配置（编辑框里**没保存**的改动也算 —— 密码模式提示才准） */
  profile?: ConnectionProfile;
  /** 从「连接失败」进来的那次：把刚才那条错误带进弹窗，别让用户再回忆一遍 */
  failure?: string;
  loading: boolean;
  data?: SshDiagnosis;
  error?: string;
}

/** GitHub Release 里的一个附件（检查更新时用来挑安装包） */
export interface Asset {
  name?: string;
  size?: number;
  browser_download_url?: string;
  /** GitHub 会给的 sha256（形如 "sha256:...."），用来校验下载到的包 */
  digest?: string;
}

/**
 * 一条"自动事件"归一之后的样子（本机日志信号 / herdr 卡片快照都先转成它）。
 *
 * 为什么先归一：两路事件字段形状不一样（日志给 cwd/turn，herdr 给 server/pane），
 * 但"更新哪张卡、改成什么状态"这件事**只能有一套实现** —— 否则迟早出现
 * "日志那条会把 herdr 的卡改坏"这种互相打架。
 */
export interface AutoCardEvent {
  /** 来源：日志 = 只读本机 rollout；herdr = 轮询 `herdr agent list` */
  source: "log" | "herdr";
  /** 实例标识（跨轮不变）：日志 `local|codex|<cwd>`；herdr `herdr|<服务器>|<窗格>` */
  key: string;
  carrier: AiCarrier;
  agent: AiAgentKind;
  /** `where` 的第一段：`本机` / 服务器显示名 */
  env: string;
  cwd: string;
  state: AiState;
  activity: string;
  atMs: number;
  /** herdr 专用：窗格号 / 服务器配置 id / 原始状态词 */
  pane?: string;
  profileId?: string;
  status?: string;
  attention?: boolean;
  /** 本机 codex 日志带会话 id（点卡片能切过去） */
  sessionId?: string | null;
}




// ---------- 对话框 state 的形状 ----------
//
// 为什么放这里：这些对象既是 App 的 state，又是拆出去的对话框组件的 props。
// 各写一份的话，两边一旦不同步就是"运行时才发现少了字段"；放一处只写一遍。

/** 侧栏"串口"那一行的右键菜单（对着哪个连接、在屏幕哪一点弹） */
export interface SerialMenuState {
  profile: ConnectionProfile;
  x: number;
  y: number;
}

/** 「串口连接」编辑对话框：isNew = 新建（保存时是"加一条"而不是"改这条"） */
export interface SerialDialogState {
  isNew: boolean;
  draft: ConnectionProfile;
}

/** 远程文件面板里某个文件/目录的右键菜单 */
export interface FsMenuState {
  profileId: string;
  name: string;
  isDir: boolean;
  x: number;
  y: number;
}

/** 新建目录 / 重命名 共用的输入框 */
export interface NameDialogState {
  mode: "mkdir" | "rename";
  profileId: string;
  dir: string;
  from: string;
  value: string;
}

/** 通用确认框（会真的关掉/删掉东西的动作走它） */
export interface ConfirmDialogState {
  title: string;
  message: string;
  okLabel?: string;
  onOk: () => void;
}

/** 会话标签的右键菜单（位置是屏幕坐标） */
export interface TabMenuState {
  id: string;
  x: number;
  y: number;
}

/** 标签改名（自绘输入框，不用浏览器 prompt） */
export interface SessionRenameState {
  id: string;
  value: string;
}

/** 侧栏服务器行的右键菜单 */
export interface CtxMenuState {
  profile: ConnectionProfile;
  x: number;
  y: number;
  /**
   * 这条菜单是**对着某一条会话记录**（侧栏服务器下面那一行）打开的时候带上它。
   *
   * 为什么要区分：服务器那一栏的菜单是"管理这台机器"，而 herdr 的窗格是**会攒的**
   * （每开一次新会话就多一个），用户需要能"就在这一行上"把它回收掉，而不是先记住
   * 窗格号再跑去别的地方找。
   */
  herdrRow?: HistoryEntry;
}

/** 「编辑服务器」对话框的草稿（改在草稿上，点保存才落盘） */
export interface EditDialogState {
  draft: ConnectionProfile;
  isNew: boolean;
}

/** 「新建会话」的表单 */
export interface NewSessionDialogState {
  profileId: string;
  useTmux: boolean;
  tmuxKind: "new" | "attach";
  tmuxName: string;
  attachTarget: string;
  /** 用 herdr 打开这次会话（默认值跟着服务器配置走，勾上就直接进她的环境） */
  useHerdr: boolean;
  /** herdr：新开一个窗格，还是接管已有的 */
  herdrKind: "new" | "attach";
  /** herdr：要接管的窗格号（形如 w1:p1） */
  herdrTarget: string;
  user: string;
  rememberUser: boolean;
  /** 会话名字（留空 = 自动命名；普通 shell 会自动编号） */
  title?: string;
  /** 这次会话临时选的高亮规则集（空 = 跟随服务器绑定） */
  highlightSetId?: string | null;
}

/**
 * 底部状态栏那条提示的签名。
 *
 * 组件只负责"发一句话"，但类型必须和 App 里那个 notify 一致 ——
 * 少个可选参数不会报错，等到某天想传诊断信息时才会在运行时发现。
 */
export type Notify = (
  text: string,
  opts?: { diagProfileId?: string; diagFailure?: string },
) => number;

/** 底部状态栏那条提示（notify 写它） */
export interface StatusMsg {
  /** 状态栏上显示的那一行（只看中文短句） */
  text: string;
  /** 悬停时看的完整原文（含 `｜原始信息：<英文>`；没有额外原文时等于 text） */
  detail: string;
  at: number;
  /** 这条提示的序号（`notify` 每发一条 +1）：异步补文案时认它，别认毫秒时间戳 */
  seq: number;
  kind: "info" | "warn" | "error";
  /**
   * 这条提示来自哪台服务器的连接失败。给了就在状态栏上多一个
   * 「为什么会失败？诊断一下」—— 点开只读诊断，不会再去连服务器。
   */
  diagProfileId?: string;
  /** 那次失败的短句（带进诊断弹窗顶部，省得用户回忆刚才报了什么） */
  diagFailure?: string;
  /** 连接失败时算出来的「密码模式」提示：完整一句话，悬停和诊断弹窗里都能看到 */
  hint?: string;
}

/** 右下角传输列表里的一行（后端 zeeai://transfer 事件累积出来的） */
export interface TransferItem {
  id: string;
  name: string;
  done: number;
  total: number;
  status: "running" | "done" | "failed";
  message?: string;
}

/** 粘贴/拖入文件后那张几秒就消失的小卡片 */
export interface PasteCard {
  thumb?: string;
  name: string;
  remote: string;
}

/** 「管理 herdr 工作区」面板一次刷出来的三样东西 */
export interface HerdrMgrState {
  scan: HerdrWorkspaceScan;
  panes: HerdrPane[];
  server: HerdrServerStatus;
}

/** 管理面板里的一行：一个 herdr 工作区 */
export interface HerdrMgrRow {
  ws: string;
  pane: string;
  label: string;
  inUse: boolean;
  idle: boolean;
  summary: string;
  detail: string;
}

