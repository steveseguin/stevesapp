# Terminal Hub

Remote terminal multiplexer for Windows. Access your terminal sessions from your phone via Tailscale.

## Features

- **Native Sessions**: Spawn cmd, PowerShell, WSL, or SSH sessions through the hub
- **Window Capture**: Attach to existing PuTTY/cmd/Windows Terminal windows
- **Multiplexing**: Multiple clients can view and interact with the same session
- **Mobile-friendly**: Responsive web UI works on phones and tablets
- **Secure**: Bearer token authentication + Tailscale for encrypted access

## Quick Start

### 1. Install Dependencies

```bash
cd terminal-hub
npm install
```

> **Note**: On Windows, `node-pty` requires build tools. Install them with:
> ```bash
> npm install -g windows-build-tools
> ```
> Or install Visual Studio Build Tools manually.

### 2. Configure

```bash
cp .env.example .env
```

Edit `.env` and set a secure API token:

```
API_TOKEN=your-secure-random-token-here
PORT=3000
```

### 3. Run

```bash
npm start
```

Or for development with auto-reload:

```bash
npm run dev
```

### 4. Access

- **Local**: Open `http://localhost:3000` in your browser
- **Remote**: Use your Tailscale IP (see below)
- **VDO relay (no local browser required)**: Open `phone.html?token=YOUR_TOKEN&room=terminal-hub&stream=host` on mobile

## Remote Access via Tailscale

1. Install [Tailscale](https://tailscale.com/download) on your Windows PC
2. Sign in and note your Tailscale IP (e.g., `100.x.x.x`)
3. Install Tailscale on your phone
4. Access Terminal Hub at `http://100.x.x.x:3000` from your phone

## Usage

### Creating Native Sessions

1. Select a shell (cmd, PowerShell, WSL, or custom)
2. Click "+ New" to create a session
3. The terminal attaches automatically

For SSH, select "Custom..." and enter: `ssh user@hostname`

### Capturing Existing Windows

1. Open PuTTY or cmd.exe on your PC
2. Click "Scan Windows" in Terminal Hub
3. Click on the window you want to capture
4. Now you can view and control it from your phone

### Multiplexing

- Multiple browser tabs/phones can attach to the same session
- All clients see the same output
- Any client can type commands
- Great for pair programming or monitoring

## API Reference

All endpoints require `Authorization: Bearer <token>` header.

### Sessions

```
GET  /api/sessions           - List all sessions
POST /api/sessions           - Create native session
     Body: { shell: "cmd.exe", cols: 120, rows: 30 }
DELETE /api/sessions/:id     - Destroy session
```

### Windows

```
GET  /api/windows            - List capturable windows
POST /api/windows/:hwnd/attach - Attach to window
```

### WebSocket

Connect to `ws://host:port?token=<token>`

Messages:
- `{ type: "attach", sessionId: "..." }` - Attach to session
- `{ type: "input", data: "..." }` - Send input
- `{ type: "resize", cols: N, rows: N }` - Resize terminal
- `{ type: "detach" }` - Detach from session

## Troubleshooting

### node-pty build errors

Install Windows build tools:
```bash
npm install -g windows-build-tools
```

Or install Visual Studio with "Desktop development with C++" workload.

### ffi-napi errors

Ensure you have:
- Node.js 18+ (LTS recommended)
- Python 3.x (for node-gyp)
- Windows Build Tools

### Window capture not working

- Make sure PuTTY or cmd is running before scanning
- Try running Terminal Hub as administrator
- Check that PowerShell is available (for UI Automation)

### Can't connect from phone

- Ensure both devices are on Tailscale
- Check Windows Firewall allows port 3000
- Verify Tailscale IP with `tailscale ip -4`

## Server-side VDO Relay (no local browser required)

The server can host the VDO.Ninja data channel directly, so remote clients connect
without keeping a local browser open.

### Requirements

- Node.js 18.20+ for `node-datachannel`
- Node.js 20+ recommended for `@roamhq/wrtc`

### Install a WebRTC implementation (data channels)

Pick one:

```bash
npm install @roamhq/wrtc
```

or

```bash
npm install node-datachannel
```

### Configuration

Environment variables:

```
VDO_SERVER=true
VDO_ROOM=terminal-hub
VDO_PASSWORD=your-secure-random-token-here
VDO_STREAM_ID=host
VDO_DEBUG=false
```

Notes:
- `VDO_PASSWORD` defaults to `API_TOKEN` when not set.
- `VDO_STREAM_ID` should match `phone.html?stream=host` (default is `host`).
- Set `VDO_SERVER=false` to disable the relay.
- Avoid enabling the browser P2P relay when the server relay is active to prevent stream ID conflicts.
- `VDON_ROOM`, `VDON_PASSWORD`, and `VDON_STREAM_ID` are also accepted.

## Security Notes

- Use a strong, random API token (32+ characters)
- Tailscale provides encrypted, authenticated connections
- Sessions are ephemeral (cleared on server restart)
- Don't expose port 3000 directly to the internet

## License

MIT
