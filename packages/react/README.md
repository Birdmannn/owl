# @owl/pilot-react

Reusable Pilot connection, profile, and permission modal. The demo in `apps/demo` integrates this package with CCC’s existing-wallet connector and the Pilot SDK.

```tsx
import { PilotModal } from '@owl/pilot-react';
import '@owl/pilot-react/styles.css';
```

Supply a `PilotManifest`, connected owner address and balance, a profile view, session state, and callbacks for owner connection, saving a profile, authorizing selected permission IDs, resuming a submitted approval, refreshing balance, disconnecting, and revoking. The component owns modal navigation, explicit checkbox consent, keyboard focus, and permission/limit presentation. Wallet discovery remains the host’s responsibility; in the demo, choosing Pilot opens this modal, which then opens CCC to connect the owner wallet.

The modal does not hold owner keys, create a new owner wallet, or implement a username authentication service. Profiles and session execution are managed by the host. Pilot manages wallet-backed usernames. `onProfile` can return a promise: await Pilot username lookup or wallet-signed registration before continuing. The host reports profile errors and passes the resulting profile to the modal. The supported manifest currently describes the deployed `counter-v1` policy only; unsupported CKB scripts cannot be presented as supported automatic signing policies by the SDK wrapper.

From the repository root:

```sh
npm run build
npm install --prefix packages/react
npm run build --prefix packages/react
```

This package is local and private; it has not been published to npm.
