use serde::Serialize;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFile {
    pub status: String,
    pub path: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub ok: bool,
    pub branch: String,
    pub upstream: String,
    pub ahead: u32,
    pub behind: u32,
    pub files: Vec<GitFile>,
    pub message: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommit {
    pub hash: String,
    pub short: String,
    pub author: String,
    pub when: String,
    pub subject: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranch {
    pub name: String,
    pub current: bool,
    pub upstream: String,
    pub when: String,
}

/// 解析 `git log --pretty=format:%H%x09%h%x09%an%x09%ar%x09%s`
pub fn parse_log(output: &str) -> Vec<GitCommit> {
    output
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|line| {
            let mut it = line.split('\t');
            let hash = it.next()?.trim().to_string();
            let short = it.next().unwrap_or("").trim().to_string();
            let author = it.next().unwrap_or("").trim().to_string();
            let when = it.next().unwrap_or("").trim().to_string();
            let subject = it.next().unwrap_or("").trim().to_string();
            Some(GitCommit {
                hash,
                short,
                author,
                when,
                subject,
            })
        })
        .collect()
}

/// 解析 `git branch --format=%(refname:short)%09%(HEAD)%09%(upstream:short)%09%(committerdate:relative)`
pub fn parse_branches(output: &str) -> Vec<GitBranch> {
    output
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|line| {
            let mut it = line.split('\t');
            let name = it.next()?.trim().to_string();
            if name.is_empty() {
                return None;
            }
            let head = it.next().unwrap_or("").trim().to_string();
            let upstream = it.next().unwrap_or("").trim().to_string();
            let when = it.next().unwrap_or("").trim().to_string();
            Some(GitBranch {
                name,
                current: head == "*",
                upstream,
                when,
            })
        })
        .collect()
}

/// Parse `git status --porcelain=v1 -b -z`. NUL records preserve Unicode,
/// whitespace and literal arrows; rename records contain destination then source.
pub fn parse_status(output: &str) -> GitStatus {
    let mut branch = String::new();
    let mut upstream = String::new();
    let mut ahead = 0u32;
    let mut behind = 0u32;
    let mut files = Vec::new();

    let mut records = output.split('\0');
    while let Some(line) = records.next() {
        if let Some(rest) = line.strip_prefix("## ") {
            // 形如：main...origin/main [ahead 1, behind 2]  或  No commits yet on main
            let head = rest.split(" [").next().unwrap_or(rest);
            let mut parts = head.split("...");
            branch = parts.next().unwrap_or("").trim().to_string();
            upstream = parts.next().unwrap_or("").trim().to_string();
            if branch.starts_with("No commits yet on ") {
                branch = branch.replace("No commits yet on ", "");
            }
            if let Some(bracket) = rest.split('[').nth(1) {
                let inner = bracket.trim_end_matches(']');
                for token in inner.split(',') {
                    let t = token.trim();
                    if let Some(n) = t.strip_prefix("ahead ") {
                        ahead = n.trim().parse().unwrap_or(0);
                    }
                    if let Some(n) = t.strip_prefix("behind ") {
                        behind = n.trim().parse().unwrap_or(0);
                    }
                }
            }
            continue;
        }
        if line.trim().is_empty() {
            continue;
        }
        if let (Some(xy), Some(path)) = (line.get(..2), line.get(3..)) {
            let status = xy.trim().to_string();
            let path = path.to_string();
            if xy.contains(['R', 'C']) {
                // The old path belongs to this record, not a second changed file.
                records.next();
            }
            files.push(GitFile { status, path });
        }
    }

    GitStatus {
        ok: true,
        branch,
        upstream,
        ahead,
        behind,
        files,
        message: String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_branch_and_files() {
        let out = "## main...origin/main [ahead 1, behind 2]\0 M src/App.tsx\0?? new.txt\0";
        let s = parse_status(out);
        assert_eq!(s.branch, "main");
        assert_eq!(s.upstream, "origin/main");
        assert_eq!(s.ahead, 1);
        assert_eq!(s.behind, 2);
        assert_eq!(s.files.len(), 2);
        assert_eq!(s.files[0].status, "M");
        assert_eq!(s.files[0].path, "src/App.tsx");
        assert_eq!(s.files[1].status, "??");
    }

    #[test]
    fn handles_clean_repo() {
        let s = parse_status("## main\0");
        assert!(s.files.is_empty());
        assert_eq!(s.branch, "main");
    }

    #[test]
    fn preserves_unicode_arrows_whitespace_and_rename_destination() {
        let s = parse_status("## main\0??  中文 -> 文件.txt \0R  新名.txt\0旧名.txt\0 M next.txt\0");
        assert_eq!(s.files.len(), 3);
        assert_eq!(s.files[0].path, " 中文 -> 文件.txt ");
        assert_eq!(s.files[1].path, "新名.txt");
        assert_eq!(s.files[2].path, "next.txt");
    }

    #[test]
    fn parses_real_git_status_with_unicode_and_spaces() {
        let dir = std::env::temp_dir().join(format!("zeeai-git-test-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&dir).unwrap();
        let init = crate::core::proc::hidden_command("git").args(["init", "-b", "main"]).arg(&dir).output().unwrap();
        assert!(init.status.success());
        let name = "中文 文件.txt";
        std::fs::write(dir.join(name), "regression").unwrap();
        let output = crate::core::proc::hidden_command("git").arg("-C").arg(&dir)
            .args(["status", "--porcelain=v1", "-b", "-z"]).output().unwrap();
        assert!(output.status.success());
        let status = parse_status(&String::from_utf8_lossy(&output.stdout));
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(status.files.len(), 1);
        assert_eq!(status.files[0].path, name);
    }
}
