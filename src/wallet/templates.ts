import { ccc } from "@ckb-ccc/core";

export type PilotAccountBytes = "accountLockHash" | "ownerLockHash" | "accountLockArgs" | "ownerLockArgs";
export interface PilotTemplateByteRule {
  offset: number;
  value: ccc.Hex | PilotAccountBytes | { account: PilotAccountBytes; offset: number; length: number };
}
export type PilotScriptPattern = "account" | "owner" | {
  codeHash: ccc.Hex;
  hashType: ccc.HashType;
  args: { equals?: ccc.Hex; prefix?: ccc.Hex; length?: number; fields?: readonly PilotTemplateByteRule[] };
};
export interface PilotTemplateCell {
  role: string;
  min?: number;
  max?: number;
  lock: PilotScriptPattern;
  type: PilotScriptPattern | null;
  capacity?: { min?: string; max?: string };
  data: {
    length?: number;
    minLength?: number;
    maxLength?: number;
    prefix?: ccc.Hex;
    fields?: readonly PilotTemplateByteRule[];
  };
}
export interface PilotTemplateField {
  source: "input" | "output";
  role: string;
  /** Repeated roles must name a specific occurrence for cross-cell comparisons. */
  index?: number;
  field: "lock" | "type" | "data" | "capacity" | "lockArgs" | "typeArgs";
  offset?: number;
  length?: number;
}
/** `each` resolves to the current occurrence of the declared input/output role. */
export type PilotTemplateRepeatedField = Omit<PilotTemplateField, "index"> & { index?: number | "each" };
export interface PilotTemplateForEach {
  inputRole: string;
  outputRole: string;
  /** Roles pair by occurrence order, with equal counts; all comparisons run for every pair. */
  relations: readonly { left: PilotTemplateRepeatedField; right: PilotTemplateRepeatedField }[];
}
export interface PilotTransactionTemplate {
  version: 1;
  id: string;
  /** Net CKB leaving the account; cumulative allowance is enforced separately. */
  maxSpend: string;
  inputs: readonly PilotTemplateCell[];
  outputs: readonly PilotTemplateCell[];
  relations?: readonly { left: PilotTemplateField; right: PilotTemplateField }[];
  forEach?: readonly PilotTemplateForEach[];
  witnesses?: readonly {
    inputRole: string;
    index?: number;
    field: "inputType" | "outputType";
    equals?: ccc.Hex;
    prefix?: ccc.Hex;
  }[];
}
const hex = (v: unknown): v is ccc.Hex => typeof v === "string" && /^0x(?:[0-9a-f]{2})*$/.test(v);
const uint = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) <= 65536;
const amount = (v: unknown) => typeof v === "string" && /^(0|[1-9][0-9]*)$/.test(v) && BigInt(v) <= 0xffffffffffffffffn;
function requireRule(ok: unknown): asserts ok {
  if (!ok) throw new Error("Invalid transaction template");
}
function keys(value: unknown, allowed: readonly string[]) {
  requireRule(value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).every(k => allowed.includes(k)));
}
const accountBytes = ["accountLockHash", "ownerLockHash", "accountLockArgs", "ownerLockArgs"];
function byteRules(rules: readonly PilotTemplateByteRule[] | undefined) {
  requireRule(rules === undefined || (Array.isArray(rules) && rules.length <= 64));
  for (const f of rules ?? []) {
    keys(f, ["offset", "value"]);
    requireRule(uint(f.offset));
    if (typeof f.value === "object") {
      keys(f.value, ["account", "offset", "length"]);
      requireRule(accountBytes.includes(f.value.account) && uint(f.value.offset) && uint(f.value.length) && f.value.length > 0);
    } else requireRule(hex(f.value) || accountBytes.includes(f.value));
  }
}
function scriptRule(p: PilotScriptPattern) {
  if (p === "account" || p === "owner") return;
  requireRule(p && typeof p === "object" && hex(p.codeHash) && p.codeHash.length === 66 &&
    ["data", "type", "data1", "data2"].includes(p.hashType) && p.args && typeof p.args === "object");
  keys(p, ["codeHash", "hashType", "args"]);
  keys(p.args, ["equals", "prefix", "length", "fields"]);
  requireRule(p.args.equals === undefined || hex(p.args.equals));
  requireRule(p.args.prefix === undefined || hex(p.args.prefix));
  requireRule(p.args.length === undefined || uint(p.args.length));
  byteRules(p.args.fields);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
export function validatePilotTransactionTemplate(t: PilotTransactionTemplate): void {
  keys(t, ["version", "id", "maxSpend", "inputs", "outputs", "relations", "forEach", "witnesses"]);
  requireRule(t && t.version === 1 && typeof t.id === "string" && /^[a-zA-Z0-9_.:-]{1,100}$/.test(t.id) && amount(t.maxSpend));
  requireRule(Array.isArray(t.inputs) && Array.isArray(t.outputs) && t.inputs.length <= 32 && t.outputs.length > 0 && t.outputs.length <= 32);
  for (const rules of [t.inputs, t.outputs]) {
    const roles = new Set<string>();
    for (const r of rules) {
      keys(r, ["role", "min", "max", "lock", "type", "capacity", "data"]);
      requireRule(r && typeof r.role === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(r.role) && !roles.has(r.role));
      roles.add(r.role);
      requireRule(uint(r.min ?? 1) && uint(r.max ?? 1) && (r.max ?? 1) <= 64 && (r.min ?? 1) <= (r.max ?? 1));
      scriptRule(r.lock);
      if (r.type !== null) scriptRule(r.type);
      requireRule(r.data && typeof r.data === "object");
      keys(r.data, ["length", "minLength", "maxLength", "prefix", "fields"]);
      for (const k of ["length", "minLength", "maxLength"] as const) requireRule(r.data[k] === undefined || uint(r.data[k]));
      requireRule(r.data.prefix === undefined || hex(r.data.prefix));
      byteRules(r.data.fields);
      if (r.capacity !== undefined) {
        keys(r.capacity, ["min", "max"]);
        requireRule(r.capacity.min === undefined || amount(r.capacity.min));
        requireRule(r.capacity.max === undefined || amount(r.capacity.max));
        requireRule(r.capacity.min === undefined || r.capacity.max === undefined || BigInt(r.capacity.min) <= BigInt(r.capacity.max));
      }
    }
  }
  requireRule(t.relations === undefined || (Array.isArray(t.relations) && t.relations.length <= 64));
  const validateRelation = (relation: { left: PilotTemplateRepeatedField; right: PilotTemplateRepeatedField }, group?: PilotTemplateForEach) => {
    keys(relation, ["left", "right"]);
    for (const f of [relation.left, relation.right]) {
      keys(f, ["source", "role", "index", "field", "offset", "length"]);
      requireRule(f && ["input", "output"].includes(f.source) && ["lock", "type", "data", "capacity", "lockArgs", "typeArgs"].includes(f.field));
      requireRule((f.source === "input" ? t.inputs : t.outputs).some(r => r.role === f.role));
      if (f.index === "each") requireRule(group && f.role === (f.source === "input" ? group.inputRole : group.outputRole));
      else requireRule(f.index === undefined || uint(f.index));
      requireRule(f.offset === undefined || uint(f.offset));
      requireRule(f.length === undefined || uint(f.length));
      if (f.field === "capacity") requireRule(f.offset === undefined && f.length === undefined);
    }
    requireRule((relation.left.field === "capacity") === (relation.right.field === "capacity"));
    if (group) requireRule(relation.left.index === "each" || relation.right.index === "each");
  };
  for (const relation of t.relations ?? []) validateRelation(relation);
  requireRule(t.forEach === undefined || (Array.isArray(t.forEach) && t.forEach.length <= 32));
  let repeatedComparisons = 0;
  const pairs = new Set<string>();
  for (const group of t.forEach ?? []) {
    keys(group, ["inputRole", "outputRole", "relations"]);
    const input = t.inputs.find(r => r.role === group.inputRole), output = t.outputs.find(r => r.role === group.outputRole);
    requireRule(input && output && !pairs.has(`${group.inputRole}:${group.outputRole}`));
    pairs.add(`${group.inputRole}:${group.outputRole}`);
    requireRule(Array.isArray(group.relations) && group.relations.length > 0 && group.relations.length <= 64);
    // Bound expanded work independently of the number of roles/groups.
    repeatedComparisons += Math.min(input.max ?? 1, output.max ?? 1) * group.relations.length;
    for (const relation of group.relations) validateRelation(relation, group);
  }
  requireRule(repeatedComparisons <= 4096);
  requireRule(t.witnesses === undefined || (Array.isArray(t.witnesses) && t.witnesses.length <= 64));
  for (const w of t.witnesses ?? []) {
    keys(w, ["inputRole", "index", "field", "equals", "prefix"]);
    requireRule(t.inputs.some(r => r.role === w.inputRole) && ["inputType", "outputType"].includes(w.field));
    requireRule(w.index === undefined || uint(w.index));
    requireRule(w.equals !== undefined || w.prefix !== undefined);
    requireRule(w.equals === undefined || hex(w.equals));
    requireRule(w.prefix === undefined || hex(w.prefix));
  }
  requireRule(canonical(t).length <= 65536);
}
/** Hash includes every declared constraint; examples/labels never substitute for these rules. */
export function pilotTemplateHash(t: PilotTransactionTemplate): ccc.Hex {
  validatePilotTransactionTemplate(t);
  return ccc.hashCkb(ccc.bytesFrom(canonical(t), "utf8"));
}
export interface PilotTemplateEffect { output: ccc.CellOutput; data: ccc.Hex; index: number }
export function matchesPilotTransactionTemplate(
  t: PilotTransactionTemplate,
  effects: { inputs: PilotTemplateEffect[]; outputs: PilotTemplateEffect[]; spent: bigint; tx: ccc.Transaction },
  account: ccc.Script,
  owner: ccc.Script,
): boolean {
  validatePilotTransactionTemplate(t);
  if (effects.spent > BigInt(t.maxSpend)) return false;
  const roles = { input: new Map<string, PilotTemplateEffect[]>(), output: new Map<string, PilotTemplateEffect[]>() };
  const references = { accountLockHash: account.hash(), ownerLockHash: owner.hash(), accountLockArgs: account.args, ownerLockArgs: owner.args };
  const fieldsMatch = (data: ccc.Hex, rules: readonly PilotTemplateByteRule[] | undefined) => (rules ?? []).every(f => {
    let value: string;
    if (typeof f.value === "object") {
      const ref = references[f.value.account], {offset, length} = f.value;
      if (offset + length > ccc.bytesFrom(ref).length) return false;
      value = `0x${ref.slice(2 + offset * 2, 2 + (offset + length) * 2)}`;
    } else value = hex(f.value) ? f.value : references[f.value];
    return data.slice(2 + f.offset * 2, 2 + f.offset * 2 + value.length - 2) === value.slice(2);
  });
  const script = (pattern: PilotScriptPattern, actual: ccc.Script | undefined): boolean => {
    if (!actual) return false;
    if (pattern === "account") return actual.eq(account);
    if (pattern === "owner") return actual.eq(owner);
    return actual.codeHash === pattern.codeHash && actual.hashType === pattern.hashType &&
      (pattern.args.equals === undefined || actual.args === pattern.args.equals) &&
      (pattern.args.prefix === undefined || actual.args.startsWith(pattern.args.prefix)) &&
      (pattern.args.length === undefined || ccc.bytesFrom(actual.args).length === pattern.args.length) && fieldsMatch(actual.args, pattern.args.fields);
  };
  const cell = (r: PilotTemplateCell, e: PilotTemplateEffect): boolean => {
    const size = ccc.bytesFrom(e.data).length;
    return script(r.lock, e.output.lock) && (r.type === null ? !e.output.type : script(r.type, e.output.type)) &&
      (r.capacity?.min === undefined || e.output.capacity >= BigInt(r.capacity.min)) &&
      (r.capacity?.max === undefined || e.output.capacity <= BigInt(r.capacity.max)) &&
      (r.data.length === undefined || size === r.data.length) &&
      (r.data.minLength === undefined || size >= r.data.minLength) &&
      (r.data.maxLength === undefined || size <= r.data.maxLength) &&
      (r.data.prefix === undefined || e.data.startsWith(r.data.prefix)) &&
      fieldsMatch(e.data, r.data.fields);
  };
  for (const source of ["input", "output"] as const) {
    const rules = source === "input" ? t.inputs : t.outputs;
    for (const e of source === "input" ? effects.inputs : effects.outputs) {
      const matched = rules.filter(r => cell(r, e));
      // Overlapping roles are ambiguous: do not guess where a payment belongs.
      if (matched.length !== 1) return false;
      const name = matched[0]!.role;
      roles[source].set(name, [...(roles[source].get(name) ?? []), e]);
    }
    for (const r of rules) {
      const count = roles[source].get(r.role)?.length ?? 0;
      if (count < (r.min ?? 1) || count > (r.max ?? 1)) return false;
    }
  }
  const field = (f: PilotTemplateField): string | undefined => {
    const items = roles[f.source].get(f.role);
    if (!items || (f.index === undefined && items.length !== 1)) return undefined;
    const e = items[f.index ?? 0];
    if (!e) return undefined;
    if (f.field === "capacity") return e.output.capacity.toString();
    const value = f.field === "lock" ? e.output.lock.hash() : f.field === "type" ? e.output.type?.hash() :
      f.field === "lockArgs" ? e.output.lock.args : f.field === "typeArgs" ? e.output.type?.args : e.data;
    if (value === undefined) return undefined;
    const size = ccc.bytesFrom(value).length, offset = f.offset ?? 0, length = f.length ?? size - offset;
    if (offset > size || length > size - offset) return undefined;
    return value.slice(2 + offset * 2, 2 + (offset + length) * 2);
  };
  for (const r of t.relations ?? []) {
    const left = field(r.left), right = field(r.right);
    if (left === undefined || right === undefined || left !== right) return false;
  }
  for (const group of t.forEach ?? []) {
    const inputs = roles.input.get(group.inputRole) ?? [], outputs = roles.output.get(group.outputRole) ?? [];
    if (inputs.length !== outputs.length) return false;
    for (let index = 0; index < inputs.length; index++) {
      const resolve = (f: PilotTemplateRepeatedField): PilotTemplateField => ({ ...f, index: f.index === "each" ? index : f.index });
      for (const relation of group.relations) {
        const left = field(resolve(relation.left)), right = field(resolve(relation.right));
        if (left === undefined || right === undefined || left !== right) return false;
      }
    }
  }
  for (const w of t.witnesses ?? []) {
    const items = roles.input.get(w.inputRole);
    if (!items || (w.index === undefined && items.length !== 1)) return false;
    const e = items[w.index ?? 0];
    if (!e) return false;
    let args: ccc.WitnessArgs | undefined;
    try { args = effects.tx.getWitnessArgs(e.index); } catch { return false; }
    if (!args) return false;
    const value = args[w.field];
    if (value === undefined || (w.equals !== undefined && value !== w.equals) || (w.prefix !== undefined && !value.startsWith(w.prefix))) return false;
  }
  return true;
}

/** Start with exact example effects; developers explicitly relax only intended fields. */
export async function pilotTemplateFromExample(
  client: ccc.Client,
  value: ccc.TransactionLike,
  options: { id: string; maxSpend: string },
): Promise<PilotTransactionTemplate> {
  const tx = ccc.Transaction.from(value);
  const pattern = (s: ccc.Script): PilotScriptPattern => ({ codeHash: s.codeHash, hashType: s.hashType, args: { equals: s.args } });
  const rule = (output: ccc.CellOutput, data: ccc.Hex, role: string): PilotTemplateCell => ({
    role, lock: pattern(output.lock), type: output.type ? pattern(output.type) : null,
    capacity: { min: output.capacity.toString(), max: output.capacity.toString() },
    data: { length: ccc.bytesFrom(data).length, prefix: data },
  });
  const inputs: PilotTemplateCell[] = [];
  const witnesses: NonNullable<PilotTransactionTemplate["witnesses"]>[number][] = [];
  for (const [i, input] of tx.inputs.entries()) {
    const cell = await client.getCellLive(input.previousOutput, true);
    if (!cell) throw new Error("Example input is not live");
    const role = `input${i}`;
    inputs.push(rule(cell.cellOutput, cell.outputData, role));
    if (tx.witnesses[i] && tx.witnesses[i] !== "0x") {
      const args = tx.getWitnessArgs(i);
      if (!args) continue;
      for (const field of ["inputType", "outputType"] as const)
        if (args[field] !== undefined) witnesses.push({ inputRole: role, field, equals: args[field] });
    }
  }
  const result: PilotTransactionTemplate = { version: 1, ...options, inputs,
    outputs: tx.outputs.map((o, i) => {
      if (tx.outputsData[i] === undefined) throw new Error("Example output data missing");
      return rule(o, tx.outputsData[i]!, `output${i}`);
    }), ...(witnesses.length ? { witnesses } : {}),
  };
  validatePilotTransactionTemplate(result);
  return result;
}
