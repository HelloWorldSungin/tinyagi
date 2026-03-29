# TODO

## Feature: Discord Server Channels Per Team

Currently Discord integration is DM-only (`discord.ts:224` skips guild messages). Add support for mapping Discord server channels to TinyAGI teams.

- [x] Remove/modify the `if (message.guild) return` guard in `packages/channels/src/discord.ts`
- [x] Add channel-to-team mapping config in `settings.json` (e.g., `channels.discord.guild_channels: { "<channel_id>": "<team_id>" }`)
- [x] Route messages from mapped server channels to the corresponding team
- [x] Send responses back to the originating server channel instead of DMs
- [x] Preserve existing DM functionality alongside server channel support

## Feature: Pipeline Mode for Teams

Current team orchestration is agent-driven via `[@teammate: message]` mentions — ordering depends on LLM behavior. Add a system-enforced sequential pipeline mode.

**Motivation:** Different models per stage for cost optimization (e.g., Opus for planning, Pi for QA/review).

- [x] Add `mode` field to `TeamConfig` type (`"collaborative"` default | `"pipeline"`)
- [x] Add `pipeline` array to `TeamConfig` defining agent execution order
- [x] In `handleTeamResponse`, when `mode === "pipeline"`, auto-enqueue the next agent instead of relying on mention parsing
- [x] Pass previous agent's response as input to the next agent
- [x] Support shared working directory or git worktree chain so each agent sees the previous agent's file changes
- [x] Add pipeline status tracking and ability to retry from a specific stage

Example config:
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

## Workflow: Agent Pipeline (Per Repo)

Two repos, one team per repo, running as parallel pipelines. Human creates plans/specs in Obsidian, agent executes autonomously.

### Human Phase (manual)
- Brainstorm using superpowers brainstorming skill
- Create plan and spec
- Track epics/stories in Obsidian TaskNotes

### Agent Phase (autonomous)
- [ ] **Step 1:** Read epic, stories, plan, and spec from Obsidian
- [ ] **Step 2:** Execute plan using `/execute-plan` (superpowers skill)
- [ ] **Step 3:** Code review using `/ark-code-review --thorough --plan <plan-file>`
- [ ] **Step 4:** Fix all issues discovered by code review
- [ ] **Step 5:** Human gate — notify and await approval to deploy
- [ ] **Step 6:** Deploy the code
- [ ] **Step 7:** QA testing via Pi CLI (inside Claude Code)
- [ ] **Step 8:** Fix QA issues
- [ ] **Step 9:** `/codebase-maintenance --full` — update Obsidian docs
- [ ] **Step 10:** Create session log on Obsidian using `/notebooklm-vault` skill
- [ ] **Step 11:** Create a PR

**Throughout:** Agent can query NotebookLM via `/notebooklm-vault` for codebase questions.

### Design Decisions
- **Pi for QA/review** — cheaper model for structured tasks, Opus/Sonnet for planning and implementation
- **Obsidian as single source of truth** — epics, stories, specs, docs, session logs
- **Human gate before deploy** — everything else is reversible, deployment is not
- **Git worktrees** (not submodules) for agent workspace isolation on same repo

### Open Questions
- How to capture and parse Pi CLI output so Claude Code can act on QA results
- Context compression over the long pipeline — agent can re-read plan/spec files from disk
- PR template/format per repo
