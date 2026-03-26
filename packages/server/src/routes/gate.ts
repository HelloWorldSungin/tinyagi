import { Hono } from 'hono';
import {
    createGateRequest, getGateById, getGateByMessageId, approveGate, rejectGate, getWaitingGates,
} from '@tinyagi/core';

export const gateRoutes = new Hono();

// POST /api/gate — Create a gate request
gateRoutes.post('/', async (c) => {
    const body = await c.req.json().catch(() => ({})) as {
        teamId?: string;
        agentId?: string;
        channel?: string;
        messageId?: string;
        threadId?: string;
        originalTask?: string;
        worktreePath?: string;
    };

    const { teamId, agentId, channel, messageId, originalTask } = body;
    if (!teamId || !agentId || !channel || !messageId || !originalTask) {
        return c.json({ error: 'Missing required fields: teamId, agentId, channel, messageId, originalTask' }, 400);
    }

    const id = createGateRequest(
        teamId,
        agentId,
        channel,
        messageId,
        body.threadId ?? null,
        originalTask,
        body.worktreePath ?? null,
    );

    return c.json({ id, status: 'waiting' }, 201);
});

// GET /api/gate/message/:messageId — Get gate by Discord message ID
gateRoutes.get('/message/:messageId', (c) => {
    const messageId = c.req.param('messageId');
    const gate = getGateByMessageId(messageId);
    if (!gate) {
        return c.json({ error: 'Gate not found' }, 404);
    }
    return c.json(gate);
});

// POST /api/gate/:id/approve — Approve a gate
gateRoutes.post('/:id/approve', (c) => {
    const id = c.req.param('id');
    const gate = getGateById(id);
    if (!gate) {
        return c.json({ error: 'Gate not found' }, 404);
    }
    if (gate.status !== 'waiting') {
        return c.json({ error: `Gate is already ${gate.status}` }, 409);
    }
    approveGate(id);
    return c.json({ status: 'approved' });
});

// POST /api/gate/:id/reject — Reject a gate
gateRoutes.post('/:id/reject', (c) => {
    const id = c.req.param('id');
    const gate = getGateById(id);
    if (!gate) {
        return c.json({ error: 'Gate not found' }, 404);
    }
    if (gate.status !== 'waiting') {
        return c.json({ error: `Gate is already ${gate.status}` }, 409);
    }
    rejectGate(id);
    return c.json({ status: 'rejected' });
});

// GET /api/gate/waiting — List all waiting gates
gateRoutes.get('/waiting', (c) => {
    const gates = getWaitingGates();
    return c.json(gates);
});
