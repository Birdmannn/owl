import { test, expect } from '@playwright/test';
import { injectWallet } from './wallet-fixture';
import { connectThroughPilot, createProfile } from './pilot-flow';

test('two users from the same extension keep distinct profiles and account hints', async ({ page, context }) => {
  const wallet = await injectWallet(context); await page.goto('/'); await connectThroughPilot(page); await createProfile(page, 'pilot_user_a');
  const addressA = (await page.getByRole('button', { name: 'Copy CKB address' }).getAttribute('title'))!;
  await page.getByRole('button', { name: 'Close Pilot' }).click();
  await wallet.selectAccount(1);
  await expect(page.getByRole('button', { name: 'Copy CKB address' })).not.toHaveAttribute('title', addressA);
  await expect(page.getByRole('button', { name: 'Open Pilot' })).toBeEnabled();
  await page.getByRole('button', { name: 'Open Pilot' }).click();
  await expect(page.getByRole('textbox', { name: 'Username', exact: true })).toHaveValue('');
  await createProfile(page, 'pilot_user_b');
  const addressB = (await page.getByRole('button', { name: 'Copy CKB address' }).getAttribute('title'))!;
  expect(addressA).not.toEqual(addressB);
  await expect(page.locator('.pilot-accounts')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add JoyID account', exact: true })).toHaveCount(0);
  await wallet.selectAccount(0);
  // The extension now reports A; Pilot restores A’s profile, never B’s.
  await expect(page.getByRole('button', { name: 'Create Pilot profile' })).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Sign these on my behalf' }).getByText('@pilot_user_a', { exact: true })).toBeVisible();
});

test('the modal does not expose external account addition while a social action is queued', async ({ page, context }) => {
  await injectWallet(context); await page.goto('/'); await connectThroughPilot(page); await createProfile(page, 'pilot_queue_user');
  await page.getByRole('button', { name: 'Close Pilot' }).click();
  const panel = page.getByRole('region', { name: 'Off-chain social demo' });
  await panel.getByRole('button', { name: 'Enable social signing' }).click();
  await page.getByRole('checkbox', { name: /Like posts/ }).check();
  await page.getByRole('button', { name: 'Approve selected off-chain actions' }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  // Hold the app store lock so the signed action remains in flight until explicitly released.
  await page.evaluate(() => new Promise<void>(resolve => {
    void navigator.locks.request('pilot:social:local-state:' + location.origin, () => new Promise<void>(release => {
      (window as unknown as {pilotTestReleaseSocial:()=>void}).pilotTestReleaseSocial = release; resolve();
    }));
  }));
  await panel.getByRole('button', { name: 'Like · 0', exact: true }).click();
  await page.getByRole('button', { name: 'Open Pilot' }).click();
  await expect(page.locator('.pilot-accounts')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add account / choose wallet' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add JoyID account', exact: true })).toHaveCount(0);
  await page.evaluate(() => (window as unknown as {pilotTestReleaseSocial:()=>void}).pilotTestReleaseSocial());
  await expect(panel.getByRole('button', { name: 'Unlike · 1', exact: true })).toBeEnabled();
});
