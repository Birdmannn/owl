import { ccc } from '@ckb-ccc/core';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import lockfile from 'proper-lockfile';
import { SPONSORED_COUNTER_CODE_HASH, SPONSORED_DELEGATION_CODE_HASH } from '../src/ckb/sponsored-code.js';
import { verifyDeployment, type Deployment } from '../src/ckb/counter.js';
import poolConfiguration from '../deployments/owl-paymaster.json' with { type: 'json' };

const secret = process.env.PILOT_DEPLOYER_PRIVATE_KEY;
if (!secret) throw new Error('Set server-only PILOT_DEPLOYER_PRIVATE_KEY to the funded testnet deployer; no key is generated automatically.');
const selected = process.argv[2] ?? 'both';
if (!['counter', 'delegation', 'both'].includes(selected)) throw new Error('Use npm run paymaster:deploy -- counter|delegation|both');
const client = new ccc.ClientPublicTestnet({ url: process.env.PILOT_PAYMASTER_RPC ?? 'https://testnet.ckb.dev' });
const genesisHash = (await client.getHeaderByNumberNoCache(0))?.hash;
if (genesisHash !== '0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606') throw new Error('Deployment requires CKB testnet');
const signer = new ccc.SignerCkbPrivateKey(client, secret as ccc.Hex);
const owner = (await signer.getRecommendedAddressObj()).script;
const pool = (await ccc.Address.fromString(process.env.PILOT_PAYMASTER_ADDRESS ?? poolConfiguration.address, client)).script;
const directory = resolve('.pilot/sponsored'); await mkdir(directory, { recursive: true, mode: 0o700 });
const journalFile = directory + '/deployment-' + selected + '.json';
try { await writeFile(journalFile, '{}', { flag: 'wx', mode: 0o600 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
const configFile = resolve('deployments/pilot-sponsored.json');
const release = await lockfile.lock(configFile);
try {
  const config = JSON.parse(await readFile(configFile, 'utf8')) as { counter: Deployment | null; delegation: Deployment | null; poolLock?: ccc.ScriptLike; status: string };
  if (config.poolLock && !pool.eq(config.poolLock)) throw new Error('Configured sponsored pool differs from receiving address; review configuration before deployment');
  const specs = [
    { kind: 'counter' as const, file: 'pilot-sponsored-session-lock', hash: SPONSORED_COUNTER_CODE_HASH },
    { kind: 'delegation' as const, file: 'pilot-sponsored-delegation-lock', hash: SPONSORED_DELEGATION_CODE_HASH },
  ].filter(spec => selected === 'both' || selected === spec.kind);
  const pending = [];
  for (const spec of specs) {
    if (config[spec.kind]) { await verifyDeployment(client, config[spec.kind]!); continue; }
    const code = ccc.hexFrom(await readFile('contracts/build/' + spec.file));
    if (ccc.hashCkb(code) !== spec.hash) throw new Error('Build sponsored contracts first; binary differs from SDK pin');
    pending.push({ ...spec, code });
  }
  if (pending.length) {
    let record = JSON.parse(await readFile(journalFile, 'utf8')) as { bytes?: ccc.Hex };
    let tx: ccc.Transaction;
    if (record.bytes) {
      tx = ccc.Transaction.fromBytes(record.bytes);
      if (pending.some((spec, i) => tx.outputsData[i] !== spec.code || !tx.outputs[i]?.lock.eq(owner))) throw new Error('Saved deployment does not match selected code/deployer; reconcile its original transaction');
    } else {
      tx = ccc.Transaction.from({ outputs: pending.map(() => ({ lock: owner })), outputsData: pending.map(spec => spec.code) });
      console.log('Deploying', pending.map(spec => spec.kind).join(', '), 'with', ccc.fixedPointToString(tx.outputs.reduce((n, output) => n + output.capacity, 0n)), 'CKB code-cell capacity plus the deployment fee.');
      await tx.completeInputsByCapacity(signer); await tx.completeFeeBy(signer, 1000n);
      tx = await signer.signTransaction(tx);
      record = { bytes: ccc.hexFrom(tx.toBytes()) };
      await writeFile(journalFile + '.tmp', JSON.stringify(record), { mode: 0o600 }); await rename(journalFile + '.tmp', journalFile);
    }
    const known = await client.getTransactionNoCache(tx.hash());
    if (!known || known.status === 'unknown' || known.status === 'rejected') await client.sendTransaction(tx);
    if ((await client.waitTransaction(tx.hash(), 1, 180_000))?.status !== 'committed') throw new Error('Deployment not confirmed; retry the same command');
    for (const [i, spec] of pending.entries()) config[spec.kind] = { network: 'testnet', genesisHash, codeHash: spec.hash as ccc.Hex, outPoint: { txHash: tx.hash(), index: i } };
  }
  config.poolLock = { codeHash: pool.codeHash, hashType: pool.hashType, args: pool.args };
  config.status = 'Sponsored code cells deployed; run the pool service and configure the demo URL to activate fee sponsorship.';
  await writeFile(configFile + '.tmp', JSON.stringify(config, null, 2) + '\n'); await rename(configFile + '.tmp', configFile);
  console.log('Verified sponsored deployment configuration:', configFile);
} finally { await release(); }
