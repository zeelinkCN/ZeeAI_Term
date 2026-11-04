use std::{env, fs, path::Path};

// Keep build-time resource validation identical to the runtime hash checks,
// without adding a dependency or invoking an executable from PATH.
#[allow(dead_code)]
#[path = "src/core/sha256.rs"]
mod sha256;

fn main() {
    if env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        prepare_windows_conpty();
    }
    tauri_build::build()
}

fn prepare_windows_conpty() {
    assert_eq!(
        env::var("CARGO_CFG_TARGET_ARCH").as_deref(),
        Ok("x86_64"),
        "The bundled Microsoft ConPTY runtime currently supports Windows x64 only"
    );
    let manifest = env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is missing");
    let source = Path::new(&manifest).join("resources/conpty");
    let out = env::var_os("OUT_DIR").expect("OUT_DIR is missing");
    // .../<profile>/build/zeeai-terminal-<hash>/out -> .../<profile>.
    // This also works with CARGO_TARGET_DIR and a target-qualified build.
    let profile = Path::new(&out)
        .ancestors()
        .nth(3)
        .expect("OUT_DIR does not contain a Cargo profile directory");
    let files = [
        (
            "conpty.dll",
            "conpty.dll",
            119_608,
            "feeef341d891643c62d30b6b07800bc70f0bc148f44cb8c3bee84aa557ae805a",
            true,
        ),
        (
            "OpenConsole.exe",
            "OpenConsole.exe",
            1_089_376,
            "3d66b23d0a71bb8eed2b77edc8b9df9bf54ce6c8fb74c863a30e760997f80586",
            true,
        ),
        (
            "LICENSE-ConPTY.txt",
            "LICENSE-ConPTY.txt",
            1_116,
            "5d177f23ecfeb0ea8e050b6a5a16355e1ae9a0b286436ca8f83ed08b3795be6b",
            false,
        ),
    ];
    for (name, destination, size, digest, executable) in files {
        let path = source.join(name);
        println!("cargo:rerun-if-changed={}", path.display());
        let bytes = fs::read(&path).unwrap_or_else(|error| {
            panic!(
                "Required Microsoft ConPTY resource {} is missing or unreadable ({error}). Restore the checked-in resources/conpty files; do not fall back to the system ConPTY",
                path.display()
            )
        });
        assert!(
            bytes.len() == size && sha256::hex_digest(&bytes) == digest,
            "Microsoft ConPTY resource {name} failed its pinned size/SHA-256 check. Restore the original resource documented in resources/conpty/UPSTREAM.md"
        );
        if executable {
            check_x64_pe(name, &bytes);
        }
        copy_if_changed(&bytes, &profile.join(destination));
        copy_if_changed(&bytes, &profile.join("deps").join(destination));
    }
    let upstream = source.join("UPSTREAM.md");
    println!("cargo:rerun-if-changed={}", upstream.display());
    let bytes = fs::read(&upstream).expect("Required ConPTY UPSTREAM.md resource is missing");
    copy_if_changed(&bytes, &profile.join("ConPTY-UPSTREAM.md"));
    copy_if_changed(&bytes, &profile.join("deps/ConPTY-UPSTREAM.md"));
}

fn check_x64_pe(name: &str, bytes: &[u8]) {
    let offset = bytes
        .get(0x3c..0x40)
        .map(|value| u32::from_le_bytes(value.try_into().unwrap()) as usize)
        .unwrap_or(usize::MAX);
    let valid = offset.checked_add(6).is_some_and(|end| {
        bytes.get(..2) == Some(b"MZ")
            && bytes.get(offset..end) == Some(&[b'P', b'E', 0, 0, 0x64, 0x86])
    });
    assert!(valid, "Microsoft ConPTY resource {name} is not an x64 PE image");
}

fn copy_if_changed(bytes: &[u8], destination: &Path) {
    // Reusing the identical runtime must not try to overwrite DLLs held open by
    // a running development session on Windows.
    if fs::read(destination).ok().as_deref() == Some(bytes) {
        return;
    }
    fs::create_dir_all(destination.parent().expect("Missing destination directory"))
        .expect("Cannot create Cargo runtime resource directory");
    fs::write(destination, bytes).unwrap_or_else(|error| {
        panic!("Cannot copy Microsoft ConPTY resource to {}: {error}", destination.display())
    });
}
