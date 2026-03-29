import {
    MessageJobData, AgentConfig, TeamConfig,
    log, emitEvent,
    findTeamForAgent, insertChatMessage,
    enqueueMessage, genId,
    getPipelineRun, advancePipelineStage, completePipelineRun,
    streamResponse,
    getPlaybookRunByPipelineId, updatePlaybookStage, updatePlaybookStatus,
} from '@tinyagi/core';
import { convertTagsToReadable, extractTeammateMentions, extractChatRoomMessages } from './routing';

// ── Team Chat Room ───────────────────────────────────────────────────────────

export function postToChatRoom(
    teamId: string,
    fromAgent: string,
    message: string,
    teamAgents: string[],
    originalData: { channel: string; sender: string; senderId?: string | null; messageId: string }
): number {
    const chatMsg = `[Chat room #${teamId} — @${fromAgent}]:\n${message}`;
    const id = insertChatMessage(teamId, fromAgent, message);
    for (const agentId of teamAgents) {
        if (agentId === fromAgent) continue;
        enqueueMessage({
            channel: 'chatroom',
            sender: originalData.sender,
            senderId: originalData.senderId ?? undefined,
            message: chatMsg,
            messageId: genId('chat'),
            agent: agentId,
            fromAgent,
        });
    }
    return id;
}

// ── Team Orchestration ───────────────────────────────────────────────────────

function resolveTeamContext(
    agentId: string,
    isTeamRouted: boolean,
    teams: Record<string, TeamConfig>
): { teamId: string; team: TeamConfig } | null {
    if (isTeamRouted) {
        for (const [tid, t] of Object.entries(teams)) {
            if (t.leader_agent === agentId && t.agents.includes(agentId)) {
                return { teamId: tid, team: t };
            }
        }
    }
    return findTeamForAgent(agentId, teams);
}

/**
 * Handle team orchestration for a response. Stateless — no conversation tracking.
 *
 * 1. Post chat room broadcasts
 * 2. Resolve team context
 * 3. Stream response to user
 * 4. Extract teammate mentions → enqueue as flat DMs
 */
export async function handleTeamResponse(params: {
    agentId: string;
    response: string;
    isTeamRouted: boolean;
    data: MessageJobData;
    agents: Record<string, AgentConfig>;
    teams: Record<string, TeamConfig>;
    pipelineRunId?: string;
}): Promise<boolean> {
    const { agentId, response, isTeamRouted, data, agents, teams, pipelineRunId } = params;
    const { channel, sender, messageId } = data;

    const teamContext = resolveTeamContext(agentId, isTeamRouted, teams);
    if (!teamContext) {
        log('DEBUG', `No team context for agent ${agentId} — falling back to direct response`);
        return false;
    }

    // Pipeline mode — skip mention parsing AND chat room extraction
    if (pipelineRunId) {
        const run = getPipelineRun(pipelineRunId);
        if (!run) {
            log('ERROR', `Pipeline run ${pipelineRunId} not found`);
            return true;
        }

        const pipeline = run.pipeline;
        const total = pipeline.length;
        const isLastStage = run.current_stage >= total - 1;

        if (isLastStage) {
            completePipelineRun(run.id, response);
            const pbRunComplete = getPlaybookRunByPipelineId(pipelineRunId);
            if (pbRunComplete) {
                updatePlaybookStatus(pbRunComplete.id, 'completed');
            }
            log('INFO', `Pipeline ${run.id} completed (${total}/${total} stages)`);

            const notification = `Pipeline complete (${total}/${total} stages). All stages finished successfully.`;
            await streamResponse(notification, {
                channel: data.channel,
                sender: data.sender,
                senderId: data.senderId ?? undefined,
                messageId: genId('pipeline-done'),
                originalMessage: run.original_message,
                agentId: teamContext.teamId,
            });
        } else {
            advancePipelineStage(run.id, response);
            // Update playbook stage tracking if this is a playbook run
            const pbRun = getPlaybookRunByPipelineId(pipelineRunId);
            if (pbRun) {
                const stages = JSON.parse(pbRun.stages_json) as Array<{ name: string }>;
                const nextStageIndex = run.current_stage + 1;
                if (nextStageIndex < stages.length) {
                    updatePlaybookStage(pbRun.id, stages[nextStageIndex].name);
                }
            }
            const nextStage = run.current_stage + 1;
            const nextAgentId = pipeline[nextStage];

            const pipelineMessage = [
                `[Pipeline stage ${nextStage + 1}/${total} — from @${agentId}]`,
                `Previous agent's response:`,
                `---`,
                response,
                `---`,
                ``,
                `Original task:`,
                run.original_message,
            ].join('\n');

            enqueueMessage({
                channel: data.channel,
                sender: data.sender,
                senderId: data.senderId ?? undefined,
                message: pipelineMessage,
                messageId: genId('pipeline'),
                agent: nextAgentId,
                fromAgent: agentId,
                pipelineRunId: run.id,
            });

            log('INFO', `Pipeline ${run.id}: stage ${nextStage + 1}/${total} → @${nextAgentId}`);
        }

        return true;
    }

    // Extract and post [#team_id: message] chat room broadcasts (collaborative mode only)
    const chatRoomMsgs = extractChatRoomMessages(response, agentId, teams);
    if (chatRoomMsgs.length > 0) {
        log('INFO', `Chat room broadcasts from @${agentId}: ${chatRoomMsgs.map(m => `#${m.teamId}`).join(', ')}`);
    }
    for (const crMsg of chatRoomMsgs) {
        postToChatRoom(crMsg.teamId, agentId, crMsg.message, teams[crMsg.teamId].agents, {
            channel, sender, senderId: data.senderId, messageId,
        });
    }

    // Extract teammate mentions and enqueue as flat DMs
    const teammateMentions = extractTeammateMentions(response, agentId, teamContext.teamId, teams, agents);
    if (teammateMentions.length > 0) {
        log('INFO', `@${agentId} → ${teammateMentions.map(m => `@${m.teammateId}`).join(', ')}`);
        for (const mention of teammateMentions) {
            emitEvent('agent:mention', { teamId: teamContext.teamId, fromAgent: agentId, toAgent: mention.teammateId });

            const internalMsg = `[Message from teammate @${agentId}]:\n${mention.message}`;
            enqueueMessage({
                channel,
                sender,
                senderId: data.senderId ?? undefined,
                message: internalMsg,
                messageId: genId('internal'),
                agent: mention.teammateId,
                fromAgent: agentId,
            });
        }
    }

    return true;
}
