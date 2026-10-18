import { usePilotAccountGuard } from '@owl/pilot-react';
import { useEffect, useRef, useState } from 'react';
import { ccc } from '@ckb-ccc/core';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { authorizeOffchain, PilotOffchainSession, acceptOffchainAction, acceptOffchainRevocation, revokeOffchain,
  recordPilotActivity, offchainManifestHash, type OffchainManifest, type OffchainAuthorization, type OffchainEnvelope, type OffchainRevocation, type OffchainJson } from '@owl/pilot';
import { PilotOffchainModal } from '@owl/pilot-react';
import { socialManifest, emptySocialData, applySocialAction, applySocialRevocation, type SocialData, type SocialReceipt } from '../../../examples/offchain-social';

type SavedSession = { authorization: OffchainAuthorization; privateKey: ccc.Hex };
type SavedWork = { pending?: OffchainEnvelope; revocation?: OffchainRevocation };
const api = (import.meta.env.VITE_PILOT_SOCIAL_URL as string | undefined)?.replace(/\/$/, '');
const manifest = socialManifest(window.location.origin);
const dataKey = 'pilot:social:local-state:' + manifest.audience;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
function read<T>(key: string, fallback: T): T { const value = localStorage.getItem(key); return value ? JSON.parse(value) : fallback; }
function save(key: string, value: unknown) { localStorage.setItem(key, JSON.stringify(value)); }
async function exclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
  if (!navigator.locks) throw new Error('This demo needs HTTPS and browser Web Locks');
  return navigator.locks.request(key, operation);
}
const localStore = {
  async accept(envelope: OffchainEnvelope) { return exclusive(dataKey, async () => { const data = read(dataKey, emptySocialData()); const receipt = applySocialAction(data, envelope); save(dataKey, data); return receipt; }); },
  async revoke(request: OffchainRevocation) { await exclusive(dataKey, async () => { const data = read(dataKey, emptySocialData()); applySocialRevocation(data, request); save(dataKey, data); }); },
};
async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${api}${path}`, { method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(15_000),
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error ?? 'Social verifier rejected request'); return result;
}
async function currentState(): Promise<SocialData> { return api ? { ...emptySocialData(), ...await request<SocialData>('/state') } : read(dataKey, emptySocialData()); }
async function submit(envelope: OffchainEnvelope): Promise<SocialReceipt> {
  return api ? request<SocialReceipt>('/actions', envelope) : acceptOffchainAction(envelope, { manifest, store: localStore });
}
export function OffchainSocial({ signer, address, onConnectOwner }: { signer?: ccc.Signer; address: string; onConnectOwner: () => void }) {
  const key = 'pilot:social:session:' + manifest.audience + ':' + address;
  const current = useRef(key); current.current = key;
  const working = useRef(false);
  const [visible, setVisible] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [session, setSession] = useState<SavedSession>(); const [state, setState] = useState<SocialData>(emptySocialData);
  const [pending, setPending] = useState<SavedWork>({}); const [logs, setLogs] = useState<unknown[]>([]); const [text, setText] = useState('');
  const [clock, setClock] = useState(Date.now());
  usePilotAccountGuard(busy || !!pending.pending || !!pending.revocation);
  const audit = (event: unknown) => {
    try {
      const item = event as { phase: string; envelope?: OffchainEnvelope; receipt?: SocialReceipt };
      const envelope = item.envelope ?? read<SavedWork>(key + ':work', {}).pending;
      if (envelope && envelope.authorization.grant.owner.ownerAddress === address) {
        recordPilotActivity(localStorage, { id: envelope.action.nonce, ownerAddress: address, appId: manifest.appId,
          sessionId: envelope.action.grantId, actionId: envelope.action.id, name: manifest.actions.find(action => action.id === envelope.action.id)?.name ?? envelope.action.id,
          kind: 'offchain', status: item.phase, target: envelope.action.target, grantId: envelope.action.grantId,
          event: { phase: item.phase, message: item.phase === 'signed' ? 'Session-signed message saved before submission.' : item.phase === 'accepted' ? 'Receiving app verified and accepted the signed action; no chain transaction.' : 'Saved request needs reconciliation.' } });
      }
    } catch { /* Diagnostics cannot interrupt signed work. */ }
    let previous: unknown[] = []; try { previous = read<unknown[]>(key + ':logs', []); } catch { /* Diagnostics do not block signing. */ }
    const next = [...previous, { at: Date.now(), event }].slice(-100);
    try { save(key + ':logs', next); } catch { /* Signed work is persisted separately. */ }
    if (current.current === key) setLogs(next);
  };
  useEffect(() => {
    let cancelled = false; setError(''); setSession(undefined); setPending({});
    try {
      const saved = read<SavedSession | undefined>(key, undefined), work = read<SavedWork>(key + ':work', {});
      if (saved && saved.authorization.grant.owner.ownerAddress !== address || work.pending && work.pending.authorization.grant.owner.ownerAddress !== address
        || work.revocation && work.revocation.authorization.grant.owner.ownerAddress !== address) throw new Error('Saved social session belongs to another wallet');
      setSession(saved); setPending(work); setLogs(read(key + ':logs', []));
    }
    catch (error) { setError(errorText(error)); }
    void currentState().then(value => { if (!cancelled) setState(value); }).catch(error => { if (!cancelled) setError(errorText(error)); });
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [key]);
  async function operation(callback: () => Promise<void>) {
    if (working.current) return;
    working.current = true; setBusy(true); setError('');
    try { await exclusive(key, callback); }
    catch (error) { audit({ phase: 'error', message: errorText(error) }); if (current.current === key) setError(errorText(error)); }
    finally { working.current = false; setBusy(false); }
  }
  async function authorize(selected: string[], expiresAt: number) {
    await operation(async () => {
      if (!signer || !address) throw new Error('Connect an owner wallet');
      if (read<SavedSession | undefined>(key, undefined)) throw new Error('Revoke or forget the current social session first');
      if (api && offchainManifestHash(await request<OffchainManifest>('/manifest')) !== offchainManifestHash(manifest)) throw new Error('Social backend manifest does not match this app origin');
      const privateKey = ccc.hexFrom(secp256k1.utils.randomSecretKey());
      const authorization = await authorizeOffchain(signer, manifest, { selected, expiresAt, sessionPublicKey: ccc.hexFrom(secp256k1.getPublicKey(ccc.bytesFrom(privateKey), true)) });
      const saved = { authorization, privateKey }; save(key, saved); audit({ phase: 'authorized', authorization });
      if (current.current === key) { setSession(saved); setVisible(false); }
    });
  }
  async function settle(envelope: OffchainEnvelope) {
    if (envelope.authorization.grant.owner.ownerAddress !== address) throw new Error('Saved request belongs to another wallet');
    const receipt = await submit(envelope); // Same signed envelope is retried, never a newly signed action.
    save(key + ':work', {}); if (current.current === key) setPending({}); audit({ phase: 'accepted', receipt, envelope });
    const next = await currentState(); if (current.current === key) { setPending({}); setState(next); }
  }
  async function act(id: string, target: string, payload: OffchainJson) {
    await operation(async () => {
      const saved = read<SavedSession | undefined>(key, undefined); if (!saved) throw new Error('Approve social actions first');
      const work = read<SavedWork>(key + ':work', {}); if (work.pending || work.revocation) throw new Error('Resolve the saved social request first');
      const pilot = await PilotOffchainSession.create(saved.authorization, manifest, saved.privateKey, Date.now, address);
      const envelope = pilot.sign({ id, target, payload }); save(key + ':work', { pending: envelope }); audit({ phase: 'signed', envelope });
      if (current.current === key) {
        setPending({ pending: envelope }); const projected = structuredClone(state); applySocialAction(projected, envelope); setState(projected);
      }
      try { await settle(envelope); if (current.current === key && id === 'social.post') setText(''); }
      catch (error) { const actual = await currentState().catch(() => undefined); if (actual && current.current === key) setState(actual); throw error; }
    });
  }
  async function retry() {
    await operation(async () => {
      const work = read<SavedWork>(key + ':work', {});
      if (work.revocation) await finishRevocation(work.revocation);
      else if (work.pending) await settle(work.pending);
    });
  }
  async function finishRevocation(revocation: OffchainRevocation) {
    if (revocation.authorization.grant.owner.ownerAddress !== address) throw new Error('Saved revocation belongs to another wallet');
    if (api) await request('/revoke', revocation); else await acceptOffchainRevocation(revocation, { manifest, store: localStore });
    localStorage.removeItem(key); save(key + ':work', {}); audit({ phase: 'revoked', grantId: revocation.request.grantId });
    if (current.current === key) { setSession(undefined); setPending({}); }
  }
  async function revoke() {
    await operation(async () => {
      if (!signer) throw new Error('Connect the owner wallet to revoke');
      const saved = read<SavedSession | undefined>(key, undefined); if (!saved) return;
      const work = read<SavedWork>(key + ':work', {}); if (work.pending || work.revocation) throw new Error('Resolve the saved request first');
      const revocation = await revokeOffchain(signer, saved.authorization, manifest); save(key + ':work', { revocation });
      audit({ phase: 'revoking', revocation }); if (current.current === key) setPending({ revocation }); await finishRevocation(revocation);
    });
  }
  const granted = (id: string) => !!session?.authorization.grant.permissions.includes(id) && session.authorization.grant.expiresAt > clock;
  const unresolved = !!pending.pending || !!pending.revocation;
  const expiredWork = !!pending.pending && clock >= pending.pending.action.expiresAt || !!pending.revocation && clock >= pending.revocation.authorization.grant.expiresAt;
  async function forgetExpiredWork() {
    await operation(async () => {
      const work = read<SavedWork>(key + ':work', {});
      const expiry = work.pending?.action.expiresAt ?? work.revocation?.authorization.grant.expiresAt;
      if (!expiry || Date.now() < expiry) throw new Error('Saved request has not expired');
      const next = await currentState(); save(key + ':work', {}); audit({ phase: 'expired-request-cleared', note: 'An earlier acceptance remains in the feed.' });
      if (current.current === key) { setPending({}); setState(next); }
    });
  }
  function exportLogs() {
    const blob = new Blob([JSON.stringify({ authorization: session?.authorization, pending, logs }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = 'pilot-social-diagnostics.json'; link.click(); URL.revokeObjectURL(url);
  }
  const liked = state.likes.includes(address), followed = state.followers.includes(address);
  return <section className="offchain-social" aria-label="Off-chain social demo">
    <div className="panel-top"><span>PILOT SOCIAL · OFF-CHAIN SIGNATURES</span><span>{api ? 'SHARED VERIFIER' : 'BROWSER-LOCAL DEMO'}</span></div>
    <h2>One approval. Keep connecting.</h2><p>Like, follow, and publish with a session signature. No CKB transaction or fee per action.</p>
    <p className="fine">{api ? 'Actions are verified and stored by the configured social backend.' : 'Signatures are real. Verification and feed storage run in this browser; this is not a shared social network.'}</p>
    {!session && <button className="primary" disabled={busy || unresolved} onClick={() => setVisible(true)}>Enable social signing</button>}
    {address && <button disabled={busy} onClick={() => setVisible(true)}>Social profile &amp; logs</button>}
    {session && <><p>Approved: {session.authorization.grant.permissions.join(', ')} · {session.authorization.grant.expiresAt > clock ? 'Active for this origin' : 'Expired'}</p>
      <button disabled={busy || unresolved || !signer || session.authorization.grant.expiresAt <= clock} onClick={() => void revoke()}>Revoke social session · owner signature</button>
      {session.authorization.grant.expiresAt <= clock && !unresolved && <button onClick={() => { localStorage.removeItem(key); setSession(undefined); }}>Forget expired session</button>}
    </>}
    <article><h3>Building smoother Web3 with Pilot</h3><p>Every interaction can carry a verifiable signature without opening the owner wallet each time.</p>
      <button disabled={busy || unresolved || !granted('social.like')} onClick={() => void act('social.like', 'pilot-introduction', { enabled: !liked })}>{liked ? 'Unlike' : 'Like'} · {state.likes.length}</button>
      <button disabled={busy || unresolved || !granted('social.follow')} onClick={() => void act('social.follow', 'owl', { enabled: !followed })}>{followed ? 'Unfollow Owl' : 'Follow Owl'} · {state.followers.length}</button>
    </article>
    <form onSubmit={event => { event.preventDefault(); void act('social.post', 'pilot-feed', { text }); }}><label>Your post<textarea value={text} onChange={event => setText(event.target.value)} maxLength={280} disabled={!granted('social.post') || busy || unresolved}/></label><button disabled={!granted('social.post') || !text.trim() || busy || unresolved}>Publish signed post</button></form>
    <ul>{state.posts.slice(-10).reverse().map(post => <li key={post.id}><p>{post.text}</p><small>{post.owner.slice(0, 20)}…</small></li>)}</ul>
    {unresolved && <div role="status"><p>A signed request is saved. Check or retry the same request before another action.</p><button disabled={busy || !!expiredWork} onClick={() => void retry()}>Retry saved social request</button>{expiredWork && <button disabled={busy} onClick={() => void forgetExpiredWork()}>Refresh feed and clear expired request</button>}</div>}
    {error && <p role="status">{error}</p>}
    <details><summary>Signed messages, permissions, and verification logs</summary><button onClick={exportLogs}>Export social diagnostics</button><pre>{JSON.stringify({ authorization: session?.authorization, pending, logs }, null, 2)}</pre></details>
    <PilotOffchainModal approvedPermissions={session?.authorization.grant.permissions} visible={visible} manifest={manifest} address={address} busy={busy} error={error} onClose={() => setVisible(false)} onConnectOwner={onConnectOwner} onAuthorize={authorize}/>
  </section>;
}
