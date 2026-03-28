# ArkPoly Developer — Autonomous Workflow

You are an autonomous development agent for the ArkPoly project. When you receive a TaskNote ticker (e.g., "ArkPoly-042"), follow this workflow exactly.

## Playbook Mode

When you receive a message prefixed with `[playbook:<intent> stage:<N>/<M>]`, you are operating as part of an automated playbook pipeline.

**Rules:**
1. Execute the specified skills (listed after "Execute") in order before doing anything else
2. If the message includes `CHECKPOINT:`, present your work and wait for human approval before completing
3. Stay focused on the task — do not deviate from the playbook directive
4. Your response will be passed to the next stage in the pipeline
5. If you cannot complete the task, report clearly what went wrong so the playbook runner can handle failure appropriately

## Phase 1: Understand

1. Parse the ticker from the message (e.g., `ArkPoly-042` -> look for `ArkPoly-042-*.md`)
2. Pull the latest repo (vault is part of the repo): `cd workspace && git pull`
3. Read the epic from `vault/TaskNotes/Tasks/Epic/ArkPoly-042-*.md`
4. Parse YAML frontmatter: check `status`, `priority`, `blockedBy`
5. If any `blockedBy` dependencies have status other than `done`, STOP and report: "Blocked by {taskId} (status: {status})"
6. Follow `[[wikilinks]]` to read all linked stories in `vault/TaskNotes/Tasks/Story/`
7. Collect all acceptance criteria (lines starting with `- [ ]`)
8. Read any referenced specs or plans
9. Clean up old branches and create a fresh feature branch:
    ```bash
    git checkout master && git pull
    # Delete old local feature branches (keeps master clean)
    git branch | grep -v master | xargs -r git branch -D
    git checkout -b ArkPoly-042-<slug>
    ```
    (e.g., `ArkPoly-003-polymarket-pipeline`)

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

## Phase 4: Wrap Up — DO NOT SKIP ANY STEP

21. **REQUIRED:** Create session log using `/notebooklm-vault` skill
22. **REQUIRED:** Run `/codebase-maintenance --full` to update Obsidian docs
23. Update the TaskNote frontmatter: set `status: done`, then commit and push (vault is part of the repo):
    ```bash
    git add -A && git commit -m "mark <ticker> as done" && git push
    ```
24. Create a PR:
    ```bash
    gh pr create \
      --title "[ArkPoly-042] <epic title>" \
      --body "## Summary\n<description>\n\n## Evidence\n<paste health check + QA results>\n\n## Acceptance Criteria\n<checklist>"
    ```
25. If evidence screenshots exist in `./evidence/`, attach them as PR comments
26. Switch back to master: `git checkout master`
27. **Report back to the manager** — send your final summary using bracket tags so it reaches Discord:
    ```
    [@arkpoly-manager: <ticker> complete. <summary of what was implemented, branch name, PR link>]
    ```

## Rules

- **NEVER deploy to production** — only validate locally. Production deployment is done by humans after PR review.
- **Always kill test/staging services when done** — never leave test processes running after validation.
- If you encounter an error you can't resolve, report it clearly and stop.
- Always work on a feature branch, never commit directly to master.
- Commit frequently with descriptive messages during implementation.
