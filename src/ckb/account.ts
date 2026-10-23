import { ccc } from '@ckb-ccc/core';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { PILOT_ACCOUNT_CODE_HASH } from './account-code.js';
import { deploymentDep, verifyDeployment, type Deployment } from './counter.js';
import { assertPilotSigningOwner, verifyOwnerSignatureChanges } from './owner.js';
import { verifySponsorQuote, SponsorQuoteRejectedError, type FeeSponsor, type SponsorQuote } from '../paymaster.js';
export { PILOT_ACCOUNT_CODE_HASH } from './account-code.js';
const u64 = (n: bigint) => {
  if (n < 0n || n > (1n << 64n) - 1n) throw new Error('Account amount outside u64');
  const bytes = new Uint8Array(8); new DataView(bytes.buffer).setBigUint64(0, n, true); return bytes;
};
export interface PilotAccountDescriptor {
  version: 1; deployment: Deployment; ownerLock: ccc.ScriptLike; publicKey: ccc.Hex; poolLock: ccc.ScriptLike; maxFee: string;
}
export interface PilotAccountKeyStore {
  /** Store must atomically persist a key before the account can receive funds. Never log/export this value. */
  load(scope: string): Promise<ccc.Hex | undefined>;
  save(scope: string, key: ccc.Hex): Promise<void>;
}
export interface PilotAccountTransaction {
  id: string; requestHash?: ccc.Hex; action: string; kind: 'action' | 'funding' | 'recovery'; hash: ccc.Hex; bytes: ccc.Hex; quote?: SponsorQuote;
  status: 'signed' | 'submitted' | 'confirmed' | 'requote'; createdAt: number;
}
export interface PilotAccountMessage { id: string; action: string; messageHash: ccc.Hex; createdAt: number }
export interface PilotAccountJournal { version: 1; accountHash: ccc.Hex; stopped: boolean; transactions: PilotAccountTransaction[]; messages?: PilotAccountMessage[] }
export interface PilotAccountJournalStore {
  load(): Promise<PilotAccountJournal | undefined>;
  save(journal: PilotAccountJournal): Promise<void>;
}
export interface PilotAccountAction {
  id: string; name: string;
  /** Required, app-specific effect validation. Permission names alone never authorize arbitrary bytes. */
  validateTransaction?: (transaction: ccc.Transaction, account: PilotAccountDescriptor) => void | Promise<void>;
  validateMessage?: (message: string | ccc.BytesLike, account: PilotAccountDescriptor) => void | Promise<void>;
}
export interface PilotAccountOptions {
  owner: ccc.Signer; deployment: Deployment; poolLock: ccc.ScriptLike; maxFee: bigint;
  keys: PilotAccountKeyStore; journal: PilotAccountJournalStore; paymaster: FeeSponsor;
  actions: readonly PilotAccountAction[]; permissions: readonly string[];
  /** Cross-tab/process exclusive lease. Keep it until the operation completes. */
  exclusive: <T>(operation: () => Promise<T>) => Promise<T>;
  onTransaction?: (record: Readonly<PilotAccountTransaction>) => void;
}
export function pilotAccountLock(account: PilotAccountDescriptor): ccc.Script {
  if (account.version !== 1 || account.deployment.codeHash !== PILOT_ACCOUNT_CODE_HASH) throw new Error('Unsupported Pilot account deployment');
  const key = ccc.bytesFrom(account.publicKey); if (key.length !== 33) throw new Error('Invalid account public key');
  secp256k1.Point.fromBytes(key);
  const owner = ccc.Script.from(account.ownerLock), pool = ccc.Script.from(account.poolLock);
  const fee = BigInt(account.maxFee); if (fee <= 0n || owner.eq(pool)) throw new Error('Pin a separate pool and positive fee limit');
  return ccc.Script.from({ codeHash: PILOT_ACCOUNT_CODE_HASH, hashType: 'data2', args: ccc.hexFrom(ccc.bytesConcat(owner.hash(), key, pool.hash(), u64(fee))) });
}
export function pilotAccountSigningDigest(transaction: ccc.TransactionLike, accountInput: number): ccc.Hex {
  const tx = ccc.Transaction.from(transaction).clone(); const poolIndex = tx.inputs.length - 1;
  if (accountInput < 0 || accountInput >= poolIndex) throw new Error('Invalid account signing position');
  tx.setWitnessArgs(accountInput, { ...tx.getWitnessArgs(accountInput), lock: '0x01' });
  tx.setWitnessArgs(poolIndex, { ...tx.getWitnessArgs(poolIndex), lock: '0x' });
  return ccc.hashCkb(ccc.bytesFrom('owl-pilot-account-v1', 'utf8'), tx.hash(),
    ...tx.witnesses.flatMap(w => [u64(BigInt(ccc.bytesFrom(w).length)), ccc.bytesFrom(w)]));
}
/** Verifies the NEW account key only. This is not proof of the original owner's identity. */
export async function verifyPilotAccountMessage(account: PilotAccountDescriptor, message: string | ccc.BytesLike, signature: ccc.Signature): Promise<boolean> {
  pilotAccountLock(account);
  return signature.identity === account.publicKey && signature.signType === ccc.SignerSignType.CkbSecp256k1
    && ccc.Signer.verifyMessage(message, signature);
}
/** Verify the claimed owner->account link using a committed funding transaction.
 * A descriptor and a valid account-key message alone are NOT an owner authorization proof.
 */
export async function verifyPilotAccountOwnership(client: ccc.Client, account: PilotAccountDescriptor, fundingHash: ccc.Hex): Promise<boolean> {
  await verifyDeployment(client, account.deployment); await assertPilotSigningOwner(client, account.ownerLock);
  const receipt = await client.getTransactionNoCache(fundingHash);
  if (receipt?.status !== 'committed' || receipt.transaction.hash() !== fundingHash
    || !receipt.transaction.outputs.some(output => output.lock.eq(pilotAccountLock(account)))) return false;
  for (const input of receipt.transaction.inputs) {
    const cell = await client.getCell(input.previousOutput);
    if (cell?.cellOutput.lock.eq(account.ownerLock)) return true;
  }
  return false;
}
const serialized = <T>(value: T): T => JSON.parse(JSON.stringify(value, (_key, v) => typeof v === 'bigint' ? v.toString() : v));

/** A CCC-compatible signer for a NEW persistent account, not the original owner's identity.
 * All spend paths require sponsorship. Use sendTransaction; raw account-only signatures are not exposed.
 * Keys and journals are trusted custody storage. This class is not an isolated wallet vault.
 */
export class PilotAccountSigner extends ccc.Signer {
  #key: ccc.Hex;
  private constructor(readonly options: PilotAccountOptions, readonly descriptor: PilotAccountDescriptor, key: ccc.Hex, readonly actionId?: string) {
    super(options.owner.client); this.#key = key;
    const freeze = (value: object) => { for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child); Object.freeze(value); };
    freeze(descriptor);
  }
  static async create(options: PilotAccountOptions): Promise<PilotAccountSigner> {
    await verifyDeployment(options.owner.client, options.deployment);
    if (options.deployment.codeHash !== PILOT_ACCOUNT_CODE_HASH) throw new Error('Deploy the Pilot account lock first');
    const owner = (await options.owner.getRecommendedAddressObj()).script;
    await assertPilotSigningOwner(options.owner.client, owner);
    const pool = ccc.Script.from(options.poolLock);
    const known = await options.owner.client.getKnownScript(ccc.KnownScript.Secp256k1Blake160);
    if (pool.codeHash !== known.codeHash || pool.hashType !== known.hashType || ccc.bytesFrom(pool.args).length !== 20) throw new Error('Account sponsorship requires an ordinary secp256k1 pool');
    if (new Set(options.actions.map(a => a.id)).size !== options.actions.length || options.actions.some(a => !a.id || !a.name)
      || new Set(options.permissions).size !== options.permissions.length || options.permissions.some(id => !options.actions.some(a => a.id === id))) throw new Error('Invalid account actions/permissions');
    return options.exclusive(async () => {
      // Lock configuration is part of the key namespace: changing it must not silently create another funded identity.
      const scope = `pilot:account:v1:${options.deployment.genesisHash}:${owner.hash()}`;
      let key = await options.keys.load(scope);
      const savedJournal = await options.journal.load();
      if (!key && savedJournal) throw new Error('Account key missing; use the saved public descriptor for owner recovery');
      if (key && !savedJournal) throw new Error('Account journal missing; restore its public descriptor/journal before reusing this key');
      if (!key) { key = ccc.hexFrom(secp256k1.utils.randomSecretKey()); await options.keys.save(scope, key); }
      const descriptor: PilotAccountDescriptor = serialized({ version: 1, deployment: options.deployment, ownerLock: owner,
        publicKey: ccc.hexFrom(secp256k1.getPublicKey(ccc.bytesFrom(key), true)), poolLock: pool, maxFee: options.maxFee.toString() });
      const signer = new PilotAccountSigner(options, descriptor, key);
      const journal = await options.journal.load();
      if (journal && (journal.version !== 1 || journal.accountHash !== signer.lock.hash())) throw new Error('Saved account configuration changed; recover the old account before migrating');
      if (!journal) await options.journal.save({ version: 1, accountHash: signer.lock.hash(), stopped: false, transactions: [] });
      return signer;
    });
  }
  get lock(): ccc.Script { return pilotAccountLock(this.descriptor); }
  get type() { return ccc.SignerType.CKB; }
  get signType() { return ccc.SignerSignType.CkbSecp256k1; }
  async connect() {}
  async disconnect() { await this.stop(); }
  async isConnected() { return !(await this.journal()).stopped && await this.options.owner.isConnected() && (await this.options.owner.getRecommendedAddressObj()).script.eq(this.descriptor.ownerLock); }
  private async assertActiveOwner() {
    if (!await this.options.owner.isConnected() || !(await this.options.owner.getRecommendedAddressObj()).script.eq(this.descriptor.ownerLock)) throw new Error('Active wallet changed; select this Pilot account owner before requesting new signatures');
  }
  async getAddressObjs() { return [ccc.Address.from({ prefix: this.client.addressPrefix, script: this.lock })]; }
  async getInternalAddress() { return this.getRecommendedAddress(); }
  async getIdentity() { return this.descriptor.publicKey; }
  forAction(id: string): PilotAccountSigner {
    this.action(id); return new PilotAccountSigner(this.options, this.descriptor, this.#key, id);
  }
  private action(id = this.actionId): PilotAccountAction {
    const action = this.options.actions.find(a => a.id === id);
    if (!action || !this.options.permissions.includes(action.id)) throw new Error('Choose an approved account action with forAction(id)');
    return action;
  }
  private async journal() {
    const journal = await this.options.journal.load();
    if (!journal || journal.version !== 1 || journal.accountHash !== this.lock.hash()) throw new Error('Missing or mismatched account journal');
    for (const record of journal.transactions) if (ccc.Transaction.fromBytes(record.bytes).hash() !== record.hash) throw new Error('Corrupt account receipt');
    return journal;
  }
  private async save(journal: PilotAccountJournal, record: PilotAccountTransaction) {
    const previous = journal.transactions.findIndex(r => r.id === record.id);
    if (previous < 0) journal.transactions.push(record); else journal.transactions[previous] = record;
    await this.options.journal.save(journal);
    try { this.options.onTransaction?.(serialized(record)); } catch { /* diagnostic only */ }
  }
  async transactions(): Promise<PilotAccountTransaction[]> { return serialized((await this.journal()).transactions); }
  async stop(): Promise<void> { await this.options.exclusive(async () => { const j = await this.journal(); j.stopped = true; await this.options.journal.save(j); }); }
  async signMessageRaw(message: string | ccc.BytesLike): Promise<string> {
    return this.options.exclusive(async () => {
      const action = this.action(); if ((await this.journal()).stopped) throw new Error('Account signing is stopped');
      if (!action.validateMessage) throw new Error('This action does not permit message signing');
      await action.validateMessage(message, serialized(this.descriptor));
      await this.assertActiveOwner();
      const signature = await new ccc.SignerCkbPrivateKey(this.client, this.#key).signMessageRaw(message);
      const journal = await this.journal();
      (journal.messages ??= []).push({ id: crypto.randomUUID(), action: action.id, messageHash: ccc.hashCkb(typeof message === 'string' ? ccc.bytesFrom(message, 'utf8') : message), createdAt: Date.now() });
      await this.options.journal.save(journal);
      return signature;
    });
  }
  async prepareTransaction(value: ccc.TransactionLike): Promise<ccc.Transaction> {
    const tx = ccc.Transaction.from(value).clone();
    tx.cellDeps.push(ccc.CellDep.from(deploymentDep(this.descriptor.deployment)));
    tx.cellDeps = tx.cellDeps.filter((dep, i, deps) => deps.findIndex(d => ccc.hexFrom(d.toBytes()) === ccc.hexFrom(dep.toBytes())) === i);
    for (let i = tx.witnesses.length; i < tx.inputs.length; i++) tx.witnesses.push('0x');
    const index = await this.accountInput(tx);
    tx.setWitnessArgs(index, { ...tx.getWitnessArgs(index), lock: ccc.hexFrom(ccc.bytesConcat([1], new Uint8Array(64))) });
    return tx;
  }
  private async accountInput(tx: ccc.Transaction): Promise<number> {
    let first = -1;
    for (const [i, input] of tx.inputs.entries()) {
      const cell = await this.client.getCell(input.previousOutput);
      if (!cell) throw new Error('Missing input cell');
      if (cell.cellOutput.lock.eq(this.lock) && first < 0) first = i;
      if (cell.cellOutput.lock.codeHash === PILOT_ACCOUNT_CODE_HASH && !cell.cellOutput.lock.eq(this.lock)) throw new Error('A transaction cannot mix Pilot accounts');
      if (cell.cellOutput.lock.eq(this.descriptor.poolLock)) throw new Error('App must not select pool inputs');
    }
    if (first < 0) throw new Error('Transaction does not spend this Pilot account');
    if (tx.outputs.some(o => o.lock.eq(this.descriptor.poolLock))) throw new Error('App must not create pool outputs');
    return first;
  }
  async signOnlyTransaction(_: ccc.TransactionLike): Promise<ccc.Transaction> {
    throw new Error('Use PilotAccountSigner.sendTransaction: persist and submit through the paymaster, never expose an unrestricted signing key');
  }
  async sendTransaction(value: ccc.TransactionLike, requestId?: string): Promise<ccc.Hex> {
    if (requestId !== undefined && (!requestId || requestId.length > 128)) throw new Error('Use a nonempty request ID of at most 128 characters');
    return this.options.exclusive(async () => {
      await this.resumeUnlocked();
      const journal = await this.journal();
      const action = this.action(); if (!action.validateTransaction) throw new Error('This action does not permit transactions');
      const tx = await this.prepareTransaction(value);
      const index = await this.accountInput(tx);
      const checkedBytes = ccc.hexFrom(tx.toBytes());
      const requestHash = ccc.hashCkb(tx.toBytes());
      const existing = requestId ? journal.transactions.find(r => r.id === requestId) : undefined;
      if (existing) {
        if (existing.kind !== 'action' || existing.action !== action.id || existing.requestHash !== requestHash) throw new Error('Request ID already belongs to different account effects');
        if (existing.status !== 'requote') return existing.hash;
      }
      if (journal.stopped) throw new Error('Account signing is stopped');
      await action.validateTransaction(tx.clone(), serialized(this.descriptor));
      if (ccc.hexFrom(tx.toBytes()) !== checkedBytes) throw new Error('Action validator mutated transaction');
      const quote = await this.options.paymaster.prepare(tx.clone());
      const sponsored = await verifySponsorQuote(this.client, tx, quote, this.descriptor.poolLock, BigInt(this.descriptor.maxFee));
      await this.assertActiveOwner();
      const signature = secp256k1.sign(ccc.bytesFrom(pilotAccountSigningDigest(sponsored, index)), ccc.bytesFrom(this.#key), { prehash: false });
      sponsored.setWitnessArgs(index, { ...sponsored.getWitnessArgs(index), lock: ccc.hexFrom(ccc.bytesConcat([1], signature)) });
      const record: PilotAccountTransaction = { id: requestId ?? crypto.randomUUID(), requestHash, kind: 'action', action: action.id, hash: sponsored.hash(),
        bytes: ccc.hexFrom(sponsored.toBytes()), quote, status: 'signed', createdAt: Date.now() };
      await this.save(journal, record); // durable BEFORE exposing the signature to the paymaster
      return this.submit(journal, record, false);
    });
  }
  private async submit(journal: PilotAccountJournal, record: PilotAccountTransaction, wait: boolean): Promise<ccc.Hex> {
    let tx = ccc.Transaction.fromBytes(record.bytes);
    const known = await this.client.getTransactionNoCache(record.hash);
    if (known?.status === 'committed') { record.status = 'confirmed'; await this.save(journal, record); return record.hash; }
    if (!known || known.status === 'unknown' || known.status === 'rejected') {
      if (record.quote) {
        try {
          const signed = await this.options.paymaster.submit(record.quote, tx.clone());
          if (signed.hash() !== tx.hash() || signed.witnesses.length !== tx.witnesses.length
            || signed.witnesses.some((w, i) => i !== signed.inputs.length - 1 && w !== tx.witnesses[i])) throw new Error('Paymaster changed signed account effects');
          const before = tx.getWitnessArgs(tx.inputs.length - 1), after = signed.getWitnessArgs(signed.inputs.length - 1);
          if (before?.inputType !== after?.inputType || before?.outputType !== after?.outputType) throw new Error('Paymaster changed type witnesses');
          tx = signed;
        } catch (error) {
          // This typed rejection means the service has not signed the quote; unknown failures remain reserved.
          if (error instanceof SponsorQuoteRejectedError && error.quoteId === record.quote.id) {
            record.status = 'requote'; await this.save(journal, record);
          }
          throw error;
        }
      } else await this.client.sendTransaction(tx);
      record.bytes = ccc.hexFrom(tx.toBytes()); record.status = 'submitted'; await this.save(journal, record);
    }
    if (wait) {
      const receipt = await this.client.waitTransaction(record.hash, 1, 180_000);
      if (receipt?.status !== 'committed') throw new Error('Account transaction is unresolved; keep its reservation and retry');
      record.status = 'confirmed'; await this.save(journal, record);
    }
    return record.hash;
  }
  private async resumeUnlocked(): Promise<void> {
    const journal = await this.journal();
    for (const record of journal.transactions) if (record.status !== 'confirmed' && record.status !== 'requote') await this.submit(journal, record, true);
  }
  async resume(): Promise<void> { return this.options.exclusive(() => this.resumeUnlocked()); }
  /** Owner operations are signed by the connected owner, with exact bytes saved before sponsorship/broadcast. */
  async fund(capacity: bigint): Promise<ccc.Hex> {
    return this.ownerOperation('funding', async owner => {
      const output = ccc.CellOutput.from({ lock: this.lock, capacity });
      if (capacity < ccc.fixedPointFrom(output.occupiedSize)) throw new Error('Funding is below the account cell capacity requirement');
      const tx = ccc.Transaction.from({ outputs: [output], outputsData: ['0x'] });
      await tx.completeInputsByCapacity(owner); await tx.completeFeeBy(owner, 0n); return tx;
    });
  }
  async recover(): Promise<ccc.Hex> {
    return this.ownerOperation('recovery', owner => preparePilotAccountRecovery(owner, this.descriptor));
  }
  private async ownerOperation(kind: 'funding' | 'recovery', build: (owner: ccc.Signer) => Promise<ccc.Transaction>): Promise<ccc.Hex> {
    return this.options.exclusive(async () => {
      if (!(await this.options.owner.getRecommendedAddressObj()).script.eq(this.descriptor.ownerLock)) throw new Error('Connected wallet is not this account owner');
      const journal = await this.journal();
      if (kind === 'recovery') { journal.stopped = true; await this.options.journal.save(journal); }
      await this.resumeUnlocked();
      const base = await build(this.options.owner);
      const quote = await this.options.paymaster.prepare(base.clone());
      const quoted = await verifySponsorQuote(this.client, base, quote, this.descriptor.poolLock, BigInt(this.descriptor.maxFee));
      const signed = await this.options.owner.signTransaction(quoted.clone());
      verifyOwnerSignatureChanges(quoted, signed);
      const record: PilotAccountTransaction = { id: crypto.randomUUID(), action: kind, kind, hash: signed.hash(), bytes: ccc.hexFrom(signed.toBytes()), quote, status: 'signed', createdAt: Date.now() };
      // Reload: resumeUnlocked may have updated receipt statuses.
      const current = await this.journal(); await this.save(current, record);
      const hash = await this.submit(current, record, true);
      if (kind === 'funding') { current.stopped = false; await this.options.journal.save(current); }
      return hash;
    });
  }
}

/** Independent recovery needs only this PUBLIC descriptor and the owner's signer, never the Pilot private key/journal.
 * Recovers all indexed ordinary CKB cells. Typed/data-bearing assets require app-specific recovery builders.
 */
export async function preparePilotAccountRecovery(owner: ccc.Signer, account: PilotAccountDescriptor): Promise<ccc.Transaction> {
  await verifyDeployment(owner.client, account.deployment); await assertPilotSigningOwner(owner.client, account.ownerLock);
  const ownerLock = (await owner.getRecommendedAddressObj()).script;
  if (!ownerLock.eq(account.ownerLock)) throw new Error('Wrong recovery owner');
  const lock = pilotAccountLock(account); const inputs: ccc.CellInputLike[] = []; let capacity = 0n;
  for await (const cell of owner.client.findCellsByLock(lock, null)) {
    if (cell.cellOutput.type || cell.outputData !== '0x') continue;
    if (!await owner.client.getCellLive(cell.outPoint, true)) throw new Error('Account changed during recovery; reconcile pending actions');
    inputs.push({ previousOutput: cell.outPoint }); capacity += cell.cellOutput.capacity;
    if (inputs.length > 60) throw new Error('Recover account cells in reviewed batches; too many inputs');
  }
  if (!inputs.length) throw new Error('No recoverable ordinary account cells; app assets require compatible builders');
  const proof = await (async () => { for await (const cell of owner.client.findCellsByLock(ownerLock, null)) {
    if (!cell.cellOutput.type && cell.outputData === '0x' && await owner.client.getCellLive(cell.outPoint, true)) return cell;
  } return undefined; })();
  if (!proof) throw new Error('Owner needs an ordinary live CKB cell to prove recovery authority');
  const tx = ccc.Transaction.from({ inputs: [...inputs, { previousOutput: proof.outPoint }],
    outputs: [{ lock: ownerLock, capacity: capacity + proof.cellOutput.capacity }], outputsData: ['0x'], cellDeps: [deploymentDep(account.deployment)] });
  tx.setWitnessArgs(0, { lock: '0x00' });
  await tx.addCellDepsOfKnownScripts(owner.client, ccc.KnownScript.Secp256k1Blake160); // owner.prepareTransaction adds its own lock deps
  return owner.prepareTransaction(tx);
}

export interface PilotAccountRecoveryReceipt { version: 1; accountHash: ccc.Hex; transaction: PilotAccountTransaction }
/** Independent sponsored recovery: a public descriptor + owner wallet, no Pilot private key.
 * Use a fresh durable receipt store for each recovery request; preserve it on uncertain outcomes.
 * Stop/reconcile the normal signer first when available. Otherwise recovery may race its transactions;
 * a chain conflict requires rebuilding from live cells after checking the original receipt.
 */
export async function recoverPilotAccount(options: {
  owner: ccc.Signer; account: PilotAccountDescriptor; paymaster: FeeSponsor;
  receipt: { load(): Promise<PilotAccountRecoveryReceipt | undefined>; save(value: PilotAccountRecoveryReceipt): Promise<void> };
  onTransaction?: (record: PilotAccountTransaction) => void;
}): Promise<ccc.Hex> {
  const { owner, account, paymaster, receipt } = options; const lock = pilotAccountLock(account);
  if (!(await owner.getRecommendedAddressObj()).script.eq(account.ownerLock)) throw new Error('Wrong recovery owner');
  await verifyDeployment(owner.client, account.deployment); await assertPilotSigningOwner(owner.client, account.ownerLock);
  let saved = await receipt.load();
  const save = async () => {
    await receipt.save(saved!); try { options.onTransaction?.(serialized(saved!.transaction)); } catch { /* diagnostics */ }
  };
  if (!saved) {
    const base = await preparePilotAccountRecovery(owner, account);
    const quote = await paymaster.prepare(base.clone());
    const quoted = await verifySponsorQuote(owner.client, base, quote, account.poolLock, BigInt(account.maxFee));
    const signed = await owner.signTransaction(quoted.clone()); verifyOwnerSignatureChanges(quoted, signed);
    saved = { version: 1, accountHash: lock.hash(), transaction: { id: crypto.randomUUID(), action: 'recovery', kind: 'recovery', hash: signed.hash(),
      bytes: ccc.hexFrom(signed.toBytes()), quote, status: 'signed', createdAt: Date.now() } };
    await save();
  }
  const record = saved.transaction;
  if (saved.version !== 1 || saved.accountHash !== lock.hash() || record.kind !== 'recovery' || record.hash !== ccc.Transaction.fromBytes(record.bytes).hash() || !record.quote) throw new Error('Recovery receipt belongs to another account or is corrupt');
  const known = await owner.client.getTransactionNoCache(record.hash);
  if (known?.status !== 'committed') {
    if (!known || known.status === 'unknown' || known.status === 'rejected') {
      const original = ccc.Transaction.fromBytes(record.bytes);
      const signed = await paymaster.submit(record.quote, original.clone());
      if (signed.hash() !== record.hash || signed.witnesses.length !== original.witnesses.length
        || signed.witnesses.some((w,i) => i !== signed.inputs.length-1 && w !== original.witnesses[i])) throw new Error('Paymaster changed recovery transaction');
      const a = original.getWitnessArgs(original.inputs.length-1), b = signed.getWitnessArgs(signed.inputs.length-1);
      if (a?.inputType !== b?.inputType || a?.outputType !== b?.outputType) throw new Error('Paymaster changed recovery type witnesses');
      record.bytes = ccc.hexFrom(signed.toBytes()); record.status = 'submitted'; await save();
    }
    if ((await owner.client.waitTransaction(record.hash, 1, 180_000))?.status !== 'committed') throw new Error('Recovery is unresolved; retain its receipt and retry');
  }
  record.status = 'confirmed'; await save(); return record.hash;
}
