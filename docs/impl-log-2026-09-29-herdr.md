# 实施记录 · 2026-09-29：herdr 一键安装 + 免 TUI 观察窗 + 看板接入 herdr

> 用户口径：**先做按钮安装 → 再修花屏 → 再把之前定的方案落成代码 → 出便携版给我试**。
> 本轮**不动版本号（仍是 0.1.8）、不打 tag、不发 release**。

## 0. 这一轮解决的两个问题

1. **花屏**：以前"新建会话 → 用 herdr 代替 tmux"是直接跑 herdr 自己的 TUI。
   它退出时会把终端留在花屏状态（用户截图那次），而且它是带自己布局的 TUI，
   进了我们"一个标签页 = 一个视口"的地方就会跟别的客户端抢尺寸。
2. **没法一键装**：新服务器上没装 herdr 时只能看到"这台机器没装"，没有下一步动作；
   而官方 `install.sh` 在国内直连 GitHub 经常十几 KB/s，10 秒超时必失败
   （用户手动装失败就是这个原因，不是他的操作问题）。

## 1. 一键安装（Windows 侧下载 → 校验 → scp）

代码：`commands.rs::herdr_install`（命令壳）+ `herdr_install_inner`（实现体）、
`core/herdr.rs`（清单解析 / 平台判定 / 来源列表）。

流程与硬规矩：

| 步骤 | 做法 | 为什么 |
|---|---|---|
| 平台判定 | 远端 `uname -sm` → `linux-x86_64` / `linux-aarch64` | 只对 Linux 供货；其它平台直接拒绝，不做半吊子 |
| 已有就不动 | 远端 `~/.local/bin/herdr --version` + `api schema` 的协议号 | 覆盖别人的安装是"帮倒忙"；已有可用版本就报错让用户自己决定 |
| 版本清单 | 读 `https://herdr.dev/latest.json`（版本 / 协议 / 各平台直链 / 各平台 sha256） | 官方清单就是权威来源，不猜版本号 |
| 下载 | 官方直链 → 镜像1 → 镜像2；每个来源先直连再试系统代理 | 国内直连 GitHub 实测 ~50KB/s（26MB 要 9 分钟），镜像 2 秒 |
| 校验 | **不管从哪来，都按官方清单里的 sha256 校验**，不一致就删掉换下一个来源 | 来源可以换，字节不能换 |
| 上传 | `scp` 到 `/tmp/zeeai-herdr-<ts>`，再 `install -m 755` 到 `~/.local/bin/herdr`，删掉 `/tmp` 里的临时文件 | 不需要 root、不碰系统目录、不执行远端安装脚本 |
| 自检 | 装完读版本 + 协议号；不达标就 `rm` 掉刚装的文件（回滚） | "装上了"必须能被证实 |

缓存：下载好的文件按 `<版本>-<平台>` 落在 `%TEMP%\zeeai-herdr\`，下次同一版本直接用
（但**仍然重新校验 sha256**）。

入口有两处：AI 面板顶部的"状态来源"下面、以及「新建会话」对话框里（都是"没装"时才出现）。
进度（平台 → 清单 → 下载 MB → 上传 → 安装 → 完成）逐条进底部状态栏，不弹浮层。

## 2. 花屏的根治：不再跑她的 TUI，改成只读观察窗

**做法**：新增会话后端 `herdr-pane`。它不跑 `herdr --session x`，
而是跑 `herdr terminal session observe <pane> --cols C --rows R`，
把这条只读字节流直接喂给 xterm。

- herdr 的 observe 输出是**一行行 JSON**（`{"bytes":"<base64 的原始终端字节>"}`），
  在 Rust 侧解成原始字节再交给前端（`core/pty.rs::Filter::HerdrObserve`）；
- 分片边界必须处理：一次 socket 读可能切在 JSON 中间，所以有行缓冲
  （`push_observe_bytes`，单测覆盖"一条 JSON 被切成三片"的场景）；
- 观察者自己声明行列数，**不会**去改窗格尺寸、也不抢键盘；
- 窗口尺寸变了就把 observe 流按新尺寸**重开**（`herdr_pane_resize`）；
  重开前先把旧读取线程的 `close_flag` 置上，免得误报"会话已关闭"。

输入走另一条通道：每个观察窗配一条常驻 ssh 当"输入泵"，按行收
`T<base64 文本>`（→ `pane send-text`）和 `K<按键名>`（→ `pane send-keys`）。
前端把 xterm 的字节序列翻成逻辑按键（`Terminal.tsx::herdrActions`：
`\r`→enter、`\x7f`→backspace、`\x1b[A`→up、`\x03`→ctrl+c…）。
**不模拟任何前缀键，也不碰 `ctrl+b`。**

顺带：终端右键菜单加了「清屏并重画」（`term.reset()` + 清 WebGL 字形图集 + 整屏
`refresh`）—— 任何全屏 TUI 异常退出留下的花屏，右键一下就能救回来。

同时把「新建会话」里那个"用 herdr 代替 tmux"的勾去掉了（它跑的就是会花屏的 TUI），
换成一行状态说明：装了就在 AI 面板卡片上点「查看窗格」。

## 3. 看板接入 herdr（第一手状态）

- 新增 `herdr_agents` 命令：读 `herdr agent list` 的 JSON，解析成
  `{kind, status, cwd, paneId, title, attention}`；
- 前端在刷新看板时，**只对"探到有 herdr 的服务器"**多打一次这条命令，
  把 agent 映射成卡片（`source = "herdr"`）；
- 合并同一张卡时信号源排序：`app(3) > herdr(2) > tmux(1) > ps(0)` ——
  herdr 真在管这个 agent，它说 working/blocked 就听它的；
- `blocked` 单独成一档：卡片显示「等你处理」、红点 + 红底边，
  并且**触发一次提醒**（左侧红点计数 + 底部状态栏；闪任务栏仍按设置走）。
  同一张卡"进入 blocked"只提醒一次，离开后再进会重新提醒；
- 卡片上的「查看窗格」直接开观察窗。

## 4. 验证了什么（有据可查）

**代码层**

- `cargo test --lib`：**67 个单测全过**（新增 herdr 清单解析 / 平台判定 /
  agent 解析（含"没有 pane_id 的条目不能进看板"）/ 窗格号消毒 / 来源列表 /
  已装版本解析 / observe 行解码 / 分段粘包 等用例）。
- `npx tsc --noEmit`：前端类型检查通过。

**真机（用户的测试服务器）**——用 `ZEEAI_SELFTEST=1 ZEEAI_SELFTEST_HERDR=1` 跑自检：

```
SELFTEST: herdr_agents(Ali_root) -> 0 个
SELFTEST: herdr_agents(lz)       -> 1 个：codex@w2:p1=idle      ← 看板的 herdr 数据源
herdr_install: 官方最新版 herdr 0.9.1（协议 22，sha256 2a02fed16beb…）
herdr_install: 下载完成（本地缓存（校验一致），25.0 MB，sha256 已核对）
herdr_install: 安装完成：herdr 0.9.1（协议 22）
SELFTEST: herdr_install ok -> v0.9.1 协议 22 平台 linux-x86_64 … 26207464 字节
```

另一次运行（root 上已经装好时）：`herdr_install -> 这台机器上已经有 herdr 0.9.1
（协议 22），不覆盖` —— "不覆盖已有安装"那道闸也验证过。

**观察窗的远端命令**：把 `observe_command()` 生成的那条命令原样在 lz 上跑 3 秒，
拿到 10683 字节 JSON 帧；第一帧 base64 解码后是真实 ANSI
（`ESC[?2026h`、`ESC[?25l`、`ESC[1;1H` + box-drawing 字符）—— 也就是 herdr 自己画的界面。

**验证痕迹已清干净**：`/root/.local/bin/herdr` 删除（目录一并删掉）、`/tmp/zeeai-herdr-*`
与 `/tmp/zeeai-selftest*` 都不存在、没有在服务器上留下她的配置目录；lz 上原本跑着的
herdr server（pid 994800）与它的 codex 会话**全程没有被触碰**。

## 5. 没验证的（如实说明）

1. **观察窗的界面表现**：远端命令与解码链路都验证了，但"在我们窗口里看着对不对"
   （字体、宽高、打字延迟）需要你打开便携版亲自看——我没有 GUI 自动化手段点它。
   > 未完 - 5.2 观察窗打字走的 `pane send-text`/`pane send-keys` 在真实 codex TUI 里的
   > 表现（尤其长文本粘贴）只做了逻辑校验，没有对着跑的 codex 真敲过。
2. **Windows 侧首次下载**：本轮第一次安装时走的镜像（2 秒、sha256 一致），
   第二次命中了本地缓存；"官方直连很慢 → 自动退到镜像"这条**降级路径**没有单独跑一遍。
3. **非 Linux 服务器**：macOS / Windows 远端会被直接拒绝（只对 Linux 出货），
   拒绝文案没在真机上走过。
4. **密码登录的服务器**：观察窗输入会明确报"只能用 tmux/普通 shell 会话"，
   这条错误路径没在真机上走过（lz 用的是密钥）。
5. tmux 的"尺寸断言 / 把旁路客户端踢掉"仍**没做**（会影响你手机上的客户端，需要你先点头）。

## 6. 前端功能测试（无头、不弹窗口）

用户要求"不打扰我、但要把前端也测一遍"。所以加了一个**零依赖的无头功能测试**：
`scripts/fe-smoke.mjs`（`npm run fe:smoke`）。

做法：把真实构建产物 `dist/` 交给系统自带的 Edge（`--headless=new`，不显示窗口），
用 CDP 驱动（Node 24 自带 WebSocket，不引任何库），把 Tauri 的 `invoke` 换成一份可控的
假后端，然后**真的去点界面**，断言页面上渲染出来的文字/元素，并截图到
`%TEMP%\zeeai-fe-test\`。

它替我抓到 4 个问题（前三个直接改了代码）：

1. **我自己的死循环**：看板里"探到 herdr 后补刷一次"这段，读的是**闭包里的 state**，
   探针结果它看不见 → 反复探、反复排队重刷，界面直接刷成死循环。
   改成 `herdrAvailRef` / `probingHerdrRef`（state 给界面看、ref 给异步流程读），
   并且只有"这次真的拿到结果"才排队补刷。**没有这个测试，这个 bug 会直接进便携版。**
2. **没有 WebGL2 的机器上终端会半崩**：xterm 的 WebglAddon 激活到一半失败时，
   内部渲染器已被换掉、尺寸又没算出来，之后任何一次 refresh 都抛
   `Cannot read properties of undefined (reading 'dimensions')`（终端整块不动）。
   现在先自己探一次 `canvas.getContext("webgl2")`，有才挂 addon。
3. **历史列表没有校验**：侧栏渲染里有 `history.filter(...)`，只要某次拿到的是空值，
   **整个界面白屏**（不是局部出错，是 React 整棵树崩）。现在统一走 `applyHistory()`：
   不是数组就保留旧列表。这条是被假后端"少实现一个命令"逼出来的，属于便宜保险。
4. 观察窗标签名太笼统（"lz · codex"）—— 改成带上窗格号（"lz · codex w2:p1"），
   同一台机器开两个 codex 时分得清。

**最终结果：15/15 全过、零控制台报错**（对 `dist` 生产构建跑的）。其中端到端的几条：

| 断言 | 结果 |
|---|---|
| 界面正常渲染（不是白屏） | ✅ 285 字 |
| 打开 AI 面板 → 显示「状态来源：herdr 0.9.1（协议 22 · 已实测）」 | ✅ |
| herdr 卡片显示「等你处理」+「查看窗格」+ 来源「herdr 状态」 | ✅ |
| 装了 herdr 时不显示「一键安装」；切成没装后**出现**「一键安装 herdr」 | ✅ |
| 点「查看窗格」→ 后端收到 `backend=herdr-pane, pane=w2:p1` | ✅ |
| 观察窗建立了输入通道 + 标签栏出现「lz · codex w2:p1」 | ✅ |
| 在观察窗里敲 `hi` + 回车 → 走 `herdr_pane_type`/`herdr_pane_key`，**本地 PTY 写入 = 0** | ✅ |
| 新建会话里不再出现「用 herdr 代替 tmux」 | ✅ |

截图（无头浏览器产出，可复核）：
`01-default.png`（主界面）、`02-ai-panel.png`（看板 + herdr 卡片 + 红点）、
`03-herdr-missing.png`（没装时的安装入口）、`04-new-session.png`、`05-herdr-pane.png`。

## 7. 打包时差点发错包（记下来防再犯）

第一次出便携版时，我用的是 `cargo build --release` —— 它产出的是
`target/release/zeeai-terminal.exe`，而便携版脚本取的是 `target/release/ZeeAI_Term.exe`
（**Tauri 构建才会生成/更新的那个名字**）。结果就是把昨天的旧 exe 又打了一遍：
zip 的 sha256 和上一轮**一模一样**（`40d59077…`）才发现。

正确的做法（已按此重做）：

```powershell
npm run tauri build -- --no-bundle   # 会先 npm run build，再产出 ZeeAI_Term.exe
powershell -ExecutionPolicy Bypass -File scripts/build-portable.ps1 -Suffix -dev
```

核对方式（别只看"打包成功"）：

- `ZeeAI_Term.exe` 的时间戳必须**晚于** `dist/` 里那份 JS 的时间戳；
- 新 zip 的 sha256 必须和上一轮**不一样**；
- 抽查 `dist/assets/*.js` 里有没有这一版的新文案（例如「查看窗格」），
  以及有没有已经删掉的旧文案（例如「用 herdr 代替 tmux」）。

> 补充：release 版的 Tauri 会把前端资源**压缩**后嵌进 exe，所以直接对 exe 做
> `findstr 查看窗格` 是搜不到的（我试过）——要查就查 `dist/`，或者启动起来看界面。

本轮最终产物：

| 文件 | 大小 (B) | sha256 |
|---|---|---|
| `portable/ZeeAI_Term/ZeeAI_Term.exe` | 8,661,504 | `198ac991b2defa40ec44085470811713546b448bf9a04d668c599005a2c6c144` |
| `portable/ZeeAI_Term-0.1.8-dev-portable.zip` | 8,979,282 | `60ef85f6ea6c963dbde1dee40e630bdbad62467f099eed8b5ee083ef1cc764e5` |

（版本号仍是 **0.1.8**：本轮**没有**升版本、**没有**打 tag、**没有**发 release。）
