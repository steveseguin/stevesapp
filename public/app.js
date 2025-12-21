/**
 * Terminal Hub Client
 */

class TerminalHub {
  constructor() {
    this.token = localStorage.getItem('terminal-hub-token') || '';
    this.ws = null;
    this.term = null;
    this.fitAddon = null;
    this.currentSessionId = null;
    this.sessions = [];
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;

    // VDO.Ninja P2P relay
    this.vdo = null;
    this.p2pActive = false;
    this.p2pPeers = new Set();
    this.terminalBuffer = ''; // Cache terminal output for new P2P peers
    this.sessionBuffers = {}; // Per-session buffers for independent viewing
    this.pendingUploads = {}; // For reassembling chunked uploads

    // Line editor for cursor support without PTY
    this.lineBuffer = '';
    this.cursorPos = 0;
    this.commandHistory = [];
    this.historyIndex = -1;
    this.promptLength = 0; // Track where the prompt ends
    this.hasPty = false; // Will be set based on server info

    // Activity tracking per session
    this.sessionActivity = {}; // sessionId -> lastActivityTime

    this.initElements();
    this.initEvents();

    // Auto-connect if token exists
    if (this.token) {
      this.connect();
    }
  }

  initElements() {
    // Screens
    this.authScreen = document.getElementById('auth-screen');
    this.mainScreen = document.getElementById('main-screen');

    // Auth
    this.tokenInput = document.getElementById('token-input');
    this.connectBtn = document.getElementById('connect-btn');
    this.authError = document.getElementById('auth-error');

    // Sidebar
    this.sidebar = document.getElementById('sidebar');
    this.toggleSidebarBtn = document.getElementById('toggle-sidebar');
    this.sessionList = document.getElementById('session-list');
    this.shellSelect = document.getElementById('shell-select');
    this.newSessionBtn = document.getElementById('new-session-btn');
    this.refreshWindowsBtn = document.getElementById('refresh-windows-btn');
    this.windowsList = document.getElementById('windows-list');

    // Terminal
    this.terminalContainer = document.getElementById('terminal');
    this.sessionInfo = document.getElementById('session-info');
    this.disconnectBtn = document.getElementById('disconnect-btn');

    // P2P controls
    this.p2pToggle = document.getElementById('p2p-toggle');
    this.p2pStatus = document.getElementById('p2p-status');
  }

  initEvents() {
    // Auth
    this.connectBtn.addEventListener('click', () => this.handleConnect());
    this.tokenInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') this.handleConnect();
    });

    // Sidebar toggle
    this.toggleSidebarBtn.addEventListener('click', () => this.toggleSidebar());

    // Floating toggle (when sidebar is collapsed)
    this.floatingToggle = document.getElementById('floating-toggle');
    this.floatingToggle.addEventListener('click', () => this.toggleSidebar());

    // New session
    this.newSessionBtn.addEventListener('click', () => this.createSession());

    // Shell select custom option
    this.shellSelect.addEventListener('change', (e) => {
      if (e.target.value === 'custom') {
        const custom = prompt('Enter shell command (e.g., ssh user@host)');
        if (custom) {
          const option = document.createElement('option');
          option.value = custom;
          option.textContent = custom;
          this.shellSelect.insertBefore(option, this.shellSelect.lastElementChild);
          this.shellSelect.value = custom;
        } else {
          this.shellSelect.value = 'cmd.exe';
        }
      }
    });

    // Refresh windows
    this.refreshWindowsBtn.addEventListener('click', () => this.refreshWindows());

    // Disconnect
    this.disconnectBtn.addEventListener('click', () => this.detachSession());

    // P2P toggle
    this.p2pToggle.addEventListener('click', () => this.toggleP2P());

    // Window resize
    window.addEventListener('resize', () => this.handleResize());

    // Mobile: close sidebar on terminal click
    this.terminalContainer.addEventListener('click', () => {
      if (window.innerWidth <= 768) {
        this.sidebar.classList.remove('open');
      }
    });
  }

  handleConnect() {
    this.token = this.tokenInput.value.trim();
    if (!this.token) {
      this.authError.textContent = 'Please enter a token';
      return;
    }

    this.authError.textContent = '';
    localStorage.setItem('terminal-hub-token', this.token);
    this.connect();
  }

  connect() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}?token=${encodeURIComponent(this.token)}`;

    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      console.log('Connected to Terminal Hub');
      this.reconnectAttempts = 0;
      this.showMainScreen();
      this.initTerminal();
    };

    this.ws.onmessage = (event) => {
      this.handleMessage(JSON.parse(event.data));
    };

    this.ws.onclose = (event) => {
      console.log('Disconnected:', event.code, event.reason);

      if (event.code === 4001) {
        // Auth failed
        this.authError.textContent = 'Invalid token';
        this.showAuthScreen();
        localStorage.removeItem('terminal-hub-token');
        return;
      }

      // Attempt reconnect
      if (this.reconnectAttempts < this.maxReconnectAttempts) {
        this.reconnectAttempts++;
        const delay = Math.min(1000 * this.reconnectAttempts, 10000);
        console.log(`Reconnecting in ${delay}ms...`);
        setTimeout(() => this.connect(), delay);
      }
    };

    this.ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };
  }

  handleMessage(msg) {
    switch (msg.type) {
      case 'sessions':
        this.sessions = msg.sessions;
        this.renderSessions();
        if (this.p2pActive && this.p2pDataChannelReady) {
          this.sendP2P({ type: 'sessions', sessions: this.sessions });
        }
        break;

      case 'output':
        const outputSessionId = msg.sessionId || this.currentSessionId;
        console.log('WS output received, session:', outputSessionId, 'length:', msg.data.length);

        // Track activity for this session
        if (outputSessionId) {
          this.sessionActivity[outputSessionId] = Date.now();
          this.updateSessionActivityDisplay();
        }

        // Store in per-session buffer
        if (outputSessionId) {
          this.sessionBuffers[outputSessionId] = (this.sessionBuffers[outputSessionId] || '') + msg.data;
          if (this.sessionBuffers[outputSessionId].length > 50000) {
            this.sessionBuffers[outputSessionId] = this.sessionBuffers[outputSessionId].slice(-50000);
          }
        }

        // Only display if it's our selected session
        if (outputSessionId === this.currentSessionId) {
          if (this.term) {
            this.term.write(msg.data);
          }
          // Track prompt for line editor (look for common prompt patterns)
          if (!this.hasPty) {
            const lines = msg.data.split('\n');
            const lastLine = lines[lines.length - 1];
            if (/[>$#]\s*$/.test(lastLine) && lastLine.length < 100) {
              this.currentPrompt = lastLine;
              this.resetLineEditor();
            }
          }
          // Update current session buffer
          this.terminalBuffer += msg.data;
          if (this.terminalBuffer.length > 50000) {
            this.terminalBuffer = this.terminalBuffer.slice(-50000);
          }
        }

        // Relay to P2P peers with sessionId
        this.sendP2P({ type: 'output', data: msg.data, sessionId: outputSessionId });
        break;

      case 'buffer':
        const bufferSessionId = msg.sessionId || this.currentSessionId;
        console.log('WS buffer received, session:', bufferSessionId, 'length:', msg.data.length);

        // Store in per-session buffer
        if (bufferSessionId) {
          this.sessionBuffers[bufferSessionId] = msg.data;
        }

        // Only display if it's our selected session
        if (bufferSessionId === this.currentSessionId) {
          this.terminalBuffer = msg.data;
          if (this.term) {
            this.term.clear();
            this.term.write(msg.data);
          }
        }

        // Relay buffer to P2P peers with sessionId
        this.sendP2P({ type: 'buffer', data: msg.data, sessionId: bufferSessionId });
        break;

      case 'info':
        this.currentSessionId = msg.sessionId;
        this.hasPty = msg.hasPty || false;
        const sessionEntry = this.sessions.find(session => session.id === msg.sessionId);
        if (sessionEntry) {
          sessionEntry.hasPty = this.hasPty;
        }
        const mode = this.hasPty ? 'PTY' : 'line-edit';
        this.sessionInfo.textContent = `${msg.sessionType} (${mode}): ${msg.sessionId.substring(0, 8)}...`;
        this.disconnectBtn.classList.remove('hidden');
        this.resetLineEditor();
        break;

      case 'error':
        console.error('Server error:', msg.message);
        // Relay errors to P2P peers
        this.sendP2P({ type: 'error', message: msg.message });
        break;

      case 'uploadComplete':
        console.log('Upload complete:', msg.filename);
        // Relay to P2P peers so phone gets confirmation
        this.sendP2P({ type: 'uploadComplete', filename: msg.filename });
        break;
    }
  }

  showAuthScreen() {
    this.authScreen.classList.remove('hidden');
    this.mainScreen.classList.add('hidden');
  }

  showMainScreen() {
    this.authScreen.classList.add('hidden');
    this.mainScreen.classList.remove('hidden');
    this.startActivityTimer();
  }

  toggleSidebar() {
    if (window.innerWidth <= 768) {
      this.sidebar.classList.toggle('open');
    } else {
      this.sidebar.classList.toggle('collapsed');
    }
  }

  initTerminal() {
    if (this.term) {
      this.term.dispose();
    }

    this.term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: '#1a1a2e',
        foreground: '#eaeaea',
        cursor: '#e94560',
        cursorAccent: '#1a1a2e',
        selectionBackground: '#e9456050',
        // ANSI 16-color palette
        black: '#1a1a2e',
        red: '#e94560',
        green: '#4ecca3',
        yellow: '#f9ed69',
        blue: '#3498db',
        magenta: '#9b59b6',
        cyan: '#00d9ff',
        white: '#eaeaea',
        brightBlack: '#4a4a6e',
        brightRed: '#ff6b8a',
        brightGreen: '#7dffce',
        brightYellow: '#fff89a',
        brightBlue: '#5dade2',
        brightMagenta: '#bb8fce',
        brightCyan: '#40e0ff',
        brightWhite: '#ffffff'
      },
      allowProposedApi: true,
      rightClickSelectsWord: true
    });

    // Paste on right-click
    this.terminalContainer.addEventListener('contextmenu', async (e) => {
      e.preventDefault();
      await this.pasteFromClipboard();
    });

    // Also handle paste via document-level event (for mobile and fallback)
    document.addEventListener('paste', async (e) => {
      // Only handle if terminal is focused
      if (!this.term || !document.activeElement?.closest('#terminal')) return;
      e.preventDefault();

      // Check for image paste first
      const items = e.clipboardData?.items;
      if (items) {
        for (const item of items) {
          if (item.type.startsWith('image/')) {
            const file = item.getAsFile();
            if (file) {
              await this.uploadFile(file);
              return;
            }
          }
        }
      }

      // Otherwise handle text paste
      const text = e.clipboardData?.getData('text');
      if (text && this.currentSessionId && this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'input', data: text, paste: true }));
      }
    });

    // Handle copy via document-level event
    document.addEventListener('copy', (e) => {
      if (!this.term || !document.activeElement?.closest('#terminal')) return;
      const selection = this.term.getSelection();
      if (selection) {
        e.preventDefault();
        e.clipboardData?.setData('text/plain', selection);
      }
    });

    this.fitAddon = new FitAddon.FitAddon();
    this.term.loadAddon(this.fitAddon);
    this.term.loadAddon(new WebLinksAddon.WebLinksAddon());

    this.term.open(this.terminalContainer);
    this.fitAddon.fit();

    // Handle input; server echoes/edits for non-PTY sessions.
    this.term.onData((data) => {
      console.log('Terminal input:', JSON.stringify(data), 'Session:', this.currentSessionId);
      if (!this.currentSessionId || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
        console.log('Not sending - no session or WS not open');
        return;
      }

      // Always send raw input; server handles echo/line editing for non-PTY.
      this.ws.send(JSON.stringify({ type: 'input', data }));
    });

    // Click to focus
    this.terminalContainer.addEventListener('click', () => {
      this.term.focus();
    });

    // Ctrl+V paste, Ctrl+C copy
    this.term.attachCustomKeyEventHandler((e) => {
      const key = e.key.toLowerCase();
      const isModifier = e.ctrlKey || e.metaKey;

      if (isModifier && key === 'v' && e.type === 'keydown') {
        this.pasteFromClipboard();
        return false; // Prevent default
      }

      // Ctrl/Cmd+C to copy (if there's a selection)
      if (isModifier && key === 'c' && e.type === 'keydown') {
        const selection = this.term.getSelection();
        if (selection) {
          this.copyToClipboard(selection);
          return false; // Prevent sending Ctrl+C to shell
        }
        // No selection - let Ctrl+C go through to shell
      }

      // Ctrl+Shift+C always copies (like some terminals)
      if (e.ctrlKey && e.shiftKey && key === 'c' && e.type === 'keydown') {
        const selection = this.term.getSelection();
        if (selection) {
          this.copyToClipboard(selection);
          return false;
        }
      }

      // Ctrl+Shift+V always pastes
      if (e.ctrlKey && e.shiftKey && key === 'v' && e.type === 'keydown') {
        this.pasteFromClipboard();
        return false;
      }

      return true;
    });

    // Initial welcome
    this.term.writeln('Terminal Hub - Select or create a session');
    this.term.writeln('');

    // Focus the terminal
    this.term.focus();
  }

  handleResize() {
    if (this.fitAddon) {
      this.fitAddon.fit();

      if (this.currentSessionId && this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          type: 'resize',
          cols: this.term.cols,
          rows: this.term.rows
        }));
      }
    }
  }

  renderSessions() {
    this.sessionList.innerHTML = '';

    if (this.sessions.length === 0) {
      this.sessionList.innerHTML = '<p style="padding: 12px; color: var(--text-secondary);">No active sessions</p>';
      return;
    }

    for (const session of this.sessions) {
      const div = document.createElement('div');
      div.className = 'session-item' + (session.id === this.currentSessionId ? ' active' : '');
      div.dataset.sessionId = session.id;

      const name = session.type === 'native'
        ? session.shell
        : session.title || `Window ${session.hwnd}`;

      div.innerHTML = `
        <div class="type">${session.type}</div>
        <div class="name">${this.escapeHtml(name)}</div>
        <div class="activity" data-session-id="${session.id}">${this.getActivityText(session.id)}</div>
        <div class="actions">
          <button class="attach">Attach</button>
          <button class="destroy">Destroy</button>
        </div>
      `;

      div.querySelector('.attach').addEventListener('click', (e) => {
        e.stopPropagation();
        this.attachSession(session.id);
      });

      div.querySelector('.destroy').addEventListener('click', (e) => {
        e.stopPropagation();
        this.destroySession(session.id);
      });

      div.addEventListener('click', () => this.attachSession(session.id));

      this.sessionList.appendChild(div);
    }
  }

  getActivityText(sessionId) {
    const lastActivity = this.sessionActivity[sessionId];
    if (!lastActivity) return '';

    const elapsed = Date.now() - lastActivity;
    if (elapsed < 10000) {
      return '<span class="activity-active">Active</span>';
    }

    const seconds = Math.floor(elapsed / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ago`;
  }

  updateSessionActivityDisplay() {
    // Update activity text for all sessions in the list
    const activityElements = document.querySelectorAll('.activity[data-session-id]');
    for (const el of activityElements) {
      const sessionId = el.dataset.sessionId;
      el.innerHTML = this.getActivityText(sessionId);
    }
  }

  startActivityTimer() {
    // Update activity display every 5 seconds
    if (this.activityTimer) clearInterval(this.activityTimer);
    this.activityTimer = setInterval(() => {
      this.updateSessionActivityDisplay();
      // Also send activity updates to P2P peers
      this.sendP2P({ type: 'activity', activity: this.sessionActivity });
    }, 5000);
  }

  attachSession(sessionId) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'attach', sessionId }));
      this.term.clear();
      this.terminalBuffer = ''; // Clear buffer for new session

      // Close sidebar on mobile, collapse on desktop
      if (window.innerWidth <= 768) {
        this.sidebar.classList.remove('open');
      }

      // Focus terminal after a brief delay to ensure it's ready
      setTimeout(() => {
        this.term.focus();
      }, 100);
    }
  }

  detachSession() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'detach' }));
    }
    this.currentSessionId = null;
    this.terminalBuffer = ''; // Clear buffer
    this.sessionInfo.textContent = 'No session selected';
    this.disconnectBtn.classList.add('hidden');
    this.term.clear();
    this.term.writeln('Session detached. Select or create a new session.');
    this.renderSessions();
  }

  async createSession() {
    const shell = this.shellSelect.value;

    try {
      const response = await fetch('/api/sessions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`
        },
        body: JSON.stringify({
          shell,
          cols: this.term ? this.term.cols : 120,
          rows: this.term ? this.term.rows : 30
        })
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to create session');
      }

      const session = await response.json();
      console.log('Created session:', session);

      // Auto-attach to new session
      setTimeout(() => this.attachSession(session.id), 100);
    } catch (error) {
      console.error('Failed to create session:', error);
      alert('Failed to create session: ' + error.message);
    }
  }

  async destroySession(sessionId) {
    if (!confirm('Destroy this session?')) return;

    try {
      const response = await fetch(`/api/sessions/${sessionId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${this.token}`
        }
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to destroy session');
      }

      if (this.currentSessionId === sessionId) {
        this.detachSession();
      }
    } catch (error) {
      console.error('Failed to destroy session:', error);
      alert('Failed to destroy session: ' + error.message);
    }
  }

  async refreshWindows() {
    try {
      const response = await fetch('/api/windows', {
        headers: {
          'Authorization': `Bearer ${this.token}`
        }
      });

      if (!response.ok) {
        throw new Error('Failed to list windows');
      }

      const windows = await response.json();
      this.renderWindows(windows);
    } catch (error) {
      console.error('Failed to list windows:', error);
      this.windowsList.innerHTML = '<p style="color: var(--accent);">Failed to scan windows</p>';
    }
  }

  renderWindows(windows) {
    this.windowsList.innerHTML = '';

    if (windows.length === 0) {
      this.windowsList.innerHTML = '<p style="color: var(--text-secondary); font-size: 0.85rem;">No terminal windows found</p>';
      return;
    }

    for (const win of windows) {
      const div = document.createElement('div');
      div.className = 'window-item';
      div.innerHTML = `
        <div class="title">${this.escapeHtml(win.title)}</div>
        <div class="class">${this.escapeHtml(win.className)}</div>
      `;

      div.addEventListener('click', () => this.attachToWindow(win.hwnd));
      this.windowsList.appendChild(div);
    }
  }

  async attachToWindow(hwnd) {
    try {
      const response = await fetch(`/api/windows/${hwnd}/attach`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.token}`
        }
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to attach to window');
      }

      const session = await response.json();
      console.log('Attached to window:', session);

      // Auto-attach to new session
      setTimeout(() => this.attachSession(session.id), 100);
    } catch (error) {
      console.error('Failed to attach to window:', error);
      alert('Failed to attach to window: ' + error.message);
    }
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  async pasteFromClipboard() {
    try {
      // Try modern clipboard API first
      if (navigator.clipboard && navigator.clipboard.readText) {
        const text = await navigator.clipboard.readText();
        if (text && this.currentSessionId && this.ws?.readyState === WebSocket.OPEN) {
          // Mark as paste so server can handle large pastes specially
          this.ws.send(JSON.stringify({ type: 'input', data: text, paste: true }));
        }
        return;
      }
    } catch (err) {
      console.log('Clipboard API paste failed, trying fallback:', err.message);
    }

    // Fallback: create a temporary textarea and use execCommand
    try {
      const textarea = document.createElement('textarea');
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      textarea.style.left = '-9999px';
      document.body.appendChild(textarea);
      textarea.focus();
      const ok = document.execCommand('paste');
      const text = textarea.value;
      document.body.removeChild(textarea);
      this.term?.focus();

      if (ok && text && this.currentSessionId && this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'input', data: text, paste: true }));
      }
    } catch (err) {
      console.error('Fallback paste failed:', err);
    }
  }

  copyToClipboard(text) {
    if (!text) {
      text = this.term?.getSelection();
    }
    if (!text) return;

    // Try modern clipboard API first
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => {
        console.log('Copied to clipboard');
      }).catch(err => {
        console.log('Clipboard API copy failed, trying fallback:', err.message);
        this.fallbackCopy(text);
      });
      return;
    }

    this.fallbackCopy(text);
  }

  copySelection(selection) {
    this.copyToClipboard(selection);
  }

  fallbackCopy(text) {
    try {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      textarea.style.left = '-9999px';
      textarea.style.pointerEvents = 'none';
      document.body.appendChild(textarea);
      textarea.select();
      textarea.setSelectionRange(0, textarea.value.length);
      const ok = document.execCommand('copy');
      document.body.removeChild(textarea);
      if (ok) {
        console.log('Fallback copy succeeded');
      } else {
        console.error('document.execCommand(copy) returned false');
      }
    } catch (err) {
      console.error('Fallback copy failed:', err);
    }
  }

  // Legacy line editor (server now handles non-PTY input)
  handleLineInput(data) {
    // Handle escape sequences (arrow keys, etc.)
    if (data === '\x1b[A') {
      // Up arrow - history previous
      this.historyUp();
    } else if (data === '\x1b[B') {
      // Down arrow - history next
      this.historyDown();
    } else if (data === '\x1b[C') {
      // Right arrow
      this.cursorRight();
    } else if (data === '\x1b[D') {
      // Left arrow
      this.cursorLeft();
    } else if (data === '\x1b[H' || data === '\x1b[1~') {
      // Home
      this.cursorHome();
    } else if (data === '\x1b[F' || data === '\x1b[4~') {
      // End
      this.cursorEnd();
    } else if (data === '\x7f' || data === '\b') {
      // Backspace
      this.handleBackspace();
    } else if (data === '\x1b[3~') {
      // Delete
      this.handleDelete();
    } else if (data === '\r') {
      // Enter - send the line
      this.submitLine();
    } else if (data === '\x03') {
      // Ctrl+C - cancel current line
      this.cancelLine();
    } else if (data === '\t') {
      // Tab - just insert spaces for now
      this.insertText('    ');
    } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
      // Printable character
      this.insertText(data);
    } else if (data.length > 1 && !data.startsWith('\x1b')) {
      // Pasted text
      this.insertText(data);
    }
  }

  insertText(text) {
    // Insert text at cursor position
    const before = this.lineBuffer.substring(0, this.cursorPos);
    const after = this.lineBuffer.substring(this.cursorPos);
    this.lineBuffer = before + text + after;
    this.cursorPos += text.length;

    // If cursor is at end, just append (no redraw needed)
    if (after.length === 0) {
      this.writeLocal(text);
    } else {
      // Inserting in middle - need to redraw rest of line
      // Write new char + rest of line, then move cursor back
      this.writeLocal(text + after + `\x1b[${after.length}D`);
    }
  }

  handleBackspace() {
    if (this.cursorPos > 0) {
      const before = this.lineBuffer.substring(0, this.cursorPos - 1);
      const after = this.lineBuffer.substring(this.cursorPos);
      this.lineBuffer = before + after;
      this.cursorPos--;

      if (after.length === 0) {
        // At end - just backspace
        this.writeLocal('\b \b');
      } else {
        // In middle - backspace, rewrite rest, clear extra, move back
        this.writeLocal('\b' + after + ' ' + `\x1b[${after.length + 1}D`);
      }
    }
  }

  handleDelete() {
    if (this.cursorPos < this.lineBuffer.length) {
      const before = this.lineBuffer.substring(0, this.cursorPos);
      const after = this.lineBuffer.substring(this.cursorPos + 1);
      this.lineBuffer = before + after;

      // Rewrite rest of line, clear extra char, move back
      this.writeLocal(after + ' ' + `\x1b[${after.length + 1}D`);
    }
  }

  cursorLeft() {
    if (this.cursorPos > 0) {
      this.cursorPos--;
      this.writeLocal('\x1b[D');
    }
  }

  cursorRight() {
    if (this.cursorPos < this.lineBuffer.length) {
      this.cursorPos++;
      this.writeLocal('\x1b[C');
    }
  }

  // Write to terminal locally (for line editor display)
  // Don't relay to P2P - phone has its own local echo
  writeLocal(data) {
    this.term.write(data);
    // Update terminal buffer for reconnecting peers
    this.terminalBuffer += data;
    if (this.terminalBuffer.length > 50000) {
      this.terminalBuffer = this.terminalBuffer.slice(-50000);
    }
    // Store in per-session buffer too
    if (this.currentSessionId) {
      this.sessionBuffers[this.currentSessionId] = (this.sessionBuffers[this.currentSessionId] || '') + data;
      if (this.sessionBuffers[this.currentSessionId].length > 50000) {
        this.sessionBuffers[this.currentSessionId] = this.sessionBuffers[this.currentSessionId].slice(-50000);
      }
    }
  }

  cursorHome() {
    if (this.cursorPos > 0) {
      this.writeLocal(`\x1b[${this.cursorPos}D`);
      this.cursorPos = 0;
    }
  }

  cursorEnd() {
    const move = this.lineBuffer.length - this.cursorPos;
    if (move > 0) {
      this.writeLocal(`\x1b[${move}C`);
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
    // Move to start of current input, clear, write new text
    let output = '';
    if (this.cursorPos > 0) {
      output += `\x1b[${this.cursorPos}D`; // Move to start
    }
    // Clear the old text
    if (this.lineBuffer.length > 0) {
      output += ' '.repeat(this.lineBuffer.length) + `\x1b[${this.lineBuffer.length}D`;
    }
    // Write new text
    output += newText;

    this.lineBuffer = newText;
    this.cursorPos = newText.length;
    this.writeLocal(output);
  }

  clearCurrentLine() {
    this.clearAndReplace('');
  }

  submitLine() {
    // Add to history if non-empty
    if (this.lineBuffer.trim()) {
      this.commandHistory.push(this.lineBuffer);
      if (this.commandHistory.length > 100) {
        this.commandHistory.shift();
      }
    }
    this.historyIndex = -1;

    // Move cursor to end and newline
    this.writeLocal('\r\n');

    // Send the complete line to server
    this.ws.send(JSON.stringify({ type: 'input', data: this.lineBuffer + '\r' }));

    // Reset line buffer
    this.lineBuffer = '';
    this.cursorPos = 0;
  }

  cancelLine() {
    this.writeLocal('^C\r\n');
    this.lineBuffer = '';
    this.cursorPos = 0;
    this.historyIndex = -1;
    // Send Ctrl+C to server
    this.ws.send(JSON.stringify({ type: 'input', data: '\x03' }));
  }

  resetLineEditor() {
    this.lineBuffer = '';
    this.cursorPos = 0;
    this.historyIndex = -1;
    this.currentPrompt = '';
  }

  // File upload method
  async uploadFile(file) {
    if (!this.currentSessionId || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.log('Cannot upload - no session or WS not connected');
      return;
    }

    // Show upload indicator in terminal
    this.term?.write(`\r\n\x1b[90m[Uploading ${file.name}...]\x1b[0m`);

    try {
      // Read file as base64
      const base64 = await this.fileToBase64(file);

      // Generate filename if not available (for pasted images)
      const filename = file.name || `pasted_image_${Date.now()}.${file.type.split('/')[1] || 'png'}`;

      // Send via WebSocket
      this.ws.send(JSON.stringify({
        type: 'upload',
        filename: filename,
        mimeType: file.type,
        data: base64,
        sessionId: this.currentSessionId
      }));

      console.log(`Uploading ${filename} (${base64.length} bytes base64)`);
    } catch (err) {
      console.error('Upload failed:', err);
      this.term?.write(`\r\n\x1b[31m[Upload failed: ${err.message}]\x1b[0m\r\n`);
    }
  }

  fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        // Remove data URL prefix to get just base64
        const base64 = reader.result.split(',')[1];
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  // P2P relay methods
  async toggleP2P() {
    if (this.p2pActive) {
      this.stopP2P();
    } else {
      await this.startP2P();
    }
  }

  async startP2P() {
    try {
      // Fixed room name - password differentiates users
      const roomId = 'terminal-hub';

      this.vdo = new VDONinjaSDK();

      // Listen for data from remote peers
      this.vdo.addEventListener('dataReceived', (e) => {
        const { data, uuid } = e.detail;
        console.log('P2P data received:', data);

        // Handle incoming data from phone
        if (data.type === 'input') {
          // Always forward phone input directly to the server with sessionId
          // Server-side echo keeps all clients in sync
          const targetSession = data.sessionId || this.currentSessionId;
          if (targetSession) {
            this.ws.send(JSON.stringify({ type: 'input', data: data.data, sessionId: targetSession }));
          }
        } else if (data.type === 'attach') {
          // Remote wants buffer for a specific session (don't switch host's view)
          const sessionId = data.sessionId;
          const session = this.sessions.find(s => s.id === sessionId);
          if (session) {
            this.sendP2P({
              type: 'info',
              sessionId,
              sessionType: session.type,
              hasPty: session.hasPty || false
            });
          }
          if (Object.prototype.hasOwnProperty.call(this.sessionBuffers, sessionId)) {
            console.log('Sending buffer for session:', sessionId);
            this.sendP2P({ type: 'buffer', data: this.sessionBuffers[sessionId], sessionId });
          }
        } else if (data.type === 'getSessions') {
          // Remote wants session list (fallback - normally sent on dataChannelOpen)
          this.sendP2P({ type: 'sessions', sessions: this.sessions });
        } else if (data.type === 'upload') {
          // Forward small upload to server via WebSocket
          console.log('P2P upload received:', data.filename, 'size:', data.data?.length, 'session:', data.sessionId);
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            console.log('Forwarding upload to server via WebSocket');
            this.ws.send(JSON.stringify({
              type: 'upload',
              filename: data.filename,
              mimeType: data.mimeType,
              data: data.data,
              sessionId: data.sessionId || this.currentSessionId
            }));
          } else {
            console.error('Cannot forward upload - WebSocket not connected');
          }
        } else if (data.type === 'uploadChunk') {
          // Handle chunked upload - reassemble then forward
          const { uploadId, filename, mimeType, chunk, chunkIndex, totalChunks, sessionId } = data;
          console.log(`P2P upload chunk ${chunkIndex + 1}/${totalChunks} for ${uploadId}`);

          if (!this.pendingUploads[uploadId]) {
            this.pendingUploads[uploadId] = {
              filename,
              mimeType,
              sessionId: sessionId || this.currentSessionId,
              chunks: new Array(totalChunks),
              received: 0
            };
          }

          const pending = this.pendingUploads[uploadId];
          pending.chunks[chunkIndex] = chunk;
          pending.received++;

          if (pending.received === totalChunks) {
            // All chunks received, reassemble and forward
            const fullData = pending.chunks.join('');
            console.log('All chunks received, forwarding complete upload:', filename, 'size:', fullData.length);

            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
              this.ws.send(JSON.stringify({
                type: 'upload',
                filename: pending.filename,
                mimeType: pending.mimeType,
                data: fullData,
                sessionId: pending.sessionId
              }));
            }

            delete this.pendingUploads[uploadId];
          }
        }
      });

      // Track peer connections
      this.vdo.addEventListener('peerConnected', (e) => {
        console.log('P2P peer connected:', e.detail.uuid);
        this.p2pPeers.add(e.detail.uuid);
      });

      this.vdo.addEventListener('peerDisconnected', (e) => {
        console.log('P2P peer disconnected:', e.detail.uuid);
        this.p2pPeers.delete(e.detail.uuid);
      });

      // Data channel ready - now safe to send
      this.p2pDataChannelReady = false;
      this.vdo.addEventListener('dataChannelOpen', (e) => {
        console.log('P2P data channel open:', e.detail);
        this.p2pDataChannelReady = true;
        // Send initial state to the peer
        this.sendP2P({ type: 'sessions', sessions: this.sessions });
        if (this.currentSessionId) {
          const currentSession = this.sessions.find(session => session.id === this.currentSessionId);
          this.sendP2P({
            type: 'info',
            sessionId: this.currentSessionId,
            sessionType: currentSession?.type || 'native',
            hasPty: currentSession?.hasPty || this.hasPty
          });
        }
      });

      // Connect to VDO.Ninja
      await this.vdo.connect();
      await this.vdo.joinRoom({ room: roomId, password: this.token });
      await this.vdo.announce({ streamID: 'host' });

      this.p2pActive = true;
      this.p2pToggle.textContent = 'Stop P2P';
      this.p2pToggle.classList.add('active');

      // Subscribe to all sessions for independent viewing
      this.ws.send(JSON.stringify({ type: 'subscribeAll' }));

      // Show connection info
      this.p2pStatus.textContent = 'P2P Active';
      this.p2pStatus.classList.remove('hidden');

      console.log('P2P relay started');

    } catch (err) {
      console.error('Failed to start P2P:', err);
      alert('Failed to start P2P: ' + err.message);
    }
  }

  stopP2P() {
    if (this.vdo) {
      this.vdo.disconnect();
      this.vdo = null;
    }
    // Unsubscribe from all sessions
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'unsubscribeAll' }));
    }
    this.p2pActive = false;
    this.p2pDataChannelReady = false;
    this.p2pPeers.clear();
    this.p2pToggle.textContent = 'Share P2P';
    this.p2pToggle.classList.remove('active');
    this.p2pStatus.classList.add('hidden');
    console.log('P2P relay stopped');
  }

  sendP2P(data) {
    if (this.vdo && this.p2pActive && this.p2pDataChannelReady) {
      console.log('Sending P2P:', data.type);
      this.vdo.sendData(data);
    }
  }
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  window.terminalHub = new TerminalHub();
});
