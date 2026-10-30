# Pilot wallet-enforced transaction templates

The general-account lock is deployed and verified live on CKB testnet as of 2026-10-28. Its code hash matches the SDK pin; the deployment outpoint is recorded under `walletGeneral` in `deployments/pilot-sponsored.json`. Rebuild/redeploy the wallet and paymaster with that record and update integrating apps to activate general mode. Hosted end-to-end signing with this deployment has not yet been verified. Existing accounts retain their original locks. Nothing silently migrates those accounts or their assets.

The general account lets Pilot’s session key sign transaction effects across future app instances. Before signing, wallet software checks the user-selected transaction templates. The account contract enforces the signing key, unique TYPE_ID authority, unchanged grant commitments, advancing sequence, cumulative **net CKB outflow** allowance, and pool-only network fees. Passkey-owner replacement, revocation and recovery remain independent of the session key.

Action templates are **not enforced by the contract**. A stolen session key can bypass them, including transferring typed assets within available cell capacity. CKB limits do not value or limit tokens/NFTs. The app’s scripts still execute their own validation. Template matching does not prove arbitrary business intent, implement a contract-method interpreter, or impersonate a different owner address. Contract-enforced templates are future work in [IMPLEMENTATION_V2.md](IMPLEMENTATION_V2.md#contract-enforced-transaction-templates).

## Integration

Use the updated repository installer, then request `accountMode: 'general'`. The static `policies` API and account-dependent `buildPolicies` callback both support `pilotTemplatePolicy(name, template)` values. Keep off-chain scopes as separate `message` policies. One template checks a whole transaction; it does not combine half of one action with half of another.

```ts
import { ccc } from '@ckb-ccc/core';
import {
  PilotWalletProvider, PilotHostedSigner, pilotTemplatePolicy,
  type PilotTransactionTemplate,
} from '@owl/pilot';

const client = new ccc.ClientPublicTestnet();
const provider = new PilotWalletProvider({ url: 'https://your-wallet.example' });

// Supply YOUR deployed app script hashes. These are neither built-in contracts
// nor an invitation to accept every contract using a human-readable action name.
const connection = await provider.connect({
  name: 'My app',
  accountMode: 'general',
  budget: ccc.fixedPointFrom(1000).toString(),
  async buildPolicies(selected) {
    const template: PilotTransactionTemplate = {
      version: 1,
      id: 'create-owned-record',
      maxSpend: ccc.fixedPointFrom(300).toString(),
      inputs: [],
      outputs: [{
        role: 'record',
        lock: 'account',
        type: {
          codeHash: YOUR_RECORD_CODE_HASH,
          hashType: 'data2',
          args: { length: YOUR_RECORD_ARGS_LENGTH },
        },
        capacity: { max: ccc.fixedPointFrom(300).toString() },
        data: {
          length: YOUR_RECORD_DATA_LENGTH,
          fields: [{ offset: YOUR_OWNER_FIELD_OFFSET, value: 'accountLockHash' }],
        },
      }],
    };
    // selected.address is known before review; use it to derive more app fields.
    return [pilotTemplatePolicy('Create my record', template)];
  },
});
const signer = new PilotHostedSigner(client, provider);
const prepared = await signer.prepareTransaction(appTransaction);
const hash = await signer.sendTransaction(prepared, stableRequestId);
```

This example is a pattern for an app whose record data contains a full owner lock hash; replace every `YOUR_*` field and supply the app’s actual rules. It is not a ready-made Freight policy. Existing Freight lock/data encodings must be checked by its integration. Broader parameter ranges authorize broader transactions: matching code identity alone is insufficient to authorize a particular operation.

## Rules

Each template has version `1`, a stable `id`, `maxSpend` in decimal shannons, `inputs`, and `outputs`. Optional `relations` and `witnesses` constrain cross-cell fields and operation selectors. Unknown rule properties and versions are rejected; code callbacks are not accepted as trusted validators.

- Every application effect must match exactly one role within the **same** selected template. Roles must be unique per input/output side. Missing required roles, ambiguous matches, unexpected cells or excess repetitions reject the template.
- A role defaults to exactly one occurrence. Set `min`/`max` explicitly to permit optional or repeated cells, up to 64 occurrences. At most 32 input roles and 32 output roles are supported. A template must include an output rule.
- The wallet manages its own authority and ordinary empty account funding/change cells; those are excluded from template roles. All other input cells and all other outputs must be described, including account-owned typed/data-bearing assets. Developers should not include wallet-generated authority, funding/change or sponsor cells in example effects.
- A script pattern is `'account'`, `'owner'`, or `{ codeHash, hashType, args }`. Explicit `args` constraints support exact `equals`, a byte `prefix`, exact byte `length`, and byte `fields`. Omitting a constraint leaves that property variable. A type pattern of `null` requires **no type script**; it is not a wildcard.
- Data constraints support exact `length`, `minLength`, `maxLength`, `prefix`, and `fields`. Byte offsets and lengths count bytes, not hex characters. Fields match fixed hex bytes or `accountLockHash`, `ownerLockHash`, `accountLockArgs`, `ownerLockArgs`. To bind a prefix, use `{ account: 'accountLockArgs', offset: 0, length: 20 }` as the field’s `value`. Out-of-range references reject.
- A cell’s optional `capacity.min`/`capacity.max` bounds the complete capacity of that cell, not the amount of a purchase. `maxSpend` bounds net CKB leaving the account for the entire action. The on-chain remaining allowance is also checked and debited; receipts/incoming funds do not automatically refill it.
- Equality `relations` use `left`/`right` references with `source: 'input' | 'output'`, `role`, optional occurrence `index`, and `field: 'lock' | 'type' | 'data' | 'capacity' | 'lockArgs' | 'typeArgs'`. Script fields compare hashes; data/args/hash fields may use a byte `offset`/`length`. Capacity compares exact decimal amounts. A repeated role requires an explicit occurrence index. This version has equality, not a general arithmetic or token-amount interpreter.
- `witnesses` reference an `inputRole`, optional occurrence `index`, `field: 'inputType' | 'outputType'`, and exact `equals` and/or `prefix` hex bytes. This can constrain a contract’s operation selector. Raw or differently encoded app witnesses need an appropriate future schema; they are not silently decoded.

Example cross-cell rules to preserve campaign identity and require an operation selector:

```ts
relations: [{
  left:  { source: 'input',  role: 'campaign', field: 'type' },
  right: { source: 'output', role: 'campaign', field: 'type' },
}],
witnesses: [{ inputRole: 'campaign', field: 'outputType', equals: '0x03' }],
```

The SDK checks templates before signing and again against the submitted prepared effects. A changed policy body must match its canonical hash commitment or fail. The on-chain grant commits the template hashes and per-policy amounts without interpreting their bodies; templates remain in the wallet journal. Names alone never approve spending. Lost-response retries use the same prepared bytes and action ID and reconcile saved signatures before new spending. Receipts record the matched action name/id for the profile.

## Variable-size batches

Use `forEach` to apply the same equality constraints to every paired input/output occurrence. One permission can cover 1–64 entries, without separate templates for each size or manually expanding every comparison. This is wallet-enforced like the other template rules; no general-lock or integrating-contract redeployment is needed.

```ts
// Both role definitions use { role: 'winner', min: 1, max: 64, ... }.
forEach: [{
  inputRole: 'winner',
  outputRole: 'winner',
  relations: [{
    left:  { source: 'input',  role: 'winner', index: 'each', field: 'lock' },
    right: { source: 'output', role: 'winner', index: 'each', field: 'lock' },
  }, {
    left:  { source: 'input',  role: 'winner', index: 'each', field: 'data', offset: 0, length: 20 },
    right: { source: 'output', role: 'winner', index: 'each', field: 'data', offset: 0, length: 20 },
  }, {
    left:  { source: 'input', role: 'winner', index: 'each', field: 'data', offset: 20, length: 8 },
    right: { source: 'input', role: 'campaign', field: 'data', offset: 0, length: 8 },
  }],
}]
```

Pairing follows occurrence order within each role, not absolute transaction indices or identity lookup. Counts must be equal. `index: 'each'` is valid only for the group's input/output roles; ordinary numeric indices and singleton references can supply shared context. Every relation must reference `each` on at least one side. Ordinary `relations` still require a numeric index for repeated roles. Lock equality compares the full lock hash. Choose data slices for the application's actual identity layout; the offsets above are illustrative, not a universal format.

All application effects still match exactly one role. Missing/extra counterparts, redirected recipients or identity changes fail the corresponding comparisons. If reordering changes a compared field, it also fails; the engine does not sort or search for a matching recipient. The rule does not independently enforce unique identity values: bind sufficient identity fields and rely on the app contract for any domain-specific uniqueness, reward arithmetic or winner-selection requirements. Role bounds apply before iteration; empty groups are allowed only when both roles explicitly permit zero entries.

Limits: 32 groups, 64 comparisons per group and 4,096 worst-case expanded comparisons across all groups. The expansion bound uses each group's smaller input/output maximum. The existing 64 ordinary comparisons and 64 occurrences per role remain unchanged. Unknown properties and invalid iterator references fail closed. All repeated rules enter the canonical policy commitment.

Redeploy the wallet with the updated matcher and install the updated SDK in integrating apps and receiving message verifiers. Older matchers reject the new schema. Changing from fixed-size templates changes permissions: users must explicitly review a replacement grant after pending receipts settle; existing grants are not silently broadened. The current single-session rule remains unchanged. FON now uses one **Distribute rewards** template for 1–64 raffle winners, preserving each entry's lock and identity and binding it to the campaign. Tests use real FON transaction builders with mocked chain data; live distribution remains to be verified after redeployment.

## Starting from an example

`await pilotTemplateFromExample(client, appTransaction, { id, maxSpend })` reads live example inputs and creates exact script arguments, exact cell capacities, complete data prefixes/lengths and present input/output type witnesses. It does **not** infer which fields are safe to vary. Explicitly relax the intended fields, add ownership/cross-cell constraints, then wrap it with `pilotTemplatePolicy` before approval. An input/output example with the same keys is insufficient: recipients, ownership, witnesses, data and amounts must be constrained. Build examples before wallet funding/change/authority completion.

## Deployment and existing accounts

1. Build and verify: `npm run contracts:build`, `npm run check`, `npm run contracts:test`.
2. The repository’s general lock is already deployed on testnet. For a separate deployment, deploy the code cell with a funded testnet deployer: `npm run paymaster:deploy -- walletGeneral`. This updates `deployments/pilot-sponsored.json`; it does not consume old contract code or transfer user funds.
3. Redeploy the wallet and paymaster backend using that deployment record. The default backend code allowlist recognizes the new pinned hash; explicitly configured allowlists must add `PILOT_WALLET_GENERAL_CODE_HASH` too.
4. Reinstall/rebuild the integrating SDK, request `accountMode: 'general'`, supply templates and obtain fresh owner approval/funding.

The passkey owner stays the same, but the general session address is a **new account identity**, stored separately from the legacy descriptor. Existing balances, app identities and typed assets do not move automatically. Reconcile/recover old accounts using their original mode; any asset transfer needs its compatible builder. General recovery backups must be imported with the general-mode wallet (`?accountMode=general`). A missing general deployment blocks setup and never falls back to the restricted lock. No second owner contract is required for this mode; the current embedded passkey owner lock is reused.

The browser suite uses virtual passkeys and mock public chain reads. Unit tests cover signing and reconciliation against a chain fixture; Rust tests execute the compiled lock in CKB-VM, including a test demonstrating software-template bypass with a valid general key. The code-cell deployment has been verified live on testnet; this does not establish a hosted end-to-end signing flow, real-device certification or independent security audit.
