import { SPONSORED_DELEGATION_CODE_HASH } from './sponsored-code.js';
import { SponsorQuoteRejectedError, type FeeSponsor, type SponsorQuote } from '../paymaster.js';
import { assertPilotSigningOwner, checkOwnerTransaction, verifyOwnerSignatureChanges } from './owner.js';
export { checkOwnerTransaction, verifyOwnerSignatureChanges } from './owner.js';
import { ccc } from '@ckb-ccc/core';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { PermanentSettlementError, type Adapter, type Context, type Session } from '../types.js';
import { actionHash, applyPilotTransition, assertPilotPermission, createPilotGrant, definePilotApp, pilotCanonical, pilotManifestHash,
  type PilotAppDefinition, type PilotAppManifest, type PilotActionRequest, type PilotDelegationGrant } from '../delegation.js';
import { deploymentDep, verifyDeployment, type SettlementStore, type SettlementJournal, type CounterTransactionEvent } from './counter.js';

const ZERO_HASH = ('0x' + '00'.repeat(32)) as ccc.Hex;
const u64 = (value: bigint) => { const bytes = new Uint8Array(8); new DataView(bytes.buffer).setBigUint64(0, value, true); return bytes; };
const u32 = (value: number) => { const bytes = new Uint8Array(4); new DataView(bytes.buffer).setUint32(0, value, true); return bytes; };
const observe = (callback: ((event: CounterTransactionEvent) => void) | undefined, event: CounterTransactionEvent) => { try { callback?.(event); } catch { /* diagnostics cannot interrupt settlement */ } };
const scriptHash = (script?: ccc.ScriptLike | null): ccc.Hex => script ? ccc.Script.from(script).hash() : ZERO_HASH;
const appType = (manifest: PilotAppManifest) => manifest.script ? ccc.Script.from(manifest.script) : undefined;
const deps = (manifest: PilotAppManifest): ccc.CellDepLike[] => [deploymentDep(manifest.policy.deployment), ...(manifest.script ? [manifest.script.cellDep] : [])];
function matchesSelection(manifest: PilotAppManifest, data: ccc.Hex): boolean {
  const rule = manifest.cellSelection;
  return (!rule?.dataPrefix || data.startsWith(rule.dataPrefix)) && (rule?.dataLength === undefined || ccc.bytesFrom(data).length === rule.dataLength);
}

export function delegationLock(manifest: PilotAppManifest, grant: PilotDelegationGrant, ownerLock: ccc.ScriptLike, publicKey: ccc.HexLike): ccc.Script {
  if (grant.manifestHash !== pilotManifestHash(manifest) || !grant.permissions.length) throw new Error('Delegation needs selected permissions');
  const key = ccc.bytesFrom(publicKey);
  if (key.length !== 33) throw new Error('Expected compressed session public key');
  secp256k1.Point.fromBytes(key);
  const rules = grant.permissions.map(id => {
    assertPilotPermission(manifest, grant, id);
    const action = manifest.actions.find(action => action.id === id)!;
    return ccc.bytesConcat(actionHash(id), new Uint8Array([action.transition.kind === 'u64-increment' ? 0 : 1]), u32(action.transition.offset), u64(BigInt(action.transition.delta)));
  });
  return ccc.Script.from({ codeHash: manifest.policy.deployment.codeHash, hashType: 'data2', args: ccc.hexFrom(ccc.bytesConcat(
    ccc.Script.from(ownerLock).hash(), key, grant.manifestHash, scriptHash(appType(manifest)),
    u64(BigInt(manifest.policy.feePerAction)), u64(BigInt(manifest.policy.floorCapacity)), new Uint8Array([rules.length]), ...rules, ...(manifest.policy.poolLock ? [ccc.Script.from(manifest.policy.poolLock).hash()] : []),
  )) });
}

/** Commits the raw transaction, selected operation, and every witness (without this signature). */
export function delegationSigningDigest(transaction: ccc.TransactionLike, id: string): ccc.Hex {
  const tx = ccc.Transaction.from(transaction).clone();
  tx.setWitnessArgs(0, { ...tx.getWitnessArgs(0), lock: ccc.hexFrom(ccc.bytesConcat(new Uint8Array([1]), actionHash(id))) });
  const sponsored = tx.outputs[0]?.lock.codeHash === SPONSORED_DELEGATION_CODE_HASH;
  if (sponsored) tx.setWitnessArgs(1, { ...tx.getWitnessArgs(1), lock: '0x' });
  return ccc.hashCkb(ccc.bytesFrom(sponsored ? 'owl-pilot-delegation-sponsored-v1' : 'owl-pilot-delegation-v1', 'utf8'), tx.hash(),
    ...tx.witnesses.flatMap(witness => [u64(BigInt(ccc.bytesFrom(witness).length)), ccc.bytesFrom(witness)]));
}
export function signDelegatedTransaction(transaction: ccc.TransactionLike, id: string, key: ccc.HexLike): ccc.Transaction {
  const tx = ccc.Transaction.from(transaction).clone();
  const signature = secp256k1.sign(ccc.bytesFrom(delegationSigningDigest(tx, id)), ccc.bytesFrom(key), { prehash: false });
  tx.setWitnessArgs(0, { ...tx.getWitnessArgs(0), lock: ccc.hexFrom(ccc.bytesConcat(new Uint8Array([1]), actionHash(id), signature)) });
  return tx;
}

export interface DelegatedCell {
  lock: ccc.ScriptLike;
  outPoint: ccc.OutPointLike;
  grant: PilotDelegationGrant;
  ownerLock: ccc.ScriptLike;
  sessionPublicKey: ccc.Hex;
}
export interface DelegationReceipt {
  version: 1;
  kind: 'setup' | 'recovery' | 'manual';
  hash: ccc.Hex;
  bytes: ccc.Hex;
  confirmed: boolean;
  paymasterQuote?: SponsorQuote;
}
export interface DelegationReceiptStore {
  load(): Promise<DelegationReceipt | undefined>;
  save(receipt: DelegationReceipt): Promise<void>;
}
export interface DelegationReview {
  mode: 'create' | 'migrate';
  source?: ccc.OutPointLike;
  sourceCapacity?: string;
  appScriptHash: ccc.Hex;
  stateData: ccc.Hex;
  permissions: { id: string; name: string }[];
  ownerAddress: string;
  delegatedCapacity: string;
  protectedCapacity: string;
  feeBudget: string;
  setupFee: string;
  sponsoredNetworkFee?: string;
  transactionHash: ccc.Hex;
}
export interface PreparedDelegation {
  mode: 'delegation';
  transactionBytes: ccc.Hex;
  paymasterQuote?: SponsorQuote;
  cell: DelegatedCell;
  review: DelegationReview;
}
export interface ConnectedWithoutDelegation { mode: 'connected'; grant: PilotDelegationGrant }

async function live(client: ccc.Client, outPoint: ccc.OutPointLike): Promise<ccc.Cell> {
  const cell = await client.getCellLive(outPoint, true);
  if (!cell) throw new Error('Selected cell is not live');
  return cell.clone();
}
async function reconcileOwnerTransaction(client: ccc.Client, store: DelegationReceiptStore, receipt: DelegationReceipt, event?: (event: CounterTransactionEvent) => void, paymaster?: FeeSponsor): Promise<ccc.Hex> {
  const saved = structuredClone(receipt);
  if (!saved) throw new Error('No saved owner transaction');
  let tx = ccc.Transaction.fromBytes(saved.bytes);
  if (tx.hash() !== saved.hash) throw new Error('Corrupt saved transaction');
  {
    const known = await client.getTransactionNoCache(saved.hash);
    if (!known || known.status === 'unknown' || known.status === 'rejected') {
      if (saved.paymasterQuote) {
        if (!paymaster) throw new Error('Restore paymaster before retrying; no user-paid fallback');
        tx = await paymaster.submit(saved.paymasterQuote, tx); saved.bytes = ccc.hexFrom(tx.toBytes()); await store.save(saved);
      }
      observe(event, { phase: 'broadcasting', transactionHash: saved.hash, transactionBytes: saved.bytes });
      try { await client.sendTransaction(tx); }
      catch (error) { if (!(error instanceof ccc.ErrorClientDuplicatedTransaction)) throw error; }
      observe(event, { phase: 'submitted', transactionHash: saved.hash });
    }
    observe(event, { phase: 'confirming', transactionHash: saved.hash });
    const receipt = await client.waitTransaction(saved.hash, 1, 180_000);
    if (receipt?.status !== 'committed') throw new Error('Owner transaction not confirmed');
    await store.save({ ...saved, confirmed: true });
  }
  observe(event, { phase: 'confirmed', transactionHash: saved.hash });
  return saved.hash;
}

export class PilotConnector<State, Params = unknown> {
  readonly name = 'Pilot';
  private definition: PilotAppDefinition<State, Params>;
  private authorizing = false;
  private prepared = new WeakMap<PreparedDelegation, { bytes: ccc.Hex; snapshot: string; output: ccc.CellOutput; data: ccc.Hex; source?: ccc.Cell; cell: DelegatedCell; quote?: SponsorQuote }>();
  constructor(readonly owner: ccc.Signer, definition: PilotAppDefinition<State, Params>, readonly options: { paymaster?: FeeSponsor } = {}) { this.definition = definePilotApp(definition);
    if ((definition.manifest.policy.kind === 'delegation-sponsored-v1') !== !!options.paymaster) throw new Error('Sponsored delegation requires paymaster; no user-paid fallback');
  }
  async getAccount() { return { address: await this.owner.getRecommendedAddress(), balance: await this.owner.getBalance() }; }
  async findDelegatableCells(limit = 20): Promise<ccc.Cell[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Cell discovery limit must be 1–100');
    const owner = (await this.owner.getRecommendedAddressObj()).script;
    const manifest = this.definition.manifest;
    const cells: ccc.Cell[] = [];
    let scanned = 0;
    for await (const cell of this.owner.client.findCellsByLock(owner, appType(manifest) ?? null)) {
      if (++scanned > 1000) break;
      if (scriptHash(cell.cellOutput.type) !== scriptHash(appType(manifest)) || !matchesSelection(manifest, cell.outputData)) continue;
      try { if (this.definition.encodeState(this.definition.decodeState(cell.outputData)) !== cell.outputData) continue; } catch { continue; }
      cells.push(cell); if (cells.length >= limit) break;
    }
    return cells;
  }

  async prepareDelegation(options: { selected: readonly string[]; sessionPublicKey: ccc.HexLike; initialState?: State; source?: ccc.OutPointLike }): Promise<PreparedDelegation | ConnectedWithoutDelegation> {
    const manifest = this.definition.manifest;
    const grant = createPilotGrant(manifest, options.selected);
    if (!grant.permissions.length) return { mode: 'connected', grant };
    await verifyDeployment(this.owner.client, manifest.policy.deployment);
    const owner = (await this.owner.getRecommendedAddressObj()).script.clone();
    await assertPilotSigningOwner(this.owner.client, owner);
    const lock = delegationLock(manifest, grant, owner, options.sessionPublicKey);
    const source = options.source ? await live(this.owner.client, options.source) : undefined;
    if (source && (!source.cellOutput.lock.eq(owner) || scriptHash(source.cellOutput.type) !== scriptHash(appType(manifest)))) throw new Error('Selected cell does not belong to this wallet and application');
    if (!source && options.initialState === undefined) throw new Error('Provide initialState when creating an app cell');
    const data = source ? source.outputData : this.definition.encodeState(options.initialState!);
    if (!matchesSelection(manifest, data)) throw new Error('Selected cell does not match the developer cell-selection rules');
    const state = this.definition.decodeState(data);
    if (this.definition.encodeState(state) !== data) throw new Error('App state codec does not preserve selected data');
    for (const id of grant.permissions) applyPilotTransition(data, manifest.actions.find(action => action.id === id)!.transition);
    const floor = BigInt(manifest.policy.floorCapacity);
    const capacity = floor + (this.options.paymaster ? 0n : BigInt(manifest.policy.budget));
    const output = ccc.CellOutput.from({ lock, type: appType(manifest), capacity });
    if (floor < ccc.fixedPointFrom(output.occupiedSize + ccc.bytesFrom(data).length)) throw new Error('Protected capacity is below occupied minimum for the selected policy');
    let tx = ccc.Transaction.from({ cellDeps: deps(manifest), inputs: source ? [{ previousOutput: source.outPoint }] : [], outputs: [output.clone()], outputsData: [data] });
    if (this.definition.buildAuthorization) tx = ccc.Transaction.from(await this.definition.buildAuthorization({ owner: this.owner, source: source?.clone(), defaultTransaction: tx.clone() })).clone();
    await tx.completeInputsByCapacity(this.owner);
    await tx.completeFeeBy(this.owner, this.options.paymaster ? 0n : 1000n);
    tx = (await this.owner.prepareTransaction(tx.clone())).clone();
    const quote = this.options.paymaster ? await this.options.paymaster.prepare(tx) : undefined;
    if (quote) tx = ccc.Transaction.fromBytes(quote.bytes);
    const fee = await checkOwnerTransaction(this.owner.client, tx, { sponsor: quote, poolLock: manifest.policy.poolLock, ownerLock: owner, selected: source, output, data, maxFee: BigInt(manifest.policy.maxSetupFee) });
    const cell: DelegatedCell = { lock, outPoint: { txHash: tx.hash(), index: 0 }, grant, ownerLock: owner, sessionPublicKey: ccc.hexFrom(options.sessionPublicKey) };
    const result: PreparedDelegation = { mode: 'delegation', paymasterQuote: quote, transactionBytes: ccc.hexFrom(tx.toBytes()), cell: structuredClone(cell), review: {
      mode: source ? 'migrate' : 'create', source: source ? { txHash: source.outPoint.txHash, index: Number(source.outPoint.index) } : undefined,
      sourceCapacity: source?.cellOutput.capacity.toString(), appScriptHash: scriptHash(appType(manifest)), stateData: data,
      permissions: manifest.actions.filter(action => grant.permissions.includes(action.id)).map(({ id, name }) => ({ id, name })),
      ownerAddress: await this.owner.getRecommendedAddress(), delegatedCapacity: capacity.toString(), protectedCapacity: floor.toString(), feeBudget: manifest.policy.budget,
      setupFee: fee.toString(), sponsoredNetworkFee: quote?.fee, transactionHash: tx.hash(),
    } };
    this.prepared.set(result, { bytes: result.transactionBytes, snapshot: pilotCanonical(result), output, data, source, cell, quote });
    return result;
  }

  /** Call only after presenting review and obtaining explicit approval. Store is required before broadcast. */
  async authorize(prepared: PreparedDelegation, store: DelegationReceiptStore, onTransaction?: (event: CounterTransactionEvent) => void): Promise<DelegatedCell> {
    if (this.authorizing) throw new Error('A delegation approval is already in progress');
    this.authorizing = true;
    try {
      const scope = this.prepared.get(prepared);
      if (!scope || scope.snapshot !== pilotCanonical(prepared)) throw new Error('Unknown or changed delegation review; prepare again');
      await verifyDeployment(this.owner.client, this.definition.manifest.policy.deployment);
      const previous = await store.load();
      if (previous) throw new Error('Resolve the saved owner transaction before authorizing another');
      const tx = ccc.Transaction.fromBytes(scope.bytes);
      await checkOwnerTransaction(this.owner.client, tx, { sponsor: scope.quote, poolLock: this.definition.manifest.policy.poolLock, ownerLock: scope.cell.ownerLock, selected: scope.source, output: scope.output, data: scope.data, maxFee: BigInt(this.definition.manifest.policy.maxSetupFee) });
      observe(onTransaction, { phase: 'signing' });
      const signed = await this.owner.signOnlyTransaction(tx.clone());
      verifyOwnerSignatureChanges(tx, signed);
      // Dry-run discovers app scripts that forbid migration without broadcasting an invalid setup.
      if (!scope.quote) await this.owner.client.estimateCycles(signed);
      const receipt: DelegationReceipt = { version: 1, kind: 'setup', paymasterQuote: scope.quote, hash: signed.hash(), bytes: ccc.hexFrom(signed.toBytes()), confirmed: false };
      await store.save(structuredClone(receipt));
      await reconcileOwnerTransaction(this.owner.client, store, receipt, onTransaction, this.options.paymaster);
      return structuredClone(scope.cell);
    } finally { this.authorizing = false; }
  }
  async resume(store: DelegationReceiptStore, onTransaction?: (event: CounterTransactionEvent) => void): Promise<ccc.Hex> {
    await verifyDeployment(this.owner.client, this.definition.manifest.policy.deployment);
    const loaded = await store.load(), saved = loaded && structuredClone(loaded);
    if (!saved || saved.version !== 1 || !['setup', 'manual', 'recovery'].includes(saved.kind)) throw new Error('Invalid saved owner transaction');
    const tx = ccc.Transaction.fromBytes(saved.bytes), owner = (await this.owner.getRecommendedAddressObj()).script;
    const output = tx.outputs[0], manifest = this.definition.manifest;
    if (saved.kind === 'recovery') {
      const source = tx.inputs[0] && await this.owner.client.getCell(tx.inputs[0].previousOutput);
      const lock = source?.cellOutput.lock;
      if (!lock || lock.codeHash !== manifest.policy.deployment.codeHash || lock.hashType !== 'data2'
        || ccc.hexFrom(ccc.bytesFrom(lock.args).slice(0, 32)) !== owner.hash()
        || ccc.hexFrom(ccc.bytesFrom(lock.args).slice(65, 97)) !== pilotManifestHash(manifest)) throw new Error('Saved recovery belongs to another owner or application');
    }
    if (!output || scriptHash(output.type) !== scriptHash(appType(manifest))) throw new Error('Saved transaction belongs to another application');
    if (saved.kind === 'recovery' ? !output.lock.eq(owner) : output.lock.codeHash !== manifest.policy.deployment.codeHash || output.lock.hashType !== 'data2'
      || ccc.hexFrom(ccc.bytesFrom(output.lock.args).slice(0, 32)) !== owner.hash()
      || ccc.hexFrom(ccc.bytesFrom(output.lock.args).slice(65, 97)) !== pilotManifestHash(manifest)) throw new Error('Saved transaction belongs to another owner or manifest');
    return reconcileOwnerTransaction(this.owner.client, store, saved, onTransaction, this.options.paymaster);
  }
}

export function checkDelegatedTransaction(manifest: PilotAppManifest, grant: PilotDelegationGrant, id: string, cell: ccc.Cell, transaction: ccc.TransactionLike): bigint {
  assertPilotPermission(manifest, grant, id);
  const tx = ccc.Transaction.from(transaction);
  const action = manifest.actions.find(action => action.id === id)!;
  const next = applyPilotTransition(cell.outputData, action.transition);
  if (tx.inputs.length !== 1 || !tx.inputs[0]!.previousOutput.eq(cell.outPoint) || tx.inputs[0]!.since !== 0n || tx.outputs.length !== 1 || tx.outputsData.length !== 1
    || !tx.outputs[0]!.lock.eq(cell.cellOutput.lock) || scriptHash(tx.outputs[0]!.type) !== scriptHash(cell.cellOutput.type)
    || scriptHash(cell.cellOutput.type) !== scriptHash(appType(manifest)) || tx.outputsData[0] !== next) throw new PermanentSettlementError('Builder violates the approved transition or cell scope');
  const fee = cell.cellOutput.capacity - tx.outputs[0]!.capacity;
  if (fee !== (manifest.policy.kind === 'delegation-sponsored-v1' ? 0n : BigInt(manifest.policy.feePerAction)) || tx.outputs[0]!.capacity < BigInt(manifest.policy.floorCapacity)) throw new PermanentSettlementError('Builder violates fee budget or protected capacity');
  return BigInt(manifest.policy.feePerAction);
}

export class PilotDelegationAdapter<State, Params = unknown> implements Adapter<State, PilotActionRequest<Params>> {
  private constructor(private options: { definition: PilotAppDefinition<State, Params>; client: ccc.Client; cell: DelegatedCell; session: Session; sessionPrivateKey: ccc.HexLike;
    paymaster?: FeeSponsor; store: SettlementStore; onTransaction?: (event: CounterTransactionEvent) => void }, private journal: SettlementJournal) {}
  static async create<State, Params = unknown>(options: { definition: PilotAppDefinition<State, Params>; client: ccc.Client; cell: DelegatedCell; session: Session; sessionPrivateKey: ccc.HexLike;
    paymaster?: FeeSponsor; store: SettlementStore; onTransaction?: (event: CounterTransactionEvent) => void }): Promise<PilotDelegationAdapter<State, Params>> {
    const definition = definePilotApp(options.definition);
    await verifyDeployment(options.client, definition.manifest.policy.deployment);
    if ((definition.manifest.policy.kind === 'delegation-sponsored-v1') !== !!options.paymaster) throw new Error('Sponsored delegation requires paymaster; no user-paid fallback');
    const publicKey = ccc.hexFrom(secp256k1.getPublicKey(ccc.bytesFrom(options.sessionPrivateKey), true));
    const expected = delegationLock(definition.manifest, options.cell.grant, options.cell.ownerLock, publicKey);
    if (!expected.eq(options.cell.lock) || publicKey !== options.cell.sessionPublicKey || options.session.network !== definition.manifest.network || options.session.policyVersion !== definition.manifest.policy.kind) throw new Error('Delegation session identity mismatch');
    const scopeHash = ccc.hashCkb(ccc.bytesFrom(pilotCanonical({ session: options.session, lock: ccc.hexFrom(expected.toBytes()), initialOutPoint: ccc.hexFrom(ccc.OutPoint.from(options.cell.outPoint).toBytes()) }), 'utf8'));
    const journal = structuredClone(await options.store.load() ?? { scopeHash, currentOutPoint: options.cell.outPoint, transactions: {} });
    if (journal.scopeHash !== scopeHash) throw new Error('Settlement journal belongs to another delegation session');
    await options.store.save(structuredClone(journal));
    return new PilotDelegationAdapter({ ...options, definition, cell: structuredClone(options.cell), session: structuredClone(options.session), sessionPrivateKey: ccc.hexFrom(options.sessionPrivateKey) }, structuredClone(journal));
  }
  private availableSponsoredBudget(): bigint { return BigInt(this.options.definition.manifest.policy.budget) - BigInt(Object.values(this.journal.transactions).filter(r => r.confirmed).length) * BigInt(this.options.definition.manifest.policy.feePerAction); }
  get currentOutPoint(): ccc.OutPointLike { return structuredClone(this.journal.currentOutPoint); }
  /** Only adopt a confirmed owner-mode transition on the current cell. Host must drain its queue first. */
  async adoptOwnerAction(hash: ccc.HexLike, id: string): Promise<{ state: State; remainingBudget: bigint }> {
    const { client, definition, cell: delegated } = this.options;
    const receipt = await client.getTransactionNoCache(hash);
    if (receipt?.status !== 'committed') throw new Error('Owner action is not confirmed');
    const tx = receipt.transaction;
    const action = definition.manifest.actions.find(action => action.id === id);
    if (ccc.OutPoint.from(this.currentOutPoint).eq({ txHash: tx.hash(), index: 0 }) && action && tx.getWitnessArgs(0)?.lock === '0x00'
      && tx.outputs[0]?.lock.eq(delegated.lock) && scriptHash(tx.outputs[0]?.type) === scriptHash(appType(definition.manifest))) {
      return { state: definition.decodeState(tx.outputsData[0]!), remainingBudget: this.options.paymaster ? this.availableSponsoredBudget() : tx.outputs[0]!.capacity - BigInt(definition.manifest.policy.floorCapacity) };
    }
    const before = await client.getCell(this.currentOutPoint);
    if (!action || !before || !tx.inputs.some(input => input.previousOutput.eq(this.currentOutPoint))
      || tx.getWitnessArgs(0)?.lock !== '0x00' || !tx.outputs[0]?.lock.eq(delegated.lock)
      || scriptHash(tx.outputs[0]?.type) !== scriptHash(before.cellOutput.type)
      || tx.outputs[0]?.capacity !== before.cellOutput.capacity
      || tx.outputsData[0] !== applyPilotTransition(before.outputData, action.transition)) throw new Error('Receipt is not the expected owner action');
    const next = structuredClone(this.journal); next.currentOutPoint = { txHash: tx.hash(), index: 0 };
    await this.options.store.save(next); this.journal = next;
    return { state: definition.decodeState(tx.outputsData[0]!), remainingBudget: this.options.paymaster ? this.availableSponsoredBudget() : tx.outputs[0]!.capacity - BigInt(definition.manifest.policy.floorCapacity) };
  }
  async validate(action: PilotActionRequest<Params>, context: Context<State>) {
    try {
      assertPilotPermission(this.options.definition.manifest, this.options.cell.grant, action.id);
      if (pilotCanonical(context.session) !== pilotCanonical(this.options.session)) throw new Error('Session mismatch');
      const builder = this.options.definition.actions[action.id]!;
      const result = await builder.validate(action.params, structuredClone(context));
      const cost = BigInt(this.options.definition.manifest.policy.feePerAction);
      if (result.cost !== cost) throw new Error('Builder estimate does not match approved fee');
      const before = this.options.definition.encodeState(context.state);
      const after = this.options.definition.encodeState(builder.apply(structuredClone(context.state), action.params));
      const transition = this.options.definition.manifest.actions.find(entry => entry.id === action.id)!.transition;
      if (after !== applyPilotTransition(before, transition)) throw new Error('Optimistic state differs from declared on-chain transition');
      return { ...result, cost };
    } catch (error) { return { allowed: false, cost: BigInt(this.options.definition.manifest.policy.feePerAction), reason: error instanceof Error ? error.message : String(error) }; }
  }
  apply(state: State, action: PilotActionRequest<Params>): State {
    assertPilotPermission(this.options.definition.manifest, this.options.cell.grant, action.id);
    return this.options.definition.actions[action.id]!.apply(state, action.params);
  }
  async settle(request: { id: string; action: PilotActionRequest<Params>; session: Session; reservedCost: bigint }) {
    const { definition, cell: delegated, client, session, store, onTransaction } = this.options;
    assertPilotPermission(definition.manifest, delegated.grant, request.action.id);
    if (pilotCanonical(request.session) !== pilotCanonical(session) || request.reservedCost !== BigInt(definition.manifest.policy.feePerAction)) throw new PermanentSettlementError('Settlement is outside approved session limits');
    let record = this.journal.transactions[request.id];
    const commitment = pilotCanonical({ action: request.action, session: request.session, reservedCost: request.reservedCost.toString() });
    if (record && (record.actionCommitment !== commitment || ccc.Transaction.fromBytes(record.bytes).hash() !== record.hash)) throw new PermanentSettlementError('Saved transaction does not match this action');
    if (record) {
      const signed = ccc.Transaction.fromBytes(record.bytes), witness = signed.getWitnessArgs(0)?.lock;
      if (signed.inputs.length !== (this.options.paymaster ? 2 : 1) || signed.outputs.length !== (this.options.paymaster ? 2 : 1) || !signed.outputs[0]!.lock.eq(delegated.lock) || !witness
        || ccc.bytesFrom(witness).length !== 97 || ccc.bytesFrom(witness)[0] !== 1
        || ccc.hexFrom(ccc.bytesFrom(witness).slice(1, 33)) !== actionHash(request.action.id)
        || !secp256k1.verify(ccc.bytesFrom(witness).slice(33), ccc.bytesFrom(delegationSigningDigest(signed, request.action.id)),
          ccc.bytesFrom(delegated.sessionPublicKey), { prehash: false })) throw new PermanentSettlementError('Saved transaction is outside the approved delegation');
    }
    if (!record) {
      if (Date.now() >= session.expiresAt) throw new PermanentSettlementError('Local session expired');
      const cell = await live(client, this.currentOutPoint);
      if (!cell.cellOutput.lock.eq(delegated.lock)) throw new PermanentSettlementError('Live cell is not the approved delegation');
      const context = { state: definition.decodeState(cell.outputData), session, availableBudget: this.options.paymaster ? this.availableSponsoredBudget() : cell.cellOutput.capacity - BigInt(definition.manifest.policy.floorCapacity) };
      const validation = await this.validate(request.action, context);
      if (!validation.allowed || context.availableBudget < request.reservedCost) throw new PermanentSettlementError(validation.reason ?? 'On-chain budget exhausted');
      const action = definition.manifest.actions.find(entry => entry.id === request.action.id)!;
      const defaultTransaction = ccc.Transaction.from({ cellDeps: deps(definition.manifest), inputs: [{ previousOutput: cell.outPoint }],
        outputs: [{ ...cell.cellOutput, capacity: cell.cellOutput.capacity - (this.options.paymaster ? 0n : request.reservedCost) }], outputsData: [applyPilotTransition(cell.outputData, action.transition)] });
      const built = await definition.actions[request.action.id]!.buildTransaction(request.action.params, { client, cell: cell.clone(), fee: request.reservedCost, defaultTransaction: defaultTransaction.clone() });
      checkDelegatedTransaction(definition.manifest, delegated.grant, action.id, cell, built);
      const paymasterQuote = this.options.paymaster ? await this.options.paymaster.prepare(ccc.Transaction.from(built)) : undefined;
      if (paymasterQuote && ccc.Transaction.fromBytes(paymasterQuote.bytes).outputs.at(-1)!.lock.hash() !== ccc.Script.from(definition.manifest.policy.poolLock!).hash()) throw new Error('Paymaster differs from pinned pool');
      const signed = signDelegatedTransaction(paymasterQuote ? ccc.Transaction.fromBytes(paymasterQuote.bytes) : built, action.id, this.options.sessionPrivateKey);
      record = { hash: signed.hash(), bytes: ccc.hexFrom(signed.toBytes()), confirmed: false, paymasterQuote, actionCommitment: commitment };
      const next = structuredClone(this.journal); next.transactions[request.id] = record;
      await store.save(next); this.journal = next;
      observe(onTransaction, { phase: 'signed', feePayer: paymasterQuote ? 'pool' : 'user', networkFee: paymasterQuote?.fee ?? definition.manifest.policy.feePerAction, actionId: request.id, transactionHash: record.hash, transactionBytes: record.bytes });
    }
    {
      if (record.paymasterQuote && !record.confirmed) {
        if (!this.options.paymaster) throw new Error('Paymaster required to resume');
        let signed: ccc.Transaction;
        try { signed = await this.options.paymaster.submit(record.paymasterQuote, ccc.Transaction.fromBytes(record.bytes)); }
        catch (error) {
          if (error instanceof SponsorQuoteRejectedError && error.quoteId === record.paymasterQuote!.id) {
            const next = structuredClone(this.journal); delete next.transactions[request.id]; await store.save(next); this.journal = next;
          }
          throw error;
        }
        const next = structuredClone(this.journal); next.transactions[request.id]!.bytes = ccc.hexFrom(signed.toBytes());
        await store.save(next); this.journal = next; record = next.transactions[request.id]!;
      }
      const known = await client.getTransactionNoCache(record.hash);
      if (!known || known.status === 'unknown' || known.status === 'rejected') {
        observe(onTransaction, { phase: 'broadcasting', actionId: request.id, transactionHash: record.hash });
        try { await client.sendTransaction(ccc.Transaction.fromBytes(record.bytes)); }
        catch (error) {
          if (error instanceof ccc.ErrorClientVerification && error.source === 'lock' && error.scriptCodeHash === definition.manifest.policy.deployment.codeHash) throw new PermanentSettlementError(`Delegation contract rejected action: ${error.errorCode}`);
          if (!(error instanceof ccc.ErrorClientDuplicatedTransaction)) throw error;
        }
      }
      observe(onTransaction, { phase: 'confirming', actionId: request.id, transactionHash: record.hash });
      const receipt = await client.waitTransaction(record.hash, 1, 180_000);
      if (receipt?.status !== 'committed') throw new Error('Action transaction not confirmed');
      const next = structuredClone(this.journal); next.transactions[request.id]!.confirmed = true; next.currentOutPoint = { txHash: record.hash, index: 0 };
      await store.save(next); this.journal = next;
    }
    observe(onTransaction, { phase: 'confirmed', actionId: request.id, transactionHash: record.hash });
    return { transactionHash: record.hash };
  }
}

async function addOwnerProof(owner: ccc.Signer, tx: ccc.Transaction): Promise<void> {
  const lock = (await owner.getRecommendedAddressObj()).script;
  for await (const cell of owner.client.findCellsByLock(lock, null)) {
    if (cell.outputData !== '0x' || cell.cellOutput.type || tx.inputs.some(input => input.previousOutput.eq(cell.outPoint))) continue;
    tx.inputs.push(ccc.CellInput.from({ previousOutput: cell.outPoint })); return;
  }
  throw new Error('Owner needs an ordinary live cell to authorize this action');
}

/** Owner path works even for actions omitted from the delegated subset. It still respects app rules. */
const ownerReviews = new WeakMap<ccc.Transaction, { bytes: ccc.Hex; kind: 'manual' | 'recovery'; ownerHash: ccc.Hex; scope: Parameters<typeof checkOwnerTransaction>[2]; paymaster?: FeeSponsor }>();
export async function prepareOwnerAction<State, Params>(owner: ccc.Signer, definition: PilotAppDefinition<State, Params>, delegated: Pick<DelegatedCell, 'lock' | 'ownerLock'>,
  currentOutPoint: ccc.OutPointLike, action: PilotActionRequest<Params>, session: Session, options: { paymaster?: FeeSponsor } = {}): Promise<ccc.Transaction> {
  definition = definePilotApp(definition); await verifyDeployment(owner.client, definition.manifest.policy.deployment);
  const ownerLock = (await owner.getRecommendedAddressObj()).script.clone();
  if (!ownerLock.eq(delegated.ownerLock)) throw new Error('Wallet is not the delegation owner');
  const cell = await live(owner.client, currentOutPoint);
  if (!cell.cellOutput.lock.eq(delegated.lock)) throw new Error('Wrong delegation cell');
  if (scriptHash(cell.cellOutput.type) !== scriptHash(appType(definition.manifest))) throw new Error('Cell belongs to another application');
  if (!cell.cellOutput.lock.eq(ownerLock) && ccc.hexFrom(ccc.bytesFrom(cell.cellOutput.lock.args).slice(0, 32)) !== ownerLock.hash()) throw new Error('Cell does not recognize this owner');
  const entry = definition.manifest.actions.find(entry => entry.id === action.id);
  const builder = definition.actions[action.id];
  if (!entry || !builder) throw new Error('Unknown manual action');
  const context = { state: definition.decodeState(cell.outputData), session, availableBudget: 0n };
  const validation = await builder.validate(action.params, structuredClone(context));
  if (!validation.allowed) throw new Error(validation.reason ?? 'Invalid owner action');
  const data = applyPilotTransition(cell.outputData, entry.transition);
  if (definition.encodeState(builder.apply(structuredClone(context.state), action.params)) !== data) throw new Error('Owner action projection does not match transition');
  const defaultTransaction = ccc.Transaction.from({ cellDeps: deps(definition.manifest), inputs: [{ previousOutput: cell.outPoint }], outputs: [cell.cellOutput.clone()], outputsData: [data] });
  const tx = ccc.Transaction.from(await builder.buildTransaction(action.params, { client: owner.client, cell: cell.clone(), fee: 0n, defaultTransaction: defaultTransaction.clone() })).clone();
  tx.setWitnessArgs(0, { ...tx.getWitnessArgs(0), lock: '0x00' });
  if (options.paymaster) await addOwnerProof(owner, tx);
  await tx.completeFeeBy(owner, options.paymaster ? 0n : 1000n);
  let prepared = (await owner.prepareTransaction(tx.clone())).clone();
  const quote = options.paymaster ? await options.paymaster.prepare(prepared) : undefined;
  if (quote) prepared = ccc.Transaction.fromBytes(quote.bytes);
  if (definition.manifest.policy.poolLock && !options.paymaster) throw new Error('Paymaster required; no user-paid fallback');
  const scope = { sponsor: quote, poolLock: definition.manifest.policy.poolLock, ownerLock, selected: cell, output: cell.cellOutput, data, maxFee: BigInt(definition.manifest.policy.maxSetupFee) };
  await checkOwnerTransaction(owner.client, prepared, scope);
  ownerReviews.set(prepared, { bytes: ccc.hexFrom(prepared.toBytes()), kind: 'manual', ownerHash: ownerLock.hash(), scope, paymaster: options.paymaster });
  return prepared;
}

export async function prepareDelegationRecovery(owner: ccc.Signer, manifest: PilotAppManifest, delegated: DelegatedCell, currentOutPoint: ccc.OutPointLike, options: { paymaster?: FeeSponsor } = {}): Promise<ccc.Transaction> {
  if (delegated.grant.manifestHash !== pilotManifestHash(manifest)) throw new Error('Recovery manifest differs from the approved delegation');
  await verifyDeployment(owner.client, manifest.policy.deployment);
  const ownerLock = (await owner.getRecommendedAddressObj()).script.clone();
  if (!ownerLock.eq(delegated.ownerLock)) throw new Error('Wallet is not the delegation owner');
  if (!delegationLock(manifest, delegated.grant, ownerLock, delegated.sessionPublicKey).eq(delegated.lock)) throw new Error('Recovery cell does not match approved policy');
  const cell = await live(owner.client, currentOutPoint);
  if (!cell.cellOutput.lock.eq(delegated.lock)) throw new Error('Wrong delegation cell');
  const output = ccc.CellOutput.from({ ...cell.cellOutput, lock: ownerLock });
  const tx = ccc.Transaction.from({ cellDeps: deps(manifest), inputs: [{ previousOutput: cell.outPoint }], outputs: [output.clone()], outputsData: [cell.outputData] });
  tx.setWitnessArgs(0, { ...tx.getWitnessArgs(0), lock: '0x00' });
  if (options.paymaster) await addOwnerProof(owner, tx);
  await tx.completeFeeBy(owner, options.paymaster ? 0n : 1000n);
  let prepared = (await owner.prepareTransaction(tx.clone())).clone();
  const quote = options.paymaster ? await options.paymaster.prepare(prepared) : undefined;
  if (quote) prepared = ccc.Transaction.fromBytes(quote.bytes);
  if (manifest.policy.poolLock && !options.paymaster) throw new Error('Paymaster required; no user-paid fallback');
  const scope = { sponsor: quote, poolLock: manifest.policy.poolLock, ownerLock, selected: cell, output, data: cell.outputData, maxFee: BigInt(manifest.policy.maxRecoveryFee) };
  await checkOwnerTransaction(owner.client, prepared, scope);
  ownerReviews.set(prepared, { bytes: ccc.hexFrom(prepared.toBytes()), kind: 'recovery', ownerHash: ownerLock.hash(), scope, paymaster: options.paymaster });
  return prepared;
}

/** Reviewed owner paths: signed bytes persist before broadcast, and resume never requests another signature. */
export async function submitOwnerDelegationTransaction(owner: ccc.Signer, transaction: ccc.TransactionLike, kind: 'manual' | 'recovery', store: DelegationReceiptStore,
  onTransaction?: (event: CounterTransactionEvent) => void): Promise<ccc.Hex> {
  const reviewed = ownerReviews.get(transaction as ccc.Transaction);
  if (!reviewed || reviewed.kind !== kind || reviewed.bytes !== ccc.hexFrom(ccc.Transaction.from(transaction).toBytes())
    || reviewed.ownerHash !== (await owner.getRecommendedAddressObj()).script.hash()) throw new Error('Unknown or changed owner transaction review');
  await checkOwnerTransaction(owner.client, transaction, reviewed.scope);
  if (await store.load()) throw new Error('Resolve the saved owner transaction before submitting another');
  const unsigned = ccc.Transaction.from(transaction).clone();
  observe(onTransaction, { phase: 'signing' });
  const signed = await owner.signOnlyTransaction(unsigned.clone());
  verifyOwnerSignatureChanges(unsigned, signed);
  if (!reviewed.scope.sponsor) await owner.client.estimateCycles(signed);
  const receipt: DelegationReceipt = { version: 1, kind, paymasterQuote: reviewed.scope.sponsor, hash: signed.hash(), bytes: ccc.hexFrom(signed.toBytes()), confirmed: false };
  await store.save(structuredClone(receipt));
  observe(onTransaction, { phase: 'signed', feePayer: reviewed.scope.sponsor ? 'pool' : 'user', networkFee: reviewed.scope.sponsor?.fee, transactionHash: signed.hash(), transactionBytes: ccc.hexFrom(signed.toBytes()) });
  return reconcileOwnerTransaction(owner.client, store, receipt, onTransaction, reviewed.paymaster);
}
