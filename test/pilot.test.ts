import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore, Pilot, PermanentSettlementError } from '../src/index.js';
import type { Adapter, Journal, Session } from '../src/index.js';

type State = { position: number };
type Action = { steps: number };
const session: Session = { id: 'session-1', network: 'ckb-testnet', policyVersion: 'game-v1', expiresAt: 1000 };
const candidate = (id = 'move') => ({ id, action: { steps: 1 } });
function adapter(settle: Adapter<State, Action>['settle'] = async ({ id }) => ({ transactionHash: id })): Adapter<State, Action> {
  return {
    async validate(action) { return { allowed: action.steps === 1, cost: 3n }; },
    apply(state, action) { return { position: state.position + action.steps }; },
    settle,
  };
}
async function create(overrides: Partial<Parameters<typeof Pilot.create<State, Action>>[0]> = {}) {
  return Pilot.create({ session, state: { position: 0 }, budget: 6n, adapter: adapter(),
    store: new MemoryStore<State, Action>(), autoSettle: false, now: () => 0, ...overrides });
}

test('acceptance is optimistic and rapid clicks cannot spend the same reservation', async () => {
  const pilot = await create();
  await pilot.prepare([candidate('left'), candidate('right')]);
  const results = await Promise.allSettled([pilot.execute('left'), pilot.execute('right')]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.deepEqual(pilot.state, { position: 1 });
  assert.deepEqual(pilot.confirmedState, { position: 0 });
  assert.equal(pilot.availableBudget, 3n);
  assert.equal(pilot.readiness('right').ready, false);
  await pilot.prepare([candidate()]);
  await pilot.execute('move');
  await pilot.prepare([candidate()]);
  assert.equal(pilot.readiness('move').ready, false);
  assert.equal(pilot.availableBudget, 0n);
});

test('confirmed owner reconciliation is durable, invalidates readiness, and cannot overwrite queued work or increase budget', async () => {
  const store = new MemoryStore<State, Action>();
  const pilot = await create({ store });
  await pilot.prepare([candidate()]);
  await pilot.reconcileConfirmed({ position: 4 }, 6n);
  assert.equal(pilot.readiness('move').ready, false);
  assert.deepEqual((await create({ store })).confirmedState, { position: 4 });
  await assert.rejects(pilot.reconcileConfirmed({ position: 9 }, 7n), /cannot increase/);
  await pilot.prepare([candidate()]); await pilot.execute('move');
  await assert.rejects(pilot.reconcileConfirmed({ position: 9 }, 3n), /queued settlement/);
  assert.deepEqual(pilot.state, { position: 5 });
  await pilot.flush(); await pilot.reconcileConfirmed({ position: 7 }, 3n);
  assert.deepEqual((await create({ store })).state, { position: 7 });
});

test('unknown failure retains actions; restart retries the same settlement ID', async () => {
  const store = new MemoryStore<State, Action>();
  const ids: string[] = [];
  const pilot = await create({ store, adapter: adapter(async ({ id }) => { ids.push(id); throw new Error('Connection lost'); }) });
  await pilot.prepare([candidate()]);
  const id = await pilot.execute('move');
  await pilot.flush();
  assert.equal(pilot.queueLength, 1);
  const restored = await create({ store, adapter: adapter(async ({ id }) => { ids.push(id); return { transactionHash: '0xtx' }; }) });
  assert.deepEqual(restored.state, { position: 1 });
  await restored.flush();
  assert.deepEqual(ids, [id, id]);
  assert.equal(restored.queueLength, 0);
  assert.deepEqual(restored.confirmedState, { position: 1 });
  assert.equal(restored.availableBudget, 3n);
});

test('definitive failure rolls back dependent actions and releases reservations', async () => {
  const pilot = await create({ adapter: adapter(async () => { throw new PermanentSettlementError('Cell conflict'); }) });
  await pilot.prepare([candidate()]);
  await pilot.execute('move');
  await pilot.prepare([candidate()]);
  await pilot.execute('move');
  assert.deepEqual(pilot.state, { position: 2 });
  await pilot.flush();
  assert.deepEqual(pilot.state, { position: 0 });
  assert.equal(pilot.availableBudget, 6n);
  assert.equal(pilot.queueLength, 0);
});

test('failed durable acceptance never exposes an optimistic action', async () => {
  let writes = 0;
  const pilot = await create({ store: {
    async load() { return undefined; },
    async save() { if (++writes > 1) throw new Error('Storage full'); },
  } });
  await pilot.prepare([candidate()]);
  await assert.rejects(pilot.execute('move'), /Storage full/);
  assert.deepEqual(pilot.state, { position: 0 });
  assert.equal(pilot.availableBudget, 6n);
});

test('slow preflight cannot overwrite newer state readiness', async () => {
  let release!: () => void;
  let wait = false;
  const base = adapter();
  const pilot = await create({ adapter: { ...base, async validate(action, context) {
    if (wait) await new Promise<void>(resolve => { release = resolve; });
    return base.validate(action, context);
  } } });
  await pilot.prepare([candidate()]);
  wait = true;
  const preparation = pilot.prepare([candidate('future')]);
  await pilot.execute('move');
  release();
  await preparation;
  assert.equal(pilot.readiness('future').ready, false);
});

test('session expiration invalidates preflight at click time', async () => {
  let now = 0;
  const pilot = await create({ now: () => now });
  await pilot.prepare([candidate()]);
  now = 1000;
  await assert.rejects(pilot.execute('move'), /not ready/);
});

test('journal failure after chain confirmation retains retry identity without rollback', async () => {
  let saved: Journal<State, Action> | undefined;
  let fail = false;
  const ids: string[] = [];
  const pilot = await create({
    store: { async load() { return saved; }, async save(value) {
      if (fail) throw new Error('Disk unavailable');
      saved = structuredClone(value);
    } },
    adapter: adapter(async ({ id }) => { ids.push(id); return { transactionHash: '0xtx' }; }),
  });
  await pilot.prepare([candidate()]);
  const id = await pilot.execute('move');
  fail = true;
  await assert.rejects(pilot.flush(), /Disk unavailable/);
  assert.equal(pilot.queueLength, 1);
  assert.deepEqual(pilot.state, { position: 1 });
  fail = false;
  await pilot.flush();
  assert.deepEqual(ids, [id, id]);
  assert.equal(pilot.queueLength, 0);
});

test('background worker settles later actions in order while UI stays optimistic', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ids: string[] = [];
  const pilot = await create({ autoSettle: true, adapter: adapter(async ({ id }) => {
    ids.push(id);
    if (ids.length === 1) await gate;
    return { transactionHash: id };
  }) });
  await pilot.prepare([candidate()]);
  const first = await pilot.execute('move');
  await pilot.prepare([candidate()]);
  const second = await pilot.execute('move');
  assert.deepEqual(pilot.state, { position: 2 });
  assert.deepEqual(pilot.confirmedState, { position: 0 });
  release();
  await pilot.flush();
  assert.deepEqual(ids, [first, second]);
  assert.deepEqual(pilot.confirmedState, { position: 2 });
  assert.equal(pilot.availableBudget, 0n);
});
