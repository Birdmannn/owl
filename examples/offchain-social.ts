import { ccc } from '@ckb-ccc/core';
import { offchainCanonical, type OffchainManifest, type OffchainEnvelope, type OffchainRevocation } from '../src/offchain.js';

export function socialManifest(audience: string): OffchainManifest {
  return { appId: 'owl.pilot.social-demo', name: 'Pilot Social', audience, actions: [
    { id: 'social.like', name: 'Like posts', description: 'Like or unlike the demo introduction post.' },
    { id: 'social.follow', name: 'Follow creators', description: 'Follow or unfollow the Owl demo account.' },
    { id: 'social.post', name: 'Publish posts', description: 'Publish a text post of up to 280 characters to the demo feed.' },
  ] };
}
export interface SocialReceipt {
  id: ccc.Hex; requestHash: ccc.Hex; grantId: string; nonce: string; owner: string;
  actionId: string; target: string; payload: OffchainEnvelope['action']['payload']; acceptedAt: number;
}
export interface SocialData {
  version: 1; likes: string[]; followers: string[]; posts: { id: string; owner: string; text: string }[];
  receipts: SocialReceipt[]; revoked: string[];
}
export const emptySocialData = (): SocialData => ({ version: 1, likes: [], followers: [], posts: [], receipts: [], revoked: [] });
/** Call only with a cryptographically verified envelope, inside an atomic store transaction. */
export function applySocialAction(data: SocialData, envelope: OffchainEnvelope, now = Date.now()): SocialReceipt {
  const { action, authorization: { grant } } = envelope;
  if (data.revoked.includes(action.grantId)) throw new Error('Delegation has been revoked');
  if (now >= action.expiresAt || now >= grant.expiresAt) throw new Error('Action or delegation expired before acceptance');
  const requestHash = ccc.hashCkb(ccc.bytesFrom(offchainCanonical(envelope), 'utf8'));
  const previous = data.receipts.find(receipt => receipt.grantId === action.grantId && receipt.nonce === action.nonce);
  if (previous) {
    if (previous.requestHash !== requestHash) throw new Error('Replay nonce is already used by another action');
    return previous; // Exact-byte retries return the original result; no second mutation.
  }
  if (data.receipts.length >= 10_000) throw new Error('Demo receipt limit reached');
  const payload = action.payload as Record<string, unknown> | null;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid social action payload');
  const owner = grant.owner.ownerAddress;
  if (action.id === 'social.like' || action.id === 'social.follow') {
    if (Object.keys(payload).length !== 1 || typeof payload.enabled !== 'boolean' || action.target !== (action.id === 'social.like' ? 'pilot-introduction' : 'owl')) throw new Error('Invalid social target or payload');
    const list = action.id === 'social.like' ? data.likes : data.followers;
    const index = list.indexOf(owner);
    if (payload.enabled && index < 0) list.push(owner);
    if (!payload.enabled && index >= 0) list.splice(index, 1);
  } else if (action.id === 'social.post') {
    if (action.target !== 'pilot-feed' || Object.keys(payload).length !== 1 || typeof payload.text !== 'string' || !payload.text.trim() || [...payload.text].length > 280) throw new Error('Post must contain 1–280 characters');
    data.posts.push({ id: requestHash, owner, text: payload.text });
  } else throw new Error('Unknown social action');
  const receipt: SocialReceipt = { id: requestHash, requestHash, grantId: action.grantId, nonce: action.nonce, owner,
    actionId: action.id, target: action.target, payload: structuredClone(action.payload), acceptedAt: now };
  data.receipts.push(receipt); return receipt;
}
export function applySocialRevocation(data: SocialData, revocation: OffchainRevocation) {
  const id = revocation.request.grantId;
  if (!data.revoked.includes(id)) { if (data.revoked.length >= 10_000) throw new Error('Demo revocation limit reached'); data.revoked.push(id); }
}
