import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ccc } from '@ckb-ccc/connector-react';
import { amount, buildDeposit, client, explorer, getRecipient, loadBoardPage, loadSocialBoardPage, readLocalBoardActivity, socialBoardUrl, paymasterAddress, short } from './chain.js';

const message = (e) => e instanceof Error ? e.message : String(e);
const receiptKey = 'pilot:paymaster:deposits:v1';
let depositInFlight = false;
const readDeposits = () => { try { const rows = JSON.parse(localStorage.getItem(receiptKey) || '[]'); return Array.isArray(rows) ? rows.filter((r) => /^0x[0-9a-f]{64}$/i.test(r.hash)) : []; } catch { return []; } };
const saveDeposits = (rows) => { try { localStorage.setItem(receiptKey, JSON.stringify(rows)); } catch { /* A storage failure must not hide a broadcast transaction. */ } };

function Paymaster() {
  const { open, disconnect, signerInfo } = ccc.useCcc();
  const signer = signerInfo?.signer;
  const [address, setAddress] = useState('');
  const [value, setValue] = useState('100');
  const [pool, setPool] = useState(null);
  const [minimum, setMinimum] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [review, setReview] = useState(null);
  const [deposits, setDeposits] = useState(readDeposits);
  const dialog = useRef(null);
  const active = useRef(true);
  const locked = useRef(false);
  const pending = deposits.some((d) => d.status === 'submitted' || d.status === 'signed');
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => { let cancelled = false; setAddress(''); setReview(null); if (signer) signer.getRecommendedAddress().then((a) => { if (!cancelled) setAddress(a); }).catch((e) => { if (!cancelled) setError(message(e)); }); return () => { cancelled = true; }; }, [signer]);
  useEffect(() => { if (review && !dialog.current.open) dialog.current.showModal(); }, [review]);
  useEffect(() => {
    if (!paymasterAddress) return;
    let cancelled = false;
    getRecipient().then(async (recipient) => {
      const min = ccc.fixedPointFrom(ccc.CellOutput.from({ lock: recipient.script, capacity: 0n }).occupiedSize);
      if (!cancelled) setMinimum(amount(min));
      const balance = await client.getBalanceSingle(recipient.script);
      if (!cancelled) setPool(amount(balance));
    }).catch((e) => { if (!cancelled) setError(message(e)); });
    return () => { cancelled = true; };
  }, []);
  const prepare = async (event) => {
    event.preventDefault(); if (!signer || locked.current || pending) return;
    if (depositInFlight) { setError('A deposit is already being signed. Wait for it to finish, then refresh receipts.'); return; }
    locked.current = true; setBusy('Preparing deposit…'); setError('');
    try { const result = await buildDeposit(signer, value); if (active.current) setReview({ ...result, signer, sender: await signer.getRecommendedAddress() }); }
    catch (e) { if (active.current) setError(message(e)); }
    finally { locked.current = false; if (active.current) setBusy(''); }
  };
  const confirm = async () => {
    if (!review || review.signer !== signer || locked.current || depositInFlight) return;
    depositInFlight = true;
    locked.current = true; setBusy('Approve in your wallet…'); setError('');
    const prepared = review;
    try {
      const signed = await prepared.signer.signTransaction(prepared.tx);
      const hash = signed.hash();
      const row = { hash, bytes: ccc.hexFrom(signed.toBytes()), amount: amount(prepared.capacity), sender: prepared.sender, recipient: prepared.recipient, status: 'signed', at: Date.now() };
      const rows = [row, ...readDeposits().filter((r) => r.hash !== hash)];
      // Do not broadcast unless the exact signed bytes are saved for reconciliation.
      localStorage.setItem(receiptKey, JSON.stringify(rows));
      if (active.current) { setDeposits(rows); setReview(null); }
      await prepared.signer.client.sendTransaction(signed);
      row.status = 'submitted'; saveDeposits(rows);
      if (active.current) setDeposits([...rows]);
    } catch (e) { if (active.current) setError(message(e)); }
    finally { depositInFlight = false; locked.current = false; if (active.current) setBusy(''); }
  };
  const checkReceipts = async () => {
    setBusy('Checking receipts…'); setError('');
    try {
      const rows = await Promise.all(readDeposits().map(async (r) => {
        if (r.status !== 'submitted' && r.status !== 'signed') return r;
        const receipt = await client.getTransactionNoCache(r.hash);
        return { ...r, status: receipt?.status === 'committed' ? 'confirmed' : receipt?.status === 'rejected' ? 'rejected' : 'submitted' };
      }));
      saveDeposits(rows); if (active.current) setDeposits(rows);
      if (paymasterAddress) { const recipient = await getRecipient(); const balance = await client.getBalanceSingle(recipient.script); if (active.current) setPool(amount(balance)); }
    } catch (e) { if (active.current) setError(message(e)); }
    finally { if (active.current) setBusy(''); }
  };
  const retryDeposit = async (row) => {
    if (depositInFlight || locked.current) return;
    locked.current = true; setBusy('Retrying saved transaction…'); setError('');
    try {
      const receipt = await client.getTransactionNoCache(row.hash);
      if (!receipt || receipt.status === 'unknown') {
        const tx = ccc.Transaction.fromBytes(row.bytes);
        if (tx.hash() !== row.hash) throw new Error('Saved transaction hash does not match its signed bytes.');
        await client.sendTransaction(tx);
      }
      await checkReceipts();
    } catch (e) { setError(message(e)); }
    finally { locked.current = false; setBusy(''); }
  };
  return <>
    <div className="ecosystem-banner"><div><span className="tiny-label">OWL PAYMASTER / CKB TESTNET</span><h2>Give every pilot<br />room to fly.</h2><p>A shared pool for transaction fees.<br />Fund the next flight, together.</p></div><div className="pool-symbol">✦<span>POWERED BY THE FLOCK</span></div></div>
    <div className="metric-grid"><div><span>Paymaster balance</span><strong>{pool ?? '—'} <small>CKB</small></strong></div><div><span>Network</span><strong>Testnet <i className="status-dot" /></strong></div><div><span>Fee sponsorship</span><strong className="metric-small">App-dependent</strong></div></div>
    <div className="deposit-panel"><div className="panel-heading"><div><span className="tiny-label">FUND THE POOL</span><h2>Deposit into Owl paymaster</h2></div><span className="network-badge">TEST CKB ONLY</span></div>
      <p>Your wallet signs a transfer into Owl’s paymaster pool. Eligible transactions can use pool funds to cover network fees; availability depends on the app and sponsorship service.</p>
      <div className="address-box"><span>Paymaster address</span>{paymasterAddress ? <><code>{paymasterAddress}</code><button type="button" onClick={(e) => { const b = e.currentTarget; navigator.clipboard.writeText(paymasterAddress).then(() => { b.textContent = 'Copied ✓'; }).catch(() => setError('Select the address to copy it.')); }}>Copy address</button></> : <p>Owl’s paymaster address hasn’t been published yet.</p>}</div>
      <form onSubmit={prepare}><label htmlFor="deposit-amount">Deposit amount</label><div className="amount-input"><input id="deposit-amount" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} disabled={!!busy || pending} autoComplete="off" /><span>CKB</span></div><div className="amount-options">{['100', '250', '1000'].map((n) => <button type="button" key={n} disabled={!!busy || pending} className={value === n ? 'selected' : ''} onClick={() => setValue(n)}>{n} CKB</button>)}</div><p className="form-note">{minimum ? `Minimum deposit: ${minimum} CKB to create a cell. The wallet also pays the transfer fee.` : 'The minimum deposit depends on the receiving lock’s cell capacity.'}</p>
      {!signer ? <button type="button" className="ecosystem-primary" onClick={() => open()}>Connect wallet <span>↗</span></button> : <><button className="ecosystem-primary" type="submit" disabled={!paymasterAddress || !!busy || pending}>{busy || (pending ? 'Deposit awaiting confirmation' : 'Review deposit')} <span>→</span></button><button type="button" className="wallet-disconnect" disabled={!!busy} onClick={() => disconnect()}>{address ? short(address) : 'Wallet connected'} · Disconnect</button></>}
      </form><div className="sponsorship-note"><span>↳</span><p><strong>Review your contribution.</strong>Deposits go to an operator-controlled pool, not a personal allowance. A deposit does not guarantee sponsorship for your transactions. There is no automatic refund.</p></div>
    </div>
    {error && <div className="app-message error" role="alert">{error}</div>}
    <section className="deposit-history"><div className="panel-heading"><h2>Your deposit receipts</h2><button type="button" className="outline-button" disabled={!!busy} onClick={checkReceipts}>{busy || 'Refresh ↻'}</button></div><p>Transfers made from this browser. Confirmation is checked against CKB testnet.</p>{deposits.length ? <div className="table-wrap"><table><thead><tr><th>Amount</th><th>Status</th><th>Receipt</th></tr></thead><tbody>{deposits.map((r) => <tr key={r.hash}><td>{r.amount} CKB</td><td><span className={`tx-status ${r.status}`}>{r.status}</span>{(r.status === 'signed' || r.status === 'submitted') && r.bytes && <button className="outline-button" disabled={!!busy} onClick={() => retryDeposit(r)}>Retry saved deposit</button>}</td><td><a href={explorer(r.hash)} target="_blank" rel="noopener">{short(r.hash)} ↗</a></td></tr>)}</tbody></table></div> : <div className="app-empty"><span>＋</span><strong>Your first contribution starts here.</strong><p>Deposit receipts will appear after you sign a transfer.</p></div>}</section>
    {review && <dialog ref={dialog} className="deposit-review" onCancel={(e) => { if (busy) e.preventDefault(); else setReview(null); }} aria-labelledby="review-title"><div className="panel-heading"><span className="tiny-label">REVIEW DEPOSIT</span><button className="outline-button" disabled={!!busy} onClick={() => setReview(null)}>Close</button></div><h2 id="review-title">Fund the next flight.</h2><dl><div><dt>Deposit</dt><dd>{amount(review.capacity)} test CKB</dd></div><div><dt>Transaction fee</dt><dd>{amount(review.fee)} CKB</dd></div><div><dt>Total wallet cost</dt><dd>{amount(review.capacity + review.fee)} CKB</dd></div></dl><label>Recipient address</label><code>{review.recipient}</code><p>This transfers test CKB to Owl’s pool. It does not guarantee fee sponsorship and has no automatic refund.</p><button className="ecosystem-primary" disabled={!!busy || review.signer !== signer} onClick={confirm}>{busy || 'Deposit · sign in wallet'} <span>↗</span></button>{error && <p role="alert">{error}</p>}</dialog>}
  </>;
}

function Board() {
  const [rows, setRows] = useState([]), [local, setLocal] = useState([]);
  const [cursor, setCursor] = useState({ chain: undefined, social: undefined });
  const [loaded, setLoaded] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [query, setQuery] = useState(''), [source, setSource] = useState('all');
  const [updated, setUpdated] = useState(null);
  const active = useRef(true), locked = useRef(false);
  const refreshLocal = () => {
    try { setLocal(readLocalBoardActivity(window.localStorage)); }
    catch { setError(previous => previous || 'Browser activity storage is unavailable.'); }
  };
  const load = async (reset = false) => {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError(''); refreshLocal();
    const sources = ['chain', 'social'];
    try {
      const results = await Promise.allSettled([loadBoardPage(reset ? undefined : cursor.chain), loadSocialBoardPage(reset ? undefined : cursor.social)]);
      if (!active.current) return;
      const successful = sources.filter((_, i) => results[i].status === 'fulfilled');
      const incoming = results.flatMap(result => result.status === 'fulfilled' ? result.value.rows : []);
      setRows(old => [...new Map([...old.filter(row => !reset || !successful.includes(row.source)), ...incoming].map(row => [row.id, row])).values()]);
      setCursor(old => Object.fromEntries(sources.map((name, i) => [name, results[i].status === 'fulfilled' ? results[i].value.cursor : old[name]])));
      setError(results.flatMap((result, i) => result.status === 'rejected' ? [`${sources[i]}: ${message(result.reason)}`] : []).join(' '));
      setLoaded(true); setUpdated(new Date());
    } finally { locked.current = false; if (active.current) setBusy(false); }
  };
  useEffect(() => {
    active.current = true; void load(true);
    window.addEventListener('storage', refreshLocal); window.addEventListener('pilot-account-activity', refreshLocal);
    return () => { active.current = false; window.removeEventListener('storage', refreshLocal); window.removeEventListener('pilot-account-activity', refreshLocal); };
  }, []);
  const all = [...rows, ...local].sort((a, b) => b.time - a.time || a.id.localeCompare(b.id));
  const visible = all.filter(row => (source === 'all' || row.source === source) &&
    [row.hash, row.block, row.session, row.owner, row.app, row.action, row.actionId, row.status, row.target, ...(row.details.logs || []).map(log => log.message)].join(' ').toLowerCase().includes(query.trim().toLowerCase()));
  const chain = rows.filter(row => row.source === 'chain');
  const fees = chain.reduce((sum, row) => sum + BigInt(row.fee), 0n);
  return <>
    <div className="ecosystem-banner board-banner"><div><span className="tiny-label">PILOT BOARD / ALL ACTIVITY</span><h2>Every action.<br />A flight recorded.</h2><p>Across apps, owners, and sessions.<br />Public receipts and available local logs.</p></div><div className="board-symbol"><span>01 ━━━ ✦</span><span>02 ━━━ ✦</span><span>03 ━━━ ✦</span></div></div>
    <div className="metric-grid"><div><span>Activity records loaded</span><strong>{all.length}</strong></div><div><span>On-chain transactions loaded</span><strong>{loaded ? chain.length : '—'}</strong></div><div><span>On-chain fees in this view</span><strong>{loaded ? amount(fees) : '—'} <small>CKB</small></strong></div></div>
    <div className="board-toolbar"><div><h2>Activity history</h2><p><i className="status-dot" /> CKB testnet · app receipts · browser timelines</p></div><button className="outline-button" disabled={busy} onClick={() => load(true)}>{busy ? 'Loading…' : 'Refresh ↻'}</button></div>
    <div className="board-filters" aria-label="Activity sources">{[['all', 'All activity'], ['chain', 'On-chain'], ['social', 'Off-chain'], ['local', 'Local logs']].map(([id, label]) => <button key={id} type="button" className="outline-button" aria-pressed={source === id} onClick={() => setSource(id)}>{label}</button>)}</div>
    <label className="board-search"><span>⌕</span><input type="search" aria-label="Filter activity" placeholder="Search app, action, owner, hash, session, or log message…" value={query} onChange={e => setQuery(e.target.value)} /></label>
    {!socialBoardUrl && <p className="board-coverage-note">Shared off-chain history is unavailable here. Available on-chain receipts and local browser logs are still shown.</p>}
    {error && <div className="app-message error" role="alert">{error} Available records remain visible.<button className="outline-button" disabled={busy} onClick={() => load()}>Retry</button></div>}
    <div className="board-records">{visible.map(row => <details className="board-record" key={row.id}>
      <summary><div><strong>{row.action || 'Pilot action'}</strong><small>{row.app} · {row.source === 'chain' ? 'On-chain' : row.source === 'social' ? 'Off-chain receipt' : 'Local log'}</small></div><span className={`tx-status ${row.source === 'chain' ? 'confirmed' : ''}`}>{row.status}</span><time>{row.time ? new Date(row.time).toLocaleString() : 'Time unavailable'}</time><span aria-hidden="true">＋</span></summary>
      <div className="board-record-body"><dl><dt>Signer</dt><dd>{row.signer}</dd><dt>Owner {row.source === 'chain' ? 'lock hash' : 'address'}</dt><dd><code>{row.owner || 'Unavailable'}</code></dd><dt>Session / grant</dt><dd><code>{row.session || 'Unavailable'}</code></dd>{row.actionId && <><dt>Action ID / hash</dt><dd><code>{row.actionId}</code></dd></>}{row.target && <><dt>Target</dt><dd>{row.target}</dd></>}{row.hash && <><dt>Transaction</dt><dd><a href={explorer(row.hash)} target="_blank" rel="noopener noreferrer">{row.hash} ↗</a></dd><dt>Block / fee</dt><dd>#{row.block} · {amount(row.fee)} CKB</dd></>}</dl>
      {row.details.logs && <ol className="board-timeline">{row.details.logs.map((log, index) => <li key={index}><time>{new Date(log.at).toLocaleString()}</time><strong>{log.phase}</strong><p>{log.message}</p></li>)}</ol>}
      <details><summary>Full record details</summary><pre>{JSON.stringify(row.details, null, 2)}</pre></details></div>
    </details>)}</div>
    {!visible.length && <div className="app-empty"><span>{busy ? '↻' : '≡'}</span><strong>{busy ? 'Reading the flight log…' : 'No matching activity loaded.'}</strong><p>Refresh, change the filter, or load older records.</p></div>}
    <div className="board-pagination"><span>{updated ? `Checked ${updated.toLocaleTimeString()} · ${all.length} records loaded` : 'Reading available activity sources'}</span>{loaded && (cursor.chain !== null || cursor.social !== null) && <button className="outline-button" disabled={busy} onClick={() => load()}>{busy ? 'Loading…' : 'Load older activity ↓'}</button>}{loaded && cursor.chain === null && cursor.social === null && <span>End of available public history</span>}</div>
    <div className="callout"><strong>All available logs, with their source visible.</strong><p>Known Pilot lock policies are indexed across apps: setup, funding, delegated transitions, owner actions, and recovery. Shared app receipts are reported by the configured verifier. Local queue, signing, retry, and error timelines are read from this origin’s browser storage, including all stored apps and accounts. Private logs on other origins or devices are not publicly accessible. A local record and its chain receipt appear separately; fees count each loaded chain transaction once.</p></div>
  </>;
}

export function mountEcosystem(element, page) {
  const root = createRoot(element);
  root.render(page === 'paymaster' ? <ccc.Provider name="Owl Paymaster" icon={`${import.meta.env.BASE_URL}owl.png`} defaultClient={client} clientOptions={[{ name: 'CKB Testnet', client }]}><Paymaster /></ccc.Provider> : <Board />);
  return () => root.unmount();
}
