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

/// 串口参数。每个串口连接存自己的一套，不再全局共用一个波特率。
#[derive(Clone, Debug)]
pub struct SerialSettings {
    pub baud: u32,
    pub data_bits: u8,
    /// 1 或 2
    pub stop_bits: u8,
    /// "none" / "odd" / "even"
    pub parity: String,
    /// "none" / "software" / "hardware"
    pub flow_control: String,
}

impl Default for SerialSettings {
    fn default() -> Self {
        Self {
            baud: 115200,
            data_bits: 8,
            stop_bits: 1,
            parity: "none".into(),
            flow_control: "none".into(),
        }
    }
}

fn builder(path: &str, s: &SerialSettings) -> serialport::SerialPortBuilder {
    serialport::new(path, s.baud)
        .data_bits(match s.data_bits {
            5 => serialport::DataBits::Five,
            6 => serialport::DataBits::Six,
            7 => serialport::DataBits::Seven,
            _ => serialport::DataBits::Eight,
        })
        .stop_bits(if s.stop_bits == 2 {
            serialport::StopBits::Two
        } else {
            serialport::StopBits::One
        })
        .parity(match s.parity.as_str() {
            "odd" => serialport::Parity::Odd,
            "even" => serialport::Parity::Even,
            _ => serialport::Parity::None,
        })
        .flow_control(match s.flow_control.as_str() {
            "software" => serialport::FlowControl::Software,
            "hardware" => serialport::FlowControl::Hardware,
            _ => serialport::FlowControl::None,
        })
        .timeout(Duration::from_millis(50))
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
                serialport::SerialPortType::Unknown => {
                    "串口（未识别型号，可能是蓝牙或虚拟串口）".into()
                }
            };
            SerialPortInfo {
                path: p.port_name,
                label,
            }
        })
        .collect())
}

/// 无人值守自检用：打开串口读一会儿，返回 (收到字节数, 去掉 ANSI 转义的预览)。
/// 用来验证「接上真实设备时能不能收到数据」，不需要开界面。
pub fn probe(path: &str, baud: u32, millis: u64) -> Result<(usize, String), String> {
    let mut port = builder(
        path,
        &SerialSettings {
            baud,
            ..Default::default()
        },
    )
        .open()
        .map_err(|e| format!("打开串口 {path} 失败: {e}"))?;
    let start = std::time::Instant::now();
    let mut total = 0usize;
    let mut preview: Vec<u8> = Vec::new();
    let mut buf = [0u8; 4096];
    while start.elapsed() < Duration::from_millis(millis) {
        match port.read(&mut buf) {
            Ok(0) => {}
            Ok(n) => {
                total += n;
                if preview.len() < 260 {
                    let take = (260 - preview.len()).min(n);
                    preview.extend_from_slice(&buf[..take]);
                }
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => {}
            Err(_) => break,
        }
    }
    let text = String::from_utf8_lossy(&preview)
        .replace('\u{1b}', "")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    Ok((total, text))
}

/// 打开串口并把它桥接成一个终端会话（原始字节流 ↔ xterm）。
pub fn open(
    path: &str,
    settings: &SerialSettings,
    title: &str,
    channel: Channel<SessionEvent>,
) -> Result<SessionHandle, String> {
    let port = builder(path, settings)
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
