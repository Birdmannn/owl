# Pilot persistent accounts: first implementation

> Update 2026-10-21: the separate passkey-owned, isolated-origin wallet is now implemented locally. Read [PILOT_WALLET.md](PILOT_WALLET.md) for its architecture, contracts, activation and limits. The broad-key account API described below remains available with its original restrictions. Neither new account architecture is deployed yet.

This document records the agreed first version: one persistent owner-recoverable Pilot account per verified owner wallet and CKB network, with per-transaction sponsorship. It replaces neither the existing counter/delegation APIs nor app contract rules.

## Agreed behavior

- On first setup, generate a new Pilot signing key and address, bound to the connected owner's complete lock hash. Reconnecting the same owner resumes that account rather than generating an address per session. Other owners and networks have separate accounts.
- The owner reviews and signs the initial transfer of an explicitly chosen spending budget into this account. This is real CKB, not the existing demo's action-count allowance. Cell capacity is separately displayed and remains necessary to hold CKB/assets.
- Integrating apps use the Pilot account's address and signer. The account can authorize general transaction shapes, subject to app type-script rules, rather than only counter/u64 transitions. It is a new on-chain identity; it cannot impersonate the original JoyID address or inherit its existing app permissions.
- Pilot checks the app's approved permissions and transaction effects before automatic signing. Possession of a broadly authorized account key is powerful: manifest restrictions enforced only by the SDK are not on-chain restrictions.
- The paymaster recognizes an account only after a service-validated funding transaction with a signature-required owner proof input has committed. Merely copying an owner hash into an account lock cannot acquire that owner's sponsorship bucket. Owner recovery with an actual owner proof input remains available independently of account registration.
- The paymaster contributes its own input and change to each eligible transaction. User inputs and outputs balance exactly; pool loss equals the complete network fee. No fee top-ups or unrestricted sponsored wallet balances are used. Missing sponsorship blocks automatic submission; it never silently charges the user.
- Payments, purchases and app cell capacity use the user's approved funding. Rewards and assets addressed to the Pilot account remain there. Token/NFT transfers still need their own compatible builders.
- The lock has an independent owner recovery branch. A transaction containing an input with the exact approved owner lock can move account cells without the Pilot key. The owner's wallet must validate that input. Recovery does not override asset/type-script restrictions and is not a global revocation of unspent cells.
- Ending automatic access first stops new actions and reconciles queued/submitted transactions. Uncertain submissions must not be treated as failed. Recovery spends current live account cells; stale keys retain authority over any cells not recovered or subsequently received at the old address.

## Flow

```mermaid
sequenceDiagram
    participant U as User / JoyID
    participant P as Pilot account SDK
    participant W as Owner-recoverable Pilot account
    participant M as Paymaster
    participant A as Integrating app
    U->>P: Connect and verify owner account
    P->>P: Create or resume owner/network-bound key and address
    P->>U: Review permissions, budget and required cell capacity
    P->>M: Quote initial funding with zero user network fee
    M-->>P: Add pool input and pool change
    U->>P: Sign reviewed funding transaction
    P->>P: Persist owner-signed funding receipt
    P->>M: Submit funding for pool co-signature
    M->>W: Broadcast and confirm initial funding
    M->>M: Bind this account to its proven owner
    A->>P: Request an approved action / prepared transaction
    P->>P: Check effects, permissions and reserve available funds
    P->>M: Request sponsorship for this exact transaction
    M-->>P: Quote with pool input and pool change
    P->>P: Verify user pays zero fee; persist signed bytes
    P->>M: Submit Pilot-signed transaction
    M->>M: Validate scripts and limits; sign pool input
    M->>W: Submit transaction and reconcile chain receipt
    W-->>A: App effects / rewards belong to Pilot address
    U->>P: Request withdrawal or recovery
    P->>P: Stop new actions; settle uncertain account transactions
    P->>M: Quote recovery with zero user network fee
    U->>P: Sign recovery using an owner proof input
    P->>P: Persist owner-signed recovery receipt
    P->>M: Submit recovery for pool co-signature
    M->>W: Broadcast and confirm recovery
    W-->>U: Return ordinary CKB; app assets need compatible builders
```

Optimistic app acceptance and on-chain confirmation remain distinct. First funding must become spendable before automatic actions start. Preflight cannot guarantee network inclusion.

## Key custody and first-version boundary

The account API must take a persistent key store explicitly; it must not store keys in the username registry or expose them in logs. The initial browser demo uses a local browser key store, consistent with the existing testnet prototype. This is not an isolated wallet vault: application JavaScript can access browser storage. It must be labeled accordingly, not presented as production custody. A hosted isolated signer or independently secured wallet vault is a separate production deployment requirement. Owner recovery protects against loss of Pilot availability; it does not prevent a compromised Pilot key spending first.

## Implementation and verification

Implement a dedicated account lock, generic sponsored account SDK/signer, durable transaction journal, independently usable owner recovery builder, paymaster account validation/accounting, and a browser demonstration. Preserve existing APIs. Add contract tests for arbitrary outputs, signature/witness tampering, fee conservation, owner binding and recovery without the account key; add SDK tests for account persistence/isolation, zero user fees, permission checks and durable retries. Update this document, README and public docs with verified status after implementation.

New lock deployment is required before public testnet use. Existing sponsored counter/delegation deployments cannot implement this account format. Do not deploy, spend pool funds or start a local node as part of implementation without an explicit deployment request.

## Implemented status

- `contracts/account-lock`: a separately compiled account lock for arbitrary transaction outputs, multiple account inputs, full owner-hash recovery, a pinned fee pool and zero user network fees. Contract tests execute in CKB-VM; no running node is needed.
- `src/ckb/account.ts`: `PilotAccountSigner`, persistent owner/network key binding, active-owner checks, named actions with mandatory effect/message validators, sponsored funding, durable signed receipts, sequential reconciliation, stopping and recovery. Stable optional request IDs prevent duplicate spending when the app retries the same transaction; reuse with different effects is rejected.
- Independent recovery: `preparePilotAccountRecovery` and `recoverPilotAccount` take the public descriptor and original owner signer, without the Pilot key or account journal. The latter persists sponsored recovery receipts before submission and resumes exact bytes after a lost response. The generic builder recovers ordinary, empty CKB cells only; typed/data-bearing app assets are deliberately preserved.
- Off-chain identity: `verifyPilotAccountMessage` checks the NEW account key, not JoyID identity. Receiving services that associate it with the original owner must also verify a committed funding link with `verifyPilotAccountOwnership` (or an equivalent verified owner authorization), and enforce their own replay/business rules.
- `server/paymaster.ts`: first-funding registration becomes usable only after full script validation and chain confirmation. Account sponsorship uses the proven full owner hash regardless of input ordering. Owner recovery can use an actual owner proof without relying on that registration. Persistent JSON/PostgreSQL service journals store public registration hashes and receipts, not account private keys.
- `apps/demo/src/PersistentAccount.tsx`: an additional account panel with unchecked permissions, a CKB budget plus explicit occupied capacity, owner funding review, automatic 61 CKB return-payment and scoped greeting, a public descriptor download/import, independent owner recovery, and account-specific detailed receipts. Profile activity also receives these actions. Existing flight/delegation/social flows are preserved, not silently switched to a different on-chain identity.
- The docs Board recognizes `account-v1` across apps, correctly finds its signing witness even when its first input is not index zero, and distinguishes account actions from counter increments.

### Activation and operational boundaries

The account lock is not deployed. `deployments/pilot-sponsored.json` deliberately contains `account: null`, and the demo blocks account creation until a verified deployment and paymaster URL are configured. After funding the deployer for the displayed compiled code-cell capacity plus fees, the explicit deployment command is:

```sh
npm run contracts:build
npm run paymaster:deploy -- account
```

`both` still deploys/verifies the existing counter/delegation pair only. Restart or redeploy the paymaster so it recognizes the new account code hash; explicit allowed-code-hash overrides must include that hash. Redeploy the demo/docs after the deployment record is committed. No deployment, account funding or pool spending has occurred during this implementation, and no internal CKB node was started.

This version deliberately exposes a key-store interface rather than claiming an isolated custody service. The demo's stable account mapping is browser-origin-local, not global across apps/devices. The username database still stores its existing owner recipient addresses; it does not silently redirect funds to Pilot. A globally hosted account vault, secure cross-app signing, generic token/NFT recovery builders and migration of existing app identities remain separate work. General account requests serialize signed/submitted receipts; the demo's existing optimistic engine remains separate and arbitrary app optimistic state still requires app integration.

App permissions are trusted SDK checks, not restrictions enforced by the general account lock. Owner recovery does not prevent key-compromise spending first, globally revoke old keys or override app type scripts. Keep recovery descriptors and unresolved receipts; deleting them is not cancellation. To end an app session, stop accepting new actions, settle its accepted app queue, then recover the account cells. A missing original queue is not proof that all transactions settled.

### Validation

- Contract build and VM suite: 41 passed, including 11 new account-lock tests.
- SDK/server checks: typecheck and build passed; 85 tests passed and 5 PostgreSQL integration tests were skipped because `PILOT_TEST_DATABASE_URL` was not configured.
- Documentation tests: 13 passed; docs production build passed.
- Browser regression suite: 14 passed, including blocking undeployed account setup and rejecting invalid imported recovery descriptors. This does not exercise a live deployed account or real JoyID signing; the account SDK and CKB-VM flows have separate tests.
- Demo and React package production builds passed. Existing Vite dependency/chunk-size warnings remain.
- No live public-testnet account end-to-end run is claimed.


## Integrating an app

Keep the builder and effect validation specific to the app. The signer interface does not infer contract actions from a code hash. For example, after creating the account with an approved `raffle.buy` action and a validator that checks the expected raffle cells, ticket count, payment recipient and amount:

```ts
const buyer = account.forAction('raffle.buy');
const tx = await buildTicketPurchase({ buyer, campaign, tickets });
// Builders must preserve a zero user network fee. Include required app dependencies/witnesses.
await tx.completeInputsByCapacity(buyer);
await tx.completeFeeBy(buyer, 0n);
const hash = await buyer.sendTransaction(tx, `my-app:purchase:${purchaseId}`);
// Persist the request ID/transaction. If the response is lost, retry the same request,
// or call account.resume() to reconcile its saved receipt before another action.
```

This is an integration sketch, not a provided raffle builder. The app continues to own its optimistic state, action cost checks and durable accepted-action queue. Do not recover an account while that external app queue still contains unsigned actions. The account signer itself serializes its signed/submitted transactions and does not pretend submission is chain confirmation. Receiving APIs that currently demand a signature derived from the original JoyID address need an account-aware verifier; no app contracts are edited by this change.
