# Owl paymaster and Pilot

The pool sponsors **CKB network transaction fees only**. The user still supplies recoverable cell capacity, transferred CKB/NFTs, and application payments. Sponsored user inputs equal user outputs exactly; pool input minus pool change pays the entire transaction fee.

The service, SDK client, and new contract variants are implemented and tested. **Both sponsored contract code cells are deployed and verified live on public testnet. Service/demo activation is still pending.** The configured receiving address was verified at **100,000 test CKB** on October 18, 2026. Verified deployment outpoints are saved in `deployments/pilot-sponsored.json`; the pool service still requires its matching operator key. Original public v1 sessions remain self-funded.

```mermaid
sequenceDiagram
    participant App
    participant SDK as Pilot SDK
    participant Pool as Owl fee service
    participant Chain as CKB
    App->>SDK: Approved action
    SDK->>SDK: Build user effects with zero user fee
    SDK->>Pool: Request unsigned quote
    Pool-->>SDK: Append pool input/change and bounded fee
    SDK->>SDK: Independently check effects, pool identity and conservation
    SDK->>SDK: Owner/session signs; persist quote + exact bytes
    SDK->>Pool: Submit user-signed transaction
    Pool->>Pool: Check effects, quotas and pool lease
    Pool->>Pool: Co-sign and dry-run all scripts
    Pool->>Pool: Persist signed bytes and pool lease
    Pool->>Chain: Broadcast
    Pool-->>SDK: Exact co-signed transaction
    SDK->>SDK: Persist final bytes
    Chain-->>App: Background confirmation
```

The optimistic engine still renders accepted actions immediately. A service failure leaves settlement retryable; it never silently charges the user's session cell. Optimistic acceptance is not a guarantee of settlement or a reservation of pool liquidity.

## Activate on testnet

1. Build contracts with `npm run contracts:build`.
2. Run `npm run paymaster:account` to create or reuse a new local testnet deployer. Its public address is saved to `deployments/sponsored-deployer.json`; its private key stays in git-ignored `.pilot/sponsored/deployer.json` with directory mode 700 and file mode 600. Fund that address with about **210,000 test CKB** for both current binaries (200,698 CKB of occupied capacity combined, plus fees and change). The deployment script reads this local account automatically. Alternatively, set server-only `PILOT_DEPLOYER_PRIVATE_KEY` to override it. This deployer is separate from the 100,000 CKB fee pool. Run `npm run paymaster:deploy -- both` (or `counter` / `delegation`). This deploys separate code cells and writes verified outpoints to `deployments/pilot-sponsored.json`. Code-cell occupied capacity is substantial; this infrastructure cost is paid by the deployer. Deployment saves exact signed bytes before broadcasting and retries its original transaction after interruption.
3. Fund the receiving address in `deployments/owl-paymaster.json`. A normal cell occupies 61 CKB; it needs extra capacity above that to pay fees. Several funding cells support simultaneous transactions. One cell can fund only one pending transaction at a time.
4. Set `PILOT_PAYMASTER_PRIVATE_KEY` on the **server** to the key that owns the pool address, then run `npm run paymaster`. The service rejects a key/address mismatch and non-testnet RPCs. This is an operator-controlled ordinary secp pool, not trustless escrow.
5. Build the demo with `VITE_PILOT_PAYMASTER_URL=https://api.example/api/paymaster`. Keep `poolLock` in the deployment configuration pinned to that same pool. Authorize fresh sponsored sessions; legacy locks cannot be upgraded in place.

Never put either private key in a `VITE_` variable. Never commit deployment journals or service journals. No private key is needed in an integrating application's browser.

Server defaults (amounts are integer shannons):

| Variable | Default | Purpose |
| --- | --- | --- |
| `PILOT_PAYMASTER_RPC` | `https://testnet.ckb.dev` | Testnet node/indexer |
| `PILOT_PAYMASTER_HOST` / `PORT` | `127.0.0.1` / `5182` | Bind behind HTTPS reverse proxy |
| `PILOT_PAYMASTER_FILE` | `data/pilot-paymaster.json` | Persistent quotes, exact signed bytes, leases, spending totals |
| `PILOT_PAYMASTER_MAX_FEE` | `100000` | Maximum network fee per transaction |
| `PILOT_PAYMASTER_FEE_RATE` | `1000` | Shannons per 1,000 bytes; quote reserves 4 KiB for signing witnesses |
| `PILOT_PAYMASTER_DAILY_BUDGET` | `100000000` | Global daily subsidy limit (1 CKB) |
| `PILOT_PAYMASTER_OWNER_DAILY_BUDGET` | `1000000` | Daily subsidy per owner (0.01 CKB) |
| `PILOT_PAYMASTER_ALLOWED_ORIGINS` | Local demo origins | Comma-separated browser origins |
| `PILOT_PAYMASTER_ALLOWED_CODE_HASHES` | Known Pilot variants | Comma-separated eligible application hashes |
| `PILOT_PAYMASTER_ALLOW_OWNER_TRANSACTIONS` | `true` in startup script | Also sponsor full-signature owner transactions, including username transfers; set `false` to disable |

The 4 KiB witness reserve is charged as part of the quoted network fee, not refunded. Oversized signed witnesses are rejected rather than changing the signed transaction. Owners can inspect the final fee before signing; automatic actions remain bounded by their approved fee cap.

Instances sharing a pool must share the same persistent journal and filesystem locks. Independent journals against the same pool are unsupported. Keep the journal across deployments: deleting it loses subsidy accounting, pool leases, and retry records. A hostile client can consume an open subsidy through valid transactions; owner/global budgets bound that spending. CORS is a browser control, not authentication or Sybil protection.

## Integrate

```ts
import { ccc } from '@ckb-ccc/core';
import { PilotPaymasterClient, PilotCounterConnector, CkbCounterAdapter } from '@owl/pilot';

const poolLock = (await ccc.Address.fromString(owlPoolAddress, client)).script;
const paymaster = new PilotPaymasterClient({
  client, url: 'https://api.example/api/paymaster', poolLock, maxFee: 100_000n,
});
// manifest.policy.kind = 'counter-sponsored-v1'
// manifest.policy.deployment = verified new sponsored-counter deployment
// manifest.policy.poolLock = poolLock
// manifest.policy.floorCapacity = '20000000000'
const connector = new PilotCounterConnector(ownerSigner, manifest);
const { cell, grant } = await connector.authorize(['counter.increment'], {
  paymaster, sessionPublicKey,
  onSigned: async (cell, bytes) => saveApproval({ cell, bytes }),
});
const adapter = await CkbCounterAdapter.create({
  client, deployment: manifest.policy.deployment, paymaster,
  sessionCell: cell, session, sessionPrivateKey, store: settlementStore,
});
```

For reusable apps, use `policy.kind: 'delegation-sponsored-v1'`, its distinct deployment, and `policy.poolLock`. Pass `{ paymaster }` as the third `PilotConnector` constructor argument and include it in `PilotDelegationAdapter.create`. Pass `{ paymaster }` to `prepareOwnerAction` / `prepareDelegationRecovery`; their reviewed submission/resume paths persist quote metadata too. Set the session descriptor's `policyVersion` to the selected policy kind.

`prepareCkbToUsername` and `prepareSporeToUsername` accept `{ sponsorship: true }` as their last argument. This builds a zero-user-fee transaction. Prepare the owner's witnesses, request a quote, verify/review the quoted transaction, owner-sign it, persist quote + exact signed bytes, then call `paymaster.submit`. Transfers still require the owner's explicit signature. The demo implements this sequence.

## Contract guarantees and retry rules

- Both new automatic policies require app input/output 0 and ordinary pool input/change 1, with exactly two inputs and outputs. App capacity and pool identity cannot change. Additional app payments or arbitrary multi-cell actions are not supported by these session policies.
- Sponsored flight deducts its fixed virtual action charge from the on-chain allowance, without removing user capacity. The charge is the maximum permitted pool fee, not a deposited user balance.
- Sponsored reusable delegation enforces the selected transition and per-transaction fee cap. Its cumulative allowance is an SDK journal limit; durable owner/global subsidy caps are service enforced. There is no cumulative per-session sponsorship counter or on-chain expiry in that contract.
- Pool signatures are returned only after a successful node dry-run. The service durably saves signed bytes and a pool-input lease before broadcast. Unknown responses retry that original transaction, including after service restart.
- Unsigned quotes do not lease cells. If an unsigned quote expires or loses its pool input, the service returns `409 REQUOTE`. Only this definitive response permits automatic adapters to discard the obsolete unsigned-pool transaction and prepare a new quote for the same action. Unknown errors retain exact bytes. Expired owner approvals need a fresh review/signature; do not discard an uncertain owner submission.
- The pool must have spendable fee headroom and available cells, and the owner/global subsidy allowance must remain. A nonzero displayed balance alone is insufficient. Exhaustion, RPC failures, service failures, and stale quotes never enable a user-paid fallback.

The docs pool-deposit form remains an explicit user-paid funding transfer with its fee displayed for review. Off-chain message actions have no CKB network fee. Mainnet activation, automatic refunds, pool management/consolidation, and sponsorship of arbitrary session transitions are not implemented.

Validation: SDK/service accounting and retry tests, cryptographic pool signatures, independent CKB VM contract regressions, and existing browser/docs checks. No live sponsored testnet transaction has been executed by this change.

## Vercel and PostgreSQL

See [VERCEL.md](VERCEL.md) for the complete one-project demo/API deployment. `DATABASE_URL` now selects PostgreSQL paymaster storage and shared rate limiting for standalone services too. The Vercel adapter requires it, plus `PILOT_APP_ORIGIN` and the matching server-only pool key. It does not use local JSON or `/tmp` for settlement state. PostgreSQL serializes a pool journal with a row lock, commits exact signed bytes/leases/accounting before broadcast, and preserves retries across function instances. Use the same database for every instance sharing that pool. Existing JSON journals are not imported automatically; stop and migrate any active service before switching.

The first PostgreSQL adapter stores the bounded journal as JSONB; it retains the existing caps and serializes paymaster RPC validation per pool. It does not add a background settlement worker. The configured function can run for sixty seconds, with shorter lock waits; interrupted requests retain the existing exact-request retry behavior. Hosting adaptation is implemented and tested locally; a live Vercel deployment and a live sponsored user transaction still require operator configuration and verification.

The Vercel/Neon integration variable `POSTGRES_URL` is also accepted by every service. `DATABASE_URL` takes precedence when both are set; use the same pooled connection for all instances sharing a pool. Keep either variable server-only.

## Persistent Pilot accounts

The pool also recognizes the new owner-recoverable `account-v1` lock. It funds a network fee in the same transaction; it never tops up an unrestricted account balance. Account inputs must share the same complete lock, pin this pool, and use the expected 105-byte format. Quotas use the embedded full owner hash even when another app input precedes the account input. The service records account registration only when a fully validated funding transaction includes the exact signature-required owner input and then confirms on-chain. A copied owner hash alone cannot get account sponsorship. Recovery with the actual owner proof input bypasses the registration requirement. This does not provide Sybil protection; valid public subsidy requests remain bounded by pool limits. Retain registration metadata when archiving service receipts.

Build the new lock, fund the deployer for its displayed code-cell capacity, then explicitly run `npm run paymaster:deploy -- account`. The script persists exact deployment bytes and writes `account` in `deployments/pilot-sponsored.json`. Existing `both` still means counter and delegation only. No account lock deployment has been performed as part of this implementation. Restart/redeploy the pool service to include the new default allowed code hash; an explicit `PILOT_PAYMASTER_ALLOWED_CODE_HASHES` override must include it. Funding/recovery owner operations also require sponsorship eligibility (the default allows signature-required owner transactions).

The demo account key is browser-local testnet custody, distinct from the server-only pool key. The account API requires an explicit key store and journal; no account keys are stored in the registry database. See [CURRENT_IMPL.md](CURRENT_IMPL.md) for architecture and the independent recovery boundary.
# Independent passkey wallet sponsorship

The optional hosted wallet uses `pilot-passkey-lock` for owner signatures and `pilot-wallet-session-lock` for restricted automatic transactions. Both hashes are in the default code allowlist. Initial funding registration requires the full passkey-owner input and a committed, validated service transaction; session requests charge that proven owner's quota. Owner recovery can use a real owner proof without registration. Fee conservation and pool leases retain their existing rules; there are no unrestricted fee top-ups.

The browser caller is the **wallet origin**, so include that origin in the paymaster's configured browser allowlist. The wallet only needs its public paymaster URL, never the pool key. New contract records are currently unset. See [PILOT_WALLET.md](PILOT_WALLET.md) for activation and custody limits.
