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

/// 解析 `git status --porcelain=v1 -b` 的输出。
pub fn parse_status(output: &str) -> GitStatus {
    let mut branch = String::new();
    let mut upstream = String::new();
    let mut ahead = 0u32;
    let mut behind = 0u32;
    let mut files = Vec::new();

    for line in output.lines() {
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
        // XY path（重命名是 "R  old -> new"）
        if line.len() > 3 {
            let status = line[..2].trim().to_string();
            let path = line[3..].trim().to_string();
            let path = match path.split_once(" -> ") {
                Some((_, to)) => to.to_string(),
                None => path,
            };
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
        let out = "## main...origin/main [ahead 1, behind 2]\n M src/App.tsx\n?? new.txt\n";
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
        let s = parse_status("## main\n");
        assert!(s.files.is_empty());
        assert_eq!(s.branch, "main");
    }
}
