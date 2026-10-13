import { ccc } from '@ckb-ccc/core';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { Pilot, LocalStorageStore, CkbCounterAdapter, PilotCounterConnector, createCounterGrant, assertCounterPermission, decodeCounterData, type PilotGrant, type Session, type SessionCell, type SettlementJournal, type CounterState, type CounterAction, type PilotEvent, type Deployment } from '@owl/pilot';
import { updateActivity, transactionObserver, logFailure, recordQueue, recordPilotEvent, recoverActivity } from './activity';
import { flightManifest } from './manifest';
import { readProfile } from './profile';
import manifest from '../../../deployments/testnet.json';
export const deployment = manifest.deployment as Deployment;
export const fee = 100_000n;
export const budget = fee * 20n;
export const amount = (n: bigint) => (Number(n) / 100_000_000).toLocaleString('en', { maximumFractionDigits: 5 });
export interface SavedSession { session: Session; privateKey: ccc.Hex; cell?: SessionCell; grant?: PilotGrant }
export interface Runtime { pilot: Pilot<CounterState, CounterAction>; adapter: CkbCounterAdapter; saved: SavedSession; key: string; receipts: string[] }
export const sessionKey = (address: string) => `pilot-demo:v1:${deployment.codeHash}:${address}`;
export function readSession(key: string): SavedSession | undefined { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : undefined; }
export async function authorize(signer: ccc.Signer, key: string, selected: readonly string[]): Promise<SavedSession> {
  const grant=createCounterGrant(flightManifest,selected);
  if(readSession(key)?.cell)throw new Error('A funded session already exists. Resume it or reclaim its capacity before authorizing another.');
  const address=await signer.getRecommendedAddress();
  if(key!==sessionKey(address)||!readProfile(address))throw new Error('Connect your owner wallet and create a Pilot profile first.');
  const privateKey = ccc.hexFrom(secp256k1.utils.randomSecretKey());
  const saved: SavedSession = { privateKey, grant, session: { id: crypto.randomUUID(), network: 'ckb-testnet', policyVersion: 'counter-v1', expiresAt: Date.now() + 24 * 60 * 60 * 1000 } };
  localStorage.setItem(key, JSON.stringify(saved));
  const id = `${saved.session.id}:authorization`;
  updateActivity(key, id, { sessionId: saved.session.id, kind: 'authorization', title: 'Session approval', status: 'signing' }, { phase: 'created', message: 'Opening a session with 150 CKB recoverable capacity and a 0.02 CKB move budget.' });
  try { const result = await new PilotCounterConnector(signer, flightManifest).authorize(selected, { sessionPublicKey: secp256k1.getPublicKey(ccc.bytesFrom(privateKey), true), onTransaction: transactionObserver(key, id, { sessionId: saved.session.id, kind: 'authorization', title: 'Session approval' }), onSubmitted: async cell => { saved.cell = cell; localStorage.setItem(key, JSON.stringify(saved)); } }); saved.cell=result.cell; } catch (error) { logFailure(key, id, error, saved.cell ? 'retry' : 'failed'); throw error; }
  localStorage.setItem(key, JSON.stringify(saved));
  return saved;
}
export async function restore(client: ccc.Client, key: string, saved: SavedSession, onEvent: (event: PilotEvent) => void): Promise<Runtime> {
  if (!saved.cell) throw new Error('Approval was not submitted. You can start a new session.');
  const receipt = await client.waitTransaction(ccc.OutPoint.from(saved.cell.outPoint).txHash, 1, 180_000);
  if (receipt?.status !== 'committed') throw new Error('Approval is still being confirmed. Retry shortly.');
  const lock=ccc.Script.from(saved.cell.lock), args=ccc.bytesFrom(lock.args);
  const view=new DataView(args.buffer,args.byteOffset,args.byteLength);
  const ownerLock=(await ccc.Address.fromString(key.slice(key.lastIndexOf(':')+1),client)).script;
  if(ccc.hexFrom(args.slice(0,32))!==ownerLock.hash())throw new Error('Stored session belongs to another owner wallet.');
  const initial=decodeCounterData(receipt.transaction.outputsData[0]);
  if(lock.codeHash!==deployment.codeHash||lock.hashType!=='data2'||args.length!==81||saved.cell.feePerMove!==fee.toString()
    ||view.getBigUint64(65,true)!==fee||view.getBigUint64(73,true)!==BigInt(flightManifest.policy.floorCapacity)
    ||!receipt.transaction.outputs[0]?.lock.eq(lock)||initial.budget!==budget||initial.position!==0n)throw new Error('Stored session does not match this app’s on-chain manifest limits.');
  if(!saved.grant){saved.grant=createCounterGrant(flightManifest,['counter.increment']);localStorage.setItem(key,JSON.stringify(saved));}
  assertCounterPermission(flightManifest,saved.grant,'counter.increment');
  const prefix = `${key}:${saved.session.id}`;
  updateActivity(key, `${saved.session.id}:authorization`, { sessionId: saved.session.id, kind: 'authorization', title: 'Session approval', hash: ccc.OutPoint.from(saved.cell.outPoint).txHash, status: 'confirmed', bytes: ccc.hexFrom(receipt.transaction.toBytes()) });
  const chain = JSON.parse(localStorage.getItem(`${prefix}:chain`) ?? 'null') as SettlementJournal | undefined;
  recoverActivity(key, saved.session.id, chain);
  const pilotStore = new LocalStorageStore<CounterState, CounterAction>(localStorage, `${prefix}:pilot`);
  const adapter = await CkbCounterAdapter.create({ client, deployment, sessionCell: saved.cell, session: saved.session, sessionPrivateKey: saved.privateKey,
    onTransaction: transactionObserver(key, '', { sessionId: saved.session.id, kind: 'move' }),
    store: { async load() { const raw = localStorage.getItem(`${prefix}:chain`); return raw ? JSON.parse(raw) as SettlementJournal : undefined; }, async save(journal) { localStorage.setItem(`${prefix}:chain`, JSON.stringify(journal)); } } });
  const pilot = await Pilot.create({ session: saved.session, state: { position: 0 }, budget, adapter, store: { async load() { const journal = await pilotStore.load(); if (journal) recordQueue(key, journal, true); return journal; }, async save(journal) { await pilotStore.save(journal); recordQueue(key, journal); } }, autoSettle: false, onEvent: event => { recordPilotEvent(key, event); onEvent(event); } });
  const journal = JSON.parse(localStorage.getItem(`${prefix}:chain`) ?? '{}') as Partial<SettlementJournal>;
  const receipts = Object.values(journal.transactions ?? {}).filter(record => record.confirmed).map(record => record.hash).reverse();
  return { pilot, adapter, saved, key, receipts };
}
