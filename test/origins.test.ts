import { createRegistryHandler } from '../server/registry.js';
import type { RegistryStore } from '../server/registry-store.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { appOrigins, allowedAppOrigins, pilotOrigins, socialAudience } from '../server/origins.js';
import { createPaymasterHandler, type PilotPaymaster } from '../server/paymaster.js';

test('multiple app origins share defaults, retain legacy config, and use explicit service overrides', () => {
  const environment = { PILOT_APP_ORIGINS: 'https://demo.example, https://other.example,https://demo.example', PILOT_APP_ORIGIN: 'https://legacy.example' };
  assert.deepEqual(appOrigins(environment), ['https://demo.example', 'https://other.example']);
  assert.deepEqual(allowedAppOrigins('REGISTRY', environment), appOrigins(environment));
  assert.deepEqual(allowedAppOrigins('PAYMASTER', environment), appOrigins(environment));
  assert.deepEqual(allowedAppOrigins('PAYMASTER', { ...environment, PILOT_PAYMASTER_ALLOWED_ORIGINS: 'https://restricted.example' }), ['https://restricted.example']);
  assert.deepEqual(appOrigins({ PILOT_APP_ORIGIN: 'https://legacy.example' }), ['https://legacy.example']);
  assert.deepEqual(appOrigins({}, 'http://localhost:5174'), ['http://localhost:5174']);
  for (const value of ['', 'https://demo.example,', '*', 'https://*.example', 'https://demo.example/', 'https://demo.example/path', 'http://public.example', 'https://user:password@demo.example']) {
    // URL accepts a literal wildcard hostname; forbid wildcard allowlists explicitly.
    assert.throws(() => pilotOrigins(value), /origin/i);
  }
  assert.throws(() => appOrigins({ PILOT_APP_ORIGINS: '', PILOT_APP_ORIGIN: 'https://legacy.example' }), /origin/i);
});

test('social audience remains explicit with multiple apps and retains its single-app fallback', () => {
  const environment = { PILOT_APP_ORIGINS: 'https://demo.example,https://other.example' };
  assert.throws(() => socialAudience(environment), /PILOT_SOCIAL_AUDIENCE/);
  assert.equal(socialAudience({ ...environment, PILOT_SOCIAL_AUDIENCE: 'https://demo.example' }), 'https://demo.example');
  assert.equal(socialAudience({ PILOT_APP_ORIGIN: 'https://legacy.example' }), 'https://legacy.example');
});

test('paymaster allows both configured browsers and their preflights, rejecting an unlisted app', async t => {
  const handler = createPaymasterHandler({
    paymaster: { async status() { return { sponsorship: 'configured' }; } } as PilotPaymaster,
    allowedOrigins: allowedAppOrigins('PAYMASTER', { PILOT_APP_ORIGINS: 'https://demo.example,https://other.example' }),
  });
  const server = createServer(handler); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/paymaster/status`;
  for (const origin of ['https://demo.example', 'https://other.example']) {
    const response = await fetch(url, { headers: { Origin: origin } });
    assert.equal(response.status, 200); assert.equal(response.headers.get('access-control-allow-origin'), origin);
    const preflight = await fetch(url, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' } });
    assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
  }
  assert.equal((await fetch(url, { headers: { Origin: 'https://unknown.example' } })).status, 403);
});

test('shared registry responds to both app origins without changing its canonical signing domain', async t => {
  const server = createServer(createRegistryHandler({ store: {} as RegistryStore, network: 'ckb-testnet',
    origin: 'https://api.example', allowedOrigins: allowedAppOrigins('REGISTRY', { PILOT_APP_ORIGINS: 'https://demo.example,https://other.example' }) }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/pilot/health`;
  for (const origin of ['https://demo.example', 'https://other.example']) {
    const response = await fetch(url, { headers: { Origin: origin } });
    assert.equal(response.status, 200); assert.equal(response.headers.get('access-control-allow-origin'), origin);
  }
  assert.equal((await fetch(url, { headers: { Origin: 'https://unknown.example' } })).status, 403);
});
