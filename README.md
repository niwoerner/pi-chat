# pi-chat

A standalone daemon that bridges Slack, Discord, and Telegram channels to a pi agent session. Each configured channel gets its own persistent pi session with dedicated workspace, shared storage, memory, and skills.

## Quick Start

```bash
# Configure accounts and channels
# Edit ~/.pi/agent/chat/config.json (see Config below)

# Run the daemon
npm start
# or directly:
npx tsx daemon.ts
```

The daemon starts one worker per configured channel concurrently. Each worker connects to its chat service, catches up on missed messages, then listens for new ones. Workers restart automatically on crash with exponential backoff (1s → 60s).

---

## Requirements

- Node.js 20+
- `tsx` (`npm install` includes it as a devDependency)
- A Slack, Discord, or Telegram bot token
- pi credentials configured (`~/.pi/agent/auth.json`) — the daemon uses the same model/auth as your pi install

---

## Server Setup

1. **Configure locally** — edit `~/.pi/agent/chat/config.json` (or use `/chat-config` inside pi) on your local machine
2. **Copy config to server**:
   ```bash
   rsync ~/.pi/agent/chat/config.json server:~/.pi/agent/chat/config.json
   rsync ~/.pi/agent/auth.json server:~/.pi/agent/auth.json
   ```
3. **Start the daemon** on the server:
   ```bash
   npm start
   ```

**Keep it running:**

```bash
# Simple: run inside a persistent tmux session
tmux new-session -d -s pi-chat 'npm --prefix /path/to/pi-chat start'
```

<details>
<summary>launchd plist (macOS)</summary>

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.pi.chat</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>/path/to/pi-chat/node_modules/.bin/tsx</string>
        <string>/path/to/pi-chat/daemon.ts</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/pi-chat.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/pi-chat.log</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.pi.chat.plist
```

</details>

---

## Config

Config lives at `~/.pi/agent/chat/config.json`:

```json
{
  "botName": "pi",
  "accounts": {
    "my-slack": {
      "service": "slack",
      "name": "My Workspace",
      "botToken": "xoxb-...",
      "appToken": "xapp-...",
      "teamId": "T...",
      "teamName": "My Team",
      "botUserId": "U...",
      "botUsername": "pi",
      "access": {
        "trigger": "mention",
        "ignoreBots": true,
        "allowedUserIds": ["U123456"]
      },
      "channels": {
        "general": {
          "id": "C...",
          "name": "general"
        },
        "bot-dm": {
          "id": "C...",
          "name": "bot-dm",
          "dm": true,
          "access": { "trigger": "message" }
        }
      }
    },
    "my-discord": {
      "service": "discord",
      "botToken": "...",
      "applicationId": "...",
      "serverId": "...",
      "serverName": "My Server",
      "botUserId": "...",
      "botUsername": "pi",
      "channels": {
        "general": { "id": "...", "name": "general" }
      }
    }
  }
}
```

### Access policy

| Field | Default | Description |
|---|---|---|
| `trigger` | `"mention"` | `"mention"` — only @mentions trigger the bot; `"message"` — every message does |
| `ignoreBots` | `true` | Ignore messages from other bots |
| `allowedUserIds` | (all) | Whitelist of user IDs that can trigger the bot |
| `allowedRoleIds` | (all) | Whitelist of role IDs (Discord only) |

Account-level access is merged with channel-level access; channel settings take precedence.

---

## Setup

### Slack

1. Create a Slack app at https://api.slack.com/apps using **Create New App → From an app manifest**.
2. Paste the included [`slack-app-manifest.yaml`](./slack-app-manifest.yaml).
3. Install the app to your workspace. Copy the **Bot User OAuth Token** (`xoxb-...`).
4. In **Basic Information → App-Level Tokens**, generate a token with `connections:write`. Copy it (`xapp-...`).
5. Add the bot to channels you want to use.
6. Fill in `config.json` with `botToken`, `appToken`, `teamId`, `botUserId`, and channel IDs.

Slack uses Socket Mode — no public HTTP endpoint needed.

### Discord

1. Create a bot at [Discord Developer Portal](https://discord.com/developers/applications).
2. Enable **Message Content Intent** under Bot settings.
3. Invite the bot to a server.
4. Fill in `config.json` with `botToken`, `applicationId`, `serverId`, `botUserId`, and channel IDs.

### Telegram

1. Create a bot via [@BotFather](https://t.me/BotFather). Copy the bot token.
2. Fill in `config.json` with `botToken`, `botUsername`, and channel/group IDs.

---

## Remote control

Any allowed user in a connected chat can send these commands (with or without @mentioning the bot):

| Command | Effect |
|---|---|
| `stop` | Abort the current turn |
| `compact` | Compact the session context |
| `status` | Show queue length, record count, and session ID |

---

## Storage layout

```
~/.pi/agent/chat/
├── config.json
└── accounts/<account>/
    ├── shared/
    │   ├── memory.md          # Account-wide persistent memory
    │   └── skills/            # Account-wide skills
    └── channels/<channel>/
        ├── channel.jsonl      # Chat log
        ├── .lock
        └── workspace/
            ├── memory.md      # Channel-specific persistent memory
            ├── skills/        # Channel-specific skills
            ├── incoming/      # Downloaded attachments
            └── .secrets/      # Runtime secrets
```

The pi session for each channel is stored under `~/.pi/agent/sessions/` keyed by workspace dir. Sessions persist across daemon restarts — the agent remembers conversation context.

---

## Memory

Two memory files are read before every agent turn and injected into the system prompt:

| File | Scope |
|---|---|
| `shared/memory.md` | Account-wide — shared across all channels for this account |
| `workspace/memory.md` | Channel-specific |

The agent writes durable facts and preferences here when asked to remember something.

---

## Skills

Skills are markdown files with YAML frontmatter, discovered at runtime and listed in the system prompt:

```yaml
---
name: my-skill
description: What this skill does
---
Instructions for the agent...
```

- **Account-wide:** `shared/skills/` (or `shared/skills/<name>/SKILL.md`)
- **Channel-specific:** `workspace/skills/`

Channel skills override shared skills with the same name.

---

## Tools

| Tool | Description |
|---|---|
| `read` | Read files in the channel workspace |
| `write` | Write files |
| `edit` | In-place file edits |
| `bash` | Run shell commands in the workspace |
| `chat_history` | Search older messages from the chat log |
| `chat_attach` | Queue local files to send with the next reply |

Tools run on the host filesystem with `workspace/` as the working directory. On a dedicated VM this is safe by default; on a shared machine, consider access policies and `allowedUserIds`.

---

## License

MIT
