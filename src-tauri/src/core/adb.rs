use serde::Serialize;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdbDevice {
    pub serial: String,
    pub state: String,
    pub model: Option<String>,
}

/// 解析 `adb devices -l` 的输出。
pub fn parse_devices(output: &str) -> Vec<AdbDevice> {
    let mut out = Vec::new();
    for line in output.lines() {
        let line = line.trim();
        if line.is_empty()
            || line.starts_with("List of devices")
            || line.starts_with('*')
            || line.starts_with("adb server")
        {
            continue;
        }
        let mut parts = line.split_whitespace();
        let Some(serial) = parts.next() else {
            continue;
        };
        let state = parts.next().unwrap_or("unknown").to_string();
        let mut model = None;
        for token in parts {
            if let Some(m) = token.strip_prefix("model:") {
                model = Some(m.replace('_', " "));
            }
        }
        out.push(AdbDevice {
            serial: serial.to_string(),
            state,
            model,
        });
    }
    out
}

pub fn shell_args(serial: &str) -> Vec<String> {
    vec!["-s".into(), serial.to_string(), "shell".into()]
}

/// `fastboot devices` 输出是 `序列号\tfastboot` 一行一个。
pub fn parse_fastboot_devices(output: &str) -> Vec<AdbDevice> {
    let mut out = Vec::new();
    for line in output.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with("List of devices") || line.starts_with('<') {
            continue;
        }
        let mut parts = line.split_whitespace();
        let Some(serial) = parts.next() else { continue };
        let state = parts.next().unwrap_or("fastboot").to_string();
        out.push(AdbDevice {
            serial: serial.to_string(),
            state,
            model: None,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_devices_output() {
        let out = "List of devices attached\n\
* daemon not running; starting now at tcp:5037\n\
R3CT90XXXX\tdevice product:husky model:Pixel_8 device:husky\n\
emulator-5554\toffline\n";
        let v = parse_devices(out);
        assert_eq!(v.len(), 2);
        assert_eq!(v[0].serial, "R3CT90XXXX");
        assert_eq!(v[0].state, "device");
        assert_eq!(v[0].model.as_deref(), Some("Pixel 8"));
        assert_eq!(v[1].state, "offline");
    }

    #[test]
    fn handles_empty() {
        assert!(parse_devices("List of devices attached\n").is_empty());
    }

    #[test]
    fn parses_fastboot_devices() {
        let v = parse_fastboot_devices("R3CT90XXXX\tfastboot\n");
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].serial, "R3CT90XXXX");
        assert_eq!(v[0].state, "fastboot");
    }
}
