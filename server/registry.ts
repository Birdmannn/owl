import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { ccc } from '@ckb-ccc/core';
import { normalizeUsername, type PilotNetwork, type PilotUsername } from '../src/usernames.js';
import type { RegistryStore } from './registry-store.js';

export interface RegistryOptions { store: RegistryStore; network: PilotNetwork; origin: string; allowedOrigins: string[] }
/** Derive acceptable CKB locks from the signing identity, never trust a claimed address alone. */
export async function verifiedProfile(input: unknown, network: PilotNetwork): Promise<PilotUsername> {
  const value = input as Record<string, unknown>;
  if (!value || typeof value.username !== 'string' || typeof value.ownerAddress !== 'string' ||
    typeof value.identity !== 'string' || value.identity.length > 3000) throw new Error('Invalid username registration');
  const client = network === 'ckb-testnet' ? new ccc.ClientPublicTestnet() : new ccc.ClientPublicMainnet();
  const address = await ccc.Address.fromString(value.ownerAddress, client);
  if (address.prefix !== client.addressPrefix) throw new Error('Wallet address belongs to another CKB network');
  const signType = value.signType as ccc.SignerSignType;
  let identity = value.identity;
  let passkeyPublicKey: string | undefined;
  let scripts: ccc.Script[];
  if (signType === ccc.SignerSignType.JoyId) {
    const parsed = JSON.parse(identity);
    if (parsed.keyType !== 'main_key' || typeof parsed.publicKey !== 'string' || !/^[a-f0-9]{128}$/i.test(parsed.publicKey)) {
      throw new Error('Register with your primary JoyID P-256 passkey; subkeys and temporary session keys cannot claim usernames');
    }
    passkeyPublicKey = parsed.publicKey.toLowerCase();
    identity = JSON.stringify({ keyType: 'main_key', publicKey: passkeyPublicKey });
    scripts = [(await ccc.Address.fromKnownScript(client, ccc.KnownScript.JoyId,
      `0x0001${ccc.hashCkb(`0x${passkeyPublicKey}`).slice(2, 42)}`)).script];
  } else if (signType === ccc.SignerSignType.CkbSecp256k1) {
    identity = ccc.hexFrom(identity).toLowerCase();
    if (!/^0x(02|03)[0-9a-f]{64}$/.test(identity)) throw new Error('Invalid CKB public key');
    const args = ccc.hashCkb(identity).slice(0, 42) as ccc.Hex;
    scripts = await Promise.all([ccc.KnownScript.Secp256k1Blake160, ccc.KnownScript.AnyoneCanPay].map(async known =>
      (await ccc.Address.fromKnownScript(client, known, args)).script));
  } else {
    let signer: ccc.Signer;
    switch (signType) {
      case ccc.SignerSignType.EvmPersonal:
        if (!/^0x[0-9a-f]{40}$/i.test(identity)) throw new Error('Invalid EVM identity');
        identity = identity.toLowerCase(); signer = new ccc.SignerEvmAddressReadonly(client, identity); break;
      case ccc.SignerSignType.BtcEcdsa:
        identity = identity.replace(/^0x/, '').toLowerCase();
        if (!/^(02|03)[0-9a-f]{64}$/.test(identity)) throw new Error('Invalid Bitcoin public key');
        signer = new ccc.SignerBtcPublicKeyReadonly(client, '', `0x${identity}`); break;
      case ccc.SignerSignType.NostrEvent:
        signer = new ccc.SignerNostrPublicKeyReadonly(client, identity);
        identity = await signer.getIdentity(); break;
      case ccc.SignerSignType.DogeEcdsa:
        signer = new ccc.SignerDogeAddressReadonly(client, identity); break;
      default: throw new Error('This wallet cannot verify Pilot username ownership');
    }
    scripts = (await signer.getAddressObjs()).map(a => a.script);
  }
  if (!scripts.some(script => script.eq(address.script))) throw new Error('Signing identity does not control this CKB recipient address');
  return { version: 2, username: normalizeUsername(value.username), ownerAddress: address.toString(), network,
    provider: signType === ccc.SignerSignType.JoyId ? 'joyid' : 'wallet', signType, identity,
    ...(passkeyPublicKey ? { passkeyPublicKey } : {}), createdAt: Date.now() };
}

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16_384) throw new Error('Request body is too large');
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export function createRegistryServer(options: RegistryOptions) {
  const { store, network, origin, allowedOrigins } = options;
  const rates = new Map<string, { count: number; until: number }>();
  return createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const send = (status: number, value: unknown) => { response.statusCode = status; response.end(JSON.stringify(value)); };
    const requestOrigin = request.headers.origin;
    if (requestOrigin && !allowedOrigins.includes(requestOrigin)) { send(403, { error: 'Origin is not allowed' }); return; }
    if (requestOrigin) { response.setHeader('Access-Control-Allow-Origin', requestOrigin); response.setHeader('Vary', 'Origin'); }
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (request.method === 'OPTIONS') { response.statusCode = 204; response.end(); return; }
    try {
      const path = new URL(request.url ?? '/', origin).pathname;
      if (request.method === 'GET' && path === '/api/pilot/health') { send(200, { status: 'ok', network }); return; }
      if (request.method === 'GET' && path.startsWith('/api/pilot/usernames/')) {
        const profile = await store.get(normalizeUsername(decodeURIComponent(path.slice('/api/pilot/usernames/'.length))));
        send(profile ? 200 : 404, profile ?? { error: 'Pilot username not found' }); return;
      }
      if (request.method === 'GET' && path.startsWith('/api/pilot/accounts/')) {
        const address = decodeURIComponent(path.slice('/api/pilot/accounts/'.length));
        if (address.length > 300) throw new Error('Invalid account address');
        send(200, { profile: await store.byAddress(address) }); return;
      }
      if (request.method !== 'POST' || !['/api/pilot/challenges', '/api/pilot/usernames'].includes(path)) {
        send(404, { error: 'Not found' }); return;
      }
      const now = Date.now(), ip = request.socket.remoteAddress ?? 'unknown';
      for (const [key, rate] of rates) if (rate.until <= now) rates.delete(key);
      const rate = rates.get(ip) ?? { count: 0, until: now + 60_000 };
      rates.set(ip, rate); if (++rate.count > 60) { send(429, { error: 'Too many registration requests; try again shortly' }); return; }
      if (!request.headers['content-type']?.startsWith('application/json')) throw new Error('Expected application/json');
      const input = await body(request);
      if (path === '/api/pilot/challenges') {
        const profile = await verifiedProfile(input, network);
        if (await store.get(profile.username) || await store.byAddress(profile.ownerAddress)) {
          send(409, { error: 'Username or wallet already registered' }); return;
        }
        const id = randomUUID(), expiresAt = Date.now() + 5 * 60_000;
        const message = ['Owl Pilot username registration', `Registry: ${origin}`, `Network: ${network}`,
          `Username: @${profile.username}`, `Recipient: ${profile.ownerAddress}`, `Signing type: ${profile.signType}`,
          `Identity: ${profile.identity}`, `Nonce: ${id}`, `Expires: ${new Date(expiresAt).toISOString()}`,
          'This registers a public recipient name. It does not authorize spending or session actions.'].join('\n');
        await store.challenge({ id, message, profile, expiresAt });
        send(201, { id, message, expiresAt }); return;
      }
      const claim = input as { challengeId?: string; signature?: ccc.Signature };
      if (!claim || typeof claim.challengeId !== 'string' || !/^[0-9a-f-]{36}$/i.test(claim.challengeId) || !claim.signature) throw new Error('Invalid registration proof');
      const challenge = await store.getChallenge(claim.challengeId);
      if (!challenge) throw new Error('Registration challenge expired or already used');
      const signature = claim.signature;
      const normalized = await verifiedProfile({ ...challenge.profile, identity: signature.identity, signType: signature.signType }, network);
      if (normalized.identity !== challenge.profile.identity || signature.signType !== challenge.profile.signType || typeof signature.signature !== 'string') throw new Error('Registration proof does not match its challenge');
      // CCC's JoyID verifier spreads the JSON signature. Whitelist fields so an
      // attacker cannot replace the server challenge, key, or credential type.
      let raw = signature.signature;
      if (signature.signType === ccc.SignerSignType.JoyId) {
        const joy = JSON.parse(raw);
        if (joy.alg !== -7 || typeof joy.signature !== 'string' || typeof joy.message !== 'string') throw new Error('Invalid JoyID passkey signature');
        raw = JSON.stringify({ alg: joy.alg, signature: joy.signature, message: joy.message });
      }
      if (!await ccc.Signer.verifyMessage(challenge.message, { signType: signature.signType, identity: challenge.profile.identity, signature: raw })) {
        send(401, { error: 'Wallet signature verification failed' }); return;
      }
      send(201, await store.claim(claim.challengeId));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Registry request failed';
      // Do not expose database connection details or filesystem paths to clients.
      const expected = /Invalid|invalid|Use 3|Register with|Signing identity|wallet|Wallet|network|Network|expired|already|Expected|too large|Too many|This wallet/.test(message);
      send(expected ? /already/.test(message) ? 409 : 400 : 503, { error: expected ? message : 'Pilot username registry is unavailable; retry shortly' });
    }
  });
}
