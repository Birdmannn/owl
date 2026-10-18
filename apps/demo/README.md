# Pilot flight demo

A standalone CKB testnet app using the real Pilot SDK and CCC wallet connector. This app is separate from Pilot’s docs and landing page.

The **Developer cell delegation** panel demonstrates version-2 app definitions, independent forward/backward permissions, explicit creation or source-cell migration, an owner-only jump, reviewed owner transactions, recovery, reload handling, a tab lease, and detailed queue/transaction logs. Its public deployment is unset by default; load a real `delegation-v1` testnet deployment JSON to enable it. A local-node verifier and proof cover the new lock separately from the existing counter flight. See [CELL_DELEGATION.md](../../CELL_DELEGATION.md).

From the repository root:

```sh
npm install
npm run build
npm install --prefix packages/react
npm install --prefix apps/demo
npm run registry # keep running in a separate terminal
npm run dev --prefix apps/demo
```

Open http://127.0.0.1:5174. Click **Connect wallet**, choose **Pilot**, then connect an existing owner wallet through CCC. Register or continue your shared Pilot username, review the owner address and balance, and inspect Owl Flight’s manifest. Select **Fly forward**, then click **Allow Pilot to sign selected actions**. The app uses CKB testnet only; EVM wallets connect through CCC’s OmniLock signer without switching to an EVM chain.

Fund the connected CKB address with at least 220 test CKB ([faucet](https://faucet.nervos.org/)), then open **Enable Pilot** to choose permissions. The wallet approves a counter session with 150 CKB recoverable capacity, 0.02 CKB move budget, and a setup transaction fee. The policy permits 20 increments, each costing 0.001 CKB. Setup waits for actual chain confirmation before enabling moves.

**Fly forward** executes through `Pilot.execute()`: reserve and persist the action, update the owl immediately, and sign/settle the real CKB transaction in the background. Readiness is refreshed after every state change. The footer counts actual chain confirmations, and receipt links open the testnet explorer. Definitive rejections roll back; uncertain network failures retain and retry actions.

The app persists the session key, action journal, and signed transaction journal in this browser. Reloading restores a submitted approval or active session. A Web Lock prevents two tabs from running the same session. Disconnecting does not revoke on-chain authority; use **End session & reclaim CKB** after all moves settle. Keep an ordinary owner cell for the recovery transaction. The 24-hour expiry is enforced locally; only recovery or budget exhaustion ends authority on-chain. This testnet demo stores the session key in localStorage; it is not a hardened production key vault.

```sh
npm run build --prefix apps/demo
npx --prefix apps/demo playwright install chromium
npm test --prefix apps/demo
# Or use installed Chrome:
PLAYWRIGHT_CHANNEL=chrome npm test --prefix apps/demo
```

Browser tests announce an injected EIP-6963 provider to exercise CCC wallet discovery, connection, approval modal, disconnection, and mobile layout. This provider is a test fixture, never part of the application. Actual wallet signing requires the connected wallet and funded testnet address.

A complete browser-driven testnet session was verified: one owner signature for setup, two session-signed moves, reload recovery, and one owner signature for reclaiming capacity. Public transaction receipts are in [`deployments/demo-testnet-proof.json`](../../deployments/demo-testnet-proof.json). The signing provider was an injected test wallet; a real extension wallet has not been manually tested.

The **Transaction queue & logs** section shows the durable FIFO queue alongside session approval, move, and recovery transactions. Select a transaction for action/session IDs, signer, fee reservation, actual fee (when its input cells can be fetched), hash, submission count, node status, block number/hash, confirmation count, execution cycles, transaction index, timestamped lifecycle events, and full error messages. Expand the raw transaction and signed bytes for inputs, outputs, cell dependencies, and witnesses. The selected hash is polled every 10 seconds; use **Refresh** for an immediate node check or **Retry settlement** to resume Pilot’s existing queue.

Logs persist independently of the active session, so closing a session retains its history. **Export logs** downloads queue IDs and transaction diagnostics only, excluding the session private key. Legacy transactions are recovered from the signed transaction journal; historical event timestamps that were never recorded cannot be reconstructed. The SDK’s optional `onTransaction` callback exposes signing, persistence, node checks, broadcasts, and confirmation without letting observer failures interrupt settlement.

The Pilot-owned modal is in `packages/react` (`@owl/pilot-react`), and the existing-wallet wrapper and manifest/grant checks are in the SDK’s `PilotCounterConnector`. Read [PILOT-FLOW.md](PILOT-FLOW.md) for the step-by-step flow assessment, scope boundaries, and the new testnet receipt evidence.

## Shared usernames and transfers

Run `npm run registry` from the root. Set `DATABASE_URL` in root `.env` to use PostgreSQL; without it, names persist in `data/pilot-usernames.json` inside this repository. A configured database failure does not fall back to JSON. The demo development server proxies `/api/pilot` to port 5180. For a deployed build, set `VITE_PILOT_REGISTRY_URL` or configure a hosting proxy. See `.env.example` for network and origin configuration.

Registering a unique username requires a signed, single-use wallet challenge. JoyID primary P-256 passkeys and other supported CCC signing identities can register; a username maps to one verified identity and CKB address. The registry stores public information only. Existing browser-local profiles are not automatically imported: claim the shared name with your wallet. Names are unique within this registry, not across independent servers. Renaming and key rotation are not implemented.

**Send with Pilot usernames** resolves a name, prepares a CKB or Spore NFT transfer, and shows the recipient and fee before asking the connected owner wallet to sign. Spore ownership and CKB receiving-cell capacity are checked. Transfers are separate from counter auto-approvals. Signed bytes and receipts persist before broadcast; unresolved transfers must be reconciled using the same saved transaction. Other NFT standards need dedicated builders.

Automated tests verify real wallet and generated WebAuthn signatures, address binding, collision/replay rejection, JSON persistence/concurrency, and CKB/Spore construction. Manual JoyID browser registration and live username-based transfers remain unverified; prior session testnet proofs describe the earlier local-profile flow.

## Off-chain social signing and hosting

The **Pilot Social** panel has independent like, follow, and publish permissions. Choose **Enable social signing**, connect your existing wallet, and approve selected actions with one message. Pilot signs subsequent actions with a separate session key; the owner wallet is not prompted for each interaction. The approval expires after one hour. **Revoke social session** requests an owner message and records revocation at the verifier.

The default is explicitly labelled **BROWSER-LOCAL DEMO**: signatures and verification are real, but feed state is local to this browser. This social panel needs no CKB node, faucet funds, username service, or on-chain deployment. Serve `apps/demo/dist` over HTTPS after `npm run build --prefix apps/demo`. Other panels retain their existing setup requirements. Message signatures are publicly inspectable; session keys stay in localStorage and are excluded from diagnostic exports.

For a shared feed, start the included verifier on a host with persistent disk:

```sh
PILOT_SOCIAL_AUDIENCE=https://demo.example \
PILOT_SOCIAL_FILE=/persistent/pilot-social.json \
npm run social
```

It listens on loopback port 5181 by default. Put it behind an HTTPS proxy, routing `/api/social/*`. Set the frontend URL **before** building:

```sh
VITE_PILOT_SOCIAL_URL=https://api.example/api/social \
npm run build --prefix apps/demo
```

For local shared-backend testing, run `npm run social`, set `VITE_PILOT_SOCIAL_URL=http://127.0.0.1:5181/api/social` in the demo environment, and run the frontend on `http://127.0.0.1:5174`. The default backend audience is that exact origin. Production audiences require HTTPS, with no trailing slash. A configured backend failure does not fall back to local acceptance. No CKB node is started by the social server.

Signed requests are saved before submission. Unknown failures retain the request; **Retry saved social request** resubmits the same signature/nonce. Exact retries return the original receipt. Changed content with the same nonce is rejected. New actions wait while a request is unresolved. Expired saved work can be cleared after refreshing the feed; earlier accepted effects remain visible. Shared backend receipts persist across restart, and replay checks, revocation checks, business validation, and app mutation occur within one locked-file transaction. This file store is a single-host demo backend; production apps should provide a transactional store.

For the SDK API, security boundaries, and sequence diagram, see [OFFCHAIN_SIGNING.md](../../OFFCHAIN_SIGNING.md). Browser tests use real EVM signatures from an injected test wallet, rather than a manually tested extension wallet.


## Profile history and signing review

Open the connected Pilot profile and expand **Activity & logs** for a list of recorded actions, app/session IDs, signing method, statuses, transaction hashes or social targets, and detailed timelines. The social panel also offers **Social profile & logs**. Histories persist locally on the same origin and filter by the connected wallet. They do not replace the full queue/transaction inspector or establish cryptographic proof.

See [SECURITY_AUDIT.md](../../SECURITY_AUDIT.md) for reviewed boundaries, fixes, tests, and open risks. In particular, the browser session-key vault and on-chain expiry are not production security features, and permissive owner locks must not be used to own delegated cells.

## Multiple browser accounts

Open Pilot and expand **Accounts in this browser** to see previously connected owners on this origin/network, including multiple owners from the same wallet. Selecting a live matching connection switches owners; otherwise choose the requested account in wallet authentication. All panels use the selected Pilot owner, and active wallet operations/queued work block switching.

**Add account / choose wallet** restarts CCC connection internally. **Add JoyID account** opens fresh JoyID authentication using an isolated signer connection. JoyID controls whether the popup offers account creation, another account, or passkey registration; its SDK has no documented force-registration option. Reconnecting an existing owner updates its entry. Never-connected wallet accounts/passkeys cannot be enumerated, and saved accounts can require reauthentication after reload. Disconnect keeps account hints and saved sessions; it does not revoke grants. Manual real-device JoyID testing is still required.

## Sponsored fees

See [PAYMASTER.md](../../PAYMASTER.md). Deploy the new sponsored code cells into `deployments/pilot-sponsored.json`, fund the configured pool with fee headroom, run `npm run paymaster` from the repo root with the matching pool key on the server, and set `VITE_PILOT_PAYMASTER_URL=https://api.example/api/paymaster` in this app’s `.env` before rebuilding. The key must never use a `VITE_` variable.

When enabled, flight and cell-delegation sessions, owner setup/recovery/manual actions, and username transfers request pool-paid fees. Missing deployment, empty pool, exhausted allowance, or unavailable service never triggers a user-paid fallback. Existing legacy sessions need recovery and fresh sponsored authorization; do not reinterpret their lock arguments. Without the sponsorship URL, the existing demo retains its explicitly displayed user-paid fee mode. The separate docs pool-deposit form still pays its reviewed funding-transfer fee.
