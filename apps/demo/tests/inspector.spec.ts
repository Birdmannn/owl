import { test, expect } from '@playwright/test';
import { ccc } from '@ckb-ccc/core';
import { JsonRpcTransformers } from '@ckb-ccc/core/advanced';
import { readFile } from 'node:fs/promises';
import { injectWallet } from './wallet-fixture';
import { connectThroughPilot, createProfile } from './pilot-flow';
import manifest from '../../../deployments/testnet.json' with { type: 'json' };
test('inspects durable queue, errors, raw transactions, and exports without the session key', async ({page,context}) => {
  await injectWallet(context);
  let receiptAvailable = false;
  let transaction: ccc.Transaction | undefined;
  let previous: ccc.Transaction | undefined;
  await page.route('https://testnet.ckb.dev/**',async route=>{
    const body=route.request().postDataJSON();
    if(body?.method==='get_transaction') {
      const tx = body.params[0] === transaction?.hash() ? transaction : body.params[0] === previous?.hash() ? previous : undefined;
      const result = receiptAvailable && tx ? {transaction:JsonRpcTransformers.transactionFrom(tx),cycles:'0x3f7a00',tx_status:{status:'committed',block_number:'0x64',block_hash:`0x${'ee'.repeat(32)}`,tx_index:'0x0'}} : {transaction:null,tx_status:{status:'unknown'}};
      await route.fulfill({json:{jsonrpc:'2.0',id:body.id,result}});
    } else if (body?.method === 'get_tip_block_number') await route.fulfill({json:{jsonrpc:'2.0',id:body.id,result:'0x65'}});
    else await route.continue();
  });
  await page.goto('/');
  await connectThroughPilot(page); await createProfile(page); await page.getByRole('button',{name:'Close Pilot'}).click();
  const address=await page.getByRole('button',{name:'Copy CKB address'}).getAttribute('title');
  const key=`pilot-demo:v1:${manifest.deployment.codeHash}:${address}`;
  previous=ccc.Transaction.from({outputs:[{lock:{codeHash:manifest.deployment.codeHash,hashType:'data2',args:'0x'},capacity:15_002_000_000n}],outputsData:['0x']});
  const tx=transaction=ccc.Transaction.from({inputs:[{previousOutput:{txHash:previous.hash(),index:0}}],outputs:[{lock:{codeHash:manifest.deployment.codeHash,hashType:'data2',args:'0x'},capacity:15_001_900_000n}],outputsData:['0xe0fd1c00000000000100000000000000'],witnesses:['0x01']});
  const bytes=ccc.hexFrom(tx.toBytes()),hash=tx.hash();
  await page.evaluate(({key,bytes,hash})=>{
    const at=Date.now();
    localStorage.setItem(key,JSON.stringify({privateKey:'TEST_SECRET_MUST_NOT_EXPORT',session:{id:'inspection-test',network:'ckb-testnet',policyVersion:'counter-v1',expiresAt:at+60000}}));
    localStorage.setItem(`${key}:inspection-test:pilot`,JSON.stringify({queue:[{id:'move-1',cost:'100000'},{id:'move-2',cost:'100000'}]}));
    localStorage.setItem(`${key}:activity`,JSON.stringify([
      {id:'approval',sessionId:'inspection-test',kind:'authorization',title:'Session approval',status:'confirmed',createdAt:at-1000,logs:[{at:at-1000,phase:'confirmed',message:'Session funding confirmed.'}]},
      {id:'move-1',sessionId:'inspection-test',kind:'move',title:'Move 1',status:'retry',cost:'100000',hash,bytes,createdAt:at,logs:[{at,phase:'accepted',message:'Action persisted and budget reserved.'},{at:at+1,phase:'broadcasting',message:'Broadcasting signed transaction.'},{at:at+2,phase:'retry',message:'Response lost. Same signed bytes retained.',error:{name:'TransportError',message:'RPC connection interrupted'}}]},
      {id:'move-2',sessionId:'inspection-test',kind:'move',title:'Move 2',status:'queued',cost:'100000',createdAt:at+1,logs:[{at:at+1,phase:'accepted',message:'Waiting for the previous move to settle.'}]},
    ]));
    window.dispatchEvent(new CustomEvent('pilot-activity',{detail:key}));
  },{key,bytes,hash});
  const inspector=page.getByRole('region',{name:'Transaction inspector'});
  await expect(inspector.getByRole('heading',{name:'Transaction queue & logs'})).toBeVisible();
  await expect(inspector.getByRole('button',{name:'Queue (2)',exact:true})).toBeVisible();
  await expect(inspector.locator('.inspector-stats').getByText('0.002 CKB',{exact:true})).toBeVisible();
  const detail=page.getByRole('article',{name:'Transaction details'});
  await expect(detail.getByRole('heading',{name:'Move 1',exact:true})).toBeVisible();
  await expect(detail.getByText('TransportError: RPC connection interrupted',{exact:true})).toBeVisible();
  await expect(detail.getByText(hash,{exact:true})).toBeVisible();
  await expect(detail.getByText(/The node does not currently know this hash/)).toBeVisible();
  receiptAvailable = true;
  await detail.getByRole('button',{name:'Refresh ↻',exact:true}).click();
  await expect(detail.getByText('committed',{exact:true})).toBeVisible();
  await expect(detail.getByText('4160000',{exact:true})).toBeVisible();
  await expect(detail.locator('.tx-fields > div').filter({hasText:'Actual transaction fee'})).toContainText('0.001 CKB (100000 shannons)');
  await expect(detail.locator('.tx-fields > div').filter({hasText:'Confirmations'})).toContainText('2');
  await detail.getByText('Transaction structure',{exact:false}).click();
  await expect(detail.getByText('Serialized size',{exact:true})).toBeVisible();
  await inspector.getByRole('button',{name:/^Move 2/}).click();
  await expect(detail.getByText('2 of 2',{exact:true})).toBeVisible();
  await expect(detail.getByText('Not signed yet. Waiting for earlier queue entries.',{exact:true})).toBeVisible();
  await inspector.getByRole('button',{name:'Errors & retries',exact:true}).click();
  await expect(detail.getByRole('heading',{name:'Move 1',exact:true})).toBeVisible();
  await expect(inspector.getByRole('button',{name:/^Move 2/})).toHaveCount(0);
  const downloadPromise=page.waitForEvent('download'); await inspector.getByRole('button',{name:'Export logs ↓'}).click();
  const download=await downloadPromise; const exported=await readFile((await download.path())!,'utf8');
  expect(exported).toContain(hash);expect(exported).toContain('RPC connection interrupted');expect(exported).not.toContain('TEST_SECRET_MUST_NOT_EXPORT');expect(exported).not.toContain('privateKey');
  await page.reload(); await expect(inspector.getByRole('button',{name:'Queue (2)',exact:true})).toBeVisible();
  await expect(detail.getByText('TransportError: RPC connection interrupted',{exact:true})).toBeVisible();
  await inspector.scrollIntoViewIfNeeded();await page.screenshot({path:'test-results/inspector.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
