import { SPONSORED_COUNTER_CODE_HASH } from './sponsored-code.js';
import { SponsorQuoteRejectedError, type FeeSponsor, type SponsorQuote } from '../paymaster.js';
import { assertPilotSigningOwner, checkOwnerTransaction, verifyOwnerSignatureChanges } from './owner.js';
import { ccc } from '@ckb-ccc/core';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { PermanentSettlementError } from '../types.js';
import type { Adapter, Session } from '../types.js';

export const COUNTER_V1_CODE_HASH: ccc.Hex = '0x1d3dc6f80f4df37c708ffbbcb47c7e6dc3bc278321f0b47a45ca22196ae7d483';
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
  authorizationQuote?: SponsorQuote;
}
export interface SettlementJournal {
  scopeHash?: ccc.Hex;
  currentOutPoint: ccc.OutPointLike;
  transactions: Record<string, { bytes: ccc.Hex; hash: ccc.Hex; confirmed: boolean; paymasterQuote?: SponsorQuote; actionCommitment?: string }>;
}
export interface SettlementStore {
  load(): Promise<SettlementJournal | undefined>;
  save(journal: SettlementJournal): Promise<void>;
}
export interface CounterTransactionEvent {
  phase: 'signing' | 'signed' | 'checking' | 'broadcasting' | 'submitted' | 'confirming' | 'confirmed';
  feePayer?: 'pool' | 'user';
  networkFee?: string;
  actionId?: string;
  transactionHash?: ccc.Hex;
  transactionBytes?: ccc.Hex;
}
/** Observers cannot affect signing, persistence, or settlement. */
function observe(callback: ((event: CounterTransactionEvent) => void) | undefined, event: CounterTransactionEvent) {
  try { callback?.(event); } catch { /* isolated observer */ }
}
export async function verifyDeployment(client: ccc.Client, deployment: Deployment): Promise<void> {
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
  maxFee: bigint, floor: bigint, poolLock?: ccc.ScriptLike): ccc.Script {
  const publicKey = ccc.bytesFrom(sessionPublicKey);
  if (publicKey.length !== 33) throw new Error('Session public key must be compressed secp256k1');
  secp256k1.Point.fromBytes(publicKey);
  if ((deployment.codeHash === SPONSORED_COUNTER_CODE_HASH) !== !!poolLock) throw new Error('Sponsored counter requires its pinned pool lock');
  return ccc.Script.from({ codeHash: deployment.codeHash, hashType: 'data2',
    args: ccc.hexFrom(ccc.bytesConcat(ccc.Script.from(ownerLock).hash(), publicKey, u64(maxFee), u64(floor), poolLock ? ccc.Script.from(poolLock).hash() : new Uint8Array())) });
}
export function deploymentDep(deployment: Deployment): ccc.CellDepLike {
  return { outPoint: deployment.outPoint, depType: 'code' };
}

/** Existing CCC wallet signs funding, thereby approving this session's immutable policy. */
export async function authorizeCounter(owner: ccc.Signer, options: {
  deployment: Deployment;
  paymaster?: FeeSponsor; poolLock?: ccc.ScriptLike;
  sessionPublicKey: ccc.HexLike;
  budget: bigint;
  feePerMove: bigint;
  floorCapacity?: bigint;
  /** Persist the funded outpoint before waiting, so interrupted approvals can resume. */
  onSubmitted?: (cell: SessionCell) => Promise<void>;
  onTransaction?: (event: CounterTransactionEvent) => void;
  onSigned?: (cell: SessionCell, bytes: ccc.Hex) => Promise<void>;
}): Promise<SessionCell> {
  await verifyDeployment(owner.client, options.deployment);
  if (![COUNTER_V1_CODE_HASH, SPONSORED_COUNTER_CODE_HASH].includes(options.deployment.codeHash)) throw new Error('Unrecognized counter binary');
  const sponsored = options.deployment.codeHash === SPONSORED_COUNTER_CODE_HASH;
  if (sponsored !== !!options.paymaster) throw new Error('Sponsored policy requires paymaster; no user-paid fallback');
  if (options.budget < options.feePerMove || options.feePerMove <= 0n) throw new Error('Invalid session budget');
  const ownerLock = (await owner.getRecommendedAddressObj()).script.clone();
  await assertPilotSigningOwner(owner.client, ownerLock);
  const floor = options.floorCapacity ?? ccc.fixedPointFrom(sponsored ? 200 : 150);
  const lock = counterLock(options.deployment, ownerLock, options.sessionPublicKey, options.feePerMove, floor, options.poolLock);
  const tx = ccc.Transaction.from({ outputs: [{ lock, capacity: floor + (sponsored ? 0n : options.budget) }],
    outputsData: [encodeCounterData(options.budget, 0n)] });
  await tx.completeInputsByCapacity(owner);
  await tx.completeFeeBy(owner, sponsored ? 0n : 1000n);
  const expected = tx.outputs[0]!.clone(), data = tx.outputsData[0]!;
  let prepared = (await owner.prepareTransaction(tx.clone())).clone();
  const quote = options.paymaster ? await options.paymaster.prepare(prepared) : undefined;
  if (quote) prepared = ccc.Transaction.fromBytes(quote.bytes);
  await checkOwnerTransaction(owner.client, prepared, { ownerLock, sponsor: quote, poolLock: options.poolLock, output: expected, data, maxFee: 1_000_000n });
  observe(options.onTransaction, { phase: 'signing' });
  let signed = await owner.signOnlyTransaction(prepared.clone());
  verifyOwnerSignatureChanges(prepared, signed);
  const txHash = signed.hash();
  const sessionCell = { lock, outPoint: { txHash, index: 0 }, feePerMove: options.feePerMove.toString(), authorizationQuote: quote };
  await options.onSigned?.(sessionCell, ccc.hexFrom(signed.toBytes()));
  observe(options.onTransaction, { phase: 'signed', feePayer: quote ? 'pool' : 'user', networkFee: quote?.fee, transactionHash: txHash, transactionBytes: ccc.hexFrom(signed.toBytes()) });
  if (quote) { signed = await options.paymaster!.submit(quote, signed); await options.onSigned?.(sessionCell, ccc.hexFrom(signed.toBytes())); }
  else await owner.client.sendTransaction(signed);
  await options.onSubmitted?.(sessionCell);
  observe(options.onTransaction, { phase: 'submitted', transactionHash: txHash });
  observe(options.onTransaction, { phase: 'confirming', transactionHash: txHash });
  const receipt = await owner.client.waitTransaction(txHash, 1, 180_000);
  if (receipt?.status !== 'committed') throw new Error('Session authorization not confirmed');
  observe(options.onTransaction, { phase: 'confirmed', transactionHash: txHash, transactionBytes: receipt.transaction ? ccc.hexFrom(receipt.transaction.toBytes()) : undefined });
  return sessionCell;
}

export function signCounterTransaction(txLike: ccc.TransactionLike, sessionPrivateKey: ccc.HexLike): ccc.Transaction {
  const tx = ccc.Transaction.from(txLike).clone();
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
  const sponsored = deployment.codeHash === SPONSORED_COUNTER_CODE_HASH;
  return ccc.Transaction.from({
    cellDeps: [deploymentDep(deployment)], inputs: [{ previousOutput: outPoint }],
    outputs: [{ lock: session.lock, capacity: cell.cellOutput.capacity - (sponsored ? 0n : fee) }],
    outputsData: [encodeCounterData(budget - fee, position + BigInt(steps))],
  });
}

/** Owner authorization is proved by an additional input protected by the original owner lock. */
export async function revokeCounter(owner: ccc.Signer, deployment: Deployment, session: SessionCell,
  outPoint: ccc.OutPointLike, options?: { paymaster?: FeeSponsor; onSigned?: (bytes: ccc.Hex, quote?: SponsorQuote) => Promise<void>; onTransaction?: (event: CounterTransactionEvent) => void }): Promise<ccc.Hex> {
  await verifyDeployment(owner.client, deployment);
  if (![COUNTER_V1_CODE_HASH, SPONSORED_COUNTER_CODE_HASH].includes(deployment.codeHash)) throw new Error('Unrecognized counter binary');
  const ownerLock = (await owner.getRecommendedAddressObj()).script.clone();
  const args = ccc.bytesFrom(ccc.Script.from(session.lock).args);
  if (ccc.hexFrom(args.slice(0, 32)) !== ownerLock.hash()) throw new Error('Wallet is not the session owner');
  const cell = (await owner.client.getCellLive(outPoint, true))?.clone();
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
  const sponsored = deployment.codeHash === SPONSORED_COUNTER_CODE_HASH;
  if (sponsored && !options?.paymaster) throw new Error('Paymaster required; no user-paid fallback');
  await tx.completeFeeBy(owner, options?.paymaster ? 0n : 1000n);
  const expected = tx.outputs[0]!.clone();
  let prepared = (await owner.prepareTransaction(tx.clone())).clone();
  const quote = options?.paymaster ? await options.paymaster.prepare(prepared) : undefined;
  if (quote && sponsored && ccc.Transaction.fromBytes(quote.bytes).outputs.at(-1)!.lock.hash() !== ccc.hexFrom(args.slice(81))) throw new Error('Recovery paymaster differs from pinned pool');
  if (quote) prepared = ccc.Transaction.fromBytes(quote.bytes);
  await checkOwnerTransaction(owner.client, prepared, { ownerLock, sponsor: quote, poolLock: quote ? ccc.Transaction.fromBytes(quote.bytes).outputs.at(-1)!.lock : undefined, selected: cell.clone(), output: expected, data: '0x', maxFee: 1_000_000n });
  observe(options?.onTransaction, { phase: 'signing' });
  let signed = await owner.signOnlyTransaction(prepared.clone());
  verifyOwnerSignatureChanges(prepared, signed);
  const hash = signed.hash();
  observe(options?.onTransaction, { phase: 'signed', feePayer: quote ? 'pool' : 'user', networkFee: quote?.fee, transactionHash: hash, transactionBytes: ccc.hexFrom(signed.toBytes()) });
  await options?.onSigned?.(ccc.hexFrom(signed.toBytes()), quote);
  if (quote) { signed = await options!.paymaster!.submit(quote, signed); await options?.onSigned?.(ccc.hexFrom(signed.toBytes()), quote); }
  else await owner.client.sendTransaction(signed);
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
    paymaster?: FeeSponsor;
    deployment: Deployment;
    sessionCell: SessionCell;
    session: Session;
    sessionPrivateKey: ccc.HexLike;
    store: SettlementStore;
    onTransaction?: (event: CounterTransactionEvent) => void;
  }, private journal: SettlementJournal) {}

  static async create(options: ConstructorParametersInternal): Promise<CkbCounterAdapter> {
    await verifyDeployment(options.client, options.deployment);
    if (![COUNTER_V1_CODE_HASH, SPONSORED_COUNTER_CODE_HASH].includes(options.deployment.codeHash)) throw new Error('Unrecognized counter binary');
    const sponsored = options.deployment.codeHash === SPONSORED_COUNTER_CODE_HASH;
    if (sponsored !== !!options.paymaster) throw new Error('Paymaster required for sponsored counter; no user-paid fallback');
    const lockArgs = ccc.bytesFrom(ccc.Script.from(options.sessionCell.lock).args);
    const publicKey = secp256k1.getPublicKey(ccc.bytesFrom(options.sessionPrivateKey), true);
    const script = ccc.Script.from(options.sessionCell.lock);
    if (script.codeHash !== options.deployment.codeHash || script.hashType !== 'data2' || lockArgs.length !== (sponsored ? 113 : 81)
      || new DataView(lockArgs.buffer, lockArgs.byteOffset, lockArgs.byteLength).getBigUint64(65, true) !== BigInt(options.sessionCell.feePerMove) || ccc.hexFrom(lockArgs.slice(32, 65)) !== ccc.hexFrom(publicKey)) {
      throw new Error('Session key does not match funded cell');
    }
    if (options.session.network !== `ckb-${options.deployment.network}` || options.session.policyVersion !== (sponsored ? 'counter-sponsored-v1' : 'counter-v1')) {
      throw new Error('Session descriptor does not match deployment');
    }
    const scopeHash = ccc.hashCkb(ccc.bytesFrom(JSON.stringify([options.session.id, options.session.network, options.session.policyVersion, options.session.expiresAt, ccc.hexFrom(script.toBytes()), ccc.hexFrom(ccc.OutPoint.from(options.sessionCell.outPoint).toBytes())]), 'utf8'));
    const journal = structuredClone(await options.store.load() ?? { scopeHash, currentOutPoint: options.sessionCell.outPoint, transactions: {} });
    if (journal.scopeHash && journal.scopeHash !== scopeHash) throw new Error('Settlement journal belongs to another counter session');
    // Legacy journals acquire a scope after their saved signatures and lock identities are checked.
    for (const record of Object.values(journal.transactions)) {
      const tx = ccc.Transaction.fromBytes(record.bytes), witness = tx.getWitnessArgs(0)?.lock;
      if (sponsored && (!record.paymasterQuote || tx.outputs[1]?.lock.hash() !== ccc.hexFrom(lockArgs.slice(81)))) throw new Error('Saved transaction has wrong pool');
      if (tx.hash() !== record.hash || tx.inputs.length !== (sponsored ? 2 : 1) || tx.outputs.length !== (sponsored ? 2 : 1) || !tx.outputs[0]!.lock.eq(script) || !witness
        || ccc.bytesFrom(witness).length !== 65 || ccc.bytesFrom(witness)[0] !== 1
        || !secp256k1.verify(ccc.bytesFrom(witness).slice(1), ccc.bytesFrom(tx.hash()), publicKey, { prehash: false })) throw new Error('Saved counter transaction is outside the approved session');
    }
    journal.scopeHash = scopeHash;
    await options.store.save(structuredClone(journal));
    return new CkbCounterAdapter({ ...options, deployment: structuredClone(options.deployment), session: structuredClone(options.session), sessionCell: structuredClone(options.sessionCell), sessionPrivateKey: ccc.hexFrom(options.sessionPrivateKey) }, structuredClone(journal));
  }
  get currentOutPoint(): ccc.OutPointLike { return structuredClone(this.journal.currentOutPoint); }
  async validate(action: CounterAction, context: { state: CounterState; session: Session; availableBudget: bigint }) {
    const matches = context.session.id === this.options.session.id
      && context.session.policyVersion === this.options.session.policyVersion
      && context.session.network === this.options.session.network && context.session.expiresAt === this.options.session.expiresAt;
    return { allowed: matches && action.steps === 1 && Number.isSafeInteger(context.state.position + 1),
      cost: BigInt(this.options.sessionCell.feePerMove), reason: 'Only increment-by-one is permitted' };
  }
  apply(state: CounterState, action: CounterAction): CounterState { return { position: state.position + action.steps }; }

  async settle(request: { id: string; action: CounterAction; session: Session; reservedCost: bigint }) {
    if (request.session.id !== this.options.session.id || request.session.network !== this.options.session.network
      || request.session.policyVersion !== this.options.session.policyVersion || request.session.expiresAt !== this.options.session.expiresAt || request.action.steps !== 1
      || request.reservedCost !== BigInt(this.options.sessionCell.feePerMove)) {
      throw new PermanentSettlementError('Action does not match authorized policy');
    }
    let record = this.journal.transactions[request.id];
    if (record && ccc.Transaction.fromBytes(record.bytes).hash() !== record.hash) throw new PermanentSettlementError('Corrupt saved transaction');
    if (!record) {
      if (Date.now() >= this.options.session.expiresAt) throw new PermanentSettlementError('Local session expired');
      const base = await buildCounterMove(this.options.client, this.options.deployment, this.options.sessionCell, this.journal.currentOutPoint);
      const paymasterQuote = this.options.paymaster ? await this.options.paymaster.prepare(base) : undefined;
      if (paymasterQuote && ccc.Transaction.fromBytes(paymasterQuote.bytes).outputs.at(-1)!.lock.hash() !== ccc.hexFrom(ccc.bytesFrom(ccc.Script.from(this.options.sessionCell.lock).args).slice(81))) throw new Error('Paymaster differs from immutable pool');
      const tx = signCounterTransaction(paymasterQuote ? ccc.Transaction.fromBytes(paymasterQuote.bytes) : base, this.options.sessionPrivateKey);
      record = { hash: tx.hash(), bytes: ccc.hexFrom(tx.toBytes()), confirmed: false, paymasterQuote };
      const next = structuredClone(this.journal);
      next.transactions[request.id] = record;
      await this.options.store.save(next); // Persist signed bytes before any broadcast.
      this.journal = next;
      observe(this.options.onTransaction, { phase: 'signed', feePayer: paymasterQuote ? 'pool' : 'user', networkFee: paymasterQuote?.fee ?? this.options.sessionCell.feePerMove, actionId: request.id, transactionHash: record.hash, transactionBytes: record.bytes });
    }
    if (record.paymasterQuote && !record.confirmed) {
      if (!this.options.paymaster) throw new Error('Restore the configured paymaster before retrying');
      let signed: ccc.Transaction;
      try { signed = await this.options.paymaster.submit(record.paymasterQuote, ccc.Transaction.fromBytes(record.bytes)); }
      catch (error) {
        if (error instanceof SponsorQuoteRejectedError && error.quoteId === record.paymasterQuote!.id) {
          const next = structuredClone(this.journal); delete next.transactions[request.id];
          await this.options.store.save(next); this.journal = next;
        }
        throw error; // Engine retries same action; unknown submissions always retain their exact bytes.
      }
      const next = structuredClone(this.journal); next.transactions[request.id]!.bytes = ccc.hexFrom(signed.toBytes());
      await this.options.store.save(next); this.journal = next; record = next.transactions[request.id]!;
    }
    if (record.confirmed) {
      const known = await this.options.client.getTransactionNoCache(record.hash);
      if (known?.status !== 'committed') throw new Error('Saved transaction is not confirmed by the node');
      const receipt = await this.options.client.waitTransaction(record.hash, 1, 180_000);
      if (receipt?.status !== 'committed') throw new Error('Saved transaction is not confirmed by the node');
      return { transactionHash: record.hash };
    }
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
  paymaster?: FeeSponsor;
  client: ccc.Client;
  deployment: Deployment;
  sessionCell: SessionCell;
  session: Session;
  sessionPrivateKey: ccc.HexLike;
  store: SettlementStore;
  onTransaction?: (event: CounterTransactionEvent) => void;
}
