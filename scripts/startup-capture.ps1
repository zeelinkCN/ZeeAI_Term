# 把启动过程一帧一帧存成 PNG，用来**亲眼看**"一大一小重影"到底长什么样。
# 用法：.\scripts\startup-capture.ps1 -Exe <exe> -OutDir <目录> [-DurationMs 2500]
param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [Parameter(Mandatory = $true)][string]$OutDir,
  [int]$IntervalMs = 90,
  [int]$DurationMs = 2500,
  [int]$MinWidth = 400,
  # screen = 抓**屏幕上那块区域**（用户真正看到的，含"窗口没画之前是别的窗口残留"这种）
  # printwindow = 只抓窗口自己的缓冲（未绘制时会返回屏幕残留，不能代表用户所见）
  [ValidateSet('screen', 'printwindow')][string]$Mode = 'screen'
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
if (-not ("ZeeWin" -as [type])) {
  Add-Type @"
using System;
using System.Runtime.InteropServices;
public class ZeeWin {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  public static IntPtr FindAppWindow(uint pid, int minW) {
    IntPtr best = IntPtr.Zero; long bestArea = 0;
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p != pid || !IsWindowVisible(h)) return true;
      RECT r; if (!GetWindowRect(h, out r)) return true;
      int w = r.R - r.L, hh = r.B - r.T;
      if (w < minW || hh < 100) return true;
      long area = (long)w * hh; if (area > bestArea) { bestArea = area; best = h; }
      return true;
    }, IntPtr.Zero);
    return best;
  }
}
"@
}
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
Get-ChildItem $OutDir -Filter '*.png' -ErrorAction SilentlyContinue | Remove-Item -Force
$exePath = (Resolve-Path $Exe).Path
$exeName = [System.IO.Path]::GetFileNameWithoutExtension($exePath)
Get-Process -Name $exeName -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 700
$t0 = Get-Date
$p = Start-Process -FilePath $exePath -PassThru
$n = 0
while (((Get-Date) - $t0).TotalMilliseconds -lt $DurationMs) {
  Start-Sleep -Milliseconds $IntervalMs
  if ($p.HasExited) { break }
  $h = [ZeeWin]::FindAppWindow([uint32]$p.Id, $MinWidth)
  if ($h -eq [IntPtr]::Zero) { continue }
  $r = New-Object ZeeWin+RECT
  if (-not [ZeeWin]::GetWindowRect($h, [ref]$r)) { continue }
  $w = $r.R - $r.L; $hh = $r.B - $r.T
  if ($w -le 0 -or $hh -le 0) { continue }
  $bmp = New-Object System.Drawing.Bitmap($w, $hh)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  if ($Mode -eq 'screen') {
    # 抓屏幕上这一块（用户真正看到的）
    $g.CopyFromScreen($r.L, $r.T, 0, 0, (New-Object System.Drawing.Size($w, $hh)))
    $ok = $true
  } else {
    $dc = $g.GetHdc()
    $ok = [ZeeWin]::PrintWindow($h, $dc, 2)
    $g.ReleaseHdc($dc)
  }
  $g.Dispose()
  if (-not $ok) { $bmp.Dispose(); continue }
  $ms = [int]((Get-Date) - $t0).TotalMilliseconds
  $file = Join-Path $OutDir ("f{0:d3}-{1}ms-{2}x{3}.png" -f $n, $ms, $w, $hh)
  $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  "  {0}" -f (Split-Path $file -Leaf)
  $n++
}
try { [void]$p.CloseMainWindow() } catch { }
Start-Sleep -Milliseconds 600
Get-Process -Id $p.Id -ErrorAction SilentlyContinue | Stop-Process -Force
"共 {0} 帧 → {1}" -f $n, $OutDir
