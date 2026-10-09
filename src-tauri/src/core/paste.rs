//! 把"剪贴板里 / 拖进来的文件"落到本地临时文件 —— 为了复用已有的 SFTP 上传链路。
//!
//! 为什么在**前端**取字节、在这里落盘：
//! WebView 的 `paste` 事件里能直接拿到文件内容 —— 不管你在资源管理器里复制的是**文件**
//! （CF_HDROP），还是别的截图工具塞进剪贴板的**位图**（CF_DIB），Chromium 都会当 file 给出来。
//! 这样就不用写 Win32 剪贴板代码（不用 new 任何依赖、也没有权限弹窗），
//! 而 `fs_upload` 要的是"本地路径"，所以中间只差这一步落盘。
//!
//! 文件名由前端生成（带时间戳），这样**同一个名字反复粘不会互相覆盖**，同时保留原名便于认。

/// 单个文件上限：粘进来的一般是截图/图片，超过这个数多半是拖错了东西
pub const MAX_BYTES: usize = 64 * 1024 * 1024;

/// 把文件名洗成"能安全拼进远端路径、也能安全显示在终端里"的样子。
///
/// 为什么要洗：这个名字会被**拼进远端路径**、再作为文本插进终端输入行 ——
/// 空格、引号、`$`、换行这些字符会把用户的命令行弄坏（甚至变成另一条命令）。
/// 中文等非 ASCII 字母保留（UTF-8 路径没问题），其余一律换成 `_`。
pub fn safe_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("").trim();
    let mut out = String::new();
    for ch in base.chars() {
        if ch.is_alphanumeric() || matches!(ch, '.' | '-' | '_' | '+' | '(' | ')') {
            out.push(ch);
        } else {
            out.push('_');
        }
    }
    let out = out.trim_matches('.').to_string();
    if out.is_empty() {
        "paste.png".to_string()
    } else {
        out
    }
}

/// 临时目录：`%TEMP%\zeeai-paste\`
pub fn paste_dir() -> std::path::PathBuf {
    std::env::temp_dir().join("zeeai-paste")
}

/// 写一个粘贴进来的文件，返回它的**绝对路径**（给 fs_upload 用）
pub fn save(name: &str, bytes: &[u8]) -> Result<String, String> {
    if bytes.is_empty() {
        return Err("粘贴的内容是空的".into());
    }
    if bytes.len() > MAX_BYTES {
        return Err(format!(
            "文件太大了（{:.1} MB，上限 {} MB）",
            bytes.len() as f64 / 1024.0 / 1024.0,
            MAX_BYTES / 1024 / 1024
        ));
    }
    let dir = paste_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("建临时目录失败：{e}"))?;
    let path = dir.join(safe_name(name));
    std::fs::write(&path, bytes).map_err(|e| format!("写临时文件失败：{e}"))?;
    Ok(path.to_string_lossy().to_string())
}

/// 预览图最多读这么多字节（缩略图不需要原图；也避免把几十 MB 的图塞进 base64 传到前端）
pub const THUMB_MAX: u64 = 4 * 1024 * 1024;

/// 带时间戳的名字：`paste-<epoch秒>-原名`。同一张图反复粘不会互相覆盖。
pub fn stamped(name: &str) -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("paste-{secs}-{}", safe_name(name))
}

/// 把用户**选中/拖进来**的本地文件收进粘贴临时目录（改名带时间戳），返回新路径。
///
/// 为什么要"收进来"：这样"上传 → 预览 → 用完删除"三件事都只认**一个目录**，
/// 守卫只写一次就够（见 [`discard`] 与 [`read_thumb`]），也不用给任意路径开读文件的权限。
pub fn adopt(path: &str) -> Result<String, String> {
    let src = std::path::Path::new(path.trim());
    let name = src
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file");
    let bytes = std::fs::read(src).map_err(|e| format!("读不了这个文件：{e}"))?;
    save(&stamped(name), &bytes)
}

/// 读一张预览图（原始字节）。**只认粘贴临时目录里的文件**，且最多读 [`THUMB_MAX`]。
pub fn read_thumb(path: &str) -> Result<Vec<u8>, String> {
    let dir = paste_dir();
    let canon_dir = std::fs::canonicalize(&dir).unwrap_or(dir);
    let canon = std::fs::canonicalize(path.trim()).map_err(|e| format!("文件不在：{e}"))?;
    if !canon.starts_with(&canon_dir) {
        return Err("拒绝读取：这个文件不在粘贴临时目录里".into());
    }
    let meta = std::fs::metadata(&canon).map_err(|e| format!("读不到文件信息：{e}"))?;
    if meta.len() > THUMB_MAX {
        return Err(format!(
            "图太大（{:.1} MB），不生成预览",
            meta.len() as f64 / 1024.0 / 1024.0
        ));
    }
    std::fs::read(&canon).map_err(|e| format!("读文件失败：{e}"))
}

/// 上传成功后把本地临时文件删掉 —— 用户不该为了"粘一张图"在 `%TEMP%` 里攒一堆垃圾。
///
/// **只删我们自己那个临时目录里的东西**：传进来的路径必须先落在 [`paste_dir`] 下，
/// 否则一律拒绝。不然这条命令就成了"给我一个路径我就删"的任意删除入口。
pub fn discard(path: &str) -> Result<(), String> {
    let dir = paste_dir();
    let canon_dir = std::fs::canonicalize(&dir).unwrap_or(dir);
    let canon = std::fs::canonicalize(path.trim()).map_err(|e| format!("文件不在：{e}"))?;
    if !canon.starts_with(&canon_dir) {
        return Err("拒绝删除：这个文件不在粘贴临时目录里".into());
    }
    std::fs::remove_file(&canon).map_err(|e| format!("删除失败：{e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_shell_metacharacters_but_keeps_chinese() {
        // 空格、引号、$、换行这些会把拼出来的路径/命令行弄坏
        assert_eq!(safe_name("my shot 1.png"), "my_shot_1.png");
        assert_eq!(safe_name("a\"b'c$d;e.png"), "a_b_c_d_e.png");
        assert_eq!(safe_name("换行\n名.png"), "换行_名.png");
        // 中文/字母数字保留
        assert_eq!(safe_name("截图 2026-10-09.png"), "截图_2026-10-09.png");
        // 路径只剩文件名
        assert_eq!(safe_name("C:\\Users\\me\\shot.png"), "shot.png");
        assert_eq!(safe_name("/tmp/a/b.jpg"), "b.jpg");
        // 空/纯点：给个兜底名
        assert_eq!(safe_name(""), "paste.png");
        assert_eq!(safe_name("..."), "paste.png");
    }

    #[test]
    fn rejects_empty_and_oversized() {
        assert!(save("x.png", &[]).is_err());
        let big = vec![0u8; MAX_BYTES + 1];
        let err = save("big.bin", &big).unwrap_err();
        assert!(err.contains("太大"), "{err}");
    }

    #[test]
    fn writes_file_and_returns_absolute_path() {
        let p = save("单测-粘贴.png", b"hello").expect("应该写得进去");
        let path = std::path::Path::new(&p);
        assert!(path.is_absolute(), "{p} 应该是绝对路径");
        assert_eq!(path.file_name().unwrap().to_string_lossy(), "单测-粘贴.png");
        assert_eq!(std::fs::read(&p).unwrap(), b"hello");
        let _ = std::fs::remove_file(&p);
    }

    /// 删除只对"我们自己临时目录里的文件"生效 —— 别处一律拒绝
    #[test]
    fn discard_refuses_paths_outside_the_paste_dir() {
        let outside = std::env::temp_dir().join("zeeai-paste-not-ours.txt");
        std::fs::write(&outside, b"keep me").unwrap();
        let err = discard(&outside.to_string_lossy()).unwrap_err();
        assert!(err.contains("拒绝删除"), "{err}");
        assert!(outside.exists(), "目录外的文件必须原封不动");

        // 自己目录里的：删得掉
        let mine = save("可以删.txt", b"bye").unwrap();
        discard(&mine).expect("自己目录里的应该能删");
        assert!(!std::path::Path::new(&mine).exists());

        let _ = std::fs::remove_file(&outside);
    }
}
