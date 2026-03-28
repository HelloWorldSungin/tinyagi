import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// Must set TINYAGI_HOME before any module that reads it at load time.
const TEST_HOME = vi.hoisted(() => {
    const dir = '/tmp/tinyagi-test-playbook-' + Date.now();
    process.env.TINYAGI_HOME = dir;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const _fs = require('fs');
    _fs.mkdirSync(dir + '/logs', { recursive: true });
    return dir;
});

import fs from 'fs';
import path from 'path';
import { initQueueDb, closeQueueDb, getDb } from '../queues';
import { initPipelineDb, getPipelineRun } from '../pipeline';
import {
    loadPlaybook,
    resolvePlaybook,
    formatStageMessage,
    startPlaybookRun,
    getPlaybookRun,
    getPlaybookRunByPipelineId,
    updatePlaybookStatus,
    initPlaybookDb,
} from '../playbook';
import type { Playbook, PlaybookStage } from '../playbook';
import type { AgentConfig } from '../types';
import { SCRIPT_DIR } from '../config';

beforeAll(() => {
    initQueueDb();
    initPipelineDb();
    initPlaybookDb();
});

afterAll(() => {
    closeQueueDb();
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

// ── Helper: build agent config map ─────────────────────────────────────────

function makeAgents(teamId: string, roles: string[]): Record<string, AgentConfig> {
    const agents: Record<string, AgentConfig> = {};
    for (const role of roles) {
        const id = `${teamId}-${role}`;
        agents[id] = {
            name: `${role} Agent`,
            provider: 'anthropic',
            model: 'sonnet',
            working_directory: path.join(TEST_HOME, 'workspace', id),
        };
    }
    return agents;
}

// ── loadPlaybook tests ─────────────────────────────────────────────────────

describe('loadPlaybook', () => {
    it('loads feature playbook with resolved $include stages', () => {
        const playbook = loadPlaybook('feature');

        expect(playbook.intent).toBe('feature');
        expect(playbook.agents).toEqual(['plan', 'dev', 'general']);
        expect(playbook.vault_output).toEqual(['plans', 'reviews', 'sessions']);
        expect(playbook.stages.length).toBeGreaterThan(4);

        // First stage should be brainstorm-and-spec
        expect(playbook.stages[0].name).toBe('brainstorm-and-spec');
        expect(playbook.stages[0].agent).toBe('plan');
        expect(playbook.stages[0].skills).toContain('/brainstorming');
        expect(playbook.stages[0].checkpoint).toBe('human-approval');
        expect(playbook.stages[0].skip_if).toBe('planned');

        // $include stages from wrap-up should be resolved
        const stageNames = playbook.stages.map(s => s.name);
        expect(stageNames).toContain('vault-sync');
        expect(stageNames).toContain('pr-creation');

        // vault-sync should have on_failure: skip (from _shared.yaml)
        const vaultSync = playbook.stages.find(s => s.name === 'vault-sync');
        expect(vaultSync?.on_failure).toBe('skip');
    });

    it('throws descriptive error for nonexistent playbook', () => {
        expect(() => loadPlaybook('nonexistent')).toThrow(/Playbook not found: 'nonexistent'/);
        expect(() => loadPlaybook('nonexistent')).toThrow(/Available playbooks:/);
    });

    it('loads bugfix playbook correctly', () => {
        const playbook = loadPlaybook('bugfix');
        expect(playbook.intent).toBe('bugfix');
        expect(playbook.agents).toEqual(['debug', 'dev']);
        expect(playbook.stages[0].name).toBe('investigate');
        expect(playbook.stages[0].checkpoint_hint).toContain('diagnosis');
    });
});

// ── resolvePlaybook tests ──────────────────────────────────────────────────

describe('resolvePlaybook', () => {
    it('resolves agent roles to team-specific IDs', () => {
        const playbook = loadPlaybook('review');
        const agents = makeAgents('alpha', ['general']);

        const result = resolvePlaybook(playbook, 'alpha', agents);

        expect(result.stages.length).toBe(playbook.stages.length);
        for (const stage of result.stages) {
            expect(stage.agent).toMatch(/^alpha-/);
        }
        expect(result.pipeline).toEqual(result.stages.map(s => s.agent));
    });

    it('removes skip_if:planned stages when planning is complete', () => {
        const playbook = loadPlaybook('feature');

        // Create a temp vault with a TaskNote that has planning: complete
        const agents = makeAgents('beta', ['plan', 'dev', 'general']);
        const vaultPath = path.join(agents['beta-plan'].working_directory, 'vault');
        const taskDir = path.join(vaultPath, 'Tasks', 'Story');
        fs.mkdirSync(taskDir, { recursive: true });
        fs.writeFileSync(path.join(taskDir, 'STORY-001.md'), [
            '---',
            'planning: complete',
            'planning_artifacts:',
            '  - plans/feature-spec.md',
            '  - plans/architecture.md',
            '---',
            '# Story 001',
        ].join('\n'));

        const result = resolvePlaybook(playbook, 'beta', agents, 'STORY-001');

        // brainstorm-and-spec has skip_if: planned, so it should be removed
        const stageNames = result.stages.map(s => s.name);
        expect(stageNames).not.toContain('brainstorm-and-spec');
        expect(stageNames).toContain('implement');

        // Planning artifacts should be collected
        expect(result.planningArtifacts).toEqual(['plans/feature-spec.md', 'plans/architecture.md']);
    });

    it('keeps all stages when planning status is not set', () => {
        const playbook = loadPlaybook('feature');
        const agents = makeAgents('gamma', ['plan', 'dev', 'general']);

        // No TaskNote ref — all stages remain
        const result = resolvePlaybook(playbook, 'gamma', agents);

        const stageNames = result.stages.map(s => s.name);
        expect(stageNames).toContain('brainstorm-and-spec');
        expect(stageNames).toContain('implement');
    });

    it('respects skipPlan flag override', () => {
        const playbook = loadPlaybook('feature');
        const agents = makeAgents('delta', ['plan', 'dev', 'general']);

        // skipPlan without TaskNote
        const result = resolvePlaybook(playbook, 'delta', agents, undefined, true);

        const stageNames = result.stages.map(s => s.name);
        expect(stageNames).not.toContain('brainstorm-and-spec');
        expect(stageNames).toContain('implement');
    });

    it('respects includePlan flag override (keeps all stages)', () => {
        const playbook = loadPlaybook('feature');
        const agents = makeAgents('epsilon', ['plan', 'dev', 'general']);

        // skipPlan is true BUT includePlan overrides to keep all
        const result = resolvePlaybook(playbook, 'epsilon', agents, undefined, true, true);

        const stageNames = result.stages.map(s => s.name);
        expect(stageNames).toContain('brainstorm-and-spec');
        expect(stageNames).toContain('implement');
    });

    it('throws when resolved agent is not in config', () => {
        const playbook = loadPlaybook('feature');
        // Only provide 'plan' agent — missing 'dev' and 'general'
        const agents = makeAgents('missing', ['plan']);

        expect(() => resolvePlaybook(playbook, 'missing', agents)).toThrow(/not found in agents config/);
    });
});

// ── formatStageMessage tests ───────────────────────────────────────────────

describe('formatStageMessage', () => {
    const playbook: Playbook = {
        intent: 'feature',
        agents: ['plan', 'dev'],
        vault_output: ['plans'],
        stages: [],
    };

    it('produces correct [playbook:...] format', () => {
        const stage: PlaybookStage = {
            name: 'implement',
            agent: 'dev',
            skills: ['/subagent-driven-development'],
            on_failure: 'halt',
        };

        const msg = formatStageMessage(playbook, stage, 1, 4, 'Build the login page');

        expect(msg).toContain('[playbook:feature stage:2/4]');
        expect(msg).toContain('Execute /subagent-driven-development for:');
        expect(msg).toContain('Build the login page');
    });

    it('includes checkpoint hint when present', () => {
        const stage: PlaybookStage = {
            name: 'brainstorm',
            agent: 'plan',
            skills: ['/brainstorming', '/write-plan'],
            checkpoint: 'human-approval',
            checkpoint_hint: 'Review the plan before proceeding',
            on_failure: 'halt',
        };

        const msg = formatStageMessage(playbook, stage, 0, 3, 'Design the API');

        expect(msg).toContain('CHECKPOINT: Review the plan before proceeding');
    });

    it('includes previous response context', () => {
        const stage: PlaybookStage = {
            name: 'review',
            agent: 'general',
            skills: ['/ark-code-review'],
            on_failure: 'halt',
        };

        const msg = formatStageMessage(
            playbook, stage, 2, 3, 'Review changes',
            'Implementation completed successfully with 5 files changed.',
        );

        expect(msg).toContain('Context from previous stage:');
        expect(msg).toContain('Implementation completed successfully with 5 files changed.');
    });

    it('includes planning artifacts when provided', () => {
        const stage: PlaybookStage = {
            name: 'implement',
            agent: 'dev',
            skills: ['/subagent-driven-development'],
            on_failure: 'halt',
        };

        const msg = formatStageMessage(
            playbook, stage, 0, 2, 'Build feature',
            undefined,
            ['plans/spec.md', 'plans/arch.md'],
        );

        expect(msg).toContain('Planning artifacts:');
        expect(msg).toContain('plans/spec.md');
        expect(msg).toContain('plans/arch.md');
    });

    it('formats multiple skills with commas', () => {
        const stage: PlaybookStage = {
            name: 'investigate',
            agent: 'debug',
            skills: ['/systematic-debugging', '/investigate'],
            on_failure: 'halt',
        };

        const msg = formatStageMessage(playbook, stage, 0, 2, 'Debug the crash');

        expect(msg).toContain('Execute /systematic-debugging, /investigate for:');
    });
});

// ── startPlaybookRun + CRUD tests ──────────────────────────────────────────

describe('startPlaybookRun', () => {
    // For startPlaybookRun we need a settings.json with proper agents config
    // We mock getSettings/getAgents by writing a settings.json into TEST_HOME

    beforeAll(() => {
        // Write settings.json with agents matching the review playbook (simplest: only 'general')
        const settings = {
            agents: {
                'test-team-general': {
                    name: 'General Agent',
                    provider: 'anthropic',
                    model: 'sonnet',
                    working_directory: path.join(TEST_HOME, 'workspace', 'test-team-general'),
                },
            },
            teams: {
                'test-team': {
                    name: 'Test Team',
                    agents: ['test-team-general'],
                    leader_agent: 'test-team-general',
                },
            },
        };
        fs.writeFileSync(
            path.join(TEST_HOME, 'settings.json'),
            JSON.stringify(settings, null, 2),
        );
    });

    it('creates both playbook_runs and pipeline_runs rows', () => {
        const { runId, pipelineRunId } = startPlaybookRun(
            'test-team', 'review', 'Review the auth module',
            'discord', 'alice', 'alice123', 'msg_pb_1',
        );

        expect(runId).toMatch(/^playbook_/);
        expect(pipelineRunId).toMatch(/^pipeline_/);

        // Check playbook run
        const pbRun = getPlaybookRun(runId);
        expect(pbRun).not.toBeNull();
        expect(pbRun!.team_id).toBe('test-team');
        expect(pbRun!.intent).toBe('review');
        expect(pbRun!.description).toBe('Review the auth module');
        expect(pbRun!.playbook_status).toBe('running');
        expect(pbRun!.pipeline_run_id).toBe(pipelineRunId);
        expect(pbRun!.current_stage_name).toBe('full-review');
        expect(pbRun!.skip_plan).toBe(false);

        // Check pipeline run was also created
        const pipeRun = getPipelineRun(pipelineRunId);
        expect(pipeRun).not.toBeNull();
        expect(pipeRun!.team_id).toBe('test-team');
        expect(pipeRun!.status).toBe('running');

        // Stages JSON should parse correctly
        const stages = JSON.parse(pbRun!.stages_json);
        expect(stages.length).toBeGreaterThanOrEqual(2);
        expect(stages[0].name).toBe('full-review');
    });

    it('getPlaybookRunByPipelineId retrieves correct run', () => {
        const { runId, pipelineRunId } = startPlaybookRun(
            'test-team', 'review', 'Review the payments module',
            'discord', 'bob', null, 'msg_pb_2',
        );

        const found = getPlaybookRunByPipelineId(pipelineRunId);
        expect(found).not.toBeNull();
        expect(found!.id).toBe(runId);
        expect(found!.description).toBe('Review the payments module');
    });

    it('updatePlaybookStatus changes status and updated_at', () => {
        const { runId } = startPlaybookRun(
            'test-team', 'review', 'Review status test',
            'discord', 'carol', null, 'msg_pb_3',
        );

        const before = getPlaybookRun(runId)!;
        expect(before.playbook_status).toBe('running');

        updatePlaybookStatus(runId, 'completed');

        const after = getPlaybookRun(runId)!;
        expect(after.playbook_status).toBe('completed');
        expect(after.updated_at).toBeGreaterThanOrEqual(before.updated_at);
    });

    it('returns null for non-existent playbook run', () => {
        expect(getPlaybookRun('nonexistent')).toBeNull();
        expect(getPlaybookRunByPipelineId('nonexistent')).toBeNull();
    });
});
