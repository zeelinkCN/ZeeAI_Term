# 快速迭代构建（开发循环用，**不是交付物**）
#
# 为什么要有这个脚本：交付构建（`npx tauri build`）固定用 release profile ——
# thin-LTO + codegen-units=1 + 三个 crate-type，光"改一行 Rust → 出新 exe"
# 实测要 ~6 分钟，其中绝大部分是单线程的尾部（出码 + LTO + 链接）。
#
# 这里走 `[profile.fast]`（见 src-tauri/Cargo.toml）：同样是"生产"语义
# （带 --features tauri/custom-protocol，前端内嵌，不会连 devUrl），
# 但关掉 LTO、放开 codegen-units、打开 incremental，换几倍的迭代速度。
#
# 为什么不用 `npx tauri build -- --profile fast`：cargo 不允许
# `--release` 和 `--profile` 同时出现，而 Tauri CLI 永远会加 `--release`。
# 所以这条快速路径绕过 CLI，自己补上 CLI 会做的那两件事：
#   1) 先构建前端（npm run build → dist/）
#   2) 带上 --features tauri/custom-protocol（否则就是 dev 构建，见 AGENTS.md 第 5 条）
# 少了 CLI 的最后一步"改名成 mainBinaryName"，所以产物叫 zeeai-terminal.exe
# 而不是 ZeeAI_Term.exe —— 这是预期行为，交付请走 `npx tauri build`。
#
# 用法：
#   .\scripts\build-fast.ps1                 # 前端 + Rust
#   .\scripts\build-fast.ps1 -SkipFrontend   # 只改了 Rust 时用，省十几秒
#   .\scripts\build-fast.ps1 -Smoke          # 构建完顺手起一次窗口，确认界面能开

param(
  [switch]$SkipFrontend,
  [switch]$Smoke
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# 注意：下面这些用绝对路径。[System.IO.File] / [System.IO.Path] 这类 .NET API
# 认的是**进程启动目录**（[Environment]::CurrentDirectory），不是 PowerShell 的
# Set-Location —— 用相对路径会去错地方找文件（踩过一次）。
$exe      = Join-Path $root 'src-tauri/target/fast/zeeai-terminal.exe'
$distHtml = Join-Path $root 'dist/index.html'

function Test-BinaryContains {
  param([string]$Path, [string]$Needle)
  # ISO-8859-1 = 逐字节映射，能直接在二进制里找 ASCII 串
  $enc = [System.Text.Encoding]::GetEncoding(28591)
  $text = $enc.GetString([System.IO.File]::ReadAllBytes($Path))
  return $text.Contains($Needle)
}

$t0 = Get-Date

if (-not $SkipFrontend) {
  Write-Host '== 1/3 构建前端 =='
  npm run build
  if ($LASTEXITCODE -ne 0) { throw 'npm run build 失败' }
} else {
  Write-Host '== 1/3 跳过前端（-SkipFrontend）=='
}
$tFrontend = Get-Date

Write-Host '== 2/3 cargo build --profile fast =='
Push-Location 'src-tauri'
try {
  cargo build --profile fast --bins --features tauri/custom-protocol
  if ($LASTEXITCODE -ne 0) { throw 'cargo build 失败' }
} finally {
  Pop-Location
}
$tCargo = Get-Date

Write-Host '== 3/3 自检 =='
if (-not (Test-Path -LiteralPath $exe)) { throw "没有产物：$exe" }
$item = Get-Item -LiteralPath $exe
if ($item.Length -lt 1MB) {
  throw "产物只有 $([math]::Round($item.Length/1KB,0)) KB —— 多半是个中间态文件，别用它（见 AGENTS.md 第 1 条）"
}

# 交付前必查的两件事：前端真的嵌进去了、没有偷偷指向 devUrl
$asset = $null
if (Test-Path $distHtml) {
  $m = [regex]::Match((Get-Content $distHtml -Raw), 'assets/[^"'']+\.js')
  if ($m.Success) { $asset = $m.Value }
}
if ($asset) {
  if (Test-BinaryContains -Path $exe -Needle $asset) {
    Write-Host "   前端已内嵌（在 exe 里找到了 $asset）"
  } else {
    throw "exe 里找不到 $asset —— 前端没嵌进去，这个 exe 打开会是白屏/连不上（见 AGENTS.md 第 1 条）"
  }
}
# 关于"是不是 dev 构建"的判断：
# 不要用"exe 里有没有 localhost:1420"来判断 —— 整个 tauri 配置（含 devUrl 字段）
# 本来就会嵌进二进制，正常交付版里也有这个字符串（实测对比过）。
# 真正的信号是**前端资源有没有被嵌进去**：dev 构建不嵌资源，所以上面那条检查就够了。

$size = '{0:N1} MB' -f ($item.Length / 1MB)
$total = ($tCargo - $t0).TotalSeconds
Write-Host ''
Write-Host ('   产物   {0}  ({1})' -f $exe, $size)
Write-Host ('   前端   {0,6:N1}s' -f ($tFrontend - $t0).TotalSeconds)
Write-Host ('   Rust   {0,6:N1}s' -f ($tCargo - $tFrontend).TotalSeconds)
Write-Host ('   合计   {0,6:N1}s' -f $total)
Write-Host '   提醒   这是开发用的快速构建，交付请跑 npx tauri build（产物是 target/release/ZeeAI_Term.exe）'

if ($Smoke) {
  Write-Host '== 冒烟：起一次窗口 =='
  $proc = Start-Process -FilePath $exe -PassThru
  $deadline = (Get-Date).AddSeconds(25)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    if ($proc.HasExited) { break }
    $proc.Refresh()
    if ($proc.MainWindowHandle -ne 0) { break }
  }
  if ($proc.HasExited) {
    # 单实例逻辑（src-tauri/src/instance.rs）：已经有一个窗口在跑时，
    # 第二个实例会把老窗口叫到前面然后**自己退出**。这不是故障，别误报。
    $others = Get-Process -ErrorAction SilentlyContinue |
      Where-Object { $_.Id -ne $proc.Id -and $_.Name -in @('zeeai-terminal', 'ZeeAI_Term') }
    if ($others) {
      Write-Warning ('   已有实例在跑（PID {0}）—— 单实例逻辑让新进程直接退出了。想真冒烟请先关掉那个窗口。' -f $others[0].Id)
    } else {
      throw "进程起来就退了（ExitCode=$($proc.ExitCode)）"
    }
  } else {
    if ($proc.MainWindowHandle -eq 0) {
      throw '进程活着但一直没窗口 —— 参见 AGENTS.md 第 2 条（"进程起来了" ≠ "界面能打开"）'
    }
    Write-Host ("   窗口标题：{0}" -f $proc.MainWindowTitle)
    Write-Host '   界面已打开（自己扫一眼有没有白屏/ERR_CONNECTION_REFUSED）'
    if ($env:DSH_SESSION_ID) {
      Stop-Process -Id $proc.Id -Force
      Write-Host '   （agent 会话中，已关闭该窗口）'
    }
  }
}
