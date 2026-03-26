#!/usr/bin/env node
/**
 * TinyAGI Queue Processor — Entry point.
 *
 * Initializes the SQLite queue, starts the API server, processes messages,
 * and manages lifecycle. This is the only file that should be run directly.
 */

import fs from 'fs';
import path from 'path';
import {
    MessageJobData,
    getSettings, getAgents, getTeams, LOG_FILE, FILES_DIR,
    log, emitEvent,
    parseAgentRouting, getAgentResetFlag,
    invokeAgent, killAgentProcess,
    loadPlugins, runIncomingHooks,
    streamResponse,
    initQueueDb, getPendingAgents, claimAllPendingMessages,
    markProcessing, completeMessage, failMessage,
    recoverStaleMessages, pruneAckedResponses, pruneCompletedMessages,
    closeQueueDb, queueEvents,
    insertAgentMessage,
    startScheduler, stopScheduler,
    initPipelineDb, createPipelineRun, getActivePipelineRun,
    failPipelineRun, getPipelineRun,
    recoverRunningPipelines, enqueueMessage, genId,
    hasPendingPipelineMessage,
    initGateDb, expireStaleGates,
} from '@tinyagi/core';
import { startApiServer } from '@tinyagi/server';
import {
    handleTeamResponse,
    groupChatroomMessages,
} from '@tinyagi/teams';

// Ensure directories exist
[FILES_DIR, path.dirname(LOG_FILE)].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

// ── Message Processing ──────────────────────────────────────────────────────

async function processMessage(dbMsg: any): Promise<void> {
    const data: MessageJobData = {
        channel: dbMsg.channel,
        sender: dbMsg.sender,
        senderId: dbMsg.sender_id,
        message: dbMsg.message,
        messageId: dbMsg.message_id,
        agent: dbMsg.agent ?? undefined,
        fromAgent: dbMsg.from_agent ?? undefined,
        pipelineRunId: dbMsg.pipeline_run_id ?? undefined,
        resume: !!dbMsg.resume,
        worktreePath: dbMsg.worktree_path ?? undefined,
    };

    const { channel, sender, message: rawMessage, messageId, agent: preRoutedAgent } = data;
    const isInternal = !!data.fromAgent;

    log('INFO', `Processing [${isInternal ? 'internal' : channel}] ${isInternal ? `@${data.fromAgent}→@${preRoutedAgent}` : `from ${sender}`}: ${rawMessage}`);

    const settings = getSettings();
    const agents = getAgents(settings);
    const teams = getTeams(settings);
    const workspacePath = settings?.workspace?.path || path.join(require('os').homedir(), 'tinyagi-workspace');

    // ── Route message to agent ──────────────────────────────────────────────
    let agentId: string;
    let message: string;
    let isTeamRouted = false;

    if (preRoutedAgent && agents[preRoutedAgent]) {
        agentId = preRoutedAgent;
        message = rawMessage;
    } else {
        const routing = parseAgentRouting(rawMessage, agents, teams);
        agentId = routing.agentId;
        message = routing.message;
        isTeamRouted = !!routing.isTeam;
    }

    if (!agents[agentId]) {
        agentId = 'tinyagi';
        message = rawMessage;
    }
    if (!agents[agentId]) {
        agentId = Object.keys(agents)[0];
    }

    // ── Pipeline detection ───────────────────────────────────────────────
    let pipelineRunId = data.pipelineRunId;

    if (!pipelineRunId) {
        // Check if this agent belongs to a pipeline-mode team
        for (const [teamId, team] of Object.entries(teams)) {
            if (team.mode === 'pipeline' && team.pipeline && team.agents.includes(agentId)) {
                // Validate config
                if (team.pipeline.some(pid => !team.agents.includes(pid))) {
                    log('ERROR', `Pipeline config for team '${teamId}' references unknown agents`);
                    await sendDirectResponse(
                        `Pipeline configuration error: pipeline references agents not in the team.`,
                        { channel, sender, senderId: data.senderId, messageId, originalMessage: rawMessage, agentId: teamId },
                    );
                    return;
                }

                // Check for active run
                const activeRun = getActivePipelineRun(teamId);
                if (activeRun) {
                    log('WARN', `Pipeline already running for team '${teamId}'`);
                    await sendDirectResponse(
                        `Pipeline already running for @${teamId}. Use @${teamId} /status to check progress.`,
                        { channel, sender, senderId: data.senderId, messageId, originalMessage: rawMessage, agentId: teamId },
                    );
                    return;
                }

                // Create pipeline run — first agent in pipeline array always receives
                pipelineRunId = createPipelineRun(
                    teamId, channel, sender, data.senderId ?? undefined,
                    messageId, rawMessage, team.pipeline,
                );
                agentId = team.pipeline[0];
                isTeamRouted = true;
                log('INFO', `Pipeline ${pipelineRunId} created for team '${teamId}' (${team.pipeline.length} stages)`);
                break;
            }
        }
    }

    const agent = agents[agentId];

    // ── Invoke agent ────────────────────────────────────────────────────────
    const agentResetFlag = getAgentResetFlag(agentId, workspacePath);
    let shouldReset = fs.existsSync(agentResetFlag);
    if (shouldReset) {
        fs.unlinkSync(agentResetFlag);
    }

    // Workflow resume: force continue conversation
    if (data.resume) {
        shouldReset = false;
    }

    ({ text: message } = await runIncomingHooks(message, { channel, sender, messageId, originalMessage: rawMessage }));

    emitEvent('agent:invoke', { agentId, agentName: agent.name, fromAgent: data.fromAgent || null });
    let response: string;
    try {
        response = await invokeAgent(agent, agentId, message, workspacePath, shouldReset, agents, teams, (text) => {
            log('INFO', `Agent ${agentId}: ${text}`);
            // Skip tool-use-only events (e.g., "[tool: Bash]") — don't send to Discord
            if (/^\[tool: .+\]$/.test(text.trim())) return;
            insertAgentMessage({ agentId, role: 'assistant', channel, sender: agentId, messageId, content: text });
            emitEvent('agent:progress', { agentId, agentName: agent.name, text, messageId });
            sendDirectResponse(text, {
                channel, sender, senderId: data.senderId,
                messageId, originalMessage: rawMessage, agentId,
            });
        }, data.worktreePath);
    } catch (error) {
        const provider = agent.provider || 'anthropic';
        const providerLabel = provider === 'openai' ? 'Codex' : provider === 'opencode' ? 'OpenCode' : 'Claude';
        log('ERROR', `${providerLabel} error (agent: ${agentId}): ${(error as Error).message}`);
        response = "Sorry, I encountered an error processing your request. Please check the queue logs.";
        // Fail pipeline run if active
        if (pipelineRunId) {
            failPipelineRun(pipelineRunId, (error as Error).message);
            const run = getPipelineRun(pipelineRunId);
            if (run) {
                const stage = run.current_stage + 1;
                const total = run.pipeline.length;
                const teamId = run.team_id;
                response = `Pipeline halted at stage ${stage}/${total} (@${agentId}): ${(error as Error).message}. Use @${teamId} /retry to resume or @${teamId} /restart to start over.`;
            }
        }
        const msgSender = isInternal ? data.fromAgent! : sender;
        insertAgentMessage({ agentId, role: 'assistant', channel, sender: msgSender, messageId, content: response });
        await sendDirectResponse(response, {
            channel, sender, senderId: data.senderId,
            messageId, originalMessage: rawMessage, agentId,
        });
    }

    emitEvent('agent:response', {
        agentId, agentName: agent.name, role: 'assistant',
        channel, sender, messageId,
        content: response,
        isTeamMessage: isInternal || isTeamRouted,
    });

    // ── Workflow gate ─────────────────────────────────────────────────────────
    // Only gate when: agent has workflow flag + message is a TaskNote ticker + not a resume
    const isTaskNoteTicker = /^(ArkSignal|ArkPoly|ArkClaw|ArkTrade|Infra|TASK)-\d+/i.test(rawMessage.trim());
    if (!data.resume && isTaskNoteTicker && agent.workflow) {
        // Find which team this agent belongs to (for metadata)
        const teamId = Object.entries(teams).find(([, t]) => t.agents.includes(agentId))?.[0] || agentId;
        await sendDirectResponse(
            '---\n\u2705 **Awaiting deployment approval.** React with \u2705 to approve or \u274c to reject.',
            { channel, sender, senderId: data.senderId, messageId, originalMessage: rawMessage, agentId },
            {
                workflowGate: true,
                teamId,
                agentId,
                originalTask: rawMessage,
                worktreePath: data.worktreePath,
            },
        );
    }

    // ── Response routing ────────────────────────────────────────────────────
    // Team orchestration — handles team-routed, internal, and direct messages
    // to agents that belong to a team.

    await handleTeamResponse({
        agentId, response, isTeamRouted, data, agents, teams,
        pipelineRunId,
    });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function sendDirectResponse(
    response: string,
    ctx: { channel: string; sender: string; senderId?: string | null; messageId: string; originalMessage: string; agentId: string },
    extraMetadata?: Record<string, unknown>,
): Promise<void> {
    const signed = `${response}\n\n- [${ctx.agentId}]`;
    await streamResponse(signed, {
        channel: ctx.channel,
        sender: ctx.sender,
        senderId: ctx.senderId ?? undefined,
        messageId: ctx.messageId,
        originalMessage: ctx.originalMessage,
        agentId: ctx.agentId,
        extraMetadata,
    });
}

// ── Queue Processing ────────────────────────────────────────────────────────

const agentChains = new Map<string, Promise<void>>();

async function processQueue(): Promise<void> {
    const pendingAgents = getPendingAgents();
    if (pendingAgents.length === 0) return;

    for (const agentId of pendingAgents) {
        const messages = claimAllPendingMessages(agentId);
        if (messages.length === 0) continue;

        const currentChain = agentChains.get(agentId) || Promise.resolve();
        // .catch() prevents a rejected chain from blocking subsequent messages
        const newChain = currentChain.catch(() => {}).then(async () => {
            const { messages: groupedMessages, messageIds } = groupChatroomMessages(messages);
            for (let i = 0; i < groupedMessages.length; i++) {
                const msg = groupedMessages[i];
                const ids = messageIds[i];
                try {
                    for (const id of ids) markProcessing(id);
                    await processMessage(msg);
                    for (const id of ids) {
                        completeMessage(id);
                    }
                } catch (error) {
                    log('ERROR', `Failed to process message ${msg.id}: ${(error as Error).message}`);
                    for (const id of ids) {
                        failMessage(id, (error as Error).message);
                    }
                }
            }
        });
        agentChains.set(agentId, newChain);
        newChain.finally(() => {
            if (agentChains.get(agentId) === newChain) {
                agentChains.delete(agentId);
            }
        });
    }
}

function logAgentConfig(): void {
    const settings = getSettings();
    const agents = getAgents(settings);
    const teams = getTeams(settings);

    const agentCount = Object.keys(agents).length;
    log('INFO', `Loaded ${agentCount} agent(s):`);
    for (const [id, agent] of Object.entries(agents)) {
        log('INFO', `  ${id}: ${agent.name} [${agent.provider}/${agent.model}] cwd=${agent.working_directory}`);
    }

    const teamCount = Object.keys(teams).length;
    if (teamCount > 0) {
        log('INFO', `Loaded ${teamCount} team(s):`);
        for (const [id, team] of Object.entries(teams)) {
            log('INFO', `  ${id}: ${team.name} [agents: ${team.agents.join(', ')}] leader=${team.leader_agent}`);
        }
    }
}

// ─── Start ──────────────────────────────────────────────────────────────────

initQueueDb();

// Recover any messages left in 'processing' from a previous run — they're
// guaranteed stale because the process just restarted.
const startupRecovered = recoverStaleMessages(0);
if (startupRecovered > 0) {
    log('INFO', `Startup: recovered ${startupRecovered} in-flight message(s) from previous run`);
}

// Initialize pipeline table
initPipelineDb();

// Initialize workflow gate table
initGateDb();

// Recover interrupted pipeline runs
const runningPipelines = recoverRunningPipelines();
for (const run of runningPipelines) {
    const teams = getTeams(getSettings());
    const team = teams[run.team_id];
    if (!team) {
        log('WARN', `Pipeline ${run.id}: team '${run.team_id}' no longer exists, marking failed`);
        failPipelineRun(run.id, 'Team no longer exists');
        continue;
    }

    const stage = run.current_stage;
    const total = run.pipeline.length;
    const agentId = run.pipeline[stage];

    // Check if a message already exists in the queue for this pipeline run
    // (recoverStaleMessages may have already re-queued it as 'pending')
    if (hasPendingPipelineMessage(run.id)) {
        log('INFO', `Pipeline ${run.id}: stage ${stage + 1}/${total} already in queue, skipping recovery`);
        continue;
    }

    // Re-enqueue at the current stage
    let message: string;
    if (stage === 0) {
        message = run.original_message;
    } else {
        message = [
            `[Pipeline stage ${stage + 1}/${total} — recovery]`,
            `Previous agent's response:`,
            `---`,
            run.last_response || '(no response recorded)',
            `---`,
            ``,
            `Original task:`,
            run.original_message,
        ].join('\n');
    }

    enqueueMessage({
        channel: run.channel,
        sender: run.sender,
        senderId: run.sender_id ?? undefined,
        message,
        messageId: genId('pipeline-recover'),
        agent: agentId,
        pipelineRunId: run.id,
    });

    log('INFO', `Recovered pipeline run ${run.id} for team ${run.team_id} at stage ${stage + 1}/${total}`);
}

const apiServer = startApiServer();

// Event-driven: process queue when a new message arrives
queueEvents.on('message:enqueued', () => processQueue());

// When user manually kills an agent session, clear its promise chain
queueEvents.on('agent:killed', ({ agentId }: { agentId: string }) => {
    agentChains.delete(agentId);
    log('INFO', `Cleared agent chain for ${agentId}`);
});

// Also poll periodically in case events are missed
const pollInterval = setInterval(() => processQueue(), 5000);

// Periodic maintenance (prune old completed/acked records)
const maintenanceInterval = setInterval(() => {
    pruneAckedResponses();
    pruneCompletedMessages();
    // Expire gates waiting longer than 7 days
    const expired = expireStaleGates(7 * 24 * 60 * 60 * 1000);
    if (expired > 0) log('INFO', `Expired ${expired} stale gate(s)`);
}, 60 * 1000);

// Load plugins
(async () => {
    await loadPlugins();
})();

// Start in-process cron scheduler
startScheduler();

log('INFO', 'Queue processor started (SQLite)');
logAgentConfig();
log('INFO', `Agents: ${Object.keys(getAgents(getSettings())).join(', ')}, Teams: ${Object.keys(getTeams(getSettings())).join(', ')}`);

// Graceful shutdown
function shutdown(): void {
    log('INFO', 'Shutting down queue processor...');
    stopScheduler();
    clearInterval(pollInterval);
    clearInterval(maintenanceInterval);
    apiServer.close();
    closeQueueDb();
    process.exit(0);
}

process.on('SIGINT', () => { shutdown(); });
process.on('SIGTERM', () => { shutdown(); });
