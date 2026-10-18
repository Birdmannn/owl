import { ccc } from '@ckb-ccc/core';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createDelegationExample } from '../examples/cell-delegation.js';
import { DELEGATION_V1_CODE_HASH, Pilot, PilotConnector, PilotDelegationAdapter, MemoryStore, prepareOwnerAction, prepareDelegationRecovery,
  submitOwnerDelegationTransaction, signDelegatedTransaction, applyPilotTransition, type DelegatedCell, type DelegationReceipt, type Deployment,
  type SettlementJournal, type Session, type Journal, type PilotActionRequest } from '../src/index.js';

class FileStore<T> {
  constructor(readonly path: string) {}
  async load(): Promise<T | undefined> { try { return JSON.parse(await readFile(this.path, 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; } }
  async save(value: T) {
    await writeFile(this.path + '.tmp', JSON.stringify(value, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2), { mode: 0o600 });
    await rename(this.path + '.tmp', this.path);
  }
}
const command = process.argv[2] ?? 'verify';
if (!['verify', 'deploy'].includes(command) || (process.argv[3] ?? 'devnet') !== 'devnet') throw new Error('Use npm run delegation -- deploy devnet or verify devnet. This verifier deliberately supports local devnet only.');
const directory = resolve('.pilot/delegation/devnet');
await mkdir(directory, { recursive: true, mode: 0o700 });
const keyStore = new FileStore<{ owner: ccc.Hex; session: ccc.Hex }>(directory + '/keys.json');
let keys = await keyStore.load();
if (!keys) { keys = { owner: ccc.hexFrom(randomBytes(32)), session: ccc.hexFrom(randomBytes(32)) }; await keyStore.save(keys); }
const exported = spawnSync('offckb', ['system-scripts', '--export-style', 'ccc', '--network', 'devnet'], { encoding: 'utf8' });
if (exported.status !== 0) throw new Error('Start offckb node before running this verifier');
const scripts = JSON.parse(exported.stdout.slice(exported.stdout.indexOf('{')));
scripts[ccc.KnownScript.NervosDao] = await new ccc.ClientPublicTestnet().getKnownScript(ccc.KnownScript.NervosDao);
const client = new ccc.ClientPublicTestnet({ url: 'http://127.0.0.1:8114', fallbacks: [], scripts });
const chain = await client.requestor.request('get_blockchain_info', []) as { chain: string };
if (chain.chain !== 'ckb_dev') throw new Error('Refusing to run against a non-devnet chain');
const owner = new ccc.SignerCkbPrivateKey(client, keys.owner);
const ownerAddress = await owner.getRecommendedAddress();
const ownerLock = (await owner.getRecommendedAddressObj()).script;
if (await owner.getBalance() < ccc.fixedPointFrom(120_000)) {
  console.log('Funding the generated local-only test account:', ownerAddress);
  const deposit = spawnSync('offckb', ['deposit', ownerAddress, '200000', '--network', 'devnet'], { encoding: 'utf8' });
  console.log(deposit.stdout);
  if (deposit.status !== 0) throw new Error('Local faucet funding failed');
  const hash = deposit.stdout.match(/0x[0-9a-f]{64}/)?.[0] as ccc.Hex | undefined;
  if (!hash) throw new Error('Local faucet did not return a transaction hash');
  await client.waitTransaction(hash, 1, 180_000);
}
const proofStore = new FileStore<Record<string, unknown>>(directory + '/proof.json');
const proof = await proofStore.load() ?? { network: 'devnet', ownerAddress, verifiedAt: new Date().toISOString() };
const saveProof = async () => { await proofStore.save(proof); };
const receiptStore = (id: string) => new FileStore<DelegationReceipt>(directory + '/' + id + '.json');
async function ownerTransaction(id: string, build: () => Promise<ccc.Transaction>) {
  const store = receiptStore(id);
  let record = await store.load();
  if (!record) {
    const signed = await owner.signTransaction(await build());
    record = { version: 1, kind: 'setup', hash: signed.hash(), bytes: ccc.hexFrom(signed.toBytes()), confirmed: false };
    await store.save(record);
  }
  if (!record.confirmed) {
    const known = await client.getTransactionNoCache(record.hash);
    if (!known || known.status === 'unknown') await client.sendTransaction(ccc.Transaction.fromBytes(record.bytes));
    const receipt = await client.waitTransaction(record.hash, 1, 180_000);
    if (receipt?.status !== 'committed') throw new Error(`${id} not confirmed`);
    await store.save({ ...record, confirmed: true });
  }
  console.log(id + ':', record.hash); return record.hash;
}
const deploymentStore = new FileStore<Deployment>(directory + '/deployment.json');
let deployment = await deploymentStore.load();
if (!deployment) {
  const code = ccc.hexFrom(await readFile('contracts/build/pilot-delegation-lock'));
  if (ccc.hashCkb(code) !== DELEGATION_V1_CODE_HASH) throw new Error('Compiled delegation binary does not match the SDK pin');
  const hash = await ownerTransaction('deploy', async () => {
    const tx = ccc.Transaction.from({ outputs: [{ lock: ownerLock }], outputsData: [code] });
    await tx.completeInputsByCapacity(owner); await tx.completeFeeBy(owner, 1000n); return tx;
  });
  deployment = { network: 'devnet', genesisHash: (await client.getHeaderByNumberNoCache(0))!.hash, codeHash: DELEGATION_V1_CODE_HASH, outPoint: { txHash: hash, index: 0 } };
  await deploymentStore.save(deployment);
  await writeFile('deployments/cell-delegation-devnet.json', JSON.stringify({ deployment }, null, 2) + '\n');
}
proof.deployment = deployment; await saveProof();
if (command === 'deploy') { console.log('Deployment ready; use verify devnet for the full flow.'); process.exit(0); }
if (proof.complete) { console.log('Existing completed proof:', proof); process.exit(0); }

const definition = createDelegationExample(deployment);
const connector = new PilotConnector(owner, definition);
const publicKey = ccc.hexFrom(secp256k1.getPublicKey(ccc.bytesFrom(keys.session), true));
const declined = await connector.prepareDelegation({ selected: [], sessionPublicKey: publicKey });
if (declined.mode !== 'connected') throw new Error('Declining permissions created a delegation');
proof.emptySelection = 'Connected without funding or signing';
const sourceHash = await ownerTransaction('source', async () => {
  const tx = ccc.Transaction.from({ outputs: [{ lock: ownerLock, capacity: ccc.fixedPointFrom(350) + 2_000_000n }], outputsData: [definition.encodeState({ position: 5 })] });
  await tx.completeInputsByCapacity(owner); await tx.completeFeeBy(owner, 1000n); return tx;
});
proof.source = { txHash: sourceHash, index: 0 }; await saveProof();

let cell = proof.cell as DelegatedCell | undefined;
const setupStore = receiptStore('setup');
if (!cell || !await setupStore.load()) {
  const prepared = await connector.prepareDelegation({ selected: ['game.forward'], sessionPublicKey: publicKey, source: { txHash: sourceHash, index: 0 } });
  if (prepared.mode !== 'delegation') throw new Error('Missing migration review');
  proof.review = prepared.review; proof.cell = prepared.cell; await saveProof();
  cell = await connector.authorize(prepared, setupStore);
} else { await connector.resume(setupStore); }
proof.setup = (await setupStore.load())!.hash; await saveProof();
const session = (proof.session as Session | undefined) ?? { id: 'devnet-delegation', network: 'ckb-devnet', policyVersion: 'delegation-v1', expiresAt: Date.now() + 86_400_000 };
proof.session = session; await saveProof();
const settlement = new FileStore<SettlementJournal>(directory + '/settlement.json');
const journal = new FileStore<Journal<{ position: number }, PilotActionRequest<undefined>>>(directory + '/pilot.json');
const adapter = await PilotDelegationAdapter.create({ definition, client, cell, session, sessionPrivateKey: keys.session, store: settlement });
const pilot = await Pilot.create({ session, state: { position: 5 }, budget: 2_000_000n, adapter, store: journal, autoSettle: false });
if (!proof.move) {
  if (!pilot.queueLength) {
    await pilot.prepare([{ id: 'forward', action: { id: 'game.forward', params: undefined } }, { id: 'backward', action: { id: 'game.backward', params: undefined } }]);
    if (!pilot.readiness('forward').ready || pilot.readiness('backward').ready) throw new Error('Selected subset is not enforced in SDK readiness');
    await pilot.execute('forward'); console.log('Optimistic position:', pilot.state.position);
  }
  await pilot.flush(); if (pilot.queueLength) throw new Error('Action remains unresolved');
  proof.move = adapter.currentOutPoint; proof.confirmedPosition = pilot.confirmedState.position; await saveProof();
}
if (!proof.unselectedActionRejected) {
  const live = await client.getCellLive(adapter.currentOutPoint, true); if (!live) throw new Error('Missing delegated cell');
  const entry = definition.manifest.actions.find(action => action.id === 'game.backward')!;
  const unsigned = ccc.Transaction.from({ cellDeps: [{ outPoint: deployment.outPoint, depType: 'code' }], inputs: [{ previousOutput: live.outPoint }],
    outputs: [{ ...live.cellOutput, capacity: live.cellOutput.capacity - 100_000n }], outputsData: [applyPilotTransition(live.outputData, entry.transition)] });
  try { await client.estimateCycles(signDelegatedTransaction(unsigned, entry.id, keys.session)); throw new Error('Unselected action unexpectedly accepted'); }
  catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (!detail.includes('error code 10') || !detail.includes(DELEGATION_V1_CODE_HASH.slice(2))) throw error;
    proof.unselectedActionRejected = { vmCode: 10, detail };
  }
  await saveProof();
}
if (!proof.manual) {
  const manualStore = receiptStore('manual');
  if (!await manualStore.load()) {
    const tx = await prepareOwnerAction(owner, definition, cell, adapter.currentOutPoint, { id: 'game.jump', params: undefined }, session);
    proof.manual = await submitOwnerDelegationTransaction(owner, tx, 'manual', manualStore);
  } else { proof.manual = await connector.resume(manualStore); }
  await saveProof();
}
if (!proof.manualAdopted) {
  const state = await adapter.adoptOwnerAction(proof.manual as ccc.Hex, 'game.jump');
  await pilot.reconcileConfirmed(state.state, state.remainingBudget);
  proof.manualAdopted = true; proof.positionAfterOwnerAction = pilot.state.position; await saveProof();
}
if (!proof.recovery) {
  const store = receiptStore('recovery');
  if (!await store.load()) {
    const tx = await prepareDelegationRecovery(owner, definition.manifest, cell, adapter.currentOutPoint);
    proof.recovery = await submitOwnerDelegationTransaction(owner, tx, 'recovery', store);
  } else { proof.recovery = await connector.resume(store); }
  const recovered = await client.getCellLive({ txHash: proof.recovery as ccc.Hex, index: 0 }, true);
  if (!recovered?.cellOutput.lock.eq(ownerLock) || recovered.outputData !== definition.encodeState({ position: 8 })) throw new Error('Recovery did not preserve app state and ownership');
  proof.recoveredCapacity = recovered.cellOutput.capacity.toString(); await saveProof();
}
// Separate fresh-cell session with both actions selected verifies creation and multi-action dispatch.
if (!proof.createdCell) {
  const prepared = await connector.prepareDelegation({ selected: ['game.forward', 'game.backward'], sessionPublicKey: publicKey, initialState: { position: 5 } });
  if (prepared.mode !== 'delegation') throw new Error('Missing creation review');
  proof.createdCell = prepared.cell; proof.creationReview = prepared.review; await saveProof();
  await connector.authorize(prepared, receiptStore('create'));
} else { await connector.resume(receiptStore('create')); }
if (!proof.twoActions) {
  const cell = proof.createdCell as DelegatedCell;
  const session2 = { ...session, id: 'devnet-create' };
  const adapter2 = await PilotDelegationAdapter.create({ definition, client, cell, session: session2, sessionPrivateKey: keys.session, store: new FileStore<SettlementJournal>(directory + '/create-settlement.json') });
  const pilot2 = await Pilot.create({ session: session2, state: { position: 5 }, budget: 2_000_000n, adapter: adapter2,
    store: new FileStore<Journal<{ position: number }, PilotActionRequest<undefined>>>(directory + '/create-pilot.json'), autoSettle: false });
  for (const id of ['game.forward', 'game.backward']) {
    await pilot2.prepare([{ id, action: { id, params: undefined } }]); await pilot2.execute(id); await pilot2.flush();
    if (pilot2.queueLength) throw new Error('Created-cell move did not settle');
  }
  if (pilot2.state.position !== 5) throw new Error('Two-action state mismatch');
  proof.twoActions = { position: pilot2.state.position, budget: pilot2.availableBudget.toString(), lastOutPoint: adapter2.currentOutPoint }; await saveProof();
}
proof.complete = true; proof.verifiedAt = new Date().toISOString(); await saveProof();
await writeFile('deployments/cell-delegation-devnet-proof.json', JSON.stringify(proof, null, 2) + '\n');
console.log('Cell delegation verified: creation, migration, selected actions, VM rejection, owner-only action, and recovery.');
