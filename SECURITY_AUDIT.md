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

The pool key remains a server-side custody risk; CORS is not caller authentication and valid transactions can consume an open subsidy. Spending limits bound exposure but do not prevent Sybil identities. All service instances sharing the key require one shared persistent journal; deleting or splitting it breaks accounting/lease safety. Existing signed records are retained and need operator archival before the configured journal record limit. A node dry-run and spendable balance do not guarantee eventual inclusion. Reusable sponsored delegation has no on-chain cumulative per-session fee counter; its local allowance can be reset by bypassing the SDK, so the server caps remain essential. Counter-sponsored allowance is on-chain. Public sponsorship is not yet deployed or funded.
