/** Public diagnostic metadata only. Never pass keys, proofs, or arbitrary application payloads. */
export interface PilotActivity {
  id: string; ownerAddress: string; appId: string; sessionId: string; actionId: string; name: string;
  kind: 'onchain' | 'offchain' | 'owner'; status: string; createdAt: number; updatedAt: number;
  transactionHash?: string; target?: string; fee?: string; grantId?: string;
  logs: { at: number; phase: string; message: string }[];
}
export const pilotActivityKey = (ownerAddress: string) => 'pilot:account-activity:v1:' + ownerAddress;
export function readPilotActivity(storage: Pick<Storage, 'getItem'>, ownerAddress: string): PilotActivity[] {
  if (!ownerAddress) return [];
  try {
    const rows: PilotActivity[] = JSON.parse(storage.getItem(pilotActivityKey(ownerAddress)) ?? '[]');
    return Array.isArray(rows) ? rows.filter(row => row.ownerAddress === ownerAddress && Array.isArray(row.logs)).sort((a, b) => b.createdAt - a.createdAt) : [];
  } catch { return []; }
}
/** Upsert one action throughout its lifecycle. History is local diagnostics, never authorization. */
export function recordPilotActivity(storage: Pick<Storage, 'getItem' | 'setItem'>, entry: Omit<PilotActivity, 'createdAt' | 'updatedAt' | 'logs'> & {
  createdAt?: number; logs?: PilotActivity['logs']; event?: { phase: string; message: string };
}): void {
  if (!entry.ownerAddress) return;
  const rows = readPilotActivity(storage, entry.ownerAddress);
  const index = rows.findIndex(row => row.id === entry.id && row.appId === entry.appId && row.sessionId === entry.sessionId);
  const previous = rows[index], now = Date.now();
  // Explicit fields prevent accidental key/payload serialization through object spreading.
  const row: PilotActivity = { id: entry.id, ownerAddress: entry.ownerAddress, appId: entry.appId, sessionId: entry.sessionId,
    actionId: entry.actionId, name: entry.name, kind: entry.kind, status: entry.status,
    createdAt: previous?.createdAt ?? entry.createdAt ?? now, updatedAt: now,
    transactionHash: entry.transactionHash ?? previous?.transactionHash, target: entry.target ?? previous?.target,
    fee: entry.fee ?? previous?.fee, grantId: entry.grantId ?? previous?.grantId,
    logs: entry.logs?.map(({ at, phase, message }) => ({ at, phase, message })) ?? [...previous?.logs ?? [], ...(entry.event ? [{ at: now, phase: entry.event.phase, message: entry.event.message }] : [])] };
  if (index < 0) rows.push(row); else rows[index] = row;
  storage.setItem(pilotActivityKey(entry.ownerAddress), JSON.stringify(rows));
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('pilot-account-activity'));
}
