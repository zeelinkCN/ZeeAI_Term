//! 终端关键字高亮的**规则表**（预设规则也在这里）。
//!
//! 高亮动作本身在前端做（`src/highlight.ts`：命中的关键词包上 ANSI 颜色再交给 xterm，
//! 所以只在界面上生效，落盘的日志仍是纯文本）。这里只负责「一条规则长什么样」
//! 和「默认给哪几包」—— 规则要存进 settings.json，得有个后端结构兜底：
//! 老配置文件里没有这个字段时自动补上预设。

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HighlightRule {
    pub id: String,
    /// 规则名（只是标签，方便在列表里认出来）
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub keywords: Vec<String>,
    /// true = 区分大小写
    #[serde(default)]
    pub case_sensitive: bool,
    /// 前景色 #rrggbb；空串 = 不改前景
    #[serde(default)]
    pub fg: String,
    /// 背景色 #rrggbb；空串 = 不改背景
    #[serde(default)]
    pub bg: String,
    /// true = 命中后整行上色；false = 只给关键词本身
    #[serde(default)]
    pub whole_line: bool,
    /// true = 关键词两侧必须是词边界（预设「OK」默认打开）
    #[serde(default)]
    pub whole_word: bool,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

fn rule(
    id: &str,
    name: &str,
    keywords: &[&str],
    case_sensitive: bool,
    whole_word: bool,
    fg: &str,
    bg: &str,
) -> HighlightRule {
    HighlightRule {
        id: id.to_string(),
        name: name.to_string(),
        keywords: keywords.iter().map(|k| k.to_string()).collect(),
        case_sensitive,
        fg: fg.to_string(),
        bg: bg.to_string(),
        whole_line: false,
        whole_word,
        enabled: true,
    }
}

/// 预设规则包：ERROR/FAIL/Exception、WARN、OK/SUCCESS、panic/assert/watchdog。
///
/// 刻意都按「只给关键词上色」给：整行高亮要等这一行结束才知道要不要整行上色，
/// 会给交互式回显带来一点延迟，所以留给用户自己按需打开（规则里有个开关）。
pub fn presets() -> Vec<HighlightRule> {
    vec![
        rule(
            "preset-error",
            "错误",
            &["ERROR", "FAIL", "Exception"],
            false,
            false,
            "#ff6b68",
            "",
        ),
        rule("preset-warn", "警告", &["WARN"], false, false, "#ffcc66", ""),
        // 「OK」只有两个字母：不分大小写的话 look / TOKEN / broke 里都会亮，
        // 所以这一包默认区分大小写 + 只认完整单词。
        rule(
            "preset-ok",
            "成功",
            &["OK", "SUCCESS"],
            true,
            true,
            "#4ec9b0",
            "",
        ),
        rule(
            "preset-fatal",
            "严重",
            &["panic", "assert", "watchdog"],
            false,
            false,
            "#ffffff",
            "#7a1c1c",
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn presets_are_sane() {
        let p = presets();
        assert_eq!(p.len(), 4);
        for r in &p {
            assert!(!r.id.is_empty());
            assert!(!r.keywords.is_empty());
            assert!(!r.fg.is_empty() || !r.bg.is_empty(), "{} 没有任何颜色", r.id);
        }
        // 默认预设都不开整行（保证交互式回显不受影响）
        assert!(p.iter().all(|r| !r.whole_line));
    }

    #[test]
    fn rules_round_trip_as_camel_case() {
        let json = serde_json::to_string(&presets()[0]).unwrap();
        assert!(json.contains("\"caseSensitive\""), "got {json}");
        assert!(json.contains("\"wholeLine\""), "got {json}");
        let back: HighlightRule = serde_json::from_str(&json).unwrap();
        assert_eq!(back.id, "preset-error");
    }

    #[test]
    fn missing_fields_get_defaults() {
        // 只写最少的字段也要能读进来（方便用户手改 settings.json）
        let r: HighlightRule =
            serde_json::from_str(r##"{"id":"x","keywords":["boom"],"fg":"#ff0000"}"##).unwrap();
        assert!(r.enabled);
        assert!(!r.case_sensitive);
        assert!(r.name.is_empty());
    }
}
