import { test, expect } from '@playwright/test';
import { ccc } from '@ckb-ccc/core';
import { JsonRpcTransformers } from '@ckb-ccc/core/advanced';
import { injectWallet } from './wallet-fixture';
import { connectThroughPilot, createProfile } from './pilot-flow';
test('username transfer resolves the shared registration, reviews the correct CKB lock, and blocks unreviewed sending',async({page,context})=>{
  await injectWallet(context);await page.goto('/');await connectThroughPilot(page);await createProfile(page,'transfer_pilot');
  await page.getByRole('button',{name:'Close Pilot'}).click();
  const address=await page.getByRole('button',{name:'Copy CKB address'}).getAttribute('title');
  const lock=(await ccc.Address.fromString(address!,new ccc.ClientPublicTestnet())).script;
  const funding=ccc.Transaction.from({outputs:[{lock,capacity:ccc.fixedPointFrom(1000)}],outputsData:['0x']});
  let submitted:ccc.Transaction|undefined;
  let broadcasts=0;
  await page.route('https://testnet.ckb.dev/**',async route=>{
    const request=route.request().postDataJSON();
    if(request?.method==='get_cells') {
      await route.fulfill({json:{jsonrpc:'2.0',id:request.id,result:{last_cursor:'0x01',objects:[{block_number:'0x64',tx_index:'0x0',out_point:{tx_hash:funding.hash(),index:'0x0'},output:JsonRpcTransformers.cellOutputFrom(funding.outputs[0]),output_data:'0x'}]}}});
    }else if(request?.method==='send_transaction') {
      submitted=JsonRpcTransformers.transactionTo(request.params[0]);broadcasts++;
      await route.fulfill({json:{jsonrpc:'2.0',id:request.id,result:submitted.hash()}});
    }else if(request?.method==='get_transaction') {
      const transaction=submitted&&submitted.hash()===request.params[0]?submitted:funding;
      await route.fulfill({json:{jsonrpc:'2.0',id:request.id,result:{transaction:JsonRpcTransformers.transactionFrom(transaction),tx_status:{status:'committed',block_number:'0x64',block_hash:`0x${'ee'.repeat(32)}`,tx_index:'0x0'}}}});
    }else if(request?.method==='get_tip_header') {
      const zero=`0x${'00'.repeat(32)}`;
      await route.fulfill({json:{jsonrpc:'2.0',id:request.id,result:{hash:zero,version:'0x0',compact_target:'0x0',timestamp:'0x0',number:'0x65',epoch:'0x0',parent_hash:zero,transactions_root:zero,proposals_hash:zero,extra_hash:zero,dao:zero,nonce:'0x0'}}});
    }else await route.continue();
  });
  await page.getByRole('textbox',{name:'Recipient username',exact:true}).fill('@missing_pilot');
  await page.getByRole('textbox',{name:'Amount (CKB)'}).fill('100');await page.getByRole('button',{name:'Review transfer'}).click();
  await expect(page.getByText('Pilot username not found',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Sign and send'})).not.toBeVisible();
  await page.getByRole('textbox',{name:'Recipient username',exact:true}).fill('@TRANSFER_PILOT');
  await page.getByRole('button',{name:'Review transfer'}).click();
  const review=page.getByRole('region',{name:'Review transfer'});await expect(review).toBeVisible();
  await expect(review.locator('code')).toHaveText(address!);
  await expect(review.getByText('@transfer_pilot',{exact:true})).toBeVisible();
  await expect(review.getByRole('button',{name:'Sign and send'})).toBeEnabled();
  await review.getByRole('button',{name:'Cancel transfer'}).click();await expect(review).not.toBeVisible();
  await page.getByRole('button',{name:'Review transfer'}).click();await expect(review).toBeVisible();
  await review.getByRole('button',{name:'Sign and send'}).click();
  await expect(page.getByText('CKB → @transfer_pilot · confirmed',{exact:true})).toBeVisible();
  expect(broadcasts).toBe(1);
  await page.getByText('Transaction details and logs',{exact:true}).click();
  await expect(page.locator('.transfer-history pre')).toContainText('signedBytes');
  await expect(page.locator('.transfer-history pre')).toContainText('committed');
  await expect(page.locator('.transfer-history ol')).toContainText('Owner signed');
  await page.reload();await expect(page.getByText('CKB → @transfer_pilot · confirmed',{exact:true})).toBeVisible();
  expect(broadcasts).toBe(1);
  await page.getByLabel('Asset',{exact:true}).selectOption('Spore NFT');
  await expect(page.getByRole('textbox',{name:'Spore ID'})).toBeVisible();
});
