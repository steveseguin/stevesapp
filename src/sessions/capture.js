const EventEmitter = require('events');
const { v4: uuidv4 } = require('uuid');
const { exec } = require('child_process');
const path = require('path');

/**
 * CaptureSession - captures text from existing terminal windows
 *
 * Uses PowerShell with UI Automation to extract text content
 * and Windows API to inject keystrokes
 */
class CaptureSession extends EventEmitter {
  constructor(hwnd) {
    super();

    this.id = uuidv4();
    this.type = 'capture';
    this.hwnd = hwnd;
    this.clients = new Set();
    this.buffer = [];
    this.maxBuffer = parseInt(process.env.SCROLLBACK) || 10000;
    this.lastContent = '';
    this.pollInterval = null;
    this.title = '';
    this.cols = 80;
    this.rows = 24;

    // Get initial window title
    this.updateTitle();

    // Start polling for content
    this.startPolling();
  }

  updateTitle() {
    const windowApi = require('../native');
    try {
      this.title = windowApi.getWindowTitle(this.hwnd);
    } catch (e) {
      this.title = `Window ${this.hwnd}`;
    }
  }

  startPolling() {
    // Poll every 100ms for window content changes
    this.pollInterval = setInterval(() => {
      this.captureContent();
    }, 100);
  }

  stopPolling() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  /**
   * Capture window content using PowerShell UI Automation
   * This works for PuTTY and other terminal windows
   */
  captureContent() {
    // PowerShell script to get text content via UI Automation
    // Using string concatenation to avoid template literal issues with PowerShell backticks
    const psScript = [
      'Add-Type -AssemblyName UIAutomationClient',
      'Add-Type -AssemblyName UIAutomationTypes',
      'try {',
      '  $hwnd = [IntPtr]::new(' + this.hwnd + ')',
      '  $element = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)',
      '  if ($element) {',
      '    $textPattern = $null',
      '    $hasText = $element.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$textPattern)',
      '    if ($hasText -and $textPattern) {',
      '      $text = $textPattern.DocumentRange.GetText(-1)',
      '      Write-Output $text',
      '    } else {',
      '      $condition = [System.Windows.Automation.PropertyCondition]::new(',
      '        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,',
      '        [System.Windows.Automation.ControlType]::Text',
      '      )',
      '      $children = $element.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)',
      '      $allText = @()',
      '      foreach ($child in $children) {',
      '        $name = $child.Current.Name',
      '        if ($name) { $allText += $name }',
      '      }',
      '      if ($allText.Count -gt 0) {',
      '        Write-Output ($allText -join [char]10)',
      '      } else {',
      '        Write-Output $element.Current.Name',
      '      }',
      '    }',
      '  }',
      '} catch {',
      '  Write-Error $_.Exception.Message',
      '}'
    ].join('; ');

    exec(`powershell -NoProfile -Command "${psScript.replace(/"/g, '\\"').replace(/\n/g, '; ')}"`,
      { encoding: 'utf8', windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          // Window may have closed
          if (error.message.includes('handle') || error.message.includes('element')) {
            this.emit('exit');
            this.stopPolling();
          }
          return;
        }

        const content = stdout.trim();

        // Only send if content changed
        if (content && content !== this.lastContent) {
          // Calculate diff (simple approach: send full content if changed significantly)
          const diff = this.calculateDiff(this.lastContent, content);
          this.lastContent = content;

          if (diff) {
            this.appendBuffer(diff);
            this.broadcast({ type: 'output', data: diff });
          }
        }
      }
    );
  }

  /**
   * Calculate what's new in the content
   * Simple approach: if content ends with new text, send just the new part
   */
  calculateDiff(oldContent, newContent) {
    if (!oldContent) {
      // First capture - send everything with clear screen
      return '\x1b[2J\x1b[H' + newContent;
    }

    // If new content is completely different, send full refresh
    if (!newContent.startsWith(oldContent.substring(0, 50))) {
      return '\x1b[2J\x1b[H' + newContent;
    }

    // Find what's new at the end
    if (newContent.startsWith(oldContent)) {
      return newContent.substring(oldContent.length);
    }

    // Content changed in the middle - full refresh
    return '\x1b[2J\x1b[H' + newContent;
  }

  appendBuffer(data) {
    this.buffer.push(data);
    if (this.buffer.length > this.maxBuffer) {
      this.buffer = this.buffer.slice(-this.maxBuffer);
    }
  }

  getBuffer() {
    return this.buffer.join('');
  }

  write(data) {
    const windowApi = require('../native');

    // Handle special keys
    if (data === '\r' || data === '\n') {
      windowApi.sendSpecialKey(this.hwnd, 'RETURN');
    } else if (data === '\t') {
      windowApi.sendSpecialKey(this.hwnd, 'TAB');
    } else if (data === '\x7f' || data === '\b') {
      windowApi.sendSpecialKey(this.hwnd, 'BACK');
    } else if (data === '\x1b[A') {
      windowApi.sendSpecialKey(this.hwnd, 'UP');
    } else if (data === '\x1b[B') {
      windowApi.sendSpecialKey(this.hwnd, 'DOWN');
    } else if (data === '\x1b[C') {
      windowApi.sendSpecialKey(this.hwnd, 'RIGHT');
    } else if (data === '\x1b[D') {
      windowApi.sendSpecialKey(this.hwnd, 'LEFT');
    } else if (data === '\x1b') {
      windowApi.sendSpecialKey(this.hwnd, 'ESCAPE');
    } else {
      // Regular text
      windowApi.sendKeys(this.hwnd, data);
    }
  }

  resize(cols, rows) {
    // Can't resize external windows, just track for reference
    this.cols = cols;
    this.rows = rows;
  }

  addClient(ws) {
    this.clients.add(ws);
  }

  removeClient(ws) {
    this.clients.delete(ws);
  }

  broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const client of this.clients) {
      if (client.readyState === 1) {
        client.send(data);
      }
    }
  }

  destroy() {
    this.stopPolling();
    this.clients.clear();
  }
}

module.exports = CaptureSession;
