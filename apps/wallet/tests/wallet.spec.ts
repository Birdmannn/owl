import {
  test,
  expect,
  type Page,
  type BrowserContext,
  type Frame,
} from "@playwright/test";
async function authenticator(context: BrowserContext, page: Page | Frame) {
  const cdp = await context.newCDPSession(page).catch(async (error) => {
    if (
      "page" in page &&
      String(error).includes("does not have a separate CDP session")
    )
      return context.newCDPSession(page.page());
    throw error;
  });
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
    "codeHash",
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
test("the SDK embeds the wallet in a modal with real cross-origin WebAuthn and source-bound messages", async ({
  page,
  context,
}) => {
  await page.goto("http://localhost:5177/tests/app.html");
  await page.waitForFunction(
    () =>
      !!(window as unknown as { pilotTestProvider: unknown }).pilotTestProvider,
  );
  await page
    .getByRole("button", { name: "Connect Pilot", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Pilot wallet",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await expect(page.locator("iframe")).toHaveCount(1);
  expect(context.pages()).toHaveLength(1);
  const wallet = page.frameLocator("iframe");
  await expect(
    wallet.getByText("External test app — http://localhost:5177"),
  ).toBeVisible();
  await expect(
    wallet.getByRole("checkbox", { name: "Like posts", exact: true }),
  ).not.toBeChecked();
  const frame = page
    .frames()
    .find((f) => f.url().startsWith("http://localhost:5176/"))!;
  await authenticator(context, frame);
  await frame.evaluate(() => {
    const get = navigator.credentials.get.bind(navigator.credentials);
    navigator.credentials.get = async (options) => {
      const result = await get(options);
      const response = (result as PublicKeyCredential)
        .response as AuthenticatorAssertionResponse;
      Object.assign(window, {
        testAssertionContext: JSON.parse(
          new TextDecoder().decode(response.clientDataJSON),
        ),
      });
      return result;
    };
  });
  await wallet.getByLabel("Account name", { exact: true }).fill("Alice");
  await wallet
    .getByRole("button", { name: "Create Pilot passkey", exact: true })
    .click();
  await expect(wallet.locator("#status")).toContainText("Passkey created");
  await wallet
    .getByRole("button", { name: "Sign in with passkey", exact: true })
    .click();
  await expect(wallet.locator("#status")).toContainText("Passkey verified");
  expect(
    await frame.evaluate(
      () =>
        (window as unknown as { testAssertionContext: unknown })
          .testAssertionContext,
    ),
  ).toMatchObject({
    crossOrigin: true,
    topOrigin: "http://localhost:5177",
    origin: "http://localhost:5176",
  });
  expect(
    await page.evaluate(() =>
      Object.keys(localStorage).filter((k) => k.startsWith("pilot:wallet:")),
    ),
  ).toEqual([]);
  expect(
    await page.evaluate(() => {
      try {
        return document
          .querySelector("[data-pilot-wallet]")!
          .shadowRoot!.querySelector("iframe")!.contentWindow!.localStorage
          .length;
      } catch (e) {
        return (e as Error).name;
      }
    }),
  ).toBe("SecurityError");
  await expect(
    wallet.getByRole("button", { name: "Approve session with passkey" }),
  ).toBeDisabled();
  // A fabricated response from the parent Window cannot impersonate the isolated signer.
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
  await expect(page.locator("body > p")).toHaveText("Waiting");
  await page.getByRole("button", { name: "Close Pilot wallet" }).click();
  await expect(dialog).not.toBeVisible();
  expect(page.frames().includes(frame)).toBe(true);
  await page.evaluate(() =>
    (
      window as unknown as { pilotTestProvider: { open(): void } }
    ).pilotTestProvider.open(),
  );
  await expect(dialog).toBeVisible();
  await expect(wallet.getByLabel("Pilot account")).toHaveValue(/.+/);
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
  await page.getByLabel("Import public recovery data").setInputFiles({
    name: "bad.json",
    mimeType: "application/json",
    buffer: Buffer.from("{}"),
  });
  await expect(page.locator("#error")).not.toBeEmpty();
});

test("confirmed connection hides the modal without unloading the signer; failed settlement preserves it", async ({
  page,
  context,
}) => {
  // Transport fixture only; this does not simulate chain success in the production wallet.
  await page.route("**/tests/mock-wallet.html*", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><script>
    const q=new URLSearchParams(location.search), origin=q.get('appOrigin'), channel=q.get('channel');
    let connect;window.failDisconnect=true;
    function reply(request,result,error){parent.postMessage({protocol:'owl-pilot-wallet-v1',channel,id:request.id,method:request.method,result,error},origin)}
    window.addEventListener('message',e=>{if(e.source!==parent||e.origin!==origin||e.data.channel!==channel)return;
      const r=e.data;if(r.method==='connect'){connect=r;window.hasConnect=true;return;}
      if(r.method==='logs')reply(r,{receipts:[]});
      if(r.method==='disconnect')reply(r,{stopped:true},window.failDisconnect?'Unresolved signed transaction':undefined);
    });
    window.approve=()=>reply(connect,{address:'public-session-address',ownerAddress:'public-owner-address',account:{},appOrigin:origin,expiresAt:Date.now()+60000});
    parent.postMessage({protocol:'owl-pilot-wallet-v1',channel,id:'ready',method:'ready'},origin);
    </script>`,
    }),
  );
  await page.goto(
    "http://localhost:5177/tests/app.html?wallet=" +
      encodeURIComponent("http://localhost:5176/tests/mock-wallet.html"),
  );
  await page
    .getByRole("button", { name: "Connect Pilot", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Pilot wallet",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  const frame = page
    .frames()
    .find((f) =>
      f.url().startsWith("http://localhost:5176/tests/mock-wallet.html"),
    )!;
  await expect
    .poll(() =>
      frame.evaluate(
        () => (window as unknown as { hasConnect: boolean }).hasConnect,
      ),
    )
    .toBe(true);
  await frame.evaluate(() =>
    (window as unknown as { approve(): void }).approve(),
  );
  await expect(page.locator("body > p")).toHaveText("Connected");
  await expect(dialog).not.toBeVisible();
  expect(page.frames()).toContain(frame);
  expect(context.pages()).toHaveLength(1);
  const receipt = await page.evaluate(async () =>
    (
      window as unknown as {
        pilotTestProvider: { request(method: string): Promise<unknown> };
      }
    ).pilotTestProvider.request("logs"),
  );
  expect(receipt).toEqual({ receipts: [] });
  await page.evaluate(() =>
    (
      window as unknown as { pilotTestProvider: { open(): void } }
    ).pilotTestProvider.open(),
  );
  await expect(dialog).toBeVisible();
  const failed = await page.evaluate(async () => {
    const p = (
      window as unknown as {
        pilotTestProvider: { disconnect(): Promise<void>; connected: boolean };
      }
    ).pilotTestProvider;
    try {
      await p.disconnect();
    } catch (e) {
      return { error: (e as Error).message, connected: p.connected };
    }
  });
  expect(failed).toEqual({
    error: "Unresolved signed transaction",
    connected: true,
  });
  expect(page.frames()).toContain(frame);
  await frame.evaluate(() => {
    Object.assign(window, { failDisconnect: false });
  });
  await page.evaluate(() =>
    (
      window as unknown as {
        pilotTestProvider: { disconnect(): Promise<void> };
      }
    ).pilotTestProvider.disconnect(),
  );
  await expect(page.locator("iframe")).toHaveCount(0);
});

test("passkeys work in a genuinely cross-site embedded wallet without a new browser window", async ({
  page,
  context,
}) => {
  await page.goto("http://127.0.0.1:5177/tests/app.html");
  await page
    .getByRole("button", { name: "Connect Pilot", exact: true })
    .click();
  const wallet = page.frameLocator("iframe");
  await expect(
    wallet.getByText("External test app — http://127.0.0.1:5177"),
  ).toBeVisible();
  const frame = page
    .frames()
    .find((f) => f.url().startsWith("http://localhost:5176/"))!;
  await authenticator(context, frame);
  await wallet
    .getByLabel("Account name", { exact: true })
    .fill("Cross-site account");
  await wallet
    .getByRole("button", { name: "Create Pilot passkey", exact: true })
    .click();
  await expect(wallet.locator("#status")).toContainText("Passkey created");
  await wallet
    .getByRole("button", { name: "Sign in with passkey", exact: true })
    .click();
  await expect(wallet.locator("#status")).toContainText("Passkey verified");
  expect(context.pages()).toHaveLength(1);
});

test("blocked embedded storage fails closed before creating a passkey and never opens a popup", async ({
  page,
  context,
}) => {
  await context.addInitScript(() => {
    if (location.origin === "http://localhost:5176")
      Storage.prototype.setItem = () => {
        throw new DOMException("Storage blocked", "SecurityError");
      };
  });
  await page.goto("http://localhost:5177/tests/app.html");
  await page
    .getByRole("button", { name: "Connect Pilot", exact: true })
    .click();
  const wallet = page.frameLocator("iframe");
  await expect(wallet.getByText(/Your browser blocks storage/)).toBeVisible();
  await wallet
    .getByLabel("Account name", { exact: true })
    .fill("Blocked account");
  await wallet
    .getByRole("button", { name: "Create Pilot passkey", exact: true })
    .click();
  await expect(wallet.locator("#error")).toContainText(
    "Embedded wallet storage is blocked",
  );
  const frame = page
    .frames()
    .find((f) => f.url().startsWith("http://localhost:5176/"))!;
  expect(
    await frame.evaluate(() =>
      localStorage.getItem("pilot:wallet:passkeys:v1"),
    ),
  ).toBeNull();
  expect(context.pages()).toHaveLength(1);
});
