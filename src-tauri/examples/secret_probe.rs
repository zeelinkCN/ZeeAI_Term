//! 验证「Windows 凭据管理器 + 密码登录」这条链路：
//!   1. 把密码写进 Windows 凭据管理器（keyring）
//!   2. 用密码建 SFTP 连接，列目录、读文件
//!   3. 用同一条连接 exec 一条命令
//!   4. 删掉凭据，确认真的删掉了
//!
//! 用法：cargo run --release --example secret_probe -- <host> <user> <password>
//! （三个参数都是必填，源码里不留任何真实主机/账号/密码）

use zeeai_terminal_lib::core::{secret, sftp};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let (Some(host), Some(user), Some(password)) = (args.next(), args.next(), args.next()) else {
        return Err("用法: cargo run --release --example secret_probe -- <host> <user> <password>".into());
    };
    let key = format!("probe-{user}");

    println!("1) 写凭据管理器 …");
    secret::set_password(&key, &password)?;
    println!("   has_password = {}", secret::has_password(&key));

    println!("2) 用密码建 SFTP 连接 …");
    let conn = sftp::connect(&host, 22, &user, None, Some(&password), None).await?;
    let (dir, entries) = sftp::list(&conn, None).await?;
    println!("   OK: 家目录 {dir}，{} 项", entries.len());
    for e in entries.iter().take(6) {
        println!("     {}{}", e.name, if e.is_dir { "/" } else { "" });
    }

    println!("3) 读一个文件 …");
    match sftp::read_file(&conn, &format!("/home/{user}/demo/pw-test.txt"), 4096).await {
        Ok(data) => println!("   OK: {}", String::from_utf8_lossy(&data).trim()),
        Err(e) => println!("   读文件失败（可能路径不同）: {e}"),
    }

    println!("4) 借这条连接 exec 一条命令 …");
    match sftp::exec(&conn, "whoami; pwd").await {
        Ok(out) => println!("   OK: {}", out.trim().replace('\n', " | ")),
        Err(e) => println!("   exec 失败: {e}"),
    }

    println!("5) 删除凭据 …");
    secret::delete_password(&key)?;
    println!("   has_password = {}", secret::has_password(&key));

    println!("全部完成");
    Ok(())
}
