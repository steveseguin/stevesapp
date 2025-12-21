require('dotenv').config();
const crypto = require('crypto');
const { createServer } = require('./server');
const { VdoBridge } = require('./vdo-bridge');

const PORT = process.env.PORT || 3000;

// Generate token if not set
if (!process.env.API_TOKEN) {
  process.env.API_TOKEN = crypto.randomBytes(16).toString('hex');
  console.log('No API_TOKEN set - generated random token for this session');
}

const { server, sessionManager } = createServer();
let vdoBridge = null;

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log(`Steve's App running on http://0.0.0.0:${PORT}`);
  console.log(`Local access: http://localhost:${PORT}`);
  console.log(`Remote access: http://localhost:${PORT}/remote.html`);
  console.log('');
  console.log(`API Token: ${process.env.API_TOKEN}`);
  console.log('');
});

if (process.env.VDO_SERVER !== 'false') {
  vdoBridge = new VdoBridge(sessionManager);
  vdoBridge.start().catch((err) => {
    console.error('[VDO] Failed to start server relay:', err.message);
  });
}
