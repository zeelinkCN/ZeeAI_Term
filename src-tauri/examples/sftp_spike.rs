//! 技术验证：不依赖系统 ssh/scp，直接用纯 Rust 的 russh + russh-sftp
//! 连服务器、用密钥认证、开 SFTP 子系统列目录。
//!
//! 用法：cargo run --release --example sftp_spike -- <host> <user> [key_path]

use std::sync::Arc;

struct Client;

impl russh::client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &russh::keys::ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let host = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "203.0.113.10".into());
    let user = std::env::args().nth(2).unwrap_or_else(|| "root".into());
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    let key_path = std::env::args()
        .nth(3)
        .unwrap_or_else(|| format!("{home}/.ssh/id_ed25519"));

    let key = russh::keys::load_secret_key(&key_path, None)?;
    println!("key loaded: {key_path}");

    let config = Arc::new(russh::client::Config::default());
    let mut session = russh::client::connect(config, (host.as_str(), 22), Client).await?;
    let key_pair = russh::keys::PrivateKeyWithHashAlg::new(Arc::new(key), None);
    let auth = session.authenticate_publickey(&user, key_pair).await?;
    println!("auth ok: {}", auth.success());

    let channel = session.channel_open_session().await?;
    channel.request_subsystem(true, "sftp").await?;
    let sftp = russh_sftp::client::SftpSession::new(channel.into_stream()).await?;

    let mut names = 0usize;
    for entry in sftp.read_dir("/root").await? {
        if names < 6 {
            println!("  {}", entry.file_name());
        }
        names += 1;
    }
    println!("read_dir ok -> {names} entries");
    Ok(())
}
