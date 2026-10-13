import { ccc } from '@ckb-ccc/core';
import { PilotUsernameClient, type PilotUsername } from '@owl/pilot';
export type PilotProfile = PilotUsername;
export const usernameRegistry = new PilotUsernameClient(import.meta.env.VITE_PILOT_REGISTRY_URL || '/api/pilot');
// In-memory display cache only. The shared registry is the source of truth.
const profiles = new Map<string, PilotProfile>();
export function readProfile(address: string): PilotProfile | undefined { return profiles.get(address); }
export async function loadProfile(address: string): Promise<PilotProfile | undefined> {
  const profile = await usernameRegistry.findByAddress(address);
  if (profile) profiles.set(address, profile); else profiles.delete(address);
  return profile;
}
export async function saveProfile(signer: ccc.Signer, username: string): Promise<PilotProfile> {
  const address = await signer.getRecommendedAddress();
  const existing = await loadProfile(address);
  if (existing) {
    if (existing.username !== username.trim().replace(/^@/, '').toLowerCase()) throw new Error('This wallet already has a Pilot username. Renaming is not supported.');
    return existing;
  }
  const profile = await usernameRegistry.register(signer, username);
  profiles.set(address, profile); return profile;
}
