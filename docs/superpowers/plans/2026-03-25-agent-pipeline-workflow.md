# Agent Pipeline Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add autonomous development workflow agents that pick up TaskNote epics from Discord, implement them via Claude Code CLI, pause at a human gate for deploy approval, then deploy, QA, and create PRs.

**Architecture:** A new `claude-cli` adapter spawns Claude Code as a subprocess. Workflow teams auto-gate after the agent's first response. Gate state persists in SQLite. Discord reactions (✅/❌) on gate messages trigger resume/rejection via `claude -c`. Response metadata carries gate signals between processMessage and Discord delivery.

**Tech Stack:** TypeScript, Bun, SQLite (better-sqlite3), discord.js (reactions/partials), vitest

**Spec:** `docs/superpowers/specs/2026-03-25-agent-pipeline-workflow-design.md`

---

### Task 1: Add workflow types

**Files:**
- Modify: `packages/core/src/types.ts:22-28` (TeamConfig)
- Modify: `packages/core/src/types.ts:115-124` (MessageJobData)

- [ ] **Step 1: Add `workflow` to TeamConfig**

In `packages/core/src/types.ts`, update the `TeamConfig` interface at line 22:

```typescript
export interface TeamConfig {
    name: string;
    agents: string[];
    leader_agent: string;
    mode?: 'collaborative' | 'pipeline';
    pipeline?: string[];
    workflow?: boolean;
}
```

- [ ] **Step 2: Add `resume` and `worktreePath` to MessageJobData**

In the same file, update `MessageJobData` at line 115:

```typescript
export interface MessageJobData {
    channel: string;
    sender: string;
    senderId?: string;
    message: string;
    messageId: string;
    agent?: string;
    fromAgent?: string;
    pipelineRunId?: string;
    resume?: boolean;
    worktreePath?: string;
}
```

- [ ] **Step 3: Build to verify**

Run: `npm run build -w @tinyagi/core`
Expected: Clean build, no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/types.ts
git commit -m "feat(workflow): add workflow, resume, worktreePath to types"
```

---

### Task 2: Thread resume/worktreePath through the message queue

**Files:**
- Modify: `packages/core/src/queues.ts:18-80` (initQueueDb — add migration)
- Modify: `packages/core/src/queues.ts:89-105` (enqueueMessage — thread new fields)

- [ ] **Step 1: Add column migrations to `initQueueDb`**

In `packages/core/src/queues.ts`, at the end of `initQueueDb()` (after the existing `pipeline_run_id` migration near line 78), add:

```typescript
    if (!msgCols.some(c => c.name === 'resume')) {
        db.exec('ALTER TABLE messages ADD COLUMN resume INTEGER DEFAULT 0');
    }
    if (!msgCols.some(c => c.name === 'worktree_path')) {
        db.exec('ALTER TABLE messages ADD COLUMN worktree_path TEXT');
    }
```

Note: `msgCols` is already defined on line 70 as `db.pragma('table_info(messages)')`. SQLite uses INTEGER for booleans.

- [ ] **Step 2: Thread through `enqueueMessage`**

Update the `enqueueMessage` function (line 89) to include the new columns in the INSERT:

```typescript
export function enqueueMessage(data: MessageJobData): number | null {
    const now = Date.now();
    try {
        const r = getDb().prepare(
            `INSERT INTO messages (message_id,channel,sender,sender_id,message,agent,from_agent,pipeline_run_id,resume,worktree_path,status,created_at,updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,'pending',?,?)`
        ).run(data.messageId, data.channel, data.sender, data.senderId ?? null, data.message,
            data.agent ?? null, data.fromAgent ?? null, data.pipelineRunId ?? null,
            data.resume ? 1 : 0, data.worktreePath ?? null, now, now);
        queueEvents.emit('message:enqueued', { id: r.lastInsertRowid, agent: data.agent });
        return r.lastInsertRowid as number;
    } catch (err: any) {
        if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            return null;
        }
        throw err;
    }
}
```

- [ ] **Step 3: Read resume/worktreePath in processMessage**

In `packages/main/src/index.ts`, update the `processMessage` function at line 46 where `MessageJobData` is constructed from `dbMsg`:

```typescript
    const data: MessageJobData = {
        channel: dbMsg.channel,
        sender: dbMsg.sender,
        senderId: dbMsg.sender_id,
        message: dbMsg.message,
        messageId: dbMsg.message_id,
        agent: dbMsg.agent ?? undefined,
        fromAgent: dbMsg.from_agent ?? undefined,
        pipelineRunId: dbMsg.pipeline_run_id ?? undefined,
        resume: !!dbMsg.resume,
        worktreePath: dbMsg.worktree_path ?? undefined,
    };
```

- [ ] **Step 4: Build to verify**

Run: `npm run build -w @tinyagi/core && npm run build -w @tinyagi/main`
Expected: Clean build.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/queues.ts packages/main/src/index.ts
git commit -m "feat(workflow): thread resume and worktreePath through message queue"
```

---

### Task 3: Create claude-cli adapter

**Files:**
- Create: `packages/core/src/adapters/claude-cli.ts`
- Modify: `packages/core/src/adapters/index.ts:1-28` (register new adapter)

The `claude-cli` adapter is similar to the existing `claudeAdapter` in `packages/core/src/adapters/claude.ts` but:
- Does NOT pass `--system-prompt` (relies on CLAUDE.md in the workspace)
- Uses the same streaming pattern with `--output-format stream-json`
- The `shouldReset` field controls `-c` flag (same semantics: `!shouldReset` → `-c`)

- [ ] **Step 1: Create the adapter file**

Create `packages/core/src/adapters/claude-cli.ts`:

```typescript
import { AgentAdapter, InvokeOptions } from './types';
import { runCommand, runCommandStreaming } from '../invoke';
import { log } from '../logging';

/**
 * Extract displayable text from a Claude stream-json event.
 * Skips 'result' events — those duplicate the final assistant message.
 */
function extractEventText(json: any): string | null {
    if (json.type === 'assistant' && json.message?.content) {
        const parts: string[] = [];
        for (const block of json.message.content) {
            if (block.type === 'text' && block.text) {
                parts.push(block.text);
            } else if (block.type === 'tool_use' && block.name) {
                parts.push(`[tool: ${block.name}]`);
            }
        }
        return parts.length > 0 ? parts.join('\n') : null;
    }
    return null;
}

/**
 * Claude Code CLI adapter for workflow agents.
 *
 * Unlike the standard 'anthropic' adapter, this does NOT pass --system-prompt.
 * Workflow agents use CLAUDE.md in their workspace directory for instructions.
 * The shouldReset field controls -c (continue) flag: !shouldReset → -c.
 */
export const claudeCliAdapter: AgentAdapter = {
    providers: ['claude-cli'],

    async invoke(opts: InvokeOptions): Promise<string> {
        const { agentId, message, workingDir, model, shouldReset, envOverrides, onEvent } = opts;
        log('DEBUG', `Using claude-cli provider (agent: ${agentId}, cwd: ${workingDir})`);

        const continueConversation = !shouldReset;
        if (continueConversation) {
            log('INFO', `Continuing conversation for workflow agent: ${agentId}`);
        }

        const args = ['--dangerously-skip-permissions'];
        if (model) args.push('--model', model);
        if (continueConversation) args.push('-c');

        if (onEvent) {
            args.push('--output-format', 'stream-json', '--verbose', '-p', message);

            let response = '';
            const { promise, signalDone } = runCommandStreaming('claude', args, (line) => {
                try {
                    const json = JSON.parse(line);
                    if (json.type === 'result') {
                        if (json.result) response = json.result;
                        if (json.usage) log('INFO', `Claude CLI usage (${agentId}): ${JSON.stringify(json.usage)}`);
                        signalDone();
                        return;
                    }
                    const text = extractEventText(json);
                    if (text) {
                        response = text;
                        onEvent(text);
                    }
                } catch (e) {
                    // Ignore non-JSON lines
                }
            }, workingDir, envOverrides, agentId);
            await promise;

            return response || 'Sorry, I could not generate a response from Claude CLI.';
        }

        args.push('-p', message);
        return await runCommand('claude', args, workingDir, envOverrides);
    },
};
```

- [ ] **Step 2: Register the adapter**

In `packages/core/src/adapters/index.ts`, add the import and registration:

```typescript
import { claudeCliAdapter } from './claude-cli';
```

Add after line 20 (`register(opencodeAdapter);`):

```typescript
register(claudeCliAdapter);
```

- [ ] **Step 3: Build to verify**

Run: `npm run build -w @tinyagi/core`
Expected: Clean build.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/adapters/claude-cli.ts packages/core/src/adapters/index.ts
git commit -m "feat(workflow): add claude-cli adapter for workflow agents"
```

---

### Task 4: Gate CRUD with tests

**Files:**
- Create: `packages/core/src/gate.ts`
- Create: `packages/core/src/__tests__/gate.test.ts`
- Modify: `packages/core/src/index.ts:8-22` (add export)

Follow the same pattern as `packages/core/src/pipeline.ts` and `packages/core/src/__tests__/pipeline.test.ts`.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/__tests__/gate.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

const TEST_HOME = vi.hoisted(() => {
    const dir = '/tmp/tinyagi-gate-test-' + Date.now();
    process.env.TINYAGI_HOME = dir;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('fs').mkdirSync(dir, { recursive: true });
    return dir;
});

import fs from 'fs';
import { initQueueDb, closeQueueDb } from '../queues';
import {
    initGateDb,
    createGateRequest,
    getGateByMessageId,
    approveGate,
    rejectGate,
    getWaitingGates,
    expireStaleGates,
} from '../gate';

beforeAll(() => {
    initQueueDb();
    initGateDb();
});

afterAll(() => {
    closeQueueDb();
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

describe('gate CRUD', () => {
    it('creates a gate request and retrieves it by message ID', () => {
        const id = createGateRequest('arksignal', 'arksignal-dev', 'discord', 'disc_msg_123', 'thread_456', 'Arksignal-080', '/tmp/worktree');
        expect(id).toMatch(/^gate_/);

        const gate = getGateByMessageId('disc_msg_123');
        expect(gate).not.toBeNull();
        expect(gate!.team_id).toBe('arksignal');
        expect(gate!.agent_id).toBe('arksignal-dev');
        expect(gate!.channel).toBe('discord');
        expect(gate!.message_id).toBe('disc_msg_123');
        expect(gate!.thread_id).toBe('thread_456');
        expect(gate!.original_task).toBe('Arksignal-080');
        expect(gate!.worktree_path).toBe('/tmp/worktree');
        expect(gate!.status).toBe('waiting');
    });

    it('approves a gate request', () => {
        const id = createGateRequest('dev', 'dev-agent', 'discord', 'disc_msg_approve', null, 'Task-1', null);
        approveGate(id);

        const gate = getGateByMessageId('disc_msg_approve');
        expect(gate!.status).toBe('approved');
    });

    it('rejects a gate request', () => {
        const id = createGateRequest('dev', 'dev-agent', 'discord', 'disc_msg_reject', null, 'Task-2', null);
        rejectGate(id);

        const gate = getGateByMessageId('disc_msg_reject');
        expect(gate!.status).toBe('rejected');
    });

    it('returns null for unknown message ID', () => {
        const gate = getGateByMessageId('nonexistent');
        expect(gate).toBeNull();
    });

    it('lists waiting gates', () => {
        const id1 = createGateRequest('t1', 'a1', 'discord', 'waiting_1', null, 'Task-W1', null);
        const id2 = createGateRequest('t2', 'a2', 'discord', 'waiting_2', null, 'Task-W2', null);
        approveGate(id1); // no longer waiting

        const waiting = getWaitingGates();
        const waitingIds = waiting.map(g => g.id);
        expect(waitingIds).not.toContain(id1);
        expect(waitingIds).toContain(id2);
    });

    it('expires stale gates', () => {
        // Create a gate with artificially old timestamp
        const id = createGateRequest('stale', 'stale-agent', 'discord', 'stale_msg', null, 'Stale-Task', null);

        // Manually backdate the created_at (7+ days ago)
        const { getDb } = require('../queues');
        const sevenDaysAgo = Date.now() - (8 * 24 * 60 * 60 * 1000);
        getDb().prepare('UPDATE gate_requests SET created_at = ? WHERE id = ?').run(sevenDaysAgo, id);

        const expired = expireStaleGates(7 * 24 * 60 * 60 * 1000);
        expect(expired).toBeGreaterThanOrEqual(1);

        const gate = getGateByMessageId('stale_msg');
        expect(gate!.status).toBe('expired');
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w @tinyagi/core`
Expected: FAIL — `gate` module does not exist yet.

- [ ] **Step 3: Implement gate.ts**

Create `packages/core/src/gate.ts`:

```typescript
import { getDb } from './queues';
import { genId } from './ids';
import { log } from './logging';

export interface GateRequest {
    id: string;
    team_id: string;
    agent_id: string;
    channel: string;
    message_id: string;
    thread_id: string | null;
    original_task: string;
    worktree_path: string | null;
    status: 'waiting' | 'approved' | 'rejected' | 'expired';
    created_at: number;
    updated_at: number;
}

export function initGateDb(): void {
    const db = getDb();
    db.exec(`
        CREATE TABLE IF NOT EXISTS gate_requests (
            id TEXT PRIMARY KEY,
            team_id TEXT NOT NULL,
            agent_id TEXT NOT NULL,
            channel TEXT NOT NULL,
            message_id TEXT NOT NULL,
            thread_id TEXT,
            original_task TEXT NOT NULL,
            worktree_path TEXT,
            status TEXT NOT NULL DEFAULT 'waiting',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_gate_message ON gate_requests(message_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_gate_team ON gate_requests(team_id, status)');
    log('DEBUG', 'Gate DB initialized');
}

export function createGateRequest(
    teamId: string,
    agentId: string,
    channel: string,
    messageId: string,
    threadId: string | null,
    originalTask: string,
    worktreePath: string | null,
): string {
    const id = genId('gate');
    const now = Date.now();
    getDb().prepare(
        `INSERT INTO gate_requests (id, team_id, agent_id, channel, message_id, thread_id, original_task, worktree_path, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'waiting', ?, ?)`
    ).run(id, teamId, agentId, channel, messageId, threadId, originalTask, worktreePath, now, now);
    return id;
}

export function getGateByMessageId(messageId: string): GateRequest | null {
    const row = getDb().prepare(
        'SELECT * FROM gate_requests WHERE message_id = ?'
    ).get(messageId) as any;
    if (!row) return null;
    return {
        ...row,
        status: row.status as GateRequest['status'],
    };
}

export function approveGate(id: string): void {
    getDb().prepare(
        'UPDATE gate_requests SET status = ?, updated_at = ? WHERE id = ?'
    ).run('approved', Date.now(), id);
}

export function rejectGate(id: string): void {
    getDb().prepare(
        'UPDATE gate_requests SET status = ?, updated_at = ? WHERE id = ?'
    ).run('rejected', Date.now(), id);
}

export function getWaitingGates(): GateRequest[] {
    return getDb().prepare(
        'SELECT * FROM gate_requests WHERE status = ?'
    ).all('waiting') as GateRequest[];
}

export function expireStaleGates(maxAgeMs: number): number {
    const cutoff = Date.now() - maxAgeMs;
    const result = getDb().prepare(
        'UPDATE gate_requests SET status = ?, updated_at = ? WHERE status = ? AND created_at < ?'
    ).run('expired', Date.now(), 'waiting', cutoff);
    return result.changes;
}
```

- [ ] **Step 4: Export gate module from core index**

In `packages/core/src/index.ts`, add after line 22 (`export * from './pipeline';`):

```typescript
export * from './gate';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -w @tinyagi/core`
Expected: All gate tests PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/gate.ts packages/core/src/__tests__/gate.test.ts packages/core/src/index.ts
git commit -m "feat(workflow): add gate_requests table with CRUD and tests"
```

---

### Task 5: Gate API endpoints

**Files:**
- Create: `packages/server/src/routes/gate.ts`
- Modify: `packages/server/src/index.ts` (mount route)

Check the existing route pattern by looking at `packages/server/src/routes/pipeline.ts`.

- [ ] **Step 1: Check existing route pattern**

Read `packages/server/src/routes/pipeline.ts` to understand the Hono route pattern used in this project, then model the gate routes after it.

- [ ] **Step 2: Create gate routes**

Create `packages/server/src/routes/gate.ts`:

```typescript
import { Hono } from 'hono';
import { createGateRequest, getGateByMessageId, approveGate, rejectGate, getWaitingGates } from '@tinyagi/core';

const gateRoutes = new Hono();

gateRoutes.post('/', async (c) => {
    const body = await c.req.json();
    const { teamId, agentId, channel, messageId, threadId, originalTask, worktreePath } = body;
    if (!teamId || !agentId || !channel || !messageId || !originalTask) {
        return c.json({ error: 'Missing required fields' }, 400);
    }
    const id = createGateRequest(teamId, agentId, channel, messageId, threadId ?? null, originalTask, worktreePath ?? null);
    return c.json({ id, status: 'waiting' });
});

gateRoutes.get('/message/:messageId', async (c) => {
    const messageId = c.req.param('messageId');
    const gate = getGateByMessageId(messageId);
    if (!gate) return c.json({ error: 'Not found' }, 404);
    return c.json(gate);
});

gateRoutes.post('/:id/approve', async (c) => {
    const id = c.req.param('id');
    approveGate(id);
    return c.json({ status: 'approved' });
});

gateRoutes.post('/:id/reject', async (c) => {
    const id = c.req.param('id');
    rejectGate(id);
    return c.json({ status: 'rejected' });
});

gateRoutes.get('/waiting', async (c) => {
    const gates = getWaitingGates();
    return c.json(gates);
});

export { gateRoutes };
```

- [ ] **Step 3: Mount the route**

In `packages/server/src/index.ts`, import and mount the gate routes alongside the existing pipeline routes. Add:

```typescript
import { gateRoutes } from './routes/gate';
```

And mount:

```typescript
app.route('/api/gate', gateRoutes);
```

- [ ] **Step 4: Build to verify**

Run: `npm run build -w @tinyagi/server`
Expected: Clean build.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/routes/gate.ts packages/server/src/index.ts
git commit -m "feat(workflow): add gate API endpoints"
```

---

### Task 6: Wire workflow detection in processMessage

**Files:**
- Modify: `packages/main/src/index.ts:45-193` (processMessage)
- Modify: `packages/core/src/response.ts:52-93` (streamResponse — add metadata passthrough)

This is the core wiring. When a workflow team's agent responds (non-resume), metadata is attached to the response so Discord can create the gate. When resuming, the worktree path and `-c` flag are applied.

- [ ] **Step 1: Add metadata passthrough to streamResponse**

In `packages/core/src/response.ts`, update the `streamResponse` options type at line 52 to accept caller metadata:

```typescript
export async function streamResponse(response: string, options: {
    channel: string;
    sender: string;
    senderId?: string;
    messageId: string;
    originalMessage: string;
    agentId: string;
    transform?: (text: string) => string;
    extraMetadata?: Record<string, unknown>;
}): Promise<void> {
```

Then at line 88, merge `extraMetadata` into the response's metadata:

```typescript
    const allMetadata = { ...metadata, ...options.extraMetadata };
    enqueueResponse({
        channel: options.channel,
        sender: options.sender,
        senderId: options.senderId,
        message: responseMessage,
        originalMessage: options.originalMessage,
        messageId: options.messageId,
        agent: options.agentId,
        files: allFiles.length > 0 ? allFiles : undefined,
        metadata: Object.keys(allMetadata).length > 0 ? allMetadata : undefined,
    });
```

- [ ] **Step 2: Add imports to processMessage**

In `packages/main/src/index.ts`, add `initGateDb` to the imports from `@tinyagi/core` (line 25):

```typescript
    initPipelineDb, createPipelineRun, getActivePipelineRun,
    failPipelineRun, getPipelineRun,
    recoverRunningPipelines, enqueueMessage, genId,
    hasPendingPipelineMessage,
    initGateDb,
```

- [ ] **Step 3: Initialize gate DB at startup**

In `packages/main/src/index.ts`, after `initPipelineDb();` (line 286), add:

```typescript
initGateDb();
```

- [ ] **Step 4: Apply resume flags in processMessage**

In `packages/main/src/index.ts`, in the `processMessage` function, after the `shouldReset` determination (line 135), add resume override:

```typescript
    const agentResetFlag = getAgentResetFlag(agentId, workspacePath);
    let shouldReset = fs.existsSync(agentResetFlag);
    if (shouldReset) {
        fs.unlinkSync(agentResetFlag);
    }

    // Workflow resume: force continue conversation
    if (data.resume) {
        shouldReset = false;
    }
```

Note: change `const shouldReset` to `let shouldReset` since we may override it.

- [ ] **Step 5: Override working directory for worktree**

In `packages/core/src/invoke.ts`, update the working directory resolution at line 203 to check for worktree path. The worktree path needs to be threaded through. The simplest approach: if `agent.working_directory` is set AND the caller has a worktree path, the worktree path takes precedence. Pass it via a new optional parameter.

Update the `invokeAgent` signature at line 181:

```typescript
export async function invokeAgent(
    agent: AgentConfig,
    agentId: string,
    message: string,
    workspacePath: string,
    shouldReset: boolean,
    agents: Record<string, AgentConfig> = {},
    teams: Record<string, TeamConfig> = {},
    onEvent?: (text: string) => void,
    worktreePathOverride?: string,
): Promise<string> {
```

Then at line 203, update working directory resolution:

```typescript
    const workingDir = worktreePathOverride
        || (agent.working_directory
            ? (path.isAbsolute(agent.working_directory)
                ? agent.working_directory
                : path.join(workspacePath, agent.working_directory))
            : agentDir);
```

- [ ] **Step 6: Pass worktreePath from processMessage to invokeAgent**

In `packages/main/src/index.ts`, update the `invokeAgent` call at line 145:

```typescript
        response = await invokeAgent(agent, agentId, message, workspacePath, shouldReset, agents, teams, (text) => {
            log('INFO', `Agent ${agentId}: ${text}`);
            insertAgentMessage({ agentId, role: 'assistant', channel, sender: agentId, messageId, content: text });
            emitEvent('agent:progress', { agentId, agentName: agent.name, text, messageId });
            sendDirectResponse(text, {
                channel, sender, senderId: data.senderId,
                messageId, originalMessage: rawMessage, agentId,
            });
        }, data.worktreePath);
```

- [ ] **Step 7: Add workflow gate metadata to final response**

In `packages/main/src/index.ts`, update `sendDirectResponse` to accept optional extra metadata, and pass workflow gate info when applicable.

Update the `sendDirectResponse` helper at line 197:

```typescript
async function sendDirectResponse(
    response: string,
    ctx: { channel: string; sender: string; senderId?: string | null; messageId: string; originalMessage: string; agentId: string },
    extraMetadata?: Record<string, unknown>,
): Promise<void> {
    const signed = `${response}\n\n- [${ctx.agentId}]`;
    await streamResponse(signed, {
        channel: ctx.channel,
        sender: ctx.sender,
        senderId: ctx.senderId ?? undefined,
        messageId: ctx.messageId,
        originalMessage: ctx.originalMessage,
        agentId: ctx.agentId,
        extraMetadata,
    });
}
```

- [ ] **Step 8: Detect workflow team and inject gate metadata in final response**

After the `invokeAgent` try/catch block and before the `handleTeamResponse` call (around line 185), add workflow gate detection. This goes after the `emitEvent('agent:response', ...)` block:

```typescript
    // ── Workflow gate ─────────────────────────────────────────────────────────
    // For workflow teams on non-resume invocations, mark the final response
    // so Discord can create a gate record and add a ✅ reaction.
    if (!data.resume) {
        for (const [teamId, team] of Object.entries(teams)) {
            if (team.workflow && team.agents.includes(agentId)) {
                // Send a final gate summary response with metadata
                await sendDirectResponse(
                    '---\n✅ **Awaiting deployment approval.** React with ✅ to approve or ❌ to reject.',
                    { channel, sender, senderId: data.senderId, messageId, originalMessage: rawMessage, agentId },
                    {
                        workflowGate: true,
                        teamId,
                        agentId,
                        originalTask: rawMessage,
                        worktreePath: data.worktreePath,
                    },
                );
                break;
            }
        }
    }
```

- [ ] **Step 9: Build to verify**

Run: `npm run build -w @tinyagi/core && npm run build -w @tinyagi/main`
Expected: Clean build.

- [ ] **Step 10: Commit**

```bash
git add packages/core/src/response.ts packages/core/src/invoke.ts packages/main/src/index.ts
git commit -m "feat(workflow): wire workflow detection, resume, and gate metadata in processMessage"
```

---

### Task 7: Discord reaction handler and gate creation

**Files:**
- Modify: `packages/channels/src/discord.ts:339-350` (client intents/partials)
- Modify: `packages/channels/src/discord.ts:601-697` (checkOutgoingQueue — gate creation on delivery)
- Add: reaction event handler (new block after messageCreate handler)

- [ ] **Step 1: Add reaction intents and partials**

In `packages/channels/src/discord.ts`, update the client constructor at line 339:

```typescript
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
```

- [ ] **Step 2: Update imports**

At the top of `discord.ts`, ensure `GatewayIntentBits` includes `GuildMessageReactions` and `Partials` includes `Reaction`. These should already be available from the discord.js import. No code change needed — just verify the import line includes them.

- [ ] **Step 3: Create gate record on response delivery**

In `packages/channels/src/discord.ts`, in the `checkOutgoingQueue` function, after a response is successfully sent (around line 677, after the message splitting loop), add gate creation logic. Capture the sent message to get its Discord ID:

Replace the send logic (around lines 667-677) to capture the sent message:

```typescript
                    if (responseText) {
                        const chunks = splitMessage(responseText);
                        let sentMessage: Message | undefined;

                        if (chunks.length > 0) {
                            if (pending && !pending.isGuild) {
                                sentMessage = await pending.message.reply(chunks[0]!);
                            } else {
                                sentMessage = await responseChannel.send(chunks[0]!);
                            }
                        }
                        for (let i = 1; i < chunks.length; i++) {
                            sentMessage = await responseChannel.send(chunks[i]!);
                        }

                        // Workflow gate: create gate record and add reaction
                        if (sentMessage && resp.metadata?.workflowGate) {
                            const meta = resp.metadata;
                            try {
                                await fetch(`${API_BASE}/api/gate`, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({
                                        teamId: meta.teamId,
                                        agentId: meta.agentId,
                                        channel: 'discord',
                                        messageId: sentMessage.id,
                                        threadId: sentMessage.channel.isThread() ? sentMessage.channel.id : null,
                                        originalTask: meta.originalTask,
                                        worktreePath: meta.worktreePath ?? null,
                                    }),
                                });
                                await sentMessage.react('✅');
                                log('INFO', `Gate created for workflow response (Discord msg: ${sentMessage.id})`);
                            } catch (gateErr) {
                                log('ERROR', `Failed to create gate: ${(gateErr as Error).message}`);
                            }
                        }
                    }
```

- [ ] **Step 4: Add reaction event handler**

After the `client.on(Events.MessageCreate, ...)` handler block (after line ~599), add the reaction handler:

```typescript
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
            // Approve gate
            await fetch(`${API_BASE}/api/gate/${gate.id}/approve`, { method: 'POST' });

            // Enqueue resume message
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

            log('INFO', `Gate ${gate.id} approved by ${user.tag}, resuming agent ${gate.agent_id}`);

            // Reply in thread
            const channel = reaction.message.channel;
            if (channel.isTextBased()) {
                await channel.send(`✅ Deployment approved by <@${user.id}>. Resuming workflow...`);
            }
        } else if (emoji === '❌') {
            // Reject gate
            await fetch(`${API_BASE}/api/gate/${gate.id}/reject`, { method: 'POST' });
            log('INFO', `Gate ${gate.id} rejected by ${user.tag}`);

            const channel = reaction.message.channel;
            if (channel.isTextBased()) {
                await channel.send(`❌ Deployment rejected by <@${user.id}>. Use \`@${gate.team_id} /gate <feedback>\` to provide guidance.`);
            }
        }
    } catch (error) {
        log('ERROR', `Reaction handler error: ${(error as Error).message}`);
    }
});
```

- [ ] **Step 5: Ensure /api/message endpoint accepts resume and worktreePath**

Check the message endpoint in `packages/server/src/routes/` to ensure it passes `resume` and `worktreePath` through to `enqueueMessage`. If not, update it to include these fields from the request body.

- [ ] **Step 6: Build to verify**

Run: `npm run build -w @tinyagi/channels`
Expected: Clean build.

- [ ] **Step 7: Commit**

```bash
git add packages/channels/src/discord.ts
git commit -m "feat(workflow): add Discord reaction handler for gate approval/rejection"
```

---

### Task 8: Write CLAUDE.md workflow templates

**Files:**
- Create: `~/.tinyagi/.agents/arksignal-dev/.claude/CLAUDE.md`
- Create: `~/.tinyagi/.agents/arkpoly-dev/.claude/CLAUDE.md`

These are NOT committed to the repo — they live in the agent's workspace directory on the host machine. Store templates in the repo for reference.

- [ ] **Step 1: Create template directory in repo**

Create `templates/workflow/` in the tinyagi repo to store reference copies.

- [ ] **Step 2: Write ArkSignal CLAUDE.md template**

Create `templates/workflow/arksignal-dev-CLAUDE.md`:

```markdown
# ArkSignal Developer — Autonomous Workflow

You are an autonomous development agent for the Trading-Signal-AI project. When you receive a TaskNote ticker (e.g., "Arksignal-080"), follow this workflow exactly.

## Phase 1: Understand

1. Parse the ticker from the message (e.g., `Arksignal-080` → look for `ArkSignal-080-*.md`)
2. Read the epic from `vault/TaskNotes/Tasks/Epic/ArkSignal-080-*.md`
3. Parse YAML frontmatter: check `status`, `priority`, `blockedBy`
4. If any `blockedBy` dependencies have status other than `done`, STOP and report: "Blocked by {taskId} (status: {status})"
5. Follow `[[wikilinks]]` to read all linked stories in `vault/TaskNotes/Tasks/Story/`
6. Collect all acceptance criteria (lines starting with `- [ ]`)
7. Read any referenced specs or plans
8. Create a git worktree: `git worktree add ../../worktrees/arksignal-080 -b arksignal-080`
9. Change to the worktree directory for all subsequent work

## Phase 2: Implement

10. Check if a plan already exists in `docs/superpowers/plans/` for this epic
11. If no plan exists: use `/write-plan` skill to create one
12. Execute the plan using `/execute-plan` skill
13. Run code review: `/code-review --thorough`
14. Fix all issues found
15. Re-run code review until clean (max 3 iterations)

## Phase 3: Human Gate

16. Compose a deploy-ready summary including:
    - Epic title and stories addressed
    - `git diff --stat` output
    - Test results
    - Code review status (clean/issues remaining)
    - Key decisions made during implementation
17. Output the summary clearly
18. STOP HERE. Your session will end. A human will review and react with ✅ to approve deployment.

---

## Phase 4: Deploy & Validate

*You are resuming after human approval. Start by re-orienting.*

19. Re-read the plan/spec files to refresh context
20. Review `git diff --stat` to remind yourself what changed
21. Deploy to staging first:
    ```bash
    python scripts/deployment/deploy_ct110.py --staging
    python scripts/deployment/staging_smoke_test.py
    ```
22. If staging passes, promote to production:
    ```bash
    python scripts/deployment/promote_to_production.py
    ```
23. Capture health check output as evidence:
    ```bash
    ssh root@192.168.68.10 "pct exec 100 -- curl -s http://localhost:8811/health"
    ssh root@192.168.68.10 "pct exec 100 -- curl -s http://localhost:8812/health"
    ssh root@192.168.68.10 "pct exec 100 -- curl -s http://localhost:8766/health"
    ```
24. Save health check results to `./evidence/health-checks.txt`
25. Run QA via Pi CLI:
    ```bash
    pi "Review this diff for bugs, logic errors, and regressions against these acceptance criteria: $(cat acceptance_criteria.txt). Diff: $(git diff main..HEAD)"
    ```
26. Capture Pi's output to `./evidence/qa-review.txt`
27. If Pi finds issues: fix them, re-deploy, re-QA (max 2 iterations)

## Phase 5: Wrap Up

28. Run `/codebase-maintenance --full` to update Obsidian docs
29. Update the TaskNote frontmatter: set `status: done`
30. Create a PR:
    ```bash
    gh pr create \
      --title "[Arksignal-080] <epic title>" \
      --body "## Summary\n<description>\n\n## Evidence\n<paste health check + QA results>\n\n## Acceptance Criteria\n<checklist>"
    ```
31. If evidence screenshots exist in `./evidence/`, attach them as PR comments
32. Clean up worktree: `cd ../.. && git worktree remove worktrees/arksignal-080`

## Rules

- NEVER skip the human gate. Always stop after Phase 3.
- If deployment fails, attempt rollback: `python scripts/deployment/deploy_ct100.py --rollback <tag>`
- If you encounter an error you can't resolve, report it clearly and stop.
- Always work inside the git worktree, never on main directly.
- Commit frequently with descriptive messages during implementation.
```

- [ ] **Step 3: Write ArkPoly CLAUDE.md template**

Create `templates/workflow/arkpoly-dev-CLAUDE.md` with the same structure but ArkPoly-specific deploy commands. Replace:
- Ticker prefix: `ArkPoly-XXX` instead of `ArkSignal-XXX`
- Deploy commands: repo-specific (TBD — leave placeholder with comment)
- Health check URLs: repo-specific (TBD — leave placeholder)

- [ ] **Step 4: Commit templates**

```bash
git add templates/workflow/
git commit -m "docs(workflow): add CLAUDE.md workflow templates for ArkSignal and ArkPoly agents"
```

---

### Task 9: Initialize gate DB on startup and add stale gate expiry

**Files:**
- Modify: `packages/main/src/index.ts:285-338` (startup section)

- [ ] **Step 1: Add gate expiry to maintenance interval**

In `packages/main/src/index.ts`, import `expireStaleGates` from `@tinyagi/core` (add to the existing import block at line 25).

- [ ] **Step 2: Add gate expiry to the maintenance interval**

At line 355, the existing maintenance interval prunes old records. Add gate expiry:

```typescript
const maintenanceInterval = setInterval(() => {
    pruneAckedResponses();
    pruneCompletedMessages();
    // Expire gates waiting longer than 7 days
    const expired = expireStaleGates(7 * 24 * 60 * 60 * 1000);
    if (expired > 0) log('INFO', `Expired ${expired} stale gate(s)`);
}, 60 * 1000);
```

- [ ] **Step 3: Build to verify**

Run: `npm run build -w @tinyagi/main`
Expected: Clean build.

- [ ] **Step 4: Commit**

```bash
git add packages/main/src/index.ts
git commit -m "feat(workflow): add gate DB init and stale gate expiry on startup"
```

---

### Task 10: End-to-end integration verification

**Files:** None (manual testing)

- [ ] **Step 1: Add agent configs to test settings**

Add the `arksignal-dev` and `arkpoly-dev` agent configs plus team configs with `workflow: true` to your local `~/.tinyagi/settings.json`.

- [ ] **Step 2: Set up agent workspace**

Create the workspace directories:

```bash
mkdir -p ~/.tinyagi/.agents/arksignal-dev/.claude
mkdir -p ~/.tinyagi/.agents/arksignal-dev/worktrees
mkdir -p ~/.tinyagi/.agents/arksignal-dev/memory
ln -s ~/GIT/ArkNode-AI/projects/trading-signal-ai ~/.tinyagi/.agents/arksignal-dev/workspace
cp templates/workflow/arksignal-dev-CLAUDE.md ~/.tinyagi/.agents/arksignal-dev/.claude/CLAUDE.md
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: All packages build cleanly.

- [ ] **Step 4: Start TinyAGI and test**

Start the queue processor, send a test message in the mapped Discord channel (e.g., `Arksignal-080`), and verify:
1. Agent picks up the message and invokes Claude Code CLI
2. Agent's progressive responses appear in Discord thread
3. After agent completes, a gate message appears with ✅ reaction
4. Reacting with ✅ resumes the agent with `-c` flag
5. Agent continues from Phase 4

- [ ] **Step 5: Commit any fixes**

```bash
git add -A
git commit -m "fix(workflow): integration fixes from end-to-end testing"
```
