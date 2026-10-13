import { ccc } from '@ckb-ccc/core';
import type { CounterTransactionEvent, Journal, CounterState, CounterAction, PilotEvent, SettlementJournal } from '@owl/pilot';
export type Status = 'queued' | 'signing' | 'signed' | 'checking' | 'broadcasting' | 'submitted' | 'confirming' | 'confirmed' | 'retry' | 'reverted' | 'failed';
export interface LogEntry { at: number; phase: string; message: string; error?: { name: string; message: string } }
export interface Activity { id: string; sessionId: string; kind: 'authorization' | 'move' | 'revocation'; title: string; status: Status; createdAt?: number; updatedAt?: number; position?: number; cost?: string; hash?: ccc.Hex; bytes?: ccc.Hex; logs: LogEntry[]; recovered?: boolean; node?: { status: string; blockHash?: string; blockNumber?: string; cycles?: string; txIndex?: string; confirmations?: string; reason?: string; checkedAt: number }; actualFee?: string }
const cache = new Map<string, Activity[]>();
export const activityKey = (key: string) => `${key}:activity`;
export function readActivity(key: string): Activity[] {
  if (cache.has(key)) return structuredClone(cache.get(key)!);
  try { return JSON.parse(localStorage.getItem(activityKey(key)) ?? '[]'); } catch { return []; }
}
export function updateActivity(key: string, id: string, patch: Partial<Activity>, entry?: Omit<LogEntry, 'at'>): void {
  try {
    const rows = readActivity(key);
    let row = rows.find(row => row.id === id);
    if (!row) { row = { id, sessionId: '', kind: 'move', title: 'Move', status: 'queued', logs: [], ...patch }; rows.push(row); }
    else Object.assign(row, patch);
    if (entry) { row.logs.push({ ...entry, at: Date.now() }); row.updatedAt = Date.now(); row.createdAt ??= row.updatedAt; }
    cache.set(key, rows);
    try { localStorage.setItem(activityKey(key), JSON.stringify(rows)); } catch { console.warn('Pilot transaction logs could not be saved.'); }
    window.dispatchEvent(new CustomEvent('pilot-activity', { detail: key }));
  } catch { /* Diagnostics must never interrupt durable action acceptance. */ }
}
export function logFailure(key: string, id: string, error: unknown, status: 'retry' | 'reverted' | 'failed') {
  const detail = error instanceof Error ? { name: error.name, message: error.message } : { name: 'Error', message: String(error) };
  updateActivity(key, id, { status }, { phase: status, message: status === 'retry' ? 'Settlement paused. The reservation and signed transaction are retained for retry.' : status === 'reverted' ? 'Action rolled back. Its reserved budget was released.' : 'Operation failed. See the error below.', error: detail });
}
const messages: Record<CounterTransactionEvent['phase'], string> = {
  signing: 'Waiting for the owner wallet to sign this transaction.',
  signed: 'Session key signed the exact transaction. Signed bytes were durably saved before broadcast.',
  checking: 'Checking the node for this transaction hash before any resubmission.',
  broadcasting: 'Broadcasting the saved signed transaction to the CKB testnet node.',
  submitted: 'The node accepted the transaction submission. This is not chain confirmation.',
  confirming: 'Waiting for commitment and one additional block before settlement completes.',
  confirmed: 'The transaction is committed on-chain and the confirmation requirement is satisfied.',
};
export function transactionObserver(key: string, id: string, base: Partial<Activity>) {
  return (event: CounterTransactionEvent) => {
    const actualId = event.actionId ?? id;
    const previous = readActivity(key).find(row => row.id === actualId);
    const patch: Partial<Activity> = { ...base, status: event.phase };
    if (previous?.status === 'confirmed') patch.status = 'confirmed';
    if (event.transactionHash) patch.hash = event.transactionHash;
    if (event.transactionBytes) patch.bytes = event.transactionBytes;
    updateActivity(key, actualId, patch, { phase: event.phase, message: messages[event.phase] });
  };
}
export function recordQueue(key: string, journal: Journal<CounterState, CounterAction>, recovered = false) {
  const existing = readActivity(key);
  journal.queue.forEach((entry, index) => {
    if (existing.some(row => row.id === entry.id)) return;
    const position = journal.projectedState.position - journal.queue.length + index + 1;
    updateActivity(key, entry.id, { sessionId: journal.session.id, kind: 'move', title: `Move ${position}`, position, status: 'queued', cost: entry.cost, recovered }, { phase: recovered ? 'restored' : 'accepted', message: recovered ? 'Saved action restored from the durable queue. Its fee reservation is still held.' : 'Action accepted and persisted. Fee budget reserved; optimistic position updated immediately. Waiting for earlier moves to settle.' });
  });
}
export function recordPilotEvent(key: string, event: PilotEvent) {
  if (event.type === 'retry') logFailure(key, event.id, event.error, 'retry');
  if (event.type === 'reverted') event.ids.forEach(id => logFailure(key, id, event.error, 'reverted'));
  if (event.type === 'settled') updateActivity(key, event.id, { status: 'confirmed', hash: event.transactionHash as ccc.Hex }, { phase: 'settled', message: 'Pilot recorded the confirmed position, debited the reserved fee, and removed the action from the queue.' });
}
export function recoverActivity(key: string, sessionId: string, chain: SettlementJournal | undefined) {
  if (!chain) return;
  for (const [id, tx] of Object.entries(chain.transactions)) {
    const old = readActivity(key).find(row => row.id === id);
    if (old) { updateActivity(key, id, { hash: tx.hash, bytes: tx.bytes, ...(tx.confirmed ? { status: 'confirmed' as const } : {}) }); continue; }
    let position: number | undefined;
    try { const data = ccc.bytesFrom(ccc.Transaction.fromBytes(tx.bytes).outputsData[0]); position = Number(new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(8, true)); } catch { /* Raw transaction still available. */ }
    updateActivity(key, id, { sessionId, kind: 'move', title: position === undefined ? 'Recovered move' : `Move ${position}`, position, hash: tx.hash, bytes: tx.bytes, status: tx.confirmed ? 'confirmed' : 'signed', recovered: true });
  }
}
export function clearActivityCache(key: string) { cache.delete(key); }
