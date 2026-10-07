# 发版脚本（Windows / PowerShell 5.1）
#
# 用法：
#   $env:GH_TOKEN = '你的 GitHub token'      # 只用环境变量，绝不写进仓库
#   .\scripts\publish-release.ps1 -Version 0.1.6
#
# 它做四件事：
#   1. 核对版本号（tauri.conf.json / package.json / Cargo.toml / App.tsx 必须一致）；
#   2. 推 main 和 tag（走 origin 的 push 地址 —— 本仓库固定为 SSH-443，见 docs/decisions.md）；
#   3. 用 gh 建 Release 并上传 4 个产物（走 api.github.com，这条线在国内比 github.com 稳）；
#   4. 复核 releases/latest 指向。
#
# 前提：先跑过构建，产物在下面 $assets 列的位置。

param(
  [Parameter(Mandatory = $true)][string]$Version,
  [string]$Repo = 'zeelinkCN/ZeeAI_Term',
  [string]$Title = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not $env:GH_TOKEN) {
  throw '请先设置 $env:GH_TOKEN（GitHub token，需要 repo 权限）'
}

$tag = "v$Version"
$notes = "docs/release-notes-$tag.md"

Write-Host '== 1) 核对版本号 =='
$tauri = (Get-Content 'src-tauri/tauri.conf.json' -Raw | ConvertFrom-Json).version
$pkg = (Get-Content 'package.json' -Raw | ConvertFrom-Json).version
$cargo = ([regex]::Match((Get-Content 'src-tauri/Cargo.toml' -Raw), '^version = "([^"]+)"', 'Multiline')).Groups[1].Value
$app = ([regex]::Match((Get-Content 'src/App.tsx' -Raw), 'const APP_VERSION = "([^"]+)"')).Groups[1].Value
foreach ($v in @($tauri, $pkg, $cargo, $app)) {
  if ($v -ne $Version) { throw "版本号不一致：参数 $Version，文件里是 $v（tauri=$tauri pkg=$pkg cargo=$cargo App=$app）" }
}
Write-Host "   四个位置都是 $Version，OK"

# 文档里的版本号也要跟着走 —— 以前只校验上面四处，README / 便携版说明各藏一个，
# 全靠手改，漂移过一次（README 长期写着"未实现进度条/断点续传"，其实早就做了）。
Write-Host '   顺便扫一遍文档里的版本号…'
$docChecks = @(
  @{ file = 'README.md';                   pattern = 'ZeeAI_Term-(\d+\.\d+\.\d+)-portable\.zip' },
  @{ file = 'README.md';                   pattern = 'ZeeAI_Term_(\d+\.\d+\.\d+)_x64-setup\.exe' },
  @{ file = 'README.md';                   pattern = 'ZeeAI_Term_(\d+\.\d+\.\d+)_x64_en-US\.msi' },
  @{ file = 'portable/README-portable.txt'; pattern = 'ZeeAI Terminal (\d+\.\d+\.\d+)' }
)
foreach ($c in $docChecks) {
  if (-not (Test-Path $c.file)) { continue }
  $text = Get-Content $c.file -Raw
  foreach ($m in [regex]::Matches($text, $c.pattern)) {
    $found = $m.Groups[1].Value
    if ($found -ne $Version) {
      throw "$($c.file) 里还写着 $found（应为 $Version）：$($m.Value)"
    }
  }
}
Write-Host '   文档版本号一致，OK'

# 版本号只是"数字对不对"，这里再查"话是不是真的"：README / 界面里的承诺必须和实现一致
# （便携版能不能一键升级、主题/配色到底几套、Fastboot 能不能刷机、自检代码在不在发布二进制里）。
# 这几条以前全靠人记，漂移过一次：README 写着便携版可一键升级，实现里是明确拒绝的。
Write-Host '== 1.5) 文档 × 实现一致性 =='
& node scripts/check-docs.mjs
if ($LASTEXITCODE -ne 0) { throw '文档与实现不一致：先改文档或改实现，再发版（node scripts/check-docs.mjs）' }

if (-not (Test-Path $notes)) { throw "缺少发版说明 $notes" }

$assets = @(
  "src-tauri/target/release/bundle/nsis/ZeeAI_Term_${Version}_x64-setup.exe",
  "src-tauri/target/release/bundle/msi/ZeeAI_Term_${Version}_x64_en-US.msi",
  "portable/ZeeAI_Term-$Version-portable.zip",
  'src-tauri/target/release/ZeeAI_Term.exe'
)
Write-Host '== 2) 检查产物 =='
foreach ($a in $assets) {
  if (-not (Test-Path $a)) {
    throw "产物不存在：$a（先跑 npm run tauri build，再跑 .\scripts\build-portable.ps1）"
  }
  Write-Host ('   {0}  {1:N2} MB' -f $a, ((Get-Item $a).Length / 1MB))
}

Write-Host '== 3) 推送 main 和 tag（origin 的 push 地址应为 SSH-443）=='
git remote -v | ForEach-Object { Write-Host "   $_" }
if (-not (git tag -l $tag)) {
  git tag -a $tag -m "ZeeAI_Term $tag"
}
git push origin main
if ($LASTEXITCODE -ne 0) { throw 'git push main 失败' }
git push origin $tag
if ($LASTEXITCODE -ne 0) { throw 'git push tag 失败' }

Write-Host '== 4) 建 Release 并上传产物 =='
$notesTitle = if ($Title) { $Title } else { "ZeeAI_Term $tag" }
& gh release create $tag @assets --repo $Repo --title $notesTitle --notes-file $notes --verify-tag
if ($LASTEXITCODE -ne 0) { throw 'gh release create 失败' }

Write-Host '== 5) 复核 =='
$latest = (& gh api "repos/$Repo/releases/latest" | ConvertFrom-Json)
'   latest = {0}  draft={1}  prerelease={2}' -f $latest.tag_name, $latest.draft, $latest.prerelease
$latest.assets | ForEach-Object { '     {0,-45} {1,10} B' -f $_.name, $_.size }
if ($latest.tag_name -ne $tag) { throw "releases/latest 指向 $($latest.tag_name)，不是 $tag" }
Write-Host "== 完成：$tag 已发布 =="
