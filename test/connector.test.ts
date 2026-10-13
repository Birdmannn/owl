import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ccc } from '@ckb-ccc/core';
import { COUNTER_V1_CODE_HASH, createCounterGrant, assertCounterPermission, counterManifestHash, PilotCounterConnector, type PilotManifest } from '../src/index.js';
const hex=`0x${'01'.repeat(32)}` as ccc.Hex;
const manifest:PilotManifest={version:1,app:{id:'owl.flight',name:'Owl Flight',description:'One-step moves'},permissions:[{id:'counter.increment',name:'Fly forward',description:'Advance one step'}],policy:{kind:'counter-v1',deployment:{network:'testnet',codeHash:COUNTER_V1_CODE_HASH,genesisHash:hex,outPoint:{txHash:hex,index:0}},feePerMove:'100000',budget:'2000000',floorCapacity:'15000000000'}};
test('permission grants reject unselected, unknown, and duplicate actions before touching the owner wallet',async()=>{
  const owner={} as ccc.Signer;
  const connector=new PilotCounterConnector(owner,manifest);
  assert.equal(connector.name,'Pilot');
  assert.throws(()=>new PilotCounterConnector(owner,{...manifest,policy:{...manifest.policy,deployment:{...manifest.policy.deployment,codeHash:hex}}}),/Unrecognized counter-v1 script/);
  for(const selected of [[],['counter.decrement'],['counter.increment','counter.increment']]){
    await assert.rejects(connector.authorize(selected,{sessionPublicKey:hex}),/Select Fly forward/);
  }
  assert.throws(()=>new PilotCounterConnector(owner,{...manifest,permissions:[{id:'transfer' as never,name:'Transfer',description:'Anything'}]}),/supports only/);
});
test('grants bind the app manifest and require fresh approval for changed limits or labels',()=>{
  const grant=createCounterGrant(manifest,['counter.increment']);
  assert.doesNotThrow(()=>assertCounterPermission(manifest,grant,'counter.increment'));
  assert.throws(()=>assertCounterPermission(manifest,grant,'counter.decrement'),/outside/);
  assert.throws(()=>assertCounterPermission({...manifest,policy:{...manifest.policy,budget:'3000000'}},grant,'counter.increment'),/Fresh approval/);
  assert.throws(()=>assertCounterPermission({...manifest,app:{...manifest.app,name:'Another app'}},grant,'counter.increment'),/Fresh approval/);
  assert.throws(()=>assertCounterPermission(manifest,{...grant,permissions:[]},'counter.increment'),/outside/);
  const reordered={policy:manifest.policy,permissions:manifest.permissions,app:manifest.app,version:1} as PilotManifest;
  assert.equal(counterManifestHash(reordered),counterManifestHash(manifest));
});
