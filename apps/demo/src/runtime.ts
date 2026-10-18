import { ccc } from '@ckb-ccc/core';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { revokeCounter, type SponsorQuote, type CounterTransactionEvent, SponsorQuoteRejectedError, PilotPaymasterClient, Pilot, LocalStorageStore, CkbCounterAdapter, PilotCounterConnector, createCounterGrant, assertCounterPermission, decodeCounterData, type PilotGrant, type Session, type SessionCell, type SettlementJournal, type CounterState, type CounterAction, type PilotEvent, type Deployment } from '@owl/pilot';
import { updateActivity, transactionObserver, logFailure, recordQueue, recordPilotEvent, recoverActivity } from './activity';
import { flightManifest, sponsorshipRequested, sponsorshipReady } from './manifest';
import { readProfile } from './profile';
import sponsoredConfiguration from '../../../deployments/pilot-sponsored.json';
export const deployment = flightManifest.policy.deployment;
export function getPaymaster(client: ccc.Client): PilotPaymasterClient | undefined {
  if (!sponsorshipRequested) return undefined;
  if (!sponsoredConfiguration.poolLock) throw new Error('Sponsorship requested, but sponsored deployment/pool lock is missing. Deploy sponsored code and configure deployments/pilot-sponsored.json. No user-paid fallback.');
  return new PilotPaymasterClient({ client, url: import.meta.env.VITE_PILOT_PAYMASTER_URL, poolLock: sponsoredConfiguration.poolLock as ccc.ScriptLike, maxFee: 100_000n });
}
export const fee = 100_000n;
export const budget = fee * 20n;
export const amount = (n: bigint) => (Number(n) / 100_000_000).toLocaleString('en', { maximumFractionDigits: 5 });
export interface SavedSession { session: Session; privateKey: ccc.Hex; ownerTransaction?: ccc.Hex; cell?: SessionCell; grant?: PilotGrant }
export interface Runtime { pilot: Pilot<CounterState, CounterAction>; adapter: CkbCounterAdapter; saved: SavedSession; key: string; receipts: string[] }
export const sessionKey = (address: string) => `pilot-demo:v1:${deployment.codeHash}:${address}`;
export function readSession(key: string): SavedSession | undefined { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : undefined; }
export async function authorize(signer: ccc.Signer, key: string, selected: readonly string[]): Promise<SavedSession> {
  if (sponsorshipRequested && !sponsorshipReady) throw new Error('Sponsored counter deployment missing; no user-paid fallback');
  const paymaster = getPaymaster(signer.client);
  const grant=createCounterGrant(flightManifest,selected);
  if(readSession(key)?.cell)throw new Error('A funded session already exists. Resume it or reclaim its capacity before authorizing another.');
  const address=await signer.getRecommendedAddress();
  if(key!==sessionKey(address)||!readProfile(address))throw new Error('Connect your owner wallet and create a Pilot profile first.');
  const privateKey = ccc.hexFrom(secp256k1.utils.randomSecretKey());
  const saved: SavedSession = { privateKey, grant, session: { id: crypto.randomUUID(), network: 'ckb-testnet', policyVersion: flightManifest.policy.kind, expiresAt: Date.now() + 24 * 60 * 60 * 1000 } };
  localStorage.setItem(key, JSON.stringify(saved));
  const id = `${saved.session.id}:authorization`;
  updateActivity(key, id, { sessionId: saved.session.id, kind: 'authorization', title: 'Session approval', status: 'signing' }, { phase: 'created', message: paymaster ? 'Opening a sponsored session: 200 CKB recoverable capacity; pool pays network fees; 0.02 CKB virtual allowance is not locked from user funds.' : 'Opening a session with 150 CKB recoverable capacity and a 0.02 CKB move budget.' });
  try { const result = await new PilotCounterConnector(signer, flightManifest).authorize(selected, { paymaster, sessionPublicKey: secp256k1.getPublicKey(ccc.bytesFrom(privateKey), true), onTransaction: transactionObserver(key, id, { sessionId: saved.session.id, kind: 'authorization', title: 'Session approval' }), onSigned: async (cell, bytes) => { saved.cell = cell; saved.ownerTransaction = bytes; localStorage.setItem(key, JSON.stringify(saved)); }, onSubmitted: async cell => { saved.cell = cell; localStorage.setItem(key, JSON.stringify(saved)); } }); saved.cell=result.cell; } catch (error) { if (error instanceof SponsorQuoteRejectedError && saved.cell?.authorizationQuote?.id === error.quoteId) { delete saved.cell; delete saved.ownerTransaction; localStorage.setItem(key, JSON.stringify(saved)); } logFailure(key, id, error, saved.cell ? 'retry' : 'failed'); throw error; }
  localStorage.setItem(key, JSON.stringify(saved));
  return saved;
}
export async function restore(client: ccc.Client, key: string, saved: SavedSession, onEvent: (event: PilotEvent) => void): Promise<Runtime> {
  if (sponsorshipRequested && !sponsorshipReady) throw new Error('Sponsored counter deployment missing; no user-paid fallback');
  const paymaster = getPaymaster(client);
  if (!saved.cell) throw new Error('Approval was not submitted. You can start a new session.');
  if (saved.ownerTransaction) {
    let tx = ccc.Transaction.fromBytes(saved.ownerTransaction);
    if (tx.hash() !== ccc.OutPoint.from(saved.cell.outPoint).txHash || !tx.outputs[0]?.lock.eq(saved.cell.lock)) throw new Error('Saved approval differs from its session cell');
    const owner = (await ccc.Address.fromString(key.slice(key.lastIndexOf(':') + 1), client)).script;
    if (ccc.hexFrom(ccc.bytesFrom(tx.outputs[0].lock.args).slice(0, 32)) !== owner.hash()) throw new Error('Saved approval belongs to another wallet');
    const known = await client.getTransactionNoCache(tx.hash());
    if (!known || known.status === 'unknown' || known.status === 'rejected') {
      if (saved.cell.authorizationQuote) { if (!paymaster) throw new Error('Restore the paymaster before retrying'); try { tx = await paymaster.submit(saved.cell.authorizationQuote, tx); } catch (error) { if (error instanceof SponsorQuoteRejectedError && error.quoteId === saved.cell.authorizationQuote.id) localStorage.removeItem(key); throw error; } saved.ownerTransaction = ccc.hexFrom(tx.toBytes()); localStorage.setItem(key, JSON.stringify(saved)); }
      try { await client.sendTransaction(tx); } catch (error) { if (!(error instanceof ccc.ErrorClientDuplicatedTransaction)) throw error; }
    }
  }
  const receipt = await client.waitTransaction(ccc.OutPoint.from(saved.cell.outPoint).txHash, 1, 180_000);
  if (receipt?.status !== 'committed') throw new Error('Approval is still being confirmed. Retry shortly.');
  const lock=ccc.Script.from(saved.cell.lock), args=ccc.bytesFrom(lock.args);
  const view=new DataView(args.buffer,args.byteOffset,args.byteLength);
  const ownerLock=(await ccc.Address.fromString(key.slice(key.lastIndexOf(':')+1),client)).script;
  if(ccc.hexFrom(args.slice(0,32))!==ownerLock.hash())throw new Error('Stored session belongs to another owner wallet.');
  const initial=decodeCounterData(receipt.transaction.outputsData[0]);
  if(lock.codeHash!==deployment.codeHash||lock.hashType!=='data2'||args.length!==(paymaster ? 113 : 81)||saved.cell.feePerMove!==fee.toString()
    ||view.getBigUint64(65,true)!==fee||view.getBigUint64(73,true)!==BigInt(flightManifest.policy.floorCapacity)
    ||!receipt.transaction.outputs[0]?.lock.eq(lock)||initial.budget!==budget||initial.position!==0n)throw new Error('Stored session does not match this app’s on-chain manifest limits.');
  if(!saved.grant){saved.grant=createCounterGrant(flightManifest,['counter.increment']);localStorage.setItem(key,JSON.stringify(saved));}
  assertCounterPermission(flightManifest,saved.grant,'counter.increment');
  const prefix = `${key}:${saved.session.id}`;
  updateActivity(key, `${saved.session.id}:authorization`, { sessionId: saved.session.id, kind: 'authorization', title: 'Session approval', hash: ccc.OutPoint.from(saved.cell.outPoint).txHash, status: 'confirmed', bytes: ccc.hexFrom(receipt.transaction.toBytes()) });
  const chain = JSON.parse(localStorage.getItem(`${prefix}:chain`) ?? 'null') as SettlementJournal | undefined;
  recoverActivity(key, saved.session.id, chain);
  const pilotStore = new LocalStorageStore<CounterState, CounterAction>(localStorage, `${prefix}:pilot`);
  const adapter = await CkbCounterAdapter.create({ client, paymaster, deployment, sessionCell: saved.cell, session: saved.session, sessionPrivateKey: saved.privateKey,
    onTransaction: transactionObserver(key, '', { sessionId: saved.session.id, kind: 'move' }),
    store: { async load() { const raw = localStorage.getItem(`${prefix}:chain`); return raw ? JSON.parse(raw) as SettlementJournal : undefined; }, async save(journal) { localStorage.setItem(`${prefix}:chain`, JSON.stringify(journal)); } } });
  const pilot = await Pilot.create({ session: saved.session, state: { position: 0 }, budget, adapter, store: { async load() { const journal = await pilotStore.load(); if (journal) recordQueue(key, journal, true); return journal; }, async save(journal) { await pilotStore.save(journal); recordQueue(key, journal); } }, autoSettle: false, onEvent: event => { recordPilotEvent(key, event); onEvent(event); } });
  const journal = JSON.parse(localStorage.getItem(`${prefix}:chain`) ?? '{}') as Partial<SettlementJournal>;
  const receipts = Object.values(journal.transactions ?? {}).filter(record => record.confirmed).map(record => record.hash).reverse();
  return { pilot, adapter, saved, key, receipts };
}

export const revocationKey = (runtime: Runtime) => `${runtime.key}:${runtime.saved.session.id}:revocation`;
/** Persist owner and pool signatures before submission; reload resumes the original recovery. */
export async function revokeSavedSession(signer: ccc.Signer, runtime: Runtime, onTransaction: (event: CounterTransactionEvent) => void): Promise<ccc.Hex> {
  const storageKey = revocationKey(runtime);
  const raw = localStorage.getItem(storageKey);
  const saved = raw ? JSON.parse(raw) as { bytes: ccc.Hex; quote?: SponsorQuote } : undefined;
  const paymaster = getPaymaster(signer.client);
  try {
    let hash: ccc.Hex;
    if (!saved) {
      hash = await revokeCounter(signer, deployment, runtime.saved.cell!, runtime.adapter.currentOutPoint, { paymaster, onTransaction,
        onSigned: async (bytes, quote) => { localStorage.setItem(storageKey, JSON.stringify({ bytes, quote })); },
      });
    } else {
      let tx = ccc.Transaction.fromBytes(saved.bytes);
      const owner = (await signer.getRecommendedAddressObj()).script;
      if (!tx.inputs[0]?.previousOutput.eq(runtime.adapter.currentOutPoint) || !tx.outputs[0]?.lock.eq(owner)
        || ccc.hexFrom(ccc.bytesFrom(ccc.Script.from(runtime.saved.cell!.lock).args).slice(0, 32)) !== owner.hash()) throw new Error('Saved recovery belongs to another owner or session');
      hash = tx.hash(); onTransaction({ phase: 'checking', transactionHash: hash });
      const known = await signer.client.getTransactionNoCache(hash);
      if (!known || known.status === 'unknown' || known.status === 'rejected') {
        if (saved.quote) {
          if (!paymaster) throw new Error('Restore paymaster before retrying recovery');
          tx = await paymaster.submit(saved.quote, tx); localStorage.setItem(storageKey, JSON.stringify({ ...saved, bytes: ccc.hexFrom(tx.toBytes()) }));
        } else await signer.client.sendTransaction(tx);
      }
      onTransaction({ phase: 'confirming', transactionHash: hash });
      if ((await signer.client.waitTransaction(hash, 1, 180_000))?.status !== 'committed') throw new Error('Recovery not confirmed; retry saved transaction');
      onTransaction({ phase: 'confirmed', transactionHash: hash, transactionBytes: ccc.hexFrom(tx.toBytes()) });
    }
    localStorage.removeItem(storageKey); return hash;
  } catch (error) {
    const value = localStorage.getItem(storageKey); const receipt = value ? JSON.parse(value) as { quote?: SponsorQuote } : undefined;
    if (error instanceof SponsorQuoteRejectedError && error.quoteId === receipt?.quote?.id) localStorage.removeItem(storageKey);
    throw error;
  }
}
