# 便携版打包脚本（Windows / PowerShell 5.1）
#
# 为什么要有这个脚本：便携版以前是**手工**三步（复制 exe → 复制 resources → 复制 README → 压缩），
# 漏一步就会发出一个坏包，而且每次都要记得去核对 sha256。这里把它固化下来。
#
# 用法：
#   .\scripts\build-portable.ps1                 # 按 tauri.conf.json 里的版本号打包
#   .\scripts\build-portable.ps1 -Suffix -dev    # 版本号后面加后缀（例如还没发版时的本地构建）
#   .\scripts\build-portable.ps1 -Clean          # 打包前先清掉历史 zip / 旧目录
#
# 前提：先跑过 `npm run tauri build`（或至少 `cargo build --release` + `npm run build`）。

param(
  [string]$Version = '',
  [string]$Suffix = '',
  [switch]$Clean
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not $Version) {
  $Version = (Get-Content 'src-tauri/tauri.conf.json' -Raw | ConvertFrom-Json).version
  if (-not $Version) { throw '读不到 tauri.conf.json 里的 version' }
}

$exe = 'src-tauri/target/release/ZeeAI_Term.exe'
$resDir = 'src-tauri/resources/platform-tools'
$readme = 'portable/README-portable.txt'
$outDir = 'portable/ZeeAI_Term'
$zip = "portable/ZeeAI_Term-$Version$Suffix-portable.zip"

foreach ($need in @($exe, $resDir, $readme)) {
  if (-not (Test-Path $need)) { throw "缺少 $need —— 先跑 npm run tauri build" }
}

if ($Clean) {
  Write-Host '== 清理历史产物 =='
  Get-ChildItem 'portable' -Filter 'ZeeAI_Term-*-portable.zip' -File | ForEach-Object {
    Write-Host "   删除 $($_.Name)"
    Remove-Item -LiteralPath $_.FullName -Force
  }
  if (Test-Path $outDir) {
    Write-Host "   删除目录 $outDir"
    Remove-Item -LiteralPath $outDir -Recurse -Force
  }
}

Write-Host "== 组装便携版目录（$outDir）=="
# 先在临时目录组装，再尝试同步到 portable/ZeeAI_Term。
#
# 为什么不在原地删了重建：便携版可能**正被用户双击运行**，那个 exe 是被锁住的，
# 硬删会 Access denied 并让整个脚本失败（连 zip 都出不来）。所以组装和"刷新用户看到的目录"
# 分开：zip 一定要产出来；同步失败只给一句人话提示。
$stage = Join-Path $env:TEMP ("zeeai-portable-stage-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Force -Path (Join-Path $stage 'resources') | Out-Null

Copy-Item -LiteralPath $exe -Destination (Join-Path $stage 'ZeeAI_Term.exe') -Force
Copy-Item -LiteralPath $readme -Destination (Join-Path $stage 'README-portable.txt') -Force
# 复制**目录内容**而不是目录本身：目标是已存在的目录时，Copy-Item 会把源目录
# "塞进去"变成 platform-tools/platform-tools（我踩过，多出一份 8MB 的 adb）。
New-Item -ItemType Directory -Force -Path (Join-Path $stage 'resources/platform-tools') | Out-Null
Copy-Item -Path (Join-Path $resDir '*') -Destination (Join-Path $stage 'resources/platform-tools') -Recurse -Force

Write-Host '== 压缩 =='
if (Test-Path $zip) { Remove-Item -LiteralPath $zip -Force }
[System.IO.Compression.ZipFile]::CreateFromDirectory(
  $stage,
  (Join-Path (Get-Location) $zip),
  [System.IO.Compression.CompressionLevel]::Optimal,
  $false
)

Write-Host '== 同步到解压即用的目录 =='
$locked = $false
try {
  # 先把旧目录**改名让位**，而不是递归删除。
  #
  # 为什么不能用 Remove-Item -Recurse：目录里有**正在运行的 exe** 时，它会
  # **先删掉其它文件、再在锁住的那个文件上失败** —— 等于把用户的解压目录掏空
  # （实测踩过：新 exe / resources / README 全被删掉，只剩一个 .old 文件）。
  # 改名不受文件锁影响，之后再建一个干净目录就行。
  $stale = "$outDir.old-" + (Get-Date -Format 'HHmmss')
  if (Test-Path $outDir) { Move-Item -LiteralPath $outDir -Destination $stale -Force }
  New-Item -ItemType Directory -Force -Path (Join-Path $outDir 'resources') | Out-Null
  Copy-Item -LiteralPath $exe -Destination (Join-Path $outDir 'ZeeAI_Term.exe') -Force
  Copy-Item -LiteralPath $readme -Destination (Join-Path $outDir 'README-portable.txt') -Force
  New-Item -ItemType Directory -Force -Path (Join-Path $outDir 'resources/platform-tools') | Out-Null
  Copy-Item -Path (Join-Path $resDir '*') -Destination (Join-Path $outDir 'resources/platform-tools') -Recurse -Force
  Write-Host "   已刷新（解压即用的目录也是这一版了）"
  if (Test-Path $stale) {
    Write-Host "   旧目录留了个备份：$stale（里面那个 exe 可能还被正在运行的窗口占着，关掉后删掉它即可）"
  }
} catch {
  # 退路：整目录重建失败（多半是那个目录被某个进程占着，或者里面的 exe 正在运行）。
  # 这种情况**就地覆盖**通常还是可以的 —— 至少让用户拿到的目录是新版，
  # 而不是像以前那样"删了一半、只剩一个 .old 文件"（真踩过，把用户的目录掏空了）。
  Write-Host '   整目录重建失败，改成就地覆盖…'
  try {
    # exe 正被运行中的窗口占着时，直接覆盖会失败 —— 那就先把它改名让位（改名不受锁影响），
    # 再把新的复制过去。用户下次打开就是新版，旧的那个留着关掉窗口后删。
    try {
      Copy-Item -LiteralPath $exe -Destination (Join-Path $outDir 'ZeeAI_Term.exe') -Force
    } catch {
      $staleExe = Join-Path $outDir ("ZeeAI_Term.exe.old-" + (Get-Date -Format 'HHmmss'))
      Move-Item -LiteralPath (Join-Path $outDir 'ZeeAI_Term.exe') -Destination $staleExe -Force
      Copy-Item -LiteralPath $exe -Destination (Join-Path $outDir 'ZeeAI_Term.exe') -Force
      Write-Host "   exe 正在运行，旧的那份改名成：$(Split-Path $staleExe -Leaf)（关掉窗口后删掉它）"
    }
    Copy-Item -LiteralPath $readme -Destination (Join-Path $outDir 'README-portable.txt') -Force
    New-Item -ItemType Directory -Force -Path (Join-Path $outDir 'resources/platform-tools') | Out-Null
    Copy-Item -Path (Join-Path $resDir '*') -Destination (Join-Path $outDir 'resources/platform-tools') -Recurse -Force
    # 顺手清掉能删的旧备份（删不掉的说明还被占着，留着就行）
    Get-ChildItem -LiteralPath $outDir -Filter 'ZeeAI_Term.exe.old-*' -File -ErrorAction SilentlyContinue |
      ForEach-Object { try { $_.Delete() } catch { } }
    Write-Host '   已就地覆盖刷新（目录本身没能重建，但里面的文件都是这一版了）'
    $locked = $false
  } catch {
    $locked = $true
    Write-Warning "同步失败：$outDir 里的文件正被占用（多半是便携版还在运行）。zip 已经正常产出，不受影响；"
    Write-Warning "想刷新那个目录，请先关掉正在跑的 ZeeAI_Term，再重跑一次本脚本。"
  }
}
Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue

# 便携版固定输出在 portable/ZeeAI_Term；上面"改名让位"那一步会留下 .old-* 目录，
# 里面是上一版 exe —— 用户完全可能去点它（点错了就是"问题没修好"的那种误判）。
# 所以这里统一清掉（能删的删，删不掉的说明还被占着，留着就行）。
Get-ChildItem -LiteralPath (Split-Path $outDir -Parent) -Directory -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -like ((Split-Path $outDir -Leaf) + '.old-*') } |
  ForEach-Object {
    try { Remove-Item -LiteralPath $_.FullName -Recurse -Force } catch { }
  }

Write-Host '== 产物 =='
$folderExe = Join-Path $outDir 'ZeeAI_Term.exe'
foreach ($f in @($folderExe, $zip)) {
  # 目录里那份可能还是旧的（正被占用，没同步成功），那种情况就别把它的哈希当成本次产物
  if ($locked -and $f -eq $folderExe) { continue }
  $item = Get-Item $f
  $hash = (Get-FileHash -LiteralPath $f -Algorithm SHA256).Hash.ToLower()
  Write-Host ('   {0,-46} {1,10:N0} B  sha256={2}' -f $item.Name, $item.Length, $hash)
}
Write-Host "== 完成：$zip =="
