# Din as Windows' shell: keeps Din's window at the bottom, under every
# program's, as Explorer's desktop is, and keeps maximized programs off Din's
# menu bar by setting the work area. Started by electron/windows-shell.mts with
# Din's window handle and the work area (physical pixels); runs until its
# stdin closes (Din quit), then gives the whole screen back.
#
# Explorer's way, SetShellWindow, works only from inside the window's own
# process; this pushes Din down from outside whenever any window comes to the
# foreground, Din included, without taking the keyboard from it.
param(
  [Parameter(Mandatory)][long]$Window,
  [int]$Left, [int]$Top, [int]$Right, [int]$Bottom
)
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;

public static class DinShell {
  delegate void WinEventProc(IntPtr hook, uint ev, IntPtr hwnd, int obj, int child, uint thread, uint time);

  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam, lParam; public uint time; public int x, y; }

  [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr module, WinEventProc proc, uint pid, uint tid, uint flags);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] static extern int GetMessage(out MSG msg, IntPtr h, uint min, uint max);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT rect);
  [DllImport("user32.dll")] static extern bool SystemParametersInfo(uint action, uint param, ref RECT rect, uint flags);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);

  const uint EVENT_SYSTEM_FOREGROUND = 0x0003;
  const uint EVENT_SYSTEM_MINIMIZEEND = 0x0017;
  const uint WINEVENT_OUTOFCONTEXT = 0;
  const uint SWP_NOSIZE = 0x1, SWP_NOMOVE = 0x2, SWP_NOACTIVATE = 0x10, SWP_NOOWNERZORDER = 0x200, SWP_NOSENDCHANGING = 0x400;
  const uint SPI_SETWORKAREA = 0x2F, SPIF_SENDCHANGE = 0x2;
  static readonly IntPtr HWND_BOTTOM = new IntPtr(1);

  static IntPtr din;
  static WinEventProc proc = OnEvent;

  static void Lower() {
    SetWindowPos(din, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_NOSENDCHANGING);
  }

  // Chromium raises its fullscreen window again once it's activated, after
  // the event: lower Din now and again once it has.
  static void OnEvent(IntPtr hook, uint ev, IntPtr hwnd, int obj, int child, uint thread, uint time) {
    if (obj != 0) return;
    Lower();
    ThreadPool.QueueUserWorkItem(_ => {
      foreach (int wait in new[] { 50, 150, 400 }) { Thread.Sleep(wait); Lower(); }
    });
  }

  // Windows fits windows into a new work area, Din's own with the rest: put
  // it back over the whole screen.
  public static void SetWorkArea(int left, int top, int right, int bottom) {
    RECT before;
    GetWindowRect(din, out before);
    RECT r = new RECT { Left = left, Top = top, Right = right, Bottom = bottom };
    SystemParametersInfo(SPI_SETWORKAREA, 0, ref r, SPIF_SENDCHANGE);
    SetWindowPos(din, HWND_BOTTOM, before.Left, before.Top, before.Right - before.Left, before.Bottom - before.Top, SWP_NOACTIVATE | SWP_NOOWNERZORDER);
  }

  // Hooks and their message loop, on a thread of their own; the caller waits
  // on stdin.
  public static void Start(long window) {
    SetProcessDpiAwarenessContext(new IntPtr(-4)); // per-monitor v2: physical pixels
    din = new IntPtr(window);
    Thread t = new Thread(() => {
      SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, IntPtr.Zero, proc, 0, 0, WINEVENT_OUTOFCONTEXT);
      SetWinEventHook(EVENT_SYSTEM_MINIMIZEEND, EVENT_SYSTEM_MINIMIZEEND, IntPtr.Zero, proc, 0, 0, WINEVENT_OUTOFCONTEXT);
      Lower();
      MSG msg;
      while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) { }
    });
    t.IsBackground = true;
    t.Start();
  }
}
'@

[DinShell]::Start($Window)
$full = $Right -gt $Left
if ($full) { [DinShell]::SetWorkArea($Left, $Top, $Right, $Bottom) }
# Lines on stdin: "workarea l t r b" when the displays change. EOF: Din quit.
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $parts = $line -split ' '
  if ($parts[0] -eq 'workarea' -and $parts.Count -eq 5) {
    [DinShell]::SetWorkArea([int]$parts[1], [int]$parts[2], [int]$parts[3], [int]$parts[4])
  }
}
