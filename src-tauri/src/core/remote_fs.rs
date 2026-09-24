use serde::Serialize;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteEntry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteListing {
    pub path: String,
    pub entries: Vec<RemoteEntry>,
}

/// 单引号包裹，避免路径里的空格/特殊字符被 shell 解释。
pub fn sq(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// 一次 ssh 调用同时拿到「解析后的路径」和「目录内容」：
/// 第一行是 pwd，其后每行是 `名字<TAB>类型<TAB>大小`。
pub fn list_remote_command(path: Option<&str>) -> String {
    let cd = match path.filter(|p| !p.trim().is_empty()) {
        Some(p) => format!("cd {} 2>/dev/null || cd \"$HOME\"", sq(p)),
        None => "cd \"$HOME\"".to_string(),
    };
    format!(
        "{{ {cd}; pwd; find . -maxdepth 1 -mindepth 1 -printf '%f\\t%y\\t%s\\n' 2>/dev/null | sort; }} 2>/dev/null"
    )
}

/// 读取文件内容（base64，二进制安全），最多 max_bytes 字节。
pub fn read_remote_command(path: &str, max_bytes: u64) -> String {
    let p = sq(path);
    format!("if [ -f {p} ]; then head -c {max_bytes} {p} | base64 -w 0; fi")
}

/// 新建目录（已存在也不报错）。
pub fn mkdir_remote_command(path: &str) -> String {
    format!("mkdir -p {} && echo OK", sq(path))
}

/// 删除文件或目录（递归）。
pub fn remove_remote_command(path: &str) -> String {
    format!("rm -rf {} && echo OK", sq(path))
}

/// 重命名 / 移动。
pub fn rename_remote_command(from: &str, to: &str) -> String {
    format!("mv -f {} {} && echo OK", sq(from), sq(to))
}

/// 看看目标存在不存在、是文件还是目录（上传/下载前后确认用）。
pub fn stat_remote_command(path: &str) -> String {
    format!(
        "if [ -e {p} ]; then if [ -d {p} ]; then echo dir; else echo file; fi; else echo missing; fi",
        p = sq(path)
    )
}

pub fn parse_listing(output: &str) -> RemoteListing {
    let mut lines = output.lines();
    let path = lines
        .next()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .unwrap_or_else(|| "/".to_string());

    let mut entries = Vec::new();
    for line in lines {
        let line = line.trim_end_matches(['\r', '\n']);
        if line.trim().is_empty() {
            continue;
        }
        let mut parts = line.split('\t');
        let name = match parts.next() {
            Some(n) if !n.is_empty() => n.to_string(),
            _ => continue,
        };
        let kind = parts.next().unwrap_or("f");
        let size = parts.next().and_then(|s| s.trim().parse::<u64>().ok()).unwrap_or(0);
        entries.push(RemoteEntry {
            name,
            is_dir: kind == "d",
            size,
        });
    }

    // 目录在前，其后按名称排序
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    RemoteListing { path, entries }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_listing_with_dirs_first() {
        let out = "/root/ai-work\nnotes.md\tf\t120\nlogs\td\t4096\nscript.py\tf\t64\n";
        let l = parse_listing(out);
        assert_eq!(l.path, "/root/ai-work");
        assert_eq!(l.entries.len(), 3);
        assert_eq!(l.entries[0].name, "logs");
        assert!(l.entries[0].is_dir);
        assert_eq!(l.entries[1].name, "notes.md");
        assert!(!l.entries[1].is_dir);
        assert_eq!(l.entries[1].size, 120);
    }

    #[test]
    fn handles_empty_directory() {
        let l = parse_listing("/tmp\n");
        assert_eq!(l.path, "/tmp");
        assert!(l.entries.is_empty());
    }

    #[test]
    fn handles_no_output() {
        let l = parse_listing("");
        assert_eq!(l.path, "/");
        assert!(l.entries.is_empty());
    }

    #[test]
    fn quotes_paths_with_spaces_and_quotes() {
        let cmd = list_remote_command(Some("/tmp/a b'c"));
        assert!(cmd.contains("'/tmp/a b'\\''c'"));
    }
}
