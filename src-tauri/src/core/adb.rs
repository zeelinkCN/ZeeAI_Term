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

pub fn logcat_args(serial: &str) -> Vec<String> {
    vec![
        "-s".into(),
        serial.to_string(),
        "logcat".into(),
        "-v".into(),
        "time".into(),
    ]
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdbFile {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
}

/// 解析 `adb shell ls -la <dir>` 的输出。
/// 典型行：`-rw-rw---- 1 root sdcard_rw 1234 2024-01-02 12:34 foo.txt`
/// 目录行首字符是 `d`；名字里可能有空格，所以取第 8 列之后的全部内容。
pub fn parse_ls(output: &str) -> Vec<AdbFile> {
    let mut out = Vec::new();
    for line in output.lines() {
        let line = line.trim_end_matches(['\r', '\n']);
        let t = line.trim();
        if t.is_empty() || t.starts_with("total ") || t.contains("No such file") {
            continue;
        }
        let fields: Vec<&str> = t.split_whitespace().collect();
        if fields.len() < 8 {
            continue;
        }
        let perm = fields[0];
        let is_link = perm.starts_with('l');
        let is_dir = perm.starts_with('d');
        let size = fields[4].parse::<u64>().unwrap_or(0);
        // 从第 8 个字段开始是文件名（可能有空格）
        let name_start = line.find(fields[7]).unwrap_or(0);
        let mut name = line[name_start..].trim().to_string();
        if is_link {
            // `name -> target` 只留名字
            if let Some((n, _)) = name.split_once(" -> ") {
                name = n.to_string();
            }
        }
        if name == "." || name == ".." {
            continue;
        }
        out.push(AdbFile {
            name,
            is_dir,
            size,
        });
    }
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    out
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
