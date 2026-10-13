import test from 'node:test';
import assert from 'node:assert/strict';
import { ccc } from '@ckb-ccc/core';
import { amount, buildDeposit, client, deployment, isPilotMove, loadBoardPage, parseDeposit } from '../src/chain.js';

test('deposit amounts retain exact shannons and reject invalid or overflowing inputs', () => {
  assert.equal(parseDeposit('0.00000001'), 1n);
  assert.equal(parseDeposit('100.12345678'), 10_012_345_678n);
  assert.equal(parseDeposit('184467440737.09551615'), (1n << 64n) - 1n);
  for (const invalid of ['0', '-1', '1e8', 'NaN', 'Infinity', '1.000000001', '184467440737.09551616']) {
    assert.throws(() => parseDeposit(invalid), undefined, invalid);
  }
  assert.equal(amount(10_012_345_678n), '100.12345678');
});

const record = { txHash: `0x${'ab'.repeat(32)}`, blockNumber: 100n, cells: [{ isInput: true, cellIndex: 0n }] };
function transaction(mode = 'session') {
  const tx = ccc.Transaction.from({
    inputs: [{ previousOutput: { txHash: `0x${'cd'.repeat(32)}`, index: 0 } }],
    outputs: [{ capacity: 15_000_000_000n, lock: { codeHash: deployment.codeHash, hashType: 'data2', args: `0x${'00'.repeat(81)}` } }],
    outputsData: [`0x${'00'.repeat(16)}`],
  });
  tx.setWitnessArgs(0, { lock: mode === 'session' ? `0x01${'11'.repeat(64)}` : '0x00' });
  return tx;
}

test('board excludes owner signatures, setup outputs, pending receipts, and other policies', () => {
  const tx = transaction();
  assert.equal(isPilotMove(record, { status: 'committed', transaction: tx }), true);
  assert.equal(isPilotMove(record, { status: 'pending', transaction: tx }), false);
  assert.equal(isPilotMove(record, { status: 'committed', transaction: transaction('owner') }), false);
  assert.equal(isPilotMove({ ...record, cells: [{ isInput: false, cellIndex: 0n }] }, { status: 'committed', transaction: tx }), false);
  tx.outputs[0].lock.codeHash = `0x${'ff'.repeat(32)}`;
  assert.equal(isPilotMove(record, { status: 'committed', transaction: tx }), false);
});

test('board reconciles input locks and derives fees from actual capacities', async (t) => {
  const tx = transaction();
  const previous = transaction(); previous.outputs[0].capacity += 100_000n;
  t.mock.method(client, 'findTransactionsPaged', async () => ({ transactions: [record], lastCursor: 'end' }));
  t.mock.method(client, 'getTransactionNoCache', async () => ({ status: 'committed', transaction: tx }));
  t.mock.method(client, 'getTransaction', async () => ({ status: 'committed', transaction: previous }));
  t.mock.method(client, 'getHeaderByNumberNoCache', async () => ({ timestamp: 123456n }));
  const result = await loadBoardPage();
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].fee, '100000');
  assert.equal(result.rows[0].time, 123456);
  assert.equal(result.cursor, null);
  previous.outputs[0].lock.args = `0x${'ff'.repeat(81)}`;
  assert.equal((await loadBoardPage()).rows.length, 0);
});

test('missing receipts produce a retryable error instead of a false empty board', async (t) => {
  t.mock.method(client, 'findTransactionsPaged', async () => ({ transactions: [record], lastCursor: 'end' }));
  t.mock.method(client, 'getTransactionNoCache', async () => undefined);
  await assert.rejects(loadBoardPage(), /temporarily unavailable/);
});

test('deposit construction rejects a wallet connected to another chain before building or signing', async () => {
  const signer = { client: { async getHeaderByNumberNoCache() { return { hash: `0x${'00'.repeat(32)}` }; } } };
  await assert.rejects(buildDeposit(signer, '100'), /CKB testnet/);
});

test('full indexer pages retain a cursor even when they contain only owner setup records', async (t) => {
  const setup = { ...record, cells: [{ isInput: false, cellIndex: 0n }] };
  const find = t.mock.method(client, 'findTransactionsPaged', async () => ({ transactions: Array.from({ length: 25 }, () => setup), lastCursor: 'older-page' }));
  const get = t.mock.method(client, 'getTransactionNoCache', async () => { throw new Error('Setup receipts should not be fetched'); });
  const result = await loadBoardPage('previous-page');
  assert.equal(result.cursor, 'older-page');
  assert.deepEqual(result.rows, []);
  assert.equal(find.mock.calls[0].arguments[3], 'previous-page');
  assert.equal(get.mock.callCount(), 0);
});
