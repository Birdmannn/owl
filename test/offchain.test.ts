import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ccc } from '@ckb-ccc/core';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { authorizeOffchain, PilotOffchainSession, verifyOffchainAction, acceptOffchainAction, revokeOffchain, acceptOffchainRevocation,
  offchainGrantMessage, offchainCanonical, validateOffchainManifest, verifyOffchainAuthorization } from '../src/offchain.js';
import { socialManifest } from '../examples/offchain-social.js';
import { JsonSocialStore, createSocialServer } from '../server/offchain-social.js';

const manifest = socialManifest('https://social.pilot.test');
const privateKey = ('0x' + '22'.repeat(32)) as ccc.Hex;
const publicKey = ccc.hexFrom(secp256k1.getPublicKey(ccc.bytesFrom(privateKey), true));
const wallet = (value = '11') => new ccc.SignerCkbPrivateKey(new ccc.ClientPublicTestnet(), `0x${value.repeat(32)}`);
test('a 50-action off-chain catalog signs only a chosen 32 and rejects larger grants before owner approval', async () => {
  const catalog = structuredClone(manifest);
  catalog.actions = Array.from({ length: 50 }, (_, i) => ({ id: `social.action${i}`, name: `Action ${i}`, description: `Perform action ${i}` }));
  validateOffchainManifest(catalog);
  const selected = catalog.actions.slice(-32).map(action => action.id);
  const owner = wallet();
  let calls = 0;
  const sign = owner.signMessage.bind(owner);
  owner.signMessage = async message => { calls++; return sign(message); };
  const options = { selected, sessionPublicKey: publicKey, expiresAt: Date.now() + 60_000 };
  const authorization = await authorizeOffchain(owner, catalog, options);
  const pilot = await PilotOffchainSession.create(authorization, catalog, privateKey);
  await verifyOffchainAction(pilot.sign({ id: 'social.action49', target: 'post', payload: {} }), catalog);
  assert.throws(() => pilot.sign({ id: 'social.action0', target: 'post', payload: {} }), /permission/);
  await assert.rejects(authorizeOffchain(owner, catalog, { ...options, selected: [...selected, 'social.action0'] }), /at most 32/);
  assert.equal(calls, 1);
  const forged = structuredClone(authorization);
  forged.grant.permissions.push('social.action0');
  forged.proof = await owner.signMessage(offchainGrantMessage(forged.grant));
  await assert.rejects(verifyOffchainAuthorization(forged, catalog), /permissions/);
  catalog.actions.push({ id: 'social.action50', name: 'Extra', description: 'Over the catalog limit' });
  assert.throws(() => validateOffchainManifest(catalog), /1–50/);
});
async function setup(selected = ['social.like', 'social.post']) {
  const owner = wallet();
  const authorization = await authorizeOffchain(owner, manifest, { selected, sessionPublicKey: publicKey, expiresAt: Date.now() + 3_600_000 });
  const pilot = await PilotOffchainSession.create(authorization, manifest, privateKey);
  return { owner, authorization, pilot };
}
async function fileStore() {
  const directory = await mkdtemp(join(tmpdir(), 'pilot-social-'));
  const store = new JsonSocialStore(join(directory, 'social.json')); await store.init();
  return { store, directory, close: () => rm(directory, { recursive: true, force: true }) };
}
test('off-chain owner approves once, session signs selected actions with no further owner calls', async () => {
  const owner = wallet(); let calls = 0;
  const sign = owner.signMessage.bind(owner); owner.signMessage = async message => { calls++; return sign(message); };
  const authorization = await authorizeOffchain(owner, manifest, { selected: ['social.like'], sessionPublicKey: publicKey, expiresAt: Date.now() + 60_000 });
  assert.match(offchainGrantMessage(authorization.grant), /does not authorize CKB transactions/);
  const pilot = await PilotOffchainSession.create(authorization, manifest, privateKey);
  const one = pilot.sign({ id: 'social.like', target: 'pilot-introduction', payload: { enabled: true } });
  const two = pilot.sign({ id: 'social.like', target: 'pilot-introduction', payload: { enabled: false } });
  await verifyOffchainAction(one, manifest); await verifyOffchainAction(two, manifest);
  assert.notEqual(one.action.nonce, two.action.nonce); assert.equal(calls, 1);
  assert.throws(() => pilot.sign({ id: 'social.follow', target: 'owl', payload: { enabled: true } }), /permission/);
  await assert.rejects(authorizeOffchain(owner, manifest, { selected: [], sessionPublicKey: publicKey, expiresAt: Date.now() + 60_000 }), /permissions/);
  assert.equal(calls, 1);
});
test('off-chain verification rejects changed scope, owner, permission, payload, target, signature, and key', async () => {
  const { pilot, authorization, owner } = await setup();
  const envelope = pilot.sign({ id: 'social.like', target: 'pilot-introduction', payload: { enabled: true } });
  await assert.rejects(verifyOffchainAction(envelope, socialManifest('https://other.pilot.test')), /another app/);
  const changedLabel = structuredClone(manifest); changedLabel.actions[0]!.name = 'Transfer funds';
  await assert.rejects(verifyOffchainAction(envelope, changedLabel), /another app/);
  for (const change of [
    (v: typeof envelope) => { v.action.target = 'other-post'; },
    (v: typeof envelope) => { v.action.payload = { enabled: false }; },
    (v: typeof envelope) => { v.authorization.grant.permissions.push('social.follow'); },
    (v: typeof envelope) => { v.action.audience = 'https://evil.test'; },
    (v: typeof envelope) => { v.signature = ('0x' + '00'.repeat(64)) as ccc.Hex; },
  ]) {
    const value = structuredClone(envelope); change(value); await assert.rejects(verifyOffchainAction(value, manifest));
  }
  const spoof = structuredClone(authorization);
  spoof.grant.owner.ownerAddress = await wallet('33').getRecommendedAddress();
  spoof.proof = await owner.signMessage(offchainGrantMessage(spoof.grant));
  await assert.rejects(PilotOffchainSession.create(spoof, manifest, privateKey), /does not control/);
  await assert.rejects(PilotOffchainSession.create(authorization, manifest, ('0x' + '33'.repeat(32)) as ccc.Hex), /key does not match/);
});
test('off-chain expiry, canonical payloads, and insecure audience are enforced', async () => {
  const { pilot, authorization } = await setup();
  const envelope = pilot.sign({ id: 'social.like', target: 'pilot-introduction', payload: { enabled: true } });
  await assert.rejects(verifyOffchainAction(envelope, manifest, envelope.action.expiresAt), /expired/);
  await assert.rejects(PilotOffchainSession.create(authorization, manifest, privateKey, () => authorization.grant.expiresAt), /expired/);
  assert.throws(() => validateOffchainManifest(socialManifest('http://social.example')), /HTTPS/);
  assert.throws(() => validateOffchainManifest(socialManifest('https://social.example/path')), /origin/);
  for (const invalid of [undefined, BigInt(1), NaN, new Date(), { absent: undefined }]) assert.throws(() => offchainCanonical(invalid));
  assert.equal(offchainCanonical({ z: 1, a: { c: 2, b: true } }), '{"a":{"b":true,"c":2},"z":1}');
});
test('server store accepts exact retries once across concurrent instances and rejects nonce reuse', async () => {
  const f = await fileStore();
  try {
    const { pilot } = await setup(); const other = new JsonSocialStore(f.store.file); await other.init();
    const envelope = pilot.sign({ id: 'social.post', target: 'pilot-feed', payload: { text: 'Hello from Pilot' } }, { nonce: 'unique-post-nonce' });
    const receipts = await Promise.all([f.store, other, f.store].map(store => acceptOffchainAction(envelope, { manifest, store })));
    assert.equal(new Set(receipts.map(receipt => receipt.id)).size, 1);
    assert.equal((await other.read()).posts.length, 1);
    const conflicting = pilot.sign({ id: 'social.post', target: 'pilot-feed', payload: { text: 'A different post' } }, { nonce: envelope.action.nonce });
    await assert.rejects(acceptOffchainAction(conflicting, { manifest, store: other }), /nonce is already used/);
    assert.equal((await other.read()).posts.length, 1);
  } finally { await f.close(); }
});
test('owner-signed revocation persists across restart and blocks previously signed actions', async () => {
  const f = await fileStore();
  try {
    const { owner, pilot, authorization } = await setup();
    const envelope = pilot.sign({ id: 'social.like', target: 'pilot-introduction', payload: { enabled: true } });
    const revocation = await revokeOffchain(owner, authorization, manifest);
    const bad = structuredClone(revocation); bad.request.grantId = 'other-grant';
    await assert.rejects(acceptOffchainRevocation(bad, { manifest, store: f.store }));
    await assert.rejects(revokeOffchain(wallet('33'), authorization, manifest), /owner/);
    await acceptOffchainRevocation(revocation, { manifest, store: f.store });
    const restarted = new JsonSocialStore(f.store.file); await restarted.init();
    await assert.rejects(acceptOffchainAction(envelope, { manifest, store: restarted }), /revoked/);
    await acceptOffchainRevocation(revocation, { manifest, store: restarted });
    assert.equal((await restarted.read()).revoked.length, 1);
    assert.equal((await restarted.read()).likes.length, 0);
  } finally { await f.close(); }
});
test('social HTTP verifier enforces origin, signatures, business rules, replay and persistent receipts', async () => {
  const f = await fileStore(); const server = createSocialServer({ store: f.store, audience: manifest.audience });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/social`;
  const post = (value: unknown, origin = manifest.audience) => fetch(url + '/actions', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(value) });
  try {
    const { pilot } = await setup();
    const envelope = pilot.sign({ id: 'social.like', target: 'pilot-introduction', payload: { enabled: true } });
    assert.equal((await post(envelope, 'https://evil.test')).status, 403);
    assert.equal((await post(envelope)).status, 200); assert.equal((await post(envelope)).status, 200);
    const invalid = pilot.sign({ id: 'social.like', target: 'other', payload: { enabled: true } });
    assert.equal((await post(invalid)).status, 400);
    const data = await (await fetch(url + '/state')).json(); assert.equal(data.likes.length, 1); assert.equal(data.receipts.length, 1);
    assert.ok(!JSON.stringify(data).includes(privateKey));
    for (const enabled of [false, true]) assert.equal((await post(pilot.sign({ id: 'social.like', target: 'pilot-introduction', payload: { enabled } }))).status, 200);
    const history = await fetch(url + '/receipts?limit=2', { headers: { Origin: 'https://docs.pilot.test' } });
    assert.equal(history.status, 200); assert.equal(history.headers.get('access-control-allow-origin'), '*');
    const first = await history.json(); assert.equal(first.receipts.length, 2); assert.equal(first.cursor, 1);
    const second = await (await fetch(url + '/receipts?limit=2&cursor=' + first.cursor)).json();
    assert.equal(second.receipts.length, 1); assert.equal(second.cursor, null);
    assert.equal(new Set([...first.receipts, ...second.receipts].map(r => r.id)).size, 3);
    for (const query of ['limit=0', 'limit=101', 'cursor=-1', 'cursor=1.2', 'cursor=999', 'limit=2x']) assert.equal((await fetch(url + '/receipts?' + query)).status, 400);
    assert.equal((await post(envelope, 'https://docs.pilot.test')).status, 403);

  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await f.close(); }
});

test('grant content commitment prevents another owner colliding with a public grant ID to revoke it', async () => {
  const f = await fileStore();
  try {
    const victim = await setup(); const attacker = wallet('33');
    const forged = await authorizeOffchain(attacker, manifest, { selected: ['social.like'], sessionPublicKey: publicKey, expiresAt: Date.now() + 60_000 });
    forged.grant.id = victim.authorization.grant.id;
    forged.proof = await attacker.signMessage(offchainGrantMessage(forged.grant));
    const revoke = await revokeOffchain(attacker, forged, manifest);
    await acceptOffchainRevocation(revoke, { manifest, store: f.store });
    const envelope = victim.pilot.sign({ id: 'social.like', target: 'pilot-introduction', payload: { enabled: true } });
    await acceptOffchainAction(envelope, { manifest, store: f.store });
    assert.equal((await f.store.read()).likes.length, 1);
    assert.notEqual(revoke.request.grantId, envelope.action.grantId);
  } finally { await f.close(); }
});

test('restoring a valid session under another connected wallet is rejected before signing', async () => {
  const { authorization, owner } = await setup();
  const address = await owner.getRecommendedAddress();
  await PilotOffchainSession.create(authorization, manifest, privateKey, Date.now, address);
  await assert.rejects(PilotOffchainSession.create(authorization, manifest, privateKey, Date.now, await wallet('33').getRecommendedAddress()), /another connected wallet/);
});
