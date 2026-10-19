import { databaseUrl } from '../server/postgres.js';
import { rateLimiterFromEnvironment } from '../server/runtime.js';
import { resolve } from 'node:path';
import { JsonSocialStore, PostgresSocialStore, createSocialServer } from '../server/offchain-social.js';
import { validateOffchainManifest } from '../src/offchain.js';
import { socialManifest } from '../examples/offchain-social.js';
const port = Number(process.env.PILOT_SOCIAL_PORT ?? 5181);
const audience = process.env.PILOT_SOCIAL_AUDIENCE ?? 'http://127.0.0.1:5174';
validateOffchainManifest(socialManifest(audience));
const url = databaseUrl();
const store = url ? new PostgresSocialStore(url, audience)
  : new JsonSocialStore(resolve(process.env.PILOT_SOCIAL_FILE ?? 'data/pilot-social.json'));
await store.init();
const server = createSocialServer({ store, audience, rateLimiter: await rateLimiterFromEnvironment() });
server.listen(port, process.env.PILOT_SOCIAL_HOST ?? '127.0.0.1', () => console.log(`Pilot Social verifier on port ${port}; audience ${audience}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
