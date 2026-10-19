import { ccc } from '@ckb-ccc/core';
import { transferSpore, assertSpore } from '@ckb-ccc/spore';

export type PilotNetwork = 'ckb-testnet' | 'ckb-mainnet';
export interface PilotUsername {
  version: 2;
  username: string;
  ownerAddress: string;
  network: PilotNetwork;
  provider: 'joyid' | 'wallet';
  signType: ccc.SignerSignType;
  identity: string;
  /** Public key only. No private key or WebAuthn credential secret is stored. */
  passkeyPublicKey?: string;
  createdAt: number;
}
export function normalizeUsername(value: string): string {
  const username = value.trim().replace(/^@/, '').toLowerCase();
  if (!/^[a-z][a-z0-9_]{2,19}$/.test(username)) throw new Error('Use 3–20 characters: start with a letter, then letters, numbers, or underscores.');
  return username;
}
export class PilotUsernameClient {
  constructor(readonly url = '/api/pilot') {}
  private async request<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.url.replace(/\/$/, '')}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? 'Pilot username registry is unavailable');
    return result as T;
  }
  async resolve(username: string, network: PilotNetwork): Promise<PilotUsername> {
    const profile = await this.request<PilotUsername>(`/usernames/${normalizeUsername(username)}`);
    if (profile.network !== network) throw new Error('This Pilot username belongs to a different CKB network');
    return profile;
  }
  async findByAddress(address: string): Promise<PilotUsername | undefined> {
    const result = await this.request<{ profile?: PilotUsername }>(`/accounts/${encodeURIComponent(address)}`);
    return result.profile;
  }
  async register(signer: ccc.Signer, username: string): Promise<PilotUsername> {
    const name = normalizeUsername(username);
    const ownerAddress = await signer.getRecommendedAddress();
    const existing = await this.findByAddress(ownerAddress);
    if (existing) {
      if (existing.username !== name) throw new Error('This address already has a Pilot username. Renaming is not supported.');
      return existing;
    }
    const claim = { username: name, ownerAddress,
      signType: signer.signType, identity: await signer.getIdentity() };
    const challenge = await this.request<{ id: string; message: string }>('/challenges', claim);
    const signature = await signer.signMessage(challenge.message);
    return this.request<PilotUsername>('/usernames', { challengeId: challenge.id, signature });
  }
}
export function signerNetwork(signer: ccc.Signer): PilotNetwork {
  return signer.client.addressPrefix === 'ckb' ? 'ckb-mainnet' : 'ckb-testnet';
}
export function parseCkbAmount(value: string): bigint {
  if (!/^\d+(\.\d{1,8})?$/.test(value)) throw new Error('Enter a positive CKB amount with up to 8 decimal places');
  const [whole, fraction = ''] = value.split('.');
  const amount = BigInt(whole!) * 100_000_000n + BigInt(fraction.padEnd(8, '0'));
  if (amount <= 0n || amount > (1n << 64n) - 1n) throw new Error('CKB amount is outside the valid range');
  return amount;
}
/** Build only: the integrating app reviews and requests the owner signature separately. */
export async function prepareCkbToUsername(registry: PilotUsernameClient, signer: ccc.Signer, username: string, capacity: bigint, options: { sponsorship?: boolean } = {}) {
  const recipient = await registry.resolve(username, signerNetwork(signer));
  const address = await ccc.Address.fromString(recipient.ownerAddress, signer.client);
  const tx = ccc.Transaction.from({ outputs: [{ lock: address.script, capacity }], outputsData: ['0x'] });
  if (capacity <= 0n || capacity > (1n << 64n) - 1n) throw new Error('CKB amount is outside the valid range');
  const minimum = ccc.fixedPointFrom(tx.outputs[0]!.occupiedSize);
  if (capacity < minimum) throw new Error(`Recipient needs at least ${ccc.fixedPointToString(minimum)} CKB to create a cell`);
  await tx.completeInputsByCapacity(signer);
  await tx.completeFeeBy(signer, options.sponsorship ? 0n : 1000n);
  if (options.sponsorship && await tx.getFee(signer.client) !== 0n) throw new Error('Sponsored transfer must pay zero user network fee');
  return { recipient, tx, fee: await tx.getFee(signer.client) };
}
/** NFT support is explicitly Spore; other NFT standards need their own builders. */
export async function prepareSporeToUsername(registry: PilotUsernameClient, signer: ccc.Signer, username: string, id: ccc.HexLike, options: { sponsorship?: boolean } = {}) {
  const recipient = await registry.resolve(username, signerNetwork(signer));
  const address = await ccc.Address.fromString(recipient.ownerAddress, signer.client);
  const { cell } = await assertSpore(signer.client, id);
  const owned = await signer.getAddressObjs();
  if (!owned.some(address => address.script.eq(cell.cellOutput.lock))) throw new Error('This Spore NFT is not owned by the connected wallet');
  const { tx } = await transferSpore({ signer, id, to: address.script });
  await tx.completeInputsByCapacity(signer);
  await tx.completeFeeBy(signer, options.sponsorship ? 0n : 1000n);
  if (options.sponsorship && await tx.getFee(signer.client) !== 0n) throw new Error('Sponsored transfer must pay zero user network fee');
  return { recipient, tx, fee: await tx.getFee(signer.client) };
}
