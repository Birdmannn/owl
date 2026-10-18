import { ccc } from '@ckb-ccc/core';
import type { PilotNetwork, PilotUsername } from './usernames.js';

/** Derive acceptable CKB locks from the signing identity, never trust a claimed address alone. */
export async function verifyWalletIdentity(input: unknown, network: PilotNetwork): Promise<Pick<PilotUsername, 'ownerAddress' | 'network' | 'provider' | 'signType' | 'identity' | 'passkeyPublicKey'>> {
  const value = input as Record<string, unknown>;
  if (!value || typeof value.ownerAddress !== 'string' ||
    typeof value.identity !== 'string' || value.identity.length > 3000) throw new Error('Invalid username registration');
  const client = network === 'ckb-testnet' ? new ccc.ClientPublicTestnet() : new ccc.ClientPublicMainnet();
  const address = await ccc.Address.fromString(value.ownerAddress, client);
  if (address.prefix !== client.addressPrefix) throw new Error('Wallet address belongs to another CKB network');
  const signType = value.signType as ccc.SignerSignType;
  let identity = value.identity;
  let passkeyPublicKey: string | undefined;
  let scripts: ccc.Script[];
  if (signType === ccc.SignerSignType.JoyId) {
    const parsed = JSON.parse(identity);
    if (parsed.keyType !== 'main_key' || typeof parsed.publicKey !== 'string' || !/^[a-f0-9]{128}$/i.test(parsed.publicKey)) {
      throw new Error('Register with your primary JoyID P-256 passkey; subkeys and temporary session keys cannot claim usernames');
    }
    passkeyPublicKey = parsed.publicKey.toLowerCase();
    identity = JSON.stringify({ keyType: 'main_key', publicKey: passkeyPublicKey });
    scripts = [(await ccc.Address.fromKnownScript(client, ccc.KnownScript.JoyId,
      `0x0001${ccc.hashCkb(`0x${passkeyPublicKey}`).slice(2, 42)}`)).script];
  } else if (signType === ccc.SignerSignType.CkbSecp256k1) {
    identity = ccc.hexFrom(identity).toLowerCase();
    if (!/^0x(02|03)[0-9a-f]{64}$/.test(identity)) throw new Error('Invalid CKB public key');
    const args = ccc.hashCkb(identity).slice(0, 42) as ccc.Hex;
    scripts = await Promise.all([ccc.KnownScript.Secp256k1Blake160, ccc.KnownScript.AnyoneCanPay].map(async known =>
      (await ccc.Address.fromKnownScript(client, known, args)).script));
  } else {
    let signer: ccc.Signer;
    switch (signType) {
      case ccc.SignerSignType.EvmPersonal:
        if (!/^0x[0-9a-f]{40}$/i.test(identity)) throw new Error('Invalid EVM identity');
        identity = identity.toLowerCase(); signer = new ccc.SignerEvmAddressReadonly(client, identity); break;
      case ccc.SignerSignType.BtcEcdsa:
        identity = identity.replace(/^0x/, '').toLowerCase();
        if (!/^(02|03)[0-9a-f]{64}$/.test(identity)) throw new Error('Invalid Bitcoin public key');
        signer = new ccc.SignerBtcPublicKeyReadonly(client, '', `0x${identity}`); break;
      case ccc.SignerSignType.NostrEvent:
        signer = new ccc.SignerNostrPublicKeyReadonly(client, identity);
        identity = await signer.getIdentity(); break;
      case ccc.SignerSignType.DogeEcdsa:
        signer = new ccc.SignerDogeAddressReadonly(client, identity); break;
      default: throw new Error('This wallet cannot verify Pilot username ownership');
    }
    scripts = (await signer.getAddressObjs()).map(a => a.script);
  }
  if (!scripts.some(script => script.eq(address.script))) throw new Error('Signing identity does not control this CKB recipient address');
  return { ownerAddress: address.toString(), network,
    provider: signType === ccc.SignerSignType.JoyId ? 'joyid' : 'wallet', signType, identity,
    ...(passkeyPublicKey ? { passkeyPublicKey } : {}) };
}

