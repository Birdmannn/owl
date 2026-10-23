# Pilot CKB locks

## Reusable cell delegation v1

`delegation-lock` is a separate reusable lock. The application may attach its own type script. Each session action consumes one app cell and creates one successor with identical lock and type. Selected action hashes and fixed u64 increment/decrement rules are committed into the lock arguments; every other data byte is preserved. Fees reduce capacity above the protected floor, so no additional budget field is required in app data. It rejects unselected actions even when the session signature is valid.

The signature commits the raw transaction hash, action identifier, and every witness. The signature itself is removed from witness zero during digest construction; the operation and type-script witness fields remain committed. This is separate from the legacy counter digest.

Arguments: owner lock hash (32), compressed session key (33), manifest hash (32), app type-script hash or zero (32), maximum action fee (8 LE), protected capacity (8 LE), rule count (1), then 45 bytes per selected rule: action hash (32), kind (1: increment=0/decrement=1), field offset (4 LE), delta (8 LE). At most 16 rules. Session witness: mode `01`, action hash (32), compact signature (64). Owner witness: `00`, with a separate input under the committed owner lock.

Owner-authorized creation, migration, manual actions, and recovery are constructed and independently reviewed by the SDK. App type scripts execute normally and can reject ownership migration or recovery. Local expiry is not on-chain expiry. Build both binaries with `npm run contracts:build`; run VM tests with `npm run contracts:test`. The new lock is verified on a real local node; no public testnet deployment is configured by default. See [CELL_DELEGATION.md](../CELL_DELEGATION.md).

## Legacy counter session lock v1

This is a narrow, deployed-capable CKB policy prototype. Session transactions have exactly one input and one output. They can only advance a counter by one, preserve the session lock, debit their exact transaction fee from the remaining budget, and keep capacity above the owner-approved floor. They cannot transfer tokens, create extra outputs, change the owner, or replenish the budget.

The owner wallet approves the session by funding a cell whose immutable lock arguments contain the session key and fee limits. This version combines session state, budget, and app state in one cell. There is no separate authority cell or policy-module system yet.

## Build and verify

Requires Rust 1.95.0, the `riscv64imac-unknown-none-elf` target, LLVM clang and llvm-objcopy. The pinned toolchain and CKB-specific atomic lowering are configured here.

```sh
npm run contracts:build
npm run contracts:test
```

Tests execute the compiled RISC-V binary using ckb-testtool, including real secp256k1 signatures. A valid move uses approximately 4.2 million VM cycles. The stripped binary is about 93 KB and therefore occupies approximately 94,000 CKB in a code cell. This footprint is a prototype tradeoff of pure-Rust signature verification; a reusable deployed authentication library can reduce it later. The code deployment is shared across sessions.

## Binary format

Lock hash type: `data2`. Code hash: CKB Blake2b hash of the exact deployed binary.

| Lock args offset | Length | Field |
|---|---:|---|
| 0 | 32 | Owner lock script hash |
| 32 | 33 | Compressed secp256k1 session public key |
| 65 | 8 | Maximum fee per move, u64 LE shannons |
| 73 | 8 | Minimum preserved capacity, u64 LE shannons |

Cell data is exactly 16 bytes: remaining fee budget (u64 LE), then position (u64 LE).

The session witness lock is `0x01 || compact_ecdsa_signature`, 65 bytes total. The session key signs the raw transaction hash directly. This is deliberately a different scheme from the standard CKB wallet sighash. It is valid here because the policy has no witness-dependent effects, no type scripts, and no additional inputs. Do not generalize this signing scheme to other transaction shapes without redesigning the digest.

Owner recovery uses witness lock `0x00` and an additional input whose lock hash matches the owner hash. CKB independently executes that input's wallet lock, so a wallet signature is still required. Recovery consumes the session cell and sends its preserved capacity to the owner. Once confirmed, there is no live session cell left to spend. A previously confirmed action is not undone.

| Exit code | Meaning |
|---|---|
| 5 | Invalid encoding or syscall failure |
| 6 | Missing owner authorization, invalid mode, or invalid session signature |
| 7 | Forbidden input/output shape, type, or lock change |
| 8 | Counter did not advance by exactly one |
| 9 | Fee, capacity floor, or cumulative budget violation |

## Current boundaries

- Budget and move restrictions are enforced by the lock in CKB-VM.
- Expiration is enforced locally by Pilot and the adapter, **not on-chain**. Someone holding the raw session key can act until revocation or budget exhaustion. Do not describe these sessions as cryptographically time-limited.
- Revocation consumes the same cell used by moves, so concurrent actions and revocation compete for it. Wait for confirmed revocation before claiming the session is revoked.
- One live cell means sequential settlement. The optimistic app can queue moves while the adapter waits for chain confirmation.
- The prototype does not provide isolated key custody, arbitrary app permissions, multiple-tab coordination, or fee sponsorship in the original v1 policies. Separate sponsored variants are described below.
- The CLI deploys the code cell under its test owner. Keep that code cell live while any sessions reference it. Owner recovery deliberately avoids consuming cells with data, including the code cell.
- Tests are functional validation, not a security audit. This implementation explicitly rejects mainnet clients.

## Sponsored policies

Build produces `pilot-sponsored-session-lock` and `pilot-sponsored-delegation-lock` alongside the original binaries. They have distinct SDK-pinned code hashes and require new code-cell deployments. Session mode has exactly two inputs and outputs: app at index 0, pool at index 1. Both preserve app capacity and enforce unchanged ordinary pool lock/data/type and positive pool loss no greater than the action cap.

Sponsored counter args are the original 81 bytes plus pool lock hash (32). Its data still decrements the virtual budget by the action cap; the cap is an allowance, not user fee capacity. Sponsored delegation args are the original rule table plus pool lock hash (32). Its digest domain is `owl-pilot-delegation-sponsored-v1`; pool witness 1 lock is normalized to empty while type witnesses stay signed. Cumulative delegation allowance is local/service enforced, not on-chain. Owner mode still requires an input under the pinned signature-required owner lock.

VM regression tests cover pool-only fees, user capacity preservation, redirected pool change, excess fees, unauthorized keys/transitions, added outputs, pool data changes, and pool co-signature/type-witness binding. The public sponsored code cells are not deployed by the test suite. See [PAYMASTER.md](../PAYMASTER.md).

## Persistent account lock v1

`account-lock` is a separate general-purpose owner-recoverable account, not a bounded counter grant. Args are owner lock hash (32), compressed account public key (33), pinned ordinary pool lock hash (32), and maximum network fee (u64 LE). Hash type is `data2`; the SDK pins the compiled code hash in `src/ckb/account-code.ts`.

Witness mode `01` plus compact account signature (64) authorizes arbitrary account input/output shapes, subject to app scripts. The pool input and change must be last, ordinary and unique; their difference must equal the complete transaction fee within the cap. This enforces zero network fee from user inputs. There is no on-chain manifest allowlist, cumulative spending cap or expiry. The account key can spend all account funds when eligible sponsorship is available.

The signing digest is CKB-personalized Blake2b over `owl-pilot-account-v1`, raw transaction hash, then each length-prefixed witness. Normalize only the first account-group witness lock to `01` and the last pool witness lock to empty bytes; retain type fields and extra witnesses. Other parties must finalize their witnesses before Pilot signs. A second independent Pilot account group is not supported by the SDK.

Witness mode `00` requires an input whose full lock hash matches the owner. That input's lock enforces owner consent. Owner recovery works without the Pilot key or pool, but type scripts still run. The SDK only accepts supported signature-required owner locks. Recovery must consume each cell to revoke authority over it; there is no account-wide revocation bit.

The SDK can construct independent ordinary-CKB recovery from a public descriptor. Deploy separately with `npm run paymaster:deploy -- account` after funding the deployer for the actual compiled code-cell size plus fees. This command is available but has not been run for the account lock.
# Passkey wallet contracts

`pilot-passkey-lock` and `pilot-wallet-session-lock` are separate additions to the existing policies. The former verifies ES256 WebAuthn transaction assertions with exact RP/origin/challenge and mandatory presence/verification. The latter pins a built-in TYPE_ID authority and enforces immutable session policies, sequence, cumulative positive net CKB spending and zero user network fee. Its owner branch requires the pinned owner input; the owner lock validates the passkey signature. Replacing/closing the authority revokes old session access.

See [PILOT_WALLET.md](../PILOT_WALLET.md) for argument/state formats, policy semantics and limitations. Names are not entrypoint parsers; token quantities need explicit compatible policies/builders. Expiry is not an on-chain upper timestamp bound. Both new deployment records are unset. `npm run paymaster:deploy -- wallet` is the explicit two-contract deployment target; `both` remains the existing sponsored pair.

### Embedded passkey owner revision

`pilot-passkey-lock` now verifies embedded WebAuthn assertions as well as top-level assertions. Cross-origin assertions need a signed secure `topOrigin`; the trusted wallet additionally checks that it matches its actual parent app. RP hash, wallet-origin hash, user verification, exact challenge and transaction/witness binding remain mandatory. The revised binary has a new SDK-pinned hash and is deployed on testnet in transaction `0x771edc9c5daf2f2e4c40eac48e3fc909f943d9541d59c6863454ede0f015f8d3` (output 0); the existing session deployment is unchanged. The old owner hash is retained as `PILOT_LEGACY_PASSKEY_CODE_HASH` so descriptors preserve old addresses, but its testnet code cell has been consumed to reclaim capacity. `passkeyLegacy` is unset and the historical record is archived as `retiredPasskeyLegacy`; recovery through the consumed dependency is unavailable. VM tests cover valid embedded assertions, missing/insecure/contradictory context and signature-invalidating top-origin tampering.
