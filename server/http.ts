import type { IncomingMessage } from 'node:http';
import type pg from 'pg';
import { initializePostgres } from './postgres.js';

/** Supports raw Node streams and Vercel's pre-parsed request.body, with the same byte cap. */
export async function readJson(request: IncomingMessage, limit: number): Promise<unknown> {
  const parsed = (request as IncomingMessage & { body?: unknown }).body;
  if (parsed !== undefined) {
    const raw = Buffer.isBuffer(parsed) ? parsed : Buffer.from(typeof parsed === 'string' ? parsed : JSON.stringify(parsed));
    if (raw.length > limit) throw new Error('Request body is too large');
    return JSON.parse(raw.toString('utf8'));
  }
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    size += Buffer.byteLength(chunk);
    if (size > limit) throw new Error('Request body is too large');
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export interface RateLimiter { allow(key: string, limit: number): Promise<boolean> }
export class MemoryRateLimiter implements RateLimiter {
  private rates = new Map<string, { count: number; until: number }>();
  async allow(key: string, limit: number) {
    const now = Date.now();
    for (const [key, value] of this.rates) if (value.until <= now) this.rates.delete(key);
    const value = this.rates.get(key) ?? { count: 0, until: now + 60_000 };
    this.rates.set(key, value); return ++value.count <= limit;
  }
}
export class PostgresRateLimiter implements RateLimiter {
  constructor(readonly pool: pg.Pool) {}
  async init() {
    await initializePostgres(this.pool, `CREATE TABLE IF NOT EXISTS pilot_rate_limits (
      key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at TIMESTAMPTZ NOT NULL);
      CREATE INDEX IF NOT EXISTS pilot_rate_limits_expiry ON pilot_rate_limits(expires_at);`);
  }
  async allow(key: string, limit: number) {
    await this.pool.query("DELETE FROM pilot_rate_limits WHERE expires_at < NOW() - INTERVAL '1 hour'");
    const result = await this.pool.query(`INSERT INTO pilot_rate_limits AS r(key,count,expires_at)
      VALUES($1,1,NOW() + INTERVAL '1 minute') ON CONFLICT(key) DO UPDATE SET
      count=CASE WHEN r.expires_at<=NOW() THEN 1 ELSE LEAST(r.count+1,1000000) END,
      expires_at=CASE WHEN r.expires_at<=NOW() THEN NOW()+INTERVAL '1 minute' ELSE r.expires_at END
      RETURNING count`, [key]);
    return result.rows[0].count <= limit;
  }
}
export function requestIp(request: IncomingMessage) {
  // Only use the proxy's overwritten header on Vercel, never arbitrary forwarded headers locally.
  const forwarded = process.env.VERCEL === '1' ? request.headers['x-forwarded-for'] : undefined;
  return (typeof forwarded === 'string' ? forwarded.split(',')[0]?.trim() : undefined) ?? request.socket.remoteAddress ?? 'unknown';
}
