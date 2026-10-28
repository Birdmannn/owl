import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ccc } from '@ckb-ccc/core';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { PilotPaymaster, PaymasterStore, createPaymasterServer } from '../server/paymaster.js';
import { SponsorQuoteRejectedError, verifySponsorQuote, PilotPaymasterClient, type SponsorQuote } from '../src/paymaster.js';
import { SPONSORED_COUNTER_CODE_HASH, SPONSORED_DELEGATION_CODE_HASH, signCounterTransaction, signDelegatedTransaction, delegationSigningDigest, counterLock, encodeCounterData, type Deployment } from '../src/index.js';
const hash=(n:number)=>ccc.hexFrom(new Uint8Array(32).fill(n));
async function fixture(t:TestContext, limits: {dailyBudget?:bigint;ownerDailyBudget?:bigint}={}) {
 const dir=await mkdtemp(join(tmpdir(),'pilot-sponsor-')); t.after(()=>rm(dir,{recursive:true,force:true}));
 const client=new ccc.ClientPublicTestnet();
 const signer=new ccc.SignerCkbPrivateKey(client,hash(1));t.mock.method(client,'getBalanceSingle',async()=>ccc.fixedPointFrom(100)); const pool=(await signer.getRecommendedAddressObj()).script;
 const owner=(await new ccc.SignerCkbPrivateKey(client,hash(3)).getRecommendedAddressObj()).script;
 const deployment:Deployment={network:'testnet',genesisHash:hash(8),codeHash:SPONSORED_COUNTER_CODE_HASH,outPoint:{txHash:hash(9),index:0}};
 const lock=counterLock(deployment,owner,secp256k1.getPublicKey(ccc.bytesFrom(hash(2)),true),100_000n,ccc.fixedPointFrom(200),pool);
 const app=ccc.Cell.from({outPoint:{txHash:hash(4),index:0},cellOutput:{lock,capacity:ccc.fixedPointFrom(200)},outputData:encodeCounterData(2_000_000n,0n)});
 const funding=ccc.Cell.from({outPoint:{txHash:hash(5),index:0},cellOutput:{lock:pool,capacity:ccc.fixedPointFrom(100)},outputData:'0x'});
 const cells=[app,funding]; let invalid=false; let failSend=false; const sent:ccc.Hex[]=[];
 t.mock.method(client,'getCell',async(point:ccc.OutPointLike)=>cells.find(c=>c.outPoint.eq(point)));
 t.mock.method(client,'getCellLive',async(point:ccc.OutPointLike)=>cells.find(c=>c.outPoint.eq(point)));
 t.mock.method(client,'findCellsByLock',async function*(){yield funding;});
 t.mock.method(client,'getTransactionNoCache',async()=>undefined);
 const store=new PaymasterStore(join(dir,'pool.json'));
 t.mock.method(client,'estimateCycles',async(tx:ccc.Transaction)=>{
  if(invalid)throw new Error('Invalid owner signature');
  const unsigned=tx.clone();unsigned.setWitnessArgs(tx.inputs.length-1,{...tx.getWitnessArgs(tx.inputs.length-1),lock:ccc.hexFrom(new Uint8Array(65))});
  const info=await unsigned.getSignHashInfo(pool,client); assert.ok(info);
  const signature=ccc.bytesFrom(tx.getWitnessArgs(info.position)!.lock!);
  assert.equal(secp256k1.verify(signature.slice(0,64),ccc.bytesFrom(info.message),secp256k1.getPublicKey(ccc.bytesFrom(hash(1)),true),{prehash:false}),true);
  return 1_000_000n;
 });
 t.mock.method(client,'sendTransaction',async(tx:ccc.Transaction)=>{
  assert.ok(JSON.parse(await readFile(store.file,'utf8')).records.some((r:{bytes?:string})=>r.bytes===ccc.hexFrom(tx.toBytes())),'exact bytes persisted before broadcast');
  sent.push(ccc.hexFrom(tx.toBytes())); if(failSend)throw new Error('Lost broadcast response'); return tx.hash();
 });
 const paymaster=await PilotPaymaster.create({signer,store,maxFee:100_000n,feeRate:1000n,dailyBudget:limits.dailyBudget??1_000_000n,ownerDailyBudget:limits.ownerDailyBudget??1_000_000n,allowedCodeHashes:[SPONSORED_COUNTER_CODE_HASH,SPONSORED_DELEGATION_CODE_HASH]});
 const base=ccc.Transaction.from({inputs:[{previousOutput:app.outPoint}],outputs:[app.cellOutput.clone()],outputsData:[encodeCounterData(1_900_000n,1n)]});
 return {client,pool,app,funding,base,paymaster,store,sent,cells,setInvalid(v:boolean){invalid=v;},setFailSend(v:boolean){failSend=v;}};
}
test('pool quote pays entire network fee without reducing user capacity; client rejects changed effects, deps and pool',async t=>{
 const f=await fixture(t); const quote=await f.paymaster.quote(ccc.hexFrom(f.base.toBytes()));
 const tx=await verifySponsorQuote(f.client,f.base,quote,f.pool,100_000n);
 assert.equal(tx.outputs[0]!.capacity,f.app.cellOutput.capacity);
 assert.equal(f.funding.cellOutput.capacity-tx.outputs[1]!.capacity,BigInt(quote.fee));
 assert.ok(BigInt(quote.fee)>0n); assert.equal((await f.paymaster.quote(ccc.hexFrom(f.base.toBytes()))).expiresAt,quote.expiresAt);
 for(const mutate of [(tx:ccc.Transaction)=>{tx.outputs[0]!.capacity--;},(tx:ccc.Transaction)=>{tx.outputs[1]!.lock=f.app.cellOutput.lock;},(tx:ccc.Transaction)=>{tx.cellDeps=[];},(tx:ccc.Transaction)=>{tx.inputs[1]!.since=1n;}]){
  const bad=tx.clone();mutate(bad);const changed={...quote,id:ccc.hashCkb(bad.toBytes()),transactionHash:bad.hash(),bytes:ccc.hexFrom(bad.toBytes())};await assert.rejects(verifySponsorQuote(f.client,f.base,changed,f.pool,100_000n));
 }
 const base=f.base.clone();base.outputs[0]!.capacity--;await assert.rejects(f.paymaster.quote(ccc.hexFrom(base.toBytes())),/zero network fee/);
});
test('invalid signatures and changed app outputs never obtain a pool signature or lease',async t=>{
 const f=await fixture(t);const quote=await f.paymaster.quote(ccc.hexFrom(f.base.toBytes()));
 const signed=signCounterTransaction(ccc.Transaction.fromBytes(quote.bytes),hash(2));
 const altered=signed.clone();altered.outputs[0]!.capacity--;await assert.rejects(f.paymaster.submit(quote.id,ccc.hexFrom(altered.toBytes())),/changed/);
 f.setInvalid(true);await assert.rejects(f.paymaster.submit(quote.id,ccc.hexFrom(signed.toBytes())),/Invalid owner signature/);
 assert.equal(JSON.parse(await readFile(f.store.file,'utf8')).records.filter((r:{bytes?:string})=>r.bytes).length,0);
 assert.equal(f.sent.length,0);
 f.setInvalid(false);await f.paymaster.submit(quote.id,ccc.hexFrom(signed.toBytes()));assert.equal(f.sent.length,1);
});
test('lost submission response and service restart reuse exact durable bytes without a second fee',async t=>{
 const f=await fixture(t);const quote=await f.paymaster.quote(ccc.hexFrom(f.base.toBytes()));const signed=signCounterTransaction(ccc.Transaction.fromBytes(quote.bytes),hash(2));
 f.setFailSend(true);await assert.rejects(f.paymaster.submit(quote.id,ccc.hexFrom(signed.toBytes())),/Lost broadcast/);
 const saved=JSON.parse(await readFile(f.store.file,'utf8'));assert.ok(saved.records[0].bytes);
 f.setFailSend(false);const restarted=await PilotPaymaster.create({...f.paymaster.options,store:new PaymasterStore(f.store.file)});
 const result=await restarted.submit(quote.id,ccc.hexFrom(signed.toBytes()));assert.equal(ccc.hexFrom(result.toBytes()),saved.records[0].bytes);assert.equal(f.sent[0],f.sent[1]);
 assert.equal(JSON.parse(await readFile(f.store.file,'utf8')).records.filter((r:{bytes?:string})=>r.bytes).length,1);
});
test('pool leases prevent conflicting submissions and spending caps prevent subsidy abuse',async t=>{
 for(const limits of [{dailyBudget:1n},{ownerDailyBudget:1n}]){const f=await fixture(t,limits);const quote=await f.paymaster.quote(ccc.hexFrom(f.base.toBytes()));await assert.rejects(f.paymaster.submit(quote.id,ccc.hexFrom(signCounterTransaction(ccc.Transaction.fromBytes(quote.bytes),hash(2)).toBytes())),/allowance exhausted/);assert.equal(f.sent.length,0);}
 const f=await fixture(t);const first=await f.paymaster.quote(ccc.hexFrom(f.base.toBytes()));const other=f.base.clone();other.outputsData[0]=encodeCounterData(1_900_000n,2n);const second=await f.paymaster.quote(ccc.hexFrom(other.toBytes()));
 await f.paymaster.submit(first.id,ccc.hexFrom(signCounterTransaction(ccc.Transaction.fromBytes(first.bytes),hash(2)).toBytes()));
 await assert.rejects(f.paymaster.submit(second.id,ccc.hexFrom(signCounterTransaction(ccc.Transaction.fromBytes(second.bytes),hash(2)).toBytes())),/Requote/);
 await assert.rejects(f.paymaster.quote(ccc.hexFrom(other.toBytes())),/no available/);
});
test('HTTP client checks independent pool conservation and exact submit result; CORS blocks foreign browsers',async t=>{
 const f=await fixture(t);const server=createPaymasterServer({paymaster:f.paymaster,allowedOrigins:['https://game.example']});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve())));
 const address=server.address() as {port:number};const url=`http://127.0.0.1:${address.port}/api/paymaster`;
 const sponsor=new PilotPaymasterClient({client:f.client,url,poolLock:f.pool,maxFee:100_000n});const quote=await sponsor.prepare(f.base);const other=f.base.clone();other.outputsData[0]=encodeCounterData(1_900_000n,2n);const conflict=await sponsor.prepare(other);const result=await sponsor.submit(quote,signCounterTransaction(ccc.Transaction.fromBytes(quote.bytes),hash(2)));assert.equal(result.hash(),quote.transactionHash);
 await assert.rejects(sponsor.submit(conflict,signCounterTransaction(ccc.Transaction.fromBytes(conflict.bytes),hash(2))),(e:unknown)=>e instanceof SponsorQuoteRejectedError && e.quoteId===conflict.id);
 const denied=await fetch(url+'/status',{headers:{Origin:'https://attacker.example'}});assert.equal(denied.status,403);
 const status=await(await fetch(url+'/status')).json();assert.equal(status.poolLock.args,f.pool.args);assert.equal(JSON.stringify(status).includes(hash(1)),false);
});
test('sponsored delegation digest survives pool co-signing but commits pool type witnesses',()=>{
 const lock={codeHash:SPONSORED_DELEGATION_CODE_HASH,hashType:'data2' as const,args:'0x'};
 const tx=ccc.Transaction.from({inputs:[{previousOutput:{txHash:hash(1),index:0}},{previousOutput:{txHash:hash(2),index:0}}],outputs:[{lock,capacity:ccc.fixedPointFrom(500)}],outputsData:['0x']});tx.setWitnessArgs(1,{lock:'0x00',inputType:'0x1234'});
 const signed=signDelegatedTransaction(tx,'game.forward',hash(3));const before=delegationSigningDigest(signed,'game.forward');signed.setWitnessArgs(1,{...signed.getWitnessArgs(1),lock:'0x123456'});assert.equal(delegationSigningDigest(signed,'game.forward'),before);signed.setWitnessArgs(1,{...signed.getWitnessArgs(1),inputType:'0x4567'});assert.notEqual(delegationSigningDigest(signed,'game.forward'),before);
});

test('sponsored counter adapter persists before service submission, restores a lost response and preserves user funds',async t=>{
 const { readFileSync }=await import('node:fs');
 const { CkbCounterAdapter } = await import('../src/index.js');
 const f=await fixture(t);
 const deployment:Deployment={network:'testnet',genesisHash:'0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606',codeHash:SPONSORED_COUNTER_CODE_HASH,outPoint:{txHash:hash(9),index:0}};
 f.cells.push(ccc.Cell.from({outPoint:deployment.outPoint,cellOutput:{lock:f.pool},outputData:readFileSync('contracts/build/pilot-sponsored-session-lock')}));
 t.mock.method(f.client,'getHeaderByNumberNoCache',async()=>({hash:deployment.genesisHash}));
 t.mock.method(f.client,'getTransactionNoCache',async()=>f.sent.length>=2?{status:'committed',transaction:ccc.Transaction.fromBytes(f.sent.at(-1)!)}:undefined);
 t.mock.method(f.client,'waitTransaction',async()=>({status:'committed',transaction:ccc.Transaction.fromBytes(f.sent.at(-1)!)}));
 let journal:import('../src/index.js').SettlementJournal|undefined;
 const paymaster={async prepare(base:ccc.Transaction){const quote=await f.paymaster.quote(ccc.hexFrom(base.toBytes()));await verifySponsorQuote(f.client,base,quote,f.pool,100_000n);return quote;},async submit(quote:SponsorQuote,tx:ccc.Transaction){assert.ok(journal?.transactions.move,'SDK saved before any pool signature request');return f.paymaster.submit(quote.id,ccc.hexFrom(tx.toBytes()));}};
 const session={id:'sponsored',network:'ckb-testnet',policyVersion:'counter-sponsored-v1',expiresAt:Date.now()+60_000};
 const options={client:f.client,deployment,paymaster,session,sessionPrivateKey:hash(2),sessionCell:{lock:f.app.cellOutput.lock,outPoint:f.app.outPoint,feePerMove:'100000'},store:{async load(){return structuredClone(journal);},async save(next:import('../src/index.js').SettlementJournal){journal=structuredClone(next);}}};
 const request={id:'move',action:{steps:1},session,reservedCost:100_000n};f.setFailSend(true);
 const first=await CkbCounterAdapter.create(options);await assert.rejects(first.settle(request),/Lost broadcast/);
 assert.ok(journal!.transactions.move!.paymasterQuote);assert.equal(journal!.transactions.move!.confirmed,false);
 f.setFailSend(false);const restored=await CkbCounterAdapter.create(options);await restored.settle(request);
 assert.equal(f.sent[0],f.sent[1]);assert.equal(journal!.transactions.move!.confirmed,true);
 const tx=ccc.Transaction.fromBytes(journal!.transactions.move!.bytes);assert.equal(tx.outputs[0]!.capacity,f.app.cellOutput.capacity);
 await restored.settle(request);assert.equal(f.sent.length,2);
 await assert.rejects(CkbCounterAdapter.create({...options,paymaster:undefined}),/Paymaster/);
});

test('sponsored reusable delegation adapter uses the pool without depositing a user fee budget',async t=>{
 const { readFileSync }=await import('node:fs');
 const { createDelegationExample }=await import('../examples/cell-delegation.js');
 const { PilotDelegationAdapter,createPilotGrant,delegationLock }=await import('../src/index.js');
 const f=await fixture(t);
 const deployment:Deployment={network:'testnet',genesisHash:'0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606',codeHash:SPONSORED_DELEGATION_CODE_HASH,outPoint:{txHash:hash(9),index:0}};
 const definition=createDelegationExample(deployment,f.pool);const grant=createPilotGrant(definition.manifest,['game.forward']);const publicKey=ccc.hexFrom(secp256k1.getPublicKey(ccc.bytesFrom(hash(2)),true));
 const owner=(await new ccc.SignerCkbPrivateKey(f.client,hash(3)).getRecommendedAddressObj()).script;
 const lock=delegationLock(definition.manifest,grant,owner,publicKey);f.app.cellOutput.lock=lock;f.app.cellOutput.capacity=ccc.fixedPointFrom(350);f.app.outputData=definition.encodeState({position:5});
 f.cells.push(ccc.Cell.from({outPoint:deployment.outPoint,cellOutput:{lock:f.pool},outputData:readFileSync('contracts/build/pilot-sponsored-delegation-lock')}));
 t.mock.method(f.client,'getHeaderByNumberNoCache',async()=>({hash:deployment.genesisHash}));
 t.mock.method(f.client,'getTransactionNoCache',async()=>f.sent.length?{status:'committed',transaction:ccc.Transaction.fromBytes(f.sent.at(-1)!)}:undefined);
 t.mock.method(f.client,'waitTransaction',async()=>({status:'committed',transaction:ccc.Transaction.fromBytes(f.sent.at(-1)!)}));
 let journal:import('../src/index.js').SettlementJournal|undefined;
 const paymaster={async prepare(base:ccc.Transaction){const quote=await f.paymaster.quote(ccc.hexFrom(base.toBytes()));await verifySponsorQuote(f.client,base,quote,f.pool,100_000n);return quote;},async submit(quote:SponsorQuote,tx:ccc.Transaction){assert.ok(journal?.transactions.move);return f.paymaster.submit(quote.id,ccc.hexFrom(tx.toBytes()));}};
 const session={id:'sponsored-app',network:'ckb-testnet',policyVersion:'delegation-sponsored-v1',expiresAt:Date.now()+60_000};
 const adapter=await PilotDelegationAdapter.create({definition,client:f.client,cell:{lock,outPoint:f.app.outPoint,grant,ownerLock:owner,sessionPublicKey:publicKey},session,sessionPrivateKey:hash(2),paymaster,
 store:{async load(){return structuredClone(journal);},async save(next:import('../src/index.js').SettlementJournal){journal=structuredClone(next);}}});
 await adapter.settle({id:'move',action:{id:'game.forward',params:undefined},session,reservedCost:100_000n});
 const tx=ccc.Transaction.fromBytes(journal!.transactions.move!.bytes);assert.equal(tx.outputs[0]!.capacity,ccc.fixedPointFrom(350));assert.equal(definition.decodeState(tx.outputsData[0]!).position,6);
 const signed=ccc.bytesFrom(tx.getWitnessArgs(0)!.lock!);assert.equal(secp256k1.verify(signed.slice(33),ccc.bytesFrom(delegationSigningDigest(tx,'game.forward')),ccc.bytesFrom(publicKey),{prehash:false}),true);
});

test('sponsored setup and recovery preserve owner capacity and include an explicit owner proof input',async t=>{
 const {readFileSync}=await import('node:fs');
 const {createDelegationExample}=await import('../examples/cell-delegation.js');
 const {PilotConnector,prepareDelegationRecovery}=await import('../src/index.js');
 const f=await fixture(t);
 const deployment:Deployment={network:'testnet',genesisHash:'0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606',codeHash:SPONSORED_DELEGATION_CODE_HASH,outPoint:{txHash:hash(9),index:0}};
 f.cells.push(ccc.Cell.from({outPoint:deployment.outPoint,cellOutput:{lock:f.pool},outputData:readFileSync('contracts/build/pilot-sponsored-delegation-lock')}));
 const signer=new ccc.SignerCkbPrivateKey(f.client,hash(3));const ownerAddress=await signer.getRecommendedAddressObj();
 t.mock.method(signer,'getAddressObjs',async()=>[ownerAddress]);
 const ownerCell=ccc.Cell.from({outPoint:{txHash:hash(10),index:0},cellOutput:{lock:ownerAddress.script,capacity:ccc.fixedPointFrom(1000)},outputData:'0x'});f.cells.push(ownerCell);
 t.mock.method(f.client,'getHeaderByNumberNoCache',async()=>({hash:deployment.genesisHash}));
 t.mock.method(f.client,'findCells',async function*(filter:{script:ccc.ScriptLike}){if(ccc.Script.from(filter.script).eq(ownerAddress.script))yield ownerCell;});
 t.mock.method(f.client,'findCellsByLock',async function*(lock:ccc.ScriptLike){yield ccc.Script.from(lock).eq(f.pool)?f.funding:ownerCell;});
 const paymaster={async prepare(tx:ccc.Transaction){const quote=await f.paymaster.quote(ccc.hexFrom(tx.toBytes()));await verifySponsorQuote(f.client,tx,quote,f.pool,100_000n);return quote;},async submit(quote:SponsorQuote,tx:ccc.Transaction){return f.paymaster.submit(quote.id,ccc.hexFrom(tx.toBytes()));}};
 const definition=createDelegationExample(deployment,f.pool);const connector=new PilotConnector(signer,definition,{paymaster});
 const prepared=await connector.prepareDelegation({selected:['game.forward'],sessionPublicKey:secp256k1.getPublicKey(ccc.bytesFrom(hash(2)),true),initialState:{position:5}});
 assert.equal(prepared.mode,'delegation');if(prepared.mode!=='delegation')throw new Error('Missing review');
 assert.equal(prepared.review.setupFee,'0');assert.equal(prepared.review.delegatedCapacity,ccc.fixedPointFrom(350).toString());
 const setup=ccc.Transaction.fromBytes(prepared.transactionBytes);assert.equal(setup.outputs[0]!.capacity,ccc.fixedPointFrom(350));
 assert.equal(setup.outputs.slice(0,-1).reduce((n,o)=>n+o.capacity,0n),ownerCell.cellOutput.capacity);
 const delegatedCell=ccc.Cell.from({outPoint:prepared.cell.outPoint,cellOutput:setup.outputs[0]!,outputData:setup.outputsData[0]!});f.cells.push(delegatedCell);
 const recovered=await prepareDelegationRecovery(signer,definition.manifest,prepared.cell,prepared.cell.outPoint,{paymaster});
 assert.ok(recovered.inputs.some(input=>input.previousOutput.eq(ownerCell.outPoint)),'owner proof is required even with zero user fee');
 const quote=recovered.inputs.at(-1)!;assert.ok(quote.previousOutput.eq(f.funding.outPoint));
 assert.equal(recovered.outputs[0]!.capacity,delegatedCell.cellOutput.capacity);
 assert.equal(recovered.outputs.slice(0,-1).reduce((n,o)=>n+o.capacity,0n),delegatedCell.cellOutput.capacity+ownerCell.cellOutput.capacity);
});

test('expired unsigned quote can be refreshed without reserving capacity or exposing a signature',async t=>{
 const f=await fixture(t);const old=await f.paymaster.quote(ccc.hexFrom(f.base.toBytes()));
 await f.store.exclusive(async data=>{data.records[0]!.quote.expiresAt=Date.now()-1;});
 await assert.rejects(f.paymaster.submit(old.id,ccc.hexFrom(signCounterTransaction(ccc.Transaction.fromBytes(old.bytes),hash(2)).toBytes())),/Requote/);
 const fresh=await f.paymaster.quote(ccc.hexFrom(f.base.toBytes()));assert.equal(fresh.id,old.id);assert.ok(fresh.expiresAt>Date.now());
 assert.equal(JSON.parse(await readFile(f.store.file,'utf8')).records.filter((r:{bytes?:string})=>r.bytes).length,0);
});

test('quote identity commits application witnesses even when raw transaction hashes match',async t=>{
 const f=await fixture(t);const a=f.base.clone(),b=f.base.clone();a.setWitnessArgs(0,{inputType:'0x01'});b.setWitnessArgs(0,{inputType:'0x02'});
 const qa=await f.paymaster.quote(ccc.hexFrom(a.toBytes())),qb=await f.paymaster.quote(ccc.hexFrom(b.toBytes()));
 assert.equal(qa.transactionHash,qb.transactionHash);assert.notEqual(qa.id,qb.id);
 await verifySponsorQuote(f.client,a,qa,f.pool,100_000n);await verifySponsorQuote(f.client,b,qb,f.pool,100_000n);
 await assert.rejects(verifySponsorQuote(f.client,b,qa,f.pool,100_000n),/reviewed transaction/);
});

test('persistent account sponsorship binds the pool and charges its owner bucket even after another app input',async t=>{
 const { PILOT_ACCOUNT_CODE_HASH, pilotAccountLock, pilotAccountSigningDigest }=await import('../src/index.js');
 const f=await fixture(t);const owner=(await new ccc.SignerCkbPrivateKey(f.client,hash(3)).getRecommendedAddressObj()).script;
 const descriptor={version:1 as const,deployment:{network:'testnet' as const,genesisHash:hash(8),codeHash:PILOT_ACCOUNT_CODE_HASH,outPoint:{txHash:hash(9),index:0}},ownerLock:owner,publicKey:ccc.hexFrom(secp256k1.getPublicKey(ccc.bytesFrom(hash(2)),true)),poolLock:f.pool,maxFee:'100000'};
 const lock=pilotAccountLock(descriptor);f.app.cellOutput.lock=lock;f.app.cellOutput.capacity=ccc.fixedPointFrom(500);f.app.outputData='0x';
 const extra=ccc.Cell.from({outPoint:{txHash:hash(33),index:0},cellOutput:{lock:owner,capacity:ccc.fixedPointFrom(300)},outputData:'0x'});f.cells.push(extra);
 const service=await PilotPaymaster.create({...f.paymaster.options,allowedCodeHashes:[PILOT_ACCOUNT_CODE_HASH]});
 const base=ccc.Transaction.from({inputs:[{previousOutput:extra.outPoint},{previousOutput:f.app.outPoint}],outputs:[{lock:owner,capacity:ccc.fixedPointFrom(400)},{lock,capacity:ccc.fixedPointFrom(400)}],outputsData:['0x','0x']});
 base.setWitnessArgs(0,{lock:'0x01'});base.setWitnessArgs(1,{lock:ccc.hexFrom(ccc.bytesConcat([1],new Uint8Array(64)))});
 await assert.rejects(service.quote(ccc.hexFrom(base.toBytes())),/confirmed owner-authorized funding/);
 const ownerRecovery=base.clone();ownerRecovery.setWitnessArgs(1,{lock:'0x00'});
 assert.ok(await service.quote(ccc.hexFrom(ownerRecovery.toBytes())),'actual owner recovery does not depend on registration');
 // An unsigned/rejected funding quote is not registration. Only a persisted, committed owner-approved setup counts.
 const setup=ccc.Transaction.from({inputs:[{previousOutput:extra.outPoint}],outputs:[{lock,capacity:extra.cellOutput.capacity}],outputsData:['0x']});
 const unrelated=ccc.Cell.from({outPoint:{txHash:hash(35),index:0},cellOutput:{lock:{codeHash:hash(36),hashType:'data2',args:'0x'},capacity:ccc.fixedPointFrom(100)},outputData:'0x'});f.cells.push(unrelated);
 const mixed=setup.clone();mixed.inputs.unshift(ccc.CellInput.from({previousOutput:unrelated.outPoint}));mixed.outputs.push(unrelated.cellOutput.clone());mixed.outputsData.push('0x');
 const mixedQuote=await service.quote(ccc.hexFrom(mixed.toBytes()));
 const mixedJournal=JSON.parse(await readFile(f.store.file,'utf8'));assert.equal(mixedJournal.records.find((r:{quote:SponsorQuote})=>r.quote.id===mixedQuote.id).owner,owner.hash(),'owner funding quota must not come from an unrelated first input');
 const setupQuote=await service.quote(ccc.hexFrom(setup.toBytes()));
 await assert.rejects(service.quote(ccc.hexFrom(base.toBytes())),/confirmed owner-authorized funding/);
 const setupOwner=new ccc.SignerCkbPrivateKey(f.client,hash(3));t.mock.method(setupOwner,'getAddressObjs',async()=>[ccc.Address.from({prefix:f.client.addressPrefix,script:owner})]);
 const setupSigned=await setupOwner.signTransaction(ccc.Transaction.fromBytes(setupQuote.bytes));
 await service.submit(setupQuote.id,ccc.hexFrom(setupSigned.toBytes()));
 await assert.rejects(service.quote(ccc.hexFrom(base.toBytes())),/confirmed owner-authorized funding/);
 // The confirmed funding pool input is consumed. A new pool cell supplies the next transaction.
 const nextFunding=ccc.Cell.from({outPoint:{txHash:hash(34),index:0},cellOutput:{lock:f.pool,capacity:ccc.fixedPointFrom(100)},outputData:'0x'});f.cells.push(nextFunding);
 t.mock.method(f.client,'getCellLive',async(point:ccc.OutPointLike)=>ccc.OutPoint.from(point).eq(f.funding.outPoint)?undefined:f.cells.find(c=>c.outPoint.eq(point)));
 t.mock.method(f.client,'findCellsByLock',async function*(){yield nextFunding;});
 t.mock.method(f.client,'getTransactionNoCache',async(hash:ccc.Hex)=>hash===setupQuote.transactionHash?{status:'committed'}:undefined);
 const quote=await service.quote(ccc.hexFrom(base.toBytes()));const sponsored=await verifySponsorQuote(f.client,base,quote,f.pool,100_000n);
 const sig=secp256k1.sign(ccc.bytesFrom(pilotAccountSigningDigest(sponsored,1)),ccc.bytesFrom(hash(2)),{prehash:false});sponsored.setWitnessArgs(1,{lock:ccc.hexFrom(ccc.bytesConcat([1],sig))});
 await service.submit(quote.id,ccc.hexFrom(sponsored.toBytes()));
 const journal=JSON.parse(await readFile(f.store.file,'utf8'));assert.equal(journal.records.find((r:{quote:SponsorQuote})=>r.quote.id===quote.id).owner,owner.hash());
 const foreignPool=(await new ccc.SignerCkbPrivateKey(f.client,hash(7)).getRecommendedAddressObj()).script;const other=pilotAccountLock({...descriptor,poolLock:foreignPool});f.app.cellOutput.lock=other;
 await assert.rejects(service.quote(ccc.hexFrom(base.toBytes())),/Invalid Pilot account/);
});

for (const general of [false, true]) test(`passkey ${general ? 'general' : 'restricted'} wallet sponsorship requires confirmed owner funding and preserves owner quota`,async t=>{
 const {p256}=await import('@noble/curves/nist.js');const{sha256}=await import('@noble/hashes/sha2.js');
 const {pilotPasskeyLock,pilotPasskeyDigest,encodePilotAssertion,base64url,verifyPilotAssertion,createPilotWalletDescriptor,pilotWalletLock,PILOT_PASSKEY_CODE_HASH,PILOT_WALLET_SESSION_CODE_HASH,PILOT_WALLET_GENERAL_CODE_HASH}=await import('../src/index.js');
 const f=await fixture(t);const identity={credentialId:'AQID',publicKey:ccc.hexFrom(p256.getPublicKey(ccc.bytesFrom(hash(3)),true)),rpId:'wallet.example',origin:'https://wallet.example',name:'Alice'};
 const owner=pilotPasskeyLock(identity);const proof=ccc.Cell.from({outPoint:{txHash:hash(41),index:0},cellOutput:{lock:owner,capacity:ccc.fixedPointFrom(1000)},outputData:'0x'});f.cells.push(proof);
 const deployment:Deployment={network:'testnet',genesisHash:hash(8),codeHash:general?PILOT_WALLET_GENERAL_CODE_HASH:PILOT_WALLET_SESSION_CODE_HASH,outPoint:{txHash:hash(9),index:0}};
 const descriptor=createPilotWalletDescriptor(owner,deployment,f.pool,100000n,{previousOutput:proof.outPoint});const lock=pilotWalletLock(descriptor);f.app.cellOutput.lock=lock;f.app.outputData='0x';
 const service=await PilotPaymaster.create({...f.paymaster.options,allowedCodeHashes:[PILOT_PASSKEY_CODE_HASH,PILOT_WALLET_SESSION_CODE_HASH,PILOT_WALLET_GENERAL_CODE_HASH]});
 const action=ccc.Transaction.from({inputs:[{previousOutput:f.app.outPoint}],outputs:[f.app.cellOutput],outputsData:['0x']});action.setWitnessArgs(0,{lock:ccc.hexFrom(ccc.bytesConcat([1],new Uint8Array(64)))});
 await assert.rejects(service.quote(ccc.hexFrom(action.toBytes())),/confirmed owner-authorized funding/);
 const setup=ccc.Transaction.from({inputs:[{previousOutput:proof.outPoint}],outputs:[{lock,capacity:proof.cellOutput.capacity}],outputsData:['0x']});setup.setWitnessArgs(0,{lock:ccc.hexFrom(new Uint8Array(620))});
 const quote=await service.quote(ccc.hexFrom(setup.toBytes()));await assert.rejects(service.quote(ccc.hexFrom(action.toBytes())),/confirmed owner-authorized funding/);
 const signed=ccc.Transaction.fromBytes(quote.bytes),challenge=pilotPasskeyDigest(signed,0,1);const auth=ccc.bytesConcat(sha256(new TextEncoder().encode(identity.rpId)),[5],new Uint8Array(4));const json=new TextEncoder().encode(JSON.stringify({type:'webauthn.get',origin:identity.origin,challenge:base64url(ccc.bytesFrom(challenge)),crossOrigin:false}));const assertion={authenticatorData:ccc.hexFrom(auth),clientDataJSON:ccc.hexFrom(json),signature:ccc.hexFrom(p256.sign(sha256(ccc.bytesConcat(auth,sha256(json))),ccc.bytesFrom(hash(3)),{prehash:false}))};assert.equal(verifyPilotAssertion(identity,challenge,assertion),true);signed.setWitnessArgs(0,{lock:encodePilotAssertion(assertion,1)});await service.submit(quote.id,ccc.hexFrom(signed.toBytes()));
 await assert.rejects(service.quote(ccc.hexFrom(action.toBytes())),/confirmed owner-authorized funding/);
 const fresh=ccc.Cell.from({outPoint:{txHash:hash(42),index:0},cellOutput:{lock:f.pool,capacity:ccc.fixedPointFrom(100)},outputData:'0x'});f.cells.push(fresh);t.mock.method(f.client,'getCellLive',async(p:ccc.OutPointLike)=>ccc.OutPoint.from(p).eq(f.funding.outPoint)?undefined:f.cells.find(c=>c.outPoint.eq(p)));t.mock.method(f.client,'findCellsByLock',async function*(){yield fresh;});t.mock.method(f.client,'getTransactionNoCache',async(h:ccc.Hex)=>h===quote.transactionHash?{status:'committed'}:undefined);
 const next=await service.quote(ccc.hexFrom(action.toBytes()));const data=JSON.parse(await readFile(f.store.file,'utf8'));assert.equal(data.records.find((r:{quote:SponsorQuote})=>r.quote.id===next.id).owner,owner.hash());assert.equal(data.records.find((r:{quote:SponsorQuote})=>r.quote.id===quote.id).owner,owner.hash());
 // Root owner-only transactions use the full owner hash too, not a truncated P-256 public key.
 const root=ccc.Transaction.from({inputs:[{previousOutput:proof.outPoint}],outputs:[proof.cellOutput],outputsData:['0x']});root.setWitnessArgs(0,{lock:ccc.hexFrom(new Uint8Array(620))});const rootQuote=await service.quote(ccc.hexFrom(root.toBytes()));const latest=JSON.parse(await readFile(f.store.file,'utf8'));assert.equal(latest.records.find((r:{quote:SponsorQuote})=>r.quote.id===rootQuote.id).owner,owner.hash());
});
