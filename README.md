# Terminal Hub

**Monitor your AI coding sessions from your phone. No VPN. No accounts. Just open a browser.**

## The Problem

You're running Claude Code, GPT Codex, or OpenCode on a VPS (or your home PC). You want to check on it from your phone while you're away. The current solution?

1. Install Tailscale on your VPS
2. Install Tailscale on your phone
3. Set up a VPN connection
4. Install a mobile SSH/terminal app
5. Configure SSH keys or passwords
6. Manage multiple tabbed connections

It works, but it's a lot of setup for "I just want to see what Claude is doing."

## The Solution

Terminal Hub gives you browser-based terminal access with **zero configuration**:

```bash
npx terminal-hub
# or: git clone ... && npm install && npm start
```

That's it. Open the URL on your phone, enter the token shown in the console, and you're connected.

### Why Terminal Hub?

| Feature | Tailscale + SSH App | Terminal Hub |
|---------|-------------------|--------------|
| VPN required | Yes | No |
| Account required | Yes (Tailscale) | No |
| Mobile app install | Yes | No (just browser) |
| Works behind NAT/firewall | With Tailscale | Yes (P2P) |
| Setup time | 15-30 min | 60 seconds |
| Cost | Free tier limits | Free forever |
| Open source | Partially | Fully (MIT) |
| Customizable | Limited | Yes |

### Perfect For

- **Claude Code users** watching agentic coding in real-time
- **Codex/OpenCode users** monitoring long-running tasks
- **VPS users** who want quick mobile access without VPN overhead
- **Anyone** who wants to check on builds, logs, or processes from their phone

## Features

- **P2P Connection**: Direct encrypted WebRTC, no relay servers storing your data
- **Mobile-Optimized UI**: Touch-friendly keyboard with Ctrl+C, arrows, Tab, etc.
- **Image Upload**: Send screenshots from phone to terminal (for AI context)
- **QR Code Login**: Scan from desktop to instantly connect your phone
- **Multiple Sessions**: CMD, PowerShell, WSL, SSH - switch between them
- **Multiplexing**: Multiple devices can view/control the same session
- **Works on Windows**: Native support, no WSL required

## Quick Start

### Option 1: npx (Easiest)

```bash
npx terminal-hub
```

### Option 2: Clone and Run

```bash
git clone https://github.com/steveseguin/stevesapp
cd terminal-hub
npm install
npm start
```

### Connect from Phone

1. Note the token displayed in the console
2. Open `http://YOUR_IP:3000/phone.html` on your phone
3. Enter the token and tap Connect

Or use the QR code: Open `http://localhost:3000` on your PC, enter the token, click the QR button, and scan with your phone.

## Configuration

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Available options:

```
API_TOKEN=your-secure-random-token    # Required: access token
PORT=3000                              # Server port
DEFAULT_SHELL=cmd.exe                  # Default shell (cmd.exe, powershell.exe, wsl.exe)
SCROLLBACK=10000                       # Terminal scrollback buffer size
```

## P2P Mode (No Browser Required on Desktop)

By default, Terminal Hub requires a browser open on your desktop to relay P2P connections. For headless/VPS use, install a WebRTC implementation:

```bash
npm install @anthropic-ai/wrtc   # or: npm install node-datachannel
```

Then the server acts as the P2P relay directly. Configure with:

```
VDO_ROOM=terminal-hub
VDO_PASSWORD=your-token
VDO_STREAM_ID=server
```

## Security

- **Token auth**: Simple but effective - use a strong random token
- **E2E encrypted**: WebRTC provides encrypted P2P connections
- **No accounts**: Nothing to hack, no password databases
- **Local only by default**: Only accessible on your network unless you expose the port
- **Open source**: Audit the code yourself

For remote access without a VPN, you can:
- Use Cloudflare Tunnel (free)
- Port forward on your router (with strong token)
- Deploy behind nginx with HTTPS

## How It Works

```
┌──────────────────────────────────────────────────────┐
│                    Your Phone                         │
│  ┌─────────────────────────────────────────────────┐ │
│  │  phone.html (mobile-optimized terminal UI)      │ │
│  │  - Virtual keyboard with special keys           │ │
│  │  - Image upload                                  │ │
│  │  - Session switching                             │ │
│  └─────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────┘
                          │
                          │ WebRTC P2P (encrypted)
                          │ or WebSocket (local)
                          ▼
┌──────────────────────────────────────────────────────┐
│                  Terminal Hub Server                  │
│  ┌─────────────────────────────────────────────────┐ │
│  │  Session Manager                                 │ │
│  │  - Spawns shells (cmd, powershell, wsl, ssh)   │ │
│  │  - Manages terminal I/O                         │ │
│  │  - Handles file uploads                         │ │
│  └─────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────┘
                          │
                          ▼
┌──────────────────────────────────────────────────────┐
│  Claude Code / Codex / OpenCode / Any Terminal       │
│  Running your AI coding assistant                     │
└──────────────────────────────────────────────────────┘
```

## API Reference

For programmatic access:

### REST API

All endpoints require `Authorization: Bearer <token>` header.

```
GET  /api/sessions           - List all sessions
POST /api/sessions           - Create session { shell, cols, rows }
DELETE /api/sessions/:id     - Destroy session
```

### WebSocket

Connect to `ws://host:port?token=<token>`

```javascript
{ type: "attach", sessionId: "..." }   // Attach to session
{ type: "input", data: "..." }         // Send input
{ type: "resize", cols: N, rows: N }   // Resize terminal
{ type: "detach" }                     // Detach from session
```

## Troubleshooting

### "node-pty not found" warning

This is normal. Without node-pty, Terminal Hub falls back to a basic mode that works fine for most use cases. To enable full PTY support:

```bash
npm install -g windows-build-tools  # Run as admin
npm install node-pty
```

### Can't connect from phone

- Make sure your phone is on the same network (or use P2P mode)
- Check Windows Firewall allows port 3000
- Try accessing from phone browser: `http://YOUR_PC_IP:3000/phone.html`

### Session disconnects frequently

This usually means the P2P connection is unstable. Try:
- Ensuring both devices have good internet
- Using WebSocket mode (same network) instead of P2P

## Contributing

PRs welcome! This is a community project. Ideas for improvements:

- Linux/Mac support
- More shell integrations
- Terminal themes
- Session recording/playback

## License

MIT - Use it however you want. No attribution required.

---

Built for the AI coding assistant era. Monitor Claude Code from anywhere.
