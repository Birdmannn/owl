import { useEffect, useRef, useState } from 'react';
import { PilotActivityLog } from './PilotActivityLog.js';
import type { PilotActivity, PilotManifest, PilotAppManifest, DelegationReview } from '@owl/pilot';
import { MAX_DELEGATED_ACTIONS } from '@owl/pilot';
export interface PilotProfileView { username: string }
const amount=(n:bigint)=>(Number(n)/100_000_000).toLocaleString('en',{maximumFractionDigits:5});
export function PilotModal({ manifest: flightManifest, visible, address, walletName, balance, profile, active, busy, canAuthorize, queueLength, submitted, error, onResume, onClose, onConnectOwner, onProfile, onAuthorize, onDisconnect, onRevoke, onRefreshBalance, onContinueWithoutDelegation, onPrepareDelegation, approvedPermissions, activity, onBudgetChange, budgetLimit, profileLoading, profileLookupError, onRetryProfile }: {
  onBudgetChange?:(budget:string)=>void; budgetLimit?:string; profileLoading?:boolean; profileLookupError?:string; onRetryProfile?:()=>void;
  activity?:readonly PilotActivity[]; manifest:PilotManifest|PilotAppManifest; visible:boolean; address:string; walletName?:string; balance?:bigint; profile?:PilotProfileView; active:boolean; busy:string; canAuthorize:boolean; queueLength:number; submitted:boolean; error:string; onResume:()=>Promise<void>;
  onContinueWithoutDelegation?:()=>void; onPrepareDelegation?:(permissions:string[])=>Promise<DelegationReview>; approvedPermissions?:readonly string[];
  onClose:()=>void; onConnectOwner:()=>void; onProfile:(username:string)=>PilotProfileView|Promise<PilotProfileView>; onAuthorize:(permissions:string[])=>Promise<boolean>; onDisconnect:()=>void; onRevoke:()=>Promise<void>; onRefreshBalance:()=>void;
}) {
  const [step,setStep]=useState<'choose'|'owner'|'profile'|'permissions'|'account'>('choose');
  const [username,setUsername]=useState('');
  const [selected,setSelected]=useState<string[]>([]);
  const [review,setReview]=useState<DelegationReview>();
  const [localError,setLocalError]=useState('');
  const permissionScope=JSON.stringify(flightManifest.version===2?flightManifest.actions:flightManifest.permissions);
  useEffect(()=>{setSelected([]);setReview(undefined);},[permissionScope]);
  const feeValue=BigInt('feePerAction' in flightManifest.policy?flightManifest.policy.feePerAction:flightManifest.policy.feePerMove);
  const [actionCount,setActionCount]=useState(String(BigInt(flightManifest.policy.budget)/feeValue));
  useEffect(()=>{setActionCount(String(BigInt(flightManifest.policy.budget)/feeValue));setReview(undefined);},[flightManifest.policy.budget,address,visible]);
  useEffect(()=>{if(visible&&profile)setStep(previous=>previous==='profile'?(active?'account':'permissions'):previous);},[visible,profile?.username,active]);
  const dialog=useRef<HTMLElement>(null);
  const priorActive=useRef(active);
  useEffect(()=>{if(profile)setUsername(profile.username);},[profile?.username]);
  useEffect(()=>{
    if(!visible)return;
    setLocalError('');setUsername(profile?.username??'');setSelected([]);setReview(undefined);
    setStep(previous => address ? !profile?'profile':active?'account':'permissions':previous==='owner'?'owner':'choose');
  },[visible,address]);
  useEffect(()=>{if(active&&profile) setStep('account');else if(!active&&priorActive.current){setStep('permissions');setSelected([]);setReview(undefined);}priorActive.current=active;},[active,profile?.username]);
  useEffect(()=>{
    if(!visible)return;
    const previous=document.activeElement as HTMLElement|null;
    dialog.current?.querySelector<HTMLElement>('button,input')?.focus();
    const keydown=(event:KeyboardEvent)=>{
      if(event.key==='Escape'&&!busy){event.preventDefault();onClose();}
      if(event.key!=='Tab')return;
      const items=Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),summary')??[]).filter(item=>item.getClientRects().length>0),first=items[0],last=items.at(-1);
      if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
    };
    document.addEventListener('keydown',keydown);return()=>{document.removeEventListener('keydown',keydown);previous?.focus();};
  },[visible,step,busy,onClose]);
  if(!visible)return null;
  const policy=flightManifest.policy;
  const networkLabel=policy.deployment.network==='devnet'?'CKB Devnet':'CKB Testnet';
  const permissions=flightManifest.version===2?flightManifest.actions:flightManifest.permissions;
  const selectionLimit=flightManifest.version===2?MAX_DELEGATED_ACTIONS:1;
  const ownerOnly=(id:string)=>flightManifest.version===2&&flightManifest.actions.some(action=>action.id===id&&action.delegation==='owner-only');
  const sponsored=policy.kind==='counter-sponsored-v1'||policy.kind==='delegation-sponsored-v1';
  const fee=BigInt('feePerAction' in policy?policy.feePerAction:policy.feePerMove);
  const validBudget=!onBudgetChange||(/^\d+$/.test(actionCount)&&BigInt(actionCount)>0n&&BigInt(actionCount)*fee<=BigInt(budgetLimit??policy.budget)&&BigInt(actionCount)*fee===BigInt(policy.budget));
  const allowed=approvedPermissions??(flightManifest.version===1?permissions.map(permission=>permission.id):[]);
  const authorize=async()=>{
    try {
      if(!validBudget||!profile||profileLoading||profileLookupError)throw new Error('Resolve your username and choose a valid budget first');
      if(!selected.length||selected.length>selectionLimit||selected.some(id=>ownerOnly(id)||!permissions.some(permission=>permission.id===id)))throw new Error(`Choose between 1 and ${selectionLimit} available actions`);
      if(onPrepareDelegation&&!review){setReview(await onPrepareDelegation([...selected]));return;}
      await onAuthorize([...selected]);
    }catch(error){setLocalError(error instanceof Error?error.message:String(error));}
  };
  const save=async()=>{try{await onProfile(username);setLocalError('');setStep('permissions');}catch(e){setLocalError(e instanceof Error?e.message:String(e));}};
  const title=step==='choose'?'Choose your wallet':step==='owner'?'Welcome to Pilot':step==='profile'?'Your Pilot profile':step==='permissions'?'Sign these on my behalf':`@${profile?.username??'pilot'}`;
  const account=<div className="pilot-account"><div className="account-avatar"><img src="/owl.png" alt=""/></div><div><strong>{profile?`@${profile.username}`:walletName??'Owner wallet'}</strong><span>{walletName??'Existing wallet'} · {networkLabel}</span></div><div className="account-balance"><strong>{balance!==undefined?amount(balance):'—'} <small>CKB</small></strong><button onClick={onRefreshBalance} disabled={!!busy}>Refresh balance ↻</button></div><code>{address}</code><button className="copy-account" onClick={()=>void navigator.clipboard.writeText(address).then(()=>setLocalError('Address copied.')).catch(()=>setLocalError('Could not copy address.'))}>Copy address</button></div>;
  return <div className="modal-backdrop pilot-modal-backdrop" onClick={()=>{if(!busy)onClose();}}><section className="pilot-modal" ref={dialog} role="dialog" aria-modal="true" aria-labelledby="pilot-modal-title" onClick={event=>event.stopPropagation()}>
    <button className="close" aria-label="Close Pilot" onClick={onClose} disabled={!!busy}>×</button><div className="pilot-modal-brand"><img src="/owl.png" alt=""/><strong>Pilot <small>by Owl</small></strong><span>{networkLabel.toUpperCase()}</span></div><h2 id="pilot-modal-title">{title}</h2>
    {step==='choose'&&<><p>Connect to {flightManifest.app.name} with a wallet.</p><button className="pilot-wallet-choice" onClick={()=>setStep('owner')}><img src="/owl.png" alt=""/><span><strong>Pilot</strong><small>Use your wallet. Approve once. Keep playing.</small></span><b>→</b></button><p className="fine">Pilot uses an existing wallet for ownership and signs only the actions you approve.</p></>}
    {step==='owner'&&<><p>Your existing wallet remains the owner. Connect it to use Pilot’s profile and automatic signing.</p><div className="pilot-owner-note"><span>01</span> Connect your owner wallet<br/><span>02</span> Choose a Pilot username<br/><span>03</span> Select actions to auto-approve</div><button className="primary full" onClick={onConnectOwner}>Connect owner wallet <span>↗</span></button><p className="fine">Pilot does not import your wallet’s private key. Session approval and recovery are signed by your owner wallet.</p></>}
    {step==='profile'&&<>{account}{profileLoading?<p role="status">Looking up your Pilot username…</p>:profileLookupError?<><p role="alert">{profileLookupError}</p><button className="secondary full" onClick={onRetryProfile} disabled={!!busy||!onRetryProfile}>Retry username lookup</button></>:<><p>{profile?'Your wallet has a registered Pilot username.':'Choose a public username for this wallet.'}</p><form onSubmit={event=>{event.preventDefault();void save();}}><label className="username-label" htmlFor="pilot-username">Username</label><div className="username-field"><span>@</span><input id="pilot-username" autoComplete="username" placeholder="your_pilot_name" value={username} onChange={event=>{setUsername(event.target.value);setLocalError('');}} maxLength={20} disabled={!!busy||!!profile}/></div><p className="fine">One address has one username. Your wallet signs a registration proof. This shared username resolves to your CKB address for funds and NFTs. JoyID usernames bind to the primary passkey; other wallets bind to their signing identity.</p><button className="primary full" type="submit" disabled={!!busy||!username.trim()}>{profile?`Continue as @${profile.username}`:'Create Pilot profile'} <span>→</span></button></form></>}</>}
    {step==='permissions'&&<>{account}<div className="permission-app"><span>APP REQUEST</span><strong>{flightManifest.app.name}</strong><p>{flightManifest.app.description}</p></div>
      <p className="fine" role="status">{selected.length} / {selectionLimit} action types selected · {permissions.length} offered. Uncheck an action to change your selection at the limit. Owner-only actions cannot be delegated.</p>
      {permissions.map(permission=><label key={permission.id} className={`permission-choice ${selected.includes(permission.id)?'checked':''}`}><input type="checkbox" checked={selected.includes(permission.id)} disabled={!!busy||ownerOnly(permission.id)||(!selected.includes(permission.id)&&selected.length>=selectionLimit)} onChange={event=>{const checked=event.target.checked;setSelected(previous=>checked?(previous.length<selectionLimit&&!previous.includes(permission.id)?[...previous,permission.id]:previous):previous.filter(id=>id!==permission.id));setReview(undefined);}}/><span><strong>{permission.name}</strong><small>{permission.description}</small><code>{permission.id} · {ownerOnly(permission.id)?'owner wallet required':'enforced on-chain'}</code></span></label>)}
      {onBudgetChange&&<><label className="username-label" htmlFor="pilot-budget-actions">Your action budget</label><div className="username-field"><input id="pilot-budget-actions" type="number" min="1" max={String(BigInt(budgetLimit??policy.budget)/fee)} step="1" value={actionCount} disabled={!!busy||submitted||active} onChange={event=>{const value=event.target.value;setActionCount(value);setReview(undefined);if(/^\d+$/.test(value)&&BigInt(value)>0n&&BigInt(value)*fee<=BigInt(budgetLimit??policy.budget))onBudgetChange((BigInt(value)*fee).toString());}}/><span>actions</span></div><p className="fine">Choose up to {String(BigInt(budgetLimit??policy.budget)/fee)} actions. {sponsored?'This allowance is not a deposit; the pool pays eligible network fees.':'The fee budget is funded in your session cell, separate from recoverable storage capacity.'} Changing an active budget requires a new session approval.</p>{!validBudget&&<p role="alert">Choose a whole number of actions within the app limit.</p>}</>}
      <div className="policy"><div><span>Maximum actions</span><strong>{String(BigInt(policy.budget)/fee)}</strong></div><div><span>{sponsored?'Pool fee cap per action':'Fee per action'}</span><strong>{amount(fee)} CKB</strong></div><div><span>{sponsored?'Sponsored allowance (not deposited)':'Total fee budget'}</span><strong>{amount(BigInt(policy.budget))} CKB</strong></div><div><span>Recoverable cell capacity</span><strong>{amount(BigInt(policy.floorCapacity))} CKB</strong></div></div>
      <p className="fine">The owner wallet signs one setup transaction. Keep an ordinary wallet cell for recovery. Session expiry is local; end the session to revoke it on-chain.</p>
      {flightManifest.version===1&&<p className="fine">Have at least 220 test CKB for this counter demo.</p>}
      <a href="https://faucet.nervos.org/" target="_blank" rel="noreferrer">Get test CKB ↗</a><details className="manifest-details"><summary>Inspect app manifest</summary><pre>{JSON.stringify(flightManifest,null,2)}</pre></details>
      {sponsored&&<p>The pool pays network fees. Your funds cover cell capacity, transfers and app payments. If sponsorship is unavailable, Pilot waits for a retry.</p>}
      {review&&<div className="delegation-review"><h3>Review cell delegation</h3><p>{review.mode==='migrate'?'Your selected app cell will move under Pilot authorization.':'Create a new app cell under Pilot authorization.'}</p><p>Delegated: {amount(BigInt(review.delegatedCapacity))} CKB · setup fee: {amount(BigInt(review.setupFee))} CKB</p><p>Allowed: {review.permissions.map(permission=>permission.name).join(', ')}</p><details><summary>Selected cell and transaction</summary><pre>{JSON.stringify(review,null,2)}</pre></details></div>}
      {submitted?<><p className="fine">A session approval was already submitted. Resume it before requesting another session.</p><button className="primary full" disabled={!!busy} onClick={()=>void onResume()}>Resume submitted session <span>→</span></button></>:<>
        <button className="primary full" disabled={!selected.length||selected.length>selectionLimit||!canAuthorize||!!busy||!validBudget||!profile||profileLoading||!!profileLookupError} onClick={()=>void authorize()}>{onPrepareDelegation&&!review?'Review cell delegation':'Allow Pilot to sign selected actions'} <span>↗</span></button>
        <button className="secondary full" disabled={!!busy} onClick={onContinueWithoutDelegation??onClose}>Continue without automatic signing</button>
      </>}
      {!selected.length&&<p className="fine permission-hint">Select an action to allow automatic signing, or continue with your owner wallet.</p>}
    </>}
    {step==='account'&&<>{account}<div className="pilot-connected"><span>✦</span><strong>Pilot is ready</strong><p>Your session may sign the actions below. Your owner wallet stays in control.</p></div>
      {permissions.filter(permission=>allowed.includes(permission.id)).map(permission=><div key={permission.id} className="permission-choice checked"><span>✓</span><span><strong>{permission.name}</strong><small>{permission.description}</small></span></div>)}
      <button className="primary full" onClick={onClose} disabled={!!busy}>Return to {flightManifest.app.name} <span>→</span></button><button className="secondary full" disabled={!!busy||queueLength>0} onClick={()=>void onRevoke()}>End session & reclaim CKB <span>↗</span></button>{queueLength>0&&<p className="fine">Recovery is available once your {queueLength} queued actions settle.</p>}
    </>}
    {address&&step!=='choose'&&step!=='owner'&&<PilotActivityLog address={address} activity={activity}/>}
    {(localError||error)&&<p className="pilot-modal-error" role="status">{localError||error}</p>}{busy&&<p className="pilot-modal-busy" role="status">{busy}</p>}
    {address&&<button className="pilot-disconnect" disabled={!!busy} onClick={onDisconnect}>Disconnect owner wallet</button>}
  </section></div>;
}
