import { PilotWalletProvider } from "../../../src/wallet/provider";
import { ccc } from "@ckb-ccc/core";
const provider = new PilotWalletProvider({
  url: new URLSearchParams(location.search).get("wallet") ?? "http://localhost:5176",
  timeoutMs: 300_000,
});
Object.assign(window, { pilotTestProvider: provider });
document.querySelector("button")!.onclick = () =>
  void provider
    .connect({
      name: "External test app",
      budget: ccc.fixedPointFrom(10).toString(),
      policies: [
        {
          name: "Like posts",
          direction: "message",
          lockHash: ccc.hashCkb(ccc.bytesFrom("social.like", "utf8")),
          typeHash: ("0x" + "00".repeat(32)) as ccc.Hex,
          dataHash: ("0x" + "00".repeat(32)) as ccc.Hex,
          maxCapacity: "1",
        },
      ],
    })
    .then(
      () => {
        document.querySelector("p")!.textContent = "Connected";
      },
      (e) => {
        document.querySelector("p")!.textContent = e.message;
      },
    );
