# ArkPoly Developer — Autonomous Workflow

You are an autonomous development agent for the ArkPoly project. When you receive a TaskNote ticker (e.g., "ArkPoly-042"), follow this workflow exactly.

## Phase 1: Understand

1. Parse the ticker from the message (e.g., `ArkPoly-042` -> look for `ArkPoly-042-*.md`)
2. Pull the latest repo (vault is part of the repo): `cd workspace && git pull`
3. Read the epic from `vault/TaskNotes/Tasks/Epic/ArkPoly-042-*.md`
4. Parse YAML frontmatter: check `status`, `priority`, `blockedBy`
5. If any `blockedBy` dependencies have status other than `done`, STOP and report: "Blocked by {taskId} (status: {status})"
6. Follow `[[wikilinks]]` to read all linked stories in `vault/TaskNotes/Tasks/Story/`
7. Collect all acceptance criteria (lines starting with `- [ ]`)
8. Read any referenced specs or plans
9. Create a git worktree using the full epic filename (without `.md`): `git worktree add ../../worktrees/ArkPoly-042-<slug> -b ArkPoly-042-<slug>` (e.g., `ArkPoly-003-polymarket-pipeline`)
10. Change to the worktree directory for all subsequent work

## Phase 2: Implement

11. Check if a plan already exists in `docs/superpowers/plans/` for this epic
12. If no plan exists: use `/write-plan` skill to create one
13. Execute the plan using `superpowers:subagent-driven-development` skill
14. Run code review — scale to the scope of the work:
    - **Epic** (multi-story, broad changes): `/ark-code-review --full`
    - **Story** (single focused change): `/ark-code-review --thorough`
15. Fix all issues found
16. Re-run code review if needed (max 2 iterations)

## Phase 3: Deploy & Validate

17. Deploy:
    ```bash
    # TODO: ArkPoly deploy pipeline TBD — replace with actual deploy commands
    echo "ArkPoly deployment not yet configured"
    ```
18. Run QA via Pi CLI:
    ```bash
    pi "Review this diff for bugs, logic errors, and regressions against these acceptance criteria: $(cat acceptance_criteria.txt). Diff: $(git diff main..HEAD)"
    ```
19. Capture Pi's output to `./evidence/qa-review.txt`
20. If Pi finds issues: fix them, re-deploy, re-QA (max 2 iterations)

## Phase 4: Wrap Up

21. Create session log using `/notebooklm-vault` skill — hand off session context to the vault before maintenance
22. Run `/codebase-maintenance --full` to update Obsidian docs
23. Update the TaskNote frontmatter: set `status: done`, then commit and push (vault is part of the repo):
    ```bash
    cd workspace && git add -A && git commit -m "mark <ticker> as done" && git push
    ```
24. Create a PR:
    ```bash
    gh pr create \
      --title "[ArkPoly-042] <epic title>" \
      --body "## Summary\n<description>\n\n## Evidence\n<paste health check + QA results>\n\n## Acceptance Criteria\n<checklist>"
    ```
25. If evidence screenshots exist in `./evidence/`, attach them as PR comments
26. Clean up worktree: `cd ../.. && git worktree remove worktrees/ArkPoly-042-<slug>`

## Rules

- **NEVER deploy to production** — only validate locally. Production deployment is done by humans after PR review.
- **Always kill test/staging services when done** — never leave test processes running after validation.
- If you encounter an error you can't resolve, report it clearly and stop.
- Always work inside the git worktree, never on main directly.
- Commit frequently with descriptive messages during implementation.
