# pi-chat

A pi extension that bridges Discord, Telegram, and Slack channels to a sandboxed pi session. Each connected channel gets its own persistent workspace, shared storage, memory, and skills.

## Quick Start

```bash
# Install as pi extension (interactive mode)
pi install /path/to/pi-chat
# or
pi -e /path/to/pi-chat

# Configure accounts and channels
/chat-config

# Option A — connect in this pi session
/chat-connect

# Option B — run as a background daemon (all channels at once)
node daemon.ts
```

---

## Modes

### Interactive (pi extension)

Load pi-chat as a pi extension and connect individual channels manually via slash commands. Good for development or single-channel use.

### Daemon (background process)

Run all configured channels in one headless process, no pi TUI required. This is the recommended mode for server deployments.

```bash
node daemon.ts
```

The daemon:
- Connects every channel in `~/.pi/agent/chat/config.json` at startup
- Restarts individual conversations on crash with exponential backoff (1s → 60s)
- Handles `SIGINT`/`SIGTERM` for graceful shutdown
- Maintains full conversation history and auto-compacts context when needed

---

## Server Setup

1. **Configure locally** — run pi with `/chat-config` on your local machine to set up accounts and channels
2. **Copy config to server**:
   ```bash
   rsync ~/.pi/agent/chat/config.json server:~/.pi/agent/chat/config.json
   rsync ~/.pi/agent/auth.json server:~/.pi/agent/auth.json
   ```
3. **Start the daemon** on the server:
   ```bash
   node daemon.ts
   ```

**Keep it running:**

```bash
# Simple: run inside a persistent tmux session
tmux new-session -d -s pi-chat 'node /path/to/pi-chat/daemon.ts'

# macOS (survives reboots):
# Create ~/Library/LaunchAgents/com.pi.chat.plist
# See below
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

## Features

- **Discord server channels**, **Telegram DMs/groups**, and **Slack channels/DMs** (Socket Mode)
- **Streamed preview** responses with edit-in-place
- **Reply-to-trigger** — bot replies are attached to the triggering message
- **Durable memory** — account-wide and channel-specific memory files
- **Skills** — agent-created reusable tools, auto-discovered and injected into the prompt
- **Encrypted secret exchange** — securely pass credentials via browser-based encryption
- **Remote control** — stop, compact, and status via chat commands
- **Chat history** tool for searching older messages
- **File attachments** — send and receive files between chat and workspace

---

## Setup

### Discord

1. Create a bot at [Discord Developer Portal](https://discord.com/developers/applications)
2. Enable **Message Content Intent** under Bot settings
3. Run `/chat-config` → Create account → Discord
4. Enter your bot token
5. Invite the bot to a server (the setup flow provides the invite URL)
6. Select a server and configure channels

### Telegram

1. Create a bot via [@BotFather](https://t.me/BotFather)
2. Run `/chat-config` → Create account → Telegram
3. Enter your bot token
4. Add DMs or groups through the guided setup

### Slack

1. Create a Slack app at https://api.slack.com/apps using **Create New App → From an app manifest**.
2. Paste the included [`slack-app-manifest.yaml`](./slack-app-manifest.yaml). Adjust the app name/display name if desired.
3. Install the app to your workspace and copy the **Bot User OAuth Token** (`xoxb-...`).
4. In **Basic Information → App-Level Tokens**, generate an app-level token with `connections:write`; copy the token (`xapp-...`).
5. Run `/chat-config` → Create account → Slack. Paste the `xoxb-...` bot token and `xapp-...` app token.
6. Invite the bot to any Slack channels you want to use, then select Slack channels/DMs to configure.

Slack uses Socket Mode, so no public HTTP endpoint or Request URL is needed. The included manifest enables the App Home messages tab for DMs. Bot replies are threaded by default: pi-chat responds inside the triggering message's thread.

Required bot scopes/events are captured in `slack-app-manifest.yaml`; if you add scopes later, reinstall the Slack app before refreshing channels in `/chat-config`.

---

## Commands (interactive mode only)

| Command | Description |
|---------|-------------|
| `/chat-config` | Configure accounts, channels, and secrets |
| `/chat-connect` | Connect to a configured channel |
| `/chat-disconnect` | Disconnect the current channel |
| `/chat-status` | Show connection status, model, usage, context |
| `/chat-list` | List configured channels |
| `/chat-spawn-all` | Spawn every configured channel in detached tmux/pi sessions |
| `/chat-spawn-all --restart` | Restart those tmux/pi sessions |
| `/chat-workers` | Show managed tmux/pi worker status |
| `/chat-open-all` | Open running workers in a tiled tmux dashboard |
| `/chat-kill-all` | Kill all managed tmux/pi workers |
| `/chat-new` | Start a new pi session, keeping the chat connection |

---

## Remote Control

Users in the connected chat can send these commands (with or without mentioning the bot):

| Command | Effect |
|---------|--------|
| `stop` | Abort the current turn |
| `status` | Show model, usage, context stats |
| `compact` | Trigger context compaction |

---

## Storage Layout

Everything lives under `~/.pi/agent/chat/`:

```
~/.pi/agent/chat/
├── config.json                          # Accounts, channels, secrets
├── cache/                               # Discovery cache
└── accounts/<account>/
    ├── shared/                          # Account-wide storage
    │   ├── memory.md                    # Account-wide persistent memory
    │   └── skills/                      # Account-wide skills
    └── channels/<channel>/
        ├── channel.jsonl                # Chat log
        ├── .lock                        # Runtime lock
        └── workspace/                   # Agent working directory
            ├── memory.md                # Channel-specific persistent memory
            ├── skills/                  # Channel-specific skills
            ├── incoming/                # Downloaded attachments
            ├── .secrets/                # Encrypted secrets
            └── SYSTEM.md                # Environment modification log
```

---

## Memory

Two persistent memory files, injected into the system prompt on every turn:

| File | Path | Scope |
|------|------|-------|
| Account memory | `shared/memory.md` | Shared across all channels for this account |
| Channel memory | `workspace/memory.md` | Specific to this channel |

The agent writes durable facts and preferences here when asked to remember something.

---

## Skills

The agent can create reusable tools as skills:

- **Account-wide:** `shared/skills/`
- **Channel-specific:** `workspace/skills/`

A skill is either a single `.md` file (e.g. `skills/foo.md`) or a directory with `SKILL.md` plus supporting files (e.g. `skills/foo/SKILL.md`, `skills/foo/run.sh`).

Each skill needs YAML frontmatter:

```yaml
---
name: skill-name
description: Short description of what this skill does
---
```

Skills are automatically discovered and listed in the system prompt each turn. The agent reads the full skill file before using it.

---

## Secrets

### Config Secrets

Configure secrets at three levels via `/chat-config`:

- **Global** — shared across all accounts
- **Per account** — shared across channels of that account
- **Per channel** — specific to one channel

### Runtime Secrets (encrypted exchange)

For credentials the agent needs at runtime:

1. Agent calls the `chat_request_secret` tool
2. A link to `pi.dev/secret` is sent to the chat with an embedded public key
3. User clicks, pastes the secret, and gets an encrypted blob
4. User pastes the blob back into chat
5. pi-chat decrypts it (RSA-OAEP + AES-256-GCM) and stores it at `workspace/.secrets/<name>`
6. Agent is notified and can use the file

---

## Tools

| Tool | Description |
|------|-------------|
| `read` | Read files from the workspace |
| `write` | Create/overwrite files |
| `edit` | Precise in-place edits |
| `bash` | Execute shell commands |
| `chat_history` | Search older messages from the chat log |
| `chat_attach` | Queue files to send with the next reply |
| `chat_request_secret` | Request a secret from the user via encrypted exchange |

---

## Credits

pi-chat includes vendored/adapted logic inspired by [Vercel Chat SDK](https://github.com/vercel/ai) (MIT):

- `src/render/format.ts`
- `src/render/streaming-markdown.ts`
- `src/render/streaming.ts`

---

## License

MIT
