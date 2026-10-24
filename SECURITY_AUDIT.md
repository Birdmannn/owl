# Pilot signing and identity security review

Review date: 2026-10-17. Scope: the working tree, including the reusable delegation lock, legacy counter lock, SDK/adapters, React consent UI, demo session restoration, username verification/transfers, and off-chain social verifier/storage. This is an assisted code review with adversarial regression tests, not an independent OpenAI certification, formal verification, or a guarantee that no vulnerabilities remain.

## Assessment

Pilot is suitable for continued **bounded testnet prototyping**. It is not ready to protect valuable mainnet assets. The most important unresolved issues are browser session-key custody and the owner-lock assumption described below. On-chain expiration also remains local only.

A username or a storage-key name is never sufficient authorization. On-chain authority comes from the actual lock args and valid transaction signatures. Off-chain authority comes from the owner's signed grant plus a valid session signature; the receiving application must enforce replay protection, revocation, and its own business rules.

## How the correct user is bound

| Boundary | Actual check |
| --- | --- |
| Owner wallet → delegated cell | The owner signs setup. The cell lock commits the owner's **full lock-script hash**, compressed session public key, manifest hash, app type-script hash, selected transition rules, fee cap, and capacity floor. The legacy counter commits a smaller fixed counter policy. |
| Session → app action | The reusable lock verifies the session signature over the raw transaction, action hash, and every witness. Exactly one input/output must preserve the approved lock and app type and perform only the selected fixed `u64` change. Unrelated state bytes cannot change. |
| Cell → next cell | The signed transaction binds the consumed outpoint. The chain cannot spend it twice. Adapters independently check proposed effects and keep exact signed bytes for retries. |
| Wallet → restored browser session | The demo compares the saved delegation's owner lock to the connected wallet, or the off-chain grant's owner address to the connected address. Looking up an address-named localStorage entry alone is insufficient. |
| Owner → off-chain identity | CCC verifies the owner's message proof. Pilot independently derives the CKB address from the signing identity; a signed claim about someone else's address is rejected. |
| Grant → off-chain action | The action includes a content hash of the complete owner grant, app ID, exact origin/audience, permitted action, target, payload, nonce, and bounded validity period. The session signature commits these fields. |
| Receiver → application state | `acceptOffchainAction` verifies cryptography, then the receiving store atomically checks nonce reuse and revocation together with the mutation. Exact retries return the prior receipt. `verifyOffchainAction` alone is insufficient. |
| Username → payment | A verified name resolves to an address. Payment remains a separate owner-approved transaction. Username registration grants no spending or session authority. |

The manifest's human-readable labels are consent information, not on-chain enforcement. These checks do not make arbitrary contracts compatible, isolate a session key from the integrating app, or prevent an approved action from being invoked repeatedly within its allowance.

## Findings and remediation

Severity describes the plausible impact before the changes in this review. Conditional findings name their prerequisites.

### P-01 — High: mutable builder objects could alter the validation baseline — fixed

CCC constructors such as `CellOutput.from(existing)` and `Transaction.from(existing)` can retain object references. The manual owner-action builder received the same selected cell and nested output objects later used as the expected result. A builder could rewrite both the proposed output lock and the expected lock, defeating the independent review check. Unlike the session branch, the owner branch intentionally permits broad owner-authorized effects.

Preparation now retains independent source/output snapshots, gives builders cloned cells and transactions, clones wallet-prepared results, and compares them against the trusted baseline. Setup, manual actions, session builders, and recovery construction were hardened. App type-witness fields are preserved when adding the owner-mode witness.

Reproduction/regression: `test/signing-security.test.ts` attempts to change the builder's cell and output lock to the owner lock. Preparation rejects the redirect before owner signing, and the RPC source remains unchanged. A separate assertion verifies type witnesses survive.

Files: `src/ckb/delegation.ts`, `src/ckb/owner.ts`.

### P-02 — Critical if a permissionless lock is used as owner: input presence is not universally proof of consent — SDK mitigation; contract assumption remains

Both contract owner branches accept a transaction containing an input whose lock hash equals the configured owner hash. This is sound only when that lock requires owner authentication for **every spend**. An Anyone-Can-Pay input can be consumed and recreated without the owner's signature. An attacker could include that input, satisfy the owner-presence check, and redirect the delegated cell. An always-success owner makes the same problem explicit.

The SDK now refuses new on-chain session funding for unknown owner locks and optional/permissionless modes. It accepts recognized normal signature configurations: secp256k1, normal OmniLock identities used by supported wallets with flags zero, primary JoyID, normal Nostr, and the recognized PW lock configuration. An otherwise usable wallet may therefore be rejected for on-chain setup. Username registration and off-chain signing still independently verify message proofs and do not use this owner-input shortcut.

**This is not a contract-level repair.** Existing cells created with ACP, unknown permissive locks, or manually bypassed SDK guards remain unsafe. Do not fund those configurations. Recover such cells through their owner wallet. Recovery remains available rather than being blocked by the new setup guard. A future contract version needs an owner-authentication design that proves authorization under each supported lock mode; it will require a new code hash and deployment/migration. SDK checks cannot protect someone who directly constructs an unsafe lock.

Evidence: new VM test `permissionless_owner_input_is_not_a_signature_proof` demonstrates that an always-success owner input permits a redirect without an owner signature. SDK tests reject ACP, OmniLock ACP flags, and unknown locks. [Nervos RFC 0026](https://github.com/nervosnetwork/rfcs/blob/master/rfcs/0026-anyone-can-pay/0026-anyone-can-pay.md) explicitly defines signature-free ACP spending when deposit conditions hold. The VM reproduction uses always-success; the ACP attack is inferred from those documented unlock rules, not a separately executed ACP VM reproduction.

Files: `contracts/delegation-lock/src/main.rs`, `contracts/session-lock/src/main.rs`, `src/ckb/owner.ts`, `src/ckb/counter.ts`, `src/ckb/delegation.ts`.

### P-03 — Medium: restoring a valid grant under another account's storage key could misattribute actions — fixed in demo; SDK check available

A valid grant/key pair for Alice placed under Bob's storage key could be used while the UI showed Bob. The backend would correctly attribute the action to Alice, but the frontend identity was misleading. This was not a forged-owner signature vulnerability.

`PilotOffchainSession.create(authorization, manifest, key, now, expectedOwnerAddress)` now optionally enforces the connected owner. The demo always supplies that address and checks saved actions/revocations before retries. Delegation restoration compares the connected owner's full lock against the saved owner. Saved owner receipts are scoped to the connected owner/app before resubmission, and reconciliation uses that exact validated receipt snapshot rather than loading a replacement from storage. Other SDK consumers must also enforce their connected account when restoring sessions.

Regression: a real, valid second owner's off-chain grant is injected into the connected wallet's browser slot. Signing stays disabled and the modal excludes the foreign owner's history. SDK tests cover the expected-owner mismatch.

Files: `src/offchain.ts`, `src/ckb/delegation.ts`, `apps/demo/src/OffchainSocial.tsx`, `apps/demo/src/CellDelegation.tsx`.

### P-04 — High conditional on a faulty/malicious wallet integration: reviewed transaction effects could change during preparation/signing — hardened

Legacy counter owner operations used the wallet's combined prepare/sign/send path without independently validating its final prepared effects. Username transfers also called a prepare-and-sign method after displaying their review.

Counter setup/recovery now validate prepared inputs, outputs, state, owner change, and a 0.01 CKB owner-operation fee ceiling, then use signing-only and compare the raw transaction hash and app type witnesses before broadcasting. Counter adapter/owner operations reject unrecognized `counter-v1` binaries. Transfers prepare before the displayed review, reject changed input/output effects, then use signing-only and compare the signed result with the reviewed transaction. Delegation owner paths retain these checks as well.

This protects against inconsistent integrations and changed reviewed effects; a compromised wallet that controls the owner's private key remains outside Pilot's protection. Allowed signature witness changes still depend on the underlying lock semantics.

Files: `src/ckb/counter.ts`, `src/ckb/owner.ts`, `apps/demo/src/UsernameTransfers.tsx`.

### P-05 — Medium: restored settlement records were insufficiently scoped — hardened; local journals remain untrusted diagnostics/state

The legacy counter adapter did not fully check its lock identity/fee metadata or scope its journal to the complete session. Saved confirmations could be accepted without a fresh chain check. Mutable adapter options could also change the local signing context after initialization.

Adapters now snapshot authority metadata and key bytes. Counter creation checks deployment/hash type, the fee encoded in lock args, session scope, and saved transaction signatures/lock identity; legacy journals are checked before gaining a scope hash. Counter settlement checks the full session descriptor. Delegation retries verify saved session signatures, action hash and output lock as well as action commitments and transaction hash. Cached confirmation flags are rechecked with the node before settling an action. Owner receipt resumption also rechecks confirmation rather than trusting a local boolean.

The engine's restored projected state/budget and local history remain editable browser records. These hardening checks do not turn localStorage into a trusted database or protect against malicious same-origin code holding the session key. Legacy journal upgrades cannot cryptographically authenticate an original local session UUID that was never committed on-chain.

Files: `src/ckb/counter.ts`, `src/ckb/delegation.ts`, `src/pilot.ts`.

### P-06 — High: session keys remain accessible to app JavaScript — open

The demo persists raw session private keys in localStorage. XSS, a compromised dependency, or malicious same-origin code can read them and sign any action allowed by the grant. A malicious host can invoke approved actions repeatedly and consume the allowed budget even without a new wallet prompt. The reusable modal is not a separate security origin or vault.

The chain still constrains a stolen on-chain key to its actual cell policy, but this is not sufficient custody for valuable assets. Before production, move key custody and policy checks into a reviewed isolated controller/vault, minimize third-party code, and enforce appropriate deployment CSP. Encrypting a key with another key available to the same JavaScript would not resolve this threat. No production vault or deployment-level CSP verification was added in this change.

### P-07 — Medium: on-chain session expiry is local only — open design limitation

A copied session key can continue signing allowed chain transitions after the browser's session clock expires, until recovery consumes the cell or budget/transition bounds prevent further use. The contract does not commit/enforce the SDK expiration timestamp. Off-chain grant/action expiry is signed and enforced by the receiver; that is a separate mechanism.

A new contract policy/deployment is needed for enforced on-chain expiry. Disconnecting or closing a modal is not revocation. Do not advertise local expiry as a chain security boundary.

### P-08 — Medium availability/recovery risk: legacy owner recovery lacks a mandatory durable receipt store — partly resolved

Legacy setup could lose its submitted hash before persistence after an uncertain wallet response. Counter setup now exposes `onSigned(cell, bytes)` **before broadcast**; the demo persists those bytes and the cell and reconciles the same transaction on restore. Storage failure in that callback prevents broadcast.

Direct low-level consumers must provide durable persistence; the hook is optional for compatibility. Legacy `revokeCounter` emits signed bytes to its diagnostic observer, but does not yet require the durable receipt-store protocol used by `submitOwnerDelegationTransaction`. A failed diagnostic write or lost recovery response can require manual chain reconciliation. Do not request a fresh setup or discard unresolved receipts to work around a timeout. The reusable delegation owner path is preferred and requires persistence before broadcast.

### P-09 — Low: transitive elliptic dependency advisory — open upstream dependency

`npm audit` reports [GHSA-848j-6mx2-7j84 / CVE-2025-14505](https://github.com/advisories/GHSA-848j-6mx2-7j84) through CCC → JoyID → Nervos SDK utilities → elliptic. No nonbreaking fix for the root installed dependency graph was offered. The demo/docs audit suggests breaking CCC downgrades for parts of the graph; those were not applied.

Audit totals: root 5 low, demo 21 low, docs 21 low; **zero moderate/high/critical npm advisories**. These are affected-package counts, largely one advisory propagated through dependency trees, not counts of independent exploits. Pilot's new session signatures use noble-curves. This review did not prove exploitability of the elliptic advisory through each supported wallet path.

## Hosting and receiver boundaries

- The social JSON service is a sample verifier on a persistent filesystem, not a production distributed database. Its mutation/replay/revocation checks must stay atomic. Ephemeral/serverless filesystems and separately writable replicas need a different store.
- CORS is a browser policy, not caller authentication. Requests without an Origin header still require valid owner/session signatures. A valid signed action may be relayed by anyone; applications needing a private feed, resource ACLs, moderation, or owner-specific quotas must enforce those separately.
- The social state/feed and username records are intentionally public. Avoid putting sensitive payloads into diagnostic logs. The new modal history writes explicit public metadata fields, not keys or arbitrary payload objects.
- RPC responses, configured known-script metadata and code-cell availability are trusted. Genesis/code-hash checks reject a mismatched honest endpoint; they do not make a malicious RPC a light client.
- The local activity list is filtered by connected owner and survives reloads on this origin. It is best-effort and editable, can hit browser storage quota, and does not reconstruct all activity across origins/devices or certify chain settlement. Off-chain “Accepted by app” is distinct from “Confirmed on-chain.”

## Validation

The review adds SDK tests for wrong-account restoration, owner-lock restrictions, builder-alias redirection, signing-time effect/type-witness changes, and private-field exclusion/account isolation in activity history. Existing tests cover changed permissions/targets/payloads, forged identities/signatures, replay, expiry, revocation, transaction shape, fees, protected capacity and type preservation.

Final command results are recorded below after verification. No internal CKB node was started and no new public-chain transactions were submitted for this review. Browser chain interactions use fixtures; VM tests run the compiled scripts directly. Existing testnet/devnet proof files cover earlier runs, not a new live deployment of these changes.


| Check | Result |
| --- | --- |
| `npm run check` | Typecheck and SDK build pass; 49 tests pass, one optional PostgreSQL test skipped because no isolated test database is configured. |
| `npm run contracts:test` | 23 VM tests pass, including the permissionless-owner limitation reproduction. |
| `npm run build --prefix packages/react` | Pass. |
| `npm run build --prefix apps/demo` | Pass. |
| `npm test --prefix apps/demo` | 9 browser tests pass, including live on-chain profile history, social history/reload, account isolation and mobile layout. |
| `npm run build --prefix apps/docs` | Pass. |
| `npm test --prefix apps/docs` | 6 tests pass. |
| npm dependency audit: root / demo / docs | 5 / 21 / 21 low affected-package reports; no moderate/high/critical reports. See P-09. |
| `git diff --check` | Pass. |

Rust dependency advisory scanning was not performed: `cargo audit` is not installed. This review did not include an independent cryptographic-library audit, fuzzing campaign, live extension/JoyID interaction, production deployment inspection, or new live-chain end-to-end transactions. The existing compiled contract hashes were unchanged.

## Paymaster follow-up

Separate sponsored policies preserve app capacity and pin pool input/change. The client independently checks original effects and zero user fee. The operator service bounds fees and owner/global daily spending, validates all scripts with a node dry-run before exposing a pool signature, and persists exact signed bytes/leases before broadcast. Tests cover output/dependency tampering, invalid signatures, pool conflicts, caps, restart and lost-response recovery. New policy VM tests cover pool redirect, user-capacity debit and signature/witness restrictions. This is implementation review and regression coverage, not independent certification.

The pool key remains a server-side custody risk; CORS is not caller authentication and valid transactions can consume an open subsidy. Spending limits bound exposure but do not prevent Sybil identities. All service instances sharing the key require one shared persistent journal (PostgreSQL now supported; see the serverless addendum); deleting or splitting it breaks accounting/lease safety. Existing signed records are retained and need operator archival before the configured journal record limit. A node dry-run and spendable balance do not guarantee eventual inclusion. Reusable sponsored delegation has no on-chain cumulative per-session fee counter; its local allowance can be reset by bypassing the SDK, so the server caps remain essential. Counter-sponsored allowance is on-chain. At the time of the original paymaster audit, public sponsorship was not deployed or funded; see the dated serverless addendum for current deployment status.

## Serverless persistence adaptation (2026-10-18)

Vercel now invokes exported request handlers; no server listener or ephemeral filesystem is used for persistence. DATABASE_URL is mandatory for serverless operation. PostgreSQL stores paymaster and social journal documents under authority-specific scopes, using SELECT FOR UPDATE transactions to serialize concurrent instances. Exact pool-signed bytes, fee accounting and input leases commit before broadcast/response. Rollback discards invalid submissions; ambiguous responses must retry original requests. Social state, replay receipts and revocation checks are atomic. PostgreSQL-backed rate limits survive cold starts; Vercel client IP headers are trusted only on that platform. Schema initialization is serialized across cold starts. Small connection pools, short lock waits and idle-transaction timeouts bound resource use.

The two sponsored contracts are now deployed and verified live on testnet and the pool was verified funded with 100,000 test CKB. Public service activation and a hosted sponsored user flow remain unverified. Private keys stay in server environment variables, never database rows or browser build variables. This adaptation retains the existing bounded journal documents and receipt limits; serialized RPC checks can limit throughput. A live JSON store is not auto-migrated: all instances must stop and preserve leases, fees, signed bytes, replay nonces and revocations during an explicit migration. Never use independent databases against the same funded pool. CORS and rate limits do not replace cryptographic authorization or prevent Sybil subsidy use. Database credentials and backup integrity remain part of the operator trust boundary.

## Persistent account implementation review (2026-10-20)

This addition has broader authority than the bounded session locks. Its account key can authorize arbitrary effects on its own cells when sponsorship is available; app type scripts still validate. SDK permission validators are not on-chain spending limits. Initial funding limits exposure to that account's funds, but future rewards/deposits also become accessible to its key. Browser-local keys remain accessible to same-origin JavaScript; the new account API is not a secure hosted custody service.

The new lock commits the full owner hash, account key, pinned pool and per-transaction fee cap. Automatic spending requires a unique ordinary pool input/change; pool loss equals the entire network fee. The signature commits every witness except the account signature and pool signature themselves, including type fields. Recovery requires the exact owner-lock input; supported SDK owners must require signatures. Recovery can work without the Pilot key but only revokes authority over consumed cells. Future deposits to an old address remain exposed to its old key.

The paymaster now requires a service-validated, confirmed owner-funding registration before automatic account sponsorship. An arbitrary descriptor claiming someone else's owner hash cannot consume their account sponsorship quota without that proof. Signed-but-unconfirmed funding is insufficient. Owner recovery remains possible with a real owner proof even if service registration is unavailable. This is not Sybil protection.

`verifyPilotAccountMessage` proves the NEW account key only. Receiving apps must not infer the original JoyID owner from an unverified descriptor; `verifyPilotAccountOwnership` checks the link against a committed funding transaction containing the exact owner input. Off-chain services still require replay protection and business rules.

Account transactions are journaled before signature exposure and retry exact bytes. Optional stable request IDs reject changed effects and prevent duplicate submission after app-response loss. Unknown failures retain reservations. Independent recovery stores its own public receipt before broadcast; it can race outstanding transactions when the original journal is lost, so reconcile actual chain state rather than assuming a cleared browser means no pending work.

The VM tests cover general payments, multi-input accounts, nonzero group positions, wrong-key/owner failures, changed payments and type witnesses, extra witnesses, pool identity/caps, fee conservation, and recovery without the Pilot key or pool. SDK tests cover owner isolation, storage failure, lost responses, request idempotency, scoped messages, forged owner links and independent recovery. No new account lock has been deployed or tested live on public testnet, and this is not an independent audit or production safety certification.

## Independent passkey wallet review — 2026-10-21

The new `apps/wallet` flow separates the owner passkey from restricted session signing. `pilot-passkey-lock` validates ES256 WebAuthn assertions, RP/origin/challenge and mandatory presence/verification. `pilot-wallet-session-lock` requires a real built-in TYPE_ID authority and enforces immutable policies, sequence, cumulative positive net CKB loss and full pool fee conservation. Owner-input recovery relies on the pinned signature-required passkey lock. VM tests cover real P-256 signatures, witness/payment tampering, state/key/policy mutation, wrong recipients, lookalike authorities and key rotation.

The app transport pins both origins, actual iframe/parent and a random channel. The wallet renders untrusted names/policies as text. Root metadata restoration retains public fields only. Account setup uses an owner-scoped Web Lock; signing and replacement use account-scoped exclusive journaling. Stale app connections cannot atomically stop or prepare against a replacement grant. App RPC logs are origin-filtered; the authenticated wallet UI retains full account logs. Signed bytes are persisted before submission, uncertain receipts block new spending, and independent owner recovery does not require the session key/journal.

Remaining boundaries: the wallet origin is trusted. Its JavaScript can use stored session keys within their on-chain grant, and a compromised approval UI could misrepresent an owner operation: WebAuthn authenticates the origin/user and signed challenge, not a hardware-displayed transaction amount. Protect that origin, dependencies and deployment access. Expiry remains wallet/verifier enforcement, not an on-chain upper time bound. Only one active on-chain session exists per account. Cell policies are not general ABI/token-amount constraints. Cross-device metadata/receipt synchronization and passkey/social recovery are absent. An imported public descriptor is not proof that another device has no pending work. Typed assets need compatible owner builders.

Browser tests use virtual authenticators and real separate origins; SDK/server tests use mock chain services, and contract tests execute separately in CKB-VM. Both new deployment records remain unset. No live hardware-passkey testnet run or independent external audit is claimed.

## Embedded SDK modal revision (2026-10-23)

The browser popup transport is replaced with an SDK-owned native dialog containing a cross-origin wallet iframe. Messages pin the actual parent/frame Window, exact origins and random channel. Successful setup hides the dialog but retains the signer; disconnect failure keeps it available for settlement. Close/hide is not revocation. Native passkey prompts remain necessary. Owner confirmation uses an in-frame dialog rather than browser `window.confirm`, which is unsuitable in cross-origin frames.

The revised passkey lock accepts signed embedded context: `crossOrigin: true` requires a secure serialized `topOrigin`; wallet-side assertions additionally bind that field to the verified actual parent app. Top-level contradictory context is rejected. Existing transaction/witness, RP, owner-origin, UV and signature checks remain. This authenticates the owner, not a chain-maintained app allowlist. New owner code requires deployment. The original top-level owner hash/deployment is retained for existing-address recovery; public descriptors missing a code hash resolve to that legacy version. New descriptors pin the new hash, and no legacy funds/identity migration is implied.

Embedding permits the parent app to position, obscure or overlay the wallet frame. The native passkey prompt does not independently show transaction effects. This implementation is not protection against all malicious-host UI redressing. The signing origin remains trusted; its software session keys remain accessible to its own scripts. HTTP embedding policies and app permissions are deployment requirements, not app authentication. Browser storage can be partitioned/blocked; partition-local Web Locks and receipts do not coordinate other sites/devices. No hosted receipt/discovery synchronization or Storage Access API recovery workflow is implemented. Test coverage uses Chromium virtual authenticators, not a complete hardware/browser/device matrix or a live testnet browser proof. No new deployment was broadcast as part of this revision.

## Safari top-level passkey bridge

Safari authentication uses a user-clicked “Continue in Pilot” window on the same wallet origin (`/auth.html`). Creation returns only the public passkey descriptor; signing returns a challenge-bound assertion which the frame verifies cryptographically. Results require the exact opened Window, wallet origin and fresh request token. Session keys and journals stay in the wallet frame. The top-level window shows the requesting app and an explicit passkey button; owner transaction details remain reviewed in the modal. Closing the window cancels authentication; blocked popups can be retried. Other browsers do not use this fallback. The production build includes both wallet and authentication entry points. Do not add COOP headers which sever the opener relationship. This has browser-automation coverage using Chromium virtual authenticators with Safari detection; actual Safari/device verification remains required. No new contract deployment is needed.

A same-origin compromised wallet page remains trusted and can request owner assertions; this bridge is not independent transaction-display protection. App origins receive no assertion through this channel. Requests are sent by postMessage after a ready handshake; no private keys or request payloads are placed in URLs. The URL fragment contains only a fresh correlation token.
