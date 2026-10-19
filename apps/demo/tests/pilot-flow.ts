import { expect, type Page } from '@playwright/test';
export async function connectThroughPilot(page:Page, existing=false) {
  await page.getByRole('button',{name:'Connect wallet'}).first().click();
  await expect(page.getByRole('dialog',{name:'Choose your wallet'})).toBeVisible();
  await page.getByRole('button',{name:'Pilot Use your wallet. Approve once. Keep playing.'}).click();
  await page.getByRole('button',{name:'Connect owner wallet'}).click();
  await page.getByText('Pilot Test Wallet',{exact:true}).click();
  await expect(page.getByRole('dialog',{name:existing?'Sign these on my behalf':'Your Pilot profile'})).toBeVisible();
}
export async function createProfile(page:Page,username='owl_pilot') {
  await page.getByRole('textbox',{name:'Username',exact:true}).fill(username);
  await page.getByRole('button',{name:'Create Pilot profile'}).click();
  await expect(page.getByRole('dialog',{name:'Sign these on my behalf'})).toBeVisible();
}
