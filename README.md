# 🎮 Minecraft Bot UI

A Minecraft bot with a sleek web-based UI featuring a real-time chat panel.

## Requirements
- **Node.js 16+** — https://nodejs.org
- A Minecraft server to connect to

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Start the bot server
node server.js

# 3. Open your browser
# Go to http://localhost:3000
```

## Features

- 🔌 **Connect/Disconnect** — Connect to any Minecraft server (cracked or premium)
- 💬 **Live Chat Panel** — See all chat messages from other players in real time
- ✉️ **Send Messages** — Type and send chat messages as the bot
- ⌨️ **Command Mode** — Type `/` to switch to command mode (runs server commands)
- ⚡ **Quick Commands** — Buttons for common commands like /help, /list, /home
- 📊 **Bot Stats** — Live health, food, and position display
- 🔍 **Message Filters** — Filter by All / Chat / System / Error
- 🔔 **Whisper Support** — Private messages shown in purple

## Auth Modes

| Mode | Description |
|------|-------------|
| **Offline** | Cracked/offline servers (no account needed) |
| **Microsoft** | Premium accounts (Microsoft login) |
| **Mojang** | Legacy premium accounts |

## Notes

- For **Microsoft auth**, a browser window will open for login on first use
- Leave **Version** blank for auto-detection
- The bot server runs on port `3000` by default
- Change port with: `PORT=8080 node server.js`
# SastaBot
# SastaBot
