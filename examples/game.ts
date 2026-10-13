import { MemoryStore, Pilot } from '../src/index.js';

// Local demonstration only: this adapter does not submit CKB transactions.
const pilot = await Pilot.create({
  session: { id: 'demo', network: 'simulation', policyVersion: 'move-v1', expiresAt: Date.now() + 60_000 },
  state: { position: 0 }, budget: 10n,
  store: new MemoryStore<{ position: number }, { steps: number }>(),
  autoSettle: false,
  adapter: {
    async validate(action) { return { allowed: action.steps === 1, cost: 1n }; },
    apply(state, action) { return { position: state.position + action.steps }; },
    async settle({ id }) { return { transactionHash: `simulation:${id}` }; },
  },
});
await pilot.prepare([{ id: 'forward', action: { steps: 1 } }]);
console.log('Ready:', pilot.readiness('forward').ready);
await pilot.execute('forward');
console.log('Instant local state:', pilot.state, 'confirmed state:', pilot.confirmedState);
await pilot.flush();
console.log('Settled state:', pilot.confirmedState, 'budget:', pilot.availableBudget);
