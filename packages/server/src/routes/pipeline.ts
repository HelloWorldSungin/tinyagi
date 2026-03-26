import { Hono } from 'hono';
import {
    getTeams, getSettings, log, enqueueMessage, genId,
    getActivePipelineRun, getFailedPipelineRun, getMostRecentRun,
    getPipelineRun, createPipelineRun, retryPipelineRun,
} from '@tinyagi/core';

const app = new Hono();

// GET /api/pipeline/:teamId/status
app.get('/api/pipeline/:teamId/status', (c) => {
    const teamId = c.req.param('teamId');
    const teams = getTeams(getSettings());
    const team = teams[teamId];
    if (!team || team.mode !== 'pipeline') {
        return c.json({ error: `Team '${teamId}' is not a pipeline-mode team` }, 400);
    }

    // Check active first, then most recent
    const active = getActivePipelineRun(teamId);
    if (active) {
        const total = active.pipeline.length;
        const stage = Math.min(active.current_stage, total - 1);
        const agentId = active.pipeline[stage] ?? 'unknown';
        return c.json({
            message: `Pipeline @${teamId}: stage ${stage + 1}/${total} (@${agentId}) — running`,
            run: active,
        });
    }

    const recent = getMostRecentRun(teamId);
    if (recent) {
        const total = recent.pipeline.length;
        const stage = Math.min(recent.current_stage, total - 1);
        const agentId = recent.pipeline[stage] ?? 'unknown';
        const statusLabel = recent.status === 'failed'
            ? `failed: ${recent.error}`
            : recent.status;
        return c.json({
            message: `Pipeline @${teamId}: stage ${stage + 1}/${total} (@${agentId}) — ${statusLabel}`,
            run: recent,
        });
    }

    return c.json({ message: `No pipeline runs found for @${teamId}.`, run: null });
});

// POST /api/pipeline/:teamId/retry
app.post('/api/pipeline/:teamId/retry', async (c) => {
    const teamId = c.req.param('teamId');
    const teams = getTeams(getSettings());
    const team = teams[teamId];
    if (!team || team.mode !== 'pipeline') {
        return c.json({ error: `Team '${teamId}' is not a pipeline-mode team` }, 400);
    }

    const body = await c.req.json().catch(() => ({})) as {
        channel?: string; sender?: string; senderId?: string;
    };

    // Reject if a run is already active
    const active = getActivePipelineRun(teamId);
    if (active) {
        return c.json({ message: `Pipeline already running for @${teamId}. Use @${teamId} /status to check progress.` }, 409);
    }

    const failed = getFailedPipelineRun(teamId);
    if (!failed) {
        return c.json({ message: 'No failed pipeline to retry.' }, 404);
    }

    // Reset run status to running
    retryPipelineRun(failed.id);

    // Build the message for the failed stage
    const stage = failed.current_stage;
    const total = failed.pipeline.length;
    const agentId = failed.pipeline[stage];
    let message: string;
    if (stage === 0) {
        message = failed.original_message;
    } else {
        message = `[Pipeline stage ${stage + 1}/${total} — retry]\nPrevious agent's response:\n---\n${failed.last_response}\n---\n\nOriginal task:\n${failed.original_message}`;
    }

    enqueueMessage({
        channel: body.channel || failed.channel,
        sender: body.sender || failed.sender,
        senderId: body.senderId || failed.sender_id || undefined,
        message,
        messageId: genId('pipeline'),
        agent: agentId,
        pipelineRunId: failed.id,
    });

    log('INFO', `[API] Pipeline retry: ${failed.id} at stage ${stage + 1}/${total}`);
    return c.json({
        message: `Retrying pipeline @${teamId} at stage ${stage + 1}/${total} (@${agentId}).`,
        runId: failed.id,
    });
});

// POST /api/pipeline/:teamId/restart
app.post('/api/pipeline/:teamId/restart', async (c) => {
    const teamId = c.req.param('teamId');
    const teams = getTeams(getSettings());
    const team = teams[teamId];
    if (!team || team.mode !== 'pipeline') {
        return c.json({ error: `Team '${teamId}' is not a pipeline-mode team` }, 400);
    }
    if (!team.pipeline || team.pipeline.length === 0) {
        return c.json({ error: `Team '${teamId}' has no pipeline configured` }, 400);
    }

    // Reject if a run is already active
    const active = getActivePipelineRun(teamId);
    if (active) {
        return c.json({ message: `Pipeline already running for @${teamId}. Use @${teamId} /status to check progress.` }, 409);
    }

    const body = await c.req.json().catch(() => ({})) as {
        message?: string; channel?: string; sender?: string; senderId?: string;
    };

    let originalMessage = body.message;
    if (!originalMessage) {
        const recent = getMostRecentRun(teamId);
        if (!recent) {
            return c.json({
                message: `No previous pipeline run found. Provide a message: @${teamId} /restart your message here`,
            }, 400);
        }
        originalMessage = recent.original_message;
    }

    const channel = body.channel || 'api';
    const sender = body.sender || 'system';
    const messageId = genId('pipeline');

    const runId = createPipelineRun(
        teamId, channel, sender, body.senderId,
        messageId, originalMessage, team.pipeline,
    );

    enqueueMessage({
        channel,
        sender,
        senderId: body.senderId,
        message: originalMessage,
        messageId,
        agent: team.pipeline[0],
        pipelineRunId: runId,
    });

    log('INFO', `[API] Pipeline restart: ${runId} for team ${teamId}`);
    return c.json({
        message: `Pipeline @${teamId} restarted.`,
        runId,
    });
});

export default app;
