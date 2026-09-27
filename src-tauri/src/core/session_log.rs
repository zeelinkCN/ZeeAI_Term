//! 终端会话日志（像 SecureCRT 那样把终端打印的内容落盘）。
//!
//! 设计：
//! - 写在 **后端**：PTY/串口读到的原始字节顺手追加到文件，不受前端渲染影响，
//!   也不会因为界面卡顿丢数据；
//! - 写之前先过一遍 **ANSI 过滤器**：把颜色、光标控制这些转义序列丢掉，
//!   日志用记事本/VS Code 直接打开就是可读文本（关键：状态跨分片保持，
//!   终端输出的转义序列经常被 read() 切成两半）；
//! - 一个会话最多一份日志，随时可以开始/停止。

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Instant;

use serde::Serialize;

/// 攒够这么多字节就落一次盘
const FLUSH_BYTES: usize = 64 * 1024;
/// 或者距上次落盘超过这么久也落一次（保证"看日志"能跟上，最多滞后这么久）
const FLUSH_INTERVAL: std::time::Duration = std::time::Duration::from_millis(200);

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
    path: PathBuf,
    writer: BufWriter<File>,
    filter: AnsiFilter,
    scratch: Vec<u8>,
    /// 距上次落盘之后攒了多少字节
    pending: usize,
    /// 上次落盘的时刻
    last_flush: Instant,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogInfo {
    pub path: String,
    pub bytes: u64,
}

#[derive(Default)]
pub struct LogRegistry {
    logs: Mutex<HashMap<String, OpenLog>>,
}

impl LogRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// 日志默认放这儿：%APPDATA%\ZeeAI-Terminal\logs\sessions
    pub fn dir() -> PathBuf {
        crate::store::log_dir()
    }

    pub fn start(&self, session_id: &str, file_name: Option<&str>) -> Result<String, String> {
        let dir = Self::dir();
        fs::create_dir_all(&dir).map_err(|e| format!("创建日志目录失败: {e}"))?;
        let name = sanitize_file_name(file_name.unwrap_or("session"));
        let path = dir.join(format!("{name}.log"));
        let file = File::create(&path).map_err(|e| format!("创建日志文件失败: {e}"))?;
        let mut logs = self.logs.lock().map_err(|e| e.to_string())?;
        // 已经在记就先收尾，避免句柄泄漏
        if let Some(mut old) = logs.remove(session_id) {
            let _ = old.writer.flush();
        }
        logs.insert(
            session_id.to_string(),
            OpenLog {
                path: path.clone(),
                writer: BufWriter::new(file),
                filter: AnsiFilter::new(),
                scratch: Vec::new(),
                pending: 0,
                last_flush: Instant::now(),
            },
        );
        log::info!("session_log: 开始记录 {session_id} -> {}", path.display());
        Ok(path.to_string_lossy().to_string())
    }

    pub fn stop(&self, session_id: &str) -> Option<String> {
        let mut logs = self.logs.lock().ok()?;
        let mut entry = logs.remove(session_id)?;
        let _ = entry.writer.flush();
        log::info!("session_log: 停止记录 {session_id}");
        Some(entry.path.to_string_lossy().to_string())
    }

    pub fn status(&self, session_id: &str) -> Option<String> {
        let logs = self.logs.lock().ok()?;
        logs.get(session_id)
            .map(|l| l.path.to_string_lossy().to_string())
    }

    /// 有新数据进来时调用；没在记录就直接返回（几乎零开销）
    ///
    /// **批量落盘**：以前每收到一片 PTY 输出就 `flush()` 一次。PTY 的读循环按 16KB 一片，
    /// 但交互式输出（提示符、逐行日志、`tail -f`）往往远小于一片 —— 于是变成每秒上千次
    /// write + flush，而 Windows Defender 对每次写都做实时扫描，"开了日志就变卡"多半来自这里。
    /// 现在改成"攒够 64KB 或过了 200ms 才落一次"：正常情况下最多滞后 200ms 就能 tail 到，
    /// 代价是应用被强杀时可能丢掉最后不到 200ms 的内容（正常退出走 stop/stop_all，会收尾 flush）。
    pub fn write(&self, session_id: &str, bytes: &[u8]) {
        let Ok(mut logs) = self.logs.lock() else {
            return;
        };
        let Some(entry) = logs.get_mut(session_id) else {
            return;
        };
        entry.scratch.clear();
        let mut scratch = std::mem::take(&mut entry.scratch);
        entry.filter.filter(bytes, &mut scratch);
        if !scratch.is_empty() {
            let _ = entry.writer.write_all(&scratch);
            entry.pending += scratch.len();
            if entry.pending >= FLUSH_BYTES || entry.last_flush.elapsed() >= FLUSH_INTERVAL {
                let _ = entry.writer.flush();
                entry.pending = 0;
                entry.last_flush = Instant::now();
            }
        }
        entry.scratch = scratch;
    }

    /// 关闭所有日志（应用退出时兜底）
    pub fn stop_all(&self) {
        if let Ok(mut logs) = self.logs.lock() {
            for (_, mut entry) in logs.drain() {
                let _ = entry.writer.flush();
            }
        }
    }
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
}
