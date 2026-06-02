# Discord AI Moderator Bot

A Discord bot that uses natural language processing to manage your server. Powered by Node.js, `discord.js` v14, and OpenRouter's Llama 3.1 253B.

## Prerequisites
- **Node.js**: Version 18.0.0 or higher is required (uses native `fetch`).
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
   - `OWNER_ID`: Your personal Discord User ID. The bot will *only* respond to this user.
   - `COMMAND_CHANNEL_ID`: (Optional) Restrict the bot to only listen to commands in a specific channel by providing its ID. Leave blank to allow commands in any channel.

3. **Start the bot**:
   ```bash
   npm start
   ```

## Usage
Only the user matching `OWNER_ID` can control the bot.
Send a natural language command to the bot in an allowed channel, for example:
- "Create 5 text channels named dev-chat-1 to dev-chat-5"
- "Create a category called Staff"
- "Make a red role called Admin with hoist and mentionable permissions"
- "Delete all channels matching the pattern chat-.*"
- "Purge 100 messages in general"
- "Set slowmode in general to 10 seconds"
- "Lock the announcements channel"
- "Ban user 123456789012345678 for spamming"

Type `!help` in the server to see a detailed list of examples!
