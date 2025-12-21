const path = require('path');
const fs = require('fs');
const os = require('os');

function hasWebRtcDependency() {
  const candidates = ['@roamhq/wrtc', 'node-datachannel', 'wrtc'];
  return candidates.some((name) => {
    try {
      require.resolve(name);
      return true;
    } catch (err) {
      return false;
    }
  });
}

function resolveSdk() {
  if (!hasWebRtcDependency()) {
    return null;
  }

  return require(path.join(__dirname, 'vdo', 'vdoninja-sdk-node.js'));
}

class VdoBridge {
  constructor(sessionManager, options = {}) {
    this.sessionManager = sessionManager;
    const envRoom = process.env.VDO_ROOM || process.env.VDON_ROOM;
    const envPassword = process.env.VDO_PASSWORD ?? process.env.VDON_PASSWORD;
    const envStream = process.env.VDO_STREAM_ID || process.env.VDON_STREAM_ID;

    this.room = options.room || envRoom || 'steves-app';
    this.password = options.password ?? envPassword ?? process.env.API_TOKEN ?? false;
    this.streamId = options.streamId || envStream || 'server';
    this.debug = options.debug ?? process.env.VDO_DEBUG === 'true';
    this.sdk = null;
    this.peers = new Map();
    this.pendingUploads = {}; // For reassembling chunked uploads

    this.handleSessionChange = this.handleSessionChange.bind(this);
    this.handleDataReceived = this.handleDataReceived.bind(this);
    this.handleDataChannelOpen = this.handleDataChannelOpen.bind(this);
    this.handlePeerDisconnected = this.handlePeerDisconnected.bind(this);
  }

  async start() {
    const SDK = resolveSdk();
    if (!SDK) {
      console.warn('[VDO] No WebRTC implementation found. Install @roamhq/wrtc or node-datachannel to enable server relay.');
      return false;
    }

    this.sdk = new SDK({
      room: this.room,
      password: this.password,
      debug: this.debug
    });

    this.sdk.on('dataReceived', this.handleDataReceived);
    this.sdk.on('dataChannelOpen', this.handleDataChannelOpen);
    this.sdk.on('peerDisconnected', this.handlePeerDisconnected);
    this.sessionManager.on('change', this.handleSessionChange);

    await this.sdk.connect();
    await this.sdk.joinRoom({ room: this.room, password: this.password });
    await this.sdk.announce({ streamID: this.streamId });

    console.log(`[VDO] Server relay active in room "${this.room}" as stream "${this.streamId}"`);
    return true;
  }

  async stop() {
    if (!this.sdk) return;
    this.sessionManager.off('change', this.handleSessionChange);
    this.sdk.off('dataReceived', this.handleDataReceived);
    this.sdk.off('dataChannelOpen', this.handleDataChannelOpen);
    this.sdk.off('peerDisconnected', this.handlePeerDisconnected);
    await this.sdk.disconnect();
    this.sdk = null;
    this.peers.clear();
  }

  ensurePeer(uuid) {
    if (!this.peers.has(uuid)) {
      this.peers.set(uuid, {
        attachedSession: null,
        attachedClient: null,
        subscribedSessions: new Map(),
        subscribeAllActive: false
      });
    }
    return this.peers.get(uuid);
  }

  sendToPeer(uuid, message) {
    if (!this.sdk || !uuid) return;
    this.sdk.sendData(message, { uuid, preference: 'publisher' });
  }

  broadcast(message) {
    if (!this.sdk) return;
    this.sdk.sendData(message);
  }

  createWrapper(uuid, sessionId) {
    return {
      readyState: 1,
      send: (data) => {
        const parsed = JSON.parse(data);
        const payload = parsed.sessionId ? parsed : { ...parsed, sessionId };
        this.sendToPeer(uuid, payload);
      }
    };
  }

  removeAttached(peer) {
    if (peer.attachedSession && peer.attachedClient) {
      peer.attachedSession.removeClient(peer.attachedClient);
    }
    peer.attachedSession = null;
    peer.attachedClient = null;
  }

  addSubscription(uuid, session) {
    const peer = this.ensurePeer(uuid);
    if (peer.subscribedSessions.has(session.id)) return;
    const wrapper = this.createWrapper(uuid, session.id);
    peer.subscribedSessions.set(session.id, wrapper);
    session.addClient(wrapper);
  }

  removeSubscription(uuid, sessionId) {
    const peer = this.peers.get(uuid);
    if (!peer) return;
    const wrapper = peer.subscribedSessions.get(sessionId);
    if (!wrapper) return;
    const session = this.sessionManager.getSession(sessionId);
    if (session) {
      session.removeClient(wrapper);
    }
    peer.subscribedSessions.delete(sessionId);
  }

  clearSubscriptions(uuid) {
    const peer = this.peers.get(uuid);
    if (!peer) return;
    for (const sessionId of Array.from(peer.subscribedSessions.keys())) {
      this.removeSubscription(uuid, sessionId);
    }
  }

  resyncSubscriptions(uuid) {
    const peer = this.peers.get(uuid);
    if (!peer || !peer.subscribeAllActive) return;
    for (const [id, session] of this.sessionManager.sessions) {
      if (peer.attachedSession && peer.attachedSession.id === id) {
        this.removeSubscription(uuid, id);
        continue;
      }
      this.addSubscription(uuid, session);
    }
    for (const sessionId of Array.from(peer.subscribedSessions.keys())) {
      if (!this.sessionManager.sessions.has(sessionId)) {
        peer.subscribedSessions.delete(sessionId);
      }
    }
  }

  handleSessionChange() {
    const sessions = this.sessionManager.listSessions();
    this.broadcast({ type: 'sessions', sessions });

    for (const [uuid, peer] of this.peers) {
      if (peer.attachedSession && !this.sessionManager.sessions.has(peer.attachedSession.id)) {
        this.removeAttached(peer);
      }
      this.resyncSubscriptions(uuid);
    }
  }

  handleDataChannelOpen(event) {
    const uuid = event.detail?.uuid;
    if (!uuid) return;
    const sessions = this.sessionManager.listSessions();
    this.sendToPeer(uuid, { type: 'sessions', sessions });
  }

  processUpload(uuid, filename, mimeType, data, sessionId, peer) {
    const uploadSession = sessionId
      ? this.sessionManager.getSession(sessionId)
      : peer.attachedSession;

    if (!uploadSession) {
      this.sendToPeer(uuid, { type: 'error', message: 'No session for upload' });
      return;
    }

    try {
      // Decode base64 data
      const buffer = Buffer.from(data, 'base64');

      // Generate unique filename
      const ext = path.extname(filename) || '.bin';
      const baseName = path.basename(filename, ext).replace(/[^a-zA-Z0-9_-]/g, '_');
      const timestamp = Date.now();
      const savedFilename = `${baseName}_${timestamp}${ext}`;

      // Save to temp directory
      const tmpDir = os.tmpdir();
      const filePath = path.join(tmpDir, savedFilename);
      fs.writeFileSync(filePath, buffer);

      console.log(`[VDO] File uploaded: ${filePath} (${buffer.length} bytes)`);

      // Insert the file path as editable text (like user typed it)
      const fileRef = `[image: ${filePath}] `;
      if (uploadSession.insertText) {
        uploadSession.insertText(fileRef);
      } else {
        uploadSession.lineBuffer = (uploadSession.lineBuffer || '') + fileRef;
        uploadSession.cursorPos = uploadSession.lineBuffer.length;
        uploadSession.appendBuffer(fileRef);
        uploadSession.broadcast({ type: 'output', data: fileRef });
      }

      // Send confirmation back to uploader
      this.sendToPeer(uuid, { type: 'uploadComplete', filename: filePath });
    } catch (err) {
      console.error('[VDO] Upload failed:', err);
      this.sendToPeer(uuid, { type: 'error', message: 'Upload failed: ' + err.message });
    }
  }

  handlePeerDisconnected(event) {
    const uuid = event.detail?.uuid;
    if (!uuid) return;
    const peer = this.peers.get(uuid);
    if (peer) {
      this.removeAttached(peer);
      this.clearSubscriptions(uuid);
      this.peers.delete(uuid);
    }
  }

  handleDataReceived(event) {
    const uuid = event.detail?.uuid;
    if (!uuid) return;
    const raw = event.detail?.data;
    let msg = raw;
    if (typeof raw === 'string') {
      try {
        msg = JSON.parse(raw);
      } catch (err) {
        console.warn('[VDO] Ignoring non-JSON message:', raw);
        return;
      }
    }
    if (!msg || typeof msg !== 'object') return;

    const peer = this.ensurePeer(uuid);

    switch (msg.type) {
      case 'attach': {
        const session = this.sessionManager.getSession(msg.sessionId);
        if (session) {
          const previousSession = peer.attachedSession;
          if (previousSession && previousSession !== session) {
            this.removeAttached(peer);
            if (peer.subscribeAllActive) {
              const existing = this.sessionManager.getSession(previousSession.id);
              if (existing) {
                this.addSubscription(uuid, existing);
              }
            }
          }

          peer.attachedSession = session;
          if (peer.subscribeAllActive) {
            this.removeSubscription(uuid, session.id);
          }
          const wrapper = this.createWrapper(uuid, session.id);
          peer.attachedClient = wrapper;
          session.addClient(wrapper);

          this.sendToPeer(uuid, { type: 'buffer', sessionId: session.id, data: session.getBuffer() });
          this.sendToPeer(uuid, {
            type: 'info',
            sessionId: session.id,
            sessionType: session.type,
            hasPty: session.usePty || false
          });
        } else {
          this.sendToPeer(uuid, { type: 'error', message: 'Session not found' });
        }
        break;
      }

      case 'input': {
        // Detect paste: multi-char input or explicitly marked as paste
        const isPaste = msg.paste || (msg.data && msg.data.length > 1 && !msg.data.startsWith('\x1b'));
        const inputSession = msg.sessionId
          ? this.sessionManager.getSession(msg.sessionId)
          : peer.attachedSession;

        if (inputSession) {
          inputSession.write(msg.data, { paste: isPaste });
        }
        break;
      }

      case 'resize': {
        if (peer.attachedSession && peer.attachedSession.type === 'native') {
          peer.attachedSession.resize(msg.cols, msg.rows);
        }
        break;
      }

      case 'detach': {
        if (peer.attachedSession) {
          const previousSession = peer.attachedSession;
          this.removeAttached(peer);
          if (peer.subscribeAllActive) {
            const session = this.sessionManager.getSession(previousSession.id);
            if (session) {
              this.addSubscription(uuid, session);
            }
          }
        }
        break;
      }

      case 'subscribeAll': {
        peer.subscribeAllActive = true;
        this.resyncSubscriptions(uuid);
        for (const [id, session] of this.sessionManager.sessions) {
          if (peer.attachedSession && peer.attachedSession.id === id) continue;
          this.sendToPeer(uuid, {
            type: 'buffer',
            sessionId: id,
            data: session.getBuffer()
          });
        }
        break;
      }

      case 'unsubscribeAll': {
        peer.subscribeAllActive = false;
        this.clearSubscriptions(uuid);
        break;
      }

      case 'getSessions': {
        const sessions = this.sessionManager.listSessions();
        this.sendToPeer(uuid, { type: 'sessions', sessions });
        break;
      }

      case 'upload': {
        // Handle file upload from P2P client
        console.log('[VDO] Upload received:', msg.filename, 'size:', msg.data?.length, 'session:', msg.sessionId);
        this.processUpload(uuid, msg.filename, msg.mimeType, msg.data, msg.sessionId, peer);
        break;
      }

      case 'uploadChunk': {
        // Handle chunked upload
        const { uploadId, filename, mimeType, chunk, chunkIndex, totalChunks, sessionId } = msg;
        console.log(`[VDO] Upload chunk ${chunkIndex + 1}/${totalChunks} for ${uploadId}`);

        if (!this.pendingUploads[uploadId]) {
          this.pendingUploads[uploadId] = {
            filename,
            mimeType,
            sessionId,
            uuid,
            chunks: new Array(totalChunks),
            received: 0
          };
        }

        const pending = this.pendingUploads[uploadId];
        pending.chunks[chunkIndex] = chunk;
        pending.received++;

        if (pending.received === totalChunks) {
          // All chunks received, process the complete upload
          const fullData = pending.chunks.join('');
          console.log('[VDO] All chunks received, processing upload:', filename, 'size:', fullData.length);
          this.processUpload(pending.uuid, pending.filename, pending.mimeType, fullData, pending.sessionId, peer);
          delete this.pendingUploads[uploadId];
        }
        break;
      }

      default:
        break;
    }
  }
}

module.exports = { VdoBridge };
