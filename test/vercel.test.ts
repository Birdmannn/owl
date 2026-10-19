import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type RequestListener } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVercelHandler } from '../server/vercel.js';
import { createSocialHandler, JsonSocialStore } from '../server/offchain-social.js';
import { databaseUrl } from '../server/postgres.js';
import { readJson } from '../server/http.js';
import { serverlessHandler } from '../server/runtime.js';
import { ccc } from '@ckb-ccc/core';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { authorizeOffchain, PilotOffchainSession } from '../src/offchain.js';
import { socialManifest } from '../examples/offchain-social.js';

test('Vercel adapter routes rewritten URLs, accepts parsed bodies, preserves receipt pagination and rejects foreign origins', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pilot-vercel-'));
  const store = new JsonSocialStore(join(directory, 'social.json')); await store.init();
  const audience = 'https://demo.pilot.test', manifest = socialManifest(audience);
  const loads: string[] = [];
  const handler = createVercelHandler(async service => {
    loads.push(service); assert.equal(service, 'social'); return createSocialHandler({ store, audience });
  });
  // Vercel may consume the stream and provide request.body before invoking the exported handler.
  const server = createServer(async (req, res) => {
    if (req.method === 'POST') {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      (req as IncomingMessage & { body: unknown }).body = JSON.parse(Buffer.concat(chunks).toString());
    }
    await handler(req, res);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const owner = new ccc.SignerCkbPrivateKey(new ccc.ClientPublicTestnet(), `0x${'11'.repeat(32)}`);
  const privateKey = `0x${'22'.repeat(32)}` as ccc.Hex;
  const authorization = await authorizeOffchain(owner, manifest, { selected: ['social.post'], sessionPublicKey: ccc.hexFrom(secp256k1.getPublicKey(ccc.bytesFrom(privateKey), true)), expiresAt: Date.now() + 60_000 });
  const pilot = await PilotOffchainSession.create(authorization, manifest, privateKey);
  for (const text of ['First', 'Second']) {
    const action = pilot.sign({ id: 'social.post', target: 'pilot-feed', payload: { text } });
    const response = await fetch(base + '/api/index?pilotRoute=social/actions', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: audience }, body: JSON.stringify(action) });
    assert.equal(response.status, 200, await response.text());
  }
  const page = await fetch(base + '/api/index?pilotRoute=social/receipts&limit=1');
  assert.equal(page.status, 200); const data = await page.json();
  assert.equal(data.receipts.length, 1); assert.equal(data.receipts[0].payload.text, 'Second'); assert.equal(data.cursor, 1);
  assert.equal((await fetch(base + '/api/index?pilotRoute=social/state', { headers: { Origin: 'https://evil.test' } })).status, 403);
  assert.equal((await fetch(base + '/api/social/state')).status, 200);
  assert.equal((await fetch(base + '/api/index?pilotRoute=unknown/foo')).status, 404);
  assert.equal((await fetch(base + '/api/index?pilotRoute=social/state&pilotRoute=paymaster/status')).status, 400);
  assert.deepEqual(loads, ['social']);
});

test('Vercel cold-start failures are sanitized and retryable rather than caching a rejected initialization', async t => {
  let loads = 0;
  const handler = createVercelHandler(async () => {
    if (++loads === 1) throw new Error('postgresql://secret-password@private-host');
    return ((_req, res) => { res.end(JSON.stringify({ ok: true })); }) satisfies RequestListener;
  });
  const server = createServer(handler); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/pilot/health`;
  const failed = await fetch(url); assert.equal(failed.status, 503); assert.doesNotMatch(await failed.text(), /secret|private-host|postgresql/);
  const retried = await fetch(url); assert.equal(retried.status, 200); assert.deepEqual(await retried.json(), { ok: true });
});

test('serverless requires PostgreSQL and explicit canonical origin; parsed request bodies retain byte limits', async () => {
  const oldApps = process.env.PILOT_APP_ORIGINS;
  const oldPostgres = process.env.POSTGRES_URL;
  const oldDatabase = process.env.DATABASE_URL, oldOrigin = process.env.PILOT_APP_ORIGIN;
  try {
    delete process.env.DATABASE_URL; delete process.env.POSTGRES_URL; delete process.env.PILOT_APP_ORIGINS;
    await assert.rejects(serverlessHandler('pilot'), /requires DATABASE_URL/);
    process.env.DATABASE_URL = 'postgresql://unused'; delete process.env.PILOT_APP_ORIGIN;
    await assert.rejects(serverlessHandler('social'), /PILOT_APP_ORIGINS/);
  } finally {
    if (oldApps === undefined) delete process.env.PILOT_APP_ORIGINS; else process.env.PILOT_APP_ORIGINS = oldApps;
    if (oldPostgres === undefined) delete process.env.POSTGRES_URL; else process.env.POSTGRES_URL = oldPostgres;
    if (oldDatabase === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = oldDatabase;
    if (oldOrigin === undefined) delete process.env.PILOT_APP_ORIGIN; else process.env.PILOT_APP_ORIGIN = oldOrigin;
  }
  const request = (body: unknown) => ({ body }) as unknown as IncomingMessage;
  assert.deepEqual(await readJson(request({ text: 'hello' }), 100), { text: 'hello' });
  assert.deepEqual(await readJson(request(Buffer.from('{"value":1}')), 100), { value: 1 });
  await assert.rejects(readJson(request({ text: '🦉'.repeat(30) }), 100), /too large/);
  await assert.rejects(readJson(request('{broken'), 100), SyntaxError);
});

test('database configuration accepts Vercel POSTGRES_URL with explicit DATABASE_URL precedence', () => {
  assert.equal(databaseUrl({ POSTGRES_URL: 'postgresql://vercel' }), 'postgresql://vercel');
  assert.equal(databaseUrl({ DATABASE_URL: 'postgresql://explicit', POSTGRES_URL: 'postgresql://vercel' }), 'postgresql://explicit');
  assert.equal(databaseUrl({ DATABASE_URL: '', POSTGRES_URL: 'postgresql://vercel' }), '', 'explicit empty configuration must not silently select a different database');
  assert.equal(databaseUrl({}), undefined);
});
