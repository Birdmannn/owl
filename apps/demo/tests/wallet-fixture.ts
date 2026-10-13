import type { BrowserContext } from '@playwright/test';
import { Wallet } from 'ethers';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonRegistryStore } from '../../../server/registry-store';
import { createRegistryServer } from '../../../server/registry';
export async function injectWallet(context: BrowserContext) {
  const wallet = Wallet.createRandom();
  const directory = await mkdtemp(join(tmpdir(),'pilot-browser-registry-'));
  const store = new JsonRegistryStore(join(directory,'names.json'));await store.init();
  const server = createRegistryServer({store,network:'ckb-testnet',origin:'http://127.0.0.1:5180',allowedOrigins:['http://127.0.0.1:5174']});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port = (server.address() as {port:number}).port;
  await context.route('**/api/pilot/**',async route=>{
    const path=new URL(route.request().url()).pathname;
    const response=await fetch(`http://127.0.0.1:${port}${path}`,{method:route.request().method(),headers:{'Content-Type':'application/json'},...(route.request().postData()?{body:route.request().postData()!}:{})});
    await route.fulfill({status:response.status,contentType:'application/json',body:await response.text()});
  });
  context.once('close',()=>{server.close(()=>void rm(directory,{recursive:true,force:true}));});
  await context.exposeFunction('pilotTestSignMessage',async(message:string)=>wallet.signMessage(message.startsWith('0x')?Buffer.from(message.slice(2),'hex'):message));
  await context.addInitScript(({address}) => {
    const provider = {
      request: async ({method,params}: {method: string;params?:string[]}) => {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [address];
        if (method === 'eth_chainId') return '0x1';
        if (method === 'personal_sign') return (window as unknown as {pilotTestSignMessage:(message:string)=>Promise<string>}).pilotTestSignMessage(params![0]!);
        throw new Error(`Unexpected wallet method: ${method}`);
      }, on: () => {}, removeListener: () => {},
    };
    window.addEventListener('eip6963:requestProvider', () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {detail: {provider, info: {uuid:'a30c27c5-1322-4a79-bbca-284552873af4',name:'Pilot Test Wallet',icon:'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>',rdns:'test.pilot.wallet'}}})));
  },{address:wallet.address});
}
