use std::collections::HashMap;
use std::io::Write;
use std::sync::{Arc, Mutex};

use portable_pty::{Child, MasterPty};
use serde::Serialize;

/// 后端推给前端的会话事件。data 字段是 base64 编码的字节流，
/// 这样前端可以直接喂给 xterm.write(Uint8Array)，也不会在 UTF-8 边界上出问题。
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
#[allow(dead_code)]
pub enum SessionEvent {
    Data {
        data: String,
        /// PTY 输出泵的批次号（从 1 开始，单调递增）。前端写进 xterm 后用
        /// `session_output_ack` 回传，后端据此维持「最多 2 个未确认批次」的背压。
        ///
        /// 串口 / herdr 这类不走 PTY 输出泵的流没有批次号，所以是 Option。
        /// 不改变 data 的字节内容（仍是原始 PTY 字节的 base64）。
        #[serde(skip_serializing_if = "Option::is_none")]
        seq: Option<u64>,
    },
    State { state: String },
    Error { message: String },
    Title { title: String },
}

pub struct SessionHandle {
    #[allow(dead_code)]
    pub kind: String,
    #[allow(dead_code)]
    pub title: String,
    pub writer: Arc<Mutex<Box<dyn Write + Send>>>,
    /// 只有 PTY 会话有；串口会话为 None
    pub master: Option<Arc<Mutex<Box<dyn MasterPty + Send>>>>,
    /// 只有子进程会话有；串口会话为 None
    pub child: Option<Arc<Mutex<Box<dyn Child + Send + Sync>>>>,
}

pub struct SessionRegistry {
    pub sessions: Mutex<HashMap<String, SessionHandle>>,
}

impl SessionRegistry {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }
}

impl Default for SessionRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// herdr 观察窗的会话元信息。
///
/// 为什么要单独记一份：herdr 的 `terminal session observe` 允许在**开流的时候**声明
/// 自己要看多大（`--cols/--rows`）。用户拖动窗口改变尺寸时，我们得把这条流重开一次，
/// 而重开需要"这台机器是谁、哪个窗格、推到哪个 Channel" —— 这些都在这里。
///
/// 注意：它**不是**会话本体的所有权（会话本体在 SessionRegistry 里），
/// 所以 `session_close` 时要两边都清掉。
pub struct HerdrPaneMeta {
    pub profile_id: String,
    pub user: Option<String>,
    pub pane_id: String,
    /// "observe"（只读观察窗）/ "control"（可读可写，就是"进到她的环境里"那条）
    pub mode: String,
    pub cols: u16,
    pub rows: u16,
    pub channel: tauri::ipc::Channel<SessionEvent>,
    /// 「这次结束是我让你停的」标志：重开 observe 流之前把它置上，
    /// 旧读取线程就不会误报 "closed"（见 pty::SpawnOpts 的说明）。
    pub close_flag: Arc<std::sync::atomic::AtomicBool>,
}

/// 一条常驻的 herdr「输入泵」：一个 ssh 子进程 + 它的 stdin（指令通道）。
///
/// **为什么要留着 `Child`**（架构审查 minor-01）：以前只把 stdin 存进表里、把 `Child`
/// 直接 drop 了。问题是远端 ssh 死掉（网络断、服务器踢人、herdr 退出）时我们**根本不知道**
/// —— 管道这一端还开着，写进去不报错，只是没人读。界面表现就是"能打字，字进不去"。
///
/// 现在 `Child` 和 stdin 存在一起：
/// - 写入前先 `try_wait()` 判活（见 `commands::herdr_write_input`），死了就报错 + 清表，
///   下一次输入会自动重开一条；
/// - 会话关闭时显式 `kill()`（不再只靠"关 stdin → 远端 read 拿到 EOF"）。
pub struct HerdrInputPump {
    pub child: Mutex<std::process::Child>,
    pub stdin: Mutex<std::process::ChildStdin>,
}

#[derive(Default)]
pub struct HerdrPaneRegistry {
    pub panes: Mutex<HashMap<String, HerdrPaneMeta>>,
    /// 每个 herdr 观察窗配一个常驻的「输入泵」（一条 ssh，stdin 就是指令通道）。
    /// 会话关掉时把它从表里移除 = 关掉 stdin = 远端 `read` 拿到 EOF 自己退出。
    ///
    /// 为什么再套一层 `Arc<Mutex<..>>`：`ChildStdin` 不能克隆，而写入是**阻塞**操作，
    /// 必须能把它挪到阻塞线程里去写（不能占着主线程，也不能占着这张表）。
    pub inputs: Mutex<HashMap<String, Arc<HerdrInputPump>>>,
}
