# Pipeline Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add sequential pipeline execution mode to teams where agents run in a system-enforced order, with progressive response delivery, error recovery, and pipeline commands.

**Architecture:** Pipeline state lives in a new `pipeline_runs` SQLite table (same DB as the message queue). Pipeline initiation happens in `processMessage` (main package), stage progression in `handleTeamResponse` (teams package), and pipeline commands are handled via new API endpoints called from channel clients.

**Tech Stack:** TypeScript, SQLite (better-sqlite3), Hono (API routes), vitest (new — for pipeline CRUD tests)

**Spec:** `docs/superpowers/specs/2026-03-25-pipeline-mode-design.md`

---

### Task 1: Add pipeline types

**Files:**
- Modify: `packages/core/src/types.ts:22-26` (TeamConfig)
- Modify: `packages/core/src/types.ts:113-121` (MessageJobData)

- [ ] **Step 1: Add `mode` and `pipeline` to TeamConfig**

In `packages/core/src/types.ts`, update the `TeamConfig` interface:

```typescript
export interface TeamConfig {
    name: string;
    agents: string[];
    leader_agent: string;
    mode?: 'collaborative' | 'pipeline';
    pipeline?: string[];
}
```

- [ ] **Step 2: Add `pipelineRunId` to MessageJobData**

In the same file, update the `MessageJobData` interface:

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
}
```

- [ ] **Step 3: Build to verify**

Run: `npm run build -w @tinyagi/core`
Expected: Clean build, no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/types.ts
git commit -m "feat(pipeline): add mode, pipeline, pipelineRunId to types"
```

---

### Task 2: Thread pipelineRunId through the message queue

**Files:**
- Modify: `packages/core/src/queues.ts:18-77` (initQueueDb — add migration)
- Modify: `packages/core/src/queues.ts:79-82` (getDb — export it)
- Modify: `packages/core/src/queues.ts:86-102` (enqueueMessage — thread pipelineRunId)

- [ ] **Step 1: Export `getDb` from queues.ts**

Change `function getDb()` (line 79) from a private function to an exported function. The pipeline module needs to access the same DB handle.

```typescript
export function getDb(): Database.Database {
    if (!db) throw new Error('Queue DB not initialized — call initQueueDb() first');
    return db;
}
```

- [ ] **Step 2: Add `pipeline_run_id` column migration to `initQueueDb`**

Add this migration at the end of `initQueueDb()`, after the existing migrations (after line 76):

```typescript
    if (!msgCols.some(c => c.name === 'pipeline_run_id')) {
        db.exec('ALTER TABLE messages ADD COLUMN pipeline_run_id TEXT');
    }
```

Note: `msgCols` is already defined on line 70. This reuses it.

- [ ] **Step 3: Thread `pipelineRunId` through `enqueueMessage`**

Update the `enqueueMessage` function to include `pipeline_run_id` in the INSERT:

```typescript
export function enqueueMessage(data: MessageJobData): number | null {
    const now = Date.now();
    try {
        const r = getDb().prepare(
            `INSERT INTO messages (message_id,channel,sender,sender_id,message,agent,from_agent,pipeline_run_id,status,created_at,updated_at)
             VALUES (?,?,?,?,?,?,?,?,'pending',?,?)`
        ).run(data.messageId, data.channel, data.sender, data.senderId ?? null, data.message,
            data.agent ?? null, data.fromAgent ?? null, data.pipelineRunId ?? null, now, now);
        queueEvents.emit('message:enqueued', { id: r.lastInsertRowid, agent: data.agent });
        return r.lastInsertRowid as number;
    } catch (err: any) {
        if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            return null; // duplicate messageId — already enqueued
        }
        throw err;
    }
}
```

- [ ] **Step 4: Build to verify**

Run: `npm run build -w @tinyagi/core`
Expected: Clean build.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/queues.ts
git commit -m "feat(pipeline): export getDb, add pipeline_run_id column, thread through enqueue"
```

---

### Task 3: Set up vitest for core package

**Files:**
- Modify: `packages/core/package.json` (add vitest devDep + test script)
- Create: `packages/core/vitest.config.ts`

- [ ] **Step 1: Install vitest**

Run: `npm install -D vitest -w @tinyagi/core`

- [ ] **Step 2: Add test script to package.json**

In `packages/core/package.json`, add a `test` script to the `scripts` block:

```json
{
  "scripts": {
    "build": "tsc",
    "dev": "tsc -w",
    "test": "vitest run"
  }
}
```

- [ ] **Step 3: Create vitest config**

Create `packages/core/vitest.config.ts`:

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
    },
});
```

- [ ] **Step 4: Verify vitest runs**

Run: `npm test -w @tinyagi/core`
Expected: "No test files found" or similar (no tests yet, but vitest itself should run).

- [ ] **Step 5: Commit**

```bash
git add packages/core/package.json packages/core/vitest.config.ts
git commit -m "chore(core): add vitest for unit testing"
```

---

### Task 4: Pipeline state CRUD with tests

**Files:**
- Create: `packages/core/src/pipeline.ts`
- Create: `packages/core/src/__tests__/pipeline.test.ts`

This is the core of the feature — all pipeline state management. TDD approach: write tests first, then implement.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/__tests__/pipeline.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initQueueDb, closeQueueDb } from '../queues';
import {
    initPipelineDb,
    createPipelineRun,
    getPipelineRun,
    advancePipelineStage,
    completePipelineRun,
    failPipelineRun,
    getActivePipelineRun,
    getFailedPipelineRun,
    recoverRunningPipelines,
    getMostRecentRun,
} from '../pipeline';

// Use in-memory DB via env override
process.env.TINYAGI_HOME = '/tmp/tinyagi-test-' + Date.now();

import fs from 'fs';
fs.mkdirSync(process.env.TINYAGI_HOME, { recursive: true });

beforeAll(() => {
    initQueueDb();
    initPipelineDb();
});

afterAll(() => {
    closeQueueDb();
    fs.rmSync(process.env.TINYAGI_HOME!, { recursive: true, force: true });
});

describe('pipeline CRUD', () => {
    it('creates a pipeline run and retrieves it', () => {
        const id = createPipelineRun('dev', 'discord', 'alice', 'alice123', 'msg_1', 'fix the bug', ['planner', 'reviewer', 'qa']);
        expect(id).toMatch(/^pipeline_/);

        const run = getPipelineRun(id);
        expect(run).not.toBeNull();
        expect(run!.team_id).toBe('dev');
        expect(run!.channel).toBe('discord');
        expect(run!.sender).toBe('alice');
        expect(run!.sender_id).toBe('alice123');
        expect(run!.original_message).toBe('fix the bug');
        expect(run!.pipeline).toEqual(['planner', 'reviewer', 'qa']);
        expect(run!.current_stage).toBe(0);
        expect(run!.status).toBe('running');
        expect(run!.last_response).toBeNull();
        expect(run!.error).toBeNull();
    });

    it('advances pipeline stage', () => {
        const id = createPipelineRun('dev', 'discord', 'alice', undefined, 'msg_2', 'task 2', ['a', 'b', 'c']);
        advancePipelineStage(id, 'response from stage 0');

        const run = getPipelineRun(id)!;
        expect(run.current_stage).toBe(1);
        expect(run.last_response).toBe('response from stage 0');
        expect(run.status).toBe('running');
    });

    it('completes a pipeline run', () => {
        const id = createPipelineRun('dev', 'discord', 'alice', undefined, 'msg_3', 'task 3', ['a', 'b']);
        completePipelineRun(id, 'final response');

        const run = getPipelineRun(id)!;
        expect(run.status).toBe('completed');
        expect(run.last_response).toBe('final response');
    });

    it('fails a pipeline run', () => {
        const id = createPipelineRun('dev', 'discord', 'alice', undefined, 'msg_4', 'task 4', ['a', 'b']);
        failPipelineRun(id, 'agent crashed');

        const run = getPipelineRun(id)!;
        expect(run.status).toBe('failed');
        expect(run.error).toBe('agent crashed');
    });

    it('getActivePipelineRun returns the running run for a team', () => {
        const id = createPipelineRun('active-team', 'discord', 'bob', undefined, 'msg_5', 'task 5', ['x', 'y']);

        const active = getActivePipelineRun('active-team');
        expect(active).not.toBeNull();
        expect(active!.id).toBe(id);

        // Complete it — should no longer be active
        completePipelineRun(id, 'done');
        expect(getActivePipelineRun('active-team')).toBeNull();
    });

    it('getFailedPipelineRun returns the most recent failed run', () => {
        const id = createPipelineRun('fail-team', 'discord', 'bob', undefined, 'msg_6', 'task 6', ['x', 'y']);
        failPipelineRun(id, 'oops');

        const failed = getFailedPipelineRun('fail-team');
        expect(failed).not.toBeNull();
        expect(failed!.id).toBe(id);
        expect(failed!.error).toBe('oops');
    });

    it('recoverRunningPipelines returns all running runs', () => {
        const id1 = createPipelineRun('recover-1', 'discord', 'bob', undefined, 'msg_7', 'task 7', ['a']);
        const id2 = createPipelineRun('recover-2', 'discord', 'bob', undefined, 'msg_8', 'task 8', ['b']);

        const running = recoverRunningPipelines();
        const ids = running.map(r => r.id);
        expect(ids).toContain(id1);
        expect(ids).toContain(id2);
    });

    it('getMostRecentRun returns the latest run regardless of status', () => {
        const id1 = createPipelineRun('recent-team', 'discord', 'bob', undefined, 'msg_9', 'task 9', ['a']);
        completePipelineRun(id1, 'done');
        const id2 = createPipelineRun('recent-team', 'discord', 'bob', undefined, 'msg_10', 'task 10', ['b']);
        failPipelineRun(id2, 'fail');

        const recent = getMostRecentRun('recent-team');
        expect(recent).not.toBeNull();
        expect(recent!.id).toBe(id2);
    });

    it('returns null for non-existent run', () => {
        expect(getPipelineRun('nonexistent')).toBeNull();
    });

    it('returns null for team with no runs', () => {
        expect(getActivePipelineRun('no-such-team')).toBeNull();
        expect(getFailedPipelineRun('no-such-team')).toBeNull();
        expect(getMostRecentRun('no-such-team')).toBeNull();
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w @tinyagi/core`
Expected: FAIL — cannot find module `../pipeline`.

- [ ] **Step 3: Implement pipeline.ts**

Create `packages/core/src/pipeline.ts`:

```typescript
/**
 * Pipeline state persistence — pipeline_runs table + CRUD.
 * Reuses the SQLite DB handle from queues.ts.
 */

import { getDb } from './queues';
import { genId } from './ids';

export interface PipelineRun {
    id: string;
    team_id: string;
    channel: string;
    sender: string;
    sender_id: string | null;
    message_id: string;
    original_message: string;
    pipeline: string[];
    current_stage: number;
    status: 'running' | 'completed' | 'failed';
    last_response: string | null;
    error: string | null;
    created_at: number;
    updated_at: number;
}

export function initPipelineDb(): void {
    const db = getDb();
    db.exec(`
        CREATE TABLE IF NOT EXISTS pipeline_runs (
            id TEXT PRIMARY KEY,
            team_id TEXT NOT NULL,
            channel TEXT NOT NULL,
            sender TEXT NOT NULL,
            sender_id TEXT,
            message_id TEXT NOT NULL,
            original_message TEXT NOT NULL,
            pipeline JSON NOT NULL,
            current_stage INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'running',
            last_response TEXT,
            error TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_pipeline_team ON pipeline_runs(team_id, status);
    `);
}

export function createPipelineRun(
    teamId: string,
    channel: string,
    sender: string,
    senderId: string | undefined,
    messageId: string,
    originalMessage: string,
    pipeline: string[],
): string {
    const id = genId('pipeline');
    const now = Date.now();
    getDb().prepare(
        `INSERT INTO pipeline_runs (id, team_id, channel, sender, sender_id, message_id, original_message, pipeline, current_stage, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'running', ?, ?)`
    ).run(id, teamId, channel, sender, senderId ?? null, messageId, originalMessage, JSON.stringify(pipeline), now, now);
    return id;
}

export function advancePipelineStage(runId: string, response: string): void {
    getDb().prepare(
        `UPDATE pipeline_runs SET current_stage = current_stage + 1, last_response = ?, updated_at = ? WHERE id = ?`
    ).run(response, Date.now(), runId);
}

export function completePipelineRun(runId: string, response: string): void {
    getDb().prepare(
        `UPDATE pipeline_runs SET status = 'completed', last_response = ?, updated_at = ? WHERE id = ?`
    ).run(response, Date.now(), runId);
}

export function failPipelineRun(runId: string, error: string): void {
    getDb().prepare(
        `UPDATE pipeline_runs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`
    ).run(error, Date.now(), runId);
}

function hydrateRun(row: any): PipelineRun | null {
    if (!row) return null;
    return { ...row, pipeline: JSON.parse(row.pipeline) };
}

export function getPipelineRun(runId: string): PipelineRun | null {
    return hydrateRun(getDb().prepare('SELECT * FROM pipeline_runs WHERE id = ?').get(runId));
}

export function getActivePipelineRun(teamId: string): PipelineRun | null {
    return hydrateRun(getDb().prepare(
        `SELECT * FROM pipeline_runs WHERE team_id = ? AND status = 'running' ORDER BY created_at DESC LIMIT 1`
    ).get(teamId));
}

export function getFailedPipelineRun(teamId: string): PipelineRun | null {
    return hydrateRun(getDb().prepare(
        `SELECT * FROM pipeline_runs WHERE team_id = ? AND status = 'failed' ORDER BY created_at DESC LIMIT 1`
    ).get(teamId));
}

export function recoverRunningPipelines(): PipelineRun[] {
    const rows = getDb().prepare(
        `SELECT * FROM pipeline_runs WHERE status = 'running'`
    ).all() as any[];
    return rows.map(hydrateRun).filter((r): r is PipelineRun => r !== null);
}

export function getMostRecentRun(teamId: string): PipelineRun | null {
    return hydrateRun(getDb().prepare(
        `SELECT * FROM pipeline_runs WHERE team_id = ? ORDER BY created_at DESC LIMIT 1`
    ).get(teamId));
}

/**
 * Reset a failed run back to 'running' for retry.
 * Does NOT change current_stage — the caller re-enqueues at the same stage.
 */
export function retryPipelineRun(runId: string): void {
    getDb().prepare(
        `UPDATE pipeline_runs SET status = 'running', error = NULL, updated_at = ? WHERE id = ?`
    ).run(Date.now(), runId);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w @tinyagi/core`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/pipeline.ts packages/core/src/__tests__/pipeline.test.ts
git commit -m "feat(pipeline): add pipeline_runs CRUD with tests"
```

---

### Task 5: Export pipeline module from core barrel

**Files:**
- Modify: `packages/core/src/index.ts:21` (add pipeline export)

- [ ] **Step 1: Add pipeline export**

In `packages/core/src/index.ts`, add after the `export * from './schedules';` line:

```typescript
export * from './pipeline';
```

- [ ] **Step 2: Build to verify**

Run: `npm run build -w @tinyagi/core`
Expected: Clean build.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/index.ts
git commit -m "feat(pipeline): export pipeline module from core barrel"
```

---

### Task 6: Pipeline API endpoints

**Files:**
- Create: `packages/server/src/routes/pipeline.ts`
- Modify: `packages/server/src/index.ts:29` (import + mount pipeline routes)

The channel clients (Discord, Telegram) communicate with the queue processor via HTTP API. Pipeline commands (`/status`, `/retry`, `/restart`) need API endpoints.

- [ ] **Step 1: Create pipeline route file**

Create `packages/server/src/routes/pipeline.ts`:

```typescript
import { Hono } from 'hono';
import {
    getTeams, getSettings, log, enqueueMessage, genId,
    getActivePipelineRun, getFailedPipelineRun, getMostRecentRun,
    getPipelineRun, createPipelineRun, retryPipelineRun,
} from '@tinyagi/core';

const app = new Hono();

// GET /api/pipeline/:teamId/status
app.get('/api/pipeline/:teamId/status', (c) => {
    const teamId = c.req.param('teamId');
    const teams = getTeams(getSettings());
    const team = teams[teamId];
    if (!team || team.mode !== 'pipeline') {
        return c.json({ error: `Team '${teamId}' is not a pipeline-mode team` }, 400);
    }

    // Check active first, then most recent
    const active = getActivePipelineRun(teamId);
    if (active) {
        const total = active.pipeline.length;
        const agentId = active.pipeline[active.current_stage];
        return c.json({
            message: `Pipeline @${teamId}: stage ${active.current_stage + 1}/${total} (@${agentId}) — running`,
            run: active,
        });
    }

    const recent = getMostRecentRun(teamId);
    if (recent) {
        const total = recent.pipeline.length;
        const agentId = recent.pipeline[recent.current_stage];
        const statusLabel = recent.status === 'failed'
            ? `failed: ${recent.error}`
            : recent.status;
        return c.json({
            message: `Pipeline @${teamId}: stage ${recent.current_stage + 1}/${total} (@${agentId}) — ${statusLabel}`,
            run: recent,
        });
    }

    return c.json({ message: `No pipeline runs found for @${teamId}.`, run: null });
});

// POST /api/pipeline/:teamId/retry
app.post('/api/pipeline/:teamId/retry', async (c) => {
    const teamId = c.req.param('teamId');
    const teams = getTeams(getSettings());
    const team = teams[teamId];
    if (!team || team.mode !== 'pipeline') {
        return c.json({ error: `Team '${teamId}' is not a pipeline-mode team` }, 400);
    }

    const body = await c.req.json().catch(() => ({})) as {
        channel?: string; sender?: string; senderId?: string;
    };

    // Reject if a run is already active
    const active = getActivePipelineRun(teamId);
    if (active) {
        return c.json({ message: `Pipeline already running for @${teamId}. Use @${teamId} /status to check progress.` }, 409);
    }

    const failed = getFailedPipelineRun(teamId);
    if (!failed) {
        return c.json({ message: 'No failed pipeline to retry.' }, 404);
    }

    // Reset run status to running
    retryPipelineRun(failed.id);

    // Build the message for the failed stage
    const stage = failed.current_stage;
    const total = failed.pipeline.length;
    const agentId = failed.pipeline[stage];
    let message: string;
    if (stage === 0) {
        message = failed.original_message;
    } else {
        message = `[Pipeline stage ${stage + 1}/${total} — retry]\nPrevious agent's response:\n---\n${failed.last_response}\n---\n\nOriginal task:\n${failed.original_message}`;
    }

    enqueueMessage({
        channel: body.channel || failed.channel,
        sender: body.sender || failed.sender,
        senderId: body.senderId || failed.sender_id || undefined,
        message,
        messageId: genId('pipeline'),
        agent: agentId,
        pipelineRunId: failed.id,
    });

    log('INFO', `[API] Pipeline retry: ${failed.id} at stage ${stage + 1}/${total}`);
    return c.json({
        message: `Retrying pipeline @${teamId} at stage ${stage + 1}/${total} (@${agentId}).`,
        runId: failed.id,
    });
});

// POST /api/pipeline/:teamId/restart
app.post('/api/pipeline/:teamId/restart', async (c) => {
    const teamId = c.req.param('teamId');
    const teams = getTeams(getSettings());
    const team = teams[teamId];
    if (!team || team.mode !== 'pipeline') {
        return c.json({ error: `Team '${teamId}' is not a pipeline-mode team` }, 400);
    }
    if (!team.pipeline || team.pipeline.length === 0) {
        return c.json({ error: `Team '${teamId}' has no pipeline configured` }, 400);
    }

    // Reject if a run is already active
    const active = getActivePipelineRun(teamId);
    if (active) {
        return c.json({ message: `Pipeline already running for @${teamId}. Use @${teamId} /status to check progress.` }, 409);
    }

    const body = await c.req.json().catch(() => ({})) as {
        message?: string; channel?: string; sender?: string; senderId?: string;
    };

    let originalMessage = body.message;
    if (!originalMessage) {
        const recent = getMostRecentRun(teamId);
        if (!recent) {
            return c.json({
                message: `No previous pipeline run found. Provide a message: @${teamId} /restart your message here`,
            }, 400);
        }
        originalMessage = recent.original_message;
    }

    const channel = body.channel || 'api';
    const sender = body.sender || 'system';
    const messageId = genId('pipeline');

    const runId = createPipelineRun(
        teamId, channel, sender, body.senderId,
        messageId, originalMessage, team.pipeline,
    );

    enqueueMessage({
        channel,
        sender,
        senderId: body.senderId,
        message: originalMessage,
        messageId,
        agent: team.pipeline[0],
        pipelineRunId: runId,
    });

    log('INFO', `[API] Pipeline restart: ${runId} for team ${teamId}`);
    return c.json({
        message: `Pipeline @${teamId} restarted.`,
        runId,
    });
});

export default app;
```

- [ ] **Step 2: Mount pipeline routes in server**

In `packages/server/src/index.ts`, add the import after the existing route imports (around line 29):

```typescript
import pipelineRoutes from './routes/pipeline';
```

Then mount it alongside the other routes (after the `schedulesRoutes` line):

```typescript
    app.route('/', pipelineRoutes);
```

- [ ] **Step 3: Build to verify**

Run: `npm run build -w @tinyagi/server`
Expected: Clean build. (Core must be built first: `npm run build -w @tinyagi/core && npm run build -w @tinyagi/server`)

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/routes/pipeline.ts packages/server/src/index.ts
git commit -m "feat(pipeline): add pipeline API endpoints (status, retry, restart)"
```

---

### Task 7: Pipeline branch in handleTeamResponse

**Files:**
- Modify: `packages/teams/src/conversation.ts`

After `resolveTeamContext` succeeds, add a pipeline-mode branch that skips mention parsing and instead advances the pipeline stage or completes it.

- [ ] **Step 1: Add pipeline imports**

In `packages/teams/src/conversation.ts`, update the import from `@tinyagi/core`:

```typescript
import {
    MessageJobData, AgentConfig, TeamConfig,
    log, emitEvent,
    findTeamForAgent, insertChatMessage,
    enqueueMessage, genId,
    getPipelineRun, advancePipelineStage, completePipelineRun,
    streamResponse,
} from '@tinyagi/core';
```

- [ ] **Step 2: Add `pipelineRunId` parameter to `handleTeamResponse`**

Update the function signature to accept an optional `pipelineRunId`:

```typescript
export async function handleTeamResponse(params: {
    agentId: string;
    response: string;
    isTeamRouted: boolean;
    data: MessageJobData;
    agents: Record<string, AgentConfig>;
    teams: Record<string, TeamConfig>;
    pipelineRunId?: string;
}): Promise<boolean> {
    const { agentId, response, isTeamRouted, data, agents, teams, pipelineRunId } = params;
```

- [ ] **Step 3: Add pipeline branch after `resolveTeamContext`**

After the `resolveTeamContext` call (line 82) and the null check (lines 83-86), add the pipeline branch BEFORE the existing collaborative logic (before the `extractTeammateMentions` call):

```typescript
    // Pipeline mode — skip mention parsing, advance stage or complete
    if (teamContext.team.mode === 'pipeline' && pipelineRunId) {
        const run = getPipelineRun(pipelineRunId);
        if (!run) {
            log('ERROR', `Pipeline run ${pipelineRunId} not found`);
            return true;
        }

        const pipeline = run.pipeline;
        const total = pipeline.length;
        const isLastStage = run.current_stage >= total - 1;

        if (isLastStage) {
            completePipelineRun(run.id, response);
            log('INFO', `Pipeline ${run.id} completed (${total}/${total} stages)`);

            const notification = `Pipeline complete (${total}/${total} stages). All stages finished successfully.`;
            await streamResponse(notification, {
                channel: data.channel,
                sender: data.sender,
                senderId: data.senderId ?? undefined,
                messageId: genId('pipeline-done'),
                originalMessage: run.original_message,
                agentId: teamContext.teamId,
            });
        } else {
            advancePipelineStage(run.id, response);
            const nextStage = run.current_stage + 1;
            const nextAgentId = pipeline[nextStage];

            const pipelineMessage = [
                `[Pipeline stage ${nextStage + 1}/${total} — from @${agentId}]`,
                `Previous agent's response:`,
                `---`,
                response,
                `---`,
                ``,
                `Original task:`,
                run.original_message,
            ].join('\n');

            enqueueMessage({
                channel: data.channel,
                sender: data.sender,
                senderId: data.senderId ?? undefined,
                message: pipelineMessage,
                messageId: genId('pipeline'),
                agent: nextAgentId,
                fromAgent: agentId,
                pipelineRunId: run.id,
            });

            log('INFO', `Pipeline ${run.id}: stage ${nextStage + 1}/${total} → @${nextAgentId}`);
        }

        return true;
    }
```

This block goes right after the `resolveTeamContext` null check and BEFORE the existing `extractTeammateMentions` line.

- [ ] **Step 4: Build to verify**

Run: `npm run build -w @tinyagi/core && npm run build -w @tinyagi/teams`
Expected: Clean build.

- [ ] **Step 5: Commit**

```bash
git add packages/teams/src/conversation.ts
git commit -m "feat(pipeline): add pipeline branch in handleTeamResponse"
```

---

### Task 8: Pipeline initiation and error handling in processMessage

**Files:**
- Modify: `packages/main/src/index.ts`

This task adds three pieces of pipeline logic to `processMessage`:
1. Read `pipelineRunId` from dequeued message
2. Before `invokeAgent`: detect pipeline-mode team, create run, validate no active run
3. On error: fail pipeline run and send pipeline-specific error notification
4. Pass `pipelineRunId` to `handleTeamResponse`

- [ ] **Step 1: Add pipeline imports**

Update the imports at the top of `packages/main/src/index.ts`. Add pipeline functions to the `@tinyagi/core` import:

```typescript
import {
    MessageJobData,
    getSettings, getAgents, getTeams, LOG_FILE, FILES_DIR,
    log, emitEvent,
    parseAgentRouting, getAgentResetFlag,
    invokeAgent, killAgentProcess,
    loadPlugins, runIncomingHooks,
    streamResponse,
    initQueueDb, getPendingAgents, claimAllPendingMessages,
    markProcessing, completeMessage, failMessage,
    recoverStaleMessages, pruneAckedResponses, pruneCompletedMessages,
    closeQueueDb, queueEvents,
    insertAgentMessage,
    startScheduler, stopScheduler,
    initPipelineDb, createPipelineRun, getActivePipelineRun,
    failPipelineRun, getPipelineRun,
    recoverRunningPipelines, enqueueMessage, genId,
    hasPendingPipelineMessage,
} from '@tinyagi/core';
```

- [ ] **Step 2: Read `pipelineRunId` from dequeued message**

In `processMessage`, update the `data` construction (around line 42-50) to include `pipelineRunId`:

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
    };
```

- [ ] **Step 3: Add pipeline initiation after agent routing**

After the agent routing block (after line 83 `if (!agents[agentId]) { agentId = Object.keys(agents)[0]; }`) and BEFORE the `invokeAgent` call, add pipeline detection:

```typescript
    // ── Pipeline detection ───────────────────────────────────────────────
    let pipelineRunId = data.pipelineRunId;

    if (!pipelineRunId) {
        // Check if this agent belongs to a pipeline-mode team
        for (const [teamId, team] of Object.entries(teams)) {
            if (team.mode === 'pipeline' && team.pipeline && team.agents.includes(agentId)) {
                // Validate config
                if (team.pipeline.some(pid => !team.agents.includes(pid))) {
                    log('ERROR', `Pipeline config for team '${teamId}' references unknown agents`);
                    await sendDirectResponse(
                        `Pipeline configuration error: pipeline references agents not in the team.`,
                        { channel, sender, senderId: data.senderId, messageId, originalMessage: rawMessage, agentId: teamId },
                    );
                    return;
                }

                // Check for active run
                const activeRun = getActivePipelineRun(teamId);
                if (activeRun) {
                    log('WARN', `Pipeline already running for team '${teamId}'`);
                    await sendDirectResponse(
                        `Pipeline already running for @${teamId}. Use @${teamId} /status to check progress.`,
                        { channel, sender, senderId: data.senderId, messageId, originalMessage: rawMessage, agentId: teamId },
                    );
                    return;
                }

                // Create pipeline run — first agent in pipeline array always receives
                pipelineRunId = createPipelineRun(
                    teamId, channel, sender, data.senderId ?? undefined,
                    messageId, rawMessage, team.pipeline,
                );
                agentId = team.pipeline[0];
                isTeamRouted = true;
                log('INFO', `Pipeline ${pipelineRunId} created for team '${teamId}' (${team.pipeline.length} stages)`);
                break;
            }
        }
    }
```

- [ ] **Step 4: Update error handler for pipeline failure**

In the `catch` block of `invokeAgent` (around line 108-119), add pipeline failure handling. After the existing error logging and before `sendDirectResponse`, add:

```typescript
        // Fail pipeline run if active
        if (pipelineRunId) {
            failPipelineRun(pipelineRunId, (error as Error).message);
            const run = getPipelineRun(pipelineRunId);
            if (run) {
                const stage = run.current_stage + 1;
                const total = run.pipeline.length;
                const teamId = run.team_id;
                response = `Pipeline halted at stage ${stage}/${total} (@${agentId}): ${(error as Error).message}. Use @${teamId} /retry to resume or @${teamId} /restart to start over.`;
            }
        }
```

Place this right after the `log('ERROR', ...)` line and before the `const msgSender = ...` line.

- [ ] **Step 5: Pass `pipelineRunId` to `handleTeamResponse`**

Update the `handleTeamResponse` call at the bottom of `processMessage` (around line 132-134):

```typescript
    await handleTeamResponse({
        agentId, response, isTeamRouted, data, agents, teams,
        pipelineRunId,
    });
```

- [ ] **Step 6: Build to verify**

Run: `npm run build -w @tinyagi/core && npm run build -w @tinyagi/teams && npm run build -w @tinyagi/main`
Expected: Clean build.

- [ ] **Step 7: Commit**

```bash
git add packages/main/src/index.ts
git commit -m "feat(pipeline): add pipeline initiation, error handling in processMessage"
```

---

### Task 9: Startup recovery

**Files:**
- Modify: `packages/main/src/index.ts` (startup section, around lines 218-226)

On startup, recover any pipeline runs that were interrupted by a crash.

- [ ] **Step 1: Add `hasPendingPipelineMessage` to queues.ts**

In `packages/core/src/queues.ts`, add a helper function that checks for any pending/queued/processing message with a given `pipeline_run_id`. This is needed because `recoverStaleMessages` resets stale messages to `pending` status, so `getProcessingMessages()` alone won't find them.

```typescript
export function hasPendingPipelineMessage(pipelineRunId: string): boolean {
    const row = getDb().prepare(
        `SELECT 1 FROM messages WHERE pipeline_run_id = ? AND status IN ('pending','queued','processing') LIMIT 1`
    ).get(pipelineRunId);
    return !!row;
}
```

- [ ] **Step 2: Add pipeline DB init and recovery after queue init**

In `packages/main/src/index.ts`, first add `hasPendingPipelineMessage` to the `@tinyagi/core` import (alongside the other pipeline imports from Task 8 Step 1).

Then, after `initQueueDb()` (line 218) and the stale message recovery block (lines 222-225), add:

```typescript
// Initialize pipeline table
initPipelineDb();

// Recover interrupted pipeline runs
const runningPipelines = recoverRunningPipelines();
for (const run of runningPipelines) {
    const teams = getTeams(getSettings());
    const team = teams[run.team_id];
    if (!team) {
        log('WARN', `Pipeline ${run.id}: team '${run.team_id}' no longer exists, marking failed`);
        failPipelineRun(run.id, 'Team no longer exists');
        continue;
    }

    const stage = run.current_stage;
    const total = run.pipeline.length;
    const agentId = run.pipeline[stage];

    // Check if a message already exists in the queue for this pipeline run
    // (recoverStaleMessages may have already re-queued it as 'pending')
    if (hasPendingPipelineMessage(run.id)) {
        log('INFO', `Pipeline ${run.id}: stage ${stage + 1}/${total} already in queue, skipping recovery`);
        continue;
    }

    // Re-enqueue at the current stage
    let message: string;
    if (stage === 0) {
        message = run.original_message;
    } else {
        message = [
            `[Pipeline stage ${stage + 1}/${total} — recovery]`,
            `Previous agent's response:`,
            `---`,
            run.last_response || '(no response recorded)',
            `---`,
            ``,
            `Original task:`,
            run.original_message,
        ].join('\n');
    }

    enqueueMessage({
        channel: run.channel,
        sender: run.sender,
        senderId: run.sender_id ?? undefined,
        message,
        messageId: genId('pipeline-recover'),
        agent: agentId,
        pipelineRunId: run.id,
    });

    log('INFO', `Recovered pipeline run ${run.id} for team ${run.team_id} at stage ${stage + 1}/${total}`);
}
```

- [ ] **Step 3: Build to verify**

Run: `npm run build -w @tinyagi/main`
Expected: Clean build.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/queues.ts packages/main/src/index.ts
git commit -m "feat(pipeline): add startup recovery for interrupted pipeline runs"
```

---

### Task 10: Discord pipeline commands

**Files:**
- Modify: `packages/channels/src/discord.ts`

Add pipeline command parsing in `handleTextCommand`. Commands follow the pattern `@team_id /command [message]`. The channel client calls the pipeline API endpoints.

- [ ] **Step 1: Add pipeline command parsing to `handleTextCommand`**

In `packages/channels/src/discord.ts`, add pipeline command detection at the END of `handleTextCommand` (before the `return false;` on line 276):

```typescript
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
```

- [ ] **Step 2: Build to verify**

Run: `npm run build -w @tinyagi/channels`
Expected: Clean build.

- [ ] **Step 3: Commit**

```bash
git add packages/channels/src/discord.ts
git commit -m "feat(pipeline): add Discord pipeline commands (status, retry, restart)"
```

---

### Task 11: Telegram pipeline commands

**Files:**
- Modify: `packages/channels/src/telegram.ts`

Add pipeline command parsing inline in the message handler. Telegram uses `bot.on('message', ...)` with inline if/else blocks.

- [ ] **Step 1: Register pipeline commands for autocomplete**

In `packages/channels/src/telegram.ts`, update the `setMyCommands` call (line 264-269) to include pipeline commands:

```typescript
bot.api.setMyCommands([
    { command: 'agent', description: 'List available agents' },
    { command: 'team', description: 'List available teams' },
    { command: 'reset', description: 'Reset conversation history' },
    { command: 'restart', description: 'Restart TinyAGI' },
    { command: 'status', description: 'Check pipeline status (@team /status)' },
    { command: 'retry', description: 'Retry failed pipeline (@team /retry)' },
]).catch((err: Error) => log('WARN', `Failed to register commands: ${err.message}`));
```

- [ ] **Step 2: Add pipeline command parsing**

In the `bot.on('message', ...)` handler, add pipeline command detection AFTER the existing restart command handler (after line 429, after the restart `return;`) and BEFORE the `applyDefaultAgent` call (line 432):

```typescript
        // Pipeline commands: @team_id /retry|restart|status
        const pipelineMatch = messageText.trim().match(/^@(\S+)\s+[!/](retry|restart|status)(?:\s+([\s\S]*))?$/i);
        if (pipelineMatch) {
            const teamId = pipelineMatch[1];
            const command = pipelineMatch[2].toLowerCase();
            const body = pipelineMatch[3]?.trim() || '';

            // Verify team is in pipeline mode
            let isPipelineTeam = false;
            try {
                const settingsData = fs.readFileSync(SETTINGS_FILE, 'utf8');
                const settings = JSON.parse(settingsData);
                isPipelineTeam = settings.teams?.[teamId]?.mode === 'pipeline';
            } catch { /* ignore */ }

            if (isPipelineTeam) {
                log('INFO', `Pipeline command: @${teamId} /${command}`);
                try {
                    if (command === 'status') {
                        const res = await fetch(`${API_BASE}/api/pipeline/${teamId}/status`);
                        const data = await res.json() as { message: string };
                        await bot.api.sendMessage(msg.chat.id, data.message, {
                            reply_parameters: { message_id: msg.message_id },
                        });
                    } else if (command === 'retry') {
                        const res = await fetch(`${API_BASE}/api/pipeline/${teamId}/retry`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                channel: 'telegram',
                                sender,
                                senderId,
                            }),
                        });
                        const data = await res.json() as { message: string };
                        await bot.api.sendMessage(msg.chat.id, data.message, {
                            reply_parameters: { message_id: msg.message_id },
                        });
                    } else if (command === 'restart') {
                        const res = await fetch(`${API_BASE}/api/pipeline/${teamId}/restart`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                message: body || undefined,
                                channel: 'telegram',
                                sender,
                                senderId,
                            }),
                        });
                        const data = await res.json() as { message: string };
                        await bot.api.sendMessage(msg.chat.id, data.message, {
                            reply_parameters: { message_id: msg.message_id },
                        });
                    }
                } catch (err) {
                    log('ERROR', `Pipeline command error: ${(err as Error).message}`);
                    await bot.api.sendMessage(msg.chat.id, 'Could not process pipeline command. Is the queue processor running?', {
                        reply_parameters: { message_id: msg.message_id },
                    });
                }
                return;
            }
            // Not a pipeline team — fall through to normal message handling
        }
```

- [ ] **Step 3: Build to verify**

Run: `npm run build -w @tinyagi/channels`
Expected: Clean build.

- [ ] **Step 4: Commit**

```bash
git add packages/channels/src/telegram.ts
git commit -m "feat(pipeline): add Telegram pipeline commands (status, retry, restart)"
```

---

### Task 12: Full build verification

**Files:** None (verification only)

- [ ] **Step 1: Clean build all packages**

Run: `npm run build`
Expected: All packages build successfully with no errors.

- [ ] **Step 2: Run pipeline CRUD tests**

Run: `npm test -w @tinyagi/core`
Expected: All tests pass.

- [ ] **Step 3: Verify type consistency**

Check that the `TeamConfig` type with new `mode` and `pipeline` fields doesn't break any existing code. The fields are optional, so existing configs without them should work unchanged.

Run: `grep -r "TeamConfig" packages/ --include="*.ts" -l` and verify no compilation issues.

- [ ] **Step 4: Commit any fixes**

If any issues were found, fix and commit:

```bash
git add -A
git commit -m "fix(pipeline): address build issues from full verification"
```
