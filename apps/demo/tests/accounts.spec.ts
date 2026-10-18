import { test, expect } from '@playwright/test';
import { ccc } from '@ckb-ccc/core';
import { p256 } from '@noble/curves/nist.js';
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
  await page.getByRole('button', { name: 'Accounts in this browser (2)' }).click();
  await expect(page.locator('.pilot-accounts li')).toHaveCount(2);
  // The extension owns its selected account. Pilot must reconnect rather than relabel B as A.
  await page.locator('.pilot-accounts li').filter({ hasText: addressA }).getByRole('button').click();
  await page.locator('ccc-connector').getByText('Pilot Test Wallet', { exact: true }).click();
  await expect(page.getByText('The wallet returned a different account. Select the requested account in your wallet.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Fly forward' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Open Pilot' })).not.toBeVisible();
  await wallet.selectAccount(0);
  // The extension now reports A; Pilot restores A’s profile, never B’s.
  await expect(page.getByRole('button', { name: 'Continue as @pilot_user_a' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue as @pilot_user_a' }).click();
  await expect(page.getByRole('dialog', { name: 'Sign these on my behalf' }).getByText('@pilot_user_a', { exact: true })).toBeVisible();
});

test('JoyID adds fresh accounts, switches cached owners, rejects mismatches after reload, and deduplicates reconnects', async ({ page, context }) => {
  await injectWallet(context);
  const client = new ccc.ClientPublicTestnet();
  const identities = await Promise.all(['11', '22'].map(async byte => {
    const pubkey = ccc.hexFrom(p256.getPublicKey(ccc.bytesFrom(`0x${byte.repeat(32)}`), false).slice(1)).slice(2);
    const address = (await ccc.Address.fromKnownScript(client, ccc.KnownScript.JoyId, `0x0001${ccc.hashCkb(`0x${pubkey}`).slice(2, 42)}`)).toString();
    return { address, pubkey, keyType: 'main_key' };
  }));
  let requests = 0; let selected = 0;
  await context.route('https://testnet.joyid.dev/**', async route => {
    requests++;
    await route.fulfill({ contentType: 'text/html', body: `<script>setTimeout(()=>opener.postMessage(${JSON.stringify({ type: 'Auth', data: identities[selected] })},'http://127.0.0.1:5174'),100)</script>` });
  });
  await page.goto('/'); await page.getByRole('button', { name: 'Connect wallet' }).first().click();
  await page.getByRole('button', { name: 'Accounts in this browser (0)' }).click();
  await page.getByRole('button', { name: 'Add JoyID account', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Copy CKB address' })).toHaveAttribute('title', identities[0]!.address);
  await expect(page.getByRole('button', { name: 'Add JoyID account', exact: true })).toBeEnabled();
  selected = 1; await page.getByRole('button', { name: 'Add JoyID account', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Copy CKB address' })).toHaveAttribute('title', identities[1]!.address);
  await expect(page.locator('.pilot-accounts li')).toHaveCount(2); expect(requests).toBe(2);
  const chooseA = () => page.locator('.pilot-accounts li').filter({ hasText: identities[0]!.address }).getByRole('button');
  await expect(chooseA()).toBeEnabled(); await chooseA().click();
  await expect(page.getByRole('button', { name: 'Copy CKB address' })).toHaveAttribute('title', identities[0]!.address);
  expect(requests).toBe(2); // In-memory JoyID connection, no forced reauthentication for switching.
  await page.reload(); await page.getByRole('button', { name: 'Connect wallet' }).first().click();
  await page.getByRole('button', { name: 'Accounts in this browser (2)' }).click();
  await chooseA().click(); // Popup still returns B, which must not activate A.
  await expect(page.getByText('The wallet returned a different account. Select the requested account in your wallet.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy CKB address' })).not.toBeVisible();
  selected = 0; await chooseA().click();
  await expect(page.getByRole('button', { name: 'Copy CKB address' })).toHaveAttribute('title', identities[0]!.address);
  await expect(page.getByRole('button', { name: 'Add JoyID account', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Add JoyID account', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Add JoyID account', exact: true })).toBeEnabled();
  await expect(page.locator('.pilot-accounts li')).toHaveCount(2); expect(requests).toBe(5);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('account switching is blocked while another panel has a signed social action in progress', async ({ page, context }) => {
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
  await page.getByRole('button', { name: 'Accounts in this browser (1)' }).click();
  await expect(page.getByRole('button', { name: 'Add account / choose wallet' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Add JoyID account', exact: true })).toBeDisabled();
  await expect(page.getByText('Finish wallet operations and settle queued work before switching accounts.', { exact: true })).toBeVisible();
  await page.evaluate(() => (window as unknown as {pilotTestReleaseSocial:()=>void}).pilotTestReleaseSocial());
  await expect(page.getByRole('button', { name: 'Add JoyID account', exact: true })).toBeEnabled();
});
