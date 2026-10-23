# Pilot wallet preview

An independent passkey owner and on-chain restricted session wallet. Read [PILOT_WALLET.md](../../PILOT_WALLET.md) for the architecture, SDK integration, trust boundaries and deployment instructions.

```sh
npm ci --prefix ../..
npm ci
npm run dev
```

Open **http://localhost:5176**. Use localhost, not an IP address, for WebAuthn RP IDs. The integrating demo runs on its separate origin and opens this wallet as a popup. A stable HTTPS wallet domain is required for durable hosted credentials.

Set `VITE_PILOT_PAYMASTER_URL` on this wallet and `VITE_PILOT_WALLET_URL` on integrating apps. Both passkey/session contracts are deployed on CKB testnet and their live code hashes were verified on 2026-10-23. Publish the current deployment records when building the wallet and backend. Funding still requires configured sponsorship and CKB at the passkey owner address. Live hardware-passkey end-to-end testing remains outstanding.

The dark-only UI shares the demo’s forest-green/lime palette and Owl artwork. It adapts to popup/mobile widths and separates accounts, app approvals and session management. Backup/restore, technical policy details and queue receipts expand on demand. No permission is selected automatically.

Run `npm run build` and `npm test`. Browser tests use Chromium virtual authenticators. Root SDK and contract tests cover sponsored funding, grants, automatic actions, witness tampering, budget conservation, revocation and recovery. These do not replace live hardware-passkey testing or an independent audit.
