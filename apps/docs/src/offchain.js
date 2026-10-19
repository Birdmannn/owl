const code = (code, language = 'typescript') => ({ code, language });
export const offchain = {
  id: 'offchain-signing', group: 'BUILD WITH PILOT', title: 'Off-chain signing', eyebrow: 'SIGN SOCIAL ACTIONS',
  description: 'Approve likes, follows, or posts once. Pilot signs messages with a scoped session key; the receiving app verifies them.',
  sections: [
    { id: 'offchain-flow', title: 'One owner message, selected actions', html: '<p>Off-chain actions do not need a funded CKB cell. Define an app manifest with readable actions and an exact audience origin. After the user selects permissions, <code>authorizeOffchain()</code> asks their existing wallet to sign a delegation binding the app manifest, owner identity and CKB address, session public key, selected action IDs, and expiry.</p><p><code>PilotOffchainSession</code> signs individual actions without asking the owner wallet again. The receiving app verifies the original owner proof and each session signature before accepting the action. This is a separate permission from on-chain delegation and never authorizes CKB spending.</p><p>Delegation lasts at most seven days; the demo uses one hour. Each action lasts at most five minutes and binds its app, origin, grant ID, action ID, target, payload, nonce, and timestamps. The SDK enforces expiry at both signing and verification.</p>' },
    { id: 'offchain-sdk', title: 'Authorize and sign', html: '<p>Generate a fresh session key and persist it with the resulting authorization in your app’s session store. The example below runs after showing the user the named actions and receiving explicit consent. An empty permission selection should simply close the consent UI; <code>authorizeOffchain()</code> rejects empty grants without signing.</p>', ...code(`import { ccc } from '@ckb-ccc/core';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { authorizeOffchain, PilotOffchainSession } from '@owl/pilot';

const manifest = {
  appId: 'my.social', name: 'My Social',
  audience: window.location.origin,
  actions: [{ id: 'social.like', name: 'Like posts',
    description: 'Like or unlike a post.' }],
};
const key = ccc.hexFrom(secp256k1.utils.randomSecretKey());
const authorization = await authorizeOffchain(ownerSigner, manifest, {
  selected: ['social.like'],
  sessionPublicKey: ccc.hexFrom(secp256k1.getPublicKey(ccc.bytesFrom(key), true)),
  expiresAt: Date.now() + 60 * 60 * 1000,
});
const connectedAddress = await ownerSigner.getRecommendedAddress();
const pilot = await PilotOffchainSession.create(
  authorization, manifest, key, Date.now, connectedAddress,
);
const envelope = pilot.sign({
  id: 'social.like', target: 'post-123', payload: { enabled: true },
});
// Persist envelope before submitting. Retry these exact bytes after a timeout.
await fetch('/api/social/actions', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(envelope),
});`) },
    { id: 'offchain-verifier', title: 'Verify on the receiving app', html: '<p>The backend must use its own configured manifest and audience, rather than trusting values supplied in the request. Call <code>acceptOffchainAction(envelope, { manifest, store })</code>. It verifies owner/address binding, the manifest commitment, permission, origin, lifetime, payload bounds, and session signature before invoking your store.</p><p>The store must atomically check revocation, enforce nonce uniqueness, validate the actual app operation and target, and update app state. A valid signature does not establish that the target exists or that the requested business operation is allowed. Exact retries should return the original receipt; a nonce reused with different content must fail. Recheck expiry at the point of mutation.</p><p><code>verifyOffchainAction()</code> checks cryptography and scope only. It does not consume nonces or check a revocation database. Use the acceptance path for state changes. Your receiving backend must persist these checks atomically with its application state, including across concurrent requests and restarts.</p>', ...code(`import { acceptOffchainAction } from '@owl/pilot';

const receipt = await acceptOffchainAction(requestBody, {
  manifest: serverConfiguredManifest,
  store: socialStore, // OffchainAcceptanceStore<YourReceipt>
});
// store.accept(envelope) performs the atomic app mutation.
// store.revoke(request) permanently records revocation for this grant.`) },
    { id: 'offchain-revocation', title: 'Revoke and recover', html: '<p><code>revokeOffchain(ownerSigner, authorization, manifest)</code> creates an owner-signed revocation. Send it to the receiving app, which calls <code>acceptOffchainRevocation()</code> and records the grant as revoked. Previously signed but unaccepted actions are rejected afterward.</p><p>The demo persists signed actions and revocations before submission, blocks new actions while a request is unresolved, and retries the same envelope. Reload retains the grant, pending request, and diagnostics. A timed-out request may already have been accepted; expired work is cleared only after refreshing the feed. Disconnecting or deleting the local key alone does not revoke a copied key. An expired grant no longer permits new accepted actions.</p>' },
    { id: 'offchain-modal', title: 'React consent and social demo', html: '<p><code>PilotOffchainModal</code> is exported by <code>@owl/pilot-react</code>. Pass the manifest, owner address, visibility/busy/error state, and connect/close/authorize callbacks. Each permission starts unchecked; no username registration or funded session is required.</p><p>The demo has separate like, follow, and publish permissions, optimistic interaction, reload recovery, owner-signed revocation, and expandable signed-message diagnostics. Diagnostic exports exclude the session private key. Open <strong>Social profile &amp; logs</strong> to inspect each recorded action and its signing/acceptance timeline in the modal. History is owner-filtered and persists locally across reloads. It is not an immutable or cross-device ledger.</p><p>The default <strong>browser-local demo</strong> uses real signatures but verifies and stores the feed in that browser. It is suitable for a static-hosted demonstration, not authoritative shared application state. Set a social verifier URL to enable the shared backend; a configured backend failure never silently falls back to browser-local acceptance.</p>', demo: true },
    { id: 'offchain-status', title: "Wallet support and limits", html: "<p>Supported signing identities include CCC CKB, EVM, Bitcoin, Nostr, Dogecoin and primary JoyID passkeys. Actual availability depends on the connected wallet\u2019s message-signing support.</p><p>Protect the session key in your application\u2019s storage. The browser example uses localStorage, which is accessible to same-origin scripts. Off-chain actions are accepted and stored by the receiving app; they do not become CKB transactions.</p><p>A signed grant is valid only for its declared app, audience, actions and lifetime. Disconnecting the wallet does not revoke a copied key: submit an owner-signed revocation or let the grant expire.</p>" },
  ],
};
