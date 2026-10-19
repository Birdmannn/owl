import { test, expect } from '@playwright/test';
import { injectWallet } from './wallet-fixture';
import { connectThroughPilot, createProfile } from './pilot-flow';
import { DELEGATION_V1_CODE_HASH } from '../../../src/index';

test('developer manifest renders independent named permissions and declining creates no session', async ({ page, context }) => {
  await injectWallet(context); await page.goto('/'); await connectThroughPilot(page); await createProfile(page);
  await page.getByRole('button', { name: 'Close Pilot' }).click();
  const panel = page.locator('.delegation-demo');
  await panel.getByLabel('Deployment JSON').setInputFiles({ name: 'test-only-deployment.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ deployment: {
    network: 'testnet', codeHash: DELEGATION_V1_CODE_HASH,
    genesisHash: '0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606',
    outPoint: { txHash: '0x' + '01'.repeat(32), index: 0 },
  } })) });
  await panel.getByRole('button', { name: 'Connect through Pilot' }).click();
  const dialog = page.getByRole('dialog', { name: 'Sign these on my behalf' });
  await expect(dialog.getByRole('checkbox')).toHaveCount(2);
  await dialog.getByRole('spinbutton',{name:'Your action budget'}).fill('7');
  await dialog.getByText('Inspect app manifest',{exact:true}).click();
  await expect(dialog.locator('.manifest-details pre')).toContainText('"budget": "700000"');
  const forward = dialog.getByRole('checkbox', { name: /Move forward/ });
  const backward = dialog.getByRole('checkbox', { name: /Move backward/ });
  await expect(forward).not.toBeChecked(); await expect(backward).not.toBeChecked();
  await forward.check(); await expect(forward).toBeChecked(); await expect(backward).not.toBeChecked();
  await backward.check(); await forward.uncheck(); await expect(backward).toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: /Jump/ })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Continue without automatic signing' }).click();
  await expect(dialog).not.toBeVisible();
  const funded = await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('pilot:cell-delegation:') && /:(session|setup|settlement)$/.test(key)));
  expect(funded).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await panel.getByRole('button', { name: 'Connect through Pilot' }).click();
  await expect(dialog.getByRole('checkbox', { name: /Move backward/ })).not.toBeChecked();
});
