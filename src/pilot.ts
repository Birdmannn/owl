import { PermanentSettlementError } from './types.js';
import { MAX_ACTION_CATALOG, MAX_PREPARED_CANDIDATES } from './limits.js';
import type { Adapter, Candidate, Journal, PilotEvent, Readiness, Session, Store } from './types.js';

export interface PilotOptions<State, Action> {
  session: Session;
  state: State;
  budget: bigint;
  adapter: Adapter<State, Action>;
  store: Store<State, Action>;
  lookahead?: number;
  autoSettle?: boolean;
  now?: () => number;
  onEvent?: (event: PilotEvent) => void;
}

/** Optimistic execution engine. It does not itself authorize a CKB session. */
export class Pilot<State, Action> {
  private ready = new Map<string, { action: Action; result: Readiness }>();
  private mutex: Promise<unknown> = Promise.resolve();
  private worker: Promise<void> | undefined;
  private readonly now: () => number;
  private readonly limit: number;

  private constructor(private options: PilotOptions<State, Action>, private journal: Journal<State, Action>) {
    this.now = options.now ?? Date.now;
    this.limit = options.lookahead ?? MAX_PREPARED_CANDIDATES;
  }

  static async create<State, Action>(options: PilotOptions<State, Action>): Promise<Pilot<State, Action>> {
    if (options.budget < 0n) throw new Error('Budget cannot be negative');
    const limit = options.lookahead ?? MAX_PREPARED_CANDIDATES;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PREPARED_CANDIDATES) throw new Error(`Lookahead must be between 1 and ${MAX_PREPARED_CANDIDATES}`);
    const saved = await options.store.load();
    if (saved && (saved.version !== 1 || JSON.stringify(saved.session) !== JSON.stringify(options.session))) {
      throw new Error('Stored journal belongs to a different session');
    }
    const journal: Journal<State, Action> = saved ?? {
      version: 1, session: structuredClone(options.session),
      confirmedState: structuredClone(options.state), projectedState: structuredClone(options.state),
      remainingBudget: options.budget.toString(), revision: 0, queue: [],
    };
    const reserved = journal.queue.reduce((sum, entry) => sum + BigInt(entry.cost), 0n);
    if (journal.queue.some(entry => BigInt(entry.cost) < 0n) || BigInt(journal.remainingBudget) < reserved) {
      throw new Error('Invalid stored budget');
    }
    if (!saved) await options.store.save(structuredClone(journal));
    const pilot = new Pilot(options, journal);
    pilot.kick();
    return pilot;
  }

  get state(): State { return structuredClone(this.journal.projectedState); }
  get confirmedState(): State { return structuredClone(this.journal.confirmedState); }
  get queueLength(): number { return this.journal.queue.length; }
  get availableBudget(): bigint {
    return BigInt(this.journal.remainingBudget) - this.journal.queue.reduce((sum, entry) => sum + BigInt(entry.cost), 0n);
  }

  /** Host must first verify a confirmed owner action. Never replace unresolved optimistic work. */
  reconcileConfirmed(state: State, remainingBudget: bigint): Promise<void> {
    return this.exclusive(async () => {
      if (this.journal.queue.length) throw new Error('Resolve queued settlement before reconciling owner state');
      if (remainingBudget < 0n || remainingBudget > BigInt(this.journal.remainingBudget)) throw new Error('Owner reconciliation cannot increase this session allowance');
      const next = { ...structuredClone(this.journal), confirmedState: structuredClone(state), projectedState: structuredClone(state),
        remainingBudget: remainingBudget.toString(), revision: this.journal.revision + 1 };
      await this.options.store.save(next);
      this.journal = next; this.ready.clear();
    });
  }

  readiness(id: string): Readiness {
    const cached = this.ready.get(id)?.result;
    if (!cached || cached.revision !== this.journal.revision) {
      return { ready: false, revision: this.journal.revision, cost: 0n, reason: 'Not prepared for current state' };
    }
    if (this.now() >= this.journal.session.expiresAt) return { ...cached, ready: false, reason: 'Session expired' };
    return { ...cached };
  }

  /** Supply up to 50 choices; explicitly select up to lookahead to prevalidate. */
  async prepare(candidates: Candidate<Action>[], selectedIds?: readonly string[]): Promise<void> {
    if (candidates.length > MAX_ACTION_CATALOG) throw new Error(`At most ${MAX_ACTION_CATALOG} candidates can be offered`);
    if (new Set(candidates.map(candidate => candidate.id)).size !== candidates.length) throw new Error('Duplicate candidate ID');
    const selected = selectedIds ?? candidates.map(candidate => candidate.id);
    if (selected.length > this.limit) throw new Error(`At most ${this.limit} candidates can be prepared; select a subset of the offered candidates`);
    if (new Set(selected).size !== selected.length) throw new Error('Duplicate selected candidate ID');
    const catalog = new Map(candidates.map(candidate => [candidate.id, candidate]));
    const prepared = selected.map(id => {
      const candidate = catalog.get(id);
      if (!candidate) throw new Error('Unknown selected candidate ID');
      return candidate;
    });
    const revision = this.journal.revision;
    const context = { state: this.state, session: structuredClone(this.journal.session), availableBudget: this.availableBudget };
    const results = await Promise.all(prepared.map(async candidate => {
      const action = structuredClone(candidate.action);
      const validation = await this.options.adapter.validate(structuredClone(action), structuredClone(context));
      if (validation.cost < 0n) throw new Error('Validation cost cannot be negative');
      const active = this.now() < context.session.expiresAt;
      const affordable = validation.cost <= context.availableBudget;
      const result: Readiness = {
        ready: active && validation.allowed && affordable, revision, cost: validation.cost,
        ...(!active ? { reason: 'Session expired' } : !affordable ? { reason: 'Insufficient budget' }
          : !validation.allowed ? { reason: validation.reason ?? 'Policy rejected action' } : {}),
      };
      return [candidate.id, { action, result }] as const;
    }));
    await this.exclusive(async () => {
      if (revision !== this.journal.revision) return;
      this.ready = new Map(results);
    });
  }

  /** Persist and reserve first, then expose the optimistic state. No wallet round trip. */
  async execute(candidateId: string): Promise<string> {
    const id = await this.exclusive(async () => {
      const candidate = this.ready.get(candidateId);
      if (!candidate || !this.readiness(candidateId).ready) throw new Error('Move is not ready');
      const next = structuredClone(this.journal);
      const id = globalThis.crypto.randomUUID();
      next.projectedState = this.options.adapter.apply(structuredClone(next.projectedState), structuredClone(candidate.action));
      next.queue.push({ id, action: structuredClone(candidate.action), cost: candidate.result.cost.toString() });
      next.revision++;
      await this.commit(next);
      this.emit({ type: 'accepted', id });
      return id;
    });
    this.kick();
    return id;
  }

  /** Invalidate preflight results when external chain/session information changes. */
  invalidate(): Promise<void> {
    return this.exclusive(async () => {
      const next = structuredClone(this.journal);
      next.revision++;
      await this.commit(next);
    });
  }

  /** Resume background settlement after reconnecting. Unknown failures retain the queue. */
  async flush(): Promise<void> {
    if (this.worker) return this.worker;
    const worker = this.drain();
    this.worker = worker;
    try { await worker; } finally { this.worker = undefined; }
  }

  private async drain(): Promise<void> {
    while (this.journal.queue.length) {
      const entry = structuredClone(this.journal.queue[0]!);
      let receipt: { transactionHash: string };
      try {
        receipt = await this.options.adapter.settle({
          id: entry.id, action: entry.action, session: structuredClone(this.journal.session), reservedCost: BigInt(entry.cost),
        });
      } catch (error) {
        if (!(error instanceof PermanentSettlementError)) {
          this.emit({ type: 'retry', id: entry.id, error });
          return;
        }
        await this.exclusive(async () => {
          const next = structuredClone(this.journal);
          const ids = next.queue.map(item => item.id);
          next.queue = [];
          next.projectedState = structuredClone(next.confirmedState);
          next.revision++;
          await this.commit(next);
          this.emit({ type: 'reverted', ids, error });
        });
        return;
      }
      // A journal write failure after confirmation must not be treated as chain rejection.
      await this.exclusive(async () => {
        const next = structuredClone(this.journal);
        next.confirmedState = this.options.adapter.apply(structuredClone(next.confirmedState), structuredClone(entry.action));
        next.remainingBudget = (BigInt(next.remainingBudget) - BigInt(entry.cost)).toString();
        next.queue.shift();
        next.revision++;
        await this.commit(next);
        this.emit({ type: 'settled', id: entry.id, transactionHash: receipt.transactionHash });
      });
    }
  }

  private async commit(next: Journal<State, Action>) {
    await this.options.store.save(structuredClone(next));
    this.journal = next;
    this.ready.clear();
  }
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutex.then(operation);
    this.mutex = result.catch(() => {});
    return result;
  }
  private emit(event: PilotEvent) {
    // Consumer callbacks cannot change execution or settlement outcomes.
    try { this.options.onEvent?.(event); } catch { /* isolated observer */ }
  }
  private kick() {
    if (this.options.autoSettle !== false) {
      void this.flush().catch(error => {
        const id = this.journal.queue[0]?.id;
        if (id) this.emit({ type: 'retry', id, error });
      });
    }
  }
}
