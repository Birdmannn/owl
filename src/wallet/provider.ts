import { ccc } from "@ckb-ccc/core";
import { canonicalWalletOrigin } from "./passkey.js";
import {
  validatePilotPolicyCatalog,
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
  private frame?: HTMLIFrameElement;
  private host?: HTMLDivElement;
  private dialog?: HTMLDialogElement;
  private channel = "";
  private pending = new Map<
    string,
    {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timer?: ReturnType<typeof setTimeout>;
      method: string;
    }
  >();
  private ready?: () => void;
  private cancelReady?: () => void;
  private connection?: PilotWalletConnection;
  readonly origin: string;
  private disposed = false;
  private approvalRequest?: { id: string; opened: boolean };
  constructor(
    readonly options: { url: string; timeoutMs?: number; styleNonce?: string },
  ) {
    const url = new URL(options.url);
    this.origin = canonicalWalletOrigin(url.origin);
    if (url.username || url.password || url.hash)
      throw new Error("Invalid wallet URL");
    // Require a direct top-level app. Nested ancestors complicate WebAuthn topOrigin binding.
    if (window.self !== window.top)
      throw new Error("Open the integrating app as a top-level page");
    window.addEventListener("message", this.receive);
  }
  private receive = (event: MessageEvent) => {
    if (
      event.source !== this.frame?.contentWindow ||
      event.origin !== this.origin ||
      !isPilotWalletEnvelope(event.data, this.channel)
    )
      return;
    const v = event.data;
    if (v.method === "resize") {
      const height = (v.params as { height?: unknown } | undefined)?.height;
      if (typeof height === "number" && Number.isSafeInteger(height) && height >= 0 && this.dialog)
        this.dialog.style.setProperty("--pilot-height", `${height + 50}px`);
      return;
    }
    if (v.method === "approval") {
      const pending = this.pending.get(v.id);
      if (!pending || !["send", "signMessage"].includes(pending.method)) return;
      clearTimeout(pending.timer);
      pending.timer = undefined;
      this.approvalRequest ??= { id: v.id, opened: !this.dialog?.open };
      this.open();
      return;
    }
    if (v.method === "progress") {
      const pending = this.pending.get(v.id);
      if (!pending) return;
      const phase = (v.params as { phase?: unknown } | undefined)?.phase;
      if (phase === "waiting-for-user") {
        clearTimeout(pending.timer);
        pending.timer = undefined;
      } else if (phase === "processing") {
        this.armResponseTimer(v.id);
      }
      return;
    }
    if (v.method === "ready") {
      this.ready?.();
      return;
    }
    const p = this.pending.get(v.id);
    if (!p) return;
    if (this.approvalRequest?.id === v.id) {
      const { opened } = this.approvalRequest;
      this.approvalRequest = undefined;
      if (opened) this.hide();
    }
    this.pending.delete(v.id);
    clearTimeout(p.timer);
    if (v.error) p.reject(new Error(v.error));
    else p.resolve(v.result);
  };
  private mount(url: URL) {
    this.host = document.createElement("div");
    this.host.setAttribute("data-pilot-wallet", "");
    const shadow = this.host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    if (this.options.styleNonce) style.nonce = this.options.styleNonce;
    style.textContent = `
      :host{color-scheme:dark}
      dialog{box-sizing:border-box;width:min(510px,calc(100vw - 24px));height:var(--pilot-height,auto);min-height:0;max-width:none;max-height:70vh;padding:0;border:1px solid #496040;border-radius:16px;background:#192e23;color:#ecf0e5;overflow:hidden;box-shadow:0 24px 100px #0008}
      dialog[open]{display:flex;flex-direction:column}
      dialog::backdrop{background:#040d09b8;backdrop-filter:blur(5px)}
      header{flex:0 0 48px;height:48px;box-sizing:border-box;display:flex;align-items:center;justify-content:space-between;padding:0 16px;font:12px system-ui,sans-serif}
      span{color:#b5c5ac;font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin:0 12px}
      button{border:1px solid #53694d;background:#192e23;color:#ecf0e5;border-radius:6px;font:12px system-ui,sans-serif;padding:5px 10px;cursor:pointer}
      button:focus-visible{outline:2px solid #c7f881;outline-offset:3px}
      iframe{display:block;flex:1 1 auto;min-height:0;border:0;width:100%;height:150px;background:#192e23}
      @media(prefers-reduced-motion:reduce){dialog::backdrop{backdrop-filter:none}}
    `;
    this.dialog = document.createElement("dialog");
    this.dialog.setAttribute("aria-label", "Pilot wallet");
    const header = document.createElement("header");
    const origin = document.createElement("span");
    origin.textContent = this.origin;
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "Close";
    close.setAttribute("aria-label", "Close Pilot wallet");
    close.onclick = () => this.hide();
    header.append(origin, close);
    this.frame = document.createElement("iframe");
    this.frame.title = "Pilot wallet account and permissions";
    this.frame.allow = `publickey-credentials-create ${this.origin}; publickey-credentials-get ${this.origin}`;
    this.frame.referrerPolicy = "origin";
    this.frame.src = url.toString();
    this.dialog.addEventListener("cancel", (event) => { event.preventDefault(); this.hide(); });
    this.dialog.append(header, this.frame);
    shadow.append(style, this.dialog);
    document.body.append(this.host);
    this.open();
  }
  /** Reopen the connected wallet for accounts, permissions, balances, logs and recovery. */
  open() {
    if (this.disposed || !this.dialog || !this.host?.isConnected)
      throw new Error("Connect Pilot before opening the wallet");
    if (!this.dialog.open) this.dialog.showModal();
  }
  /** Hide the presentation only. Keep the isolated signer alive; this does not disconnect. */
  hide() {
    if (this.approvalRequest) this.frame?.contentWindow?.postMessage({
      protocol: PILOT_WALLET_PROTOCOL, channel: this.channel,
      id: this.approvalRequest.id, method: "cancelApproval",
    } satisfies PilotWalletEnvelope, this.origin);
    this.dialog?.close();
  }
  async connect(request: PilotWalletConnect): Promise<PilotWalletConnection> {
    if (this.disposed) throw new Error("Provider disposed");
    validatePilotPolicyCatalog(request.policies);
    if (
      !request.name ||
      request.name.length > 100 ||
      BigInt(request.budget) <= 0n
    )
      throw new Error("Choose an app name and positive spending budget");
    if (this.frame) {
      this.open();
      throw new Error(
        "Pilot is already open; finish or disconnect the existing connection before reconnecting",
      );
    }
    this.channel = crypto.randomUUID();
    const url = new URL(this.options.url);
    url.searchParams.set("appOrigin", location.origin);
    url.searchParams.set("channel", this.channel);
    url.searchParams.set("embed", "1");
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.ready = undefined;
        reject(
          new Error(
            "Pilot wallet could not load. Check wallet URL, frame-src and framing permissions.",
          ),
        );
      }, this.options.timeoutMs ?? 300_000);
      this.cancelReady = () => {
        clearTimeout(timer);
        reject(new Error("Provider disposed"));
      };
      this.ready = () => {
        clearTimeout(timer);
        this.ready = undefined;
        this.cancelReady = undefined;
        resolve();
      };
    });
    this.mount(url);
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
    this.hide();
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
    if (this.disposed || !this.frame?.contentWindow || !this.host?.isConnected)
      throw new Error("Connect Pilot first");
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      // Connection starts with account/permission UI, not transaction execution.
      if (method !== "connect") this.armResponseTimer(id);
      this.frame!.contentWindow!.postMessage(
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
  private armResponseTimer(id: string) {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.timer = setTimeout(() => {
      this.pending.delete(id);
      if (this.approvalRequest?.id === id) this.approvalRequest = undefined;
      const message = pending.method === "send"
        ? "Wallet transaction response unavailable; retry the same action request ID and reconcile before new spending"
        : pending.method === "signMessage"
          ? "Wallet message signing timed out while processing; check its status and retry with the same nonce"
          : pending.method === "connect"
            ? "Wallet connection processing timed out; reopen Pilot and reconcile any saved funding transaction before trying again"
            : "Wallet request timed out while processing; check the connection and reconcile any saved transactions before trying again";
      pending.reject(new Error(message));
    }, this.options.timeoutMs ?? 300_000);
  }
  async disconnect() {
    // Do not remove the signer or clear the account if settlement fails.
    if (this.connection) await this.request("disconnect");
    else if (this.pending.size || this.ready) {
      this.open();
      throw new Error(
        "Finish the pending wallet operation before disconnecting",
      );
    }
    this.unmount();
  }
  private unmount() {
    this.hide();
    this.host?.remove();
    this.host = undefined;
    this.dialog = undefined;
    this.frame = undefined;
    this.connection = undefined;
  }
  get connected() {
    return (
      !!this.connection &&
      this.connection.expiresAt > Date.now() &&
      !!this.host?.isConnected
    );
  }
  get account() {
    return this.connection;
  }
  dispose() {
    this.disposed = true;
    window.removeEventListener("message", this.receive);
    this.cancelReady?.();
    this.cancelReady = undefined;
    this.ready = undefined;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("Provider disposed"));
    }
    this.pending.clear();
    // Local teardown only. Saved signed transactions still require reconciliation.
    this.unmount();
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
