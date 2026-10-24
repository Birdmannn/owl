import { ccc } from '@ckb-ccc/core';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { verifyWalletIdentity } from './wallet-identity.js';
import type { PilotNetwork } from './usernames.js';
import { MAX_ACTION_CATALOG, MAX_OFFCHAIN_PERMISSIONS } from './limits.js';

export type OffchainJson = null | boolean | number | string | OffchainJson[] | { [key: string]: OffchainJson };
export interface OffchainManifest {
  appId: string;
  name: string;
  audience: string;
  actions: { id: string; name: string; description: string }[];
}
export interface OffchainGrant {
  version: 1;
  id: string;
  manifestHash: ccc.Hex;
  appId: string;
  audience: string;
  owner: { ownerAddress: string; network: PilotNetwork; identity: string; signType: ccc.SignerSignType };
  sessionPublicKey: ccc.Hex;
  permissions: string[];
  issuedAt: number;
  expiresAt: number;
}
export interface OffchainAuthorization { grant: OffchainGrant; proof: ccc.Signature }
export interface OffchainAction {
  version: 1;
  grantId: string;
  appId: string;
  audience: string;
  id: string;
  target: string;
  payload: OffchainJson;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
}
export interface OffchainEnvelope { authorization: OffchainAuthorization; action: OffchainAction; signature: ccc.Hex }
export interface OffchainRevocation {
  authorization: OffchainAuthorization;
  request: { version: 1; grantId: string; appId: string; audience: string; nonce: string; issuedAt: number };
  proof: ccc.Signature;
}
/** Implement accept/revoke atomically with the app mutation and replay/revocation checks. */
export interface OffchainAcceptanceStore<Receipt> {
  accept(envelope: OffchainEnvelope): Promise<Receipt>;
  revoke(request: OffchainRevocation): Promise<void>;
}
const MAX_GRANT_MS = 7 * 86_400_000;
const ACTION_MS = 5 * 60_000;
const textBytes = (value: string) => ccc.bytesFrom(value, 'utf8');
const digest = (domain: string, value: unknown) => ccc.hashCkb(textBytes(domain + '\n' + offchainCanonical(value)));
function fail(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function identifier(value: unknown): value is string { return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value); }
function timestamp(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
/** Strict canonical JSON: no BigInt, undefined, non-finite numbers, class instances, or deep nesting. */
export function offchainCanonical(value: unknown, depth = 0): string {
  fail(depth <= 20, 'Off-chain JSON is too deeply nested');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') { fail(Number.isFinite(value), 'Invalid off-chain number'); return JSON.stringify(value); }
  fail(typeof value === 'object' && value !== null, 'Expected JSON-compatible off-chain data');
  if (Array.isArray(value)) return '[' + Array.from(value, item => offchainCanonical(item, depth + 1)).join(',') + ']';
  fail(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null, 'Expected a plain JSON object');
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + offchainCanonical((value as Record<string, unknown>)[key], depth + 1)).join(',') + '}';
}
export function validateOffchainManifest(manifest: OffchainManifest): void {
  fail(manifest && identifier(manifest.appId) && typeof manifest.name === 'string' && manifest.name.length > 0 && manifest.name.length <= 120, 'Invalid off-chain app');
  const url = new URL(manifest.audience);
  fail(url.origin === manifest.audience && (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))), 'Audience must be an exact HTTPS origin (HTTP allowed on localhost)');
  fail(Array.isArray(manifest.actions) && manifest.actions.length > 0 && manifest.actions.length <= MAX_ACTION_CATALOG, `Declare 1–${MAX_ACTION_CATALOG} off-chain actions`);
  const ids = new Set<string>();
  for (const action of manifest.actions) {
    fail(action && identifier(action.id) && !ids.has(action.id) && typeof action.name === 'string' && action.name.length > 0 && action.name.length <= 120
      && typeof action.description === 'string' && action.description.length > 0 && action.description.length <= 500, 'Invalid or duplicate off-chain permission');
    ids.add(action.id);
  }
}
export function offchainManifestHash(manifest: OffchainManifest): ccc.Hex { validateOffchainManifest(manifest); return digest('owl-pilot-offchain-manifest-v1', manifest); }
export function offchainGrantId(grant: OffchainGrant): ccc.Hex { return digest('owl-pilot-offchain-grant-v1', grant); }
export function offchainGrantMessage(grant: OffchainGrant): string {
  return ['Owl Pilot — off-chain action delegation', `App: ${grant.appId}`, `Audience: ${grant.audience}`,
    `Allow: ${grant.permissions.join(', ')}`, `Expires: ${new Date(grant.expiresAt).toISOString()}`,
    'Authorize this session key to sign only these off-chain actions. This does not authorize CKB transactions or spending.',
    offchainCanonical(grant)].join('\n');
}
async function verifyOwner(message: string, proof: ccc.Signature, owner: OffchainGrant['owner']) {
  fail(proof && proof.signType === owner.signType && proof.identity === owner.identity && typeof proof.signature === 'string', 'Owner proof does not match delegation');
  let raw = proof.signature;
  if (proof.signType === ccc.SignerSignType.JoyId) {
    const joy = JSON.parse(raw);
    fail(joy.alg === -7 && typeof joy.signature === 'string' && typeof joy.message === 'string', 'Invalid JoyID proof');
    raw = JSON.stringify({ alg: joy.alg, signature: joy.signature, message: joy.message });
  }
  await verifyWalletIdentity(owner, owner.network);
  fail(await ccc.Signer.verifyMessage(message, { ...proof, signature: raw }), 'Invalid owner delegation signature');
}
function checkGrant(grant: OffchainGrant, manifest: OffchainManifest, now: number) {
  fail(grant && grant.version === 1 && identifier(grant.id) && grant.manifestHash === offchainManifestHash(manifest)
    && grant.appId === manifest.appId && grant.audience === manifest.audience, 'Delegation belongs to another app or audience');
  fail(timestamp(grant.issuedAt) && timestamp(grant.expiresAt) && grant.issuedAt <= now && now < grant.expiresAt
    && grant.expiresAt > grant.issuedAt && grant.expiresAt - grant.issuedAt <= MAX_GRANT_MS, 'Delegation expired or has invalid lifetime');
  fail(grant.owner && ['ckb-testnet', 'ckb-mainnet'].includes(grant.owner.network), 'Invalid owner network');
  fail(Array.isArray(grant.permissions) && grant.permissions.length > 0 && grant.permissions.length <= MAX_OFFCHAIN_PERMISSIONS && new Set(grant.permissions).size === grant.permissions.length
    && grant.permissions.every(id => manifest.actions.some(action => action.id === id)), 'Invalid delegated permissions');
  fail(typeof grant.sessionPublicKey === 'string' && /^0x(02|03)[a-f0-9]{64}$/.test(grant.sessionPublicKey), 'Invalid session public key');
  secp256k1.Point.fromBytes(ccc.bytesFrom(grant.sessionPublicKey));
}
export async function authorizeOffchain(owner: ccc.Signer, manifest: OffchainManifest, options: {
  selected: readonly string[]; sessionPublicKey: ccc.Hex; expiresAt: number; now?: number;
}): Promise<OffchainAuthorization> {
  validateOffchainManifest(manifest);
  fail(options.selected.length <= MAX_OFFCHAIN_PERMISSIONS, `Select at most ${MAX_OFFCHAIN_PERMISSIONS} off-chain actions`);
  const now = options.now ?? Date.now();
  const grant: OffchainGrant = { version: 1, id: crypto.randomUUID(), manifestHash: offchainManifestHash(manifest), appId: manifest.appId,
    audience: manifest.audience, owner: { ownerAddress: await owner.getRecommendedAddress(), identity: await owner.getIdentity(), signType: owner.signType,
      network: owner.client.addressPrefix === 'ckb' ? 'ckb-mainnet' : 'ckb-testnet' },
    sessionPublicKey: options.sessionPublicKey, permissions: [...options.selected].sort(), issuedAt: now, expiresAt: options.expiresAt };
  checkGrant(grant, manifest, now);
  const proof = await owner.signMessage(offchainGrantMessage(grant));
  const authorization = { grant, proof };
  await verifyOffchainAuthorization(authorization, manifest, now);
  return authorization;
}
export async function verifyOffchainAuthorization(authorization: OffchainAuthorization, manifest: OffchainManifest, now = Date.now()): Promise<void> {
  fail(authorization && textBytes(offchainCanonical(authorization)).length <= 32_768, 'Invalid or oversized off-chain authorization');
  checkGrant(authorization.grant, manifest, now);
  await verifyOwner(offchainGrantMessage(authorization.grant), authorization.proof, authorization.grant.owner);
}
function checkAction(action: OffchainAction, grant: OffchainGrant, now: number) {
  fail(action && action.version === 1 && action.grantId === offchainGrantId(grant) && action.appId === grant.appId && action.audience === grant.audience, 'Action is outside this delegation');
  fail(grant.permissions.includes(action.id) && typeof action.target === 'string' && action.target.length > 0 && textBytes(action.target).length <= 512
    && identifier(action.nonce), 'Action permission, target, or nonce is invalid');
  fail(timestamp(action.issuedAt) && timestamp(action.expiresAt) && action.issuedAt >= grant.issuedAt && action.issuedAt <= now && now < action.expiresAt
    && action.expiresAt <= grant.expiresAt && action.expiresAt > action.issuedAt && action.expiresAt - action.issuedAt <= ACTION_MS, 'Off-chain action expired or has invalid lifetime');
  fail(textBytes(offchainCanonical(action.payload)).length <= 16_384, 'Off-chain payload is too large');
}
export class PilotOffchainSession {
  private constructor(private authorization: OffchainAuthorization, private key: ccc.Hex, private now: () => number) {}
  static async create(authorization: OffchainAuthorization, manifest: OffchainManifest, privateKey: ccc.Hex, now = Date.now, expectedOwnerAddress?: string) {
    const snapshot = JSON.parse(offchainCanonical(authorization)) as OffchainAuthorization;
    if (expectedOwnerAddress !== undefined) fail(snapshot.grant.owner.ownerAddress === expectedOwnerAddress, 'Delegation belongs to another connected wallet');
    await verifyOffchainAuthorization(snapshot, manifest, now());
    fail(ccc.hexFrom(secp256k1.getPublicKey(ccc.bytesFrom(privateKey), true)) === snapshot.grant.sessionPublicKey, 'Session key does not match delegation');
    return new PilotOffchainSession(snapshot, privateKey, now);
  }
  sign(input: { id: string; target: string; payload: OffchainJson }, options: { nonce?: string; expiresAt?: number } = {}): OffchainEnvelope {
    const issuedAt = this.now(), grant = this.authorization.grant;
    fail(issuedAt < grant.expiresAt, 'Delegation expired');
    const action: OffchainAction = { ...structuredClone(input), version: 1, grantId: offchainGrantId(grant), appId: grant.appId, audience: grant.audience,
      nonce: options.nonce ?? crypto.randomUUID(), issuedAt, expiresAt: options.expiresAt ?? Math.min(grant.expiresAt, issuedAt + ACTION_MS) };
    checkAction(action, grant, issuedAt);
    return { authorization: structuredClone(this.authorization), action,
      signature: ccc.hexFrom(secp256k1.sign(ccc.bytesFrom(digest('owl-pilot-offchain-action-v1', action)), ccc.bytesFrom(this.key), { prehash: false })) };
  }
}
/** Cryptographic verification only. Use acceptOffchainAction to enforce replay protection and mutate app state. */
export async function verifyOffchainAction(envelope: OffchainEnvelope, manifest: OffchainManifest, now = Date.now()): Promise<void> {
  fail(envelope && textBytes(offchainCanonical(envelope)).length <= 65_536, 'Invalid or oversized off-chain envelope');
  await verifyOffchainAuthorization(envelope.authorization, manifest, now);
  checkAction(envelope.action, envelope.authorization.grant, now);
  fail(typeof envelope.signature === 'string' && /^0x[a-f0-9]{128}$/.test(envelope.signature)
    && secp256k1.verify(ccc.bytesFrom(envelope.signature), ccc.bytesFrom(digest('owl-pilot-offchain-action-v1', envelope.action)),
      ccc.bytesFrom(envelope.authorization.grant.sessionPublicKey), { prehash: false }), 'Invalid session action signature');
}
export async function acceptOffchainAction<Receipt>(envelope: OffchainEnvelope, options: {
  manifest: OffchainManifest; store: OffchainAcceptanceStore<Receipt>; now?: number;
}): Promise<Receipt> {
  const snapshot = JSON.parse(offchainCanonical(envelope)) as OffchainEnvelope;
  await verifyOffchainAction(snapshot, options.manifest, options.now ?? Date.now());
  return options.store.accept(snapshot);
}
const revocationMessage = (request: OffchainRevocation['request']) => 'Owl Pilot — revoke off-chain delegation\n' + offchainCanonical(request);
export async function revokeOffchain(owner: ccc.Signer, authorization: OffchainAuthorization, manifest: OffchainManifest): Promise<OffchainRevocation> {
  await verifyOffchainAuthorization(authorization, manifest);
  fail(await owner.getRecommendedAddress() === authorization.grant.owner.ownerAddress && await owner.getIdentity() === authorization.grant.owner.identity, 'Connect the delegation owner to revoke');
  const request: OffchainRevocation['request'] = { version: 1, grantId: offchainGrantId(authorization.grant), appId: manifest.appId, audience: manifest.audience, nonce: crypto.randomUUID(), issuedAt: Date.now() };
  return { authorization: structuredClone(authorization), request, proof: await owner.signMessage(revocationMessage(request)) };
}
export async function acceptOffchainRevocation<Receipt>(revocation: OffchainRevocation, options: {
  manifest: OffchainManifest; store: OffchainAcceptanceStore<Receipt>; now?: number;
}): Promise<void> {
  const snapshot = JSON.parse(offchainCanonical(revocation)) as OffchainRevocation;
  const now = options.now ?? Date.now();
  await verifyOffchainAuthorization(snapshot.authorization, options.manifest, now);
  const { request, authorization } = snapshot;
  fail(request.version === 1 && request.grantId === offchainGrantId(authorization.grant) && request.appId === options.manifest.appId && request.audience === options.manifest.audience
    && identifier(request.nonce) && timestamp(request.issuedAt) && request.issuedAt <= now && now - request.issuedAt < ACTION_MS, 'Invalid or expired revocation');
  await verifyOwner(revocationMessage(request), snapshot.proof, authorization.grant.owner);
  await options.store.revoke(snapshot);
}
