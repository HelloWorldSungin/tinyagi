import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// Must set TINYAGI_HOME before any module that reads it at load time.
const TEST_HOME = vi.hoisted(() => {
    const dir = '/tmp/tinyagi-test-playbook-routes-' + Date.now();
    process.env.TINYAGI_HOME = dir;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const _fs = require('fs');
    _fs.mkdirSync(dir + '/logs', { recursive: true });
    return dir;
});

import fs from 'fs';
import path from 'path';
import { Hono } from 'hono';
import { initQueueDb, closeQueueDb, initPipelineDb, initPlaybookDb } from '@tinyagi/core';
import playbookRoutes from '../routes/playbook';

const app = new Hono();
app.route('/api/playbook', playbookRoutes);

// ── Helpers ──────────────────────────────────────────────────────────────────

function postRun(body: unknown) {
    return app.request('/api/playbook/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

function getStatus(teamId: string) {
    return app.request(`/api/playbook/${teamId}/status`);
}

// ── Setup / Teardown ─────────────────────────────────────────────────────────

beforeAll(() => {
    // Write settings.json with a test team using the review playbook (needs only 'general' agent)
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

    initQueueDb();
    initPipelineDb();
    initPlaybookDb();
});

afterAll(() => {
    closeQueueDb();
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

// ── POST /api/playbook/run ───────────────────────────────────────────────────

describe('POST /api/playbook/run', () => {
    it('returns 400 when teamId is missing', async () => {
        const res = await postRun({ intent: 'review', description: 'test' });
        expect(res.status).toBe(400);
        const json = await res.json();
        expect(json.error).toContain('teamId');
    });

    it('returns 400 when intent is missing', async () => {
        const res = await postRun({ teamId: 'test-team', description: 'test' });
        expect(res.status).toBe(400);
        const json = await res.json();
        expect(json.error).toContain('intent');
    });

    it('returns 400 when description is missing', async () => {
        const res = await postRun({ teamId: 'test-team', intent: 'review' });
        expect(res.status).toBe(400);
        const json = await res.json();
        expect(json.error).toContain('description');
    });

    it('returns 400 when team does not exist', async () => {
        const res = await postRun({
            teamId: 'nonexistent-team',
            intent: 'review',
            description: 'test',
        });
        expect(res.status).toBe(400);
        const json = await res.json();
        expect(json.error).toContain('nonexistent-team');
        expect(json.error).toContain('not found');
    });

    it('returns 400 when intent is unknown (no playbook YAML file)', async () => {
        const res = await postRun({
            teamId: 'test-team',
            intent: 'nonexistent-playbook',
            description: 'test',
        });
        expect(res.status).toBe(400);
        const json = await res.json();
        expect(json.error).toContain('not found');
    });

    it('returns 200 with correct shape on valid request', async () => {
        const res = await postRun({
            teamId: 'test-team',
            intent: 'review',
            description: 'Review the auth module',
        });
        expect(res.status).toBe(200);
        const json = await res.json();

        expect(json.playbookRunId).toMatch(/^playbook_/);
        expect(json.pipelineRunId).toMatch(/^pipeline_/);
        expect(json.intent).toBe('review');
        expect(typeof json.stages).toBe('number');
        expect(json.stages).toBeGreaterThan(0);
        expect(json.message).toContain("Playbook 'review' started for team 'test-team'");
        expect(json.message).toContain(`${json.stages} stages`);
    });

    it('handles malformed JSON body gracefully (returns 400, not 500)', async () => {
        const res = await app.request('/api/playbook/run', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{ this is not valid json }',
        });
        // Malformed JSON is caught by .catch(() => ({})), yielding an empty object,
        // which then fails the required-fields check with 400.
        expect(res.status).toBe(400);
        const json = await res.json();
        expect(json.error).toBeDefined();
    });
});

// ── GET /api/playbook/:teamId/status ─────────────────────────────────────────

describe('GET /api/playbook/:teamId/status', () => {
    it('returns appropriate response when no active run exists for a valid team', async () => {
        // Use a second team that has never had a playbook run
        const settings = JSON.parse(
            fs.readFileSync(path.join(TEST_HOME, 'settings.json'), 'utf8'),
        );
        settings.agents['empty-team-general'] = {
            name: 'Empty General',
            provider: 'anthropic',
            model: 'sonnet',
            working_directory: path.join(TEST_HOME, 'workspace', 'empty-team-general'),
        };
        settings.teams['empty-team'] = {
            name: 'Empty Team',
            agents: ['empty-team-general'],
            leader_agent: 'empty-team-general',
        };
        fs.writeFileSync(
            path.join(TEST_HOME, 'settings.json'),
            JSON.stringify(settings, null, 2),
        );

        const res = await getStatus('empty-team');
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.run).toBeNull();
        expect(json.message).toContain('No playbook runs found');
    });

    it('returns 400 when team does not exist', async () => {
        const res = await getStatus('nonexistent-team');
        expect(res.status).toBe(400);
        const json = await res.json();
        expect(json.error).toContain('not found');
    });

    it('returns status with stage info when a run is active', async () => {
        // First, create a playbook run via the POST endpoint
        const postRes = await postRun({
            teamId: 'test-team',
            intent: 'review',
            description: 'Review for status test',
        });
        expect(postRes.status).toBe(200);
        const postJson = await postRes.json();

        // Now query the status
        const res = await getStatus('test-team');
        expect(res.status).toBe(200);
        const json = await res.json();

        expect(json.playbookRunId).toMatch(/^playbook_/);
        expect(json.pipelineRunId).toMatch(/^pipeline_/);
        expect(json.intent).toBe('review');
        expect(json.status).toBe('running');
        expect(typeof json.currentStage).toBe('number');
        expect(json.currentStage).toBeGreaterThanOrEqual(1);
        expect(typeof json.totalStages).toBe('number');
        expect(json.totalStages).toBeGreaterThan(0);
        expect(typeof json.stageName).toBe('string');
    });
});
