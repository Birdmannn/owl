import { PILOT_ACCOUNT_CODE_HASH } from '../../../src/ckb/account-code.ts';
import { PILOT_LEGACY_PASSKEY_CODE_HASH, PILOT_PASSKEY_CODE_HASH, PILOT_WALLET_SESSION_CODE_HASH } from '../../../src/wallet/code.ts';
import { ccc } from '@ckb-ccc/core';
import manifest from '../../../deployments/testnet.json' with { type: 'json' };
import { SPONSORED_COUNTER_CODE_HASH, SPONSORED_DELEGATION_CODE_HASH } from '../../../src/ckb/sponsored-code.ts';
import { DELEGATION_V1_CODE_HASH } from '../../../src/ckb/delegation-code.ts';
import paymaster from '../../../deployments/owl-paymaster.json' with { type: 'json' };

export const client = new ccc.ClientPublicTestnet({ url: 'https://testnet.ckb.dev' });
export const deployment = manifest.deployment;
export const paymasterAddress = import.meta.env?.VITE_PAYMASTER_ADDRESS || paymaster.address || '';
export const explorer = (hash) => `https://testnet.explorer.nervos.org/transaction/${hash}`;
export const short = (s) => `${s.slice(0, 10)}…${s.slice(-8)}`;
export const amount = (value) => {
  const n = BigInt(value);
  return `${n / 100_000_000n}${n % 100_000_000n ? `.${(n % 100_000_000n).toString().padStart(8, '0').replace(/0+$/, '')}` : ''}`;
};

export function parseDeposit(value) {
  if (!/^\d+(\.\d{1,8})?$/.test(value)) throw new Error('Enter a positive CKB amount with up to 8 decimal places.');
  const [whole, fraction = ''] = value.split('.');
  const capacity = BigInt(whole) * 100_000_000n + BigInt(fraction.padEnd(8, '0'));
  if (capacity <= 0n || capacity > (1n << 64n) - 1n) throw new Error('Deposit amount is outside the valid CKB range.');
  return capacity;
}

export async function getRecipient() {
  if (!paymasterAddress) throw new Error('Owl’s paymaster address has not been configured yet.');
  if (!paymasterAddress.startsWith('ckt1')) throw new Error('The paymaster must use a CKB testnet address.');
  return ccc.Address.fromString(paymasterAddress, client);
}

export async function buildDeposit(signer, value) {
  const genesis = await signer.client.getHeaderByNumberNoCache(0);
  if (genesis?.hash !== deployment.genesisHash) throw new Error('Connect a wallet on CKB testnet.');
  const recipient = await getRecipient();
  const capacity = parseDeposit(value);
  const tx = ccc.Transaction.from({ outputs: [{ lock: recipient.script, capacity }], outputsData: ['0x'] });
  const minimum = ccc.fixedPointFrom(tx.outputs[0].occupiedSize);
  if (capacity < minimum) throw new Error(`This address needs at least ${amount(minimum)} CKB per deposit to create a cell.`);
  await tx.completeInputsByCapacity(signer);
  await tx.completeFeeBy(signer, 1000n);
  return { tx, capacity, fee: await tx.getFee(signer.client), recipient: paymasterAddress };
}

export const boardPolicies = [
  { id: 'counter-v1', name: 'Counter policy', codeHash: deployment.codeHash, argsLength: 81 },
  { id: 'delegation-v1', name: 'App delegation', codeHash: DELEGATION_V1_CODE_HASH, argsLength: null, argsExtra: 0 },
  { id: 'counter-sponsored-v1', name: 'Sponsored counter', codeHash: SPONSORED_COUNTER_CODE_HASH, argsLength: 113 },
  { id: 'delegation-sponsored-v1', name: 'Sponsored app delegation', codeHash: SPONSORED_DELEGATION_CODE_HASH, argsLength: null, argsExtra: 32 },
  { id: 'account-v1', name: 'Persistent Pilot account', codeHash: PILOT_ACCOUNT_CODE_HASH, argsLength: 105 },
  { id: 'passkey-legacy', name: 'Pilot original passkey owner', codeHash: PILOT_LEGACY_PASSKEY_CODE_HASH, argsLength: 97 },
  { id: 'passkey-v1', name: 'Pilot passkey owner', codeHash: PILOT_PASSKEY_CODE_HASH, argsLength: 97 },
  { id: 'wallet-session-v1', name: 'Pilot wallet session', codeHash: PILOT_WALLET_SESSION_CODE_HASH, argsLength: 104 },
];
export const socialBoardUrl = (import.meta.env?.VITE_PILOT_SOCIAL_URL || '').replace(/\/$/, '');
function policyOf(lock) {
  if (!lock || lock.hashType !== 'data2') return undefined;
  const bytes = ccc.bytesFrom(lock.args);
  return boardPolicies.find(policy => policy.codeHash === lock.codeHash && (policy.argsLength
    ? bytes.length === policy.argsLength
    : bytes.length >= 191 && bytes[145] > 0 && bytes[145] <= 16 && bytes.length === 146 + bytes[145] * 45 + (policy.argsExtra ?? 0)));
}
const distinct = (values) => [...new Set(values)];

/** All transactions involving Pilot locks, across applications and owners. No counter-action filter. */
export async function loadBoardPage(cursor) {
  if (cursor === null) return { rows: [], cursor: null };
  const pages = await Promise.all(boardPolicies.map(async policy => {
    const previous = cursor?.[policy.id];
    if (previous === null) return { policy, transactions: [], cursor: null };
    const result = await client.findTransactionsPaged({
      script: { codeHash: policy.codeHash, hashType: 'data2', args: '0x' },
      scriptType: 'lock', scriptSearchMode: 'prefix', groupByTransaction: true,
    }, 'desc', 25, previous);
    return { policy, transactions: result.transactions, cursor: result.transactions.length === 25 ? result.lastCursor : null };
  }));
  const records = [...new Map(pages.flatMap(page => page.transactions).map(record => [record.txHash, record])).values()];
  const rows = [], headers = new Map(), previousTransactions = new Map();
  const previousReceipt = hash => {
    if (!previousTransactions.has(hash)) previousTransactions.set(hash, client.getTransaction(hash));
    return previousTransactions.get(hash);
  };
  // Bound concurrent receipt work. Full fees include ordinary owner funding inputs too.
  for (let offset = 0; offset < records.length; offset += 5) {
    await Promise.all(records.slice(offset, offset + 5).map(async record => {
      const receipt = await client.getTransactionNoCache(record.txHash);
      if (!receipt) throw new Error('Some indexed transactions are temporarily unavailable. Refresh to retry.');
      if (receipt.status !== 'committed') return;
      const tx = receipt.transaction, inputs = [];
      for (const input of tx.inputs) {
        const previous = await previousReceipt(input.previousOutput.txHash);
        const output = previous?.transaction.outputs[Number(input.previousOutput.index)];
        if (!output) throw new Error('A transaction’s input receipt is unavailable. Refresh to retry.');
        inputs.push(output);
      }
      const incoming = inputs.filter(output => policyOf(output.lock));
      const outgoing = tx.outputs.filter(output => policyOf(output.lock));
      const related = [...incoming, ...outgoing];
      if (!related.length) return; // Validate indexer matches against actual locks.
      const policies = distinct(related.map(output => policyOf(output.lock).name));
      let witness;
      try { witness = tx.getWitnessArgs(Math.max(0, inputs.findIndex(output => policyOf(output.lock))))?.lock; } catch { /* Unknown witness remains inspectable. */ }
      const witnessBytes = witness ? ccc.bytesFrom(witness) : [];
      const isAccount = related.some(output => policyOf(output.lock).id === 'account-v1');
      const isWallet = related.some(output => policyOf(output.lock).id === 'wallet-session-v1');
      const isPasskey = related.some(output => ['passkey-v1','passkey-legacy'].includes(policyOf(output.lock).id));
      const signer = isWallet && witness === '0x00' || isPasskey && !isWallet ? 'Pilot passkey' : incoming.length && witnessBytes[0] === 1 && [65, 97].includes(witnessBytes.length) ? isAccount ? 'Pilot account key' : 'Pilot session key'
        : !incoming.length || witness === '0x00' ? 'Owner wallet' : 'See transaction witnesses';
      const action = isWallet ? witnessBytes[0] === 1 ? 'Wallet session action' : 'Passkey grant / recovery' : isPasskey ? 'Passkey owner transaction' : isAccount && incoming.length && signer === 'Pilot account key' ? 'Pilot account action' : !incoming.length ? 'Session setup / funding' : !outgoing.length ? 'Recovery / session close'
        : signer === 'Pilot session key' ? related.some(output => policyOf(output.lock).id.startsWith('delegation-')) ? 'Delegated app action' : 'Counter increment' : 'Owner app transition';
      const actionHash = witnessBytes.length === 97 && witnessBytes[0] === 1 ? ccc.hexFrom(witnessBytes.slice(1, 33)) : undefined;
      const sessionKeys = distinct(related.filter(output => !['passkey-v1','passkey-legacy','wallet-session-v1'].includes(policyOf(output.lock).id)).map(output => ccc.hexFrom(ccc.bytesFrom(output.lock.args).slice(32, 65))));
      const owners = distinct(related.map(output => ['passkey-v1','passkey-legacy'].includes(policyOf(output.lock).id) ? output.lock.hash() : ccc.hexFrom(ccc.bytesFrom(output.lock.args).slice(0, 32))));
      const manifests = distinct(related.filter(output => policyOf(output.lock).id.startsWith('delegation-')).map(output => ccc.hexFrom(ccc.bytesFrom(output.lock.args).slice(65, 97))));
      const block = BigInt(receipt.blockNumber ?? record.blockNumber).toString();
      if (!headers.has(block)) headers.set(block, client.getHeaderByNumberNoCache(BigInt(block)));
      const header = await headers.get(block);
      if (!header) throw new Error('A block header is temporarily unavailable. Refresh to retry.');
      const fee = inputs.reduce((sum, output) => sum + output.capacity, 0n) - tx.outputs.reduce((sum, output) => sum + output.capacity, 0n);
      rows.push({ id: 'chain:' + record.txHash, source: 'chain', hash: record.txHash, block, action, actionId: actionHash,
        app: policies.join(', '), signer, session: sessionKeys.join(', '), owner: owners.join(', '), status: 'Confirmed on-chain', fee: fee.toString(),
        time: Number(header.timestamp), details: { policies, sessionKeys, ownerLockHashes: owners, manifestHashes: manifests,
          actionHash, transaction: JSON.parse(tx.stringify()), signedBytes: ccc.hexFrom(tx.toBytes()) } });
    }));
  }
  const next = Object.fromEntries(pages.map(page => [page.policy.id, page.cursor]));
  return { rows: rows.sort((a, b) => Number(BigInt(b.block) - BigInt(a.block)) || a.hash.localeCompare(b.hash)),
    cursor: Object.values(next).every(value => value === null) ? null : next };
}

/** Public receipts reported by a configured receiving application, separately labeled from chain data. */
export async function loadSocialBoardPage(cursor, url = socialBoardUrl, fetcher = fetch) {
  if (!url || cursor === null) return { rows: [], cursor: null };
  const response = await fetcher(`${url.replace(/\/$/, '')}/receipts?limit=50${cursor === undefined ? '' : '&cursor=' + encodeURIComponent(cursor)}`, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error('Social receipt history is unavailable. Retry to continue.');
  const result = await response.json();
  if (!Array.isArray(result.receipts) || !(result.cursor === null || Number.isSafeInteger(result.cursor) && result.cursor >= 0)) throw new Error('Invalid social receipt history');
  return { rows: result.receipts.map(receipt => ({ id: 'social:' + receipt.id, source: 'social', action: receipt.actionId,
    actionId: receipt.actionId, app: 'Pilot Social', signer: 'Pilot session key', session: receipt.grantId, owner: receipt.owner,
    status: 'Accepted by app', time: receipt.acceptedAt, target: receipt.target, fee: null, details: { receipt, verification: 'Reported by the configured app verifier; not independently verified by this Board.' } })), cursor: result.cursor };
}

/** Same-origin browser diagnostics: never send these private/local records to a server. */
export function readLocalBoardActivity(storage) {
  const rows = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (!key?.startsWith('pilot:account-activity:v1:')) continue;
    let entries;
    try { entries = JSON.parse(storage.getItem(key)); } catch { continue; }
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || entry.ownerAddress !== key.slice('pilot:account-activity:v1:'.length) || !Array.isArray(entry.logs)) continue;
      // Explicit public metadata only; do not spread or export arbitrary stored fields.
      const logs = entry.logs.filter(log => log && typeof log.message === 'string').map(log => ({ at: log.at, phase: log.phase, message: log.message }));
      rows.push({ id: `local:${entry.ownerAddress}:${entry.appId}:${entry.sessionId}:${entry.id}`, source: 'local', action: entry.name,
        actionId: entry.actionId, app: entry.appId, signer: entry.kind === 'owner' ? 'Owner wallet' : 'Pilot session key',
        session: entry.sessionId, owner: entry.ownerAddress, status: entry.status + ' · local record', time: entry.createdAt,
        target: entry.target, fee: null, details: { recordId: entry.id, transactionHash: entry.transactionHash, grantId: entry.grantId,
          reservedFee: entry.fee, logs } });
    }
  }
  return rows.sort((a, b) => b.time - a.time);
}
