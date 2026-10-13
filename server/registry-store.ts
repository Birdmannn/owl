import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import lockfile from 'proper-lockfile';
import pg from 'pg';
import type { PilotUsername } from '../src/usernames.js';

export interface Challenge { id: string; message: string; profile: PilotUsername; expiresAt: number }
export interface RegistryStore {
  init(): Promise<void>;
  get(username: string): Promise<PilotUsername | undefined>;
  byAddress(address: string): Promise<PilotUsername | undefined>;
  challenge(value: Challenge): Promise<void>;
  getChallenge(id: string): Promise<Challenge | undefined>;
  claim(id: string): Promise<PilotUsername>;
  close(): Promise<void>;
}
function conflict(profiles: PilotUsername[], profile: PilotUsername) {
  if (profiles.some(p => p.username === profile.username || p.ownerAddress === profile.ownerAddress ||
    (p.signType === profile.signType && p.identity === profile.identity))) {
    throw new Error('Username, wallet, or passkey already registered');
  }
}
interface Data { version: 1; profiles: PilotUsername[]; challenges: Challenge[] }
export class JsonRegistryStore implements RegistryStore {
  constructor(readonly file: string) {}
  async init() {
    await mkdir(dirname(this.file), { recursive: true });
    const release = await lockfile.lock(this.file, { realpath: false, retries: { retries: 20, minTimeout: 20, maxTimeout: 100 } });
    try {
      try { await writeFile(this.file, JSON.stringify({ version: 1, profiles: [], challenges: [] }, null, 2), { flag: 'wx', mode: 0o600 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      await this.read();
    } finally { await release(); }
  }
  private async read(): Promise<Data> {
    const data = JSON.parse(await readFile(this.file, 'utf8')) as Data;
    if (data.version !== 1 || !Array.isArray(data.profiles) || !Array.isArray(data.challenges)) throw new Error('Invalid registry JSON; refusing to reset it');
    return data;
  }
  private async write<T>(mutate: (data: Data) => T): Promise<T> {
    const release = await lockfile.lock(this.file, { realpath: false, retries: { retries: 20, minTimeout: 20, maxTimeout: 100 } });
    try {
      const data = await this.read();
      data.challenges = data.challenges.filter(c => c.expiresAt > Date.now());
      const result = mutate(data);
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(data, null, 2), { mode: 0o600 });
      await rename(temporary, this.file);
      return result;
    } finally { await release(); }
  }
  async get(username: string) { return (await this.read()).profiles.find(p => p.username === username); }
  async byAddress(address: string) { return (await this.read()).profiles.find(p => p.ownerAddress === address); }
  async challenge(value: Challenge) { await this.write(data => { if (data.challenges.length >= 5000) throw new Error('Too many active registration challenges'); data.challenges.push(value); }); }
  async getChallenge(id: string) { return (await this.read()).challenges.find(c => c.id === id && c.expiresAt > Date.now()); }
  async claim(id: string) {
    return this.write(data => {
      const index = data.challenges.findIndex(c => c.id === id);
      const value = data.challenges[index];
      if (!value) throw new Error('Registration challenge expired or already used');
      conflict(data.profiles, value.profile);
      data.profiles.push(value.profile); data.challenges.splice(index, 1);
      return value.profile;
    });
  }
  async close() {}
}
export class PostgresRegistryStore implements RegistryStore {
  private pool: pg.Pool;
  constructor(url: string) { this.pool = new pg.Pool({ connectionString: url }); }
  async init() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS pilot_usernames (
      username TEXT PRIMARY KEY, owner_address TEXT NOT NULL UNIQUE,
      identity_key TEXT NOT NULL UNIQUE, profile JSONB NOT NULL);
      CREATE TABLE IF NOT EXISTS pilot_username_challenges (
      id UUID PRIMARY KEY, expires_at BIGINT NOT NULL, challenge JSONB NOT NULL);`);
  }
  async get(username: string) { return (await this.pool.query('SELECT profile FROM pilot_usernames WHERE username=$1', [username])).rows[0]?.profile as PilotUsername | undefined; }
  async byAddress(address: string) { return (await this.pool.query('SELECT profile FROM pilot_usernames WHERE owner_address=$1', [address])).rows[0]?.profile as PilotUsername | undefined; }
  async challenge(value: Challenge) {
    await this.pool.query('DELETE FROM pilot_username_challenges WHERE expires_at <= $1', [Date.now()]);
    await this.pool.query('INSERT INTO pilot_username_challenges VALUES ($1,$2,$3)', [value.id, value.expiresAt, value]);
  }
  async getChallenge(id: string) { return (await this.pool.query('SELECT challenge FROM pilot_username_challenges WHERE id=$1 AND expires_at>$2', [id, Date.now()])).rows[0]?.challenge as Challenge | undefined; }
  async claim(id: string) {
    const connection = await this.pool.connect();
    try {
      await connection.query('BEGIN');
      const row = (await connection.query('DELETE FROM pilot_username_challenges WHERE id=$1 AND expires_at>$2 RETURNING challenge', [id, Date.now()])).rows[0];
      if (!row) throw new Error('Registration challenge expired or already used');
      const profile = (row.challenge as Challenge).profile;
      await connection.query('INSERT INTO pilot_usernames VALUES ($1,$2,$3,$4)', [profile.username, profile.ownerAddress, `${profile.signType}:${profile.identity}`, profile]);
      await connection.query('COMMIT'); return profile;
    } catch (error) {
      await connection.query('ROLLBACK');
      if ((error as { code?: string }).code === '23505') throw new Error('Username, wallet, or passkey already registered');
      throw error;
    } finally { connection.release(); }
  }
  async close() { await this.pool.end(); }
}
