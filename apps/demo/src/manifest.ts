import { SPONSORED_COUNTER_CODE_HASH, type Deployment, type PilotManifest } from '@owl/pilot';
import manifest from '../../../deployments/testnet.json';
import sponsored from '../../../deployments/pilot-sponsored.json';
export const sponsorshipRequested = !!import.meta.env.VITE_PILOT_PAYMASTER_URL;
const configuredPool = (sponsored as unknown as { poolLock?: PilotManifest['policy']['poolLock'] }).poolLock;
const sponsoredDeployment = sponsored.counter as Deployment | null;
export const sponsorshipReady = sponsorshipRequested && !!sponsoredDeployment && !!configuredPool;
if (sponsoredDeployment && sponsoredDeployment.codeHash !== SPONSORED_COUNTER_CODE_HASH) throw new Error('Sponsored deployment hash mismatch');
export const flightManifest: PilotManifest = {
  version:1,
  app:{id:'owl.flight.demo',name:'Owl Flight',description:'A small on-chain flight. Every forward move advances the counter by one.'},
  permissions:[{id:'counter.increment',name:'Fly forward',description:'Move your owl forward by exactly one step. Pilot may sign this action automatically.'}],
  policy:{poolLock:sponsorshipReady ? configuredPool : undefined,kind:sponsorshipReady ? 'counter-sponsored-v1' : 'counter-v1',deployment:sponsorshipReady ? sponsoredDeployment! : manifest.deployment as PilotManifest['policy']['deployment'],feePerMove:'100000',budget:'2000000',floorCapacity:sponsorshipReady ? '20000000000' : '15000000000'},
};
