import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { ccc } from '@ckb-ccc/core';
import { decodeCounterData } from '../src/index.js';
import type { Deployment } from '../src/index.js';
const proof = JSON.parse(await readFile('deployments/testnet.json', 'utf8')) as {
  deployment: Deployment;
  authorization: ccc.Hex;
  moves: ccc.Hex[];
  revocation: ccc.Hex;
};
const client = new ccc.ClientPublicTestnet({ url: 'https://testnet.ckb.dev', fallbacks: [] });
const genesis = await client.getHeaderByNumberNoCache(0);
assert.equal(genesis?.hash, proof.deployment.genesisHash);
const code = await client.getCellLive(proof.deployment.outPoint, true);
assert.ok(code, 'Shared deployment cell must remain live');
assert.equal(ccc.hashCkb(code.outputData), proof.deployment.codeHash);
const authorization = await client.getTransactionNoCache(proof.authorization);
assert.equal(authorization?.status, 'committed');
assert.deepEqual(decodeCounterData(authorization!.transaction.outputsData[0]!), { position: 0n, budget: 300_000n });
for (const [index, hash] of proof.moves.entries()) {
  const transaction = await client.getTransactionNoCache(hash);
  assert.equal(transaction?.status, 'committed');
  assert.equal(transaction!.transaction.inputs.length, 1);
  assert.equal(transaction!.transaction.outputs.length, 1);
  assert.deepEqual(decodeCounterData(transaction!.transaction.outputsData[0]!), {
    position: BigInt(index + 1), budget: 300_000n - BigInt(index + 1) * 100_000n,
  });
}
const revocation = await client.getTransactionNoCache(proof.revocation);
assert.equal(revocation?.status, 'committed');
assert.equal(await client.getCellLive({ txHash: proof.moves.at(-1)!, index: 0 }, true), undefined);
console.log('Verified public testnet deployment, owner authorization, two session moves, budgets, and revocation.');
