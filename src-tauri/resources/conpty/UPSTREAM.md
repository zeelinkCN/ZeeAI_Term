# Microsoft ConPTY runtime (Windows x64)

These files are unmodified x64 binaries from Microsoft's stable
`Microsoft.Windows.Console.ConPTY` package **1.25.260930003**. They are distributed
under the MIT license; the complete Microsoft copyright and license notice is
in `LICENSE-ConPTY.txt` and must accompany redistributed copies.

- Upstream project: <https://github.com/microsoft/terminal>
- Upstream release: <https://github.com/microsoft/terminal/releases/tag/v1.25.2733.0>
- Package: <https://github.com/microsoft/terminal/releases/download/v1.25.2733.0/Microsoft.Windows.Console.ConPTY.1.25.260930003.nupkg>
- Package size: **1,750,533 bytes**
- Package SHA-256 (verified against the GitHub Release API asset digest):
  `6d6f8b008c655d814c498d8205d4012dcd4d0b6dfc1096461d0a185d1e3caf03`
- License source: <https://raw.githubusercontent.com/microsoft/terminal/v1.25.2733.0/LICENSE>

| File | Original package entry | Size | SHA-256 |
| --- | --- | ---: | --- |
| `conpty.dll` | `runtimes/win-x64/native/conpty.dll` | 119608 | `feeef341d891643c62d30b6b07800bc70f0bc148f44cb8c3bee84aa557ae805a` |
| `OpenConsole.exe` | `build/native/runtimes/x64/OpenConsole.exe` | 1089376 | `3d66b23d0a71bb8eed2b77edc8b9df9bf54ce6c8fb74c863a30e760997f80586` |
| `LICENSE-ConPTY.txt` | Upstream license at the pinned release tag | 1116 | `5d177f23ecfeb0ea8e050b6a5a16355e1ae9a0b286436ca8f83ed08b3795be6b` |

The package's `.nuspec` declares `MIT` and has no package dependencies. These
binaries import Windows system DLLs/API sets and UCRT, rather than an additional
VC runtime redistributable shipped in this package. The package supports Windows
10 build 17763 and later. This copy and ZeeAI's current Windows distribution
target x64; no native Windows ARM64 build is provided.

Keep `conpty.dll` and its matched `OpenConsole.exe` together. Upstream's
`src/winconpty/winconpty.cpp::_ConsoleHostPath()` resolves `OpenConsole.exe` relative
to the loaded DLL's directory; omitting the host can cause a fallback to the
older system console host. `portable-pty` 0.9.0 prefers this DLL over `kernel32`
when it is loaded. ZeeAI also embeds the same pinned runtime for the standalone
exe upgrade path, verifies its bytes, and loads it from a controlled absolute
path. It does not download native runtime code at application startup.

`build.rs` verifies each component's size/SHA-256 and both PE machine types, then
copies the pair and license to the Cargo profile and test executable directories.
Windows installers and portable packages keep the runtime and license alongside
`ZeeAI_Term.exe`. macOS bundles do not include these Windows components.
