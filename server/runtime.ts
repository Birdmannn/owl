import type { RequestListener } from 'node:http';
import { PostgresRegistryStore } from './registry-store.js';
import { createRegistryHandler } from './registry.js';
import { PostgresSocialStore, createSocialHandler } from './offchain-social.js';
import { createPaymasterHandler } from './paymaster.js';
import { paymasterFromEnvironment } from './paymaster-config.js';
import { MemoryRateLimiter, PostgresRateLimiter, type RateLimiter } from './http.js';
import { postgresPool } from './postgres.js';
import { socialManifest } from '../examples/offchain-social.js';
import { validateOffchainManifest } from '../src/offchain.js';
import type { PilotNetwork } from '../src/usernames.js';

let limiter: Promise<RateLimiter> | undefined;
export function rateLimiterFromEnvironment(): Promise<RateLimiter> {
  if (!limiter) limiter = (async () => {
    if (!process.env.DATABASE_URL) return new MemoryRateLimiter();
    const value = new PostgresRateLimiter(postgresPool(process.env.DATABASE_URL));
    try { await value.init(); return value; }
    catch (error) { await value.pool.end(); throw error; }
  })().catch(error => { limiter = undefined; throw error; });
  return limiter;
}
function origin(value: string | undefined): string {
  if (!value || new URL(value).origin !== value || !value.startsWith('https://')) throw new Error('Configure an exact HTTPS PILOT_APP_ORIGIN');
  return value;
}
function origins(value: string | undefined, fallback: string) {
  return (value ?? fallback).split(',').map(s => origin(s.trim()));
}
export type PilotService = 'pilot' | 'social' | 'paymaster';
/** Lazy per-service initialization: registry/social requests never require the pool key. */
export async function serverlessHandler(service: PilotService): Promise<RequestListener> {
  const database = process.env.DATABASE_URL;
  if (!database) throw new Error('Serverless Pilot requires DATABASE_URL; JSON fallback is disabled');
  const appOrigin = origin(process.env.PILOT_APP_ORIGIN);
  const rateLimiter = await rateLimiterFromEnvironment();
  if (service === 'pilot') {
    const network = process.env.PILOT_REGISTRY_NETWORK ?? 'ckb-testnet';
    if (!['ckb-testnet', 'ckb-mainnet'].includes(network)) throw new Error('Invalid registry network');
    const registryOrigin = origin(process.env.PILOT_REGISTRY_ORIGIN ?? appOrigin);
    const allowedOrigins = origins(process.env.PILOT_REGISTRY_ALLOWED_ORIGINS, appOrigin);
    const store = new PostgresRegistryStore(database);
    try { await store.init(); }
    catch (error) { await store.close(); throw error; }
    return createRegistryHandler({ store, network: network as PilotNetwork,
      origin: registryOrigin, allowedOrigins, rateLimiter });
  }
  if (service === 'social') {
    const audience = origin(process.env.PILOT_SOCIAL_AUDIENCE ?? appOrigin);
    validateOffchainManifest(socialManifest(audience));
    const store = new PostgresSocialStore(database, audience);
    try { await store.init(); }
    catch (error) { await store.close(); throw error; }
    return createSocialHandler({ store, audience, rateLimiter });
  }
  const allowedOrigins = origins(process.env.PILOT_PAYMASTER_ALLOWED_ORIGINS, appOrigin);
  return createPaymasterHandler({ paymaster: await paymasterFromEnvironment(), allowedOrigins, rateLimiter });
}
