# Agent Pipeline Workflow

**Date:** 2026-03-25
**Status:** Draft
**Approach:** Single Claude Code agent per repo with CLAUDE.md-driven workflow, Discord reaction gate

## Summary

Add an autonomous development workflow where a Claude Code agent picks up a TaskNote epic from a Discord channel, reads specs from an Obsidian vault, implements the plan, runs code review, pauses for human approval before deploy, then deploys, runs QA via Pi CLI, updates docs, and creates a PR — all guided by a CLAUDE.md workflow file. Two repos (Trading-Signal-AI, ArkNode-Poly) run parallel workflows in one TinyAGI instance.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Orchestration | Single agent with CLAUDE.md workflow, NOT pipeline mode | Pipeline mode is for multi-agent handoff; this is one agent following a scripted workflow. Full context preserved via `-c` flag. |
| Agent runtime | Claude Code CLI (`claude-cli` provider) | Agent needs tool access (filesystem, git, skills, bash). Claude Code provides this natively. |
| Human gate | Discord reaction (✅) + `claude -c` resume | Non-blocking for humans (react when ready). `-c` restores conversation context across the gate. |
| Workspace isolation | Git worktrees per epic | Multiple agents (future) can work on different epics concurrently without conflicts. Shared git object store, no disk duplication. |
| Obsidian access | Symlinked vault inside the git workspace | Direct file reads — no API needed. Agent reads TaskNote markdown + frontmatter. |
| QA model | Pi CLI invoked as bash subprocess inside Claude Code | Cheaper model for structured QA review. Claude Code captures output and acts on findings. |
| Deploy | Existing Python deploy scripts | `deploy_ct100.py`, `promote_to_production.py` already handle git bundle transfer, service restart, health checks. |
| Evidence capture | Screenshots + terminal output saved during deploy/QA | Attached to PR as visual proof of working deployment. |

## Agent Configuration

Two new agents, one per repo, each in a dedicated team mapped to a Discord channel.

### settings.json

```json
{
  "agents": {
    "arksignal-dev": {
      "name": "ArkSignal Developer",
      "provider": "claude-cli",
      "model": "opus",
      "working_directory": "~/.tinyagi/.agents/arksignal-dev"
    },
    "arkpoly-dev": {
      "name": "ArkPoly Developer",
      "provider": "claude-cli",
      "model": "opus",
      "working_directory": "~/.tinyagi/.agents/arkpoly-dev"
    }
  },
  "teams": {
    "arksignal": {
      "name": "ArkSignal Pipeline",
      "agents": ["arksignal-dev"],
      "leader_agent": "arksignal-dev",
      "workflow": true
    },
    "arkpoly": {
      "name": "ArkPoly Pipeline",
      "agents": ["arkpoly-dev"],
      "leader_agent": "arkpoly-dev",
      "workflow": true
    }
  }
}
```

The `workflow: true` flag tells TinyAGI to auto-gate after the agent's first response (no marker parsing needed).

### TeamConfig Type Extension

```typescript
export interface TeamConfig {
    name: string;
    agents: string[];
    leader_agent: string;
    mode?: 'collaborative' | 'pipeline';
    pipeline?: string[];
    workflow?: boolean;  // NEW: auto-gate after first response
}
```

## Workspace Layout

### ArkSignal

```
~/.tinyagi/.agents/arksignal-dev/
├── .claude/
│   └── CLAUDE.md                ← workflow instructions
├── workspace/                   ← symlink → ~/GIT/ArkNode-AI/projects/trading-signal-ai
│   ├── src/
│   ├── scripts/deployment/
│   │   ├── deploy_ct100.py
│   │   ├── deploy_ct110.py
│   │   └── promote_to_production.py
│   ├── vault/                   ← Obsidian vault (submodule or symlink)
│   │   ├── TaskNotes/
│   │   │   ├── Tasks/Epic/
│   │   │   ├── Tasks/Story/
│   │   │   └── meta/
│   │   ├── Trading-Signal-AI/
│   │   └── Infrastructure/
│   └── ...
├── worktrees/                   ← git worktrees created per epic
│   ├── arksignal-080/
│   └── arksignal-081/
└── memory/                      ← Claude Code persistent memory
```

### ArkPoly

```
~/.tinyagi/.agents/arkpoly-dev/
├── .claude/
│   └── CLAUDE.md
├── workspace/                   ← symlink → ~/GIT/ArkNode-Poly
│   ├── vault/                   ← Obsidian vault
│   │   └── TaskNotes/
│   └── ...
├── worktrees/
└── memory/
```

### Worktree Lifecycle

1. Agent receives TaskNote ticker (e.g., `Arksignal-080`)
2. Creates worktree: `git worktree add ../worktrees/arksignal-080 -b arksignal-080`
3. All work happens inside the worktree directory
4. Claude Code runs with `cwd` set to the worktree path
5. After PR merge, agent cleans up: `git worktree remove ../worktrees/arksignal-080`

## CLAUDE.md Workflow

The CLAUDE.md is the core of the design — it scripts the agent's autonomous behavior. Each repo has a customized version with repo-specific deploy commands.

### Phase 1: Understand

1. Parse the TaskNote ticker from the incoming message (e.g., `Arksignal-080`)
2. Read the epic file from `vault/TaskNotes/Tasks/Epic/ArkSignal-080-*.md`
3. Parse YAML frontmatter: check `status`, `priority`, `blockedBy`
4. If any `blockedBy` dependencies are not `done`, stop and report: "Blocked by {taskId}"
5. Follow wikilinks to read all linked stories and their acceptance criteria
6. Read any referenced specs or plans in the vault
7. Create a git worktree for this epic: `git worktree add ../worktrees/arksignal-080 -b arksignal-080`
8. Change working directory to the worktree

### Phase 2: Implement

9. If no existing plan: invoke `/write-plan` skill (brainstorm → spec → plan)
10. If plan exists: read it from the vault or `docs/superpowers/plans/`
11. Execute the plan using `/execute-plan` skill
12. Run code review using `/code-review` skill
13. Fix all issues found by code review
14. Re-run code review until clean

### Phase 3: Human Gate

15. Compose a deploy-ready summary:
    - What epic/stories were addressed
    - Files changed (git diff --stat)
    - Tests passing
    - Code review status
    - Key decisions made
16. Output the summary
17. **Stop.** Exit the session. Wait for human approval.

--- *session break — human reacts with ✅* ---

### Phase 4: Deploy & Validate

18. **Re-orient:** Re-read the plan and spec files to refresh context after session break
19. Run the deploy script:
    - ArkSignal: `python scripts/deployment/promote_to_production.py` (or `deploy_ct100.py`)
    - ArkPoly: repo-specific deploy command
20. Verify health checks pass, capture output as evidence
21. Take screenshots of monitor dashboard / relevant endpoints using browser tools
22. Run QA via Pi CLI:
    - Invoke `pi` as bash subprocess
    - Feed it the diff and acceptance criteria from the TaskNote
    - Capture Pi's review output
23. If Pi finds issues: fix, re-deploy, re-QA
24. Save all evidence (screenshots, health check output, QA results) to `./evidence/`

### Phase 5: Wrap Up

25. Run `/codebase-maintenance --full` to update Obsidian docs
26. Create session log in vault using `/notebooklm-vault` skill
27. Update the TaskNote frontmatter: `status: done`
28. Create a PR:
    - Feature branch from worktree (already on `arksignal-080` branch)
    - PR title: `[Arksignal-080] <epic title>`
    - PR body: summary, evidence screenshots, acceptance criteria checklist
    - Use `gh pr create` with evidence images attached
29. Clean up worktree: `git worktree remove ../worktrees/arksignal-080`

## Claude Code CLI Adapter

New provider `claude-cli` for agents that run as Claude Code subprocess.

### Provider Type

Add `'claude-cli'` to the provider union. The adapter is implemented alongside existing adapters in `packages/core/src/adapters/` (or wherever adapters live).

### Invocation Modes

| Mode | Command | When |
|------|---------|------|
| New session | `claude --dangerously-skip-permissions -p "<message>"` | TaskNote ticker arrives |
| Resume | `claude --dangerously-skip-permissions -c -p "<resume prompt>"` | After human gate approval |

Both run with `cwd` set to the agent's worktree path (or working directory if no worktree yet).

### Adapter Implementation

```typescript
interface ClaudeCliAdapterOptions {
    model: string;
    workingDirectory: string;
    resume?: boolean;
    onEvent?: (text: string) => void;
}

async function invokeClaudeCli(options: ClaudeCliAdapterOptions, message: string): Promise<string> {
    const args = ['--dangerously-skip-permissions'];
    if (options.resume) args.push('-c');
    args.push('--model', options.model);
    args.push('-p', message);

    const proc = spawn('claude', args, {
        cwd: options.workingDirectory,
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    proc.stdout.on('data', (chunk) => {
        const text = chunk.toString();
        output += text;
        options.onEvent?.(text);
    });

    return new Promise((resolve, reject) => {
        proc.on('close', (code) => {
            if (code === 0) resolve(output);
            else reject(new Error(`claude-cli exited with code ${code}`));
        });
    });
}
```

### MessageJobData Extension

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
    resume?: boolean;        // NEW: triggers -c flag
    worktreePath?: string;   // NEW: cwd override for worktree
}
```

## Human Gate Infrastructure

### Discord Reaction Listener

Add to the Discord client:

**Intents:** Add `GatewayIntentBits.GuildMessageReactions`

**Partials:** Add `Partials.Reaction`, `Partials.Message` (for reactions on uncached messages)

**Event handler:**

```typescript
client.on('messageReactionAdd', async (reaction, user) => {
    if (user.bot) return;
    if (reaction.emoji.name !== '✅' && reaction.emoji.name !== '☑️') return;

    // Fetch partial if needed
    if (reaction.partial) await reaction.fetch();
    if (reaction.message.partial) await reaction.message.fetch();

    const messageId = reaction.message.id;

    // Look up gate record
    const gate = getGateByMessageId(messageId);
    if (!gate || gate.status !== 'waiting') return;

    // Approve and resume
    approveGate(gate.id);
    enqueueMessage({
        channel: gate.channel,
        sender: gate.original_task,
        senderId: user.id,
        message: 'Human approved deployment. Continue from Phase 4 (deploy). Re-read the plan and spec files to refresh context.',
        messageId: genId('gate'),
        agent: gate.agent_id,
        resume: true,
        worktreePath: gate.worktree_path,
    });
});
```

### Rejection Handler

```typescript
// Same listener, different emoji
if (reaction.emoji.name === '❌') {
    rejectGate(gate.id);
    // Post rejection message to thread
}
```

### Gate State Persistence

New SQLite table in the same database:

```sql
CREATE TABLE gate_requests (
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
);

CREATE INDEX idx_gate_message ON gate_requests(message_id);
CREATE INDEX idx_gate_team ON gate_requests(team_id, status);
```

### CRUD Operations

- `createGateRequest(teamId, agentId, channel, messageId, threadId, originalTask, worktreePath)` — insert with `status = 'waiting'`
- `getGateByMessageId(messageId)` — look up by Discord message ID
- `approveGate(id)` — set `status = 'approved'`
- `rejectGate(id)` — set `status = 'rejected'`
- `getWaitingGates()` — return all `status = 'waiting'` (for stale detection)
- `expireStaleGates(maxAgeMs)` — set `status = 'expired'` for old waiting gates

### Gate Creation Flow

In `processMessage`, after the agent's response is delivered:

1. Check if the team has `workflow: true`
2. Check if this is NOT a resume invocation (`!data.resume`)
3. If both true: this is the pre-gate response
4. Get the Discord message ID of the posted response (from the channel client's delivery tracking)
5. Call `createGateRequest(...)` with the message ID, agent ID, worktree path
6. Add a ✅ reaction to the gate message (as a visual prompt for the human)

## Error Handling

### Pre-Gate Failures (Phase 1-3)

- Claude Code process exits non-zero → `processMessage` catches error
- Post error to Discord thread: "Workflow failed during implementation: {error}. Use `@arksignal /retry` to re-run."
- Gate record is NOT created
- Worktree is left in place for inspection or retry

### Post-Gate Failures (Phase 4-5)

- Same error capture pattern
- Post error to Discord thread: "Workflow failed during deploy/QA: {error}"
- CLAUDE.md instructs agent to attempt rollback on deploy failure before exiting
- Human can react ✅ on the error message to re-trigger resume, or `@arksignal /retry` for fresh run

### Stale Gate Cleanup

- Gates in `waiting` status older than 48 hours: post Discord reminder
- After 7 days: auto-expire, post notification
- Run via periodic check (heartbeat or startup)

### Stale Worktree Cleanup

- On successful PR creation (Phase 5 step 29), CLAUDE.md instructs agent to remove its worktree
- `@team /cleanup` command lists orphaned worktrees with no active gate for manual removal

### Startup Recovery

- On TinyAGI restart, query `gate_requests WHERE status = 'waiting'`
- No re-invocation needed — gates are just waiting for a human reaction
- Discord reaction listener re-attaches on startup and catches reactions on existing messages

### Context Loss Mitigation

- Claude Code's `-c` restores conversation history, but long sessions may compress
- Phase 4 starts with a "re-orient" instruction: re-read plan/spec files to refresh context
- All file changes from Phase 1-3 are on disk in the worktree — agent can reconstruct from `git diff`

## Files Changed

| File | Change |
|------|--------|
| `packages/core/src/types.ts` | Add `workflow?: boolean` to `TeamConfig`. Add `resume?: boolean`, `worktreePath?: string` to `MessageJobData`. |
| `packages/core/src/adapters/claude-cli.ts` (new) | Claude Code CLI adapter: spawn subprocess, stream output, support `-c` resume. |
| `packages/core/src/gate.ts` (new) | `gate_requests` table schema, CRUD functions, stale detection. |
| `packages/core/src/index.ts` | Export gate functions and claude-cli adapter. |
| `packages/main/src/index.ts` | After agent response in workflow teams: create gate record, add ✅ reaction. On resume: pass `-c` flag to adapter. Startup: re-register reaction listener. |
| `packages/channels/src/discord.ts` | Add `GuildMessageReactions` intent, `Reaction`/`Message` partials. Add `messageReactionAdd` handler for gate approval/rejection. Expose method to add reaction to a message. |
| `~/.tinyagi/.agents/arksignal-dev/.claude/CLAUDE.md` (new) | ArkSignal workflow instructions (Phase 1-5). |
| `~/.tinyagi/.agents/arkpoly-dev/.claude/CLAUDE.md` (new) | ArkPoly workflow instructions (Phase 1-5). |

## What Does NOT Change

- Pipeline mode (collaborative/pipeline team behavior, pipeline_runs table)
- Existing agent invocation for non-workflow teams (API adapters unchanged)
- Queue processor concurrency model
- Discord DM functionality and guild channel routing
- Telegram channel client
- SSE events, response delivery, chat rooms
- Existing agent configs, workspaces, memory
