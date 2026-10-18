import { ccc } from '@ckb-ccc/core';

export interface SponsorQuote {
  version: 1; id: ccc.Hex; transactionHash: ccc.Hex; bytes: ccc.Hex; baseBytes: ccc.Hex; fee: string; expiresAt: number;
}
export interface FeeSponsor {
  prepare(transaction: ccc.Transaction): Promise<SponsorQuote>;
  submit(quote: SponsorQuote, signed: ccc.Transaction): Promise<ccc.Transaction>;
}
export class SponsorQuoteRejectedError extends Error {
  constructor(readonly quoteId: ccc.Hex) { super('Unsigned sponsorship quote expired or conflicted; prepare a new quote'); }
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export async function inputCapacity(client: ccc.Client, tx: ccc.Transaction): Promise<bigint> {
  let total = 0n; const seen = new Set<string>();
  for (const input of tx.inputs) {
    const key = ccc.hexFrom(input.previousOutput.toBytes());
    if (seen.has(key)) throw new Error('Duplicate transaction input'); seen.add(key);
    const cell = await client.getCell(input.previousOutput);
    if (!cell) throw new Error('Transaction input unavailable');
    total += cell.cellOutput.capacity;
  }
  return total;
}
/** Independent conservation check: pool loss equals the entire fee; all original effects stay identical. */
export async function verifySponsorQuote(client: ccc.Client, base: ccc.Transaction, quote: SponsorQuote, pool: ccc.ScriptLike, maxFee: bigint): Promise<ccc.Transaction> {
  const tx = ccc.Transaction.fromBytes(quote.bytes), lock = ccc.Script.from(pool);
  if (quote.version !== 1 || tx.hash() !== quote.transactionHash || ccc.hashCkb(tx.toBytes()) !== quote.id || quote.baseBytes !== ccc.hexFrom(base.toBytes())
    || tx.inputs.length !== base.inputs.length + 1 || tx.outputs.length !== base.outputs.length + 1
    || tx.outputsData.length !== tx.outputs.length || base.witnesses.length > base.inputs.length
    || tx.version !== base.version || !same(tx.headerDeps, base.headerDeps)
    || !same(tx.inputs.slice(0, -1).map(i => ccc.hexFrom(i.toBytes())), base.inputs.map(i => ccc.hexFrom(i.toBytes())))
    || !same(tx.outputs.slice(0, -1).map(o => ccc.hexFrom(o.toBytes())), base.outputs.map(o => ccc.hexFrom(o.toBytes())))
    || !same(tx.outputsData.slice(0, -1), base.outputsData)) throw new Error('Paymaster changed the reviewed transaction');
  const permitted = base.clone(); await permitted.addCellDepsOfKnownScripts(client, ccc.KnownScript.Secp256k1Blake160);
  if (!same(tx.cellDeps.map(d => ccc.hexFrom(d.toBytes())), permitted.cellDeps.map(d => ccc.hexFrom(d.toBytes())))) throw new Error('Paymaster changed transaction dependencies');
  for (let i = 0; i < base.inputs.length; i++) if ((base.witnesses[i] ?? '0x') !== (tx.witnesses[i] ?? '0x')) throw new Error('Paymaster changed application witnesses');
  if (tx.witnesses.length !== tx.inputs.length) throw new Error('Unexpected paymaster witness shape');
  const poolWitness = tx.getWitnessArgs(tx.inputs.length - 1);
  if (poolWitness?.lock !== ccc.hexFrom(new Uint8Array(65)) || poolWitness.inputType !== undefined || poolWitness.outputType !== undefined) throw new Error('Unexpected pool witness fields');
  if (new Set(tx.inputs.map(input => ccc.hexFrom(input.previousOutput.toBytes()))).size !== tx.inputs.length) throw new Error('Duplicate sponsorship input');
  const point = tx.inputs.at(-1)!.previousOutput, cell = await client.getCellLive(point, true), output = tx.outputs.at(-1)!;
  if (tx.inputs.at(-1)!.since !== 0n || !cell || !cell.cellOutput.lock.eq(lock) || cell.cellOutput.type || cell.outputData !== '0x'
    || !output.lock.eq(lock) || output.type || tx.outputsData.at(-1) !== '0x' || output.capacity < ccc.fixedPointFrom(output.occupiedSize)) throw new Error('Invalid paymaster funding cell or change');
  const fee = cell.cellOutput.capacity - output.capacity;
  if (fee <= 0n || fee > maxFee || fee !== BigInt(quote.fee)) throw new Error('Paymaster fee exceeds approved limit');
  const baseIn = await inputCapacity(client, base), baseOut = base.outputs.reduce((n, o) => n + o.capacity, 0n);
  if (baseIn !== baseOut) throw new Error('User inputs must balance user outputs exactly; the user cannot pay the network fee');
  return tx;
}
export class PilotPaymasterClient implements FeeSponsor {
  constructor(readonly options: { client: ccc.Client; url: string; poolLock: ccc.ScriptLike; maxFee: bigint }) {
    const url = new URL(options.url);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('Paymaster requires HTTPS');
  }
  private async request(path: string, body: unknown) {
    const response = await fetch(this.options.url.replace(/\/$/, '') + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    const value = await response.json();
    if (response.status === 409 && value.code === 'REQUOTE' && typeof value.quoteId === 'string') throw new SponsorQuoteRejectedError(value.quoteId);
    if (!response.ok) throw new Error(value.error ?? 'Paymaster unavailable; no user-paid fallback'); return value;
  }
  async prepare(transaction: ccc.Transaction): Promise<SponsorQuote> {
    const base = transaction.clone();
    const quote = await this.request('/quote', { bytes: ccc.hexFrom(base.toBytes()) }) as SponsorQuote;
    if (quote.expiresAt <= Date.now()) throw new Error('Paymaster quote expired');
    await verifySponsorQuote(this.options.client, base, quote, this.options.poolLock, this.options.maxFee);
    return quote;
  }
  async submit(quote: SponsorQuote, signed: ccc.Transaction): Promise<ccc.Transaction> {
    const before = ccc.Transaction.fromBytes(quote.bytes);
    if (signed.hash() !== quote.transactionHash || before.hash() !== quote.transactionHash || ccc.hashCkb(before.toBytes()) !== quote.id) throw new Error('Signed transaction differs from sponsored quote');
    const result = ccc.Transaction.fromBytes((await this.request('/submit', { quoteId: quote.id, bytes: ccc.hexFrom(signed.toBytes()) })).bytes);
    if (result.hash() !== signed.hash() || result.witnesses.length !== signed.witnesses.length) throw new Error('Paymaster changed signed transaction');
    const poolIndex = result.inputs.length - 1;
    for (let i = 0; i < result.witnesses.length; i++) {
      if (i !== poolIndex && result.witnesses[i] !== signed.witnesses[i]) throw new Error('Paymaster changed another signer’s witness');
      if (i === poolIndex) {
        const a = signed.getWitnessArgs(i), b = result.getWitnessArgs(i);
        if (a?.inputType !== b?.inputType || a?.outputType !== b?.outputType) throw new Error('Paymaster changed type witnesses');
      }
    }
    return result;
  }
}
