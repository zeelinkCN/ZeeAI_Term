//! 终端会话日志（像 SecureCRT 那样把终端打印的内容落盘）。
//!
//! 设计：
//! - 写在 **后端**：PTY/串口读到的原始字节顺手追加到文件，不受前端渲染影响，
//!   也不会因为界面卡顿丢数据；
//! - 写之前先过一遍 **ANSI 过滤器**：把颜色、光标控制这些转义序列丢掉，
//!   日志用记事本/VS Code 直接打开就是可读文本（关键：状态跨分片保持，
//!   终端输出的转义序列经常被 read() 切成两半）；
//! - 一个会话最多一份日志，随时可以开始/停止。
//!
//! 并发与磁盘（2026-10 架构审查的修复）：
//! - 文件名总是拼 session_id 的短哈希，`create_new(true).append(true)` 打开；
//!   同名冲突就加后缀，**绝不 `File::create` 截断别人的日志**；
//! - 全局 `logs` 锁里**只克隆 `Arc<Mutex<OpenLog>>`**，拿完立刻放锁；
//!   `write_all` / `flush` / 轮转都在锁外（每个日志自己的互斥锁内）做；
//! - 单文件 64MB 后轮转，文件名 `...-1.log`、`...-2.log`，长会话不会无限长；
//! - 关日志时没有日志的会话完全不碰互斥锁（`active` 原子计数短路）。

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;

/// 攒够这么多字节就落一次盘
const FLUSH_BYTES: usize = 64 * 1024;
/// 或者距上次落盘超过这么久也落一次（保证"看日志"能跟上，最多滞后这么久）
const FLUSH_INTERVAL: Duration = Duration::from_millis(200);
/// 单个日志文件上限；到了就自动换新文件（防止长会话无限增长）
const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;

/// ANSI/控制序列过滤器。
#[derive(Default)]
pub struct AnsiFilter {
    state: u8,
    /// 见到了一个 CR，但还不知道它后面跟不跟 LF（`\r\n` 要算**一个**换行）
    pending_cr: bool,
}

impl AnsiFilter {
    pub fn new() -> Self {
        Self {
            state: 0,
            pending_cr: false,
        }
    }

    /// 把 input 过滤后追加到 out
    pub fn filter(&mut self, input: &[u8], out: &mut Vec<u8>) {
        for &b in input {
            // 先把"挂起的 CR"结掉。
            //
            // 以前 CR 是**直接丢掉**的（理由是"避免 \r\n 变成两个换行"）。问题是
            // `docker pull` / `curl` / `npm install` 这类**用 \r 原地刷新的进度输出**根本没有 LF，
            // 丢掉 CR 就等于把一次次刷新拼成一条没有分隔的超长行，日志没法读。
            // 现在：CR 后面跟 LF → 一个换行（和以前一样）；CR 后面跟别的 → 一个换行。
            if self.pending_cr {
                self.pending_cr = false;
                out.push(b'\n');
                if b == b'\n' {
                    continue; // CRLF 已经用掉这个 LF，别再输出第二个换行
                }
            }
            match self.state {
                // 正常文本
                0 => match b {
                    0x1b => self.state = 1, // ESC
                    0x0d => self.pending_cr = true,
                    0x08 => {
                        // 退格：删掉已经写出的最后一个字符
                        if out.last().map(|c| *c != b'\n').unwrap_or(false) {
                            out.pop();
                        }
                    }
                    0x07 => {} // 响铃
                    _ => out.push(b),
                },
                // ESC 之后的第一个字节决定序列类型
                1 => match b {
                    b'[' => self.state = 2, // CSI
                    b']' => self.state = 3, // OSC
                    _ => self.state = 0,    // 其他两字节序列，整段丢掉
                },
                // CSI：直到 0x40..=0x7e 结束
                2 => {
                    if (0x40..=0x7e).contains(&b) {
                        self.state = 0;
                    }
                }
                // OSC：直到 BEL 或 ESC \
                3 => {
                    if b == 0x07 {
                        self.state = 0;
                    } else if b == 0x1b {
                        self.state = 4;
                    }
                }
                4 => self.state = 0,
                _ => self.state = 0,
            }
        }
    }
}

struct OpenLog {
    dir: PathBuf,
    /// 不带扩展名的文件名（含 session_id 短哈希），轮转时当前缀
    stem: String,
    path: PathBuf,
    writer: BufWriter<File>,
    filter: AnsiFilter,
    scratch: Vec<u8>,
    /// 距上次落盘之后攒了多少字节
    pending: usize,
    /// 上次落盘的时刻
    last_flush: Instant,
    /// 当前文件已经写入多少字节（按追加打开时文件现有长度起算）
    file_bytes: u64,
    /// 单文件上限；测试会把它调小
    max_file_bytes: u64,
    /// 当前文件后缀编号（0 = 无后缀；轮转/冲突时递增）
    part: u32,
}

impl OpenLog {
    fn open(dir: &Path, stem: &str, max_file_bytes: u64) -> Result<Self, String> {
        let (path, file, part) = open_part(dir, stem, 0)?;
        let file_bytes = file.metadata().map(|m| m.len()).unwrap_or(0);
        Ok(Self {
            dir: dir.to_path_buf(),
            stem: stem.to_string(),
            path,
            writer: BufWriter::new(file),
            filter: AnsiFilter::new(),
            scratch: Vec::new(),
            pending: 0,
            last_flush: Instant::now(),
            file_bytes,
            max_file_bytes,
            part,
        })
    }

    /// 换一个新文件。**先 flush 旧文件**，再 create_new 新文件。
    fn rotate(&mut self) -> Result<(), String> {
        let _ = self.writer.flush();
        let (path, file, part) = open_part(&self.dir, &self.stem, self.part.saturating_add(1))?;
        let old = self.path.clone();
        self.writer = BufWriter::new(file);
        self.path = path.clone();
        self.part = part;
        self.file_bytes = 0;
        self.pending = 0;
        self.last_flush = Instant::now();
        log::info!(
            "session_log: 轮转 {} -> {}",
            old.display(),
            path.display()
        );
        Ok(())
    }

    fn write_filtered(&mut self, bytes: &[u8]) {
        self.scratch.clear();
        let mut scratch = std::mem::take(&mut self.scratch);
        self.filter.filter(bytes, &mut scratch);
        if !scratch.is_empty() {
            // 单文件到上限就换新文件；跨上限的这一片整体写进新文件，不截断。
            if self.file_bytes > 0
                && self
                    .file_bytes
                    .saturating_add(scratch.len() as u64)
                    > self.max_file_bytes
            {
                if let Err(e) = self.rotate() {
                    // 轮转失败不能让日志停摆，更不能 panic：继续写当前文件，
                    // 并把上限抬高避免每次写都重试（错误已经记了 warn）。
                    log::warn!("session_log: 轮转失败（继续写当前文件）：{e}");
                    self.max_file_bytes = u64::MAX;
                }
            }
            match self.writer.write_all(&scratch) {
                Ok(()) => {
                    self.file_bytes = self.file_bytes.saturating_add(scratch.len() as u64);
                    self.pending += scratch.len();
                }
                Err(e) => log::warn!(
                    "session_log: 写入 {} 失败：{e}",
                    self.path.display()
                ),
            }
            if self.pending >= FLUSH_BYTES || self.last_flush.elapsed() >= FLUSH_INTERVAL {
                if let Err(e) = self.writer.flush() {
                    log::warn!("session_log: flush {} 失败：{e}", self.path.display());
                }
                self.pending = 0;
                self.last_flush = Instant::now();
            }
        }
        self.scratch = scratch;
    }

    fn flush_now(&mut self) {
        if let Err(e) = self.writer.flush() {
            log::warn!("session_log: flush {} 失败：{e}", self.path.display());
        }
        self.pending = 0;
        self.last_flush = Instant::now();
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogInfo {
    pub path: String,
    pub bytes: u64,
}

pub struct LogRegistry {
    /// 全局注册表：锁里只做 map 操作，磁盘 I/O 不在这把锁内。
    logs: Mutex<HashMap<String, Arc<Mutex<OpenLog>>>>,
    /// 没有日志在记时用原子数短路，连 map 锁都不碰。
    active: AtomicUsize,
    dir: PathBuf,
    max_file_bytes: u64,
}

impl Default for LogRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl LogRegistry {
    pub fn new() -> Self {
        Self {
            logs: Mutex::new(HashMap::new()),
            active: AtomicUsize::new(0),
            dir: Self::dir(),
            max_file_bytes: MAX_FILE_BYTES,
        }
    }

    #[cfg(test)]
    fn with_limits(dir: PathBuf, max_file_bytes: u64) -> Self {
        Self {
            logs: Mutex::new(HashMap::new()),
            active: AtomicUsize::new(0),
            dir,
            max_file_bytes,
        }
    }

    /// 日志默认放这儿：%APPDATA%\ZeeAI-Terminal\logs\sessions
    pub fn dir() -> PathBuf {
        crate::store::log_dir()
    }

    pub fn start(&self, session_id: &str, file_name: Option<&str>) -> Result<String, String> {
        fs::create_dir_all(&self.dir).map_err(|e| format!("创建日志目录失败: {e}"))?;
        let name = sanitize_file_name(file_name.unwrap_or("session"));
        // 同名 + 不同 session 不再互相截断：文件名里带 session_id 的短哈希。
        let stem = format!("{name}-{:08x}", short_hash(session_id));
        // 关键：磁盘 I/O 在全局锁外做。
        let entry = OpenLog::open(&self.dir, &stem, self.max_file_bytes)?;
        let path = entry.path.to_string_lossy().to_string();
        let replace = Arc::new(Mutex::new(entry));

        let old = {
            let mut logs = self.logs.lock().map_err(|e| e.to_string())?;
            let existed = logs.contains_key(session_id);
            let old = logs.insert(session_id.to_string(), replace);
            if !existed {
                self.active.fetch_add(1, Ordering::Relaxed);
            }
            old
        };
        // 旧句柄的 flush 也在锁外。
        if let Some(old) = old {
            if let Ok(mut old) = old.lock() {
                old.flush_now();
            }
        }
        log::info!("session_log: 开始记录 {session_id} -> {path}");
        Ok(path)
    }

    pub fn stop(&self, session_id: &str) -> Option<String> {
        let entry = {
            let mut logs = self.logs.lock().ok()?;
            let entry = logs.remove(session_id);
            if entry.is_some() {
                self.active.fetch_sub(1, Ordering::Relaxed);
            }
            entry
        };
        let entry = entry?;
        let mut entry = entry.lock().ok()?;
        entry.flush_now();
        let path = entry.path.to_string_lossy().to_string();
        drop(entry);
        log::info!("session_log: 停止记录 {session_id}");
        Some(path)
    }

    pub fn status(&self, session_id: &str) -> Option<String> {
        // 先克隆 Arc、放掉全局锁，再读当前路径（路径可能因轮转变化）。
        let entry = {
            let logs = self.logs.lock().ok()?;
            logs.get(session_id).cloned()
        }?;
        let entry = entry.lock().ok()?;
        Some(entry.path.to_string_lossy().to_string())
    }

    /// 有新数据进来时调用；没在记录就直接返回（几乎零开销）
    ///
    /// **批量落盘**：以前每收到一片 PTY 输出就 `flush()` 一次。PTY 的读循环按 16KB 一片，
    /// 但交互式输出（提示符、逐行日志、`tail -f`）往往远小于一片 —— 于是变成每秒上千次
    /// write + flush，而 Windows Defender 对每次写都做实时扫描，"开了日志就变卡"多半来自这里。
    /// 现在改成"攒够 64KB 或过了 200ms 才落一次"：正常情况下最多滞后 200ms 就能 tail 到，
    /// 代价是应用被强杀时可能丢掉最后不到 200ms 的内容（正常退出走 stop/stop_all，会收尾 flush）。
    pub fn write(&self, session_id: &str, bytes: &[u8]) {
        if self.active.load(Ordering::Relaxed) == 0 {
            return;
        }
        // 全局限锁只到这一行为止：克隆出这个日志自己的 Arc，然后立刻放锁。
        let entry = {
            let Ok(logs) = self.logs.lock() else {
                return;
            };
            logs.get(session_id).cloned()
        };
        let Some(entry) = entry else {
            return;
        };
        // 这里才做 ANSI 过滤和 write/flush；锁是"这个日志自己的"，
        // 不挡别的会话开/停/写，也不进入全局注册表的临界区。
        if let Ok(mut entry) = entry.lock() {
            entry.write_filtered(bytes);
        };
    }

    /// 关闭所有日志（应用退出时兜底）
    pub fn stop_all(&self) {
        let entries: Vec<Arc<Mutex<OpenLog>>> = {
            let Ok(mut logs) = self.logs.lock() else {
                return;
            };
            self.active.store(0, Ordering::Relaxed);
            logs.drain().map(|(_, entry)| entry).collect()
        };
        // 全部在全局锁外 flush。
        for entry in entries {
            if let Ok(mut entry) = entry.lock() {
                entry.flush_now();
            }
        }
    }
}

/// FNV-1a 32-bit。只用来给文件名一个稳定短后缀（不用于安全用途）。
fn short_hash(s: &str) -> u32 {
    let mut hash: u32 = 0x811c_9dc5;
    for b in s.as_bytes() {
        hash ^= *b as u32;
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash
}

/// 打开 `stem.log` / `stem-1.log` / …；冲突就递增，绝不截断已有文件。
fn open_part(dir: &Path, stem: &str, mut part: u32) -> Result<(PathBuf, File, u32), String> {
    for _ in 0..10_000 {
        let name = if part == 0 {
            format!("{stem}.log")
        } else {
            format!("{stem}-{part}.log")
        };
        let path = dir.join(name);
        match OpenOptions::new()
            .create_new(true)
            .append(true)
            .open(&path)
        {
            Ok(file) => return Ok((path, file, part)),
            Err(e) if e.kind() == ErrorKind::AlreadyExists => {
                part = part.saturating_add(1);
                continue;
            }
            Err(e) => {
                return Err(format!("创建日志文件 {} 失败: {e}", path.display()));
            }
        }
    }
    Err("创建日志文件失败：同名冲突过多".to_string())
}

fn sanitize_file_name(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '-',
            c if c.is_control() => '-',
            c => c,
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').to_string();
    if trimmed.is_empty() {
        "session".to_string()
    } else {
        trimmed.chars().take(80).collect()
    }
}

/// 供命令层用：把用户给的绝对路径做一层校验，不让写到奇怪的地方
pub fn ensure_log_parent(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_dir(tag: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "zeeai-log-{tag}-{}-{nanos}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn filt(chunks: &[&[u8]]) -> String {
        let mut f = AnsiFilter::new();
        let mut out = Vec::new();
        for c in chunks {
            f.filter(c, &mut out);
        }
        String::from_utf8_lossy(&out).to_string()
    }

    #[test]
    fn strips_color_codes() {
        assert_eq!(filt(&[b"\x1b[32mhello\x1b[0m"]), "hello");
    }

    #[test]
    fn handles_sequence_split_across_reads() {
        // 转义序列被 read() 切成两半也要正确处理
        assert_eq!(filt(&[b"ab\x1b[3", b"2mcd"]), "abcd");
    }

    #[test]
    fn drops_carriage_return_keeps_newline() {
        assert_eq!(filt(&[b"line1\r\nline2"]), "line1\nline2");
    }

    #[test]
    fn lone_carriage_return_becomes_newline() {
        // 进度条风格（docker pull / curl / npm）靠 \r 原地刷新，没有 LF。
        // 日志里必须断开成多行，否则一整轮进度会被拼成一条读不了的长行。
        assert_eq!(filt(&[b"10%\r50%\r100%\n"]), "10%\n50%\n100%\n");
        // CR 出现在分片边界上也要成立
        assert_eq!(filt(&[b"aaa\r", b"bbb"]), "aaa\nbbb");
    }

    #[test]
    fn strips_osc_title() {
        assert_eq!(filt(&[b"\x1b]0;title\x07body"]), "body");
    }

    #[test]
    fn backspace_deletes_previous_char() {
        assert_eq!(filt(&[b"abc\x08d"]), "abd");
    }

    #[test]
    fn file_name_contains_session_hash_and_never_truncates() {
        let dir = unique_dir("collision");
        let a = LogRegistry::with_limits(dir.clone(), MAX_FILE_BYTES);
        let b = LogRegistry::with_limits(dir.clone(), MAX_FILE_BYTES);

        let p1 = a.start("session-a", Some("same-name")).unwrap();
        a.write("session-a", b"first-content\n");
        let p2 = b.start("session-b", Some("same-name")).unwrap();
        b.write("session-b", b"second-content\n");

        assert_ne!(p1, p2, "同名日志不能互相截断");
        assert!(p1.contains("same-name-"), "文件名要拼会话短哈希: {p1}");
        assert!(p2.contains("same-name-"), "文件名要拼会话短哈希: {p2}");

        a.stop("session-a");
        b.stop("session-b");
        assert_eq!(fs::read_to_string(&p1).unwrap(), "first-content\n");
        assert_eq!(fs::read_to_string(&p2).unwrap(), "second-content\n");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn restarting_same_session_uses_new_file_not_create_truncate() {
        let dir = unique_dir("restart");
        let reg = LogRegistry::with_limits(dir.clone(), MAX_FILE_BYTES);
        let p1 = reg.start("same-session", Some("restart")).unwrap();
        reg.write("same-session", b"old\n");
        let p2 = reg.start("same-session", Some("restart")).unwrap();
        assert_ne!(p1, p2);
        reg.write("same-session", b"new\n");
        reg.stop("same-session");
        assert_eq!(fs::read_to_string(&p1).unwrap(), "old\n");
        assert_eq!(fs::read_to_string(&p2).unwrap(), "new\n");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rotates_file_after_size_limit() {
        let dir = unique_dir("rotate");
        let reg = LogRegistry::with_limits(dir.clone(), 100);
        let p1 = reg.start("rot", Some("rot")).unwrap();
        reg.write("rot", &vec![b'a'; 80]);
        // 第二次写会让 80+80 > 100 → 先轮转，再写新文件
        reg.write("rot", &vec![b'b'; 80]);
        let p2 = reg.status("rot").unwrap();
        reg.stop("rot");

        assert_ne!(p1, p2, "超过 64MB（测试里是 100B）后必须换文件");
        let first = fs::read(&p1).unwrap();
        let second = fs::read(&p2).unwrap();
        assert_eq!(first.len(), 80);
        assert_eq!(second.len(), 80);
        assert!(first.iter().all(|b| *b == b'a'));
        assert!(second.iter().all(|b| *b == b'b'));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_without_active_log_is_noop() {
        let dir = unique_dir("noop");
        let reg = LogRegistry::with_limits(dir.clone(), MAX_FILE_BYTES);
        reg.write("nobody", b"ignored");
        assert_eq!(reg.active.load(Ordering::Relaxed), 0);
        assert!(fs::read_dir(&dir).unwrap().next().is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn concurrent_sessions_do_not_deadlock_each_other() {
        let dir = unique_dir("concurrent");
        let reg = Arc::new(LogRegistry::with_limits(dir.clone(), MAX_FILE_BYTES));
        let mut handles = Vec::new();
        for t in 0..4 {
            let reg = reg.clone();
            handles.push(std::thread::spawn(move || {
                let id = format!("s{t}");
                reg.start(&id, Some("concurrent")).unwrap();
                for _ in 0..100 {
                    reg.write(&id, b"0123456789");
                    let _ = reg.status(&id);
                }
                reg.stop(&id);
            }));
        }
        for h in handles {
            h.join().unwrap();
        }
        let files: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .collect();
        assert_eq!(files.len(), 4);
        for f in files {
            let len = fs::metadata(f.path()).unwrap().len();
            assert_eq!(len, 1000, "每个会话 100 次 × 10 字节都要落盘");
        }
        let _ = fs::remove_dir_all(&dir);
    }
}
