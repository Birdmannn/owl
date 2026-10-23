# Pilot passkey wallet

Implemented locally on 2026-10-21. This is a separate wallet architecture alongside the existing external-wallet and broad-key account APIs. It is a testnet preview; its two contracts are not deployed and a live hardware-passkey testnet flow is not yet verified.

## Ownership and isolation

Pilot owns its authentication experience. `createPilotPasskey` creates an ES256 discoverable passkey with mandatory user verification on the **Pilot wallet origin**. The owner private key stays with the authenticator. The public credential ID, public key, RP ID, exact origin and account label are stored as metadata. No JoyID account is required.

`apps/wallet` runs as a separate, top-level popup. `PilotWalletProvider` connects an app to it using messages bound to the exact wallet origin, actual popup/opener Window and a random channel. Users explicitly review the requesting browser origin, select policies and approve a spending amount. Requests cannot choose a different paymaster or RPC: those come from the wallet's own configuration. No owner or session private keys cross the transport. Untrusted app names/policies are rendered as text, not HTML.

The popup avoids third-party iframe storage and embedded-WebAuthn restrictions. It must remain open for this transport to work; reconnect after closing it. An iframe/headless/mobile transport is not included.

## Contracts and authorization

### Passkey owner lock

`contracts/passkey-lock` pins a compressed P-256 public key, SHA-256 RP ID hash and SHA-256 exact-origin hash. A spend verifies:

- The WebAuthn assertion's RP hash, user-presence and user-verification flags.
- `webauthn.get`, the expected challenge, exact origin and no cross-origin assertion.
- A real ES256 signature over authenticator data and the client-data hash.
- A domain-separated transaction digest covering the raw transaction and every witness, preserving type fields. Only the owner signature and explicitly designated final sponsor signature are normalized.

The owner can hold ordinary CKB at this stable passkey address, inspect owner/account balances, fund an account, authorize a replacement session, revoke it and recover funds. After recovery closes an empty account, an explicit replacement control archives the old public descriptor before a new address is prepared; app ownership does not migrate. Keep an ordinary owner cell available as the proof input. The wallet shows this funding address before setup. External wallets may send funds there without becoming account owners.

### Session account lock

`contracts/wallet-session-lock` pins the full owner-lock hash, the hash of a **built-in TYPE_ID** singleton authority, pool-lock hash and per-transaction fee ceiling. The account address is stable across session replacement; its initial TYPE_ID is derived from the first funding input and output index.

A replacement permission list must fit the existing state-cell capacity. Oversized state is rejected before passkey signing; use fewer policies or explicitly recover/fund a replacement account.

State stores a session public key, cumulative remaining CKB budget, sequence, app-origin commitment and up to 16 explicit cell/message policies. Each automatic transaction must consume the authority and recreate it under the same account lock. Its key, app and policies cannot change through session authority. The remaining budget decreases by positive net account-capacity loss; receipts/incoming funds do not restore a previously spent allowance. Sequence must advance by one. App type scripts still run.

Cell policies commit to input/output direction, full lock hash, full type hash, output-data hash and a maximum capacity. Zero type hash means **no type**, never any type. Zero data hash is an explicit arbitrary-data permission. Ordinary empty account change and the authority successor are handled separately. Account asset inputs and external/typed/data-bearing outputs require matching policies. Other inputs still enforce their own locks. Policies are an approved union; human-readable names do not implement contract-method decoding or token-amount arithmetic.

Automatic transactions require a unique final pool input/output. The pool pays the **entire** network fee within the configured cap. Unavailable sponsorship fails closed. Initial funding registration must be owner-authorized, service-validated and committed before automatic sponsorship is available. A copied owner hash does not qualify for that owner's pool quota.

The owner branch requires an actual input under the pinned passkey owner lock. It can replace the state, blank it to revoke the session, or close the authority during recovery. An old session key cannot recreate a destroyed TYPE_ID authority or advance a rotated state. Cells subsequently received at the old account still have an owner-recovery path, but session access needs a live valid authority.

## Flow

```mermaid
sequenceDiagram
    participant A as Integrating app
    participant W as Pilot wallet origin
    participant P as Owner passkey authenticator
    participant C as CKB account and TYPE_ID state
    participant M as Paymaster
    A->>W: Open wallet; request policies and budget
    W->>P: Create or authenticate Pilot passkey
    P-->>W: Public credential / verified assertion
    W->>W: Show actual app origin and unchecked policies
    W->>W: Persist session key on wallet origin
    Note over W,C: First setup needs CKB at the passkey owner address
    W->>M: Quote reviewed funding / session grant
    W->>P: Authorize exact grant transaction
    W->>W: Persist signed receipt before submission
    W->>M: Submit; validate and co-sign fee input
    M->>C: Confirm singleton state and account funding
    W-->>A: Public address and connection
    A->>W: Prepare app effects; send stable request ID
    W->>W: Check app, current state, policies and budget
    W->>M: Quote exact transaction
    W->>W: Session-sign and durably save exact bytes
    W->>M: Submit sponsored transaction
    M->>C: Enforce policies, budget, key and fee conservation
    A->>W: Request end of session
    W->>W: Stop new signatures and settle saved receipts
    W->>P: Sign on-chain revocation or recovery
    W->>M: Persist and submit sponsored owner operation
    M->>C: Replace / revoke / close authority
```

## SDK integration

Use the existing repository installer for the SDK. The hosted signer is a separate API from the existing CCC owner-wallet wrapper:

```ts
import { ccc } from '@ckb-ccc/core';
import { PilotWalletProvider, PilotHostedSigner } from '@owl/pilot';

const provider = new PilotWalletProvider({ url: 'https://wallet.example' });
// Call from a click handler so the browser allows the popup.
const connection = await provider.connect({
  name: 'My app',
  budget: ccc.fixedPointFrom(200).toString(),
  policies: myExplicitCellPolicies,
});
const signer = new PilotHostedSigner(new ccc.ClientPublicTestnet(), provider);
// Start with requested app effects; the wallet adds its authority successor/change.
const tx = await signer.prepareTransaction(appTransaction);
const hash = await signer.sendTransaction(tx, `purchase:${purchaseId}`);
// Persist the prepared bytes and stable ID; retry those exact values after response loss.
const logs = await provider.request('logs');
```

Builders still supply app dependencies, assets, business rules and app-specific witnesses. Do not call generic input completion before the hosted wallet prepares its authority/change. Do not prepare a different transaction on a retry. The app still manages optimistic rendering and its durable accepted-but-unsigned queue. `prepare` may settle a prior signed request before constructing the next one; instant UI acceptance remains the app's responsibility.

`PilotWalletSession` is the trusted-wallet implementation, not an app-side key store. Its methods include grant, send, resume, stop, revoke and recover. All signed receipts are saved before service submission, uncertain outcomes block later spending, and stable IDs reject changed requests. A new session replaces the existing one only after saved receipts settle. Old app connections cannot sign, prepare effects, read another app’s receipts or stop its replacement through the popup protocol. The wallet profile shows all account receipts; app RPC logs are filtered to the requesting origin. Local disconnect stops new signatures and settles saved signed/submitted receipts before closing; use on-chain revoke to remove cryptographic session authority.

## Scoped off-chain actions

A message policy commits to a scope hash with direction `message`. The wallet signs an envelope binding the account hash, app origin, session key, scope, message, nonce and expiry. Use `provider.request('signMessage', { scope, message, nonce })` and `verifyPilotScopedMessage` in the receiving API. The verifier checks the live authority and scope, so revocation invalidates verification of old-key messages. It does not store replay state: the API must atomically consume its expected nonce and enforce authorization/business rules.

The API must establish the expected account separately. `verifyPilotWalletOwnership` verifies a committed owner-input funding link; `verifyPilotAssertion` verifies the passkey itself when an original-owner identity proof is needed. Do not accept a caller-provided descriptor as proof of a pre-existing identity. Message scopes authorize the stated scope, not arbitrary original-wallet signatures. The existing social demo backend uses its original grant protocol and is not silently migrated.

## Development and deployment

```sh
npm ci
npm run contracts:build
npm ci --prefix apps/wallet
npm run dev --prefix apps/wallet
```

Wallet development origin: `http://localhost:5176`; demo: `http://127.0.0.1:5174`; docs retain their existing port. Set `VITE_PILOT_WALLET_URL` in the demo to the wallet's exact URL. The wallet needs `VITE_PILOT_PAYMASTER_URL`; optionally `VITE_PILOT_WALLET_RPC` and `VITE_PILOT_WALLET_MAX_FEE`. The configured deployment pool must match. Add the **wallet origin** to the paymaster's browser-origin allowlist, because that origin submits sponsored requests. Apps communicate with the wallet; they do not receive a pool secret.

`deployments/pilot-sponsored.json` has `passkey: null` and `walletSession: null`. After an explicit deployment decision, the prepared command is `npm run paymaster:deploy -- wallet`. It deploys these two new binaries, leaving `both` and `account` with their previous meanings. Code-cell capacity is separate from user budgets; review the displayed deployment cost first. No contract was deployed or pool funds spent as part of implementation.

For Vercel, add a third project rooted at `apps/wallet` using its `vercel.json`, with access to sources outside the root. Keep demo/backend and docs as their existing separate projects. Use a stable wallet domain before registering durable passkeys; passkeys are RP-bound and changing domains is not automatic migration. No database credentials or private keys belong in this static wallet project.

## Boundaries

- Owner keys remain in the authenticator. Session private keys remain in browser storage **on the wallet origin**. The integrating app cannot read them across origins, but a compromised wallet origin can use an active session key within its on-chain grant. This is not hardware isolation for session keys. A compromised wallet approval UI can also misrepresent an owner operation; WebAuthn verifies the origin/user and challenge, not a transaction amount on a separate trusted display.
- One active on-chain session per account. Multiple independent grants, overlapping session settlement and app-isolated sub-budgets are not implemented. Replacing a session invalidates the old key when the replacement commits.
- No trustworthy on-chain upper timestamp bound is claimed. Expiry is wallet/verifier enforcement; a copied key can still act under its remaining on-chain policies until revoked or exhausted. Use on-chain revocation for cryptographic invalidation.
- Metadata/account discovery is shared across apps using the same wallet origin in the same browser. Passkey synchronization does not synchronize browser metadata or receipts. Import the public recovery descriptor on another device with access to its passkey. No hosted credential directory or globally enforced usernames are added by this flow. Account labels are local labels.
- The popup must stay open. Shared multi-tab requests require the exclusive Web Lock and fresh state checks; an independent browser/device can race the same singleton and must reconcile conflicts. Missing local receipts do not prove another device is idle.
- Initial setup needs owner funding plus occupied state capacity and an ordinary owner proof cell. Session budget counts positive net CKB loss, not a universal NFT/token quantity limit.
- Recovery returns ordinary CKB and the authority cell. Other typed/data-bearing assets need compatible builders and continue to obey their app scripts. Lost passkeys need an authenticator backup/recovery mechanism; there is no social recovery or replacement-owner ceremony in this preview.
- The contracts, SDK tests and browser tests do not constitute an independent audit or live mainnet readiness.

## Verification record

- Contract build and VM tests: 56 passed, including 15 new passkey/session tests.
- SDK/server: typecheck/build passed; 99 passed, 5 PostgreSQL integration tests skipped without `PILOT_TEST_DATABASE_URL`.
- Docs: 14 passed and production build passed.
- Existing demo browser suite: 14 passed. New isolated wallet browser suite: 3 passed with Chromium virtual authenticators and real distinct localhost origins.
- Production builds for wallet, demo, React package and docs are checked separately. Vite's existing bundle-size/dependency warnings do not indicate deployment.
- No contracts deployed, no public pool/deployer funds spent, no local CKB node started. Live hardware-passkey/public-testnet verification remains an activation step.
