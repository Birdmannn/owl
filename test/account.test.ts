import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ccc } from '@ckb-ccc/core';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { PilotAccountSigner, PILOT_ACCOUNT_CODE_HASH, pilotAccountSigningDigest, pilotAccountLock, preparePilotAccountRecovery, verifyPilotAccountMessage,
  type PilotAccountJournal, type PilotAccountOptions, type Deployment } from '../src/index.js';
import { type SponsorQuote, verifySponsorQuote } from '../src/paymaster.js';
const hash=(n:number)=>ccc.hexFrom(new Uint8Array(32).fill(n));
async function fixture(t:TestContext) {
 const client=new ccc.ClientPublicTestnet();const owner=new ccc.SignerCkbPrivateKey(client,hash(1));
 const ownerAddress=await owner.getRecommendedAddressObj(); t.mock.method(owner,'getAddressObjs',async()=>[ownerAddress]);
 const pool=(await new ccc.SignerCkbPrivateKey(client,hash(2)).getRecommendedAddressObj()).script;
 const deployment:Deployment={network:'testnet',genesisHash:'0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606',codeHash:PILOT_ACCOUNT_CODE_HASH,outPoint:{txHash:hash(9),index:0}};
 const code=ccc.Cell.from({outPoint:deployment.outPoint,cellOutput:{lock:pool},outputData:await readFile('contracts/build/pilot-account-lock')});
 const funding=ccc.Cell.from({outPoint:{txHash:hash(4),index:0},cellOutput:{lock:pool,capacity:ccc.fixedPointFrom(1000)},outputData:'0x'});
 const cells=[code,funding];const sent:ccc.Hex[]=[];let fail=false;let committed=false;let rejectQuote=false;let journal:PilotAccountJournal|undefined;
 const keys=new Map<string,ccc.Hex>();let lock=Promise.resolve();let validates=0;
 t.mock.method(client,'getHeaderByNumberNoCache',async()=>({hash:deployment.genesisHash}));
 t.mock.method(client,'getCell',async(point:ccc.OutPointLike)=>cells.find(c=>c.outPoint.eq(point)));
 t.mock.method(client,'getCellLive',async(point:ccc.OutPointLike)=>cells.find(c=>c.outPoint.eq(point)));
 t.mock.method(client,'findCellsByLock',async function*(script:ccc.ScriptLike){for(const cell of cells)if(cell.cellOutput.lock.eq(script))yield cell;});
 t.mock.method(client,'findCells',async function*(filter:{script:ccc.ScriptLike}){for(const cell of cells)if(cell.cellOutput.lock.eq(filter.script))yield cell;});
 t.mock.method(client,'getTransactionNoCache',async()=>committed?{status:'committed'}:undefined);
 t.mock.method(client,'waitTransaction',async()=>{committed=true;return{status:'committed'};});
 const options:PilotAccountOptions={owner,deployment,poolLock:pool,maxFee:100_000n,
  keys:{async load(scope){return keys.get(scope);},async save(scope,key){keys.set(scope,key);}},
  journal:{async load(){return structuredClone(journal);},async save(value){journal=structuredClone(value);}},
  async exclusive(operation){const previous=lock;let release!:()=>void;lock=new Promise<void>(r=>{release=r;});await previous;try{return await operation();}finally{release();}},
  actions:[{id:'pay',name:'Pay reviewed recipient',validateTransaction(tx){validates++;if(!tx.outputs[0]!.lock.eq(ownerAddress.script))throw new Error('Wrong recipient');},validateMessage(message){if(message!=='like:123')throw new Error('Wrong message');}}],permissions:['pay'],
  paymaster:{async prepare(base){if(rejectQuote)throw new Error('Pool unavailable');const tx=base.clone();tx.inputs.push(ccc.CellInput.from({previousOutput:funding.outPoint}));tx.outputs.push(funding.cellOutput.clone());tx.outputsData.push('0x');tx.outputs.at(-1)!.capacity-=1000n;await tx.addCellDepsOfKnownScripts(client,ccc.KnownScript.Secp256k1Blake160);tx.setWitnessArgs(tx.inputs.length-1,{lock:ccc.hexFrom(new Uint8Array(65))});return{version:1,id:ccc.hashCkb(tx.toBytes()),transactionHash:tx.hash(),bytes:ccc.hexFrom(tx.toBytes()),baseBytes:ccc.hexFrom(base.toBytes()),fee:'1000',expiresAt:Date.now()+60000};},
  async submit(quote,tx){assert.ok(journal?.transactions.some(r=>r.bytes===ccc.hexFrom(tx.toBytes())),'persisted before exposing signature');sent.push(ccc.hexFrom(tx.toBytes()));if(fail)throw new Error('Lost response');const result=tx.clone();result.setWitnessArgs(result.inputs.length-1,{lock:ccc.hexFrom(new Uint8Array(65).fill(7))});return result;}}
 };
 const signer=await PilotAccountSigner.create(options);
 const cell=ccc.Cell.from({outPoint:{txHash:hash(5),index:0},cellOutput:{lock:signer.lock,capacity:ccc.fixedPointFrom(500)},outputData:'0x'});cells.push(cell);
 const base=()=>ccc.Transaction.from({inputs:[{previousOutput:cell.outPoint}],outputs:[{lock:ownerAddress.script,capacity:ccc.fixedPointFrom(100)},{lock:signer.lock,capacity:ccc.fixedPointFrom(400)}],outputsData:['0x','0x']});
 return{client,owner,ownerAddress,pool,deployment,options,signer,keys,cells,cell,base,sent,get journal(){return journal!;},get validates(){return validates;},setFail(v:boolean){fail=v;},setPoolDown(v:boolean){rejectQuote=v;},setCommitted(v:boolean){committed=v;}};
}
test('account resumes same owner/key/address, rejects changed configuration and separates owners',async t=>{
 const f=await fixture(t);const restored=await PilotAccountSigner.create(f.options);assert.equal(await restored.getRecommendedAddress(),await f.signer.getRecommendedAddress());assert.equal(f.keys.size,1);
 await assert.rejects(PilotAccountSigner.create({...f.options,maxFee:999n}),/configuration changed/);
 const other=new ccc.SignerCkbPrivateKey(f.client,hash(3));let otherJournal:PilotAccountJournal|undefined;
 const separated=await PilotAccountSigner.create({...f.options,owner:other,journal:{async load(){return otherJournal;},async save(j){otherJournal=structuredClone(j);}}});
 assert.notEqual(separated.lock.hash(),f.signer.lock.hash());assert.equal(f.keys.size,2);
});
test('approved payment signs arbitrary outputs and pool pays exactly the full fee',async t=>{
 const f=await fixture(t);const result=await f.signer.forAction('pay').sendTransaction(f.base());assert.equal(result,f.journal.transactions[0]!.hash);assert.equal(f.validates,1);
 const record=f.journal.transactions[0]!;const tx=ccc.Transaction.fromBytes(record.bytes);const signature=ccc.bytesFrom(tx.getWitnessArgs(0)!.lock!).slice(1);
 assert.equal(secp256k1.verify(signature,ccc.bytesFrom(pilotAccountSigningDigest(tx,0)),ccc.bytesFrom(f.signer.descriptor.publicKey),{prehash:false}),true);
 assert.equal(tx.outputs.slice(0,-1).reduce((sum,o)=>sum+o.capacity,0n),f.cell.cellOutput.capacity);
 assert.equal(f.journal.transactions[0]!.status,'submitted');await f.signer.resume();assert.equal(f.journal.transactions[0]!.status,'confirmed');
});
test('no permission, wrong recipient, pool outage and user-paid fees all fail closed',async t=>{
 const f=await fixture(t);await assert.rejects(f.signer.sendTransaction(f.base()),/approved/);assert.throws(()=>f.signer.forAction('not-approved'),/approved/);
 const wrong=f.base();wrong.outputs[0]!.lock=f.pool;await assert.rejects(f.signer.forAction('pay').sendTransaction(wrong),/pool outputs/);
 const incorrect=f.base();incorrect.outputs[0]!.lock=f.signer.lock;await assert.rejects(f.signer.forAction('pay').sendTransaction(incorrect),/Wrong recipient/);
 const fees=f.base();fees.outputs[0]!.capacity--;await assert.rejects(f.signer.forAction('pay').sendTransaction(fees),/cannot pay the network fee/);
 f.setPoolDown(true);await assert.rejects(f.signer.forAction('pay').sendTransaction(f.base()),/Pool unavailable/);assert.equal(f.sent.length,0);
 await assert.rejects(f.signer.signTransaction(f.base()),/sendTransaction/);
});
test('lost response survives restart with exact signed bytes, blocks new spending and recovery until settled',async t=>{
 const f=await fixture(t);f.setFail(true);await assert.rejects(f.signer.forAction('pay').sendTransaction(f.base()),/Lost response/);
 const bytes=f.journal.transactions[0]!.bytes;assert.equal(f.journal.transactions[0]!.status,'signed');
 const restored=await PilotAccountSigner.create(f.options);await assert.rejects(restored.forAction('pay').sendTransaction(f.base()),/Lost response/);assert.equal(f.journal.transactions.length,1);
 await assert.rejects(restored.recover(),/Lost response/);assert.equal(f.journal.stopped,true);
 f.setFail(false);await restored.resume();assert.equal(f.journal.transactions[0]!.status,'confirmed');assert.equal(f.sent.every(b=>b===bytes),true);
 await assert.rejects(restored.forAction('pay').sendTransaction(f.base()),/stopped/);
});
test('owner can build recovery with public descriptor, without account key or journal; wrong owner cannot',async t=>{
 const f=await fixture(t);const proof=ccc.Cell.from({outPoint:{txHash:hash(6),index:0},cellOutput:{lock:f.ownerAddress.script,capacity:ccc.fixedPointFrom(100)},outputData:'0x'});f.cells.push(proof);
 const tx=await preparePilotAccountRecovery(f.owner,JSON.parse(JSON.stringify(f.signer.descriptor)));
 assert.equal(tx.getWitnessArgs(0)!.lock,'0x00');assert.equal(tx.inputs.length,2);assert.equal(tx.outputs[0]!.capacity,f.cell.cellOutput.capacity+proof.cellOutput.capacity);
 await assert.rejects(preparePilotAccountRecovery(new ccc.SignerCkbPrivateKey(f.client,hash(7)),f.signer.descriptor),/Wrong recovery owner/);
 const typed=ccc.Cell.from({outPoint:{txHash:hash(8),index:0},cellOutput:{lock:f.signer.lock,type:f.pool,capacity:ccc.fixedPointFrom(500)},outputData:'0x01'});f.cells.push(typed);
 const again=await preparePilotAccountRecovery(f.owner,f.signer.descriptor);assert.equal(again.inputs.length,2,'typed assets not silently consumed');
});
test('messages bind new account key, validate scope, persist audit entry, and stop with account',async t=>{
 const f=await fixture(t);const signature=await f.signer.forAction('pay').signMessage('like:123');assert.equal(await verifyPilotAccountMessage(f.signer.descriptor,'like:123',signature),true);
 assert.equal(await verifyPilotAccountMessage({...f.signer.descriptor,publicKey:ccc.hexFrom(secp256k1.getPublicKey(ccc.bytesFrom(hash(8)),true))},'like:123',signature),false);
 assert.equal(f.journal.messages!.length,1);assert.equal(JSON.stringify(f.journal).includes('like:123'),false);
 await assert.rejects(f.signer.forAction('pay').signMessage('unapproved:message'),/Wrong message/);await f.signer.stop();await assert.rejects(f.signer.forAction('pay').signMessage('like:123'),/stopped/);
});
test('owner funding is sponsored and signed only after explicit request; wallet mutation is rejected',async t=>{
 const f=await fixture(t);const proof=ccc.Cell.from({outPoint:{txHash:hash(6),index:0},cellOutput:{lock:f.ownerAddress.script,capacity:ccc.fixedPointFrom(1000)},outputData:'0x'});f.cells.push(proof);
 await assert.rejects(f.signer.fund(1n),/below/);
 await f.signer.fund(ccc.fixedPointFrom(300));const record=f.journal.transactions[0]!;assert.equal(record.kind,'funding');assert.equal(record.status,'confirmed');const tx=ccc.Transaction.fromBytes(record.bytes);assert.equal(tx.outputs[0]!.capacity,ccc.fixedPointFrom(300));assert.ok(tx.outputs[0]!.lock.eq(f.signer.lock));
 t.mock.method(f.owner,'signTransaction',async(value:ccc.TransactionLike)=>{const tx=ccc.Transaction.from(value);tx.outputs[0]!.capacity--;return tx;});
 await assert.rejects(f.signer.fund(ccc.fixedPointFrom(300)),/changed reviewed/);
});

test('stable request IDs prevent duplicate spending after a lost app response', async t => {
 const f=await fixture(t);const signer=f.signer.forAction('pay');const hash=await signer.sendTransaction(f.base(),'purchase-123');
 const retry=await signer.sendTransaction(f.base(),'purchase-123');assert.equal(hash,retry);assert.equal(f.journal.transactions.length,1);assert.equal(f.validates,1);
 const changed=f.base();changed.outputs[0]!.capacity++;changed.outputs[1]!.capacity--;
 await assert.rejects(signer.sendTransaction(changed,'purchase-123'),/different account effects/);
});
test('journal failure never exposes an account signature to the paymaster', async t => {
 const f=await fixture(t);t.mock.method(f.options.journal,'save',async()=>{throw new Error('Storage full');});
 await assert.rejects(f.signer.forAction('pay').sendTransaction(f.base()),/Storage full/);assert.equal(f.sent.length,0);
 await assert.rejects(f.signer.forAction('pay').signMessage('like:123'),/Storage full/);
});

test('independent sponsored recovery persists before submission and retries without the Pilot key', async t => {
 const { recoverPilotAccount }=await import('../src/index.js');
 const f=await fixture(t);f.cells.push(ccc.Cell.from({outPoint:{txHash:hash(6),index:0},cellOutput:{lock:f.ownerAddress.script,capacity:ccc.fixedPointFrom(100)},outputData:'0x'}));
 let receipt:import('../src/index.js').PilotAccountRecoveryReceipt|undefined;let submitted:ccc.Hex|undefined;let lose=true;
 const options={owner:f.owner,account:structuredClone(f.signer.descriptor),receipt:{async load(){return structuredClone(receipt);},async save(value:import('../src/index.js').PilotAccountRecoveryReceipt){receipt=structuredClone(value);}},
  paymaster:{prepare:f.options.paymaster.prepare,async submit(quote:SponsorQuote,tx:ccc.Transaction){assert.equal(receipt!.transaction.bytes,ccc.hexFrom(tx.toBytes()));if(submitted)assert.equal(submitted,ccc.hexFrom(tx.toBytes()));submitted=ccc.hexFrom(tx.toBytes());if(lose)throw new Error('Lost recovery response');return tx;}}};
 await assert.rejects(recoverPilotAccount(options),/Lost recovery response/);assert.equal(receipt!.transaction.status,'signed');lose=false;
 const result=await recoverPilotAccount(options);assert.equal(result,receipt!.transaction.hash);assert.equal(receipt!.transaction.status,'confirmed');
});

test('account-key signatures cannot prove a forged owner link; ownership requires a committed owner input', async t => {
 const { verifyPilotAccountOwnership }=await import('../src/index.js');const f=await fixture(t);
 const source=ccc.Cell.from({outPoint:{txHash:hash(6),index:0},cellOutput:{lock:f.ownerAddress.script,capacity:ccc.fixedPointFrom(500)},outputData:'0x'});f.cells.push(source);
 const tx=ccc.Transaction.from({inputs:[{previousOutput:source.outPoint}],outputs:[{lock:f.signer.lock,capacity:ccc.fixedPointFrom(500)}],outputsData:['0x']});
 t.mock.method(f.client,'getTransactionNoCache',async()=>({status:'committed',transaction:tx}));
 assert.equal(await verifyPilotAccountOwnership(f.client,f.signer.descriptor,tx.hash()),true);
 const fakeOwner=(await new ccc.SignerCkbPrivateKey(f.client,hash(7)).getRecommendedAddressObj()).script;
 assert.equal(await verifyPilotAccountOwnership(f.client,{...f.signer.descriptor,ownerLock:fakeOwner},tx.hash()),false);
 t.mock.method(f.client,'getTransactionNoCache',async()=>({status:'pending',transaction:tx}));
 assert.equal(await verifyPilotAccountOwnership(f.client,f.signer.descriptor,tx.hash()),false);
});

test('a changed active owner cannot trigger new automatic signatures from the old account', async t => {
 const f=await fixture(t);const other=await new ccc.SignerCkbPrivateKey(f.client,hash(7)).getRecommendedAddressObj();
 t.mock.method(f.owner,'getRecommendedAddressObj',async()=>other);
 assert.equal(await f.signer.isConnected(),false);
 await assert.rejects(f.signer.forAction('pay').sendTransaction(f.base()),/Active wallet changed/);
 await assert.rejects(f.signer.forAction('pay').signMessage('like:123'),/Active wallet changed/);
 assert.equal(f.sent.length,0);
});
