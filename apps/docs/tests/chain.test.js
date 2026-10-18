import test from 'node:test';
import assert from 'node:assert/strict';
import { ccc } from '@ckb-ccc/core';
import { amount, buildDeposit, client, deployment, boardPolicies, loadBoardPage, loadSocialBoardPage, readLocalBoardActivity, parseDeposit } from '../src/chain.js';

test('deposit amounts retain exact shannons and reject invalid or overflowing inputs', () => {
  assert.equal(parseDeposit('0.00000001'), 1n);
  assert.equal(parseDeposit('100.12345678'), 10_012_345_678n);
  assert.equal(parseDeposit('184467440737.09551615'), (1n << 64n) - 1n);
  for (const invalid of ['0', '-1', '1e8', 'NaN', 'Infinity', '1.000000001', '184467440737.09551616']) assert.throws(() => parseDeposit(invalid));
  assert.equal(amount(10_012_345_678n), '100.12345678');
});
const hash = n => `0x${n.repeat(32)}`;
const record = { txHash: hash('ab'), blockNumber: 100n, cells: [{ isInput: true, cellIndex: 0n }] };
const ordinary = { codeHash: hash('ff'), hashType: 'data2', args: '0x' };
const lock = (delegated = false) => ({ codeHash: delegated ? boardPolicies[1].codeHash : deployment.codeHash, hashType: 'data2',
  args: delegated ? `0x${'00'.repeat(145)}01${'11'.repeat(45)}` : `0x${'00'.repeat(81)}` });
function fixture(t, { mode = 'session', delegated = false, setup = false, recovery = false, status = 'committed' } = {}) {
  const tx = ccc.Transaction.from({ inputs: [{ previousOutput: { txHash: hash('cd'), index: 0 } }],
    outputs: [{ capacity: 15_000_000_000n, lock: recovery ? ordinary : lock(delegated) }], outputsData: ['0x'] });
  tx.setWitnessArgs(0, { lock: mode === 'session' ? `0x01${delegated ? '22'.repeat(32) : ''}${'11'.repeat(64)}` : '0x00' });
  const previous = ccc.Transaction.from({ outputs: [{ capacity: 15_000_100_000n, lock: setup ? ordinary : lock(delegated) }], outputsData: ['0x'] });
  t.mock.method(client, 'findTransactionsPaged', async () => ({ transactions: [record], lastCursor: 'end' }));
  t.mock.method(client, 'getTransactionNoCache', async () => ({ status, transaction: tx }));
  t.mock.method(client, 'getTransaction', async () => ({ status: 'committed', transaction: previous }));
  t.mock.method(client, 'getHeaderByNumberNoCache', async () => ({ timestamp: 123456n }));
  return { tx, previous };
}
test('both policies are queried and duplicate transactions are counted once with full fees', async t => {
  const { tx } = fixture(t);
  tx.inputs.push(ccc.CellInput.from({ previousOutput: { txHash: hash('ef'), index: 0 } }));
  tx.outputs.push(ccc.CellOutput.from({ capacity: 15_000_000_000n, lock: ordinary })); tx.outputsData.push('0x');
  const result = await loadBoardPage();
  assert.equal(result.rows.length, 1); assert.equal(result.rows[0].fee, '200000');
  assert.equal(result.rows[0].time, 123456); assert.equal(result.cursor, null);
  assert.equal(result.rows[0].details.transaction.inputs.length, 2);
  assert.deepEqual(client.findTransactionsPaged.mock.calls.map(call => call.arguments[0].script.codeHash), boardPolicies.map(p => p.codeHash));
});
for (const [options, action] of [
  [{ setup: true, mode: 'owner' }, 'Session setup / funding'],
  [{ recovery: true, mode: 'owner' }, 'Recovery / session close'],
  [{ mode: 'owner' }, 'Owner app transition'],
  [{ delegated: true }, 'Delegated app action'],
]) test(`board includes ${action}`, async t => {
  fixture(t, options); const { rows } = await loadBoardPage();
  assert.equal(rows[0].action, action);
  if (options.delegated) { assert.equal(rows[0].actionId, hash('22')); assert.equal(rows[0].details.manifestHashes.length, 1); }
});
test('pending receipts and false indexer matches are excluded', async t => {
  const { tx, previous } = fixture(t, { status: 'pending' });
  assert.equal((await loadBoardPage()).rows.length, 0);
  client.getTransactionNoCache.mock.restore();
  t.mock.method(client, 'getTransactionNoCache', async () => ({ status: 'committed', transaction: tx }));
  tx.outputs[0].lock = ccc.Script.from(ordinary); previous.outputs[0].lock = ccc.Script.from(ordinary);
  assert.equal((await loadBoardPage()).rows.length, 0);
});
test('missing receipts produce retryable errors', async t => {
  fixture(t); client.getTransactionNoCache.mock.restore();
  t.mock.method(client, 'getTransactionNoCache', async () => undefined);
  await assert.rejects(loadBoardPage(), /temporarily unavailable/);
});
test('independent policy pagination includes setup records and skips exhausted streams', async t => {
  fixture(t, { setup: true, mode: 'owner' }); client.findTransactionsPaged.mock.restore();
  const find = t.mock.method(client, 'findTransactionsPaged', async () => ({ transactions: Array(25).fill(record), lastCursor: 'older' }));
  const result = await loadBoardPage(Object.fromEntries(boardPolicies.map(p => [p.id, p.id === 'counter-v1' ? 'previous' : null])));
  assert.equal(result.rows.length, 1); assert.deepEqual(result.cursor, Object.fromEntries(boardPolicies.map(p => [p.id, p.id === 'counter-v1' ? 'older' : null])));
  assert.equal(find.mock.callCount(), 1); assert.equal(find.mock.calls[0].arguments[3], 'previous');
  assert.deepEqual(await loadBoardPage(null), { rows: [], cursor: null });
});
test('shared receipt pages are labeled app acceptance and failures remain visible', async () => {
  let requested;
  const fetcher = async url => { requested = url; return { ok: true, json: async () => ({ receipts: [{ id: 'r', owner: 'owner', grantId: 'g', actionId: 'social.like', acceptedAt: 42 }], cursor: 25 }) }; };
  const result = await loadSocialBoardPage(75, 'https://api.test/api/social', fetcher);
  assert.match(requested, /receipts\?limit=50&cursor=75/); assert.equal(result.cursor, 25);
  assert.equal(result.rows[0].status, 'Accepted by app'); assert.equal(result.rows[0].source, 'social');
  await assert.rejects(loadSocialBoardPage(undefined, 'https://api.test', async () => ({ ok: false })), /unavailable/);
});
test('local history reads every stored app and owner with every log, excluding secrets and mismatched accounts', () => {
  const values = new Map();
  for (const owner of ['alice', 'bob']) values.set('pilot:account-activity:v1:' + owner, JSON.stringify(Array.from({ length: 120 }, (_, i) => ({ id: String(i), appId: 'app' + i % 2, ownerAddress: owner, sessionId: 's', name: 'Like', createdAt: i, status: 'signed', privateKey: 'SECRET', logs: [{ at: i, phase: 'sign', message: 'signed' }, { at: i, phase: 'retry', message: 'retried' }] }))));
  values.set('pilot:account-activity:v1:wrong', JSON.stringify([{ ownerAddress: 'alice', logs: [] }]));
  const rows = readLocalBoardActivity({ length: values.size, key: i => [...values.keys()][i], getItem: key => values.get(key) });
  assert.equal(rows.length, 240); assert.equal(new Set(rows.map(r => r.id)).size, 240);
  assert.equal(rows[0].details.logs.length, 2); assert.ok(!JSON.stringify(rows).includes('SECRET'));
});
test('deposit rejects another chain before building or signing', async () => {
  await assert.rejects(buildDeposit({ client: { async getHeaderByNumberNoCache() { return { hash: hash('00') }; } } }, '100'), /CKB testnet/);
});
