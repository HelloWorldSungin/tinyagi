# Discord Server Channels Per Team

**Date:** 2026-03-25
**Status:** Draft
**Approach:** Minimal — config + guard change in existing `discord.ts`

## Summary

Add support for mapping Discord server channels to TinyAGI teams. Each mapped channel auto-routes messages to its team, with agent override via `@mention`. Responses are delivered in Discord threads. Existing DM functionality is unchanged.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Routing | Hybrid — auto-route to team, `@agent` overrides | Convenience of auto-routing with flexibility to target specific agents |
| Response format | Thread per user message | Keeps channel clean, parallel conversations don't clash |
| Channel selection | Allowlist only | Predictable, safe — bot ignores unmapped channels |
| DM behavior | Unchanged | Additive feature, DMs serve a different purpose (private, flexible routing) |
| Access control | None (Discord permissions suffice) | Avoids duplicating Discord's built-in role/channel permission system |
| Channel-to-team mapping | One-to-one | Each channel maps to exactly one team; each team works on a different repo/project |
| Sticky defaults | Disabled for guild channels | Prevents one user's default from affecting others in a shared channel |

## Configuration

Add `guild_channels` to the existing Discord channel config in `~/.tinyagi/settings.json`:

```json
{
  "channels": {
    "enabled": ["discord"],
    "discord": {
      "bot_token": "...",
      "guild_channels": {
        "1234567890": "backend",
        "0987654321": "frontend"
      }
    }
  }
}
```

- Keys: Discord channel IDs (strings)
- Values: Team IDs (must exist in `settings.teams`)
- Settings are re-read per message, so changes take effect without restart

## Discord Client Changes

### Intents and Partials

Add `GatewayIntentBits.GuildMessages` to the client constructor. Current intents (`Guilds`, `DirectMessages`, `MessageContent`) remain.

No additional partials needed — the existing `Partials.Channel` already covers partial thread channel resolution in discord.js v14.

### Type Changes

Update the `PendingMessage` interface:
- Change `channel: DMChannel` to `channel: DMChannel | PublicThreadChannel` (or use discord.js `TextBasedChannel`). Update the import line accordingly. This affects response delivery and the typing indicator loop — both already call `.sendTyping()` and `.send()` which exist on both types.
- Add `isGuild: boolean` flag (default `false`). Set to `true` for guild-originated messages. This allows `checkOutgoingQueue` to distinguish between an evicted guild pending entry (should log warning and ack, not DM) and a legitimate proactive message (should fall back to DM via `senderId`).

### Message Handler

Modify the guild guard at `discord.ts:224`:

```
Current:  if (message.guild) return;

New:      if (message.guild)
            → look up message.channel.id in guild_channels
            → if not mapped → return (ignore)
            → if mapped → handle as guild message
          else
            → existing DM flow (unchanged)
```

### Guild Message Flow

1. Read `guild_channels` from settings, look up `message.channel.id`
2. If `message.channel.isThread()`, look up via `message.channel.parentId` instead. If the parent is mapped, deliver the response in the existing thread (do not create a new one). If not mapped, ignore.
3. If not mapped, return (ignore)
4. Skip bot messages (already handled)
5. Get the mapped `teamId`
6. Process text commands (`/agent`, `/team`, `/reset`, `/restart`) BEFORE thread creation. Reply with `message.reply()` directly in the channel — do not spawn a thread for commands.
7. Save the original message text for thread naming (before any prepend)
8. If user message does NOT start with `@`, prepend `@teamId` to the message text (auto-routing). Ensure the message body is non-empty after prepend — for attachment-only messages, use the file path references as the body so the `parseAgentRouting` regex (`@tag\s+body`) always matches.
9. If user message starts with `@agent`, leave as-is (override)
10. Create a thread on the user's message: `message.startThread({ name: truncated_original_message })`
11. Enqueue to the API via `POST /api/message` with `channel: 'discord'`
12. Store the **thread** object (not the parent channel) in `pendingMessages` — this ensures `sendTyping()` and response delivery target the thread
13. Show typing indicator in the thread

### Response Delivery

No structural change to `checkOutgoingQueue`. It already sends responses to whatever channel object is stored in `pendingMessages`. For guild messages, that object is the thread instead of a DM channel.

- First response chunk replies in the thread
- Subsequent chunks (2000 char splits) follow in the same thread
- File attachments sent to the thread via `AttachmentBuilder`
- **Eviction fallback**: The 10-minute pending message cleanup may evict guild entries. In `checkOutgoingQueue`, when `pending` is missing: check if the response originated from a guild message (via the `isGuild` flag on the pending entry, or by checking if the `messageId` prefix indicates guild origin). For guild messages, log a warning and ack without responding — do NOT fall back to DM delivery. For non-guild (DM/proactive) messages, the existing `senderId` → `createDM` fallback remains.

### Routing Logic

- **Auto-routing**: Handler prepends `@teamId` before enqueuing. Existing `parseAgentRouting` in the queue processor handles the rest. No downstream changes.
- **Override**: If the user writes `@alice fix this`, no prepend. Routes directly to alice. Team context auto-activates if alice belongs to a team.
- **Sticky defaults**: Skipped entirely for guild messages. The channel-to-team mapping is the implicit default. `applyDefaultAgent()` is not called for guild messages.
- **Pairing**: Skipped for guild messages. Discord server/channel permissions are the access gate. `ensureSenderPaired()` is not called for guild messages.
- **Text commands**: `/agent`, `/team`, `/reset`, `/restart` are text-prefix commands (not Discord Slash Commands). They are processed before thread creation and reply directly in the channel via `message.reply()`.

## Thread Management

- **Naming**: First ~90 characters of the **original** user message (before `@teamId` prepend). Discord limit is 100 chars. Strip `@agent` prefix for cleaner names. For attachment-only messages, use `"Attachment from {username}"`.
- **Reuse**: None. Each user message in the parent channel creates a new thread. Messages inside existing threads are processed in that thread without creating a new one.
- **Typing indicator**: `thread.sendTyping()` is valid on discord.js `PublicThreadChannel`. Existing 8-second polling interval works unchanged — it iterates `pendingMessages` and calls `.sendTyping()` on the stored channel object (which is the thread, not the parent channel).

## Edge Cases and Error Handling

- **Invalid team mapping**: If `guild_channels` references a team ID not in `settings.teams`, log a warning and ignore the message.
- **Bot permissions**: Requires `CreatePublicThreads` and `SendMessagesInThreads` in mapped channels. If thread creation fails, catch the error, log it, and attempt a direct channel reply as fallback with a note that thread creation failed.
- **Concurrent messages**: Each message gets its own thread. Discord handles concurrent thread creation without conflict.
- **Thread name collisions**: Discord allows duplicate thread names. No issue.
- **Empty messages with attachments**: Build message from attachment file path references as the body. Use generic thread name (`"Attachment from {username}"`).
- **Messages inside existing threads**: If `message.channel.isThread()`, look up via `message.channel.parentId`. If parent is mapped, process the message and respond in the existing thread. If not mapped, ignore.
- **Pending eviction for slow responses**: If a guild message's pending entry is evicted (10-minute timeout) before the agent responds, log a warning and ack. Do not fall back to DM delivery.

## Files Changed

- `packages/channels/src/discord.ts` — intents, partials, `PendingMessage` type update (`DMChannel` → `DMChannel | PublicThreadChannel`), guild guard, thread creation, text command handling, response delivery eviction fallback
- `packages/core/src/types.ts` — add `guild_channels?: Record<string, string>` to Discord channel settings type

## What Does NOT Change

- DM functionality (routing, sticky defaults, pairing, slash commands)
- Queue processor, API server, team orchestration
- Other channel clients (Telegram, WhatsApp)
- SSE event system
- `applyDefaultAgent()` function (just not called for guild messages)
