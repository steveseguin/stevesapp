# Steve's App

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

Steve's App gives you browser-based terminal access with **zero configuration**:

```bash
git clone https://github.com/steveseguin/stevesapp
cd stevesapp
npm install
npm start
```

That's it. Open the URL on your phone, enter the token shown in the console, and you're connected.

### Why Steve's App?

| Feature | Tailscale + SSH App | Steve's App |
|---------|---------------------|-------------|
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

- **P2P Connection**: Direct encrypted WebRTC via [VDO.Ninja](https://vdo.ninja), no relay servers storing your data
- **Full PTY Support**: Proper terminal emulation - colors, TUI apps, interactive programs all work
- **Mobile-Optimized UI**: Touch-friendly keyboard with Ctrl+C, arrows, Tab, etc.
- **Image Upload**: Send screenshots from phone to terminal (for AI context)
- **QR Code Login**: Scan from desktop to instantly connect your phone
- **Multiple Sessions**: Run multiple shell sessions, switch between them
- **Multiplexing**: Multiple devices can view/control the same session
- **ANSI Color Support**: Full 16-color palette for colorful CLI output

## Requirements

- **Linux or WSL** (Windows Subsystem for Linux)
- **Node.js 18+**

> **Note**: Steve's App runs on Linux. If you're on Windows, use WSL (Windows Subsystem for Linux). This is required for proper terminal emulation with node-pty.

## Installation

### On Linux / macOS

```bash
git clone https://github.com/steveseguin/stevesapp
cd stevesapp
npm install
npm start
```

### On Windows (via WSL)

1. **Install WSL** (if not already installed):
   ```powershell
   wsl --install
   ```

2. **Open WSL terminal** and install Node.js:
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
   sudo apt-get install -y nodejs
   ```

3. **Clone and run**:
   ```bash
   git clone https://github.com/steveseguin/stevesapp
   cd stevesapp
   npm install
   npm start
   ```

### Output

When the server starts, you'll see:

```
node-pty loaded - full PTY support enabled

Steve's App running on http://0.0.0.0:3000
Local access: http://localhost:3000
Remote access: http://localhost:3000/remote.html

API Token: your-token-here

[P2P] active - room "steves-app", stream "server"
[P2P] Press "p" to toggle, "s" for status, "h" for help.
```

## Connecting

### From Desktop Browser

1. Open `http://localhost:3000`
2. Enter the API token shown in the console
3. Click **Connect**

### From Phone

1. Open `http://YOUR_IP:3000/remote.html` on your phone
2. Enter the API token
3. Tap **Connect**

Or use the **QR code**: On the desktop page, click the QR button and scan with your phone.

### Finding Your IP

- **Local network**: Use your computer's local IP (e.g., `192.168.1.x`)
- **WSL**: The server binds to `0.0.0.0`, accessible via your Windows IP
- **Remote**: Use P2P mode (see below) or set up port forwarding

## Running Claude Code

Once connected, you can run Claude Code directly:

```bash
claude
```

The full terminal UI will render properly, including:
- Colors and syntax highlighting
- Interactive prompts
- Tool use confirmations
- Real-time streaming output

You can monitor Claude's work from your phone while it runs on your desktop/server.

## Configuration

Create a `.env` file for persistent settings:

```bash
cp .env.example .env
```

Available options:

```bash
# Required: access token (auto-generated if not set)
API_TOKEN=your-secure-random-token

# Server port (default: 3000)
PORT=3000

# Terminal scrollback buffer size
SCROLLBACK=10000

# Session I/O logging (enabled by default)
SESSION_LOG_ENABLED=true
SESSION_LOG_DIR=session-logs
SESSION_LOG_KEEP=10

# Default working directory for new shell sessions (fallback: HOME/USERPROFILE)
# Example (WSL): /mnt/c/Users/steve
DEFAULT_CWD=

# P2P relay settings (enabled by default)
P2P_ENABLED=true
VDO_ROOM=steves-app
VDO_PASSWORD=your-secure-random-token
VDO_STREAM_ID=server
VDO_SALT=steves.app
VDO_DEBUG=false

# Legacy alias (use P2P_ENABLED instead)
# VDO_SERVER=true
```

If `API_TOKEN` is not set, a random token is generated each time the server starts.

## Session Logs

When `SESSION_LOG_ENABLED` is true, the server writes JSONL transcripts to `SESSION_LOG_DIR` (default: `session-logs/`).
Each line is a JSON object with a timestamp, type (`start`, `input`, `output`, `exit`, `destroy`), and data.
Only the most recent `SESSION_LOG_KEEP` session files are retained; older logs are removed automatically.

## P2P Remote Access

Steve's App uses [VDO.Ninja](https://vdo.ninja) for P2P WebRTC connections, allowing remote access without port forwarding.

### How it works

1. Node server announces itself to VDO.Ninja signaling server
2. Your phone connects via the same room and stream
3. Direct P2P connection is established
4. All data flows encrypted between your devices

### Configuration

```bash
# In .env
P2P_ENABLED=true           # Enable the server P2P relay (default: true)
VDO_ROOM=steves-app          # Room name (default: steves-app)
VDO_PASSWORD=your-token      # Room password (defaults to API_TOKEN)
VDO_STREAM_ID=server         # Stream identifier
VDO_SALT=steves.app          # Hash salt (use same value on server + remote)
```

Keep `VDO_SALT` consistent between the server and `remote.html` (override with `?salt=` if needed).

### Runtime controls

- Desktop UI toggle controls the server relay state (the desktop browser does not announce P2P).
- Server console menu: press `p` to toggle, `s` for status, `h` for help.

### Server-side relay (optional)

For headless servers, install a WebRTC implementation:

```bash
npm install @roamhq/wrtc   # or: npm install node-datachannel
```

This allows the server to relay P2P connections directly without needing a browser open.

## Security

- **Token auth**: Simple but effective - use a strong random token
- **E2E encrypted**: WebRTC provides encrypted P2P connections
- **No accounts**: Nothing to hack, no password databases
- **Local only by default**: Only accessible on your network unless you enable P2P
- **Open source**: Audit the code yourself

### For remote access

Options for accessing from outside your network:
- **P2P mode**: Use VDO.Ninja relay (built-in)
- **Cloudflare Tunnel**: Free, easy setup
- **Port forwarding**: With strong token
- **Nginx reverse proxy**: With HTTPS

## Architecture

Steve's App uses [VDO.Ninja SDK](https://sdk.vdo.ninja) for P2P connectivity:

```
┌──────────────────────────────────────────────────────┐
│                    Your Phone                         │
│  ┌─────────────────────────────────────────────────┐ │
│  │  remote.html (mobile-optimized terminal UI)     │ │
│  │  - Virtual keyboard with special keys           │ │
│  │  - Image upload for AI context                  │ │
│  │  - Session switching                            │ │
│  └─────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────┘
                          │
                          │ WebRTC P2P (encrypted)
                          │ via VDO.Ninja
                          ▼
┌──────────────────────────────────────────────────────┐
│              Steve's App Server (Linux/WSL)          │
│  ┌─────────────────────────────────────────────────┐ │
│  │  node-pty: Full terminal emulation              │ │
│  │  - Spawns bash/zsh/sh sessions                  │ │
│  │  - Colors, TUI apps, interactive programs       │ │
│  │  - Handles resize, input, output                │ │
│  └─────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────┘
                          │
                          ▼
┌──────────────────────────────────────────────────────┐
│  Claude Code / Codex / OpenCode / Any Terminal App   │
│  Full TUI with colors, interactive prompts           │
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

### "node-pty not available" warning

This means PTY support isn't working. On Linux/WSL, this usually means build tools are missing:

```bash
sudo apt-get install -y build-essential python3
npm rebuild node-pty
```

### Can't connect from phone

- Make sure your phone is on the same network
- Check firewall allows port 3000: `sudo ufw allow 3000`
- Try P2P mode for remote access
- Verify the server is running: `curl http://localhost:3000`

### Colors not showing

Make sure your terminal type is set:
```bash
export TERM=xterm-256color
```

### WSL-specific issues

If running from WSL and can't access from Windows browser:
- WSL2 should work with `localhost:3000` automatically
- If not, find WSL IP: `ip addr show eth0 | grep inet`
- Access via that IP from Windows

## Contributing

PRs welcome! This project uses the [VDO.Ninja SDK](https://sdk.vdo.ninja) for P2P connectivity.

Ideas for improvements:
- Session recording/playback
- Terminal themes
- File browser integration
- Multi-user support

## License

MIT - Use it however you want. No attribution required.

## Credits

- [VDO.Ninja](https://vdo.ninja) - P2P WebRTC platform
- [xterm.js](https://xtermjs.org/) - Terminal emulator
- [node-pty](https://github.com/microsoft/node-pty) - PTY bindings

---

Built for the AI coding assistant era. Monitor Claude Code from anywhere.
