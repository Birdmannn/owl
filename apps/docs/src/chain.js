import { ccc } from '@ckb-ccc/core';
import manifest from '../../../deployments/testnet.json' with { type: 'json' };
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

export function isPilotMove(record, receipt) {
  if (receipt?.status !== 'committed') return false;
  const tx = receipt.transaction;
  const lock = tx?.getWitnessArgs(0)?.lock;
  return record.cells.some((cell) => cell.isInput && BigInt(cell.cellIndex) === 0n)
    && tx.inputs.length === 1 && tx.outputs.length === 1
    && tx.outputs[0].lock.codeHash === deployment.codeHash
    && tx.outputs[0].lock.hashType === 'data2'
    && tx.outputs[0].lock.args.length === 164
    && /^0x01[0-9a-f]{128}$/i.test(lock || '')
    && ccc.bytesFrom(tx.outputsData[0]).length === 16;
}

export async function loadBoardPage(cursor) {
  const result = await client.findTransactionsPaged({
    script: { codeHash: deployment.codeHash, hashType: 'data2', args: '0x' },
    scriptType: 'lock', scriptSearchMode: 'prefix', groupByTransaction: true,
  }, 'desc', 25, cursor);
  const rows = [];
  const headers = new Map();
  // Bound concurrent RPC requests rather than flooding the public endpoint.
  for (let offset = 0; offset < result.transactions.length; offset += 5) {
    const batch = await Promise.all(result.transactions.slice(offset, offset + 5).map(async (record) => {
      if (!record.cells.some((cell) => cell.isInput)) return;
      const receipt = await client.getTransactionNoCache(record.txHash);
      if (!receipt) throw new Error('Some indexed transactions are temporarily unavailable. Refresh to retry.');
      if (!isPilotMove(record, receipt)) return;
      const tx = receipt.transaction;
      const previous = await client.getTransaction(tx.inputs[0].previousOutput.txHash);
      if (!previous) throw new Error('A transaction’s input receipt is unavailable. Refresh to retry.');
      const input = previous.transaction.outputs[Number(tx.inputs[0].previousOutput.index)];
      if (!input || input.lock.codeHash !== deployment.codeHash || !input.lock.eq(tx.outputs[0].lock)) return;
      const block = BigInt(record.blockNumber).toString();
      if (!headers.has(block)) headers.set(block, client.getHeaderByNumberNoCache(record.blockNumber));
      const header = await headers.get(block);
      const bytes = ccc.bytesFrom(tx.outputsData[0]);
      const position = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(8, true).toString();
      return {
        hash: record.txHash, block, position,
        session: tx.outputs[0].lock.args.slice(66, 132),
        fee: (input.capacity - tx.outputs[0].capacity).toString(),
        time: header ? Number(header.timestamp) : null,
      };
    }));
    rows.push(...batch.filter(Boolean));
  }
  return { rows, cursor: result.transactions.length === 25 ? result.lastCursor : null };
}
