import { PILOT_ACCOUNT_CODE_HASH } from '../src/ckb/account-code.js';
import { PILOT_PASSKEY_CODE_HASH, PILOT_WALLET_SESSION_CODE_HASH } from '../src/wallet/code.js';
import { ccc } from '@ckb-ccc/core';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import lockfile from 'proper-lockfile';
import { SPONSORED_COUNTER_CODE_HASH, SPONSORED_DELEGATION_CODE_HASH } from '../src/ckb/sponsored-code.js';
import { verifyDeployment, type Deployment } from '../src/ckb/counter.js';
import poolConfiguration from '../deployments/owl-paymaster.json' with { type: 'json' };

let secret = process.env.PILOT_DEPLOYER_PRIVATE_KEY;
if (!secret) {
  let account: { version: number; network: string; privateKey: ccc.Hex };
  try { account = JSON.parse(await readFile(resolve('.pilot/sponsored/deployer.json'), 'utf8')); }
  catch { throw new Error('Run npm run paymaster:account and fund its testnet address, or set server-only PILOT_DEPLOYER_PRIVATE_KEY.'); }
  if (account.version !== 1 || account.network !== 'ckb-testnet') throw new Error('Invalid local deployer account');
  secret = account.privateKey;
}
const selected = process.argv[2] ?? 'both';
if (!['counter', 'delegation', 'account', 'passkey', 'walletSession', 'wallet', 'both'].includes(selected)) throw new Error('Use npm run paymaster:deploy -- counter|delegation|account|passkey|walletSession|wallet|both');
const client = new ccc.ClientPublicTestnet({ url: process.env.PILOT_PAYMASTER_RPC ?? 'https://testnet.ckb.dev' });
const genesisHash = (await client.getHeaderByNumberNoCache(0))?.hash;
if (genesisHash !== '0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606') throw new Error('Deployment requires CKB testnet');
const signer = new ccc.SignerCkbPrivateKey(client, secret as ccc.Hex);
const owner = (await signer.getRecommendedAddressObj()).script;
const pool = (await ccc.Address.fromString(process.env.PILOT_PAYMASTER_ADDRESS ?? poolConfiguration.address, client)).script;
const directory = resolve('.pilot/sponsored'); await mkdir(directory, { recursive: true, mode: 0o700 });
// A revised owner binary must not reuse the previous wallet deployment's signed bytes.
const revision = ['wallet', 'passkey'].includes(selected) ? '-' + PILOT_PASSKEY_CODE_HASH.slice(2, 14) : '';
const journalFile = directory + '/deployment-' + selected + revision + '.json';
try { await writeFile(journalFile, '{}', { flag: 'wx', mode: 0o600 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
const configFile = resolve('deployments/pilot-sponsored.json');
const release = await lockfile.lock(configFile);
try {
  const config = JSON.parse(await readFile(configFile, 'utf8')) as { counter: Deployment | null; delegation: Deployment | null; account?: Deployment | null; passkey?:Deployment|null; walletSession?:Deployment|null; poolLock?: ccc.ScriptLike; status: string };
  if (config.poolLock && !pool.eq(config.poolLock)) throw new Error('Configured sponsored pool differs from receiving address; review configuration before deployment');
  const specs = [
    { kind: 'counter' as const, file: 'pilot-sponsored-session-lock', hash: SPONSORED_COUNTER_CODE_HASH },
    { kind: 'delegation' as const, file: 'pilot-sponsored-delegation-lock', hash: SPONSORED_DELEGATION_CODE_HASH },
    { kind: 'account' as const, file: 'pilot-account-lock', hash: PILOT_ACCOUNT_CODE_HASH },
    { kind: 'passkey' as const, file: 'pilot-passkey-lock', hash: PILOT_PASSKEY_CODE_HASH },
    { kind: 'walletSession' as const, file: 'pilot-wallet-session-lock', hash: PILOT_WALLET_SESSION_CODE_HASH },
  ].filter(spec => (selected === 'both' && ['counter','delegation'].includes(spec.kind)) || (selected==='wallet' && ['passkey','walletSession'].includes(spec.kind)) || selected === spec.kind);
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
      await tx.completeInputsByCapacity(signer);
      await tx.completeFee(signer, (candidate, capacity) => {
        // Preserve sub-minimum change in the deployer-owned code cell instead
        // of requiring another top-up or paying the remainder as a fee.
        if (capacity < ccc.fixedPointFrom(61)) candidate.outputs[0]!.capacity += capacity;
        else candidate.addOutput({ lock: owner, capacity });
        return 0n;
      }, 1000n);
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
