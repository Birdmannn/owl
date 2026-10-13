import { ccc } from '@ckb-ccc/core';
import { authorizeCounter, type Deployment, type SessionCell, type CounterTransactionEvent } from './ckb/counter.js';
export const COUNTER_V1_CODE_HASH: ccc.Hex = '0x1d3dc6f80f4df37c708ffbbcb47c7e6dc3bc278321f0b47a45ca22196ae7d483';
/** This version exposes only the transition enforced by the deployed counter lock. */
export interface PilotManifest {
  version: 1;
  app: { id: string; name: string; description: string };
  permissions: { id: 'counter.increment'; name: string; description: string }[];
  policy: { kind: 'counter-v1'; deployment: Deployment; feePerMove: string; budget: string; floorCapacity: string };
}
export interface PilotGrant { version: 1; manifestHash: ccc.Hex; permissions: string[] }
function validateManifest(manifest: PilotManifest) {
  if (manifest.version !== 1 || manifest.policy.kind !== 'counter-v1' || !manifest.app.id
    || manifest.permissions.length !== 1 || manifest.permissions[0]?.id !== 'counter.increment') {
    throw new Error('This Pilot connector supports only the on-chain counter.increment policy');
  }
  if(manifest.policy.deployment.codeHash!==COUNTER_V1_CODE_HASH)throw new Error('Unrecognized counter-v1 script. This manifest cannot request automatic signing.');
  const { budget, feePerMove, floorCapacity } = manifest.policy;
  if (BigInt(feePerMove) <= 0n || BigInt(budget) < BigInt(feePerMove) || BigInt(floorCapacity) < ccc.fixedPointFrom(138)) {
    throw new Error('Invalid counter session limits');
  }
}
export function counterManifestHash(manifest: PilotManifest): ccc.Hex {
  validateManifest(manifest);
  // Fixed field order: equivalent JSON property ordering produces the same commitment.
  const p=manifest.policy, d=p.deployment;
  return ccc.hashCkb(ccc.bytesFrom(JSON.stringify([manifest.version, manifest.app.id, manifest.app.name, manifest.app.description,
    manifest.permissions.map(permission=>[permission.id,permission.name,permission.description]),
    p.kind,d.network,d.genesisHash,d.codeHash,d.outPoint.txHash,d.outPoint.index,p.feePerMove,p.budget,p.floorCapacity]), 'utf8'));
}
export function createCounterGrant(manifest: PilotManifest, selected: readonly string[]): PilotGrant {
  const manifestHash=counterManifestHash(manifest);
  if (selected.length !== 1 || selected[0] !== 'counter.increment') throw new Error('Select Fly forward before authorizing automatic signing');
  return { version:1,manifestHash,permissions:[...selected] };
}
export function assertCounterPermission(manifest: PilotManifest, grant: PilotGrant, permission: string): void {
  if (grant.version !== 1 || grant.manifestHash !== counterManifestHash(manifest)
    || grant.permissions.length !== 1 || grant.permissions[0] !== 'counter.increment'
    || permission !== 'counter.increment') throw new Error('This action is outside the approved Pilot permissions. Fresh approval is required.');
}
/** A Pilot-branded connector backed by an existing CCC owner wallet. No owner keys are imported. */
export class PilotCounterConnector {
  readonly name = 'Pilot';
  private readonly manifest: PilotManifest;
  constructor(private readonly owner: ccc.Signer, manifest: PilotManifest) {
    validateManifest(manifest); this.manifest=structuredClone(manifest);
  }
  async getAccount() {
    const [address,balance]=await Promise.all([this.owner.getRecommendedAddress(),this.owner.getBalance()]);
    return {address,balance};
  }
  async authorize(selected: readonly string[], options: {
    sessionPublicKey: ccc.HexLike;
    onSubmitted?: (cell: SessionCell) => Promise<void>;
    onTransaction?: (event: CounterTransactionEvent) => void;
  }): Promise<{ cell: SessionCell; grant: PilotGrant }> {
    const grant=createCounterGrant(this.manifest,selected),p=this.manifest.policy;
    const cell=await authorizeCounter(this.owner,{...options,deployment:p.deployment,budget:BigInt(p.budget),feePerMove:BigInt(p.feePerMove),floorCapacity:BigInt(p.floorCapacity)});
    return {cell,grant};
  }
}
