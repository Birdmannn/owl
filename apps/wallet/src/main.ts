import "./style.css";
import { MAX_DELEGATED_ACTIONS } from '../../../src/limits';
import { validatePilotPolicyCatalog } from '../../../src/wallet/session';
import { needsSafariAuth, topLevelAuth } from "./auth-bridge";
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
  type PilotAssertion,
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
import {
  PILOT_PASSKEY_CODE_HASH,
  PILOT_LEGACY_PASSKEY_CODE_HASH,
} from "../../../src/wallet/code";
import { PilotPaymasterClient } from "../../../src/paymaster";
import type { Deployment } from "../../../src/ckb/counter";
import deployment from "../../../deployments/pilot-sponsored.json";
const config = deployment as unknown as {
  passkey?: Deployment | null;
  passkeyLegacy?: Deployment | null;
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
const header = node("header");
header.className = "wallet-header";
const brand = node("a", undefined, header);
brand.className = "brand";
brand.href = "#";
brand.setAttribute("aria-label", "Pilot wallet home");
const owl = node("img", undefined, brand);
owl.src = "/owl.png";
owl.alt = "";
const wordmark = node("span", "pilot", brand);
node("small", "BY OWL", wordmark);
node("span", "CKB Testnet", header).className = "network";
const intro = node("div");
intro.className = "intro";
node("span", "YOUR WALLET. YOUR CALL.", intro).className = "eyebrow";
const heading = node("h1", "A little permission.", intro);
node("span", "A lot less signing.", heading);
node("p", "One passkey. Apps you trust. You decide what happens next.", intro);
const trust = node("div");
trust.className = "trust-strip";
node("span", "Passkey protected", trust);
node("span", "Permissions on-chain", trust);
node("span", "You stay in control", trust);
const preview = node("details");
preview.className = "preview-note";
node("summary", "Testnet preview · Know your wallet", preview);
node(
  "p",
  "Your owner private key stays in your passkey authenticator. Session keys are stored on this wallet origin and remain accessible to its own scripts. Keep this origin trusted. Only one on-chain session is active per account.",
  preview,
);
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
const embedded = window.self !== window.top;
if (embedded && window.parent !== window.top)
  throw new Error("Nested wallet embedding is unsupported");
if (embedded && (params.get("embed") !== "1" || !appOrigin || !channel))
  throw new Error("Open this wallet through the Pilot SDK modal");
const peer = embedded ? window.parent : null;
if (embedded) {
  document.documentElement.classList.add("embedded");
  heading.textContent = "Your Pilot wallet";
  intro.querySelector("p")!.textContent = "Choose an account, then review what this app can do.";
  node(
    "p",
    "Your browser may keep account history separate for each app. Use Backup & restore with your original passkey to restore an account.",
    preview,
  ).className = "storage-note";
}
const assertOwner = (passkey: PilotPasskey, challenge: ccc.Hex) =>
  embedded && needsSafariAuth()
    ? topLevelAuth({ kind: "assert", passkey, challenge, appOrigin }) as Promise<PilotAssertion>
    : requestPilotAssertion(passkey, challenge, embedded ? appOrigin : undefined);
async function confirmReview(message: string): Promise<boolean> {
  const dialog = node("dialog");
  dialog.className = "owner-review";
  const title = node("h2", "Review and confirm", dialog);
  title.id = "owner-review-title";
  dialog.setAttribute("aria-labelledby", title.id);
  node("pre", message, dialog);
  return new Promise((resolve) => {
    const finish = (approved: boolean) => {
      dialog.close();
      dialog.remove();
      resolve(approved);
    };
    const cancel = node("button", "Cancel", dialog);
    cancel.onclick = () => finish(false);
    const approve = node("button", "Confirm with passkey", dialog);
    approve.className = "primary";
    approve.onclick = () => finish(true);
    dialog.oncancel = (event) => {
      event.preventDefault();
      finish(false);
    };
    dialog.showModal();
  });
}
if (appOrigin) {
  const requesting = node("div");
  requesting.className = "requesting-origin";
  node("small", "REQUESTING APP", requesting);
  node("p", appOrigin, requesting).className = "origin";
}
let storageReady = true;
try {
  const probe = "pilot:wallet:storage-probe:" + crypto.randomUUID();
  localStorage.setItem(probe, "1");
  localStorage.removeItem(probe);
} catch {
  storageReady = false;
}
const ready =
  storageReady &&
  config.passkey?.codeHash === PILOT_PASSKEY_CODE_HASH &&
  !!config.walletSession &&
  !!paymasterUrl;
if (!ready)
  node(
    "p",
    (!storageReady
      ? "Your browser blocks storage for the embedded Pilot wallet. Allow storage for this wallet origin or use a supported browser. "
      : config.passkey?.codeHash === PILOT_PASSKEY_CODE_HASH &&
          config.walletSession
        ? "Fee sponsorship is not configured for this wallet. "
        : "On-chain sessions are unavailable until the wallet contracts and sponsorship are configured. ") +
      (storageReady
        ? "You can create and authenticate a passkey now; no on-chain success is simulated."
        : "No wallet actions are available until storage is enabled."),
  ).className = "availability-note";
const metaKey = "pilot:wallet:passkeys:v1";
let passkeys: PilotPasskey[] = JSON.parse(
  storageReady ? (localStorage.getItem(metaKey) ?? "[]") : "[]",
).map(parsePilotPasskey);
let selected: PilotPasskey | undefined;
let authenticated = false;
let session: PilotWalletSession | undefined;
let connection: PilotWalletConnection | undefined;
let busy = false;
let pendingConnect:
  { request: PilotWalletConnect; envelope: PilotWalletEnvelope } | undefined;
let selectedPolicies: number[] = [];
type ModalStep = "welcome" | "signin" | "permissions" | "profile";
let modalStep: ModalStep = "welcome";
let createMode = passkeys.length === 0;
const modalHeading = node("h2", "Welcome to Pilot");
modalHeading.className = "modal-heading";
modalHeading.tabIndex = -1;
const modalBack = node("button", "← Back");
modalBack.className = "modal-back";
modalBack.onclick = () => goTo(modalStep === "signin" ? "welcome" : "profile");
const workspace = node("div");
workspace.className = "workspace";
const welcome = node("section", undefined, workspace);
welcome.className = "welcome-card";
node("p", "Your Pilot account. One passkey. Fewer interruptions.", welcome);
const enter = node("button", undefined, welcome);
enter.className = "pilot-wallet-choice";
const enterIcon = node("img", undefined, enter);
enterIcon.src = "/owl.png";
enterIcon.alt = "";
const enterText = node("span", undefined, enter);
node("strong", "Pilot", enterText);
node("small", "Create an account or sign in with your passkey", enterText);
node("b", "→", enter);
enter.onclick = () => goTo("signin");
node("p", "Your passkey owns your account. You choose the actions each app may perform.", welcome).className = "fine";
const accounts = node("section", undefined, workspace);
accounts.className = "account-card";
accounts.id = "accounts";
node("span", "01 / YOUR IDENTITY", accounts).className = "eyebrow";
node("h2", "Pilot accounts", accounts);
node(
  "p",
  "Create a wallet or return with your passkey. No seed phrase to copy.",
  accounts,
).className = "section-description";
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
  void renderLogs();
};
const addresses = node("div", undefined, accounts);
addresses.className = "addresses";
node("small", "OWNER FUNDING ADDRESS", addresses);
const ownerAddress = node(
  "code",
  "Select or create an account to see your funding address.",
  addresses,
);
ownerAddress.id = "owner-address";
const accountAddress = node("code", "", addresses);
const balances = node(
  "p",
  "Refresh balances after selecting an account.",
  accounts,
);
balances.className = "balance-note";
function showOwner() {
  ownerAddress.textContent = selected
    ? ccc.Address.from({
        prefix: client.addressPrefix,
        script: pilotPasskeyLock(selected),
      }).toString()
    : "Select or create an account to see your funding address.";
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
const authModes = node("div", undefined, accounts);
authModes.className = "auth-modes";
const existingMode = node("button", "Sign in", authModes);
existingMode.onclick = () => { createMode = false; renderModal(); };
const newMode = node("button", "Create account", authModes);
newMode.onclick = () => { createMode = true; renderModal(); };
const label = node("label", "Account name", accounts);
const name = node("input", undefined, label);
name.placeholder = "e.g. My everyday wallet";
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
    if (!storageReady)
      throw new Error(
        "Embedded wallet storage is blocked by your browser. Enable storage for the Pilot wallet before creating an account.",
      );
    await fn();
  } catch (e) {
    error.textContent = e instanceof Error ? e.message : String(e);
  } finally {
    busy = false;
    for (const b of root.querySelectorAll<
      HTMLButtonElement | HTMLInputElement | HTMLSelectElement
    >("button,input,select"))
      b.disabled = false;
    renderModal();
  }
}
const createPasskey = button("Create Pilot passkey", async () => {
  const p = embedded && needsSafariAuth()
    ? await topLevelAuth({ kind: "create", name: name.value, appOrigin }) as PilotPasskey
    : await createPilotPasskey(name.value);
  if (passkeys.some((v) => v.publicKey === p.publicKey))
    throw new Error("Passkey already registered");
  passkeys.push(p);
  localStorage.setItem(metaKey, JSON.stringify(passkeys));
  selected = p;
  authenticated = true;
  renderAccounts();
  select.value = p.credentialId;
  showOwner();
  await renderLogs();
  status.textContent =
    "Passkey created. Its owner private key remains in your authenticator.";
  if (embedded) goTo(pendingConnect ? "permissions" : "profile");
});
createPasskey.className = "primary";
const signIn = button("Sign in with passkey", async () => {
  if (!selected) throw new Error("Select an account first");
  await assertOwner(
    selected,
    ccc.hexFrom(crypto.getRandomValues(new Uint8Array(32))),
  );
  authenticated = true;
  showOwner();
  await renderLogs();
  status.textContent =
    "Passkey verified. Review the requesting app before authorizing a session.";
  if (embedded) goTo(pendingConnect ? "permissions" : "profile");
});
async function refreshAvailableBalances() {
  if (!selected) throw new Error("Select an account");
  const owner = await client.getBalanceSingle(pilotPasskeyLock(selected));
  const raw = localStorage.getItem(accountKey(selected));
  const account = raw
    ? await client.getBalanceSingle(pilotWalletLock(JSON.parse(raw)))
    : 0n;
  balances.textContent = `Passkey owner: ${ccc.fixedPointToString(owner)} CKB. Session account: ${ccc.fixedPointToString(account)} CKB. State/asset occupied capacity is part of these balances.`;
  profileBalance.textContent = balances.textContent;
  fundingBalance.textContent = balances.textContent;
}
const refreshBalances = button("Refresh balances", refreshAvailableBalances);
const backup = node("details", undefined, accounts);
backup.className = "backup-tools";
node("summary", "Backup & restore", backup);
node(
  "p",
  "Export public account details for recovery on another browser. This file contains no private keys; keep access to your original passkey.",
  backup,
);
button(
  "Export public recovery data",
  async () => {
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
  },
  backup,
);
const restoreLabel = node("label", "Import public recovery data", backup);
const restore = node("input", undefined, restoreLabel);
restore.type = "file";
restore.accept = "application/json";
restore.onchange = () =>
  void run(async () => {
    const f = restore.files?.[0];
    if (!f) return;
    if (connection || session)
      throw new Error("Disconnect and settle the active app before restoring another account.");
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
    createMode = false;
    if (embedded) goTo("signin");
  });
const review = node("section", undefined, workspace);
review.className = "approval-card";
review.id = "permissions";
node("span", "02 / YOU SET THE RULES", review).className = "eyebrow";
node("h2", "Sign these on my behalf", review);
const appName = node("p", "No app is requesting a connection.", review);
appName.className = "app-request";
const policyList = node("div", undefined, review);
const selectionCount = node("p", undefined, review);
selectionCount.setAttribute('role', 'status');
selectionCount.className = 'fine';
policyList.className = "policy-list";
const emptyPolicies = node(
  "p",
  "Open Pilot from an app to review the actions it wants to perform. Nothing is approved by default.",
  policyList,
);
emptyPolicies.className = "empty-state";
const budgetLabel = node("label", "Maximum session spending (CKB)", review);
const budget = node("input", undefined, budgetLabel);
budget.placeholder = "Set your spending limit";
budget.setAttribute("aria-label", "Maximum session spending (CKB)");
budget.inputMode = "decimal";
const policyHelp = node("details", undefined, review);
policyHelp.className = "policy-help";
node("summary", "How these permissions work", policyHelp);
node(
  "p",
  "Cell policies constrain full lock/type/data hashes and capacity. A zero data hash permits arbitrary data. This is not a named-contract-method interpreter. Expiry is checked by the wallet; revocation and remaining budget are enforced on-chain.",
  policyHelp,
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
    if (selected.codeHash === PILOT_LEGACY_PASSKEY_CODE_HASH)
      throw new Error(
        "This is an original top-level-only account. Recover it from the trusted wallet directly, then create a new embedded account. Do not send funds to a replacement address until reviewed.",
      );
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
          (challenge) => assertOwner(ownerSelection, challenge),
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
              "Open “Fund your Pilot account” and fund the displayed passkey owner address first. Keep an ordinary owner cell for recovery.",
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
          !(await confirmReview(
            `${appOrigin}\nDestination: ${await session.getRecommendedAddress()}\n${total}\nMaximum session spending: ${budget.value} CKB.\nApprove ${approved.length} selected policies?`,
          ))
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
          "Session confirmed on-chain. You can close the modal. Pilot stays connected for approved actions.";
        await renderLogs();
        if (embedded) goTo("profile");
      },
    );
  },
  review,
);
grant.className = "primary";
grant.disabled = true;
const profile = node("section", undefined, workspace);
profile.className = "profile-card";
const profileSummary = node("div", undefined, profile);
profileSummary.className = "pilot-account-summary";
const profileName = node("strong", "Pilot", profileSummary);
node("small", "Passkey account · CKB Testnet", profileSummary);
const profileAddress = node("code", undefined, profileSummary);
button("Copy address", async () => {
  if (!selected) throw new Error("Sign in first");
  await navigator.clipboard.writeText(profileAddress.textContent ?? "");
  status.textContent = "Address copied.";
}, profileSummary);
const profileBalance = node("p", "Refresh to see your balance.", profileSummary);
button("Refresh balance", refreshAvailableBalances, profileSummary);
button("Review permissions", async () => goTo("permissions"), profile).className = "primary full";
const profileHint = node("p", undefined, profile);
const funding = node("details", undefined, review);
funding.className = "funding-details";
node("summary", "Fund your Pilot account", funding);
node("p", "Send CKB to this passkey owner address before approving. Your spending limit and recoverable account storage are funded separately from sponsored network fees. Keep an ordinary owner cell available for recovery.", funding);
const fundingAddress = node("code", undefined, funding);
const fundRefresh = node("button", "Refresh balances", funding);
fundRefresh.onclick = () => refreshBalances.click();
const fundingBalance = node("p", undefined, funding);
const management = node("section");
management.className = "management-card";
node("span", "03 / ALWAYS YOURS", management).className = "eyebrow";
node("h2", "Session and recovery", management);
node(
  "p",
  "Settle your queue, withdraw access or bring your CKB home. On-chain changes require your passkey.",
  management,
).className = "section-description";
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
  "End session & reclaim CKB",
  async () => {
    if (
      !(await confirmReview(
        "Stop automatic access, settle saved transactions, then recover ordinary CKB and close the account authority? Stop other devices first; missing local receipts do not prove they are idle. Typed app assets require separate builders.",
      ))
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
      !(await confirmReview(
        "The old account has no live cells. Preserve its public descriptor and prepare a new account address on next approval? Existing app state does not migrate automatically.",
      ))
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
logs.className = "activity-card";
node("summary", "Queue and all account receipts", logs);
const logBody = node("pre", "No account selected.", logs);
const footer = node("footer");
node("span", "PILOT / BY OWL", footer);
node("span", "Less signing. More doing.", footer);
if (embedded) {
  // A modal has one task per screen; recovery and receipts belong in the profile.
  header.after(modalBack, modalHeading);
  const advanced = node("details", undefined, profile);
  advanced.className = "profile-tools";
  node("summary", "Session & recovery", advanced);
  advanced.append(management);
  profile.append(logs, backup);
}
function goTo(step: ModalStep) {
  modalStep = step;
  renderModal();
  if (embedded) {
    modalHeading.focus();
    window.scrollTo(0, 0);
  }
}
function renderModal() {
  grant.disabled = !ready || !pendingConnect || !authenticated || !selectedPolicies.length || selectedPolicies.length > MAX_DELEGATED_ACTIONS || busy;
  selectionCount.textContent = pendingConnect ? `${selectedPolicies.length} / ${MAX_DELEGATED_ACTIONS} policies selected · ${pendingConnect.request.policies.length} offered. Uncheck a policy to change your selection at the limit.` : '';
  policyList.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((box, i) => {
    box.checked = selectedPolicies.includes(i);
    box.disabled = busy || !pendingConnect || (!box.checked && selectedPolicies.length >= MAX_DELEGATED_ACTIONS);
  });
  if (!embedded) {
    welcome.hidden = profile.hidden = modalHeading.hidden = modalBack.hidden = authModes.hidden = funding.hidden = true;
    return;
  }
  welcome.hidden = modalStep !== "welcome";
  accounts.hidden = modalStep !== "signin";
  review.hidden = modalStep !== "permissions";
  profile.hidden = modalStep !== "profile";
  modalHeading.textContent = modalStep === "welcome" ? "Welcome to Pilot"
    : modalStep === "signin" ? (createMode ? "Create your Pilot account" : "Sign in to Pilot")
    : modalStep === "permissions" ? "Sign these on my behalf" : (selected?.name || "Your Pilot profile");
  modalBack.hidden = modalStep === "welcome" || modalStep === "profile" || (modalStep === "permissions" && !authenticated);
  (modalStep === "signin" ? accounts : profile).append(backup);
  modalBack.disabled = busy;
  existingMode.disabled = busy || !passkeys.length;
  existingMode.setAttribute("aria-pressed", String(!createMode));
  newMode.disabled = busy;
  newMode.setAttribute("aria-pressed", String(createMode));
  select.hidden = createMode;
  label.hidden = createPasskey.hidden = !createMode;
  signIn.hidden = createMode;
  addresses.hidden = balances.hidden = refreshBalances.hidden = true;
  profileName.textContent = selected?.name || "Pilot";
  profileAddress.textContent = connection?.address || ownerAddress.textContent;
  fundingAddress.textContent = selected ? ownerAddress.textContent : "Sign in to see your funding address.";
  fundingBalance.textContent = balances.textContent;
  profileHint.textContent = connection
    ? "Pilot is ready. Only your approved actions may run automatically."
    : "Review this app’s permissions to connect. No automatic actions are approved yet.";
  budget.disabled = busy || !pendingConnect;
}
renderModal();
if (embedded && peer) {
  const resize = new ResizeObserver(() => {
    peer.postMessage({
      protocol: PILOT_WALLET_PROTOCOL, channel, id: "resize", method: "resize",
      params: { height: Math.ceil(root.getBoundingClientRect().height) },
    }, appOrigin);
  });
  resize.observe(root);
}
async function renderLogs(e = session) {
  let journal = e ? await e.options.journal.load() : undefined;
  if (!journal && selected) {
    const raw = localStorage.getItem(accountKey(selected));
    if (raw) {
      const account = parsePilotWalletDescriptor(JSON.parse(raw));
      const saved = localStorage.getItem("pilot:wallet:journal:" + pilotWalletLock(account).hash());
      if (saved) journal = JSON.parse(saved) as PilotWalletJournal;
    }
  }
  logBody.textContent = journal ? JSON.stringify(journal, null, 2) : "No saved account receipts yet.";
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
  const ownerDeployment =
    selected?.codeHash === PILOT_LEGACY_PASSKEY_CODE_HASH
      ? config.passkeyLegacy
      : config.passkey;
  if (!ownerDeployment || !paymasterUrl || !selected || !authenticated)
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
    ownerDeployment,
    (challenge) => assertOwner(selected!, challenge),
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
  peer?.postMessage(
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
    !peer ||
    event.source !== peer ||
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
      validatePilotPolicyCatalog(v.policies);
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
        const policy = node("div", undefined, policyList);
        policy.className = "policy";
        const l = node("label", undefined, policy),
          box = node("input", undefined, l);
        box.type = "checkbox";
        box.onchange = () => {
          selectedPolicies = box.checked
            ? (selectedPolicies.length < MAX_DELEGATED_ACTIONS && !selectedPolicies.includes(i) ? [...selectedPolicies, i] : selectedPolicies)
            : selectedPolicies.filter((n) => n !== i);
          renderModal();
        };
        l.append(document.createTextNode(p.name));
        const technical = node("details", undefined, policy);
        node("summary", "View policy details", technical);
        node("pre", JSON.stringify(p, null, 2), technical);
      });
      renderModal();
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
      renderModal();
    });
});
if (peer && appOrigin && channel)
  peer.postMessage(
    { protocol: PILOT_WALLET_PROTOCOL, channel, id: "ready", method: "ready" },
    appOrigin,
  );
