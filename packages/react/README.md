# @owl/pilot-react

Reusable Pilot connection, profile, and permission modal. The demo in `apps/demo` integrates this package with CCC’s existing-wallet connector and the Pilot SDK.

```tsx
import { PilotModal } from '@owl/pilot-react';
import '@owl/pilot-react/styles.css';
```

Supply a `PilotManifest`, connected owner address and balance, a profile view, session state, and callbacks for owner connection, saving a profile, authorizing selected permission IDs, resuming a submitted approval, refreshing balance, disconnecting, and revoking. The component owns modal navigation, explicit checkbox consent, keyboard focus, and permission/limit presentation. Wallet discovery remains the host’s responsibility; in the demo, choosing Pilot opens this modal, which then opens CCC to connect the owner wallet.

The modal does not hold owner keys, create a new owner wallet, or implement a username authentication service. Profiles and session execution are managed by the host. Pilot manages wallet-backed usernames. `onProfile` can return a promise: await Pilot username lookup or wallet-signed registration before continuing. The host reports profile errors and passes the resulting profile to the modal. The modal accepts legacy `PilotManifest` and version-2 `PilotAppManifest`. Version 2 renders named actions independently and omits owner-only actions from delegation choices. Pass `onPrepareDelegation` to show the exact cell/fee review before `onAuthorize`, `approvedPermissions` for the active subset, and `onContinueWithoutDelegation` to remain connected without funding a session. Unsupported CKB scripts cannot be presented as supported signing policies.

From the repository root:

```sh
npm run build
npm install --prefix packages/react
npm run build --prefix packages/react
```

This package is local and private; it has not been published to npm.

`PilotOffchainModal` provides separate consent for message signing. It accepts an `OffchainManifest`, `visible`, `address`, `busy`, optional `error`, and `onClose`, `onConnectOwner`, `onAuthorize(selected, expiresAt)` callbacks. Permissions start unchecked and the demo approval lasts one hour. This flow requires no username, CKB transaction, or fee budget. The host calls `authorizeOffchain()` after consent and manages key persistence, action submission, replay protection, and receiving-app revocation. Import the same stylesheet as `PilotModal`.


## Account activity

Both modals include an expandable **Activity & logs** section for the connected address. It lists public action metadata, timestamps, app/session/action IDs, signing method, status, transaction hash or off-chain target, and per-action timelines. On-chain confirmation and off-chain application acceptance are labeled separately.

Wire your action/adapter events to `recordPilotActivity(localStorage, entry)` from `@owl/pilot`; reuse `(appId, sessionId, id)` for lifecycle updates. The modal reads this browser journal live and across tabs. It does not intercept arbitrary wallet calls. For your own journal, pass `activity: readonly PilotActivity[]` to either modal, or render `<PilotActivityLog address={address} activity={entries}/>` directly. Entries are filtered by the connected address again. Never supply keys or secrets in event text.

History persists locally on the same browser origin, is best-effort and editable, and is not a cross-device ledger or authorization proof. `PilotOffchainModal` accepts `approvedPermissions` to show an existing session's read-only permissions and logs. See [SECURITY_AUDIT.md](../../SECURITY_AUDIT.md) for the current signing boundaries and open risks.

## Browser account switching

Wrap controlled modals in `PilotAccountsProvider` and use `usePilotAccounts()` as the source of the app’s active owner signer. Pass CCC’s `signerInfo?.signer`, wallet name, `isOpen` as `connectorOpen`, a stable network ID, and callbacks for connecting/disconnecting wallets. CCC remains the wallet discovery UI; Pilot selects the owner above it. The demo’s `AccountBridge` in `apps/demo/src/main.tsx` provides complete wiring. Use `usePilotAccountGuard(blocked)` in every panel with signing or queued work to prevent switching during those operations.

Both modals automatically show remembered accounts from this site/network. Multiple owners from one wallet are separate entries. Selection checks the live address and signing identity before changing the active owner. A cached connection is reusable only while it still matches; otherwise the wallet is reopened. Use the returned signer for **all** app signing, not CCC’s underlying discovery signer. Scope profiles, sessions, stores, and activity by the resulting owner address, as in the demo. Existing controlled integrations without this provider continue to work.

An optional `connectJoyId` callback must create a fresh signer and call `connect()` on every invocation. Use an isolated connection repository so this flow does not replace CCC’s cached JoyID connection. The SDK has no documented force-passkey-creation flag: the wallet controls account selection and registration. Accounts not previously connected cannot be enumerated. Account metadata is stored as public connection hints only; it grants no signing authority. After reload, remembered accounts can need authentication again. Disconnecting does not revoke saved app grants.
