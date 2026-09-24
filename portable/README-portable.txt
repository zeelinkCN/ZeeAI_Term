ZeeAI Terminal 0.1.0 - 便携版 / Portable
=========================================

怎么用 / How to run
-------------------
1. 双击 zeeai-terminal.exe 即可，无需安装。
2. 左侧「远程」→ 点「＋ 新建会话」（或直接在「已保存的服务器」里点服务器）。
   连接时会问要不要用 tmux：可以新建一个 tmux 会话，也可以附加到已有的。
3. 同一个弹窗里可以改「登录用户」：想用普通用户登录就把 root 改成你的用户名，
   远程文件和 tmux 都会跟着这个用户走（勾上「保存到配置」下次默认用它）。
4. 侧栏「文件」子标签可以浏览服务器目录，点文件即可看 Markdown / HTML 预览（默认渲染效果）。
5. 服务器要新建 / 编辑 / 复制 / 删除：点「已保存的服务器」旁边的 ⋯，或顶部菜单
   「连接 → 服务器管理…」。
6. 左侧还有 PowerShell / CMD / WSL / Git / 串口 / ADB 等本地工具；顶部菜单、底部齿轮都能用。

依赖 / Requirements
-------------------
- Windows 10/11（需要系统自带 WebView2 Runtime，Win11 默认已有）
- SSH 使用系统自带 OpenSSH 客户端，密钥沿用你 ~/.ssh 里的配置

关于 ADB
--------
本便携版已内置 platform-tools（resources\platform-tools\）。
第一次点「刷新设备」时 Windows 可能弹防火墙授权——这是 adb 的正常行为，允许即可。

配置文件 / Config
-----------------
%APPDATA%\ZeeAI-Terminal\
  profiles.json   连接配置
  history.json    会话历史
  settings.json   设置

注意 / Notes
------------
- 不要单独把 exe 拷走：resources 目录要和 exe 放在一起（ADB 依赖它）。
- 卸载 = 删除整个文件夹，再手动删掉上面的 %APPDATA% 目录。
