import { counterManifestHash, type PilotManifest } from './connector.js';
import { validatePilotAppManifest, type PilotAppManifest } from './delegation.js';

/** Select a user budget within the app's ceiling before creating its grant. */
export function withPilotBudget<T extends PilotManifest | PilotAppManifest>(manifest: T, budget: string): T {
  if (manifest.version === 1) counterManifestHash(manifest); else validatePilotAppManifest(manifest);
  if (!/^\d+$/.test(budget)) throw new Error('Budget must be integer shannons');
  const value = BigInt(budget);
  const fee = BigInt('feePerAction' in manifest.policy ? manifest.policy.feePerAction : manifest.policy.feePerMove);
  if (value < fee || value > BigInt(manifest.policy.budget) || value > (1n << 64n) - 1n) {
    throw new Error('Choose a budget between one action and the app limit');
  }
  const result = structuredClone(manifest);
  result.policy.budget = value.toString();
  return result;
}
