# Pipeline Mode for Teams

**Date:** 2026-03-25
**Status:** Draft
**Approach:** Queue-driven pipeline in `handleTeamResponse`

## Summary

Add a `"pipeline"` execution mode to teams where agents run sequentially in a system-enforced order. Each stage's response is progressively delivered to the user and passed as context to the next stage. The pipeline halts on error with retry/restart support. Pipeline state is persisted in SQLite for crash recovery.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Response delivery | Progressive — each agent's response streamed to user as it completes | Long pipelines need visibility; avoids minutes of silence |
| Error handling | Halt on error | Fail fast, notify user, allow retry from failed stage |
| Recovery | Retry from failed stage + restart entire pipeline | Retry is the common case, restart is the escape hatch |
| Context passing | Shared working directory + previous response text | Agent sees file changes on disk; response text provides narrative context |
| Triggering | Auto-detect mode from config + explicit /retry, /restart, /status commands | Mode is a team property, not a per-message decision |
| Mention parsing | Ignored in pipeline mode | Pipeline agents don't control routing — the system enforces order |

## Configuration

Extend `TeamConfig` with optional pipeline fields in `~/.tinyagi/settings.json`:

```json
{
  "teams": {
    "dev": {
      "name": "Dev Pipeline",
      "agents": ["planner", "reviewer", "qa", "maintainer"],
      "leader_agent": "planner",
      "mode": "pipeline",
      "pipeline": ["planner", "reviewer", "qa", "maintainer"]
    }
  }
}
```

- `mode` — `"collaborative"` (default, current behavior) or `"pipeline"`.
- `pipeline` — ordered array of agent IDs defining execution sequence. Required when `mode === "pipeline"`. All IDs must exist in the team's `agents` array.
- `leader_agent` — ignored for routing in pipeline mode (first agent in `pipeline` always receives initial message). Kept for backward compatibility.

Validation on message arrival:
- If `mode === "pipeline"` and `pipeline` is missing or contains unknown agent IDs, log an error and reject the message.
- If `mode === "pipeline"` and a run with `status = 'running'` already exists for this team, reject the message and reply: `"Pipeline already running for @{teamId}. Use @{teamId} /status to check progress."`
- Only one pipeline run per team can be active at a time. This avoids race conditions where `handleTeamResponse` would ambiguously pick between multiple active runs.

## Pipeline State Persistence

New SQLite table `pipeline_runs`:

```sql
CREATE TABLE pipeline_runs (
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
```

- `id` — unique run ID via `genId('pipeline')`
- `pipeline` — JSON array of agent IDs in order, e.g. `["planner","reviewer","qa","maintainer"]`
- `current_stage` — zero-based index into the pipeline array
- `status` — `running`, `completed`, `failed`
- `last_response` — most recent agent's response text (passed to next stage)
- `error` — error message if failed

### CRUD Operations

- `createPipelineRun(teamId, channel, sender, senderId, messageId, originalMessage, pipeline)` — insert new run with `status = 'running'`, `current_stage = 0`
- `advancePipelineStage(runId, response)` — increment `current_stage`, set `last_response`, update `updated_at`
- `completePipelineRun(runId, response)` — set `status = 'completed'`, `last_response`
- `failPipelineRun(runId, error)` — set `status = 'failed'`, store error
- `getPipelineRun(runId)` — get a specific run
- `getActivePipelineRun(teamId)` — get the most recent `running` run for a team
- `getFailedPipelineRun(teamId)` — get the most recent `failed` run for a team
- `recoverRunningPipelines()` — return all runs with `status = 'running'` (for startup recovery)
- `getMostRecentRun(teamId)` — get the most recent run of any status for a team (used by `/restart` when no message provided)

### Index

```sql
CREATE INDEX idx_pipeline_team ON pipeline_runs(team_id, status);
```

### Database Handle

`pipeline.ts` reuses the same SQLite database handle from `queues.ts` (the singleton `getDb()` function). The `pipeline_runs` table is created in the same `initQueueDb` initialization, or in a separate `initPipelineDb` called alongside it.

## Pipeline Flow

### RunId Threading

The pipeline `runId` must be threaded through the queue so `handleTeamResponse` can look up the correct run. This requires:

1. Add `pipelineRunId?: string` to the `MessageJobData` type in `packages/core/src/types.ts`
2. Add a `pipeline_run_id TEXT` column to the `messages` table in the queue schema
3. `enqueueMessage` passes `pipelineRunId` through to the DB row
4. `processMessage` reads `pipelineRunId` from the dequeued message and passes it to `handleTeamResponse`
5. `handleTeamResponse` receives `pipelineRunId` as an optional parameter — if present, uses `getPipelineRun(runId)` for a direct lookup (no ambiguous team-based query)

This eliminates the race condition of querying by team — the exact run is identified by ID at every step.

### Initiation

When a message arrives for a pipeline-mode team (e.g., `@dev fix the auth bug`):

1. Queue processor resolves the agent ID via `parseAgentRouting` or `preRoutedAgent` (existing logic, lines 63-83 of `index.ts`)
2. **After agent resolution, before `invokeAgent`**: check if the resolved agent belongs to a pipeline-mode team. This applies to both the initial-message path (via `parseAgentRouting`) and the pipeline-progression path (via `preRoutedAgent` for subsequent stages).
3. If pipeline mode: validate no active run exists for this team (reject if one is running). For progression messages (which have `pipelineRunId` set on the `MessageJobData`), skip this check — they're part of an already-running pipeline.
4. Create a `pipeline_runs` row with `current_stage = 0`, store the returned `runId`
5. Invoke the first agent in the `pipeline` array with the user's message
6. The `runId` is stored in the message's `pipelineRunId` field so it threads through the queue

### Stage Progression (in `handleTeamResponse`)

After an agent responds:

1. Resolve team context via `resolveTeamContext` (existing call at line 82 of `conversation.ts`)
2. If no team context → fall back to direct response (existing behavior, unchanged)
3. Check if the team's mode is `"pipeline"`
4. If `"collaborative"` → current behavior (extract mentions, enqueue teammates). **Unchanged.**
5. If `"pipeline"`:
   a. Look up the pipeline run via `getPipelineRun(pipelineRunId)` — the `runId` is threaded through `MessageJobData`
   b. **Ignore** any `[@teammate:]` mentions in the response — pipeline agents don't control routing
   c. If this was the **last stage** → call `completePipelineRun`, send completion notification to user
   d. Otherwise → call `advancePipelineStage`, enqueue the next agent with `pipelineRunId` set so the chain continues

### Message Format to Next Agent

For stages 1+ (after the first agent):

```
[Pipeline stage 2/4 — from @reviewer]
Previous agent's response:
---
{last_response}
---

Original task:
{original_message}
```

For stage 0 (first agent, or retry of stage 0): the user's original message is passed directly with no wrapper.

**Display numbering:** `current_stage` is zero-based in the DB. User-facing strings use 1-based numbering: `display_stage = current_stage + 1`.

The next agent receives both the previous stage's output and the original task. It can also read the shared working directory for file-level changes.

### Response Delivery (Progressive)

Each agent's response is delivered to the user as it completes via the existing `sendDirectResponse` flow in `processMessage`. Responses are signed with the agent ID (`- [agentId]`), so the user sees which stage produced which output. No change to the delivery mechanism.

When the last stage completes, send an additional notification:
```
Pipeline complete (4/4 stages). All stages finished successfully.
```

## Pipeline Commands

Detected in channel clients before enqueuing. These are compound commands with an `@team_id` prefix followed by a `/command`. Parsing uses a regex on the full message content:

```
/^@(\S+)\s+[!/](retry|restart|status)(?:\s+([\s\S]*))?$/i
```

- Group 1: team ID
- Group 2: command name
- Group 3: optional message body (for `/restart`)

Pipeline commands are checked AFTER the existing bare commands (`/agent`, `/team`, `/reset`, `/restart`) and BEFORE the default agent routing. If the resolved team is not in pipeline mode, the command is ignored and the message passes through normally.

### `@team_id /retry`

- Finds the most recent `failed` run for that team via `getFailedPipelineRun`
- If the failed stage is 0: re-enqueues with `original_message` directly (no wrapper format)
- If the failed stage is 1+: re-enqueues with the `[Pipeline stage N/M]` format using `last_response` and `original_message` from the DB row
- Sets `status = 'running'`, sets `pipelineRunId` on the enqueued message
- If no failed run exists, reply: `"No failed pipeline to retry."`

### `@team_id /restart [message]`

- Creates a new run with `current_stage = 0`
- If `message` is provided, use it as the new `original_message`
- If no message, reuse `original_message` from the most recent run via `getMostRecentRun(teamId)`. If no prior run exists, reply: `"No previous pipeline run found. Provide a message: @{teamId} /restart your message here"`
- Old run stays in DB as history

### `@team_id /status`

- Returns the current pipeline status for that team
- Format: `"Pipeline @dev: stage 2/4 (@reviewer) — running"` or `"Pipeline @dev: stage 3/4 (@qa) — failed: {error}"`
- If no active/recent run: `"No pipeline runs found for @dev."`

## Error Handling

- If `invokeAgent` throws, `processMessage` catches it (existing behavior at line 108)
- The `runId` is available in `processMessage` scope because pipeline initiation (step 3) stores it before `invokeAgent` is called. For subsequent stages, `runId` comes from `pipelineRunId` on the dequeued `MessageJobData`.
- For pipeline teams, additionally call `failPipelineRun(runId, error.message)`. The stage number for the notification is read from the DB row's `current_stage`.
- Send error notification to user: `"Pipeline halted at stage 2/4 (@reviewer): {error}. Use @dev /retry to resume or @dev /restart to start over."`
- Remaining stages are not enqueued

## Startup Recovery

On queue processor startup (in `packages/main/src/index.ts`), after `initQueueDb` and after `recoverStaleMessages`:

1. Call `recoverRunningPipelines()` to get all runs with `status = 'running'`
2. For each run, check if a pending or processing message already exists in the queue for the current stage's agent (since `recoverStaleMessages` may have already re-queued it). If so, skip — the queue will pick it up naturally.
3. If no existing queue entry, re-enqueue the `current_stage` agent with the pipeline message format. Use `original_message` for stage 0, or the `[Pipeline stage N/M]` format with `last_response` for later stages. Set `pipelineRunId` on the enqueued message.
4. Log: `"Recovered pipeline run {id} for team {teamId} at stage {current_stage + 1}/{total}"`

## Files Changed

| File | Change |
|---|---|
| `packages/core/src/types.ts` | Add `mode?: 'collaborative' \| 'pipeline'` and `pipeline?: string[]` to `TeamConfig`. Add `pipelineRunId?: string` to `MessageJobData`. |
| `packages/core/src/queue.ts` | Add `pipeline_run_id TEXT` column to `messages` table. Thread `pipelineRunId` through `enqueueMessage` and dequeue. |
| `packages/core/src/pipeline.ts` (new) | `pipeline_runs` table schema + index, CRUD functions, recovery. Reuses DB handle from `queues.ts`. |
| `packages/core/src/index.ts` | Export pipeline functions |
| `packages/teams/src/conversation.ts` | In `handleTeamResponse`, accept optional `pipelineRunId` param. After `resolveTeamContext` succeeds, add pipeline branch: skip mention parsing, advance stage, enqueue next agent with `pipelineRunId`. |
| `packages/main/src/index.ts` | Detect pipeline-mode team in `processMessage`, create run before first invocation. Pass `pipelineRunId` to `handleTeamResponse`. Startup recovery (after `recoverStaleMessages`). Error handler updates pipeline run via `runId` from scope. |
| `packages/channels/src/discord.ts` | Add pipeline command parsing (regex for `@team /retry\|restart\|status`). Handle commands via API calls to pipeline CRUD. |
| `packages/channels/src/telegram.ts` | Add pipeline commands. Telegram uses inline `if/else` blocks on `msg.text` (not grammy's `/command` handler). Add `/retry`, `/restart`, `/status` to `setMyCommands` registration (lines 264-269) for autocomplete, AND handle them inline alongside the existing `/reset` and `/restart` handlers. Use the same regex pattern as Discord to parse `@team_id /command` from message text. |

## What Does NOT Change

- Collaborative team behavior (guarded by `mode` check)
- Agent invocation (`invokeAgent`) — agents invoked the same way
- Queue processor concurrency model — per-agent chains work as-is
- SSE events, response delivery, chat rooms
- Agent workspaces, skills, memory
- DM functionality
