pub mod commands;
pub mod core;
mod instance;
mod store;

use core::SessionRegistry;
use tauri::Manager;
// 只有自检/演示那条路径（feature = "selftest"）才发事件
#[cfg(feature = "selftest")]
use tauri::Emitter;

/// 启动计时起点（进程内第一次用到时开始算）
static STARTUP_T0: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
/// 窗口是否已经显示过。前端 ready 与 setup 里的兜底线程可能同时到达，只允许一次。
static WINDOW_SHOWN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn startup_ms() -> u128 {
  STARTUP_T0.get_or_init(std::time::Instant::now).elapsed().as_millis()
}

/// 启动阶段标记：**日志 + 一个专用小文件**，两个都写。
///
/// 为什么要文件：测量脚本在画面稳定后就把进程关掉，而日志插件的文件写入有自己的
/// 缓冲/线程 —— 实测被强杀时最后几行会丢，`logger().flush()` 也救不回来
/// （甚至出现过 flush 之后那一行彻底不见）。启动耗时是要拿数字说话的东西，不能靠运气。
fn mark_startup(stage: &str) {
  let ms = startup_ms();
  log::info!("startup: {} at {} ms", stage, ms);
  let Some(base) = std::env::var("LOCALAPPDATA").ok() else {
    return;
  };
  let dir = std::path::Path::new(&base)
    .join("com.zeeai.terminal")
    .join("logs");
  if std::fs::create_dir_all(&dir).is_err() {
    return;
  }
  if let Ok(mut f) = std::fs::OpenOptions::new()
    .create(true)
    .append(true)
    .open(dir.join("startup-marks.log"))
  {
    use std::io::Write;
    let _ = writeln!(f, "stage={stage} at_ms={ms} pid={}", std::process::id());
    let _ = f.flush();
  }
}

/// 前端**首屏画完了** → 记一笔启动耗时（窗口本身是可见创建的，见下面的说明）。
///
/// 用户报的问题："启动瞬间一大一小两个相同画面重影 + 卡顿一下"。
/// `scripts/startup-probe.ps1` + `scripts/startup-capture.ps1` 实测到的真相是：
///   · 窗口在 ~225ms 就**映射到屏幕上**，而 WebView2 那时**一帧都还没画** ——
///     这段时间屏幕上留着的是**上一次那个窗口的残留**（重开时就是同一个应用的界面，
///     所以看起来是"两个相同的画面，一大一小"），接着才画出一片**白**，最后才是深色界面；
///   · 一直等到 ~830ms 画面才稳定 —— 那一下"卡顿"就是首屏在跟 WebGL 挂载 / 看板扫描 /
///     快照轮询抢主线程。
/// 试过"窗口隐藏创建、前端 ready 再 show"（`visible: false`）：**实测更差** ——
/// Chromium 对隐藏窗口会推迟渲染，窗口虽然 250ms 就 show 了，但**第一帧要到 ~1.4s** 才出来，
/// 用户会对着一个空窗口干等一秒。所以最终没那么做，改成：
///   1. `tauri.conf.json` 设窗口背景色（不再白闪）+ `index.html` 里一块**不依赖 JS 的静态启动屏**
///      —— 保证"第一眼看到的是我们自己的画面"；
///   2. 把重活（WebGL、看板扫描、快照、更新检查）推迟到首帧之后（见 `src/startup.ts`）。
/// 这条命令因此只做计时/日志，`show()` 只是保险（窗口已经可见时是空操作）。
#[tauri::command]
fn frontend_ready(app: tauri::AppHandle, at_ms: Option<f64>) {
  if WINDOW_SHOWN.swap(true, std::sync::atomic::Ordering::SeqCst) {
    return;
  }
  mark_startup(&format!(
    "frontend ready（前端自报 {} ms）",
    at_ms.unwrap_or(0.0) as u64
  ));
  if let Some(w) = app.get_webview_window("main") {
    if !w.is_visible().unwrap_or(true) {
      let _ = w.show();
      mark_startup("window shown");
    }
  }
}

/// 前端把"某个阶段好了"写进日志（终端就绪 / 空闲任务补齐…），用来对比启动耗时。
/// 故意做成"只记日志"：它不该影响任何行为，也不该因为失败打断启动。
#[tauri::command]
fn startup_mark(name: String) {
  mark_startup(&name);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  // 单实例：便携版和安装版**共用**同一份配置目录，两个实例同时跑会互相覆盖
  // settings / history / workspace（后写的赢），通知也会各弹一遍。
  // 第二个实例只把已有窗口叫到前面来，然后自己退出。见 instance.rs。
  #[cfg(windows)]
  if !instance::ensure_single_instance() {
    return;
  }
  tauri::Builder::default()
    .plugin(
      tauri_plugin_log::Builder::default()
        .level(log::LevelFilter::Info)
        .build(),
    )
    .plugin(tauri_plugin_dialog::init())
    .setup(|app| {
      // 启动计时起点。（窗口是**可见创建**的：试过"隐藏创建 + 前端 ready 再 show"，
      // 实测 Chromium 会推迟隐藏窗口的渲染 —— 窗口 250ms 就 show 了，但第一帧要到 ~1.4s 才出来，
      // 用户对着空窗口干等一秒，反而更差。完整结论写在 frontend_ready 的注释里。）
      STARTUP_T0.get_or_init(std::time::Instant::now);
      mark_startup("window created");
      // WebView2 在画出第一帧之前是**白底**（实测 400ms 时整窗纯白、四周还露着旧窗口的边），
      // 这就是"启动闪一下"的来源。`tauri.conf.json` 的窗口颜色只盖住窗口层，
      // **webview 层仍是白的** —— 必须用 `set_background_color`（它两层一起设）。
      // 这里先按深色主题设；界面渲染好后由前端自己画底（`.app { background: var(--bg) }`）。
      if let Some(w) = app.get_webview_window("main") {
        if let Err(e) = w.set_background_color(Some(tauri::window::Color(30, 30, 30, 255))) {
          log::warn!("startup: 设置窗口底色失败（只是没有白闪防护）：{e}");
        }
      }
      {
        // 保险丝：万一窗口因为什么原因没显示（改配置、前端没跑起来），5 秒后兜底显示。
        let handle = app.handle().clone();
        std::thread::spawn(move || {
          std::thread::sleep(std::time::Duration::from_secs(5));
          WINDOW_SHOWN.store(true, std::sync::atomic::Ordering::SeqCst);
          if let Some(w) = handle.get_webview_window("main") {
            if !w.is_visible().unwrap_or(true) {
              log::warn!("startup: 5 秒后窗口仍不可见，兜底显示");
              let _ = w.show();
            }
          }
        });
      }
      // 系统托盘：配合「关闭时收进托盘」使用，也能快速唤回窗口
      {
        use tauri::menu::{Menu, MenuItem};
        use tauri::tray::TrayIconBuilder;
        let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
        let quit = MenuItem::with_id(app, "quit", "退出 ZeeAI Term", true, None::<&str>)?;
        let menu = Menu::with_items(app, &[&show, &quit])?;
        let mut builder = TrayIconBuilder::with_id("main-tray")
          .tooltip("ZeeAI Term")
          .menu(&menu)
          .show_menu_on_left_click(false)
          .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
              if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
              }
            }
            "quit" => app.exit(0),
            _ => {}
          });
        if let Some(icon) = app.default_window_icon() {
          builder = builder.icon(icon.clone());
        }
        let _ = builder.build(app);
      }
      // 本机 codex 日志 → 红点（§10.6 唯一允许"自动亮"的本机来源之一）。
      //
      // **只读文件、不起子进程**：线程里只有 `std::fs::metadata` + 读取新增字节，
      // 没有任何 `Command` / `ssh` / `ps`。用户明确反对的是"短周期自动探测子进程"
      // （那会弹控制台窗口、耗 CPU）；读自己的日志文件不属于探测，而且这也是用户
      // 2026-10-20 亲口确认的口径（"本地 codex 的日志文件也算可以直接读"）。
      // ⚠️ 别往这条线程里加任何命令；要加探测必须先问用户（见 docs/design-ai-board-v2.md §10.8）。
      crate::core::ai_log_watch::spawn(app.handle().clone());
      // herdr 红点轮询（用户 2026-10-20 明确批准）：每台**勾了 herdr 的**服务器
      // 每 60 秒查一次 `herdr agent list`，只用来驱动红点。
      //
      // 为什么不和上面那条并在一起：这条**要起 ssh**（herdr 的状态只能这么拉），
      // 所以它必须有自己的间隔（60 秒，用户批的下限）、自己的失败静默策略，
      // 以及一个应用退出时能置位的停止位；读本机日志那条 2.5 秒一轮、不碰网络。
      // 探测本身复用 `commands::herdr_agents`（→ `run_remote_capture` →
      // `proc::hidden_command_async`，带 CREATE_NO_WINDOW），不会弹黑框。
      // ⚠️ 不要往这条线程里塞第二个探测 / 改小间隔；见 core/ai_herdr_dots.rs 模块头。
      crate::core::ai_herdr_dots::spawn(app.handle().clone());
      // 自动化演示：设置 ZEEAI_AUTODEMO=1 时，启动后通知前端按脚本走一遍流程
      // （连接 → 切文件 → 打开预览），便于无人值守截图验证界面。
      //
      // `#[cfg(feature = "selftest")]`：**默认不编进发布二进制**。
      // 这一段和下面的自检都会对用户自己的服务器/手机做真操作（上传、删除、装 herdr、
      // kill adb），编进发给用户的 exe 就等于"设个环境变量就能动他的机器"。
      // 开发时用 `cargo run --features selftest`（见 Cargo.toml 的 [features]）。
      #[cfg(feature = "selftest")]
      if std::env::var("ZEEAI_AUTODEMO").is_ok() {
        let handle = app.handle().clone();
        std::thread::spawn(move || {
          std::thread::sleep(std::time::Duration::from_secs(4));
          let _ = handle.emit("zeeai://autodemo", ());
        });
      }
      // 无人值守自检：设置 ZEEAI_SELFTEST=1 启动时，对第一条 SSH 配置跑一遍
      // tmux 列表与远端目录列举，把结果写进日志后退出。便于 CI/夜里验证。
      // 同上：默认不编进发布二进制（`--features selftest` 才编）。
      #[cfg(feature = "selftest")]
      if std::env::var("ZEEAI_SELFTEST").is_ok() {
        let handle = app.handle().clone();
        tauri::async_runtime::spawn(async move {
          let profiles = crate::store::load().unwrap_or_default();
          // 默认拿第一台 SSH 服务器；设了 ZEEAI_SELFTEST_PROFILE=<名字> 就按名字挑
          //（排查"只有某台机器出问题"时很有用，比如 lz 走的是密码认证那条路）
          let want = std::env::var("ZEEAI_SELFTEST_PROFILE").unwrap_or_default();
          let picked = if want.trim().is_empty() {
            profiles.iter().find(|p| p.ssh.is_some())
          } else {
            profiles
              .iter()
              .find(|p| p.ssh.is_some() && p.name.eq_ignore_ascii_case(want.trim()))
              .or_else(|| profiles.iter().find(|p| p.ssh.is_some()))
          };
          match picked {
            Some(profile) => {
              log::info!("SELFTEST: using profile {}", profile.name);
              match crate::commands::tmux_list(profile.id.clone(), None).await {
                Ok(list) => {
                  log::info!("SELFTEST: tmux_list ok -> {} sessions", list.len());
                  // 「文件面板跟随终端目录」依赖这个：问 tmux 会话当前在哪个目录
                  if let Some(first) = list.first() {
                    match crate::commands::remote_pwd(
                      profile.id.clone(),
                      Some(first.name.clone()),
                      None,
                    )
                    .await
                    {
                      Ok(pwd) => log::info!(
                        "SELFTEST: remote_pwd ok -> tmux {} 在 {}",
                        first.name,
                        pwd
                      ),
                      Err(e) => log::error!("SELFTEST: remote_pwd failed -> {e}"),
                    }
                  }
                }
                Err(e) => log::error!("SELFTEST: tmux_list failed -> {e}"),
              }
              match crate::commands::fs_list(profile.id.clone(), None, None).await {
                Ok(listing) => log::info!(
                  "SELFTEST: fs_list ok -> {} entries at {}",
                  listing.entries.len(),
                  listing.path
                ),
                Err(e) => log::error!("SELFTEST: fs_list failed -> {e}"),
              }
              // 以另一个普通用户登录时，远程文件必须跟着这个用户走（家目录不同）。
              // 设 ZEEAI_SELFTEST_ALTUSER=zeeai 可验证「选用户登录」这条链路。
              if let Ok(alt_user) = std::env::var("ZEEAI_SELFTEST_ALTUSER") {
                if !alt_user.trim().is_empty() {
                  match crate::commands::fs_list(
                    profile.id.clone(),
                    None,
                    Some(alt_user.clone()),
                  )
                  .await
                  {
                    Ok(listing) => log::info!(
                      "SELFTEST: fs_list as {alt_user} ok -> {} entries at {}",
                      listing.entries.len(),
                      listing.path
                    ),
                    Err(e) => log::error!("SELFTEST: fs_list as {alt_user} failed -> {e}"),
                  }
                  match crate::commands::tmux_list(
                    profile.id.clone(),
                    Some(alt_user.clone()),
                  )
                  .await
                  {
                    Ok(list) => log::info!(
                      "SELFTEST: tmux_list as {alt_user} ok -> {} sessions",
                      list.len()
                    ),
                    Err(e) => log::error!("SELFTEST: tmux_list as {alt_user} failed -> {e}"),
                  }
                }
              }
              match crate::commands::adb_devices(handle.clone()).await {
                Ok(list) => log::info!("SELFTEST: adb_devices ok -> {} devices", list.len()),
                Err(e) => log::error!("SELFTEST: adb_devices failed -> {e}"),
              }
              match crate::commands::fastboot_devices(handle.clone()).await {
                Ok(list) => log::info!("SELFTEST: fastboot ok -> {} devices", list.len()),
                Err(e) => log::error!("SELFTEST: fastboot failed -> {e}"),
              }
              match crate::commands::serial_list() {
                Ok(list) => log::info!("SELFTEST: serial_list ok -> {} ports", list.len()),
                Err(e) => log::error!("SELFTEST: serial_list failed -> {e}"),
              }
              // 真机串口验证：**只有显式设了 ZEEAI_SELFTEST_SERIAL 才探测**。
              // 默认绝不去碰任何串口 —— 用户机器上的串口可能正被别的项目占用，
              // 自检悄悄打开它会把别人的程序踢掉（我踩过这个坑）。
              {
                let wanted = std::env::var("ZEEAI_SELFTEST_SERIAL").unwrap_or_default();
                if wanted.trim().is_empty() {
                  log::info!(
                    "SELFTEST: serial_probe 跳过（未指定 ZEEAI_SELFTEST_SERIAL，默认不占用任何串口）"
                  );
                } else {
                  let ports = crate::core::serial::list().unwrap_or_default();
                  match ports.iter().find(|p| p.path.eq_ignore_ascii_case(wanted.trim())) {
                    Some(p) => match crate::core::serial::probe(&p.path, 115200, 4000) {
                      Ok((n, preview)) => log::info!(
                        "SELFTEST: serial_probe {} ({}) ok -> {} bytes | {}",
                        p.path,
                        p.label,
                        n,
                        preview
                      ),
                      Err(e) => log::error!("SELFTEST: serial_probe {} failed -> {e}", p.path),
                    },
                    None => log::warn!("SELFTEST: serial port {} not found", wanted.trim()),
                  }
                }
              }
              // M3 文件传输链路：新建目录 → 上传 → 列目录 → 下载回来比对 → 改名 → 删除
              {
                let pid = profile.id.clone();
                let remote_dir = "/tmp/zeeai-selftest".to_string();
                let local_up = std::env::temp_dir().join("zeeai-selftest-up.txt");
                let local_down_dir = std::env::temp_dir().join("zeeai-selftest-dl");
                let payload = b"zeeai transfer selftest\n";
                let _ = std::fs::create_dir_all(&local_down_dir);
                let _ = std::fs::write(&local_up, payload);
                let _ = std::fs::remove_file(local_down_dir.join("zeeai-selftest-up.txt"));

                match crate::commands::fs_mkdir(pid.clone(), remote_dir.clone(), None).await {
                  Ok(()) => log::info!("SELFTEST: fs_mkdir ok -> {remote_dir}"),
                  Err(e) => log::error!("SELFTEST: fs_mkdir failed -> {e}"),
                }
                match crate::commands::fs_upload(
                  pid.clone(),
                  vec![local_up.to_string_lossy().to_string()],
                  remote_dir.clone(),
                  None,
                  None,
                  handle.clone(),
                )
                .await
                {
                  Ok(msg) => log::info!("SELFTEST: fs_upload ok -> {msg}"),
                  Err(e) => log::error!("SELFTEST: fs_upload failed -> {e}"),
                }
                let remote_file = format!("{remote_dir}/zeeai-selftest-up.txt");
                match crate::commands::fs_list(pid.clone(), Some(remote_dir.clone()), None).await {
                  Ok(listing) => log::info!(
                    "SELFTEST: fs_upload verify -> {} entries ({})",
                    listing.entries.len(),
                    listing
                      .entries
                      .iter()
                      .map(|e| e.name.clone())
                      .collect::<Vec<_>>()
                      .join(",")
                  ),
                  Err(e) => log::error!("SELFTEST: fs_upload verify failed -> {e}"),
                }
                match crate::commands::fs_download(
                  pid.clone(),
                  vec![remote_file.clone()],
                  local_down_dir.to_string_lossy().to_string(),
                  None,
                  None,
                  handle.clone(),
                )
                .await
                {
                  Ok(msg) => {
                    let got = std::fs::read(local_down_dir.join("zeeai-selftest-up.txt"))
                      .unwrap_or_default();
                    log::info!(
                      "SELFTEST: fs_download ok -> {msg} (roundtrip match = {})",
                      got == payload
                    );
                  }
                  Err(e) => log::error!("SELFTEST: fs_download failed -> {e}"),
                }
                match crate::commands::fs_rename(
                  pid.clone(),
                  remote_file.clone(),
                  format!("{remote_dir}/renamed.txt"),
                  None,
                )
                .await
                {
                  Ok(()) => log::info!("SELFTEST: fs_rename ok"),
                  Err(e) => log::error!("SELFTEST: fs_rename failed -> {e}"),
                }
                match crate::commands::fs_remove(pid.clone(), remote_dir.clone(), None).await {
                  Ok(()) => log::info!("SELFTEST: fs_remove ok -> {remote_dir}"),
                  Err(e) => log::error!("SELFTEST: fs_remove failed -> {e}"),
                }
                // 断点续传验证：先手工写一半，再走一次完整上传，看会不会接着传完
                {
                  let big_local = std::env::temp_dir().join("zeeai-selftest-resume.bin");
                  let payload: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();
                  let _ = std::fs::write(&big_local, &payload);
                  // 注意：文件名必须和本地文件名一致，fs_upload 是按本地文件名拼远端路径的
                  let remote_resume =
                    format!("{remote_dir}/zeeai-selftest-resume.bin");
                  let cfg_ok = crate::commands::fs_mkdir(
                    pid.clone(),
                    remote_dir.clone(),
                    None,
                  )
                  .await
                  .is_ok();
                  if cfg_ok {
                    let conn = crate::core::sftp::connect(
                      &profile.ssh.as_ref().unwrap().host,
                      profile.ssh.as_ref().unwrap().port,
                      &profile.ssh.as_ref().unwrap().user,
                      None,
                      None,
                      None,
                    )
                    .await;
                    match conn {
                      Ok(conn) => {
                        use tokio::io::AsyncWriteExt;
                        let half = payload.len() / 2;
                        if let Ok(mut f) = conn.sftp.create(&remote_resume).await {
                          let _ = f.write_all(&payload[..half]).await;
                          let _ = f.flush().await;
                        }
                        drop(conn);
                        // 再走一次正常上传（应当从 half 处续传）
                        match crate::commands::fs_upload(
                          pid.clone(),
                          vec![big_local.to_string_lossy().to_string()],
                          remote_dir.clone(),
                          None,
                          None,
                          handle.clone(),
                        )
                        .await
                        {
                          Ok(msg) => {
                            // 校验远端大小
                            let conn2 = crate::core::sftp::connect(
                              &profile.ssh.as_ref().unwrap().host,
                              profile.ssh.as_ref().unwrap().port,
                              &profile.ssh.as_ref().unwrap().user,
                              None,
                              None,
                              None,
                            )
                            .await;
                            if let Ok(c2) = conn2 {
                              match c2.sftp.metadata(&remote_resume).await {
                                Ok(md) => {
                                  let size = md.size.unwrap_or(0);
                                  log::info!(
                                    "SELFTEST: resume upload ok ({msg}) -> 远端 {} 字节，期望 {}，匹配 = {}",
                                    size,
                                    payload.len(),
                                    size == payload.len() as u64
                                  );
                                }
                                Err(e) => log::error!("SELFTEST: resume stat failed -> {e}"),
                              }
                            }
                          }
                          Err(e) => log::error!("SELFTEST: resume upload failed -> {e}"),
                        }
                      }
                      Err(e) => log::error!("SELFTEST: resume setup failed -> {e}"),
                    }
                  }
                  let _ = std::fs::remove_file(&big_local);
                  let _ = crate::commands::fs_remove(pid.clone(), remote_dir.clone(), None).await;
                }
                let _ = std::fs::remove_file(&local_up);
                let _ = std::fs::remove_dir_all(&local_down_dir);
              }
              let probe_dir = std::env::current_dir()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();
              match crate::commands::git_status(probe_dir.clone()).await {
                Ok(s) => log::info!(
                  "SELFTEST: git_status ok -> ok={} branch={} files={} dir={}",
                  s.ok,
                  s.branch,
                  s.files.len(),
                  probe_dir
                ),
                Err(e) => log::error!("SELFTEST: git_status failed -> {e}"),
              }
              // herdr 链路自检（**要显式开关**：它可能往服务器写 ~/.local/bin/herdr）：
              // 探测 → 读官方清单 → Windows 侧下载 → 校验 sha256 → scp → 安装 → 只读自检。
              // 不设变量时连探测都不跑 —— 免得默认打扰别人的服务器。
              if std::env::var("ZEEAI_SELFTEST_HERDR").is_ok() {
                // 先对**每一台** SSH 服务器跑一遍"状态来源探测"（AI 面板/新建会话用的那个），
                // 并且**把原始输出也打出来**：万一哪天远端采集又拿到空串（例如 API 改成
                // spawn 之后忘了接管道 —— 我踩过，表现是"明明装了 herdr 却显示没装"），
                // 日志里一眼就能看出来。
                for p in profiles.iter().filter(|p| p.ssh.is_some()) {
                    match crate::commands::ai_source_probe(Some(p.id.clone()), None).await {
                        Ok(info) => {
                            if info.raw.trim().is_empty() {
                                log::error!(
                                    "SELFTEST: ai_source_probe({}) **拿到空输出** —— 远端采集可能又没接管 stdout",
                                    p.name
                                );
                            } else {
                                log::info!(
                                    "SELFTEST: ai_source_probe({}) -> herdr={:?} 协议 {} raw={:?}",
                                    p.name,
                                    info.herdr_version,
                                    info.protocol,
                                    info.raw
                                );
                            }
                        }
                        Err(e) => log::error!("SELFTEST: ai_source_probe({}) failed -> {e}", p.name),
                    }
                }
                // 再对**每一台** SSH 服务器只读探一遍 agent 列表（这是看板的 herdr 数据源）
                for p in profiles.iter().filter(|p| p.ssh.is_some()) {
                  // 顺手量一下耗时：这一步走的是"远端采集"（密钥走 ssh.exe、密码走 russh），
                  // 用户报的"新建 herdr 窗口一直转"如果卡在这里，日志里就能直接看出来。
                  let t0 = std::time::Instant::now();
                  let r = crate::commands::herdr_agents(p.id.clone(), None).await;
                  let ms = t0.elapsed().as_millis();
                  match r {
                    Ok(list) => log::info!(
                      "SELFTEST: herdr_agents({}) -> {} 个（{} ms）：{}",
                      p.name,
                      list.len(),
                      ms,
                      list.iter()
                        .map(|a| format!("{}@{}={}", a.kind, a.pane_id, a.status))
                        .collect::<Vec<_>>()
                        .join(", ")
                    ),
                    Err(e) => log::error!(
                      "SELFTEST: herdr_agents({}) failed（{} ms）-> {e}",
                      p.name,
                      ms
                    ),
                  }
                }
                // 再量一遍"新建窗格"那条路（用户点「新建 herdr 窗格」时走的就是它）
                {
                  let t0 = std::time::Instant::now();
                  match crate::commands::herdr_workspace_create(profile.id.clone(), None).await {
                    Ok(pane) => {
                      log::info!(
                        "SELFTEST: herdr_workspace_create -> {pane}（{} ms）",
                        t0.elapsed().as_millis()
                      );
                      // 建完就关掉，别在服务器上留垃圾
                      let host = profile.ssh.as_ref().map(|s| s.host.clone()).unwrap_or_default();
                      let user = profile.ssh.as_ref().map(|s| s.user.clone()).unwrap_or_default();
                      let ws = pane.split(':').next().unwrap_or("").to_string();
                      let args = crate::core::ssh::ssh_exec_args(
                        &host,
                        22,
                        &user,
                        None,
                        &format!("herdr workspace close '{ws}'"),
                        None,
                      );
                      // 后台探针：统一走 hidden_command，别让自检闪控制台
                      let _ = crate::core::proc::hidden_command(crate::core::ssh::ssh_exe())
                        .args(&args)
                        .output();
                    }
                    Err(e) => log::error!(
                      "SELFTEST: herdr_workspace_create failed（{} ms）-> {e}",
                      t0.elapsed().as_millis()
                    ),
                  }
                }
                match crate::commands::herdr_install_inner(
                  profile.id.clone(),
                  None,
                  |s: &str| log::info!("SELFTEST: herdr {s}"),
                )
                .await
                {
                  Ok(rep) => log::info!(
                    "SELFTEST: herdr_install ok -> v{} 协议 {} 平台 {} 来源 {} {} 字节 sha {}",
                    rep.version,
                    rep.protocol,
                    rep.platform,
                    rep.source,
                    rep.bytes,
                    &rep.sha256[..rep.sha256.len().min(12)]
                  ),
                  Err(e) => log::error!("SELFTEST: herdr_install -> {e}"),
                }
              }
            }
            None => log::warn!("SELFTEST: no ssh profile found"),
          }
          log::info!("SELFTEST: done");
          // 自检里调过 adb_devices，那会顺手起一个 adb 守护进程；它从
          // `target/debug/resources/platform-tools/` 启动、会一直占着 AdbWinApi.dll，
          // 于是**下一次 cargo build 会报"文件正在使用"**（实测踩过好几次）。
          // 自检自己收尾：跑完就把它关掉。
          {
            let adb = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
              .join("resources")
              .join("platform-tools")
              .join("adb.exe");
            if adb.exists() {
              // 后台收尾命令：同样走 hidden_command（CREATE_NO_WINDOW）
              let mut c = crate::core::proc::hidden_command(&adb);
              c.arg("kill-server");
              let _ = c.output();
              log::info!("SELFTEST: 已顺手关掉 adb 守护进程（免得占着构建要用的 DLL）");
            }
          }
          handle.exit(0);
        });
      }
      Ok(())
    })
    .manage(SessionRegistry::new())
    // herdr 观察窗的元信息 + 输入泵
    .manage(crate::core::HerdrPaneRegistry::default())
    .manage(std::sync::Arc::new(
        crate::core::session_log::LogRegistry::new(),
    ))
    // 「AI 任务看板」里"App 自己启动的"那批任务的账本
    .manage(crate::core::ai_tasks::AiTaskRegistry::new())
    .invoke_handler(tauri::generate_handler![
      // 启动节奏：前端首帧 ready → 显示窗口；startup_mark 只记启动阶段耗时
      frontend_ready,
      startup_mark,
      commands::list_profiles,
      commands::save_profile,
      commands::delete_profile,
      // 连接诊断：跑一次 ssh -G 把"实际生效的 host/port/user/密钥"给 UI 看（用户报障用）
      commands::ssh_diagnose,
      commands::open_local,
      commands::open_ssh,
      commands::session_write,
      commands::session_resize,
      commands::session_close,
      commands::tmux_list,
      commands::tmux_kill,
      commands::tmux_windows,
      commands::tmux_action,
      commands::remote_pwd,
      commands::fs_list,
      commands::fs_read,
      commands::fs_upload,
      commands::fs_download,
      commands::fs_mkdir,
      commands::fs_remove,
      commands::fs_rename,
      commands::paste_save_file,
      commands::paste_discard_file,
      commands::paste_adopt_file,
      commands::paste_read_thumb,
      commands::history_list,
      commands::history_save,
      commands::history_remove,
      commands::settings_get,
      commands::settings_set,
      commands::adb_version,
      commands::adb_devices,
      commands::open_adb_shell,
      commands::serial_list,
      commands::open_serial,
      commands::fastboot_version,
      commands::fastboot_devices,
      commands::adb_ls,
      commands::adb_pull,
      commands::adb_push,
      commands::adb_rm,
      commands::adb_mkdir,
      commands::git_status,
      commands::git_init,
      commands::git_add,
      commands::git_unstage,
      commands::git_discard,
      commands::git_commit,
      commands::git_log,
      commands::git_branches,
      commands::git_checkout,
      commands::git_diff,
      commands::git_show,
      commands::secret_set,
      commands::secret_has,
      commands::secret_delete,
      commands::workspace_save,
      commands::workspace_load,
      commands::session_log_start,
      commands::session_log_stop,
      commands::session_log_status,
      commands::session_log_dir,
      commands::open_in_explorer,
      commands::open_external_url,
      commands::update_install_kind,
      commands::update_take_result,
      commands::update_download_install,
      commands::ai_probe,
      commands::highlight_presets,
      commands::is_admin,
      commands::restart_as_admin,
      commands::open_admin_shell,
      commands::ai_task_note_start,
      commands::ai_tasks_remote,
      commands::ai_tasks_local,
      commands::ai_tasks_clear_finished,
      commands::ai_session_snapshot,
      commands::ai_task_artifacts,
      // 看板 v2 §10：统一「AI 实例」模型（前端把已采集的数据送进来，合并/判状态在后端做）
      commands::ai_instances,
      commands::ai_timeline_list,
      commands::ai_timeline_add,
      commands::ai_timeline_clear,
      commands::ai_source_probe,
      commands::herdr_agents,
      commands::herdr_panes,
      commands::herdr_server_status,
      commands::herdr_server_start,
      commands::herdr_server_stop,
      commands::herdr_workspace_scan,
      commands::herdr_workspace_close,
      commands::herdr_pane_action,
      commands::herdr_workspace_create,
      commands::herdr_pane_input,
      commands::herdr_pane_resize,
      commands::herdr_pane_input_start,
      commands::herdr_pane_type,
      commands::herdr_pane_key,
      commands::herdr_install,
    ])
    .on_window_event(|window, event| {
      // 「关闭时收进托盘」：拦截关闭请求并隐藏窗口（托盘菜单可唤回）
      if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        let settings = crate::store::load_settings();
        if settings.close_action == "tray" {
          api.prevent_close();
          let _ = window.hide();
          log::info!("window close intercepted -> hidden to tray");
        }
      }
    })
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|app_handle, event| {
      // 退出前把所有会话进程收干净（Job Object 也会兜底，但显式做更清晰）
      if let tauri::RunEvent::Exit = event {
        // herdr 红点轮询：先置停止位，让它在下一个分片睡眠（≤500ms）里收尾，
        // 不会在退出路径上再多发一次 ssh。
        crate::core::ai_herdr_dots::stop();
        let registry = app_handle.state::<SessionRegistry>();
        // 先把句柄取出来再 kill，避免在持有 map 锁的同时去碰子进程
        let handles: Vec<_> = match registry.sessions.lock() {
          Ok(mut sessions) => sessions.drain().map(|(_, handle)| handle).collect(),
          Err(_) => Vec::new(),
        };
        for handle in handles {
          if let Some(child) = handle.child.as_ref() {
            if let Ok(mut child) = child.lock() {
              let _ = child.kill();
            }
          }
        }
      }
    });
}
