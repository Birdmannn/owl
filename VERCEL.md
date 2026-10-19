# Deploy Pilot on Vercel

The repository can serve the demo and all three APIs from one Vercel project. The sponsored contracts are already deployed on CKB testnet; the deployment outpoints are in `deployments/pilot-sponsored.json`.

## Two Vercel projects from the same repository

| Setting | Demo and backend | Docs and landing page |
| --- | --- | --- |
| Root Directory | Repository root; leave the directory field empty | `apps/docs` |
| Framework | Other | Vite |
| Install | `npm ci && npm ci --prefix packages/react && npm ci --prefix apps/demo` | `npm ci` |
| Build | `npm run build --prefix apps/demo` | `npm run build` |
| Output | `apps/demo/dist` | `dist` |
| Configuration | Root `vercel.json` | `apps/docs/vercel.json` |

Vercel may auto-select **Services** as the Application Preset when it detects the demo, docs and Rust contracts. In that screen, Root Directory can already be `./` while the docs service is assigned the public `/` route and the demo is internal. That is a Services routing selection, not evidence that the project root is `apps/docs`. For the demo/backend deployment, keep Root Directory at `./`, change Application Preset from Services to **Other**, and use the root configuration above. Do not import `apps/demo` as a standalone subdirectory with the current setup, because the backend function lives in the repository-root `api` directory. The Rust contracts are deployed to CKB, not Vercel. For the docs project, choose **Import single project** on the docs entry, with Root Directory `apps/docs` and preset Vite.

If a project actually has `apps/docs` as its Root Directory, change that setting separately for the demo and check its build/output overrides against the table, save, and redeploy. Root Directory is a Vercel project setting; repository configuration cannot change it for an already imported project.

Keep source files outside the Root Directory available for the docs build, since it imports shared deployment/script metadata. Set its public `VITE_DEMO_URL` to the demo deployment and optionally `VITE_PILOT_SOCIAL_URL` to that deployment's `/api/social` endpoint.

## Project setup

1. Import the GitHub repository into Vercel. Keep **Root Directory at the repository root**, not `apps/demo`.
2. Select **Other** as the framework and Node.js **22.x**. The committed `vercel.json` installs the root, React wrapper and demo dependencies, builds the demo, serves `apps/demo/dist`, and routes `/api/*` to the Node function at `api/index.ts`.
3. Attach a PostgreSQL database and set `DATABASE_URL` to its pooled connection URL, with the provider's TLS settings. Use one database for all instances sharing a pool. The runtime creates its tables automatically; the database role needs table/index creation permission on the intended schema.
4. Choose a stable HTTPS app domain and add the following Vercel environment variables. Replace `https://pilot.example` with that exact origin (no trailing slash):

```dotenv
# Server only
DATABASE_URL=postgresql://...
PILOT_APP_ORIGIN=https://pilot.example
PILOT_PAYMASTER_PRIVATE_KEY=0x...

# Public frontend build configuration
VITE_PILOT_PAYMASTER_URL=https://pilot.example/api/paymaster
VITE_PILOT_SOCIAL_URL=https://pilot.example/api/social
```

The key must own the funded address in `deployments/owl-paymaster.json`. The deployer key is a different key and is not needed on Vercel. Never prefix database credentials or private keys with `VITE_`.

The username API uses `/api/pilot` automatically. `PILOT_APP_ORIGIN` supplies the default registry signing origin, social audience, and allowed browser origin. Optional overrides are `PILOT_REGISTRY_ORIGIN`, `PILOT_REGISTRY_ALLOWED_ORIGINS`, `PILOT_SOCIAL_AUDIENCE`, and `PILOT_PAYMASTER_ALLOWED_ORIGINS`. Override values must be exact HTTPS origins; allowlists are comma-separated. The social audience must match the frontend's `window.location.origin`.

The root `.env.example` includes localhost allowlists for local development. Do not copy those localhost values into Vercel: omit the allowlist overrides to inherit `PILOT_APP_ORIGIN`, or set your public origins explicitly.

5. Deploy or redeploy after configuring the environment variables. Frontend variables are baked into the build. Use the configured app domain when testing.

For previews, supply a separate database and test pool/key, and configure the exact preview origin and frontend URLs. A production social grant is bound to its production origin. Do not point independent databases or JSON journals at the same funded pool, including preview deployments. IP rate limits alone are not user authentication; the paymaster also verifies signatures, on-chain scripts and persistent spending caps.

## Verify the deployment

```sh
curl https://pilot.example/api/pilot/health
curl https://pilot.example/api/social/manifest
curl https://pilot.example/api/paymaster/status
```

Then connect an owner wallet in the demo, create a fresh sponsored session, and perform an action. Check the transaction inspector and chain receipt: user app-cell capacity stays unchanged and the pool input/change difference pays the network fee. Legacy sessions retain their existing fee rules.

Enable social signing, publish a post, reload, and check the shared feed and receipts. Register/resolve a username to check the registry. Test wallet signing in the deployed browser; a successful API health check alone does not verify that flow.

Backend initialization failures return sanitized errors. Missing database configuration never falls back to Vercel's temporary filesystem. A configured database outage fails closed; retry the original signed request after recovery.

## Persistence and concurrency

| Storage | Contents |
| --- | --- |
| `pilot_usernames` | Public username, recipient address and verified signing identity/profile |
| `pilot_username_challenges` | Temporary wallet-ownership challenges |
| `pilot_journals`, paymaster scope | Quotes, exact signed transaction bytes, owner/day accounting and pool-input leases |
| `pilot_journals`, social scope | Shared likes/follows/posts, action receipts/replay nonces and revoked grant IDs |
| `pilot_rate_limits` | Shared per-service IP request counters with expiry |

Paymaster scope is determined by the testnet pool lock hash; social scope by the social app/audience. A PostgreSQL `SELECT ... FOR UPDATE` transaction serializes each scope across all function instances. Rejections roll back the entire mutation. Pool signatures are persisted and committed with their lease and fee accounting **before** transaction broadcast or returning signed bytes. Lost responses reuse the saved transaction. Social mutation, replay checks and revocation checks are committed atomically.

This initial database adapter keeps bounded JSONB journal documents, rather than a row per receipt. It serializes operations per pool/audience, including paymaster RPC validation. Lock waits time out after five seconds, and idle transactions after fifty seconds; contention returns a retryable failure. The function has a sixty-second duration setting. Existing prototype journal/receipt caps remain; this is not a high-throughput settlement service. Request-driven retries handle interrupted broadcasts; no background worker or cron is needed to retain exact bytes, and automatic autonomous resubmission is not implemented.

Use a pooled database connection URL. Each warm store uses a small connection pool (maximum three connections), with short idle timeouts. Configure database and Vercel capacity for expected traffic. Private keys remain server environment secrets, not database fields. Browser session keys and local diagnostic logs remain in browser storage.

## Existing local data

Standalone `npm run registry`, `npm run social`, and `npm run paymaster` also use PostgreSQL when `DATABASE_URL` is present; otherwise they retain their local JSON stores. Vercel handlers always require PostgreSQL. Initialization is idempotent and safe across concurrent cold starts.

Existing JSON data is **not imported automatically**. Before switching a live service, stop every old instance and explicitly migrate its records, including signed transaction bytes, pool leases, daily fee accounting, social receipts/nonces and revocations. Do not start with an empty database while an old journal has unresolved pool transactions. Keep backups of database/journals; do not delete signed retry records to recover availability.

## Local verification

Use a disposable PostgreSQL database; tests create and remove isolated schemas:

```sh
PILOT_TEST_DATABASE_URL=postgresql://user:password@localhost:5432/pilot_test npm test
npm run typecheck
npm run build --prefix apps/demo
```

The suite tests real PostgreSQL multi-instance competition, durable-before-broadcast writes, fee limits, rollback, social replay/revocation, shared rate limits, and the exported request adapter with Vercel-style parsed bodies. It does not publish a Vercel deployment or spend public pool funds.

Vercel references: [Node.js request handlers](https://vercel.com/docs/functions/runtimes/node-js) and [project configuration](https://vercel.com/docs/project-configuration/vercel-json).
