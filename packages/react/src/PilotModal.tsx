import { useEffect, useRef, useState } from 'react';
import type { PilotManifest } from '@owl/pilot';
export interface PilotProfileView { username: string }
const amount=(n:bigint)=>(Number(n)/100_000_000).toLocaleString('en',{maximumFractionDigits:5});
export function PilotModal({ manifest: flightManifest, visible, address, walletName, balance, profile, active, busy, canAuthorize, queueLength, submitted, error, onResume, onClose, onConnectOwner, onProfile, onAuthorize, onDisconnect, onRevoke, onRefreshBalance }: {
  manifest:PilotManifest; visible:boolean; address:string; walletName?:string; balance?:bigint; profile?:PilotProfileView; active:boolean; busy:string; canAuthorize:boolean; queueLength:number; submitted:boolean; error:string; onResume:()=>Promise<void>;
  onClose:()=>void; onConnectOwner:()=>void; onProfile:(username:string)=>PilotProfileView|Promise<PilotProfileView>; onAuthorize:(permissions:string[])=>Promise<boolean>; onDisconnect:()=>void; onRevoke:()=>Promise<void>; onRefreshBalance:()=>void;
}) {
  const [step,setStep]=useState<'choose'|'owner'|'profile'|'permissions'|'account'>('choose');
  const [username,setUsername]=useState('');
  const [selected,setSelected]=useState(false);
  const [localError,setLocalError]=useState('');
  const dialog=useRef<HTMLElement>(null);
  const priorActive=useRef(active);
  useEffect(()=>{if(profile)setUsername(profile.username);},[profile?.username]);
  useEffect(()=>{
    if(!visible)return;
    setLocalError('');setUsername(profile?.username??'');setSelected(false);
    setStep(previous => address ? !profile?'profile':active?'account':previous==='owner'?'profile':'permissions':previous==='owner'?'owner':'choose');
  },[visible,address]);
  useEffect(()=>{if(active&&profile) setStep('account');else if(!active&&priorActive.current){setStep('permissions');setSelected(false);}priorActive.current=active;},[active,profile?.username]);
  useEffect(()=>{
    if(!visible)return;
    const previous=document.activeElement as HTMLElement|null;
    dialog.current?.querySelector<HTMLElement>('button,input')?.focus();
    const keydown=(event:KeyboardEvent)=>{
      if(event.key==='Escape'&&!busy){event.preventDefault();onClose();}
      if(event.key!=='Tab')return;
      const items=Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled)')??[]),first=items[0],last=items.at(-1);
      if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
    };
    document.addEventListener('keydown',keydown);return()=>{document.removeEventListener('keydown',keydown);previous?.focus();};
  },[visible,step,busy,onClose]);
  if(!visible)return null;
  const policy=flightManifest.policy;
  const save=async()=>{try{await onProfile(username);setLocalError('');setStep('permissions');}catch(e){setLocalError(e instanceof Error?e.message:String(e));}};
  const title=step==='choose'?'Choose your wallet':step==='owner'?'Welcome to Pilot':step==='profile'?'Your Pilot profile':step==='permissions'?'Sign these on my behalf':`@${profile?.username??'pilot'}`;
  const account=<div className="pilot-account"><div className="account-avatar"><img src="/owl.png" alt=""/></div><div><strong>{profile?`@${profile.username}`:walletName??'Owner wallet'}</strong><span>{walletName??'Existing wallet'} · CKB Testnet</span></div><div className="account-balance"><strong>{balance!==undefined?amount(balance):'—'} <small>CKB</small></strong><button onClick={onRefreshBalance} disabled={!!busy}>Refresh balance ↻</button></div><code>{address}</code><button className="copy-account" onClick={()=>void navigator.clipboard.writeText(address).then(()=>setLocalError('Address copied.')).catch(()=>setLocalError('Could not copy address.'))}>Copy address</button></div>;
  return <div className="modal-backdrop pilot-modal-backdrop" onClick={()=>{if(!busy)onClose();}}><section className="pilot-modal" ref={dialog} role="dialog" aria-modal="true" aria-labelledby="pilot-modal-title" onClick={event=>event.stopPropagation()}>
    <button className="close" aria-label="Close Pilot" onClick={onClose} disabled={!!busy}>×</button><div className="pilot-modal-brand"><img src="/owl.png" alt=""/><strong>Pilot <small>by Owl</small></strong><span>CKB TESTNET</span></div><h2 id="pilot-modal-title">{title}</h2>
    {step==='choose'&&<><p>Connect to Owl Flight with a wallet.</p><button className="pilot-wallet-choice" onClick={()=>setStep('owner')}><img src="/owl.png" alt=""/><span><strong>Pilot</strong><small>Use your wallet. Approve once. Keep playing.</small></span><b>→</b></button><p className="fine">Pilot uses an existing wallet for ownership and signs only the actions you approve.</p></>}
    {step==='owner'&&<><p>Your existing wallet remains the owner. Connect it to use Pilot’s profile and automatic signing.</p><div className="pilot-owner-note"><span>01</span> Connect your owner wallet<br/><span>02</span> Choose a Pilot username<br/><span>03</span> Select actions to auto-approve</div><button className="primary full" onClick={onConnectOwner}>Connect owner wallet <span>↗</span></button><p className="fine">Pilot does not import your wallet’s private key. Session approval and recovery are signed by your owner wallet.</p></>}
    {step==='profile'&&<>{account}<p>{profile?'Your wallet has a registered Pilot username.':'Choose a public username for this wallet.'}</p><form onSubmit={event=>{event.preventDefault();void save();}}><label className="username-label" htmlFor="pilot-username">Username</label><div className="username-field"><span>@</span><input id="pilot-username" autoComplete="username" placeholder="your_pilot_name" value={username} onChange={event=>{setUsername(event.target.value);setLocalError('');}} maxLength={20} disabled={!!busy}/></div><p className="fine">Your wallet signs a registration proof. This shared username resolves to your CKB address for funds and NFTs. JoyID usernames bind to the primary passkey; other wallets bind to their signing identity.</p><button className="primary full" type="submit" disabled={!!busy||!username.trim()}>{profile?`Continue as @${profile.username}`:'Create Pilot profile'} <span>→</span></button></form></>}
    {step==='permissions'&&<>{account}<div className="permission-app"><span>APP REQUEST</span><strong>{flightManifest.app.name}</strong><p>{flightManifest.app.description}</p></div><label className={`permission-choice ${selected?'checked':''}`}><input type="checkbox" checked={selected} disabled={!!busy} onChange={event=>setSelected(event.target.checked)}/><span><strong>{flightManifest.permissions[0].name}</strong><small>{flightManifest.permissions[0].description}</small><code>counter.increment · enforced on-chain</code></span></label><div className="policy"><div><span>Maximum moves</span><strong>{String(BigInt(policy.budget)/BigInt(policy.feePerMove))}</strong></div><div><span>Fee per move</span><strong>{amount(BigInt(policy.feePerMove))} CKB</strong></div><div><span>Total fee budget</span><strong>{amount(BigInt(policy.budget))} CKB</strong></div><div><span>Recoverable cell capacity</span><strong>{amount(BigInt(policy.floorCapacity))} CKB</strong></div></div><p className="fine">The owner wallet signs one setup transaction. Have at least 220 test CKB and keep an ordinary wallet cell for recovery. Pilot stops signing after 24 hours locally; end the session to revoke it on-chain.</p><a href="https://faucet.nervos.org/" target="_blank" rel="noreferrer">Get test CKB ↗</a><details className="manifest-details"><summary>Inspect app manifest</summary><pre>{JSON.stringify(flightManifest,null,2)}</pre></details>{submitted?<><p className="fine">A session approval was already submitted. Resume it before requesting another session.</p><button className="primary full" disabled={!!busy} onClick={()=>void onResume()}>Resume submitted session <span>→</span></button></>:<button className="primary full" disabled={!selected||!canAuthorize||!!busy} onClick={()=>void onAuthorize(['counter.increment'])}>Allow Pilot to sign selected actions <span>↗</span></button>}{!selected&&<p className="fine permission-hint">Select an action to allow automatic signing.</p>}</>}
    {step==='account'&&<>{account}<div className="pilot-connected"><span>✦</span><strong>Pilot is ready</strong><p>Your session may sign the actions below. Your owner wallet stays in control.</p></div><div className="permission-choice checked"><span>✓</span><span><strong>Fly forward</strong><small>One step per transaction · up to the remaining session budget.</small></span></div><button className="primary full" onClick={onClose} disabled={!!busy}>Return to Owl Flight <span>→</span></button><button className="secondary full" disabled={!!busy||queueLength>0} onClick={()=>void onRevoke()}>End session & reclaim CKB <span>↗</span></button>{queueLength>0&&<p className="fine">Recovery is available once your {queueLength} queued moves settle.</p>}</>}
    {(localError||error)&&<p className="pilot-modal-error" role="status">{localError||error}</p>}{busy&&<p className="pilot-modal-busy" role="status">{busy}</p>}
    {address&&<button className="pilot-disconnect" disabled={!!busy} onClick={onDisconnect}>Disconnect owner wallet</button>}
  </section></div>;
}
