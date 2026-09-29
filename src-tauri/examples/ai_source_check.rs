//! 直接调用应用自己的探测函数（`commands::ai_source_probe`），把每个服务器
//! 真正拿到的东西打出来 —— 不带任何模拟，用来回答"为什么显示没装"。
//!
//! ```text
//! cargo run --example ai_source_check
//! ```

fn main() {
    // 直接读应用的 profiles.json（store 模块是私有的，这里只为了拿 id/名字，不参与业务）
    let path = std::env::var("APPDATA")
        .map(|p| std::path::PathBuf::from(p).join("ZeeAI-Terminal").join("profiles.json"))
        .unwrap_or_default();
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    let list: Vec<serde_json::Value> = serde_json::from_str(&text).unwrap_or_default();
    for p in list.iter().filter(|p| p.get("ssh").map(|s| !s.is_null()).unwrap_or(false)) {
        let name = p.get("name").and_then(|x| x.as_str()).unwrap_or("?");
        let id = p.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
        let user = p
            .get("ssh")
            .and_then(|s| s.get("user"))
            .and_then(|x| x.as_str())
            .unwrap_or("");
        println!("== {name} ({user}) ==");
        let t0 = std::time::Instant::now();
        let r = tauri::async_runtime::block_on(
            zeeai_terminal_lib::commands::ai_source_probe(Some(id), None),
        );
        let ms = t0.elapsed().as_millis();
        match r {
            Ok(info) => {
                println!("   耗时 {ms} ms");
                println!(
                    "   herdrVersion={:?} protocol={} agents={} compat={:?}",
                    info.herdr_version, info.protocol, info.agents, info.compat
                );
                println!("   路径={:?}", info.herdr_path);
                println!("   远端原始输出={:?}", info.raw);
            }
            Err(e) => println!("   探测失败（{ms} ms）：{e}"),
        }
        println!();
    }
}
