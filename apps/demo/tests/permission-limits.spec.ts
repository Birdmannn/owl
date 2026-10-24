import { test, expect } from '@playwright/test';

for (const [kind, limit] of [['chain', 16], ['offchain', 32]] as const) {
  test(`${kind} consent offers 50 actions, caps selection at ${limit}, and permits swapping choices`, async ({ page }) => {
    await page.goto('/');
    await page.evaluate(async kind => {
      const path = '/tests/fixtures/permissions.tsx';
      const fixture = await import(/* @vite-ignore */ path);
      fixture.mountPermissions(kind);
    }, kind);
    const dialog = page.getByRole('dialog', { name: kind === 'chain' ? 'Sign these on my behalf' : 'Sign social actions on my behalf' });
    const choices = dialog.getByRole('checkbox');
    await expect(choices).toHaveCount(50);
    const approve = dialog.getByRole('button', { name: kind === 'chain' ? 'Allow Pilot to sign selected actions' : 'Approve selected off-chain actions' });
    await expect(approve).toBeDisabled();
    for (let i = 0; i < limit; i++) await choices.nth(i).check();
    await expect(dialog.getByText(`${limit} / ${limit} action types selected`, { exact: false })).toBeVisible();
    await expect(choices.nth(limit)).toBeDisabled();
    await expect(choices.nth(0)).toBeEnabled();
    await choices.nth(0).uncheck();
    await expect(choices.nth(48)).toBeEnabled();
    await choices.nth(48).check();
    await expect(choices.nth(0)).toBeDisabled();
    if (kind === 'chain') await expect(choices.nth(49)).toBeDisabled();
    await approve.click();
    const selected: string[] = JSON.parse(await page.getByTestId('permission-result').textContent() || '[]');
    expect(selected).toHaveLength(limit);
    expect(selected).toContain('app.action48');
    expect(selected).not.toContain('app.action0');
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });
}
