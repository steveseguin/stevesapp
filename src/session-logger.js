const fs = require('fs');
const path = require('path');

class SessionLogger {
  constructor(options = {}) {
    this.enabled = Boolean(options.enabled);
    const dir = options.dir || 'session-logs';
    this.dir = path.isAbsolute(dir) ? dir : path.join(process.cwd(), dir);
    const keep = Number.parseInt(options.keep, 10);
    this.keep = Number.isFinite(keep) ? Math.max(1, keep) : 10;
    this.streams = new Map();
    this.wrapped = new WeakSet();
  }

  getStatus() {
    return {
      enabled: this.enabled,
      dir: this.dir,
      keep: this.keep
    };
  }

  ensureDir() {
    if (!this.enabled) return;
    fs.mkdirSync(this.dir, { recursive: true });
  }

  attach(session) {
    if (!this.enabled || !session || this.wrapped.has(session)) return;

    this.ensureDir();
    this.pruneOldLogs();

    const filename = this.buildFilename(session);
    const filePath = path.join(this.dir, filename);
    const stream = fs.createWriteStream(filePath, { flags: 'a' });
    this.streams.set(session.id, { stream, filePath });

    this.log(session.id, {
      type: 'start',
      sessionId: session.id,
      sessionType: session.type,
      shell: session.shell || null,
      cwd: session.cwd || null,
      cols: session.cols || null,
      rows: session.rows || null
    });

    const originalWrite = session.write.bind(session);
    session.write = (data, options = {}) => {
      this.log(session.id, {
        type: 'input',
        data: String(data),
        paste: Boolean(options.paste)
      });
      return originalWrite(data, options);
    };

    const originalBroadcast = session.broadcast.bind(session);
    session.broadcast = (msg) => {
      if (msg && msg.type === 'output' && msg.data !== undefined) {
        this.log(session.id, {
          type: 'output',
          data: String(msg.data)
        });
      }
      return originalBroadcast(msg);
    };

    if (typeof session.on === 'function') {
      session.on('exit', (code) => {
        this.log(session.id, { type: 'exit', code: code ?? null });
        this.close(session.id);
      });
    }

    this.wrapped.add(session);
  }

  close(sessionId) {
    const entry = this.streams.get(sessionId);
    if (!entry) return;
    entry.stream.end();
    this.streams.delete(sessionId);
  }

  log(sessionId, entry) {
    const entryInfo = this.streams.get(sessionId);
    if (!entryInfo) return;
    const record = { ts: new Date().toISOString(), ...entry };
    try {
      entryInfo.stream.write(JSON.stringify(record) + '\n');
    } catch (err) {
      console.warn('[SessionLog] Failed to write log entry:', err.message);
    }
  }

  buildFilename(session) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return `session-${stamp}-${session.id}.jsonl`;
  }

  pruneOldLogs() {
    if (!this.enabled) return;
    let entries = [];
    try {
      const files = fs.readdirSync(this.dir);
      entries = files
        .filter((file) => file.startsWith('session-') && file.endsWith('.jsonl'))
        .map((file) => {
          const filePath = path.join(this.dir, file);
          const stat = fs.statSync(filePath);
          return { file, filePath, mtime: stat.mtimeMs };
        });
    } catch (err) {
      return;
    }

    entries.sort((a, b) => b.mtime - a.mtime);
    const stale = entries.slice(this.keep);
    for (const entry of stale) {
      try {
        fs.unlinkSync(entry.filePath);
      } catch (err) {
        console.warn('[SessionLog] Failed to remove old log:', entry.filePath);
      }
    }
  }
}

module.exports = { SessionLogger };
