# 启动探针：连续抓窗口画面，用来量"启动多快"和"有没有不同尺寸的中间帧（一大一小重影）"
#
# 背景：用户报"启动瞬间一大一小两个相同画面重影 + 卡顿一下"。
# 实测（**0.1.11 及更早的基线**）：窗口 ~373ms 就可见，而画面要到 ~1010ms 才稳定 ——
# 中间 600 多毫秒就是"重影 + 卡顿"：那一段屏幕上留着的其实是**上一次窗口的残留**
# （WebView2 一帧都还没画），接着画出一片白，最后才是深色界面。
# 0.1.12 的修法见 src/startup.ts / index.html 的静态启动屏 / lib.rs 的 frontend_ready。
#
# ⚠️ 找窗口用**枚举本进程的可见顶层窗口**，不用 `Process.MainWindowHandle`：
# 托盘图标会带出一个 16x16 的消息窗，抓错了量出来全是假数（踩过）。
# 结束时先好好关一次、让日志刷盘，再强制结束。
#
# 用法：
#   .\scripts\startup-probe.ps1 -Exe .\src-tauri\target\release\ZeeAI_Term.exe -Runs 5
param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [int]$Runs = 5,
  [int]$IntervalMs = 100,
  [int]$TimeoutSec = 20,
  # 每次跑固定抓这么久 —— **不要"画面稳定就提前收工"**：
  # 那样"最后一次变化"会被采样窗口截断，量出来永远是 0，看不出真实差异（踩过）。
  [int]$DurationMs = 2500
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
if (-not ("ZeeWin" -as [type])) {
  Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class ZeeWin {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

  /// 找出属于 pid 的、可见的、宽度 >= minW 的顶层窗口；返回面积最大的那个
  public static IntPtr FindAppWindow(uint pid, int minW) {
    IntPtr best = IntPtr.Zero; long bestArea = 0;
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p != pid) return true;
      if (!IsWindowVisible(h)) return true;
      RECT r;
      if (!GetWindowRect(h, out r)) return true;
      int w = r.R - r.L, hh = r.B - r.T;
      if (w < minW || hh < 100) return true;
      long area = (long)w * hh;
      if (area > bestArea) { bestArea = area; best = h; }
      return true;
    }, IntPtr.Zero);
    return best;
  }
}
"@
}

$exePath = (Resolve-Path $Exe).Path
$exeName = [System.IO.Path]::GetFileNameWithoutExtension($exePath)

function Get-FrameHash([IntPtr]$h) {
  $rect = New-Object ZeeWin+RECT
  if (-not [ZeeWin]::GetWindowRect($h, [ref]$rect)) { return $null }
  $w = $rect.R - $rect.L; $hh = $rect.B - $rect.T
  if ($w -le 0 -or $hh -le 0) { return $null }
  $bmp = New-Object System.Drawing.Bitmap($w, $hh)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $hdc = $g.GetHdc()
  $ok = [ZeeWin]::PrintWindow($h, $hdc, 2)  # PW_RENDERFULLCONTENT
  $g.ReleaseHdc($hdc); $g.Dispose()
  if (-not $ok) { $bmp.Dispose(); return $null }
  # 缩到 64x40 再哈希：忽略一个像素级的抖动，只比较"画面结构"
  $small = New-Object System.Drawing.Bitmap($bmp, 64, 40)
  $ms = New-Object System.IO.MemoryStream
  $small.Save($ms, [System.Drawing.Imaging.ImageFormat]::Bmp)
  $hash = ([System.Security.Cryptography.SHA256]::Create().ComputeHash($ms.ToArray()) | ForEach-Object { $_.ToString('x2') }) -join ''
  $ms.Dispose(); $small.Dispose(); $bmp.Dispose()
  return [pscustomobject]@{ W = $w; H = $hh; Hash = $hash.Substring(0, 10) }
}

$results = @()
for ($run = 1; $run -le $Runs; $run++) {
  Get-Process -Name $exeName -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Milliseconds 700
  $t0 = Get-Date
  $p = Start-Process -FilePath $exePath -PassThru
  $frames = New-Object System.Collections.Generic.List[object]
  $firstFrameMs = $null; $stableMs = $null; $lastHash = $null; $sameCount = 0
  $hardDeadline = $t0.AddSeconds($TimeoutSec)
  $softDeadline = $t0.AddMilliseconds($DurationMs)
  while ((Get-Date) -lt $hardDeadline) {
    if ((Get-Date) -ge $softDeadline) { break }
    Start-Sleep -Milliseconds $IntervalMs
    if ($p.HasExited) { break }
    $h = [ZeeWin]::FindAppWindow([uint32]$p.Id, 400)
    if ($h -eq [IntPtr]::Zero) { continue }
    $f = Get-FrameHash $h
    if ($null -eq $f) { continue }
    $ms = [int]((Get-Date) - $t0).TotalMilliseconds
    $frames.Add([pscustomobject]@{ Ms = $ms; W = $f.W; H = $f.H; Hash = $f.Hash })
    if ($null -eq $firstFrameMs) { $firstFrameMs = $ms }
    if ($f.Hash -eq $lastHash) { $sameCount++ } else { $sameCount = 1; $lastHash = $f.Hash }
    if ($sameCount -ge 5 -and $null -eq $stableMs) { $stableMs = $ms }
  }
  $sizeSeq = (($frames | ForEach-Object { "$($_.W)x$($_.H)" } | Select-Object -Unique) -join ' → ')
  $distinctHashes = ($frames | Select-Object -ExpandProperty Hash -Unique).Count
  # 「画面最后一次变化」= 与"最终那张画面"不同的最后一帧的时间。
  # 不用"连续 N 帧相同"那种判据 —— 它天生偏晚（采样间隔 × N），量不出真实差异。
  $finalHash = if ($frames.Count -gt 0) { $frames[$frames.Count - 1].Hash } else { $null }
  $lastChangeMs = $null
  foreach ($f in $frames) { if ($f.Hash -ne $finalHash) { $lastChangeMs = $f.Ms } }
  if ($null -eq $lastChangeMs -and $frames.Count -gt 0) { $lastChangeMs = $frames[0].Ms }
  # 好好关一次，让日志刷盘（force kill 会丢缓冲里的 startup: 行），再强杀兜底
  try { [void]$p.CloseMainWindow() } catch { }
  Start-Sleep -Milliseconds 600
  Get-Process -Id $p.Id -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Milliseconds 400
  $results += [pscustomobject]@{ Run = $run; Frames = $frames.Count; FirstFrameMs = $firstFrameMs; SettleMs = $stableMs; LastChangeMs = $lastChangeMs; Sizes = $sizeSeq; Hashes = $distinctHashes }
  "run {0}: 首帧 {1}ms  最后一次变化 {2}ms  抓 {3} 帧（{4} 种画面）  尺寸: {5}" -f $run, $firstFrameMs, $lastChangeMs, $frames.Count, $distinctHashes, $sizeSeq
}

function Median($xs) { $a = @($xs | Where-Object { $_ -ne $null } | Sort-Object); if ($a.Count -eq 0) { return $null }; $a[[int][Math]::Floor(($a.Count - 1) / 2)] }
"---- 汇总（{0} 次冷启动）----" -f $Runs
"首帧(窗口可见) 中位数: {0} ms" -f (Median ($results.FirstFrameMs))
"画面最后一次变化 中位数: {0} ms" -f (Median ($results.LastChangeMs))
"可见→画面不再变 中位数 : {0} ms  ← 这段就是用户看到的「重影 + 卡顿」" -f (Median ($results | ForEach-Object { if ($_.FirstFrameMs -and $_.LastChangeMs) { $_.LastChangeMs - $_.FirstFrameMs } }))
"出现过的窗口尺寸: {0}" -f (($results.Sizes | Sort-Object -Unique) -join '  |  ')
