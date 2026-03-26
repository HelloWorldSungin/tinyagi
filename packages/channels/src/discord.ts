#!/usr/bin/env node
/**
 * Discord Client for TinyAGI Simple
 * Writes DM messages to queue and reads responses
 * Does NOT call Claude directly - that's handled by queue-processor
 */

import { Client, Events, GatewayIntentBits, Partials, Message, DMChannel, PublicThreadChannel, AttachmentBuilder } from 'discord.js';
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import { ensureSenderPaired, genId } from '@tinyagi/core';
import { createSSEClient } from './sse-client';
import { applyDefaultAgent } from './default-agent';

const API_PORT = parseInt(process.env.TINYAGI_API_PORT || '3777', 10);
const API_BASE = `http://localhost:${API_PORT}`;

const SCRIPT_DIR = path.resolve(__dirname, '..', '..');
const TINYAGI_HOME = process.env.TINYAGI_HOME
    || path.join(require('os').homedir(), '.tinyagi');
const LOG_FILE = path.join(TINYAGI_HOME, 'logs/discord.log');
const SETTINGS_FILE = path.join(TINYAGI_HOME, 'settings.json');
const FILES_DIR = path.join(TINYAGI_HOME, 'files');
const PAIRING_FILE = path.join(TINYAGI_HOME, 'pairing.json');

// Ensure directories exist
[path.dirname(LOG_FILE), FILES_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

// Validate bot token
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
if (!DISCORD_BOT_TOKEN || DISCORD_BOT_TOKEN === 'your_token_here') {
    console.error('ERROR: DISCORD_BOT_TOKEN is not set in .env file');
    process.exit(1);
}

interface PendingMessage {
    message: Message;
    channel: DMChannel | PublicThreadChannel;
    timestamp: number;
    isGuild: boolean;
}

function sanitizeFileName(fileName: string): string {
    const baseName = path.basename(fileName).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
    return baseName.length > 0 ? baseName : 'file.bin';
}

function buildUniqueFilePath(dir: string, preferredName: string): string {
    const cleanName = sanitizeFileName(preferredName);
    const ext = path.extname(cleanName);
    const stem = path.basename(cleanName, ext);
    let candidate = path.join(dir, cleanName);
    let counter = 1;
    while (fs.existsSync(candidate)) {
        candidate = path.join(dir, `${stem}_${counter}${ext}`);
        counter++;
    }
    return candidate;
}

// Download a file from URL to local path
function downloadFile(url: string, destPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(destPath);
        const request = (url.startsWith('https') ? https.get(url, handleResponse) : http.get(url, handleResponse));

        function handleResponse(response: http.IncomingMessage): void {
            if (response.statusCode === 301 || response.statusCode === 302) {
                const redirectUrl = response.headers.location;
                if (redirectUrl) {
                    file.close();
                    fs.unlinkSync(destPath);
                    downloadFile(redirectUrl, destPath).then(resolve).catch(reject);
                    return;
                }
            }
            response.pipe(file);
            file.on('finish', () => { file.close(); resolve(); });
        }

        request.on('error', (err) => {
            fs.unlink(destPath, () => {});
            reject(err);
        });
    });
}

// Track pending messages (waiting for response)
const pendingMessages = new Map<string, PendingMessage>();
let processingOutgoingQueue = false;

// Logger
function log(level: string, message: string): void {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [${level}] ${message}\n`;
    console.log(logMessage.trim());
    fs.appendFileSync(LOG_FILE, logMessage);
}

// Load teams from settings for /team command
function getTeamListText(): string {
    try {
        const settingsData = fs.readFileSync(SETTINGS_FILE, 'utf8');
        const settings = JSON.parse(settingsData);
        const teams = settings.teams;
        if (!teams || Object.keys(teams).length === 0) {
            return 'No teams configured.\n\nCreate a team with `tinyagi team add`.';
        }
        let text = '**Available Teams:**\n';
        for (const [id, team] of Object.entries(teams) as [string, any][]) {
            text += `\n**@${id}** - ${team.name}`;
            text += `\n  Agents: ${team.agents.join(', ')}`;
            text += `\n  Leader: @${team.leader_agent}`;
        }
        text += '\n\nUsage: Start your message with `@team_id` to route to a team.';
        return text;
    } catch {
        return 'Could not load team configuration.';
    }
}

// Load agents from settings for /agent command
function getAgentListText(): string {
    try {
        const settingsData = fs.readFileSync(SETTINGS_FILE, 'utf8');
        const settings = JSON.parse(settingsData);
        const agents = settings.agents;
        if (!agents || Object.keys(agents).length === 0) {
            return 'No agents configured. Using default single-agent mode.\n\nConfigure agents in `.tinyagi/settings.json` or run `tinyagi agent add`.';
        }
        let text = '**Available Agents:**\n';
        for (const [id, agent] of Object.entries(agents) as [string, any][]) {
            text += `\n**@${id}** - ${agent.name}`;
            text += `\n  Provider: ${agent.provider}/${agent.model}`;
            text += `\n  Directory: ${agent.working_directory}`;
            if (agent.system_prompt) text += `\n  Has custom system prompt`;
            if (agent.prompt_file) text += `\n  Prompt file: ${agent.prompt_file}`;
        }
        text += '\n\nUsage: Start your message with `@agent_id` to route to a specific agent.';
        return text;
    } catch {
        return 'Could not load agent configuration.';
    }
}

// Split long messages for Discord's 2000 char limit
function splitMessage(text: string, maxLength = 2000): string[] {
    if (text.length <= maxLength) {
        return [text];
    }

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
        if (remaining.length <= maxLength) {
            chunks.push(remaining);
            break;
        }

        // Try to split at a newline boundary
        let splitIndex = remaining.lastIndexOf('\n', maxLength);

        // Fall back to space boundary
        if (splitIndex <= 0) {
            splitIndex = remaining.lastIndexOf(' ', maxLength);
        }

        // Hard-cut if no good boundary found
        if (splitIndex <= 0) {
            splitIndex = maxLength;
        }

        chunks.push(remaining.substring(0, splitIndex));
        remaining = remaining.substring(splitIndex).replace(/^\n/, '');
    }

    return chunks;
}

function pairingMessage(code: string): string {
    return [
        'This sender is not paired yet.',
        `Your pairing code: ${code}`,
        'Ask the TinyAGI owner to approve you with:',
        `tinyagi pairing approve ${code}`,
    ].join('\n');
}

// Load guild_channels mapping from settings
function getGuildChannels(): Record<string, string> {
    try {
        const settingsData = fs.readFileSync(SETTINGS_FILE, 'utf8');
        const settings = JSON.parse(settingsData);
        return settings.channels?.discord?.guild_channels || {};
    } catch {
        return {};
    }
}

// Build a thread name from a message (max 100 chars, Discord limit)
function buildThreadName(messageText: string, username: string): string {
    if (!messageText || !messageText.trim()) {
        return `Attachment from ${username}`;
    }
    // Strip leading @agent prefix for cleaner names
    const cleaned = messageText.replace(/^@\S+\s*/, '').trim();
    const name = cleaned || messageText.trim();
    return name.length > 90 ? name.substring(0, 90) + '...' : name;
}

// Check for text commands (/agent, /team, /reset, /restart) and handle them.
// Returns true if the message was a command and was handled.
async function handleTextCommand(message: Message): Promise<boolean> {
    const content = message.content?.trim() || '';

    if (content.match(/^[!/]agent$/i)) {
        log('INFO', 'Agent list command received');
        await message.reply(getAgentListText());
        return true;
    }

    if (content.match(/^[!/]team$/i)) {
        log('INFO', 'Team list command received');
        await message.reply(getTeamListText());
        return true;
    }

    if (content.match(/^[!/]reset$/i)) {
        await message.reply('Usage: `/reset @agent_id [@agent_id2 ...]`\nSpecify which agent(s) to reset.');
        return true;
    }

    const resetMatch = content.match(/^[!/]reset\s+(.+)$/i);
    if (resetMatch) {
        log('INFO', 'Per-agent reset command received');
        const agentArgs = resetMatch[1].split(/\s+/).map(a => a.replace(/^@/, '').toLowerCase());
        try {
            const settingsData = fs.readFileSync(SETTINGS_FILE, 'utf8');
            const settings = JSON.parse(settingsData);
            const agents = settings.agents || {};
            const workspacePath = settings?.workspace?.path || path.join(require('os').homedir(), 'tinyagi-workspace');
            const resetResults: string[] = [];
            for (const agentId of agentArgs) {
                if (!agents[agentId]) {
                    resetResults.push(`Agent '${agentId}' not found.`);
                    continue;
                }
                const flagDir = path.join(workspacePath, agentId);
                if (!fs.existsSync(flagDir)) fs.mkdirSync(flagDir, { recursive: true });
                fs.writeFileSync(path.join(flagDir, 'reset_flag'), 'reset');
                resetResults.push(`Reset @${agentId} (${agents[agentId].name}).`);
            }
            await message.reply(resetResults.join('\n'));
        } catch {
            await message.reply('Could not process reset command. Check settings.');
        }
        return true;
    }

    if (content.match(/^[!/]restart$/i)) {
        log('INFO', 'Restart command received');
        await message.reply('Restarting TinyAGI...');
        const { exec } = require('child_process');
        exec(`"${path.join(SCRIPT_DIR, 'lib', 'tinyagi.sh')}" restart`, { detached: true, stdio: 'ignore' });
        return true;
    }

    // Pipeline commands: @team_id /retry|restart|status
    const pipelineMatch = content.match(/^@(\S+)\s+[!/](retry|restart|status)(?:\s+([\s\S]*))?$/i);
    if (pipelineMatch) {
        const teamId = pipelineMatch[1];
        const command = pipelineMatch[2].toLowerCase();
        const body = pipelineMatch[3]?.trim() || '';

        // Verify team is in pipeline mode
        try {
            const settingsData = fs.readFileSync(SETTINGS_FILE, 'utf8');
            const settings = JSON.parse(settingsData);
            const team = settings.teams?.[teamId];
            if (!team || team.mode !== 'pipeline') {
                return false; // Not a pipeline team — pass through as normal message
            }
        } catch {
            return false;
        }

        log('INFO', `Pipeline command: @${teamId} /${command}`);

        try {
            if (command === 'status') {
                const res = await fetch(`${API_BASE}/api/pipeline/${teamId}/status`);
                const data = await res.json() as { message: string };
                await message.reply(data.message);
            } else if (command === 'retry') {
                const res = await fetch(`${API_BASE}/api/pipeline/${teamId}/retry`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        channel: 'discord',
                        sender: message.author.username,
                        senderId: message.author.id,
                    }),
                });
                const data = await res.json() as { message: string };
                await message.reply(data.message);
            } else if (command === 'restart') {
                const res = await fetch(`${API_BASE}/api/pipeline/${teamId}/restart`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        message: body || undefined,
                        channel: 'discord',
                        sender: message.author.username,
                        senderId: message.author.id,
                    }),
                });
                const data = await res.json() as { message: string };
                await message.reply(data.message);
            }
        } catch (err) {
            log('ERROR', `Pipeline command error: ${(err as Error).message}`);
            await message.reply('Could not process pipeline command. Is the queue processor running?');
        }
        return true;
    }

    return false;
}

// Initialize Discord client
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
    ],
    partials: [
        Partials.Channel,
        Partials.Message,
        Partials.Reaction,
    ],
});

// Client ready
client.on(Events.ClientReady, (readyClient) => {
    log('INFO', `Discord bot connected as ${readyClient.user.tag}`);
    log('INFO', 'Listening for DMs and guild channels...');
});

// Message received - Write to queue
client.on(Events.MessageCreate, async (message: Message) => {
    try {
        // Skip bot messages
        if (message.author.bot) {
            return;
        }

        // Guild message — check if channel is mapped to a team
        if (message.guild) {
            const guildChannels = getGuildChannels();

            // Resolve channel ID — for threads, use the parent channel ID
            let channelId = message.channel.id;
            let existingThread: PublicThreadChannel | null = null;
            if (message.channel.isThread()) {
                const parentId = message.channel.parentId;
                if (!parentId || !guildChannels[parentId]) return;
                channelId = parentId;
                existingThread = message.channel as PublicThreadChannel;
            }

            if (!guildChannels[channelId]) return;

            const teamId = guildChannels[channelId];
            const hasGuildAttachments = message.attachments.size > 0;
            const hasGuildContent = message.content && message.content.trim().length > 0;
            if (!hasGuildContent && !hasGuildAttachments) return;

            // Handle text commands before team validation and thread creation
            // (so commands work even if team mapping is invalid)
            if (await handleTextCommand(message)) return;

            // Validate team exists in settings
            try {
                const settingsData = fs.readFileSync(SETTINGS_FILE, 'utf8');
                const settings = JSON.parse(settingsData);
                if (!settings.teams?.[teamId]) {
                    log('WARN', `Guild channel ${channelId} mapped to non-existent team '${teamId}', ignoring`);
                    return;
                }
            } catch {
                log('ERROR', 'Could not read settings for team validation');
                return;
            }

            const sender = message.author.username;
            const messageId = genId('discord-guild');

            // Download attachments (same as DM path)
            const downloadedFiles: string[] = [];
            if (hasGuildAttachments) {
                for (const [, attachment] of message.attachments) {
                    try {
                        const attachmentName = attachment.name || `discord_${messageId}_${Date.now()}.bin`;
                        const filename = `discord_${messageId}_${attachmentName}`;
                        const localPath = buildUniqueFilePath(FILES_DIR, filename);
                        await downloadFile(attachment.url, localPath);
                        downloadedFiles.push(localPath);
                        log('INFO', `Downloaded attachment: ${path.basename(localPath)} (${attachment.contentType || 'unknown'})`);
                    } catch (dlErr) {
                        log('ERROR', `Failed to download attachment ${attachment.name}: ${(dlErr as Error).message}`);
                    }
                }
            }

            // Save original message for thread naming (before prepend)
            const originalText = message.content || '';

            // Build file references once (used for both body fallback and appending)
            const fileRefs = downloadedFiles.length > 0
                ? downloadedFiles.map(f => `[file: ${f}]`).join('\n')
                : '';

            // Build message with auto-routing
            let messageText = originalText;
            if (!messageText.startsWith('@')) {
                const body = messageText || fileRefs || 'process attachments';
                messageText = `@${teamId} ${body}`;
            }

            // Append file references if text + attachments (and refs weren't already used as body)
            let fullMessage = messageText;
            if (fileRefs && originalText) {
                fullMessage = `${messageText}\n\n${fileRefs}`;
            }

            // Create thread or use existing one
            let thread: PublicThreadChannel;
            if (existingThread) {
                thread = existingThread;
            } else {
                try {
                    const threadName = buildThreadName(originalText, sender);
                    const created = await message.startThread({ name: threadName });
                    thread = created as PublicThreadChannel;
                } catch (threadErr) {
                    log('ERROR', `Failed to create thread: ${(threadErr as Error).message}`);
                    try {
                        await message.reply('Could not create a thread for this message. Please try again.');
                    } catch { /* ignore fallback failure */ }
                    return;
                }
            }

            // Store pending message with thread as the channel BEFORE enqueuing
            // to avoid a race where SSE fires before the pending entry is stored
            pendingMessages.set(messageId, {
                message: message,
                channel: thread,
                timestamp: Date.now(),
                isGuild: true,
            });

            // Enqueue to API
            await fetch(`${API_BASE}/api/message`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    channel: 'discord',
                    sender,
                    senderId: message.author.id,
                    message: fullMessage,
                    messageId,
                }),
            });

            log('INFO', `Queued guild message ${messageId} (team: ${teamId}, thread: ${thread.id})`);

            // Show typing in the thread
            await thread.sendTyping();
            return;
        }

        const hasAttachments = message.attachments.size > 0;
        const hasContent = message.content && message.content.trim().length > 0;

        // Skip messages with no content and no attachments
        if (!hasContent && !hasAttachments) {
            return;
        }

        const sender = message.author.username;

        // Generate unique message ID
        const messageId = genId('discord');

        // Download any attachments
        const downloadedFiles: string[] = [];
        if (hasAttachments) {
            for (const [, attachment] of message.attachments) {
                try {
                    const attachmentName = attachment.name || `discord_${messageId}_${Date.now()}.bin`;
                    const filename = `discord_${messageId}_${attachmentName}`;
                    const localPath = buildUniqueFilePath(FILES_DIR, filename);

                    await downloadFile(attachment.url, localPath);
                    downloadedFiles.push(localPath);
                    log('INFO', `Downloaded attachment: ${path.basename(localPath)} (${attachment.contentType || 'unknown'})`);
                } catch (dlErr) {
                    log('ERROR', `Failed to download attachment ${attachment.name}: ${(dlErr as Error).message}`);
                }
            }
        }

        let messageText = message.content || '';

        log('INFO', `Message from ${sender}: ${messageText.substring(0, 50)}${downloadedFiles.length > 0 ? ` [+${downloadedFiles.length} file(s)]` : ''}...`);

        const pairing = ensureSenderPaired(PAIRING_FILE, 'discord', message.author.id, sender);
        if (!pairing.approved && pairing.code) {
            if (pairing.isNewPending) {
                log('INFO', `Blocked unpaired Discord sender ${sender} (${message.author.id}) with code ${pairing.code}`);
                await message.reply(pairingMessage(pairing.code));
            } else {
                log('INFO', `Blocked pending Discord sender ${sender} (${message.author.id}) without re-sending pairing message`);
            }
            return;
        }

        // Check for text commands
        if (await handleTextCommand(message)) {
            return;
        }

        // Apply default agent routing
        const { message: routedMessage, switchNotification } = applyDefaultAgent(
            message.author.id, messageText, SETTINGS_FILE,
        );
        if (switchNotification) {
            await (message.channel as DMChannel).send(switchNotification);
        }
        if (routedMessage === null) {
            return;
        }
        messageText = routedMessage;

        // Show typing indicator
        await (message.channel as DMChannel).sendTyping();

        // Build message text with file references
        let fullMessage = messageText;
        if (downloadedFiles.length > 0) {
            const fileRefs = downloadedFiles.map(f => `[file: ${f}]`).join('\n');
            fullMessage = fullMessage ? `${fullMessage}\n\n${fileRefs}` : fileRefs;
        }

        // Write to queue via API
        await fetch(`${API_BASE}/api/message`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                channel: 'discord',
                sender,
                senderId: message.author.id,
                message: fullMessage,
                messageId,
            }),
        });

        log('INFO', `Queued message ${messageId}`);

        // Store pending message for response
        pendingMessages.set(messageId, {
            message: message,
            channel: message.channel as DMChannel,
            timestamp: Date.now(),
            isGuild: false,
        });

        // Clean up old pending messages (older than 10 minutes)
        const tenMinutesAgo = Date.now() - (10 * 60 * 1000);
        for (const [id, data] of pendingMessages.entries()) {
            if (data.timestamp < tenMinutesAgo) {
                pendingMessages.delete(id);
            }
        }

    } catch (error) {
        log('ERROR', `Message handling error: ${(error as Error).message}`);
    }
});

// Workflow gate — reaction handler
client.on('messageReactionAdd', async (reaction, user) => {
    try {
        if (user.bot) return;

        // Fetch partials if needed
        if (reaction.partial) {
            try { await reaction.fetch(); } catch { return; }
        }
        if (reaction.message.partial) {
            try { await reaction.message.fetch(); } catch { return; }
        }

        const emoji = reaction.emoji.name;
        if (emoji !== '✅' && emoji !== '❌') return;

        const discordMessageId = reaction.message.id;

        // Check if this is a gate message
        let gateRes: Response;
        try {
            gateRes = await fetch(`${API_BASE}/api/gate/message/${discordMessageId}`);
        } catch { return; }
        if (!gateRes.ok) return;

        const gate = await gateRes.json() as any;
        if (gate.status !== 'waiting') return;

        if (emoji === '✅') {
            await fetch(`${API_BASE}/api/gate/${gate.id}/approve`, { method: 'POST' });

            await fetch(`${API_BASE}/api/message`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    channel: 'discord',
                    sender: gate.original_task,
                    senderId: user.id,
                    message: 'Human approved deployment. Continue from Phase 4 (deploy). Re-read the plan and spec files to refresh context.',
                    agent: gate.agent_id,
                    resume: true,
                    worktreePath: gate.worktree_path,
                }),
            });

            log('INFO', `Gate ${gate.id} approved by ${(user as any).tag || user.id}, resuming agent ${gate.agent_id}`);

            const channel = reaction.message.channel;
            if (channel.isTextBased()) {
                await (channel as any).send(`✅ Deployment approved by <@${user.id}>. Resuming workflow...`);
            }
        } else if (emoji === '❌') {
            await fetch(`${API_BASE}/api/gate/${gate.id}/reject`, { method: 'POST' });
            log('INFO', `Gate ${gate.id} rejected by ${(user as any).tag || user.id}`);

            const channel = reaction.message.channel;
            if (channel.isTextBased()) {
                await (channel as any).send(`❌ Deployment rejected by <@${user.id}>. Use \`@${gate.team_id} /gate <feedback>\` to provide guidance.`);
            }
        }
    } catch (error: any) {
        log('ERROR', `Reaction handler error: ${error.message}`);
    }
});

// Watch for responses via API
async function checkOutgoingQueue(): Promise<void> {
    if (processingOutgoingQueue) {
        return;
    }

    processingOutgoingQueue = true;

    try {
        const res = await fetch(`${API_BASE}/api/responses/pending?channel=discord`);
        if (!res.ok) return;
        const responses = await res.json() as any[];

        for (const resp of responses) {
            try {
                const responseText = resp.message;
                const messageId = resp.messageId;
                const sender = resp.sender;
                const senderId = resp.senderId;
                const files: string[] = resp.files || [];

                // Find pending message, or fall back to senderId for proactive messages
                const pending = pendingMessages.get(messageId);
                let responseChannel: DMChannel | PublicThreadChannel | null = pending?.channel ?? null;

                if (!responseChannel) {
                    // Guild messages must not fall back to DM — detect via messageId prefix
                    // (pending is undefined when evicted, so pending?.isGuild won't help here)
                    if (messageId.startsWith('discord-guild')) {
                        log('WARN', `Guild message ${messageId} pending entry missing/evicted, acking without response`);
                        await fetch(`${API_BASE}/api/responses/${resp.id}/ack`, { method: 'POST' });
                        continue;
                    }
                    // DM/proactive fallback: try to open a DM
                    if (senderId) {
                        try {
                            const user = await client.users.fetch(senderId);
                            responseChannel = await user.createDM();
                        } catch (err) {
                            log('ERROR', `Could not open DM for senderId ${senderId}: ${(err as Error).message}`);
                        }
                    }
                }

                if (responseChannel) {
                    // Send any attached files
                    if (files.length > 0) {
                        const attachments: AttachmentBuilder[] = [];
                        for (const file of files) {
                            try {
                                if (!fs.existsSync(file)) continue;
                                attachments.push(new AttachmentBuilder(file));
                            } catch (fileErr) {
                                log('ERROR', `Failed to prepare file ${file}: ${(fileErr as Error).message}`);
                            }
                        }
                        if (attachments.length > 0) {
                            await responseChannel.send({ files: attachments });
                            log('INFO', `Sent ${attachments.length} file(s) to Discord`);
                        }
                    }

                    // Split message if needed (Discord 2000 char limit)
                    if (responseText) {
                        const chunks = splitMessage(responseText);
                        let firstSentMessage: any;

                        if (chunks.length > 0) {
                            if (pending && !pending.isGuild) {
                                firstSentMessage = await pending.message.reply(chunks[0]!);
                            } else {
                                firstSentMessage = await responseChannel.send(chunks[0]!);
                            }
                        }
                        for (let i = 1; i < chunks.length; i++) {
                            await responseChannel.send(chunks[i]!);
                        }

                        // Workflow gate: create gate record and add reaction
                        if (firstSentMessage && resp.metadata?.workflowGate) {
                            const meta = resp.metadata;
                            try {
                                await fetch(`${API_BASE}/api/gate`, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({
                                        teamId: meta.teamId,
                                        agentId: meta.agentId,
                                        channel: 'discord',
                                        messageId: firstSentMessage.id,
                                        threadId: firstSentMessage.channel.isThread?.() ? firstSentMessage.channel.id : null,
                                        originalTask: meta.originalTask,
                                        worktreePath: meta.worktreePath ?? null,
                                    }),
                                });
                                await firstSentMessage.react('✅');
                                log('INFO', `Gate created for workflow response (Discord msg: ${firstSentMessage.id})`);
                            } catch (gateErr: any) {
                                log('ERROR', `Failed to create gate: ${gateErr.message}`);
                            }
                        }
                    }

                    log('INFO', `Sent ${pending ? 'response' : 'proactive message'} to ${sender} (${responseText.length} chars${files.length > 0 ? `, ${files.length} file(s)` : ''})`);

                    if (pending) pendingMessages.delete(messageId);
                    await fetch(`${API_BASE}/api/responses/${resp.id}/ack`, { method: 'POST' });
                } else {
                    log('WARN', `No pending message for ${messageId} and no senderId, acking`);
                    await fetch(`${API_BASE}/api/responses/${resp.id}/ack`, { method: 'POST' });
                }
            } catch (error) {
                log('ERROR', `Error processing response ${resp.id}: ${(error as Error).message}`);
                // Don't ack on error, will retry next poll
            }
        }
    } catch (error) {
        log('ERROR', `Outgoing queue error: ${(error as Error).message}`);
    } finally {
        processingOutgoingQueue = false;
    }
}

// SSE-driven response delivery (replaces 1s polling)
createSSEClient({
    port: API_PORT,
    onEvent: (eventType, data) => {
        if (eventType === 'message:done' && data.channel === 'discord') {
            checkOutgoingQueue();
        }
    },
    onConnect: () => {
        log('INFO', 'SSE connected — listening for responses');
        checkOutgoingQueue();
    },
});

// Refresh typing indicator every 8 seconds (Discord typing expires after ~10s)
setInterval(() => {
    for (const [, data] of pendingMessages.entries()) {
        data.channel.sendTyping().catch(() => {
            // Ignore typing errors silently
        });
    }
}, 8000);

// Catch unhandled errors so we can see what kills the bot
process.on('unhandledRejection', (reason) => {
    log('ERROR', `Unhandled rejection: ${reason}`);
});
process.on('uncaughtException', (error) => {
    log('ERROR', `Uncaught exception: ${error.message}\n${error.stack}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
    log('INFO', 'Shutting down Discord client...');
    client.destroy();
    process.exit(0);
});

process.on('SIGTERM', () => {
    log('INFO', 'Shutting down Discord client...');
    client.destroy();
    process.exit(0);
});

// Start client
log('INFO', 'Starting Discord client...');
client.login(DISCORD_BOT_TOKEN);
