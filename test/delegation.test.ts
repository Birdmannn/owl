import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { ccc } from '@ckb-ccc/core';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { createDelegationExample } from '../examples/cell-delegation.js';
import { Pilot, MemoryStore, PilotConnector, PilotDelegationAdapter, DELEGATION_V1_CODE_HASH, definePilotApp, createPilotGrant, pilotManifestHash,
  assertPilotPermission, delegationLock, checkOwnerTransaction, checkDelegatedTransaction, applyPilotTransition, signDelegatedTransaction, delegationSigningDigest,
  type Deployment, type SettlementJournal, type Session } from '../src/index.js';

const hash = (n: number) => ccc.hexFrom(new Uint8Array(32).fill(n));
const deployment: Deployment = { network: 'testnet', genesisHash: '0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606',
  codeHash: DELEGATION_V1_CODE_HASH, outPoint: { txHash: hash(1), index: 0 } };
const definition = createDelegationExample(deployment);
const key = hash(2), publicKey = ccc.hexFrom(secp256k1.getPublicKey(ccc.bytesFrom(key), true));
const owner = ccc.Script.from({ codeHash: hash(3), hashType: 'data2', args: '0x' });
const grant = createPilotGrant(definition.manifest, ['game.forward']);
const lock = delegationLock(definition.manifest, grant, owner, publicKey);
const point = { txHash: hash(4), index: 0 };
const input = ccc.Cell.from({ outPoint: point, cellOutput: { lock, capacity: ccc.fixedPointFrom(350) + 2_000_000n }, outputData: definition.encodeState({ position: 5 }) });
const session: Session = { id: 'delegation-test', network: 'ckb-testnet', policyVersion: 'delegation-v1', expiresAt: Date.now() + 60_000 };
function move() { return ccc.Transaction.from({ inputs: [{ previousOutput: point }], outputs: [{ ...input.cellOutput, capacity: input.cellOutput.capacity - 100_000n }],
  outputsData: [definition.encodeState({ position: 6 })], cellDeps: [{ outPoint: deployment.outPoint, depType: 'code' }] }); }

test('developer definitions bind script identity, labels, operation rules and limits; subsets require explicit consent', async () => {
  assert.throws(() => definePilotApp({ ...definition, actions: {} }), /builder/);
  assert.throws(() => createPilotGrant(definition.manifest, ['unknown']), /Unknown/);
  assert.throws(() => createPilotGrant(definition.manifest, ['game.forward', 'game.forward']), /duplicate/);
  assert.throws(() => createPilotGrant(definition.manifest, ['game.jump']), /owner-only/);
  assert.throws(() => assertPilotPermission(definition.manifest, grant, 'game.backward'), /outside/);
  const changed = structuredClone(definition.manifest); changed.actions[0]!.transition.delta = '2';
  assert.throws(() => assertPilotPermission(changed, grant, 'game.forward'), /fresh consent/);
  assert.notEqual(pilotManifestHash(changed), grant.manifestHash);
  const reordered = Object.fromEntries(Object.entries(definition.manifest).reverse()) as typeof definition.manifest;
  assert.equal(pilotManifestHash(reordered), grant.manifestHash);
  const connector = new PilotConnector({} as ccc.Signer, definition);
  const declined = await connector.prepareDelegation({ selected: [], sessionPublicKey: publicKey });
  assert.equal(declined.mode, 'connected'); // No wallet method or RPC available: declining cannot fund/sign.
});

test('selected rules change lock identity and cannot modify any other state byte', () => {
  const both = createPilotGrant(definition.manifest, ['game.forward', 'game.backward']);
  assert.notEqual(delegationLock(definition.manifest, both, owner, publicKey).hash(), lock.hash());
  const original = '0x0500000000000000aabb';
  assert.equal(applyPilotTransition(original, { kind: 'u64-increment', offset: 0, delta: '1' }), '0x0600000000000000aabb');
  assert.throws(() => applyPilotTransition('0x0000000000000000', { kind: 'u64-decrement', offset: 0, delta: '1' }), /underflow/);
  assert.throws(() => applyPilotTransition(original, { kind: 'u64-increment', offset: 9, delta: '1' }), /outside/);
});

test('independent authorization checks reject unrelated assets, missing source, changed state, payments, and excessive fees', async () => {
  const source = ccc.Cell.from({ outPoint: point, cellOutput: { lock: owner, capacity: ccc.fixedPointFrom(400) }, outputData: input.outputData });
  const unrelated = ccc.Cell.from({ outPoint: { txHash: hash(5), index: 0 }, cellOutput: { lock: owner, capacity: ccc.fixedPointFrom(100) }, outputData: '0x1234' });
  const client = { async getCellLive(outPoint: ccc.OutPointLike) { return ccc.OutPoint.from(outPoint).eq(point) ? source : unrelated; } } as unknown as ccc.Client;
  const output = ccc.CellOutput.from({ lock, capacity: source.cellOutput.capacity - 1000n });
  const tx = ccc.Transaction.from({ inputs: [{ previousOutput: point }], outputs: [output], outputsData: [source.outputData] });
  const scope = { ownerLock: owner, selected: source, output, data: source.outputData, maxFee: 2000n };
  assert.equal(await checkOwnerTransaction(client, tx, scope), 1000n);
  const stateChange = tx.clone(); stateChange.outputsData[0] = definition.encodeState({ position: 8 });
  await assert.rejects(checkOwnerTransaction(client, stateChange, scope), /changed reviewed/);
  const asset = tx.clone(); asset.inputs.push(ccc.CellInput.from({ previousOutput: unrelated.outPoint }));
  await assert.rejects(checkOwnerTransaction(client, asset, scope), /unapproved state cell or asset/);
  await assert.rejects(checkOwnerTransaction(client, tx, { ...scope, maxFee: 999n }), /fee limit/);
  const payment = tx.clone(); payment.outputs.push(ccc.CellOutput.from({ lock: { ...owner, args: '0x01' }, capacity: ccc.fixedPointFrom(61) })); payment.outputsData.push('0x');
  await assert.rejects(checkOwnerTransaction(client, payment, scope), /owner change/);
});

test('action builders cannot change another cell, transfer funds, or exceed the approved transition', () => {
  assert.equal(checkDelegatedTransaction(definition.manifest, grant, 'game.forward', input, move()), 100_000n);
  const tx = move(); tx.outputsData[0] = definition.encodeState({ position: 7 });
  assert.throws(() => checkDelegatedTransaction(definition.manifest, grant, 'game.forward', input, tx), /transition/);
  assert.throws(() => checkDelegatedTransaction(definition.manifest, grant, 'game.backward', input, move()), /outside/);
  const wrongCell = move(); wrongCell.inputs[0]!.previousOutput = ccc.OutPoint.from({ txHash: hash(8), index: 0 });
  assert.throws(() => checkDelegatedTransaction(definition.manifest, grant, 'game.forward', input, wrongCell), /scope/);
});

test('session signatures commit operations, type witnesses, and appended witnesses', () => {
  const tx = move(); tx.setWitnessArgs(0, { inputType: '0x1234' }); tx.witnesses.push('0x5678');
  const signed = signDelegatedTransaction(tx, 'game.forward', key);
  const signature = ccc.bytesFrom(signed.getWitnessArgs(0)!.lock!).slice(33);
  const valid = (tx: ccc.Transaction, id = 'game.forward') => secp256k1.verify(signature, ccc.bytesFrom(delegationSigningDigest(tx, id)), ccc.bytesFrom(publicKey), { prehash: false });
  assert.equal(valid(signed), true);
  assert.equal(valid(signed, 'game.backward'), false);
  const witnessChanged = signed.clone(); witnessChanged.setWitnessArgs(0, { ...witnessChanged.getWitnessArgs(0), inputType: '0x1111' });
  assert.equal(valid(witnessChanged), false);
  const appended = signed.clone(); appended.witnesses.push('0xaabb'); assert.equal(valid(appended), false);
});

test('named-action adapter preserves optimistic execution and retries exact signed bytes after reload', { skip: !existsSync('contracts/build/pilot-delegation-lock') && 'Run npm run contracts:build for this compiled-binary check' }, async () => {
  const code = readFileSync('contracts/build/pilot-delegation-lock');
  assert.equal(ccc.hashCkb(code), DELEGATION_V1_CODE_HASH);
  let saved: SettlementJournal | undefined;
  let fail = true;
  const sent: string[] = [];
  const client = {
    async getHeaderByNumberNoCache() { return { hash: deployment.genesisHash }; },
    async getCellLive(point: ccc.OutPointLike) { return ccc.OutPoint.from(point).eq(deployment.outPoint)
      ? ccc.Cell.from({ outPoint: point, cellOutput: { lock: owner }, outputData: ccc.hexFrom(code) }) : input; },
    async getTransactionNoCache() { return undefined; },
    async sendTransaction(tx: ccc.Transaction) { assert.ok(Object.values(saved?.transactions ?? {}).some(record => record.hash === tx.hash())); sent.push(ccc.hexFrom(tx.toBytes())); if (fail) throw new Error('Lost response'); return tx.hash(); },
    async waitTransaction() { return { status: 'committed' }; },
  } as unknown as ccc.Client;
  const store = { async load() { return structuredClone(saved); }, async save(journal: SettlementJournal) { saved = structuredClone(journal); } };
  const options = { definition, client, session, sessionPrivateKey: key, store, cell: { lock, outPoint: point, grant, ownerLock: owner, sessionPublicKey: publicKey } };
  const adapter = await PilotDelegationAdapter.create(options);
  const pilot = await Pilot.create({ session, state: { position: 5 }, budget: 2_000_000n, adapter, store: new MemoryStore<{ position: number }, { id: string; params: undefined }>(), autoSettle: false });
  await pilot.prepare([{ id: 'forward', action: { id: 'game.forward', params: undefined } }, { id: 'backward', action: { id: 'game.backward', params: undefined } }]);
  assert.equal(pilot.readiness('forward').ready, true); assert.equal(pilot.readiness('backward').ready, false);
  await pilot.execute('forward'); assert.equal(pilot.state.position, 6); assert.equal(pilot.confirmedState.position, 5);
  await pilot.flush(); assert.equal(pilot.queueLength, 1);
  fail = false;
  const restored = await PilotDelegationAdapter.create(options);
  // The Pilot engine generates its own stable ID; reconcile that exact request after restart.
  const id = Object.keys(saved!.transactions)[0]!;
  await restored.settle({ id, action: { id: 'game.forward', params: undefined }, session, reservedCost: 100_000n });
  assert.equal(sent[0], sent.at(-1));
  await assert.rejects(restored.settle({ id, action: { id: 'game.forward', params: 'different' as never }, session, reservedCost: 100_000n }), /does not match/);
  await assert.rejects(PilotDelegationAdapter.create({ ...options, session: { ...session, id: 'another' } }), /another delegation/);
});
