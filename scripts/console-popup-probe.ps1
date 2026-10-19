# 控制台弹窗探针：量「App 运行期间，有多少子进程/控制台窗口会闪出来」。
#
# 为什么要有这个脚本（v0.1.12 的用户故障）：
#   看板/CLI 健康/快照轮询改成常驻之后，后端有些探测进程**没带 CREATE_NO_WINDOW**。
#   Tauri 是 GUI 进程、自己没有控制台，所以 Windows 会为每个 console 子进程
#   新分配一个控制台 + conhost，屏幕上就是一闪一闪的黑框。
#   这个脚本用 Toolhelp 快照（含 ParentProcessId）每 50ms 采一次样，把
#   「父进程链能追到被测 App」的进程全记下来；同时枚举可见窗口，单独记
#   ConsoleWindowClass / PseudoConsoleWindow 这类控制台窗口。
#
# 用法：
#   .\scripts\console-popup-probe.ps1 -Exe .\portable\ZeeAI_Term\ZeeAI_Term.exe -Seconds 90
#   .\scripts\console-popup-probe.ps1 -Exe .\src-tauri\target\fast\zeeai-terminal.exe -Seconds 90 -Json $env:TEMP\after.json
#
# 输出：
#   - 控制台：按进程名汇总（唯一 PID 数 / 采样命中数 / 直接子进程数），以及控制台窗口列表；
#   - -Json：完整明细（含每个 PID 的父进程、首末出现时间），便于前后对比。
param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [int]$Seconds = 90,
  [int]$IntervalMs = 50,
  [string]$Json = '',
  # 多 agent 并行时，别人可能用 WM_CLOSE 关掉被测窗口（"防弹窗看门狗"）。
  # 打开这两个开关后：窗口被隐藏就立刻 ShowWindow 回来；标题改成随机串，
  # 躲开"按标题找窗口"的清理脚本。只影响这次监控，不改被测程序。
  [switch]$KeepWindow,
  [string]$Retitle = '',
  # 给被测进程单独一个 APPDATA（配置隔离）。多 agent 并行时，别人会改
  # %APPDATA%\ZeeAI-Terminal\settings.json（例如把 closeAction 改回 exit），
  # 被测 App 下一次 WM_CLOSE 就会真退出 —— 这不是被测代码的问题，是环境干扰。
  [string]$AppData = ''
)

$ErrorActionPreference = 'Stop'

if (-not ("ZeeProcWatch" -as [type])) {
  # 本机残留的 LIB/INCLUDE 指向已不存在的 VC98 目录时，PowerShell 5.1 的 csc
  # 会把那条警告当**错误**（Add-Type 直接失败）。编译这段 C# 不需要它们，先清掉。
  $savedLib = $env:LIB; $savedInclude = $env:INCLUDE
  $env:LIB = ''; $env:INCLUDE = ''
  try {
  Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class ZeeProcHit {
  public int Pid;
  public int Ppid;
  public string Name;
  public string ParentName;
  public int Depth;
  public bool Direct;
}

public class ZeeWinHit {
  public long Hwnd;
  public int Pid;
  public string Name;
  public string Class;
  public string Title;
  public int W;
  public int H;
  public bool Console;
  public bool OwnerDescendant;
  public string Chain;
}

public class ZeeScanResult {
  public ZeeProcHit[] Procs;
  public ZeeWinHit[] DescWins;
  public ZeeWinHit[] ConsoleWins;
  public int Total;
}

public class ZeeProcWatch {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct PROCESSENTRY32W {
    public uint dwSize;
    public uint cntUsage;
    public uint th32ProcessID;
    public IntPtr th32DefaultHeapID;
    public uint th32ModuleID;
    public uint cntThreads;
    public uint th32ParentProcessID;
    public int pcPriClassBase;
    public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct RECT { public int L, T, R, B; }

  delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr CreateToolhelp32Snapshot(uint dwFlags, uint th32ProcessID);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool Process32FirstW(IntPtr hSnapshot, ref PROCESSENTRY32W lppe);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool Process32NextW(IntPtr hSnapshot, ref PROCESSENTRY32W lppe);
  [DllImport("kernel32.dll")]
  static extern bool CloseHandle(IntPtr hObject);
  [DllImport("user32.dll")]
  static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")]
  static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")]
  static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern int GetClassNameW(IntPtr hWnd, StringBuilder buf, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern int GetWindowTextW(IntPtr hWnd, StringBuilder buf, int max);
  [DllImport("user32.dll")]
  static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")]
  static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern bool SetWindowTextW(IntPtr hWnd, string text);

  class Node { public int Pid; public int Ppid; public string Name; }

  static Dictionary<int, Node> Snapshot() {
    Dictionary<int, Node> map = new Dictionary<int, Node>();
    IntPtr snap = CreateToolhelp32Snapshot(0x00000002, 0); // TH32CS_SNAPPROCESS
    if (snap == (IntPtr)(-1)) return map;
    try {
      PROCESSENTRY32W pe = new PROCESSENTRY32W();
      pe.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32W));
      if (Process32FirstW(snap, ref pe)) {
        do {
          Node n = new Node();
          n.Pid = (int)pe.th32ProcessID;
          n.Ppid = (int)pe.th32ParentProcessID;
          n.Name = pe.szExeFile;
          map[n.Pid] = n;
        } while (Process32NextW(snap, ref pe));
      }
    } finally {
      CloseHandle(snap);
    }
    return map;
  }

  // 离 root 几层；追不到（父进程已退出/不是它后代）返回 -1
  static int Depth(Dictionary<int, Node> map, int pid, int root) {
    int d = 0;
    int cur = pid;
    while (cur != 0 && d < 16) {
      if (cur == root) return d;
      Node n;
      if (!map.TryGetValue(cur, out n)) return -1;
      cur = n.Ppid;
      d++;
    }
    return -1;
  }

  static string ParentName(Dictionary<int, Node> map, int ppid) {
    Node n;
    return map.TryGetValue(ppid, out n) ? n.Name : "";
  }

  static string Chain(Dictionary<int, Node> map, int pid) {
    List<string> parts = new List<string>();
    int cur = pid;
    int guard = 0;
    while (cur != 0 && guard < 10) {
      Node n;
      if (!map.TryGetValue(cur, out n)) break;
      parts.Add(n.Name + "(" + cur + ")");
      cur = n.Ppid;
      guard++;
    }
    return string.Join(" <- ", parts.ToArray());
  }

  static bool IsConsoleClass(string cls) {
    if (cls == null) return false;
    return cls == "ConsoleWindowClass" ||
           cls == "PseudoConsoleWindow" ||
           cls == "CASCADIA_HOSTING_WINDOW_CLASS";
  }

  // 被测 App 自己的顶层窗口（含隐藏的；消息窗 16x16 不算）
  public static long[] RootWindows(int root) {
    List<long> list = new List<long>();
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      if ((int)pid != root) return true;
      RECT r;
      if (!GetWindowRect(h, out r)) return true;
      int w = r.R - r.L, hh = r.B - r.T;
      if (w < 200 || hh < 100) return true;
      list.Add(h.ToInt64());
      return true;
    }, IntPtr.Zero);
    return list.ToArray();
  }

  public static bool IsVisible(long h) { return IsWindowVisible((IntPtr)h); }
  public static bool Show(long h) { return ShowWindow((IntPtr)h, 5); } // SW_SHOW
  public static bool Retitle(long h, string text) { return SetWindowTextW((IntPtr)h, text); }

  public static ZeeScanResult Scan(int root, string[] targets) {
    Dictionary<int, Node> map = Snapshot();
    List<ZeeProcHit> procs = new List<ZeeProcHit>();
    HashSet<string> targetSet = new HashSet<string>(targets, StringComparer.OrdinalIgnoreCase);

    foreach (Node n in map.Values) {
      if (!targetSet.Contains(n.Name)) continue;
      int d = Depth(map, n.Pid, root);
      if (d < 1) continue;
      ZeeProcHit h = new ZeeProcHit();
      h.Pid = n.Pid;
      h.Ppid = n.Ppid;
      h.Name = n.Name;
      h.ParentName = ParentName(map, n.Ppid);
      h.Depth = d;
      h.Direct = (d == 1);
      procs.Add(h);
    }

    List<ZeeWinHit> desc = new List<ZeeWinHit>();
    List<ZeeWinHit> consoles = new List<ZeeWinHit>();
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      int d = Depth(map, (int)pid, root);
      StringBuilder cls = new StringBuilder(256);
      GetClassNameW(h, cls, 256);
      string className = cls.ToString();
      bool isConsole = IsConsoleClass(className);
      if (d < 1 && !isConsole) return true;
      StringBuilder title = new StringBuilder(512);
      GetWindowTextW(h, title, 512);
      RECT r;
      GetWindowRect(h, out r);
      ZeeWinHit w = new ZeeWinHit();
      w.Hwnd = h.ToInt64();
      w.Pid = (int)pid;
      w.Name = ParentName(map, (int)pid);
      w.Class = className;
      w.Title = title.ToString();
      w.W = r.R - r.L;
      w.H = r.B - r.T;
      w.Console = isConsole;
      w.OwnerDescendant = (d >= 1);
      w.Chain = Chain(map, (int)pid);
      if (d >= 1) desc.Add(w);
      if (isConsole) consoles.Add(w);
      return true;
    }, IntPtr.Zero);

    ZeeScanResult res = new ZeeScanResult();
    res.Procs = procs.ToArray();
    res.DescWins = desc.ToArray();
    res.ConsoleWins = consoles.ToArray();
    res.Total = map.Count;
    return res;
  }
}
"@
  } finally {
    $env:LIB = $savedLib; $env:INCLUDE = $savedInclude
  }
}

$exePath = (Resolve-Path -LiteralPath $Exe).Path
$exeName = [System.IO.Path]::GetFileNameWithoutExtension($exePath)
$targets = @(
  'cmd.exe', 'powershell.exe', 'pwsh.exe', 'where.exe', 'codex.exe', 'codex',
  'certutil.exe', 'reg.exe', 'curl.exe', 'conhost.exe', 'OpenConsole.exe',
  'ssh.exe', 'scp.exe', 'node.exe', 'wsl.exe', 'adb.exe', 'git.exe', 'msiexec.exe'
)

Get-Process -Name $exeName -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 800

if ($AppData) {
  New-Item -ItemType Directory -Force -Path $AppData | Out-Null
  # 用 ProcessStartInfo 才能给子进程单独设 APPDATA；Start-Process 在 PS 5.1 里没有 -Environment
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $exePath
  $psi.WorkingDirectory = (Split-Path -Parent $exePath)
  $psi.UseShellExecute = $false
  $psi.EnvironmentVariables['APPDATA'] = $AppData
  $root = [System.Diagnostics.Process]::Start($psi)
} else {
  $root = Start-Process -FilePath $exePath -WorkingDirectory (Split-Path -Parent $exePath) -PassThru
}
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$procSeen = @{}
$winSeen = @{}
$consoleSeen = @{}
$samples = 0
$scanErrors = 0
$reshows = 0
$retitles = 0
$retitled = @{}

while ($sw.Elapsed.TotalSeconds -lt $Seconds) {
  if ($root.HasExited) { break }
  try {
    $scan = [ZeeProcWatch]::Scan([int]$root.Id, $targets)
  } catch {
    $scanErrors++
    Start-Sleep -Milliseconds $IntervalMs
    continue
  }
  $samples++
  $ms = [int]$sw.Elapsed.TotalMilliseconds
  # 外部看门狗可能 WM_CLOSE 把窗口收进托盘/隐藏：立刻拉回来，别让 WebView 因隐藏而限频
  if ($KeepWindow -or $Retitle) {
    foreach ($h in [ZeeProcWatch]::RootWindows([int]$root.Id)) {
      if ($KeepWindow -and -not [ZeeProcWatch]::IsVisible($h)) {
        [void][ZeeProcWatch]::Show($h)
        $reshows++
      }
      if ($Retitle -and -not $retitled.ContainsKey($h)) {
        [void][ZeeProcWatch]::Retitle($h, $Retitle)
        $retitled[$h] = 1
        $retitles++
      }
    }
  }
  foreach ($p in $scan.Procs) {
    $k = "$($p.Name)|$($p.Pid)"
    if (-not $procSeen.ContainsKey($k)) {
      $procSeen[$k] = [pscustomobject]@{
        Name = $p.Name; Pid = $p.Pid; Ppid = $p.Ppid; ParentName = $p.ParentName;
        Depth = $p.Depth; Direct = $p.Direct; FirstMs = $ms; LastMs = $ms; Samples = 1
      }
    } else {
      $procSeen[$k].LastMs = $ms
      $procSeen[$k].Samples++
    }
  }
  foreach ($w in $scan.DescWins) {
    $k = "$($w.Class)|$($w.Pid)|$($w.Hwnd)"
    if (-not $winSeen.ContainsKey($k)) {
      $winSeen[$k] = [pscustomobject]@{
        Pid = $w.Pid; Name = $w.Name; Class = $w.Class; Title = $w.Title;
        W = $w.W; H = $w.H; FirstMs = $ms; LastMs = $ms; Samples = 1
      }
    } else {
      $winSeen[$k].LastMs = $ms
      $winSeen[$k].Samples++
    }
  }
  foreach ($w in $scan.ConsoleWins) {
    $k = "$($w.Class)|$($w.Pid)|$($w.Hwnd)"
    if (-not $consoleSeen.ContainsKey($k)) {
      $consoleSeen[$k] = [pscustomobject]@{
        Pid = $w.Pid; Name = $w.Name; Class = $w.Class; Title = $w.Title;
        W = $w.W; H = $w.H; OwnerDescendant = $w.OwnerDescendant; Chain = $w.Chain;
        FirstMs = $ms; LastMs = $ms; Samples = 1
      }
    } else {
      $consoleSeen[$k].LastMs = $ms
      $consoleSeen[$k].Samples++
    }
  }
  Start-Sleep -Milliseconds $IntervalMs
}
$sw.Stop()

$exited = $root.HasExited
$exitCode = $null
if ($exited) { $exitCode = $root.ExitCode }
try { [void]$root.CloseMainWindow() } catch { }
Start-Sleep -Milliseconds 700
if (-not $root.HasExited) { Stop-Process -Id $root.Id -Force -ErrorAction SilentlyContinue }

$procs = @($procSeen.Values | Sort-Object FirstMs)
$wins = @($winSeen.Values | Sort-Object FirstMs)
$consoles = @($consoleSeen.Values | Sort-Object FirstMs)
$summary = @(
  $procs | Group-Object Name | ForEach-Object {
    [pscustomobject]@{
      Name = $_.Name
      UniquePids = $_.Count
      SampleHits = ($_.Group | Measure-Object Samples -Sum).Sum
      DirectChildren = @($_.Group | Where-Object Direct).Count
      Pids = (($_.Group | Sort-Object FirstMs | ForEach-Object { "$($_.Pid)@$($_.FirstMs)ms" }) -join ', ')
    }
  } | Sort-Object Name
)

"==== console-popup-probe ===="
"exe        : $exePath"
"duration   : $([math]::Round($sw.Elapsed.TotalSeconds,1))s  interval=${IntervalMs}ms  samples=$samples  scanErrors=$scanErrors"
"app pid    : $($root.Id)  exited=$exited  exitCode=$exitCode  reshows=$reshows  retitles=$retitles"
"appdata    : $(if ($AppData) { $AppData } else { '(inherited)' })"
""
"---- 子进程（父链能追到 App 的目标进程；UniquePids = 真实出现次数）----"
if ($summary.Count -eq 0) {
  "（无）"
} else {
  $summary | Format-Table -AutoSize | Out-String -Width 200
}
"---- 子进程的可见窗口（descendant visible windows）----"
if ($wins.Count -eq 0) {
  "（无）"
} else {
  $wins | Select-Object Pid, Name, Class, Title, W, H, FirstMs, LastMs, Samples | Format-Table -AutoSize | Out-String -Width 220
}
"---- 可见控制台窗口（不管父链，窗口类 = 控制台）----"
if ($consoles.Count -eq 0) {
  "（无）"
} else {
  $consoles | Select-Object Pid, Name, Class, Title, W, H, OwnerDescendant, FirstMs, LastMs, Samples, Chain |
    Format-Table -AutoSize | Out-String -Width 260
}

if ($Json) {
  $jsonDir = Split-Path -Parent $Json
  if ($jsonDir) { New-Item -ItemType Directory -Force -Path $jsonDir | Out-Null }
  $payload = [pscustomobject]@{
    Exe = $exePath
    Seconds = $Seconds
    IntervalMs = $IntervalMs
    Samples = $samples
    ScanErrors = $scanErrors
    Reshows = $reshows
    Retitles = $retitles
    AppData = $AppData
    AppPid = $root.Id
    Exited = $exited
    ExitCode = $exitCode
    Summary = $summary
    Processes = $procs
    DescendantWindows = $wins
    ConsoleWindows = $consoles
  }
  $payload | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $Json -Encoding UTF8
  "json -> $Json"
}
