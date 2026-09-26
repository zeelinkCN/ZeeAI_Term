//! 真机验证「一键升级」的**下载 + 校验**链路（只下载到临时目录，不安装、不改机器上任何东西）。
//!
//! 用法：
//!   cargo run --release --example update_spike -- <url> <expected_size> [ext] [version]
//!
//! 例：
//!   cargo run --release --example update_spike -- \
//!     https://github.com/zeelinkCN/ZeeAI_Term/releases/download/v0.1.2/ZeeAI_Term_0.1.2_x64-setup.exe \
//!     9013703 exe 0.1.2
//!
//! 走的是和界面里「一键升级」完全相同的代码路径（`fetch_update_package`），
//! 所以它能下下来并校验通过，界面里的按钮就能用。

use zeeai_terminal_lib::commands::fetch_update_package;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("用法: update_spike <url> <expected_size> [ext] [version]");
        std::process::exit(2);
    }
    let url = args[1].clone();
    let expected: u64 = args[2].parse().unwrap_or(0);
    let ext = args.get(3).cloned().unwrap_or_else(|| "exe".to_string());
    let version = args.get(4).cloned().unwrap_or_else(|| "0.0.0".to_string());

    println!("URL      : {url}");
    println!("期望大小 : {expected} 字节");
    println!("类型/版本: {ext} / {version}");
    println!("开始下载…");

    let mut last_shown = 0u64;
    let result = fetch_update_package(&url, expected, &ext, &version, |done, total| {
        // 每涨 10% 打一行，别刷屏
        if total > 0 {
            let pct = done * 100 / total;
            if pct >= last_shown + 10 {
                last_shown = pct - (pct % 10);
                println!("  {pct}%  ({done}/{total})");
            }
        }
    });

    match result {
        Ok(path) => {
            let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
            println!("✅ 下载 + 校验通过");
            println!("   落盘: {}", path.display());
            println!("   大小: {size} 字节");
            std::process::exit(0);
        }
        Err(e) => {
            println!("❌ 失败: {e}");
            std::process::exit(1);
        }
    }
}
