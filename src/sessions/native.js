const EventEmitter = require('events');
const { spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');

// Try to load node-pty for proper PTY support
let pty = null;
try {
  pty = require('node-pty');
  console.log('node-pty loaded - full PTY support enabled');
} catch (e) {
  console.log('node-pty not available - using child_process fallback (no arrow key/history support)');
  console.log('node-pty error:', e.message);
}

/**
 * NativeSession - spawns shell processes
 * Uses node-pty if available for full PTY support, otherwise falls back to child_process
 */
class NativeSession extends EventEmitter {
  constructor(options = {}) {
    super();

    this.id = uuidv4();
    this.type = 'native';
    this.shell = options.shell || 'cmd.exe';
    this.cols = options.cols || 120;
    this.rows = options.rows || 30;
    this.clients = new Set();
    this.usePty = !!pty;

    // Scrollback buffer
    this.buffer = [];
    this.maxBuffer = parseInt(process.env.SCROLLBACK) || 10000;

    // Shared line editor state for non-PTY sessions
    this.lineBuffer = '';
    this.cursorPos = 0;
    this.commandHistory = [];
    this.historyIndex = -1;

    // Determine shell and args
    let shellPath = this.shell;
    let shellArgs = [];

    if (this.shell === 'wsl' || this.shell === 'wsl.exe') {
      shellPath = 'wsl.exe';
      shellArgs = [];
    } else if (this.shell === 'powershell' || this.shell === 'powershell.exe') {
      shellPath = 'powershell.exe';
      shellArgs = ['-NoLogo'];
    } else if (this.shell === 'cmd' || this.shell === 'cmd.exe') {
      shellPath = 'cmd.exe';
      shellArgs = this.usePty ? [] : ['/Q']; // Only use /Q without PTY
    } else if (this.shell.startsWith('ssh ')) {
      // SSH command: extract host and args
      const parts = this.shell.split(' ');
      shellPath = 'ssh';
      shellArgs = parts.slice(1);
    }

    if (this.usePty) {
      // Use node-pty for full PTY support
      this.process = pty.spawn(shellPath, shellArgs, {
        name: 'xterm-256color',
        cols: this.cols,
        rows: this.rows,
        cwd: process.env.USERPROFILE || process.env.HOME,
        env: process.env
      });

      this.process.onData((data) => {
        console.log('PTY data:', JSON.stringify(data.substring(0, 100)));
        this.appendBuffer(data);
        this.broadcast({ type: 'output', data });
      });

      this.process.onExit(({ exitCode }) => {
        this.emit('exit', exitCode);
      });

    } else {
      // Fallback to child_process
      this.process = spawn(shellPath, shellArgs, {
        cwd: process.env.USERPROFILE || process.env.HOME,
        env: {
          ...process.env,
          TERM: 'xterm-256color',
          COLUMNS: String(this.cols),
          LINES: String(this.rows)
        },
        shell: false,
        windowsHide: true
      });

      // Handle stdout
      this.process.stdout.on('data', (data) => {
        const str = data.toString();
        console.log('Shell stdout:', JSON.stringify(str));
        this.appendBuffer(str);
        this.broadcast({ type: 'output', data: str });
      });

      // Handle stderr (merge with stdout)
      this.process.stderr.on('data', (data) => {
        const str = data.toString();
        this.appendBuffer(str);
        this.broadcast({ type: 'output', data: str });
      });

      // Handle process exit
      this.process.on('exit', (code) => {
        this.emit('exit', code);
      });

      this.process.on('error', (err) => {
        console.error('Process error:', err);
        this.broadcast({ type: 'output', data: `\r\nError: ${err.message}\r\n` });
      });
    }

    // Log session start (don't inject into terminal output)
    const mode = this.usePty ? 'PTY' : 'basic';
    console.log(`[Session] Started: ${shellPath} (${mode})`);
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

  emitOutput(data) {
    this.appendBuffer(data);
    this.broadcast({ type: 'output', data });
  }

  handleLineInput(data) {
    // Handle escape sequences (arrow keys, etc.)
    if (data === '\x1b[A') {
      this.historyUp();
    } else if (data === '\x1b[B') {
      this.historyDown();
    } else if (data === '\x1b[C') {
      this.cursorRight();
    } else if (data === '\x1b[D') {
      this.cursorLeft();
    } else if (data === '\x1b[H' || data === '\x1b[1~') {
      this.cursorHome();
    } else if (data === '\x1b[F' || data === '\x1b[4~') {
      this.cursorEnd();
    } else if (data === '\x7f' || data === '\b') {
      this.handleBackspace();
    } else if (data === '\x1b[3~') {
      this.handleDelete();
    } else if (data === '\r' || data === '\n') {
      this.submitLine();
    } else if (data === '\x03') {
      this.cancelLine();
    } else if (data === '\t') {
      this.insertText('    ');
    } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
      this.insertText(data);
    } else if (data.length > 1 && !data.startsWith('\x1b')) {
      this.insertText(data);
    }
  }

  insertText(text) {
    const before = this.lineBuffer.substring(0, this.cursorPos);
    const after = this.lineBuffer.substring(this.cursorPos);
    this.lineBuffer = before + text + after;
    this.cursorPos += text.length;

    if (after.length === 0) {
      this.emitOutput(text);
    } else {
      this.emitOutput(text + after + `\x1b[${after.length}D`);
    }
  }

  handleBackspace() {
    if (this.cursorPos > 0) {
      const before = this.lineBuffer.substring(0, this.cursorPos - 1);
      const after = this.lineBuffer.substring(this.cursorPos);
      this.lineBuffer = before + after;
      this.cursorPos--;

      if (after.length === 0) {
        this.emitOutput('\b \b');
      } else {
        this.emitOutput('\b' + after + ' ' + `\x1b[${after.length + 1}D`);
      }
    }
  }

  handleDelete() {
    if (this.cursorPos < this.lineBuffer.length) {
      const before = this.lineBuffer.substring(0, this.cursorPos);
      const after = this.lineBuffer.substring(this.cursorPos + 1);
      this.lineBuffer = before + after;
      this.emitOutput(after + ' ' + `\x1b[${after.length + 1}D`);
    }
  }

  cursorLeft() {
    if (this.cursorPos > 0) {
      this.cursorPos--;
      this.emitOutput('\x1b[D');
    }
  }

  cursorRight() {
    if (this.cursorPos < this.lineBuffer.length) {
      this.cursorPos++;
      this.emitOutput('\x1b[C');
    }
  }

  cursorHome() {
    if (this.cursorPos > 0) {
      this.emitOutput(`\x1b[${this.cursorPos}D`);
      this.cursorPos = 0;
    }
  }

  cursorEnd() {
    const move = this.lineBuffer.length - this.cursorPos;
    if (move > 0) {
      this.emitOutput(`\x1b[${move}C`);
      this.cursorPos = this.lineBuffer.length;
    }
  }

  historyUp() {
    if (this.commandHistory.length === 0) return;
    if (this.historyIndex < this.commandHistory.length - 1) {
      this.historyIndex++;
      this.loadHistoryItem();
    }
  }

  historyDown() {
    if (this.historyIndex > 0) {
      this.historyIndex--;
      this.loadHistoryItem();
    } else if (this.historyIndex === 0) {
      this.historyIndex = -1;
      this.clearCurrentLine();
      this.lineBuffer = '';
      this.cursorPos = 0;
    }
  }

  loadHistoryItem() {
    const cmd = this.commandHistory[this.commandHistory.length - 1 - this.historyIndex];
    this.clearAndReplace(cmd);
  }

  clearAndReplace(newText) {
    let output = '';
    if (this.cursorPos > 0) {
      output += `\x1b[${this.cursorPos}D`;
    }
    if (this.lineBuffer.length > 0) {
      output += ' '.repeat(this.lineBuffer.length) + `\x1b[${this.lineBuffer.length}D`;
    }
    output += newText;

    this.lineBuffer = newText;
    this.cursorPos = newText.length;
    this.emitOutput(output);
  }

  clearCurrentLine() {
    this.clearAndReplace('');
  }

  submitLine() {
    if (this.lineBuffer.trim()) {
      this.commandHistory.push(this.lineBuffer);
      if (this.commandHistory.length > 100) {
        this.commandHistory.shift();
      }
    }
    this.historyIndex = -1;

    this.emitOutput('\r\n');
    this.writeToProcess(this.lineBuffer + '\r');

    this.lineBuffer = '';
    this.cursorPos = 0;
  }

  cancelLine() {
    this.emitOutput('^C\r\n');
    this.lineBuffer = '';
    this.cursorPos = 0;
    this.historyIndex = -1;
    this.writeToProcess('\x03');
  }

  writeToProcess(data) {
    if (this.process && this.process.stdin && this.process.stdin.writable) {
      const normalized = data.replace(/\r(?!\n)/g, '\r\n');
      console.log('Writing to shell:', JSON.stringify(normalized));
      this.process.stdin.write(normalized);
    } else {
      console.log('Cannot write - stdin not writable');
    }
  }

  write(data, options = {}) {
    const isPaste = options.paste || false;
    const LARGE_PASTE_THRESHOLD = 200; // bytes
    const isLargePaste = isPaste && data.length > LARGE_PASTE_THRESHOLD;

    if (this.usePty) {
      // PTY handles everything - use bracketed paste for large pastes
      if (isLargePaste) {
        // Bracketed paste mode: wrap content so shell knows it's pasted
        const bracketedData = `\x1b[200~${data}\x1b[201~`;
        console.log(`Writing large paste to PTY: ${data.length} bytes`);
        this.process.write(bracketedData);
      } else {
        console.log('Writing to PTY:', JSON.stringify(data.slice(0, 50)));
        this.process.write(data);
      }
    } else if (this.process && this.process.stdin && this.process.stdin.writable) {
      // Server-side line editor for non-PTY sessions
      if (isLargePaste) {
        this.handleLargePaste(data);
      } else {
        this.handleLineInput(data);
      }
    } else {
      console.log('Cannot write - stdin not writable');
    }
  }

  handleLargePaste(data) {
    // For large pastes in non-PTY mode:
    // 1. Show a summary to all clients
    // 2. Insert the data into line buffer (no echo)
    // 3. The data will be sent when user presses Enter

    const lines = data.split(/\r?\n/);
    const lineCount = lines.length;
    const byteCount = data.length;
    const hasNewlines = lineCount > 1;

    // Format size nicely
    let sizeStr;
    if (byteCount >= 1024) {
      sizeStr = (byteCount / 1024).toFixed(1) + 'KB';
    } else {
      sizeStr = byteCount + ' bytes';
    }

    // Show paste indicator
    const indicator = hasNewlines
      ? `[Pasted ${sizeStr}, ${lineCount} lines]`
      : `[Pasted ${sizeStr}]`;

    // Insert data into line buffer silently
    const before = this.lineBuffer.substring(0, this.cursorPos);
    const after = this.lineBuffer.substring(this.cursorPos);
    this.lineBuffer = before + data + after;
    this.cursorPos += data.length;

    // Show indicator and a preview
    const preview = data.slice(0, 50).replace(/[\r\n]/g, '↵');
    const displayText = preview + (data.length > 50 ? '...' : '');

    // Emit the indicator (dim/gray) followed by abbreviated content
    this.emitOutput(`\x1b[90m${indicator}\x1b[0m ${displayText}`);

    // If paste contains newlines, auto-submit each line
    if (hasNewlines) {
      // Clear current display and process line by line
      this.emitOutput('\r\n');

      // Split and execute each line
      const allLines = this.lineBuffer.split(/\r?\n/);
      for (let i = 0; i < allLines.length; i++) {
        const line = allLines[i];
        if (i < allLines.length - 1) {
          // Complete line - execute it
          if (line.trim()) {
            this.commandHistory.push(line);
            if (this.commandHistory.length > 100) {
              this.commandHistory.shift();
            }
          }
          this.writeToProcess(line + '\r\n');
        } else {
          // Last segment - keep in buffer for editing
          this.lineBuffer = line;
          this.cursorPos = line.length;
        }
      }
      this.historyIndex = -1;
    }
  }

  resize(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    if (this.usePty && this.process) {
      this.process.resize(cols, rows);
    }
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
      if (client.readyState === 1) { // WebSocket.OPEN
        client.send(data);
      }
    }
  }

  destroy() {
    if (this.process) {
      if (this.usePty) {
        this.process.kill();
      } else {
        this.process.kill();
      }
    }
    this.clients.clear();
  }
}

module.exports = NativeSession;
