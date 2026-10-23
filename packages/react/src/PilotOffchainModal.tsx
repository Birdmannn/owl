import { useEffect, useRef, useState } from 'react';
import { PilotActivityLog } from './PilotActivityLog.js';
import type { PilotActivity, OffchainManifest } from '@owl/pilot';

/** Consent UI for message delegation. It never requests on-chain approval or funding. */
export function PilotOffchainModal({ visible, manifest, address, busy, error, onClose, onConnectOwner, onAuthorize, activity, approvedPermissions }: {
  activity?: readonly PilotActivity[]; approvedPermissions?: readonly string[]; visible: boolean; manifest: OffchainManifest; address: string; busy: boolean; error?: string;
  onClose: () => void; onConnectOwner: () => void; onAuthorize: (selected: string[], expiresAt: number) => Promise<void>;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [localError, setLocalError] = useState('');
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => { if (visible) { setSelected([]); setLocalError(''); } }, [visible, address, manifest.audience]);
  useEffect(() => {
    if (!visible) return;
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLElement>('button,input')?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose();
      if (event.key !== 'Tab') return;
      const items = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),a[href],summary') ?? []).filter(item => item.getClientRects().length > 0);
      if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0]?.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('keydown', keydown); previous?.focus(); };
  }, [visible, busy, onClose]);
  if (!visible) return null;
  return <div className="modal-backdrop pilot-modal-backdrop" onClick={() => { if (!busy) onClose(); }}>
    <section className="pilot-modal" ref={dialog} role="dialog" aria-modal="true" aria-labelledby="pilot-offchain-title" onClick={event => event.stopPropagation()}>
      <button className="close" aria-label="Close off-chain permissions" disabled={busy} onClick={onClose}>×</button>
      <div className="pilot-modal-brand"><strong>Pilot <small>by Owl</small></strong><span>OFF-CHAIN</span></div>
      <h2 id="pilot-offchain-title">{approvedPermissions ? 'Your Pilot social profile' : 'Sign social actions on my behalf'}</h2>
      <p>{manifest.name} · {manifest.audience}</p>
      <p className="fine">One wallet message approves only the selected actions for one hour. No CKB funding, transaction, or spending permission.</p>
      {address ? <><code style={{ overflowWrap: 'anywhere' }}>{address}</code>
        {manifest.actions.map(action => <label key={action.id} className={`permission-choice ${selected.includes(action.id) ? 'checked' : ''}`}>
          <input type="checkbox" checked={approvedPermissions ? approvedPermissions.includes(action.id) : selected.includes(action.id)} disabled={busy || !!approvedPermissions} onChange={event => setSelected(previous => event.target.checked ? [...previous, action.id] : previous.filter(id => id !== action.id))}/>
          <span><strong>{action.name}</strong><small>{action.description}</small><code>{action.id} · verified by the receiving app</code></span>
        </label>)}
        {!approvedPermissions && <><button className="primary full" disabled={busy || !selected.length} onClick={() => { setLocalError(''); void onAuthorize([...selected], Date.now() + 3_600_000).catch(error => setLocalError(error instanceof Error ? error.message : String(error))); }}>Approve selected off-chain actions</button>
        <button className="secondary full" disabled={busy} onClick={onClose}>Continue without automatic signing</button></>}
        {approvedPermissions && <button className="primary full" onClick={onClose}>Return to app</button>}
      </> : <button className="primary full" onClick={onConnectOwner}>Connect owner wallet for social demo</button>}
      {address && <PilotActivityLog address={address} activity={activity}/>}
      <p className="fine">The receiving app verifies the owner delegation and each session signature. Disconnecting alone does not revoke a grant; use Revoke social session.</p>
      {(localError || error) && <p role="status">{localError || error}</p>}{busy && <p role="status">Waiting for approval…</p>}
    </section>
  </div>;
}
