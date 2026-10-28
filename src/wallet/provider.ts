import { PilotError, formatPilotError } from "../errors.js";
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
  /** General account uses wallet-enforced action templates; requires its separate deployment. */
  accountMode?: "general";
}
export interface PilotWalletConnection {
  address: string;
  ownerAddress: string;
  account: PilotWalletDescriptor;
  appOrigin: string;
  expiresAt: number;
}
/** Public account selection only: no spending authority exists until approval. */
export type PilotWalletSelectedAccount = Omit<PilotWalletConnection, "expiresAt">;
export type PilotWalletPolicyBuilder = (account: PilotWalletSelectedAccount) =>
  readonly PilotCellPolicy[] | Promise<readonly PilotCellPolicy[]>;
export type PilotWalletDynamicConnect = Omit<PilotWalletConnect, "policies"> & {
  buildPolicies: PilotWalletPolicyBuilder;
};
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
  private policyBuilder?: PilotWalletPolicyBuilder;
  private generalAccount = false;
  constructor(
    readonly options: { url: string; timeoutMs?: number; styleNonce?: string },
  ) {
    const url = new URL(options.url);
    this.origin = canonicalWalletOrigin(url.origin);
    if (url.username || url.password || url.hash)
      throw new PilotError("Invalid wallet URL");
    // Require a direct top-level app. Nested ancestors complicate WebAuthn topOrigin binding.
    if (window.self !== window.top)
      throw new PilotError("Open the integrating app as a top-level page");
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
    if (v.method === "accountSelected") {
      const pending = this.pending.get(v.id);
      if (pending?.method !== "connect" || !this.policyBuilder) return;
      const selection = v.params as { selectionId: string; account: PilotWalletSelectedAccount };
      if (!selection || typeof selection.selectionId !== "string" ||
          selection.account?.appOrigin !== location.origin) return;
      const builder = this.policyBuilder;
      const channel = this.channel;
      void Promise.resolve().then(() => builder(structuredClone(selection.account))).then(policies => {
        validatePilotPolicyCatalog(policies);
        if (!this.generalAccount && policies.some(p => p.direction === "template")) throw new PilotError("Action templates require accountMode: general and its deployment");
        return { policies };
      }).catch(error => ({ error: formatPilotError(error) })).then(result => {
        if (this.disposed || channel !== this.channel || !this.pending.has(v.id)) return;
        this.frame?.contentWindow?.postMessage({
          protocol: PILOT_WALLET_PROTOCOL, channel, id: v.id, method: "policiesReady",
          params: { selectionId: selection.selectionId, ...result },
        } satisfies PilotWalletEnvelope, this.origin);
      });
      return;
    }
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
    if (!p || v.method !== p.method) return;
    if (this.approvalRequest?.id === v.id) {
      const { opened } = this.approvalRequest;
      this.approvalRequest = undefined;
      if (opened) this.hide();
    }
    this.pending.delete(v.id);
    clearTimeout(p.timer);
    if (v.error) p.reject(new PilotError(v.error));
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
      header{flex:0 0 48px;height:48px;box-sizing:border-box;display:flex;align-items:center;justify-content:space-between;padding:0 28px;font:12px system-ui,sans-serif}
      span{color:#b5c5ac;font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-right:12px}
      button{box-sizing:border-box;display:grid;place-items:center;flex:0 0 26px;width:26px;height:26px;border:0;background:transparent;color:#ecf0e5;border-radius:6px;padding:0;cursor:pointer}
      button:focus-visible{outline:2px solid #c7f881;outline-offset:3px}
      @media(max-width:396px){header{padding:0 20px}}
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
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("width", "18");
    icon.setAttribute("height", "18");
    icon.setAttribute("aria-hidden", "true");
    const cross = document.createElementNS("http://www.w3.org/2000/svg", "path");
    cross.setAttribute("d", "M6 6l12 12M18 6L6 18");
    cross.setAttribute("fill", "none");
    cross.setAttribute("stroke", "#c7f881");
    cross.setAttribute("stroke-width", "1.8");
    cross.setAttribute("stroke-linecap", "round");
    icon.append(cross);
    close.append(icon);
    close.setAttribute("aria-label", "Close Pilot wallet");
    close.onclick = () => this.hide();
    header.append(origin, close);
    this.frame = document.createElement("iframe");
    this.frame.title = "Pilot wallet account and permissions";
    this.frame.allow = `publickey-credentials-create ${this.origin}; publickey-credentials-get ${this.origin}; clipboard-write ${this.origin}`;
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
      throw new PilotError("Connect Pilot before opening the wallet");
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
  async connect(request: PilotWalletConnect | PilotWalletDynamicConnect): Promise<PilotWalletConnection> {
    try {
      if (this.disposed) throw new PilotError("Provider disposed");
      const dynamic = "buildPolicies" in request;
      if (dynamic) {
        if (typeof request.buildPolicies !== "function") throw new PilotError("Provide a policy builder");
      } else validatePilotPolicyCatalog(request.policies);
      if (
        !request.name ||
        request.name.length > 100 ||
        BigInt(request.budget) <= 0n
      )
        throw new PilotError("Choose an app name and positive spending budget");
      if (this.frame) {
        this.open();
        throw new PilotError(
          "Pilot is already open; finish or disconnect the existing connection before reconnecting",
        );
      }
      if (request.accountMode !== undefined && request.accountMode !== "general") throw new PilotError("Unknown account mode");
      if (!dynamic && !request.accountMode && request.policies.some(p => p.direction === "template"))
        throw new PilotError("Action templates require accountMode: general and its deployment");
      this.generalAccount = request.accountMode === "general";
      this.channel = crypto.randomUUID();
      this.policyBuilder = dynamic ? request.buildPolicies : undefined;
      const url = new URL(this.options.url);
      url.searchParams.set("appOrigin", location.origin);
      url.searchParams.set("channel", this.channel);
      url.searchParams.set("embed", "1");
      url.searchParams.set("progress", "1");
      if (dynamic) url.searchParams.set("accountPolicies", "1");
      if (request.accountMode) url.searchParams.set("accountMode", request.accountMode);
      const ready = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.ready = undefined;
          reject(
            new PilotError(
              "Pilot wallet could not load. Check wallet URL, frame-src and framing permissions.",
            ),
          );
        }, this.options.timeoutMs ?? 300_000);
        this.cancelReady = () => {
          clearTimeout(timer);
          reject(new PilotError("Provider disposed"));
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
        dynamic ? { name: request.name, budget: request.budget, durationMs: request.durationMs, accountMode: request.accountMode,
          policies: [], dynamicPolicies: true } : request,
      )) as PilotWalletConnection;
      if (
        !connection ||
        typeof connection !== "object" ||
        connection.appOrigin !== location.origin ||
        connection.expiresAt <= Date.now()
      )
        throw new PilotError("Wallet returned an invalid session");
      this.connection = connection;
      this.policyBuilder = undefined;
      this.hide();
      return connection;
    } catch (error) {
      throw error instanceof PilotError ? error : new PilotError(formatPilotError(error));
    }
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
      throw new PilotError("Connect Pilot first");
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
      pending.reject(new PilotError(message));
    }, this.options.timeoutMs ?? 300_000);
  }
  async disconnect() {
    // Do not remove the signer or clear the account if settlement fails.
    if (this.connection) await this.request("disconnect");
    else if (this.pending.size || this.ready) {
      this.open();
      throw new PilotError(
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
    this.policyBuilder = undefined;
    window.removeEventListener("message", this.receive);
    this.cancelReady?.();
    this.cancelReady = undefined;
    this.ready = undefined;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new PilotError("Provider disposed"));
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
      throw new PilotError("Call provider.connect with app policies first");
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
    if (!a) throw new PilotError("Pilot is disconnected");
    return [await ccc.Address.fromString(a.address, this.client)];
  }
  async signMessageRaw(): Promise<string> {
    throw new PilotError(
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
    throw new PilotError(
      "Pilot signatures remain inside the wallet; use sendTransaction",
    );
  }
  async sendTransaction(
    value: ccc.TransactionLike,
    requestId?: string,
  ): Promise<ccc.Hex> {
    if (!requestId)
      throw new PilotError("Provide a stable request ID for wallet submission");
    return (await this.provider.request("send", {
      bytes: ccc.hexFrom(ccc.Transaction.from(value).toBytes()),
      requestId,
    })) as ccc.Hex;
  }
}
