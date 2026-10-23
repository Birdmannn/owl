import { PILOT_ACCOUNT_CODE_HASH } from '../src/ckb/account-code.js';
import { PILOT_PASSKEY_CODE_HASH, PILOT_WALLET_SESSION_CODE_HASH } from '../src/wallet/code.js';
import { databaseUrl } from './postgres.js';
import { resolve } from 'node:path';
import { ccc } from '@ckb-ccc/core';
import { PaymasterStore, PostgresPaymasterStore, PilotPaymaster } from './paymaster.js';
import { SPONSORED_COUNTER_CODE_HASH, SPONSORED_DELEGATION_CODE_HASH } from '../src/ckb/sponsored-code.js';
import { COUNTER_V1_CODE_HASH } from '../src/ckb/counter.js';
import { DELEGATION_V1_CODE_HASH } from '../src/ckb/delegation-code.js';
import deployment from '../deployments/owl-paymaster.json' with { type: 'json' };

export async function paymasterFromEnvironment() {
  const secret = process.env.PILOT_PAYMASTER_PRIVATE_KEY;
  if (!secret) throw new Error('Set PILOT_PAYMASTER_PRIVATE_KEY on the server only. The key must own the configured pool address.');
  const client = new ccc.ClientPublicTestnet({ url: process.env.PILOT_PAYMASTER_RPC ?? 'https://testnet.ckb.dev' });
  if ((await client.getHeaderByNumberNoCache(0))?.hash !== '0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606') throw new Error('Paymaster RPC must be CKB testnet');
  const signer = new ccc.SignerCkbPrivateKey(client, secret as ccc.Hex);
  const address = process.env.PILOT_PAYMASTER_ADDRESS ?? deployment.address;
  const pool = await ccc.Address.fromString(address, client);
  if (!(await signer.getRecommendedAddressObj()).script.eq(pool.script)) throw new Error('Pool signing key does not match configured pool address');
  const url = databaseUrl();
  const store = url
    ? new PostgresPaymasterStore(url, pool.script.hash())
    : new PaymasterStore(resolve(process.env.PILOT_PAYMASTER_FILE ?? 'data/pilot-paymaster.json'));
  try {
    const paymaster = await PilotPaymaster.create({ signer, store,
      maxFee: BigInt(process.env.PILOT_PAYMASTER_MAX_FEE ?? '100000'), feeRate: BigInt(process.env.PILOT_PAYMASTER_FEE_RATE ?? '1000'),
      dailyBudget: BigInt(process.env.PILOT_PAYMASTER_DAILY_BUDGET ?? '100000000'), ownerDailyBudget: BigInt(process.env.PILOT_PAYMASTER_OWNER_DAILY_BUDGET ?? '1000000'),
      allowOwnerTransactions: process.env.PILOT_PAYMASTER_ALLOW_OWNER_TRANSACTIONS !== 'false',
      allowedCodeHashes: (process.env.PILOT_PAYMASTER_ALLOWED_CODE_HASHES?.split(',').map(h => ccc.hexFrom(h.trim())) ?? [SPONSORED_COUNTER_CODE_HASH, SPONSORED_DELEGATION_CODE_HASH, COUNTER_V1_CODE_HASH, DELEGATION_V1_CODE_HASH, PILOT_ACCOUNT_CODE_HASH, PILOT_PASSKEY_CODE_HASH, PILOT_WALLET_SESSION_CODE_HASH]),
    });
    return paymaster;
  } catch (error) {
    if (store instanceof PostgresPaymasterStore) await store.close();
    throw error;
  }
}
