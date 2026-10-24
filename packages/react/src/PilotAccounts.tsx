import { formatPilotError } from '@owl/pilot';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { assertPilotAccount, pilotAccountFromSigner, readPilotAccounts, rememberPilotAccount, type PilotAccount } from '@owl/pilot';
import { ccc } from '@ckb-ccc/core';

type Owner = { signer: ccc.Signer; walletName: string; account: PilotAccount };
type Accounts = {
  signer?: ccc.Signer; walletName?: string; accounts: PilotAccount[]; currentId?: string;
  switching: boolean; blocked: boolean; error: string;
  select: (account: PilotAccount) => Promise<void>; addJoyId?: () => Promise<void>;
  connectWallet: () => void; disconnect: () => void;
  guard: (key: symbol, blocked: boolean) => void;
};
const Context = createContext<Accounts | undefined>(undefined);
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** CCC remains the wallet discovery UI. Pilot owns the selected, identity-checked owner above it. */
export function PilotAccountsProvider({ children, network, signer, walletName, onConnectWallet, onDisconnectWallet, connectJoyId, connectorOpen = false }: {
  children: ReactNode; network: string; signer?: ccc.Signer; walletName?: string; connectorOpen?: boolean;
  onConnectWallet: () => void; onDisconnectWallet: () => void;
  /** Must create a fresh wallet authentication request; never return a cached connection. */
  connectJoyId?: () => Promise<ccc.Signer>;
}) {
  const [owner, setOwner] = useState<Owner>();
  const [accounts, setAccounts] = useState<PilotAccount[]>([]), [switching, setSwitching] = useState(false);
  const [blocked, setBlocked] = useState(false), [error, setError] = useState('');
  const cache = useRef(new Map<string, Owner>()), guards = useRef(new Set<symbol>());
  const serial = useRef(0), waiting = useRef<{ expected?: PilotAccount } | undefined>(undefined);
  const seenOpen = useRef(false), mounted = useRef(true), operation = useRef(false);
  const read = () => { try { setAccounts(readPilotAccounts(localStorage, network)); } catch (e) { setError(message(e)); } };
  useEffect(() => { mounted.current = true; cache.current.clear(); setOwner(undefined); read(); window.addEventListener('storage', read); return () => { mounted.current = false; serial.current++; window.removeEventListener('storage', read); }; }, [network]);
  const accept = async (next: ccc.Signer, name: string, version: number, expected?: PilotAccount) => {
    if (expected) await assertPilotAccount(next, expected);
    const account = await pilotAccountFromSigner(next, network, name);
    if (expected && account.id !== expected.id) throw new Error('The wallet returned a different account. Select the requested account in your wallet.');
    if (!mounted.current || serial.current !== version) return;
    if (!(await next.isConnected())) throw new Error('Wallet disconnected during account selection');
    if (!mounted.current || serial.current !== version) return;
    rememberPilotAccount(localStorage, account);
    const value = { signer: next, walletName: name, account };
    cache.current.set(account.id, value); setOwner(value); read(); setError('');
  };
  useEffect(() => {
    if (!signer) return;
    const version = ++serial.current, expected = waiting.current?.expected;
    setSwitching(true);
    void accept(signer, walletName ?? 'Owner wallet', version, expected).catch(e => {
      if (serial.current === version) { setOwner(undefined); setError(message(e)); }
    }).finally(() => { if (serial.current === version) { waiting.current = undefined; operation.current = false; setSwitching(false); } });
  }, [signer, walletName, network]);
  useEffect(() => {
    if (connectorOpen) seenOpen.current = true;
    else if (seenOpen.current) {
      seenOpen.current = false;
      // CCC can emit close before publishing its signer. Keep the requested identity until a signer arrives or another request explicitly replaces it.
      if (waiting.current && !signer) { serial.current++; operation.current = false; setSwitching(false); setError('Account connection cancelled. Your saved accounts are unchanged.'); }
    }
  }, [connectorOpen, signer]);
  useEffect(() => {
    if (!owner) return;
    return owner.signer.onReplaced(() => { serial.current++; setOwner(undefined); setError('Wallet account changed. Reconnect the account you want to use.'); });
  }, [owner]);
  const available = () => !operation.current && guards.current.size === 0;
  const reconnect = (expected?: PilotAccount) => {
    if (!available()) return;
    operation.current = true; serial.current++; waiting.current = { expected }; setOwner(undefined); setSwitching(true); setError('');
    onConnectWallet();
  };
  const select = async (account: PilotAccount) => {
    if (!available() || account.network !== network || account.id === owner?.account.id) return;
    waiting.current = undefined;
    const known = cache.current.get(account.id);
    if (!known && account.signType === ccc.SignerSignType.JoyId && connectJoyId) {
      operation.current = true; const version = ++serial.current; setSwitching(true); setError('');
      try { await accept(await connectJoyId(), account.walletName, version, account); }
      catch (e) { if (serial.current === version) setError(message(e)); }
      finally { if (serial.current === version) { operation.current = false; setSwitching(false); } }
      return;
    }
    if (!known) { reconnect(account); return; }
    operation.current = true; const version = ++serial.current; setSwitching(true); setError('');
    try { await accept(known.signer, known.walletName, version, account); }
    catch { if (serial.current === version) { operation.current = false; setSwitching(false); reconnect(account); } }
    finally { if (serial.current === version) { operation.current = false; setSwitching(false); } }
  };
  const addJoyId = connectJoyId ? async () => {
    if (!available()) return;
    waiting.current = undefined;
    operation.current = true; const version = ++serial.current; setSwitching(true); setError('');
    try { await accept(await connectJoyId(), 'JoyID Passkey', version); }
    catch (e) { if (serial.current === version) setError(message(e)); }
    finally { if (serial.current === version) { operation.current = false; setSwitching(false); } }
  } : undefined;
  const disconnect = () => {
    if (!available()) return;
    serial.current++; waiting.current = undefined;
    if (owner) { cache.current.delete(owner.account.id); void owner.signer.disconnect().catch(e => setError(message(e))); }
    setOwner(undefined); onDisconnectWallet();
  };
  const guard = (key: symbol, value: boolean) => { if (value) guards.current.add(key); else guards.current.delete(key); setBlocked(guards.current.size > 0); };
  return <Context.Provider value={{ signer: owner?.signer, walletName: owner?.walletName, accounts, currentId: owner?.account.id,
    switching, blocked, error, select, addJoyId, connectWallet: () => reconnect(), disconnect, guard }}>{children}</Context.Provider>;
}
export function usePilotAccounts() {
  const value = useContext(Context);
  if (!value) throw new Error('Wrap this app in PilotAccountsProvider');
  return value;
}
export function usePilotAccountGuard(blocked: boolean) {
  const value = useContext(Context), key = useRef(Symbol('account-operation'));
  const guard = value?.guard;
  // Provider callbacks change with selection; depend on the stable registry and blocked value via a ref.
  const current = useRef(guard); current.current = guard;
  useEffect(() => { current.current?.(key.current, blocked); return () => current.current?.(key.current, false); }, [blocked]);
}
/** Optional context: existing controlled-modal integrations continue to work without a provider. */
export function PilotAccountMenu({ busy = false }: { busy?: boolean }) {
  const accounts = useContext(Context), [expanded, setExpanded] = useState(false);
  if (!accounts) return null;
  const disabled = busy || accounts.blocked || accounts.switching;
  return <div className="pilot-accounts">
    <button className="secondary full" type="button" aria-expanded={expanded} disabled={busy} onClick={() => setExpanded(!expanded)}>Accounts in this browser ({accounts.accounts.length})</button>
    {expanded && <div><p className="fine">Previously connected accounts on this site. Selecting a saved account may ask you to choose it again in your wallet.</p>
      <ul>{accounts.accounts.map(account => <li key={account.id}><button type="button" disabled={disabled || account.id === accounts.currentId} aria-current={account.id === accounts.currentId ? 'true' : undefined} onClick={() => void accounts.select(account)}><strong>{account.walletName}{account.id === accounts.currentId ? ' · Active' : ''}</strong><code>{account.address}</code></button></li>)}</ul>
      <button type="button" className="secondary full" disabled={disabled} onClick={accounts.connectWallet}>Add account / choose wallet</button>
      {accounts.addJoyId && <><button type="button" className="secondary full" disabled={disabled} onClick={() => void accounts.addJoyId?.()}>Add JoyID account</button><p className="fine">Opens fresh JoyID authentication. Choose another JoyID or create one if JoyID offers it. Pilot cannot force passkey creation or list passkeys you have never connected.</p></>}
    </div>}
    {accounts.blocked && <p className="fine">Finish wallet operations and settle queued work before switching accounts.</p>}
    {accounts.switching && <p role="status" className="fine">Choose the requested account in your wallet…</p>}
    {accounts.error && <p className="pilot-modal-error" role="status">{formatPilotError(accounts.error)}</p>}
  </div>;
}
