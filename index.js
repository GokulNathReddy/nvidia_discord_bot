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

// ─── Utilities ──────────────────────────────────────────────────────────────
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const ts = () => new Date().toISOString();

// Rate-limit-aware delay: starts at baseMs, doubles on each retry (capped at 5s)
async function rateLimitDelay(attempt = 0, baseMs = 500) {
    const wait = Math.min(baseMs * Math.pow(2, attempt), 5000);
    await delay(wait);
}

// ─── Configuration ──────────────────────────────────────────────────────────
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OWNER_ID = process.env.OWNER_ID;
const COMMAND_CHANNEL_ID = process.env.COMMAND_CHANNEL_ID;
const LOADING_EMOJI = "<a:loading:1511398333665509466>";

if (!OPENROUTER_API_KEY || !process.env.DISCORD_TOKEN || !OWNER_ID) {
    console.error('[FATAL] Missing required environment variables. Check .env file.');
    process.exit(1);
}

// ─── Discord Client ─────────────────────────────────────────────────────────
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});

// ─── Action History ─────────────────────────────────────────────────────────
const actionHistory = [];
const MAX_HISTORY = 50;

function addToHistory(entry) {
    actionHistory.unshift(entry);
    if (actionHistory.length > MAX_HISTORY) actionHistory.pop();
}

// ─── Destructive actions needing confirmation ───────────────────────────────
const DESTRUCTIVE_ACTIONS = new Set([
    'delete_channels', 'kick_user', 'ban_user', 'purge_messages', 'delete_role'
]);

// ─── Build live server context ──────────────────────────────────────────────
function buildServerContext(guild) {
    const textChannels = guild.channels.cache
        .filter(c => c.type === ChannelType.GuildText)
        .map(c => `#${c.name} (id:${c.id})`)
        .slice(0, 50).join(', ');

    const voiceChannels = guild.channels.cache
        .filter(c => c.type === ChannelType.GuildVoice)
        .map(c => `${c.name} (id:${c.id})`)
        .slice(0, 20).join(', ');

    const categories = guild.channels.cache
        .filter(c => c.type === ChannelType.GuildCategory)
        .map(c => `${c.name} (id:${c.id})`)
        .slice(0, 20).join(', ');

    const roles = guild.roles.cache
        .filter(r => r.name !== '@everyone')
        .sort((a, b) => b.position - a.position)
        .map(r => `${r.name} (id:${r.id})`)
        .slice(0, 30).join(', ');

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

// ─── System Prompt ──────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a Discord server management bot. You receive the server's current state and a user command.
You MUST output ONLY a raw JSON object — no markdown, no explanation, no code fences, no extra text before or after.

CRITICAL RULES:
1. NEVER ask for clarification. NEVER refuse. If the command is vague, use creative defaults and execute.
2. Your output MUST be a single JSON object with "action" and "params" keys.
3. When a command involves MULTIPLE tasks, you MUST use the "sequence" action with a steps array. Never silently drop tasks — execute ALL of them.
4. For ORDER-DEPENDENT tasks (e.g., create category THEN put channels in it): use "sequence" — runs one by one.
5. For INDEPENDENT tasks (e.g., create 3 roles with no dependency): use "parallel" — all run simultaneously, much faster.
6. Use exact channel/role names from the SERVER STATE when referencing existing channels or roles.
7. Channel and role names in the server state include their IDs in parentheses — use the NAME (not the ID) in your params unless a param specifically asks for an ID.
8. For general knowledge questions, fun questions, or anything not related to server management, use the "reply" action with a helpful answer.

AVAILABLE ACTIONS:
create_channels:       {names:string[], type:"text"|"voice", categoryId?:string}
delete_channels:       {pattern:string}
create_role:           {name:string, color?:string, hoist?:boolean, mentionable?:boolean, permissions?:string[]}
delete_role:           {name:string}
assign_role:           {userId:string, roleName:string}
remove_role:           {userId:string, roleName:string}
create_category:       {name:string}
move_channel:          {channelName:string, categoryName:string}
set_slowmode:          {channelName:string, seconds:number}
kick_user:             {userId:string, reason?:string}
ban_user:              {userId:string, reason?:string}
unban_user:            {userId:string}
purge_messages:        {channelName:string, count:number}
lock_channel:          {channelName:string}
unlock_channel:        {channelName:string}
set_channel_topic:     {channelName:string, topic:string}
rename_channel:        {oldName:string, newName:string}
bulk_rename_channels:  {renames:[{oldName:string, newName:string}]}
rename_role:           {oldName:string, newName:string}
set_nickname:          {userId:string, nickname:string}
create_invite:         {channelName:string, maxAge?:number, maxUses?:number}
reply:                 {message:string}
sequence:              {steps:[{action:string, params:object}]}
parallel:              {steps:[{action:string, params:object}]}

Output ONLY the JSON object. No other text.`;

// ─── Few-shot examples ──────────────────────────────────────────────────────
const FEW_SHOT_EXAMPLES = [
    {
        role: "user",
        content: "SERVER STATE:\nText channels: #general (id:111), #announcements (id:222)\nRoles: Admin (id:333)\n\nUSER COMMAND: create 3 text channels called lobby lounge hangout"
    },
    {
        role: "assistant",
        content: '{"action":"create_channels","params":{"names":["lobby","lounge","hangout"],"type":"text"}}'
    },
    {
        role: "user",
        content: "SERVER STATE:\nText channels: #general (id:111), #memes (id:222), #rules (id:333)\nRoles: Admin (id:444)\n\nUSER COMMAND: rename all channels with cool emojis AND create a red Admin role with hoist"
    },
    {
        role: "assistant",
        content: '{"action":"sequence","params":{"steps":[{"action":"bulk_rename_channels","params":{"renames":[{"oldName":"general","newName":"💬・general"},{"oldName":"memes","newName":"😂・memes"},{"oldName":"rules","newName":"📜・rules"}]}},{"action":"create_role","params":{"name":"Admin","color":"#FF0000","hoist":true,"mentionable":false}}]}}'
    },
    {
        role: "user",
        content: "SERVER STATE:\nText channels: #general (id:111)\n\nUSER COMMAND: create a Gaming category, then create voice channels lobby and squad-1 inside it, and also create a Gamer role in green"
    },
    {
        role: "assistant",
        content: '{"action":"sequence","params":{"steps":[{"action":"create_category","params":{"name":"Gaming"}},{"action":"create_channels","params":{"names":["lobby","squad-1"],"type":"voice"}},{"action":"create_role","params":{"name":"Gamer","color":"#00FF00","hoist":false,"mentionable":true}}]}}'
    },
    {
        role: "user",
        content: "SERVER STATE:\nText channels: #general (id:111)\n\nUSER COMMAND: create roles for Admin, Moderator, Member all at once — red, blue, green"
    },
    {
        role: "assistant",
        content: '{"action":"parallel","params":{"steps":[{"action":"create_role","params":{"name":"Admin","color":"#FF0000","hoist":true}},{"action":"create_role","params":{"name":"Moderator","color":"#0000FF","hoist":true}},{"action":"create_role","params":{"name":"Member","color":"#00FF00","hoist":false}}]}}'
    },
    {
        role: "user",
        content: "SERVER STATE:\nText channels: #general (id:111)\n\nUSER COMMAND: make a Gaming category and put a lobby voice channel inside it"
    },
    {
        role: "assistant",
        content: '{"action":"sequence","params":{"steps":[{"action":"create_category","params":{"name":"Gaming"}},{"action":"create_channels","params":{"names":["lobby"],"type":"voice"}}]}}'
    },
    {
        role: "user",
        content: "SERVER STATE:\nText channels: #general (id:111)\n\nUSER COMMAND: what is 2+2?"
    },
    {
        role: "assistant",
        content: '{"action":"reply","params":{"message":"2 + 2 = 4 🧮"}}'
    },
    {
        role: "user",
        content: "SERVER STATE:\nText channels: #general (id:111), #spam-1 (id:222), #spam-2 (id:333)\nRoles: Admin (id:444)\n\nUSER COMMAND: delete all spam channels and lock general"
    },
    {
        role: "assistant",
        content: '{"action":"sequence","params":{"steps":[{"action":"delete_channels","params":{"pattern":"spam"}},{"action":"lock_channel","params":{"channelName":"general"}}]}}'
    }
];

// ─── Model Stack (ordered by quality & reliability) ─────────────────────────
// Primary: Gemini 2.5 Flash — best balance of speed, cost, and JSON discipline
// Fallback: Gemini 2.0 Flash — still excellent, very fast
// Safety net: Llama 3.3 70B (free) — good free option
// Last resort: Qwen3 (free) — decent fallback
const MODELS = [
    "google/gemini-2.5-flash",
    "google/gemini-2.0-flash-001",
    "meta-llama/llama-3.3-70b-instruct:free",
    "qwen/qwen3-30b-a3b:free"
];

// ─── Extract JSON from messy model output ───────────────────────────────────
function extractJSON(raw) {
    // Strip thinking tags (Qwen, DeepSeek, Kimi wrap output in <think>...</think>)
    let cleaned = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    // Strip markdown code fences
    cleaned = cleaned.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();

    // Try parsing the full cleaned text first
    try {
        const p = JSON.parse(cleaned);
        if (p && p.action) return p;
    } catch (_) { /* continue */ }

    // Greedy: outermost { ... }
    const big = cleaned.match(/\{[\s\S]*\}/);
    if (big) {
        try {
            const p = JSON.parse(big[0]);
            if (p && p.action) return p;
        } catch (_) { /* continue */ }
    }

    // Try each individual JSON-like block (deepest first)
    const blocks = [...cleaned.matchAll(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g)];
    for (const b of blocks.reverse()) {
        try {
            const p = JSON.parse(b[0]);
            if (p && p.action) return p;
        } catch (_) { /* continue */ }
    }

    return null;
}

// ─── Sanitize regex pattern ─────────────────────────────────────────────────
function safeRegex(pattern) {
    try {
        new RegExp(pattern, 'i');
        return pattern;
    } catch {
        // Escape special regex characters if the pattern is invalid
        return pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
}

// ─── Call OpenRouter with model fallback + retries ──────────────────────────
async function callOpenRouter(userPrompt, serverContext) {
    const userMessage = `${serverContext}\n\nUSER COMMAND: ${userPrompt}`;

    for (const model of MODELS) {
        // Try each model up to 2 times (in case of transient JSON issues)
        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                console.log(`[${ts()}] Trying ${model} (attempt ${attempt})`);
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 60000); // 60s timeout

                const messages = [
                    { role: "system", content: SYSTEM_PROMPT },
                    ...FEW_SHOT_EXAMPLES,
                    { role: "user", content: userMessage }
                ];

                // On retry, add a prefill nudge to force JSON output
                if (attempt === 2) {
                    messages.push({ role: "assistant", content: '{"action":"' });
                }

                let response;
                try {
                    response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
                        method: "POST",
                        signal: controller.signal,
                        headers: {
                            "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
                            "Content-Type": "application/json",
                            "HTTP-Referer": "https://github.com/GokulNathReddy/nvidia_discord_bot",
                            "X-Title": "NVIDIA Discord Bot"
                        },
                        body: JSON.stringify({
                            model,
                            max_tokens: 1500,
                            temperature: 0.05,
                            messages
                        })
                    });
                } finally {
                    clearTimeout(timeout);
                }

                if (response.status === 429) {
                    console.log(`[${ts()}] ${model} rate-limited, trying next model`);
                    break; // skip to next model
                }
                if (!response.ok) {
                    console.log(`[${ts()}] ${model} HTTP ${response.status}`);
                    break;
                }

                const data = await response.json();
                let content = data?.choices?.[0]?.message?.content?.trim();
                if (!content) {
                    console.log(`[${ts()}] ${model} empty response`);
                    break;
                }

                // If we used the prefill trick, prepend what we started
                if (attempt === 2) content = '{"action":"' + content;

                console.log(`[${ts()}] Raw (${model}): ${content.slice(0, 400)}`);

                const parsed = extractJSON(content);
                if (parsed) {
                    console.log(`[${ts()}] ✅ ${model} → ${parsed.action}`);
                    return parsed;
                }

                console.log(`[${ts()}] ${model} attempt ${attempt}: no valid JSON extracted`);

            } catch (err) {
                const msg = err.name === 'AbortError' ? 'timed out (60s)' : err.message;
                console.log(`[${ts()}] ${model} error: ${msg}`);
                break; // skip to next model on error
            }
        }
    }
    throw new Error("All AI models failed. Please try again in a moment, or simplify your command.");
}

// ─── Rollback Builders ──────────────────────────────────────────────────────
function buildRollbackFn(action, params, guild) {
    switch (action) {
        case 'create_channels':
            return async () => {
                for (const name of params.names) {
                    const ch = guild.channels.cache.find(c => c.name === name);
                    if (ch) { await ch.delete(); await rateLimitDelay(); }
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
                    if (ch) { await ch.setName(r.oldName); await rateLimitDelay(); }
                }
                return `Reverted ${params.renames.length} channel rename(s)`;
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
        if (!params.names || !Array.isArray(params.names) || params.names.length === 0) {
            throw new Error("No channel names provided.");
        }
        const type = params.type === 'voice' ? ChannelType.GuildVoice : ChannelType.GuildText;
        const created = [];

        // Resolve categoryId by name if it looks like a name rather than a snowflake
        let parentId = params.categoryId || null;
        if (parentId && !/^\d{17,20}$/.test(parentId)) {
            const cat = guild.channels.cache.find(
                c => c.name.toLowerCase() === parentId.toLowerCase() && c.type === ChannelType.GuildCategory
            );
            parentId = cat ? cat.id : null;
        }

        // If we're in a sequence and a category was just created, try to find it
        if (!parentId && params._sequenceCategoryHint) {
            const cat = guild.channels.cache.find(
                c => c.name.toLowerCase() === params._sequenceCategoryHint.toLowerCase() && c.type === ChannelType.GuildCategory
            );
            parentId = cat ? cat.id : null;
        }

        for (let i = 0; i < params.names.length; i++) {
            const name = String(params.names[i]).slice(0, 100); // Discord max channel name length
            const ch = await guild.channels.create({ name, type, parent: parentId });
            created.push(ch.name);
            if (i < params.names.length - 1) await rateLimitDelay();
        }
        return `Created ${created.length} ${params.type || 'text'} channel(s): ${created.map(n => `**${n}**`).join(', ')}`;
    },

    delete_channels: async (guild, params) => {
        if (!params.pattern) throw new Error("No pattern provided for channel deletion.");
        const pattern = safeRegex(params.pattern);
        const regex = new RegExp(pattern, 'i');
        const matched = guild.channels.cache.filter(c => regex.test(c.name));
        if (matched.size === 0) throw new Error(`No channels matched pattern \`${params.pattern}\``);
        let count = 0;
        for (const [, ch] of matched) {
            await ch.delete();
            count++;
            await rateLimitDelay();
        }
        return `Deleted **${count}** channel(s) matching \`${params.pattern}\``;
    },

    create_role: async (guild, params) => {
        if (!params.name) throw new Error("No role name provided.");
        const perms = (params.permissions || []).map(p => PermissionsBitField.Flags[p]).filter(Boolean);
        const role = await guild.roles.create({
            name: String(params.name).slice(0, 100),
            color: params.color || '#000000',
            hoist: !!params.hoist,
            mentionable: !!params.mentionable,
            permissions: perms,
            reason: 'AI command'
        });
        return `Created role **${role.name}**${params.color ? ` (${params.color})` : ''}`;
    },

    delete_role: async (guild, params) => {
        if (!params.name) throw new Error("No role name provided.");
        const role = guild.roles.cache.find(r => r.name.toLowerCase() === params.name.toLowerCase());
        if (!role) throw new Error(`Role "${params.name}" not found`);
        await role.delete('AI command');
        return `Deleted role **${params.name}**`;
    },

    assign_role: async (guild, params) => {
        if (!params.roleName || !params.userId) throw new Error("Missing role name or user ID.");
        const role = guild.roles.cache.find(r => r.name.toLowerCase() === params.roleName.toLowerCase());
        if (!role) throw new Error(`Role "${params.roleName}" not found`);
        const member = await guild.members.fetch(params.userId);
        await member.roles.add(role);
        return `Assigned **${role.name}** to <@${params.userId}>`;
    },

    remove_role: async (guild, params) => {
        if (!params.roleName || !params.userId) throw new Error("Missing role name or user ID.");
        const role = guild.roles.cache.find(r => r.name.toLowerCase() === params.roleName.toLowerCase());
        if (!role) throw new Error(`Role "${params.roleName}" not found`);
        const member = await guild.members.fetch(params.userId);
        await member.roles.remove(role);
        return `Removed **${role.name}** from <@${params.userId}>`;
    },

    create_category: async (guild, params) => {
        if (!params.name) throw new Error("No category name provided.");
        const cat = await guild.channels.create({
            name: String(params.name).slice(0, 100),
            type: ChannelType.GuildCategory
        });
        return `Created category **${cat.name}**`;
    },

    move_channel: async (guild, params) => {
        if (!params.channelName || !params.categoryName) throw new Error("Missing channel or category name.");
        const ch = guild.channels.cache.find(c => c.name.toLowerCase() === params.channelName.toLowerCase());
        if (!ch) throw new Error(`Channel "${params.channelName}" not found`);
        const cat = guild.channels.cache.find(
            c => c.name.toLowerCase() === params.categoryName.toLowerCase() && c.type === ChannelType.GuildCategory
        );
        if (!cat) throw new Error(`Category "${params.categoryName}" not found`);
        await ch.setParent(cat.id);
        return `Moved **#${ch.name}** into **${cat.name}**`;
    },

    set_slowmode: async (guild, params) => {
        if (!params.channelName) throw new Error("No channel name provided.");
        const ch = guild.channels.cache.find(
            c => c.name.toLowerCase() === params.channelName.toLowerCase() && c.type === ChannelType.GuildText
        );
        if (!ch) throw new Error(`Text channel "${params.channelName}" not found`);
        await ch.setRateLimitPerUser(params.seconds || 0);
        return `Set slowmode in **#${ch.name}** to **${params.seconds || 0}s**`;
    },

    kick_user: async (guild, params) => {
        if (!params.userId) throw new Error("No user ID provided.");
        const member = await guild.members.fetch(params.userId);
        await member.kick(params.reason || 'AI command');
        return `Kicked <@${params.userId}> — Reason: ${params.reason || 'None'}`;
    },

    ban_user: async (guild, params) => {
        if (!params.userId) throw new Error("No user ID provided.");
        await guild.members.ban(params.userId, { reason: params.reason || 'AI command' });
        return `Banned <@${params.userId}> — Reason: ${params.reason || 'None'}`;
    },

    unban_user: async (guild, params) => {
        if (!params.userId) throw new Error("No user ID provided.");
        await guild.members.unban(params.userId);
        return `Unbanned <@${params.userId}>`;
    },

    purge_messages: async (guild, params) => {
        if (!params.channelName) throw new Error("No channel name provided.");
        const ch = guild.channels.cache.find(
            c => c.name.toLowerCase() === params.channelName.toLowerCase() && c.type === ChannelType.GuildText
        );
        if (!ch) throw new Error(`Text channel "${params.channelName}" not found`);
        const count = Math.min(Math.max(params.count || 1, 1), 100);
        const deleted = await ch.bulkDelete(count, true);
        return `Purged **${deleted.size}** messages in **#${ch.name}**`;
    },

    lock_channel: async (guild, params) => {
        if (!params.channelName) throw new Error("No channel name provided.");
        const ch = guild.channels.cache.find(
            c => c.name.toLowerCase() === params.channelName.toLowerCase() && c.type === ChannelType.GuildText
        );
        if (!ch) throw new Error(`Text channel "${params.channelName}" not found`);
        await ch.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false });
        return `🔒 Locked **#${ch.name}**`;
    },

    unlock_channel: async (guild, params) => {
        if (!params.channelName) throw new Error("No channel name provided.");
        const ch = guild.channels.cache.find(
            c => c.name.toLowerCase() === params.channelName.toLowerCase() && c.type === ChannelType.GuildText
        );
        if (!ch) throw new Error(`Text channel "${params.channelName}" not found`);
        await ch.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: null });
        return `🔓 Unlocked **#${ch.name}**`;
    },

    set_channel_topic: async (guild, params) => {
        if (!params.channelName || params.topic === undefined) throw new Error("Missing channel name or topic.");
        const ch = guild.channels.cache.find(
            c => c.name.toLowerCase() === params.channelName.toLowerCase() && c.type === ChannelType.GuildText
        );
        if (!ch) throw new Error(`Text channel "${params.channelName}" not found`);
        await ch.setTopic(params.topic);
        return `Set topic for **#${ch.name}**: *${params.topic}*`;
    },

    rename_channel: async (guild, params) => {
        if (!params.oldName || !params.newName) throw new Error("Missing old or new channel name.");
        const ch = guild.channels.cache.find(c => c.name.toLowerCase() === params.oldName.toLowerCase());
        if (!ch) throw new Error(`Channel "${params.oldName}" not found`);
        await ch.setName(String(params.newName).slice(0, 100));
        return `Renamed **${params.oldName}** → **${params.newName}**`;
    },

    bulk_rename_channels: async (guild, params) => {
        if (!params.renames || !Array.isArray(params.renames)) throw new Error("No renames provided.");
        let count = 0;
        const skipped = [];
        for (const r of params.renames) {
            const ch = guild.channels.cache.find(c => c.name.toLowerCase() === r.oldName.toLowerCase());
            if (ch) {
                await ch.setName(String(r.newName).slice(0, 100));
                count++;
                await rateLimitDelay();
            } else {
                skipped.push(r.oldName);
            }
        }
        let msg = `Renamed **${count}** channel(s)`;
        if (skipped.length) msg += ` (skipped: ${skipped.join(', ')})`;
        return msg;
    },

    rename_role: async (guild, params) => {
        if (!params.oldName || !params.newName) throw new Error("Missing old or new role name.");
        const role = guild.roles.cache.find(r => r.name.toLowerCase() === params.oldName.toLowerCase());
        if (!role) throw new Error(`Role "${params.oldName}" not found`);
        await role.setName(String(params.newName).slice(0, 100));
        return `Renamed role **${params.oldName}** → **${params.newName}**`;
    },

    set_nickname: async (guild, params) => {
        if (!params.userId || !params.nickname) throw new Error("Missing user ID or nickname.");
        const member = await guild.members.fetch(params.userId);
        await member.setNickname(String(params.nickname).slice(0, 32));
        return `Set nickname for <@${params.userId}> to **${params.nickname}**`;
    },

    create_invite: async (guild, params) => {
        if (!params.channelName) throw new Error("No channel name provided.");
        const ch = guild.channels.cache.find(c => c.name.toLowerCase() === params.channelName.toLowerCase());
        if (!ch) throw new Error(`Channel "${params.channelName}" not found`);
        const invite = await ch.createInvite({
            maxAge: params.maxAge || 0,
            maxUses: params.maxUses || 0,
            reason: 'AI command'
        });
        return `Created invite: **${invite.url}** (expires: ${params.maxAge ? `${params.maxAge}s` : 'never'})`;
    },

    reply: async (_guild, params) => {
        return params.message || "I'm not sure what to say!";
    },

    // ── Sequence: run multiple actions in order ─────────────────────────────
    sequence: async (guild, params, _ctx, editFn) => {
        const steps = params.steps || [];
        if (!steps.length) throw new Error("Sequence has no steps.");

        const results = [];
        const rollbackFns = [];
        let lastCategoryName = null; // Track last created category for auto-parenting

        for (let i = 0; i < steps.length; i++) {
            const { action, params: sp } = steps[i];
            const handler = handlers[action];

            if (!handler) {
                results.push(`⚠️ **Step ${i + 1}:** Unknown action \`${action}\` — skipped`);
                continue;
            }

            // Auto-wire: if previous step created a category, hint it to create_channels
            if (action === 'create_channels' && lastCategoryName && !sp.categoryId) {
                // Re-fetch channels to get the newly created category
                await guild.channels.fetch().catch(() => {});
                const cat = guild.channels.cache.find(
                    c => c.name.toLowerCase() === lastCategoryName.toLowerCase() && c.type === ChannelType.GuildCategory
                );
                if (cat) sp.categoryId = cat.id;
            }

            // Live progress update
            if (editFn) {
                const progressLines = steps.map((s, idx) => {
                    if (idx < i) return `✅ Step ${idx + 1}: \`${s.action}\` — done`;
                    if (idx === i) return `${LOADING_EMOJI} Step ${idx + 1}: \`${s.action}\` — running...`;
                    return `⏳ Step ${idx + 1}: \`${s.action}\``;
                }).join('\n');
                await editFn({ content: `**Running ${steps.length} steps...**\n\n${progressLines}`, embeds: [], components: [] }).catch(() => {});
            }

            try {
                const result = await handler(guild, sp);
                results.push(`✅ **Step ${i + 1} — \`${action}\`:** ${result}`);

                // Track category creation for auto-wiring
                if (action === 'create_category' && sp.name) {
                    lastCategoryName = sp.name;
                    // Refresh channel cache so subsequent steps see the new category
                    await guild.channels.fetch().catch(() => {});
                }

                const rbFn = buildRollbackFn(action, sp, guild);
                if (rbFn) rollbackFns.push({ action, params: sp, summary: result, rollbackFn: rbFn });
            } catch (err) {
                results.push(`❌ **Step ${i + 1} — \`${action}\`:** ${err.message}`);
            }

            // Rate limit delay between steps
            if (i < steps.length - 1) await rateLimitDelay();
        }

        // Store each step in history
        for (const rb of rollbackFns) {
            addToHistory({ ...rb, timestamp: Date.now(), canRollback: true });
        }

        return results.join('\n');
    },

    // ── Parallel: run independent actions simultaneously ────────────────────
    parallel: async (guild, params, _ctx, editFn) => {
        const steps = params.steps || [];
        if (!steps.length) throw new Error("Parallel has no steps.");

        if (editFn) {
            const lines = steps.map((s, i) => `${LOADING_EMOJI} Task ${i + 1}: \`${s.action}\` — running...`).join('\n');
            await editFn({ content: `**Running ${steps.length} tasks in parallel...**\n\n${lines}`, embeds: [], components: [] }).catch(() => {});
        }

        const results = await Promise.allSettled(
            steps.map(({ action, params: sp }) => {
                const handler = handlers[action];
                if (!handler) return Promise.resolve(`⚠️ Unknown action \`${action}\` — skipped`);
                return handler(guild, sp);
            })
        );

        const lines = results.map((r, i) => {
            const { action } = steps[i];
            if (r.status === 'fulfilled') return `✅ **Task ${i + 1} — \`${action}\`:** ${r.value}`;
            return `❌ **Task ${i + 1} — \`${action}\`:** ${r.reason?.message || r.reason}`;
        });

        // Store rollbackable ones in history
        for (let i = 0; i < steps.length; i++) {
            if (results[i].status === 'fulfilled') {
                const rbFn = buildRollbackFn(steps[i].action, steps[i].params, guild);
                if (rbFn) {
                    addToHistory({
                        action: steps[i].action,
                        params: steps[i].params,
                        summary: results[i].value,
                        timestamp: Date.now(),
                        rollbackFn: rbFn,
                        canRollback: true
                    });
                }
            }
        }

        return lines.join('\n');
    }
};

// ─── Permission Check ───────────────────────────────────────────────────────
function hasPermission(member, authorId) {
    if (authorId === OWNER_ID) return true;
    if (member?.permissions.has(PermissionsBitField.Flags.Administrator)) return true;
    return false;
}

// ─── Reply helper ───────────────────────────────────────────────────────────
async function editReply(ctx, payload) {
    try {
        if (ctx.editReply) return await ctx.editReply(payload);
        if (ctx.edit) return await ctx.edit(payload);
    } catch (err) {
        console.error(`[${ts()}] Failed to edit reply:`, err.message);
    }
}

// ─── Confirmation flow for destructive actions ──────────────────────────────
async function confirmDestructiveAction(ctx, action, params, steps) {
    const isMultiStep = !!steps;
    const destructiveList = isMultiStep
        ? steps.filter(s => DESTRUCTIVE_ACTIONS.has(s.action)).map(s => `\`${s.action}\``).join(', ')
        : `\`${action}\``;

    const description = isMultiStep
        ? `**${steps.length} steps to run** (includes destructive: ${destructiveList})\n\n` +
          steps.map((s, i) => `**${i + 1}.** \`${s.action}\``).join('\n')
        : `**Action:** \`${action}\`\n\`\`\`json\n${JSON.stringify(params, null, 2)}\`\`\``;

    const confirmEmbed = new EmbedBuilder()
        .setColor('#f39c12')
        .setTitle(isMultiStep ? '⚠️ Confirm Multi-Step Action' : '⚠️ Confirm Destructive Action')
        .setDescription(description)
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
            await btn.update({ embeds: [new EmbedBuilder().setColor('#95a5a6').setTitle('🚫 Cancelled')], components: [] });
            return false;
        }
        await btn.update({
            content: `${LOADING_EMOJI} Executing${isMultiStep ? ` ${steps.length} steps` : ` **${action}**`}...`,
            embeds: [],
            components: []
        });
        return true;
    } catch {
        await editReply(ctx, {
            embeds: [new EmbedBuilder().setColor('#95a5a6').setTitle('⏰ Timed Out').setDescription('Confirmation expired.')],
            components: []
        });
        return false;
    }
}

// ─── Core Processor ─────────────────────────────────────────────────────────
async function processAICommand(prompt, ctx, guild) {
    try {
        const serverContext = buildServerContext(guild);
        console.log(`[${ts()}] 📝 Command: "${prompt}"`);

        let aiResponse;
        try {
            aiResponse = await callOpenRouter(prompt, serverContext);
        } catch (err) {
            return await editReply(ctx, {
                content: '',
                embeds: [new EmbedBuilder().setColor('#e74c3c').setTitle('❌ AI Error').setDescription(err.message)]
            });
        }

        const { action, params } = aiResponse;

        // ── Sequence (multi-step ordered) ──
        if (action === 'sequence') {
            const steps = params?.steps || [];
            if (!steps.length) {
                return await editReply(ctx, {
                    content: '',
                    embeds: [new EmbedBuilder().setColor('#e74c3c').setTitle('❌ Error').setDescription('AI returned an empty sequence.')]
                });
            }

            const hasDestructive = steps.some(s => DESTRUCTIVE_ACTIONS.has(s.action));
            if (hasDestructive) {
                const confirmed = await confirmDestructiveAction(ctx, action, params, steps);
                if (!confirmed) return;
            }

            try {
                const resultText = await handlers.sequence(guild, params, ctx, payload => editReply(ctx, payload));
                const embed = new EmbedBuilder()
                    .setColor('#2ecc71')
                    .setTitle(`✅ Sequence Complete (${steps.length} steps)`)
                    .setDescription(resultText.slice(0, 4096))
                    .setFooter({ text: '↩️ Use "sudo rollback" to undo last action' })
                    .setTimestamp();
                await editReply(ctx, { content: '', embeds: [embed], components: [] });
            } catch (err) {
                console.error(`[${ts()}] Sequence error:`, err);
                await editReply(ctx, {
                    content: '',
                    embeds: [new EmbedBuilder().setColor('#e74c3c').setTitle('❌ Sequence Error').setDescription(err.message)],
                    components: []
                });
            }
            return;
        }

        // ── Parallel (multi-step simultaneous) ──
        if (action === 'parallel') {
            const steps = params?.steps || [];
            if (!steps.length) {
                return await editReply(ctx, {
                    content: '',
                    embeds: [new EmbedBuilder().setColor('#e74c3c').setTitle('❌ Error').setDescription('AI returned empty parallel tasks.')]
                });
            }

            const hasDestructive = steps.some(s => DESTRUCTIVE_ACTIONS.has(s.action));
            if (hasDestructive) {
                const confirmed = await confirmDestructiveAction(ctx, action, params, steps);
                if (!confirmed) return;
            }

            try {
                const resultText = await handlers.parallel(guild, params, ctx, payload => editReply(ctx, payload));
                const passed = (resultText.match(/^✅/gm) || []).length;
                const failed = (resultText.match(/^❌/gm) || []).length;
                const color = failed === 0 ? '#2ecc71' : passed === 0 ? '#e74c3c' : '#f39c12';
                const embed = new EmbedBuilder()
                    .setColor(color)
                    .setTitle(`⚡ Parallel Complete — ${passed}/${steps.length} succeeded`)
                    .setDescription(resultText.slice(0, 4096))
                    .setFooter({ text: '↩️ Use "sudo rollback" to undo last action' })
                    .setTimestamp();
                await editReply(ctx, { content: '', embeds: [embed], components: [] });
            } catch (err) {
                console.error(`[${ts()}] Parallel error:`, err);
                await editReply(ctx, {
                    content: '',
                    embeds: [new EmbedBuilder().setColor('#e74c3c').setTitle('❌ Parallel Error').setDescription(err.message)],
                    components: []
                });
            }
            return;
        }

        // ── Single action ──
        const handler = handlers[action];
        if (!handler) {
            return await editReply(ctx, {
                content: '',
                embeds: [new EmbedBuilder().setColor('#e74c3c').setTitle('❌ Unknown Action').setDescription(`The AI returned unsupported action: \`${action}\``)]
            });
        }

        // Confirmation for destructive actions
        if (DESTRUCTIVE_ACTIONS.has(action)) {
            const confirmed = await confirmDestructiveAction(ctx, action, params);
            if (!confirmed) return;
        } else {
            await editReply(ctx, { content: `${LOADING_EMOJI} Executing **${action}**...` });
        }

        // Execute
        try {
            const rollbackFn = buildRollbackFn(action, params, guild);
            const resultText = await handler(guild, params);

            addToHistory({
                action, params, summary: resultText,
                timestamp: Date.now(), rollbackFn, canRollback: !!rollbackFn
            });

            const embed = new EmbedBuilder()
                .setColor('#2ecc71')
                .setTitle('✅ Done')
                .setDescription(resultText)
                .setFooter({ text: rollbackFn ? '↩️ Use "sudo rollback" to undo' : '⛔ Cannot be undone' })
                .setTimestamp();

            await editReply(ctx, { content: '', embeds: [embed], components: [] });
            console.log(`[${ts()}] ✅ ${action}: ${resultText}`);
        } catch (err) {
            console.error(`[${ts()}] ❌ Execution error:`, err);
            await editReply(ctx, {
                content: '',
                embeds: [new EmbedBuilder().setColor('#e74c3c').setTitle('❌ Execution Error').setDescription(err.message)],
                components: []
            });
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
            .addStringOption(opt =>
                opt.setName('prompt')
                    .setDescription('Your command in natural language')
                    .setRequired(true)
            )
    ].map(c => c.toJSON());

    try {
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log(`[${ts()}] ✅ Slash commands registered`);
    } catch (err) {
        console.error(`[${ts()}] Slash command registration failed:`, err);
    }
});

// ─── Slash Commands ─────────────────────────────────────────────────────────
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== 'mod_ai_agent') return;
    if (!hasPermission(interaction.member, interaction.user.id)) {
        return interaction.reply({ content: '🚫 No permission.', ephemeral: true });
    }

    const prompt = interaction.options.getString('prompt');

    // deferReply gives us 15 minutes instead of the 3-second window
    await interaction.deferReply();
    await interaction.editReply(`${LOADING_EMOJI} Processing: *"${prompt}"*`);
    await processAICommand(prompt, interaction, interaction.guild);
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
        if (!last) {
            return message.reply({
                embeds: [new EmbedBuilder().setColor('#e74c3c').setTitle('❌ Nothing to Rollback').setDescription('No reversible actions in history.')]
            });
        }

        const msg = await message.reply(`${LOADING_EMOJI} Rolling back **${last.action}**...`);
        try {
            const result = await last.rollbackFn();
            last.canRollback = false;
            addToHistory({
                action: 'rollback', params: {}, summary: result,
                timestamp: Date.now(), rollbackFn: null, canRollback: false
            });
            await msg.edit({
                content: '',
                embeds: [new EmbedBuilder().setColor('#3498db').setTitle('↩️ Rolled Back').setDescription(result).setTimestamp()]
            });
        } catch (err) {
            await msg.edit({
                content: '',
                embeds: [new EmbedBuilder().setColor('#e74c3c').setTitle('❌ Rollback Failed').setDescription(err.message)]
            });
        }
        return;
    }

    // ── sudo history ──
    if (/^sudo\s+history$/i.test(content)) {
        if (!actionHistory.length) {
            return message.reply({
                embeds: [new EmbedBuilder().setColor('#95a5a6').setTitle('📜 History').setDescription('No actions yet.')]
            });
        }

        const lines = actionHistory.slice(0, 15).map((h) => {
            const ago = Math.round((Date.now() - h.timestamp) / 1000);
            const icon = h.canRollback ? '↩️' : '✅';
            return `${icon} **${ago}s ago** — \`${h.action}\` — ${h.summary.slice(0, 80)}`;
        }).join('\n');

        return message.reply({
            embeds: [new EmbedBuilder().setColor('#3498db').setTitle('📜 Action History').setDescription(lines).setTimestamp()]
        });
    }

    // ── sudo help ──
    if (/^sudo\s+help$/i.test(content)) {
        return message.reply({
            embeds: [new EmbedBuilder()
                .setColor('#3498db')
                .setTitle('🤖 AI Moderator Bot — Help')
                .setDescription('Use **`sudo <command>`** with natural language. Supports **multi-step commands** — just describe everything you want done in one message!')
                .addFields(
                    {
                        name: '📁 Channels',
                        value: '`sudo create 5 text channels called dev-1 to dev-5`\n`sudo delete channels matching "test"`\n`sudo rename all channels with cool emojis`\n`sudo move general into the Main category`\n`sudo lock announcements`\n`sudo set slowmode in general to 10s`',
                        inline: false
                    },
                    {
                        name: '🎭 Roles',
                        value: '`sudo create a red Admin role with hoist`\n`sudo delete the Muted role`\n`sudo rename Admin to Administrator`\n`sudo assign Admin to user 123456789`',
                        inline: false
                    },
                    {
                        name: '🛡️ Moderation',
                        value: '`sudo kick user 123456789 for spam`\n`sudo ban user 123456789`\n`sudo purge 50 messages in general`\n`sudo set nickname for user 123 to CoolGuy`',
                        inline: false
                    },
                    {
                        name: '🔗 Multi-step',
                        value: '`sudo create a Gaming category, add voice channels, and create a Gamer role in green`\n`sudo rename all channels with emojis and lock announcements`',
                        inline: false
                    },
                    {
                        name: '🧠 AI & General',
                        value: '`sudo what is the capital of Japan?`\n`sudo explain quantum computing`',
                        inline: false
                    },
                    {
                        name: '⚙️ Bot Commands',
                        value: '`sudo history` — View recent actions\n`sudo rollback` — Undo last action\n`sudo help` — This menu',
                        inline: false
                    }
                )
                .setFooter({ text: 'Destructive actions require confirmation • Use /mod_ai_agent for slash commands' })
            ]
        });
    }

    // ── sudo <prompt> ──
    if (/^sudo\s+/i.test(content)) {
        const prompt = content.slice(5).trim();
        if (!prompt) return message.reply('Provide a command after `sudo`.');
        const processingMsg = await message.reply(`${LOADING_EMOJI} Processing: *"${prompt}"*`);
        await processAICommand(prompt, processingMsg, message.guild);
    }
});

// ─── Graceful Shutdown ──────────────────────────────────────────────────────
process.on('SIGTERM', () => {
    console.log(`[${ts()}] SIGTERM received, shutting down`);
    client.destroy();
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log(`[${ts()}] SIGINT received, shutting down`);
    client.destroy();
    process.exit(0);
});

process.on('uncaughtException', err => {
    console.error(`[${ts()}] Uncaught exception:`, err);
});

process.on('unhandledRejection', err => {
    console.error(`[${ts()}] Unhandled rejection:`, err);
});

// ─── Login ──────────────────────────────────────────────────────────────────
client.login(process.env.DISCORD_TOKEN);
