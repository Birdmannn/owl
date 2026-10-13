# Pilot username registry

From the repository root, run `npm install` and `npm run registry`. The server reads root `.env`; see `.env.example`. Defaults: loopback port 5180, CKB testnet, allowed demo/docs origins on ports 5174/5175.

- `DATABASE_URL`: PostgreSQL connection string. Tables are initialized on startup. Credentials stay server-side.
- No `DATABASE_URL`: `data/pilot-usernames.json` inside this repo, created automatically. The runtime file is ignored by Git and denied by the demo's static server. `PILOT_REGISTRY_FILE` overrides its location.
- A configured database failure stops startup; it never creates a second JSON namespace. Switching backends requires explicit data migration.
- For deployment, configure `PILOT_REGISTRY_ORIGIN`, `PILOT_REGISTRY_ALLOWED_ORIGINS`, `PILOT_REGISTRY_HOST`, `PILOT_REGISTRY_PORT`, and `PILOT_REGISTRY_NETWORK`. Serve HTTPS through your host/reverse proxy. Use PostgreSQL for multiple hosts; JSON mode requires a shared filesystem.

API base: `/api/pilot`.

| Endpoint | Behavior |
| --- | --- |
| `GET /health` | Service status and configured network. |
| `GET /usernames/:username` | Resolve a public username record; 404 when absent. |
| `GET /accounts/:address` | Return `{profile}` if the address has a registered username. |
| `POST /challenges` | Accept username, ownerAddress, signType and identity; return a five-minute signing challenge. |
| `POST /usernames` | Accept challengeId and CCC signature; verify ownership and atomically consume the challenge to claim the name. |

The server derives acceptable CKB locks from verified signing identities. It never accepts a supplied recipient address without checking that binding. JoyID registrations support primary P-256 passkeys; wallet signatures support CKB secp256k1, EVM personal signing, Bitcoin ECDSA, Nostr and Dogecoin. Each username, recipient address and canonical signing identity is unique. Renaming, key rotation, deletion, multi-wallet linking and automatic import of old browser-local names are not implemented. Names are unique in one registry, not globally across independently hosted registries.

Public registry records contain addresses and public signing identities; no wallet private keys or passkey secrets. Registration is a proof of ownership, not spending consent. Senders review a resolved address and authorize transactions in their own wallets. The SDK currently builds CKB and Spore NFT transfers; other asset standards need builders.

Run `npm test` for JSON, proof verification and builder tests. PostgreSQL verification uses a temporary schema and cleans it up:

```sh
PILOT_TEST_DATABASE_URL=postgresql://user:password@localhost:5432/pilot_test npm run test:registry:postgres
```

Use a test database. This check was also run against an ephemeral local PostgreSQL instance on 2026-10-13. Automated tests cover signature verification, recipient binding, JSON persistence/concurrency, PostgreSQL uniqueness/transactions, and CKB/Spore construction. Live JoyID browser registration and live username transfers remain unverified.
