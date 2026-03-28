import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// Must set TINYAGI_HOME before any module that reads it at load time.
const TEST_HOME = vi.hoisted(() => {
    const dir = '/tmp/tinyagi-teams-test-' + Date.now();
    process.env.TINYAGI_HOME = dir;
    const mkfs = require('fs'); // eslint-disable-line @typescript-eslint/no-require-imports
    mkfs.mkdirSync(dir, { recursive: true });
    mkfs.mkdirSync(dir + '/logs', { recursive: true });
    return dir;
});

// Mock streamResponse and emitEvent to avoid actual output channel writes
vi.mock('@tinyagi/core', async () => {
    // Import directly from source to bypass package.json resolution
    const core = await import('../../../../packages/core/src/index');
    return {
        ...core,
        streamResponse: vi.fn().mockResolvedValue(undefined),
        emitEvent: vi.fn(),
    };
});

import fs from 'fs';
import {
    initQueueDb, closeQueueDb,
    initPipelineDb, createPipelineRun, getPipelineRun,
    initPlaybookDb,
} from '@tinyagi/core';
import type { TeamConfig, AgentConfig, MessageJobData } from '@tinyagi/core';
import { handleTeamResponse } from '../conversation';

const makeData = (overrides?: Partial<MessageJobData>): MessageJobData => ({
    channel: 'test',
    sender: 'user',
    senderId: 'user123',
    message: 'run the pipeline',
    messageId: 'msg_test_1',
    ...overrides,
});

const agents: Record<string, AgentConfig> = {
    planner: { name: 'Planner', model: 'test', provider: 'anthropic' as any, working_directory: '/tmp' },
    reviewer: { name: 'Reviewer', model: 'test', provider: 'anthropic' as any, working_directory: '/tmp' },
    qa: { name: 'QA', model: 'test', provider: 'anthropic' as any, working_directory: '/tmp' },
};

beforeAll(() => {
    initQueueDb();
    initPipelineDb();
    initPlaybookDb();
});

afterAll(() => {
    closeQueueDb();
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

describe('handleTeamResponse pipeline advancement', () => {
    it('advances pipeline stage when pipelineRunId is present and team mode is collaborative', async () => {
        const teams: Record<string, TeamConfig> = {
            'collab-team': {
                name: 'Collab Team',
                mode: 'collaborative',
                agents: ['planner', 'reviewer', 'qa'],
                leader_agent: 'planner',
                pipeline: ['planner', 'reviewer', 'qa'],
            },
        };

        // Create a pipeline run for this collaborative team
        const runId = createPipelineRun(
            'collab-team', 'test', 'user', 'user123',
            'msg_test_1', 'run the pipeline', ['planner', 'reviewer', 'qa'],
        );

        // handleTeamResponse should advance the pipeline even though team mode is collaborative
        await handleTeamResponse({
            agentId: 'planner',
            response: 'Stage 0 output',
            isTeamRouted: true,
            data: makeData(),
            agents,
            teams,
            pipelineRunId: runId,
        });

        const run = getPipelineRun(runId);
        expect(run).not.toBeNull();
        // Pipeline should have advanced from stage 0 to stage 1
        expect(run!.current_stage).toBe(1);
        expect(run!.last_response).toBe('Stage 0 output');
        expect(run!.status).toBe('running');
    });

    it('does NOT advance pipeline for collaborative teams when no pipelineRunId', async () => {
        const teams: Record<string, TeamConfig> = {
            'collab-team-2': {
                name: 'Collab Team 2',
                mode: 'collaborative',
                agents: ['planner', 'reviewer'],
                leader_agent: 'planner',
            },
        };

        // No pipelineRunId — should go through normal collaborative flow (mention parsing)
        const result = await handleTeamResponse({
            agentId: 'planner',
            response: 'Just a normal response',
            isTeamRouted: true,
            data: makeData(),
            agents,
            teams,
        });

        // Should return true (team context found) but no pipeline advancement
        expect(result).toBe(true);
    });

    it('still works for pipeline-mode teams (existing behavior preserved)', async () => {
        const teams: Record<string, TeamConfig> = {
            'pipe-team': {
                name: 'Pipeline Team',
                mode: 'pipeline',
                agents: ['planner', 'reviewer', 'qa'],
                leader_agent: 'planner',
                pipeline: ['planner', 'reviewer', 'qa'],
            },
        };

        const runId = createPipelineRun(
            'pipe-team', 'test', 'user', 'user123',
            'msg_pipe_1', 'pipeline task', ['planner', 'reviewer', 'qa'],
        );

        const result = await handleTeamResponse({
            agentId: 'planner',
            response: 'Pipeline stage 0 done',
            isTeamRouted: true,
            data: makeData(),
            agents,
            teams,
            pipelineRunId: runId,
        });

        expect(result).toBe(true);

        const run = getPipelineRun(runId);
        expect(run).not.toBeNull();
        expect(run!.current_stage).toBe(1);
        expect(run!.last_response).toBe('Pipeline stage 0 done');
        expect(run!.status).toBe('running');
    });

    it('completes pipeline at the last stage for collaborative teams', async () => {
        const teams: Record<string, TeamConfig> = {
            'collab-complete': {
                name: 'Collab Complete',
                mode: 'collaborative',
                agents: ['planner', 'reviewer'],
                leader_agent: 'planner',
                pipeline: ['planner', 'reviewer'],
            },
        };

        const runId = createPipelineRun(
            'collab-complete', 'test', 'user', 'user123',
            'msg_complete_1', 'complete task', ['planner', 'reviewer'],
        );

        // Advance past stage 0 (planner)
        await handleTeamResponse({
            agentId: 'planner',
            response: 'planner output',
            isTeamRouted: true,
            data: makeData(),
            agents,
            teams,
            pipelineRunId: runId,
        });

        // Now stage 1 (reviewer) — this is the last stage
        await handleTeamResponse({
            agentId: 'reviewer',
            response: 'final review output',
            isTeamRouted: true,
            data: makeData(),
            agents,
            teams,
            pipelineRunId: runId,
        });

        const run = getPipelineRun(runId);
        expect(run).not.toBeNull();
        expect(run!.status).toBe('completed');
        expect(run!.last_response).toBe('final review output');
    });
});
