import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { ccc } from '@ckb-ccc/core';
import { PostgresRegistryStore } from '../server/registry-store.js';
import { verifiedProfile } from '../server/registry.js';

const databaseUrl = process.env.PILOT_TEST_DATABASE_URL;
test('PostgreSQL registry preserves unique claims and atomic challenge consumption across instances', {
  skip: databaseUrl ? false : 'Set PILOT_TEST_DATABASE_URL to run against an isolated PostgreSQL schema',
}, async () => {
  const admin = new pg.Client({ connectionString: databaseUrl }); await admin.connect();
  const schema = `pilot_test_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const scoped = new URL(databaseUrl!); scoped.searchParams.set('options', `-c search_path=${schema}`);
  const a = new PostgresRegistryStore(scoped.toString()), b = new PostgresRegistryStore(scoped.toString());
  try {
    await a.init(); await b.init();
    const make = async (key: string, username: string) => {
      const signer = new ccc.SignerCkbPrivateKey(new ccc.ClientPublicTestnet(), `0x${key.repeat(32)}`);
      return { id: randomUUID(), message: 'store verification', expiresAt: Date.now() + 60_000,
        profile: await verifiedProfile({ username, ownerAddress: await signer.getRecommendedAddress(),
          identity: await signer.getIdentity(), signType: signer.signType }, 'ckb-testnet') };
    };
    const first = await make('11', 'database_pilot'), second = await make('22', 'database_pilot');
    await Promise.all([a.challenge(first), b.challenge(second)]);
    const results = await Promise.allSettled([a.claim(first.id), b.claim(second.id)]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    const profile = await a.get('database_pilot'); assert.ok(profile);
    assert.equal((await b.byAddress(profile.ownerAddress))?.username, 'database_pilot');
    const winner = results[0]!.status === 'fulfilled' ? first : second;
    const loser = winner === first ? second : first;
    await assert.rejects(a.claim(winner.id), /expired|already/);
    assert.ok(await b.getChallenge(loser.id), 'Conflicting insert must roll back challenge deletion');
    const third = await make('33', 'other_pilot'); await a.challenge(third); await a.claim(third.id);
    const alias = await make('33', 'another_alias'); await b.challenge(alias);
    await assert.rejects(b.claim(alias.id), /already registered/);
    const expired = await make('44', 'expired_pilot'); expired.expiresAt = 0; await a.challenge(expired);
    assert.equal(await a.getChallenge(expired.id), undefined);
    await assert.rejects(a.claim(expired.id), /expired/);
  } finally {
    await a.close(); await b.close();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
  }
});
