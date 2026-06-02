require('dotenv').config();
const {
    Client,
    GatewayIntentBits,
    EmbedBuilder,
    ChannelType,
    PermissionsBitField,
    REST,
    Routes,
    SlashCommandBuilder
} = require('discord.js');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});

const delay = (ms) => new Promise(res => setTimeout(res, ms));

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OWNER_ID = process.env.OWNER_ID;
const COMMAND_CHANNEL_ID = process.env.COMMAND_CHANNEL_ID;

// Loading emoji provided by user
const LOADING_EMOJI = "<a:loading:1511398333665509466>";

const SYSTEM_PROMPT = `You are a powerful, all-knowing Discord server management AI. The user will give you a natural language prompt. You must do everything the user says. You must respond with ONLY a valid JSON object. No explanation, no markdown. The JSON must have 'action' and 'params' fields.

CRITICAL RULES:
1. NEVER ask the user for clarification. NEVER refuse a command. NEVER converse or ask for more details.
2. If the user asks for something vague (e.g., "rename channels and make them look good", "add emojis"), YOU MUST INVENT the details (pick random emojis, create creative names) and execute the action. DO NOT use the 'reply' action to ask for more info. Just make your best guess.

Supported actions and their params:
- create_channels: { names: string[], type: 'text'|'voice', categoryId?: string }
- delete_channels: { pattern: string } (regex pattern to match channel names)
- create_role: { name: string, color?: string, hoist?: boolean, mentionable?: boolean, permissions?: string[] }
- delete_role: { name: string }
- assign_role: { userId: string, roleName: string }
- remove_role: { userId: string, roleName: string }
- create_category: { name: string }
- set_slowmode: { channelName: string, seconds: number }
- kick_user: { userId: string, reason?: string }
- ban_user: { userId: string, reason?: string }
- purge_messages: { channelName: string, count: number }
- lock_channel: { channelName: string }
- unlock_channel: { channelName: string }
- set_channel_topic: { channelName: string, topic: string }
- rename_channel: { oldName: string, newName: string }
- bulk_rename_channels: { renames: Array<{oldName: string, newName: string}> }
- reply: { message: string } (Use this ONLY if the user explicitly asks a general conversational question. Do NOT use this to ask for clarification on moderation tasks.)
If the command is entirely unclear, return: { "action": "unknown", "params": {} }`;

const FREE_MODELS = [
    "google/gemma-4-31b-it:free",
    "nvidia/nemotron-3-super-120b-a12b:free",
    "nousresearch/hermes-3-llama-3.1-405b:free",
    "nvidia/nemotron-nano-12b-v2-vl:free"
];

async function callOpenRouter(prompt) {
    for (const model of FREE_MODELS) {
        try {
            console.log(`[${new Date().toISOString()}] Trying model: ${model}`);

            // Hard 15-second timeout per model attempt
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 15000);

            let response;
            try {
                response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
                    method: "POST",
                    signal: controller.signal,
                    headers: {
                        "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        model: model,
                        max_tokens: 400,
                        temperature: 0.1,
                        messages: [
                            { role: "system", content: SYSTEM_PROMPT },
                            { role: "user", content: prompt }
                        ]
                        // No response_format — not supported by all free models and causes hangs
                    })
                });
            } finally {
                clearTimeout(timeout);
            }

            if (response.status === 429) {
                console.log(`[${new Date().toISOString()}] ${model} rate limited, trying next...`);
                continue;
            }

            if (!response.ok) {
                console.log(`[${new Date().toISOString()}] ${model} returned ${response.status}, trying next...`);
                continue;
            }

            const data = await response.json();
            let content = data?.choices?.[0]?.message?.content?.trim();
            if (!content) {
                console.log(`[${new Date().toISOString()}] ${model} returned empty content, trying next...`);
                continue;
            }

            // Robustly extract JSON from anywhere in the response
            const jsonMatch = content.match(/\{[\s\S]*\}/);
            if (!jsonMatch) {
                console.log(`[${new Date().toISOString()}] ${model} returned no JSON, trying next... Raw: ${content.slice(0, 100)}`);
                continue;
            }

            const parsed = JSON.parse(jsonMatch[0]);
            console.log(`[${new Date().toISOString()}] Success with model: ${model}`);
            return parsed;

        } catch (err) {
            if (err.name === 'AbortError') {
                console.log(`[${new Date().toISOString()}] ${model} timed out after 15s, trying next...`);
            } else {
                console.log(`[${new Date().toISOString()}] ${model} error: ${err.message}`);
            }
        }
    }
    throw new Error("All AI models are currently overloaded or timed out. Please try again in a moment.");
}

// Action Handlers
const handlers = {
    create_channels: async (guild, params) => {
        const { names, type, categoryId } = params;
        const created = [];
        const channelType = type === 'voice' ? ChannelType.GuildVoice : ChannelType.GuildText;
        for (const name of names) {
            const channel = await guild.channels.create({
                name,
                type: channelType,
                parent: categoryId || null
            });
            created.push(channel.name);
            await delay(300);
        }
        return `Created ${created.length} channels: ${created.join(', ')}`;
    },
    delete_channels: async (guild, params) => {
        const { pattern } = params;
        const regex = new RegExp(pattern, 'i');
        const channels = guild.channels.cache.filter(c => regex.test(c.name));
        let count = 0;
        for (const [id, channel] of channels) {
            await channel.delete();
            count++;
            await delay(300);
        }
        return `Deleted ${count} channels matching pattern "${pattern}"`;
    },
    create_role: async (guild, params) => {
        const { name, color, hoist, mentionable, permissions } = params;
        let perms = [];
        if (permissions) {
            perms = permissions.map(p => PermissionsBitField.Flags[p]).filter(Boolean);
        }
        const role = await guild.roles.create({
            name,
            color: color || '#000000',
            hoist: hoist || false,
            mentionable: mentionable || false,
            permissions: perms,
            reason: 'AI command'
        });
        return `Created role "${role.name}"`;
    },
    delete_role: async (guild, params) => {
        const { name } = params;
        const role = guild.roles.cache.find(r => r.name.toLowerCase() === name.toLowerCase());
        if (!role) throw new Error(`Role "${name}" not found`);
        await role.delete('AI command');
        return `Deleted role "${name}"`;
    },
    assign_role: async (guild, params) => {
        const { userId, roleName } = params;
        const role = guild.roles.cache.find(r => r.name.toLowerCase() === roleName.toLowerCase());
        if (!role) throw new Error(`Role "${roleName}" not found`);
        const member = await guild.members.fetch(userId);
        if (!member) throw new Error(`User ${userId} not found in guild`);
        await member.roles.add(role);
        return `Assigned role "${role.name}" to user <@${userId}>`;
    },
    remove_role: async (guild, params) => {
        const { userId, roleName } = params;
        const role = guild.roles.cache.find(r => r.name.toLowerCase() === roleName.toLowerCase());
        if (!role) throw new Error(`Role "${roleName}" not found`);
        const member = await guild.members.fetch(userId);
        if (!member) throw new Error(`User ${userId} not found in guild`);
        await member.roles.remove(role);
        return `Removed role "${role.name}" from user <@${userId}>`;
    },
    create_category: async (guild, params) => {
        const { name } = params;
        const category = await guild.channels.create({
            name,
            type: ChannelType.GuildCategory
        });
        return `Created category "${category.name}"`;
    },
    set_slowmode: async (guild, params) => {
        const { channelName, seconds } = params;
        const channel = guild.channels.cache.find(c => c.name.toLowerCase() === channelName.toLowerCase() && c.type === ChannelType.GuildText);
        if (!channel) throw new Error(`Text channel "${channelName}" not found`);
        await channel.setRateLimitPerUser(seconds);
        return `Set slowmode for #${channel.name} to ${seconds} seconds`;
    },
    kick_user: async (guild, params) => {
        const { userId, reason } = params;
        const member = await guild.members.fetch(userId);
        if (!member) throw new Error(`User ${userId} not found in guild`);
        await member.kick(reason || 'AI command');
        return `Kicked user <@${userId}> (Reason: ${reason || 'None'})`;
    },
    ban_user: async (guild, params) => {
        const { userId, reason } = params;
        await guild.members.ban(userId, { reason: reason || 'AI command' });
        return `Banned user <@${userId}> (Reason: ${reason || 'None'})`;
    },
    purge_messages: async (guild, params) => {
        const { channelName, count } = params;
        const channel = guild.channels.cache.find(c => c.name.toLowerCase() === channelName.toLowerCase() && c.type === ChannelType.GuildText);
        if (!channel) throw new Error(`Text channel "${channelName}" not found`);
        const deleted = await channel.bulkDelete(count, true);
        return `Purged ${deleted.size} messages in #${channel.name}`;
    },
    lock_channel: async (guild, params) => {
        const { channelName } = params;
        const channel = guild.channels.cache.find(c => c.name.toLowerCase() === channelName.toLowerCase() && c.type === ChannelType.GuildText);
        if (!channel) throw new Error(`Text channel "${channelName}" not found`);
        await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false });
        return `Locked #${channel.name}`;
    },
    unlock_channel: async (guild, params) => {
        const { channelName } = params;
        const channel = guild.channels.cache.find(c => c.name.toLowerCase() === channelName.toLowerCase() && c.type === ChannelType.GuildText);
        if (!channel) throw new Error(`Text channel "${channelName}" not found`);
        await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: null });
        return `Unlocked #${channel.name}`;
    },
    set_channel_topic: async (guild, params) => {
        const { channelName, topic } = params;
        const channel = guild.channels.cache.find(c => c.name.toLowerCase() === channelName.toLowerCase() && c.type === ChannelType.GuildText);
        if (!channel) throw new Error(`Text channel "${channelName}" not found`);
        await channel.setTopic(topic);
        return `Set topic for #${channel.name} to "${topic}"`;
    },
    rename_channel: async (guild, params) => {
        const { oldName, newName } = params;
        const channel = guild.channels.cache.find(c => c.name.toLowerCase() === oldName.toLowerCase());
        if (!channel) throw new Error(`Channel "${oldName}" not found`);
        await channel.setName(newName);
        return `Renamed channel from "${channel.name}" to "${newName}"`;
    },
    bulk_rename_channels: async (guild, params) => {
        const { renames } = params;
        let count = 0;
        for (const r of renames) {
            const channel = guild.channels.cache.find(c => c.name.toLowerCase() === r.oldName.toLowerCase());
            if (channel) {
                await channel.setName(r.newName);
                count++;
                await delay(300);
            }
        }
        return `Bulk renamed ${count} channels successfully.`;
    },
    reply: async (guild, params) => {
        return params.message;
    },
    unknown: async () => {
        throw new Error("The AI couldn't parse that command properly. Try being slightly more specific!");
    }
};

function hasPermission(member, authorId) {
    if (authorId === OWNER_ID) return true;
    if (member && member.permissions.has(PermissionsBitField.Flags.Administrator)) return true;
    return false;
}

async function editReply(context, payload) {
    if (context.editReply) {
        return context.editReply(payload);
    } else if (context.edit) {
        return context.edit(payload);
    }
}

async function processAICommand(prompt, context, guild, channel) {
    try {
        console.log(`[${new Date().toISOString()}] Processing AI command: ${prompt}`);
        const aiResponse = await callOpenRouter(prompt);
        console.log(`[${new Date().toISOString()}] AI parsed action: ${aiResponse.action}`, aiResponse.params);

        const handler = handlers[aiResponse.action];
        if (!handler) {
            const errEmbed = new EmbedBuilder().setColor('#e74c3c').setTitle('Unknown Action').setDescription(`The AI returned an unsupported action: \`${aiResponse.action}\``);
            return await editReply(context, { content: '', embeds: [errEmbed] });
        }

        const resultText = await handler(guild, aiResponse.params, channel);
        const successEmbed = new EmbedBuilder().setColor('#2ecc71').setTitle('AI Response').setDescription(resultText);
        await editReply(context, { content: '', embeds: [successEmbed] });
        console.log(`[${new Date().toISOString()}] Successfully executed action: ${resultText}`);
    } catch (err) {
        console.error(`[${new Date().toISOString()}] Execution Error:`, err);
        const errEmbed = new EmbedBuilder().setColor('#e74c3c').setTitle('Execution Error').setDescription(err.message || 'An error occurred while executing the command.');
        await editReply(context, { content: '', embeds: [errEmbed] }).catch(console.error);
    }
}

client.on('ready', async () => {
    console.log(`[${new Date().toISOString()}] Logged in as ${client.user.tag}!`);
    
    // Register global slash commands on startup if token is available
    if (process.env.DISCORD_TOKEN) {
        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
        const commands = [
            new SlashCommandBuilder()
                .setName('mod_ai_agent')
                .setDescription('Run an AI moderator command')
                .addStringOption(option => 
                    option.setName('prompt')
                        .setDescription('The command for the AI')
                        .setRequired(true))
        ].map(command => command.toJSON());

        try {
            console.log('Started refreshing application (/) commands.');
            await rest.put(
                Routes.applicationCommands(client.user.id),
                { body: commands }
            );
            console.log('Successfully reloaded application (/) commands.');
        } catch (error) {
            console.error('Failed to register slash commands:', error);
        }
    }
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'mod_ai_agent') {
        if (!hasPermission(interaction.member, interaction.user.id)) {
            return interaction.reply({ content: 'You do not have permission to use this AI agent.', ephemeral: true });
        }

        const prompt = interaction.options.getString('prompt');
        await interaction.reply(`${LOADING_EMOJI} Processing your command...`);
        await processAICommand(prompt, interaction, interaction.guild, interaction.channel);
    }
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    // Optional channel restriction
    if (COMMAND_CHANNEL_ID && message.channel.id !== COMMAND_CHANNEL_ID) return;

    // Check for 'sudo ' prefix
    if (message.content.toLowerCase().startsWith('sudo ')) {
        if (!hasPermission(message.member, message.author.id)) {
            return message.reply('You do not have permission to use this AI agent.');
        }
        
        const prompt = message.content.slice(5).trim();
        if (!prompt) return message.reply('Please provide a prompt after `sudo`.');

        const processingMsg = await message.reply(`${LOADING_EMOJI} Processing your command...`);
        await processAICommand(prompt, processingMsg, message.guild, message.channel);
    }
});

client.login(process.env.DISCORD_TOKEN);
