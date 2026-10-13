import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ccc } from '@ckb-ccc/core';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { counterLock, encodeCounterData, decodeCounterData, signCounterTransaction,
  CkbCounterAdapter } from '../src/index.js';
import type { Deployment, Session, SettlementJournal } from '../src/index.js';
const key = ccc.hexFrom(new Uint8Array(32).fill(1));
const genesisHash = '0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606';
const code = new Uint8Array([1, 2, 3]);
const outPoint = { txHash: ccc.hexFrom(new Uint8Array(32).fill(2)), index: 0 };
const deployment: Deployment = { network: 'testnet', genesisHash, codeHash: ccc.hashCkb(code), outPoint };
const owner = ccc.Script.from({ codeHash: ccc.hexFrom(new Uint8Array(32).fill(3)), hashType: 'data2', args: '0x' });
const lock = counterLock(deployment, owner, ccc.hexFrom(secp256k1.getPublicKey(ccc.bytesFrom(key), true)), 1000n, 15_000_000_000n);
const cell = { lock, outPoint: { txHash: ccc.hexFrom(new Uint8Array(32).fill(4)), index: 0 }, feePerMove: '1000' };
const session: Session = { id: 'ckb-test', network: 'ckb-testnet', policyVersion: 'counter-v1', expiresAt: Date.now() + 60_000 };

test('counter encoding preserves u64 amounts and signatures bind exact transaction effects', () => {
  assert.deepEqual(decodeCounterData(encodeCounterData((1n << 64n) - 1n, 7n)), { budget: (1n << 64n) - 1n, position: 7n });
  assert.throws(() => encodeCounterData(-1n, 0n), /u64/);
  const tx = signCounterTransaction(ccc.Transaction.from({ inputs: [{ previousOutput: cell.outPoint }],
    outputs: [{ lock, capacity: 15_000_000_000n }], outputsData: [encodeCounterData(1000n, 1n)] }), key);
  const witness = ccc.bytesFrom(tx.getWitnessArgs(0)!.lock!);
  const publicKey = secp256k1.getPublicKey(ccc.bytesFrom(key), true);
  assert.equal(secp256k1.verify(witness.slice(1), ccc.bytesFrom(tx.hash()), publicKey, { prehash: false }), true);
  tx.outputsData[0] = encodeCounterData(1000n, 2n);
  assert.equal(secp256k1.verify(witness.slice(1), ccc.bytesFrom(tx.hash()), publicKey, { prehash: false }), false);
});

test('adapter persists signed bytes before broadcast and reconciles after restart', async () => {
  let saved: SettlementJournal | undefined;
  let fail = true;
  const sent: string[] = [];
  const phases: string[] = [];
  const store = { async load() { return structuredClone(saved); }, async save(value: SettlementJournal) { saved = structuredClone(value); } };
  const fake = {
    async getHeaderByNumberNoCache() { return { hash: genesisHash }; },
    async getCellLive(point: ccc.OutPointLike) {
      if (ccc.OutPoint.from(point).eq(deployment.outPoint)) return ccc.Cell.from({ outPoint, cellOutput: { lock: owner }, outputData: code });
      return ccc.Cell.from({ outPoint: point, cellOutput: { lock, capacity: 15_000_003_000n }, outputData: encodeCounterData(3000n, 0n) });
    },
    async getTransactionNoCache() { return undefined; },
    async sendTransaction(tx: ccc.Transaction) {
      assert.ok(saved?.transactions['move-1']);
      sent.push(ccc.hexFrom(tx.toBytes()));
      if (fail) throw new Error('Response lost after submission');
      return tx.hash();
    },
    async waitTransaction() { return { status: 'committed' }; },
  } as unknown as ccc.Client;
  const options = { client: fake, deployment, sessionCell: cell, session, sessionPrivateKey: key, store, onTransaction: (event: import('../src/index.js').CounterTransactionEvent) => { phases.push(event.phase); if (event.phase === 'signed') throw new Error('Broken diagnostic observer'); } };
  const request = { id: 'move-1', action: { steps: 1 }, session, reservedCost: 1000n };
  const first = await CkbCounterAdapter.create(options);
  await assert.rejects(first.settle(request), /Response lost/);
  fail = false;
  const restored = await CkbCounterAdapter.create(options);
  const receipt = await restored.settle(request);
  assert.equal(sent.length, 2);
  assert.equal(sent[0], sent[1]);
  assert.equal(ccc.OutPoint.from(restored.currentOutPoint).txHash, receipt.transactionHash);
  await restored.settle(request);
  assert.equal(sent.length, 2);
  assert.deepEqual(phases, ['signed', 'checking', 'broadcasting', 'checking', 'broadcasting', 'submitted', 'confirming', 'confirmed']);
});

test('adapter rejects a deployment on another chain before signing', async () => {
  const fake = { async getHeaderByNumberNoCache() { return { hash: '0x92b197aa1fba0f63633922c61c92375c9c074a93e85963554f5499fe1450d0e5' }; } } as unknown as ccc.Client;
  await assert.rejects(CkbCounterAdapter.create({ client: fake, deployment, sessionCell: cell, session,
    sessionPrivateKey: key, store: { async load() { return undefined; }, async save() {} } }), /network/);
});
