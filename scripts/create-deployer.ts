import { ccc } from '@ckb-ccc/core';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { resolve } from 'node:path';

const directory = resolve('.pilot/sponsored');
const file = directory + '/deployer.json';
await mkdir(directory, { recursive: true, mode: 0o700 });
await chmod(directory, 0o700);
try {
  await writeFile(file, JSON.stringify({ version: 1, network: 'ckb-testnet', privateKey: ccc.hexFrom(secp256k1.utils.randomSecretKey()) }) + '\n', { flag: 'wx', mode: 0o600 });
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
}
await chmod(file, 0o600);
const account = JSON.parse(await readFile(file, 'utf8')) as { version: number; network: string; privateKey: ccc.Hex };
if (account.version !== 1 || account.network !== 'ckb-testnet') throw new Error('Unexpected deployer account file');
const signer = new ccc.SignerCkbPrivateKey(new ccc.ClientPublicTestnet(), account.privateKey);
const address = await signer.getRecommendedAddress();
await writeFile('deployments/sponsored-deployer.json', JSON.stringify({ network: 'ckb-testnet', address, purpose: 'Deploy sponsored Pilot code cells; separate from the fee pool.' }, null, 2) + '\n');
console.log(JSON.stringify({ network: account.network, address, keyFile: file, recommendedFundingCKB: '210000' }, null, 2));
