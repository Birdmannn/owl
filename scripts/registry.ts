import { databaseUrl } from '../server/postgres.js';
import { rateLimiterFromEnvironment } from '../server/runtime.js';
import { resolve } from 'node:path';
import { JsonRegistryStore, PostgresRegistryStore } from '../server/registry-store.js';
import { createRegistryServer } from '../server/registry.js';
import type { PilotNetwork } from '../src/usernames.js';

const url = databaseUrl();
if (url && !/^postgres(ql)?:\/\//.test(url)) throw new Error('DATABASE_URL or POSTGRES_URL must be a PostgreSQL connection URL');
const store = url ? new PostgresRegistryStore(url) : new JsonRegistryStore(resolve(process.env.PILOT_REGISTRY_FILE ?? 'data/pilot-usernames.json'));
const network = process.env.PILOT_REGISTRY_NETWORK ?? 'ckb-testnet';
if (!['ckb-testnet', 'ckb-mainnet'].includes(network)) throw new Error('Invalid PILOT_REGISTRY_NETWORK');
await store.init(); // Database failures deliberately do not fall back to another registry.
const port = Number(process.env.PILOT_REGISTRY_PORT ?? 5180);
const origin = process.env.PILOT_REGISTRY_ORIGIN ?? `http://127.0.0.1:${port}`;
const allowedOrigins = (process.env.PILOT_REGISTRY_ALLOWED_ORIGINS ?? 'http://127.0.0.1:5174,http://127.0.0.1:5175,http://localhost:5174,http://localhost:5175').split(',').map(s => s.trim());
const server = createRegistryServer({ store, network: network as PilotNetwork, origin, allowedOrigins, rateLimiter: await rateLimiterFromEnvironment() });
server.listen(port, process.env.PILOT_REGISTRY_HOST ?? '127.0.0.1', () => console.log(`Pilot username registry: ${origin} (${url ? 'PostgreSQL' : 'repo-local JSON'}, ${network})`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.close(() => void store.close().finally(() => process.exit(0))); });
