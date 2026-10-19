const code = (code, language = 'typescript') => ({ code, language });
export const delegation = {
  id: 'cell-delegation', group: 'BUILD WITH PILOT', title: 'Cell delegation', eyebrow: 'DEFINE YOUR APP ACTIONS',
  description: 'Define named transitions and builders, let users choose permissions, and authorize selected cells with a reusable CKB lock.',
  sections: [
    { id: 'developer-setup', title: 'The developer defines the transition', html: '<p><code>definePilotApp()</code> combines a version-2 manifest, a state codec, and one builder per action. The manifest gives users readable names and binds script identity, operation labels, transition rules, and fee limits. The builder constructs transactions; Pilot does not infer application behavior from a script hash.</p><p>The application’s optional type script still enforces its own rules. Pilot’s <code>delegation-v1</code> lock enforces which selected actions the session key may perform. The current reusable policy supports a fixed increment or decrement of one declared little-endian <code>u64</code> field; every other data byte must remain unchanged. Arbitrary transitions require another compatible policy.</p>', table: [['manifest.app', 'App ID, readable name, and description.'], ['manifest.script', 'Optional app type script: role, codeHash, hashType, args, and code cell dependency.'], ['manifest.actions', 'Action ID, name, description, operation label, transition, and optional owner-only designation.'], ['manifest.cellSelection', 'Optional data prefix and exact data length for discovering and selecting app cells.'], ['manifest.policy', 'Pinned delegation binary and real deployment; fee per action, budget, protected capacity, setup and recovery fee caps.'], ['actions[id]', 'Developer validate(), apply(), and buildTransaction() functions.'], ['encodeState / decodeState', 'Lossless conversion between app state and cell data.'], ['buildAuthorization', 'Optional app-specific creation/migration hook; its transaction is independently checked by Pilot.']] },
    { id: 'define-app', title: 'Register a named action', html: '<p>This factory accepts a real <code>delegation-v1</code> deployment. It defines a one-field app; add an app type script when your application has one. Use the actual code-cell outpoint and genesis hash from your deployment. The full forward/backward/owner-only example is in <code>examples/cell-delegation.ts</code>.</p>', ...code(`import { ccc } from '@ckb-ccc/core';
import { definePilotApp, type Deployment } from '@owl/pilot';

export function createApp(deployment: Deployment) {
  return definePilotApp<{ position: number }, undefined>({
    manifest: {
      version: 2,
      app: { id: 'my.game', name: 'My Game', description: 'Move one step.' },
      network: \`ckb-\${deployment.network}\`,
      cellSelection: { dataLength: 8 },
      actions: [{
        id: 'game.move', name: 'Move your character',
        description: 'Advance one step without another wallet prompt.',
        operation: 'move',
        transition: { kind: 'u64-increment', offset: 0, delta: '1' },
      }],
      policy: {
        kind: 'delegation-v1', deployment,
        feePerAction: '100000', budget: '2000000',
        floorCapacity: '35000000000',
        maxSetupFee: '1000000', maxRecoveryFee: '1000000',
      },
    },
    encodeState(state) {
      if (!Number.isSafeInteger(state.position) || state.position < 0)
        throw new Error('Invalid position');
      const bytes = new Uint8Array(8);
      new DataView(bytes.buffer).setBigUint64(0, BigInt(state.position), true);
      return ccc.hexFrom(bytes);
    },
    decodeState(data) {
      const bytes = ccc.bytesFrom(data);
      if (bytes.length !== 8) throw new Error('Invalid app data');
      const value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        .getBigUint64(0, true);
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Position overflow');
      return { position: Number(value) };
    },
    actions: {
      'game.move': {
        async validate(_params, { state }) {
          return { allowed: Number.isSafeInteger(state.position + 1), cost: 100000n };
        },
        apply(state) { return { position: state.position + 1 }; },
        async buildTransaction(_params, { defaultTransaction }) {
          return defaultTransaction;
        },
      },
    },
  });
}`) },
    { id: 'onboarding', title: 'Connect, review, then authorize', html: '<p>Use <code>PilotConnector(ownerSigner, app)</code> inside the wallet connection flow. <code>findDelegatableCells()</code> discovers matching owner cells; it does not automatically delegate them. Ask the user to select one cell, or create a new app cell with an initial state.</p><p><code>prepareDelegation()</code> returns a review with selected action names, the exact source outpoint, source and delegated capacity, protected capacity, fee budget, setup fee, app script hash, and state data. Only after explicit approval call <code>authorize()</code>. A required receipt store saves exact signed bytes before broadcast. Persist the session key and returned cell metadata before requesting approval so interruptions can resume.</p><p>An empty permission selection returns <code>mode: "connected"</code> without funding or signing. This supports a connected account that declines automation.</p>', ...code(`const connector = new PilotConnector(ownerSigner, app);
const candidates = await connector.findDelegatableCells();
// UI selects a specific candidate; never delegate the whole wallet.
const prepared = await connector.prepareDelegation({
  selected: userSelectedActionIds,
  sessionPublicKey,
  source: userSelectedCell.outPoint,
  // For creation, omit source and supply initialState instead.
});

if (prepared.mode === 'delegation') {
  // Display prepared.review and obtain explicit user approval.
  // Persist the session key and prepared.cell before signing.
  const cell = await connector.authorize(prepared, setupReceiptStore);
  // If interrupted, connector.resume(setupReceiptStore) retries saved bytes.
}`) },
    { id: 'independent-checks', title: 'Pilot checks the builder independently', html: '<p>The authorization transaction must preserve the selected cell’s data and type, create exactly the reviewed delegated output, and send any extra outputs only to ordinary owner change. Extra inputs may fund setup only if they are ordinary, empty-data, type-free cells under the same owner lock. Unrelated state cells, assets, payments, duplicate inputs, changed reviews, and excessive fees are rejected.</p><p>The signed transaction is dry-run before broadcast. An app type script that forbids changing ownership or locks can reject migration. Its developer must supply a valid migration path or update the application; Pilot cannot bypass the existing contract. Both the owner and session paths reject changed transaction effects from the signer or builder.</p>' },
    { id: 'automatic-actions', title: 'Route actions to registered builders', html: '<p><code>PilotDelegationAdapter.create()</code> verifies the actual code cell, network, approved lock, session key, grant, and settlement-journal identity. Use it with the existing <code>Pilot</code> engine and actions shaped as <code>{ id, params }</code>. Readiness checks the selected permission and compares the optimistic result to the declared transition.</p><p>Settlement is sequential. The adapter checks the live cell, independently validates builder output, signs with the session key, saves exact bytes, and submits. The on-chain lock rejects unselected operations even with a valid session-key signature. It preserves the lock, type script, other state bytes, capacity floor, and fee cap. Signatures commit the operation and every witness, including app type witnesses.</p><p>The fee budget is the cell’s capacity above the protected floor; every automatic action reduces it. The example uses 350 recoverable CKB plus 0.02 CKB for 20 actions. Actual occupied capacity depends on selected rules and app script/data; the SDK rejects an insufficient floor. Expiration remains local. A compatible sponsored policy can use a paymaster for network fees instead of reducing user capacity; see <a href="#paymaster">Owl Paymaster</a>.</p>' },
    { id: 'manual-and-recovery', title: 'Keep unapproved actions on the owner path', html: '<p>Set <code>delegation: "owner-only"</code> for an action the developer never wants automated. It cannot enter a grant and has no permission checkbox. Users may also leave a delegatable action unchecked. <code>prepareOwnerAction()</code> supports an explicit owner-signed transition for either case, including an existing owner-locked app cell without a funded delegation.</p><p>Drain the automatic queue first. Review the owner transaction, submit with <code>submitOwnerDelegationTransaction()</code> and a durable receipt store, then use <code>adapter.adoptOwnerAction()</code> and <code>pilot.reconcileConfirmed()</code> to adopt its confirmed state before resuming automation. Reconciliation rejects unresolved queues and increased allowances.</p><p><code>prepareDelegationRecovery()</code> returns the app cell to the owner lock, preserving its data, type, remaining capacity, and unused budget. Recovery requires an ordinary owner funding cell and a separate fee. The app’s type script must allow that ownership transition. Saved manual/recovery transactions resume through <code>connector.resume()</code> without requesting another signature.</p>' },
    { id: 'react-flow', title: 'Show the developer-defined permissions', html: '<p><code>PilotModal</code> accepts the version-2 manifest and renders each delegatable action independently. Provide <code>onPrepareDelegation</code> to build and display the exact cell review before <code>onAuthorize</code>, <code>approvedPermissions</code> to display the actual selected subset, and <code>onContinueWithoutDelegation</code> to remain connected with no funded session.</p><p>The browser demo’s <strong>Developer cell delegation</strong> panel integrates creation/migration selection, forward/backward permissions, an owner-only jump, owner recovery, reload handling, a tab lease, and detailed queue/transaction logs. Select a compatible testnet deployment for the app policy. The panel retains its public deployment metadata across reloads. Manual actions and recovery show a separate transaction review before asking for the owner signature.</p>', demo: true },
    { id: 'verification', title: "Supported policy limits", html: "<p>The reusable policy supports one delegated app cell per session transaction and up to 16 declared actions. Each automated action changes one declared little-endian u64 field by a fixed amount and preserves the other state bytes.</p><p>Arbitrary multi-cell, NFT or other state transitions require a compatible policy and builder. Pilot cannot override an app type script that rejects migration or recovery. These integrations target testnet; mainnet is rejected. On-chain expiration remains local to the SDK.</p>" },
  ],
};
