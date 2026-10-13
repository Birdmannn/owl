import type { Journal, Store } from './types.js';

export class MemoryStore<State, Action> implements Store<State, Action> {
  private journal: Journal<State, Action> | undefined;
  async load() { return structuredClone(this.journal); }
  async save(journal: Journal<State, Action>) { this.journal = structuredClone(journal); }
}

/** One Pilot instance per key. Use a transactional store for multiple tabs. */
export class LocalStorageStore<State, Action> implements Store<State, Action> {
  constructor(private storage: Pick<Storage, 'getItem' | 'setItem'>, private key: string) {}
  async load(): Promise<Journal<State, Action> | undefined> {
    const value = this.storage.getItem(this.key);
    return value === null ? undefined : JSON.parse(value) as Journal<State, Action>;
  }
  async save(journal: Journal<State, Action>) {
    this.storage.setItem(this.key, JSON.stringify(journal));
  }
}
