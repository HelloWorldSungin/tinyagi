/**
 * Pipeline state persistence — pipeline_runs table + CRUD.
 * Reuses the SQLite DB handle from queues.ts.
 */

import { getDb } from './queues';
import { genId } from './ids';

export interface PipelineRun {
    id: string;
    team_id: string;
    channel: string;
    sender: string;
    sender_id: string | null;
    message_id: string;
    original_message: string;
    pipeline: string[];
    current_stage: number;
    status: 'running' | 'completed' | 'failed';
    last_response: string | null;
    error: string | null;
    created_at: number;
    updated_at: number;
}

export function initPipelineDb(): void {
    const db = getDb();
    db.exec(`
        CREATE TABLE IF NOT EXISTS pipeline_runs (
            id TEXT PRIMARY KEY,
            team_id TEXT NOT NULL,
            channel TEXT NOT NULL,
            sender TEXT NOT NULL,
            sender_id TEXT,
            message_id TEXT NOT NULL,
            original_message TEXT NOT NULL,
            pipeline JSON NOT NULL,
            current_stage INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'running',
            last_response TEXT,
            error TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_pipeline_team ON pipeline_runs(team_id, status);
    `);
}

export function createPipelineRun(
    teamId: string,
    channel: string,
    sender: string,
    senderId: string | undefined,
    messageId: string,
    originalMessage: string,
    pipeline: string[],
): string {
    const id = genId('pipeline');
    const now = Date.now();
    getDb().prepare(
        `INSERT INTO pipeline_runs (id, team_id, channel, sender, sender_id, message_id, original_message, pipeline, current_stage, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'running', ?, ?)`
    ).run(id, teamId, channel, sender, senderId ?? null, messageId, originalMessage, JSON.stringify(pipeline), now, now);
    return id;
}

export function advancePipelineStage(runId: string, response: string): void {
    getDb().prepare(
        `UPDATE pipeline_runs SET current_stage = current_stage + 1, last_response = ?, updated_at = ? WHERE id = ?`
    ).run(response, Date.now(), runId);
}

export function completePipelineRun(runId: string, response: string): void {
    getDb().prepare(
        `UPDATE pipeline_runs SET status = 'completed', last_response = ?, updated_at = ? WHERE id = ?`
    ).run(response, Date.now(), runId);
}

export function failPipelineRun(runId: string, error: string): void {
    getDb().prepare(
        `UPDATE pipeline_runs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`
    ).run(error, Date.now(), runId);
}

function hydrateRun(row: any): PipelineRun | null {
    if (!row) return null;
    return { ...row, pipeline: JSON.parse(row.pipeline) };
}

export function getPipelineRun(runId: string): PipelineRun | null {
    return hydrateRun(getDb().prepare('SELECT * FROM pipeline_runs WHERE id = ?').get(runId));
}

export function getActivePipelineRun(teamId: string): PipelineRun | null {
    return hydrateRun(getDb().prepare(
        `SELECT * FROM pipeline_runs WHERE team_id = ? AND status = 'running' ORDER BY created_at DESC LIMIT 1`
    ).get(teamId));
}

export function getFailedPipelineRun(teamId: string): PipelineRun | null {
    return hydrateRun(getDb().prepare(
        `SELECT * FROM pipeline_runs WHERE team_id = ? AND status = 'failed' ORDER BY created_at DESC LIMIT 1`
    ).get(teamId));
}

export function recoverRunningPipelines(): PipelineRun[] {
    const rows = getDb().prepare(
        `SELECT * FROM pipeline_runs WHERE status = 'running'`
    ).all() as any[];
    return rows.map(hydrateRun).filter((r): r is PipelineRun => r !== null);
}

export function getMostRecentRun(teamId: string): PipelineRun | null {
    return hydrateRun(getDb().prepare(
        `SELECT * FROM pipeline_runs WHERE team_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`
    ).get(teamId));
}

/**
 * Reset a failed run back to 'running' for retry.
 * Does NOT change current_stage — the caller re-enqueues at the same stage.
 */
export function retryPipelineRun(runId: string): void {
    getDb().prepare(
        `UPDATE pipeline_runs SET status = 'running', error = NULL, updated_at = ? WHERE id = ?`
    ).run(Date.now(), runId);
}
