import { type PilotWalletSelectedAccount, PilotWalletProvider } from "../../../src/wallet/provider";
import { ccc } from "@ckb-ccc/core";
import {pilotTemplatePolicy} from "../../../src/wallet/session";
const provider = new PilotWalletProvider({
  url: new URLSearchParams(location.search).get("wallet") ?? "http://localhost:5176",
  timeoutMs: 300_000,
});
Object.assign(window, { pilotTestProvider: provider });
const dynamic = new URLSearchParams(location.search).has("dynamic");
const buildPolicies = async (account: PilotWalletSelectedAccount) => {
  Object.assign(window, { pilotSelectedAccount: account });
  if ((window as unknown as { failPolicyBuilder?: boolean }).failPolicyBuilder) throw new Error("Policy builder unavailable");
  if ((window as any).holdPolicyBuilder) await new Promise<void>(resolve => Object.assign(window, { releasePolicyBuilder: resolve }));
  const address = await ccc.Address.fromString(account.address, new ccc.ClientPublicTestnet());
  return [{ name: "Account-specific output", direction: "output" as const,
    lockHash: address.script.hash(), typeHash: ("0x" + "00".repeat(32)) as ccc.Hex,
    dataHash: ("0x" + "00".repeat(32)) as ccc.Hex, maxCapacity: ccc.fixedPointFrom(100).toString() }];
};
const mixed = new URLSearchParams(location.search).has("mixed");
const mixedPrograms = [1, 2].map(n => ({codeHash: ccc.hexFrom(new Uint8Array(32).fill(n)), hashType: "data2" as const, args: {}}));
const mixedPolicy = pilotTemplatePolicy("Distribute rewards", {version: 1, id: "test.mixed", maxSpend: "0",
  inputs: [{role: "ticket", min: 1, max: 64, lock: {codeHash: ccc.hexFrom(new Uint8Array(32).fill(3)), hashType: "data2", args: {}}, type: null, data: {length: 20}}],
  outputs: [{role: "payout", min: 1, max: 64, lock: {anyOf: mixedPrograms}, type: null, data: {length: 0}}],
  forEach: [{inputRole: "ticket", outputRole: "payout", relations: [], anyOf: mixedPrograms.map((outputLock, n) => ({outputLock, relations: [{
    left: {source: "input" as const, role: "ticket", index: "each" as const, field: "data" as const, offset: 0, length: 20},
    right: {source: "output" as const, role: "payout", index: "each" as const, field: n ? "lock" as const : "lockArgs" as const, offset: 0, length: 20},
  }]}))}],
});
const catalogSize = Number(new URLSearchParams(location.search).get('catalog') ?? 1);
document.querySelector("button")!.onclick = () =>
  void provider
    .connect({
      name: "External test app",
      ...((mixed || new URLSearchParams(location.search).has("general")) ? {accountMode: "general" as const} : {}),
      budget: ccc.fixedPointFrom(10).toString(),
      ...(mixed ? {policies: [mixedPolicy]} : dynamic ? { buildPolicies } : { policies: Array.from({ length: catalogSize }, (_, i) => (
        {
          name: catalogSize === 1 ? "Like posts" : `Action ${i}`,
          direction: "message",
          lockHash: ccc.hashCkb(ccc.bytesFrom("social.like", "utf8")),
          typeHash: ("0x" + "00".repeat(32)) as ccc.Hex,
          dataHash: ("0x" + "00".repeat(32)) as ccc.Hex,
          maxCapacity: "1",
        }
      )) }),
    })
    .then(
      () => {
        document.querySelector("p")!.textContent = "Connected";
      },
      (e) => {
        document.querySelector("p")!.textContent = e.message;
      },
    );
