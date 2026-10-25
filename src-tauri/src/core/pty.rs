use std::collections::{HashMap, VecDeque};
use std::io::Read;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use base64::Engine as _;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use tauri::ipc::Channel;

use super::session::{SessionEvent, SessionHandle};
use super::job;

/// 起进程时的开关
#[derive(Clone, Debug)]
pub struct SpawnOpts {
    /// **故意重开**时用：不要因为这一路流结束就往前端报 "closed"。
    ///
    /// 为什么是共享开关而不是一个 bool：herdr 的 observe 流在"用户改了窗口大小"时要重开，
    /// 而重开前必须先杀掉旧进程 —— 旧进程的读取线程此时会 EOF。用 bool 的话这个值在起
    /// 线程时就定死了，没法事后告诉它"这次是我让你停的"。所以给一个共享标志：
    /// 重开之前把它置上，旧线程看到它就不会误报"会话已关闭"。
    pub close_flag: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl Default for SpawnOpts {
    fn default() -> Self {
        Self {
            close_flag: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }
    }
}

// ---------------------------------------------------------------------------
// PTY 输出合并 + 背压
//
// 设计文档（docs/design.md §3.2）承诺的是「16ms 合并 + 前端背压」。这里补上实现：
//
// - **合并**：每片 read() 先攒进 BatchBuffer，满足任一条件才发一次 Channel：
//     · 攒到 64KB（大块输出走这条，一次 base64 一大片）
//     · 从本批第一片算起满 16ms（普通输出）
//     · 遇到换行 / 回车 / ESC 时把 deadline 缩到 5ms（交互式提示符要快，
//       但不能「见换行就立刻发」—— 实测 PowerShell 每 60 字节一片、18MB 输出
//       会产生 30 万次 IPC，正是用户「越用越卡」的来源。5ms 是一个合并窗口，
//       仍保证提示符的额外延迟远小于一帧。）
//     · 1MB 硬上限（兜底，正常永远到不了：64KB 就先发了）
//   顺序与字节完全不变（原样 Vec 拼接，最后只做一次 base64）。
//
// - **背压**：每批带一个 seq。前端等 xterm.write 的回调触发后调用
//   `session_output_ack(session_id, seq)`；后端最多允许 2 个未确认批次，超过就
//   暂停 reader 线程（reader 阻塞 → ConPTY / 远端 TCP 自然减速）。ack 等 1 秒
//   仍不到就记 warn 并推进窗口（丢掉的那次 ack 不能把会话永久卡死）。
// ---------------------------------------------------------------------------

/// 普通输出最长攒 16ms。
const FLUSH_INTERVAL: Duration = Duration::from_millis(16);
/// 见到换行 / CR / ESC 后的快速合并窗口。不是 0：0 会把「每行一个 IPC」原样带回来。
const INTERACTIVE_FLUSH_INTERVAL: Duration = Duration::from_millis(5);
/// 攒够这么多字节立刻发。
const FLUSH_BYTES: usize = 64 * 1024;
/// 批缓冲硬上限。真到了这里即使没满 16ms 也必须发，绝不无界增长。
const MAX_BUFFER_BYTES: usize = 1024 * 1024;
/// 最多允许多少批「已发但前端还没 ack」。
const MAX_UNACKED_BATCHES: usize = 2;
/// 等 ack 的上限；超时推进窗口，防一次丢 ack 永久卡死。
const ACK_TIMEOUT: Duration = Duration::from_secs(1);
/// 每 10 秒打一行吞吐诊断（只有真的有输出时才打）。
const PERF_LOG_INTERVAL: Duration = Duration::from_secs(10);
/// PTY 读缓冲大小。
const READ_CHUNK_BYTES: usize = 16 * 1024;
/// reader → 输出泵之间的有界队列。故意很小：前端不 ack 时 reader 会阻塞在 send 上。
const READ_QUEUE_CHUNKS: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FlushReason {
    /// 见到了换行 / 回车 / ESC，走 5ms 快速窗口
    Interactive,
    /// 普通 16ms 窗口
    Timer,
    /// 攒到了 64KB
    Bytes,
    /// 触到 1MB 上限
    HardLimit,
}

/// 一个批次的累积器。纯内存、无锁（只属于输出泵线程），所以可以直接单测。
struct BatchBuffer {
    bytes: Vec<u8>,
    started: Option<Instant>,
    interactive: bool,
}

impl BatchBuffer {
    fn new() -> Self {
        Self {
            bytes: Vec::new(),
            started: None,
            interactive: false,
        }
    }

    fn push(&mut self, chunk: &[u8], now: Instant) {
        if self.bytes.is_empty() {
            self.started = Some(now);
            self.interactive = false;
        }
        self.bytes.extend_from_slice(chunk);
        if !self.interactive && chunk.iter().any(|b| matches!(*b, b'\n' | b'\r' | 0x1b)) {
            self.interactive = true;
        }
    }

    fn len(&self) -> usize {
        self.bytes.len()
    }

    fn is_empty(&self) -> bool {
        self.bytes.is_empty()
    }

    fn deadline(&self) -> Option<Instant> {
        let started = self.started?;
        Some(
            started
                + if self.interactive {
                    INTERACTIVE_FLUSH_INTERVAL
                } else {
                    FLUSH_INTERVAL
                },
        )
    }

    fn due(&self, now: Instant) -> Option<FlushReason> {
        if self.bytes.is_empty() {
            return None;
        }
        if self.bytes.len() >= MAX_BUFFER_BYTES {
            return Some(FlushReason::HardLimit);
        }
        if self.bytes.len() >= FLUSH_BYTES {
            return Some(FlushReason::Bytes);
        }
        if now >= self.deadline()? {
            return Some(if self.interactive {
                FlushReason::Interactive
            } else {
                FlushReason::Timer
            });
        }
        None
    }

    fn take(&mut self) -> Vec<u8> {
        self.started = None;
        self.interactive = false;
        std::mem::take(&mut self.bytes)
    }
}

#[derive(Debug)]
struct OutstandingBatch {
    seq: u64,
    bytes: usize,
    sent_at: Instant,
}

#[derive(Debug)]
struct AckState {
    next_seq: u64,
    acked_upto: u64,
    outstanding: VecDeque<OutstandingBatch>,
    /// reader 是否应该暂停（未确认批次达到上限）
    paused: bool,
    closed: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AckWait {
    Ready,
    TimedOut,
}

/// 输出泵和 ack 命令共享的窗口状态。
///
/// 放在 Arc 里：输出泵线程持有它；`session_output_ack` 命令通过全局注册表拿到
/// 同一个 Arc，就能在**不碰会话表、不碰输出泵线程**的情况下推进窗口。
struct PumpControl {
    state: Mutex<AckState>,
    cv: Condvar,
    total_read: AtomicU64,
    total_batches: AtomicU64,
}

impl PumpControl {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(AckState {
                next_seq: 0,
                acked_upto: 0,
                outstanding: VecDeque::new(),
                paused: false,
                closed: false,
            }),
            cv: Condvar::new(),
            total_read: AtomicU64::new(0),
            total_batches: AtomicU64::new(0),
        })
    }

    fn lock_state(&self) -> std::sync::MutexGuard<'_, AckState> {
        // 输出泵里任何 panic 都不该把 ack 通路毒死；锁被毒就继续用里面那点状态。
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 登记一个刚发出的批次，返回 seq（从 1 开始）。
    fn register_batch(&self, bytes: usize, now: Instant) -> u64 {
        let mut st = self.lock_state();
        st.next_seq += 1;
        let seq = st.next_seq;
        st.outstanding.push_back(OutstandingBatch {
            seq,
            bytes,
            sent_at: now,
        });
        if st.outstanding.len() >= MAX_UNACKED_BATCHES {
            st.paused = true;
        }
        drop(st);
        self.cv.notify_all();
        seq
    }

    /// 前端 ack 到 seq（**累积语义**：seq 及之前的所有批次都算确认）。
    /// 返回 false 表示 seq 比已发出的还大（前端算错了，忽略）。
    fn ack(&self, seq: u64) -> bool {
        if seq == 0 {
            return false;
        }
        let mut st = self.lock_state();
        let highest_sent = st.next_seq;
        if seq > highest_sent {
            return false;
        }
        if seq <= st.acked_upto {
            return true; // 迟到的重复 ack：无害
        }
        st.acked_upto = seq;
        while st
            .outstanding
            .front()
            .map(|b| b.seq <= seq)
            .unwrap_or(false)
        {
            st.outstanding.pop_front();
        }
        if st.outstanding.len() < MAX_UNACKED_BATCHES {
            st.paused = false;
        }
        drop(st);
        self.cv.notify_all();
        true
    }

    /// 等窗口腾出位置；最多等 timeout。超时由调用方决定怎么推进。
    fn wait_for_room(&self, timeout: Duration) -> AckWait {
        let deadline = Instant::now() + timeout;
        let mut st = self.lock_state();
        loop {
            if st.closed || st.outstanding.len() < MAX_UNACKED_BATCHES {
                return AckWait::Ready;
            }
            let now = Instant::now();
            if now >= deadline {
                return AckWait::TimedOut;
            }
            let (guard, _) = self
                .cv
                .wait_timeout(st, deadline.saturating_duration_since(now))
                .unwrap_or_else(|e| e.into_inner());
            st = guard;
        }
    }

    /// 把最老的、已经等超过 timeout 的批次从窗口里踢掉（ack 丢失兜底）。
    fn expire_oldest(&self, now: Instant, timeout: Duration) -> Option<(u64, usize, Duration)> {
        let mut st = self.lock_state();
        let front = st.outstanding.front()?;
        let age = now.saturating_duration_since(front.sent_at);
        if age < timeout {
            return None;
        }
        let batch = st.outstanding.pop_front()?;
        st.acked_upto = st.acked_upto.max(batch.seq);
        if st.outstanding.len() < MAX_UNACKED_BATCHES {
            st.paused = false;
        }
        drop(st);
        self.cv.notify_all();
        Some((batch.seq, batch.bytes, age))
    }

    fn backlog_bytes(&self) -> usize {
        self.lock_state().outstanding.iter().map(|b| b.bytes).sum()
    }

    fn is_paused(&self) -> bool {
        self.lock_state().paused
    }

    /// reader 线程在每次 read 前调用；窗口满时在这里阻塞 → 不再读 PTY。
    /// 返回 false 表示泵已经关了，reader 可以退出。
    fn wait_until_readable(&self) -> bool {
        let mut st = self.lock_state();
        while st.paused && !st.closed {
            let (guard, _) = self
                .cv
                .wait_timeout(st, Duration::from_millis(100))
                .unwrap_or_else(|e| e.into_inner());
            st = guard;
        }
        !st.closed
    }

    fn close(&self) {
        let mut st = self.lock_state();
        st.closed = true;
        st.paused = false;
        drop(st);
        self.cv.notify_all();
    }
}

static PUMPS: OnceLock<Mutex<HashMap<String, Arc<PumpControl>>>> = OnceLock::new();

fn pump_registry() -> &'static Mutex<HashMap<String, Arc<PumpControl>>> {
    PUMPS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn register_pump(session_id: &str, control: Arc<PumpControl>) {
    if let Ok(mut map) = pump_registry().lock() {
        map.insert(session_id.to_string(), control);
    }
}

fn unregister_pump(session_id: &str, control: &Arc<PumpControl>) {
    if let Ok(mut map) = pump_registry().lock() {
        // 只删「自己」：自动重连时新泵可能已经用同一个 session_id 注册进来了，
        // 旧泵退出时不能把新泵的 ack 通路一起删掉。
        let is_same = map
            .get(session_id)
            .map(|current| Arc::ptr_eq(current, control))
            .unwrap_or(false);
        if is_same {
            map.remove(session_id);
        }
    }
}

/// 前端 ack 的入口（commands::session_output_ack 调用）。
///
/// 串口 / herdr 会话没有输出泵，这个函数就是空操作。
pub fn ack_output(session_id: &str, seq: u64) {
    let control = pump_registry()
        .lock()
        .ok()
        .and_then(|map| map.get(session_id).cloned());
    if let Some(control) = control {
        let _ = control.ack(seq);
    }
}

enum ReadMsg {
    Data(Vec<u8>),
    Eof,
}

/// 输出泵主循环：负责攒批、发 IPC、等 ack、打诊断日志。
fn run_output_pump<F>(
    session_id: String,
    sink: F,
    rx: std::sync::mpsc::Receiver<ReadMsg>,
    control: Arc<PumpControl>,
    close_flag: Arc<std::sync::atomic::AtomicBool>,
) where
    F: Fn(SessionEvent),
{
    let started = Instant::now();
    let mut batcher = BatchBuffer::new();
    let mut last_perf = started;
    let mut last_perf_read = 0u64;
    let mut last_perf_batches = 0u64;
    let mut sent_batches = 0u64;

    // 先定义一个能“发一批”的闭包。它会在窗口满时先等 ack（最多 1s）。
    let flush = |batcher: &mut BatchBuffer,
                 reason: FlushReason,
                 sent_batches: &mut u64| {
        let bytes = batcher.take();
        if bytes.is_empty() {
            return;
        }
        loop {
            match control.wait_for_room(ACK_TIMEOUT) {
                AckWait::Ready => break,
                AckWait::TimedOut => {
                    let now = Instant::now();
                    if let Some((seq, bytes, age)) = control.expire_oldest(now, ACK_TIMEOUT) {
                        log::warn!(
                            "pty: session={session_id} ack 超时（等了 {}ms，seq={seq}，{} 字节；窗口已推进，继续读 PTY，避免永久卡死）",
                            age.as_millis(),
                            bytes
                        );
                    } else {
                        // 理论上窗口满时一定有最老批次；没有就退避一下，别空转。
                        thread::sleep(Duration::from_millis(5));
                    }
                }
            }
        }
        let seq = control.register_batch(bytes.len(), Instant::now());
        let data = base64::engine::general_purpose::STANDARD.encode(&bytes);
        sink(SessionEvent::Data {
            data,
            seq: Some(seq),
        });
        *sent_batches += 1;
        control.total_batches.fetch_add(1, Ordering::Relaxed);
        log::trace!(
            "pty: session={session_id} flush reason={reason:?} bytes={} seq={seq}",
            bytes.len()
        );
    };

    let finish = |batcher: &mut BatchBuffer, sent_batches: &mut u64| {
        if !batcher.is_empty() {
            flush(batcher, FlushReason::Timer, sent_batches);
        }
        let elapsed = started.elapsed();
        log::info!(
            "perf: session={session_id} done bytes={} batches={} elapsed_ms={} avg_ipc/s={:.1} backlog={}",
            control.total_read.load(Ordering::Relaxed),
            *sent_batches,
            elapsed.as_millis(),
            if elapsed.as_secs_f64() > 0.0 {
                *sent_batches as f64 / elapsed.as_secs_f64()
            } else {
                0.0
            },
            control.backlog_bytes()
        );
    };

    loop {
        // 1) 到时间 / 到大小就发。
        if let Some(reason) = batcher.due(Instant::now()) {
            flush(&mut batcher, reason, &mut sent_batches);
        }

        // 2) 窗口满就暂停 reader；这里主动等 ack（含 1s 超时恢复），
        //    否则「窗口满 + 恰好没有新数据」时没人会去推进窗口。
        while control.is_paused() {
            match control.wait_for_room(ACK_TIMEOUT) {
                AckWait::Ready => break,
                AckWait::TimedOut => {
                    let now = Instant::now();
                    if let Some((seq, bytes, age)) = control.expire_oldest(now, ACK_TIMEOUT) {
                        log::warn!(
                            "pty: session={session_id} ack 超时（等了 {}ms，seq={seq}，{} 字节；窗口已推进，继续读 PTY，避免永久卡死）",
                            age.as_millis(),
                            bytes
                        );
                    }
                }
            }
        }

        // 3) 10 秒诊断：只有这 10 秒里真的读过/发过才打，空闲会话不刷日志。
        let now = Instant::now();
        if now.duration_since(last_perf) >= PERF_LOG_INTERVAL {
            let read = control.total_read.load(Ordering::Relaxed);
            let batches = control.total_batches.load(Ordering::Relaxed);
            if read > last_perf_read || batches > last_perf_batches {
                let secs = now.duration_since(last_perf).as_secs_f64().max(0.001);
                log::info!(
                    "perf: session={session_id} bytes/s={:.0} ipc/s={:.1} pending={} backlog={}",
                    (read - last_perf_read) as f64 / secs,
                    (batches - last_perf_batches) as f64 / secs,
                    batcher.len(),
                    control.backlog_bytes()
                );
            }
            last_perf = now;
            last_perf_read = read;
            last_perf_batches = batches;
        }

        // 4) 等到「本批 deadline」或「下一条 read 数据」或「下个诊断点」。
        let now = Instant::now();
        let mut wait = batcher
            .deadline()
            .map(|d| d.saturating_duration_since(now))
            .unwrap_or(PERF_LOG_INTERVAL);
        wait = wait.min(
            (last_perf + PERF_LOG_INTERVAL)
                .saturating_duration_since(now)
                .max(Duration::from_millis(1)),
        );
        // 没数据时别睡 50ms 才发现 EOF；小步轮询还能让诊断日志按时打。
        wait = wait.min(Duration::from_millis(50)).max(Duration::from_millis(1));

        match rx.recv_timeout(wait) {
            Ok(ReadMsg::Data(chunk)) => {
                batcher.push(&chunk, Instant::now());
                if let Some(reason) = batcher.due(Instant::now()) {
                    flush(&mut batcher, reason, &mut sent_batches);
                }
            }
            Ok(ReadMsg::Eof) => {
                finish(&mut batcher, &mut sent_batches);
                break;
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                // 下一轮会检查 due / 诊断；这里不需要做别的。
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                finish(&mut batcher, &mut sent_batches);
                break;
            }
        }
    }

    control.close();
    unregister_pump(&session_id, &control);
    if !close_flag.load(Ordering::Relaxed) {
        sink(SessionEvent::State {
            state: "closed".into(),
        });
    }
}

// 说明：herdr 的终端流**不走这里** —— 它用 `core::herdr_stream`（管道，不惊动 ConPTY）。
// 原因见那个模块顶部（ConPTY 的终端握手会被 JSON 行缓冲吃掉 → 黑屏；超长行还会被折行）。

/// 用系统 PTY 起一个进程（本地终端，或把 ssh.exe 跑在 PTY 里充当远程终端）。
pub fn spawn(
    session_id: &str,
    kind: &str,
    title: &str,
    program: &str,
    args: &[String],
    cwd: Option<&str>,
    cols: u16,
    rows: u16,
    channel: Channel<SessionEvent>,
    logs: std::sync::Arc<super::session_log::LogRegistry>,
    opts: SpawnOpts,
) -> Result<SessionHandle, String> {
    spawn_with_sink(
        session_id,
        kind,
        title,
        program,
        args,
        cwd,
        cols,
        rows,
        move |ev| {
            let _ = channel.send(ev);
        },
        logs,
        opts,
    )
}

/// 和 [`spawn`] 一样，但事件走一个普通闭包而不是 Tauri 的 Channel。
///
/// 为什么要有这个变体：**真机复现/自检**需要在没有前端、没有 Channel 的地方把
/// "起进程 → 收字节 → 过滤"这条链路原样跑一遍（见 `examples/herdr_probe.rs`）。
/// 两条路共用同一份实现，所以复现器里看到的行为就是用户看到的行为。
pub fn spawn_with_sink<F>(
    session_id: &str,
    kind: &str,
    title: &str,
    program: &str,
    args: &[String],
    cwd: Option<&str>,
    cols: u16,
    rows: u16,
    sink: F,
    logs: std::sync::Arc<super::session_log::LogRegistry>,
    opts: SpawnOpts,
) -> Result<SessionHandle, String>
where
    F: Fn(SessionEvent) + Send + 'static,
{
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty failed: {e}"))?;

    // 故意不走 core::proc::hidden_command：这里起的是**用户自己的终端**（ConPTY 里的
    // shell / ssh），不是后台探测；它由我们的标签页承载。portable-pty 直接走 ConPTY，
    // 本来也不经过 std/tokio 的 Command。
    let mut cmd = CommandBuilder::new(program);
    for a in args {
        cmd.arg(a);
    }
    if let Some(dir) = cwd {
        cmd.cwd(dir);
    }
    // 尽量给出一个可用的终端环境变量集合
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn failed: {e}"))?;
    drop(pair.slave);

    // 让子进程跟随应用生命周期，避免留下孤儿 ssh 客户端挂在远端 tmux 上
    if let Some(pid) = child.process_id() {
        job::assign(pid);
    }

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone reader failed: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take writer failed: {e}"))?;

    sink(SessionEvent::State {
        state: "connected".into(),
    });

    // reader 线程只做「读 → 落日志 → 送有界队列」；攒批 / 编码 / 等 ack 全在
    // 输出泵线程里。这样 read() 不会因为 base64 或 IPC 慢而被占住，而背压又能
    // 精确地作用在 read 之前（`wait_until_readable`）。
    let control = PumpControl::new();
    register_pump(session_id, control.clone());
    let (tx, rx) = std::sync::mpsc::sync_channel::<ReadMsg>(READ_QUEUE_CHUNKS);

    let sid_reader = session_id.to_string();
    let reader_control = control.clone();
    thread::Builder::new()
        .name(format!("pty-read-{session_id}"))
        .spawn(move || {
            let mut buf = vec![0u8; READ_CHUNK_BYTES];
            loop {
                if !reader_control.wait_until_readable() {
                    break;
                }
                match reader.read(&mut buf) {
                    Ok(0) => {
                        let _ = tx.send(ReadMsg::Eof);
                        break;
                    }
                    Ok(n) => {
                        // 会话日志：原始 PTY 字节（是否真的落盘由 LogRegistry 判断）
                        logs.write(&sid_reader, &buf[..n]);
                        reader_control
                            .total_read
                            .fetch_add(n as u64, Ordering::Relaxed);
                        if tx.send(ReadMsg::Data(buf[..n].to_vec())).is_err() {
                            break;
                        }
                    }
                    Err(e) => {
                        log::warn!("pty: session={sid_reader} 读取失败: {e}");
                        let _ = tx.send(ReadMsg::Eof);
                        break;
                    }
                }
            }
        })
        .map_err(|e| format!("spawn pty reader failed: {e}"))?;

    let sid_pump = session_id.to_string();
    let close_flag = opts.close_flag.clone();
    thread::Builder::new()
        .name(format!("pty-out-{session_id}"))
        .spawn(move || run_output_pump(sid_pump, sink, rx, control, close_flag))
        .map_err(|e| format!("spawn pty output pump failed: {e}"))?;

    Ok(SessionHandle {
        kind: kind.to_string(),
        title: title.to_string(),
        writer: Arc::new(Mutex::new(writer)),
        master: Some(Arc::new(Mutex::new(pair.master))),
        child: Some(Arc::new(Mutex::new(child))),
    })
}

/// 把新收到的一片字节喂进行缓冲，返回**已经能处理的完整记录**。
///
/// 为什么单独抽出来：herdr 的流是**按行**的 JSON，而 socket 读到的分片**不保证**落在
/// 行边界上 —— 一条 JSON 可能被切成两片（甚至跨三片）。这种"粘包/半包"必须自己缓冲，
/// 否则会出现"偶尔花屏/断片"，而且多半在网速慢的时候才复现（最难查的那一类 bug）。
///
/// 解码规则本身在 [`super::herdr::classify_line`] 里（那是 herdr 的协议知识，和被谁调用无关），
/// 这里只负责"按行切分 + 缓冲半截"。
pub fn push_herdr_bytes(
    pending: &mut Vec<u8>,
    chunk: &[u8],
) -> Vec<super::herdr::StreamLine> {
    pending.extend_from_slice(chunk);
    let mut out = Vec::new();
    while let Some(pos) = pending.iter().position(|b| *b == b'\n') {
        let line: Vec<u8> = pending.drain(..=pos).collect();
        let text = String::from_utf8_lossy(&line).to_string();
        let rec = super::herdr::classify_line(&text);
        // 空的数据帧没必要转发（省一次 IPC）
        if let super::herdr::StreamLine::Data(d) = &rec {
            if d.is_empty() {
                continue;
            }
        }
        out.push(rec);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::herdr::StreamLine;

    #[test]
    fn observe_line_decodes_base64_payload() {
        let raw = b"\x1b[31mhello\x1b[0m\r\n";
        let json = format!(
            "{{\"bytes\":\"{}\"}}",
            base64::engine::general_purpose::STANDARD.encode(raw)
        );
        assert_eq!(
            crate::core::herdr::classify_line(&json),
            StreamLine::Data(raw.to_vec())
        );
    }

    #[test]
    fn observe_line_passes_through_non_json() {
        assert!(matches!(
            crate::core::herdr::classify_line("herdr: something went wrong"),
            StreamLine::Other(_)
        ));
        assert!(matches!(
            crate::core::herdr::classify_line("{\"other\":1}"),
            StreamLine::Other(_)
        ));
    }

    #[test]
    fn observe_stream_survives_split_across_reads() {
        // 一条 JSON 被切成三片喂进来 —— 这正是网速慢时会发生的情况
        let frame = format!(
            "{{\"bytes\":\"{}\"}}\n",
            base64::engine::general_purpose::STANDARD.encode(b"HELLO\r\n")
        );
        let bytes = frame.as_bytes();
        let mut pending = Vec::new();
        assert!(push_herdr_bytes(&mut pending, &bytes[..5]).is_empty());
        assert!(push_herdr_bytes(&mut pending, &bytes[5..11]).is_empty());
        let got = push_herdr_bytes(&mut pending, &bytes[11..]);
        assert_eq!(got, vec![StreamLine::Data(b"HELLO\r\n".to_vec())]);
        assert!(pending.is_empty(), "完整行解完之后不该留东西");

        // 一片里塞两行半：前两行要立刻出来，剩下的半行留着
        let two = format!(
            "{{\"bytes\":\"{}\"}}\n{{\"bytes\":\"{}\"}}\n{{\"bytes\":",
            base64::engine::general_purpose::STANDARD.encode(b"AA"),
            base64::engine::general_purpose::STANDARD.encode(b"BB")
        );
        let mut p2 = Vec::new();
        let got2 = push_herdr_bytes(&mut p2, two.as_bytes());
        assert_eq!(
            got2,
            vec![
                StreamLine::Data(b"AA".to_vec()),
                StreamLine::Data(b"BB".to_vec())
            ]
        );
        assert!(!p2.is_empty(), "半截行必须留在缓冲里");
        // 非 JSON 的错误文本要原样带出去（否则用户什么都看不到）
        let mut p3 = Vec::new();
        assert_eq!(
            push_herdr_bytes(&mut p3, b"herdr: boom\n"),
            vec![StreamLine::Other(b"herdr: boom\n".to_vec())]
        );
        // 关流记录要被认出来（不能打成一行 JSON 丢到终端里）
        let mut p4 = Vec::new();
        assert!(matches!(
            push_herdr_bytes(&mut p4, b"{\"type\":\"terminal.closed\",\"reason\":\"detached\"}\n")[0],
            StreamLine::Closed(_)
        ));
        // 空数据帧直接丢掉，不浪费一次 IPC
        let mut p5 = Vec::new();
        assert!(push_herdr_bytes(&mut p5, b"{\"bytes\":\"\"}\n").is_empty());
        // 半截 JSON 留在缓冲里，不能当成"其它内容"打到屏幕上
        let mut p6 = Vec::new();
        assert!(push_herdr_bytes(&mut p6, b"{\"bytes\":\"YWJ").is_empty());
        assert_eq!(p6, b"{\"bytes\":\"YWJ".to_vec());
        assert_eq!(
            push_herdr_bytes(&mut p6, b"j\"}\n"),
            // "YWJj" → "abc"（半截 + 剩下的拼起来才是一个完整帧）
            vec![StreamLine::Data(b"abc".to_vec())]
        );
    }

    // ---------- 输出合并 / 背压 ----------

    #[test]
    fn batch_waits_16ms_for_plain_output() {
        let t0 = Instant::now();
        let mut b = BatchBuffer::new();
        b.push(b"partial line", t0);
        assert_eq!(b.due(t0 + Duration::from_millis(15)), None);
        assert_eq!(
            b.due(t0 + FLUSH_INTERVAL),
            Some(FlushReason::Timer),
            "没有换行的普通输出按 16ms 合并"
        );
    }

    #[test]
    fn newline_uses_5ms_fast_window_not_per_line_ipc() {
        let t0 = Instant::now();
        let mut b = BatchBuffer::new();
        b.push(b"line 1\n", t0);
        assert_eq!(b.due(t0 + Duration::from_millis(4)), None);
        assert_eq!(
            b.due(t0 + INTERACTIVE_FLUSH_INTERVAL),
            Some(FlushReason::Interactive),
            "换行/控制序列要尽快可见，但仍保留 5ms 合并窗口"
        );

        // 同一窗口里继续到达的行要合并进同一批，而不是一行一个 IPC。
        let mut b2 = BatchBuffer::new();
        b2.push(b"line 1\n", t0);
        b2.push(b"line 2\n", t0 + Duration::from_millis(1));
        b2.push(b"\x1b[31mline 3\x1b[0m\r\n", t0 + Duration::from_millis(2));
        assert_eq!(b2.due(t0 + Duration::from_millis(4)), None);
        assert_eq!(
            b2.due(t0 + INTERACTIVE_FLUSH_INTERVAL),
            Some(FlushReason::Interactive)
        );
    }

    #[test]
    fn batch_flushes_at_64kb_and_1mb_hard_cap() {
        let t0 = Instant::now();
        let mut b = BatchBuffer::new();
        b.push(&vec![b'x'; FLUSH_BYTES], t0);
        assert_eq!(b.due(t0), Some(FlushReason::Bytes));

        let mut hard = BatchBuffer::new();
        hard.push(&vec![b'y'; MAX_BUFFER_BYTES], t0);
        assert_eq!(
            hard.due(t0),
            Some(FlushReason::HardLimit),
            "1MB 硬上限必须在时间/换行之前兜底，缓冲不允许无界增长"
        );
    }

    #[test]
    fn batching_preserves_byte_order_and_ansi_sequences() {
        let t0 = Instant::now();
        let mut b = BatchBuffer::new();
        // 故意把一条 ANSI 序列拆到两片里，模拟 PTY read 的边界
        b.push(b"\x1b[3", t0);
        b.push(b"1mhello\x1b[0m\r\n", t0 + Duration::from_millis(1));
        b.push(b"world", t0 + Duration::from_millis(2));
        let out = b.take();
        assert_eq!(out, b"\x1b[31mhello\x1b[0m\r\nworld".to_vec());
        assert!(b.is_empty());
        assert_eq!(b.due(t0 + Duration::from_secs(1)), None);
    }

    #[test]
    fn ack_window_allows_two_then_pauses_and_resumes() {
        let c = PumpControl::new();
        assert_eq!(c.wait_for_room(Duration::from_millis(1)), AckWait::Ready);
        let now = Instant::now();
        let s1 = c.register_batch(60, now);
        let s2 = c.register_batch(60, now);
        assert!(c.is_paused(), "2 个未确认批次后必须暂停 reader");
        assert_eq!(
            c.wait_for_room(Duration::from_millis(5)),
            AckWait::TimedOut
        );

        // 累积 ack：确认 s1 后窗口降到 1，reader 可以继续
        assert!(c.ack(s1));
        assert!(!c.is_paused());
        assert_eq!(c.wait_for_room(Duration::from_millis(1)), AckWait::Ready);
        assert!(c.ack(s2));
        assert_eq!(c.backlog_bytes(), 0);
        assert!(!c.is_paused());
    }

    #[test]
    fn stale_and_garbage_acks_are_ignored() {
        let c = PumpControl::new();
        let now = Instant::now();
        let s1 = c.register_batch(10, now);
        let s2 = c.register_batch(10, now);
        // s2 累积确认了两批
        assert!(c.ack(s2));
        assert_eq!(c.backlog_bytes(), 0);
        // 迟到的 s1 是重复确认，不能把 acked_upto 退回去
        assert!(c.ack(s1));
        assert_eq!(c.backlog_bytes(), 0);
        assert!(!c.ack(99), "确认一个还没发出的 seq 必须被拒绝");
        assert!(!c.ack(0), "seq 从 1 开始");
    }

    #[test]
    fn ack_timeout_fallback_recovers_a_lost_ack() {
        let c = PumpControl::new();
        let now = Instant::now();
        let s1 = c.register_batch(60, now);
        let s2 = c.register_batch(60, now);
        assert!(c.is_paused());

        assert!(
            c.expire_oldest(now + Duration::from_millis(500), ACK_TIMEOUT)
                .is_none(),
            "不到 1 秒不能提前丢批次"
        );
        let (expired, bytes, age) = c
            .expire_oldest(now + ACK_TIMEOUT, ACK_TIMEOUT)
            .expect("超过 1 秒必须推进窗口");
        assert_eq!(expired, s1);
        assert_eq!(bytes, 60);
        assert!(age >= ACK_TIMEOUT);
        assert!(!c.is_paused(), "超时推进后 reader 必须恢复");
        assert_eq!(c.wait_for_room(Duration::from_millis(1)), AckWait::Ready);

        // s1 的迟到 ack 已经无效；s2 仍然可以正常确认
        assert!(c.ack(s1));
        assert_eq!(c.backlog_bytes(), 60);
        assert!(c.ack(s2));
        assert_eq!(c.backlog_bytes(), 0);
    }

    #[test]
    fn ack_command_for_unknown_session_is_a_noop() {
        // 串口 / herdr 没有输出泵；前端误发 ack 不能 panic。
        ack_output("no-such-session", 1);
    }
}
