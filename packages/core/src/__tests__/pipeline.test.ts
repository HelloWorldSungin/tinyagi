import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// Must set TINYAGI_HOME before any module that reads it at load time.
// vi.hoisted runs before imports are evaluated. Use require() since fs import is hoisted too.
const TEST_HOME = vi.hoisted(() => {
    const dir = '/tmp/tinyagi-test-' + Date.now();
    process.env.TINYAGI_HOME = dir;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('fs').mkdirSync(dir, { recursive: true });
    return dir;
});

import fs from 'fs';
import { initQueueDb, closeQueueDb } from '../queues';
import {
    initPipelineDb,
    createPipelineRun,
    getPipelineRun,
    advancePipelineStage,
    completePipelineRun,
    failPipelineRun,
    retryPipelineRun,
    getActivePipelineRun,
    getFailedPipelineRun,
    recoverRunningPipelines,
    getMostRecentRun,
} from '../pipeline';

beforeAll(() => {
    initQueueDb();
    initPipelineDb();
});

afterAll(() => {
    closeQueueDb();
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

describe('pipeline CRUD', () => {
    it('creates a pipeline run and retrieves it', () => {
        const id = createPipelineRun('dev', 'discord', 'alice', 'alice123', 'msg_1', 'fix the bug', ['planner', 'reviewer', 'qa']);
        expect(id).toMatch(/^pipeline_/);

        const run = getPipelineRun(id);
        expect(run).not.toBeNull();
        expect(run!.team_id).toBe('dev');
        expect(run!.channel).toBe('discord');
        expect(run!.sender).toBe('alice');
        expect(run!.sender_id).toBe('alice123');
        expect(run!.original_message).toBe('fix the bug');
        expect(run!.pipeline).toEqual(['planner', 'reviewer', 'qa']);
        expect(run!.current_stage).toBe(0);
        expect(run!.status).toBe('running');
        expect(run!.last_response).toBeNull();
        expect(run!.error).toBeNull();
    });

    it('advances pipeline stage', () => {
        const id = createPipelineRun('dev', 'discord', 'alice', undefined, 'msg_2', 'task 2', ['a', 'b', 'c']);
        advancePipelineStage(id, 'response from stage 0');

        const run = getPipelineRun(id)!;
        expect(run.current_stage).toBe(1);
        expect(run.last_response).toBe('response from stage 0');
        expect(run.status).toBe('running');
    });

    it('completes a pipeline run', () => {
        const id = createPipelineRun('dev', 'discord', 'alice', undefined, 'msg_3', 'task 3', ['a', 'b']);
        completePipelineRun(id, 'final response');

        const run = getPipelineRun(id)!;
        expect(run.status).toBe('completed');
        expect(run.last_response).toBe('final response');
    });

    it('fails a pipeline run', () => {
        const id = createPipelineRun('dev', 'discord', 'alice', undefined, 'msg_4', 'task 4', ['a', 'b']);
        failPipelineRun(id, 'agent crashed');

        const run = getPipelineRun(id)!;
        expect(run.status).toBe('failed');
        expect(run.error).toBe('agent crashed');
    });

    it('getActivePipelineRun returns the running run for a team', () => {
        const id = createPipelineRun('active-team', 'discord', 'bob', undefined, 'msg_5', 'task 5', ['x', 'y']);

        const active = getActivePipelineRun('active-team');
        expect(active).not.toBeNull();
        expect(active!.id).toBe(id);

        // Complete it — should no longer be active
        completePipelineRun(id, 'done');
        expect(getActivePipelineRun('active-team')).toBeNull();
    });

    it('getFailedPipelineRun returns the most recent failed run', () => {
        const id = createPipelineRun('fail-team', 'discord', 'bob', undefined, 'msg_6', 'task 6', ['x', 'y']);
        failPipelineRun(id, 'oops');

        const failed = getFailedPipelineRun('fail-team');
        expect(failed).not.toBeNull();
        expect(failed!.id).toBe(id);
        expect(failed!.error).toBe('oops');
    });

    it('recoverRunningPipelines returns all running runs', () => {
        const id1 = createPipelineRun('recover-1', 'discord', 'bob', undefined, 'msg_7', 'task 7', ['a']);
        const id2 = createPipelineRun('recover-2', 'discord', 'bob', undefined, 'msg_8', 'task 8', ['b']);

        const running = recoverRunningPipelines();
        const ids = running.map(r => r.id);
        expect(ids).toContain(id1);
        expect(ids).toContain(id2);
    });

    it('getMostRecentRun returns the latest run regardless of status', () => {
        const id1 = createPipelineRun('recent-team', 'discord', 'bob', undefined, 'msg_9', 'task 9', ['a']);
        completePipelineRun(id1, 'done');
        const id2 = createPipelineRun('recent-team', 'discord', 'bob', undefined, 'msg_10', 'task 10', ['b']);
        failPipelineRun(id2, 'fail');

        const recent = getMostRecentRun('recent-team');
        expect(recent).not.toBeNull();
        expect(recent!.id).toBe(id2);
    });

    it('retries a failed pipeline run', () => {
        const id = createPipelineRun('retry-team', 'discord', 'alice', undefined, 'msg_11', 'task 11', ['a', 'b']);
        advancePipelineStage(id, 'stage 0 response');
        failPipelineRun(id, 'stage 1 crashed');

        const failed = getPipelineRun(id)!;
        expect(failed.status).toBe('failed');
        expect(failed.error).toBe('stage 1 crashed');
        expect(failed.current_stage).toBe(1);

        retryPipelineRun(id);

        const retried = getPipelineRun(id)!;
        expect(retried.status).toBe('running');
        expect(retried.error).toBeNull();
        expect(retried.current_stage).toBe(1); // stage unchanged
        expect(retried.last_response).toBe('stage 0 response'); // preserved
    });

    it('returns null for non-existent run', () => {
        expect(getPipelineRun('nonexistent')).toBeNull();
    });

    it('returns null for team with no runs', () => {
        expect(getActivePipelineRun('no-such-team')).toBeNull();
        expect(getFailedPipelineRun('no-such-team')).toBeNull();
        expect(getMostRecentRun('no-such-team')).toBeNull();
    });
});
