import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// Must set TINYAGI_HOME before any module that reads it at load time.
// vi.hoisted runs before imports are evaluated. Use require() since fs import is hoisted too.
const TEST_HOME = vi.hoisted(() => {
    const dir = '/tmp/tinyagi-test-gate-' + Date.now();
    process.env.TINYAGI_HOME = dir;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const _fs = require('fs');
    _fs.mkdirSync(dir + '/logs', { recursive: true });
    return dir;
});

import fs from 'fs';
import { initQueueDb, closeQueueDb, getDb } from '../queues';
import {
    initGateDb,
    createGateRequest,
    getGateByMessageId,
    approveGate,
    rejectGate,
    getWaitingGates,
    expireStaleGates,
} from '../gate';

beforeAll(() => {
    initQueueDb();
    initGateDb();
});

afterAll(() => {
    closeQueueDb();
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

describe('gate CRUD', () => {
    it('creates a gate request and retrieves it by Discord message ID', () => {
        const id = createGateRequest('dev', 'planner', 'discord', 'msg_100', 'thread_1', 'deploy the app', '/tmp/wt');
        expect(id).toMatch(/^gate_/);

        const gate = getGateByMessageId('msg_100');
        expect(gate).not.toBeNull();
        expect(gate!.id).toBe(id);
        expect(gate!.team_id).toBe('dev');
        expect(gate!.agent_id).toBe('planner');
        expect(gate!.channel).toBe('discord');
        expect(gate!.message_id).toBe('msg_100');
        expect(gate!.thread_id).toBe('thread_1');
        expect(gate!.original_task).toBe('deploy the app');
        expect(gate!.worktree_path).toBe('/tmp/wt');
        expect(gate!.status).toBe('waiting');
        expect(gate!.created_at).toBeGreaterThan(0);
        expect(gate!.updated_at).toBeGreaterThan(0);
    });

    it('approves a gate request', () => {
        const id = createGateRequest('dev', 'reviewer', 'discord', 'msg_101', null, 'review PR', null);
        approveGate(id);

        const gate = getGateByMessageId('msg_101');
        expect(gate).not.toBeNull();
        expect(gate!.status).toBe('approved');
    });

    it('rejects a gate request', () => {
        const id = createGateRequest('dev', 'reviewer', 'discord', 'msg_102', null, 'bad PR', null);
        rejectGate(id);

        const gate = getGateByMessageId('msg_102');
        expect(gate).not.toBeNull();
        expect(gate!.status).toBe('rejected');
    });

    it('returns null for unknown message ID', () => {
        expect(getGateByMessageId('nonexistent_msg')).toBeNull();
    });

    it('lists waiting gates', () => {
        const id1 = createGateRequest('team-a', 'agent1', 'discord', 'msg_200', null, 'task a', null);
        const id2 = createGateRequest('team-b', 'agent2', 'discord', 'msg_201', null, 'task b', null);
        // Approve one so it should NOT appear in waiting list
        approveGate(id1);

        const waiting = getWaitingGates();
        const ids = waiting.map(g => g.id);
        expect(ids).toContain(id2);
        expect(ids).not.toContain(id1);
    });

    it('expires stale gates', () => {
        // Create a gate and backdate its created_at to simulate staleness
        const id = createGateRequest('stale-team', 'agent', 'discord', 'msg_300', null, 'stale task', null);

        // Backdate created_at by 2 hours
        const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
        getDb().prepare('UPDATE gate_requests SET created_at = ? WHERE id = ?').run(twoHoursAgo, id);

        // Expire gates older than 1 hour
        const expired = expireStaleGates(60 * 60 * 1000);
        expect(expired).toBeGreaterThanOrEqual(1);

        const gate = getGateByMessageId('msg_300');
        expect(gate).not.toBeNull();
        expect(gate!.status).toBe('expired');
    });
});
