require('dotenv').config();
const { createServer } = require('./server');
const { VdoBridge } = require('./vdo-bridge');

const PORT = process.env.PORT || 3000;

const { server, sessionManager } = createServer();
let vdoBridge = null;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Terminal Hub running on http://0.0.0.0:${PORT}`);
  console.log(`Local access: http://localhost:${PORT}`);
  console.log(`Phone access: Open phone.html on mobile`);
});

if (process.env.VDO_SERVER !== 'false') {
  vdoBridge = new VdoBridge(sessionManager);
  vdoBridge.start().catch((err) => {
    console.error('[VDO] Failed to start server relay:', err.message);
  });
}
