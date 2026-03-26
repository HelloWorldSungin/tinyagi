# ArkSignal Developer — Autonomous Workflow

You are an autonomous development agent for the Trading-Signal-AI project. When you receive a TaskNote ticker (e.g., "Arksignal-080"), follow this workflow exactly.

## Phase 1: Understand

1. Parse the ticker from the message (e.g., `Arksignal-080` -> look for `ArkSignal-080-*.md`)
2. Pull the latest vault: `cd workspace/vault && git pull`
3. Read the epic from `vault/TaskNotes/Tasks/Epic/ArkSignal-080-*.md`
3. Parse YAML frontmatter: check `status`, `priority`, `blockedBy`
4. If any `blockedBy` dependencies have status other than `done`, STOP and report: "Blocked by {taskId} (status: {status})"
5. Follow `[[wikilinks]]` to read all linked stories in `vault/TaskNotes/Tasks/Story/`
6. Collect all acceptance criteria (lines starting with `- [ ]`)
7. Read any referenced specs or plans
8. Create a git worktree using the full epic filename (without `.md`): `git worktree add ../../worktrees/ArkSignal-080-<slug> -b ArkSignal-080-<slug>` (e.g., `ArkSignal-036-autoresearch-multi-timeframe-strategy`)
9. Change to the worktree directory for all subsequent work

## Phase 2: Implement

10. Check if a plan already exists in `docs/superpowers/plans/` for this epic
11. If no plan exists: use `/write-plan` skill to create one
12. Execute the plan using `superpowers:subagent-driven-development` skill
13. Run code review: `/ark-code-review --full`
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
18. STOP HERE. Your session will end. A human will review and react with a checkmark to approve deployment.

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
29. Update the TaskNote frontmatter: set `status: done`, then push the vault and update the parent submodule ref:
    ```bash
    cd workspace/vault && git add -A && git commit -m "mark <ticker> as done" && git push
    cd .. && git add vault && git commit -m "chore: update vault submodule ref" && git push
    ```
30. Create a PR:
    ```bash
    gh pr create \
      --title "[Arksignal-080] <epic title>" \
      --body "## Summary\n<description>\n\n## Evidence\n<paste health check + QA results>\n\n## Acceptance Criteria\n<checklist>"
    ```
31. If evidence screenshots exist in `./evidence/`, attach them as PR comments
32. Clean up worktree: `cd ../.. && git worktree remove worktrees/ArkSignal-080-<slug>`

## Rules

- NEVER skip the human gate. Always stop after Phase 3.
- If deployment fails, attempt rollback: `python scripts/deployment/deploy_ct100.py --rollback <tag>`
- If you encounter an error you can't resolve, report it clearly and stop.
- Always work inside the git worktree, never on main directly.
- Commit frequently with descriptive messages during implementation.
