# Discord AI Moderator Bot

A Discord bot that uses natural language processing to manage your server. Powered by Node.js, `discord.js` v14, and OpenRouter (Gemini 2.5 Flash).

## Features
- **Natural language commands** — just describe what you want in plain English
- **Conversation memory** — reply to the bot's message to follow up without needing `sudo` (e.g., bot suggests something → you reply "yes do it" → bot executes)
- **Multi-step sequences** — create a category, add channels to it, and create roles in one command
- **Parallel execution** — independent tasks run simultaneously for speed
- **Destructive action confirmation** — ban, kick, delete require button confirmation
- **Rollback support** — undo the last action with `sudo rollback`
- **Action history** — review recent operations with `sudo history`
- **Smart model fallback** — cascades through multiple AI models if one fails
- **Custom prompt instructions** — customize the AI's behavior with `/prompt`
- **Bot statistics** — monitor uptime, command usage, and model performance with `/stats`

## Prerequisites
- **Node.js**: Version 18.0.0 or higher (uses native `fetch`).
- **Discord Bot**: Create an app in the [Discord Developer Portal](https://discord.com/developers/applications), and enable **Server Members Intent** and **Message Content Intent**.
- **OpenRouter Account**: Get your API key from [OpenRouter](https://openrouter.ai/).

## Setup Instructions

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Configure Environment Variables**:
   Copy `.env.example` and rename it to `.env`. Fill in the values:
   - `DISCORD_TOKEN`: Your Discord bot token.
   - `OPENROUTER_API_KEY`: Your OpenRouter API key.
   - `OWNER_ID`: Your personal Discord User ID. The bot will *only* respond to this user (and server admins).
   - `COMMAND_CHANNEL_ID`: (Optional) Restrict the bot to only listen to commands in a specific channel by providing its ID. Leave blank to allow commands in any channel.

3. **Start the bot**:
   ```bash
   npm start
   ```

## Usage

### Text Commands
Only the user matching `OWNER_ID` (or server Administrators) can control the bot.
Send a natural language command prefixed with `sudo`:

| Command | Example |
|---------|---------|
| Create channels | `sudo create 5 text channels called dev-1 to dev-5` |
| Create categories | `sudo create a Gaming category` |
| Rename channels | `sudo rename all channels with cool emojis` |
| Delete channels | `sudo delete all channels matching "spam"` |
| Create roles | `sudo create a red Admin role with hoist` |
| Moderation | `sudo ban user 123456789 for spamming` |
| Multi-step | `sudo create a Gaming category, add voice channels lobby and squad-1 inside it, and create a Gamer role in green` |
| General Q&A | `sudo what is 2+2?` |

### Conversation Follow-ups
When the bot replies with a suggestion (e.g., *"I can rename them with special characters or emojis if you'd like!"*), simply **reply to that message** with "yes", "do it", "go ahead", etc. — no `sudo` prefix needed. The bot remembers the conversation context and will execute what it suggested.

### Slash Commands
| Command | Description |
|---------|-------------|
| `/mod_ai_agent` | Run an AI moderator command with a natural language prompt |
| `/stats` | View bot statistics — uptime, commands processed, model usage, memory |
| `/prompt` | View, customize, or reset the AI's system prompt behavior |

### Built-in Commands
- `sudo help` — Show the help menu
- `sudo history` — View recent actions
- `sudo rollback` — Undo the last reversible action

## Model Stack
The bot uses a cascading model strategy via OpenRouter:
1. **Gemini 2.5 Flash** (primary) — best balance of speed, cost, and JSON reliability
2. **Gemini 2.0 Flash** (fallback) — fast and reliable
3. **Llama 3.3 70B** (free) — good free option
4. **Qwen3 30B** (free) — last resort

## License
MIT
