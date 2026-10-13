import { useEffect, useRef, useState } from 'react';
import { ccc } from '@ckb-ccc/core';
import { parseCkbAmount, prepareCkbToUsername, prepareSporeToUsername, type PilotUsername } from '@owl/pilot';
import { usernameRegistry } from './profile';
interface Prepared { recipient: PilotUsername; tx: ccc.Transaction; fee: bigint; sender: ccc.Signer; kind: string; value: string }
interface Receipt { hash: string; bytes: ccc.Hex; username: string; address: string; status: 'signed'|'submitted'|'confirmed'|'rejected'; kind: string; value: string; senderAddress: string; fee: string; events: {at:number;message:string}[]; nodeReceipt?:unknown }
const key = 'pilot:username-transfers:v1';
const read = (): Receipt[] => { try { return JSON.parse(localStorage.getItem(key)??'[]'); } catch { return []; } };
const amount = (value: bigint) => ccc.fixedPointToString(value);
export function UsernameTransfers({signer,onSent}:{signer?:ccc.Signer;onSent:()=>void}) {
  const [username,setUsername]=useState(''), [kind,setKind]=useState('CKB'), [value,setValue]=useState('');
  const [review,setReview]=useState<Prepared>(), [busy,setBusy]=useState(''), [error,setError]=useState('');
  const [receipts,setReceipts]=useState<Receipt[]>(read);
  const active=useRef(signer), locked=useRef(false); active.current=signer;
  useEffect(()=>{setReview(undefined);setError('');},[signer]);
  useEffect(()=>{const refresh=()=>setReceipts(read());window.addEventListener('storage',refresh);return()=>window.removeEventListener('storage',refresh);},[]);
  const save=(rows:Receipt[])=>{localStorage.setItem(key,JSON.stringify(rows));setReceipts(rows);};
  const record=(hash:string,status:Receipt['status'],message:string,receipt?:unknown)=>save(read().map(row=>row.hash===hash?{...row,status,events:[...(row.events??[]),{at:Date.now(),message}],...(receipt?{nodeReceipt:JSON.parse(JSON.stringify(receipt,(_key,value)=>typeof value==='bigint'?value.toString():value))}:{})}:row));
  const pending=receipts.some(r=>r.status==='signed'||r.status==='submitted');
  const prepare=async()=>{
    if(!signer||locked.current||pending)return;locked.current=true;setBusy('Resolving username and preparing transfer');setError('');
    try{
      const prepared=kind==='CKB'?await prepareCkbToUsername(usernameRegistry,signer,username,parseCkbAmount(value)):await prepareSporeToUsername(usernameRegistry,signer,username,ccc.hexFrom(value));
      if(active.current===signer)setReview({...prepared,sender:signer,kind,value});
    }catch(e){setError(e instanceof Error?e.message:String(e));}finally{locked.current=false;setBusy('');}
  };
  const exclusive=async(operation:()=>Promise<void>)=>{
    if(!navigator.locks)throw new Error('This browser cannot protect transfers across tabs');
    await navigator.locks.request(key,{ifAvailable:true},async lock=>{if(!lock)throw new Error('A transfer is active in another tab');await operation();});
  };
  const check=async(row:Receipt)=>{
    if(!signer||locked.current)return;locked.current=true;setBusy('Checking saved transfer');setError('');
    try{await exclusive(async()=>{
      if(await signer.getRecommendedAddress()!==row.senderAddress)throw new Error('Connect the wallet that signed this transfer');
      const tx=ccc.Transaction.fromBytes(row.bytes);if(tx.hash()!==row.hash)throw new Error('Saved transfer does not match its transaction hash');
      let receipt=await signer.client.getTransactionNoCache(row.hash);
      if(!receipt||receipt.status==='unknown'){await signer.client.sendTransaction(tx);record(row.hash,'submitted','Rebroadcast the original saved transaction.');receipt=await signer.client.getTransactionNoCache(row.hash);}
      record(row.hash,receipt?.status==='committed'?'confirmed':receipt?.status==='rejected'?'rejected':'submitted','Queried the node receipt for the saved transaction.',receipt);
      onSent();
    });}catch(e){const message=e instanceof Error?e.message:String(e);setError(message);try{record(row.hash,row.status,`Reconciliation error: ${message}`);}catch{}}finally{locked.current=false;setBusy('');}
  };
  const send=async()=>{
    if(!review||!signer||review.sender!==signer||locked.current||pending)return;locked.current=true;setBusy('Approve transfer in your owner wallet');setError('');
    let savedHash:string|undefined;
    try{await exclusive(async()=>{
      if(read().some(r=>r.status==='signed'||r.status==='submitted'))throw new Error('Reconcile the saved transfer before sending again');
      const current=await usernameRegistry.resolve(review.recipient.username,review.recipient.network);
      if(current.ownerAddress!==review.recipient.ownerAddress||current.identity!==review.recipient.identity)throw new Error('Recipient changed; review the transfer again');
      if(active.current!==signer)throw new Error('Wallet changed; review again');
      const tx=await signer.signTransaction(review.tx);
      const row:Receipt={hash:tx.hash(),bytes:ccc.hexFrom(tx.toBytes()),username:current.username,address:current.ownerAddress,status:'signed',kind:review.kind,value:review.value,senderAddress:await signer.getRecommendedAddress(),fee:review.fee.toString(),events:[{at:Date.now(),message:'Owner signed; exact transaction bytes persisted before broadcast.'}]};
      save([row,...read()]); // Persist exact signed bytes before broadcasting.
      savedHash=row.hash;
      setReview(undefined);setBusy('Submitting transfer');await signer.client.sendTransaction(tx);
      record(row.hash,'submitted','Broadcast the saved owner-signed transaction.');
      setBusy('Confirming transfer');const receipt=await signer.client.waitTransaction(row.hash,1,180_000);
      record(row.hash,receipt?.status==='committed'?'confirmed':receipt?.status==='rejected'?'rejected':'submitted','Finished checking chain confirmation.',receipt);onSent();
    });}catch(e){const message=e instanceof Error?e.message:String(e);setError(message);if(savedHash){const row=read().find(r=>r.hash===savedHash);if(row)try{record(row.hash,row.status,`Settlement error: ${message}`);}catch{}}}finally{locked.current=false;setBusy('');}
  };
  return <section className="username-transfers"><div className="panel-top"><span>SEND WITH PILOT USERNAMES</span><span className="tag">OWNER WALLET</span></div><h2>Send to a name.</h2><p>Resolve a registered Pilot username, review its address, then sign with your connected wallet.</p><form onSubmit={event=>{event.preventDefault();void prepare();}}>
    <label>Recipient username<input aria-label="Recipient username" placeholder="@pilot_name" value={username} onChange={event=>{setUsername(event.target.value);setReview(undefined);}} disabled={!!busy}/></label>
    <label>Asset<select aria-label="Asset" value={kind} onChange={event=>{setKind(event.target.value);setValue('');setReview(undefined);}} disabled={!!busy}><option>CKB</option><option>Spore NFT</option></select></label>
    <label>{kind==='CKB'?'Amount (CKB)':'Spore ID'}<input aria-label={kind==='CKB'?'Amount (CKB)':'Spore ID'} placeholder={kind==='CKB'?'100':'0x…'} value={value} onChange={event=>{setValue(event.target.value);setReview(undefined);}} disabled={!!busy}/></label>
    <button className="primary" disabled={!signer||!!busy||pending}>Review transfer →</button></form>
    <p className="fine">CKB and Spore NFTs only. Transfers are separate from Fly forward permissions and require owner approval. Never retry an uncertain transfer by building a new one.</p>
    {review&&<div className="transfer-review" role="region" aria-label="Review transfer"><h3>Review {review.kind} transfer</h3><p><strong>@{review.recipient.username}</strong> · {review.recipient.provider==='joyid'?'JoyID passkey':'Verified wallet'}</p><code>{review.recipient.ownerAddress}</code><p>{review.kind==='CKB'?`${review.value} CKB`:`Spore ${review.value}`} · Fee {amount(review.fee)} CKB</p><button className="primary" disabled={!!busy||review.sender!==signer} onClick={()=>void send()}>Sign and send</button><button className="secondary" disabled={!!busy} onClick={()=>setReview(undefined)}>Cancel transfer</button></div>}
    {(busy||error)&&<p role="status">{busy||error}</p>}
    {pending&&<p className="fine">A transfer awaits reconciliation. Check its saved receipt before sending again.</p>}
    {receipts.length>0&&<div className="transfer-history"><h3>Transfer receipts</h3>{receipts.map(row=><div key={row.hash}><span>{row.kind} → @{row.username} · {row.status}</span><a href={`https://testnet.explorer.nervos.org/transaction/${row.hash}`} target="_blank" rel="noreferrer">{row.hash.slice(0,12)}… ↗</a>{(row.status==='signed'||row.status==='submitted')&&<button className="secondary" disabled={!signer||!!busy} onClick={()=>void check(row)}>Check / retry saved transfer</button>}<details><summary>Transaction details and logs</summary><p>Sender: <code>{row.senderAddress}</code></p><p>Recipient: <code>{row.address}</code></p><p>{row.kind}: {row.value} · Reviewed fee: {row.fee?amount(BigInt(row.fee)):'—'} CKB</p><ol>{row.events?.map((event,index)=><li key={index}>{new Date(event.at).toLocaleString()} · {event.message}</li>)}</ol><pre>{JSON.stringify({hash:row.hash,transaction:JSON.parse(ccc.Transaction.fromBytes(row.bytes).stringify()),signedBytes:row.bytes,nodeReceipt:row.nodeReceipt},null,2)}</pre></details></div>)}</div>}
  </section>;
}
