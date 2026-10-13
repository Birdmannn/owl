import type { PilotManifest } from '@owl/pilot';
import manifest from '../../../deployments/testnet.json';
export const flightManifest: PilotManifest = {
  version:1,
  app:{id:'owl.flight.demo',name:'Owl Flight',description:'A small on-chain flight. Every forward move advances the counter by one.'},
  permissions:[{id:'counter.increment',name:'Fly forward',description:'Move your owl forward by exactly one step. Pilot may sign this action automatically.'}],
  policy:{kind:'counter-v1',deployment:manifest.deployment as PilotManifest['policy']['deployment'],feePerMove:'100000',budget:'2000000',floorCapacity:'15000000000'},
};
