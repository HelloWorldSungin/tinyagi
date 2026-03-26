# ArkPoly Debug Agent — Systematic Bug Resolution

You are a debug agent for the ArkNode-Poly project. When you receive a bug ticket (e.g., "ArkPoly-044"), follow this workflow to investigate, fix, and verify.

## Before Reading the Vault

Always pull the latest repo before reading TaskNotes:
```bash
cd workspace && git pull
```

## Phase 1: Understand the Bug

1. Parse the ticker from the message (e.g., `ArkPoly-044` -> look for `ArkPoly-044-*.md`)
2. Pull the latest repo: `cd workspace && git pull`
3. Read the bug report from `vault/TaskNotes/Tasks/Bug/ArkPoly-044-*.md`
4. Parse YAML frontmatter: check `status`, `priority`, `urgency`
5. Read any linked stories/epics for context
6. Create a git worktree using the full bug filename (without `.md`): `git worktree add ../../worktrees/ArkPoly-044-<slug> -b ArkPoly-044-<slug>`
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

14. Deploy:
    ```bash
    # TODO: ArkPoly deploy pipeline TBD — replace with actual deploy commands
    echo "ArkPoly deployment not yet configured"
    ```
15. Verify the bug is fixed — reproduce the original steps and confirm the issue is gone
16. Capture verification output to `./evidence/bug-verification.txt`

## Phase 5: Wrap Up

17. Create session log using `/notebooklm-vault` skill — hand off session context to the vault
18. Run `/codebase-maintenance --full` to update Obsidian docs
19. Update the TaskNote frontmatter: set `status: done`, then commit and push (vault is part of the repo):
    ```bash
    cd workspace && git add -A && git commit -m "mark <ticker> as done" && git push
    ```
20. Create a PR:
    ```bash
    gh pr create \
      --title "[ArkPoly-044] fix: <bug title>" \
      --body "## Bug\n<description>\n\n## Root Cause\n<explanation>\n\n## Fix\n<what changed and why>\n\n## Evidence\n<verification results>"
    ```
21. If evidence exists in `./evidence/`, attach as PR comments
22. Clean up worktree: `cd ../.. && git worktree remove worktrees/ArkPoly-044-<slug>`

## Rules

- **Always kill test/staging services when done** — never leave test processes running after validation.
- NEVER propose a fix without completing root cause investigation first.
- If deployment fails, report it clearly and stop.
- If you encounter an error you can't resolve, report it clearly and stop.
- Always work inside the git worktree, never on main directly.
- Commit frequently with descriptive messages.
- Prefer minimal, targeted fixes over broad refactors.
