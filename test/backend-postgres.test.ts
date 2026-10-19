import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { ccc } from '@ckb-ccc/core';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { PilotPaymaster, PostgresPaymasterStore } from '../server/paymaster.js';
import { PostgresSocialStore } from '../server/offchain-social.js';
import { PostgresRateLimiter } from '../server/http.js';
import { postgresPool } from '../server/postgres.js';
import { socialManifest } from '../examples/offchain-social.js';
import { authorizeOffchain, PilotOffchainSession, acceptOffchainAction, revokeOffchain, acceptOffchainRevocation } from '../src/offchain.js';
import { SPONSORED_COUNTER_CODE_HASH, counterLock, encodeCounterData, signCounterTransaction, type Deployment } from '../src/index.js';

const databaseUrl = process.env.PILOT_TEST_DATABASE_URL;
const hash = (n: number) => ccc.hexFrom(new Uint8Array(32).fill(n));
async function database(t: TestContext) {
  const admin = new pg.Client({ connectionString: databaseUrl }); await admin.connect();
  const schema = `pilot_backend_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(databaseUrl!); url.searchParams.set('options', `-c search_path=${schema}`);
  t.after(async () => { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  return url.toString();
}
const skip = databaseUrl ? false : 'Set PILOT_TEST_DATABASE_URL to test real PostgreSQL transactions';

test('PostgreSQL paymaster serializes competing instances, persists before broadcast, rolls back rejection and retries exact bytes', { skip }, async t => {
  const url = await database(t);
  const client = new ccc.ClientPublicTestnet();
  const signer = new ccc.SignerCkbPrivateKey(client, hash(1));
  const pool = (await signer.getRecommendedAddressObj()).script;
  const owner = (await new ccc.SignerCkbPrivateKey(client, hash(3)).getRecommendedAddressObj()).script;
  const deployment: Deployment = { network: 'testnet', genesisHash: hash(8), codeHash: SPONSORED_COUNTER_CODE_HASH, outPoint: { txHash: hash(9), index: 0 } };
  const lock = counterLock(deployment, owner, secp256k1.getPublicKey(ccc.bytesFrom(hash(2)), true), 100_000n, ccc.fixedPointFrom(200), pool);
  const app = ccc.Cell.from({ outPoint: { txHash: hash(4), index: 0 }, cellOutput: { lock, capacity: ccc.fixedPointFrom(200) }, outputData: encodeCounterData(2_000_000n, 0n) });
  const funding = ccc.Cell.from({ outPoint: { txHash: hash(5), index: 0 }, cellOutput: { lock: pool, capacity: ccc.fixedPointFrom(100) }, outputData: '0x' });
  const cells = [app, funding];
  t.mock.method(client, 'getCell', async (point: ccc.OutPointLike) => cells.find(c => c.outPoint.eq(point)));
  t.mock.method(client, 'getCellLive', async (point: ccc.OutPointLike) => cells.find(c => c.outPoint.eq(point)));
  t.mock.method(client, 'findCellsByLock', async function* () { yield funding; });
  t.mock.method(client, 'getTransactionNoCache', async () => undefined);
  let rejectSignature = true, failSend = true; const sent: string[] = [];
  t.mock.method(client, 'estimateCycles', async () => { if (rejectSignature) throw new Error('Invalid signature'); return 1000n; });
  const a = new PostgresPaymasterStore(url, pool.hash()), b = new PostgresPaymasterStore(url, pool.hash());
  t.after(async () => { await a.close(); await b.close(); });
  await Promise.all([a.init(), b.init()]); // Simultaneous cold-start DDL must also be safe.
  t.mock.method(client, 'sendTransaction', async (tx: ccc.Transaction) => {
    const bytes = ccc.hexFrom(tx.toBytes());
    assert.ok((await b.journal.read()).records.some(r => r.bytes === bytes), 'committed exact bytes before network broadcast');
    sent.push(bytes); if (failSend) throw new Error('Lost response'); return tx.hash();
  });
  const options = { signer, maxFee: 100_000n, feeRate: 1000n, dailyBudget: 1_000_000n, ownerDailyBudget: 1_000_000n, allowedCodeHashes: [SPONSORED_COUNTER_CODE_HASH] as const };
  const first = await PilotPaymaster.create({ ...options, store: a }), second = await PilotPaymaster.create({ ...options, store: b });
  const base = ccc.Transaction.from({ inputs: [{ previousOutput: app.outPoint }], outputs: [app.cellOutput.clone()], outputsData: [encodeCounterData(1_900_000n, 1n)] });
  const quote = await first.quote(ccc.hexFrom(base.toBytes()));
  const changed = base.clone(); changed.outputsData[0] = encodeCounterData(1_900_000n, 2n);
  const competing = await second.quote(ccc.hexFrom(changed.toBytes()));
  const signed = ccc.hexFrom(signCounterTransaction(ccc.Transaction.fromBytes(quote.bytes), hash(2)).toBytes());
  await assert.rejects(first.submit(quote.id, signed), /Invalid signature/);
  assert.equal((await b.journal.read()).records.filter(r => r.bytes).length, 0);
  rejectSignature = false;
  const competingBytes = ccc.hexFrom(signCounterTransaction(ccc.Transaction.fromBytes(competing.bytes), hash(2)).toBytes());
  const competition = await Promise.allSettled([first.submit(quote.id, signed), second.submit(competing.id, competingBytes)]);
  assert.equal(competition.filter(r => r.status === 'rejected' && /Lost response/.test(String(r.reason))).length, 1);
  assert.equal(competition.filter(r => r.status === 'rejected' && /Requote/.test(String(r.reason))).length, 1);
  const winner = (await b.journal.read()).records.find(r => r.bytes)!;
  const winnerBytes = winner.quote.id === quote.id ? signed : competingBytes;
  failSend = false;
  const retries = await Promise.all([second.submit(winner.quote.id, winnerBytes), first.submit(winner.quote.id, winnerBytes)]);
  assert.equal(new Set(retries.map(tx => ccc.hexFrom(tx.toBytes()))).size, 1);
  assert.equal(new Set(sent).size, 1);
  assert.equal((await b.journal.read()).records.filter(r => r.bytes).length, 1);

  // Different live pool inputs still share one budget lock across function instances.
  const anotherFunding = funding.clone(); anotherFunding.outPoint = ccc.OutPoint.from({ txHash: hash(6), index: 0 }); cells.push(anotherFunding);
  t.mock.method(client, 'findCellsByLock', async function* () { yield anotherFunding; });
  const next = await second.quote(ccc.hexFrom(changed.toBytes()));
  const capped = await PilotPaymaster.create({ ...options, store: b, dailyBudget: BigInt(quote.fee) });
  await assert.rejects(capped.submit(next.id, ccc.hexFrom(signCounterTransaction(ccc.Transaction.fromBytes(next.bytes), hash(2)).toBytes())), /allowance exhausted/);
  assert.equal((await b.journal.read()).records.filter(r => r.bytes).length, 1);
});

test('PostgreSQL social actions preserve replay checks, revocations and audience isolation across instances', { skip }, async t => {
  const url = await database(t), audience = 'https://social.pilot.test';
  const a = new PostgresSocialStore(url, audience), b = new PostgresSocialStore(url, audience), other = new PostgresSocialStore(url, 'https://other.pilot.test');
  t.after(async () => { await a.close(); await b.close(); await other.close(); });
  await Promise.all([a.init(), b.init(), other.init()]);
  const manifest = socialManifest(audience);
  const owner = new ccc.SignerCkbPrivateKey(new ccc.ClientPublicTestnet(), hash(1));
  const privateKey = hash(2), sessionPublicKey = ccc.hexFrom(secp256k1.getPublicKey(ccc.bytesFrom(privateKey), true));
  const authorization = await authorizeOffchain(owner, manifest, { selected: ['social.post'], sessionPublicKey, expiresAt: Date.now() + 60_000 });
  const pilot = await PilotOffchainSession.create(authorization, manifest, privateKey);
  const envelope = pilot.sign({ id: 'social.post', target: 'pilot-feed', payload: { text: 'Persist once' } }, { nonce: 'database-retry' });
  const results = await Promise.all([a, b, a].map(store => acceptOffchainAction(envelope, { manifest, store })));
  assert.equal(new Set(results.map(r => r.id)).size, 1);
  assert.equal((await b.read()).posts.length, 1);
  assert.equal((await other.read()).posts.length, 0);
  const changed = pilot.sign({ id: 'social.post', target: 'pilot-feed', payload: { text: 'Conflicting replay' } }, { nonce: 'database-retry' });
  await assert.rejects(acceptOffchainAction(changed, { manifest, store: b }), /nonce/);
  const revoke = await revokeOffchain(owner, authorization, manifest);
  await acceptOffchainRevocation(revoke, { manifest, store: a });
  await assert.rejects(acceptOffchainAction(envelope, { manifest, store: b }), /revoked/);
  assert.equal((await b.read()).revoked.length, 1);
  assert.equal((await b.read()).receipts.length, 1);
});

test('PostgreSQL row mutations roll back and rate limits are shared across cold instances', { skip }, async t => {
  const url = await database(t);
  const a = new PostgresPaymasterStore(url, hash(1)), b = new PostgresPaymasterStore(url, hash(1));
  const limiterA = new PostgresRateLimiter(postgresPool(url)), limiterB = new PostgresRateLimiter(postgresPool(url));
  t.after(async () => { await a.close(); await b.close(); await limiterA.pool.end(); await limiterB.pool.end(); });
  await Promise.all([a.init(), b.init(), limiterA.init(), limiterB.init()]);
  await assert.rejects(a.exclusive(async data => { data.version = 1; data.records.push({} as never); throw new Error('abort'); }), /abort/);
  assert.deepEqual((await b.journal.read()).records, []);
  const outcomes = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? limiterA : limiterB).allow('paymaster:ip', 7)));
  assert.equal(outcomes.filter(Boolean).length, 7);
  assert.equal(await limiterB.allow('registry:ip', 7), true);
});

test('real serverless runtime initializes PostgreSQL registry/social handlers without a pool key and fails closed for paymaster', { skip }, async t => {
  const { createServer } = await import('node:http');
  const { createVercelHandler } = await import('../server/vercel.js');
  const { rateLimiterFromEnvironment } = await import('../server/runtime.js');
  const url = await database(t), audience = 'https://hosted.pilot.test';
  const names = ['DATABASE_URL', 'POSTGRES_URL', 'PILOT_APP_ORIGIN', 'PILOT_PAYMASTER_PRIVATE_KEY', 'PILOT_SOCIAL_AUDIENCE', 'PILOT_REGISTRY_ORIGIN', 'PILOT_REGISTRY_ALLOWED_ORIGINS'];
  const saved = new Map(names.map(name => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  process.env.POSTGRES_URL = url; process.env.PILOT_APP_ORIGIN = audience;
  const server = createServer(createVercelHandler());
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    const limiter = await rateLimiterFromEnvironment(); if (limiter instanceof PostgresRateLimiter) await limiter.pool.end();
    for (const [name, value] of saved) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const health = await fetch(base + '/api/index?pilotRoute=pilot/health'); assert.equal(health.status, 200);
  const owner = new ccc.SignerCkbPrivateKey(new ccc.ClientPublicTestnet(), hash(7));
  const send = (path: string, body: unknown) => fetch(base + '/api/index?pilotRoute=' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: audience }, body: JSON.stringify(body) });
  const challengeResponse = await send('pilot/challenges', { username: 'serverless_user', ownerAddress: await owner.getRecommendedAddress(), identity: await owner.getIdentity(), signType: owner.signType });
  assert.equal(challengeResponse.status, 201); const challenge = await challengeResponse.json();
  assert.match(challenge.message, /Registry: https:\/\/hosted.pilot.test/);
  const claimed = await send('pilot/usernames', { challengeId: challenge.id, signature: await owner.signMessage(challenge.message) });
  assert.equal(claimed.status, 201);
  const resolved = await (await fetch(base + '/api/pilot/usernames/serverless_user')).json(); assert.equal(resolved.ownerAddress, await owner.getRecommendedAddress());
  const manifest = await (await fetch(base + '/api/social/manifest')).json(); assert.equal(manifest.audience, audience);
  const privateKey = hash(9), authorization = await authorizeOffchain(owner, manifest, { selected: ['social.post'], sessionPublicKey: ccc.hexFrom(secp256k1.getPublicKey(ccc.bytesFrom(privateKey), true)), expiresAt: Date.now() + 60_000 });
  const pilot = await PilotOffchainSession.create(authorization, manifest, privateKey);
  const action = pilot.sign({ id: 'social.post', target: 'pilot-feed', payload: { text: 'Shared hosted post' } });
  assert.equal((await send('social/actions', action)).status, 200);
  const state = await (await fetch(base + '/api/social/state')).json(); assert.equal(state.posts[0].text, 'Shared hosted post');
  const unavailable = await fetch(base + '/api/paymaster/status'); assert.equal(unavailable.status, 503);
  assert.doesNotMatch(await unavailable.text(), /PRIVATE_KEY|postgresql|password/);
});
