# Discord Server Channels Per Team — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Discord server channel support so each mapped channel auto-routes messages to a TinyAGI team, with responses delivered in threads.

**Architecture:** Minimal change to the existing Discord client (`discord.ts`). The guild message guard is replaced with a config lookup. Guild messages create threads and enqueue with a `@teamId` prefix. Response delivery reuses the existing `pendingMessages` map with an updated type. No downstream changes to the queue processor or team orchestration.

**Tech Stack:** TypeScript, discord.js v14, existing TinyAGI core/channels packages.

**Spec:** `docs/superpowers/specs/2026-03-25-discord-server-channels-design.md`

---

### Task 1: Add `guild_channels` to Settings type

**Files:**
- Modify: `packages/core/src/types.ts:33-39` (the `channels` property in `Settings`)

- [ ] **Step 1: Add `guild_channels` to the discord config type**

In `packages/core/src/types.ts`, update the `discord` property inside the `channels` interface from:

```typescript
discord?: { bot_token?: string };
```

to:

```typescript
discord?: { bot_token?: string; guild_channels?: Record<string, string> };
```

Keys are Discord channel ID strings, values are team ID strings.

- [ ] **Step 2: Verify the build**

Run: `cd packages/core && npm run build`
Expected: Clean compilation, no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/types.ts
git commit -m "feat(types): add guild_channels to Discord channel settings"
```

---

### Task 2: Update imports, types, and intents in Discord client

**Files:**
- Modify: `packages/channels/src/discord.ts:1-10` (imports)
- Modify: `packages/channels/src/discord.ts:43-47` (`PendingMessage` interface)
- Modify: `packages/channels/src/discord.ts:196-207` (client constructor)

- [ ] **Step 1: Update the discord.js import**

In `packages/channels/src/discord.ts`, change line 8 from:

```typescript
import { Client, Events, GatewayIntentBits, Partials, Message, DMChannel, AttachmentBuilder } from 'discord.js';
```

to:

```typescript
import { Client, Events, GatewayIntentBits, Partials, Message, DMChannel, PublicThreadChannel, TextChannel, AttachmentBuilder } from 'discord.js';
```

- [ ] **Step 2: Update the `PendingMessage` interface**

Change lines 43-47 from:

```typescript
interface PendingMessage {
    message: Message;
    channel: DMChannel;
    timestamp: number;
}
```

to:

```typescript
interface PendingMessage {
    message: Message;
    channel: DMChannel | PublicThreadChannel;
    timestamp: number;
    isGuild: boolean;
}
```

- [ ] **Step 3: Add `GatewayIntentBits.GuildMessages` to the client constructor**

Change lines 198-202 from:

```typescript
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
    ],
```

to:

```typescript
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
    ],
```

- [ ] **Step 4: Update the ready log message**

Change line 212 from:

```typescript
    log('INFO', 'Listening for DMs...');
```

to:

```typescript
    log('INFO', 'Listening for DMs and guild channels...');
```

- [ ] **Step 5: Update DM pending message creation to include `isGuild: false`**

Change lines 369-373 from:

```typescript
        pendingMessages.set(messageId, {
            message: message,
            channel: message.channel as DMChannel,
            timestamp: Date.now(),
        });
```

to:

```typescript
        pendingMessages.set(messageId, {
            message: message,
            channel: message.channel as DMChannel,
            timestamp: Date.now(),
            isGuild: false,
        });
```

- [ ] **Step 6: Verify the build**

Run: `cd packages/channels && npm run build`
Expected: Clean compilation. Existing DM functionality unchanged.

- [ ] **Step 7: Commit**

```bash
git add packages/channels/src/discord.ts
git commit -m "feat(discord): update imports, types, and intents for guild channel support"
```

---

### Task 3: Add `getGuildChannels` helper and thread naming utility

**Files:**
- Modify: `packages/channels/src/discord.ts` (add after `pairingMessage` function, around line 194)

- [ ] **Step 1: Add the `getGuildChannels` helper function**

Add after the `pairingMessage` function (after line 194):

```typescript
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
```

- [ ] **Step 2: Add the `buildThreadName` helper function**

Add immediately after `getGuildChannels`:

```typescript
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
```

- [ ] **Step 3: Verify the build**

Run: `cd packages/channels && npm run build`
Expected: Clean compilation.

- [ ] **Step 4: Commit**

```bash
git add packages/channels/src/discord.ts
git commit -m "feat(discord): add getGuildChannels and buildThreadName helpers"
```

---

### Task 4: Add text command detection helper

**Files:**
- Modify: `packages/channels/src/discord.ts` (add after `buildThreadName`)

- [ ] **Step 1: Extract text command handling into a helper**

This helper checks if a message is a text command and handles it. Returns `true` if the message was a command (so the caller should stop processing), `false` otherwise.

Add after `buildThreadName`:

```typescript
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

    return false;
}
```

- [ ] **Step 2: Replace inline command handling in the DM path with the helper**

Replace lines 274-329 in the `MessageCreate` handler. This is the block starting with `// Check for agent list command` and ending with the restart `return;`. The exact range covers all five command checks (`/agent`, `/team`, `/reset` bare, `/reset` with args, `/restart`).

**Note:** The original source declares `resetMatch` before the bare `/reset` guard. The extracted helper reverses this order (bare `/reset` first, then `resetMatch`). This is safe because the bare match (`/^[!/]reset$/i`) and the args match (`/^[!/]reset\s+(.+)$/i`) are mutually exclusive — they can't both match the same input.

Replace with:

```typescript
        // Check for text commands
        if (await handleTextCommand(message)) {
            return;
        }
```

- [ ] **Step 3: Verify the build**

Run: `cd packages/channels && npm run build`
Expected: Clean compilation. DM commands still work identically — same logic, just extracted.

- [ ] **Step 4: Commit**

```bash
git add packages/channels/src/discord.ts
git commit -m "refactor(discord): extract text command handling into helper function"
```

---

### Task 5: Implement guild message handler

**Files:**
- Modify: `packages/channels/src/discord.ts:223-226` (the guild guard)

- [ ] **Step 1: Replace the guild guard with the guild message handler**

Replace lines 223-226:

```typescript
        // Skip non-DM messages (guild = server channel)
        if (message.guild) {
            return;
        }
```

with:

```typescript
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
                        await message.reply(`Could not create thread: ${(threadErr as Error).message}`);
                    } catch { /* ignore fallback failure */ }
                    return;
                }
            }

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

            // Store pending message with thread as the channel
            pendingMessages.set(messageId, {
                message: message,
                channel: thread,
                timestamp: Date.now(),
                isGuild: true,
            });

            // Show typing in the thread
            await thread.sendTyping();
            return;
        }
```

- [ ] **Step 2: Verify the build**

Run: `cd packages/channels && npm run build`
Expected: Clean compilation.

- [ ] **Step 3: Commit**

```bash
git add packages/channels/src/discord.ts
git commit -m "feat(discord): implement guild message handler with thread creation and team auto-routing"
```

---

### Task 6: Update response delivery for guild message eviction fallback

**Files:**
- Modify: `packages/channels/src/discord.ts` (inside `checkOutgoingQueue`, around lines 409-420)

- [ ] **Step 1: Update the eviction fallback logic**

In the `checkOutgoingQueue` function, replace the block that handles missing pending messages (the `if (!dmChannel && senderId)` section and the `if (dmChannel)` / `else` blocks). The current code at approximately lines 410-463:

```typescript
                const pending = pendingMessages.get(messageId);
                let dmChannel = pending?.channel ?? null;

                if (!dmChannel && senderId) {
                    try {
                        const user = await client.users.fetch(senderId);
                        dmChannel = await user.createDM();
                    } catch (err) {
                        log('ERROR', `Could not open DM for senderId ${senderId}: ${(err as Error).message}`);
                    }
                }

                if (dmChannel) {
```

Replace with:

```typescript
                const pending = pendingMessages.get(messageId);
                let responseChannel: DMChannel | PublicThreadChannel | null = pending?.channel ?? null;

                if (!responseChannel) {
                    // Check if this was a guild message — if so, don't fallback to DM
                    if (pending?.isGuild || messageId.startsWith('discord-guild')) {
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
```

Rename **all** occurrences of `dmChannel` to `responseChannel` within the `checkOutgoingQueue` function body (there are ~7 occurrences including the declaration, conditionals, and `.send()` calls).

**CRITICAL:** Also fix the first-chunk delivery. The existing code uses `pending.message.reply()` which replies to the original message in the **parent channel**, not the thread. For guild messages this is wrong — the response must go to the thread. Change the first-chunk block from:

```typescript
                        if (pending) {
                            await pending.message.reply(chunks[0]!);
                        } else {
                            await responseChannel.send(chunks[0]!);
                        }
```

to:

```typescript
                        if (pending && !pending.isGuild) {
                            await pending.message.reply(chunks[0]!);
                        } else {
                            await responseChannel.send(chunks[0]!);
                        }
```

This ensures DM responses still reply to the user's message, while guild responses are sent to the thread.

- [ ] **Step 2: Verify the build**

Run: `cd packages/channels && npm run build`
Expected: Clean compilation.

- [ ] **Step 3: Commit**

```bash
git add packages/channels/src/discord.ts
git commit -m "feat(discord): update response delivery with guild eviction fallback"
```

---

### Task 7: Manual integration test

**Files:** None (testing only)

No automated test suite exists in this repo, so this is a manual verification checklist.

- [ ] **Step 1: Build the full project**

Run: `npm run build` (from repo root)
Expected: All packages compile without errors.

- [ ] **Step 2: Verify DM functionality is unchanged**

Start TinyAGI (`tinyagi start`), send a DM to the bot. Verify:
- Bot responds in the DM (not in a thread)
- `@agent` routing works
- Sticky defaults work
- `/agent`, `/team`, `/reset` commands work
- Pairing gate works for new users

- [ ] **Step 3: Configure a test guild channel**

Add to `~/.tinyagi/settings.json`:

```json
{
  "channels": {
    "discord": {
      "guild_channels": {
        "<your-test-channel-id>": "<your-team-id>"
      }
    }
  }
}
```

Ensure the bot has permissions in the channel: `Send Messages`, `Create Public Threads`, `Send Messages in Threads`, `Read Message History`.

- [ ] **Step 4: Test guild channel auto-routing**

Send a plain message (e.g., "fix the login bug") in the mapped Discord server channel. Verify:
- Bot creates a thread named after the message
- Agent response appears in the thread
- Message was routed to the correct team

- [ ] **Step 5: Test `@agent` override**

Send `@specific_agent do something` in the mapped channel. Verify:
- Bot creates a thread
- Message routes to the specific agent, not the team leader

- [ ] **Step 6: Test text commands in guild channel**

Send `/agent` and `/team` in the mapped channel. Verify:
- Bot replies directly in the channel (not in a thread)
- Agent and team lists display correctly

- [ ] **Step 7: Test thread reply**

Reply to an existing thread in the mapped channel. Verify:
- Bot processes the message in the existing thread
- No new thread is created

- [ ] **Step 8: Test unmapped channel**

Send a message in a server channel NOT in `guild_channels`. Verify:
- Bot ignores the message entirely

- [ ] **Step 9: Commit final state**

All changes should already be committed in Tasks 1-6. If any unstaged changes remain:

```bash
git add packages/channels/src/discord.ts packages/core/src/types.ts
git commit -m "feat(discord): add server channel-to-team mapping with thread responses"
```
