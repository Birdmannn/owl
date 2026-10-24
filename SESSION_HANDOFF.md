## Latest update: old SDK / new wallet progress compatibility (2026-10-24)

User reported "Cannot read properties of undefined (reading appOrigin)" when signing in with saved passkey in Brave. Error is in integrating app Errors panel, not wallet. Hosted wallet currently sends new progress events but older app SDK receive() interprets ANY envelope with pending ID as final response; `connect()` then reads appOrigin from undefined result. Fixed capability negotiation: current provider adds `progress=1` iframe query flag; wallet notifyProgress only emits for opt-in. Older SDKs remain compatible after wallet redeploy, though old response timeout behavior remains until app SDK rebuild. New provider requires final response method === pending method and validates absent/nonobject connect result before reading appOrigin. Unknown future events cannot resolve pending connect. Browser regression fixture emulates the old matching-ID SDK while creating/reloading/signing in using actual virtual WebAuthn; progress must be absent and sign-in successful. Timer fixture also sends unknown event with matching ID to test current provider defense. README/web docs updated. Do not clear user storage or regenerate passkeys; not an authenticator issue. No contract changes needed.

Validation: root check passed (114 tests passed, 5 environment-dependent skips); wallet build and 11/11 browser tests passed, including saved-passkey create/reload/sign-in with legacy SDK fixture; docs build and 15/15 tests passed. Initial legacy test fixture was blocked by Chromium local-network checks when served through route.fulfill; converted it to real localhost tests/legacy-app.html so browser address-space classification is accurate. No hosted deployment performed.

## Latest update: idle modal response timeout (2026-10-24)

Traced "retry the same action request ID" to `PilotWalletProvider.request()` using one default 300,000ms timer for connect, all signing and reads. It fired while users were still choosing accounts/permissions and showed transaction-uncertainty text for every method. Connect now starts without a response timer while awaiting input. Bound wallet progress waiting-for-user clears the timer; processing restarts it. Approval notification also clears timer for backward-compatible one-time review. Main wallet reports progress during UI operations, confirmReview, owner assertions (including Safari) and passkey creation. Unknown/spoofed progress cannot resolve or pause another request (existing source/origin/channel + pending ID checks). Genuine send timeout retains exact ID/reconciliation warning; message timeout mentions same nonce; connect/other failures get separate guidance. Loading remains timed, native/Safari auth time limits unchanged, session expiry unchanged. Close pending connect hides and preserves request; dispose tears it down. Rebuild/redeploy wallet and SDK clients; no contracts changed. README/web docs updated. Browser clock/transport test covers >5min idle connect and one-time review, resumed processing timeout and rejection of parent-window forged progress.

Validation: root typecheck/tests/build passed (114 passed, 5 environment-dependent skips); wallet build and 10/10 browser tests passed; docs build and 15/15 tests passed. No hosted deployment performed.

## Latest update: resume hosted sessions after logout (2026-10-24)

User reported inability to reuse same-app session and "Initial funding input changed; rebuild the unfunded descriptor". Wallet always created a fresh key/grant on connect; disconnect set journal stopped and reload never restored saved keys/metadata. Added permissions-screen Continue existing session after passkey sign-in: loads account journal, saved key and per-key/legacy active expiry metadata, ensures offered policies match retained ones and current app budget accepts remaining amount. Explicit button calls new trusted `PilotWalletSession.resumeAppAccess()`: verifies owner/deployment, reconciles receipts, verifies exact app/key/expiry and live authority, then clears local stopped flag without modifying chain/key/budget/sequence/policies/expiry. Public RPC resume remains receipt reconciliation only. UI edits hide resume choice and require replacement review. Only one active session remains.

Fixed authority lookup to query saved receipt outputs directly before indexer lookup; transaction builder accepts that verified live anchor. grant refuses to treat a previously funded/closed account as initial funding when authority is unavailable. First funding ownerProof chooses the exact input committed by TYPE_ID, avoiding indexer cell-order mismatch. Truly spent unfunded seed still requires a new unfunded descriptor; funded identities are not silently rebuilt. Keys and per-key expiry metadata persist on wallet origin; per-key metadata saved before grant to survive interrupted initial confirmation. No contract changes/deployments. README and web docs updated. New unit tests cover reconnect without grant/sign/funding, preserved budget, indexer lag, expired/revoked/wrong-key/wrong-app rejection, closed-account funding guard and seed ordering.

Validation: root check passed (114 passed, 5 environment-dependent skips), wallet build and 9 browser tests passed, docs build and 15 docs tests passed. New reconnect behavior is verified with mocked-chain unit tests; live hosted reconnect/Safari hardware verification remains outstanding. No deployment performed.

## Latest update: one-time approval without reconnecting (2026-10-24)

Implemented for the hosted passkey-wallet protocol. Unselected transaction effects/message scopes request the existing owner passkey rather than reconnect/regrant. `src/wallet/session.ts`: trusted `approveOnce` callback, typed policy mismatch, transaction structure/budget/authority validation retained, owner-proof input added by wallet only, owner branch witness, same successor state/budget, passkey-marked receipt with stable ID/hash retry. Preparation permits effects awaiting review but never signs. Direct session callers without callback still reject unselected effects. App-supplied recovery-owner inputs rejected. One-time messages use version 2 owner assertion (version 1 unchanged); updated `verifyPilotScopedMessage` checks owner identity + live matching state. Message APIs must update verifier; caller still enforces expected account and atomic replay/business rules.

Wallet main shows exact effects/message in confirmReview, then reuses assertOwner (Safari-only auth window). Provider handles source/origin/channel/pending-request-bound approval notification by reopening existing iframe, closes automatically after request if it opened the modal, and sends cancelApproval on Close/Escape. No new account, key, grant or policy change. Cancellation before signing leaves state/connection intact; cannot retract an already signed transaction. Expired/stopped/replaced sessions and over-budget actions do not use this fallback. Owner proof cell and sponsorship required. Legacy wallet connectors unchanged. Rebuild/redeploy wallet + SDK clients and message verifier; no contract deploy. README/web docs updated. Wallet unit and browser tests added; virtual-authenticator/browser transport fixtures are not live-chain or real-Safari proof.

Validation for one-time approval: `npm run check` passed (109 tests passed, 5 environment-dependent tests skipped); wallet build passed; wallet Playwright 9/9 passed, including real virtual WebAuthn/Safari detection and a transport fixture proving same-frame reopen/cancel; docs build and 15/15 tests passed. No deployment performed.

## Latest update: Safari-only top-level authentication (2026-10-24)

User explicitly authorized top-level auth ONLY on Safari after Sequoia Safari rejected iframe creation even on HTTPS preview. Implemented apps/wallet/auth.html + src/auth.ts and src/auth-bridge.ts; main.ts routes embedded Safari passkey create/assert to a user-clicked same-origin window. Main account/permissions/profile UI stays in modal; Chromium/Brave keep embedded auth. Same wallet RP/origin, exact opener/window/origin/token handshake, assertion signature/challenge verification in frame. Session secrets/journals never leave frame. No storage fallback and no contracts changed. Build must deploy both HTML entry points; avoid COOP headers severing opener. Browser automation uses spoofed Safari UA + real Chromium virtual WebAuthn; no claim of actual Safari/device proof. Redeploy wallet; app provider API unchanged.

## Latest diagnosis: HTTP localhost parent with hosted HTTPS wallet

User’s app responds at http://localhost:3000 (Next.js); wallet https://owl-pilot.vercel.app responds 200 with valid TLS under curl validation and permits localhost framing/WebAuthn. Brave reports TLS certificate error at create; Safari on macOS Sequoia 15.8.1 reports ancestor-origin error. Chromium current ChromeContentBrowserClient::IsSecurityLevelAcceptableForWebAuthn exempts localhost caller origins, otherwise checks the top-level WebContents security level. An HTTPS hosted wallet caller inside an HTTP localhost parent is not covered by that exception. Correct prior advice: run parent app with trusted HTTPS or HTTPS preview; do not change wallet origin or bypass certificate security. Safari creation is a separate iframe compatibility limit. No SDK behavior changed. README/web docs/hosting notes corrected; browser tests so far used localhost wallet callers and virtual authenticators, not this exact hosted-wallet setup. Source: https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/chrome_content_browser_client.cc .

## Latest modal sizing update

The embedded SDK modal has no fixed minimum height: it uses the wallet frame’s measured content height including padding/margins, plus its 48px outer header and 2px border. Maximum outer height is 70vh; the frame scrolls when content exceeds that cap. README and web docs updated.

## Latest update: compact modal UX restored (2026-10-23)

Embedded wallet now shows focused welcome, passkey sign-in/create-account, permission/budget and profile screens in the earlier demo modal style. It no longer presents the standalone wallet dashboard in a long iframe page. Profile groups balances/address, permission review, expandable queue/all receipt logs, session/recovery and public backup/restore. Standalone dashboard remains for recovery. `PilotModal` and `PilotOffchainModal` no longer insert the legacy `PilotAccountMenu`; exported explicit legacy account APIs remain available for compatibility. No contracts or signing/custody boundaries changed, no further contract deployment needed. Local labels are not registered usernames. UI changes need wallet and integrating SDK builds/redeployment. Verified: SDK/React/wallet/demo production builds; 6 wallet browser tests, 13 demo browser tests and 15 docs tests; docs production build. Desktop and 390/320 px layouts checked without overflow or page errors. One obsolete JoyID-addition browser test was removed with the default menu; account identity isolation remains covered by unit tests and external-account-change regressions. The provider accepts source/origin/channel-bound height updates from the frame so short screens size to content while long screens scroll. No public-chain browser success is claimed.

## Latest update: revised owner deployed (2026-10-23)

User funded the remaining deployment amount with 350 CKB, confirmed transfer `0xe69e41fae08664b6abca387f7b99082247ac1af3d2d802db73e6fe765c45c10f`. Ran `npm run paymaster:deploy -- passkey`; committed deployment `0x771edc9c5daf2f2e4c40eac48e3fc909f943d9541d59c6863454ede0f015f8d3`, output 0. Revised owner code hash matches SDK pin `0x2ba431b27a844a3664e24c548ecd175cea3ba005590f4f362bee5a94acac92e6`. Session deployment reused. `passkey` is configured; legacy remains retired. Deployment fee 0.00085451 CKB; code cell holds 85,118.99521939 CKB. The deployer has no ordinary change from this transaction: the script now preserves sub-61 CKB change in output 0 rather than requiring another top-up or burning it as a fee. Signed deployment is journaled under ignored `.pilot/sponsored/deployment-passkey-2ba431b27a84.json`.

Next: rebuild/redeploy static wallet, demo/backend and integrating apps using the updated deployment metadata/SDK. Configure stable wallet URL and sponsorship origins. No remote Vercel deployment, commit/push or hardware-passkey public-chain end-to-end test performed. Earlier deployment-pending notes below are historical.

## Latest update: legacy owner capacity reclaimed (2026-10-23)

User explicitly authorized consuming the previous testnet owner code cell. Confirmed transaction: `0x6843ea0f8c10d310ebd2b647028c709f3280b062295cbf4e9b431a06d510b173`. Reclaimed 83,837 CKB to the deployer, less a 0.00000508 CKB transaction fee. Deployer balance after confirmation: 84,768.9960739 CKB. Revised owner requires 85,069 CKB plus fee: still short 300.0039261 CKB plus fee; a 350 CKB top-up is sufficient headroom. No revised contract was deployed. Original session code cell was not spent.

`passkeyLegacy` is now null; original public deployment metadata is archived as `retiredPasskeyLegacy` with reclamation transaction. Accounts depending on the consumed old code cell cannot spend/recover through it while unavailable. Earlier notes below describing a live legacy recovery deployment are historical and superseded by this update. Do not retry the reclamation or restore the consumed outpoint as active. Exact signed reclamation bytes are journaled at ignored `.pilot/sponsored/reclaim-legacy-owner.json`.

# Pilot session handoff

Updated: 2026-10-21 (Africa/Lagos).

## Embedded modal update (2026-10-23)

User requires the wallet inside an SDK modal, with no browser popup. `PilotWalletProvider` now owns a dark native dialog and isolated wallet iframe, checks actual source/origin/channel, delegates WebAuthn, and exposes `open()`/`hide()`. Confirmation hides the modal without unloading the signer; disconnect settles before teardown and retains the frame on failure. `dispose()` remains local teardown only. Wallet peers with its actual parent, checks signed topOrigin against that origin, uses in-frame owner review instead of window.confirm, and reports blocked storage. Browser storage may be partitioned by embedding app. No popup fallback or hosted discovery exists.

The revised passkey lock permits signed secure embedded context; it has a NEW hash. Current pin: `0x2ba431b27a844a3664e24c548ecd175cea3ba005590f4f362bee5a94acac92e6`; stripped binary 85,008 bytes. The standard deployer lock needs about 85,069 test CKB of code-cell capacity plus fee. `deployments/pilot-sponsored.json` deliberately sets `passkey: null`, preserves old deployment as `passkeyLegacy`, and retains the unchanged `walletSession`. Deploy only the revised owner with `npm run paymaster:deploy -- passkey` when requested/funded; no deployment was performed by this revision. Deployment journals include the owner-code revision. Old descriptors missing codeHash resolve to the legacy owner, preserving addresses, and can recover through direct trusted-wallet access. New passkeys explicitly pin the revised hash. There is no automatic funds/app-identity migration. Do not overwrite the legacy record or claim embedded public-chain success.

Wallet framing headers now permit HTTPS and local apps; X-Frame-Options DENY is removed. Apps must allow frame-src and delegated WebAuthn features, and strict style CSP can use provider styleNonce. A malicious host can overlay its frame; this is not trusted-display protection. Rebuild/redeploy wallet, backend and integrating apps after revised deployment. README, web docs, architecture, hosting and security notes track this change. Earlier popup/deployment notes below are historical. Validation: SDK/server 100 passed and 5 PostgreSQL skips; 58 contract VM tests; 15 docs tests; 6 wallet browser tests including cross-site virtual WebAuthn, modal lifecycle, failed disconnect and denied storage. Wallet/docs/demo/SDK/React production builds pass. Final demo regression suite: 14 passed. Modal visual checks at 1200, 390 and 320 px passed with dark mode forced even under a light system preference. Demo reconnect regression accepts CCC restoring an already verified owner while the chooser changes, without bypassing explicit unchecked permissions.

## Deployment update: 2026-10-23

Both passkey-wallet contracts are now deployed on CKB testnet in committed transaction `0x2fc1cfa4046cdb186eb8ab7adc1cfe19ea3b116a7a5e3480530b73475b0a78be` (passkey output 0, walletSession output 1). Live code cells and SDK hashes were verified via RPC. The user ran deployment after transferring 92,000 test CKB from the pool to the deployer. Earlier undeployed status below is historical. Next: push deployment records and source, host `apps/wallet` on a stable HTTPS origin, configure wallet/demo URLs and paymaster origin allowlist, redeploy backend/demo/docs, then run a real passkey funding/grant/action/recovery flow. Hardware-passkey end-to-end remains unverified.

## Latest update: independent passkey wallet implemented

The user subsequently asked to implement and test Cartridge-like independent passkey ownership, isolated signing and on-chain restricted sessions. That implementation is now present **alongside** the earlier broad-key account API described below. Read `PILOT_WALLET.md` first; it contains the current architecture, Mermaid flow, integration sketch and operational limits. `CURRENT_IMPL.md` remains the record of the preceding broad-key version.

New components:

- `contracts/passkey-lock`: ES256 WebAuthn owner lock; no JoyID required. Args: P-256 key33, RP hash32, exact-origin hash32. Mandatory user verification/presence, exact challenge/type/origin and full transaction/witness binding.
- `contracts/wallet-session-lock`: owner hash32, built-in TYPE_ID authority hash32, pool hash32, fee cap8. Every auto action consumes/recreates the singleton. State pins key, app-origin commitment, remaining budget, sequence and <=16 cell/message policies. On-chain policy/budget enforcement and owner-authorized state replacement/revocation/closure; no on-chain upper timestamp expiry.
- `src/wallet/{passkey,session,provider,code}.ts`: passkey creation/assertion verification, CCC owner signer, public descriptor parsing, trusted-wallet session engine, durable exact-byte receipts, stable request IDs, atomic scoped app disconnect/preparation, cell effect validation/building, scoped messages with live-authority verification, owner recovery without session key/journal, and app-side popup provider/CCC hosted signer. Public imports discard unknown fields; do not treat a submitted descriptor as proof of an existing identity.
- `apps/wallet`: a separate static Vite wallet, local URL **http://localhost:5176**. Do not use 127.0.0.1 for its WebAuthn RP ID. The popup must remain open. Passkey private keys stay in the authenticator; session keys remain in this trusted wallet origin's browser storage. Apps cannot read that storage. Requests pin origin, Window and channel; stale apps cannot stop a replacement grant. Wallet UI logs are complete; app RPC logs are origin-filtered.
- `apps/demo/src/HostedWallet.tsx`: an additional independent connection panel; old flight/CCC and broad-key account panels remain separate.
- Paymaster recognizes root/session hashes, validates committed passkey-owner funding registration and derives full owner quotas. `src/ckb/owner.ts` recognizes the pinned mandatory-signature passkey lock.
- Docs Board recognizes both wallet formats. README, web docs (new passkey-wallet page), VERCEL.md, .env.example, security/contract/paymaster docs updated.

Activation: `deployments/pilot-sponsored.json` still has `account: null`, and now also `passkey: null`, `walletSession: null`. No deployments or pool spending occurred. New explicit target **`npm run paymaster:deploy -- wallet`** deploys the two wallet binaries; `both` remains counter/delegation and `account` remains the earlier broad-key lock. Current stripped wallet binaries total about 190 kB, so code-cell deployment needs roughly 190,400 test CKB plus fees (deployer funds, separate from pool funds); review actual script output before proceeding. No deployment authorization was requested by the current user task.

Hosting adds an optional **third Vercel project**, root `apps/wallet`, using its vercel.json and shared sources outside the root. Wallet gets public `VITE_PILOT_PAYMASTER_URL` and optional wallet RPC/fee cap. Demo gets `VITE_PILOT_WALLET_URL`. Add the wallet origin to paymaster browser allowlists. Do not give this static project database credentials or pool/deployer private keys. Use a stable production wallet domain before registering credentials.

Latest verification: 56 VM tests; SDK/server typecheck/build with 99 passed and 5 PG skips; 14 docs tests; 14 existing demo browser tests; 3 new wallet browser tests with virtual authenticators and actual distinct localhost origins. Public testnet/hardware-passkey end-to-end is **not** verified. Consult `PILOT_WALLET.md` for the final verification record.

Limits: one active on-chain session; local/verifier expiry only; explicit cell hashes/capacity policies rather than ABI inference or universal asset-quantity limits; no hosted metadata directory/sync, globally claimed labels, social recovery or universal typed-asset recovery. Browser metadata restoration across devices needs public descriptors and an available original passkey. A compromised wallet origin remains dangerous. Closing/recovering the singleton requires an explicit replacement account for later fresh grants; the UI archives the old descriptor only once no live old-account cells remain. Do not lose receipts or assume other devices are idle.

Additional changed paths beyond the older inventory: `.env.example`, `VERCEL.md`, `src/ckb/owner.ts`, `contracts/tests/Cargo.toml`; new `PILOT_WALLET.md`, `src/wallet/`, `apps/wallet/`, `apps/demo/src/HostedWallet.tsx`, `contracts/passkey-lock/`, `contracts/wallet-session-lock/`, `contracts/tests/src/wallet.rs`, `test/wallet.test.ts`. All remain uncommitted; preserve them.

---

This is an internal continuation note, not public product documentation. Read `AGENTS.md` and `CURRENT_IMPL.md` before making changes. The latest requested implementation is complete locally; activation and live testnet verification remain outstanding. The user requested this context export so a new session can continue.

## Workspace and working rules

- Repository: `/Users/torti/ckb/owl`.
- The persistent-account implementation is uncommitted. The working tree was clean before that implementation; preserve its current changes. Do not reset or overwrite them.
- User requires both `README.md` and relevant `apps/docs/src/content.js` documentation to stay current with behavior, API and setup changes. Preserve concurrent docs/landing work. Run docs build and tests after web documentation changes.
- Do not expose private keys, wallet exports or environment secrets. No secrets are included in this handoff. `.pool/pool-export.txt` was mentioned earlier as a private export; do not print it.
- Do not start an internal CKB node. The user previously asked for it to be stopped. Contract tests use an in-process VM.
- No contract deployment, account funding, pool spending, commit or push was performed during this implementation. Obtain an explicit deployment request before spending funds; the current request is implementation and context export.
- Current developer instructions prohibit spawning subagents unless explicitly requested by the user or applicable instructions.

## User goal and architecture decision

Pilot is Owl's CKB signing SDK/infrastructure, inspired by Cartridge Controller. It should support app-approved automatic signing, user-selected budgets and permissions, account switching, detailed owner-specific action logs, usernames and fee sponsorship. Apps remain optimistic, while actual settlement is tracked separately. An app queue must settle before ending/recovering the active account; do not treat an uncertain submission as failed.

The previous counter/delegation model could not automatically authorize arbitrary app transactions owned by an unrelated JoyID lock. The user chose a new architecture: Pilot becomes a new app account from the beginning, funded by the owner, with an independent original-owner recovery branch. The accepted fee model is **per-transaction sponsorship**, not fee top-ups into a generally spendable account balance.

The explicit request was to write `CURRENT_IMPL.md` with the corrected Mermaid flow first, then implement this first version. That document was written first and updated with verified results afterwards.

Important distinction: this account is a new on-chain identity. It cannot impersonate an existing JoyID address or inherit old app ownership. Existing compatible contracts may accept it as the owner of newly created app state. App builders and off-chain verifiers still need integration. No files in the sibling `../freightonnervos` project were changed.

## Implemented components

### Account contract

- `contracts/account-lock/src/main.rs` and Cargo/workspace/build integration.
- Pinned code hash in `src/ckb/account-code.ts`: `0xac7aed6158f543d28ffa85c188ba797c25f210302b0e0e517a44674da2f459a8`.
- Lock args (105 bytes): full owner lock hash (32), compressed account public key (33), full pool lock hash (32), maximum per-transaction fee (u64 little-endian, 8).
- Automatic branch: account signature authorizes general transaction shapes; app type scripts still execute. Pool input and output are pinned, ordinary, unique and last. Pool loss must equal the entire positive transaction fee within the cap, so user capacity pays zero network fee.
- Custom signature digest binds transaction hash and all length-prefixed witnesses, preserving type fields and extra witnesses. Supports multiple account inputs and first account input at a nonzero transaction index.
- Recovery branch: a real input under the exact owner lock must be present and validated by that lock. Does not require the account key or pool at the contract level.
- Broad account authority is intentional. SDK manifest checks are not enforced by this general lock. Recovery does not globally revoke an old key or protect against a compromised key spending first.

### SDK

`src/ckb/account.ts`, exported through `src/index.ts`:

- `PilotAccountSigner`, public account descriptor, explicit persistent key store, durable journal and required exclusive lease interface.
- Key scope binds full owner lock and CKB network genesis hash. Reconnection resumes the same browser-stored key; config/journal/key mismatches fail closed.
- `forAction(id)` returns an action-bound CCC signer. Actions require effect/message validators and explicit permission selection. Root automatic signing without a named action is rejected.
- New signatures check the currently connected original owner, preventing signing through a stale account after wallet switching.
- `fund`, sponsored `sendTransaction`, `resume`, `stop` and `recover`. Exact signed bytes are persisted before submission. Optional stable request IDs prevent duplicate spending and reject retries with changed effects.
- Pending/uncertain receipts reconcile before subsequent spending. Signed/submitted account receipts are serialized; the integrating app still owns its accepted-but-unsigned action queue.
- `preparePilotAccountRecovery` and `recoverPilotAccount` allow independent original-owner recovery using the public descriptor, without the Pilot key or original journal. Sponsored recovery has its own durable receipt persistence and exact-byte retry.
- Generic recovery handles ordinary empty CKB cells only. Typed/data-bearing assets remain untouched and need app-specific recovery builders.
- `verifyPilotAccountMessage` proves the new account key's signature. `verifyPilotAccountOwnership` additionally verifies a committed owner-authorized funding link when a service needs to associate that account with its original owner. Receiving services must also enforce replay/business rules.
- Automatic transactions require the durable sponsored send path; standalone `signOnlyTransaction` is rejected.

### Paymaster

- `server/paymaster.ts` recognizes the account format and derives sponsorship quota from the proven original owner, independent of input ordering.
- New account registration requires a funding transaction containing a supported signature-required owner input. Registration becomes usable only after script validation, durable signing and chain commitment. An unsigned quote, unconfirmed transaction or copied owner hash is insufficient.
- Owner recovery can use a real owner proof without prior account registration.
- Existing JSON/PostgreSQL paymaster journals now also store public account registration hashes alongside receipts. No account private keys are stored there.
- `server/paymaster-config.ts` includes the account code hash by default. An explicit allowed-code-hash override must include it.
- Pool co-signing still validates scripts and exact transaction effects before exposing a signature.

### Demo and docs

- New `apps/demo/src/PersistentAccount.tsx`, rendered in the existing demo. Existing counter/delegation/social flows remain present.
- The panel stays disabled until the account deployment and paymaster URL are configured. It does not silently substitute an old contract.
- Explicit unchecked permissions, user CKB spending budget, separate occupied capacity, owner funding review, automatic fixed 61 CKB return payment, scoped message signing, public descriptor export/import, stop/reconcile/recovery controls and detailed receipt logs. Events also enter the owner-filtered profile activity history.
- The browser demo uses local browser storage and Web Locks. Keys are accessible to application JavaScript: **this is not an isolated production vault**.
- Docs Board (`apps/docs/src/chain.js`) recognizes account transactions across apps and locates nonzero-index account witnesses correctly.
- Updated: `README.md`, `CURRENT_IMPL.md`, `PAYMASTER.md`, `SECURITY_AUDIT.md`, `contracts/README.md`, `apps/docs/README.md`, and `apps/docs/src/content.js` (new persistent-accounts page).
- Public demo URL is `https://owl-pilot-demo.vercel.app`; prior localhost-link corrections remain in place.

## Verified results

Completed during implementation:

- `npm run contracts:build`: passed.
- `npm run contracts:test`: 41 passed, including 11 new account-lock VM tests.
- `npm run check`: typecheck/build passed; 85 tests passed, 5 PostgreSQL integration tests skipped because `PILOT_TEST_DATABASE_URL` was not configured.
- `npm test --prefix apps/docs`: 13 passed.
- `npm test --prefix apps/demo`: 14 passed. Includes undeployed-account blocking and invalid recovery descriptor handling; does not exercise a live deployed account or real JoyID signing.
- Production builds passed for `packages/react`, `apps/demo` and `apps/docs`. Existing Vite dependency/chunk-size warnings remain.
- `git diff --check`: clean, including the final review before this handoff.

Tests cover general payments, multiple/nonzero-index account inputs, wrong signatures and witness tampering, pool identity and fee conservation, owner binding, keyless recovery, active owner switching, permission checks, stable request IDs, journal failures, lost-response retries and confirmed account registration.

No live public-testnet persistent-account end-to-end success is claimed. Do not present skipped PostgreSQL tests as passed. Do not repeatedly rerun the entire suite unless changes or unresolved concerns warrant it.

## Deployment and next steps

`deployments/pilot-sponsored.json` currently has `"account": null`. Existing counter/delegation deployment records were preserved. A separate new code cell is needed before the account panel activates.

Deployment tooling is ready in `scripts/deploy-sponsored.ts`. After an explicit deployment request and checking the deployer's available capacity without exposing secrets:

```sh
npm run contracts:build
npm run paymaster:deploy -- account
```

The `both` deployment target still refers only to the existing counter/delegation pair. The deployment script persists exact signed deployment bytes before broadcast and records the verified account deployment after commitment.

Then:

1. Verify the new code-cell outpoint/code hash and preserve the resulting deployment JSON.
2. Restart/redeploy the paymaster with the updated code; include the new code hash in any explicit allowlist override.
3. Rebuild/redeploy demo and docs from the updated repository. The demo needs its configured `VITE_PILOT_PAYMASTER_URL` and the new deployment record.
4. Run a small real JoyID flow: funding review and owner signature, confirmed registration, automatic payment, scoped message verification, lost-response resume where practical, stop and owner recovery. Inspect exact pool/user capacity and detailed receipts.
5. Run PostgreSQL integration tests when an isolated test database is available.
6. Integrate a real external app's builder and effect validators using the new account address. Existing owner identities need migration or fresh state; off-chain APIs need account-aware verification.

Do not promise a global wallet yet. Secure shared custody/cross-origin signing and account discovery across apps/devices remain separate work.

## Remaining limits to communicate accurately

- Persistent mapping is local to a browser origin, not a global account database. The username registry still maps existing owner recipients; it does not redirect funds to Pilot.
- No shared isolated vault or server-held account key service is implemented. PostgreSQL stores public service data, not these private keys.
- General account permissions are trusted SDK checks, not on-chain manifest restrictions. A stolen account key has broad spending authority within the lock's rules.
- Recovery requires a live owner proof input and asset-compatible transactions. Owner recovery cannot override app scripts or undo an already confirmed spend.
- Stopping SDK signing is not global key revocation. Recover all relevant live cells, consider pending transactions and future deposits, and never treat deleted journals as cancellation.
- First funding must settle before automatic actions. Apps own their optimistic UI, preflight reservation logic and durable accepted-action queues; no network inclusion guarantee is provided.
- No universal token/NFT recovery builder, old JoyID identity migration, or automatic contract-action inference exists.

## Current change inventory

Modified tracked files:

```text
PAYMASTER.md
README.md
SECURITY_AUDIT.md
apps/demo/src/main.tsx
apps/demo/src/style.css
apps/docs/README.md
apps/docs/src/chain.js
apps/docs/src/content.js
apps/docs/tests/chain.test.js
contracts/Cargo.lock
contracts/Cargo.toml
contracts/README.md
contracts/tests/src/lib.rs
deployments/pilot-sponsored.json
scripts/build-contract.sh
scripts/deploy-sponsored.ts
server/paymaster-config.ts
server/paymaster.ts
src/index.ts
test/paymaster.test.ts
```

New files/directories:

```text
CURRENT_IMPL.md
SESSION_HANDOFF.md
apps/demo/src/PersistentAccount.tsx
apps/demo/tests/persistent-account.spec.ts
contracts/account-lock/
contracts/tests/src/account.rs
src/ckb/account-code.ts
src/ckb/account.ts
test/account.test.ts
```

Suggested prompt for a new session: “Read AGENTS.md, SESSION_HANDOFF.md and CURRENT_IMPL.md, inspect the current uncommitted changes, and continue Pilot's persistent-account activation/integration from the documented state. Do not start a local node or deploy/spend funds without my explicit request.”
