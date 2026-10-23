import { verifySponsorQuote, type SponsorQuote } from '../paymaster.js';
import { ccc } from '@ckb-ccc/core';
import { PILOT_PASSKEY_CODE_HASH } from '../wallet/code.js';

/** Owner-input presence proves consent only for locks requiring a signature on every spend.
 * Reject unknown scripts and optional/permissionless modes before funding a delegation.
 * Recovery of an existing cell remains available even if its lock is no longer supported.
 */
export async function assertPilotSigningOwner(client: ccc.Client, ownerLock: ccc.ScriptLike): Promise<void> {
  const lock = ccc.Script.from(ownerLock), args = ccc.bytesFrom(lock.args);
  // This pinned lock requires a user-verified P-256 assertion on every spend.
  if (lock.codeHash === PILOT_PASSKEY_CODE_HASH && lock.hashType === 'data2' && args.length === 97) return;
  const supported: [ccc.KnownScript, boolean][] = [
    [ccc.KnownScript.Secp256k1Blake160, args.length === 20],
    [ccc.KnownScript.OmniLock, args.length === 22 && [0, 1, 0x12, 4, 5].includes(args[0]!) && args[21] === 0],
    [ccc.KnownScript.JoyId, args.length === 22 && args[0] === 0 && args[1] === 1],
    [ccc.KnownScript.NostrLock, args.length === 21 && args[0] === 0],
    [ccc.KnownScript.PWLock, args.length === 20],
  ];
  for (const [name, validArgs] of supported) {
    if (!validArgs) continue;
    let known: { codeHash: ccc.Hex; hashType: ccc.HashType };
    try { known = await client.getKnownScript(name); } catch { continue; }
    if (lock.codeHash === known.codeHash && lock.hashType === known.hashType) return;
  }
  throw new Error('Unsupported Pilot owner lock: use a signature-required wallet lock; Anyone-Can-Pay and optional authorization modes cannot own a session');
}

/** Prevent builders from selecting another wallet, state cell, asset, or output. */
export async function checkOwnerTransaction(client: ccc.Client, transaction: ccc.TransactionLike, options: {
  ownerLock: ccc.ScriptLike; sponsor?: SponsorQuote; poolLock?: ccc.ScriptLike; selected?: ccc.Cell; output: ccc.CellOutputLike; data: ccc.Hex; maxFee: bigint;
}): Promise<bigint> {
  const complete = ccc.Transaction.from(transaction);
  const tx = complete.clone();
  if (options.sponsor) {
    if (!options.poolLock || ccc.Script.from(options.poolLock).eq(options.ownerLock)) throw new Error('Pin a separate pool lock for sponsorship');
    await verifySponsorQuote(client, ccc.Transaction.fromBytes(options.sponsor.baseBytes), options.sponsor, options.poolLock, options.maxFee);
    if (complete.hash() !== options.sponsor.transactionHash) throw new Error('Changed sponsored owner transaction');
    tx.inputs.pop(); tx.outputs.pop(); tx.outputsData.pop();
  }
  const owner = ccc.Script.from(options.ownerLock);
  if (!tx.inputs.length || tx.outputs.length < 1 || tx.outputsData.length !== tx.outputs.length) throw new Error('Invalid authorization shape');
  const expected = ccc.CellOutput.from(options.output);
  if (!tx.outputs[0]!.eq(expected) || tx.outputsData[0] !== options.data) throw new Error('Builder changed reviewed state, assets, lock, or capacity');
  let inputCapacity = 0n;
  let found = !options.selected;
  const used = new Set<string>();
  for (const input of tx.inputs) {
    const point = ccc.OutPoint.from(input.previousOutput);
    const identity = ccc.hexFrom(point.toBytes());
    if (used.has(identity)) throw new Error('Duplicate authorization input');
    used.add(identity);
    if (input.since !== 0n) throw new Error('Unexpected authorization since');
    const cell = await client.getCellLive(point, true);
    if (!cell) throw new Error('Selected cell is not live');
    if (options.selected && point.eq(options.selected.outPoint)) {
      if (!cell.cellOutput.eq(options.selected.cellOutput) || cell.outputData !== options.selected.outputData) throw new Error('Selected cell changed since review');
      found = true;
    } else if (!cell.cellOutput.lock.eq(owner) || cell.cellOutput.type || cell.outputData !== '0x') {
      throw new Error('Builder selected an unapproved state cell or asset');
    }
    inputCapacity += cell.cellOutput.capacity;
  }
  if (!found) throw new Error('Builder omitted the selected cell');
  for (let index = 1; index < tx.outputs.length; index++) {
    const output = tx.outputs[index]!;
    if (!output.lock.eq(owner) || output.type || tx.outputsData[index] !== '0x') throw new Error('Extra output is not ordinary owner change');
  }
  const fee = inputCapacity - tx.outputs.reduce((sum, output) => sum + output.capacity, 0n);
  if (options.sponsor && fee !== 0n) throw new Error('Sponsored owner must pay zero network fee');
  if (fee < 0n || fee > options.maxFee) throw new Error('Owner transaction exceeds approved fee limit');
  return fee;
}

export function verifyOwnerSignatureChanges(unsigned: ccc.Transaction, signed: ccc.Transaction): void {
  if (signed.hash() !== unsigned.hash() || signed.witnesses.length !== unsigned.witnesses.length) throw new Error('Wallet changed reviewed transaction effects');
  for (let index = 0; index < unsigned.witnesses.length; index++) {
    if (unsigned.witnesses[index] === signed.witnesses[index]) continue;
    const before = unsigned.getWitnessArgs(index), after = signed.getWitnessArgs(index);
    if ((!before && unsigned.witnesses[index] !== '0x') || !after || before?.inputType !== after.inputType || before?.outputType !== after.outputType) throw new Error('Wallet changed reviewed type witnesses');
  }
}
