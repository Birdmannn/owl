import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, generateKeyPairSync, createHash, sign } from 'node:crypto';
import { ccc } from '@ckb-ccc/core';
import { Wallet } from 'ethers';
import { JsonRegistryStore } from '../server/registry-store.js';
import { createRegistryServer, verifiedProfile } from '../server/registry.js';
import { normalizeUsername, parseCkbAmount, PilotUsernameClient, prepareCkbToUsername, prepareSporeToUsername } from '../src/usernames.js';
import { getSporeScriptInfo } from '@ckb-ccc/spore';
import { packRawSporeData } from '@ckb-ccc/spore/advanced';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'pilot-usernames-'));
  const store = new JsonRegistryStore(join(directory, 'names.json')); await store.init();
  const server = createRegistryServer({store,network:'ckb-testnet',origin:'https://registry.pilot.test',allowedOrigins:['https://app.pilot.test']});
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
  const address = server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}/api/pilot`;
  const post = (path: string, data: unknown) => fetch(`${url}${path}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  return {store, directory, server, url, post, client:new PilotUsernameClient(url), async close(){await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(directory,{recursive:true,force:true});}};
}
const nodeClient = new ccc.ClientPublicTestnet();
const wallet = (key = '11') => new ccc.SignerCkbPrivateKey(nodeClient, `0x${key.repeat(32)}`);

test('usernames normalize consistently; amount parsing preserves shannons', () => {
  assert.equal(normalizeUsername(' @OwL_123 '),'owl_123');
  assert.throws(()=>normalizeUsername('bad/name'));
  assert.equal(parseCkbAmount('100.00000001'),10_000_000_001n);
  assert.throws(()=>parseCkbAmount('1.000000001'));assert.throws(()=>parseCkbAmount('0'));
});
test('real wallet proof registers, resolves and survives server/store restart; replay and collisions fail',async()=>{
  const f = await fixture();
  try {
    const signer=wallet(), identity=await signer.getIdentity(), ownerAddress=await signer.getRecommendedAddress();
    const challenge=await (await f.post('/challenges',{username:'OwL_Registry',ownerAddress,identity,signType:signer.signType})).json();
    const signature=await signer.signMessage(challenge.message);
    const result=await f.post('/usernames',{challengeId:challenge.id,signature});assert.equal(result.status,201);
    assert.equal((await f.client.resolve('@OWL_REGISTRY','ckb-testnet')).ownerAddress,ownerAddress);
    assert.equal((await f.client.findByAddress(ownerAddress))?.username,'owl_registry');
    assert.equal((await f.post('/usernames',{challengeId:challenge.id,signature})).status,409);
    await assert.rejects(f.client.register(wallet('22'),'owl_registry'),/already/);
    await assert.rejects(f.client.register(signer,'second_name'),/already/);
    signer.signMessage=async()=>{throw new Error('An existing name must not require another signature');};
    assert.equal((await f.client.register(signer,'@OWL_REGISTRY')).username,'owl_registry');
    await assert.rejects(f.client.resolve('owl_registry','ckb-mainnet'),/different/);
    const second=new JsonRegistryStore(f.store.file);await second.init();assert.equal((await second.get('owl_registry'))?.ownerAddress,ownerAddress);
    const contents=await readFile(f.store.file,'utf8');assert.ok(!contents.includes('privateKey'));assert.ok(!contents.includes('signature'));
  }finally{await f.close();}
});
test('registration rejects spoofed addresses, mismatched signatures, expired challenges and foreign origins',async()=>{
  const f=await fixture();try{
    const signer=wallet(), identity=await signer.getIdentity(), ownerAddress=await signer.getRecommendedAddress();
    const claim={username:'honest_pilot',ownerAddress,identity,signType:signer.signType};
    assert.equal((await f.post('/challenges',{...claim,ownerAddress:await wallet('22').getRecommendedAddress()})).status,400);
    const challenge=await (await f.post('/challenges',claim)).json();
    const forged=await wallet('22').signMessage(challenge.message);
    assert.equal((await f.post('/usernames',{challengeId:challenge.id,signature:forged})).status,400);
    const signature=await signer.signMessage('another message');
    assert.equal((await f.post('/usernames',{challengeId:challenge.id,signature})).status,401);
    const data=JSON.parse(await readFile(f.store.file,'utf8'));data.challenges[0].expiresAt=0;await writeFile(f.store.file,JSON.stringify(data));
    assert.equal((await f.post('/usernames',{challengeId:challenge.id,signature})).status,409);
    const foreign=await fetch(`${f.url}/challenges`,{method:'POST',headers:{Origin:'https://evil.test','Content-Type':'application/json'},body:JSON.stringify(claim)});assert.equal(foreign.status,403);
  }finally{await f.close();}
});
test('JSON fallback serializes competing processes/instances; exactly one conflicting name wins',async()=>{
  const f=await fixture();try{
    const other=new JsonRegistryStore(f.store.file);await other.init();
    const make=async(key:string)=>({id:randomUUID(),message:'test',expiresAt:Date.now()+60_000,profile:await verifiedProfile({username:'one_pilot',ownerAddress:await wallet(key).getRecommendedAddress(),identity:await wallet(key).getIdentity(),signType:ccc.SignerSignType.CkbSecp256k1},'ckb-testnet')});
    const a=await make('11'),b=await make('22');await Promise.all([f.store.challenge(a),other.challenge(b)]);
    const results=await Promise.allSettled([f.store.claim(a.id),other.claim(b.id)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    assert.equal(JSON.parse(await readFile(f.store.file,'utf8')).profiles.length,1);
  }finally{await f.close();}
});
test('simultaneous JSON initialization does not expose a partial file or reset existing records',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'pilot-init-'));
  try{
    const file=join(directory,'names.json');
    const stores=Array.from({length:4},()=>new JsonRegistryStore(file));await Promise.all(stores.map(store=>store.init()));
    const data=JSON.parse(await readFile(file,'utf8'));assert.equal(data.version,1);assert.deepEqual(data.profiles,[]);
    await writeFile(file,'broken JSON');await assert.rejects(stores[0]!.init());assert.equal(await readFile(file,'utf8'),'broken JSON');
  }finally{await rm(directory,{recursive:true,force:true});}
});
test('EVM wallet registration verifies its CKB OmniLock recipient and personal signature',async()=>{
  const f=await fixture();try{
    const evm=new Wallet(`0x${'33'.repeat(32)}`), signer=new ccc.SignerEvmAddressReadonly(nodeClient,evm.address);
    const claim={username:'evm_pilot',ownerAddress:await signer.getRecommendedAddress(),identity:evm.address,signType:ccc.SignerSignType.EvmPersonal};
    const challenge=await (await f.post('/challenges',claim)).json();assert.ok(challenge.message);
    const signature={identity:evm.address,signType:ccc.SignerSignType.EvmPersonal,signature:await evm.signMessage(challenge.message)};
    assert.equal((await f.post('/usernames',{challengeId:challenge.id,signature})).status,201);
    assert.equal((await f.client.resolve('evm_pilot','ckb-testnet')).provider,'wallet');
  }finally{await f.close();}
});
test('Nostr and Dogecoin wallets register with their native signed identities',async()=>{
  const f=await fixture();try{
    const nostr=new ccc.SignerNostrPrivateKey(nodeClient,`0x${'55'.repeat(32)}`);
    const doge=new ccc.SignerDogePrivateKey(nodeClient,`0x${'66'.repeat(32)}`);
    const a=await f.client.register(nostr,'nostr_pilot'),b=await f.client.register(doge,'doge_pilot');
    assert.equal(a.identity,await nostr.getIdentity());assert.equal(b.identity,await doge.getIdentity());
  }finally{await f.close();}
});
test('JoyID registration binds a real P-256 WebAuthn signature and rejects challenge replacement',async()=>{
  const f=await fixture();try{
    const keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),jwk=keys.publicKey.export({format:'jwk'});
    const publicKey=Buffer.concat([Buffer.from(jwk.x!,'base64url'),Buffer.from(jwk.y!,'base64url')]).toString('hex');
    const ownerAddress=(await ccc.Address.fromKnownScript(nodeClient,ccc.KnownScript.JoyId,`0x0001${ccc.hashCkb(`0x${publicKey}`).slice(2,42)}`)).toString();
    const identity=JSON.stringify({keyType:'main_key',publicKey});
    const challenge=await (await f.post('/challenges',{username:'joy_pilot',ownerAddress,identity,signType:ccc.SignerSignType.JoyId})).json();assert.ok(challenge.message);
    const proof=(message:string)=>{
      const auth=Buffer.alloc(37);auth[32]=5;
      const clientData=Buffer.from(JSON.stringify({type:'webauthn.get',origin:'https://testnet.joyid.dev',challenge:Buffer.from(message).toString('base64url')}));
      const bytes=Buffer.concat([auth,createHash('sha256').update(clientData).digest()]);
      return {signature:sign('sha256',bytes,keys.privateKey).toString('base64url'),alg:-7,message:Buffer.concat([auth,clientData]).toString('base64url')};
    };
    const forged=JSON.stringify({...proof('attacker challenge'),challenge:'attacker challenge',pubkey:publicKey,keyType:'main_key'});
    assert.equal((await f.post('/usernames',{challengeId:challenge.id,signature:{identity,signType:ccc.SignerSignType.JoyId,signature:forged}})).status,401);
    const signature={identity,signType:ccc.SignerSignType.JoyId,signature:JSON.stringify(proof(challenge.message))};
    assert.equal((await f.post('/usernames',{challengeId:challenge.id,signature})).status,201);
    const profile=await f.client.resolve('joy_pilot','ckb-testnet');assert.equal(profile.passkeyPublicKey,publicKey);assert.equal(profile.provider,'joyid');
    await assert.rejects(verifiedProfile({username:'wrong_joy',ownerAddress,identity:JSON.stringify({keyType:'sub_key',publicKey}),signType:ccc.SignerSignType.JoyId},'ckb-testnet'),/primary JoyID/);
  }finally{await f.close();}
});
test('CKB username builder preserves reviewed recipient lock and refuses below minimum capacity',async()=>{
  const f=await fixture();try{
    const recipient=await f.client.register(wallet('22'),'recipient_pilot');
    let output:ccc.Transaction|undefined;
    const fakeClient=Object.create(nodeClient) as ccc.Client;
    const signer=new ccc.SignerCkbPrivateKey(fakeClient, `0x${'11'.repeat(32)}`);
    fakeClient.findCells=async function*(){yield ccc.Cell.from({outPoint:{txHash:`0x${'ab'.repeat(32)}`,index:0},cellOutput:{capacity:ccc.fixedPointFrom(1000),lock:(await signer.getRecommendedAddressObj()).script},outputData:'0x'});};
    fakeClient.getFeeRate=async()=>1000n;
    const prepared=await prepareCkbToUsername(f.client,signer,'@recipient_pilot',ccc.fixedPointFrom(100));output=prepared.tx;
    assert.ok(output.outputs[0]!.lock.eq((await ccc.Address.fromString(recipient.ownerAddress,nodeClient)).script));
    assert.equal(output.outputs[0]!.capacity,ccc.fixedPointFrom(100));assert.ok(prepared.fee>0n);
    await assert.rejects(prepareCkbToUsername(f.client,signer,'recipient_pilot',1n),/at least/);
  }finally{await f.close();}
});
test('Spore username builder preserves NFT type/data, resolves the owner lock, and rejects foreign NFTs',async()=>{
  const f=await fixture();try{
    const recipient=await f.client.register(wallet('22'),'nft_recipient');
    const fakeClient=Object.create(nodeClient) as ccc.Client;
    const signer=new ccc.SignerCkbPrivateKey(fakeClient,`0x${'11'.repeat(32)}`);
    const owner=(await signer.getRecommendedAddressObj()).script;
    const id=`0x${'cd'.repeat(32)}` as ccc.Hex, info=getSporeScriptInfo(fakeClient);
    const cell=ccc.Cell.from({outPoint:{txHash:`0x${'ac'.repeat(32)}`,index:0},cellOutput:{lock:owner,type:{codeHash:info.codeHash,hashType:info.hashType,args:id},capacity:ccc.fixedPointFrom(500)},outputData:packRawSporeData({contentType:'text/plain',content:'0x70696c6f74'})});
    fakeClient.findSingletonCellByType=async()=>cell;
    fakeClient.findCells=async function*(){yield ccc.Cell.from({outPoint:{txHash:`0x${'ab'.repeat(32)}`,index:0},cellOutput:{capacity:ccc.fixedPointFrom(1000),lock:owner},outputData:'0x'});};
    fakeClient.getFeeRate=async()=>1000n;
    const result=await prepareSporeToUsername(f.client,signer,'nft_recipient',id);
    assert.ok(result.tx.outputs[0]!.type?.eq(cell.cellOutput.type!));assert.equal(result.tx.outputsData[0],cell.outputData);
    assert.ok(result.tx.outputs[0]!.lock.eq((await ccc.Address.fromString(recipient.ownerAddress,nodeClient)).script));
    fakeClient.findSingletonCellByType=async()=>ccc.Cell.from({...cell,cellOutput:{...cell.cellOutput,lock:(await wallet('33').getRecommendedAddressObj()).script}});
    await assert.rejects(prepareSporeToUsername(f.client,signer,'nft_recipient',id),/not owned/);
  }finally{await f.close();}
});
