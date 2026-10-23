import { useEffect, useRef, useState } from 'react';
import { ccc } from '@ckb-ccc/core';
import { usePilotAccountGuard } from '@owl/pilot-react';
import { PilotAccountSigner, PILOT_ACCOUNT_CODE_HASH, recordPilotActivity, verifyPilotAccountMessage, recoverPilotAccount,
  pilotAccountLock, type PilotAccountDescriptor, type PilotAccountRecoveryReceipt, type PilotAccountJournal, type PilotAccountTransaction, type Deployment } from '@owl/pilot';
import configuration from '../../../deployments/pilot-sponsored.json';
import { getPaymaster } from './runtime';

type Metadata = { permissions: string[]; descriptor: PilotAccountDescriptor };
const deployment = configuration.account as Deployment | null;
const amount = (value: bigint) => ccc.fixedPointToString(value);
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
export function PersistentAccount({ owner, ownerAddress }: { owner?: ccc.Signer; ownerAddress: string }) {
  const [account, setAccount] = useState<PilotAccountSigner>(); const [pilotAddress, setPilotAddress] = useState('');
  const [balance, setBalance] = useState(0n); const [funding, setFunding] = useState('200'); const [selected, setSelected] = useState<string[]>([]);
  const [recoveryDescriptor,setRecoveryDescriptor] = useState<PilotAccountDescriptor>();
  const [review, setReview] = useState(false); const [busy, setBusy] = useState(''); const [error, setError] = useState('');
  const [journal, setJournal] = useState<PilotAccountJournal>(); const [lastMessage, setLastMessage] = useState('');
  const epoch = useRef(0); const live = useRef<PilotAccountSigner | undefined>(undefined);
  const key = `pilot:persistent-account-demo:v1:${deployment?.genesisHash ?? ''}:${ownerAddress}`;
  const ready = !!deployment && deployment.codeHash === PILOT_ACCOUNT_CODE_HASH && !!import.meta.env.VITE_PILOT_PAYMASTER_URL;
  const pending = journal?.transactions.filter(t => t.status !== 'confirmed' && t.status !== 'requote').length ?? 0;
  const funded = journal?.transactions.some(t => t.kind === 'funding' && t.status === 'confirmed') && !journal.stopped;
  usePilotAccountGuard(!!busy || pending > 0);
  const storage = { async load(): Promise<PilotAccountJournal | undefined> { const raw = localStorage.getItem(key + ':journal'); return raw ? JSON.parse(raw) : undefined; },
    async save(next: PilotAccountJournal) { localStorage.setItem(key + ':journal', JSON.stringify(next)); if (live.current?.lock.hash() === next.accountHash) setJournal(next); } };
  async function attach(permissions: string[]) {
    if (!owner || !deployment || !navigator.locks) throw new Error('Connect an owner wallet in a browser with Web Locks');
    const paymaster = getPaymaster(owner.client); if (!paymaster) throw new Error('Per-transaction sponsorship is required');
    const ownerLock = (await owner.getRecommendedAddressObj()).script;
    return PilotAccountSigner.create({ owner, deployment, poolLock: configuration.poolLock as ccc.ScriptLike, maxFee: 100_000n, paymaster,
      journal: storage, keys: { async load(scope) { return localStorage.getItem(scope + ':key') as ccc.Hex | undefined ?? undefined; }, async save(scope, secret) { localStorage.setItem(scope + ':key', secret); } },
      exclusive: async <T,>(operation: () => Promise<T>): Promise<T> => await navigator.locks.request(key, () => operation()), permissions,
      actions: [
        { id: 'account.return-payment', name: 'Send 61 CKB to my owner wallet', async validateTransaction(tx, descriptor) {
          const accountLock = pilotAccountLock(descriptor);
          for (const input of tx.inputs) { const cell = await owner.client.getCell(input.previousOutput); if (!cell?.cellOutput.lock.eq(accountLock)) throw new Error('Payment selected another account'); }
          if (tx.outputs.length !== 2 || tx.outputsData.some(data => data !== '0x') || tx.outputs.some(o => o.type)
            || !tx.outputs[0]!.lock.eq(ownerLock) || tx.outputs[0]!.capacity !== ccc.fixedPointFrom(61)
            || !tx.outputs[1]!.lock.eq(accountLock) || tx.outputs[1]!.capacity < ccc.fixedPointFrom(tx.outputs[1]!.occupiedSize)
            || descriptor.ownerLock.args !== ownerLock.args) throw new Error('Payment differs from approved action');
        } },
        { id: 'account.message', name: 'Sign a demo greeting', validateMessage(value, descriptor) {
          if (typeof value !== 'string' || !value.startsWith(`Pilot demo greeting\nAccount: ${descriptor.publicKey}\nNonce: `)
            || !/^[0-9a-f-]{36}$/.test(value.split('Nonce: ')[1] ?? '')) throw new Error('Message is outside the greeting permission');
        } },
      ], onTransaction(record) {
        recordPilotActivity(localStorage, { id: record.id, ownerAddress, appId: 'owl.persistent-account-demo', sessionId: key,
          actionId: record.action, name: record.kind === 'action' ? 'Pilot account payment' : record.kind === 'funding' ? 'Pilot account funding' : 'Pilot account recovery',
          kind: record.kind === 'action' ? 'onchain' : 'owner', status: record.status, transactionHash: record.hash, fee: record.quote?.fee,
          event: { phase: record.status, message: `Per-transaction sponsorship. User network fee: 0. Pool fee: ${record.quote?.fee ?? 'unknown'} shannons.` } });
      } });
  }
  async function refresh(value: PilotAccountSigner) {
    const [address, balance, next] = await Promise.all([value.getRecommendedAddress(), value.getBalance(), storage.load()]);
    if (live.current !== value) return; setPilotAddress(address); setBalance(balance); setJournal(next);
  }
  useEffect(() => {
    const version = ++epoch.current; live.current = undefined; setAccount(undefined); setPilotAddress(''); setBalance(0n); setJournal(undefined); setBusy(''); setError(''); setReview(false); setRecoveryDescriptor(undefined); setSelected([]); setLastMessage('');
    if (!owner || !ownerAddress || !ready) return;
    const raw = localStorage.getItem(key + ':metadata'); if (!raw) return;
    void (async () => {
      const saved: Metadata = JSON.parse(raw); const value = await attach(saved.permissions);
      if (JSON.stringify(value.descriptor) !== JSON.stringify(saved.descriptor)) throw new Error('Saved account descriptor differs from current account');
      if (version !== epoch.current) return; live.current = value; setAccount(value); setSelected(saved.permissions); await refresh(value);
    })().catch(e => { if (version === epoch.current) setError(message(e)); });
    return () => { epoch.current++; live.current = undefined; };
  }, [owner, ownerAddress, ready]);
  async function run(label: string, operation: () => Promise<void>) {
    const version = epoch.current; setBusy(label); setError('');
    try { await operation(); } catch (e) { if (version === epoch.current) setError(message(e)); }
    finally { const current = live.current; if (current && version === epoch.current) { try { await refresh(current); } catch (e) { setError(message(e)); } } if (version === epoch.current) setBusy(''); }
  }
  async function prepare() {
    if (!selected.length) throw new Error('Choose at least one permission');
    const value = funded && account ? account : await attach(selected); live.current = value; setAccount(value);
    // Public recovery descriptor is persisted before asking the wallet to fund the address.
    localStorage.setItem(key + ':metadata', JSON.stringify({ permissions: selected, descriptor: value.descriptor } satisfies Metadata));
    await refresh(value); setReview(true);
  }
  function fundingCapacity(): bigint {
    if (!/^\d+(\.\d{1,8})?$/.test(funding)) throw new Error('Enter a positive CKB budget with up to 8 decimals');
    const budget = ccc.fixedPointFrom(funding); if (budget <= 0n) throw new Error('Budget must be positive');
    if (!account) throw new Error('Prepare the account first');
    return budget + ccc.fixedPointFrom(ccc.CellOutput.from({ lock: account.lock }).occupiedSize);
  }
  async function pay() {
    if (!account) return;
    const tx = ccc.Transaction.from({ outputs: [{ lock: account.descriptor.ownerLock, capacity: ccc.fixedPointFrom(61) }], outputsData: ['0x'] });
    await tx.completeInputsByCapacity(account); await tx.completeFeeBy(account, 0n);
    await account.forAction('account.return-payment').sendTransaction(tx);
  }
  function downloadDescriptor() {
    if (!account) return; const url = URL.createObjectURL(new Blob([JSON.stringify(account.descriptor, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'pilot-account-recovery.json'; link.click(); URL.revokeObjectURL(url);
  }
  let total = ''; try { total = account ? amount(fundingCapacity()) : ''; } catch { /* form validation below */ }
  return <section className="username-transfers persistent-account" aria-label="Persistent Pilot account">
    <div className="panel-top"><span>PERSISTENT PILOT ACCOUNT</span><span className="tag">OWNER RECOVERABLE · TESTNET</span></div>
    <h2>Your Pilot, your app account.</h2>
    <p>Fund a separate account once. Pilot signs its approved payments and messages; the pool pays eligible network fees per transaction. Your connected wallet remains the recovery owner.</p>
    <p>This testnet prototype stores its account key in this browser. Keep a recovery descriptor; clearing browser storage loses automatic access. It does not synchronize the key or address across browsers.</p>
    {!ready && <p role="status">Account setup is unavailable until the new account lock is deployed and per-transaction sponsorship is configured. Existing flight sessions use their existing contracts.</p>}
    {!owner && <p>Connect your wallet above to set up an account.</p>}
    {owner && ready && <>
      <p>Owner: <code>{ownerAddress}</code></p>
      {pilotAddress && <><p>Pilot address: <code>{pilotAddress}</code></p><p>Account balance: {amount(balance)} CKB · User network fee: 0 CKB</p><button className="secondary" disabled={!!busy} onClick={downloadDescriptor}>Save public recovery descriptor</button></>}
      {!funded && <fieldset disabled={!!busy || pending>0}><legend>Actions Pilot may perform</legend>{[['account.return-payment','Send 61 CKB to my owner wallet'],['account.message','Sign a demo greeting']].map(([id,label]) => <label key={id}><input type="checkbox" checked={selected.includes(id!)} onChange={e => setSelected(p => e.target.checked ? [...p,id!] : p.filter(v => v !== id))}/>{label}</label>)}</fieldset>}
      <label>Spending budget (CKB)<input aria-label="Account spending budget (CKB)" inputMode="decimal" value={funding} onChange={e=>setFunding(e.target.value)} disabled={!!busy}/></label>
      <button className="primary" disabled={!!busy || (!account && !selected.length)} onClick={()=>void run('Preparing account review',prepare)}>{funded ? 'Review additional funding' : account ? 'Review account funding' : 'Review Pilot account setup'}</button>
      {account && <div className="account-actions">
        <button className="secondary" disabled={!!busy || !funded || !selected.includes('account.return-payment')} onClick={()=>void run('Submitting sponsored payment',pay)}>Send 61 CKB automatically</button>
        <button className="secondary" disabled={!!busy || !funded || !selected.includes('account.message')} onClick={()=>void run('Signing greeting',async()=>{
          const value = `Pilot demo greeting\nAccount: ${account.descriptor.publicKey}\nNonce: ${crypto.randomUUID()}`;
          const signature = await account.forAction('account.message').signMessage(value);
          if (!await verifyPilotAccountMessage(account.descriptor,value,signature)) throw new Error('Account signature verification failed');
          setLastMessage('Greeting signed and verified as the Pilot account; no owner wallet prompt.');
          recordPilotActivity(localStorage,{id:crypto.randomUUID(),ownerAddress,appId:'owl.persistent-account-demo',sessionId:key,actionId:'account.message',name:'Pilot account greeting',kind:'offchain',status:'signed',event:{phase:'signed',message:'Scoped greeting signed and verified against the Pilot account public key.'}});
        })}>Sign greeting automatically</button>
        <button className="secondary" disabled={!!busy} onClick={()=>void run('Reconciling account receipts',()=>account.resume())}>Reconcile pending transactions</button>
        <button className="secondary" disabled={!!busy} onClick={()=>void run('Stopping automatic signing',()=>account.stop())}>Stop automatic signing</button>
        <button className="secondary" disabled={!!busy || balance===0n} onClick={()=>{if(window.confirm('Stop automatic signing, settle pending transactions, then ask your owner wallet to recover all ordinary CKB cells? App assets require separate builders.'))void run('Recovering account funds',()=>account.recover().then(()=>{}));}}>Recover ordinary CKB with owner wallet</button>
      </div>}
      {busy && <p role="status">{busy}</p>}{lastMessage && <p role="status">{lastMessage}</p>}
      <details open={pending>0}><summary>Account queue and detailed logs ({pending} unresolved)</summary>
        <p>Each row belongs to this owner and Pilot address. Signed or submitted receipts retain their inputs until reconciled; confirmation is separate from submission.</p>
        {journal?.transactions.map((record:PilotAccountTransaction)=><details key={record.id}><summary>{record.kind} · {record.action} · {record.status}</summary><a href={`https://testnet.explorer.nervos.org/transaction/${record.hash}`} target="_blank" rel="noreferrer">View transaction ↗</a><p>User network fee: 0 CKB · Pool fee: {record.quote?.fee ?? 'unknown'} shannons</p><pre>{JSON.stringify(record,null,2)}</pre><details><summary>Decoded transaction and witnesses</summary><pre>{JSON.stringify(ccc.Transaction.fromBytes(record.bytes),(_key,value)=>typeof value==='bigint'?value.toString():value,2)}</pre></details></details>)}
        {journal?.messages?.map(record=><pre key={record.id}>{JSON.stringify(record,null,2)}</pre>)}
      </details>
    </>}
    {owner && <details><summary>Recover with a saved public descriptor</summary>
      <p>If this browser no longer has the Pilot key, import the public descriptor and use your original owner wallet. This recovers ordinary CKB, not app-specific assets. If another device is still signing, stop it first; recovery can conflict with its pending transactions.</p>
      <label>Public recovery descriptor<input type="file" accept="application/json" aria-label="Public account recovery descriptor" disabled={!!busy} onChange={event=>void run('Checking recovery descriptor',async()=>{
        const file=event.target.files?.[0];if(!file)return;if(file.size>16000)throw new Error('Recovery descriptor is too large');
        const descriptor:PilotAccountDescriptor=JSON.parse(await file.text());pilotAccountLock(descriptor);
        if(!(await owner.getRecommendedAddressObj()).script.eq(descriptor.ownerLock))throw new Error('Recovery descriptor belongs to another owner');setRecoveryDescriptor(descriptor);
      })}/></label>
      {recoveryDescriptor && <><p>Recover from <code>{ccc.Address.from({prefix:owner.client.addressPrefix,script:pilotAccountLock(recoveryDescriptor)}).toString()}</code> to your connected owner wallet. User network fee: 0; sponsorship is required.</p>
        <button className="secondary" disabled={!!busy} onClick={()=>void run('Recovering with your owner wallet',async()=>{
          const paymaster=getPaymaster(owner.client);if(!paymaster)throw new Error('Configure sponsorship before recovering through this demo');
          await navigator.locks.request(key,async()=>{
            if(live.current?.lock.eq(pilotAccountLock(recoveryDescriptor)))throw new Error('Use the account recovery button above so pending work settles first');
            const receiptKey='pilot:independent-account-recovery:'+pilotAccountLock(recoveryDescriptor).hash();
            await recoverPilotAccount({owner,account:recoveryDescriptor,paymaster,receipt:{async load(){const raw=localStorage.getItem(receiptKey);return raw?JSON.parse(raw) as PilotAccountRecoveryReceipt:undefined;},async save(receipt){localStorage.setItem(receiptKey,JSON.stringify(receipt));}}});
          });setLastMessage('Independent owner recovery confirmed. Keep the old Pilot address out of future deposits.');
        })}>Recover using public descriptor</button></>}
    </details>}
    {error && <p role="alert">{error}</p>}
    {review && account && <div className="account-dialog-backdrop"><section role="dialog" aria-modal="true" aria-label="Review Pilot account funding" className="account-dialog">
      <h3>Review Pilot account funding</h3><p>Destination is your separate Pilot account, recoverable by the connected owner.</p><code>{pilotAddress}</code>
      <p>Spending budget: {funding} CKB. Additional cell capacity: {amount(ccc.fixedPointFrom(ccc.CellOutput.from({lock:account.lock}).occupiedSize))} CKB. Total transfer: {total || 'Invalid budget'} CKB.</p>
      <p>Network fee: 0 CKB from you; the paymaster pays this transaction. Approved actions: {selected.join(', ')}. These action permissions are checked by the SDK; the account key has broad on-chain spending authority.</p>
      <button className="primary" disabled={!!busy || !total} onClick={()=>void run('Approve funding in your owner wallet',async()=>{await account.fund(fundingCapacity());setReview(false);})}>Approve funding with owner wallet</button>
      <button className="secondary" disabled={!!busy} onClick={()=>setReview(false)}>Cancel funding</button>
    </section></div>}
  </section>;
}
