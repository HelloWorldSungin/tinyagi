/**
 * Gate request persistence — gate_requests table + CRUD.
 * Reuses the SQLite DB handle from queues.ts.
 */

import { getDb } from './queues';
import { genId } from './ids';
import { log } from './logging';

export interface GateRequest {
    id: string;
    team_id: string;
    agent_id: string;
    channel: string;
    message_id: string;
    thread_id: string | null;
    original_task: string;
    worktree_path: string | null;
    status: 'waiting' | 'approved' | 'rejected' | 'expired';
    created_at: number;
    updated_at: number;
}

export function initGateDb(): void {
    const db = getDb();
    db.exec(`
        CREATE TABLE IF NOT EXISTS gate_requests (
            id TEXT PRIMARY KEY,
            team_id TEXT NOT NULL,
            agent_id TEXT NOT NULL,
            channel TEXT NOT NULL,
            message_id TEXT NOT NULL,
            thread_id TEXT,
            original_task TEXT NOT NULL,
            worktree_path TEXT,
            status TEXT NOT NULL DEFAULT 'waiting',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_gate_message ON gate_requests(message_id);
        CREATE INDEX IF NOT EXISTS idx_gate_team ON gate_requests(team_id, status);
    `);
}

export function createGateRequest(
    teamId: string,
    agentId: string,
    channel: string,
    messageId: string,
    threadId: string | null,
    originalTask: string,
    worktreePath: string | null,
): string {
    const id = genId('gate');
    const now = Date.now();
    getDb().prepare(
        `INSERT INTO gate_requests (id, team_id, agent_id, channel, message_id, thread_id, original_task, worktree_path, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'waiting', ?, ?)`
    ).run(id, teamId, agentId, channel, messageId, threadId, originalTask, worktreePath, now, now);
    log('INFO', `Gate request created: ${id} for team ${teamId}`);
    return id;
}

export function getGateById(id: string): GateRequest | null {
    const row = getDb().prepare('SELECT * FROM gate_requests WHERE id = ?').get(id);
    return (row as GateRequest) ?? null;
}

export function getGateByMessageId(messageId: string): GateRequest | null {
    const row = getDb().prepare('SELECT * FROM gate_requests WHERE message_id = ?').get(messageId);
    return (row as GateRequest) ?? null;
}

export function approveGate(id: string): void {
    getDb().prepare(
        `UPDATE gate_requests SET status = 'approved', updated_at = ? WHERE id = ?`
    ).run(Date.now(), id);
    log('INFO', `Gate approved: ${id}`);
}

export function rejectGate(id: string): void {
    getDb().prepare(
        `UPDATE gate_requests SET status = 'rejected', updated_at = ? WHERE id = ?`
    ).run(Date.now(), id);
    log('INFO', `Gate rejected: ${id}`);
}

export function getWaitingGates(): GateRequest[] {
    return getDb().prepare(
        `SELECT * FROM gate_requests WHERE status = 'waiting'`
    ).all() as GateRequest[];
}

export function expireStaleGates(maxAgeMs: number): number {
    const cutoff = Date.now() - maxAgeMs;
    const result = getDb().prepare(
        `UPDATE gate_requests SET status = 'expired', updated_at = ? WHERE status = 'waiting' AND created_at < ?`
    ).run(Date.now(), cutoff);
    const count = result.changes;
    if (count > 0) {
        log('INFO', `Expired ${count} stale gate request(s)`);
    }
    return count;
}
