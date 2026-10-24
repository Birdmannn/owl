import { formatPilotError } from "../../../src/errors";
import { ccc } from '@ckb-ccc/core';
import { parsePilotPasskey, verifyPilotAssertion, type PilotPasskey, type PilotAssertion } from '../../../src/wallet/passkey';
export const AUTH_PROTOCOL = 'owl-pilot-top-auth-v1';
export type AuthRequest = { kind: 'create'; name: string; appOrigin: string } | { kind: 'assert'; passkey: PilotPasskey; challenge: ccc.Hex; appOrigin: string };
// Includes Safari on iOS/iPadOS; other engines keep the embedded ceremony.
export function needsSafariAuth(ua = navigator.userAgent) {
  return /Safari\//.test(ua) && !/Chrome|Chromium|CriOS|FxiOS|Edg|OPR|Android/.test(ua);
}
export function topLevelAuth(request: AuthRequest): Promise<PilotPasskey | PilotAssertion> {
  const dialog = document.createElement('dialog');
  dialog.className = 'owner-review';
  const title = document.createElement('h2'); title.textContent = 'Continue with Safari';
  const text = document.createElement('p');
  text.textContent = 'Safari needs a separate Pilot window for passkey authentication. Your app permissions, budget and account stay in this modal.';
  const cancel = document.createElement('button'); cancel.textContent = 'Cancel';
  const proceed = document.createElement('button'); proceed.textContent = 'Continue in Pilot'; proceed.className = 'primary';
  dialog.append(title, text, cancel, proceed); document.body.append(dialog); dialog.showModal();
  return new Promise((resolve, reject) => {
    let popup: Window | null = null;
    let interval: ReturnType<typeof setInterval> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const token = crypto.randomUUID();
    const finish = (error?: Error, result?: PilotPasskey | PilotAssertion) => {
      window.removeEventListener('message', receive);
      clearInterval(interval); clearTimeout(timer); popup?.close(); dialog.remove();
      if (error) reject(error); else resolve(result!);
    };
    const receive = (event: MessageEvent) => {
      if (!popup || event.source !== popup || event.origin !== location.origin || event.data?.protocol !== AUTH_PROTOCOL || event.data.token !== token) return;
      if (event.data.method === 'ready') {
        popup.postMessage({ protocol: AUTH_PROTOCOL, token, method: 'request', request }, location.origin);
      } else if (event.data.method === 'result') {
        try {
          if (event.data.error) throw new Error(String(event.data.error));
          const result = event.data.result;
          if (request.kind === 'create') {
            const passkey = parsePilotPasskey(result);
            if (passkey.origin !== location.origin || passkey.name !== request.name) throw new Error('Unexpected passkey identity');
            finish(undefined, passkey);
          } else {
            if (!verifyPilotAssertion(request.passkey, request.challenge, result)) throw new Error('Invalid top-level passkey assertion');
            finish(undefined, result);
          }
        } catch (e) { finish(e instanceof Error ? e : new Error(String(e))); }
      }
    };
    window.addEventListener('message', receive);
    cancel.onclick = () => finish(new Error('Passkey authentication cancelled'));
    dialog.oncancel = (event) => { event.preventDefault(); finish(new Error('Passkey authentication cancelled')); };
    proceed.onclick = () => {
      if (popup && !popup.closed) { popup.focus(); return; }
      // Run directly from this click: owner transaction preparation may have awaited RPC calls.
      popup = window.open(new URL('/auth.html#' + token, location.origin), '_blank', 'popup,width=480,height=620');
      if (!popup) { text.textContent = formatPilotError('Safari blocked the Pilot window. Allow popups for this site and try Continue again.'); return; }
      proceed.textContent = 'Focus Pilot authentication';
      interval = setInterval(() => { if (popup?.closed) finish(new Error('Pilot authentication window closed')); }, 500);
      timer = setTimeout(() => finish(new Error('Pilot authentication timed out')), 180_000);
    };
  });
}
