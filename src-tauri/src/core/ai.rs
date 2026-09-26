//! 服务器上的 AI 命令行工具（Codex / Claude Code / Aider / Gemini CLI）探测与安装。
//!
//! 设计取舍：
//! - 探测/安装在**远端**跑（用的是这台服务器上的 node/npm/pip），
//!   所以我们只要把一条 shell 命令丢过去、解析结果就行；
//! - "任务完成通知"靠**进程是否还在**判断：启动时进程在 → 运行中；
//!   进程消失 → 认为这一轮任务结束，弹通知。这比解析终端输出可靠得多。

use serde::Serialize;

/// 我们支持的 AI 工具
pub const TOOLS: [&str; 4] = ["codex", "claude", "aider", "gemini"];

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiTool {
    pub name: String,
    pub label: String,
    pub installed: bool,
    pub version: String,
    /// 安装用的命令（展示给用户看，也用于一键安装）
    pub install_cmd: String,
    /// 启动命令（在终端里敲的）
    pub run_cmd: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProbe {
    pub tools: Vec<AiTool>,
    /// 远端的 npm 版本，空串表示没装 npm
    pub npm: String,
    /// 当前正在运行的 AI 进程（可能多个）
    pub running: Vec<String>,
}

fn label_of(name: &str) -> &str {
    match name {
        "codex" => "OpenAI Codex CLI",
        "claude" => "Claude Code",
        "aider" => "Aider",
        "gemini" => "Gemini CLI",
        _ => name,
    }
}

fn install_cmd_of(name: &str) -> &str {
    match name {
        "codex" => "npm install -g @openai/codex",
        "claude" => "npm install -g @anthropic-ai/claude-code",
        "aider" => "python3 -m pip install -U aider-chat",
        "gemini" => "npm install -g @google/gemini-cli",
        _ => "",
    }
}

/// 生成探测脚本：每个工具一行 `TOOL|名字|是否安装|版本`
pub fn probe_script() -> String {
    let mut s = String::new();
    s.push_str("for c in codex claude aider gemini; do ");
    s.push_str("p=$(command -v \"$c\" 2>/dev/null); ");
    s.push_str("if [ -n \"$p\" ]; then ");
    s.push_str("v=$(\"$c\" --version 2>&1 | head -1 | tr -d '\\r'); ");
    s.push_str("echo \"TOOL|$c|1|$v\"; else echo \"TOOL|$c|0|\"; fi; done; ");
    // npm 版本（没有就写 none）
    s.push_str("echo \"NPM|$(command -v npm >/dev/null 2>&1 && npm -v 2>/dev/null || echo none)\"; ");
    // 正在跑的 AI 进程（用 ps 的 args，排除 grep 自己）
    s.push_str("echo \"RUN|$(ps -eo args= 2>/dev/null | grep -E '(^|/)(codex|claude|aider)([[:space:]]|$)' | grep -v grep | head -5 | tr '\\n' ';')\"");
    s
}

/// 解析探测结果
pub fn parse_probe(output: &str) -> AiProbe {
    let mut tools: Vec<AiTool> = Vec::new();
    let mut npm = String::new();
    let mut running: Vec<String> = Vec::new();

    for line in output.lines() {
        let line = line.trim_end_matches(['\r', '\n']).trim();
        if let Some(rest) = line.strip_prefix("TOOL|") {
            let parts: Vec<&str> = rest.splitn(3, '|').collect();
            if parts.len() < 3 {
                continue;
            }
            let name = parts[0].to_string();
            let installed = parts[1] == "1";
            let version = parts[2].trim().to_string();
            tools.push(AiTool {
                label: label_of(&name).to_string(),
                install_cmd: install_cmd_of(&name).to_string(),
                run_cmd: name.clone(),
                name,
                installed,
                version,
            });
        } else if let Some(rest) = line.strip_prefix("NPM|") {
            let v = rest.trim();
            if v != "none" {
                npm = v.to_string();
            }
        } else if let Some(rest) = line.strip_prefix("RUN|") {
            for piece in rest.split(';') {
                let p = piece.trim();
                if p.is_empty() {
                    continue;
                }
                // 只保留工具名，方便前端比对。
                // 用和「AI 任务看板」同一套判定：`node /usr/local/bin/codex` 要认成
                // codex，而不是把解释器 node 当成工具名。
                if let Some(tool) = crate::core::ai_tasks::tool_of(&p) {
                    running.push(tool);
                }
            }
        }
    }

    AiProbe {
        tools,
        npm,
        running,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_probe_output() {
        let out = "TOOL|codex|1|codex-cli 0.130.0\n\
TOOL|claude|0|\n\
TOOL|aider|0|\n\
TOOL|gemini|0|\n\
NPM|10.8.2\n\
RUN|node /usr/local/bin/codex;";
        let p = parse_probe(out);
        assert_eq!(p.tools.len(), 4);
        assert!(p.tools[0].installed);
        assert_eq!(p.tools[0].version, "codex-cli 0.130.0");
        assert!(!p.tools[1].installed);
        assert_eq!(p.npm, "10.8.2");
        assert_eq!(p.running, vec!["codex".to_string()]);
    }

    #[test]
    fn handles_no_npm() {
        let p = parse_probe("TOOL|codex|0|\nNPM|none\nRUN|");
        assert!(p.npm.is_empty());
        assert!(p.running.is_empty());
    }
}
