import { ccc } from '@ckb-ccc/core';
import { SPONSORED_DELEGATION_CODE_HASH, definePilotApp, type Deployment } from '../src/index.js';

/** Two named app actions. Deployment is supplied explicitly; never invent a code-cell outpoint. */
export function createDelegationExample(deployment: Deployment, poolLock?: ccc.ScriptLike) {
  const fee = 100_000n;
  return definePilotApp<{ position: number }, undefined>({
    manifest: {
      version: 2,
      app: { id: 'owl.delegation.example', name: 'Cell Delegation', description: 'Move forward or backward with individually selected permissions.' },
      network: `ckb-${deployment.network}`,
      actions: [
        { id: 'game.forward', name: 'Move forward', description: 'Increase position by one.', operation: 'forward', transition: { kind: 'u64-increment', offset: 0, delta: '1' } },
        { id: 'game.backward', name: 'Move backward', description: 'Decrease position by one.', operation: 'backward', transition: { kind: 'u64-decrement', offset: 0, delta: '1' } },
        { id: 'game.jump', name: 'Jump two steps', description: 'Owner approval is required for this action.', operation: 'jump', delegation: 'owner-only', transition: { kind: 'u64-increment', offset: 0, delta: '2' } },
      ],
      cellSelection: { dataLength: 8 },
      policy: { kind: deployment.codeHash === SPONSORED_DELEGATION_CODE_HASH ? 'delegation-sponsored-v1' : 'delegation-v1', poolLock, deployment, feePerAction: fee.toString(), budget: (fee * 20n).toString(),
        floorCapacity: ccc.fixedPointFrom(350).toString(), maxSetupFee: '1000000', maxRecoveryFee: '1000000' },
    },
    encodeState(state) {
      if (!Number.isSafeInteger(state.position) || state.position < 0) throw new Error('Position must be a nonnegative safe integer');
      const bytes = new Uint8Array(8); new DataView(bytes.buffer).setBigUint64(0, BigInt(state.position), true);
      return ccc.hexFrom(bytes);
    },
    decodeState(data) {
      const bytes = ccc.bytesFrom(data);
      if (bytes.length !== 8) throw new Error('Expected one u64 field');
      const value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(0, true);
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Position exceeds display range');
      return { position: Number(value) };
    },
    actions: {
      'game.forward': {
        async validate(_params, { state }) { return { allowed: Number.isSafeInteger(state.position + 1), cost: fee }; },
        apply(state) { return { position: state.position + 1 }; },
        async buildTransaction(_params, { defaultTransaction }) { return defaultTransaction; },
      },
      'game.backward': {
        async validate(_params, { state }) { return { allowed: state.position > 0, cost: fee, reason: 'Position must stay nonnegative' }; },
        apply(state) { return { position: state.position - 1 }; },
        async buildTransaction(_params, { defaultTransaction }) { return defaultTransaction; },
      },
      'game.jump': {
        async validate(_params, { state }) { return { allowed: Number.isSafeInteger(state.position + 2), cost: fee }; },
        apply(state) { return { position: state.position + 2 }; },
        async buildTransaction(_params, { defaultTransaction }) { return defaultTransaction; },
      },
    },
  });
}
