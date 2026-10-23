# Pilot wallet preview

An independent passkey owner and on-chain restricted session wallet. Read [PILOT_WALLET.md](../../PILOT_WALLET.md) for the architecture, SDK integration, trust boundaries and deployment instructions.

```sh
npm ci --prefix ../..
npm ci
npm run dev
```

Open **http://localhost:5176**. Use localhost, not an IP address, for WebAuthn RP IDs. The integrating demo runs on its separate origin and embeds this wallet in its SDK modal. The native device passkey prompt is still used for owner authentication. A stable HTTPS wallet domain is required for durable hosted credentials.

Set `VITE_PILOT_PAYMASTER_URL` on this wallet and `VITE_PILOT_WALLET_URL` on integrating apps. The session contract remains deployed on testnet; the original owner code cell has been consumed to reclaim capacity. The revised embedded owner lock is deployed in transaction `0x771edc9c5daf2f2e4c40eac48e3fc909f943d9541d59c6863454ede0f015f8d3` (output 0), recorded as `passkey`; the historical original record is archived as `retiredPasskeyLegacy` with `passkeyLegacy` unset. Rebuild and redeploy wallet/backend/apps with the revised records. Old public descriptors preserve the original address but cannot recover through the consumed code dependency; they are not silently migrated. Funding still requires configured sponsorship and CKB at the passkey owner address. Live hardware-passkey end-to-end testing remains outstanding.

The dark-only UI shares the demo’s forest-green/lime palette and Owl artwork. It adapts to popup/mobile widths and separates accounts, app approvals and session management. Backup/restore, technical policy details and queue receipts expand on demand. No permission is selected automatically.

Run `npm run build` and `npm test`. Browser tests use Chromium virtual authenticators. Root SDK and contract tests cover sponsored funding, grants, automatic actions, witness tampering, budget conservation, revocation and recovery. These do not replace live hardware-passkey testing or an independent audit.

The SDK keeps the iframe mounted after its modal hides; `provider.open()` reopens it, and orderly disconnect settles receipts before teardown. Apps must allow the wallet in `frame-src` and permit delegated `publickey-credentials-create`/`publickey-credentials-get`. Wallet production headers allow HTTPS framing; do not add `X-Frame-Options: DENY`. Browsers can partition or deny iframe storage and passkeys; no popup fallback or app-origin key storage is used. Cross-device/cross-app discovery and storage-access workflows remain planned. The embedding app can overlay its iframe, so origin isolation is not a trusted transaction-display guarantee.

Embedded presentation uses the compact original Pilot modal style: welcome, passkey sign-in/create-account, permission/budget review and profile screens. Queue/receipt logs, recovery and public backups are expandable in the profile. External-wallet addition and JoyID selection are not part of this flow; standalone recovery access remains available.

### Hosted wallet with a local app

When embedding the hosted HTTPS wallet, serve the integrating app over trusted HTTPS too, including local development. Chromium/Brave can report “WebAuthn is not supported on sites with TLS certificate errors” for a hosted wallet inside an HTTP localhost page even when the wallet certificate is valid. Use a trusted local certificate or an HTTPS preview deployment; clicking through an untrusted-certificate warning is insufficient. Localhost-to-localhost virtual-authenticator tests do not verify this hosted-wallet configuration. Safari embedded passkey creation remains a separate browser compatibility limitation.
