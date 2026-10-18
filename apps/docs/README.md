# Pilot docs

Standalone documentation site using the green pixel owl theme. Content reflects the current SDK, counter contract, and browser demo. It does not modify the demo or SDK.

```sh
npm install --prefix apps/docs
npm run dev --prefix apps/docs
```

Open http://127.0.0.1:5175. Run the browser demo separately with `npm run dev --prefix apps/demo`; demo links default to http://127.0.0.1:5174.

Set `VITE_DEMO_URL` to the deployed demo URL when building or serving the docs. No public demo URL is assumed.

```sh
VITE_DEMO_URL=https://your-demo.example npm run build --prefix apps/docs
npm run preview --prefix apps/docs
```

The site includes page navigation, section links, searchable docs (Cmd/Ctrl+K), copyable code blocks, and mobile navigation. Edit content in `src/content.js`. The app-integration quickstart is in `src/quickstart.js`: it uses `scripts/install-pilot.mjs` to clone, build, and install the SDK, React modal, and wallet connector automatically in an existing npm app, then covers wallet connection and app integration. No package publication is required. The `#cell-delegation` page in `src/delegation.js` covers developer-defined manifests, builders, selected-cell authorization, manual actions, and recovery; the implementation record is [CELL_DELEGATION.md](../../CELL_DELEGATION.md).

## Owl Paymaster

The separate `#paymaster` page connects wallets through CCC and supports reviewed, owner-signed deposits of test CKB. The receiving address is read from `deployments/owl-paymaster.json`, or overridden with `VITE_PAYMASTER_ADDRESS`. No address is invented; deposits stay disabled until an address is configured. The recipient must be a valid `ckt1` testnet address. The form enforces the lock's minimum cell capacity and shows the actual transfer fee before signing.

Create a password-protected account locally:

```sh
ckb-cli account new --local-only
```

Set and confirm the password at the terminal prompts. Copy only the output's public `testnet` address into the manifest's `address` field. Keep the password and encrypted keystore out of the repo. Do not use `ckb-cli account export` for this setup.

Signed deposits are saved before broadcast, with their exact transaction bytes. Receipts survive reloads, and uncertain submissions can be queried or retried using the saved transaction. An unresolved deposit prevents a new deposit in this browser. The deposit page does not implement automatic refunds.

The current counter contract cannot take a paymaster input: it restricts moves to one session-cell input and one successor. The sponsorship service and a compatible policy are still needed before this balance can pay users' transaction fees. The page makes that status explicit and does not advertise the current demo as fee-free.

## Pilot Board

The `#board` page indexes both known Pilot lock policies across apps and owners on CKB testnet, including setup, delegated actions, owner transitions, and recovery. Records expand to show full details. Source filters and search cover chain receipts, shared off-chain receipts, and every available same-origin account journal entry. Load older activity to paginate public history; fees count loaded chain transactions once.

Set `VITE_PILOT_SOCIAL_URL=https://api.example/api/social` before building or serving the docs to include the shared social verifier’s public paginated receipt history. The backend must include `GET /api/social/receipts`; this public read endpoint supports cross-origin access without changing mutation origin restrictions. Receipt payloads are public and backend-reported acceptance is labeled separately from chain confirmation.

Private journals on another origin or device and legacy inspector-only logs cannot be queried by this site. Local records are never uploaded. Missing receipts or unavailable public sources produce retryable errors while retaining available history. Unknown app actions appear by their on-chain action/manifest hashes; custom lock code hashes require a Board catalog entry.
