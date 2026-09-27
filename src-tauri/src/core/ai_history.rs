//! AI 任务时间线（G-01）。
//!
//! 为什么需要：看板只显示"当前这一轮"，而 `AiTaskRegistry` 是**内存**里的 ——
//! 应用一关，昨晚跑过的十几个任务就再也查不到了。用户的原话是"我离开电脑再回来，
//! 得知道它干了什么"。所以这里把"每一轮跑完"的事实**落盘**，做成一条可回溯的时间线。
//!
//! 数据来源是前端在"发现新一轮完成"那一刻调用的 [`record`] —— 那一刻它手上有全部信息
//! （服务器、项目目录、AI 最后一段话、耗时、这一轮的产物）。后端只负责"存、去重、限量、读"。

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// 时间线最多保留多少条（够回看最近几百轮，又不至于让文件无限长）
pub const MAX_RECORDS: usize = 300;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiTurnRecord {
    /// 去重键：环境|服务器|会话|完成时间
    #[serde(default)]
    pub id: String,
    /// remote / local / wsl
    #[serde(default)]
    pub env: String,
    /// 服务器名，或本地终端标签
    #[serde(default)]
    pub server: String,
    /// 会话标题（点进去切到这个会话）
    #[serde(default)]
    pub session_title: String,
    /// 这一轮的工作目录
    #[serde(default)]
    pub cwd: String,
    /// 哪个 AI（codex / claude / …）
    #[serde(default)]
    pub tool: String,
    /// 这一轮结束时间（Unix 秒）
    #[serde(default)]
    pub completed_at: i64,
    #[serde(default)]
    pub duration_ms: i64,
    /// AI 最后一段话
    #[serde(default)]
    pub message: String,
    /// 累计 token（以"兆"显示用）
    #[serde(default)]
    pub tokens_total: u64,
    /// 这一轮产出的文件（相对路径或文件名）
    #[serde(default)]
    pub artifacts: Vec<String>,
}

fn file() -> PathBuf {
    crate::store::ai_turns_file()
}

/// 读整条时间线（新的在前）
pub fn list() -> Vec<AiTurnRecord> {
    let Ok(text) = std::fs::read_to_string(file()) else {
        return Vec::new();
    };
    let mut v: Vec<AiTurnRecord> = serde_json::from_str(&text).unwrap_or_default();
    v.sort_by(|a, b| b.completed_at.cmp(&a.completed_at));
    v
}

/// 记一条（按 id 去重）。返回**是不是新记录** —— 前端靠它决定要不要刷新列表。
pub fn record(mut entry: AiTurnRecord) -> bool {
    if entry.id.trim().is_empty() {
        entry.id = format!(
            "{}|{}|{}|{}|{}",
            entry.env, entry.server, entry.session_title, entry.cwd, entry.completed_at
        );
    }
    let mut all = list();
    if let Some(old) = all.iter_mut().find(|r| r.id == entry.id) {
        // 同一条再报一次：把可能补上的字段并进去（例如产物是后一步才算出来的）
        if old.message.is_empty() {
            old.message = entry.message;
        }
        if old.artifacts.is_empty() && !entry.artifacts.is_empty() {
            old.artifacts = entry.artifacts;
        }
        if old.tokens_total == 0 {
            old.tokens_total = entry.tokens_total;
        }
        save(&all);
        return false;
    }
    all.push(entry);
    all.sort_by(|a, b| b.completed_at.cmp(&a.completed_at));
    all.truncate(MAX_RECORDS);
    let ok = save(&all);
    ok
}

/// 清空时间线
pub fn clear() {
    let _ = std::fs::remove_file(file());
}

fn save(all: &[AiTurnRecord]) -> bool {
    match serde_json::to_string_pretty(all) {
        Ok(text) => crate::store::write_ai_turns(&text).is_ok(),
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(at: i64, msg: &str, artifacts: Vec<String>) -> AiTurnRecord {
        AiTurnRecord {
            id: String::new(),
            env: "remote".into(),
            server: "lz".into(),
            session_title: "codexAAA".into(),
            cwd: "/home/lz".into(),
            tool: "codex".into(),
            completed_at: at,
            duration_ms: 1234,
            message: msg.into(),
            tokens_total: 42,
            artifacts,
        }
    }

    /// 只测"去重键 + 合并"这层纯逻辑，不碰真实配置目录
    #[test]
    fn dedupe_key_is_stable_and_merges_late_fields() {
        let mut a = rec(100, "", vec![]);
        a.id = format!("{}|{}|{}|{}|{}", a.env, a.server, a.session_title, a.cwd, a.completed_at);
        let b = rec(100, "补上的消息", vec!["out.md".into()]);
        assert_eq!(a.id, format!("{}|{}|{}|{}|{}", b.env, b.server, b.session_title, b.cwd, b.completed_at),
            "同一条记录的键必须一致，否则会重复");
        // 合并规则：空字段才补
        if a.message.is_empty() {
            a.message = b.message.clone();
        }
        if a.artifacts.is_empty() {
            a.artifacts = b.artifacts.clone();
        }
        assert_eq!(a.message, "补上的消息");
        assert_eq!(a.artifacts, vec!["out.md".to_string()]);
    }
}
