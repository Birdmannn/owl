import { PILOT_ACCOUNT_CODE_HASH } from '../src/ckb/account-code.js';
import { PILOT_WALLET_SESSION_CODE_HASH, PILOT_PASSKEY_CODE_HASH } from '../src/wallet/code.js';
import { createServer, type RequestListener } from 'node:http';
import { PostgresJournal, postgresPool } from './postgres.js';
import { readJson, MemoryRateLimiter, requestIp, type RateLimiter } from './http.js';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import lockfile from 'proper-lockfile';
import { ccc } from '@ckb-ccc/core';
import { inputCapacity, type SponsorQuote } from '../src/paymaster.js';
import { assertPilotSigningOwner, verifyOwnerSignatureChanges } from '../src/ckb/owner.js';
class Requote extends Error { constructor(readonly quoteId: ccc.Hex) { super('Requote unsigned request'); } }
interface Record { quote: SponsorQuote; bytes?: ccc.Hex; day: string; owner: string; accounts?: string[] }
export interface PaymasterData { version: 1; records: Record[] }
export interface PaymasterStorage {
  init(): Promise<void>;
  exclusive<T>(operation: (data: PaymasterData) => Promise<T>): Promise<T>;
}
function validatePaymasterData(value: unknown): asserts value is PaymasterData {
  const data = value as PaymasterData;
  if (!data || data.version !== 1 || !Array.isArray(data.records)) throw new Error('Invalid paymaster journal');
}
export class PostgresPaymasterStore implements PaymasterStorage {
  readonly pool; readonly journal;
  constructor(url: string, poolLockHash: string) {
    this.pool = postgresPool(url);
    this.journal = new PostgresJournal(this.pool, `paymaster:ckb-testnet:${poolLockHash}`,
      (): PaymasterData => ({ version: 1, records: [] }), validatePaymasterData);
  }
  init() { return this.journal.init(); }
  exclusive<T>(operation: (data: PaymasterData) => Promise<T>) { return this.journal.exclusive(operation); }
  close() { return this.pool.end(); }
}
/** Durable quotes, pool-input leases, spending caps, and retry bytes. Run one chain/network per file. */
export class PaymasterStore {
  constructor(readonly file: string) {}
  async init() { await mkdir(dirname(this.file), { recursive: true }); try { await writeFile(this.file, JSON.stringify({ version: 1, records: [] }), { flag: 'wx', mode: 0o600 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; } }
  async exclusive<T>(operation: (data: PaymasterData) => Promise<T>): Promise<T> {
    const release = await lockfile.lock(this.file, { realpath: false, retries: { retries: 30, minTimeout: 20, maxTimeout: 100 } });
    try {
      const data = JSON.parse(await readFile(this.file, 'utf8')) as PaymasterData;
      if (data.version !== 1 || !Array.isArray(data.records)) throw new Error('Invalid paymaster journal');
      const result = await operation(data), temp = this.file + '.' + randomUUID() + '.tmp';
      await writeFile(temp, JSON.stringify(data), { mode: 0o600 }); await rename(temp, this.file); return result;
    } finally { await release(); }
  }
}
export class PilotPaymaster {
  private constructor(readonly options: { signer: ccc.Signer; store: PaymasterStorage; maxFee: bigint; feeRate: bigint; dailyBudget: bigint; ownerDailyBudget: bigint; allowedCodeHashes: readonly ccc.Hex[]; allowOwnerTransactions?: boolean }, readonly pool: ccc.Script) {}
  static async create(options: PilotPaymaster['options']) {
    if (options.maxFee <= 0n || options.feeRate <= 0n || options.dailyBudget <= 0n || options.ownerDailyBudget <= 0n || !options.allowedCodeHashes.length) throw new Error('Configure paymaster limits and allowed application code hashes');
    const pool = (await options.signer.getRecommendedAddressObj()).script;
    const known = await options.signer.client.getKnownScript(ccc.KnownScript.Secp256k1Blake160);
    if (pool.codeHash !== known.codeHash || pool.hashType !== known.hashType || ccc.bytesFrom(pool.args).length !== 20) throw new Error('Paymaster requires an ordinary secp256k1 pool');
    await options.store.init(); return new PilotPaymaster(options, pool);
  }
  get client() { return this.options.signer.client; }
  async status() { return { poolLock: { codeHash: this.pool.codeHash, hashType: this.pool.hashType, args: this.pool.args }, balance: (await this.client.getBalanceSingle(this.pool)).toString(), maxFee: this.options.maxFee.toString(), feeRate: this.options.feeRate.toString(), sponsorship: 'configured', allowedCodeHashes: this.options.allowedCodeHashes }; }
  async quote(bytes: ccc.Hex): Promise<SponsorQuote> {
    const base = ccc.Transaction.fromBytes(bytes);
    if (!base.inputs.length || base.inputs.length > 64 || base.outputs.length > 64 || base.witnesses.length > base.inputs.length) throw new Error('Unsupported sponsorship shape');
    if (await inputCapacity(this.client, base) !== base.outputs.reduce((n, o) => n + o.capacity, 0n)) throw new Error('User must fund cell capacity and assets, but zero network fee');
    const cells = await Promise.all(base.inputs.map(input => this.client.getCellLive(input.previousOutput, true)));
    if (cells.some(c => !c || c.cellOutput.lock.eq(this.pool))) throw new Error('Invalid user funding input');
    const accounts = cells.filter(c => [PILOT_ACCOUNT_CODE_HASH,PILOT_WALLET_SESSION_CODE_HASH].includes(c!.cellOutput.lock.codeHash));
    if (accounts.length) {
      const lock = accounts[0]!.cellOutput.lock, args = ccc.bytesFrom(lock.args);
      const modern=lock.codeHash===PILOT_WALLET_SESSION_CODE_HASH;
      if (lock.hashType !== 'data2' || args.length !== (modern?104:105) || ccc.hexFrom(args.slice(modern?64:65, modern?96:97)) !== this.pool.hash()
        || accounts.some(c => !c!.cellOutput.lock.eq(lock)) || base.outputs.some(o => o.lock.eq(this.pool))) throw new Error('Invalid Pilot account sponsorship');
    }
    // Register only accounts funded by a complete, signature-required owner input.
    // The registration becomes usable only after submit validates all scripts AND the funding commits.
    const registrations: string[] = []; const registrationOwners = new Set<string>();
    for (const output of base.outputs) {
      if (![PILOT_ACCOUNT_CODE_HASH,PILOT_WALLET_SESSION_CODE_HASH].includes(output.lock.codeHash) || output.lock.hashType !== 'data2') continue;
      const args = ccc.bytesFrom(output.lock.args);
      const modern=output.lock.codeHash===PILOT_WALLET_SESSION_CODE_HASH;
      if (args.length !== (modern?104:105) || ccc.hexFrom(args.slice(modern?64:65,modern?96:97)) !== this.pool.hash()) continue;
      const proof = cells.find(cell => cell!.cellOutput.lock.hash() === ccc.hexFrom(args.slice(0,32)));
      if (proof) { await assertPilotSigningOwner(this.client, proof.cellOutput.lock); registrations.push(output.lock.hash()); registrationOwners.add(proof.cellOutput.lock.hash()); }
    }
    if (!accounts.length && registrationOwners.size > 1) throw new Error('Fund one Pilot recovery owner per transaction');
    let ownerRecovery = false;
    if (accounts.length) {
      const account = accounts[0]!, index = cells.indexOf(account), ownerHash = ccc.hexFrom(ccc.bytesFrom(account.cellOutput.lock.args).slice(0,32));
      const proof = cells.find(cell => cell!.cellOutput.lock.hash() === ownerHash);
      if (proof && base.getWitnessArgs(index)?.lock === '0x00') { await assertPilotSigningOwner(this.client, proof.cellOutput.lock); ownerRecovery = true; }
    }
    const related = [...cells.map(c => c!.cellOutput), ...base.outputs];
    if (!related.some(o => [o.lock.codeHash, o.type?.codeHash].some(hash => hash && this.options.allowedCodeHashes.includes(hash)))) {
      if (!this.options.allowOwnerTransactions || !cells.every(c => c!.cellOutput.lock.eq(cells[0]!.cellOutput.lock))) throw new Error('Application is not eligible for this pool');
      await assertPilotSigningOwner(this.client, cells[0]!.cellOutput.lock);
    }
    return this.options.store.exclusive(async data => {
      if (accounts.length && !ownerRecovery) {
        const accountHash = accounts[0]!.cellOutput.lock.hash();
        let registered = false;
        for (const record of data.records) {
          if (!record.bytes || !record.accounts?.includes(accountHash)) continue;
          if ((await this.client.getTransactionNoCache(record.quote.transactionHash))?.status === 'committed') { registered = true; break; }
        }
        if (!registered) throw new Error('Pilot account needs confirmed owner-authorized funding through this paymaster before automatic sponsorship');
      }
      // Unsigned quotes do not reserve or expose a pool signature. Only validated submitted transactions lease cells.
      const leased = new Set<string>();
      for (const record of data.records.filter(r => r.bytes)) {
        const tx = ccc.Transaction.fromBytes(record.bytes!);
        if (await this.client.getCellLive(tx.inputs.at(-1)!.previousOutput, false)) leased.add(ccc.hexFrom(tx.inputs.at(-1)!.previousOutput.toBytes()));
      }
      for await (const cell of this.client.findCellsByLock(this.pool, null)) {
        if (cell.outputData !== '0x' || cell.cellOutput.type || leased.has(ccc.hexFrom(cell.outPoint.toBytes())) || !await this.client.getCellLive(cell.outPoint, false)) continue;
        const tx = base.clone(); tx.inputs.push(ccc.CellInput.from({ previousOutput: cell.outPoint }));
        tx.outputs.push(cell.cellOutput.clone()); tx.outputsData.push('0x');
        await tx.addCellDepsOfKnownScripts(this.client, ccc.KnownScript.Secp256k1Blake160);
        for (let i = tx.witnesses.length; i < tx.inputs.length; i++) tx.witnesses.push('0x');
        tx.setWitnessArgs(tx.inputs.length - 1, { lock: ccc.hexFrom(new Uint8Array(65)) });
        const fee = (BigInt(tx.toBytes().length + 4096 + 4) * this.options.feeRate + 999n) / 1000n;
        if (fee > this.options.maxFee) throw new Error('Network fee exceeds pool policy');
        const change = tx.outputs.at(-1)!;
        if (change.capacity - fee < ccc.fixedPointFrom(change.occupiedSize)) continue;
        change.capacity -= fee;
        const quote: SponsorQuote = { version: 1, id: ccc.hashCkb(tx.toBytes()), transactionHash: tx.hash(), bytes: ccc.hexFrom(tx.toBytes()), baseBytes: bytes, fee: fee.toString(), expiresAt: Date.now() + 120_000 };
        const first = accounts[0]?.cellOutput.lock ?? cells[0]!.cellOutput.lock;
        const owner = !accounts.length && registrationOwners.size === 1 ? [...registrationOwners][0]!
          : (accounts.length > 0 || (this.options.allowedCodeHashes.includes(first.codeHash) && first.codeHash !== PILOT_PASSKEY_CODE_HASH)) && ccc.bytesFrom(first.args).length >= 32
            ? ccc.hexFrom(ccc.bytesFrom(first.args).slice(0, 32)) : first.hash();
        data.records = data.records.filter(r => r.bytes || r.quote.expiresAt + 86_400_000 > Date.now());
        if (data.records.length > 50_000) throw new Error('Paymaster journal needs archival');
        const existing = data.records.find(r => r.quote.id === quote.id);
        if (existing) {
          if (!existing.bytes && existing.quote.expiresAt <= Date.now()) existing.quote = quote;
          return existing.quote;
        }
        data.records.push({ quote, day: new Date().toISOString().slice(0, 10), owner, ...(registrations.length ? { accounts: [...new Set(registrations)] } : {}) });
        return quote;
      }
      throw new Error('Paymaster has no available spendable fee capacity; no user-paid fallback');
    });
  }
  async submit(id: ccc.Hex, bytes: ccc.Hex): Promise<ccc.Transaction> {
    const tx = await this.options.store.exclusive(async data => {
      const record = data.records.find(r => r.quote.id === id);
      if (!record) throw new Error('Unknown sponsorship quote');
      if (record.bytes) return ccc.Transaction.fromBytes(record.bytes);
      if (record.quote.expiresAt <= Date.now()) throw new Requote(id);
      const candidate = ccc.Transaction.fromBytes(bytes), quoted = ccc.Transaction.fromBytes(record.quote.bytes);
      verifyOwnerSignatureChanges(quoted, candidate);
      const poolIndex = candidate.inputs.length - 1;
      if (candidate.witnesses[poolIndex] !== quoted.witnesses[poolIndex]) throw new Error('Changed pool witness');
      const day = new Date().toISOString().slice(0, 10), fee = BigInt(record.quote.fee);
      const spent = data.records.filter(r => r.bytes && r.day === day);
      if (spent.reduce((n, r) => n + BigInt(r.quote.fee), 0n) + fee > this.options.dailyBudget
        || spent.filter(r => r.owner === record.owner).reduce((n, r) => n + BigInt(r.quote.fee), 0n) + fee > this.options.ownerDailyBudget) throw new Error('Paymaster daily fee allowance exhausted');
      if (!await this.client.getCellLive(candidate.inputs[poolIndex]!.previousOutput, true)) throw new Requote(id);
      if (data.records.some(r => r.bytes && ccc.Transaction.fromBytes(r.bytes).inputs.at(-1)!.previousOutput.eq(candidate.inputs[poolIndex]!.previousOutput))) throw new Requote(id);
      const signed = await this.options.signer.signOnlyTransaction(candidate.clone());
      if (signed.hash() !== candidate.hash()) throw new Error('Pool signer changed transaction');
      if ((BigInt(signed.toBytes().length + 4) * this.options.feeRate + 999n) / 1000n > fee) throw new Error('Signed witnesses exceed quoted fee reserve');
      // Verifies every owner/session/app/pool script before exposing a usable pool signature.
      await this.client.estimateCycles(signed);
      record.bytes = ccc.hexFrom(signed.toBytes()); record.day = day;
      return signed;
    }); // Durable exact bytes and pool lease BEFORE broadcast; retries return the original transaction.
    const known = await this.client.getTransactionNoCache(tx.hash());
    if (!known || known.status === 'unknown' || known.status === 'rejected') {
      try { await this.client.sendTransaction(tx); } catch (e) { if (!(e instanceof ccc.ErrorClientDuplicatedTransaction)) throw e; }
    }
    return tx;
  }
}
interface PaymasterHttpOptions { paymaster: PilotPaymaster; allowedOrigins: readonly string[]; rateLimiter?: RateLimiter }
export function createPaymasterHandler(options: PaymasterHttpOptions): RequestListener {
  const limiter = options.rateLimiter ?? new MemoryRateLimiter();
  return async (req, res) => {
    res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    const send = (status: number, body: unknown) => { res.statusCode = status; res.end(JSON.stringify(body)); };
    const origin = req.headers.origin;
    if (origin && !options.allowedOrigins.includes(origin)) { send(403, { error: 'Origin not allowed' }); return; }
    if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
    try {
      if (!await limiter.allow(`paymaster:${requestIp(req)}`, 60)) { send(429, { error: 'Rate limit exceeded' }); return; }
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (req.method === 'GET' && path === '/api/paymaster/status') { send(200, await options.paymaster.status()); return; }
      if (req.method !== 'POST' || !['/api/paymaster/quote', '/api/paymaster/submit'].includes(path)) { send(404, { error: 'Not found' }); return; }
      if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('Expected JSON');
      const body = await readJson(req, 262_144) as { bytes: ccc.Hex; quoteId: ccc.Hex };
      if (path === '/api/paymaster/quote') send(200, await options.paymaster.quote(body.bytes));
      else send(200, { bytes: ccc.hexFrom((await options.paymaster.submit(body.quoteId, body.bytes)).toBytes()) });
    } catch (error) { if (error instanceof Requote) { send(409, { code: 'REQUOTE', quoteId: error.quoteId }); return; } send(400, { error: 'Sponsorship unavailable or rejected; no user-paid fallback. Retry the saved request, or contact the pool operator.' }); }
  };
}
export function createPaymasterServer(options: PaymasterHttpOptions) { return createServer(createPaymasterHandler(options)); }
