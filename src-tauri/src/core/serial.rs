use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use base64::Engine as _;
use serde::Serialize;
use tauri::ipc::Channel;

use super::session::{SessionEvent, SessionHandle};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialPortInfo {
    pub path: String,
    pub label: String,
}

pub fn list() -> Result<Vec<SerialPortInfo>, String> {
    let ports = serialport::available_ports().map_err(|e| format!("枚举串口失败: {e}"))?;
    Ok(ports
        .into_iter()
        .map(|p| {
            let label = match &p.port_type {
                serialport::SerialPortType::UsbPort(info) => {
                    let mut s = info
                        .product
                        .clone()
                        .unwrap_or_else(|| "USB 串口设备".into());
                    if let Some(m) = info.manufacturer.clone() {
                        s.push_str(" · ");
                        s.push_str(&m);
                    }
                    s
                }
                serialport::SerialPortType::BluetoothPort => "蓝牙串口".into(),
                serialport::SerialPortType::PciPort => "PCI 串口".into(),
                serialport::SerialPortType::Unknown => "串口设备".into(),
            };
            SerialPortInfo {
                path: p.port_name,
                label,
            }
        })
        .collect())
}

/// 打开串口并把它桥接成一个终端会话（原始字节流 ↔ xterm）。
pub fn open(
    path: &str,
    baud: u32,
    title: &str,
    channel: Channel<SessionEvent>,
) -> Result<SessionHandle, String> {
    let port = serialport::new(path, baud)
        .timeout(Duration::from_millis(50))
        .open()
        .map_err(|e| format!("打开串口 {path} 失败: {e}"))?;
    let mut reader = port
        .try_clone()
        .map_err(|e| format!("复制串口句柄失败: {e}"))?;

    let _ = channel.send(SessionEvent::State {
        state: "connected".into(),
    });

    let ch = channel.clone();
    thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => continue,
                Ok(n) => {
                    let data = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                    if ch.send(SessionEvent::Data { data }).is_err() {
                        break;
                    }
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => continue,
                Err(_) => break,
            }
        }
        let _ = ch.send(SessionEvent::State {
            state: "closed".into(),
        });
    });

    let writer: Box<dyn Write + Send> = Box::new(port);
    Ok(SessionHandle {
        kind: "serial".into(),
        title: title.to_string(),
        writer: Arc::new(Mutex::new(writer)),
        master: None,
        child: None,
    })
}
