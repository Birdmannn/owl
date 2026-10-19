/** Exact browser origins only; HTTP is restricted to local development. */
export function pilotOrigin(value: string | undefined): string {
  if (!value) throw new Error('Configure PILOT_APP_ORIGINS with exact app origins');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Invalid Pilot origin'); }
  if (url.hostname.includes('*') || url.origin !== value || !(url.protocol === 'https:' ||
    (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new Error('Pilot origins must be exact HTTPS origins (HTTP allowed on localhost)');
  }
  return value;
}
export function pilotOrigins(value: string): string[] {
  return [...new Set(value.split(',').map(item => pilotOrigin(item.trim())))];
}
export function appOrigins(environment: NodeJS.ProcessEnv = process.env, localFallback?: string): string[] {
  const value = environment.PILOT_APP_ORIGINS ?? environment.PILOT_APP_ORIGIN ?? localFallback;
  if (value === undefined) throw new Error('Configure PILOT_APP_ORIGINS with exact app origins');
  return pilotOrigins(value);
}
/** Explicit service overrides replace the common app allowlist. */
export function allowedAppOrigins(service: 'REGISTRY' | 'PAYMASTER', environment: NodeJS.ProcessEnv = process.env, localFallback?: string) {
  const override = environment[`PILOT_${service}_ALLOWED_ORIGINS`];
  return override === undefined ? appOrigins(environment, localFallback) : pilotOrigins(override);
}
/** Social is a specific demo app: multiple browser origins must not share a signed audience. */
export function socialAudience(environment: NodeJS.ProcessEnv = process.env) {
  if (environment.PILOT_SOCIAL_AUDIENCE !== undefined) return pilotOrigin(environment.PILOT_SOCIAL_AUDIENCE);
  const apps = appOrigins(environment);
  if (apps.length !== 1) throw new Error('Set PILOT_SOCIAL_AUDIENCE explicitly when allowing multiple apps');
  return apps[0]!;
}
