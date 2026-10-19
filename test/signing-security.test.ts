import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { ccc } from '@ckb-ccc/core';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { assertPilotSigningOwner, prepareOwnerAction, PilotConnector, createPilotGrant, delegationLock, DELEGATION_V1_CODE_HASH,
  verifyOwnerSignatureChanges, type Deployment, type Session } from '../src/index.js';
import { createDelegationExample } from '../examples/cell-delegation.js';
const hex = (n: number) => ccc.hexFrom(new Uint8Array(32).fill(n));
const client = new ccc.ClientPublicTestnet();

test('owner-input authority rejects ACP, OmniLock ACP, always-success, and unknown owner locks', async () => {
  const args = '0x' + '11'.repeat(20);
  for (const [known, suffix] of [[ccc.KnownScript.Secp256k1Blake160, args], [ccc.KnownScript.OmniLock, '0x12' + '11'.repeat(20) + '00'], [ccc.KnownScript.JoyId, '0x0001' + '11'.repeat(20)]] as const) {
    await assertPilotSigningOwner(client, (await ccc.Address.fromKnownScript(client, known, suffix)).script);
  }
  for (const script of [
    (await ccc.Address.fromKnownScript(client, ccc.KnownScript.AnyoneCanPay, args)).script,
    (await ccc.Address.fromKnownScript(client, ccc.KnownScript.OmniLock, '0x12' + '11'.repeat(20) + '02')).script,
    ccc.Script.from({ codeHash: hex(9), hashType: 'data2', args }),
  ]) await assert.rejects(assertPilotSigningOwner(client, script), /Unsupported Pilot owner lock/);
});

test('wallet signing cannot change reviewed payments or app type witnesses', () => {
  const tx = ccc.Transaction.from({ outputs: [{ lock: { codeHash: hex(1), hashType: 'data2', args: '0x' }, capacity: 100n }], outputsData: ['0x'] });
  tx.setWitnessArgs(0, { lock: '0x00', inputType: '0x1234' });
  const signed = tx.clone(); signed.setWitnessArgs(0, { ...signed.getWitnessArgs(0), lock: '0x1234' }); verifyOwnerSignatureChanges(tx, signed);
  const changed = signed.clone(); changed.outputs[0]!.capacity = 1n;
  assert.throws(() => verifyOwnerSignatureChanges(tx, changed), /effects/);
  signed.setWitnessArgs(0, { lock: '0x1234', inputType: '0x9999' });
  assert.throws(() => verifyOwnerSignatureChanges(tx, signed), /type witnesses/);
});

test('manual builder cannot mutate its cell or default transaction to redirect a reviewed owner action; type witnesses survive', { skip: !existsSync('contracts/build/pilot-delegation-lock') && 'Build the contracts first' }, async () => {
  const deployment: Deployment = { network: 'testnet', genesisHash: '0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606', codeHash: DELEGATION_V1_CODE_HASH, outPoint: { txHash: hex(1), index: 0 } };
  const definition = createDelegationExample(deployment);
  const ownerLock = ccc.Script.from({ codeHash: hex(2), hashType: 'data2', args: '0x' });
  const publicKey = ccc.hexFrom(secp256k1.getPublicKey(ccc.bytesFrom(hex(3)), true));
  const grant = createPilotGrant(definition.manifest, ['game.forward']);
  const lock = delegationLock(definition.manifest, grant, ownerLock, publicKey), point = { txHash: hex(4), index: 0 };
  const source = ccc.Cell.from({ outPoint: point, cellOutput: { lock, capacity: 35_002_000_000n }, outputData: definition.encodeState({ position: 5 }) });
  const code = ccc.Cell.from({ outPoint: deployment.outPoint, cellOutput: { lock: ownerLock }, outputData: ccc.hexFrom(readFileSync('contracts/build/pilot-delegation-lock')) });
  const fakeClient = { async getHeaderByNumberNoCache() { return { hash: deployment.genesisHash }; }, async getCellLive(p: ccc.OutPointLike) { return ccc.OutPoint.from(p).eq(deployment.outPoint) ? code : source; } } as unknown as ccc.Client;
  const owner = { client: fakeClient, async getRecommendedAddressObj() { return { script: ownerLock }; }, async prepareTransaction(tx: ccc.Transaction) { return tx; } } as unknown as ccc.Signer;
  const session: Session = { id: 'manual', network: 'ckb-testnet', policyVersion: 'delegation-v1', expiresAt: Date.now() + 60000 };
  const previous = ccc.Transaction.prototype.completeFeeBy;
  // Isolate the builder boundary; coin selection is independently checked elsewhere.
  ccc.Transaction.prototype.completeFeeBy = async function () { return [0, false]; };
  try {
    const build = definition.actions['game.jump']!.buildTransaction;
    definition.actions['game.jump']!.buildTransaction = async (params, context) => {
      const tx = ccc.Transaction.from(await build(params, context));
      context.cell.cellOutput.lock = ownerLock.clone(); tx.outputs[0]!.lock = ownerLock.clone();
      return tx;
    };
    await assert.rejects(prepareOwnerAction(owner, definition, { lock, ownerLock }, point, { id: 'game.jump', params: undefined }, session), /changed reviewed/);
    assert.ok(source.cellOutput.lock.eq(lock), 'builder did not mutate RPC source');
    definition.actions['game.jump']!.buildTransaction = async (params, context) => { const tx = ccc.Transaction.from(await build(params, context)); tx.setWitnessArgs(0, { inputType: '0x1234' }); return tx; };
    const prepared = await prepareOwnerAction(owner, definition, { lock, ownerLock }, point, { id: 'game.jump', params: undefined }, session);
    assert.equal(prepared.getWitnessArgs(0)?.inputType, '0x1234'); assert.equal(prepared.getWitnessArgs(0)?.lock, '0x00');
    const connector = new PilotConnector({ ...owner, async getRecommendedAddressObj() { return { script: ccc.Script.from({ codeHash: hex(9), hashType: 'data2', args: '0x' }) }; } } as unknown as ccc.Signer, definition);
    let broadcasts = 0;
    fakeClient.sendTransaction = async () => { broadcasts++; return hex(1); };
    await assert.rejects(connector.resume({ async load() { return { version: 1, kind: 'setup', hash: prepared.hash(), bytes: ccc.hexFrom(prepared.toBytes()), confirmed: true }; }, async save() {} }), /another owner or manifest/);
    assert.equal(broadcasts, 0);
    // Resume must submit the exact receipt that passed owner/app validation,
    // rather than reading a potentially different receipt a second time.
    let reads = 0;
    const valid = { version: 1 as const, kind: 'manual' as const, hash: prepared.hash(), bytes: ccc.hexFrom(prepared.toBytes()), confirmed: false };
    fakeClient.getTransactionNoCache = async () => ({ status: 'committed' }) as never;
    fakeClient.waitTransaction = async () => ({ status: 'committed' }) as never;
    const ownConnector = new PilotConnector(owner, definition);
    const resumed = await ownConnector.resume({ async load() { reads++; return reads === 1 ? valid : { ...valid, hash: hex(99) }; }, async save() {} });
    assert.equal(resumed, prepared.hash()); assert.equal(reads, 1);
  } finally { ccc.Transaction.prototype.completeFeeBy = previous; }
});

test('counter setup persists exact signed bytes before broadcast and refuses to broadcast after persistence failure', { skip: !existsSync('contracts/build/pilot-session-lock') && 'Build the contracts first' }, async () => {
  const { authorizeCounter, COUNTER_V1_CODE_HASH } = await import('../src/index.js');
  const ownerLock = (await ccc.Address.fromKnownScript(client, ccc.KnownScript.Secp256k1Blake160, '0x' + '11'.repeat(20))).script;
  const codePoint = { txHash: hex(10), index: 0 }, fundingPoint = { txHash: hex(11), index: 0 };
  const deployment: Deployment = { network: 'testnet', codeHash: COUNTER_V1_CODE_HASH,
    genesisHash: '0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606', outPoint: codePoint };
  const funding = ccc.Cell.from({ outPoint: fundingPoint, cellOutput: { lock: ownerLock, capacity: 50_000_000_000n }, outputData: '0x' });
  const code = ccc.Cell.from({ outPoint: codePoint, cellOutput: { lock: ownerLock }, outputData: ccc.hexFrom(readFileSync('contracts/build/pilot-session-lock')) });
  let broadcasts = 0; let persisted: ccc.Hex | undefined;
  const fakeClient = {
    getKnownScript: client.getKnownScript.bind(client),
    async getHeaderByNumberNoCache() { return { hash: deployment.genesisHash }; },
    async getCellLive(point: ccc.OutPointLike) { return ccc.OutPoint.from(point).eq(codePoint) ? code : funding; },
    async sendTransaction(tx: ccc.Transaction) { broadcasts++; assert.equal(ccc.hexFrom(tx.toBytes()), persisted); throw new Error('Lost response after broadcast'); },
  } as unknown as ccc.Client;
  const owner = { client: fakeClient, async getRecommendedAddressObj() { return { script: ownerLock }; },
    async prepareTransaction(tx: ccc.Transaction) { tx.setWitnessArgs(0, { lock: '0x00' }); return tx; },
    async signOnlyTransaction(tx: ccc.Transaction) { return tx.clone(); } } as unknown as ccc.Signer;
  const previousInputs = ccc.Transaction.prototype.completeInputsByCapacity, previousFee = ccc.Transaction.prototype.completeFeeBy;
  ccc.Transaction.prototype.completeInputsByCapacity = async function () { this.inputs.push(ccc.CellInput.from({ previousOutput: fundingPoint })); return 1; };
  ccc.Transaction.prototype.completeFeeBy = async function () { this.outputs.push(ccc.CellOutput.from({ lock: ownerLock, capacity: funding.cellOutput.capacity - this.outputs[0]!.capacity - 1000n })); this.outputsData.push('0x'); return [0, false]; };
  const options = { deployment, sessionPublicKey: ccc.hexFrom(secp256k1.getPublicKey(ccc.bytesFrom(hex(3)), true)), budget: 2_000_000n, feePerMove: 100_000n };
  try {
    await assert.rejects(authorizeCounter(owner, { ...options, async onSigned() { throw new Error('Storage full'); } }), /Storage full/);
    assert.equal(broadcasts, 0);
    await assert.rejects(authorizeCounter(owner, { ...options, async onSigned(cell, bytes) { persisted = bytes; assert.equal(ccc.Transaction.fromBytes(bytes).hash(), ccc.OutPoint.from(cell.outPoint).txHash); } }), /Lost response/);
    assert.equal(broadcasts, 1); assert.ok(persisted);
    const { withPilotBudget, PilotCounterConnector, decodeCounterData } = await import('../src/index.js');
    const manifest = withPilotBudget({ version: 1 as const, app: { id: 'test.budget', name: 'Budget test', description: 'Chosen allowance' },
      permissions: [{ id: 'counter.increment' as const, name: 'Move', description: 'One step' }],
      policy: { kind: 'counter-v1' as const, deployment, feePerMove: '100000', budget: '2000000', floorCapacity: '15000000000' } }, '500000');
    await assert.rejects(new PilotCounterConnector(owner, manifest).authorize(['counter.increment'], {
      sessionPublicKey: options.sessionPublicKey,
      async onSigned(_cell, bytes) {
        persisted = bytes;
        const tx = ccc.Transaction.fromBytes(bytes);
        assert.equal(decodeCounterData(tx.outputsData[0]!).budget, 500000n);
        assert.equal(tx.outputs[0]!.capacity, 15000500000n);
      },
    }), /Lost response/);
    assert.equal(broadcasts, 2);

  } finally { ccc.Transaction.prototype.completeInputsByCapacity = previousInputs; ccc.Transaction.prototype.completeFeeBy = previousFee; }
});
