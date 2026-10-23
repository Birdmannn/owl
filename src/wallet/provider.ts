import { ccc } from "@ckb-ccc/core";
import { canonicalWalletOrigin } from "./passkey.js";
import {
  validatePilotPolicies,
  type PilotCellPolicy,
  type PilotWalletDescriptor,
} from "./session.js";
export const PILOT_WALLET_PROTOCOL = "owl-pilot-wallet-v1";
export interface PilotWalletConnect {
  name: string;
  policies: readonly PilotCellPolicy[];
  budget: string;
  durationMs?: number;
}
export interface PilotWalletConnection {
  address: string;
  ownerAddress: string;
  account: PilotWalletDescriptor;
  appOrigin: string;
  expiresAt: number;
}
export interface PilotWalletEnvelope {
  protocol: typeof PILOT_WALLET_PROTOCOL;
  channel: string;
  id: string;
  method: string;
  params?: unknown;
  result?: unknown;
  error?: string;
}
export function isPilotWalletEnvelope(
  value: unknown,
  channel: string,
): value is PilotWalletEnvelope {
  if (!value || typeof value !== "object") return false;
  const v = value as PilotWalletEnvelope;
  return (
    v.protocol === PILOT_WALLET_PROTOCOL &&
    v.channel === channel &&
    typeof v.id === "string" &&
    v.id.length <= 128 &&
    typeof v.method === "string"
  );
}
/** Public transport: only public descriptors, effects and receipts cross this boundary. */
export class PilotWalletProvider {
  private popup: Window | null = null;
  private channel = "";
  private pending = new Map<
    string,
    {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private ready?: () => void;
  private connection?: PilotWalletConnection;
  readonly origin: string;
  private disposed = false;
  constructor(readonly options: { url: string; timeoutMs?: number }) {
    const url = new URL(options.url);
    this.origin = canonicalWalletOrigin(url.origin);
    if (url.username || url.password || url.hash)
      throw new Error("Invalid wallet URL");
    window.addEventListener("message", this.receive);
  }
  private receive = (event: MessageEvent) => {
    if (
      event.source !== this.popup ||
      event.origin !== this.origin ||
      !isPilotWalletEnvelope(event.data, this.channel)
    )
      return;
    const v = event.data;
    if (v.method === "ready") {
      this.ready?.();
      return;
    }
    const p = this.pending.get(v.id);
    if (!p) return;
    this.pending.delete(v.id);
    clearTimeout(p.timer);
    if (v.error) p.reject(new Error(v.error));
    else p.resolve(v.result);
  };
  async connect(request: PilotWalletConnect): Promise<PilotWalletConnection> {
    if (this.disposed) throw new Error("Provider disposed");
    validatePilotPolicies(request.policies);
    if (
      !request.name ||
      request.name.length > 100 ||
      BigInt(request.budget) <= 0n
    )
      throw new Error("Choose an app name and positive spending budget");
    if (this.popup && !this.popup.closed)
      throw new Error(
        "Disconnect the existing wallet connection before reconnecting",
      );
    this.channel = crypto.randomUUID();
    const url = new URL(this.options.url);
    url.searchParams.set("appOrigin", location.origin);
    url.searchParams.set("channel", this.channel);
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.ready = undefined;
        reject(new Error("Pilot wallet did not open"));
      }, this.options.timeoutMs ?? 300_000);
      this.ready = () => {
        clearTimeout(timer);
        this.ready = undefined;
        resolve();
      };
    });
    this.popup = window.open(
      url.toString(),
      "pilot-wallet-" + this.channel,
      "popup,width=480,height=780",
    );
    if (!this.popup) {
      this.ready?.();
      throw new Error("Allow the Pilot wallet popup");
    }
    await ready;
    const connection = (await this.request(
      "connect",
      request,
    )) as PilotWalletConnection;
    if (
      connection.appOrigin !== location.origin ||
      connection.expiresAt <= Date.now()
    )
      throw new Error("Wallet returned an invalid session");
    this.connection = connection;
    return connection;
  }
  async request(
    method:
      | "connect"
      | "prepare"
      | "send"
      | "logs"
      | "resume"
      | "disconnect"
      | "signMessage",
    params?: unknown,
  ): Promise<unknown> {
    if (this.disposed || !this.popup || this.popup.closed)
      throw new Error("Open the Pilot wallet first");
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            "Wallet response unavailable; retry the same request ID and reconcile before new spending",
          ),
        );
      }, this.options.timeoutMs ?? 300_000);
      this.pending.set(id, { resolve, reject, timer });
      this.popup!.postMessage(
        {
          protocol: PILOT_WALLET_PROTOCOL,
          channel: this.channel,
          id,
          method,
          params,
        } satisfies PilotWalletEnvelope,
        this.origin,
      );
    });
  }
  async disconnect() {
    if (this.popup && !this.popup.closed) await this.request("disconnect");
    this.popup?.close();
    this.popup = null;
    this.connection = undefined;
  }
  get connected() {
    return (
      !!this.connection &&
      this.connection.expiresAt > Date.now() &&
      !!this.popup &&
      !this.popup.closed
    );
  }
  get account() {
    return this.connection;
  }
  dispose() {
    this.disposed = true;
    window.removeEventListener("message", this.receive);
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("Provider disposed"));
    }
    this.pending.clear();
    this.popup?.close();
    this.connection = undefined;
  }
}
/** CCC-compatible app-side signer. The app never receives private keys. */
export class PilotHostedSigner extends ccc.Signer {
  constructor(
    client: ccc.Client,
    readonly provider: PilotWalletProvider,
  ) {
    super(client);
  }
  get type() {
    return ccc.SignerType.CKB;
  }
  get signType() {
    return ccc.SignerSignType.Unknown;
  }
  async connect() {
    if (!this.provider.connected)
      throw new Error("Call provider.connect with app policies first");
  }
  async disconnect() {
    await this.provider.disconnect();
  }
  async isConnected() {
    return this.provider.connected;
  }
  async getIdentity() {
    return (await this.getRecommendedAddressObj()).script.hash();
  }
  async getInternalAddress() {
    return this.getRecommendedAddress();
  }
  async getAddressObjs() {
    const a = this.provider.account;
    if (!a) throw new Error("Pilot is disconnected");
    return [await ccc.Address.fromString(a.address, this.client)];
  }
  async signMessageRaw(): Promise<string> {
    throw new Error(
      "Use provider.request(signMessage) for a scoped Pilot authorization",
    );
  }
  async prepareTransaction(value: ccc.TransactionLike) {
    const bytes = (await this.provider.request("prepare", {
      bytes: ccc.hexFrom(ccc.Transaction.from(value).toBytes()),
    })) as ccc.Hex;
    return ccc.Transaction.fromBytes(bytes);
  }
  async signOnlyTransaction(): Promise<ccc.Transaction> {
    throw new Error(
      "Pilot signatures remain inside the wallet; use sendTransaction",
    );
  }
  async sendTransaction(
    value: ccc.TransactionLike,
    requestId?: string,
  ): Promise<ccc.Hex> {
    if (!requestId)
      throw new Error("Provide a stable request ID for wallet submission");
    return (await this.provider.request("send", {
      bytes: ccc.hexFrom(ccc.Transaction.from(value).toBytes()),
      requestId,
    })) as ccc.Hex;
  }
}
