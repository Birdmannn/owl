import { ccc } from '@ckb-ccc/core';

/** Browser-local connection hints, never authorization or private key material. */
export interface PilotAccount {
  id: string; network: string; address: string; walletName: string; signType: ccc.SignerSignType;
  identity: string; lastConnectedAt: number;
}
export const pilotAccountsKey = 'pilot:accounts:v1';
type AccountStorage = Pick<Storage, 'getItem' | 'setItem'>;
const identityOf = (signType: ccc.SignerSignType, identity: string) => {
  if (signType !== ccc.SignerSignType.JoyId) return identity;
  const value = JSON.parse(identity);
  return JSON.stringify([value.keyType, value.publicKey?.toLowerCase()]);
};
export function readPilotAccounts(storage: Pick<Storage, 'getItem'>, network: string): PilotAccount[] {
  const value: unknown = JSON.parse(storage.getItem(pilotAccountsKey) ?? '[]');
  if (!Array.isArray(value)) throw new Error('Invalid saved Pilot accounts');
  return value.filter((row): row is PilotAccount => !!row && typeof row.id === 'string' && row.network === network &&
    typeof row.address === 'string' && typeof row.walletName === 'string' && typeof row.signType === 'string' &&
    typeof row.identity === 'string' && typeof row.lastConnectedAt === 'number').sort((a, b) => b.lastConnectedAt - a.lastConnectedAt);
}
export async function pilotAccountFromSigner(signer: ccc.Signer, network: string, walletName: string): Promise<PilotAccount> {
  const [address, identity] = await Promise.all([signer.getRecommendedAddress(), signer.getIdentity()]);
  const id = ccc.hashCkb(ccc.bytesFrom(JSON.stringify([network, address, signer.signType, identityOf(signer.signType, identity)]), 'utf8'));
  return { id, network, address, identity, signType: signer.signType, walletName, lastConnectedAt: Date.now() };
}
export function rememberPilotAccount(storage: AccountStorage, account: PilotAccount): void {
  const all: unknown = JSON.parse(storage.getItem(pilotAccountsKey) ?? '[]');
  if (!Array.isArray(all)) throw new Error('Invalid saved Pilot accounts');
  // Explicit allowlist: callers cannot accidentally persist a signer, key, or session grant here.
  const { id, network, address, identity, signType, walletName, lastConnectedAt } = account;
  storage.setItem(pilotAccountsKey, JSON.stringify([{ id, network, address, identity, signType, walletName, lastConnectedAt },
    ...all.filter(row => row && row.id !== id)]));
}
export async function assertPilotAccount(signer: ccc.Signer, expected: PilotAccount): Promise<void> {
  const actual = await pilotAccountFromSigner(signer, expected.network, expected.walletName);
  if (!(await signer.isConnected()) || (actual.id !== expected.id || actual.address !== expected.address || actual.signType !== expected.signType || identityOf(actual.signType, actual.identity) !== identityOf(expected.signType, expected.identity))) throw new Error('The wallet returned a different account. Select the requested account in your wallet.');
}
