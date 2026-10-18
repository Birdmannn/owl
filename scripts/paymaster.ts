import { paymasterFromEnvironment } from '../server/paymaster-config.js';
import { createPaymasterServer } from '../server/paymaster.js';
import { rateLimiterFromEnvironment } from '../server/runtime.js';

const paymaster = await paymasterFromEnvironment();
const port = Number(process.env.PILOT_PAYMASTER_PORT ?? '5182');
const allowedOrigins = (process.env.PILOT_PAYMASTER_ALLOWED_ORIGINS ?? 'http://localhost:5174,http://127.0.0.1:5174').split(',').map(s => s.trim()).filter(Boolean);
const server = createPaymasterServer({ paymaster, allowedOrigins, rateLimiter: await rateLimiterFromEnvironment() });
server.listen(port, process.env.PILOT_PAYMASTER_HOST ?? '127.0.0.1', async () => console.log(`Pilot paymaster listening on ${port}; pool ${await paymaster.options.signer.getRecommendedAddress()}; network testnet`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
