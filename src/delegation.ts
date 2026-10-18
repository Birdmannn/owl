import { SPONSORED_DELEGATION_CODE_HASH } from './ckb/sponsored-code.js';
import { ccc } from '@ckb-ccc/core';
import type { Context, Validation } from './types.js';
import type { Deployment } from './ckb/counter.js';
import { DELEGATION_V1_CODE_HASH } from './ckb/delegation-code.js';

export interface PilotTransition {
  kind: 'u64-increment' | 'u64-decrement';
  offset: number;
  delta: string;
}
export interface PilotActionManifest {
  id: string;
  name: string;
  description: string;
  /** Informational operation name; the transition below supplies actual on-chain restrictions. */
  operation: string;
  /** Owner-only actions remain available to the app but cannot enter a delegated grant. */
  delegation?: 'allowed' | 'owner-only';
  transition: PilotTransition;
}
export interface PilotAppManifest {
  version: 2;
  app: { id: string; name: string; description: string };
  network: 'ckb-testnet' | 'ckb-devnet';
  /** Optional app type script. Its complete identity, not only its code hash, is committed. */
  script?: { role: 'type'; codeHash: ccc.Hex; hashType: ccc.HashType; args: ccc.Hex; cellDep: ccc.CellDepLike };
  actions: PilotActionManifest[];
  cellSelection?: { dataPrefix?: ccc.Hex; dataLength?: number };
  policy: {
    kind: 'delegation-v1' | 'delegation-sponsored-v1';
    poolLock?: ccc.ScriptLike;
    deployment: Deployment;
    feePerAction: string;
    budget: string;
    floorCapacity: string;
    maxSetupFee: string;
    maxRecoveryFee: string;
  };
}
export interface PilotDelegationGrant {
  version: 2;
  manifestHash: ccc.Hex;
  permissions: string[];
}
export interface PilotActionRequest<Params = unknown> { id: string; params: Params }
export interface PilotBuildContext {
  client: ccc.Client;
  cell: ccc.Cell;
  fee: bigint;
  defaultTransaction: ccc.Transaction;
}
export interface PilotActionBuilder<State, Params = unknown> {
  validate(params: Params, context: Context<State>): Promise<Validation>;
  apply(state: State, params: Params): State;
  buildTransaction(params: Params, context: PilotBuildContext): Promise<ccc.TransactionLike>;
}
export interface PilotAppDefinition<State, Params = unknown> {
  manifest: PilotAppManifest;
  actions: Record<string, PilotActionBuilder<State, Params>>;
  encodeState(state: State): ccc.Hex;
  decodeState(data: ccc.Hex): State;
  /** Optional app-specific migration/construction hook. Pilot independently verifies the result. */
  buildAuthorization?: (context: { owner: ccc.Signer; source?: ccc.Cell; defaultTransaction: ccc.Transaction }) => Promise<ccc.TransactionLike>;
}

export function pilotCanonical(value: unknown): string {
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(pilotCanonical).join(',') + ']';
  const entries = Object.entries(value as Record<string, unknown>).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b));
  return '{' + entries.map(([key, value]) => JSON.stringify(key) + ':' + pilotCanonical(value)).join(',') + '}';
}
export function delegationAmount(value: string, name: string): bigint {
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new Error(`${name} must be integer shannons or an unsigned integer`);
  const amount = BigInt(value);
  if (amount > (1n << 64n) - 1n) throw new Error(`${name} exceeds u64`);
  return amount;
}
export function actionHash(id: string): ccc.Hex { return ccc.hashCkb(ccc.bytesFrom(id, 'utf8')); }
export function validatePilotAppManifest(manifest: PilotAppManifest): void {
  if (manifest.version !== 2 || !['delegation-v1', 'delegation-sponsored-v1'].includes(manifest.policy.kind) || !manifest.app.id || !manifest.app.name) throw new Error('Invalid Pilot app manifest');
  if (manifest.policy.deployment.codeHash !== (manifest.policy.kind === 'delegation-sponsored-v1' ? SPONSORED_DELEGATION_CODE_HASH : DELEGATION_V1_CODE_HASH)) throw new Error('Unrecognized delegation-v1 binary');
  if ((manifest.policy.kind === 'delegation-sponsored-v1') !== !!manifest.policy.poolLock) throw new Error('Sponsored delegation must pin pool lock');
  if (manifest.network !== `ckb-${manifest.policy.deployment.network}`) throw new Error('Manifest network mismatch');
  ccc.OutPoint.from(manifest.policy.deployment.outPoint);
  if (ccc.bytesFrom(manifest.policy.deployment.genesisHash).length !== 32) throw new Error('Invalid genesis hash');
  if (!manifest.actions.length || manifest.actions.length > 16) throw new Error('Declare between 1 and 16 actions');
  const ids = new Set<string>();
  for (const action of manifest.actions) {
    if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(action.id) || !action.name || !action.description || !action.operation || ids.has(action.id)) throw new Error('Invalid or duplicate action');
    ids.add(action.id);
    if (action.delegation && !['allowed', 'owner-only'].includes(action.delegation)) throw new Error('Invalid action delegation mode');
    if (!['u64-increment', 'u64-decrement'].includes(action.transition.kind) || !Number.isInteger(action.transition.offset)
      || action.transition.offset < 0 || action.transition.offset > 0xffffffff || delegationAmount(action.transition.delta, 'delta') === 0n) throw new Error('Unsupported transition rule');
  }
  if (manifest.cellSelection?.dataPrefix) ccc.bytesFrom(manifest.cellSelection.dataPrefix);
  if (manifest.cellSelection?.dataLength !== undefined && (!Number.isSafeInteger(manifest.cellSelection.dataLength) || manifest.cellSelection.dataLength < 8)) throw new Error('Invalid selected data length');
  const policy = manifest.policy;
  const fee = delegationAmount(policy.feePerAction, 'feePerAction');
  if (fee === 0n || delegationAmount(policy.budget, 'budget') < fee || delegationAmount(policy.floorCapacity, 'floorCapacity') === 0n) throw new Error('Invalid delegation funding limits');
  delegationAmount(policy.maxSetupFee, 'maxSetupFee');
  delegationAmount(policy.maxRecoveryFee, 'maxRecoveryFee');
  if (manifest.script) {
    if (manifest.script.role !== 'type') throw new Error('Application script must be a type script');
    ccc.Script.from(manifest.script); ccc.CellDep.from(manifest.script.cellDep);
  }
}
export function pilotManifestHash(manifest: PilotAppManifest): ccc.Hex {
  validatePilotAppManifest(manifest);
  return ccc.hashCkb(ccc.bytesFrom(pilotCanonical(manifest), 'utf8'));
}
export function createPilotGrant(manifest: PilotAppManifest, selected: readonly string[]): PilotDelegationGrant {
  const manifestHash = pilotManifestHash(manifest);
  if (new Set(selected).size !== selected.length || selected.some(id => !manifest.actions.some(action => action.id === id && action.delegation !== 'owner-only'))) throw new Error('Unknown, owner-only, or duplicate selected permission');
  // Empty selection connects the account without funding or delegating anything.
  return { version: 2, manifestHash, permissions: [...selected].sort() };
}
export function assertPilotPermission(manifest: PilotAppManifest, grant: PilotDelegationGrant, id: string): void {
  if (grant.version !== 2 || grant.manifestHash !== pilotManifestHash(manifest) || !grant.permissions.includes(id)
    || new Set(grant.permissions).size !== grant.permissions.length
    || grant.permissions.some(id => !manifest.actions.some(action => action.id === id && action.delegation !== 'owner-only'))) throw new Error('Action is outside the approved Pilot grant; fresh consent is required');
}
export function definePilotApp<State, Params = unknown>(definition: PilotAppDefinition<State, Params>): PilotAppDefinition<State, Params> {
  validatePilotAppManifest(definition.manifest);
  const declared = definition.manifest.actions.map(action => action.id);
  if (Object.keys(definition.actions).length !== declared.length || declared.some(id => !definition.actions[id])) throw new Error('Register exactly one action builder for each manifest action');
  for (const builder of Object.values(definition.actions)) {
    if (typeof builder.validate !== 'function' || typeof builder.apply !== 'function' || typeof builder.buildTransaction !== 'function') throw new Error('Incomplete action builder');
  }
  return { ...definition, manifest: structuredClone(definition.manifest), actions: Object.fromEntries(Object.entries(definition.actions).map(([id, builder]) => [id, { ...builder }])) };
}
export function applyPilotTransition(data: ccc.HexLike, transition: PilotTransition): ccc.Hex {
  const bytes = ccc.bytesFrom(data).slice();
  if (transition.offset + 8 > bytes.length) throw new Error('Transition field is outside app data');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const before = view.getBigUint64(transition.offset, true);
  const delta = delegationAmount(transition.delta, 'delta');
  const after = transition.kind === 'u64-increment' ? before + delta : before - delta;
  if (after < 0n || after > (1n << 64n) - 1n) throw new Error('Transition overflow or underflow');
  view.setBigUint64(transition.offset, after, true);
  return ccc.hexFrom(bytes);
}
