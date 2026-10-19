import { getPaymaster } from './runtime';
import { sponsorshipRequested } from './manifest';
import sponsored from '../../../deployments/pilot-sponsored.json';
import { usePilotAccountGuard } from '@owl/pilot-react';
import { useEffect, useRef, useState } from 'react';
import { ccc } from '@ckb-ccc/core';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { SponsorQuoteRejectedError, Pilot, LocalStorageStore, PilotConnector, PilotDelegationAdapter, prepareOwnerAction, prepareDelegationRecovery, submitOwnerDelegationTransaction,
  recordPilotActivity, validatePilotAppManifest, withPilotBudget, type Deployment, type DelegatedCell, type Session, type PreparedDelegation, type DelegationReceipt, type SettlementJournal,
  type CounterTransactionEvent, type PilotActionRequest } from '@owl/pilot';
import { PilotModal, type PilotProfileView } from '@owl/pilot-react';
import { createDelegationExample } from '../../../examples/cell-delegation';
import configuration from '../../../deployments/cell-delegation.json';

type Saved = { budget?: string; session: Session; privateKey: ccc.Hex; cell: DelegatedCell };
type Runtime = { pilot: Pilot<{ position: number }, PilotActionRequest<undefined>>; adapter: PilotDelegationAdapter<{ position: number }, undefined>; saved: Saved };
function jsonStore<T>(key: string) {
  return { async load(): Promise<T | undefined> { const value = localStorage.getItem(key); return value ? JSON.parse(value) : undefined; },
    async save(value: T) { localStorage.setItem(key, JSON.stringify(value)); } };
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const deploymentStorageKey = 'pilot:cell-delegation:public-deployment';
function savedDeployment(): Deployment | undefined {
  try {
    const stored = localStorage.getItem(deploymentStorageKey);
    const value = sponsorshipRequested ? sponsored.delegation : stored ? JSON.parse(stored) : configuration.deployment;
    if (!value) return undefined;
    validatePilotAppManifest(createDelegationExample(value, sponsorshipRequested ? sponsored.poolLock as ccc.ScriptLike : undefined).manifest);
    return value.network === 'testnet' ? value : undefined;
  } catch { return undefined; }
}
export function CellDelegation({ profileLookupError, onRetryProfile, profileLoading, signer, address, balance, profile, onProfile, onConnectOwner, onRefreshBalance, onDisconnectOwner }: {
  profileLookupError?: string; onRetryProfile?:()=>void; profileLoading?: boolean; signer?: ccc.Signer; address: string; balance?: bigint; profile?: PilotProfileView;
  onProfile: (name: string) => Promise<PilotProfileView>; onConnectOwner: () => void; onRefreshBalance: () => void; onDisconnectOwner: () => void;
}) {
  const [deployment, setDeployment] = useState<Deployment | undefined>(savedDeployment);
  const [selectedBudget,setSelectedBudget]=useState('2000000');
  const [mode, setMode] = useState<'create' | 'migrate'>('create');
  const [sourceHash, setSourceHash] = useState(''); const [sourceIndex, setSourceIndex] = useState('0');
  const [visible, setVisible] = useState(false); const [busy, setBusy] = useState(''); const [error, setError] = useState('');
  const [runtime, setRuntime] = useState<Runtime>(); const [position, setPosition] = useState(5);
  const [ownerReview, setOwnerReview] = useState<{ transaction: ccc.Transaction; recovery: boolean; fee: string }>();
  const [ready, setReady] = useState<Record<string, boolean>>({}); const [queue, setQueue] = useState<unknown[]>([]);
  const [logs, setLogs] = useState<{ time: string; event: unknown }[]>([]);
  const prepared = useRef<{ connector: PilotConnector<{ position: number }, undefined>; transaction: PreparedDelegation; privateKey: ccc.Hex } | undefined>(undefined);
  const active = useRef<Runtime | undefined>(undefined); const lease = useRef(false); const epoch = useRef(0);
  const pendingOwner = useRef<Promise<void> | undefined>(undefined);
  const liveKey = useRef('');
  const key = address && deployment ? `pilot:cell-delegation:${deployment.codeHash}:${address}` : '';
  usePilotAccountGuard(!!busy || queue.length > 0);
  const baseDefinition = deployment ? createDelegationExample(deployment, sponsorshipRequested ? sponsored.poolLock as ccc.ScriptLike : undefined) : undefined;
  function definitionFor(budget?: string) {
    if (!baseDefinition) return undefined;
    return { ...baseDefinition, manifest: withPilotBudget(baseDefinition.manifest,budget??baseDefinition.manifest.policy.budget) };
  }
  const definition = definitionFor(runtime?.saved.budget??selectedBudget);
  const sponsorOptions = () => ({ paymaster: signer ? getPaymaster(signer.client) : undefined });
  function discardRejectedOwnerQuote(error: unknown) {
    if (!(error instanceof SponsorQuoteRejectedError)) return;
    for (const suffix of [':setup', ':owner']) {
      const raw = localStorage.getItem(key + suffix); const receipt: DelegationReceipt | undefined = raw ? JSON.parse(raw) : undefined;
      if (receipt && !receipt.confirmed && receipt.hash === receipt.paymasterQuote?.transactionHash && receipt.paymasterQuote?.id === error.quoteId) {
        localStorage.removeItem(key + suffix);
        if (suffix === ':setup') localStorage.removeItem(key + ':session');
      }
    }
  }
  const log = (event: unknown) => {
    const diagnostic = JSON.parse(JSON.stringify(event, (_key, value) => value instanceof Error ? { name: value.name, message: value.message } : typeof value === 'bigint' ? value.toString() : value));
    try {
      const entry = diagnostic as { phase?: string; type?: string; id?: string; actionId?: string; transactionHash?: string; kind?: string; networkFee?: string; feePayer?: string };
      const id = entry.actionId ?? entry.id;
      if (id && definition) {
        const journal = JSON.parse(localStorage.getItem(key + ':pilot') ?? '{}');
        const actionId = journal.queue?.find((row: {id:string}) => row.id === id)?.action?.id;
        const name = definition.manifest.actions.find(action => action.id === actionId)?.name;
        const phase = entry.phase ?? entry.type ?? 'recorded';
        // Once the engine drains a confirmed entry, retain its earlier label in history.
        const history = JSON.parse(localStorage.getItem('pilot:account-activity:v1:' + address) ?? '[]');
        const old = history.find((row: {id:string}) => row.id === id);
        recordPilotActivity(localStorage, { id, ownerAddress: address, appId: definition.manifest.app.id,
          sessionId: active.current?.saved.session.id ?? old?.sessionId ?? '', actionId: actionId ?? old?.actionId ?? id,
          name: name ?? old?.name ?? 'Delegated app action', kind: 'onchain', status: phase === 'settled' ? 'confirmed' : phase,
          transactionHash: entry.transactionHash, fee: entry.networkFee ?? old?.fee ?? definition.manifest.policy.feePerAction,
          event: { phase, message: phase === 'accepted' ? 'Action persisted and budget reserved; projected state updated.' : phase === 'confirmed' || phase === 'settled' ? 'Transaction confirmed on-chain.' : 'Background settlement: ' + phase + (entry.feePayer === 'pool' ? '. Pool network fee: ' + entry.networkFee + ' shannons; user network fee: 0.' : '') } });
      }
    } catch { /* Diagnostic history cannot interrupt settlement. */ }
    const previous = key ? JSON.parse(localStorage.getItem(key + ':logs') ?? '[]') : [];
    const next = [...previous, { time: new Date().toISOString(), event: diagnostic }].slice(-100);
    if (key) localStorage.setItem(key + ':logs', JSON.stringify(next));
    if (liveKey.current === key) setLogs(next);
  };
  function holdOwnerOperation() {
    let done!: () => void; const pending = new Promise<void>(resolve => { done = resolve; }); pendingOwner.current = pending;
    return () => { done(); if (pendingOwner.current === pending) pendingOwner.current = undefined; };
  }
  async function refresh(value: Runtime) {
    if (active.current !== value) return;
    await value.pilot.prepare(['game.forward', 'game.backward'].map(id => ({ id, action: { id, params: undefined } })));
    if (active.current !== value) return;
    setReady(Object.fromEntries(['game.forward', 'game.backward'].map(id => [id, value.pilot.readiness(id).ready])));
    setPosition(value.pilot.state.position);
    const journal = await jsonStore<{ queue: unknown[] }>(key + ':pilot').load(); setQueue(journal?.queue ?? []);
  }
  async function attach(saved: Saved, version = epoch.current) {
    const definition=definitionFor(saved.budget);
    if (!signer || !definition) throw new Error('Connect a wallet and configure a deployment');
    if (!(await signer.getRecommendedAddressObj()).script.eq(saved.cell.ownerLock)) throw new Error('Saved delegation belongs to another connected wallet');
    const adapter = await PilotDelegationAdapter.create({ ...sponsorOptions(), definition, client: signer.client, cell: saved.cell, session: saved.session,
      sessionPrivateKey: saved.privateKey, store: jsonStore<SettlementJournal>(key + ':settlement'), onTransaction: event => log(event) });
    const ownerReceipt = await jsonStore<DelegationReceipt>(key + ':owner').load();
    let ownerState: { state: { position: number }; remainingBudget: bigint } | undefined;
    if (ownerReceipt) {
      const hash = await new PilotConnector(signer, definition, sponsorOptions()).resume(jsonStore(key + ':owner'), event => log(event));
      if (ownerReceipt.kind === 'recovery') {
        for (const suffix of [':session', ':setup', ':pilot', ':settlement', ':owner']) localStorage.removeItem(key + suffix);
        log({ phase: 'confirmed', kind: 'recovery', transactionHash: hash }); return;
      }
      ownerState = await adapter.adoptOwnerAction(hash, 'game.jump');
    }
    const live = await signer.client.getCellLive(adapter.currentOutPoint, true);
    if (!live) throw new Error('Delegated cell is not live; reconcile owner transactions first');
    const pilot = await Pilot.create({ session: saved.session, state: definition.decodeState(live.outputData),
      budget: sponsorshipRequested ? BigInt(definition.manifest.policy.budget) : live.cellOutput.capacity - BigInt(definition.manifest.policy.floorCapacity), adapter,
      store: new LocalStorageStore<{ position: number }, PilotActionRequest<undefined>>(localStorage, key + ':pilot'), autoSettle: false,
      onEvent: event => { log(event); const current = active.current; if (epoch.current === version && current) void refresh(current).catch(e => setError(message(e))); } });
    if (ownerState) { await pilot.reconcileConfirmed(ownerState.state, ownerState.remainingBudget); localStorage.removeItem(key + ':owner'); }
    if (epoch.current !== version) return;
    const value = { pilot, adapter, saved }; active.current = value; setRuntime(value); await refresh(value); void pilot.flush();
  }
  useEffect(() => {
    const version = ++epoch.current; liveKey.current = key; let release: (() => void) | undefined; let cancelled = false;
    const abort = new AbortController(); active.current = undefined; prepared.current = undefined; lease.current = false;
    setRuntime(undefined); setOwnerReview(undefined); setReady({}); setQueue([]); setPosition(5); setError(''); setBusy('');
    setLogs(key ? JSON.parse(localStorage.getItem(key + ':logs') ?? '[]') : []);
    if (key && signer && definition && navigator.locks) {
      void navigator.locks.request(key, { signal: abort.signal }, async () => {
        if (cancelled) return; lease.current = true;
        const hold = new Promise<void>(resolve => { release = resolve; });
        try {
          const saved = await jsonStore<Saved>(key + ':session').load();
          const setup = await jsonStore<DelegationReceipt>(key + ':setup').load();
          if (saved && setup) { await new PilotConnector(signer, definition, sponsorOptions()).resume(jsonStore(key + ':setup')); if (epoch.current === version) await attach(saved, version); }
        } catch (e) { if (!cancelled) setError(message(e)); }
        await hold; if (epoch.current === version) lease.current = false;
      }).catch(e => { if (!cancelled) setError(message(e)); });
    }
    return () => { cancelled = true; abort.abort(); const value = active.current; active.current = undefined;
      void Promise.allSettled([value?.pilot.flush(), pendingOwner.current]).finally(() => release?.()); };
  }, [key, signer]);
  useEffect(() => {
    if (!runtime) return;
    const timer = window.setInterval(() => { if (active.current === runtime) { void runtime.pilot.flush(); void refresh(runtime).catch(e => setError(message(e))); } }, 5000);
    return () => clearInterval(timer);
  }, [runtime]);

  async function prepare(permissions: string[]) {
    if (!signer || !definition || !lease.current) throw new Error('Connect your wallet; this tab must hold session access');
    if (await jsonStore<DelegationReceipt>(key + ':setup').load()) throw new Error('Resume or end the existing setup before delegating again');
    const version = epoch.current;
    setBusy('Preparing your selected cell and funding review'); setError('');
    try {
      const privateKey = ccc.hexFrom(crypto.getRandomValues(new Uint8Array(32)));
      const connector = new PilotConnector(signer, definition, sponsorOptions());
      const transaction = await connector.prepareDelegation({ selected: permissions, sessionPublicKey: ccc.hexFrom(secp256k1.getPublicKey(ccc.bytesFrom(privateKey), true)),
        ...(mode === 'create' ? { initialState: { position: 5 } } : { source: { txHash: ccc.hexFrom(sourceHash), index: Number(sourceIndex) } }) });
      if (transaction.mode !== 'delegation') throw new Error('No permissions selected');
      if (epoch.current !== version) throw new Error('Wallet changed; prepare delegation again');
      prepared.current = { connector, transaction, privateKey }; return transaction.review;
    } finally { if (epoch.current === version) setBusy(''); }
  }
  async function authorize(permissions: string[]) {
    if (pendingOwner.current) return false;
    const value = prepared.current;
    if (!value || !definition || !permissions.every(id => value.transaction.cell.grant.permissions.includes(id)) || permissions.length !== value.transaction.cell.grant.permissions.length) return false;
    const version = epoch.current; const release = holdOwnerOperation();
    setBusy('Approve the reviewed delegation in your wallet');
    try {
      const saved: Saved = { budget: definition.manifest.policy.budget, privateKey: value.privateKey, cell: value.transaction.cell,
        session: { id: crypto.randomUUID(), network: definition.manifest.network, policyVersion: definition.manifest.policy.kind, expiresAt: Date.now() + 86_400_000 } };
      await jsonStore<Saved>(key + ':session').save(saved);
      saved.cell = await value.connector.authorize(value.transaction, jsonStore(key + ':setup'), event => log(event));
      await jsonStore<Saved>(key + ':session').save(saved); if (epoch.current !== version) return false;
      await attach(saved, version); onRefreshBalance(); return true;
    } catch (e) { discardRejectedOwnerQuote(e); if (epoch.current === version) setError(message(e)); log({ error: message(e) }); return false; } finally { release(); if (epoch.current === version) setBusy(''); }
  }
  async function resume() {
    if (pendingOwner.current) return;
    if (!signer || !definition || !lease.current) return;
    const version = epoch.current; const release = holdOwnerOperation(); setBusy('Reconciling the saved delegation');
    try {
      await new PilotConnector(signer, definition, sponsorOptions()).resume(jsonStore(key + ':setup'), event => log(event));
      const saved = await jsonStore<Saved>(key + ':session').load(); if (saved && epoch.current === version) await attach(saved, version);
    } catch (e) { discardRejectedOwnerQuote(e); if (epoch.current === version) setError(message(e)); } finally { release(); if (epoch.current === version) setBusy(''); }
  }
  async function action(id: string) {
    const value = active.current; if (!value) return;
    setError(''); setReady({});
    try { await value.pilot.execute(id); await refresh(value); void value.pilot.flush(); }
    catch (e) { setError(message(e)); }
  }
  async function ownerAction(recovery: boolean, approved = false) {
    if (pendingOwner.current) return;
    const value = active.current; if (!value || !signer || !definition || value.pilot.queueLength) return;
    const version = epoch.current; const release = holdOwnerOperation();
    setBusy(recovery ? 'Review recovery and sign in your wallet' : 'Sign the owner-only jump'); setReady({});
    const store = jsonStore<DelegationReceipt>(key + ':owner');
    try {
      const previous = await store.load();
      if (previous && previous.kind !== (recovery ? 'recovery' : 'manual')) throw new Error('Resolve the other saved owner operation first');
      let hash: ccc.Hex;
      if (previous) hash = await new PilotConnector(signer, definition, sponsorOptions()).resume(store);
      else {
        if (!approved) {
          const tx = recovery ? await prepareDelegationRecovery(signer, definition.manifest, value.saved.cell, value.adapter.currentOutPoint, sponsorOptions())
            : await prepareOwnerAction(signer, definition, value.saved.cell, value.adapter.currentOutPoint, { id: 'game.jump', params: undefined }, value.saved.session, sponsorOptions());
          let inputCapacity = 0n;
          for (const input of tx.inputs) { const cell = await signer.client.getCellLive(input.previousOutput, true); if (!cell) throw new Error('Owner action input is no longer live'); inputCapacity += cell.cellOutput.capacity; }
          const fee = inputCapacity - tx.outputs.reduce((sum, output) => sum + output.capacity, 0n);
          if (epoch.current !== version) return;
          setOwnerReview({ transaction: tx, recovery, fee: fee.toString() }); setVisible(false);
          log({ phase: 'owner-review', kind: recovery ? 'recovery' : 'manual', transactionHash: tx.hash(), fee: fee.toString() }); return;
        }
        if (!ownerReview || ownerReview.recovery !== recovery) throw new Error('Review the owner transaction first');
        const tx = ownerReview.transaction;
        hash = await submitOwnerDelegationTransaction(signer, tx, recovery ? 'recovery' : 'manual', store, event => log(event));
      }
      log({ phase: 'confirmed', kind: recovery ? 'recovery' : 'manual', transactionHash: hash });
      if (epoch.current !== version) return;
      setOwnerReview(undefined);
      if (recovery) {
        active.current = undefined; setRuntime(undefined); setQueue([]);
        for (const suffix of [':session', ':setup', ':pilot', ':settlement', ':owner']) localStorage.removeItem(key + suffix);
      } else {
        const updated = await value.adapter.adoptOwnerAction(hash, 'game.jump'); await value.pilot.reconcileConfirmed(updated.state, updated.remainingBudget);
        localStorage.removeItem(key + ':owner'); await refresh(value);
      }
      onRefreshBalance();
    } catch (e) { discardRejectedOwnerQuote(e); if (epoch.current === version) setError(message(e)); log({ error: message(e) }); } finally { release(); if (epoch.current === version) setBusy(''); }
  }
  const submitted = !!key && !!localStorage.getItem(key + ':setup') && !runtime;
  return <section className="delegation-demo" style={{ marginTop: 24, padding: 24, border: '1px solid #304538', borderRadius: 16 }}>
    <h2>Developer cell delegation</h2><p>Named actions, individual permissions, explicit app-cell selection, and owner recovery.</p>
    {!deployment && <p>The reusable contract is verified locally. Load its public testnet deployment JSON to enable this example.</p>}
    <label>Deployment JSON <input type="file" accept="application/json,.json" disabled={!!runtime || !!busy || submitted} onChange={event => {
      const file = event.target.files?.[0]; if (!file) return;
      void file.text().then(text => { const parsed = JSON.parse(text); const value = parsed.deployment ?? parsed; const definition = createDelegationExample(value);
        validatePilotAppManifest(definition.manifest); if (value.network !== 'testnet') throw new Error('This browser demo uses CKB testnet');
        localStorage.setItem(deploymentStorageKey, JSON.stringify(value)); setDeployment(value); setError('');
      }).catch(e => setError(message(e)));
    }}/></label>
    {definition && <>
      {!runtime && !submitted && <div><label>App cell <select value={mode} onChange={event => { setMode(event.target.value as 'create' | 'migrate'); prepared.current = undefined; }}><option value="create">Create a new app cell</option><option value="migrate">Delegate my selected existing app cell</option></select></label>
        {mode === 'migrate' && <><label>Source transaction hash <input value={sourceHash} onChange={event => setSourceHash(event.target.value)} placeholder="0x…"/></label><label>Output index <input type="number" min="0" value={sourceIndex} onChange={event => setSourceIndex(event.target.value)}/></label></>}
      </div>}
      <p>Position: <strong>{position}</strong> · {queue.length} queued actions</p>
      <button disabled={!!busy} onClick={() => setVisible(true)}>{runtime ? 'Inspect delegated permissions' : 'Connect through Pilot'}</button>
      {runtime && <><button disabled={!ready['game.forward'] || !!busy || !!ownerReview} onClick={() => void action('game.forward')}>Move forward</button><button disabled={!ready['game.backward'] || !!busy || !!ownerReview} onClick={() => void action('game.backward')}>Move backward</button>
        <button disabled={!!busy || !!queue.length} onClick={() => void ownerAction(false)}>Jump two steps · owner signature</button><button disabled={!!busy || !!queue.length} onClick={() => void ownerAction(true)}>Recover app cell</button></>}
      {ownerReview && <div className="delegation-review"><h3>{ownerReview.recovery ? 'Review app-cell recovery' : 'Review owner-only jump'}</h3>
        <p>{sponsorshipRequested ? 'Pool network fee: ' : 'Fee: '}{Number(BigInt(ownerReview.fee)) / 100000000} CKB.{sponsorshipRequested ? ' Your network fee: 0 CKB.' : ''} This operation requires your owner-wallet signature.</p>
        <p>Output capacity: {Number(ownerReview.transaction.outputs[0]!.capacity) / 100000000} CKB.</p>
        <details><summary>Owner transaction and preserved app state</summary><pre>{JSON.stringify({ transactionHash: ownerReview.transaction.hash(), bytes: ccc.hexFrom(ownerReview.transaction.toBytes()), outputData: ownerReview.transaction.outputsData[0] }, null, 2)}</pre></details>
        <button disabled={!!busy} onClick={()=>void ownerAction(ownerReview.recovery,true)}>Approve owner transaction</button><button disabled={!!busy} onClick={()=>setOwnerReview(undefined)}>Cancel review</button>
      </div>}
      <details><summary>App manifest and registered actions</summary><pre>{JSON.stringify(definition.manifest, null, 2)}</pre></details>
      <PilotModal profileLookupError={profileLookupError} onRetryProfile={onRetryProfile} profileLoading={profileLoading} budgetLimit={baseDefinition!.manifest.policy.budget} onBudgetChange={value=>{prepared.current=undefined;setSelectedBudget(value);}} manifest={definition.manifest} visible={visible} address={address} balance={balance} profile={profile} active={!!runtime} busy={busy} canAuthorize={!!signer && lease.current}
        queueLength={queue.length} submitted={submitted} error={error} onResume={resume} onClose={() => setVisible(false)} onConnectOwner={onConnectOwner} onProfile={onProfile}
        onPrepareDelegation={prepare} onAuthorize={authorize} onContinueWithoutDelegation={() => { prepared.current = undefined; setVisible(false); log({ phase: 'connected', delegation: 'declined' }); }}
        approvedPermissions={runtime?.saved.cell.grant.permissions} onDisconnect={()=>{setVisible(false);onDisconnectOwner();}} onRevoke={() => ownerAction(true)} onRefreshBalance={onRefreshBalance}/>
    </>}
    <details><summary>Delegation queue and transaction logs</summary><pre>{JSON.stringify({ queue, logs }, null, 2)}</pre></details>
    {(error || busy) && <p role="status">{busy || error}</p>}
  </section>;
}
