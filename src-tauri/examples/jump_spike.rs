//! 验证：russh 能不能自己做跳板机（先连跳板，再 direct-tcpip 到目标）。
//! 用法：cargo run --release --example jump_spike -- <jump_user@host> <target_user@host>

use std::sync::Arc;
use std::time::Duration;

use russh::client::{self, Handle};

struct Client;

impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _k: &russh::keys::ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

async fn connect_direct(host: &str, port: u16) -> Result<Handle<Client>, String> {
    let cfg = Arc::new(client::Config {
        inactivity_timeout: Some(Duration::from_secs(60)),
        ..Default::default()
    });
    client::connect(cfg, (host, port), Client)
        .await
        .map_err(|e| format!("connect {host}:{port} failed: {e}"))
}

async fn auth(session: &mut Handle<Client>, user: &str) -> Result<bool, String> {
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    let key_path = format!("{home}/.ssh/id_ed25519");
    let key = russh::keys::load_secret_key(&key_path, None).map_err(|e| e.to_string())?;
    let kp = russh::keys::PrivateKeyWithHashAlg::new(Arc::new(key), None);
    let res = session
        .authenticate_publickey(user, kp)
        .await
        .map_err(|e| e.to_string())?;
    Ok(res.success())
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let jump = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "root@203.0.113.10".into());
    let target = std::env::args()
        .nth(2)
        .unwrap_or_else(|| "root@203.0.113.10".into());
    let (jump_user, jump_host) = jump.split_once('@').expect("user@host");
    let (t_user, t_host) = target.split_once('@').expect("user@host");

    println!("1) 连跳板机 {jump_host} …");
    let mut js = connect_direct(jump_host, 22).await?;
    println!("   auth = {}", auth(&mut js, jump_user).await?);

    println!("2) 从跳板机开 direct-tcpip 到 {t_host}:22 …");
    let mut ch = js
        .channel_open_direct_tcpip(t_host, 22, "127.0.0.1", 0)
        .await
        .map_err(|e| format!("direct-tcpip failed: {e}"))?;

    println!("3) 用这条通道当传输层，连目标机 …");
    let cfg = Arc::new(client::Config {
        inactivity_timeout: Some(Duration::from_secs(60)),
        ..Default::default()
    });
    // russh 0.53: connect_stream 接一个实现了 AsyncRead+AsyncWrite 的流
    let stream = ch.into_stream();
    let mut ts = client::connect_stream(cfg, stream, Client)
        .await
        .map_err(|e| format!("connect_stream failed: {e}"))?;
    println!("   target auth = {}", auth(&mut ts, t_user).await?);

    let mut c = ts.channel_open_session().await?;
    c.exec(true, "whoami; hostname").await?;
    use russh::ChannelMsg;
    let mut out = Vec::new();
    loop {
        match c.wait().await {
            Some(ChannelMsg::Data { data }) => out.extend_from_slice(&data),
            Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
            _ => {}
        }
    }
    println!("4) 目标机输出: {}", String::from_utf8_lossy(&out).trim().replace('\n', " | "));

    // 5) 再用同样「自己跳自己」的方式验证 sftp::connect 的跳板分支
    println!("5) sftp::connect(带跳板机) …");
    let conn = zeeai_terminal_lib::core::sftp::connect(
        t_host,
        22,
        t_user,
        None,
        None,
        Some(&jump),
    )
    .await?;
    let (dir, entries) = zeeai_terminal_lib::core::sftp::list(&conn, None).await?;
    println!("   OK: SFTP 经跳板机拿到 {dir}，{} 项", entries.len());
    Ok(())
}
