import { Hono } from 'hono';
import {
    getSettings, getTeams, genId, log,
    startPlaybookRun, getPlaybookRun, getPlaybookRunByPipelineId,
    getActivePipelineRun, getMostRecentRun,
} from '@tinyagi/core';

const app = new Hono();

// POST /api/playbook/run
app.post('/run', async (c) => {
    const body = await c.req.json();
    const {
        teamId, intent, description, taskNoteRef,
        skipPlan, includePlan,
        channel, sender, senderId, messageId,
    } = body;

    if (!teamId || !intent || !description) {
        return c.json({ error: 'teamId, intent, and description are required' }, 400);
    }

    const settings = getSettings();
    const teams = getTeams(settings);
    if (!teams[teamId]) {
        return c.json({ error: `Team '${teamId}' not found` }, 400);
    }

    try {
        const result = startPlaybookRun(
            teamId,
            intent,
            description,
            channel || 'discord',
            sender || 'playbook-runner',
            senderId || null,
            messageId || genId('msg'),
            taskNoteRef,
            skipPlan,
            includePlan,
        );

        // Get the created run for stage count
        const run = getPlaybookRun(result.runId);
        const stages = run ? JSON.parse(run.stages_json) : [];

        return c.json({
            playbookRunId: result.runId,
            pipelineRunId: result.pipelineRunId,
            intent,
            stages: stages.length,
            message: `Playbook '${intent}' started for team '${teamId}' (${stages.length} stages)`,
        });
    } catch (err: any) {
        if (err.message.includes('not found') || err.message.includes('Unknown') || err.message.includes('validation')) {
            return c.json({ error: err.message }, 400);
        }
        return c.json({ error: err.message }, 500);
    }
});

// GET /api/playbook/:teamId/status
app.get('/:teamId/status', (c) => {
    const teamId = c.req.param('teamId');
    const settings = getSettings();
    const teams = getTeams(settings);
    if (!teams[teamId]) {
        return c.json({ error: `Team '${teamId}' not found` }, 400);
    }

    // Find the most relevant pipeline run for this team
    const pipelineRun = getActivePipelineRun(teamId) || getMostRecentRun(teamId);
    if (!pipelineRun) {
        return c.json({ message: `No playbook runs found for team '${teamId}'.`, run: null });
    }

    // Check if this pipeline run has a playbook associated
    const playbookRun = getPlaybookRunByPipelineId(pipelineRun.id);
    if (!playbookRun) {
        return c.json({ message: `No playbook runs found for team '${teamId}'.`, run: null });
    }

    const stages = JSON.parse(playbookRun.stages_json);
    const currentIdx = stages.findIndex((s: any) => s.name === playbookRun.current_stage_name);

    return c.json({
        playbookRunId: playbookRun.id,
        pipelineRunId: playbookRun.pipeline_run_id,
        intent: playbookRun.intent,
        status: playbookRun.playbook_status,
        currentStage: currentIdx >= 0 ? currentIdx + 1 : 1,
        totalStages: stages.length,
        stageName: playbookRun.current_stage_name,
    });
});

export default app;
