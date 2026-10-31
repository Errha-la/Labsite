import { expect, test } from "@playwright/test";

const TURNSTILE_SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TURNSTILE_MOCK = `
(() => {
  let nextId = 1;
  let lastId = null;
  const widgets = new Map();
  const removed = [];
  window.turnstile = {
    render(container, options) {
      if (window.__turnstileRenderThrows) throw new Error('controlled render failure');
      const id = 'widget-' + nextId++;
      lastId = id;
      widgets.set(id, { container, options });
      return id;
    },
    remove(id) { removed.push(id); widgets.delete(id); },
  };
  window.__turnstileTest = {
    solve(token = 'browser-token', id = lastId) { widgets.get(id)?.options.callback(token); },
    expire(id = lastId) { widgets.get(id)?.options['expired-callback'](); },
    timeout(id = lastId) { widgets.get(id)?.options['timeout-callback'](); },
    fail(id = lastId) { widgets.get(id)?.options['error-callback'](); },
    lastId: () => lastId,
    options: (id = lastId) => widgets.get(id)?.options,
    callback: (id = lastId) => widgets.get(id)?.options.callback,
    widgetCount: () => widgets.size,
    removed: () => [...removed],
  };
})();`;

async function guardNetwork(page, script = TURNSTILE_MOCK) {
  const interceptedExternal = [];
  await page.route("**/*", async (route) => {
    const url = route.request().url();
    if (url === TURNSTILE_SCRIPT) {
      interceptedExternal.push(url);
      await route.fulfill({ status: 200, contentType: "text/javascript", body: script });
      return;
    }
    if (url === SITEVERIFY_URL) {
      interceptedExternal.push(url);
      await route.fulfill({ status: 503, contentType: "application/json", body: '{"success":false}' });
      return;
    }
    const target = new URL(url);
    if (target.origin === "http://127.0.0.1:8787" || target.protocol === "data:") {
      await route.continue();
      return;
    }
    interceptedExternal.push(url);
    await route.fulfill({ status: 204, body: "" });
  });
  return interceptedExternal;
}

async function openContact(page) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.React && window.ReactDOM && document.querySelector("#dc-root"));
  await page.locator(".desktop-nav .navlink").nth(5).click();
  const form = page.locator("form.contact-form");
  await expect(form).toBeVisible();
  return form;
}

async function fillContact(form) {
  await form.locator('[name="name"]').fill("Visitor");
  await form.locator('[name="email"]').fill("visitor@example.test");
  await form.locator('label[for="contactReasonOther"]').click();
  await form.locator('[name="message"]').fill("Please contact me.");
  await form.locator('[name="consent"]').check();
}

async function solve(page, token = "browser-token") {
  await expect.poll(() => page.evaluate(() => window.__turnstileTest?.widgetCount())).toBe(1);
  await page.evaluate((value) => window.__turnstileTest.solve(value), token);
}

test("explicit widget renders with the public key and action, then error and expiry fail closed", async ({ page }) => {
  const external = await guardNetwork(page);
  const form = await openContact(page);
  await expect.poll(() => page.evaluate(() => window.__turnstileTest?.widgetCount())).toBe(1);
  const options = await page.evaluate(() => {
    const value = window.__turnstileTest.options();
    return { sitekey: value.sitekey, action: value.action };
  });
  expect(options).toEqual({ sitekey: "1x00000000000000000000AA", action: "contact" });
  expect(external.filter((url) => url === TURNSTILE_SCRIPT)).toHaveLength(1);
  await expect(form.locator("[data-contact-submit]")).toBeDisabled();

  await solve(page, "first-token");
  await expect(form.locator('[name="turnstileToken"]')).toHaveValue("first-token");
  await expect(form.locator("[data-contact-submit]")).toBeEnabled();
  await page.evaluate(() => window.__turnstileTest.expire());
  await expect(form.locator('[name="turnstileToken"]')).toHaveValue("");
  await expect(form.locator("[data-contact-submit]")).toBeDisabled();

  await page.evaluate(() => window.__turnstileTest.solve("second-token"));
  await expect(form.locator("[data-contact-submit]")).toBeEnabled();
  await page.evaluate(() => window.__turnstileTest.fail());
  await expect(form.locator('[name="turnstileToken"]')).toHaveValue("");
  await expect(form.locator("[data-contact-submit]")).toBeDisabled();
  await expect(form.locator("[data-contact-status]")).toHaveAttribute("data-state", "error");
});

test("missing widget API and render errors leave submission disabled", async ({ browser }) => {
  for (const mode of ["missing-api", "render-error"]) {
    const context = await browser.newContext();
    const page = await context.newPage();
    if (mode === "render-error") await page.addInitScript(() => { window.__turnstileRenderThrows = true; });
    await guardNetwork(page, mode === "missing-api" ? "/* controlled missing widget API */" : TURNSTILE_MOCK);
    const form = await openContact(page);
    await expect(form.locator("[data-contact-submit]")).toBeDisabled();
    await expect(form.locator("[data-contact-status]")).toHaveAttribute("data-state", "error");
    await expect(form.locator("[data-contact-status]")).not.toHaveText("");
    await context.close();
  }
});

test("native validation blocks requests and a failed request preserves every visitor value", async ({ page }) => {
  await guardNetwork(page);
  let requests = 0;
  let captured;
  await page.route("**/api/contact", async (route) => {
    requests += 1;
    captured = { url: route.request().url(), payload: route.request().postDataJSON() };
    await route.fulfill({ status: 501, contentType: "application/json", body: '{"error":"not_implemented"}' });
  });
  const form = await openContact(page);
  await solve(page);
  await form.locator('[name="name"]').fill("Visitor");
  await form.locator("[data-contact-submit]").click();
  expect(requests).toBe(0);
  await expect(form.locator('[name="name"]')).toHaveValue("Visitor");

  await form.locator('[name="email"]').fill("visitor@example.test");
  await form.locator('label[for="contactReasonIndustry"]').click();
  await form.locator('[name="message"]').fill("Keep this message");
  await form.locator('[name="consent"]').check();
  await form.locator("[data-contact-submit]").click();
  await expect.poll(() => requests).toBe(1);
  expect(captured.url).toBe("http://127.0.0.1:8787/api/contact");
  expect(Object.keys(captured.payload).sort()).toEqual(["consent", "email", "message", "name", "reason", "turnstileToken"]);
  expect(captured.payload).toMatchObject({
    consent: true,
    email: "visitor@example.test",
    message: "Keep this message",
    name: "Visitor",
    reason: "industry",
    turnstileToken: "browser-token",
  });
  await expect(form.locator('[name="name"]')).toHaveValue("Visitor");
  await expect(form.locator('[name="email"]')).toHaveValue("visitor@example.test");
  await expect(form.locator('[name="reason"][value="industry"]')).toBeChecked();
  await expect(form.locator('[name="message"]')).toHaveValue("Keep this message");
  await expect(form.locator('[name="consent"]')).toBeChecked();
  await expect(form.locator("[data-contact-status]")).toHaveAttribute("data-state", "error");
  await expect(form.locator("[data-contact-submit]")).toBeDisabled();
  await expect(form.locator('[name="turnstileToken"]')).toHaveValue("");
});

test("200, 202, 204, malformed, timeout, 501, and 503 never show success or reset fields", async ({ page }) => {
  await guardNetwork(page);
  const outcomes = [
    { status: 200, body: "not-json" },
    { status: 202, body: '{"ok":true}' },
    { status: 204, body: "" },
    { status: 200, body: "{" },
    { abort: true },
    { status: 501, body: '{"error":"not_implemented"}' },
    { status: 503, body: '{"error":"service_unavailable"}' },
  ];
  let call = 0;
  await page.route("**/api/contact", async (route) => {
    const outcome = outcomes[call++];
    if (outcome.abort) await route.abort("timedout");
    else await route.fulfill({ status: outcome.status, contentType: "application/json", body: outcome.body });
  });
  const form = await openContact(page);
  await fillContact(form);

  for (let index = 0; index < outcomes.length; index += 1) {
    await solve(page, `token-${index}`);
    await form.locator("[data-contact-submit]").click();
    await expect.poll(() => call).toBe(index + 1);
    await expect(form).not.toHaveAttribute("aria-busy", "true");
    await expect(form.locator("[data-contact-status]")).toHaveAttribute("data-state", "error");
    await expect(form.locator("[data-contact-status]")).not.toContainText(/已送出|has been sent/i);
    await expect(form.locator('[name="name"]')).toHaveValue("Visitor");
    await expect(form.locator('[name="email"]')).toHaveValue("visitor@example.test");
    await expect(form.locator('[name="reason"][value="other"]')).toBeChecked();
    await expect(form.locator('[name="message"]')).toHaveValue("Please contact me.");
    await expect(form.locator('[name="consent"]')).toBeChecked();
    await expect(form.locator('[name="turnstileToken"]')).toHaveValue("");
    await expect(form.locator("[data-contact-submit]")).toBeDisabled();
  }
});

test("pending guard permits one request and every attempt requires a newly rendered widget", async ({ page }) => {
  await guardNetwork(page);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let requests = 0;
  await page.route("**/api/contact", async (route) => {
    requests += 1;
    await held;
    await route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"service_unavailable"}' });
  });
  const form = await openContact(page);
  await fillContact(form);
  await solve(page);
  const firstWidget = await page.evaluate(() => window.__turnstileTest.lastId());
  await form.evaluate((element) => {
    element.requestSubmit();
    element.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true, submitter: element.querySelector("[data-contact-submit]") }));
  });
  await expect.poll(() => requests).toBe(1);
  release();
  await expect(form).not.toHaveAttribute("aria-busy", "true");
  await expect.poll(() => page.evaluate(() => window.__turnstileTest.lastId())).not.toBe(firstWidget);
  await expect(form.locator("[data-contact-submit]")).toBeDisabled();
});

test("unmount removes the widget and stale callbacks cannot restore a token", async ({ page }) => {
  await guardNetwork(page);
  const form = await openContact(page);
  await expect.poll(() => page.evaluate(() => window.__turnstileTest?.widgetCount())).toBe(1);
  await page.evaluate(() => { window.__staleTurnstileCallback = window.__turnstileTest.callback(); });
  await page.locator(".desktop-nav .navlink").first().click();
  await expect(form).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.__turnstileTest.removed().length)).toBeGreaterThan(0);
  await page.evaluate(() => window.__staleTurnstileCallback("stale-token"));
  await page.locator(".desktop-nav .navlink").nth(5).click();
  const newForm = page.locator("form.contact-form");
  await expect(newForm).toBeVisible();
  await expect(newForm.locator('[name="turnstileToken"]')).toHaveValue("");
  await expect(newForm.locator("[data-contact-submit]")).toBeDisabled();
});

test("static refresh works while API paths return JSON and never use SPA fallback", async ({ page }) => {
  await guardNetwork(page);
  const refresh = await page.goto("/research/project", { waitUntil: "domcontentloaded" });
  expect(refresh.status()).toBe(200);
  await expect(page).toHaveTitle("先進製程與設備智能輔助實驗室");
  const results = await page.evaluate(async () => Promise.all(["/api", "/api/unknown", "/api/contact?legacy=1"].map(async (path) => {
    const response = await fetch(path);
    return { path, status: response.status, type: response.headers.get("Content-Type"), body: await response.json() };
  })));
  for (const result of results) {
    expect(result.status).toBe(404);
    expect(result.type).toMatch(/^application\/json/);
    expect(result.body).toEqual({ error: "not_found" });
  }
  expect(await page.locator("html").innerHTML()).not.toContain("VITE_CONTACT_API_URL");
});
