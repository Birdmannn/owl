import type { ccc } from "@ckb-ccc/core";
// Updated from reproducible stripped binaries by the build verification step.
export const PILOT_PASSKEY_CODE_HASH: ccc.Hex =
  "0x2ba431b27a844a3664e24c548ecd175cea3ba005590f4f362bee5a94acac92e6";
export const PILOT_WALLET_SESSION_CODE_HASH: ccc.Hex =
  "0xdda8f7cfc319891c35aa68425674776f79c0e1c9c0f1c6adc253990fa4322695";
/** General account: transaction template semantics are enforced by wallet software. */
export const PILOT_WALLET_GENERAL_CODE_HASH: ccc.Hex =
  "0x37d1ff519ae19f7b16cd7ee9b4f726300cdcc6fece923bf8bee40466a15cef28";

/** Original top-level-only owner lock; retained for existing-account recovery. */
export const PILOT_LEGACY_PASSKEY_CODE_HASH: ccc.Hex =
  "0x1ed0479cc0f57f0f5bc340c3739a78802f5f66ad59cb647a6cedc78a62a3fdaa";
