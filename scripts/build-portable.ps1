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
if (Test-Path $outDir) { Remove-Item -LiteralPath $outDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path (Join-Path $outDir 'resources') | Out-Null

Copy-Item -LiteralPath $exe -Destination (Join-Path $outDir 'ZeeAI_Term.exe') -Force
Copy-Item -LiteralPath $readme -Destination (Join-Path $outDir 'README-portable.txt') -Force
Copy-Item -LiteralPath $resDir -Destination (Join-Path $outDir 'resources/platform-tools') -Recurse -Force

Write-Host '== 压缩 =='
if (Test-Path $zip) { Remove-Item -LiteralPath $zip -Force }
[System.IO.Compression.ZipFile]::CreateFromDirectory(
  (Resolve-Path $outDir).Path,
  (Join-Path (Get-Location) $zip),
  [System.IO.Compression.CompressionLevel]::Optimal,
  $false
)

Write-Host '== 产物 =='
foreach ($f in @((Join-Path $outDir 'ZeeAI_Term.exe'), $zip)) {
  $item = Get-Item $f
  $hash = (Get-FileHash -LiteralPath $f -Algorithm SHA256).Hash.ToLower()
  Write-Host ('   {0,-46} {1,10:N0} B  sha256={2}' -f $item.Name, $item.Length, $hash)
}
Write-Host "== 完成：$zip =="
