# Pilot flow verification

The session flow was verified on CKB testnet on 2026-10-12, before shared usernames were introduced. The browser uses the real CCC connector with an injected EIP-6963 test wallet; funding, signatures, broadcasts, confirmations, and recovery are real on-chain operations. Manual extension-wallet testing remains outstanding.

| Flow step | Result | Evidence |
| --- | --- | --- |
| Connect wallet lists Pilot | Pass | Browser tests choose Pilot in the app wallet picker before seeing any owner-wallet options. |
| Pilot wraps an existing wallet | Pass | Pilot opens CCC to connect the owner; the owner key stays in that wallet. |
| Create or return to a username | Pass in automated registry/browser tests | Shared names bind to a verified signing identity and recipient address. JoyID primary P-256 passkeys and other wallets can register. Names are unique within one registry; manual JoyID browser registration is outstanding. |
| See address and balance | Pass | Modal displays the owner’s CKB testnet address and balance, with copy and refresh controls. |
| Inspect the app manifest | Pass | Owl Flight supplies names, descriptions, deployment identity, policy, per-move fee, budget, and protected capacity. Raw manifest is expandable. |
| Choose automatic approvals | Pass | The Fly forward checkbox starts unchecked. Approval is disabled until selected. Unknown, missing, or duplicate permissions are rejected by the SDK. |
| Authorize once | Pass | Owner signs the funding transaction. The grant records selected permission IDs and a manifest commitment. A submitted approval must be resumed before another can replace it. |
| Pilot signs permitted app actions | Pass | Two moves updated optimistically, used session signatures, and confirmed on testnet with no further owner signatures. |
| On-chain permission enforcement | Pass for counter-v1 | Supported script identity is pinned. The contract enforces increment-by-one, exact transaction shape, session signatures, fee limits, budget debits, and protected capacity. Manifest labels alone grant no authority. |
| Restore after reload | Pass | Session, approved manifest commitment, profile, position, budget, signed journal, and queue are restored. |
| Owner revokes and recovers | Pass | One owner signature recovered session capacity after the move queue settled. |
| Requests outside the grant | Pass, reject behavior | SDK rejects unknown actions and changed manifests. This version does not implement an automatic manual-signing fallback for additional action types. |

Public receipts and signature counts are in `deployments/pilot-flow-testnet-proof.json`.

## Current boundaries

Pilot appears as a wallet option in integrating apps; it is not yet an installed wallet extension or a globally discoverable wallet provider. `PilotCounterConnector` is a reusable SDK wrapper, and `@owl/pilot-react` is the reusable modal package. These are local packages, not published releases.

The first supported policy is counter-v1, which has one selectable action. General function manifests for arbitrary CKB applications need additional contract policies and adapters. Profiles now use a shared, off-chain username registry backed by PostgreSQL when configured, otherwise repo-local JSON. This is not an on-chain name service or a passkey custody/recovery service. A registration proof adds a separate owner signature before session approval. Session keys use localStorage in this demo, not an isolated production wallet vault. The 24-hour expiry is local only; end the session to revoke on-chain authority. Revoke existing sessions before shipping a changed manifest that needs new approval.

Username-based CKB and Spore transfer builders have automated policy tests. Live username-based transfers have not been verified. Existing session testnet receipts do not certify this newly added transfer flow.
