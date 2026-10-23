import { useEffect, useRef, useState } from "react";
import { ccc } from "@ckb-ccc/core";
import {
  PilotWalletProvider,
  type PilotWalletConnection,
} from "../../../src/wallet/provider";
import {
  verifyPilotScopedMessage,
  type PilotWalletJournal,
  type PilotScopedMessage,
} from "../../../src/wallet/session";
const client = new ccc.ClientPublicTestnet();
const zero = ("0x" + "00".repeat(32)) as ccc.Hex;
export function HostedWallet() {
  const url =
    (import.meta.env.VITE_PILOT_WALLET_URL as string | undefined) ||
    (import.meta.env.DEV ? "http://localhost:5176" : "");
  const provider = useRef<PilotWalletProvider | undefined>(undefined);
  const [connection, setConnection] = useState<PilotWalletConnection>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [logs, setLogs] = useState<PilotWalletJournal>();
  const [result, setResult] = useState("");
  useEffect(() => () => provider.current?.dispose(), []);
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function connect() {
    provider.current?.dispose();
    const value = new PilotWalletProvider({ url });
    provider.current = value;
    try {
      const next = await value.connect({
        name: "Pilot passkey demo",
        budget: ccc.fixedPointFrom(10).toString(),
        policies: [
          {
            name: "Sign scoped demo likes",
            direction: "message",
            lockHash: ccc.hashCkb(ccc.bytesFrom("demo.like", "utf8")),
            typeHash: zero,
            dataHash: zero,
            maxCapacity: "1",
          },
        ],
      });
      setConnection(next);
      setLogs((await value.request("logs")) as PilotWalletJournal);
    } catch (e) {
      value.dispose();
      provider.current = undefined;
      throw e;
    }
  }
  return (
    <section className="username-transfers" aria-label="Pilot passkey wallet">
      <div className="panel-top">
        <span>PILOT PASSKEY WALLET</span>
        <span className="tag">ISOLATED ORIGIN · PREVIEW</span>
      </div>
      <h2>Connect directly to Pilot.</h2>
      <p>
        Create a Pilot passkey without JoyID or another wallet. Approve the app
        in a separate wallet window; owner and session private keys stay outside
        this app.
      </p>
      <p>
        The two new wallet contracts must be deployed before session funding
        works. This preview does not replace the existing flight demo’s wallet
        flow.
      </p>
      {!url && (
        <p role="status">
          A hosted Pilot wallet URL has not been configured for this demo.
        </p>
      )}
      <button
        className="primary"
        disabled={busy || !url || !!connection}
        onClick={() => void run(connect)}
      >
        Connect Pilot passkey wallet
      </button>
      {connection && (
        <>
          <p>
            Account: <code>{connection.address}</code>
          </p>
          <p>
            Passkey owner: <code>{connection.ownerAddress}</code>
          </p>
          <button
            className="secondary"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const nonce = crypto.randomUUID();
                const proof = (await provider.current!.request("signMessage", {
                  scope: "demo.like",
                  message: "like:pilot-demo",
                  nonce,
                })) as PilotScopedMessage;
                const journal = (await provider.current!.request(
                  "logs",
                )) as PilotWalletJournal;
                if (
                  !journal.state ||
                  !(await verifyPilotScopedMessage(
                    client,
                    connection.account,
                    journal.state,
                    proof,
                    { appOrigin: location.origin, scope: "demo.like", nonce },
                  ))
                )
                  throw new Error("Scoped message verification failed");
                setLogs(journal);
                setResult(
                  "Like signed and verified against the live Pilot session. No owner passkey prompt.",
                );
              })
            }
          >
            Sign a demo like automatically
          </button>
          <button
            className="secondary"
            disabled={busy}
            onClick={() =>
              void run(async () =>
                setLogs(
                  (await provider.current!.request(
                    "logs",
                  )) as PilotWalletJournal,
                ),
              )
            }
          >
            Refresh account logs
          </button>
          <button
            className="secondary"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await provider.current!.disconnect();
                setConnection(undefined);
                setResult(
                  "Local access stopped. Use the wallet’s revoke control for on-chain revocation.",
                );
              })
            }
          >
            Disconnect app
          </button>
        </>
      )}
      {busy && (
        <p role="status">Complete the request in the Pilot wallet window.</p>
      )}
      {result && <p role="status">{result}</p>}
      {error && <p role="alert">{error}</p>}
      <details>
        <summary>Passkey account queue and logs</summary>
        <pre>
          {logs
            ? JSON.stringify(logs, null, 2)
            : "Connect a funded account to inspect its receipts."}
        </pre>
      </details>
    </section>
  );
}
