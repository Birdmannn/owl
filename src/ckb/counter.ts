import { ccc } from '@ckb-ccc/core';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { PermanentSettlementError } from '../types.js';
import type { Adapter, Session } from '../types.js';

export type CounterState = { position: number };
export type CounterAction = { steps: number };
export interface Deployment {
  network: 'testnet' | 'devnet';
  genesisHash: ccc.Hex;
  codeHash: ccc.Hex;
  outPoint: { txHash: ccc.Hex; index: number };
}
export interface SessionCell {
  lock: ccc.ScriptLike;
  outPoint: ccc.OutPointLike;
  feePerMove: string;
}
export interface SettlementJournal {
  currentOutPoint: ccc.OutPointLike;
  transactions: Record<string, { bytes: ccc.Hex; hash: ccc.Hex; confirmed: boolean }>;
}
export interface SettlementStore {
  load(): Promise<SettlementJournal | undefined>;
  save(journal: SettlementJournal): Promise<void>;
}
export interface CounterTransactionEvent {
  phase: 'signing' | 'signed' | 'checking' | 'broadcasting' | 'submitted' | 'confirming' | 'confirmed';
  actionId?: string;
  transactionHash?: ccc.Hex;
  transactionBytes?: ccc.Hex;
}
/** Observers cannot affect signing, persistence, or settlement. */
function observe(callback: ((event: CounterTransactionEvent) => void) | undefined, event: CounterTransactionEvent) {
  try { callback?.(event); } catch { /* isolated observer */ }
}
async function verifyDeployment(client: ccc.Client, deployment: Deployment): Promise<void> {
  const genesis = await client.getHeaderByNumberNoCache(0);
  const testnet = '0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606';
  const mainnet = '0x92b197aa1fba0f63633922c61c92375c9c074a93e85963554f5499fe1450d0e5';
  if (!genesis || genesis.hash === mainnet || genesis.hash !== deployment.genesisHash
    || (deployment.network === 'testnet') !== (genesis.hash === testnet)) {
    throw new Error('Deployment network does not match RPC chain');
  }
  const code = await client.getCellLive(deployment.outPoint, true);
  if (!code || ccc.hashCkb(code.outputData) !== deployment.codeHash) throw new Error('Deployment code cell missing or hash mismatch');
}
const MAX_U64 = (1n << 64n) - 1n;
function u64(value: bigint): Uint8Array {
  if (value < 0n || value > MAX_U64) throw new Error('Value outside u64 range');
  const buffer = new Uint8Array(8);
  new DataView(buffer.buffer).setBigUint64(0, value, true);
  return buffer;
}
export function encodeCounterData(budget: bigint, position: bigint): ccc.Hex {
  return ccc.hexFrom(ccc.bytesConcat(u64(budget), u64(position)));
}
export function decodeCounterData(data: ccc.HexLike): { budget: bigint; position: bigint } {
  const bytes = ccc.bytesFrom(data);
  if (bytes.length !== 16) throw new Error('Invalid counter cell data');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { budget: view.getBigUint64(0, true), position: view.getBigUint64(8, true) };
}
export function counterLock(deployment: Deployment, ownerLock: ccc.ScriptLike, sessionPublicKey: ccc.HexLike,
  maxFee: bigint, floor: bigint): ccc.Script {
  const publicKey = ccc.bytesFrom(sessionPublicKey);
  if (publicKey.length !== 33) throw new Error('Session public key must be compressed secp256k1');
  secp256k1.Point.fromBytes(publicKey);
  return ccc.Script.from({ codeHash: deployment.codeHash, hashType: 'data2',
    args: ccc.hexFrom(ccc.bytesConcat(ccc.Script.from(ownerLock).hash(), publicKey, u64(maxFee), u64(floor))) });
}
export function deploymentDep(deployment: Deployment): ccc.CellDepLike {
  return { outPoint: deployment.outPoint, depType: 'code' };
}

/** Existing CCC wallet signs funding, thereby approving this session's immutable policy. */
export async function authorizeCounter(owner: ccc.Signer, options: {
  deployment: Deployment;
  sessionPublicKey: ccc.HexLike;
  budget: bigint;
  feePerMove: bigint;
  floorCapacity?: bigint;
  /** Persist the funded outpoint before waiting, so interrupted approvals can resume. */
  onSubmitted?: (cell: SessionCell) => Promise<void>;
  onTransaction?: (event: CounterTransactionEvent) => void;
}): Promise<SessionCell> {
  await verifyDeployment(owner.client, options.deployment);
  if (options.budget < options.feePerMove || options.feePerMove <= 0n) throw new Error('Invalid session budget');
  const ownerLock = (await owner.getRecommendedAddressObj()).script;
  const floor = options.floorCapacity ?? ccc.fixedPointFrom(150);
  const lock = counterLock(options.deployment, ownerLock, options.sessionPublicKey, options.feePerMove, floor);
  const tx = ccc.Transaction.from({ outputs: [{ lock, capacity: floor + options.budget }],
    outputsData: [encodeCounterData(options.budget, 0n)] });
  await tx.completeInputsByCapacity(owner);
  await tx.completeFeeBy(owner, 1000n);
  observe(options.onTransaction, { phase: 'signing' });
  const txHash = await owner.sendTransaction(tx);
  const sessionCell = { lock, outPoint: { txHash, index: 0 }, feePerMove: options.feePerMove.toString() };
  await options.onSubmitted?.(sessionCell);
  observe(options.onTransaction, { phase: 'submitted', transactionHash: txHash });
  observe(options.onTransaction, { phase: 'confirming', transactionHash: txHash });
  const receipt = await owner.client.waitTransaction(txHash, 1, 180_000);
  if (receipt?.status !== 'committed') throw new Error('Session authorization not confirmed');
  observe(options.onTransaction, { phase: 'confirmed', transactionHash: txHash, transactionBytes: receipt.transaction ? ccc.hexFrom(receipt.transaction.toBytes()) : undefined });
  return sessionCell;
}

export function signCounterTransaction(txLike: ccc.TransactionLike, sessionPrivateKey: ccc.HexLike): ccc.Transaction {
  const tx = ccc.Transaction.from(txLike);
  const signature = secp256k1.sign(ccc.bytesFrom(tx.hash()), ccc.bytesFrom(sessionPrivateKey), { prehash: false });
  tx.setWitnessArgs(0, { lock: ccc.hexFrom(ccc.bytesConcat(new Uint8Array([1]), signature)) });
  return tx;
}

export async function buildCounterMove(client: ccc.Client, deployment: Deployment, session: SessionCell,
  outPoint: ccc.OutPointLike = session.outPoint, steps = 1, fee = BigInt(session.feePerMove)): Promise<ccc.Transaction> {
  const cell = await client.getCellLive(outPoint, true);
  if (!cell) throw new PermanentSettlementError('Session cell is no longer live');
  if (!cell.cellOutput.lock.eq(session.lock) || cell.cellOutput.type) throw new Error('Session cell does not match policy');
  const { budget, position } = decodeCounterData(cell.outputData);
  if (budget < fee) throw new PermanentSettlementError('On-chain session budget exhausted');
  return ccc.Transaction.from({
    cellDeps: [deploymentDep(deployment)], inputs: [{ previousOutput: outPoint }],
    outputs: [{ lock: session.lock, capacity: cell.cellOutput.capacity - fee }],
    outputsData: [encodeCounterData(budget - fee, position + BigInt(steps))],
  });
}

/** Owner authorization is proved by an additional input protected by the original owner lock. */
export async function revokeCounter(owner: ccc.Signer, deployment: Deployment, session: SessionCell,
  outPoint: ccc.OutPointLike, options?: { onTransaction?: (event: CounterTransactionEvent) => void }): Promise<ccc.Hex> {
  const ownerLock = (await owner.getRecommendedAddressObj()).script;
  const args = ccc.bytesFrom(ccc.Script.from(session.lock).args);
  if (ccc.hexFrom(args.slice(0, 32)) !== ownerLock.hash()) throw new Error('Wallet is not the session owner');
  const cell = await owner.client.getCellLive(outPoint, true);
  if (!cell || !cell.cellOutput.lock.eq(session.lock)) throw new Error('Session cell is no longer live');
  let proof: ccc.Cell | undefined;
  for await (const candidate of owner.client.findCellsByLock(ownerLock, null)) {
    if (candidate.outputData !== '0x') continue;
    proof = candidate; break;
  }
  if (!proof) throw new Error('Owner needs an ordinary live cell to authorize recovery');
  const tx = ccc.Transaction.from({ cellDeps: [deploymentDep(deployment)],
    inputs: [{ previousOutput: outPoint }, { previousOutput: proof.outPoint }],
    outputs: [{ lock: ownerLock, capacity: cell.cellOutput.capacity }], outputsData: ['0x'] });
  tx.setWitnessArgs(0, { lock: '0x00' });
  await tx.completeFeeBy(owner, 1000n);
  observe(options?.onTransaction, { phase: 'signing' });
  const hash = await owner.sendTransaction(tx);
  observe(options?.onTransaction, { phase: 'submitted', transactionHash: hash });
  observe(options?.onTransaction, { phase: 'confirming', transactionHash: hash });
  const receipt = await owner.client.waitTransaction(hash, 1, 180_000);
  if (receipt?.status !== 'committed') throw new Error('Revocation not confirmed');
  observe(options?.onTransaction, { phase: 'confirmed', transactionHash: hash, transactionBytes: receipt.transaction ? ccc.hexFrom(receipt.transaction.toBytes()) : undefined });
  return hash;
}

export class CkbCounterAdapter implements Adapter<CounterState, CounterAction> {
  private constructor(private options: {
    client: ccc.Client;
    deployment: Deployment;
    sessionCell: SessionCell;
    session: Session;
    sessionPrivateKey: ccc.HexLike;
    store: SettlementStore;
    onTransaction?: (event: CounterTransactionEvent) => void;
  }, private journal: SettlementJournal) {}

  static async create(options: ConstructorParametersInternal): Promise<CkbCounterAdapter> {
    await verifyDeployment(options.client, options.deployment);
    const lockArgs = ccc.bytesFrom(ccc.Script.from(options.sessionCell.lock).args);
    const publicKey = secp256k1.getPublicKey(ccc.bytesFrom(options.sessionPrivateKey), true);
    if (lockArgs.length !== 81 || ccc.hexFrom(lockArgs.slice(32, 65)) !== ccc.hexFrom(publicKey)) {
      throw new Error('Session key does not match funded cell');
    }
    if (options.session.network !== `ckb-${options.deployment.network}` || options.session.policyVersion !== 'counter-v1') {
      throw new Error('Session descriptor does not match deployment');
    }
    const journal = await options.store.load() ?? { currentOutPoint: options.sessionCell.outPoint, transactions: {} };
    await options.store.save(structuredClone(journal));
    return new CkbCounterAdapter(options, journal);
  }
  get currentOutPoint(): ccc.OutPointLike { return structuredClone(this.journal.currentOutPoint); }
  async validate(action: CounterAction, context: { state: CounterState; session: Session; availableBudget: bigint }) {
    const matches = context.session.id === this.options.session.id
      && context.session.policyVersion === this.options.session.policyVersion
      && context.session.network === this.options.session.network;
    return { allowed: matches && action.steps === 1 && Number.isSafeInteger(context.state.position + 1),
      cost: BigInt(this.options.sessionCell.feePerMove), reason: 'Only increment-by-one is permitted' };
  }
  apply(state: CounterState, action: CounterAction): CounterState { return { position: state.position + action.steps }; }

  async settle(request: { id: string; action: CounterAction; session: Session; reservedCost: bigint }) {
    if (request.session.id !== this.options.session.id || request.action.steps !== 1
      || request.reservedCost !== BigInt(this.options.sessionCell.feePerMove)) {
      throw new PermanentSettlementError('Action does not match authorized policy');
    }
    let record = this.journal.transactions[request.id];
    if (!record) {
      if (Date.now() >= this.options.session.expiresAt) throw new PermanentSettlementError('Local session expired');
      const tx = signCounterTransaction(await buildCounterMove(this.options.client, this.options.deployment,
        this.options.sessionCell, this.journal.currentOutPoint), this.options.sessionPrivateKey);
      record = { hash: tx.hash(), bytes: ccc.hexFrom(tx.toBytes()), confirmed: false };
      const next = structuredClone(this.journal);
      next.transactions[request.id] = record;
      await this.options.store.save(next); // Persist signed bytes before any broadcast.
      this.journal = next;
      observe(this.options.onTransaction, { phase: 'signed', actionId: request.id, transactionHash: record.hash, transactionBytes: record.bytes });
    }
    if (record.confirmed) return { transactionHash: record.hash };
    observe(this.options.onTransaction, { phase: 'checking', actionId: request.id, transactionHash: record.hash });
    const known = await this.options.client.getTransactionNoCache(record.hash);
    if (!known || known.status === 'rejected' || known.status === 'unknown') {
      // Resubmit exactly the same transaction; unknown transport errors remain retryable.
      try {
        observe(this.options.onTransaction, { phase: 'broadcasting', actionId: request.id, transactionHash: record.hash });
        await this.options.client.sendTransaction(ccc.Transaction.fromBytes(record.bytes));
        observe(this.options.onTransaction, { phase: 'submitted', actionId: request.id, transactionHash: record.hash });
      } catch (error) {
        if (error instanceof ccc.ErrorClientVerification && error.source === 'lock'
          && error.scriptCodeHash === this.options.deployment.codeHash) {
          throw new PermanentSettlementError(`Session policy rejected transaction: ${error.errorCode}`);
        }
        if (!(error instanceof ccc.ErrorClientDuplicatedTransaction)) throw error;
      }
    }
    observe(this.options.onTransaction, { phase: 'confirming', actionId: request.id, transactionHash: record.hash });
    const receipt = await this.options.client.waitTransaction(record.hash, 1, 180_000);
    if (receipt?.status !== 'committed') throw new Error('Transaction not confirmed');
    const next = structuredClone(this.journal);
    next.transactions[request.id]!.confirmed = true;
    next.currentOutPoint = { txHash: record.hash, index: 0 };
    await this.options.store.save(next);
    this.journal = next;
    observe(this.options.onTransaction, { phase: 'confirmed', actionId: request.id, transactionHash: record.hash });
    return { transactionHash: record.hash };
  }
}
interface ConstructorParametersInternal {
  client: ccc.Client;
  deployment: Deployment;
  sessionCell: SessionCell;
  session: Session;
  sessionPrivateKey: ccc.HexLike;
  store: SettlementStore;
  onTransaction?: (event: CounterTransactionEvent) => void;
}
