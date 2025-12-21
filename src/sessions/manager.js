const EventEmitter = require('events');
const NativeSession = require('./native');
const CaptureSession = require('./capture');

class SessionManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.sessions = new Map();
    this.logger = options.logger || null;
  }

  createNativeSession(options) {
    const session = new NativeSession(options);
    console.log('Created native session:', session.id);
    if (this.logger) {
      this.logger.attach(session);
    }

    session.on('exit', (code) => {
      console.log('Native session exited:', session.id, 'code:', code);
      this.sessions.delete(session.id);
      this.emit('change');
    });

    this.sessions.set(session.id, session);
    this.emit('change');
    return session;
  }

  createCaptureSession(hwnd) {
    const session = new CaptureSession(hwnd);
    if (this.logger) {
      this.logger.attach(session);
    }

    session.on('exit', () => {
      this.sessions.delete(session.id);
      this.emit('change');
    });

    this.sessions.set(session.id, session);
    this.emit('change');
    return session;
  }

  getSession(id) {
    return this.sessions.get(id);
  }

  destroySession(id) {
    const session = this.sessions.get(id);
    if (session) {
      session.destroy();
      if (this.logger) {
        this.logger.log(session.id, { type: 'destroy' });
        this.logger.close(session.id);
      }
      this.sessions.delete(id);
      this.emit('change');
      return true;
    }
    return false;
  }

  listSessions() {
    const list = [];
    for (const [id, session] of this.sessions) {
      list.push({
        id,
        type: session.type,
        shell: session.shell || null,
        hwnd: session.hwnd || null,
        title: session.title || null,
        hasPty: session.usePty || false,
        cols: session.cols,
        rows: session.rows
      });
    }
    return list;
  }

  listWindows() {
    // Use the Windows API to enumerate windows
    const windowApi = require('../native');
    return windowApi.listTerminalWindows();
  }
}

module.exports = SessionManager;
