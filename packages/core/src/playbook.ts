/**
 * Playbook runner — loads YAML definitions, resolves stages, orchestrates runs.
 * Bridges playbook definitions with the pipeline system and message queue.
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { SCRIPT_DIR } from './config';
import { getSettings, getAgents } from './config';
import { getDb, enqueueMessage } from './queues';
import { createPipelineRun } from './pipeline';
import { genId } from './ids';
import { log } from './logging';
import type { AgentConfig } from './types';

// ── Types ──────────────────────────────────────────────────────────────────

export interface PlaybookStage {
    name: string;
    agent: string;        // role suffix: 'plan', 'dev', 'general', etc.
    skills: string[];     // e.g., ['/brainstorming', '/write-plan']
    checkpoint?: string;  // 'human-approval' | undefined
    checkpoint_hint?: string;
    on_failure: 'halt' | 'retry' | 'skip';
    max_retries?: number; // default: 2
    skip_if?: string;     // 'planned' | undefined
}

export interface Playbook {
    intent: string;
    agents: string[];
    params?: string[];
    vault_output: string[];
    stages: PlaybookStage[];
}

export interface PlaybookRun {
    id: string;
    pipeline_run_id: string;
    team_id: string;
    intent: string;
    description: string;
    task_note_ref: string | null;
    playbook_status: 'running' | 'paused' | 'stale' | 'completed' | 'failed';
    stages_json: string;       // JSON of resolved stages with metadata
    current_stage_name: string;
    metrics_json: string | null; // JSON of per-stage metrics
    skip_plan: boolean;
    created_at: number;
    updated_at: number;
}

// ── Raw YAML types (before validation) ─────────────────────────────────────

interface RawStage {
    name?: string;
    agent?: string;
    skills?: string[];
    checkpoint?: string;
    checkpoint_hint?: string;
    on_failure?: string;
    max_retries?: number;
    skip_if?: string;
    $include?: string;
}

interface RawPlaybook {
    intent?: string;
    agents?: string[];
    params?: string[];
    vault_output?: string[];
    stages?: RawStage[];
}

// ── Helpers ────────────────────────────────────────────────────────────────

function getPlaybooksDir(): string {
    return path.join(SCRIPT_DIR, 'templates', 'playbooks');
}

function loadSharedStages(): Record<string, RawStage[]> {
    const sharedPath = path.join(getPlaybooksDir(), '_shared.yaml');
    if (!fs.existsSync(sharedPath)) {
        return {};
    }
    const content = fs.readFileSync(sharedPath, 'utf8');
    const parsed = yaml.load(content) as Record<string, RawStage[]> | null;
    return parsed || {};
}

// ── loadPlaybook ───────────────────────────────────────────────────────────

export function loadPlaybook(intent: string): Playbook {
    const playbookPath = path.join(getPlaybooksDir(), `${intent}.yaml`);

    if (!fs.existsSync(playbookPath)) {
        throw new Error(
            `Playbook not found: '${intent}'. ` +
            `Expected file at ${playbookPath}. ` +
            `Available playbooks: ${listAvailablePlaybooks().join(', ') || 'none'}`
        );
    }

    const content = fs.readFileSync(playbookPath, 'utf8');
    const raw = yaml.load(content) as RawPlaybook;

    if (!raw || typeof raw !== 'object') {
        throw new Error(`Playbook '${intent}' is empty or invalid YAML`);
    }

    // Validate required top-level fields
    if (!raw.intent) throw new Error(`Playbook '${intent}': missing required field 'intent'`);
    if (!raw.agents || !Array.isArray(raw.agents) || raw.agents.length === 0) {
        throw new Error(`Playbook '${intent}': missing or empty 'agents' array`);
    }
    if (!raw.vault_output || !Array.isArray(raw.vault_output) || raw.vault_output.length === 0) {
        throw new Error(`Playbook '${intent}': missing or empty 'vault_output' array`);
    }
    if (!raw.stages || !Array.isArray(raw.stages) || raw.stages.length === 0) {
        throw new Error(`Playbook '${intent}': missing or empty 'stages' array`);
    }

    // Resolve $include references
    const shared = loadSharedStages();
    const resolvedStages: PlaybookStage[] = [];

    for (const rawStage of raw.stages) {
        if (rawStage.$include) {
            const groupName = rawStage.$include;
            const group = shared[groupName];
            if (!group || !Array.isArray(group)) {
                throw new Error(
                    `Playbook '${intent}': $include '${groupName}' not found in _shared.yaml. ` +
                    `Available groups: ${Object.keys(shared).join(', ') || 'none'}`
                );
            }
            for (const sharedStage of group) {
                resolvedStages.push(validateStage(sharedStage, intent, groupName));
            }
        } else {
            resolvedStages.push(validateStage(rawStage, intent));
        }
    }

    return {
        intent: raw.intent,
        agents: raw.agents,
        params: raw.params,
        vault_output: raw.vault_output,
        stages: resolvedStages,
    };
}

function validateStage(raw: RawStage, intent: string, includeSource?: string): PlaybookStage {
    const context = includeSource ? ` (from $include '${includeSource}')` : '';

    if (!raw.name) {
        throw new Error(`Playbook '${intent}': stage missing required field 'name'${context}`);
    }
    if (!raw.agent) {
        throw new Error(`Playbook '${intent}': stage '${raw.name}' missing required field 'agent'${context}`);
    }
    if (!raw.skills || !Array.isArray(raw.skills)) {
        throw new Error(`Playbook '${intent}': stage '${raw.name}' missing required field 'skills'${context}`);
    }
    if (!raw.on_failure) {
        throw new Error(`Playbook '${intent}': stage '${raw.name}' missing required field 'on_failure'${context}`);
    }

    const validFailureModes = ['halt', 'retry', 'skip'];
    if (!validFailureModes.includes(raw.on_failure)) {
        throw new Error(
            `Playbook '${intent}': stage '${raw.name}' has invalid on_failure '${raw.on_failure}'. ` +
            `Must be one of: ${validFailureModes.join(', ')}${context}`
        );
    }

    return {
        name: raw.name,
        agent: raw.agent,
        skills: raw.skills,
        checkpoint: raw.checkpoint,
        checkpoint_hint: raw.checkpoint_hint,
        on_failure: raw.on_failure as 'halt' | 'retry' | 'skip',
        max_retries: raw.max_retries ?? 2,
        skip_if: raw.skip_if,
    };
}

function listAvailablePlaybooks(): string[] {
    try {
        const dir = getPlaybooksDir();
        return fs.readdirSync(dir)
            .filter(f => f.endsWith('.yaml') && !f.startsWith('_'))
            .map(f => f.replace('.yaml', ''));
    } catch {
        return [];
    }
}

// ── resolvePlaybook ────────────────────────────────────────────────────────

export function resolvePlaybook(
    playbook: Playbook,
    teamId: string,
    agents: Record<string, AgentConfig>,
    taskNoteRef?: string,
    skipPlan?: boolean,
    includePlan?: boolean,
): { stages: PlaybookStage[]; pipeline: string[]; planningArtifacts?: string[] } {
    // Resolve agent role suffixes to team-specific IDs
    let stages = playbook.stages.map(stage => ({
        ...stage,
        agent: `${teamId}-${stage.agent}`,
    }));

    // Validate resolved agent IDs exist in agents config
    for (const stage of stages) {
        if (!agents[stage.agent]) {
            throw new Error(
                `Playbook '${playbook.intent}': resolved agent '${stage.agent}' ` +
                `(stage '${stage.name}') not found in agents config. ` +
                `Available agents: ${Object.keys(agents).join(', ')}`
            );
        }
    }

    let planningArtifacts: string[] | undefined;

    // Handle TaskNote-based planning resolution
    if (taskNoteRef) {
        const planningStatus = readTaskNotePlanningStatus(agents, stages, taskNoteRef);

        if ((planningStatus === 'complete' || skipPlan) && !includePlan) {
            // Remove planning stages and collect planning artifacts
            const planningLinks = readTaskNotePlanningArtifacts(agents, stages, taskNoteRef);
            if (planningLinks.length > 0) {
                planningArtifacts = planningLinks;
            }
            stages = stages.filter(s => s.skip_if !== 'planned');
        }
        // If planning is 'in-progress', keep all stages (planning artifacts used as context)
        if (planningStatus === 'in-progress') {
            const planningLinks = readTaskNotePlanningArtifacts(agents, stages, taskNoteRef);
            if (planningLinks.length > 0) {
                planningArtifacts = planningLinks;
            }
        }
    } else if (skipPlan && !includePlan) {
        // skipPlan flag without TaskNote: just remove skip_if:planned stages
        stages = stages.filter(s => s.skip_if !== 'planned');
    }

    // Build pipeline: ordered list of resolved agent IDs
    const pipeline = stages.map(s => s.agent);

    return { stages, pipeline, planningArtifacts };
}

function getVaultPath(agents: Record<string, AgentConfig>, stages: PlaybookStage[]): string | null {
    // Use the first stage's agent to find the vault path
    if (stages.length === 0) return null;
    const firstAgentId = stages[0].agent;
    const agentConfig = agents[firstAgentId];
    if (!agentConfig?.working_directory) return null;
    return path.join(agentConfig.working_directory, 'vault');
}

function readTaskNotePlanningStatus(
    agents: Record<string, AgentConfig>,
    stages: PlaybookStage[],
    taskNoteRef: string,
): string | null {
    const vaultPath = getVaultPath(agents, stages);
    if (!vaultPath) return null;

    const taskNotePath = findTaskNote(vaultPath, taskNoteRef);
    if (!taskNotePath) return null;

    try {
        const content = fs.readFileSync(taskNotePath, 'utf8');
        const frontmatter = extractFrontmatter(content);
        return frontmatter?.planning ?? null;
    } catch {
        return null;
    }
}

function readTaskNotePlanningArtifacts(
    agents: Record<string, AgentConfig>,
    stages: PlaybookStage[],
    taskNoteRef: string,
): string[] {
    const vaultPath = getVaultPath(agents, stages);
    if (!vaultPath) return [];

    const taskNotePath = findTaskNote(vaultPath, taskNoteRef);
    if (!taskNotePath) return [];

    try {
        const content = fs.readFileSync(taskNotePath, 'utf8');
        const frontmatter = extractFrontmatter(content);
        if (!frontmatter?.planning_artifacts) return [];
        if (Array.isArray(frontmatter.planning_artifacts)) {
            return frontmatter.planning_artifacts;
        }
        return [String(frontmatter.planning_artifacts)];
    } catch {
        return [];
    }
}

function findTaskNote(vaultPath: string, taskNoteRef: string): string | null {
    const subdirs = ['Epic', 'Story', 'Bug'];
    const tasksDir = path.join(vaultPath, 'Tasks');

    for (const subdir of subdirs) {
        const candidate = path.join(tasksDir, subdir, `${taskNoteRef}.md`);
        if (fs.existsSync(candidate)) return candidate;
    }

    // Also check Tasks/ directly
    const directPath = path.join(tasksDir, `${taskNoteRef}.md`);
    if (fs.existsSync(directPath)) return directPath;

    return null;
}

function extractFrontmatter(content: string): Record<string, any> | null {
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return null;
    try {
        return yaml.load(match[1]) as Record<string, any>;
    } catch {
        return null;
    }
}

// ── formatStageMessage ─────────────────────────────────────────────────────

export function formatStageMessage(
    playbook: Playbook,
    stage: PlaybookStage,
    stageIndex: number,
    totalStages: number,
    description: string,
    previousResponse?: string,
    planningArtifacts?: string[],
): string {
    const parts: string[] = [];

    // Header
    const prefix = `[playbook:${playbook.intent} stage:${stageIndex + 1}/${totalStages}]`;
    if (stage.skills.length > 0) {
        parts.push(`${prefix} Execute ${stage.skills.join(', ')} for:`);
    } else {
        parts.push(`${prefix} Complete the following task:`);
    }
    parts.push('');
    parts.push(description);

    // Previous response context
    if (previousResponse) {
        parts.push('');
        parts.push('Context from previous stage:');
        parts.push(previousResponse);
    }

    // Planning artifacts
    if (planningArtifacts && planningArtifacts.length > 0) {
        parts.push('');
        parts.push('Planning artifacts:');
        parts.push(planningArtifacts.join('\n'));
    }

    // Checkpoint hint
    if (stage.checkpoint && stage.checkpoint_hint) {
        parts.push('');
        parts.push(`CHECKPOINT: ${stage.checkpoint_hint}`);
    }

    return parts.join('\n');
}

// ── startPlaybookRun ───────────────────────────────────────────────────────

export function startPlaybookRun(
    teamId: string,
    intent: string,
    description: string,
    channel: string,
    sender: string,
    senderId: string | null,
    messageId: string,
    taskNoteRef?: string,
    skipPlan?: boolean,
    includePlan?: boolean,
): { runId: string; pipelineRunId: string } {
    const playbook = loadPlaybook(intent);

    const settings = getSettings();
    const agents = getAgents(settings);

    const { stages, pipeline, planningArtifacts } = resolvePlaybook(
        playbook, teamId, agents, taskNoteRef, skipPlan, includePlan,
    );

    if (stages.length === 0) {
        throw new Error(`Playbook '${intent}': no stages remaining after resolution`);
    }

    // Create the pipeline run
    const pipelineRunId = createPipelineRun(
        teamId, channel, sender, senderId ?? undefined, messageId, description, pipeline,
    );

    // Create the playbook_runs row
    const runId = genId('playbook');
    const now = Date.now();
    getDb().prepare(
        `INSERT INTO playbook_runs (id, pipeline_run_id, team_id, intent, description, task_note_ref, playbook_status, stages_json, current_stage_name, metrics_json, skip_plan, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, NULL, ?, ?, ?)`
    ).run(
        runId, pipelineRunId, teamId, intent, description,
        taskNoteRef ?? null,
        JSON.stringify(stages),
        stages[0].name,
        (skipPlan ?? false) ? 1 : 0,
        now, now,
    );

    // Build the resolved playbook for formatStageMessage (with original agents for display)
    const resolvedPlaybook: Playbook = { ...playbook, stages };

    // Format and enqueue the first stage message
    const firstStage = stages[0];
    const message = formatStageMessage(
        resolvedPlaybook, firstStage, 0, stages.length,
        description, undefined, planningArtifacts,
    );

    enqueueMessage({
        channel,
        sender,
        senderId: senderId ?? undefined,
        message,
        messageId: genId('pbmsg'),
        agent: firstStage.agent,
        pipelineRunId,
    });

    log('INFO', `Playbook run started: ${runId} (intent=${intent}, pipeline=${pipelineRunId}, stages=${stages.length})`);

    return { runId, pipelineRunId };
}

// ── CRUD ───────────────────────────────────────────────────────────────────

/**
 * No-op — the playbook_runs table is created in initQueueDb() (queues.ts).
 * Kept for API consistency with initPipelineDb / initGateDb.
 */
export function initPlaybookDb(): void {
    // Table already created by initQueueDb()
}

export function getPlaybookRun(runId: string): PlaybookRun | null {
    const row = getDb().prepare('SELECT * FROM playbook_runs WHERE id = ?').get(runId) as any;
    if (!row) return null;
    return {
        ...row,
        skip_plan: !!row.skip_plan,
    };
}

export function getPlaybookRunByPipelineId(pipelineRunId: string): PlaybookRun | null {
    const row = getDb().prepare(
        'SELECT * FROM playbook_runs WHERE pipeline_run_id = ?'
    ).get(pipelineRunId) as any;
    if (!row) return null;
    return {
        ...row,
        skip_plan: !!row.skip_plan,
    };
}

export function updatePlaybookStatus(runId: string, status: PlaybookRun['playbook_status']): void {
    getDb().prepare(
        `UPDATE playbook_runs SET playbook_status = ?, updated_at = ? WHERE id = ?`
    ).run(status, Date.now(), runId);
}

export function updatePlaybookStage(runId: string, stageName: string): void {
    getDb().prepare(
        `UPDATE playbook_runs SET current_stage_name = ?, updated_at = ? WHERE id = ?`
    ).run(stageName, Date.now(), runId);
}

// ── writeMetrics ───────────────────────────────────────────────────────────

export function writeMetrics(runId: string, vaultPath: string): void {
    const run = getPlaybookRun(runId);
    if (!run) {
        log('WARN', `writeMetrics: playbook run '${runId}' not found`);
        return;
    }

    const stages: PlaybookStage[] = JSON.parse(run.stages_json);
    const metricsData = JSON.parse(run.metrics_json || '{}');

    const date = new Date(run.created_at).toISOString().split('T')[0];
    const slug = run.description
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .substring(0, 40);

    const metricsDir = path.join(vaultPath, 'pipeline-runs', `${date}-${run.intent}-${slug}`);
    fs.mkdirSync(metricsDir, { recursive: true });

    const metricsContent = {
        playbook: run.intent,
        run_id: run.id,
        pipeline_run_id: run.pipeline_run_id,
        team_id: run.team_id,
        status: run.playbook_status,
        created_at: new Date(run.created_at).toISOString(),
        updated_at: new Date(run.updated_at).toISOString(),
        duration_ms: run.updated_at - run.created_at,
        stages: stages.map((stage) => ({
            name: stage.name,
            agent: stage.agent,
            skills: stage.skills,
            outcome: metricsData[stage.name]?.outcome ?? 'unknown',
            duration_ms: metricsData[stage.name]?.duration_ms ?? null,
        })),
    };

    const metricsPath = path.join(metricsDir, 'metrics.yaml');
    fs.writeFileSync(metricsPath, yaml.dump(metricsContent, { lineWidth: 120 }));
    log('INFO', `Metrics written to ${metricsPath}`);
}
