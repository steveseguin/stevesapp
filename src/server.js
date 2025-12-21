const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { authenticate, authenticateWs } = require('./auth');
const SessionManager = require('./sessions/manager');

function createServer(options = {}) {
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocket.Server({ server });
  const sessionManager = options.sessionManager || new SessionManager();

  // Middleware
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '../public')));

  // REST API Routes

  // List all sessions
  app.get('/api/sessions', authenticate, (req, res) => {
    const sessions = sessionManager.listSessions();
    res.json(sessions);
  });

  // Create a new native session
  app.post('/api/sessions', authenticate, (req, res) => {
    const { shell, cols, rows } = req.body;
    try {
      const session = sessionManager.createNativeSession({
        shell: shell || 'cmd.exe',
        cols: cols || parseInt(process.env.DEFAULT_COLS) || 120,
        rows: rows || parseInt(process.env.DEFAULT_ROWS) || 30
      });
      res.json({ id: session.id, type: session.type, shell: session.shell });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Destroy a session
  app.delete('/api/sessions/:id', authenticate, (req, res) => {
    const success = sessionManager.destroySession(req.params.id);
    if (success) {
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'Session not found' });
    }
  });

  // List capturable windows
  app.get('/api/windows', authenticate, (req, res) => {
    try {
      const windows = sessionManager.listWindows();
      res.json(windows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Attach to an existing window
  app.post('/api/windows/:hwnd/attach', authenticate, (req, res) => {
    try {
      const hwnd = parseInt(req.params.hwnd);
      const session = sessionManager.createCaptureSession(hwnd);
      res.json({ id: session.id, type: session.type, hwnd: session.hwnd, title: session.title });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // WebSocket handling
  wss.on('connection', (ws, req) => {
    // Authenticate WebSocket connection
    const token = new URL(req.url, 'http://localhost').searchParams.get('token');
    if (!authenticateWs(token)) {
      ws.close(4001, 'Unauthorized');
      return;
    }

    let attachedSession = null;
    const subscribedSessions = new Map(); // sessionId -> wrapper client
    let subscribeAllActive = false;

    const addSubscription = (id, session) => {
      if (subscribedSessions.has(id)) return;
      const wrapper = {
        readyState: 1,
        send: (data) => {
          const parsed = JSON.parse(data);
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ ...parsed, sessionId: id }));
          }
        }
      };
      subscribedSessions.set(id, wrapper);
      session.addClient(wrapper);
    };

    const removeSubscription = (id) => {
      const wrapper = subscribedSessions.get(id);
      if (!wrapper) return;
      const session = sessionManager.getSession(id);
      if (session) {
        session.removeClient(wrapper);
      }
      subscribedSessions.delete(id);
    };

    const clearSubscriptions = () => {
      for (const id of Array.from(subscribedSessions.keys())) {
        removeSubscription(id);
      }
    };

    const resyncSubscriptions = () => {
      if (!subscribeAllActive) return;
      for (const [id, session] of sessionManager.sessions) {
        if (attachedSession && attachedSession.id === id) {
          removeSubscription(id);
          continue;
        }
        addSubscription(id, session);
      }
      for (const id of Array.from(subscribedSessions.keys())) {
        if (!sessionManager.sessions.has(id)) {
          subscribedSessions.delete(id);
        }
      }
    };

    const handleSessionChange = () => {
      if (attachedSession && !sessionManager.sessions.has(attachedSession.id)) {
        attachedSession = null;
      }
      resyncSubscriptions();
    };

    sessionManager.on('change', handleSessionChange);

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);

        switch (msg.type) {
          case 'attach':
            // Attach to a session
            console.log('Client attaching to session:', msg.sessionId);
            const session = sessionManager.getSession(msg.sessionId);
            if (session) {
              const previousSession = attachedSession;
              if (previousSession && previousSession !== session) {
                previousSession.removeClient(ws);
                if (subscribeAllActive) {
                  const existing = sessionManager.getSession(previousSession.id);
                  if (existing) {
                    addSubscription(previousSession.id, existing);
                  }
                }
              }
              attachedSession = session;
              if (subscribeAllActive) {
                removeSubscription(session.id);
              }
              session.addClient(ws);
              const bufferContent = session.getBuffer();
              console.log('Client attached, total clients:', session.clients.size);
              console.log('Sending buffer, length:', bufferContent.length, 'chars');

              // Send current buffer
              ws.send(JSON.stringify({
                type: 'buffer',
                data: bufferContent
              }));

              // Send session info
              ws.send(JSON.stringify({
                type: 'info',
                sessionId: session.id,
                sessionType: session.type,
                hasPty: session.usePty || false
              }));
            } else {
              ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }));
            }
            break;

          case 'input':
            // Send input to session
            // Support targeting a specific session (for P2P independent viewing)
            const inputSession = msg.sessionId
              ? sessionManager.getSession(msg.sessionId)
              : attachedSession;

            if (inputSession) {
              // Detect paste: multi-char input or explicitly marked as paste
              const isPaste = msg.paste || (msg.data && msg.data.length > 1 && !msg.data.startsWith('\x1b'));
              inputSession.write(msg.data, { paste: isPaste });
            }
            break;

          case 'resize':
            // Resize terminal (only for native sessions)
            if (attachedSession && attachedSession.type === 'native') {
              attachedSession.resize(msg.cols, msg.rows);
            }
            break;

          case 'detach':
            if (attachedSession) {
              const previousSession = attachedSession;
              previousSession.removeClient(ws);
              attachedSession = null;
              if (subscribeAllActive) {
                const session = sessionManager.getSession(previousSession.id);
                if (session) {
                  addSubscription(previousSession.id, session);
                }
              }
            }
            break;

          case 'subscribeAll':
            // Subscribe to output from ALL sessions (for P2P relay)
            // Skip the already-attached session to avoid duplicates
            console.log('Client subscribing to all sessions, attached:', attachedSession?.id);
            subscribeAllActive = true;
            resyncSubscriptions();
            // Send buffers for all sessions EXCEPT the attached one (it already has its buffer)
            for (const [id, session] of sessionManager.sessions) {
              if (attachedSession && attachedSession.id === id) continue;
              ws.send(JSON.stringify({
                type: 'buffer',
                sessionId: id,
                data: session.getBuffer()
              }));
            }
            break;

          case 'unsubscribeAll':
            // Unsubscribe from all sessions
            console.log('Client unsubscribing from all sessions');
            subscribeAllActive = false;
            clearSubscriptions();
            break;

          case 'upload': {
            // Handle file upload from WebSocket client
            console.log('[WS] Upload message received:', msg.filename, 'size:', msg.data?.length);
            const uploadSession = msg.sessionId
              ? sessionManager.getSession(msg.sessionId)
              : attachedSession;

            if (!uploadSession) {
              ws.send(JSON.stringify({ type: 'error', message: 'No session for upload' }));
              break;
            }

            try {
              // Decode base64 data
              const buffer = Buffer.from(msg.data, 'base64');

              // Generate unique filename
              const ext = path.extname(msg.filename) || '.bin';
              const baseName = path.basename(msg.filename, ext).replace(/[^a-zA-Z0-9_-]/g, '_');
              const timestamp = Date.now();
              const filename = `${baseName}_${timestamp}${ext}`;

              // Save to temp directory
              const tmpDir = os.tmpdir();
              const filePath = path.join(tmpDir, filename);
              fs.writeFileSync(filePath, buffer);

              console.log(`[WS] File uploaded: ${filePath} (${buffer.length} bytes)`);

              // Insert the file path as editable text (like user typed it)
              const fileRef = `[image: ${filePath}] `;
              if (uploadSession.insertText) {
                // Use the session's insertText method so it's editable
                uploadSession.insertText(fileRef);
              } else {
                // Fallback: just append to line buffer and echo
                uploadSession.lineBuffer = (uploadSession.lineBuffer || '') + fileRef;
                uploadSession.cursorPos = uploadSession.lineBuffer.length;
                uploadSession.appendBuffer(fileRef);
                uploadSession.broadcast({ type: 'output', data: fileRef });
              }

              // Send confirmation back to uploader
              ws.send(JSON.stringify({ type: 'uploadComplete', filename: filePath }));
            } catch (err) {
              console.error('[WS] Upload failed:', err);
              ws.send(JSON.stringify({ type: 'error', message: 'Upload failed: ' + err.message }));
            }
            break;
          }
        }
      } catch (err) {
        console.error('WebSocket message error:', err);
      }
    });

    ws.on('close', () => {
      if (attachedSession) {
        attachedSession.removeClient(ws);
      }
      clearSubscriptions();
      sessionManager.off('change', handleSessionChange);
    });

    // Send initial session list
    ws.send(JSON.stringify({
      type: 'sessions',
      sessions: sessionManager.listSessions()
    }));
  });

  // Broadcast session list updates
  sessionManager.on('change', () => {
    const sessions = sessionManager.listSessions();
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: 'sessions', sessions }));
      }
    });
  });

  return { server, sessionManager };
}

module.exports = { createServer };
