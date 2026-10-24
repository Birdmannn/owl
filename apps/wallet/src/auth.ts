import { formatPilotError } from "../../../src/errors";
import './style.css';
import { createPilotPasskey, requestPilotAssertion, parsePilotPasskey, canonicalWalletOrigin } from '../../../src/wallet/passkey';
import { AUTH_PROTOCOL, type AuthRequest } from './auth-bridge';
const root = document.querySelector<HTMLElement>('#app')!;
const title = document.createElement('h1'); title.textContent = 'Pilot passkey';
const description = document.createElement('p');
const origin = document.createElement('p');
const detail = document.createElement('code');
const status = document.createElement('p'); status.setAttribute('role', 'status');
const approve = document.createElement('button'); approve.className = 'primary'; approve.textContent = 'Continue with passkey'; approve.disabled = true;
root.append(title, description, origin, detail, approve, status);
const token = location.hash.slice(1);
const peer = window.opener;
let request: AuthRequest | undefined;
if (window.self !== window.top || !peer || !/^[a-f0-9-]{36}$/.test(token)) {
  status.textContent = 'Open authentication from the Pilot modal.';
} else {
  // Requests and results go only to the exact same-origin wallet frame which opened us.
  window.addEventListener('message', (event) => {
    if (event.source !== peer || event.origin !== location.origin || event.data?.protocol !== AUTH_PROTOCOL || event.data.token !== token || event.data.method !== 'request' || request) return;
    try {
      const value = event.data.request as AuthRequest;
      canonicalWalletOrigin(value.appOrigin);
      if (value.kind === 'create') {
        if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 64) throw new Error('Invalid account name');
        description.textContent = `Create a Pilot passkey for ${value.name}.`;
      } else if (value.kind === 'assert') {
        value.passkey = parsePilotPasskey(value.passkey);
        if (value.passkey.origin !== location.origin || !/^0x[0-9a-f]{64}$/.test(value.challenge)) throw new Error('Invalid authentication request');
        description.textContent = `Authenticate ${value.passkey.name}. For an owner operation, confirm only if you reviewed its details in the Pilot modal.`;
        detail.textContent = 'Request digest: ' + value.challenge;
      } else throw new Error('Unsupported authentication request');
      origin.textContent = 'Requesting app: ' + value.appOrigin;
      request = value; approve.disabled = false;
    } catch (e) { status.textContent = formatPilotError(e); }
  });
  peer.postMessage({ protocol: AUTH_PROTOCOL, token, method: 'ready' }, location.origin);
}
approve.onclick = async () => {
  if (!request) return;
  approve.disabled = true;
  try {
    const result = request.kind === 'create' ? await createPilotPasskey(request.name) : await requestPilotAssertion(request.passkey, request.challenge);
    peer.postMessage({ protocol: AUTH_PROTOCOL, token, method: 'result', result }, location.origin);
    status.textContent = 'Complete. Return to the Pilot modal.';
  } catch (e) {
    status.textContent = formatPilotError(e);
    approve.disabled = false;
  }
};
