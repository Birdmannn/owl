/** State and actions must be JSON-serializable; costs use integer shannons. */
export interface Session {
  id: string;
  network: string;
  policyVersion: string;
  expiresAt: number;
}

export interface Validation {
  allowed: boolean;
  cost: bigint;
  reason?: string;
}

export interface Context<State> {
  state: State;
  session: Session;
  availableBudget: bigint;
}

/** The production adapter must enforce session policy on-chain. */
export interface Adapter<State, Action> {
  validate(action: Action, context: Context<State>): Promise<Validation>;
  apply(state: State, action: Action): State;
  /** Resolve only after chain confirmation. Retries reuse id as an idempotency key.
   * Never spend beyond reservedCost; request fresh approval if costs rise.
   */
  settle(request: {
    id: string;
    action: Action;
    session: Session;
    reservedCost: bigint;
  }): Promise<{ transactionHash: string }>;
}

export interface QueueEntry<Action> {
  id: string;
  action: Action;
  cost: string;
}

export interface Journal<State, Action> {
  version: 1;
  session: Session;
  confirmedState: State;
  projectedState: State;
  remainingBudget: string;
  revision: number;
  queue: QueueEntry<Action>[];
}

export interface Store<State, Action> {
  load(): Promise<Journal<State, Action> | undefined>;
  /** Atomically replace the journal; rejection must leave the old journal intact. */
  save(journal: Journal<State, Action>): Promise<void>;
}

export interface Candidate<Action> { id: string; action: Action }
export interface Readiness {
  ready: boolean;
  revision: number;
  cost: bigint;
  reason?: string;
}
export type PilotEvent =
  | { type: 'accepted'; id: string }
  | { type: 'settled'; id: string; transactionHash: string }
  | { type: 'retry'; id: string; error: unknown }
  | { type: 'reverted'; ids: string[]; error: unknown };

/** Only throw this when the transaction definitely cannot have settled. */
export class PermanentSettlementError extends Error {}
