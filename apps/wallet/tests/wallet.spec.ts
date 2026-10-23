import { test, expect, type Page, type BrowserContext } from "@playwright/test";
async function authenticator(context: BrowserContext, page: Page) {
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return cdp;
}
test("real browser WebAuthn registers and verifies a passkey without storing an owner private key", async ({
  page,
  context,
}) => {
  await authenticator(context, page);
  await page.goto("/");
  await page.getByLabel("Account name", { exact: true }).fill("Alice");
  await page
    .getByRole("button", { name: "Create Pilot passkey", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "Passkey created" }),
  ).toBeVisible();
  await expect(page.locator("#owner-address")).toContainText("ckt1");
  await page
    .getByRole("button", { name: "Sign in with passkey", exact: true })
    .click();
  await expect(page.locator("#status")).toContainText("Passkey verified");
  const data = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("pilot:wallet:passkeys:v1")!),
  );
  expect(data).toHaveLength(1);
  expect(Object.keys(data[0]).sort()).toEqual([
    "credentialId",
    "name",
    "origin",
    "publicKey",
    "rpId",
  ]);
  expect(data[0].publicKey).toMatch(/^0x0[23][0-9a-f]{64}$/);
  expect(
    await page.evaluate(() =>
      Object.keys(localStorage).some((k) => k.includes("session-key")),
    ),
  ).toBe(false);
  await expect(
    page.getByRole("button", { name: "Approve session with passkey" }),
  ).toBeDisabled();
  await expect(
    page.getByText(/no on-chain success is simulated/),
  ).toBeVisible();
});
test("a separate app opens the wallet, reviews an unselected manifest and cannot access its storage", async ({
  page,
  context,
}) => {
  await page.goto("http://localhost:5177/tests/app.html");
  await page.waitForFunction(
    () =>
      !!(window as unknown as { pilotTestProvider: unknown }).pilotTestProvider,
  );
  const opened = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Connect Pilot" }).click();
  const wallet = await opened;
  await expect(
    wallet.getByText("External test app — http://localhost:5177"),
  ).toBeVisible();
  await expect(
    wallet.getByRole("checkbox", { name: "Like posts" }),
  ).not.toBeChecked();
  await authenticator(context, wallet);
  await wallet.getByLabel("Account name", { exact: true }).fill("Alice");
  await wallet
    .getByRole("button", { name: "Create Pilot passkey", exact: true })
    .click();
  await expect(wallet.locator("#status")).toContainText("Passkey created");
  expect(
    await page.evaluate(() =>
      Object.keys(localStorage).filter((k) => k.startsWith("pilot:wallet:")),
    ),
  ).toEqual([]);
  expect(
    await page.evaluate(() => {
      try {
        const p = (
          window as unknown as { pilotTestProvider: { popup: Window } }
        ).pilotTestProvider.popup;
        return p.localStorage.length;
      } catch (e) {
        return (e as Error).name;
      }
    }),
  ).toBe("SecurityError");
  await expect(
    wallet.getByRole("button", { name: "Approve session with passkey" }),
  ).toBeDisabled();
  await expect(page.locator("p")).toHaveText("Waiting");
  // Same channel and apparent origin do not substitute for the actual wallet Window source.
  await page.evaluate(() => {
    const p = (
      window as unknown as {
        pilotTestProvider: { channel: string; pending: Map<string, unknown> };
      }
    ).pilotTestProvider;
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: "http://localhost:5176",
        source: window,
        data: {
          protocol: "owl-pilot-wallet-v1",
          channel: p.channel,
          id: [...p.pending.keys()][0],
          method: "connect",
          result: {
            address: "fake",
            appOrigin: location.origin,
            expiresAt: Date.now() + 60000,
          },
        },
      }),
    );
  });
  await expect(page.locator("p")).toHaveText("Waiting");
});
test("account switching needs the selected passkey and public recovery import never imports keys", async ({
  page,
  context,
}) => {
  await authenticator(context, page);
  await page.goto("/");
  for (const name of ["Alice", "Bob"]) {
    await page.getByLabel("Account name", { exact: true }).fill(name);
    await page
      .getByRole("button", { name: "Create Pilot passkey", exact: true })
      .click();
    await expect(page.locator("#status")).toContainText("Passkey created");
  }
  await expect(page.getByLabel("Pilot account")).toHaveCount(1);
  const addresses = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("pilot:wallet:passkeys:v1")!),
  );
  expect(addresses).toHaveLength(2);
  expect(addresses[0].publicKey).not.toEqual(addresses[1].publicKey);
  await page
    .getByLabel("Pilot account")
    .selectOption(addresses[0].credentialId);
  await page
    .getByRole("button", { name: "Sign in with passkey", exact: true })
    .click();
  await expect(page.locator("#status")).toContainText("Passkey verified");
  await page
    .getByLabel("Import public recovery data")
    .setInputFiles({
      name: "bad.json",
      mimeType: "application/json",
      buffer: Buffer.from("{}"),
    });
  await expect(page.locator("#error")).not.toBeEmpty();
});
