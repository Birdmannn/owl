import "./style.css";
import { ccc } from "@ckb-ccc/core";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
  createPilotPasskey,
  parsePilotPasskey,
  requestPilotAssertion,
  pilotPasskeyLock,
  PilotPasskeySigner,
  canonicalWalletOrigin,
  type PilotPasskey,
} from "../../../src/wallet/passkey";
import {
  PILOT_WALLET_PROTOCOL,
  isPilotWalletEnvelope,
  type PilotWalletConnect,
  type PilotWalletConnection,
  type PilotWalletEnvelope,
} from "../../../src/wallet/provider";
import {
  PilotWalletSession,
  createPilotWalletDescriptor,
  encodePilotWalletState,
  pilotWalletLock,
  parsePilotWalletDescriptor,
  validatePilotPolicies,
  type PilotWalletDescriptor,
  type PilotWalletJournal,
  type PilotWalletState,
} from "../../../src/wallet/session";
import { PilotPaymasterClient } from "../../../src/paymaster";
import type { Deployment } from "../../../src/ckb/counter";
import deployment from "../../../deployments/pilot-sponsored.json";
const config = deployment as unknown as {
  passkey?: Deployment | null;
  walletSession?: Deployment | null;
  poolLock: ccc.ScriptLike;
};
const client = new ccc.ClientPublicTestnet({
  url: import.meta.env.VITE_PILOT_WALLET_RPC ?? "https://testnet.ckb.dev",
});
const maxFee = BigInt(import.meta.env.VITE_PILOT_WALLET_MAX_FEE ?? "100000");
const paymasterUrl = import.meta.env.VITE_PILOT_PAYMASTER_URL as
  string | undefined;
const root = document.querySelector<HTMLElement>("#app")!;
function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  parent: HTMLElement = root,
) {
  const e = document.createElement(tag);
  if (text) e.textContent = text;
  parent.append(e);
  return e;
}
node("small", "OWL / PILOT WALLET");
node("h1", "Your account. Your permissions.");
node(
  "p",
  "Use a Pilot passkey to own your account. Apps receive a connection, never your owner private key or session private keys.",
);
node(
  "p",
  "Testnet preview: session keys are stored on this wallet origin and remain accessible to its own scripts. Keep this origin trusted. Only one on-chain session is active per account.",
).className = "warning";
const error = node("p");
error.id = "error";
error.setAttribute("role", "alert");
const status = node("p");
status.id = "status";
status.setAttribute("role", "status");
const params = new URLSearchParams(location.search);
let appOrigin = "";
const channel = params.get("channel") ?? "";
try {
  if (params.has("appOrigin"))
    appOrigin = canonicalWalletOrigin(params.get("appOrigin")!);
} catch {
  error.textContent = "Invalid requesting app origin";
}
const opener = window.opener as Window | null;
if (window.self !== window.top)
  throw new Error("Open Pilot as a top-level wallet popup");
if (appOrigin) node("p", appOrigin).className = "origin";
const ready = !!config.passkey && !!config.walletSession && !!paymasterUrl;
if (!ready)
  node(
    "p",
    "On-chain sessions are unavailable until both new wallet locks are deployed and sponsorship is configured. You can create and authenticate a passkey now; no on-chain success is simulated.",
  ).setAttribute("role", "status");
const metaKey = "pilot:wallet:passkeys:v1";
let passkeys: PilotPasskey[] = JSON.parse(
  localStorage.getItem(metaKey) ?? "[]",
).map(parsePilotPasskey);
let selected: PilotPasskey | undefined;
let authenticated = false;
let session: PilotWalletSession | undefined;
let connection: PilotWalletConnection | undefined;
let busy = false;
let pendingConnect:
  { request: PilotWalletConnect; envelope: PilotWalletEnvelope } | undefined;
let selectedPolicies: number[] = [];
const accounts = node("section");
node("h2", "Pilot accounts", accounts);
const select = node("select", undefined, accounts);
select.setAttribute("aria-label", "Pilot account");
function renderAccounts() {
  select.replaceChildren();
  node("option", "Select an account", select).value = "";
  for (const p of passkeys)
    node("option", p.name, select).value = p.credentialId;
}
renderAccounts();
select.onchange = () => {
  selected = passkeys.find((p) => p.credentialId === select.value);
  authenticated = false;
  session = undefined;
  connection = undefined;
  showOwner();
};
const ownerAddress = node("code", "", accounts);
ownerAddress.id = "owner-address";
const accountAddress = node("code", "", accounts);
const balances = node(
  "p",
  "Refresh balances after selecting an account.",
  accounts,
);
function showOwner() {
  ownerAddress.textContent = selected
    ? ccc.Address.from({
        prefix: client.addressPrefix,
        script: pilotPasskeyLock(selected),
      }).toString()
    : "";
  const raw = selected ? localStorage.getItem(accountKey(selected)) : null;
  accountAddress.textContent = raw
    ? "Session account: " +
      ccc.Address.from({
        prefix: client.addressPrefix,
        script: pilotWalletLock(JSON.parse(raw)),
      }).toString()
    : "";
  balances.textContent =
    "Refresh balances to check available owner/account funds.";
}
const label = node("label", "Account name", accounts);
const name = node("input", undefined, label);
name.setAttribute("aria-label", "Account name");
name.maxLength = 64;
name.autocomplete = "username webauthn";
function button(text: string, fn: () => Promise<void>, parent = accounts) {
  const b = node("button", text, parent);
  b.onclick = () => void run(fn);
  return b;
}
async function run(fn: () => Promise<void>) {
  if (busy) return;
  busy = true;
  error.textContent = "";
  for (const b of root.querySelectorAll<
    HTMLButtonElement | HTMLInputElement | HTMLSelectElement
  >("button,input,select"))
    b.disabled = true;
  try {
    await fn();
  } catch (e) {
    error.textContent = e instanceof Error ? e.message : String(e);
  } finally {
    busy = false;
    for (const b of root.querySelectorAll<
      HTMLButtonElement | HTMLInputElement | HTMLSelectElement
    >("button,input,select"))
      b.disabled = false;
    grant.disabled = !ready || !pendingConnect;
  }
}
button("Create Pilot passkey", async () => {
  const p = await createPilotPasskey(name.value);
  if (passkeys.some((v) => v.publicKey === p.publicKey))
    throw new Error("Passkey already registered");
  passkeys.push(p);
  localStorage.setItem(metaKey, JSON.stringify(passkeys));
  selected = p;
  authenticated = true;
  renderAccounts();
  select.value = p.credentialId;
  showOwner();
  status.textContent =
    "Passkey created. Its owner private key remains in your authenticator.";
});
button("Sign in with passkey", async () => {
  if (!selected) throw new Error("Select an account first");
  await requestPilotAssertion(
    selected,
    ccc.hexFrom(crypto.getRandomValues(new Uint8Array(32))),
  );
  authenticated = true;
  showOwner();
  status.textContent =
    "Passkey verified. Review the requesting app before authorizing a session.";
});
button("Refresh balances", async () => {
  if (!selected) throw new Error("Select an account");
  const owner = await client.getBalanceSingle(pilotPasskeyLock(selected));
  const raw = localStorage.getItem(accountKey(selected));
  const account = raw
    ? await client.getBalanceSingle(pilotWalletLock(JSON.parse(raw)))
    : 0n;
  balances.textContent = `Passkey owner: ${ccc.fixedPointToString(owner)} CKB. Session account: ${ccc.fixedPointToString(account)} CKB. State/asset occupied capacity is part of these balances.`;
});
button("Export public recovery data", async () => {
  if (!selected) throw new Error("Select an account");
  const publicAccount = localStorage.getItem(accountKey(selected));
  const blob = new Blob(
    [
      JSON.stringify(
        {
          passkey: selected,
          account: publicAccount ? JSON.parse(publicAccount) : undefined,
        },
        null,
        2,
      ),
    ],
    { type: "application/json" },
  );
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "pilot-wallet-public-recovery.json";
  a.click();
  URL.revokeObjectURL(url);
});
const restoreLabel = node("label", "Import public recovery data", accounts);
const restore = node("input", undefined, restoreLabel);
restore.type = "file";
restore.accept = "application/json";
restore.onchange = () =>
  void run(async () => {
    const f = restore.files?.[0];
    if (!f) return;
    if (f.size > 30000) throw new Error("Recovery file too large");
    const v = JSON.parse(await f.text()) as {
      passkey: PilotPasskey;
      account?: PilotWalletDescriptor;
    };
    v.passkey = parsePilotPasskey(v.passkey);
    if (v.passkey.origin !== location.origin)
      throw new Error("This passkey belongs to a different wallet origin");
    if (v.account) {
      v.account = parsePilotWalletDescriptor(v.account);
      if (!ccc.Script.from(v.account.ownerLock).eq(pilotPasskeyLock(v.passkey)))
        throw new Error("Recovery owner mismatch");
      const old = localStorage.getItem(accountKey(v.passkey));
      if (old && old !== JSON.stringify(v.account))
        throw new Error("Existing account differs; preserve its descriptor");
      localStorage.setItem(accountKey(v.passkey), JSON.stringify(v.account));
    }
    if (!passkeys.some((p) => p.credentialId === v.passkey.credentialId)) {
      passkeys.push(v.passkey);
      localStorage.setItem(metaKey, JSON.stringify(passkeys));
    }
    selected = v.passkey;
    authenticated = false;
    renderAccounts();
    select.value = selected.credentialId;
    showOwner();
    status.textContent =
      "Public descriptor restored. Sign in with its original passkey. This file contains no private keys.";
  });
const review = node("section");
node("h2", "App session approval", review);
const appName = node("p", "No app is requesting a connection.", review);
const policyList = node("div", undefined, review);
const budgetLabel = node("label", "Maximum session spending (CKB)", review);
const budget = node("input", undefined, budgetLabel);
budget.setAttribute("aria-label", "Maximum session spending (CKB)");
budget.inputMode = "decimal";
node(
  "p",
  "Cell policies constrain full lock/type/data hashes and capacity. A zero data hash permits arbitrary data. This is not a named-contract-method interpreter. Expiry is checked by the wallet; revocation and remaining budget are enforced on-chain.",
  review,
);
const grant = button(
  "Approve session with passkey",
  async () => {
    if (!ready)
      throw new Error(
        "Deploy both wallet locks and configure sponsorship first",
      );
    if (!pendingConnect || !selected || !authenticated)
      throw new Error("Sign in, then review an app connection");
    const ownerSelection = selected,
      approval = pendingConnect;
    await navigator.locks.request(
      accountKey(ownerSelection) + ":owner-operation",
      async () => {
        const approved = selectedPolicies.map(
          (i) => approval.request.policies[i]!,
        );
        validatePilotPolicies(approved);
        if (!/^\d+(\.\d{1,8})?$/.test(budget.value))
          throw new Error("Enter a CKB amount with up to 8 decimals");
        const amount = ccc.fixedPointFrom(budget.value);
        if (amount <= 0n || amount > BigInt(approval.request.budget))
          throw new Error("Budget must be positive and within the app request");
        const owner = new PilotPasskeySigner(
          client,
          ownerSelection,
          config.passkey!,
          undefined,
          config.poolLock,
        );
        await owner.connect();
        const saved = localStorage.getItem(accountKey(ownerSelection));
        let account: PilotWalletDescriptor;
        if (saved) account = JSON.parse(saved);
        else {
          let seed: ccc.Cell | undefined;
          for await (const c of client.findCellsByLock(
            pilotPasskeyLock(ownerSelection),
            null,
          ))
            if (
              !c.cellOutput.type &&
              c.outputData === "0x" &&
              (await client.getCellLive(c.outPoint, true))
            ) {
              seed = c;
              break;
            }
          if (!seed)
            throw new Error(
              "Fund the passkey owner address shown above first. Keep at least one ordinary owner cell for recovery.",
            );
          account = createPilotWalletDescriptor(
            pilotPasskeyLock(ownerSelection),
            config.walletSession!,
            config.poolLock,
            maxFee,
            { previousOutput: seed.outPoint },
          );
          localStorage.setItem(
            accountKey(ownerSelection),
            JSON.stringify(account),
          );
        }
        const secret = ccc.hexFrom(secp256k1.utils.randomSecretKey()),
          publicKey = ccc.hexFrom(
            secp256k1.getPublicKey(ccc.bytesFrom(secret), true),
          );
        localStorage.setItem("pilot:wallet:session-key:" + publicKey, secret);
        const expiresAt =
          Date.now() +
          Math.min(
            Math.max(approval.request.durationMs ?? 3_600_000, 60_000),
            86_400_000,
          );
        session = engine(owner, account, secret, expiresAt);
        const journal = await session.options.journal.load();
        const state: PilotWalletState = {
          publicKey,
          remaining: amount.toString(),
          sequence: (BigInt(journal?.state?.sequence ?? "-1") + 1n).toString(),
          appOrigin,
          policies: approved,
        };
        const output = ccc.CellOutput.from({
          lock: pilotWalletLock(account),
          type: account.stateType,
        });
        const capacity =
          ccc.fixedPointFrom(
            output.occupiedSize +
              ccc.bytesFrom(encodePilotWalletState(state)).length,
          ) + amount;
        status.textContent =
          "Reviewing the passkey-authorized on-chain grant. Initial setup uses your spending amount plus occupied state-cell capacity; sponsorship pays network fees.";
        // This explicit second review includes the exact first-funding amount before WebAuthn signing.
        const live = journal?.state;
        const total = live
          ? "Existing account capacity is reused; this replaces its active session."
          : `Initial account funding: ${ccc.fixedPointToString(capacity)} CKB (budget plus occupied capacity).`;
        if (
          !window.confirm(
            `${appOrigin}\nDestination: ${await session.getRecommendedAddress()}\n${total}\nMaximum session spending: ${budget.value} CKB.\nApprove ${approved.length} selected policies?`,
          )
        )
          throw new Error("Session approval cancelled");
        await session.grant(state, capacity);
        connection = {
          address: await session.getRecommendedAddress(),
          ownerAddress: await owner.getRecommendedAddress(),
          account,
          appOrigin,
          expiresAt,
        };
        localStorage.setItem(
          "pilot:wallet:active:" + pilotWalletLock(account).hash(),
          JSON.stringify({ expiresAt, appOrigin }),
        );
        reply(approval.envelope, connection);
        pendingConnect = undefined;
        showOwner();
        status.textContent =
          "Session confirmed on-chain. Keep this wallet window open for automatic actions.";
        await renderLogs();
      },
    );
  },
  review,
);
grant.className = "primary";
grant.disabled = true;
const management = node("section");
node("h2", "Session and recovery", management);
button(
  "Reconcile queued transactions",
  async () => {
    const e = await recoveryEngine();
    await e.resume();
    status.textContent = "Saved receipts reconciled.";
    await renderLogs(e);
  },
  management,
);
button(
  "Stop and revoke on-chain",
  async () => {
    const e = await recoveryEngine();
    await e.stop();
    await e.revoke();
    connection = undefined;
    status.textContent =
      "Session revoked on-chain. Its old key can no longer advance the authority.";
    await renderLogs(e);
  },
  management,
);
button(
  "Recover ordinary CKB with passkey",
  async () => {
    if (
      !window.confirm(
        "Stop automatic access, settle saved transactions, then recover ordinary CKB and close the account authority? Stop other devices first; missing local receipts do not prove they are idle. Typed app assets require separate builders.",
      )
    )
      return;
    const e = await recoveryEngine();
    await e.recover();
    connection = undefined;
    status.textContent =
      "Ordinary CKB recovered to the passkey owner. Do not send new funds to the closed session address.";
    await renderLogs(e);
  },
  management,
);
button(
  "Prepare a replacement account",
  async () => {
    const e = await recoveryEngine();
    await e.resume();
    for await (const cell of client.findCellsByLock(e.lock, null))
      if (await client.getCellLive(cell.outPoint, true))
        throw new Error(
          "Recover the old account and its remaining assets before replacing its descriptor",
        );
    if (
      !window.confirm(
        "The old account has no live cells. Preserve its public descriptor and prepare a new account address on next approval? Existing app state does not migrate automatically.",
      )
    )
      return;
    localStorage.setItem(
      "pilot:wallet:archived:" + e.lock.hash(),
      JSON.stringify(e.options.account),
    );
    localStorage.removeItem(accountKey(selected!));
    session = undefined;
    connection = undefined;
    status.textContent =
      "Old public descriptor archived. Reconnect the app to review a fresh account grant.";
  },
  management,
);
const logs = node("details");
node("summary", "Queue and all account receipts", logs);
const logBody = node("pre", "No account selected.", logs);
async function renderLogs(e = session) {
  if (e)
    logBody.textContent = JSON.stringify(
      await e.options.journal.load(),
      null,
      2,
    );
}
function accountKey(p: PilotPasskey) {
  return "pilot:wallet:account:" + p.publicKey + ":testnet";
}
function engine(
  owner: PilotPasskeySigner,
  account: PilotWalletDescriptor,
  key: ccc.Hex,
  expiresAt: number,
) {
  const journalKey = "pilot:wallet:journal:" + pilotWalletLock(account).hash();
  if (!paymasterUrl) throw new Error("Sponsorship is not configured");
  return new PilotWalletSession({
    owner,
    account,
    sessionKey: key,
    appOrigin: appOrigin || location.origin,
    expiresAt,
    paymaster: new PilotPaymasterClient({
      client,
      url: paymasterUrl,
      poolLock: config.poolLock,
      maxFee,
    }),
    journal: {
      async load() {
        const value = localStorage.getItem(journalKey);
        return value ? (JSON.parse(value) as PilotWalletJournal) : undefined;
      },
      async save(value) {
        localStorage.setItem(journalKey, JSON.stringify(value));
      },
    },
    exclusive: async (fn) =>
      await navigator.locks.request(journalKey, async () => await fn()),
  });
}
async function recoveryEngine() {
  if (!ready || !selected || !authenticated)
    throw new Error(
      "Sign in with the original passkey and configure deployment/sponsorship",
    );
  const raw = localStorage.getItem(accountKey(selected));
  if (!raw) throw new Error("Import the public recovery descriptor first");
  const account: PilotWalletDescriptor = JSON.parse(raw);
  if (session && session.lock.eq(pilotWalletLock(account))) return session;
  const owner = new PilotPasskeySigner(
    client,
    selected,
    config.passkey!,
    undefined,
    config.poolLock,
  );
  const key = ccc.hexFrom(secp256k1.utils.randomSecretKey());
  const e = engine(owner, account, key, 0);
  if (!(await e.options.journal.load()))
    await e.options.journal.save({
      accountHash: e.lock.hash(),
      stopped: true,
      receipts: [],
    });
  return e;
}
function reply(
  request: PilotWalletEnvelope,
  result?: unknown,
  failure?: string,
) {
  opener?.postMessage(
    {
      protocol: PILOT_WALLET_PROTOCOL,
      channel,
      id: request.id,
      method: request.method,
      ...(failure ? { error: failure } : { result }),
    },
    appOrigin,
  );
}
let operation = false;
window.addEventListener("message", (event) => {
  if (
    !opener ||
    event.source !== opener ||
    event.origin !== appOrigin ||
    !isPilotWalletEnvelope(event.data, channel)
  )
    return;
  const request = event.data;
  if (operation || busy) {
    reply(
      request,
      undefined,
      "Another wallet operation is in progress; retry with the same request ID",
    );
    return;
  }
  if (request.method === "connect") {
    try {
      if (pendingConnect || connection)
        throw new Error("A connection is already active");
      const v = request.params as PilotWalletConnect;
      validatePilotPolicies(v.policies);
      if (
        typeof v.name !== "string" ||
        !v.name ||
        v.name.length > 100 ||
        BigInt(v.budget) <= 0n ||
        !Number.isSafeInteger(v.durationMs ?? 3_600_000)
      )
        throw new Error("Invalid app request");
      pendingConnect = { request: v, envelope: request };
      selectedPolicies = [];
      appName.textContent = `${v.name} — ${appOrigin}`;
      budget.value = ccc.fixedPointToString(BigInt(v.budget));
      policyList.replaceChildren();
      v.policies.forEach((p, i) => {
        const l = node("label", undefined, policyList),
          box = node("input", undefined, l);
        box.type = "checkbox";
        box.onchange = () => {
          selectedPolicies = box.checked
            ? [...selectedPolicies, i]
            : selectedPolicies.filter((n) => n !== i);
        };
        l.append(document.createTextNode(p.name));
        node("pre", JSON.stringify(p, null, 2), policyList);
      });
      grant.disabled = !ready;
    } catch (e) {
      reply(request, undefined, e instanceof Error ? e.message : String(e));
    }
    return;
  }
  operation = true;
  void (async () => {
    if (!session || !connection || connection.appOrigin !== event.origin)
      throw new Error("Approve this app session first");
    const current = await session.options.journal.load();
    if (
      current?.state?.appOrigin !== appOrigin ||
      current.state.publicKey !== session.publicKey
    )
      throw new Error(
        "This connection was replaced; reconnect and approve a fresh session",
      );
    if (request.method === "disconnect") {
      await session.endAppAccess();
      connection = undefined;
      return { stopped: true, onchainRevoked: false };
    }
    if (request.method === "logs") {
      return {
        ...current,
        receipts: current.receipts.filter(
          (r) =>
            r.next?.appOrigin === appOrigin ||
            r.kind === "revoke" ||
            r.kind === "recover",
        ),
        messages: current.messages?.filter((m) => m.appOrigin === appOrigin),
      };
    }
    if (request.method === "resume") {
      await session.resume();
      return true;
    }
    if (request.method === "signMessage") {
      const p = request.params as {
        scope: string;
        message: string;
        nonce: string;
      };
      return session.signScopedMessage(p.scope, p.message, p.nonce);
    }
    if (request.method === "prepare" || request.method === "send") {
      const p = request.params as { bytes: ccc.Hex; requestId?: string };
      if (typeof p.bytes !== "string" || p.bytes.length > 262144)
        throw new Error("Transaction is too large");
      let tx = ccc.Transaction.fromBytes(p.bytes);
      const j = await session.options.journal.load();
      if (!j?.state) throw new Error("Missing session state");
      if (request.method === "prepare") {
        return ccc.hexFrom((await session.prepareAppTransaction(tx)).toBytes());
      }
      return session.sendTransaction(tx, p.requestId);
    }
    throw new Error("Unsupported wallet method");
  })()
    .then(
      (v) => reply(request, v),
      (e) =>
        reply(request, undefined, e instanceof Error ? e.message : String(e)),
    )
    .finally(() => {
      operation = false;
      void renderLogs();
    });
});
if (opener && appOrigin && channel)
  opener.postMessage(
    { protocol: PILOT_WALLET_PROTOCOL, channel, id: "ready", method: "ready" },
    appOrigin,
  );
