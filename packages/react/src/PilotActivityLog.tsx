import { useEffect, useState } from 'react';
import { readPilotActivity, type PilotActivity } from '@owl/pilot';

/** Supply activity for a custom journal, or use recordPilotActivity's local browser history. */
export function PilotActivityLog({ address, activity }: { address: string; activity?: readonly PilotActivity[] }) {
  const [local, setLocal] = useState<PilotActivity[]>([]);
  useEffect(() => {
    const refresh = () => { try { setLocal(readPilotActivity(window.localStorage, address)); } catch { setLocal([]); } };
    refresh(); window.addEventListener('pilot-account-activity', refresh); window.addEventListener('storage', refresh);
    return () => { window.removeEventListener('pilot-account-activity', refresh); window.removeEventListener('storage', refresh); };
  }, [address]);
  const rows = (activity ?? local).filter(row => row.ownerAddress === address).sort((a, b) => b.createdAt - a.createdAt);
  return <details className="pilot-action-history"><summary>Activity &amp; logs ({rows.length})</summary>
    <p className="fine">Actions recorded for this wallet on this browser and origin. Local acceptance is immediate; settlement is tracked separately. Logs are diagnostics, not proof of authorization.</p>
    {!rows.length && <p>No actions recorded for this wallet yet.</p>}
    <ol>{rows.map(row => <li key={`${row.appId}:${row.sessionId}:${row.id}`}><details>
      <summary><strong>{row.name}</strong><span>{row.kind === 'offchain' ? (row.status === 'accepted' ? 'Accepted by app' : row.status) : row.status === 'confirmed' ? 'Confirmed on-chain' : row.status} · {new Date(row.createdAt).toLocaleString()}</span></summary>
      <dl><dt>App</dt><dd>{row.appId}</dd><dt>Action</dt><dd>{row.actionId}</dd><dt>Signing</dt><dd>{row.kind === 'owner' ? 'Owner wallet' : 'Pilot session key'}</dd><dt>Session</dt><dd>{row.sessionId || '—'}</dd><dt>Action record</dt><dd>{row.id}</dd>
        {row.target && <><dt>Target</dt><dd>{row.target}</dd></>}{row.fee && <><dt>Reserved fee (shannons)</dt><dd>{row.fee}</dd></>}
        {row.transactionHash && <><dt>Transaction hash</dt><dd>{row.transactionHash}</dd></>}{row.grantId && <><dt>Grant</dt><dd>{row.grantId}</dd></>}</dl>
      <ol>{row.logs.map((log, index) => <li key={index}><time>{new Date(log.at).toLocaleString()}</time> · <strong>{log.phase}</strong> · {log.message}</li>)}</ol>
    </details></li>)}</ol>
  </details>;
}
