require('dotenv').config();
const crypto = require('crypto');
const readline = require('readline');
const EventEmitter = require('events');
const SessionManager = require('./sessions/manager');
const { createServer } = require('./server');
const { VdoBridge } = require('./vdo-bridge');

const PORT = process.env.PORT || 3000;

const parseBool = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
};

class P2PManager extends EventEmitter {
  constructor(sessionManager, config) {
    super();
    this.sessionManager = sessionManager;
    this.room = config.room;
    this.password = config.password;
    this.streamId = config.streamId;
    this.debug = config.debug;
    this.enabled = false;
    this.active = false;
    this.available = true;
    this.lastError = null;
    this.bridge = null;
    this.transitioning = false;
  }

  getStatus() {
    return {
      enabled: this.enabled,
      active: this.active,
      available: this.available,
      room: this.room,
      streamId: this.streamId,
      error: this.lastError
    };
  }

  async start() {
    if (this.active) return true;
    this.bridge = new VdoBridge(this.sessionManager, {
      room: this.room,
      password: this.password,
      streamId: this.streamId,
      debug: this.debug
    });
    const started = await this.bridge.start();
    if (!started) {
      this.bridge = null;
      this.active = false;
      this.available = false;
      this.lastError = 'WebRTC dependencies not available';
      return false;
    }
    this.active = true;
    this.available = true;
    this.lastError = null;
    return true;
  }

  async stop() {
    if (this.bridge) {
      await this.bridge.stop();
      this.bridge = null;
    }
    this.active = false;
  }

  async setEnabled(enabled) {
    if (this.transitioning) return this.getStatus();
    if (enabled === this.enabled && (!enabled || this.active)) {
      this.emit('change', this.getStatus());
      return this.getStatus();
    }

    this.transitioning = true;
    try {
      if (enabled) {
        const started = await this.start();
        this.enabled = started;
        this.active = started;
      } else {
        await this.stop();
        this.enabled = false;
        this.active = false;
      }
    } catch (err) {
      this.lastError = err.message;
      this.enabled = false;
      this.active = false;
    } finally {
      this.transitioning = false;
      this.emit('change', this.getStatus());
    }
    return this.getStatus();
  }

  toggle() {
    return this.setEnabled(!this.enabled);
  }
}

const formatP2PStatus = (status) => {
  const state = status.active ? 'active' : (status.enabled ? 'starting' : 'disabled');
  const availability = status.available ? '' : ' (unavailable)';
  return `[P2P] ${state}${availability} - room "${status.room}", stream "${status.streamId}"`;
};

const logP2PStatus = (status, showHint = false) => {
  console.log(formatP2PStatus(status));
  if (status.error) {
    console.log(`[P2P] Error: ${status.error}`);
  }
  if (showHint && process.stdin.isTTY) {
    console.log('[P2P] Press "p" to toggle, "s" for status, "h" for help.');
  }
};

const setupCliMenu = (p2pManager) => {
  if (!process.stdin.isTTY) return;

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);

  const showHelp = () => {
    console.log('');
    console.log('CLI menu:');
    console.log('  p - toggle P2P relay');
    console.log('  s - show P2P status');
    console.log('  h - show this help');
    console.log('  q - quit');
    console.log('');
  };

  process.stdin.on('keypress', (str, key) => {
    if (key && key.ctrl && key.name === 'c') {
      process.exit(0);
    }
    if (!key) return;

    if (key.name === 'p') {
      void p2pManager.toggle();
    } else if (key.name === 's') {
      logP2PStatus(p2pManager.getStatus());
    } else if (key.name === 'h') {
      showHelp();
    } else if (key.name === 'q') {
      process.exit(0);
    }
  });

  showHelp();
};

// Generate token if not set
if (!process.env.API_TOKEN) {
  process.env.API_TOKEN = crypto.randomBytes(16).toString('hex');
  console.log('No API_TOKEN set - generated random token for this session');
}

const p2pConfig = {
  enabled: parseBool(process.env.P2P_ENABLED ?? process.env.VDO_SERVER, true),
  room: process.env.VDO_ROOM || 'steves-app',
  password: process.env.VDO_PASSWORD || process.env.API_TOKEN,
  streamId: process.env.VDO_STREAM_ID || 'server',
  debug: parseBool(process.env.VDO_DEBUG, false)
};

const sessionManager = new SessionManager();
const p2pManager = new P2PManager(sessionManager, p2pConfig);
const { server } = createServer({ sessionManager, p2pManager });

p2pManager.on('change', (status) => {
  logP2PStatus(status);
});

void p2pManager.setEnabled(p2pConfig.enabled);

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log(`Steve's App running on http://0.0.0.0:${PORT}`);
  console.log(`Local access: http://localhost:${PORT}`);
  console.log(`Remote access: http://localhost:${PORT}/remote.html`);
  console.log('');
  console.log(`API Token: ${process.env.API_TOKEN}`);
  console.log('');
  logP2PStatus(p2pManager.getStatus(), true);
  setupCliMenu(p2pManager);
});
