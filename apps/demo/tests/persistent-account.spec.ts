import { test, expect } from '@playwright/test';
import { injectWallet } from './wallet-fixture';
import { connectThroughPilot } from './pilot-flow';
test('new account setup stays blocked without a deployment and does not silently use the old counter lock', async ({ page, context }) => {
  await injectWallet(context); await page.goto('/');
  const panel=page.getByRole('region',{name:'Persistent Pilot account'});
  await expect(panel.getByRole('heading',{name:'Your Pilot, your app account.'})).toBeVisible();
  await expect(panel.getByText(/Account setup is unavailable until the new account lock is deployed/)).toBeVisible();
  await expect(panel.getByRole('button',{name:'Review Pilot account setup'})).toHaveCount(0);
  await connectThroughPilot(page); await page.getByRole('button',{name:'Close Pilot'}).click();
  await panel.getByText('Recover with a saved public descriptor').click();
  await panel.getByLabel('Public account recovery descriptor').setInputFiles({name:'invalid.json',mimeType:'application/json',buffer:Buffer.from('{}')});
  await expect(panel.getByRole('alert')).toContainText('Unsupported Pilot account deployment');
  const keys=await page.evaluate(()=>Object.keys(localStorage).filter(key=>key.startsWith('pilot:account:v1:')&&key.endsWith(':key')));
  expect(keys).toEqual([]);
});
