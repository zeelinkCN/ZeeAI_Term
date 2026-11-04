# 发版入口（Windows / PowerShell 5.1+）
#
# 用法：
#   .\scripts\publish-release.ps1 -Version 0.1.15           # 云端构建并创建 draft
#   .\scripts\publish-release.ps1 -Version 0.1.15 -Publish  # 验证后正式发布为 latest
#
# 使用 gh 已登录的凭据（含系统 keyring），也支持 GH_TOKEN；无需将 token 写进脚本。
# 先将 PR 合并到 main、推送对应的 vX.Y.Z tag，再运行本脚本。
# 本脚本不再推送 main/tag，也不直接上传本机的 Windows 包：发布统一走 release.yml，
# Windows 与 macOS 全部产物齐全、GitHub SHA-256 核对通过后才能变成正式 latest。

param(
  [Parameter(Mandatory = $true)][string]$Version,
  [string]$Repo = 'zeelinkCN/ZeeAI_Term',
  [string]$Title = '',
  [switch]$Publish
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if ($Version -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') {
  throw 'Version 必须是稳定版 X.Y.Z（例如 0.1.15），不带 v 前缀'
}
$tag = "v$Version"
$notes = @("docs/releases/$tag.md", "docs/release-notes-$tag.md") |
  Where-Object { (Test-Path -LiteralPath $_ -PathType Leaf) -and ([string](Get-Content -LiteralPath $_ -Raw)).Trim() } |
  Select-Object -First 1
if (-not $notes) { throw "缺少更新说明：docs/releases/$tag.md（兼容历史 docs/release-notes-$tag.md）" }

Write-Host '== 1) 核对本地版本与文档 =='
# PowerShell 5.1 的 ConvertFrom-Json 不支持 npm lockfile 中的空字符串键。
# 这里只提取顶层版本与 packages[""] 的版本，完整 JSON 由云端 Node 再校验。
$pkgLock = Get-Content 'package-lock.json' -Raw
$versions = [ordered]@{
  'tauri.conf.json' = (Get-Content 'src-tauri/tauri.conf.json' -Raw | ConvertFrom-Json).version
  'package.json' = (Get-Content 'package.json' -Raw | ConvertFrom-Json).version
  'package-lock.json' = ([regex]::Match($pkgLock, '(?m)^\s*"version"\s*:\s*"([^"]+)"')).Groups[1].Value
  'package-lock.json root package' = ([regex]::Match($pkgLock, '(?s)"packages"\s*:\s*\{\s*""\s*:\s*\{.*?"version"\s*:\s*"([^"]+)"')).Groups[1].Value
  'Cargo.toml' = ([regex]::Match((Get-Content 'src-tauri/Cargo.toml' -Raw), '^version = "([^"]+)"', 'Multiline')).Groups[1].Value
  'Cargo.lock' = ([regex]::Match((Get-Content 'src-tauri/Cargo.lock' -Raw), '(?m)^name = "zeeai-terminal"\r?\nversion = "([^"]+)"')).Groups[1].Value
  'APP_VERSION' = ([regex]::Match((Get-Content 'src/lib/app-consts.ts' -Raw), 'export const APP_VERSION = "([^"]+)"')).Groups[1].Value
  'portable README' = ([regex]::Match((Get-Content 'portable/README-portable.txt' -Raw), '^ZeeAI Terminal ([\d.]+) ')).Groups[1].Value
}
foreach ($entry in $versions.GetEnumerator()) {
  if ($entry.Value -ne $Version) { throw "版本号不一致：$($entry.Key) 是 $($entry.Value)，应为 $Version" }
}
Write-Host "   版本一致：$Version；更新说明：$notes"
& node scripts/check-docs.mjs
if ($LASTEXITCODE -ne 0) { throw '文档与实现不一致，先修正再发版' }

Write-Host '== 2) 核对 gh 认证、远端 main 与 tag =='
Get-Command gh -ErrorAction Stop | Out-Null
& gh auth status --hostname github.com *> $null
if ($LASTEXITCODE -ne 0) { throw 'gh 认证不可用；可使用 gh 已登录的凭据或 GH_TOKEN，无需把 token 写进脚本' }
$defaultBranch = & gh api "repos/$Repo" --jq '.default_branch'
if ($LASTEXITCODE -ne 0) { throw '无法读取仓库，请检查 gh 的仓库访问权限' }
if ($defaultBranch -ne 'main') { throw "新发布流程应从默认 main 分支运行，当前默认分支是 $defaultBranch" }
& gh api "repos/$Repo/git/ref/tags/$tag" --silent
if ($LASTEXITCODE -ne 0) { throw "远端缺少 $tag；请先合并 main 并推送该 tag（本脚本不会代为推送）" }
& gh workflow view release.yml --repo $Repo --ref main *> $null
if ($LASTEXITCODE -ne 0) { throw 'main 中还没有可用的 release.yml；请先合并包含新发布流程的 PR' }

Write-Host '== 3) 手动触发跨平台发布工作流 =='
$publishValue = if ($Publish) { 'true' } else { 'false' }
$dispatch = @('workflow', 'run', 'release.yml', '--repo', $Repo, '--ref', 'main', '--raw-field', "tag=$tag", '--raw-field', "publish=$publishValue")
if ($Title) { $dispatch += @('--raw-field', "title=$Title") }
& gh @dispatch
if ($LASTEXITCODE -ne 0) { throw '触发 release.yml 失败' }

$mode = if ($Publish) { '正式发布为 latest' } else { '保留 draft，不进入应用更新检查' }
Write-Host "已触发 $tag：$mode。工作流将重新检查 tag 源码、测试并构建 Windows x64 与 macOS Universal。"
Write-Host "查看进度：gh run list --repo $Repo --workflow release.yml --branch main --limit 3"
Write-Host "完成后核对：gh release view $tag --repo $Repo"
