import { appOrigins, allowedAppOrigins, pilotOrigin, socialAudience } from './origins.js';
import type { RequestListener } from 'node:http';
import { PostgresRegistryStore } from './registry-store.js';
import { createRegistryHandler } from './registry.js';
import { PostgresSocialStore, createSocialHandler } from './offchain-social.js';
import { createPaymasterHandler } from './paymaster.js';
import { paymasterFromEnvironment } from './paymaster-config.js';
import { MemoryRateLimiter, PostgresRateLimiter, type RateLimiter } from './http.js';
import { databaseUrl, postgresPool } from './postgres.js';
import { socialManifest } from '../examples/offchain-social.js';
import { validateOffchainManifest } from '../src/offchain.js';
import type { PilotNetwork } from '../src/usernames.js';

let limiter: Promise<RateLimiter> | undefined;
export function rateLimiterFromEnvironment(): Promise<RateLimiter> {
  if (!limiter) limiter = (async () => {
    const url = databaseUrl();
    if (!url) return new MemoryRateLimiter();
    const value = new PostgresRateLimiter(postgresPool(url));
    try { await value.init(); return value; }
    catch (error) { await value.pool.end(); throw error; }
  })().catch(error => { limiter = undefined; throw error; });
  return limiter;
}
export type PilotService = 'pilot' | 'social' | 'paymaster';
/** Lazy per-service initialization: registry/social requests never require the pool key. */
export async function serverlessHandler(service: PilotService): Promise<RequestListener> {
  const database = databaseUrl();
  if (!database) throw new Error('Serverless Pilot requires DATABASE_URL or POSTGRES_URL; JSON fallback is disabled');
  const apps = appOrigins();
  const rateLimiter = await rateLimiterFromEnvironment();
  if (service === 'pilot') {
    const network = process.env.PILOT_REGISTRY_NETWORK ?? 'ckb-testnet';
    if (!['ckb-testnet', 'ckb-mainnet'].includes(network)) throw new Error('Invalid registry network');
    const registryOrigin = pilotOrigin(process.env.PILOT_REGISTRY_ORIGIN ?? apps[0]);
    const allowedOrigins = allowedAppOrigins('REGISTRY');
    const store = new PostgresRegistryStore(database);
    try { await store.init(); }
    catch (error) { await store.close(); throw error; }
    return createRegistryHandler({ store, network: network as PilotNetwork,
      origin: registryOrigin, allowedOrigins, rateLimiter });
  }
  if (service === 'social') {
    const audience = socialAudience();
    validateOffchainManifest(socialManifest(audience));
    const store = new PostgresSocialStore(database, audience);
    try { await store.init(); }
    catch (error) { await store.close(); throw error; }
    return createSocialHandler({ store, audience, rateLimiter });
  }
  const allowedOrigins = allowedAppOrigins('PAYMASTER');
  return createPaymasterHandler({ paymaster: await paymasterFromEnvironment(), allowedOrigins, rateLimiter });
}
