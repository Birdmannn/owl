# Pilot counter session lock v1

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
- The prototype does not provide isolated key custody, arbitrary app permissions, multiple-tab coordination, or fee sponsorship.
- The CLI deploys the code cell under its test owner. Keep that code cell live while any sessions reference it. Owner recovery deliberately avoids consuming cells with data, including the code cell.
- Tests are functional validation, not a security audit. This implementation explicitly rejects mainnet clients.
