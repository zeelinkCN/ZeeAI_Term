# Bug 专篇：tmux 里往上翻，历史忽然变成一条窄柱 / 内容被覆盖

> 你给的现场：截图 `codex-clipboard-9541b30f-...png`，标签 `lz·codexAAA`。
> 现象：在 tmux 里跑着 codex，往上翻看历史，上方那段文字被压成大约十几列的窄柱、
> 里面还夹着一块绿色高亮的 `[codexAAA] 0:codextext*`。
>
> 本轮**只读**：没有改代码、没有 attach 你的会话、没有在服务器上写任何东西。

---

## 1. 结论先说

**这不是编码问题（不是乱码），是一次"窗口尺寸被压小"留下的永久伤疤。**

机制是这样的：

1. tmux 的窗口尺寸由**当前挂着的客户端**决定。你这台服务器是 **tmux 2.7**，
   它**没有 `window-size` 选项**（那是 tmux 2.9 才加的）——在 2.7 时代，
   多方 attach 时窗口取**最小的那个客户端的尺寸**。
2. 当窗口被压小（多了一个小尺寸客户端，或本应用在某次布局变化里把很小的 cols 发给了 tmux），
   tmux 会收到 resize，**codex 这个全屏 TUI 收到 SIGWINCH 后把整屏按新宽度重画**。
3. 重画出来的那些行，是按"当时那个窄宽度"**硬换行**写进 tmux 历史的。
4. 等尺寸恢复，tmux 没法区分"这个换行是我 tmux 自己加的"还是"程序自己写的"——
   全屏 TUI 是**用绝对定位画的**，每一行都被当成"程序自己写完的一行"。
   所以那一段**再也拼不回去**，看起来就是"上面变窄了"。

截图里那块绿色的 `[codexAAA] 0:codextext*` 是 tmux 自己的**状态栏碎片**，
它本该画在屏幕最底下。它能跑到滚动历史中间，本身就是"这里发生过重画 / resize"的指纹。

---

## 2. 我在你服务器上做的只读核对

只跑了一条 `ssh ... "tmux -V; tmux list-clients; tmux ls; tmux show-options -g window-size; tmux list-panes -a"`，
**没有 attach、没有发任何输入、没有改任何配置**：

```
tmux 2.7
--- CLIENTS ---
/dev/pts/0|84x66|1790445572
--- SESSIONS ---
47-99-241-168-lz|1|0|120x36
codexAAA|1|1|84x65
--- OPT ---
unknown option: window-size
--- PANES ---
47-99-241-168-lz:0.0|120x36|bash
codexAAA:0.0|84x65|node
```

怎么读这几行：

| 看到的东西 | 含义 |
|---|---|
| `tmux 2.7` | **关键**：没有 `window-size`，多客户端时按最小尺寸 |
| `CLIENTS` 只有 `/dev/pts/0 | 84x66` | **此刻**只有 1 个客户端，而且尺寸和 `codexAAA` 的窗口一致 → 现在没在冲突 |
| `codexAAA` `attached=1`，窗口 `84x65` | 现在一切正常：84 列 + 1 行状态栏 = 客户端的 66 行 |
| `47-99-241-168-lz` `attached=0`，窗口 `120x36` | 这个会话没人挂，但窗口尺寸被**留在了 120x36**（tmux 会记住最后一个尺寸） |

也就是说：**伤是过去留下的，现在这一刻已经恢复。** 这正是这类问题的典型形态——
只有历史被永久破坏，当前屏幕看着是好的。

> 补充：那条 `120x36` 也值得注意 —— 本应用创建 PTY 时的默认值是 110x30，而它是 120x36，
> 说明这个会话曾经被某个尺寸为 120x36 的客户端挂过。尺寸在会话之间是各自记住的。

---

## 3. 本应用代码里能造成"窗口被压小"的路径

### 3.1 tmux 的 attach 方式允许多客户端（根因）

`src-tauri/src/core/ssh.rs:146`：

```rust
let mut tmux = format!("tmux new-session -A -s '{}'", session_name.replace('\'', ""));
```

`-A` 的含义是"会话存在就 attach，不存在就新建"，**但它不带 `-d`**。
`-d` 才是"把别的客户端踢掉"。所以同一个会话被 attach 两次 → **两个客户端同时挂着** →
在 tmux 2.7 上窗口取**较小**的那个 → 另一个（大）客户端那边就会看到被压窄的画面。

这正是 `src-tauri/src/core/job.rs:1-5` 注释里写的那个已知现象：

> 孤儿客户端会一直挂在服务器的 tmux 上，导致多客户端尺寸冲突（表现为终端显示不全、满屏花点）。

### 3.2 现在有两个入口会真的制造第二个客户端

**入口 A：tmux 管理面板的「连接」按钮**（`src/App.tsx:4369-4375`）

```tsx
onClick={() => void openSshSession(tmuxTarget, "name", s.name)}   // 没有"已开着就切过去"的判断
```

而同一个应用在**另一条路径**上已经做了这个判断（`src/App.tsx:2477-2488`），注释写得明明白白：

```tsx
// App.tsx:2473-2475
// 已经在标签里开着的：直接切过去，不要再开一个。
// - tmux：同一个会话被两个客户端 attach 会互相挤窗口尺寸（"显示不全"那次的根因）；
```

**所以这是一个"已经知道、但漏了一个入口"的 bug。**

**入口 B：「新建会话 → tmux 新建 → 名字留空」**（`src/App.tsx:2441-2450`）

```tsx
} else if (newDialog.tmuxKind === "new") {
  const name = newDialog.tmuxName.trim() || defaultTmuxName(profile);   // 同一台服务器永远是同一个名字
```

`defaultTmuxName()` 按模板 `{host}-{user}` 生成，对 `lz@192.0.2.45` 永远是
`47-99-241-168-lz`。所以"新建会话"点两次 = 同一个 tmux 会话挂两个客户端。

### 3.3 前端的最小尺寸下限太小（次要成因）

`src/features/Terminal.tsx:91-94`：

```tsx
// 小于这个尺寸的 resize 一律不发：界面首次布局时容器可能是 0 尺寸，
// 一旦把 12x4 这种尺寸发给 tmux，窗口会被压变形（表现为满屏花点）。
const MIN_COLS = 20;
const MIN_ROWS = 5;
```

这个下限确实挡住"0 尺寸"，但 **20 列本身已经足够把历史压烂**：

- 分屏（三分屏 / 四分屏）时每格只有几十列；
- 侧栏拖到 620px + 窗口最小宽 900px 时，终端区只剩约 230px（字号大时约 20–25 列）；
- `ResizeObserver`（`Terminal.tsx:201-202`）在这些瞬态尺寸下会**照发不误**。

---

## 4. 怎么确认（如果你想亲手验一次）

这些命令都是只读的，随时可以跑：

```bash
# 1) 现在有几个客户端挂在 codexAAA 上？（>1 就是当场复现了冲突）
tmux list-clients -t codexAAA -F '#{client_name} #{client_width}x#{client_height} #{client_activity}'

# 2) 本机 tmux 版本（< 2.9 就没有 window-size 选项）
tmux -V

# 3) 这个会话的窗口现在多大、里面跑的是什么
tmux list-panes -t codexAAA -F '#{pane_width}x#{pane_height} #{pane_current_command}'
```

如果第 1 条列出两个客户端、且宽度不一样——**这就是现场的完整复现**。

---

## 5. 可选修法（按推荐顺序，我本轮不动手）

1. **让 attach 互斥**（最直接，改一处字符串）：

   ```sh
   if tmux has-session -t NAME 2>/dev/null; then exec tmux attach -d -t NAME; \
   else exec tmux new-session -s NAME; fi
   ```

   `attach -d` 会踢掉别的客户端，从根上消掉尺寸冲突。注意 `has-session` 在 2.7 上也有。

2. **补上那两个去重入口**（T-18）：把"已打开就切过去"提到 `openSshSession` 内部，
   所有入口统一生效；`defaultTmuxName()` 再按"这个名字已经开着"顺延编号。

3. **抬高最小尺寸 + 不可见时不发 resize**：`MIN_COLS` 20 → 40 以上；
   终端处于隐藏 / 未激活时不要 `session_resize`（顺手也省掉一批无谓的 IPC）。

4. **服务器侧升级 tmux 并设策略**（治本，但要动服务器）：

   ```bash
   tmux set-option -g window-size latest     # 需要 tmux >= 2.9
   tmux set-option -w aggressive-resize on   # 2.7 就支持
   ```

   这台是 2.7（2018 年），建议至少升到 3.x —— 但**这是改服务器环境**，要不要做你定。

5. **治本之后再加一道保险**：在连接时把 tmux 侧也设一次
   `set-option -g window-size latest`（只有新版本认，旧版本会报错，需要 `2>/dev/null` 兜住）。

---

## 6. 这条 bug 的边界（没验证的部分）

- 我**没有**复现"两个客户端同时挂着"的那一刻：查询的时候只有 1 个客户端、尺寸也是对的。
  所以「到底哪一次操作压窄了它」我只能给出**代码级可能路径**，不能给你"就是某次点击造成的"这种定论。
- 我也**没有**验证历史的窄柱能不能修复——按 tmux 的原理，**历史一旦按窄宽度硬换行就回不来了**，
  只能靠 `/clear` 或新开一个 tmux 会话。你那段历史里如果还有要留的内容，建议在它还在的时候先复制出来。
- 如果你愿意，我可以下次在这台测试服务器上做一次**受控复现**（开两个客户端 → 截图 → 关掉一个），
  把因果链钉死；那会在服务器上留下少量痕迹，需要你点头。
