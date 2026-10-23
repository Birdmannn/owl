import { ccc } from "@ckb-ccc/core";
import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  deploymentDep,
  verifyDeployment,
  type Deployment,
} from "../ckb/counter.js";
import { PILOT_PASSKEY_CODE_HASH } from "./code.js";

export interface PilotPasskey {
  credentialId: string;
  publicKey: ccc.Hex;
  rpId: string;
  origin: string;
  name: string;
}
export interface PilotAssertion {
  authenticatorData: ccc.Hex;
  clientDataJSON: ccc.Hex;
  signature: ccc.Hex;
}
/** Public metadata only; do not retain arbitrary fields from imported JSON. */
export function parsePilotPasskey(value: unknown): PilotPasskey {
  if (!value || typeof value !== "object")
    throw new Error("Invalid public passkey descriptor");
  const v = value as PilotPasskey;
  if (
    typeof v.credentialId !== "string" ||
    !/^[A-Za-z0-9_-]{1,2048}$/.test(v.credentialId) ||
    typeof v.name !== "string" ||
    !v.name.trim() ||
    v.name.length > 64 ||
    typeof v.publicKey !== "string" ||
    typeof v.origin !== "string" ||
    typeof v.rpId !== "string"
  )
    throw new Error("Invalid public passkey descriptor");
  const p = {
    credentialId: v.credentialId,
    publicKey: v.publicKey,
    rpId: v.rpId,
    origin: v.origin,
    name: v.name,
  };
  pilotPasskeyLock(p);
  return p;
}
export const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
export function fromBase64url(value: string): Uint8Array {
  return Uint8Array.from(
    atob(value.replaceAll("-", "+").replaceAll("_", "/")),
    (c) => c.charCodeAt(0),
  );
}
const u16 = (n: number) => new Uint8Array([n & 255, n >>> 8]);
export function walletU64(n: bigint): Uint8Array {
  if (n < 0n || n > 0xffffffffffffffffn) throw new Error("Amount outside u64");
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, n, true);
  return bytes;
}
export function canonicalWalletOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.origin !== value ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(url.hostname)
      ))
  )
    throw new Error(
      "Use an exact HTTPS origin (localhost is allowed for development)",
    );
  return value;
}
export function pilotPasskeyLock(passkey: PilotPasskey): ccc.Script {
  canonicalWalletOrigin(passkey.origin);
  const url = new URL(passkey.origin);
  if (
    !passkey.rpId ||
    !(
      url.hostname === passkey.rpId || url.hostname.endsWith("." + passkey.rpId)
    )
  )
    throw new Error("Passkey RP ID does not match wallet origin");
  const key = ccc.bytesFrom(passkey.publicKey);
  if (key.length !== 33) throw new Error("Use a compressed P-256 key");
  p256.Point.fromBytes(key);
  return ccc.Script.from({
    codeHash: PILOT_PASSKEY_CODE_HASH,
    hashType: "data2",
    args: ccc.hexFrom(
      ccc.bytesConcat(
        key,
        sha256(new TextEncoder().encode(passkey.rpId)),
        sha256(new TextEncoder().encode(passkey.origin)),
      ),
    ),
  });
}
/** Called on the Pilot wallet's top-level origin, never inside the integrating app. */
export async function createPilotPasskey(name: string): Promise<PilotPasskey> {
  if (!name.trim() || name.length > 64)
    throw new Error("Choose an account name (1–64 characters)");
  const origin = canonicalWalletOrigin(location.origin),
    rpId = location.hostname;
  if (rpId === "127.0.0.1")
    throw new Error(
      "Use http://localhost for passkey development; WebAuthn RP IDs cannot be IP addresses",
    );
  const credential = (await navigator.credentials.create({
    publicKey: {
      rp: { id: rpId, name: "Owl Pilot" },
      user: {
        id: crypto.getRandomValues(new Uint8Array(32)),
        name,
        displayName: name,
      },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "required",
      },
      attestation: "none",
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error("Passkey creation cancelled");
  const response = credential.response as AuthenticatorAttestationResponse;
  const spki = response.getPublicKey();
  if (!spki || response.getPublicKeyAlgorithm() !== -7)
    throw new Error("Authenticator must expose an ES256 public key");
  const key = await crypto.subtle.importKey(
    "spki",
    spki,
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", key);
  const raw = ccc.bytesConcat(
    [4],
    fromBase64url(jwk.x!),
    fromBase64url(jwk.y!),
  );
  const passkey = {
    credentialId: base64url(new Uint8Array(credential.rawId)),
    publicKey: ccc.hexFrom(p256.Point.fromBytes(raw).toBytes(true)),
    rpId,
    origin,
    name,
  };
  pilotPasskeyLock(passkey);
  return passkey;
}
export async function requestPilotAssertion(
  passkey: PilotPasskey,
  challenge: ccc.Hex,
): Promise<PilotAssertion> {
  if (location.origin !== passkey.origin)
    throw new Error("Passkey signing must run on its Pilot wallet origin");
  const credential = (await navigator.credentials.get({
    publicKey: {
      rpId: passkey.rpId,
      challenge: Uint8Array.from(ccc.bytesFrom(challenge)),
      allowCredentials: [
        {
          type: "public-key",
          id: Uint8Array.from(fromBase64url(passkey.credentialId)),
        },
      ],
      userVerification: "required",
    },
  })) as PublicKeyCredential | null;
  if (
    !credential ||
    base64url(new Uint8Array(credential.rawId)) !== passkey.credentialId
  )
    throw new Error("Incorrect passkey selected");
  const r = credential.response as AuthenticatorAssertionResponse;
  const assertion = {
    authenticatorData: ccc.hexFrom(new Uint8Array(r.authenticatorData)),
    clientDataJSON: ccc.hexFrom(new Uint8Array(r.clientDataJSON)),
    signature: ccc.hexFrom(
      p256.Signature.fromBytes(new Uint8Array(r.signature), "der").toBytes(
        "compact",
      ),
    ),
  };
  if (!verifyPilotAssertion(passkey, challenge, assertion))
    throw new Error("Invalid passkey assertion");
  return assertion;
}
export function verifyPilotAssertion(
  passkey: PilotPasskey,
  challenge: ccc.Hex,
  assertion: PilotAssertion,
): boolean {
  try {
    pilotPasskeyLock(passkey);
    const auth = ccc.bytesFrom(assertion.authenticatorData),
      json = ccc.bytesFrom(assertion.clientDataJSON);
    if (
      auth.length < 37 ||
      auth.length > 1024 ||
      json.length > 2048 ||
      (auth[32]! & 5) !== 5 ||
      (auth[32]! & 64) !== 0 ||
      ccc.hexFrom(auth.slice(0, 32)) !==
        ccc.hexFrom(sha256(new TextEncoder().encode(passkey.rpId)))
    )
      return false;
    const data = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(json),
    );
    if (
      data.type !== "webauthn.get" ||
      data.challenge !== base64url(ccc.bytesFrom(challenge)) ||
      data.origin !== passkey.origin ||
      (data.crossOrigin !== undefined && data.crossOrigin !== false)
    )
      return false;
    return p256.verify(
      ccc.bytesFrom(assertion.signature),
      sha256(ccc.bytesConcat(auth, sha256(json))),
      ccc.bytesFrom(passkey.publicKey),
      { prehash: false, lowS: false },
    );
  } catch {
    return false;
  }
}
export function pilotPasskeyDigest(
  value: ccc.TransactionLike,
  index: number,
  sponsor?: number,
): ccc.Hex {
  const tx = ccc.Transaction.from(value).clone();
  if (
    index < 0 ||
    index >= tx.inputs.length ||
    (sponsor !== undefined &&
      (sponsor !== tx.inputs.length - 1 || sponsor === index))
  )
    throw new Error("Invalid passkey signing position");
  tx.setWitnessArgs(index, {
    ...tx.getWitnessArgs(index),
    lock: ccc.hexFrom(ccc.bytesConcat([0], u16(sponsor ?? 65535))),
  });
  if (sponsor !== undefined)
    tx.setWitnessArgs(sponsor, { ...tx.getWitnessArgs(sponsor), lock: "0x" });
  return ccc.hashCkb(
    ccc.bytesFrom("owl-pilot-passkey-v1", "utf8"),
    tx.hash(),
    ...tx.witnesses.flatMap((w) => [
      walletU64(BigInt(ccc.bytesFrom(w).length)),
      ccc.bytesFrom(w),
    ]),
  );
}
export function encodePilotAssertion(
  assertion: PilotAssertion,
  sponsor?: number,
): ccc.Hex {
  const a = ccc.bytesFrom(assertion.authenticatorData),
    j = ccc.bytesFrom(assertion.clientDataJSON),
    s = ccc.bytesFrom(assertion.signature);
  if (a.length < 37 || a.length > 1024 || j.length > 2048 || s.length !== 64)
    throw new Error("Invalid passkey assertion size");
  return ccc.hexFrom(
    ccc.bytesConcat(
      [0],
      u16(sponsor ?? 65535),
      u16(a.length),
      u16(j.length),
      s,
      a,
      j,
    ),
  );
}
export class PilotPasskeySigner extends ccc.Signer {
  constructor(
    client: ccc.Client,
    readonly passkey: PilotPasskey,
    readonly deployment: Deployment,
    readonly assert: (challenge: ccc.Hex) => Promise<PilotAssertion> = (
      challenge,
    ) => requestPilotAssertion(passkey, challenge),
    readonly poolLock?: ccc.ScriptLike,
  ) {
    super(client);
    if (deployment.codeHash !== PILOT_PASSKEY_CODE_HASH)
      throw new Error("Unsupported passkey deployment");
    pilotPasskeyLock(passkey);
  }
  get type() {
    return ccc.SignerType.CKB;
  }
  get signType() {
    return ccc.SignerSignType.Unknown;
  }
  async connect() {
    await verifyDeployment(this.client, this.deployment);
  }
  async disconnect() {}
  async isConnected() {
    return true;
  }
  async getIdentity() {
    return this.passkey.publicKey;
  }
  async getAddressObjs() {
    return [
      ccc.Address.from({
        prefix: this.client.addressPrefix,
        script: pilotPasskeyLock(this.passkey),
      }),
    ];
  }
  async getInternalAddress() {
    return this.getRecommendedAddress();
  }
  async signMessageRaw(): Promise<string> {
    throw new Error(
      "Use a domain-bound passkey assertion, not a raw wallet message signature",
    );
  }
  async prepareTransaction(value: ccc.TransactionLike) {
    const tx = ccc.Transaction.from(value).clone();
    tx.cellDeps.push(ccc.CellDep.from(deploymentDep(this.deployment)));
    tx.cellDeps = tx.cellDeps.filter(
      (d, i, a) =>
        a.findIndex(
          (x) => ccc.hexFrom(x.toBytes()) === ccc.hexFrom(d.toBytes()),
        ) === i,
    );
    for (let i = tx.witnesses.length; i < tx.inputs.length; i++)
      tx.witnesses.push("0x");
    const index = await this.position(tx);
    tx.setWitnessArgs(index, {
      ...tx.getWitnessArgs(index),
      lock: ccc.hexFrom(new Uint8Array(71 + 37 + 512)),
    });
    return tx;
  }
  private async position(tx: ccc.Transaction) {
    for (const [i, input] of tx.inputs.entries()) {
      const cell = await this.client.getCell(input.previousOutput);
      if (cell?.cellOutput.lock.eq(pilotPasskeyLock(this.passkey))) return i;
    }
    throw new Error("Transaction has no passkey-owner input");
  }
  async signOnlyTransaction(value: ccc.TransactionLike) {
    await verifyDeployment(this.client, this.deployment);
    const tx = ccc.Transaction.from(value).clone();
    const index = await this.position(tx);
    const last = tx.inputs.length - 1;
    const pool =
      this.poolLock &&
      (
        await this.client.getCell(tx.inputs[last]!.previousOutput)
      )?.cellOutput.lock.eq(this.poolLock)
        ? last
        : undefined;
    const challenge = pilotPasskeyDigest(tx, index, pool);
    const assertion = await this.assert(challenge);
    if (!verifyPilotAssertion(this.passkey, challenge, assertion))
      throw new Error("Passkey did not authorize this transaction");
    tx.setWitnessArgs(index, {
      ...tx.getWitnessArgs(index),
      lock: encodePilotAssertion(assertion, pool),
    });
    return tx;
  }
}
