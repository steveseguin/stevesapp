/**
 * Windows API bindings using PowerShell
 * No native compilation required!
 */

const { execSync, exec } = require('child_process');

/**
 * Run a PowerShell command synchronously
 */
function runPowerShell(script) {
  try {
    const result = execSync(
      `powershell -NoProfile -ExecutionPolicy Bypass -Command "${script.replace(/"/g, '\\"')}"`,
      { encoding: 'utf8', windowsHide: true, timeout: 5000 }
    );
    return result.trim();
  } catch (error) {
    console.error('PowerShell error:', error.message);
    return null;
  }
}

/**
 * List all terminal windows
 */
function listTerminalWindows() {
  const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;

public class WindowEnumerator {
    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    private static extern int GetWindowTextLength(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    private static List<string> results = new List<string>();
    private static string[] terminalClasses = { "PuTTY", "ConsoleWindowClass", "CASCADIA_HOSTING_WINDOW_CLASS", "mintty", "VirtualConsoleClass" };

    private static bool EnumWindowsCallback(IntPtr hWnd, IntPtr lParam) {
        if (!IsWindowVisible(hWnd)) return true;

        StringBuilder className = new StringBuilder(256);
        GetClassName(hWnd, className, 256);
        string classStr = className.ToString();

        bool isTerminal = false;
        foreach (string tc in terminalClasses) {
            if (classStr.IndexOf(tc, StringComparison.OrdinalIgnoreCase) >= 0) {
                isTerminal = true;
                break;
            }
        }

        if (!isTerminal) return true;

        int length = GetWindowTextLength(hWnd);
        if (length == 0) return true;

        StringBuilder title = new StringBuilder(length + 1);
        GetWindowText(hWnd, title, length + 1);

        results.Add(hWnd.ToInt64() + "|" + title.ToString() + "|" + classStr);
        return true;
    }

    public static string[] GetWindows() {
        results.Clear();
        EnumWindows(EnumWindowsCallback, IntPtr.Zero);
        return results.ToArray();
    }
}
"@

[WindowEnumerator]::GetWindows() | ForEach-Object { Write-Output $_ }
`;

  const output = runPowerShell(script);
  if (!output) return [];

  const windows = [];
  for (const line of output.split('\n')) {
    const parts = line.trim().split('|');
    if (parts.length >= 3) {
      windows.push({
        hwnd: parseInt(parts[0]),
        title: parts[1],
        className: parts[2]
      });
    }
  }
  return windows;
}

/**
 * Get window title by HWND
 */
function getWindowTitle(hwnd) {
  const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public class WindowHelper {
    [DllImport("user32.dll")]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    public static extern int GetWindowTextLength(IntPtr hWnd);

    public static string GetTitle(long hwnd) {
        IntPtr hWnd = new IntPtr(hwnd);
        int length = GetWindowTextLength(hWnd);
        if (length == 0) return "";
        StringBuilder title = new StringBuilder(length + 1);
        GetWindowText(hWnd, title, length + 1);
        return title.ToString();
    }
}
"@

Write-Output ([WindowHelper]::GetTitle(${hwnd}))
`;

  return runPowerShell(script) || '';
}

/**
 * Send keystrokes to a window using SendMessage
 */
function sendKeys(hwnd, text) {
  // Use SendKeys through PowerShell - bring window to front and type
  const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;

public class KeySender {
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@

$hwnd = [IntPtr]::new(${hwnd})
[KeySender]::ShowWindow($hwnd, 9) # SW_RESTORE
Start-Sleep -Milliseconds 50
[KeySender]::SetForegroundWindow($hwnd)
Start-Sleep -Milliseconds 50
`;

  // First bring window to foreground
  runPowerShell(script);

  // Then send keys using SendKeys
  const escaped = text
    .replace(/\+/g, '{+}')
    .replace(/\^/g, '{^}')
    .replace(/%/g, '{%}')
    .replace(/~/g, '{~}')
    .replace(/\(/g, '{(}')
    .replace(/\)/g, '{)}')
    .replace(/\[/g, '{[}')
    .replace(/\]/g, '{]}')
    .replace(/\{/g, '{{}')
    .replace(/\}/g, '{}}');

  const sendScript = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait('${escaped.replace(/'/g, "''")}')
`;

  runPowerShell(sendScript);
}

/**
 * Send a special key
 */
function sendSpecialKey(hwnd, key) {
  const keyMap = {
    'RETURN': '{ENTER}',
    'TAB': '{TAB}',
    'ESCAPE': '{ESC}',
    'BACK': '{BACKSPACE}',
    'UP': '{UP}',
    'DOWN': '{DOWN}',
    'LEFT': '{LEFT}',
    'RIGHT': '{RIGHT}',
    'HOME': '{HOME}',
    'END': '{END}',
    'DELETE': '{DELETE}',
    'PAGEUP': '{PGUP}',
    'PAGEDOWN': '{PGDN}'
  };

  const sendKey = keyMap[key.toUpperCase()];
  if (!sendKey) return;

  // Bring window to foreground first
  const focusScript = `
Add-Type @"
using System;
using System.Runtime.InteropServices;

public class KeySender {
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@

$hwnd = [IntPtr]::new(${hwnd})
[KeySender]::ShowWindow($hwnd, 9)
Start-Sleep -Milliseconds 50
[KeySender]::SetForegroundWindow($hwnd)
Start-Sleep -Milliseconds 50
`;

  runPowerShell(focusScript);

  const sendScript = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait('${sendKey}')
`;

  runPowerShell(sendScript);
}

module.exports = {
  listTerminalWindows,
  getWindowTitle,
  sendKeys,
  sendSpecialKey
};
