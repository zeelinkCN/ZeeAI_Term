//! 进程内的 SHA-256（FIPS 180-4），只依赖 std。
//!
//! 为什么不用系统的 `certutil -hashfile`（架构审查提的 PATH 劫持）：
//! 1. **PATH 劫持**：`certutil` 是按 PATH 解析的。用户（或任何能改 PATH 的程序）在
//!    PATH 前面放一个假的 `certutil.exe` 就能让校验"永远通过"；而这条链路的下一步是
//!    **静默执行一个下载来的安装包**（见 `commands::update_download_install`），
//!    等于把"官方 sha256 校验"整条防线交给 PATH 决定；
//! 2. **每算一次起一个子进程**：更新包 / herdr 包都是 9~14MB，还要把整份内容再读一遍，
//!    顺带多一个可能闪控制台的进程。
//!
//! 现在直接在进程内算：同样的字节，同样的十六进制小写结果，不碰 PATH、不起进程。
//! 这**不是**在造密码学轮子 —— SHA-256 是确定性的公开算法（测试里对着 FIPS 向量钉死）。

/// 轮常数（FIPS 180-4 §4.2.2）
const K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/// 初始哈希值（FIPS 180-4 §5.3.3）
const H0: [u32; 8] = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

/// 增量 SHA-256（`update` 可以喂任意多段，`finish` 出 32 字节摘要）
pub struct Sha256 {
    state: [u32; 8],
    /// 还没凑满一个 512 位块的数据
    buf: [u8; 64],
    buf_len: usize,
    /// 已经喂进来的总字节数（末尾要按它补位）
    total: u64,
}

impl Default for Sha256 {
    fn default() -> Self {
        Self::new()
    }
}

impl Sha256 {
    pub fn new() -> Self {
        Self {
            state: H0,
            buf: [0u8; 64],
            buf_len: 0,
            total: 0,
        }
    }

    pub fn update(&mut self, mut data: &[u8]) {
        self.total = self.total.saturating_add(data.len() as u64);
        // 先把上次剩下的半块填满
        if self.buf_len > 0 {
            let want = 64 - self.buf_len;
            let take = want.min(data.len());
            self.buf[self.buf_len..self.buf_len + take].copy_from_slice(&data[..take]);
            self.buf_len += take;
            data = &data[take..];
            if self.buf_len == 64 {
                let block = self.buf;
                self.compress(&block);
                self.buf_len = 0;
            }
        }
        // 整块直接压
        while data.len() >= 64 {
            let mut block = [0u8; 64];
            block.copy_from_slice(&data[..64]);
            self.compress(&block);
            data = &data[64..];
        }
        // 尾巴留到下一次
        if !data.is_empty() {
            self.buf[..data.len()].copy_from_slice(data);
            self.buf_len = data.len();
        }
    }

    pub fn finish(mut self) -> [u8; 32] {
        let bit_len = self.total.saturating_mul(8);
        // 补一个 0x80，再补 0 到 (56 mod 64)，最后 8 字节是大端位长
        self.update(&[0x80]);
        // update 里凑满 64 会自己压块并把 buf_len 归零，所以这里一路补到 56 为止
        while self.buf_len != 56 {
            self.update(&[0x00]);
        }
        let mut tail = [0u8; 8];
        tail.copy_from_slice(&bit_len.to_be_bytes());
        // 最后一块直接压（不要再走 update：那会改 total）
        self.buf[56..64].copy_from_slice(&tail);
        let block = self.buf;
        self.compress(&block);
        let mut out = [0u8; 32];
        for (i, word) in self.state.iter().enumerate() {
            out[i * 4..i * 4 + 4].copy_from_slice(&word.to_be_bytes());
        }
        out
    }

    fn compress(&mut self, block: &[u8; 64]) {
        let mut w = [0u32; 64];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([
                block[i * 4],
                block[i * 4 + 1],
                block[i * 4 + 2],
                block[i * 4 + 3],
            ]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = self.state;
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let t1 = h
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(maj);
            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(t2);
        }
        let add = [a, b, c, d, e, f, g, h];
        for i in 0..8 {
            self.state[i] = self.state[i].wrapping_add(add[i]);
        }
    }
}

/// 一段内存的 sha256（小写十六进制，64 个字符）
pub fn hex_digest(data: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(data);
    to_hex(&h.finish())
}

fn to_hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// 一个文件的 sha256（流式读，不把整个安装包读进内存）。
///
/// 读失败 / 打不开都会返回**中文**错误（这条链路的调用方会把它直接显示给用户）。
pub fn file_digest(path: &std::path::Path) -> Result<String, String> {
    use std::io::Read;
    let mut f = std::fs::File::open(path)
        .map_err(|e| format!("打开文件失败（算 sha256 用）：{}：{e}", path.display()))?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = f
            .read(&mut buf)
            .map_err(|e| format!("读取文件失败（算 sha256 用）：{}：{e}", path.display()))?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(to_hex(&h.finish()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// FIPS 180-4 / NIST 的官方测试向量：换成任何别的实现都必须一致。
    #[test]
    fn matches_fips_test_vectors() {
        assert_eq!(
            hex_digest(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            hex_digest(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            hex_digest(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
            "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
        );
        // 一百万个 'a'（标准向量）：同时验证多块 + 跨块补位
        let million_a = vec![b'a'; 1_000_000];
        assert_eq!(
            hex_digest(&million_a),
            "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"
        );
    }

    /// 增量喂（任意切分）必须和一次喂完一样 —— 读文件就是一片片喂的。
    #[test]
    fn incremental_update_matches_one_shot() {
        let data: Vec<u8> = (0..1000u32).map(|i| (i % 251) as u8).collect();
        let one_shot = hex_digest(&data);
        for chunk in [1usize, 7, 63, 64, 65, 128, 999] {
            let mut h = Sha256::new();
            for part in data.chunks(chunk) {
                h.update(part);
            }
            assert_eq!(to_hex(&h.finish()), one_shot, "chunk={chunk}");
        }
    }

    /// 文件版：内容对得上，且**不依赖 PATH 上的任何命令**（这条就是修复本身）。
    #[test]
    fn file_digest_reads_real_file() {
        let dir = std::env::temp_dir().join(format!("zeeai-sha256-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("abc.bin");
        std::fs::write(&p, b"abc").unwrap();
        assert_eq!(
            file_digest(&p).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        // 空文件
        let empty = dir.join("empty.bin");
        std::fs::write(&empty, b"").unwrap();
        assert_eq!(
            file_digest(&empty).unwrap(),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        // 打不开要中文报错，不能 panic
        let err = file_digest(&dir.join("不存在.bin")).unwrap_err();
        assert!(err.contains("打开文件失败"), "{err}");
        assert!(!err.contains("certutil"), "不能再依赖 certutil：{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 结果必须是小写十六进制 64 位（`package_problem` 就是按这个格式比的）。
    #[test]
    fn digest_format_is_lowercase_hex_64() {
        let s = hex_digest(b"zeeai");
        assert_eq!(s.len(), 64);
        assert!(s.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    }
}
