# Pilot passkey wallet

Implemented locally on 2026-10-21. This is a separate wallet architecture alongside the existing external-wallet and broad-key account APIs. It is a testnet preview; the original owner and session contracts were deployed on CKB testnet and verified on 2026-10-23. The embedded-modal revision needs a new passkey owner-lock deployment; the session contract is unchanged. A live hardware-passkey testnet flow is not yet verified.

## Ownership and isolation

Pilot owns its authentication experience. `createPilotPasskey` creates an ES256 discoverable passkey with mandatory user verification on the **Pilot wallet origin**. The owner private key stays with the authenticator. The public credential ID, public key, RP ID, exact origin and account label are stored as metadata. No JoyID account is required.

`apps/wallet` is hosted on its own trusted origin and embedded as an iframe inside an SDK-owned dark modal over the integrating app. No new browser window opens. `PilotWalletProvider` connects an app to it using messages bound to the exact wallet origin, actual iframe/parent Window and a random channel. Users explicitly review the requesting browser origin, select policies and approve a spending amount. Requests cannot choose a different paymaster or RPC: those come from the wallet's own configuration. No owner or session private keys cross the transport. Untrusted app names/policies are rendered as text, not HTML.

`PilotWalletProvider.connect()` opens the modal. Users select/create an account, complete the device passkey prompt, review unchecked app policies and a budget, and authorize the exact grant using an in-frame review dialog and passkey. After chain confirmation the modal hides automatically. Its iframe remains mounted so approved actions continue without owner prompts. `provider.open()` reopens the account controls; `provider.hide()` and the Close/Escape controls hide the UI without ending the session. `disconnect()` waits for saved signed transactions to settle before removing the signer. If settlement fails, the connection remains available for reconciliation. `dispose()` is local teardown, not on-chain revocation or proof that pending work settled.

The integrating app must be a top-level page. The SDK delegates `publickey-credentials-create` and `publickey-credentials-get` to the wallet frame. App CSP must permit that origin in `frame-src` (or its fallback); app Permissions-Policy must not block those features. With a strict style CSP, pass `styleNonce` for the SDK modal stylesheet. The wallet response allows HTTPS embedding and local development, rather than sending `X-Frame-Options: DENY`. The native device passkey prompt remains part of authentication; it is not a wallet popup.

Embedded storage/passkey support depends on the browser. Storage can be partitioned by the top-level site or blocked entirely; a shared wallet URL does not guarantee shared account discovery across apps. Metadata/receipts stay in the available wallet storage partition; passkey sync does not sync those records. Restore with the public descriptor and original passkey when needed. Blocked storage is reported and wallet actions fail closed. Safari alone uses a temporary top-level passkey window; this is not a storage-denial fallback, Storage Access API workflow or hosted discovery service.

## Contracts and authorization

### Passkey owner lock

`contracts/passkey-lock` pins a compressed P-256 public key, SHA-256 RP ID hash and SHA-256 exact-origin hash. A spend verifies:

- The WebAuthn assertion's RP hash, user-presence and user-verification flags.
- `webauthn.get`, the expected challenge, exact wallet origin, and signed embedding context. Cross-origin assertions require a secure serialized `topOrigin`; the wallet also checks it equals its verified actual parent app origin. Top-level assertions must not contain a contradictory `topOrigin`. The on-chain owner lock authenticates the wallet credential and transaction; it does not maintain a registry of permitted apps.
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
    A->>W: Embed isolated wallet in SDK modal; request policies and budget
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
    W-->>A: Public address and confirmed connection
    A->>A: Hide modal; retain mounted signer iframe
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
// Call from the Connect wallet button. No browser popup opens.
const connection = await provider.connect({
  name: 'My app',
  budget: ccc.fixedPointFrom(200).toString(),
  policies: myExplicitCellPolicies,
});
const signer = new PilotHostedSigner(new ccc.ClientPublicTestnet(), provider);
// Start with requested app effects; the wallet adds its authority successor/change.
const tx = await signer.prepareTransaction(appTransaction);
const hash = await signer.sendTransaction(tx, `purchase:${purchaseId}`);
// Reopen the account from your connected-account button: provider.open().
// Close/hide retains signing; disconnect settles before removing the frame.
// Persist the prepared bytes and stable ID; retry those exact values after response loss.
const logs = await provider.request('logs');
```

Builders still supply app dependencies, assets, business rules and app-specific witnesses. Do not call generic input completion before the hosted wallet prepares its authority/change. Do not prepare a different transaction on a retry. The app still manages optimistic rendering and its durable accepted-but-unsigned queue. `prepare` may settle a prior signed request before constructing the next one; instant UI acceptance remains the app's responsibility.

`PilotWalletSession` is the trusted-wallet implementation, not an app-side key store. Its methods include grant, send, resume, stop, revoke and recover. All signed receipts are saved before service submission, uncertain outcomes block later spending, and stable IDs reject changed requests. A new session replaces the existing one only after saved receipts settle. Old app connections cannot sign, prepare effects, read another app’s receipts or stop its replacement through the iframe protocol. The wallet profile shows all account receipts; app RPC logs are filtered to the requesting origin. Local disconnect stops new signatures and settles saved signed/submitted receipts before removing the signer iframe; use on-chain revoke to remove cryptographic session authority.


### Build policies after account selection

Apps whose transaction locks depend on the selected Pilot address can use `buildPolicies` instead of a fixed `policies` array:

```ts
const connection = await provider.connect({
  name: 'My app',
  budget: ccc.fixedPointFrom(200).toString(),
  async buildPolicies(selected) {
    // Public metadata only. No active signer or spending approval yet.
    // selected.address is the session account; selected.ownerAddress is its owner.
    // Implement this function in your app using your contracts/builders:
    return appPoliciesForAccount(selected);
  },
});
```

`buildPolicies` receives a `PilotWalletSelectedAccount`: `address`, `ownerAddress`, public `account` descriptor and `appOrigin`. It returns a catalog of `PilotCellPolicy` values, directly or through a promise. The wallet creates/restores the descriptor after passkey authentication, sends public metadata through the bound connection channel, displays returned policies unchecked, and requires explicit selection and owner approval. The callback is not an authorization and must not call signing APIs or assume `provider.account`/`provider.connected` is active. It may read public chain data to calculate exact lock/type/data hashes. Policy limits (50 offered, 16 selected), exact-hash validation and spending rules are unchanged; a scope hash with direction `message` does not authorize transaction outputs. One app action may need several cell policies.

For a new account, fund the passkey owner first: its initial live funding input determines the session TYPE_ID/address. The modal displays the owner funding address, then Load account permissions retries after funding or a builder failure. No funding transaction is signed merely to reveal the account descriptor. An externally spent seed still invalidates initial funding; approval must not silently use another address. Existing funded descriptors are restored. Account changes discard old policies/selections and invoke the builder again; replies bind the app/wallet source and origins, connection request and selection token. Recheck account identity under the approval lock before granting. Keep builder results specific to the selected account and current app context rather than caching a previous account’s permissions.

Builder errors stay in the modal for retry; `connect()` remains pending until successful grant/resume or provider disposal. Fixed-policy `connect({ policies, ... })` remains supported. Update/reinstall the SDK in the integrating app and redeploy `apps/wallet` together for this handoff; no on-chain contract deployment is required. It resolves address-dependent policy construction, not blanket authorization of unknown future contract instances. The session remains unapproved until the user completes review.

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

The original testnet transaction `0x2fc1cfa4046cdb186eb8ab7adc1cfe19ea3b116a7a5e3480530b73475b0a78be` remains historical: original owner output 0 and live `walletSession` output 1. The old owner code cell was consumed on 2026-10-23 to reclaim 83,837 test CKB in transaction `0x6843ea0f8c10d310ebd2b647028c709f3280b062295cbf4e9b431a06d510b173`. Its record is archived as `retiredPasskeyLegacy`, and `passkeyLegacy` is unset. The original owner lock rejects embedded assertions. The revised `passkey` contract is now deployed in transaction `0x771edc9c5daf2f2e4c40eac48e3fc909f943d9541d59c6863454ede0f015f8d3` (output 0). Its live code hash matches the SDK pin; the session contract is reused. Deployment used `npm run paymaster:deploy -- passkey`. The fee was 0.00085451 CKB; the code cell holds 85,118.99521939 CKB, preserving the sub-minimum change under the deployer lock. Deployment journals include the owner-code revision to avoid reusing the original deployment’s signed transaction.

Old passkey descriptors without a code hash resolve to the original lock, preserving funding addresses. New descriptors explicitly pin the revised hash. Existing owners can export/import metadata, but recovery through the consumed old deployment is unavailable. The old lock also cannot authorize assertions inside an app iframe. Do not treat this as automatic migration of funds, app ownership or accounts. New embedded accounts have new owner/session identities. Publish new deployment metadata and rebuild wallet/backend/apps after activation. Code-cell capacity is separate from user budgets and sponsorship.

For Vercel, add a third project rooted at `apps/wallet` using its `vercel.json`, with access to sources outside the root. Keep demo/backend and docs as their existing separate projects. Use a stable wallet domain before registering durable passkeys; passkeys are RP-bound and changing domains is not automatic migration. No database credentials or private keys belong in this static wallet project.

## Boundaries

- Owner keys remain in the authenticator. Session private keys remain in browser storage **on the wallet origin**. The integrating app cannot read them across origins, but a compromised wallet origin can use an active session key within its on-chain grant. This is not hardware isolation for session keys. A compromised wallet approval UI can also misrepresent an owner operation; WebAuthn verifies the origin/user and challenge, not a transaction amount on a separate trusted display.
- One active on-chain session per account. Multiple independent grants, overlapping session settlement and app-isolated sub-budgets are not implemented. Replacing a session invalidates the old key when the replacement commits.
- No trustworthy on-chain upper timestamp bound is claimed. Expiry is wallet/verifier enforcement; a copied key can still act under its remaining on-chain policies until revoked or exhausted. Use on-chain revocation for cryptographic invalidation.
- Metadata/account discovery is scoped to the wallet origin and browser storage partition; cross-site embedding can produce separate partitions even in the same browser. Passkey synchronization does not synchronize browser metadata or receipts. Import the public recovery descriptor on another device with access to its passkey. No hosted credential directory or globally enforced usernames are added by this flow. Account labels are local labels.
- The signer iframe must remain mounted, even while its modal is hidden. Navigation/reload or disposal removes that runtime; reconnect and reconcile saved receipts. Shared multi-tab requests require the exclusive Web Lock and fresh state checks; an independent browser/device can race the same singleton and must reconcile conflicts. Missing local receipts do not prove another device is idle.
- Initial setup needs owner funding plus occupied state capacity and an ordinary owner proof cell. Session budget counts positive net CKB loss, not a universal NFT/token quantity limit.
- Recovery returns ordinary CKB and the authority cell. Other typed/data-bearing assets need compatible builders and continue to obey their app scripts. Lost passkeys need an authenticator backup/recovery mechanism; there is no social recovery or replacement-owner ceremony in this preview.
- The contracts, SDK tests and browser tests do not constitute an independent audit or live mainnet readiness.

## Verification record

- Contract build and VM tests: 58 passed, including valid embedded context and missing/insecure/contradictory/tampered top-origin cases.
- SDK/server: typecheck/build passed; 100 passed, 5 PostgreSQL integration tests skipped without `PILOT_TEST_DATABASE_URL`.
- Docs: 15 passed and production build passed.
- Existing demo browser suite: 14 passed. New isolated wallet browser suite: 6 passed, covering real passkey creation/sign-in, source isolation, modal lifecycle, settlement failure, cross-site embedding and denied storage with Chromium virtual authenticators; these are not public-chain browser tests.
- Production builds for wallet, demo, React package and docs are checked separately. Vite's existing bundle-size/dependency warnings do not indicate deployment.
- The revised embedded owner and unchanged session code cells were verified live against their SDK pins on 2026-10-23. The original owner code cell was consumed to reclaim capacity. This is not a browser end-to-end chain proof. Live hardware-passkey/public-testnet testing remains an activation step; no local CKB node was started.

## Embedded UI trust boundary

The app can position, hide or overlay its embedded frame. Origin-bound messages, WebAuthn parent checks and wallet-side policy validation do not make a malicious embedding page a trusted transaction display. Review the actual requesting app origin and permissions. The wallet signer origin remains trusted and session keys remain software-accessible there. This preview does not claim protection against all clickjacking, malicious-app presentation, every browser’s third-party storage rules or credential loss. A broader supported-device matrix and authenticated discovery/receipt backup remain V2 work.

## Compact modal presentation

The embedded SDK modal follows the original demo’s visual style with one task per screen: Welcome to Pilot → sign in or create a Pilot passkey account → select permissions and budget → profile. The isolated iframe is a signing boundary, not a full website/dashboard shown in a modal. The profile holds balances, address copying, permission review, expandable queue/all receipts, recovery and public backups. Sign-in can select a known Pilot passkey or import a public descriptor; account names remain local labels. There is no external owner-wallet, Add wallet or Add JoyID step. The standalone wallet keeps its recovery dashboard. Closing the modal keeps the isolated signer mounted; on-chain authority and fee sponsorship are unchanged. No new contract deployment is required for this UI change.

### Hosted wallet with a local app

When embedding the hosted HTTPS wallet, serve the integrating app over trusted HTTPS too, including local development. Chromium/Brave can report “WebAuthn is not supported on sites with TLS certificate errors” for a hosted wallet inside an HTTP localhost page even when the wallet certificate is valid. Use a trusted local certificate or an HTTPS preview deployment; clicking through an untrusted-certificate warning is insufficient. Localhost-to-localhost virtual-authenticator tests do not verify this hosted-wallet configuration. Safari embedded passkey restrictions are handled by a Safari-only top-level authentication window; allow popups when prompted.

Safari authentication uses a user-clicked “Continue in Pilot” window on the same wallet origin (`/auth.html`). Creation returns only the public passkey descriptor; signing returns a challenge-bound assertion which the frame verifies cryptographically. Results require the exact opened Window, wallet origin and fresh request token. Session keys and journals stay in the wallet frame. The top-level window shows the requesting app and an explicit passkey button; owner transaction details remain reviewed in the modal. Closing the window cancels authentication; blocked popups can be retried. Other browsers do not use this fallback. The production build includes both wallet and authentication entry points. Do not add COOP headers which sever the opener relationship. This has browser-automation coverage using Chromium virtual authenticators with Safari detection; actual Safari/device verification remains required. No new contract deployment is needed.
