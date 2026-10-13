import { ccc } from '@ckb-ccc/core';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { readFile, rename, mkdir, open } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { Pilot, authorizeCounter, buildCounterMove, signCounterTransaction, revokeCounter,
  CkbCounterAdapter, decodeCounterData } from '../src/index.js';
import type { Deployment, SessionCell, Session, SettlementJournal, Journal, CounterState, CounterAction } from '../src/index.js';

class JsonFile<T> {
  constructor(private path: string) {}
  async load(): Promise<T | undefined> {
    try { return JSON.parse(await readFile(this.path, 'utf8')) as T; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
  async save(value: T): Promise<void> {
    const temporary = `${this.path}.tmp`;
    const file = await open(temporary, 'w', 0o600);
    try {
      await file.writeFile(JSON.stringify(value, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2));
      await file.sync();
    } finally { await file.close(); }
    await rename(temporary, this.path);
  }
}
const command = process.argv[2] ?? 'address';
const network = process.argv[3] ?? 'devnet';
if (network !== 'devnet' && network !== 'testnet') throw new Error('Only devnet and testnet are supported');
const directory = resolve('.pilot', network);
await mkdir(directory, { recursive: true, mode: 0o700 });
const keysFile = new JsonFile<{ owner: ccc.Hex; session: ccc.Hex }>(`${directory}/keys.json`);
let keys = await keysFile.load();
if (!keys) {
  keys = { owner: ccc.hexFrom(randomBytes(32)), session: ccc.hexFrom(randomBytes(32)) };
  await keysFile.save(keys);
}
let scripts: Partial<Record<ccc.KnownScript, ccc.ScriptInfoLike>> | undefined;
if (network === 'devnet') {
  const source = await readFile(`${directory}/system-scripts.txt`, 'utf8');
  const exported = JSON.parse(source.slice(source.indexOf('{')));
  scripts = { ...exported, [ccc.KnownScript.NervosDao]: await new ccc.ClientPublicTestnet().getKnownScript(ccc.KnownScript.NervosDao) };
}
const client = new ccc.ClientPublicTestnet({
  url: network === 'devnet' ? 'http://127.0.0.1:8114' : 'https://testnet.ckb.dev',
  fallbacks: [], ...(scripts ? { scripts } : {}),
});
const chain = await client.requestor.request('get_blockchain_info', []) as { chain: string };
if (chain.chain !== (network === 'devnet' ? 'ckb_dev' : 'ckb_testnet')) throw new Error('RPC chain does not match requested network');
const owner = new ccc.SignerCkbPrivateKey(client, keys.owner);
const address = await owner.getRecommendedAddress();
const deploymentFile = new JsonFile<Deployment>(`${directory}/deployment.json`);
const sessionFile = new JsonFile<{ descriptor: Session; cell: SessionCell }>(`${directory}/session.json`);
const adapterStore = new JsonFile<SettlementJournal>(`${directory}/settlement.json`);
const pilotStore = new JsonFile<Journal<CounterState, CounterAction>>(`${directory}/pilot.json`);
const proofFile = new JsonFile<Record<string, unknown>>(`${directory}/proof.json`);
const proof = await proofFile.load() ?? {};
const print = (name: string, hash: string) => console.log(`${name}: ${network === 'testnet' ? `https://pudge.explorer.nervos.org/transaction/${hash}` : hash}`);
if (command === 'address') {
  console.log('Test-only owner address:', address);
  console.log('Balance (shannons):', String(await client.getBalanceSingle((await owner.getRecommendedAddressObj()).script)));
  console.log('Deployment requires approximately 94,000 test CKB for code-cell capacity.');
} else if (command === 'faucet') {
  if (network !== 'testnet') throw new Error('Use offckb deposit for devnet');
  const response = await fetch('https://faucet-api.nervos.org/claim_events', { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ claim_event: { address_hash: address, amount: '10000' } }) });
  console.log('Faucet status:', response.status);
  const body = await response.json() as { data?: { attributes?: { tx_hash?: string; txHash?: string } }; message?: string };
  console.log('Faucet response:', JSON.stringify(body));
} else if (command === 'deploy') {
  const existing = await deploymentFile.load();
  if (existing) throw new Error('Deployment already exists; reuse it');
  const code = new Uint8Array(await readFile('contracts/build/pilot-session-lock'));
  const lock = (await owner.getRecommendedAddressObj()).script;
  const tx = ccc.Transaction.from({ outputs: [{ lock }], outputsData: [ccc.hexFrom(code)] });
  await tx.completeInputsByCapacity(owner);
  await tx.completeFeeBy(owner, 1000n);
  const hash = await owner.sendTransaction(tx);
  print('Deployment', hash);
  const receipt = await client.waitTransaction(hash, 1, 180_000);
  if (receipt?.status !== 'committed') throw new Error('Deployment not confirmed');
  const deployment: Deployment = { network, genesisHash: (await client.getHeaderByNumber(0))!.hash, codeHash: ccc.hashCkb(code), outPoint: { txHash: hash, index: 0 } };
  await deploymentFile.save(deployment);
  proof.deployment = hash;
  await proofFile.save(proof);
} else {
  const deployment = await deploymentFile.load();
  if (!deployment) throw new Error('Deploy the contract first');
  const liveCode = await client.getCellLive(deployment.outPoint, true);
  if (!liveCode || ccc.hashCkb(liveCode.outputData) !== deployment.codeHash) throw new Error('Deployment code cell missing or hash mismatch');
  if (command === 'authorize') {
    if (await sessionFile.load()) throw new Error('Session already exists');
    const descriptor: Session = { id: crypto.randomUUID(), network: `ckb-${network}`, policyVersion: 'counter-v1', expiresAt: Date.now() + 24 * 3600_000 };
    const cell = await authorizeCounter(owner, { deployment, sessionPublicKey: ccc.hexFrom(secp256k1.getPublicKey(ccc.bytesFrom(keys.session), true)),
      budget: 300_000n, feePerMove: 100_000n });
    await sessionFile.save({ descriptor, cell });
    proof.authorization = ccc.OutPoint.from(cell.outPoint).txHash;
    await proofFile.save(proof);
    print('Authorized session', String(proof.authorization));
  } else {
    const session = await sessionFile.load();
    if (!session) throw new Error('Authorize the session first');
    const adapter = await CkbCounterAdapter.create({ client, deployment, sessionCell: session.cell, session: session.descriptor,
      sessionPrivateKey: keys.session, store: adapterStore });
    if (command === 'move' || command === 'resume') {
      const initial = await client.getCellLive(session.cell.outPoint, true);
      const saved = await pilotStore.load();
      if (!initial && !saved) throw new Error('Initial session cell missing and no Pilot journal exists');
      const data = initial ? decodeCounterData(initial.outputData) : { budget: 0n, position: 0n };
      const pilot = await Pilot.create({ session: session.descriptor, state: { position: Number(data.position) }, budget: data.budget,
        adapter, store: pilotStore, autoSettle: false });
      if (command === 'move') {
        await pilot.prepare([{ id: 'forward', action: { steps: 1 } }]);
        if (!pilot.readiness('forward').ready) throw new Error(pilot.readiness('forward').reason);
        await pilot.execute('forward');
        console.log('Instant local position:', pilot.state.position);
      }
      await pilot.flush();
      if (pilot.queueLength) throw new Error('Settlement unfinished; run resume to retry safely');
      const committed = await client.getCellLive(adapter.currentOutPoint, true);
      if (!committed) throw new Error('Confirmed successor cell is missing');
      const actual = decodeCounterData(committed.outputData);
      if (actual.position !== BigInt(pilot.confirmedState.position)) throw new Error('Chain position differs from Pilot state');
      print('Confirmed session action', ccc.OutPoint.from(adapter.currentOutPoint).txHash);
      console.log('On-chain position:', actual.position.toString(), 'remaining fee budget:', actual.budget.toString());
      proof.moves = [...new Set([...(proof.moves as string[] | undefined ?? []), ccc.OutPoint.from(adapter.currentOutPoint).txHash])];
      await proofFile.save(proof);
    } else if (command === 'reject') {
      // Sign invalid transactions correctly and ask the node's VM to reject their effects.
      for (const [name, steps, fee, expected] of [['forbidden-move', 2, 100_000n, 8], ['overspend', 1, 100_001n, 9]] as const) {
        const tx = signCounterTransaction(await buildCounterMove(client, deployment, session.cell, adapter.currentOutPoint, steps, fee), keys.session);
        try {
          await client.sendTransactionDry(tx);
          throw new Error(`Node unexpectedly accepted ${name}`);
        } catch (error) {
          const message = String(error);
          if (!message.includes(`error code ${expected}`) && !message.includes(`ValidationFailure(${expected})`)) throw error;
          console.log(`${name}: rejected by CKB-VM with code ${expected}`);
          proof[name] = { code: expected, transactionHash: tx.hash() };
        }
      }
      await proofFile.save(proof);
    } else if (command === 'revoke') {
      const hash = await revokeCounter(owner, deployment, session.cell, adapter.currentOutPoint);
      if (await client.getCellLive(adapter.currentOutPoint, true)) throw new Error('Revoked cell is still live');
      print('Owner revoked session', hash);
      proof.revocation = hash;
      await proofFile.save(proof);
    } else throw new Error(`Unknown command: ${command}`);
  }
}
