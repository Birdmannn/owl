import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ccc } from '@ckb-ccc/connector-react';
import { assertCounterPermission, withPilotBudget, type PilotEvent } from '@owl/pilot';
import { revokeSavedSession, revocationKey, amount, authorize, budget, deployment, fee, readSession, restore, sessionKey, type Runtime } from './runtime';
import { TransactionInspector } from './TransactionInspector';
import { updateActivity, transactionObserver, logFailure, readActivity } from './activity';
import { PilotModal, PilotAccountsProvider, usePilotAccounts, usePilotAccountGuard } from '@owl/pilot-react';
import '@owl/pilot-react/styles.css';
import { flightManifest, sponsorshipRequested, sponsorshipReady } from './manifest';
import { readProfile, loadProfile, saveProfile, type PilotProfile } from './profile';
import { UsernameTransfers } from './UsernameTransfers';
import { OffchainSocial } from './OffchainSocial';
import { CellDelegation } from './CellDelegation';
import './style.css';
const client = new ccc.ClientPublicTestnet({ url: 'https://testnet.ckb.dev' });
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);
const short = (a: string) => `${a.slice(0, 9)}…${a.slice(-6)}`;
function App() {
  const { isOpen } = ccc.useCcc();
  const accounts = usePilotAccounts();
  const { signer, walletName, disconnect, connectWallet: open } = accounts;
  const [address, setAddress] = useState('');
  const [balance, setBalance] = useState<bigint>();
  const [runtime, setRuntime] = useState<Runtime>();
  const active = useRef<Runtime | undefined>(undefined);
  const [position, setPosition] = useState(0);
  const [settled, setSettled] = useState(0);
  const [remaining, setRemaining] = useState(budget);
  const [ready, setReady] = useState(false);
  const [operationBusy, setBusy] = useState('');
  const busy = accounts.switching ? 'Switching owner account' : operationBusy;
  usePilotAccountGuard(!!operationBusy || (runtime?.pilot.queueLength ?? 0) > 0);
  const [message, setMessage] = useState('');
  const [pilotOpen, setPilotOpen] = useState(false);
  const [profileLookupError,setProfileLookupError]=useState('');
  const [profileLoading,setProfileLoading]=useState(false);
  const [selectedBudget,setSelectedBudget]=useState(flightManifest.policy.budget);
  const sessionManifest=runtime?.saved.manifest??withPilotBudget(flightManifest,selectedBudget);
  const sessionBudget=BigInt(sessionManifest.policy.budget);
  const [profile, setProfile] = useState<PilotProfile>();
  const [transactions, setTransactions] = useState<string[]>([]);
  const lockHeld = useRef(false);
  const epoch = useRef(0);
  const refresh = async (r: Runtime) => {
    if (active.current !== r) return;
    setPosition(r.pilot.state.position); setSettled(r.pilot.confirmedState.position); setRemaining(r.pilot.availableBudget);
    if (localStorage.getItem(revocationKey(r))) { setReady(false); return; }
    await r.pilot.prepare([{ id: 'move', action: { steps: 1 } }]);
    if (active.current === r) setReady(r.pilot.readiness('move').ready && !!readProfile(r.key.slice(r.key.lastIndexOf(':')+1)));
  };
  const flush = (r: Runtime) => { void r.pilot.flush().catch(e => { if (active.current === r) setMessage(errorText(e)); }); };
  const onEvent = (event: PilotEvent) => {
    const r = active.current; if (!r) return;
    if (event.type === 'settled') { setTransactions(h => [event.transactionHash, ...h].slice(0, 5)); setMessage(''); }
    if (event.type === 'retry') { console.warn('Pilot settlement retry', event.error); setMessage('Settlement interrupted. Your moves are saved and will retry automatically.'); }
    if (event.type === 'reverted') setMessage(`The chain rejected the action. Position restored. ${errorText(event.error)}`);
    void refresh(r).catch(e => setMessage(errorText(e)));
  };
  const attach = async (key: string, saved: NonNullable<ReturnType<typeof readSession>>, version: number) => {
    const r = await restore(client, key, saved, event => { if (epoch.current === version) onEvent(event); });
    if (epoch.current !== version) return;
    active.current = r; setRuntime(r); setTransactions(r.receipts.slice(0, 5)); await refresh(r); flush(r);
  };
  useEffect(() => {
    const version = ++epoch.current;
    active.current = undefined; setRuntime(undefined); setReady(false); setAddress(''); setProfile(undefined); setBalance(undefined); setPosition(0); setSettled(0); setRemaining(budget); setSelectedBudget(flightManifest.policy.budget);setProfileLoading(false);setProfileLookupError(''); setTransactions([]); setMessage(''); setBusy('');
    let release: (() => void) | undefined;
    let cancelled = false;
    const lockAbort = new AbortController();
    let waitNotice: number | undefined;
    if (signer) {
      setBusy('Connecting wallet'); setProfileLoading(true);
      void (async () => {
        const a = await signer.getRecommendedAddress();
        if (cancelled) return;
        setAddress(a);
        try { const savedProfile = await loadProfile(a); if (cancelled) return; setProfile(savedProfile); }
        catch (e) { if (!cancelled) setProfileLookupError(errorText(e)); }
        finally { if (!cancelled) setProfileLoading(false); }
        void signer.getBalance().then(b => { if (!cancelled) setBalance(b); }).catch(() => {});
        if (!navigator.locks) throw new Error('This browser cannot protect sessions across tabs. Use a current browser.');
        waitNotice = window.setTimeout(() => { if (!cancelled && !lockHeld.current) setMessage('Waiting for session access. If Pilot is open in another tab, close it to continue here.'); }, 1000);
        void navigator.locks.request(sessionKey(a), { signal: lockAbort.signal }, async lock => {
          if (cancelled) return;
          if (!lock) return;
          clearTimeout(waitNotice); setMessage('');
          lockHeld.current = true;
          const hold = new Promise<void>(resolve => { release = resolve; });
          try { const saved = readSession(sessionKey(a)); if (saved?.cell) { setBusy('Restoring session'); await attach(sessionKey(a), saved, version); } }
          catch (e) { if (!cancelled) setMessage(errorText(e)); }
          finally { if (!cancelled) setBusy(''); }
          await hold;
          lockHeld.current = false;
        }).catch(e => { if (!cancelled && e?.name !== 'AbortError') setMessage(errorText(e)); });
      })().catch(e => { if (!cancelled) { setMessage(errorText(e)); setBusy(''); setProfileLoading(false); } });
    }
    return () => { cancelled = true; clearTimeout(waitNotice); lockAbort.abort(); const r = active.current; active.current = undefined; if (r) void r.pilot.flush().catch(() => {}).finally(() => release?.()); else release?.(); };
  }, [signer]);
  useEffect(() => {
    if (!runtime) return;
    const tick = () => { if (active.current === runtime) { void refresh(runtime).catch(e => setMessage(errorText(e))); flush(runtime); } };
    const timer = window.setInterval(tick, 5000); window.addEventListener('online', tick);
    return () => { clearInterval(timer); window.removeEventListener('online', tick); };
  }, [runtime]);
  const retryProfile = async () => {
    if (!address) return;
    const version=epoch.current;setProfileLoading(true);setProfileLookupError('');
    try {const value=await loadProfile(address);if(epoch.current===version)setProfile(value);}
    catch(error){if(epoch.current===version)setProfileLookupError(errorText(error));}
    finally{if(epoch.current===version)setProfileLoading(false);}
  };
  const start = async (permissions: string[]): Promise<boolean> => {
    if (!signer || !address || !lockHeld.current) return false; setBusy('Approve the session in your wallet'); setMessage('');
    const version = epoch.current;
    const key = sessionKey(address);
    try {
      const saved = await authorize(signer, key, permissions, selectedBudget);
      if (version !== epoch.current) return false;
      setBusy('Activating session'); await attach(key, saved, version);
      void signer.getBalance().then(setBalance).catch(() => {});
      return true;
    } catch (e) { if (version === epoch.current) setMessage(errorText(e)); return false; }
    finally { if (version === epoch.current) setBusy(''); }
  };
  const move = async () => {
    const r = active.current; if (!r || !ready) return;
    setReady(false);
    try { if(!r.saved.grant)throw new Error('No Pilot permission grant'); assertCounterPermission(r.saved.manifest??flightManifest,r.saved.grant,'counter.increment'); await r.pilot.execute('move'); await refresh(r); flush(r); } catch (e) { setMessage(errorText(e)); await refresh(r); }
  };
  const revoke = async () => {
    const r = active.current; if (!r || !signer || r.pilot.queueLength || !r.saved.cell) return;
    setBusy('Reclaim capacity in your wallet'); setReady(false); setMessage('');
    const operationId = `${r.saved.session.id}:revocation:${crypto.randomUUID()}`;
    updateActivity(r.key, operationId, { sessionId: r.saved.session.id, kind: 'revocation', title: 'End session & reclaim capacity', status: 'signing' }, { phase: 'created', message: 'Owner recovery requested. The move queue is empty; building a transaction that spends the latest session cell.' });
    try {
      const hash = await revokeSavedSession(signer, r, transactionObserver(r.key, operationId, { sessionId: r.saved.session.id, kind: 'revocation', title: 'End session & reclaim capacity' }));
      localStorage.removeItem(r.key); active.current = undefined; setRuntime(undefined); setTransactions(h => [hash, ...h]); setMessage('Session closed. Capacity returned to your wallet.');
      setBalance(await signer.getBalance());
    } catch (e) { const log = readActivity(r.key).find(row => row.id === operationId); logFailure(r.key, operationId, e, log?.hash ? 'retry' : 'failed'); setMessage(errorText(e)); await refresh(r); } finally { setBusy(''); }
  };
  const retry = async () => {
    if (!address || !lockHeld.current) return;
    setBusy('Restoring session');
    try { const saved = readSession(sessionKey(address)); if (saved?.cell) await attach(sessionKey(address), saved, epoch.current); } catch(e) { setMessage(errorText(e)); } finally { setBusy(''); }
  };
  const hasSubmitted = address && readSession(sessionKey(address))?.cell;
  return <div className="shell">
    <header><a className="brand" href="/" aria-label="Pilot home"><img src="/owl.png" alt=""/><span>pilot<span className="by">by owl</span></span></a><div className="header-actions"><span className="network"><i/> CKB Testnet</span>{address ? <button className="wallet" onClick={() => setPilotOpen(true)} title="Open Pilot" aria-label="Open Pilot" disabled={!!busy}>{profile?`Pilot · @${profile.username}`:short(address)} <span>↗</span></button> : <button className="wallet" onClick={() => setPilotOpen(true)}>Connect wallet <span>↗</span></button>}</div></header>
    <main><div className="intro"><div className="eyebrow">THE PILOT PLAYGROUND <span>01 / FLIGHT DEMO</span></div><h1>One approval.<br/><em>Room to play.</em></h1><p>A little flight, powered by Pilot. Connect your wallet,<br className="desktop"/> approve a session, and take off without signing every move.</p></div>
      {sponsorshipRequested&&!sponsorshipReady&&<p role="alert">Sponsorship is configured, but its contract deployment is missing. Flight actions are blocked until the sponsored deployment is configured. No user-paid fallback.</p>}<div className="workspace"><section className="flight"><div className="panel-top"><span>OWL’S FIRST FLIGHT</span><span className="tag">LIVE TESTNET DEMO</span></div><div className="sky"><div className="sun"/><div className="orbit orbit-one"/><div className="orbit orbit-two"/><div className="cloud cloud-one"/><div className="cloud cloud-two"/><span className="coordinate">CKB / AIRSPACE 001</span><div className="flight-owl" style={{left:`${12 + (position % 10) * 7.6}%`, top:`${49 - (position % 4) * 5}%`}}><img src="/owl.png" alt="Your owl"/><span className="owl-shadow"/></div><div className="route">{Array.from({length:10},(_,i)=><span key={i} className={i <= position%10 ? 'visited':''}>{i===position%10 ? '✦' : '·'}</span>)}</div><div className="altitude"><span>FLIGHT DISTANCE</span><strong data-testid="position">{String(position).padStart(2,'0')}<small> moves</small></strong></div><div className="hills hill-one"/><div className="hills hill-two"/></div><div className="flight-bottom"><div><span className={`status-dot ${ready?'green':''}`}/><span>{runtime ? ready ? 'Ready for your next move' : remaining < fee ? 'Flight budget used. Start a new session.' : 'Checking session' : 'Your owl is waiting for takeoff'}</span></div><button className="primary move" disabled={!ready || !!busy} onClick={() => void move()}>Fly forward <span>→</span></button></div></section>
      <aside className="session"><div className="panel-top"><span>YOUR PILOT SESSION</span><span className={`session-indicator ${runtime?'enabled':''}`}>{runtime?'ACTIVE':'OFFLINE'}</span></div><div className="session-icon">✦</div><h2>{runtime ? 'You’re in control.' : 'Give your owl wings.'}</h2><p>{runtime ? 'Every move appears instantly. Pilot signs and records it on CKB in the background.' : 'Your wallet approves a small, limited session. Pilot handles the moves from there.'}</p><div className="policy"><div><span>Allowed action</span><strong>Fly forward, one step</strong></div><div><span>Flight allowance</span><strong>{runtime ? Number(remaining / fee) : Number(sessionBudget/fee)} moves</strong></div><div><span>{sponsorshipReady?'Your network fee':'Fee per move'}</span><strong>{sponsorshipReady?'0 CKB · pool pays':'0.001 CKB'}</strong></div><div><span>{sponsorshipReady?'Remaining sponsored allowance':'Remaining fee budget'}</span><strong>{amount(runtime?remaining:sessionBudget)} CKB</strong></div></div><div className="budget-track"><div style={{width:`${Number(runtime?remaining:sessionBudget)*100/Number(sessionBudget)}%`}}/></div>
        {!address ? <button className="primary full" onClick={() => setPilotOpen(true)}>Connect wallet <span>↗</span></button> : !runtime ? hasSubmitted ? <button className="primary full" disabled={!!busy} onClick={() => void retry()}>Resume session <span>→</span></button> : <button className="primary full" disabled={!!busy || !lockHeld.current} onClick={() => setPilotOpen(true)}>Enable Pilot <span>↗</span></button> : <button className="secondary full" disabled={!!busy || runtime.pilot.queueLength > 0} onClick={() => void revoke()}>End session & reclaim CKB <span>↗</span></button>}
        <div className="session-note">{busy || (address ? `${walletName ?? 'Wallet'} connected${balance !== undefined ? ` · ${amount(balance)} CKB` : ''}` : 'Use your existing wallet. No new account.')}{address && <button className="copy-address" title={address} onClick={() => void navigator.clipboard.writeText(address).then(() => setMessage('CKB testnet address copied.')).catch(e => setMessage(errorText(e)))}>Copy CKB address</button>}</div>
      </aside></div>
      {message && <div className="notice" role="status">{message}</div>}
      <div className="under"><div className="flow"><span><b>01</b> Connect</span><i>→</i><span><b>02</b> Approve once</span><i>→</i><span><b>03</b> Keep flying</span></div><span className="settlement"><i/> {settled} moves recorded on CKB</span></div>
      {transactions.length>0 && <section className="receipts"><span>ON-CHAIN RECEIPTS</span>{transactions.map(hash=><a key={hash} href={`https://testnet.explorer.nervos.org/transaction/${hash}`} target="_blank" rel="noreferrer">{short(hash)} ↗</a>)}</section>}
      <TransactionInspector storageKey={address ? sessionKey(address) : undefined} runtime={runtime} client={client} onRetry={() => { const r = active.current; if (r) flush(r); }}/>
      <OffchainSocial signer={signer} address={address} onConnectOwner={()=>open()}/>
      <UsernameTransfers signer={signer} onSent={()=>{if(signer)void signer.getBalance().then(setBalance).catch(()=>{});}}/>
      <CellDelegation profileLookupError={profileLookupError} onRetryProfile={()=>void retryProfile()} profileLoading={profileLoading} signer={signer} address={address} balance={balance} profile={profile} onConnectOwner={()=>open()} onDisconnectOwner={()=>disconnect()} onRefreshBalance={()=>{if(signer)void signer.getBalance().then(setBalance).catch(e=>setMessage(errorText(e)));}}
        onProfile={async username=>{if(!signer)throw new Error('Connect your owner wallet first');const version=epoch.current;const value=await saveProfile(signer,username);if(epoch.current!==version)throw new Error('Wallet changed during registration');setProfile(value);return value;}}/>
    </main><footer><span>Built with Owl’s Pilot SDK</span><span>Session keys stay in this browser · Test CKB only</span></footer>
    <PilotModal onBudgetChange={setSelectedBudget} budgetLimit={flightManifest.policy.budget} profileLookupError={profileLookupError} onRetryProfile={()=>void retryProfile()} profileLoading={profileLoading} manifest={sessionManifest} visible={pilotOpen&&!isOpen} address={address} walletName={walletName} balance={balance} profile={profile} active={!!runtime} busy={busy} canAuthorize={lockHeld.current} queueLength={runtime?.pilot.queueLength??0} submitted={!!hasSubmitted&&!runtime} onResume={retry} error={message}
      onClose={()=>setPilotOpen(false)} onConnectOwner={()=>open()} onProfile={async username=>{if(!signer)throw new Error('Connect your owner wallet first');const version=epoch.current;setBusy('Register your username in your wallet');try{const value=await saveProfile(signer,username);if(epoch.current!==version)throw new Error('Wallet changed during registration');setProfile(value);if(active.current)void refresh(active.current);return value;}finally{if(epoch.current===version)setBusy('');}}} onAuthorize={start}
      onDisconnect={()=>{setPilotOpen(false);disconnect();}} onRevoke={revoke} onRefreshBalance={()=>{if(signer)void signer.getBalance().then(setBalance).catch(e=>setMessage(errorText(e)));}}/>
  </div>;
}
function AccountBridge({ children }: { children: React.ReactNode }) {
  const connection = ccc.useCcc();
  return <PilotAccountsProvider network="ckb-testnet" signer={connection.signerInfo?.signer} walletName={connection.wallet?.name} connectorOpen={connection.isOpen}
    onConnectWallet={() => { const show = () => {
        connection.open();
        // CCC measures its panel while opening. Re-measure after React makes the host visible.
        window.requestAnimationFrame(() => connection.open());
      };
      if (connection.signerInfo) { connection.disconnect(); window.setTimeout(show, 200); } else show(); }} onDisconnectWallet={connection.disconnect}
    connectJoyId={async () => {
      // A new signer always calls /auth. A separate in-memory repo avoids replacing CCC’s cached account.
      const signer = new ccc.JoyId.CkbSigner(client, 'Owl’s Pilot', new URL('/owl.png', location.origin).href,
        undefined, undefined, { get: async () => undefined, set: async () => {} });
      await signer.connect(); return signer;
    }}>{children}</PilotAccountsProvider>;
}
createRoot(document.getElementById('root')!).render(<ccc.Provider name="Owl’s Pilot" icon="/owl.png" defaultClient={client} clientOptions={[{name:'CKB Testnet',client}]} connectorProps={{style:{'--background':'#14271f','--divider':'#304538','--btn-primary':'#21372b','--btn-primary-hover':'#2d4937','--btn-color':'#ecf3e8','--tip-color':'#99ac9b',color:'#ecf3e8'} as React.CSSProperties}}><AccountBridge><App/></AccountBridge></ccc.Provider>);
