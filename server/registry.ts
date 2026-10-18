import { readJson, MemoryRateLimiter, requestIp, type RateLimiter } from './http.js';
import { verifyWalletIdentity } from '../src/wallet-identity.js';
import { randomUUID } from 'node:crypto';
import { createServer, type RequestListener } from 'node:http';
import { ccc } from '@ckb-ccc/core';
import { normalizeUsername, type PilotNetwork, type PilotUsername } from '../src/usernames.js';
import type { RegistryStore } from './registry-store.js';

export interface RegistryOptions { store: RegistryStore; network: PilotNetwork; origin: string; allowedOrigins: string[]; rateLimiter?: RateLimiter }
/** Verify the signing identity controls the named CKB recipient. */
export async function verifiedProfile(input: unknown, network: PilotNetwork): Promise<PilotUsername> {
  const value = input as Record<string, unknown>;
  if (!value || typeof value.username !== 'string') throw new Error('Invalid username registration');
  return { version: 2, username: normalizeUsername(value.username), ...await verifyWalletIdentity(input, network), createdAt: Date.now() };
}

export function createRegistryHandler(options: RegistryOptions): RequestListener {
  const { store, network, origin, allowedOrigins } = options;
  const limiter = options.rateLimiter ?? new MemoryRateLimiter();
  return async (request, response) => {
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
      if (!await limiter.allow(`registry:${requestIp(request)}`, 60)) { send(429, { error: 'Too many registration requests; try again shortly' }); return; }
      if (!request.headers['content-type']?.startsWith('application/json')) throw new Error('Expected application/json');
      const input = await readJson(request, 16_384);
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
  };
}
export function createRegistryServer(options: RegistryOptions) { return createServer(createRegistryHandler(options)); }
