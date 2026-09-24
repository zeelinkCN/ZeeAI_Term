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
    Data { data: String },
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
