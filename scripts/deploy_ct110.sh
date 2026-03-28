#!/usr/bin/env bash
set -euo pipefail

# TinyAGI Deployment Script — deploys to CT110 via Proxmox
#
# Usage:
#   ./scripts/deploy_ct110.sh              # Deploy current branch
#   ./scripts/deploy_ct110.sh --dry-run    # Show what would happen
#   ./scripts/deploy_ct110.sh --templates  # Only update CLAUDE.md templates
#   ./scripts/deploy_ct110.sh --restart    # Only restart services

PROXMOX_HOST="192.168.68.10"
CT_ID="110"
CT_USER="strategist"
REMOTE_PATH="/opt/tinyagi"
BUNDLE_PATH="/tmp/tinyagi-deploy.bundle"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
COMMIT="$(git rev-parse --short HEAD)"

DRY_RUN=false
TEMPLATES_ONLY=false
RESTART_ONLY=false

for arg in "$@"; do
    case $arg in
        --dry-run) DRY_RUN=true ;;
        --templates) TEMPLATES_ONLY=true ;;
        --restart) RESTART_ONLY=true ;;
    esac
done

# Helper: run command on CT110 as strategist
ct_exec() {
    ssh root@${PROXMOX_HOST} "pct exec ${CT_ID} -- su - ${CT_USER} -c '$1'"
}

# Helper: run command on CT110 as root
ct_root() {
    ssh root@${PROXMOX_HOST} "pct exec ${CT_ID} -- bash -c '$1'"
}

log() { echo "[deploy] $1"; }

# ── Restart only ──────────────────────────────────────────────────────────────
if $RESTART_ONLY; then
    log "Restarting TinyAGI services..."
    ct_root "systemctl restart tinyagi-queue && systemctl restart tinyagi-discord && systemctl restart tinyagi-office"
    sleep 3
    ct_root "systemctl is-active tinyagi-queue tinyagi-discord tinyagi-office"
    log "All services restarted."
    exit 0
fi

# ── Templates only ────────────────────────────────────────────────────────────
copy_templates() {
    log "Copying CLAUDE.md templates to agent workspaces..."
    ct_exec "cd ${REMOTE_PATH} && \
        cp templates/workflow/arksignal-manager-CLAUDE.md ~/.tinyagi/.agents/arksignal-manager/workspace/.claude/CLAUDE.md && \
        cp templates/workflow/arksignal-dev-CLAUDE.md ~/.tinyagi/.agents/arksignal-dev/workspace/.claude/CLAUDE.md && \
        cp templates/workflow/arksignal-debug-CLAUDE.md ~/.tinyagi/.agents/arksignal-debug/workspace/.claude/CLAUDE.md && \
        cp templates/workflow/arksignal-deploy-CLAUDE.md ~/.tinyagi/.agents/arksignal-deploy/workspace/.claude/CLAUDE.md && \
        cp templates/workflow/arksignal-plan-CLAUDE.md ~/.tinyagi/.agents/arksignal-plan/workspace/.claude/CLAUDE.md && \
        cp templates/workflow/arksignal-general-CLAUDE.md ~/.tinyagi/.agents/arksignal-general/workspace/.claude/CLAUDE.md && \
        cp templates/workflow/arkpoly-manager-CLAUDE.md ~/.tinyagi/.agents/arkpoly-manager/workspace/.claude/CLAUDE.md && \
        cp templates/workflow/arkpoly-dev-CLAUDE.md ~/.tinyagi/.agents/arkpoly-dev/workspace/.claude/CLAUDE.md && \
        cp templates/workflow/arkpoly-debug-CLAUDE.md ~/.tinyagi/.agents/arkpoly-debug/workspace/.claude/CLAUDE.md && \
        cp templates/workflow/arkpoly-deploy-CLAUDE.md ~/.tinyagi/.agents/arkpoly-deploy/workspace/.claude/CLAUDE.md && \
        cp templates/workflow/arkpoly-plan-CLAUDE.md ~/.tinyagi/.agents/arkpoly-plan/workspace/.claude/CLAUDE.md && \
        cp templates/workflow/arkpoly-general-CLAUDE.md ~/.tinyagi/.agents/arkpoly-general/workspace/.claude/CLAUDE.md"
    log "Templates copied."
}

if $TEMPLATES_ONLY; then
    copy_templates
    exit 0
fi

# ── Full deployment ───────────────────────────────────────────────────────────

log "Deploying TinyAGI branch '${BRANCH}' (${COMMIT}) to CT110..."

if $DRY_RUN; then
    log "[DRY RUN] Would deploy ${BRANCH} (${COMMIT}) to ${REMOTE_PATH}"
    log "[DRY RUN] Steps: bundle → transfer → build → templates → restart"
    exit 0
fi

# Step 1: Create git bundle
log "Creating git bundle..."
git bundle create ${BUNDLE_PATH} ${BRANCH}

# Step 2: Transfer to Proxmox host → CT110
log "Transferring bundle to CT110..."
scp ${BUNDLE_PATH} root@${PROXMOX_HOST}:/tmp/
ssh root@${PROXMOX_HOST} "pct push ${CT_ID} ${BUNDLE_PATH} ${BUNDLE_PATH}"

# Step 3: Fix permissions and update code
log "Updating code on CT110..."
ct_root "chown -R ${CT_USER}:${CT_USER} ${REMOTE_PATH}/.git"
ct_exec "cd ${REMOTE_PATH} && git fetch ${BUNDLE_PATH} ${BRANCH}:FETCH_HEAD && git reset --hard FETCH_HEAD"

# Step 4: Build
log "Building TypeScript..."
ct_exec "cd ${REMOTE_PATH} && npx tsc --build"

# Step 5: Copy CLAUDE.md templates
copy_templates

# Step 6: Restart services
log "Restarting services..."
ct_root "systemctl restart tinyagi-queue && systemctl restart tinyagi-discord && systemctl restart tinyagi-office"

# Step 7: Verify
sleep 3
log "Verifying services..."
ct_root "systemctl is-active tinyagi-queue tinyagi-discord tinyagi-office"

# Step 8: Health check
log "Running health check..."
HEALTH=$(ssh root@${PROXMOX_HOST} "pct exec ${CT_ID} -- su - ${CT_USER} -c 'curl -s http://localhost:3778/api/agents | python3 -c \"import sys,json; print(len(json.load(sys.stdin)))\"'" 2>/dev/null || echo "0")
log "Health: ${HEALTH} agents loaded"

# Cleanup
log "Cleaning up bundles..."
rm -f ${BUNDLE_PATH}
ssh root@${PROXMOX_HOST} "rm -f ${BUNDLE_PATH}" 2>/dev/null
ct_root "rm -f ${BUNDLE_PATH}" 2>/dev/null

DEPLOYED_COMMIT=$(ct_exec "cd ${REMOTE_PATH} && git log --oneline -1" 2>/dev/null)
log "Deployed: ${DEPLOYED_COMMIT}"
log "Done."
