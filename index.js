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

// ─── Action History ─────────────────────────────────────────────────────────
const actionHistory = [];
const MAX_HISTORY = 30;

function addToHistory(entry) {
    actionHistory.unshift(entry);
    if (actionHistory.length > MAX_HISTORY) actionHistory.pop();
}

// ─── Destructive actions needing confirmation ───────────────────────────────
const DESTRUCTIVE_ACTIONS = new Set([
    'delete_channels', 'kick_user', 'ban_user',
    'purge_messages', 'delete_role'
]);

// ─── Build live server context ──────────────────────────────────────────────
function buildServerContext(guild) {
    const textChannels = guild.channels.cache
        .filter(c => c.type === ChannelType.GuildText)
        .map(c => `#${c.name}`)
        .slice(0, 40).join(', ');

    const voiceChannels = guild.channels.cache
        .filter(c => c.type === ChannelType.GuildVoice)
        .map(c => c.name)
        .slice(0, 15).join(', ');

    const categories = guild.channels.cache
        .filter(c => c.type === ChannelType.GuildCategory)
        .map(c => c.name)
        .slice(0, 15).join(', ');

    const roles = guild.roles.cache
        .filter(r => r.name !== '@everyone')
        .sort((a, b) => b.position - a.position)
        .map(r => r.name)
        .slice(0, 25).join(', ');

    const recentActions = actionHistory.slice(0, 5).map(h => {
        const ago = Math.round((Date.now() - h.timestamp) / 1000);
        return `${ago}s ago: ${h.action} — ${h.summary}`;
    }).join('\n') || 'None yet';

    return `SERVER STATE:
Text channels: ${textChannels || 'none'}
Voice channels: ${voiceChannels || 'none'}
Categories: ${categories || 'none'}
Roles: ${roles || 'none'}
Members: ${guild.memberCount}
Recent bot actions:\n${recentActions}`;
}

// ─── System Prompt (kept concise, examples go in few-shot pairs) ────────────
const SYSTEM_PROMPT = `You are a Discord server management bot. You receive the server's current state and a user command. You MUST output ONLY a raw JSON object — no markdown, no explanation, no code fences, no extra text.

RULES:
1. NEVER ask for clarification. NEVER refuse. If vague, invent creative details and execute.
2. JSON must have "action" and "params" keys.
3. Use the server state (channels, roles) to reference exact existing names.
4. For bulk operations, use the bulk action variants.

ACTIONS:
create_channels: {names:string[], type:"text"|"voice", categoryId?:string}
delete_channels: {pattern:string}
create_role: {name:string, color?:string, hoist?:boolean, mentionable?:boolean, permissions?:string[]}
delete_role: {name:string}
assign_role: {userId:string, roleName:string}
remove_role: {userId:string, roleName:string}
create_category: {name:string}
move_channel: {channelName:string, categoryName:string}
set_slowmode: {channelName:string, seconds:number}
kick_user: {userId:string, reason?:string}
ban_user: {userId:string, reason?:string}
unban_user: {userId:string}
purge_messages: {channelName:string, count:number}
lock_channel: {channelName:string}
unlock_channel: {channelName:string}
set_channel_topic: {channelName:string, topic:string}
rename_channel: {oldName:string, newName:string}
bulk_rename_channels: {renames:[{oldName:string, newName:string}]}
rename_role: {oldName:string, newName:string}
set_nickname: {userId:string, nickname:string}
create_invite: {channelName:string, maxAge?:number, maxUses?:number}
reply: {message:string}

Output ONLY the JSON object.`;

// ─── Few-shot examples as user/assistant message pairs ──────────────────────
// This is THE most effective way to make LLMs follow your format reliably.
const FEW_SHOT_EXAMPLES = [
    { role: "user", content: "SERVER STATE:\nText channels: #general, #announcements, #bot-commands\nRoles: Admin, Moderator\n\nUSER COMMAND: create 3 text channels called lobby, lounge, and hangout" },
    { role: "assistant", content: '{"action":"create_channels","params":{"names":["lobby","lounge","hangout"],"type":"text"}}' },

    { role: "user", content: "SERVER STATE:\nText channels: #general, #help, #memes, #rules\nRoles: Admin\n\nUSER COMMAND: rename all my channels with cool emojis" },
    { role: "assistant", content: '{"action":"bulk_rename_channels","params":{"renames":[{"oldName":"general","newName":"💬・general"},{"oldName":"help","newName":"❓・help"},{"oldName":"memes","newName":"😂・memes"},{"oldName":"rules","newName":"📜・rules"}]}}' },

    { role: "user", content: "SERVER STATE:\nText channels: #general\n\nUSER COMMAND: make a red admin role with hoist" },
    { role: "assistant", content: '{"action":"create_role","params":{"name":"Admin","color":"#FF0000","hoist":true,"mentionable":false}}' },

    { role: "user", content: "SERVER STATE:\nText channels: #general, #spam\n\nUSER COMMAND: delete all channels with spam in the name" },
    { role: "assistant", content: '{"action":"delete_channels","params":{"pattern":"spam"}}' },

    { role: "user", content: "SERVER STATE:\nText channels: #general\n\nUSER COMMAND: what is 2+2?" },
    { role: "assistant", content: '{"action":"reply","params":{"message":"2 + 2 = 4"}}' },
];

// ─── Model Stack ────────────────────────────────────────────────────────────
const FREE_MODELS = [
    "meta-llama/llama-3.3-70b-instruct:free",
    "moonshotai/kimi-k2.6:free",
    "openai/gpt-oss-120b:free",
    "qwen/qwen3-next-80b-a3b-instruct:free",
    "nousresearch/hermes-3-llama-3.1-405b:free"
];

// ─── Extract JSON from messy model output ───────────────────────────────────
function extractJSON(raw) {
    // Strip thinking tags (Qwen, Kimi, DeepSeek wrap output in <think>...</think>)
    let cleaned = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    // Strip markdown code fences
    cleaned = cleaned.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();

    // Try parsing the full cleaned text first
    try { const p = JSON.parse(cleaned); if (p.action) return p; } catch (_) {}

    // Greedy: outermost { ... }
    const big = cleaned.match(/\{[\s\S]*\}/);
    if (big) {
        try { const p = JSON.parse(big[0]); if (p.action) return p; } catch (_) {}
    }

    // Try each individual JSON-like block
    const blocks = [...cleaned.matchAll(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g)];
    for (const b of blocks.reverse()) {
        try { const p = JSON.parse(b[0]); if (p.action) return p; } catch (_) {}
    }

    return null;
}

// ─── Call OpenRouter with few-shot + retries ────────────────────────────────
async function callOpenRouter(userPrompt, serverContext) {
    const userMessage = `${serverContext}\n\nUSER COMMAND: ${userPrompt}`;

    for (const model of FREE_MODELS) {
        // Try each model up to 2 times (in case of transient JSON issues)
        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                console.log(`[${ts()}] Trying ${model} (attempt ${attempt})`);
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 25000);

                const messages = [
                    { role: "system", content: SYSTEM_PROMPT },
                    ...FEW_SHOT_EXAMPLES,
                    { role: "user", content: userMessage }
                ];

                // On retry, add a stronger nudge
                if (attempt === 2) {
                    messages.push({ role: "assistant", content: '{"action":"' }); // prefill trick
                }

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
                            max_tokens: 600,
                            temperature: 0.05,
                            messages
                        })
                    });
                } finally {
                    clearTimeout(timeout);
                }

                if (response.status === 429) { console.log(`[${ts()}] ${model} rate limited`); break; } // skip to next model
                if (!response.ok) { console.log(`[${ts()}] ${model} HTTP ${response.status}`); break; }

                const data = await response.json();
                let content = data?.choices?.[0]?.message?.content?.trim();
                if (!content) { console.log(`[${ts()}] ${model} empty response`); break; }

                // If we used the prefill trick, prepend what we started
                if (attempt === 2) content = '{"action":"' + content;

                console.log(`[${ts()}] Raw (${model}): ${content.slice(0, 300)}`);

                const parsed = extractJSON(content);
                if (parsed) {
                    console.log(`[${ts()}] ✅ ${model} → ${parsed.action}`);
                    return parsed;
                }

                console.log(`[${ts()}] ${model} attempt ${attempt}: no valid JSON extracted`);

            } catch (err) {
                const msg = err.name === 'AbortError' ? 'timed out (25s)' : err.message;
                console.log(`[${ts()}] ${model} error: ${msg}`);
                break; // skip to next model on timeout
            }
        }
    }
    throw new Error("All AI models failed. Please try again in a moment, or simplify your command.");
}

function ts() { return new Date().toISOString(); }

// ─── Rollback Builders ──────────────────────────────────────────────────────
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
        case 'rename_role':
            return async () => {
                const role = guild.roles.cache.find(r => r.name.toLowerCase() === params.newName.toLowerCase());
                if (role) await role.setName(params.oldName);
                return `Renamed role back to "${params.oldName}"`;
            };
        case 'set_nickname':
            return async () => {
                const member = await guild.members.fetch(params.userId).catch(() => null);
                if (member) await member.setNickname(null);
                return `Reset nickname for <@${params.userId}>`;
            };
        case 'move_channel': {
            const origParent = guild.channels.cache.find(c => c.name.toLowerCase() === params.channelName.toLowerCase())?.parentId || null;
            return async () => {
                const ch = guild.channels.cache.find(c => c.name.toLowerCase() === params.channelName.toLowerCase());
                if (ch) await ch.setParent(origParent);
                return `Moved #${params.channelName} back to its original category`;
            };
        }
        default: return null;
    }
}

// ─── Action Handlers ────────────────────────────────────────────────────────
const handlers = {
    create_channels: async (guild, params) => {
        const type = params.type === 'voice' ? ChannelType.GuildVoice : ChannelType.GuildText;
        const created = [];
        for (const name of params.names) {
            const ch = await guild.channels.create({ name, type, parent: params.categoryId || null });
            created.push(ch.name); await delay(300);
        }
        return `Created ${created.length} ${params.type || 'text'} channel(s): ${created.map(n => `**${n}**`).join(', ')}`;
    },
    delete_channels: async (guild, params) => {
        const regex = new RegExp(params.pattern, 'i');
        const matched = guild.channels.cache.filter(c => regex.test(c.name));
        let count = 0;
        for (const [, ch] of matched) { await ch.delete(); count++; await delay(300); }
        return `Deleted **${count}** channel(s) matching \`${params.pattern}\``;
    },
    create_role: async (guild, params) => {
        const perms = (params.permissions || []).map(p => PermissionsBitField.Flags[p]).filter(Boolean);
        const role = await guild.roles.create({ name: params.name, color: params.color || '#000000', hoist: !!params.hoist, mentionable: !!params.mentionable, permissions: perms, reason: 'AI command' });
        return `Created role **${role.name}** ${params.color ? `(${params.color})` : ''}`;
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
    move_channel: async (guild, params) => {
        const ch = guild.channels.cache.find(c => c.name.toLowerCase() === params.channelName.toLowerCase());
        if (!ch) throw new Error(`Channel "${params.channelName}" not found`);
        const cat = guild.channels.cache.find(c => c.name.toLowerCase() === params.categoryName.toLowerCase() && c.type === ChannelType.GuildCategory);
        if (!cat) throw new Error(`Category "${params.categoryName}" not found`);
        await ch.setParent(cat.id);
        return `Moved **#${ch.name}** into **${cat.name}**`;
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
    unban_user: async (guild, params) => {
        await guild.members.unban(params.userId);
        return `Unbanned <@${params.userId}>`;
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
        return `Set topic for **#${ch.name}**: *${params.topic}*`;
    },
    rename_channel: async (guild, params) => {
        const ch = guild.channels.cache.find(c => c.name.toLowerCase() === params.oldName.toLowerCase());
        if (!ch) throw new Error(`Channel "${params.oldName}" not found`);
        await ch.setName(params.newName);
        return `Renamed **${params.oldName}** → **${params.newName}**`;
    },
    bulk_rename_channels: async (guild, params) => {
        let count = 0, skipped = [];
        for (const r of params.renames) {
            const ch = guild.channels.cache.find(c => c.name.toLowerCase() === r.oldName.toLowerCase());
            if (ch) { await ch.setName(r.newName); count++; await delay(400); }
            else skipped.push(r.oldName);
        }
        let msg = `Renamed **${count}** channel(s)`;
        if (skipped.length) msg += ` (skipped: ${skipped.join(', ')})`;
        return msg;
    },
    rename_role: async (guild, params) => {
        const role = guild.roles.cache.find(r => r.name.toLowerCase() === params.oldName.toLowerCase());
        if (!role) throw new Error(`Role "${params.oldName}" not found`);
        await role.setName(params.newName);
        return `Renamed role **${params.oldName}** → **${params.newName}**`;
    },
    set_nickname: async (guild, params) => {
        const member = await guild.members.fetch(params.userId);
        await member.setNickname(params.nickname);
        return `Set nickname for <@${params.userId}> to **${params.nickname}**`;
    },
    create_invite: async (guild, params) => {
        const ch = guild.channels.cache.find(c => c.name.toLowerCase() === params.channelName.toLowerCase());
        if (!ch) throw new Error(`Channel "${params.channelName}" not found`);
        const invite = await ch.createInvite({ maxAge: params.maxAge || 0, maxUses: params.maxUses || 0, reason: 'AI command' });
        return `Created invite: **${invite.url}** (expires: ${params.maxAge ? `${params.maxAge}s` : 'never'})`;
    },
    reply: async (_guild, params) => params.message,
    unknown: async () => { throw new Error("Couldn't understand that command. Try rephrasing it."); }
};

// ─── Permission Check ───────────────────────────────────────────────────────
function hasPermission(member, authorId) {
    if (authorId === OWNER_ID) return true;
    if (member?.permissions.has(PermissionsBitField.Flags.Administrator)) return true;
    return false;
}

// ─── Reply helper ───────────────────────────────────────────────────────────
async function editReply(ctx, payload) {
    if (ctx.editReply) return ctx.editReply(payload);
    if (ctx.edit) return ctx.edit(payload);
}

// ─── Core Processor ─────────────────────────────────────────────────────────
async function processAICommand(prompt, ctx, guild, channel) {
    try {
        const serverContext = buildServerContext(guild);
        console.log(`[${ts()}] 📝 Command: "${prompt}"`);

        let aiResponse;
        try {
            aiResponse = await callOpenRouter(prompt, serverContext);
        } catch (err) {
            return await editReply(ctx, { content: '', embeds: [new EmbedBuilder().setColor('#e74c3c').setTitle('❌ AI Error').setDescription(err.message)] });
        }

        const { action, params } = aiResponse;
        const handler = handlers[action];
        if (!handler) {
            return await editReply(ctx, { content: '', embeds: [new EmbedBuilder().setColor('#e74c3c').setTitle('❌ Unknown Action').setDescription(`Unsupported: \`${action}\``)] });
        }

        // ── Confirmation for destructive actions ──
        if (DESTRUCTIVE_ACTIONS.has(action)) {
            const confirmEmbed = new EmbedBuilder()
                .setColor('#f39c12')
                .setTitle('⚠️ Confirm Destructive Action')
                .setDescription(`**Action:** \`${action}\`\n**Details:**\n\`\`\`json\n${JSON.stringify(params, null, 2)}\`\`\``)
                .setFooter({ text: 'Expires in 30 seconds' });

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('confirm_action').setLabel('✅ Confirm').setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId('cancel_action').setLabel('❌ Cancel').setStyle(ButtonStyle.Secondary)
            );

            await editReply(ctx, { content: '', embeds: [confirmEmbed], components: [row] });
            const sentMsg = ctx.editReply ? await ctx.fetchReply() : ctx;

            try {
                const btn = await sentMsg.awaitMessageComponent({
                    filter: i => i.user.id === (ctx.user?.id || OWNER_ID),
                    componentType: ComponentType.Button,
                    time: 30000
                });
                if (btn.customId === 'cancel_action') {
                    return await btn.update({ embeds: [new EmbedBuilder().setColor('#95a5a6').setTitle('🚫 Cancelled')], components: [] });
                }
                await btn.update({ content: `${LOADING_EMOJI} Executing **${action}**...`, embeds: [], components: [] });
            } catch {
                return await editReply(ctx, { embeds: [new EmbedBuilder().setColor('#95a5a6').setTitle('⏰ Timed Out').setDescription('Confirmation expired.')], components: [] });
            }
        } else {
            await editReply(ctx, { content: `${LOADING_EMOJI} Executing **${action}**...` });
        }

        // ── Execute ──
        try {
            const rollbackFn = buildRollbackFn(action, params, guild);
            const resultText = await handler(guild, params);

            addToHistory({ action, params, summary: resultText, timestamp: Date.now(), rollbackFn, canRollback: !!rollbackFn });

            const successEmbed = new EmbedBuilder()
                .setColor('#2ecc71')
                .setTitle('✅ Done')
                .setDescription(resultText)
                .setFooter({ text: rollbackFn ? '↩️ Use "sudo rollback" to undo' : '⛔ Cannot be undone' })
                .setTimestamp();

            await editReply(ctx, { content: '', embeds: [successEmbed], components: [] });
            console.log(`[${ts()}] ✅ ${action}: ${resultText}`);
        } catch (err) {
            console.error(`[${ts()}] ❌ Execution error:`, err);
            await editReply(ctx, { content: '', embeds: [new EmbedBuilder().setColor('#e74c3c').setTitle('❌ Execution Error').setDescription(err.message)], components: [] }).catch(console.error);
        }

    } catch (err) {
        console.error(`[${ts()}] Critical error:`, err);
    }
}

// ─── Bot Ready ──────────────────────────────────────────────────────────────
client.on('ready', async () => {
    console.log(`[${ts()}] ✅ Logged in as ${client.user.tag}`);

    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    const commands = [
        new SlashCommandBuilder()
            .setName('mod_ai_agent')
            .setDescription('Run an AI moderator command')
            .addStringOption(opt => opt.setName('prompt').setDescription('Your command').setRequired(true))
    ].map(c => c.toJSON());

    try {
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log(`[${ts()}] ✅ Slash commands registered`);
    } catch (err) { console.error('Slash command registration failed:', err); }
});

// ─── Slash Commands ─────────────────────────────────────────────────────────
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== 'mod_ai_agent') return;
    if (!hasPermission(interaction.member, interaction.user.id))
        return interaction.reply({ content: '🚫 No permission.', ephemeral: true });

    const prompt = interaction.options.getString('prompt');
    await interaction.reply(`${LOADING_EMOJI} Processing: *"${prompt}"*`);
    await processAICommand(prompt, interaction, interaction.guild, interaction.channel);
});

// ─── Message Handler ────────────────────────────────────────────────────────
client.on('messageCreate', async message => {
    if (message.author.bot) return;
    if (COMMAND_CHANNEL_ID && message.channel.id !== COMMAND_CHANNEL_ID) return;
    if (!hasPermission(message.member, message.author.id)) return;

    const content = message.content.trim();

    // ── sudo rollback ──
    if (/^sudo\s+rollback$/i.test(content)) {
        const last = actionHistory.find(h => h.canRollback);
        if (!last) return message.reply({ embeds: [new EmbedBuilder().setColor('#e74c3c').setTitle('❌ Nothing to Rollback').setDescription('No reversible actions in history.')] });

        const msg = await message.reply(`${LOADING_EMOJI} Rolling back **${last.action}**...`);
        try {
            const result = await last.rollbackFn();
            last.canRollback = false;
            addToHistory({ action: 'rollback', params: {}, summary: result, timestamp: Date.now(), rollbackFn: null, canRollback: false });
            msg.edit({ content: '', embeds: [new EmbedBuilder().setColor('#3498db').setTitle('↩️ Rolled Back').setDescription(result).setTimestamp()] });
        } catch (err) {
            msg.edit({ content: '', embeds: [new EmbedBuilder().setColor('#e74c3c').setTitle('❌ Rollback Failed').setDescription(err.message)] });
        }
        return;
    }

    // ── sudo history ──
    if (/^sudo\s+history$/i.test(content)) {
        if (!actionHistory.length) return message.reply({ embeds: [new EmbedBuilder().setColor('#95a5a6').setTitle('📜 History').setDescription('No actions yet.')] });

        const lines = actionHistory.slice(0, 15).map((h, i) => {
            const ago = Math.round((Date.now() - h.timestamp) / 1000);
            const icon = h.canRollback ? '↩️' : '✅';
            return `${icon} **${ago}s ago** — \`${h.action}\` — ${h.summary.slice(0, 80)}`;
        }).join('\n');
        return message.reply({ embeds: [new EmbedBuilder().setColor('#3498db').setTitle('📜 Action History').setDescription(lines).setTimestamp()] });
    }

    // ── sudo help ──
    if (/^sudo\s+help$/i.test(content)) {
        return message.reply({ embeds: [new EmbedBuilder()
            .setColor('#3498db')
            .setTitle('🤖 AI Moderator Bot')
            .setDescription('Use **`sudo <command>`** with natural language. The AI understands what you mean!')
            .addFields(
                { name: '📁 Channels', value: '`sudo create 5 text channels called dev-1 to dev-5`\n`sudo delete channels matching "test"`\n`sudo rename all channels with cool emojis`\n`sudo move general into the Main category`\n`sudo lock announcements`\n`sudo set slowmode in general to 10s`', inline: false },
                { name: '🎭 Roles', value: '`sudo create a red Admin role with hoist`\n`sudo delete the Muted role`\n`sudo rename Admin to Administrator`\n`sudo assign Admin to user 123456789`', inline: false },
                { name: '🛡️ Moderation', value: '`sudo kick user 123456789 for spam`\n`sudo ban user 123456789`\n`sudo purge 50 messages in general`\n`sudo set nickname for user 123 to CoolGuy`', inline: false },
                { name: '🧠 AI & General', value: '`sudo what is the capital of Japan?`\n`sudo explain quantum computing`', inline: false },
                { name: '⚙️ Bot Commands', value: '`sudo history` — View recent actions\n`sudo rollback` — Undo last action\n`sudo help` — This menu', inline: false }
            )
            .setFooter({ text: 'Destructive actions require confirmation • Use /mod_ai_agent for slash commands' })] });
    }

    // ── sudo <prompt> ──
    if (/^sudo\s+/i.test(content)) {
        const prompt = content.slice(5).trim();
        if (!prompt) return message.reply('Provide a command after `sudo`.');
        const processingMsg = await message.reply(`${LOADING_EMOJI} Processing: *"${prompt}"*`);
        await processAICommand(prompt, processingMsg, message.guild, message.channel);
    }
});

client.login(process.env.DISCORD_TOKEN);
