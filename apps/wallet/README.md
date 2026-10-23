# Pilot wallet preview

An independent passkey owner and on-chain restricted session wallet. Read [PILOT_WALLET.md](../../PILOT_WALLET.md) for the architecture, SDK integration, trust boundaries and deployment instructions.

```sh
npm ci --prefix ../..
npm ci
npm run dev
```

Open **http://localhost:5176**. Use localhost, not an IP address, for WebAuthn RP IDs. The integrating demo runs on its separate origin and opens this wallet as a popup. A stable HTTPS wallet domain is required for durable hosted credentials.

Set `VITE_PILOT_PAYMASTER_URL` on this wallet and `VITE_PILOT_WALLET_URL` on integrating apps. The two new CKB deployments are currently unset; the UI permits passkey creation/authentication but blocks on-chain setup. No simulated on-chain success is displayed.

Run `npm run build` and `npm test`. Browser tests use Chromium virtual authenticators. Root SDK and contract tests cover sponsored funding, grants, automatic actions, witness tampering, budget conservation, revocation and recovery. These do not replace live hardware-passkey testing or an independent audit.
