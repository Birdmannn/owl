import { ccc } from "@ckb-ccc/core";
import { MAX_ACTION_CATALOG, MAX_DELEGATED_ACTIONS } from '../limits.js';
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { pilotTemplateHash, matchesPilotTransactionTemplate, type PilotTransactionTemplate, type PilotTemplateEffect } from "./templates.js";
import {
  deploymentDep,
  verifyDeployment,
  type Deployment,
} from "../ckb/counter.js";
import {
  PilotPasskeySigner,
  canonicalWalletOrigin,
  walletU64,
  pilotPasskeyLock,
  verifyPilotAssertion,
  type PilotPasskey,
  type PilotAssertion,
} from "./passkey.js";
import {
  PILOT_WALLET_SESSION_CODE_HASH,
  PILOT_WALLET_GENERAL_CODE_HASH,
  PILOT_LEGACY_PASSKEY_CODE_HASH,
  PILOT_PASSKEY_CODE_HASH,
} from "./code.js";
import {
  SponsorQuoteRejectedError,
  verifySponsorQuote,
  type FeeSponsor,
  type SponsorQuote,
} from "../paymaster.js";
export const PILOT_TYPE_ID: ccc.Hex =
  "0x00000000000000000000000000000000000000000000000000545950455f4944";
const ZERO: ccc.Hex = ("0x" + "00".repeat(32)) as ccc.Hex;
export interface PilotCellPolicy {
  name: string;
  direction: "input" | "output" | "message" | "template";
  lockHash: ccc.Hex;
  typeHash: ccc.Hex;
  dataHash: ccc.Hex;
  maxCapacity: string;
  /** Present only for wallet-enforced template permissions. */
  template?: PilotTransactionTemplate;
}
export function pilotTemplatePolicy(name: string, template: PilotTransactionTemplate): PilotCellPolicy {
  return { name, direction: "template", lockHash: pilotTemplateHash(template), typeHash: ZERO,
    dataHash: ZERO, maxCapacity: template.maxSpend === "0" ? "1" : template.maxSpend, template: structuredClone(template) };
}
export interface PilotWalletState {
  /** Version-2 general account; template semantics are NOT contract-enforced. */
  mode?: "templates";
  publicKey: ccc.Hex;
  remaining: string;
  sequence: string;
  appOrigin: string;
  policies: readonly PilotCellPolicy[];
}
export interface PilotWalletDescriptor {
  version: 2;
  deployment: Deployment;
  ownerLock: ccc.ScriptLike;
  stateType: ccc.ScriptLike;
  poolLock: ccc.ScriptLike;
  maxFee: string;
}
/** Accept public fields only when restoring an exported account. */
export function parsePilotWalletDescriptor(
  value: unknown,
): PilotWalletDescriptor {
  const v = value as PilotWalletDescriptor;
  if (
    !v ||
    v.version !== 2 ||
    !v.deployment ||
    !["testnet", "devnet"].includes(v.deployment.network) ||
    !/^0x[0-9a-f]{64}$/.test(v.deployment.genesisHash) ||
    !/^0x[0-9a-f]{64}$/.test(v.deployment.outPoint?.txHash) ||
    !Number.isSafeInteger(v.deployment.outPoint.index) ||
    v.deployment.outPoint.index < 0 ||
    v.deployment.outPoint.index > 0xffffffff ||
    typeof v.maxFee !== "string"
  )
    throw new Error("Invalid public wallet descriptor");
  const account: PilotWalletDescriptor = {
    version: 2,
    deployment: {
      network: v.deployment.network,
      genesisHash: v.deployment.genesisHash,
      codeHash: v.deployment.codeHash,
      outPoint: {
        txHash: v.deployment.outPoint.txHash,
        index: v.deployment.outPoint.index,
      },
    },
    ownerLock: ccc.Script.from(v.ownerLock),
    stateType: ccc.Script.from(v.stateType),
    poolLock: ccc.Script.from(v.poolLock),
    maxFee: v.maxFee,
  };
  pilotWalletLock(account);
  return account;
}
export function validatePilotPolicies(
  policies: readonly PilotCellPolicy[],
): void {
  validatePolicies(policies, MAX_DELEGATED_ACTIONS);
}
/** Offered policies are not authorized until the user selects a bounded subset. */
export function validatePilotPolicyCatalog(policies: readonly PilotCellPolicy[]): void {
  validatePolicies(policies, MAX_ACTION_CATALOG);
}
function validatePolicies(policies: readonly PilotCellPolicy[], limit: number): void {
  if (!Array.isArray(policies) || policies.length < 1 || policies.length > limit)
    throw new Error(`Choose between 1 and ${limit} cell policies`);
  for (const p of policies) {
    if (
      !p.name ||
      p.name.length > 100 ||
      !["input", "output", "message", "template"].includes(p.direction)
    )
      throw new Error("Invalid policy name or direction");
    for (const h of [p.lockHash, p.typeHash, p.dataHash])
      if (!/^0x[0-9a-f]{64}$/.test(h))
        throw new Error("Policies require full 32-byte hashes");
    walletU64(BigInt(p.maxCapacity));
    if (BigInt(p.maxCapacity) <= 0n)
      throw new Error("Policy capacity must be positive");
    if (p.direction === "template") {
      if (!p.template || pilotTemplateHash(p.template) !== p.lockHash || p.typeHash !== ZERO || p.dataHash !== ZERO ||
        p.maxCapacity !== (p.template.maxSpend === "0" ? "1" : p.template.maxSpend))
        throw new Error("Template permission commitment mismatch");
    } else if (p.template !== undefined) throw new Error("Template requires template direction");
  }
}
export function encodePilotWalletState(state: PilotWalletState): ccc.Hex {
  validatePilotPolicies(state.policies);
  if (state.mode !== undefined && state.mode !== "templates") throw new Error("Unknown account authorization mode");
  if (!state.mode && state.policies.some(p => p.direction === "template")) throw new Error("Templates require a general account deployment");
  canonicalWalletOrigin(state.appOrigin);
  const key = ccc.bytesFrom(state.publicKey);
  if (key.length !== 33) throw new Error("Invalid session key");
  secp256k1.Point.fromBytes(key);
  return ccc.hexFrom(
    ccc.bytesConcat(
      [state.mode === "templates" ? 2 : 1],
      key,
      walletU64(BigInt(state.remaining)),
      walletU64(BigInt(state.sequence)),
      ccc.hashCkb(ccc.bytesFrom(state.appOrigin, "utf8")),
      [state.policies.length],
      ...state.policies.map((p) =>
        ccc.bytesConcat(
          [p.direction === "input" ? 0 : p.direction === "output" ? 1 : p.direction === "message" ? 2 : 3],
          p.lockHash,
          p.typeHash,
          p.dataHash,
          walletU64(BigInt(p.maxCapacity)),
        ),
      ),
    ),
  );
}
export function pilotWalletLock(account: PilotWalletDescriptor): ccc.Script {
  if (
    account.version !== 2 ||
    ![PILOT_WALLET_SESSION_CODE_HASH, PILOT_WALLET_GENERAL_CODE_HASH].includes(account.deployment.codeHash)
  )
    throw new Error("Unsupported Pilot wallet deployment");
  const type = ccc.Script.from(account.stateType),
    owner = ccc.Script.from(account.ownerLock),
    pool = ccc.Script.from(account.poolLock);
  if (
    type.codeHash !== PILOT_TYPE_ID ||
    type.hashType !== "type" ||
    ccc.bytesFrom(type.args).length !== 32 ||
    ![PILOT_PASSKEY_CODE_HASH, PILOT_LEGACY_PASSKEY_CODE_HASH].includes(
      owner.codeHash,
    ) ||
    owner.hashType !== "data2" ||
    ccc.bytesFrom(owner.args).length !== 97 ||
    owner.eq(pool) ||
    BigInt(account.maxFee) <= 0n
  )
    throw new Error("Invalid account authority or pool");
  return ccc.Script.from({
    codeHash: account.deployment.codeHash,
    hashType: "data2",
    args: ccc.hexFrom(
      ccc.bytesConcat(
        owner.hash(),
        type.hash(),
        pool.hash(),
        walletU64(BigInt(account.maxFee)),
      ),
    ),
  });
}
export function createPilotWalletDescriptor(
  owner: ccc.ScriptLike,
  deployment: Deployment,
  poolLock: ccc.ScriptLike,
  maxFee: bigint,
  firstInput: ccc.CellInputLike,
): PilotWalletDescriptor {
  return {
    version: 2,
    deployment,
    ownerLock: owner,
    poolLock,
    maxFee: maxFee.toString(),
    stateType: {
      codeHash: PILOT_TYPE_ID,
      hashType: "type",
      args: ccc.hashCkb(
        ccc.CellInput.from(firstInput).toBytes(),
        walletU64(0n),
      ),
    },
  };
}
export function pilotWalletDigest(
  value: ccc.TransactionLike,
  index: number,
): ccc.Hex {
  const tx = ccc.Transaction.from(value).clone();
  const pool = tx.inputs.length - 1;
  if (index < 0 || index >= pool) throw new Error("Invalid session input");
  tx.setWitnessArgs(index, { ...tx.getWitnessArgs(index), lock: "0x01" });
  tx.setWitnessArgs(pool, { ...tx.getWitnessArgs(pool), lock: "0x" });
  return ccc.hashCkb(
    ccc.bytesFrom("owl-pilot-wallet-session-v1", "utf8"),
    tx.hash(),
    ...tx.witnesses.flatMap((w) => [
      walletU64(BigInt(ccc.bytesFrom(w).length)),
      ccc.bytesFrom(w),
    ]),
  );
}
function permitted(
  state: PilotWalletState,
  output: ccc.CellOutput,
  data: ccc.Hex,
  direction: "input" | "output",
): boolean {
  return state.policies.some(
    (p) =>
      p.direction === direction &&
      p.lockHash === output.lock.hash() &&
      p.typeHash === (output.type?.hash() ?? ZERO) &&
      (p.dataHash === ZERO || p.dataHash === ccc.hashCkb(data)) &&
      output.capacity <= BigInt(p.maxCapacity),
  );
}
export class PilotPolicyApprovalRequiredError extends Error {}

/** Mirrors consensus checks before asking for sponsorship. Does not replace CKB script validation. */
export async function validatePilotWalletEffects(
  client: ccc.Client,
  account: PilotWalletDescriptor,
  state: PilotWalletState,
  tx: ccc.Transaction,
  ownerApproved = false,
): Promise<{ index: number; next: PilotWalletState; policyName?: string; policyId?: string }> {
  const lock = pilotWalletLock(account),
    type = ccc.Script.from(account.stateType);
  const general = account.deployment.codeHash === PILOT_WALLET_GENERAL_CODE_HASH;
  if (general !== (state.mode === "templates")) throw new Error("Account authorization mode does not match deployment");
  const templates = state.policies.filter(p => p.direction === "template");
  const useTemplates = general && templates.length > 0;
  const effects: { inputs: PilotTemplateEffect[]; outputs: PilotTemplateEffect[] } = { inputs: [], outputs: [] };
  let input = 0n,
    output = 0n,
    anchorIn = -1,
    anchorOut = -1,
    first = -1;
  const points = new Set<string>();
  for (const [i, v] of tx.inputs.entries()) {
    const point = ccc.hexFrom(v.previousOutput.toBytes());
    if (points.has(point)) throw new Error("Duplicate wallet input");
    points.add(point);
    const cell = await client.getCellLive(v.previousOutput, true);
    if (!cell) throw new Error("Wallet input is not live");
    if (cell.cellOutput.lock.eq(account.ownerLock))
      throw new Error("Apps cannot select recovery-owner inputs");
    if (cell.cellOutput.lock.eq(account.poolLock))
      throw new Error("Apps cannot select pool inputs");
    if (
      [PILOT_WALLET_SESSION_CODE_HASH, PILOT_WALLET_GENERAL_CODE_HASH].includes(cell.cellOutput.lock.codeHash) &&
      !cell.cellOutput.lock.eq(lock)
    )
      throw new Error("Do not mix Pilot wallets");
    if (cell.cellOutput.type?.eq(type)) {
      if (
        anchorIn !== -1 ||
        !cell.cellOutput.lock.eq(lock) ||
        cell.outputData !== encodePilotWalletState(state)
      )
        throw new Error("Missing, changed or duplicate session authority");
      anchorIn = i;
    }
    if (cell.cellOutput.lock.eq(lock)) {
      if (first === -1) first = i;
      input += cell.cellOutput.capacity;
      if (
        !cell.cellOutput.type?.eq(type) &&
        (cell.cellOutput.type || cell.outputData !== "0x") &&
        !ownerApproved && !useTemplates &&
        !permitted(state, cell.cellOutput, cell.outputData, "input")
      )
        throw new PilotPolicyApprovalRequiredError("Account asset input is outside session policies");
    }
    if (!cell.cellOutput.type?.eq(type) && !(cell.cellOutput.lock.eq(lock) && !cell.cellOutput.type && cell.outputData === "0x"))
      effects.inputs.push({ output: cell.cellOutput, data: cell.outputData, index: i });
  }
  for (const [i, o] of tx.outputs.entries()) {
    const data = tx.outputsData[i];
    if (data === undefined) throw new Error("Missing output data");
    if (
      o.capacity <
      ccc.fixedPointFrom(o.occupiedSize + ccc.bytesFrom(data).length)
    )
      throw new Error("Output below occupied capacity");
    if (o.lock.eq(account.poolLock))
      throw new Error("Apps cannot create pool outputs");
    if (o.type?.eq(type)) {
      if (anchorOut !== -1 || !o.lock.eq(lock))
        throw new Error("Invalid successor authority");
      anchorOut = i;
    }
    if (o.lock.eq(lock)) {
      output += o.capacity;
      if (o.type?.eq(type)) continue;
      if (!o.type && data === "0x") continue;
    }
    effects.outputs.push({ output: o, data, index: i });
    if (!ownerApproved && !useTemplates && !permitted(state, o, data, "output"))
      throw new PilotPolicyApprovalRequiredError("Output is outside session policies");
  }
  if (anchorIn < 0 || anchorOut < 0)
    throw new Error(
      "Every automatic transaction must consume and recreate the unique session state",
    );
  const spent = input > output ? input - output : 0n;
  if (spent > BigInt(state.remaining))
    throw new Error("Session spending budget exceeded");
  const matched = !ownerApproved && useTemplates ? templates.find(p => matchesPilotTransactionTemplate(p.template!, { ...effects, spent, tx }, lock, ccc.Script.from(account.ownerLock))) : undefined;
  if (!ownerApproved && useTemplates && !matched) throw new PilotPolicyApprovalRequiredError("Transaction does not match an approved action template");
  const next = {
    ...state,
    remaining: (BigInt(state.remaining) - spent).toString(),
    sequence: (BigInt(state.sequence) + 1n).toString(),
  };
  if (tx.outputsData[anchorOut] !== encodePilotWalletState(next))
    throw new Error("Session state changed or budget/sequence is incorrect");
  return { index: first, next, ...(matched ? { policyName: matched.name, policyId: matched.template!.id } : {}) };
}
export interface PilotWalletReceipt {
  id: string;
  requestHash: ccc.Hex;
  hash: ccc.Hex;
  bytes: ccc.Hex;
  quote: SponsorQuote;
  status: "signed" | "submitted" | "confirmed" | "requote";
  kind: "grant" | "action" | "revoke" | "recover";
  next?: PilotWalletState;
  approval?: "passkey";
  policyName?: string;
  policyId?: string;
  createdAt: number;
}
export interface PilotWalletJournal {
  accountHash: ccc.Hex;
  stopped: boolean;
  state?: PilotWalletState;
  receipts: PilotWalletReceipt[];
  messages?: {
    id: string;
    appOrigin: string;
    scope: string;
    hash: ccc.Hex;
    createdAt: number;
  }[];
}
export interface PilotWalletJournalStore {
  load(): Promise<PilotWalletJournal | undefined>;
  save(value: PilotWalletJournal): Promise<void>;
}
export type PilotOwnerActionReview =
  | { kind: "transaction"; appOrigin: string; bytes: ccc.Hex; requestId: string; remaining: string; fee: string }
  | { kind: "message"; appOrigin: string; scope: string; message: string; nonce: string };

export interface PilotWalletOptions {
  /** Trusted wallet UI only. Never supply this callback from app-controlled code. */
  approveOnce?: (review: PilotOwnerActionReview) => Promise<boolean>;
  owner: PilotPasskeySigner;
  account: PilotWalletDescriptor;
  paymaster: FeeSponsor;
  journal: PilotWalletJournalStore;
  exclusive: <T>(operation: () => Promise<T>) => Promise<T>;
  sessionKey: ccc.Hex;
  appOrigin: string;
  expiresAt: number;
}
/** Fill the authority successor and ordinary account change for a builder's requested effects. */
export async function buildPilotWalletTransaction(
  client: ccc.Client,
  account: PilotWalletDescriptor,
  state: PilotWalletState,
  value: ccc.TransactionLike,
  allowOwnerReview = false,
  knownAnchor?: ccc.Cell,
): Promise<ccc.Transaction> {
  const tx = ccc.Transaction.from(value).clone(),
    lock = pilotWalletLock(account),
    type = ccc.Script.from(account.stateType);
  if (tx.outputs.some((o) => o.type?.eq(type)))
    throw new Error("The wallet builds its own session successor");
  let anchor: ccc.Cell | undefined = knownAnchor;
  const ordinary: ccc.Cell[] = [];
  for await (const cell of client.findCellsByLock(lock, null)) {
    if (!(await client.getCellLive(cell.outPoint, true))) continue;
    if (cell.cellOutput.type?.eq(type)) {
      if (anchor && !anchor.outPoint.eq(cell.outPoint)) throw new Error("Duplicate authority");
      anchor = cell;
    } else if (!cell.cellOutput.type && cell.outputData === "0x")
      ordinary.push(cell);
  }
  if (!anchor || !anchor.cellOutput.lock.eq(lock) || !anchor.cellOutput.type?.eq(type) ||
      !(await client.getCellLive(anchor.outPoint, true)) || anchor.outputData !== encodePilotWalletState(state))
    throw new Error("Session authority changed; reconnect and reconcile");
  if (!tx.inputs.some((i) => i.previousOutput.eq(anchor!.outPoint))) {
    for (let i = tx.witnesses.length; i < tx.inputs.length; i++)
      tx.witnesses.push("0x");
    tx.inputs.push(ccc.CellInput.from({ previousOutput: anchor.outPoint }));
    tx.witnesses.push("0x");
  }
  let total = 0n,
    own = 0n;
  const used = new Set<string>();
  for (const i of tx.inputs) {
    const id = ccc.hexFrom(i.previousOutput.toBytes());
    if (used.has(id)) throw new Error("Duplicate input");
    used.add(id);
    const cell = await client.getCellLive(i.previousOutput, true);
    if (!cell) throw new Error("Input is no longer live");
    total += cell.cellOutput.capacity;
    if (cell.cellOutput.lock.eq(lock)) own += cell.cellOutput.capacity;
  }
  const out = tx.outputs.reduce((n, o) => n + o.capacity, 0n);
  const ownOut = tx.outputs
    .filter((o) => o.lock.eq(lock))
    .reduce((n, o) => n + o.capacity, 0n);
  const successor = ccc.CellOutput.from({
    lock,
    type,
    capacity: anchor.cellOutput.capacity,
  });
  const min = ccc.fixedPointFrom(
    successor.occupiedSize + ccc.bytesFrom(anchor.outputData).length,
  );
  for (const cell of ordinary) {
    if (total - out >= min) break;
    if (used.has(ccc.hexFrom(cell.outPoint.toBytes()))) continue;
    for (let i = tx.witnesses.length; i < tx.inputs.length; i++)
      tx.witnesses.push("0x");
    tx.inputs.push(ccc.CellInput.from({ previousOutput: cell.outPoint }));
    tx.witnesses.push("0x");
    total += cell.cellOutput.capacity;
    own += cell.cellOutput.capacity;
  }
  successor.capacity = total - out;
  if (successor.capacity < min)
    throw new Error(
      "Insufficient account capacity after reserving the session cell",
    );
  const loss =
    own > ownOut + successor.capacity ? own - ownOut - successor.capacity : 0n;
  if (loss > BigInt(state.remaining))
    throw new Error("Session spending budget exceeded");
  const next = {
    ...state,
    remaining: (BigInt(state.remaining) - loss).toString(),
    sequence: (BigInt(state.sequence) + 1n).toString(),
  };
  tx.outputs.push(successor);
  tx.outputsData.push(encodePilotWalletState(next));
  await validatePilotWalletEffects(client, account, state, tx, allowOwnerReview);
  return tx;
}
/** Trusted-wallet implementation. Never instantiate this with keys in an integrating app. */
export class PilotWalletSession extends ccc.Signer {
  #key: ccc.Hex;
  constructor(readonly options: PilotWalletOptions) {
    super(options.owner.client);
    this.#key = options.sessionKey;
    canonicalWalletOrigin(options.appOrigin);
    pilotWalletLock(options.account);
  }
  get type() {
    return ccc.SignerType.CKB;
  }
  get signType() {
    return ccc.SignerSignType.Unknown;
  }
  get lock() {
    return pilotWalletLock(this.options.account);
  }
  get publicKey() {
    return ccc.hexFrom(secp256k1.getPublicKey(ccc.bytesFrom(this.#key), true));
  }
  async connect() {
    await this.verify();
  }
  async disconnect() {
    await this.stop();
  }
  async isConnected() {
    const j = await this.options.journal.load();
    return (
      !!j &&
      !j.stopped &&
      j.state?.appOrigin === this.options.appOrigin &&
      j.state.publicKey === this.publicKey &&
      this.options.expiresAt > Date.now()
    );
  }
  async getIdentity() {
    return this.lock.hash();
  }
  async getAddressObjs() {
    return [
      ccc.Address.from({
        prefix: this.client.addressPrefix,
        script: this.lock,
      }),
    ];
  }
  async getInternalAddress() {
    return this.getRecommendedAddress();
  }
  async signMessageRaw(): Promise<string> {
    throw new Error(
      "Use Pilot scoped message authorization; raw account impersonation is not supported",
    );
  }
  private async verify() {
    await verifyDeployment(this.client, this.options.account.deployment);
    await this.options.owner.connect();
    if (
      !(await this.options.owner.getRecommendedAddressObj()).script.eq(
        this.options.account.ownerLock,
      )
    )
      throw new Error("Incorrect passkey owner");
  }
  private async journal() {
    const j = await this.options.journal.load();
    if (!j || j.accountHash !== this.lock.hash())
      throw new Error(
        "Missing wallet journal; restore the public descriptor and reconcile before signing",
      );
    for (const r of j.receipts)
      if (ccc.Transaction.fromBytes(r.bytes).hash() !== r.hash)
        throw new Error("Corrupt wallet receipt");
    return j;
  }
  private async save(j: PilotWalletJournal, r: PilotWalletReceipt) {
    const i = j.receipts.findIndex((v) => v.id === r.id);
    if (i < 0) j.receipts.push(r);
    else j.receipts[i] = r;
    await this.options.journal.save(j);
  }
  async stop() {
    await this.options.exclusive(async () => {
      const j = await this.journal();
      j.stopped = true;
      await this.options.journal.save(j);
    });
  }
  /** App disconnect is scoped and atomic with grant replacement; owner controls use stop/revoke. */
  async endAppAccess() {
    await this.options.exclusive(async () => {
      const j = await this.journal();
      if (
        j.state?.publicKey !== this.publicKey ||
        j.state.appOrigin !== this.options.appOrigin
      )
        throw new Error("This app session was replaced");
      j.stopped = true;
      await this.options.journal.save(j);
      await this.resumeUnlocked();
    });
  }
  /** Explicitly resume a locally retained grant after passkey sign-in, without replacing it. */
  async resumeAppAccess(): Promise<PilotWalletState> {
    return this.options.exclusive(async () => {
      await this.verify();
      await this.resumeUnlocked();
      const j = await this.journal();
      if (!j.state || j.state.appOrigin !== this.options.appOrigin ||
          j.state.publicKey !== this.publicKey || this.options.expiresAt <= Date.now())
        throw new Error("Saved session expired, was replaced, or belongs to another app/key");
      const anchor = await this.anchor();
      if (!anchor || anchor.outputData !== encodePilotWalletState(j.state))
        throw new Error("Saved session authority is unavailable, revoked or changed; reconcile before reconnecting");
      j.stopped = false;
      await this.options.journal.save(j);
      return j.state;
    });
  }
  async prepareAppTransaction(
    value: ccc.TransactionLike,
  ): Promise<ccc.Transaction> {
    return this.options.exclusive(async () => {
      await this.resumeUnlocked();
      const j = await this.journal();
      if (
        !j.state ||
        j.stopped ||
        this.options.expiresAt <= Date.now() ||
        j.state.publicKey !== this.publicKey ||
        j.state.appOrigin !== this.options.appOrigin
      )
        throw new Error("This app session stopped, expired or was replaced");
      const tx = await buildPilotWalletTransaction(
        this.client,
        this.options.account,
        j.state,
        value,
        !!this.options.approveOnce,
        await this.anchor(),
      );
      return this.prepareTransaction(tx);
    });
  }
  private async submit(
    j: PilotWalletJournal,
    r: PilotWalletReceipt,
    wait: boolean,
  ) {
    const tx = ccc.Transaction.fromBytes(r.bytes);
    const known = await this.client.getTransactionNoCache(r.hash);
    if (
      known?.status !== "committed" &&
      (!known || ["unknown", "rejected"].includes(known.status))
    ) {
      try {
        const signed = await this.options.paymaster.submit(r.quote, tx.clone());
        if (
          signed.hash() !== tx.hash() ||
          signed.witnesses.length !== tx.witnesses.length ||
          signed.witnesses.some(
            (w, i) => i !== signed.inputs.length - 1 && w !== tx.witnesses[i],
          )
        )
          throw new Error("Sponsor changed signed wallet transaction");
        const a = tx.getWitnessArgs(tx.inputs.length - 1),
          b = signed.getWitnessArgs(signed.inputs.length - 1);
        if (a?.inputType !== b?.inputType || a?.outputType !== b?.outputType)
          throw new Error("Sponsor changed type witnesses");
        r.bytes = ccc.hexFrom(signed.toBytes());
        r.status = "submitted";
        await this.save(j, r);
      } catch (e) {
        if (
          e instanceof SponsorQuoteRejectedError &&
          e.quoteId === r.quote.id
        ) {
          r.status = "requote";
          await this.save(j, r);
        }
        throw e;
      }
    }
    if (known?.status === "committed" || wait) {
      if (
        known?.status !== "committed" &&
        (await this.client.waitTransaction(r.hash, 1, 180_000))?.status !==
          "committed"
      )
        throw new Error(
          "Transaction remains unresolved; retain its reservation",
        );
      r.status = "confirmed";
      if (r.next) j.state = r.next;
      await this.save(j, r);
    }
    return r.hash;
  }
  private async resumeUnlocked() {
    const j = await this.journal();
    for (const r of j.receipts)
      if (!["confirmed", "requote"].includes(r.status))
        await this.submit(j, r, true);
  }
  async resume() {
    await this.options.exclusive(() => this.resumeUnlocked());
  }
  async prepareTransaction(value: ccc.TransactionLike) {
    const tx = ccc.Transaction.from(value).clone();
    tx.cellDeps.push(
      ccc.CellDep.from(deploymentDep(this.options.account.deployment)),
    );
    tx.cellDeps = tx.cellDeps.filter(
      (d, i, a) =>
        a.findIndex(
          (x) => ccc.hexFrom(x.toBytes()) === ccc.hexFrom(d.toBytes()),
        ) === i,
    );
    for (let i = tx.witnesses.length; i < tx.inputs.length; i++)
      tx.witnesses.push("0x");
    let first = -1;
    for (const [i, v] of tx.inputs.entries())
      if (
        (await this.client.getCell(v.previousOutput))?.cellOutput.lock.eq(
          this.lock,
        )
      ) {
        first = i;
        break;
      }
    if (first < 0) throw new Error("Missing wallet input");
    tx.setWitnessArgs(first, {
      ...tx.getWitnessArgs(first),
      lock: ccc.hexFrom(ccc.bytesConcat([1], new Uint8Array(64))),
    });
    return tx;
  }
  async signOnlyTransaction(): Promise<ccc.Transaction> {
    throw new Error(
      "Wallet signatures remain isolated; use sponsored sendTransaction",
    );
  }
  async sendTransaction(
    value: ccc.TransactionLike,
    requestId?: string,
  ): Promise<ccc.Hex> {
    if (!requestId || requestId.length > 128)
      throw new Error("Supply a stable request ID (1–128 characters)");
    return this.options.exclusive(async () => {
      await this.verify();
      await this.resumeUnlocked();
      const j = await this.journal(),
        tx = await this.prepareTransaction(value),
        requestHash = ccc.hashCkb(tx.toBytes());
      const old = j.receipts.find((r) => r.id === requestId);
      if (old) {
        if (old.kind !== "action" || old.requestHash !== requestHash)
          throw new Error("Request ID reused with different effects");
        if (old.status !== "requote") return old.hash;
      }
      if (j.stopped || this.options.expiresAt <= Date.now())
        throw new Error("Session stopped or expired");
      const state = j.state;
      if (
        !state ||
        state.appOrigin !== this.options.appOrigin ||
        state.publicKey !==
          ccc.hexFrom(secp256k1.getPublicKey(ccc.bytesFrom(this.#key), true))
      )
        throw new Error("Session belongs to another key or app");
      let ownerApproval = false;
      let checked;
      try {
        checked = await validatePilotWalletEffects(this.client, this.options.account, state, tx);
      } catch (error) {
        if (!(error instanceof PilotPolicyApprovalRequiredError) || !this.options.approveOnce) throw error;
        // Policy mismatch alone can request owner review. All structural/budget checks still apply.
        checked = await validatePilotWalletEffects(this.client, this.options.account, state, tx, true);
        ownerApproval = true;
        await this.ownerProof(tx);
        tx.setWitnessArgs(checked.index, { ...tx.getWitnessArgs(checked.index), lock: "0x00" });
        const prepared = await this.options.owner.prepareTransaction(tx);
        tx.cellDeps = prepared.cellDeps;
        tx.witnesses = prepared.witnesses;
      }
      const quote = await this.options.paymaster.prepare(tx.clone());
      const signed = await verifySponsorQuote(
        this.client,
        tx,
        quote,
        this.options.account.poolLock,
        BigInt(this.options.account.maxFee),
      );
      if (ownerApproval) {
        if (!(await this.options.approveOnce!({ kind: "transaction", appOrigin: this.options.appOrigin,
          bytes: ccc.hexFrom(signed.toBytes()), requestId, remaining: checked.next.remaining, fee: quote.fee })))
          throw new Error("One-time approval cancelled");
        const approved = await this.options.owner.signOnlyTransaction(signed);
        if (approved.hash() !== signed.hash()) throw new Error("Owner changed reviewed transaction");
        signed.witnesses = approved.witnesses;
      } else {
        const signature = secp256k1.sign(
          ccc.bytesFrom(pilotWalletDigest(signed, checked.index)),
          ccc.bytesFrom(this.#key), { prehash: false },
        );
        signed.setWitnessArgs(checked.index, { ...signed.getWitnessArgs(checked.index),
          lock: ccc.hexFrom(ccc.bytesConcat([1], signature)) });
      }
      const r: PilotWalletReceipt = {
        id: requestId,
        requestHash,
        hash: signed.hash(),
        bytes: ccc.hexFrom(signed.toBytes()),
        quote,
        status: "signed",
        kind: "action",
        ...(checked.policyName ? { policyName: checked.policyName, policyId: checked.policyId } : {}),
        ...(ownerApproval ? { approval: "passkey" as const } : {}),
        next: checked.next,
        createdAt: Date.now(),
      };
      await this.save(j, r);
      return this.submit(j, r, false);
    });
  }
  /** Owner confirms an on-chain grant. The initial transaction anchors the account with TYPE_ID. */
  async grant(state: PilotWalletState, capacity?: bigint): Promise<ccc.Hex> {
    // Snapshot reviewed permissions/budget; sequencing is wallet-managed after settlement.
    state = structuredClone(state);
    if (this.options.account.deployment.codeHash === PILOT_WALLET_GENERAL_CODE_HASH) state.mode = "templates";
    else if (state.mode) throw new Error("Legacy account cannot grant general signing");
    return this.ownerOperation(
      "grant",
      async () => {
        if (
          state.appOrigin !== this.options.appOrigin ||
          state.publicKey !==
            ccc.hexFrom(secp256k1.getPublicKey(ccc.bytesFrom(this.#key), true))
        )
          throw new Error("Grant does not match the selected app/key");
        const anchor = await this.anchor();
        if (anchor && anchor.outputData !== "0x") {
          const bytes = ccc.bytesFrom(anchor.outputData);
          if (bytes.length < 83 || bytes[0] !== (state.mode === "templates" ? 2 : 1) || bytes[82]! < 1 ||
              bytes[82]! > MAX_DELEGATED_ACTIONS || bytes.length !== 83 + bytes[82]! * 105)
            throw new Error("Invalid live session authority; reconcile before replacing the grant");
          const sequence = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(42, true);
          state.sequence = (sequence + 1n).toString();
        } else {
          // A revoked authority has no encoded counter; retained history is a local continuity hint.
          const previous = anchor ? (await this.journal()).state?.sequence : undefined;
          state.sequence = previous === undefined ? "0" : (BigInt(previous) + 1n).toString();
        }
        const data = encodePilotWalletState(state);
        let tx: ccc.Transaction;
        if (anchor) {
          // CCC fills minimum capacities when constructing outputs with new data.
          // Check first so that it cannot silently increase a reviewed replacement's funding.
          if (
            anchor.cellOutput.capacity <
            ccc.fixedPointFrom(
              anchor.cellOutput.occupiedSize + ccc.bytesFrom(data).length,
            )
          )
            throw new Error(
              "Output below occupied capacity; choose fewer policies or fund a replacement account",
            );
          tx = ccc.Transaction.from({
            inputs: [{ previousOutput: anchor.outPoint }],
            outputs: [anchor.cellOutput],
            outputsData: [data],
          });

        } else {
          const history = await this.journal();
          if (history.state || history.receipts.some(r => r.kind === "grant" && r.status !== "requote"))
            throw new Error("Existing account authority is unavailable or closed; reconcile or recover it instead of funding it again");
          if (!capacity)
            throw new Error("Initial grant needs a funding capacity");
          tx = ccc.Transaction.from({
            outputs: [
              {
                lock: this.lock,
                type: this.options.account.stateType,
                capacity,
              },
            ],
            outputsData: [data],
          });
          if (
            capacity <
            ccc.fixedPointFrom(
              tx.outputs[0]!.occupiedSize + ccc.bytesFrom(data).length,
            )
          )
            throw new Error("Budget plus state cell capacity is required");
        }
        await this.ownerProof(tx, !anchor ? ccc.Script.from(this.options.account.stateType).args : undefined);
        if (
          !anchor &&
          ccc.hashCkb(tx.inputs[0]!.toBytes(), walletU64(0n)) !==
            ccc.Script.from(this.options.account.stateType).args
        )
          throw new Error(
            "Initial funding input changed; rebuild the unfunded descriptor",
          );
        return tx;
      },
      state,
    );
  }
  async revoke(): Promise<ccc.Hex> {
    return this.ownerOperation("revoke", async () => {
      const anchor = await this.anchor();
      if (!anchor) throw new Error("No live session authority");
      const tx = ccc.Transaction.from({
        inputs: [{ previousOutput: anchor.outPoint }],
        outputs: [anchor.cellOutput],
        outputsData: ["0x"],
      });
      await this.ownerProof(tx);
      return tx;
    });
  }
  async recover(): Promise<ccc.Hex> {
    return this.ownerOperation("recover", async () => {
      const inputs: ccc.CellInputLike[] = [];
      let capacity = 0n;
      for await (const cell of this.client.findCellsByLock(this.lock, null)) {
        if (
          cell.cellOutput.type &&
          !cell.cellOutput.type.eq(this.options.account.stateType)
        )
          continue;
        if (!cell.cellOutput.type && cell.outputData !== "0x") continue;
        if (inputs.length >= 60)
          throw new Error("Recover account in smaller batches");
        inputs.push({ previousOutput: cell.outPoint });
        capacity += cell.cellOutput.capacity;
      }
      if (!inputs.length)
        throw new Error("No ordinary account cells to recover");
      const tx = ccc.Transaction.from({
        inputs,
        outputs: [{ lock: this.options.account.ownerLock, capacity }],
        outputsData: ["0x"],
      });
      await this.ownerProof(tx);
      return tx;
    });
  }
  async signScopedMessage(
    scope: string,
    message: string,
    nonce: string,
  ): Promise<PilotScopedMessage> {
    return this.options.exclusive(async () => {
      await this.resumeUnlocked();
      const j = await this.journal();
      if (j.stopped || this.options.expiresAt <= Date.now())
        throw new Error("Session stopped or expired");
      if (
        !scope ||
        scope.length > 100 ||
        !message ||
        message.length > 16384 ||
        !/^[a-zA-Z0-9_-]{16,128}$/.test(nonce)
      )
        throw new Error("Supply a scope, bounded message and unique nonce");
      const state = j.state,
        anchor = await this.anchor();
      if (
        !state ||
        state.appOrigin !== this.options.appOrigin ||
        state.publicKey !==
          ccc.hexFrom(secp256k1.getPublicKey(ccc.bytesFrom(this.#key), true)) ||
        !anchor ||
        anchor.outputData !== encodePilotWalletState(state)
      )
        throw new Error(
          "Message scope is not authorized by the current on-chain session",
        );
      const automatic = state.policies.some(p => p.direction === "message" &&
        p.lockHash === ccc.hashCkb(ccc.bytesFrom(scope, "utf8")));
      if (!automatic && !this.options.approveOnce)
        throw new Error("Message scope is not authorized by the current on-chain session");
      const value = {
        version: automatic ? 1 as const : 2 as const,
        accountHash: this.lock.hash(),
        appOrigin: this.options.appOrigin,
        publicKey: state.publicKey,
        scope,
        message,
        nonce,
        expiresAt: this.options.expiresAt,
      };
      const hash = scopedMessageDigest(value);
      const old = j.messages?.find((m) => m.id === nonce);
      if (old && old.hash !== hash)
        throw new Error("Message nonce reused with different effects");
      let proof: Pick<PilotSessionMessage, "signature"> | Pick<PilotOwnerMessage, "passkey" | "assertion">;
      if (automatic) {
        proof = { signature: ccc.hexFrom(secp256k1.sign(ccc.bytesFrom(hash), ccc.bytesFrom(this.#key), { prehash: false })) };
      } else {
        if (!(await this.options.approveOnce!({kind: "message", appOrigin: this.options.appOrigin, scope, message, nonce})))
          throw new Error("One-time approval cancelled");
        const assertion = await this.options.owner.assert(hash);
        if (!verifyPilotAssertion(this.options.owner.passkey, hash, assertion))
          throw new Error("Invalid one-time owner assertion");
        proof = { passkey: this.options.owner.passkey, assertion };
      }
      if (!old)
        (j.messages ??= []).push({
          id: nonce,
          appOrigin: this.options.appOrigin,
          scope,
          hash,
          createdAt: Date.now(),
        });
      await this.options.journal.save(j);
      return { ...value, ...proof } as PilotScopedMessage;
    });
  }
  private async anchor(): Promise<ccc.Cell | undefined> {
    // A confirmed transaction can be ahead of the indexer after disconnect/reload.
    const journal = await this.options.journal.load();
    for (const receipt of [...(journal?.receipts ?? [])].reverse()) {
      if (ccc.Transaction.fromBytes(receipt.bytes).hash() !== receipt.hash)
        throw new Error("Corrupt wallet receipt");
      const tx = ccc.Transaction.fromBytes(receipt.bytes);
      for (const [index, output] of tx.outputs.entries()) {
        if (!output.lock.eq(this.lock) || !output.type?.eq(this.options.account.stateType)) continue;
        const cell = await this.client.getCellLive({txHash: receipt.hash, index}, true);
        if (cell?.cellOutput.lock.eq(this.lock) && cell.cellOutput.type?.eq(this.options.account.stateType)) return cell;
      }
    }
    for await (const cell of this.client.findCellsByLock(this.lock, null))
      if (
        cell.cellOutput.type?.eq(this.options.account.stateType) &&
        (await this.client.getCellLive(cell.outPoint, true))
      )
        return cell;
    return undefined;
  }
  private async ownerProof(tx: ccc.Transaction, initialTypeId?: ccc.Hex) {
    let proof: ccc.Cell | undefined;
    for await (const cell of this.client.findCellsByLock(
      this.options.account.ownerLock,
      null,
    ))
      if (
        !cell.cellOutput.type &&
        cell.outputData === "0x" &&
        (!initialTypeId || ccc.hashCkb(ccc.CellInput.from({ previousOutput: cell.outPoint }).toBytes(), walletU64(0n)) === initialTypeId) &&
        (await this.client.getCellLive(cell.outPoint, true))
      ) {
        proof = cell;
        break;
      }
    if (!proof)
      throw new Error(
        initialTypeId ? "The unfunded account seed is no longer live; prepare a replacement unfunded descriptor" :
        "Fund the passkey owner address first; an ordinary owner proof cell is required",
      );
    const already = tx.inputs.some((i) => i.previousOutput.eq(proof!.outPoint));
    if (!already) {
      const hasAccountInput = tx.inputs.length > 0;
      tx.inputs.push(ccc.CellInput.from({ previousOutput: proof.outPoint }));
      if (hasAccountInput) {
        tx.outputs.push(
          ccc.CellOutput.from({
            lock: this.options.account.ownerLock,
            capacity: proof.cellOutput.capacity,
          }),
        );
        tx.outputsData.push("0x");
      }
    }
    await tx.completeInputsByCapacity(this.options.owner);
    await tx.completeFeeBy(this.options.owner, 0n);
  }
  private async ownerOperation(
    kind: "grant" | "revoke" | "recover",
    build: () => Promise<ccc.Transaction>,
    next?: PilotWalletState,
  ) {
    return this.options.exclusive(async () => {
      await this.verify();
      let j = await this.options.journal.load();
      if (!j) {
        j = { accountHash: this.lock.hash(), stopped: true, receipts: [] };
        await this.options.journal.save(j);
      }
      if (j.accountHash !== this.lock.hash())
        throw new Error("Account journal mismatch");
      j.stopped = true;
      await this.options.journal.save(j);
      await this.resumeUnlocked();
      j = await this.journal();
      let tx = await build();
      tx.cellDeps.push(
        ccc.CellDep.from(deploymentDep(this.options.account.deployment)),
      );
      for (let i = tx.witnesses.length; i < tx.inputs.length; i++)
        tx.witnesses.push("0x");
      for (const [i, v] of tx.inputs.entries())
        if (
          (await this.client.getCell(v.previousOutput))?.cellOutput.lock.eq(
            this.lock,
          )
        ) {
          tx.setWitnessArgs(i, { ...tx.getWitnessArgs(i), lock: "0x00" });
          break;
        }
      tx = await this.options.owner.prepareTransaction(tx);
      for (const [i, output] of tx.outputs.entries()) {
        if (
          output.capacity <
          ccc.fixedPointFrom(
            output.occupiedSize + ccc.bytesFrom(tx.outputsData[i]!).length,
          )
        )
          throw new Error(
            "Output below occupied capacity; choose fewer policies or recover and fund a replacement account",
          );
      }
      const quote = await this.options.paymaster.prepare(tx.clone());
      const sponsored = await verifySponsorQuote(
        this.client,
        tx,
        quote,
        this.options.account.poolLock,
        BigInt(this.options.account.maxFee),
      );
      const signed = await this.options.owner.signOnlyTransaction(sponsored);
      if (signed.hash() !== sponsored.hash())
        throw new Error("Owner changed reviewed transaction");
      const r: PilotWalletReceipt = {
        id: crypto.randomUUID(),
        requestHash: ccc.hashCkb(tx.toBytes()),
        hash: signed.hash(),
        bytes: ccc.hexFrom(signed.toBytes()),
        quote,
        status: "signed",
        kind,
        next,
        createdAt: Date.now(),
      };
      await this.save(j, r);
      await this.submit(j, r, true);
      j = await this.journal();
      if (kind === "grant") {
        j.stopped = false;
        await this.options.journal.save(j);
      }
      return r.hash;
    });
  }
}

interface PilotMessageFields {
  version: 1 | 2;
  accountHash: ccc.Hex;
  appOrigin: string;
  publicKey: ccc.Hex;
  scope: string;
  message: string;
  nonce: string;
  expiresAt: number;
}
export interface PilotSessionMessage extends PilotMessageFields { version: 1; signature: ccc.Hex }
/** One action authorized by the recovery passkey, without adding a session permission. */
export interface PilotOwnerMessage extends PilotMessageFields { version: 2; passkey: PilotPasskey; assertion: PilotAssertion }
export type PilotScopedMessage = PilotSessionMessage | PilotOwnerMessage;
function scopedMessageDigest(
  value: PilotMessageFields,
): ccc.Hex {
  return ccc.hashCkb(
    ccc.bytesFrom(
      "owl-pilot-scoped-message-v1\n" +
        JSON.stringify([
          value.version,
          value.accountHash,
          value.appOrigin,
          value.publicKey,
          value.scope,
          value.message,
          value.nonce,
          value.expiresAt,
        ]),
      "utf8",
    ),
  );
}
/** The API must additionally check its expected account identity, nonce uniqueness and business rules. */
export async function verifyPilotScopedMessage(
  client: ccc.Client,
  account: PilotWalletDescriptor,
  state: PilotWalletState,
  value: PilotScopedMessage,
  expected: { appOrigin: string; scope: string; nonce: string; now?: number },
): Promise<boolean> {
  try {
    if (
      ![1, 2].includes(value.version) ||
      value.accountHash !== pilotWalletLock(account).hash() ||
      value.appOrigin !== expected.appOrigin ||
      state.appOrigin !== expected.appOrigin ||
      value.scope !== expected.scope ||
      value.nonce !== expected.nonce ||
      value.expiresAt <= (expected.now ?? Date.now()) ||
      value.publicKey !== state.publicKey ||
      (value.version === 1 && !state.policies.some(
        (p) => p.direction === "message" &&
          p.lockHash === ccc.hashCkb(ccc.bytesFrom(value.scope, "utf8")),
      ))
    )
      return false;
    await verifyDeployment(client, account.deployment);
    let live = false;
    for await (const cell of client.findCellsByLock(
      pilotWalletLock(account),
      null,
    ))
      if (
        cell.cellOutput.type?.eq(account.stateType) &&
        cell.outputData === encodePilotWalletState(state) &&
        (await client.getCellLive(cell.outPoint, true))
      ) {
        live = true;
        break;
      }
    if (!live) return false;
    if (value.version === 2)
      return pilotPasskeyLock(value.passkey).eq(account.ownerLock) &&
        verifyPilotAssertion(value.passkey, scopedMessageDigest(value), value.assertion);
    return secp256k1.verify(
      ccc.bytesFrom(value.signature),
      ccc.bytesFrom(scopedMessageDigest(value)),
      ccc.bytesFrom(state.publicKey),
      { prehash: false },
    );
  } catch {
    return false;
  }
}
export async function verifyPilotWalletOwnership(
  client: ccc.Client,
  account: PilotWalletDescriptor,
  fundingHash: ccc.Hex,
): Promise<boolean> {
  await verifyDeployment(client, account.deployment);
  const tx = await client.getTransactionNoCache(fundingHash);
  if (
    tx?.status !== "committed" ||
    tx.transaction.hash() !== fundingHash ||
    !tx.transaction.outputs.some(
      (o) =>
        o.lock.eq(pilotWalletLock(account)) && o.type?.eq(account.stateType),
    )
  )
    return false;
  for (const input of tx.transaction.inputs)
    if (
      (await client.getCell(input.previousOutput))?.cellOutput.lock.eq(
        account.ownerLock,
      )
    )
      return true;
  return false;
}
