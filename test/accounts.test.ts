import test from 'node:test';
import assert from 'node:assert/strict';
import { ccc } from '@ckb-ccc/core';
import { assertPilotAccount, pilotAccountFromSigner, pilotAccountsKey, readPilotAccounts, rememberPilotAccount } from '../src/accounts.js';
const wallet = (byte: string) => new ccc.SignerCkbPrivateKey(new ccc.ClientPublicTestnet(), `0x${byte.repeat(32)}`);
function storage() { const data = new Map<string,string>(); return { getItem: (key:string) => data.get(key) ?? null, setItem: (key:string,value:string) => { data.set(key,value); } }; }
test('account history keeps multiple users from one wallet, deduplicates reconnects, and isolates networks', async () => {
  const store = storage(), a = await pilotAccountFromSigner(wallet('11'), 'ckb-testnet', 'Same Wallet'), b = await pilotAccountFromSigner(wallet('22'), 'ckb-testnet', 'Same Wallet');
  rememberPilotAccount(store, a); rememberPilotAccount(store, b); rememberPilotAccount(store, { ...a, lastConnectedAt: b.lastConnectedAt + 1 });
  const rows = readPilotAccounts(store, 'ckb-testnet'); assert.equal(rows.length, 2); assert.notEqual(a.id, b.id); assert.equal(rows[0]!.id, a.id);
  assert.equal(readPilotAccounts(store, 'ckb-mainnet').length, 0);
  rememberPilotAccount(store, { ...a, privateKey: 'SECRET' } as typeof a);
  assert.ok(!store.getItem(pilotAccountsKey)!.includes('SECRET'));
});
test('stored hints cannot activate a different wallet identity', async () => {
  const a = wallet('11'), b = wallet('22'); const expected = await pilotAccountFromSigner(a, 'ckb-testnet', 'Same Wallet');
  await assertPilotAccount(a, expected); await assert.rejects(assertPilotAccount(b, expected), /different account/);
  const fakeAddress = { ...expected, address: await b.getRecommendedAddress() };
  await assert.rejects(assertPilotAccount(a, fakeAddress), /different account/);
  // Canonical account IDs are derived from the live signer. Selection returns live metadata, never the stored address.
  assert.notEqual((await pilotAccountFromSigner(b, fakeAddress.network, fakeAddress.walletName)).id, fakeAddress.id);
});
test('malformed account storage fails explicitly rather than overwriting history', async () => {
  const store = storage(); store.setItem(pilotAccountsKey, '{}');
  assert.throws(() => readPilotAccounts(store, 'ckb-testnet'), /Invalid saved/);
  await assert.rejects(async () => rememberPilotAccount(store, await pilotAccountFromSigner(wallet('11'), 'ckb-testnet', 'Wallet')), /Invalid saved/);
  assert.equal(store.getItem(pilotAccountsKey), '{}');
});
