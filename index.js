require('dotenv').config();
const {
    Client,
    GatewayIntentBits,
    EmbedBuilder,
    ChannelType,
    PermissionsBitField,
    REST,
    Routes,
    SlashCommandBuilder,
    ButtonBuilder,
    ActionRowBuilder,
    ButtonStyle,
    ComponentType
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
const LOADING_EMOJI = "<a:loading:1511398333665509466>";

// ─── Action History (in-memory, last 20 actions) ───────────────────────────
const actionHistory = [];
const MAX_HISTORY = 20;

function addToHistory(entry) {
    actionHistory.unshift(entry); // newest first
    if (actionHistory.length > MAX_HISTORY) actionHistory.pop();
}

// ─── Destructive actions that require confirmation ──────────────────────────
const DESTRUCTIVE_ACTIONS = new Set([
    'delete_channels', 'kick_user', 'ban_user',
    'purge_messages', 'delete_role'
]);

// ─── Build live server context for AI ──────────────────────────────────────
function buildServerContext(guild) {
    const textChannels = guild.channels.cache
        .filter(c => c.type === ChannelType.GuildText)
        .map(c => `#${c.name}`)
        .slice(0, 30).join(', ');

    const voiceChannels = guild.channels.cache
        .filter(c => c.type === ChannelType.GuildVoice)
        .map(c => c.name)
        .slice(0, 10).join(', ');

    const categories = guild.channels.cache
        .filter(c => c.type === ChannelType.GuildCategory)
        .map(c => c.name)
        .slice(0, 10).join(', ');

    const roles = guild.roles.cache
        .filter(r => r.name !== '@everyone')
        .map(r => r.name)
        .slice(0, 20).join(', ');

    const recentActions = actionHistory.slice(0, 5).map(h => {
        const ago = Math.round((Date.now() - h.timestamp) / 1000);
        return `[${ago}s ago] ${h.action}: ${h.summary}`;
    }).join('\n') || 'None';

    return `CURRENT SERVER STATE:
Text Channels: ${textChannels || 'none'}
Voice Channels: ${voiceChannels || 'none'}
Categories: ${categories || 'none'}
Roles: ${roles || 'none'}
Recent Actions:
${recentActions}`;
}

// ─── System Prompt ──────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are an elite Discord server management AI. Output ONLY a single raw JSON object. No markdown, no explanation, no extra text — just the JSON.

RULES:
- Never ask for clarification. Always act. If vague, invent reasonable creative details.
- Output must be valid JSON with "action" and "params" keys.
- You will receive the current server state (channels, roles, categories). USE THIS to reference exact names.
- If the user says "rename my channels" and lists exist, rename those actual channels.

ACTIONS (use exact action names):
create_channels      -> params: { names: string[], type: "text"|"voice", categoryId?: string }
delete_channels      -> params: { pattern: string }
create_role          -> params: { name: string, color?: string, hoist?: boolean, mentionable?: boolean, permissions?: string[] }
delete_role          -> params: { name: string }
assign_role          -> params: { userId: string, roleName: string }
remove_role          -> params: { userId: string, roleName: string }
create_category      -> params: { name: string }
set_slowmode         -> params: { channelName: string, seconds: number }
kick_user            -> params: { userId: string, reason?: string }
ban_user             -> params: { userId: string, reason?: string }
purge_messages       -> params: { channelName: string, count: number }
lock_channel         -> params: { channelName: string }
unlock_channel       -> params: { channelName: string }
set_channel_topic    -> params: { channelName: string, topic: string }
rename_channel       -> params: { oldName: string, newName: string }
bulk_rename_channels -> params: { renames: [{oldName: string, newName: string}] }
reply                -> params: { message: string } (ONLY for general knowledge questions, NOT for asking clarification)

EXAMPLES:
User: "create 3 text channels called lobby, lounge, and hangout"
{"action":"create_channels","params":{"names":["lobby","lounge","hangout"],"type":"text"}}

User: "rename all my channels to look cool with emojis"
{"action":"bulk_rename_channels","params":{"renames":[{"oldName":"general","newName":"💬・general"},{"oldName":"announcements","newName":"📢・announcements"},{"oldName":"bot-commands","newName":"🤖・bot-commands"}]}}

User: "make a red admin role with hoist"
{"action":"create_role","params":{"name":"Admin","color":"#FF0000","hoist":true,"mentionable":false}}

User: "purge 50 messages in general"
{"action":"purge_messages","params":{"channelName":"general","count":50}}

User: "lock the announcements channel"
{"action":"lock_channel","params":{"channelName":"announcements"}}

User: "what is the speed of light?"
{"action":"reply","params":{"message":"The speed of light is approximately 299,792,458 meters per second."}}`;

// ─── Model Stack ────────────────────────────────────────────────────────────
const FREE_MODELS = [
    "meta-llama/llama-3.3-70b-instruct:free",
    "moonshotai/kimi-k2.6:free",
    "openai/gpt-oss-120b:free",
    "qwen/qwen3-next-80b-a3b-instruct:free",
    "nousresearch/hermes-3-llama-3.1-405b:free"
];

async function callOpenRouter(userPrompt, serverContext) {
    const fullUserMessage = `${serverContext}\n\nUSER COMMAND: ${userPrompt}`;

    for (const model of FREE_MODELS) {
        try {
            console.log(`[${new Date().toISOString()}] Trying model: ${model}`);
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 20000);

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
                        model,
                        max_tokens: 512,
                        temperature: 0.1,
                        messages: [
                            { role: "system", content: SYSTEM_PROMPT },
                            { role: "user", content: fullUserMessage }
                        ]
                    })
                });
            } finally {
                clearTimeout(timeout);
            }

            if (response.status === 429) { console.log(`[${new Date().toISOString()}] ${model} rate limited, trying next...`); continue; }
            if (!response.ok) { console.log(`[${new Date().toISOString()}] ${model} returned ${response.status}, trying next...`); continue; }

            const data = await response.json();
            let content = data?.choices?.[0]?.message?.content?.trim();
            if (!content) { console.log(`[${new Date().toISOString()}] ${model} empty content, trying next...`); continue; }

            console.log(`[${new Date().toISOString()}] Raw from ${model}: ${content.slice(0, 300)}`);

            // Extract outermost JSON block
            let parsed = null;
            const bigMatch = content.match(/\{[\s\S]*\}/);
            if (bigMatch) { try { parsed = JSON.parse(bigMatch[0]); } catch (_) {} }
            if (!parsed || !parsed.action) { console.log(`[${new Date().toISOString()}] ${model} no valid JSON, trying next...`); continue; }

            console.log(`[${new Date().toISOString()}] ✅ ${model} → action: ${parsed.action}`);
            return parsed;

        } catch (err) {
            const msg = err.name === 'AbortError' ? 'timed out (20s)' : err.message;
            console.log(`[${new Date().toISOString()}] ${model} failed: ${msg}, trying next...`);
        }
    }
    throw new Error("All AI models are currently unavailable. Please try again in a moment.");
}

// ─── Rollback Helpers ───────────────────────────────────────────────────────
function buildRollbackFn(action, params, guild) {
    switch (action) {
        case 'create_channels':
            return async () => {
                for (const name of params.names) {
                    const ch = guild.channels.cache.find(c => c.name === name);
                    if (ch) { await ch.delete(); await delay(300); }
                }
                return `Deleted channels: ${params.names.join(', ')}`;
            };
        case 'create_role':
            return async () => {
                const role = guild.roles.cache.find(r => r.name === params.name);
                if (role) await role.delete();
                return `Deleted role "${params.name}"`;
            };
        case 'create_category':
            return async () => {
                const cat = guild.channels.cache.find(c => c.name === params.name && c.type === ChannelType.GuildCategory);
                if (cat) await cat.delete();
                return `Deleted category "${params.name}"`;
            };
        case 'assign_role':
            return async () => {
                const role = guild.roles.cache.find(r => r.name.toLowerCase() === params.roleName.toLowerCase());
                const member = await guild.members.fetch(params.userId).catch(() => null);
                if (role && member) await member.roles.remove(role);
                return `Removed role "${params.roleName}" from <@${params.userId}>`;
            };
        case 'remove_role':
            return async () => {
                const role = guild.roles.cache.find(r => r.name.toLowerCase() === params.roleName.toLowerCase());
                const member = await guild.members.fetch(params.userId).catch(() => null);
                if (role && member) await member.roles.add(role);
                return `Re-assigned role "${params.roleName}" to <@${params.userId}>`;
            };
        case 'set_slowmode': {
            const prev = guild.channels.cache.find(c => c.name.toLowerCase() === params.channelName.toLowerCase())?.rateLimitPerUser || 0;
            return async () => {
                const ch = guild.channels.cache.find(c => c.name.toLowerCase() === params.channelName.toLowerCase());
                if (ch) await ch.setRateLimitPerUser(prev);
                return `Restored slowmode in #${params.channelName} to ${prev}s`;
            };
        }
        case 'lock_channel':
            return async () => {
                const ch = guild.channels.cache.find(c => c.name.toLowerCase() === params.channelName.toLowerCase());
                if (ch) await ch.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: null });
                return `Unlocked #${params.channelName}`;
            };
        case 'unlock_channel':
            return async () => {
                const ch = guild.channels.cache.find(c => c.name.toLowerCase() === params.channelName.toLowerCase());
                if (ch) await ch.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false });
                return `Locked #${params.channelName}`;
            };
        case 'rename_channel':
            return async () => {
                const ch = guild.channels.cache.find(c => c.name.toLowerCase() === params.newName.toLowerCase());
                if (ch) await ch.setName(params.oldName);
                return `Renamed back to "${params.oldName}"`;
            };
        case 'bulk_rename_channels':
            return async () => {
                for (const r of params.renames) {
                    const ch = guild.channels.cache.find(c => c.name.toLowerCase() === r.newName.toLowerCase());
                    if (ch) { await ch.setName(r.oldName); await delay(300); }
                }
                return `Reverted ${params.renames.length} channel renames`;
            };
        case 'set_channel_topic': {
            const prevTopic = guild.channels.cache.find(c => c.name.toLowerCase() === params.channelName.toLowerCase())?.topic || '';
            return async () => {
                const ch = guild.channels.cache.find(c => c.name.toLowerCase() === params.channelName.toLowerCase());
                if (ch) await ch.setTopic(prevTopic);
                return `Restored topic in #${params.channelName}`;
            };
        }
        case 'ban_user':
            return async () => {
                await guild.members.unban(params.userId);
                return `Unbanned user <@${params.userId}>`;
            };
        default:
            return null; // not rollbackable
    }
}

// ─── Action Handlers ────────────────────────────────────────────────────────
const handlers = {
    create_channels: async (guild, params) => {
        const { names, type, categoryId } = params;
        const channelType = type === 'voice' ? ChannelType.GuildVoice : ChannelType.GuildText;
        const created = [];
        for (const name of names) {
            const ch = await guild.channels.create({ name, type: channelType, parent: categoryId || null });
            created.push(ch.name);
            await delay(300);
        }
        return `Created ${created.length} ${type || 'text'} channel(s): ${created.map(n => `**${n}**`).join(', ')}`;
    },
    delete_channels: async (guild, params) => {
        const regex = new RegExp(params.pattern, 'i');
        const channels = guild.channels.cache.filter(c => regex.test(c.name));
        let count = 0;
        for (const [, ch] of channels) { await ch.delete(); count++; await delay(300); }
        return `Deleted **${count}** channel(s) matching \`${params.pattern}\``;
    },
    create_role: async (guild, params) => {
        const { name, color, hoist, mentionable, permissions } = params;
        let perms = (permissions || []).map(p => PermissionsBitField.Flags[p]).filter(Boolean);
        const role = await guild.roles.create({ name, color: color || '#000000', hoist: !!hoist, mentionable: !!mentionable, permissions: perms, reason: 'AI command' });
        return `Created role **${role.name}** ${color ? `with color \`${color}\`` : ''}`;
    },
    delete_role: async (guild, params) => {
        const role = guild.roles.cache.find(r => r.name.toLowerCase() === params.name.toLowerCase());
        if (!role) throw new Error(`Role "${params.name}" not found`);
        await role.delete('AI command');
        return `Deleted role **${params.name}**`;
    },
    assign_role: async (guild, params) => {
        const role = guild.roles.cache.find(r => r.name.toLowerCase() === params.roleName.toLowerCase());
        if (!role) throw new Error(`Role "${params.roleName}" not found`);
        const member = await guild.members.fetch(params.userId);
        await member.roles.add(role);
        return `Assigned **${role.name}** to <@${params.userId}>`;
    },
    remove_role: async (guild, params) => {
        const role = guild.roles.cache.find(r => r.name.toLowerCase() === params.roleName.toLowerCase());
        if (!role) throw new Error(`Role "${params.roleName}" not found`);
        const member = await guild.members.fetch(params.userId);
        await member.roles.remove(role);
        return `Removed **${role.name}** from <@${params.userId}>`;
    },
    create_category: async (guild, params) => {
        const cat = await guild.channels.create({ name: params.name, type: ChannelType.GuildCategory });
        return `Created category **${cat.name}**`;
    },
    set_slowmode: async (guild, params) => {
        const ch = guild.channels.cache.find(c => c.name.toLowerCase() === params.channelName.toLowerCase() && c.type === ChannelType.GuildText);
        if (!ch) throw new Error(`Text channel "${params.channelName}" not found`);
        await ch.setRateLimitPerUser(params.seconds);
        return `Set slowmode in **#${ch.name}** to **${params.seconds}s**`;
    },
    kick_user: async (guild, params) => {
        const member = await guild.members.fetch(params.userId);
        await member.kick(params.reason || 'AI command');
        return `Kicked <@${params.userId}> — Reason: ${params.reason || 'None'}`;
    },
    ban_user: async (guild, params) => {
        await guild.members.ban(params.userId, { reason: params.reason || 'AI command' });
        return `Banned <@${params.userId}> — Reason: ${params.reason || 'None'}`;
    },
    purge_messages: async (guild, params) => {
        const ch = guild.channels.cache.find(c => c.name.toLowerCase() === params.channelName.toLowerCase() && c.type === ChannelType.GuildText);
        if (!ch) throw new Error(`Text channel "${params.channelName}" not found`);
        const deleted = await ch.bulkDelete(Math.min(params.count, 100), true);
        return `Purged **${deleted.size}** messages in **#${ch.name}**`;
    },
    lock_channel: async (guild, params) => {
        const ch = guild.channels.cache.find(c => c.name.toLowerCase() === params.channelName.toLowerCase() && c.type === ChannelType.GuildText);
        if (!ch) throw new Error(`Text channel "${params.channelName}" not found`);
        await ch.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false });
        return `🔒 Locked **#${ch.name}**`;
    },
    unlock_channel: async (guild, params) => {
        const ch = guild.channels.cache.find(c => c.name.toLowerCase() === params.channelName.toLowerCase() && c.type === ChannelType.GuildText);
        if (!ch) throw new Error(`Text channel "${params.channelName}" not found`);
        await ch.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: null });
        return `🔓 Unlocked **#${ch.name}**`;
    },
    set_channel_topic: async (guild, params) => {
        const ch = guild.channels.cache.find(c => c.name.toLowerCase() === params.channelName.toLowerCase() && c.type === ChannelType.GuildText);
        if (!ch) throw new Error(`Text channel "${params.channelName}" not found`);
        await ch.setTopic(params.topic);
        return `Set topic for **#${ch.name}** to: *${params.topic}*`;
    },
    rename_channel: async (guild, params) => {
        const ch = guild.channels.cache.find(c => c.name.toLowerCase() === params.oldName.toLowerCase());
        if (!ch) throw new Error(`Channel "${params.oldName}" not found`);
        await ch.setName(params.newName);
        return `Renamed **${params.oldName}** → **${params.newName}**`;
    },
    bulk_rename_channels: async (guild, params) => {
        let count = 0;
        for (const r of params.renames) {
            const ch = guild.channels.cache.find(c => c.name.toLowerCase() === r.oldName.toLowerCase());
            if (ch) { await ch.setName(r.newName); count++; await delay(400); }
        }
        return `Bulk renamed **${count}** channel(s)`;
    },
    reply: async (guild, params) => params.message,
    unknown: async () => { throw new Error("Couldn't parse that command. Try rephrasing it."); }
};

// ─── Permission Check ───────────────────────────────────────────────────────
function hasPermission(member, authorId) {
    if (authorId === OWNER_ID) return true;
    if (member?.permissions.has(PermissionsBitField.Flags.Administrator)) return true;
    return false;
}

// ─── Edit reply helper ──────────────────────────────────────────────────────
async function editReply(ctx, payload) {
    if (ctx.editReply) return ctx.editReply(payload);
    if (ctx.edit) return ctx.edit(payload);
}

// ─── Core processor ─────────────────────────────────────────────────────────
async function processAICommand(prompt, ctx, guild, channel, replyFn) {
    try {
        const serverContext = buildServerContext(guild);
        console.log(`[${new Date().toISOString()}] Command: "${prompt}"`);

        let aiResponse;
        try {
            aiResponse = await callOpenRouter(prompt, serverContext);
        } catch (err) {
            const errEmbed = new EmbedBuilder().setColor('#e74c3c').setTitle('❌ AI Error').setDescription(err.message);
            return await editReply(ctx, { content: '', embeds: [errEmbed] });
        }

        const { action, params } = aiResponse;
        const handler = handlers[action];
        if (!handler) {
            const errEmbed = new EmbedBuilder().setColor('#e74c3c').setTitle('❌ Unknown Action').setDescription(`Unsupported action: \`${action}\``);
            return await editReply(ctx, { content: '', embeds: [errEmbed] });
        }

        // ── Confirmation for destructive actions ──
        if (DESTRUCTIVE_ACTIONS.has(action)) {
            const confirmEmbed = new EmbedBuilder()
                .setColor('#f39c12')
                .setTitle('⚠️ Confirm Action')
                .setDescription(`**Action:** \`${action}\`\n**Params:** \`\`\`json\n${JSON.stringify(params, null, 2)}\`\`\`\nThis action may be **irreversible**. Are you sure?`)
                .setFooter({ text: 'Expires in 30 seconds' });

            const confirmBtn = new ButtonBuilder().setCustomId('confirm_action').setLabel('✅ Confirm').setStyle(ButtonStyle.Danger);
            const cancelBtn = new ButtonBuilder().setCustomId('cancel_action').setLabel('❌ Cancel').setStyle(ButtonStyle.Secondary);
            const row = new ActionRowBuilder().addComponents(confirmBtn, cancelBtn);

            await editReply(ctx, { content: '', embeds: [confirmEmbed], components: [row] });

            // Get the actual message to collect interactions
            const sentMsg = ctx.editReply ? await ctx.fetchReply() : ctx;

            try {
                const confirmation = await sentMsg.awaitMessageComponent({
                    filter: i => i.user.id === (ctx.user?.id || channel.messages.cache.get(sentMsg.id)?.author?.id || OWNER_ID),
                    componentType: ComponentType.Button,
                    time: 30000
                });

                if (confirmation.customId === 'cancel_action') {
                    const cancelEmbed = new EmbedBuilder().setColor('#95a5a6').setTitle('🚫 Cancelled').setDescription('Action was cancelled.');
                    return await confirmation.update({ embeds: [cancelEmbed], components: [] });
                }
                await confirmation.update({ components: [] }); // remove buttons, proceed
            } catch {
                const expiredEmbed = new EmbedBuilder().setColor('#95a5a6').setTitle('⏰ Timed Out').setDescription('Confirmation expired. Action cancelled.');
                return await editReply(ctx, { embeds: [expiredEmbed], components: [] });
            }
        } else {
            await editReply(ctx, { content: `${LOADING_EMOJI} Executing **${action}**...` });
        }

        // ── Execute ──
        try {
            const rollbackFn = buildRollbackFn(action, params, guild);
            const resultText = await handler(guild, params, channel);

            addToHistory({
                action,
                params,
                summary: resultText,
                timestamp: Date.now(),
                rollbackFn,
                canRollback: !!rollbackFn
            });

            const successEmbed = new EmbedBuilder()
                .setColor('#2ecc71')
                .setTitle('✅ Done')
                .setDescription(resultText)
                .setFooter({ text: rollbackFn ? 'Use "sudo rollback" to undo this action' : 'This action cannot be undone' })
                .setTimestamp();

            await editReply(ctx, { content: '', embeds: [successEmbed], components: [] });
            console.log(`[${new Date().toISOString()}] ✅ ${action}: ${resultText}`);
        } catch (err) {
            console.error(`[${new Date().toISOString()}] Execution error:`, err);
            const errEmbed = new EmbedBuilder().setColor('#e74c3c').setTitle('❌ Execution Error').setDescription(err.message);
            await editReply(ctx, { content: '', embeds: [errEmbed], components: [] }).catch(console.error);
        }

    } catch (err) {
        console.error(`[${new Date().toISOString()}] Critical error:`, err);
    }
}

// ─── Bot Ready + Slash Command Registration ─────────────────────────────────
client.on('ready', async () => {
    console.log(`[${new Date().toISOString()}] ✅ Logged in as ${client.user.tag}`);

    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    const commands = [
        new SlashCommandBuilder()
            .setName('mod_ai_agent')
            .setDescription('Run an AI moderator command')
            .addStringOption(opt => opt.setName('prompt').setDescription('Your command').setRequired(true))
    ].map(c => c.toJSON());

    try {
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log(`[${new Date().toISOString()}] ✅ Slash commands registered`);
    } catch (err) {
        console.error('Failed to register slash commands:', err);
    }
});

// ─── Slash Command Handler ──────────────────────────────────────────────────
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== 'mod_ai_agent') return;

    if (!hasPermission(interaction.member, interaction.user.id)) {
        return interaction.reply({ content: '🚫 You do not have permission to use this.', ephemeral: true });
    }

    const prompt = interaction.options.getString('prompt');
    await interaction.reply(`${LOADING_EMOJI} Processing: *"${prompt}"*`);
    await processAICommand(prompt, interaction, interaction.guild, interaction.channel);
});

// ─── Message Handler ─────────────────────────────────────────────────────────
client.on('messageCreate', async message => {
    if (message.author.bot) return;
    if (COMMAND_CHANNEL_ID && message.channel.id !== COMMAND_CHANNEL_ID) return;
    if (!hasPermission(message.member, message.author.id)) return;

    const content = message.content.trim();

    // ── sudo rollback ──
    if (/^sudo\s+rollback$/i.test(content)) {
        const last = actionHistory.find(h => h.canRollback);
        if (!last) {
            return message.reply({ embeds: [new EmbedBuilder().setColor('#e74c3c').setTitle('❌ Nothing to Rollback').setDescription('No reversible actions in history.')] });
        }
        const processingMsg = await message.reply(`${LOADING_EMOJI} Rolling back **${last.action}**...`);
        try {
            const result = await last.rollbackFn();
            last.canRollback = false; // mark as rolled back
            processingMsg.edit({ content: '', embeds: [new EmbedBuilder().setColor('#3498db').setTitle('↩️ Rolled Back').setDescription(result).setTimestamp()] });
        } catch (err) {
            processingMsg.edit({ content: '', embeds: [new EmbedBuilder().setColor('#e74c3c').setTitle('❌ Rollback Failed').setDescription(err.message)] });
        }
        return;
    }

    // ── sudo history ──
    if (/^sudo\s+history$/i.test(content)) {
        if (!actionHistory.length) {
            return message.reply({ embeds: [new EmbedBuilder().setColor('#95a5a6').setTitle('📜 Action History').setDescription('No actions recorded yet.')] });
        }
        const lines = actionHistory.map((h, i) => {
            const ago = Math.round((Date.now() - h.timestamp) / 1000);
            const rollbackLabel = h.canRollback ? '↩️' : h.canRollback === false ? '✅' : '⛔';
            return `${rollbackLabel} **[${ago}s ago]** \`${h.action}\` — ${h.summary}`;
        }).join('\n');
        return message.reply({ embeds: [new EmbedBuilder().setColor('#3498db').setTitle('📜 Action History (Last 20)').setDescription(lines).setTimestamp()] });
    }

    // ── sudo help ──
    if (/^sudo\s+help$/i.test(content)) {
        const embed = new EmbedBuilder()
            .setColor('#3498db')
            .setTitle('🤖 AI Moderator Bot — Help')
            .setDescription('Prefix all commands with **`sudo`**. The AI understands natural language!')
            .addFields(
                { name: '📁 Channels', value: '`sudo create 5 text channels called chat-1 to chat-5`\n`sudo delete all channels with "test" in the name`\n`sudo rename general to 💬・general`\n`sudo rename all channels to look cool with emojis`\n`sudo lock the announcements channel`\n`sudo set slowmode in general to 10 seconds`\n`sudo purge 50 messages in general`', inline: false },
                { name: '🎭 Roles', value: '`sudo create a red Admin role with hoist`\n`sudo delete the Muted role`\n`sudo assign Admin to user 123456789`\n`sudo remove Muted from user 123456789`', inline: false },
                { name: '🛡️ Moderation', value: '`sudo kick user 123456789 for spamming`\n`sudo ban user 123456789 for rule violation`', inline: false },
                { name: '⚙️ Bot Commands', value: '`sudo history` — See last 20 actions\n`sudo rollback` — Undo the last reversible action\n`sudo help` — Show this menu', inline: false }
            )
            .setFooter({ text: 'Destructive actions (delete/ban/kick/purge) require confirmation.' });
        return message.reply({ embeds: [embed] });
    }

    // ── sudo <prompt> ──
    if (/^sudo\s+/i.test(content)) {
        const prompt = content.slice(5).trim();
        if (!prompt) return message.reply('Please provide a command after `sudo`.');

        const processingMsg = await message.reply(`${LOADING_EMOJI} Processing: *"${prompt}"*`);
        await processAICommand(prompt, processingMsg, message.guild, message.channel);
    }
});

client.login(process.env.DISCORD_TOKEN);
