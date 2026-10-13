import { useEffect, useMemo, useState } from 'react';
import { ccc } from '@ckb-ccc/core';
import { activityKey, clearActivityCache, readActivity, updateActivity, type Activity } from './activity';
import { amount, readSession, type Runtime } from './runtime';
import type { Journal, CounterState, CounterAction } from '@owl/pilot';
const labels: Record<string, string> = { queued:'Queued', signing:'Wallet signature', signed:'Signed & saved', checking:'Checking node', broadcasting:'Broadcasting', submitted:'Submitted', confirming:'Confirming', confirmed:'Confirmed', retry:'Retry scheduled', reverted:'Rolled back', failed:'Failed' };
const time = (n?: number) => n ? new Intl.DateTimeFormat(undefined, {hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(n) : 'Not recorded';
const date = (n?: number) => n ? new Date(n).toLocaleString() : 'Original timestamp unavailable';
const short = (s: string) => `${s.slice(0,10)}…${s.slice(-8)}`;
const json = (value: unknown) => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2);
export function TransactionInspector({ storageKey, runtime, client, onRetry }: { storageKey?: string; runtime?: Runtime; client: ccc.Client; onRetry: () => void }) {
  const [rows, setRows] = useState<Activity[]>([]);
  const [queue, setQueue] = useState<string[]>([]);
  const [selected, setSelected] = useState<string>();
  const [filter, setFilter] = useState('all');
  const [rpcError, setRpcError] = useState('');
  const [queryVersion, setQueryVersion] = useState(0);
  const [checking, setChecking] = useState(false);
  const [copyMessage, setCopyMessage] = useState('');
  useEffect(() => {
    setSelected(undefined); setFilter('all'); setRpcError('');
    const refresh = () => {
      if (!storageKey) { setRows([]); setQueue([]); return; }
      setRows(readActivity(storageKey));
      try { const sessionId = runtime?.saved.session.id ?? readSession(storageKey)?.session.id; const journal = JSON.parse(localStorage.getItem(`${storageKey}:${sessionId}:pilot`) ?? 'null') as Journal<CounterState,CounterAction> | null; setQueue(journal?.queue.map(entry => entry.id) ?? []); } catch { setQueue([]); }
    };
    const local = (event: Event) => { if ((event as CustomEvent).detail === storageKey) refresh(); };
    const remote = (event: StorageEvent) => { if (storageKey && event.key?.startsWith(storageKey)) { clearActivityCache(storageKey); refresh(); } };
    refresh(); window.addEventListener('pilot-activity', local); window.addEventListener('storage', remote);
    const timer = setInterval(refresh, 1000);
    return () => { clearInterval(timer); window.removeEventListener('pilot-activity', local); window.removeEventListener('storage', remote); };
  }, [storageKey, runtime]);
  const visible = useMemo(() => {
    const filtered = rows.filter(row => filter === 'all' || (filter === 'queue' ? queue.includes(row.id) : filter === 'confirmed' ? row.status === 'confirmed' : (['retry','reverted','failed'].includes(row.status) || row.logs.some(log => log.error || ['retry','reverted','failed'].includes(log.phase)))));
    return filtered.sort((a,b) => { const ai=queue.indexOf(a.id), bi=queue.indexOf(b.id); if(ai>=0||bi>=0) return ai<0 ? 1 : bi<0 ? -1 : ai-bi; return (b.createdAt??0)-(a.createdAt??0); });
  }, [rows,queue,filter]);
  const row = visible.find(row => row.id === selected) ?? visible[0];
  useEffect(() => {
    setRpcError(''); setChecking(false);
    if (!storageKey || !row?.hash) return;
    const id=row.id, hash=row.hash;
    let cancelled=false, inFlight=false, feeLoaded=false;
    const query = async () => {
      if(inFlight) return; inFlight=true; setChecking(true);
      try {
        const response=await client.getTransactionNoCache(hash);
        if(cancelled)return;
        if(!response) { setRpcError('The node does not currently know this hash. A saved signature alone does not prove submission.'); return; }
        let confirmations: string | undefined;
        if(response.blockNumber!==undefined) confirmations=(BigInt(await client.getTip())-response.blockNumber+1n).toString();
        if(cancelled)return;
        const node={status:response.status,blockHash:response.blockHash,blockNumber:response.blockNumber?.toString(),cycles:response.cycles?.toString(),txIndex:response.txIndex?.toString(),confirmations,reason:response.reason,checkedAt:Date.now()};
        const old=readActivity(storageKey).find(row=>row.id===id);
        updateActivity(storageKey,id,{node,bytes:ccc.hexFrom(response.transaction.toBytes())},old?.node?.status!==node.status ? {phase:`node:${node.status}`,message:`Node reports ${node.status}${node.blockNumber ? ` in block ${node.blockNumber}` : ''}.${node.reason ? ` ${node.reason}` : ''}`} : undefined);
        setRpcError('');
        if(!feeLoaded) {
          feeLoaded=true;
          const cells=await Promise.all(response.transaction.inputs.map(input=>client.getCell(input.previousOutput)));
          if(!cancelled && cells.every(cell=>cell!==undefined)) {
            const inputCapacity=cells.reduce((sum,cell)=>sum+cell!.cellOutput.capacity,0n);
            const outputCapacity=response.transaction.outputs.reduce((sum,output)=>sum+output.capacity,0n);
            if(inputCapacity>=outputCapacity) updateActivity(storageKey,id,{actualFee:(inputCapacity-outputCapacity).toString()});
          }
        }
      } catch(error) { if(!cancelled)setRpcError(error instanceof Error ? error.message : String(error)); }
      finally {inFlight=false; if(!cancelled)setChecking(false);}
    };
    void query(); const interval=setInterval(()=>void query(),10000);
    return ()=>{cancelled=true;clearInterval(interval);};
  }, [storageKey,row?.id,row?.hash,client,queryVersion]);
  const parsed = useMemo(() => { try { return row?.bytes ? ccc.Transaction.fromBytes(row.bytes) : undefined; } catch { return undefined; } }, [row?.bytes]);
  const reserved=rows.filter(row=>queue.includes(row.id)).reduce((sum,row)=>sum+BigInt(row.cost??'0'),0n);
  const exportLogs=()=>{
    const blob=new Blob([json({network:'ckb-testnet',exportedAt:new Date().toISOString(),queue,transactions:rows})],{type:'application/json'});
    const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='pilot-transactions.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
  const copy=async(value:string)=>{try{await navigator.clipboard.writeText(value);setCopyMessage('Copied');setTimeout(()=>setCopyMessage(''),1800);}catch{setCopyMessage('Copy unavailable');}};
  return <section className="inspector" aria-label="Transaction inspector">
    <div className="inspector-heading"><div><div className="eyebrow">UNDER THE HOOD</div><h2>Transaction queue & logs</h2><p>Your flight stays instant. Follow the signing and settlement work here.</p></div><button className="inspector-button" disabled={!rows.length} onClick={exportLogs}>Export logs ↓</button></div>
    <div className="inspector-stats"><div><span>LOCAL QUEUE</span><strong>{queue.length}<small> actions</small></strong></div><div><span>RESERVED FEES</span><strong>{amount(reserved)}<small> CKB</small></strong></div><div><span>CONFIRMED TRANSACTIONS</span><strong>{rows.filter(row=>row.status==='confirmed').length}</strong></div><div><span>NEEDS ATTENTION</span><strong>{rows.filter(row=>['retry','failed','reverted'].includes(row.status)).length}</strong></div></div>
    <div className="inspector-toolbar"><div className="inspector-tabs" role="group" aria-label="Filter transactions">{[['all','All transactions'],['queue','Queue'],['confirmed','Confirmed'],['errors','Errors & retries']].map(([value,label])=><button key={value} aria-pressed={filter===value} onClick={()=>{setFilter(value);setSelected(undefined);}}>{label}{value==='queue'&&` (${queue.length})`}</button>)}</div><button className="inspector-button" disabled={!runtime || !queue.length} onClick={onRetry}>Retry settlement ↻</button></div>
    {!visible.length ? <div className="inspector-empty"><span>≡</span><h3>{filter==='queue'?'The queue is clear.':filter==='confirmed'?'No confirmed transactions yet.':filter==='errors'?'No errors or retries.':'No transactions yet.'}</h3><p>{!storageKey?'Connect your wallet to see its transaction queue and history.':filter==='all'?'Enable Pilot to log session approval. Every move and recovery transaction will appear here.':filter==='queue'?'Actions are removed only after their chain receipts are reconciled.':'New activity appears automatically.'}</p></div> : <div className="inspector-body"><div className="transaction-list" aria-label="Transactions">{visible.map(item=><button key={item.id} className={`transaction-item ${row?.id===item.id?'selected':''}`} aria-pressed={row?.id===item.id} onClick={()=>setSelected(item.id)}><div><strong>{item.title}</strong><span className={`tx-badge ${item.status}`}>{labels[item.status]}</span></div><p>{queue.includes(item.id)?`Queue #${queue.indexOf(item.id)+1} · `:''}{item.kind==='move'?'Session key':'Owner wallet'}{item.cost?` · ${amount(BigInt(item.cost))} CKB`:''}</p><code>{item.hash?short(item.hash):'Hash assigned after signing'}</code><time>{(item.recovered ? 'Recovered journal' : time(item.createdAt))}</time></button>)}</div>
    {row&&<article className="transaction-detail" aria-label="Transaction details"><div className="detail-title"><div><span>{row.kind.toUpperCase()}</span><h3>{row.title}</h3></div><span className={`tx-badge ${row.status}`}>{labels[row.status]}</span></div>
      <dl className="tx-fields"><div><dt>Action / operation ID</dt><dd>{row.id}</dd></div><div><dt>Session ID</dt><dd>{row.sessionId || 'Not recorded'}</dd></div><div><dt>Signer</dt><dd>{row.kind==='move'?'Pilot session key · no wallet prompt':'Owner wallet'}</dd></div><div><dt>Local queue position</dt><dd>{queue.includes(row.id)?`${queue.indexOf(row.id)+1} of ${queue.length}`:'Not in the queue'}</dd></div><div><dt>Reserved move fee</dt><dd>{row.cost?`${amount(BigInt(row.cost))} CKB (${row.cost} shannons)`:'Not a move reservation'}</dd></div><div><dt>Actual transaction fee</dt><dd>{row.actualFee?`${amount(BigInt(row.actualFee))} CKB (${row.actualFee} shannons)`:'Not yet available'}</dd></div><div><dt>Created</dt><dd>{(row.recovered ? 'Original timestamp unavailable' : date(row.createdAt))}</dd></div><div><dt>Broadcast attempts</dt><dd>{row.logs.filter(log=>log.phase==='broadcasting').length || (row.kind!=='move'&&row.hash?'Wallet-managed · count unavailable':row.recovered?'Original count unavailable':'0')}</dd></div><div><dt>Transaction hash</dt><dd>{row.hash?<><code>{row.hash}</code><div className="hash-actions"><button onClick={()=>void copy(row.hash!)}>Copy hash</button><a href={`https://testnet.explorer.nervos.org/transaction/${row.hash}`} target="_blank" rel="noreferrer">Explorer ↗</a></div></>:row.kind !== 'move' ? 'No transaction hash has been returned by the wallet.' : row.status === 'reverted' ? 'Action rolled back before signing.' : 'Not signed yet. Waiting for earlier queue entries.'}</dd></div></dl>
      <div className="node-heading"><h4>Node & chain receipt</h4><button className="inspector-button" disabled={!row.hash||checking} onClick={()=>setQueryVersion(v=>v+1)}>{checking?'Checking…':'Refresh ↻'}</button></div>
      <dl className="tx-fields compact"><div><dt>RPC status</dt><dd>{row.node?.status??'Not fetched'}</dd></div><div><dt>Block number</dt><dd>{row.node?.blockNumber??'Not recorded'}</dd></div><div><dt>Confirmations</dt><dd>{row.node?.confirmations??'Not recorded'}</dd></div><div><dt>Execution cycles</dt><dd>{row.node?.cycles??'Not reported by node'}</dd></div><div><dt>Transaction index</dt><dd>{row.node?.txIndex??'Not recorded'}</dd></div><div><dt>Last node check</dt><dd>{row.node?date(row.node.checkedAt):'Not checked'}</dd></div>{row.node?.blockHash&&<div><dt>Block hash</dt><dd><code>{row.node.blockHash}</code></dd></div>}{row.node?.reason&&<div><dt>Node rejection reason</dt><dd className="log-error">{row.node.reason}</dd></div>}</dl>
      {rpcError&&<p className="inspector-warning" role="status">Node lookup: {rpcError}</p>}
      <h4>Event timeline <small>{row.logs.length} events</small></h4>{row.recovered&&<p className="inspector-muted">Recovered from a saved journal. Events and timestamps from before logging was enabled are unavailable.</p>}
      <ol className="event-timeline">{row.logs.map((log,index)=><li key={index}><time title={date(log.at)}>{time(log.at)}</time><div><strong>{log.phase}</strong><p>{log.message}</p>{log.error&&<pre className="log-error">{log.error.name}: {log.error.message}</pre>}</div></li>)}</ol>{!row.logs.length&&<p className="inspector-muted">No historical events were recorded for this transaction.</p>}
      <details className="raw-details"><summary>Transaction structure {parsed?`· ${parsed.inputs.length} inputs / ${parsed.outputs.length} outputs`:''}</summary>{parsed?<><dl className="tx-fields compact"><div><dt>Serialized size</dt><dd>{ccc.bytesFrom(row.bytes!).length} bytes</dd></div><div><dt>Cell dependencies</dt><dd>{parsed.cellDeps.length}</dd></div><div><dt>Witnesses</dt><dd>{parsed.witnesses.length}</dd></div></dl><pre>{json(parsed)}</pre></>:<p className="inspector-muted">Available after signing or fetching the transaction from the node.</p>}</details>
      <details className="raw-details"><summary>Signed transaction bytes</summary>{row.bytes?<><button className="inspector-button" onClick={()=>void copy(row.bytes!)}>Copy serialized transaction</button><pre>{row.bytes}</pre></>:<p className="inspector-muted">No signed bytes available yet.</p>}</details><span className="copy-status" role="status">{copyMessage}</span>
    </article>}</div>}
    <div className="inspector-footnote">Queue order is FIFO: each move spends the previous move’s session cell. Logs stay in this browser, including after a session ends. Only the selected transaction is polled, every 10 seconds.</div>
  </section>;
}
