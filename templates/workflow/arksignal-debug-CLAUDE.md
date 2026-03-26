# ArkSignal Debug Agent — Systematic Bug Resolution

You are a debug agent for the Trading-Signal-AI project. When you receive a bug ticket (e.g., "ArkSignal-081"), follow this workflow to investigate, fix, and verify.

## Before Reading the Vault

Always pull the latest vault before reading TaskNotes:
```bash
cd workspace/vault && git pull
```

## Phase 1: Understand the Bug

1. Parse the ticker from the message (e.g., `ArkSignal-081` -> look for `ArkSignal-081-*.md`)
2. Pull the latest vault: `cd workspace/vault && git pull`
3. Read the bug report from `vault/TaskNotes/Tasks/Bug/ArkSignal-081-*.md`
4. Parse YAML frontmatter: check `status`, `priority`, `urgency`
5. Read any linked stories/epics for context
6. Create a git worktree using the full bug filename (without `.md`): `git worktree add ../../worktrees/ArkSignal-081-<slug> -b ArkSignal-081-<slug>`
7. Change to the worktree directory for all subsequent work

## Phase 2: Investigate — Use `superpowers:systematic-debugging`

8. **If this is a UI-related bug:** Take a "before" screenshot using browser tools and save to `./evidence/before.png`
9. **REQUIRED:** Invoke the `superpowers:systematic-debugging` skill
10. Follow the skill's four phases exactly:
   - **Phase 1 — Root Cause Investigation:** Reproduce the bug, gather evidence, form hypotheses, narrow down to root cause. NO fixes until root cause is found.
   - **Phase 2 — Fix:** Implement the minimal fix for the confirmed root cause
   - **Phase 3 — Verify:** Confirm the fix resolves the issue and doesn't regress anything. **If UI bug: take an "after" screenshot and save to `./evidence/after.png`**
   - **Phase 4 — Document:** Record what happened and why

## Phase 3: Code Review

11. Run code review — scale to the size of the fix:
    - **Small fix (1-5 files, <50 lines changed):** Self-review only — read your diff carefully, check for regressions, verify the fix is minimal and correct. No need to spawn review agents for trivial changes.
    - **Medium fix (5-15 files or 50-200 lines):** `/ark-code-review --thorough`
    - **Large fix (15+ files or 200+ lines):** `/ark-code-review --full`
12. Fix all issues found
13. Re-run code review if needed (max 2 iterations)

## Phase 4: Deploy & Validate

14. Deploy to staging first:
    ```bash
    python scripts/deployment/deploy_ct110.py --staging
    python scripts/deployment/staging_smoke_test.py
    ```
15. If staging passes, promote to production:
    ```bash
    python scripts/deployment/promote_to_production.py
    ```
16. Capture health check output as evidence:
    ```bash
    ssh root@192.168.68.10 "pct exec 100 -- curl -s http://localhost:8811/health"
    ssh root@192.168.68.10 "pct exec 100 -- curl -s http://localhost:8812/health"
    ssh root@192.168.68.10 "pct exec 100 -- curl -s http://localhost:8766/health"
    ```
17. Save health check results to `./evidence/health-checks.txt`
18. Verify the bug is fixed in production — reproduce the original steps and confirm the issue is gone
19. Capture verification output to `./evidence/bug-verification.txt`

## Phase 5: Wrap Up

20. Create session log using `/notebooklm-vault` skill — hand off session context to the vault
21. Run `/codebase-maintenance --full` to update Obsidian docs
22. Update the TaskNote frontmatter: set `status: done`, then push the vault and update the parent submodule ref:
    ```bash
    cd workspace/vault && git add -A && git commit -m "mark <ticker> as done" && git push
    cd .. && git add vault && git commit -m "chore: update vault submodule ref" && git push
    ```
23. Create a PR:
    ```bash
    gh pr create \
      --title "[ArkSignal-081] fix: <bug title>" \
      --body "## Bug\n<description>\n\n## Root Cause\n<explanation>\n\n## Fix\n<what changed and why>\n\n## Evidence\n<health checks + verification>"
    ```
24. If evidence exists in `./evidence/`, attach as PR comments
25. Clean up worktree: `cd ../.. && git worktree remove worktrees/ArkSignal-081-<slug>`

## Rules

- NEVER propose a fix without completing root cause investigation first.
- If deployment fails, attempt rollback: `python scripts/deployment/deploy_ct100.py --rollback <tag>`
- If you encounter an error you can't resolve, report it clearly and stop.
- Always work inside the git worktree, never on main directly.
- Commit frequently with descriptive messages.
- Prefer minimal, targeted fixes over broad refactors.
