import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { ccc } from "@ckb-ccc/core";
import { p256 } from "@noble/curves/nist.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  PilotPasskeySigner,
  pilotPasskeyLock,
  pilotPasskeyDigest,
  base64url,
  verifyPilotAssertion,
  parsePilotPasskey,
  type PilotPasskey,
  type PilotAssertion,
} from "../src/wallet/passkey.js";
import {
  PilotWalletSession,
  createPilotWalletDescriptor,
  encodePilotWalletState,
  pilotWalletLock,
  parsePilotWalletDescriptor,
  pilotWalletDigest,
  validatePilotWalletEffects,
  validatePilotPolicies,
  validatePilotPolicyCatalog,
  buildPilotWalletTransaction,
  verifyPilotScopedMessage,
  verifyPilotWalletOwnership,
  type PilotWalletState,
  type PilotWalletJournal,
  type PilotWalletOptions,
  type PilotCellPolicy,
} from "../src/wallet/session.js";

test('hosted wallet offers 50 policies while encoded grants still enforce the 16-policy limit', () => {
  const policies: PilotCellPolicy[] = Array.from({ length: 50 }, (_, i) => ({ name: `Action ${i}`, direction: 'message', lockHash: `0x${'01'.repeat(32)}`, typeHash: `0x${'00'.repeat(32)}`, dataHash: `0x${'00'.repeat(32)}`, maxCapacity: '1' }));
  assert.doesNotThrow(() => validatePilotPolicyCatalog(policies));
  assert.doesNotThrow(() => validatePilotPolicies(policies.slice(-16)));
  assert.throws(() => validatePilotPolicies(policies.slice(-17)), /1 and 16/);
  assert.throws(() => validatePilotPolicyCatalog([...policies, policies[0]!]), /1 and 50/);
  const malformed = structuredClone(policies); malformed[49]!.lockHash = '0x01';
  assert.throws(() => validatePilotPolicyCatalog(malformed), /full 32-byte/);
});
import {
  PILOT_LEGACY_PASSKEY_CODE_HASH,
  PILOT_PASSKEY_CODE_HASH,
  PILOT_WALLET_SESSION_CODE_HASH,
} from "../src/wallet/code.js";
import {
  isPilotWalletEnvelope,
  PILOT_WALLET_PROTOCOL,
} from "../src/wallet/provider.js";
import type { Deployment } from "../src/ckb/counter.js";
const h = (n: number) => ccc.hexFrom(new Uint8Array(32).fill(n)),
  zero = h(0);
const passkey: PilotPasskey = {
  codeHash: PILOT_PASSKEY_CODE_HASH,
  credentialId: base64url(new Uint8Array([1, 2, 3])),
  publicKey: ccc.hexFrom(p256.getPublicKey(ccc.bytesFrom(h(3)), true)),
  rpId: "wallet.pilot.example",
  origin: "https://wallet.pilot.example",
  name: "Alice",
};
function assertion(
  challenge: ccc.Hex,
  changes: Record<string, unknown> = {},
  flags = 5,
): PilotAssertion {
  const auth = ccc.bytesConcat(
    sha256(new TextEncoder().encode(passkey.rpId)),
    [flags],
    new Uint8Array(4),
  );
  const json = new TextEncoder().encode(
    JSON.stringify({
      type: "webauthn.get",
      origin: passkey.origin,
      challenge: base64url(ccc.bytesFrom(challenge)),
      crossOrigin: false,
      ...changes,
    }),
  );
  const sig = p256.sign(
    sha256(ccc.bytesConcat(auth, sha256(json))),
    ccc.bytesFrom(h(3)),
    { prehash: false, lowS: false },
  );
  return {
    authenticatorData: ccc.hexFrom(auth),
    clientDataJSON: ccc.hexFrom(json),
    signature: ccc.hexFrom(sig),
  };
}
async function fixture(t: TestContext, initial = true) {
  const client = new ccc.ClientPublicTestnet();
  const pool = (
    await new ccc.SignerCkbPrivateKey(client, h(2)).getRecommendedAddressObj()
  ).script;
  const recipient = (
    await new ccc.SignerCkbPrivateKey(client, h(4)).getRecommendedAddressObj()
  ).script;
  const genesisHash =
    "0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606" as ccc.Hex;
  const deploy = (codeHash: ccc.Hex, n: number): Deployment => ({
    network: "testnet",
    genesisHash,
    codeHash,
    outPoint: { txHash: h(n), index: 0 },
  });
  const ownerDeployment = deploy(PILOT_PASSKEY_CODE_HASH, 8),
    sessionDeployment = deploy(PILOT_WALLET_SESSION_CODE_HASH, 9);
  const cells: ccc.Cell[] = [];
  const all: ccc.Cell[] = [];
  const receipts = new Map<
    string,
    { status: string; transaction: ccc.Transaction }
  >();
  for (const [d, name] of [
    [ownerDeployment, "pilot-passkey-lock"],
    [sessionDeployment, "pilot-wallet-session-lock"],
  ] as const) {
    const cell = ccc.Cell.from({
      outPoint: d.outPoint,
      cellOutput: { lock: pool },
      outputData: await readFile("contracts/build/" + name),
    });
    cells.push(cell);
    all.push(cell);
  }
  const funding = ccc.Cell.from({
    outPoint: { txHash: h(5), index: 0 },
    cellOutput: {
      lock: pilotPasskeyLock(passkey),
      capacity: ccc.fixedPointFrom(2000),
    },
    outputData: "0x",
  });
  const poolCell = ccc.Cell.from({
    outPoint: { txHash: h(6), index: 0 },
    cellOutput: { lock: pool, capacity: ccc.fixedPointFrom(2000) },
    outputData: "0x",
  });
  cells.push(funding, poolCell);
  all.push(funding, poolCell);
  t.mock.method(client, "getHeaderByNumberNoCache", async () => ({
    hash: genesisHash,
  }));
  t.mock.method(client, "getCell", async (p: ccc.OutPointLike) =>
    all.find((c) => c.outPoint.eq(p)),
  );
  t.mock.method(client, "getCellLive", async (p: ccc.OutPointLike) =>
    cells.find((c) => c.outPoint.eq(p)),
  );
  t.mock.method(
    client,
    "findCellsByLock",
    async function* (lock: ccc.ScriptLike) {
      for (const cell of [...cells])
        if (cell.cellOutput.lock.eq(lock)) yield cell;
    },
  );
  t.mock.method(
    client,
    "findCells",
    async function* (f: { script: ccc.ScriptLike }) {
      for (const cell of [...cells])
        if (cell.cellOutput.lock.eq(f.script)) yield cell;
    },
  );
  t.mock.method(client, "getTransactionNoCache", async (hash: string) =>
    receipts.get(hash),
  );
  function commit(tx: ccc.Transaction) {
    for (const i of tx.inputs) {
      const idx = cells.findIndex((c) => c.outPoint.eq(i.previousOutput));
      if (idx >= 0) cells.splice(idx, 1);
    }
    for (const [o, index] of tx.outputs.map((o, i) => [o, i] as const)) {
      const c = ccc.Cell.from({
        outPoint: { txHash: tx.hash(), index },
        cellOutput: o,
        outputData: tx.outputsData[index]!,
      });
      cells.push(c);
      all.push(c);
    }
    receipts.set(tx.hash(), { status: "committed", transaction: tx });
  }
  const submitted = new Map<string, ccc.Transaction>();
  let lose = false;
  let signs = 0;
  let journal: PilotWalletJournal | undefined;
  let mutex = Promise.resolve();
  t.mock.method(client, "waitTransaction", async (hash: string) => {
    const tx = submitted.get(hash);
    if (tx) commit(tx);
    return receipts.get(hash);
  });
  const owner = new PilotPasskeySigner(
    client,
    passkey,
    ownerDeployment,
    async (c) => {
      signs++;
      return assertion(c);
    },
    pool,
  );
  const account = createPilotWalletDescriptor(
    pilotPasskeyLock(passkey),
    sessionDeployment,
    pool,
    100000n,
    { previousOutput: funding.outPoint },
  );
  const policies: PilotCellPolicy[] = [
    {
      name: "Pay 61 CKB",
      direction: "output",
      lockHash: recipient.hash(),
      typeHash: zero,
      dataHash: ccc.hashCkb("0x"),
      maxCapacity: ccc.fixedPointFrom(61).toString(),
    },
    {
      name: "Like posts",
      direction: "message",
      lockHash: ccc.hashCkb(ccc.bytesFrom("social.like", "utf8")),
      typeHash: zero,
      dataHash: zero,
      maxCapacity: "1",
    },
  ];
  const state: PilotWalletState = {
    publicKey: ccc.hexFrom(secp256k1.getPublicKey(ccc.bytesFrom(h(1)), true)),
    remaining: ccc.fixedPointFrom(200).toString(),
    sequence: "0",
    appOrigin: "https://game.example",
    policies,
  };
  const options: PilotWalletOptions = {
    owner,
    account,
    appOrigin: state.appOrigin,
    expiresAt: Date.now() + 60000,
    sessionKey: h(1),
    journal: {
      async load() {
        return structuredClone(journal);
      },
      async save(j) {
        journal = structuredClone(j);
      },
    },
    async exclusive(fn) {
      const prev = mutex;
      let release!: () => void;
      mutex = new Promise<void>((r) => (release = r));
      await prev;
      try {
        return await fn();
      } finally {
        release();
      }
    },
    paymaster: {
      async prepare(base) {
        const poolCell = cells.find(
          (c) => c.cellOutput.lock.eq(pool) && c.outputData === "0x",
        )!;
        const tx = base.clone();
        tx.inputs.push(
          ccc.CellInput.from({ previousOutput: poolCell.outPoint }),
        );
        tx.outputs.push(poolCell.cellOutput.clone());
        tx.outputs.at(-1)!.capacity -= 1000n;
        tx.outputsData.push("0x");
        await tx.addCellDepsOfKnownScripts(
          client,
          ccc.KnownScript.Secp256k1Blake160,
        );
        tx.setWitnessArgs(tx.inputs.length - 1, {
          lock: ccc.hexFrom(new Uint8Array(65)),
        });
        return {
          version: 1,
          id: ccc.hashCkb(tx.toBytes()),
          transactionHash: tx.hash(),
          bytes: ccc.hexFrom(tx.toBytes()),
          baseBytes: ccc.hexFrom(base.toBytes()),
          fee: "1000",
          expiresAt: Date.now() + 60000,
        };
      },
      async submit(q, tx) {
        assert.ok(
          journal?.receipts.some((r) => r.bytes === ccc.hexFrom(tx.toBytes())),
          "exact signature persisted before service receives it",
        );
        if (lose) throw new Error("Lost response");
        const final = tx.clone();
        final.setWitnessArgs(final.inputs.length - 1, {
          lock: ccc.hexFrom(new Uint8Array(65).fill(7)),
        });
        submitted.set(tx.hash(), final);
        return final;
      },
    },
  };
  const session = new PilotWalletSession(options);
  if (initial) await session.grant(state, ccc.fixedPointFrom(1200));
  return {
    client,
    pool,
    recipient,
    owner,
    account,
    state,
    options,
    session,
    cells,
    receipts,
    submitted,
    get journal() {
      return journal!;
    },
    get signs() {
      return signs;
    },
    setLose(v: boolean) {
      lose = v;
    },
    commit,
    async payment() {
      return buildPilotWalletTransaction(
        client,
        account,
        (await options.journal.load())!.state!,
        ccc.Transaction.from({
          outputs: [{ lock: recipient, capacity: ccc.fixedPointFrom(61) }],
          outputsData: ["0x"],
        }),
      );
    },
  };
}
test("passkey assertions bind type, challenge, exact origin, RP and mandatory user verification", () => {
  assert.equal(verifyPilotAssertion(passkey, h(1), assertion(h(1))), true);
  for (const a of [
    assertion(h(2)),
    assertion(h(1), { origin: "https://evil.example" }),
    assertion(h(1), { type: "webauthn.create" }),
    assertion(h(1), { crossOrigin: true }),
    assertion(h(1), {}, 1),
  ])
    assert.equal(verifyPilotAssertion(passkey, h(1), a), false);
  assert.throws(
    () => pilotPasskeyLock({ ...passkey, rpId: "evil.example" }),
    /RP ID/,
  );
});
test("owner passkey funds and authorizes initial anchored session, without an external wallet", async (t) => {
  const f = await fixture(t);
  assert.equal(f.signs, 1);
  assert.equal(f.journal.receipts[0]!.kind, "grant");
  assert.equal(f.journal.receipts[0]!.status, "confirmed");
  assert.equal(f.journal.stopped, false);
  const tx = ccc.Transaction.fromBytes(f.journal.receipts[0]!.bytes);
  assert.equal(tx.outputs[0]!.lock.hash(), pilotWalletLock(f.account).hash());
  assert.equal(
    await verifyPilotWalletOwnership(f.client, f.account, tx.hash()),
    true,
  );
  const raw = ccc.bytesFrom(tx.getWitnessArgs(0)!.lock!),
    al = new DataView(raw.buffer, raw.byteOffset).getUint16(3, true);
  assert.equal(
    verifyPilotAssertion(
      passkey,
      pilotPasskeyDigest(tx, 0, tx.inputs.length - 1),
      {
        signature: ccc.hexFrom(raw.slice(7, 71)),
        authenticatorData: ccc.hexFrom(raw.slice(71, 71 + al)),
        clientDataJSON: ccc.hexFrom(raw.slice(71 + al)),
      },
    ),
    true,
  );
});
test("automatic payment consumes authority, deducts cumulative budget and never prompts owner", async (t) => {
  const f = await fixture(t);
  const tx = await f.payment();
  const hash = await f.session.sendTransaction(tx, "buy-123");
  assert.equal(f.signs, 1);
  const r = f.journal.receipts.at(-1)!;
  assert.equal(r.status, "submitted");
  const signed = ccc.Transaction.fromBytes(r.bytes);
  assert.equal(
    secp256k1.verify(
      ccc.bytesFrom(signed.getWitnessArgs(0)!.lock!).slice(1),
      ccc.bytesFrom(pilotWalletDigest(signed, 0)),
      ccc.bytesFrom(f.state.publicKey),
      { prehash: false },
    ),
    true,
  );
  await f.session.resume();
  assert.equal(f.journal.state!.remaining, ccc.fixedPointFrom(139).toString());
  assert.equal(f.journal.state!.sequence, "1");
  assert.equal(await f.session.sendTransaction(tx, "buy-123"), hash);
  assert.equal(f.journal.receipts.length, 2);
});
test("unapproved effects, raised budgets, stale state and expired sessions fail before signing", async (t) => {
  const f = await fixture(t);
  const wrong = await f.payment();
  wrong.outputs[0]!.lock = pilotPasskeyLock(passkey);
  await assert.rejects(f.session.sendTransaction(wrong, "wrong"), /policies/);
  const changed = await f.payment();
  const state = {
    ...f.state,
    remaining: ccc.fixedPointFrom(999).toString(),
    sequence: "1",
  };
  changed.outputsData[1] = encodePilotWalletState(state);
  await assert.rejects(
    f.session.sendTransaction(changed, "changed"),
    /state changed/,
  );
  const expired = new PilotWalletSession({ ...f.options, expiresAt: 0 });
  await assert.rejects(
    expired.sendTransaction(await f.payment(), "expired"),
    /expired/,
  );
  await assert.rejects(f.session.signOnlyTransaction(), /isolated/);
  assert.equal(f.journal.receipts.length, 1);
});
test("lost responses retain exact signed bytes and block new actions until reconciliation", async (t) => {
  const f = await fixture(t);
  f.setLose(true);
  const tx = await f.payment();
  await assert.rejects(f.session.sendTransaction(tx, "lost"), /Lost response/);
  const bytes = f.journal.receipts.at(-1)!.bytes;
  await assert.rejects(f.session.revoke(), /Lost response/);
  assert.equal(f.journal.stopped, true);
  assert.equal(f.journal.receipts.length, 2);
  f.setLose(false);
  await f.session.resume();
  assert.equal(f.journal.receipts.at(-1)!.status, "confirmed");
  assert.equal(
    ccc.Transaction.fromBytes(bytes).hash(),
    f.journal.receipts.at(-1)!.hash,
  );
  await assert.rejects(
    f.session.sendTransaction(await f.payment(), "after-stop"),
    /stopped/,
  );
});
test("storage failure prevents exposing session signatures to the service", async (t) => {
  const f = await fixture(t);
  const count = f.submitted.size;
  t.mock.method(f.options.journal, "save", async () => {
    throw new Error("Storage full");
  });
  await assert.rejects(
    f.session.sendTransaction(await f.payment(), "storage"),
    /Storage full/,
  );
  assert.equal(f.submitted.size, count);
});
test("owner can revoke on-chain or recover after losing every session private key", async (t) => {
  const f = await fixture(t);
  const recovered = new PilotWalletSession({
    ...f.options,
    sessionKey: h(7),
    expiresAt: 0,
  });
  await recovered.revoke();
  assert.equal(f.signs, 2);
  assert.equal(f.journal.stopped, true);
  const stateCell = f.cells.find((c) =>
    c.cellOutput.type?.eq(f.account.stateType),
  );
  assert.equal(stateCell!.outputData, "0x");
  await recovered.recover();
  assert.equal(f.signs, 3);
  assert.equal(
    f.cells.some((c) => c.cellOutput.lock.eq(pilotWalletLock(f.account))),
    false,
  );
});
test("scoped messages bind app, scope and nonce; revoked chain state invalidates verification", async (t) => {
  const f = await fixture(t);
  const value = await f.session.signScopedMessage(
    "social.like",
    "post:123",
    "nonce_1234567890123456",
  );
  assert.equal(f.signs, 1);
  assert.equal(
    await verifyPilotScopedMessage(f.client, f.account, f.state, value, {
      appOrigin: f.state.appOrigin,
      scope: "social.like",
      nonce: value.nonce,
    }),
    true,
  );
  assert.equal(
    await verifyPilotScopedMessage(f.client, f.account, f.state, value, {
      appOrigin: "https://evil.example",
      scope: "social.like",
      nonce: value.nonce,
    }),
    false,
  );
  await assert.rejects(
    f.session.signScopedMessage(
      "social.delete",
      "post:123",
      "nonce_1234567890123457",
    ),
    /not authorized/,
  );
  await assert.rejects(
    f.session.signScopedMessage("social.like", "post:456", value.nonce),
    /reused/,
  );
  assert.equal(JSON.stringify(f.journal.messages).includes("post:123"), false);
  await f.session.revoke();
  assert.equal(
    await verifyPilotScopedMessage(f.client, f.account, f.state, value, {
      appOrigin: f.state.appOrigin,
      scope: "social.like",
      nonce: value.nonce,
    }),
    false,
  );
});
test("wallet state encoding pins policies, app, key and amounts; envelope checks reject other channels", () => {
  const policy: PilotCellPolicy = {
    name: "Like",
    direction: "message",
    lockHash: h(1),
    typeHash: zero,
    dataHash: zero,
    maxCapacity: "1",
  };
  assert.throws(
    () =>
      encodePilotWalletState({
        publicKey: h(1),
        appOrigin: "https://game.example",
        remaining: "1",
        sequence: "0",
        policies: [policy],
      }),
    /key/,
  );
  assert.equal(
    isPilotWalletEnvelope(
      {
        protocol: PILOT_WALLET_PROTOCOL,
        channel: "a",
        id: "1",
        method: "connect",
      },
      "a",
    ),
    true,
  );
  assert.equal(
    isPilotWalletEnvelope(
      {
        protocol: PILOT_WALLET_PROTOCOL,
        channel: "b",
        id: "1",
        method: "connect",
      },
      "a",
    ),
    false,
  );
});

test("public passkey imports discard secret/unknown fields and reject invalid credential metadata", () => {
  assert.deepEqual(
    parsePilotPasskey({
      ...passkey,
      privateKey: "must-not-store",
      extra: "discard",
    }),
    passkey,
  );
  assert.throws(
    () => parsePilotPasskey({ ...passkey, credentialId: "../../secret" }),
    /descriptor/,
  );
  assert.throws(() => parsePilotPasskey({}), /descriptor/);
});

test("replacing a session keeps the address but invalidates the old app/key; public import drops extra fields", async (t) => {
  const f = await fixture(t);
  const replacement = new PilotWalletSession({
    ...f.options,
    sessionKey: h(7),
    appOrigin: "https://other.example",
  });
  const next = {
    ...f.state,
    publicKey: replacement.publicKey,
    appOrigin: "https://other.example",
    remaining: ccc.fixedPointFrom(100).toString(),
    sequence: "1",
  };
  await replacement.grant(next);
  assert.equal(
    await replacement.getRecommendedAddress(),
    await f.session.getRecommendedAddress(),
  );
  assert.equal(await f.session.isConnected(), false);
  assert.equal(await replacement.isConnected(), true);
  await assert.rejects(f.session.endAppAccess(), /replaced/);
  await assert.rejects(
    f.session.prepareAppTransaction(
      ccc.Transaction.from({
        outputs: [{ lock: f.recipient, capacity: ccc.fixedPointFrom(61) }],
        outputsData: ["0x"],
      }),
    ),
    /replaced/,
  );
  assert.equal(f.journal.stopped, false);
  await assert.rejects(
    f.session.sendTransaction(await f.payment(), "old-app"),
    /another key or app/,
  );
  await assert.rejects(
    f.session.signScopedMessage(
      "social.like",
      "post:123",
      "nonce_1234567890123456",
    ),
    /not authorized/,
  );
  const parsed = parsePilotWalletDescriptor({
    ...f.account,
    privateKey: "discard",
    deployment: { ...f.account.deployment, secret: "discard" },
  });
  assert.equal(JSON.stringify(parsed).includes("discard"), false);
  assert.equal(
    pilotWalletLock(parsed).hash(),
    pilotWalletLock(f.account).hash(),
  );
});

test("public descriptor plus passkey recovers with no session key or journal and preserves typed assets", async (t) => {
  const f = await fixture(t);
  const typed = ccc.Cell.from({
    outPoint: { txHash: h(44), index: 0 },
    cellOutput: {
      lock: pilotWalletLock(f.account),
      type: f.recipient,
      capacity: ccc.fixedPointFrom(300),
    },
    outputData: "0x1234",
  });
  f.cells.push(typed);
  let restored: PilotWalletJournal | undefined;
  const recovery = new PilotWalletSession({
    ...f.options,
    sessionKey: h(7),
    expiresAt: 0,
    journal: {
      async load() {
        return structuredClone(restored);
      },
      async save(j) {
        restored = structuredClone(j);
      },
    },
  });
  // The fixture service checks persistence against the original journal; add an independent receipt assertion for this fresh store.
  recovery.options.paymaster = {
    ...f.options.paymaster,
    async submit(quote, tx) {
      assert.equal(restored!.receipts.at(-1)!.bytes, ccc.hexFrom(tx.toBytes()));
      const signed = tx.clone();
      signed.setWitnessArgs(signed.inputs.length - 1, {
        lock: ccc.hexFrom(new Uint8Array(65).fill(7)),
      });
      f.submitted.set(signed.hash(), signed);
      return signed;
    },
  };
  await recovery.recover();
  assert.equal(restored!.receipts[0]!.status, "confirmed");
  assert.equal(
    f.cells.some((c) => c.outPoint.eq(typed.outPoint)),
    true,
  );
  assert.equal(
    f.cells.filter((c) => c.cellOutput.lock.eq(pilotWalletLock(f.account)))
      .length,
    1,
  );
  assert.equal(f.signs, 2);
});

test("an oversized replacement policy state is rejected before asking the passkey to sign", async (t) => {
  const f = await fixture(t);
  const policies = Array.from({ length: 16 }, (_, i) => ({
    name: `Scope ${i}`,
    direction: "message" as const,
    lockHash: h(i + 1),
    typeHash: zero,
    dataHash: zero,
    maxCapacity: "1",
  }));
  await assert.rejects(
    f.session.grant({ ...f.state, sequence: "1", policies }),
    /occupied capacity/,
  );
  assert.equal(f.signs, 1);
  assert.equal(f.journal.receipts.length, 1);
});

test("embedded assertions bind the signed top origin and preserve legacy account addresses", () => {
  const top = "https://fon.example";
  const proof = assertion(h(1), { crossOrigin: true, topOrigin: top });
  assert.equal(verifyPilotAssertion(passkey, h(1), proof, top), true);
  assert.equal(verifyPilotAssertion(passkey, h(1), proof, "https://evil.example"), false);
  assert.equal(verifyPilotAssertion(passkey, h(1), assertion(h(1)), top), false);
  for (const topOrigin of [undefined, "null", "http://evil.example", "https://fon.example/path", "https://fon.example@evil.example"]) {
    assert.equal(verifyPilotAssertion(passkey, h(1), assertion(h(1), { crossOrigin: true, topOrigin })), false);
  }
  assert.equal(verifyPilotAssertion(passkey, h(1), assertion(h(1), { topOrigin: top })), false);
  const old = { ...passkey, codeHash: PILOT_LEGACY_PASSKEY_CODE_HASH };
  assert.equal(verifyPilotAssertion(old, h(1), proof, top), false);
  assert.equal(verifyPilotAssertion(old, h(1), assertion(h(1))), true);
  const {codeHash, ...originalDescriptor} = passkey;
  assert.equal(pilotPasskeyLock(parsePilotPasskey(originalDescriptor)).codeHash, PILOT_LEGACY_PASSKEY_CODE_HASH);
  assert.notEqual(pilotPasskeyLock(old).hash(), pilotPasskeyLock(passkey).hash());
});

test("one-time passkey transaction approval preserves the session and journals exact retries", async (t) => {
  const f = await fixture(t);
  let reviews = 0;
  f.options.approveOnce = async review => {
    assert.equal(review.kind, "transaction");
    if (review.kind === "transaction") {
      const tx = ccc.Transaction.fromBytes(review.bytes);
      assert.equal(tx.getWitnessArgs(0)?.lock, "0x00");
      assert.equal(review.remaining, ccc.fixedPointFrom(139).toString());
    }
    reviews++;
    return true;
  };
  const destination = f.recipient.clone(); destination.args = ccc.hexFrom(new Uint8Array(20).fill(77));
  const tx = await f.session.prepareAppTransaction({ outputs: [{ lock: destination, capacity: ccc.fixedPointFrom(61) }], outputsData: ["0x"] });
  assert.equal(reviews, 0, "preparation never signs or prompts");
  const hash = await f.session.sendTransaction(tx, "manual-1");
  assert.equal(reviews, 1);
  assert.equal(f.signs, 2);
  assert.equal(f.journal.receipts.at(-1)!.approval, "passkey");
  assert.equal(f.journal.stopped, false);
  await f.session.resume();
  assert.deepEqual(f.journal.state!.policies, f.state.policies);
  assert.equal(f.journal.state!.publicKey, f.state.publicKey);
  assert.equal(await f.session.sendTransaction(tx, "manual-1"), hash);
  assert.equal(reviews, 1, "exact retry does not ask again");
  await f.session.sendTransaction(await f.payment(), "automatic-after-manual");
  assert.equal(f.signs, 2, "later selected actions remain automatic");
});

test("cancelled one-time actions leave the connection, authority and receipts intact", async (t) => {
  const f = await fixture(t);
  f.options.approveOnce = async () => false;
  const tx = await f.payment(); tx.outputs[0]!.lock.args = ccc.hexFrom(new Uint8Array(20).fill(77));
  await assert.rejects(f.session.sendTransaction(tx, "cancelled"), /cancelled/);
  await assert.rejects(f.session.signScopedMessage("social.delete", "post:123", "cancel_nonce_12345678"), /cancelled/);
  assert.equal(f.signs, 1);
  assert.equal(f.journal.receipts.length, 1);
  assert.equal(f.journal.messages?.length ?? 0, 0);
  assert.equal(f.journal.stopped, false);
  assert.deepEqual(f.journal.state, f.state);
});

test("one-time review cannot bypass budget, authority integrity or select recovery funds", async (t) => {
  const f = await fixture(t);
  let reviews = 0;
  f.options.approveOnce = async () => { reviews++; return true; };
  const tx = await f.payment(); tx.outputs[0]!.lock.args = ccc.hexFrom(new Uint8Array(20).fill(77));
  const raised = tx.clone();
  raised.outputsData[1] = encodePilotWalletState({ ...f.state, remaining: ccc.fixedPointFrom(300).toString(), sequence: "1" });
  await assert.rejects(f.session.sendTransaction(raised, "raise"), /budget\/sequence/);
  const drained = tx.clone();
  drained.outputs[0]!.capacity += ccc.fixedPointFrom(150);
  drained.outputs[1]!.capacity -= ccc.fixedPointFrom(150);
  await assert.rejects(f.session.sendTransaction(drained, "drain"), /budget exceeded/);
  const proof = f.cells.find(c => c.cellOutput.lock.eq(f.account.ownerLock))!;
  const ownerInput = tx.clone(); ownerInput.inputs.push(ccc.CellInput.from({previousOutput: proof.outPoint}));
  await assert.rejects(f.session.sendTransaction(ownerInput, "owner-input"), /recovery-owner inputs/);
  assert.equal(reviews, 0);
  assert.equal(f.signs, 1);
});

test("unselected messages use an owner-bound proof; edits, wrong owner and revocation fail", async (t) => {
  const f = await fixture(t);
  f.options.approveOnce = async review => { assert.equal(review.kind, "message"); return true; };
  const value = await f.session.signScopedMessage("social.delete", "post:123", "manual_nonce_12345678");
  assert.equal(value.version, 2);
  const expected = { appOrigin: f.state.appOrigin, scope: value.scope, nonce: value.nonce };
  assert.equal(await verifyPilotScopedMessage(f.client, f.account, f.state, value, expected), true);
  assert.equal(await verifyPilotScopedMessage(f.client, f.account, f.state, { ...value, message: "post:456" }, expected), false);
  if (value.version !== 2) throw new Error("Expected owner proof");
  const impostor = { ...value, passkey: { ...value.passkey, publicKey: ccc.hexFrom(p256.getPublicKey(ccc.bytesFrom(h(4)), true)) } };
  assert.equal(await verifyPilotScopedMessage(f.client, f.account, f.state, impostor, expected), false);
  await assert.rejects(f.session.signScopedMessage(value.scope, "post:456", value.nonce), /reused/);
  assert.equal(f.signs, 2);
  assert.deepEqual(f.journal.state!.policies, f.state.policies);
  await f.session.revoke();
  assert.equal(await verifyPilotScopedMessage(f.client, f.account, f.state, value, expected), false);
});

test("disconnect and reauthentication resume the retained grant without funding, signing or resetting limits", async (t) => {
  const f = await fixture(t);
  await f.session.sendTransaction(await f.payment(), "before-logout");
  await f.session.endAppAccess();
  const saved = structuredClone(f.journal.state);
  const reconnected = new PilotWalletSession(f.options);
  assert.equal(await reconnected.isConnected(), false);
  const state = await reconnected.resumeAppAccess();
  assert.deepEqual(state, saved);
  assert.equal(await reconnected.isConnected(), true);
  assert.equal(f.journal.receipts.length, 2);
  assert.equal(f.signs, 1, "resumption creates no owner transaction");
  assert.equal(state.remaining, ccc.fixedPointFrom(139).toString());
  await reconnected.sendTransaction(await f.payment(), "after-login");
  assert.equal(f.signs, 1);
});

test("resuming uses live receipt outputs while the indexer lags behind the confirmed grant", async (t) => {
  const f = await fixture(t);
  await f.session.endAppAccess();
  t.mock.method(f.client, "findCellsByLock", async function* (lock: ccc.ScriptLike) {
    for (const cell of f.cells)
      if (cell.cellOutput.lock.eq(lock) && !cell.cellOutput.type?.eq(f.account.stateType)) yield cell;
  });
  await f.session.resumeAppAccess();
  const tx = await f.session.prepareAppTransaction({ outputs: [{ lock: f.recipient, capacity: ccc.fixedPointFrom(61) }], outputsData: ["0x"] });
  await f.session.sendTransaction(tx, "indexer-lag");
  assert.equal(f.signs, 1);
});

test("expired, revoked and mismatched saved sessions cannot be resumed", async (t) => {
  const f = await fixture(t);
  await f.session.endAppAccess();
  await assert.rejects(new PilotWalletSession({ ...f.options, expiresAt: Date.now() - 1 }).resumeAppAccess(), /expired/);
  await assert.rejects(new PilotWalletSession({ ...f.options, appOrigin: "https://other.example" }).resumeAppAccess(), /another app\/key/);
  await assert.rejects(new PilotWalletSession({ ...f.options, sessionKey: h(2) }).resumeAppAccess(), /another app\/key/);
  assert.equal(f.journal.stopped, true);
  await f.session.revoke();
  await assert.rejects(f.session.resumeAppAccess(), /revoked or changed/);
  assert.equal(f.journal.stopped, true);
});

test("closed funded accounts cannot fall back to initial funding", async (t) => {
  const f = await fixture(t);
  await f.session.recover();
  const signs = f.signs;
  await assert.rejects(f.session.grant({ ...f.state, sequence: "1" }, ccc.fixedPointFrom(1200)), /instead of funding it again/);
  assert.equal(f.signs, signs);
});

test("initial funding selects its exact TYPE_ID seed despite owner-cell indexer reordering", async (t) => {
  const f = await fixture(t, false);
  f.cells.unshift(ccc.Cell.from({outPoint:{txHash:h(87),index:0}, cellOutput:{lock:f.account.ownerLock,capacity:ccc.fixedPointFrom(2000)},outputData:"0x"}));
  await f.session.grant(f.state, ccc.fixedPointFrom(1200));
  const receipt = f.journal.receipts[0]!;
  const tx = ccc.Transaction.fromBytes(receipt.bytes);
  assert.equal(ccc.hashCkb(tx.inputs[0]!.toBytes(), new Uint8Array(8)), ccc.Script.from(f.account.stateType).args);
  assert.equal(f.signs, 1);
});
