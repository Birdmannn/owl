import { createServer } from 'node:http';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import lockfile from 'proper-lockfile';
import { acceptOffchainAction, acceptOffchainRevocation, type OffchainEnvelope, type OffchainRevocation, type OffchainAcceptanceStore } from '../src/offchain.js';
import { socialManifest, emptySocialData, applySocialAction, applySocialRevocation, type SocialData, type SocialReceipt } from '../examples/offchain-social.js';

/** Single-file demo backend. Lock + atomic rename keep mutation, replay checks, and revocation indivisible. */
export class JsonSocialStore implements OffchainAcceptanceStore<SocialReceipt> {
  constructor(readonly file: string) {}
  async init() {
    await mkdir(dirname(this.file), { recursive: true });
    const release = await this.lock();
    try {
      try { await writeFile(this.file, JSON.stringify(emptySocialData()), { flag: 'wx', mode: 0o600 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      await this.read();
    } finally { await release(); }
  }
  private lock() { return lockfile.lock(this.file, { realpath: false, retries: { retries: 30, minTimeout: 10, maxTimeout: 100 } }); }
  async read(): Promise<SocialData> {
    const value = JSON.parse(await readFile(this.file, 'utf8'));
    if (value.version !== 1 || !['likes', 'followers', 'posts', 'receipts', 'revoked'].every(key => Array.isArray(value[key]))) throw new Error('Invalid social store; refusing to reset it');
    return value;
  }
  private async mutate<T>(operation: (data: SocialData) => T) {
    const release = await this.lock();
    try {
      const data = await this.read(); const result = operation(data);
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(data), { mode: 0o600 });
      await rename(temporary, this.file); return result;
    } finally { await release(); }
  }
  accept(envelope: OffchainEnvelope) { return this.mutate(data => applySocialAction(data, envelope)); }
  async revoke(request: OffchainRevocation) { await this.mutate(data => applySocialRevocation(data, request)); }
}
export function createSocialServer(options: { store: JsonSocialStore; audience: string }) {
  const manifest = socialManifest(options.audience);
  const rates = new Map<string, { count: number; until: number }>();
  return createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json'); response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const send = (status: number, value: unknown) => { response.statusCode = status; response.end(JSON.stringify(value)); };
    const origin = request.headers.origin;
    const publicHistory = request.method === 'GET' && request.url?.split('?')[0] === '/api/social/receipts';
    if (publicHistory) response.setHeader('Access-Control-Allow-Origin', '*');
    if (!publicHistory && origin && origin !== options.audience) { send(403, { error: 'Origin is not allowed' }); return; }
    if (!publicHistory && origin) { response.setHeader('Access-Control-Allow-Origin', origin); response.setHeader('Vary', 'Origin'); }
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS'); response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (request.method === 'OPTIONS') { response.statusCode = 204; response.end(); return; }
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const path = url.pathname;
      if (request.method === 'GET' && path === '/api/social/receipts') {
        const data = await options.store.read();
        const rawCursor = url.searchParams.get('cursor');
        const rawLimit = url.searchParams.get('limit') ?? '50';
        if (!/^[1-9]\d*$/.test(rawLimit) || Number(rawLimit) > 100) throw new Error('Invalid receipt limit');
        if (rawCursor !== null && !/^(0|[1-9]\d*)$/.test(rawCursor)) throw new Error('Invalid receipt cursor');
        const end = rawCursor === null ? data.receipts.length : Number(rawCursor);
        if (!Number.isSafeInteger(end) || end > data.receipts.length) throw new Error('Invalid receipt cursor');
        const start = Math.max(0, end - Number(rawLimit));
        send(200, { receipts: data.receipts.slice(start, end).reverse(), cursor: start > 0 ? start : null }); return;
      }
      if (request.method === 'GET' && path === '/api/social/state') {
        const data = await options.store.read();
        send(200, { likes: data.likes, followers: data.followers, posts: data.posts, receipts: data.receipts.slice(-100) }); return;
      }
      if (request.method === 'GET' && path === '/api/social/manifest') { send(200, manifest); return; }
      if (request.method !== 'POST' || !['/api/social/actions', '/api/social/revoke'].includes(path)) { send(404, { error: 'Not found' }); return; }
      const now = Date.now();
      for (const [ip, value] of rates) if (value.until <= now) rates.delete(ip);
      const ip = request.socket.remoteAddress ?? 'unknown'; const rate = rates.get(ip) ?? { count: 0, until: now + 60_000 }; rates.set(ip, rate);
      if (++rate.count > 120) { send(429, { error: 'Too many requests' }); return; }
      if (!request.headers['content-type']?.startsWith('application/json')) throw new Error('Expected application/json');
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of request) { size += chunk.length; if (size > 65_536) throw new Error('Request is too large'); chunks.push(Buffer.from(chunk)); }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (path === '/api/social/actions') {
        send(200, await acceptOffchainAction(input, { manifest, store: options.store })); return;
      }
      await acceptOffchainRevocation(input, { manifest, store: options.store }); send(200, { revoked: true });
    } catch (error) {
      // Node I/O failures may include paths; never expose those to the browser.
      if (error && typeof error === 'object' && 'code' in error) { send(503, { error: 'Social storage unavailable' }); return; }
      send(400, { error: error instanceof Error ? error.message : 'Invalid social request' });
    }
  });
}
