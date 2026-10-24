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
async function enterPilot(page: Page) {
  const wallet = page.frameLocator("iframe");
  await expect(wallet.getByRole("heading", { name: "Welcome to Pilot", exact: true })).toBeVisible();
  await expect(wallet.getByRole("checkbox")).toHaveCount(0);
  await expect(wallet.getByRole("checkbox")).not.toBeVisible();
  await expect(wallet.getByRole("button", { name: /Add JoyID|Add account \/ choose wallet|Connect owner wallet/ })).toHaveCount(0);
  await wallet.getByRole("button", { name: /^Pilot Create an account/ }).click();
  return wallet;
}
async function returnWithPasskey(page: Page) {
  await page.reload();
  await page.getByRole("button", { name: "Connect Pilot", exact: true }).click();
  const wallet = await enterPilot(page);
  await wallet.getByLabel("Pilot account").selectOption({ index: 1 });
  await wallet.getByRole("button", { name: "Sign in with passkey", exact: true }).click();
  await expect(wallet.locator("#status")).toContainText("Passkey verified");
  return wallet;
}
test('hosted app offers 50 policies and the user selects at most 16', async ({ page, context }) => {
  await page.goto('http://localhost:5177/tests/app.html?catalog=50');
  await page.getByRole('button', { name: 'Connect Pilot', exact: true }).click();
  const wallet = await enterPilot(page);
  const frame = page.frames().find(f => f.url().startsWith('http://localhost:5176/'))!;
  await authenticator(context, frame);
  await wallet.getByLabel('Account name', { exact: true }).fill('Catalog tester');
  await wallet.getByRole('button', { name: 'Create Pilot passkey', exact: true }).click();
  const choices = wallet.getByRole('checkbox');
  await expect(choices).toHaveCount(50);
  for (let i = 0; i < 16; i++) await choices.nth(i).check();
  await expect(wallet.getByText('16 / 16 policies selected', { exact: false })).toBeVisible();
  await expect(choices.nth(16)).toBeDisabled();
  await choices.nth(0).uncheck();
  await choices.nth(49).check();
  await expect(choices.nth(0)).toBeDisabled();
  await expect(choices.nth(49)).toBeChecked();
});
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
  const wallet = await enterPilot(page);
  await expect(wallet.locator(".origin")).toHaveText("http://localhost:5177");
  const frame = page
    .frames()
    .find((f) => f.url().startsWith("http://localhost:5176/"))!;
  await authenticator(context, frame);
  await context.addInitScript(() => {
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
  await expect(wallet.getByRole("heading", { name: "Sign these on my behalf", exact: true })).toBeVisible();
  await expect(wallet.getByRole("checkbox", { name: "Like posts", exact: true })).not.toBeChecked();
  await expect(wallet.locator("#accounts")).not.toBeVisible();
  await expect(wallet.getByText("Session and recovery", { exact: true })).not.toBeVisible();
  const signedInWallet = await returnWithPasskey(page);
  const signedInFrame = page.frames().find((f) => f.url().startsWith("http://localhost:5176/"))!;
  expect(
    await signedInFrame.evaluate(
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
  expect(page.frames().includes(signedInFrame)).toBe(true);
  await page.evaluate(() =>
    (
      window as unknown as { pilotTestProvider: { open(): void } }
    ).pilotTestProvider.open(),
  );
  await expect(dialog).toBeVisible();
  await expect(signedInWallet.getByRole("heading", { name: "Sign these on my behalf", exact: true })).toBeVisible();
  await signedInWallet.getByRole("button", { name: "← Back", exact: true }).click();
  await expect(signedInWallet.getByRole("heading", { name: "Alice", exact: true })).toBeVisible();
  await expect(signedInWallet.getByText("Queue and all account receipts", { exact: true })).toBeVisible();
  await expect(signedInWallet.getByRole("checkbox")).not.toBeVisible();
  await signedInWallet.getByRole("button", { name: "Review permissions", exact: true }).click();
  await expect(signedInWallet.getByRole("checkbox", { name: "Like posts", exact: true })).not.toBeChecked();
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
    error: "Pilot says: Unresolved signed transaction",
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
  const wallet = await enterPilot(page);
  await expect(wallet.locator(".origin")).toHaveText("http://127.0.0.1:5177");
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
  await returnWithPasskey(page);
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
  const wallet = await enterPilot(page);
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

test('Safari uses a source-bound top-level ceremony and returns the public passkey to the modal', async ({ page, context }) => {
  await context.addInitScript(() => Object.defineProperty(navigator, 'userAgent', {
    value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15',
  }));
  await page.goto('http://localhost:5177/tests/app.html');
  await page.getByRole('button', { name: 'Connect Pilot', exact: true }).click();
  const wallet = await enterPilot(page);
  await wallet.getByLabel('Account name', { exact: true }).fill('Safari Alice');
  await wallet.getByRole('button', { name: 'Create Pilot passkey', exact: true }).click();
  await expect(wallet.getByRole('heading', { name: 'Continue with Safari', exact: true })).toBeVisible();
  expect(context.pages()).toHaveLength(1);
  const opened = context.waitForEvent('page');
  await wallet.getByRole('button', { name: 'Continue in Pilot', exact: true }).click();
  const auth = await opened;
  const authCdp = await authenticator(context, auth);
  let savedCredential: unknown;
  authCdp.on('WebAuthn.credentialAdded', event => { savedCredential = event.credential; });
  await expect(auth.getByText('Requesting app: http://localhost:5177', { exact: true })).toBeVisible();
  await expect(auth.getByRole('button', { name: 'Continue with passkey' })).toBeEnabled();
  // Same-origin spoof from a different Window is ignored by the opener binding.
  const frame = page.frames().find(f => f.url().startsWith('http://localhost:5176/'))!;
  await frame.evaluate(() => window.dispatchEvent(new MessageEvent('message', {
    source: window, origin: location.origin,
    data: { protocol: 'owl-pilot-top-auth-v1', method: 'result', result: {} },
  })));
  await auth.getByRole('button', { name: 'Continue with passkey' }).click();
  await expect(wallet.locator('#status')).toContainText('Passkey created');
  await expect(wallet.getByRole('heading', { name: 'Sign these on my behalf', exact: true })).toBeVisible();
  await expect.poll(() => auth.isClosed()).toBe(true);
  const records = await frame.evaluate(() => JSON.parse(localStorage.getItem('pilot:wallet:passkeys:v1')!));
  expect(records).toHaveLength(1);
  expect(records[0].origin).toBe('http://localhost:5176');
  expect(Object.keys(records[0])).not.toContain('privateKey');
  expect(await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('pilot:wallet:')))).toEqual([]);

  await page.reload();
  await page.getByRole('button', { name: 'Connect Pilot', exact: true }).click();
  const again = await enterPilot(page);
  await again.getByLabel('Pilot account').selectOption({ index: 1 });
  await again.getByRole('button', { name: 'Sign in with passkey', exact: true }).click();
  const secondOpened = context.waitForEvent('page');
  await again.getByRole('button', { name: 'Continue in Pilot', exact: true }).click();
  const second = await secondOpened;
  await expect(second.getByText(/Authenticate Safari Alice/)).toBeVisible();
  const secondCdp = await context.newCDPSession(second);
  await secondCdp.send("WebAuthn.enable");
  const authenticators = await secondCdp.send('WebAuthn.addVirtualAuthenticator', { options: {
    protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
    hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true,
  } });
  expect(savedCredential).toBeTruthy();
  await secondCdp.send('WebAuthn.addCredential', { authenticatorId: authenticators.authenticatorId, credential: savedCredential });
  await second.getByRole('button', { name: 'Continue with passkey' }).click();
  await expect(again.locator('#status')).toContainText('Passkey verified');
  await expect.poll(() => second.isClosed()).toBe(true);
  await expect(again.getByRole('heading', { name: 'Sign these on my behalf', exact: true })).toBeVisible();

  await page.reload();
  await page.getByRole('button', { name: 'Connect Pilot', exact: true }).click();
  const cancelled = await enterPilot(page);
  await cancelled.getByLabel('Pilot account').selectOption({ index: 1 });
  await cancelled.getByRole('button', { name: 'Sign in with passkey', exact: true }).click();
  const cancelledOpened = context.waitForEvent('page');
  await cancelled.getByRole('button', { name: 'Continue in Pilot', exact: true }).click();
  const cancelledAuth = await cancelledOpened;
  await cancelledAuth.close();
  await expect(cancelled.locator('#error')).toContainText('authentication window closed');
  await expect(cancelled.locator('#accounts')).toBeVisible();
});

test("one-time approval reopens the existing frame and cancels without reconnecting", async ({ page }) => {
  // Transport fixture only: signing and account checks are covered by wallet unit/WebAuthn tests.
  await page.route('http://localhost:5176/approval-fixture*', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><p>Connected account</p><script>
    const q = new URLSearchParams(location.search), channel = q.get('channel'), origin = q.get('appOrigin');
    const post = (id, method, result) => parent.postMessage({protocol:'owl-pilot-wallet-v1', channel, id, method, result}, origin);
    window.addEventListener('message', event => {
      if(event.source !== parent || event.origin !== origin || event.data.channel !== channel) return;
      const r = event.data;
      if(r.method === 'connect') post(r.id, r.method, {appOrigin:origin, expiresAt:Date.now()+60000});
      if(r.method === 'signMessage') { window.active = r; post(r.id,'approval'); }
      if(r.method === 'cancelApproval') post(r.id,'signMessage',{cancelled:true});
    });
    post('ready','ready');
  </script>` }));
  await page.goto('http://localhost:5177/tests/app.html?wallet=' + encodeURIComponent('http://localhost:5176/approval-fixture'));
  await page.getByRole('button', { name: 'Connect Pilot', exact: true }).click();
  await expect(page.locator('p').filter({hasText:'Connected'})).toBeVisible();
  const dialog = page.getByRole('dialog', {name:'Pilot wallet',exact:true});
  await expect(dialog).not.toBeVisible();
  const frame = page.frames().find(f => f.url().includes('/approval-fixture'))!;
  const originalUrl = frame.url();
  await page.evaluate(() => {
    const p = (window as any).pilotTestProvider;
    (window as any).oneTimeResult = p.request('signMessage', {scope:'social.delete',message:'post:123',nonce:'one_time_nonce_12345'});
  });
  await expect(dialog).toBeVisible();
  expect(page.frames().find(f => f.url() === originalUrl)).toBe(frame);
  await expect(page.frameLocator('iframe').getByText('Connected account')).toBeVisible();
  await page.getByRole('button', {name:'Close Pilot wallet'}).click();
  await expect(dialog).not.toBeVisible();
  expect(await page.evaluate(() => (window as any).oneTimeResult)).toEqual({cancelled:true});
  await page.evaluate(() => (window as any).pilotTestProvider.open());
  await expect(dialog).toBeVisible();
  expect(page.frames().find(f => f.url() === originalUrl)).toBe(frame);
});

test("user wait time does not expire connect or approval; processing timeouts remain scoped to the request", async ({ page }) => {
  // Simulated wallet transport and clock: no chain transaction or passkey signature is claimed here.
  await page.clock.install();
  await page.route('http://localhost:5176/timeout-fixture*', route => route.fulfill({contentType:'text/html',body:`<!doctype html><p>Waiting for user</p><script>
    const q = new URLSearchParams(location.search), channel=q.get('channel'), origin=q.get('appOrigin');
    window.requests={};
    window.reply=(id,method,result,params)=>parent.postMessage({protocol:'owl-pilot-wallet-v1',channel,id,method,result,params},origin);
    addEventListener('message',event=>{
      if(event.source!==parent || event.origin!==origin || event.data.channel!==channel) return;
      const r=event.data; window.requests[r.method]=r;
      if(r.method==='signMessage') window.reply(r.id,'approval');
    });
    window.reply('ready','ready');
  </script>`}));
  await page.goto('http://localhost:5177/tests/app.html?wallet='+encodeURIComponent('http://localhost:5176/timeout-fixture'));
  await page.getByRole('button',{name:'Connect Pilot',exact:true}).click();
  await expect(page.frameLocator('iframe').getByText('Waiting for user')).toBeVisible();
  const frame=page.frames().find(f=>f.url().includes('/timeout-fixture'))!;
  await frame.waitForFunction(()=>!!(window as any).requests?.connect);
  // A new event type from the real wallet must not resolve an older request type.
  await frame.evaluate(()=>{
    const w=window as any; w.reply(w.requests.connect.id,'future-event');
  });
  await page.clock.fastForward(300_001);
  expect(await page.evaluate(()=>(window as any).pilotTestProvider.pending.size)).toBe(1);
  await frame.evaluate(()=>{
    const w=window as any;
    w.reply(w.requests.connect.id,'connect',{appOrigin:'http://localhost:5177',expiresAt:Date.now()+3_600_000});
  });
  await expect(page.locator('p').filter({hasText:'Connected'})).toBeVisible();
  await page.evaluate(()=>{
    const w=window as any;
    w.result=w.pilotTestProvider.request('signMessage',{scope:'social.delete',message:'post:123',nonce:'timeout_nonce_12345'}).catch((e:Error)=>e.message);
  });
  const dialog=page.getByRole('dialog',{name:'Pilot wallet',exact:true});
  await expect(dialog).toBeVisible();
  await page.clock.fastForward(300_001);
  expect(await page.evaluate(()=>(window as any).pilotTestProvider.pending.size)).toBe(1);
  await frame.evaluate(()=>{
    const w=window as any; w.reply(w.requests.signMessage.id,'progress',undefined,{phase:'processing'});
  });
  await expect.poll(()=>page.evaluate(() => [...(window as any).pilotTestProvider.pending.values()].some((p:any)=>p.timer!==undefined))).toBe(true);
  await page.clock.fastForward(300_001);
  expect(await page.evaluate(()=>(window as any).result)).toContain('same nonce');
  await page.evaluate(()=>{
    const w=window as any, p=w.pilotTestProvider;
    w.result=p.request('send',{bytes:'0x',requestId:'stable-action-123'}).catch((e:Error)=>e.message);
    // An app-window forgery must not pause a bound request timer.
    window.dispatchEvent(new MessageEvent('message',{source:window,origin:'http://localhost:5176',data:{protocol:'owl-pilot-wallet-v1',channel:p.channel,id:[...p.pending.keys()][0],method:'progress',params:{phase:'waiting-for-user'}}}));
  });
  await page.clock.fastForward(300_001);
  expect(await page.evaluate(()=>(window as any).result)).toContain('same action request ID');
});

test("wallet sign-in does not send progress responses to an older SDK without opt-in", async ({page,context}) => {
  await page.goto('http://localhost:5177/tests/legacy-app.html');
  let wallet=await enterPilot(page);
  let frame=page.frames().find(f=>f.url().startsWith('http://localhost:5176/'))!;
  await authenticator(context,frame);
  await wallet.getByLabel('Account name',{exact:true}).fill('Legacy account');
  await wallet.getByRole('button',{name:'Create Pilot passkey',exact:true}).click();
  await expect(wallet.locator('#status')).toContainText('Passkey created');
  await page.reload();
  wallet=await enterPilot(page);
  frame=page.frames().find(f=>f.url().startsWith('http://localhost:5176/'))!;
  await wallet.getByLabel('Pilot account').selectOption({index:1});
  await wallet.getByRole('button',{name:'Sign in with passkey',exact:true}).click();
  await expect(wallet.locator('#status')).toContainText('Passkey verified');
  await expect(page.locator('#error')).toHaveText('');
  expect(await page.evaluate(()=>(window as any).progressEvents)).toBe(0);
});
