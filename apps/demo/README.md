# Pilot flight demo

A standalone CKB testnet app using the real Pilot SDK and CCC wallet connector. This app is separate from Pilot’s docs and landing page.

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
