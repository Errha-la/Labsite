import assert from "node:assert/strict";
import test from "node:test";
import worker, { canonicalizeClientIp } from "../worker/index.js";

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

function validPayload(overrides = {}) {
  return {
    consent: true,
    email: "visitor@example.test",
    message: "Hello 世界",
    name: "Visitor",
    reason: "other",
    turnstileToken: "token-1",
    ...overrides,
  };
}

function createCounter(options = {}) {
  const records = new Map();
  const calls = [];
  let next = 1;
  let sends = 0;
  const stub = {
    async fetch(_url, init) {
      const input = JSON.parse(init.body);
      calls.push(input.action);
      if (input.action === "rate_check") return Response.json({ allowed: true, remaining: 4 });
      if (input.action === "budget_status") {
        const available = options.budgetAvailable !== false;
        return Response.json({ available, remaining: available ? 1 : 0 });
      }
      const existing = records.get(input.idempotencyKey);
      if (input.action === "reserve") {
        const payload = JSON.stringify(input.payload);
        if (existing) {
          if (existing.payload !== payload) return Response.json({ error: "IDEMPOTENCY_CONFLICT" }, { status: 409 });
          return Response.json({ created: false, caseNumber: existing.caseNumber, state: existing.state, expiresAt: 99 });
        }
        const record = { payload, caseNumber: String(next++).padStart(4, "0"), state: "reserved" };
        records.set(input.idempotencyKey, record);
        return Response.json({ created: true, caseNumber: record.caseNumber, state: record.state, expiresAt: 99 }, { status: 201 });
      }
      if (!existing) return Response.json({ error: "IDEMPOTENCY_NOT_FOUND" }, { status: 404 });
      if (input.action === "claim_send") {
        if (existing.state !== "reserved") return Response.json({ caseNumber: existing.caseNumber, state: existing.state, claimed: false, expiresAt: 99 });
        existing.state = "sending";
        sends += 1;
        return Response.json({ caseNumber: existing.caseNumber, state: "sending", claimed: true, expiresAt: 99 });
      }
      if (input.action === "transition") {
        if (options.failTransitionTo === input.to) {
          return Response.json({ error: "storage_unavailable" }, { status: 503 });
        }
        existing.state = input.to;
        return Response.json({ caseNumber: existing.caseNumber, state: existing.state, expiresAt: 99 });
      }
      return Response.json({ error: "invalid_request" }, { status: 400 });
    },
  };
  return {
    binding: { idFromName: () => "singleton", get: () => stub },
    calls,
    records,
    get sends() { return sends; },
  };
}

function createEnv(overrides = {}) {
  const counter = overrides.__counter || createCounter();
  const assetRequests = [];
  const env = {
    ASSETS: { async fetch(request) { assetRequests.push(request); return new Response("static asset"); } },
    CONTACT_ADMIN_EMAIL: "admin@example.test",
    CONTACT_CASE_COUNTER: counter.binding,
    CONTACT_ENVIRONMENT: "production",
    CONTACT_IDEMPOTENCY_HMAC_KEY: "test-idempotency-hmac-key-at-least-32-bytes",
    CONTACT_RATE_LIMIT_HMAC_KEY: "test-rate-limit-hmac-key-at-least-32-bytes",
    GMAIL_SENDER_EMAIL: "sender@example.test",
    GOOGLE_OAUTH_CLIENT_ID: "test-client-id",
    GOOGLE_OAUTH_CLIENT_SECRET: "test-client-secret",
    GOOGLE_OAUTH_REFRESH_TOKEN: "test-refresh-token",
    TURNSTILE_EXPECTED_HOSTNAME: "example.test",
    TURNSTILE_SECRET: "test-turnstile-secret",
    ...overrides,
  };
  delete env.__counter;
  return { env, counter, assetRequests };
}

function contactRequest(payload = validPayload(), options = {}) {
  const headers = new Headers({
    "Content-Type": "application/json",
    "CF-Connecting-IP": "2001:db8::1",
    "X-Contact-Idempotency-Key": "operation-key-00000001",
    ...options.headers,
  });
  return new Request(options.url || "https://example.test/api/contact", {
    method: options.method || "POST",
    headers,
    body: options.body === undefined ? JSON.stringify(payload) : options.body,
    ...(options.duplex ? { duplex: options.duplex } : {}),
  });
}

function verifiedResponse(overrides = {}) {
  return Response.json({ success: true, hostname: "example.test", action: "contact", ...overrides });
}

function tokenResponse(token = "access-token") {
  return Response.json({ access_token: token, token_type: "Bearer" });
}

async function withFetchMock(mock, callback) {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  try { return await callback(); } finally { globalThis.fetch = original; }
}

async function responseBody(response) {
  return { status: response.status, body: await response.json() };
}

function successProvider(captured = []) {
  return async (url, init) => {
    captured.push({ url, init });
    if (url === VERIFY_URL) return verifiedResponse();
    if (url === TOKEN_URL) return tokenResponse();
    if (url === GMAIL_URL) return Response.json({ id: "gmail-message-id" }, { status: 202 });
    throw new Error("unexpected endpoint");
  };
}

test("confirmed Gmail acceptance returns 202 and MIME has fixed safe headers with Unicode roundtrip", async () => {
  const { env, counter } = createEnv();
  const calls = [];
  const response = await withFetchMock(successProvider(calls), () => worker.fetch(contactRequest(), env));
  assert.deepEqual(await responseBody(response), { status: 202, body: { ok: true, caseNumber: "0001" } });
  assert.deepEqual(calls.map(({ url }) => url), [VERIFY_URL, TOKEN_URL, GMAIL_URL]);
  assert.deepEqual(counter.calls, ["rate_check", "reserve", "budget_status", "claim_send", "transition"]);
  const tokenRequest = calls[1];
  assert.equal(tokenRequest.init.redirect, "manual");
  assert.deepEqual([...new URLSearchParams(tokenRequest.init.body).keys()].sort(), ["client_id", "client_secret", "grant_type", "refresh_token"]);
  const gmailRequest = calls[2];
  assert.equal(gmailRequest.init.redirect, "manual");
  assert.equal(gmailRequest.init.headers.Authorization, "Bearer access-token");
  const raw = JSON.parse(gmailRequest.init.body).raw;
  const mime = Buffer.from(raw, "base64url").toString("utf8");
  const [headerText, bodyEncoded] = mime.split("\r\n\r\n");
  assert.match(headerText, /^From: sender@example\.test\r\nTo: admin@example\.test\r\nReply-To: visitor@example\.test\r\n/);
  assert.match(headerText, /Subject: =\?UTF-8\?B\?[^?]+\?= New Contact Message/);
  const prefix = headerText.match(/Subject: =\?UTF-8\?B\?([^?]+)\?=/)[1];
  assert.equal(Buffer.from(prefix, "base64").toString("utf8"), "[案件編號 0001]");
  assert.match(headerText, /MIME-Version: 1\.0/);
  assert.match(headerText, /Content-Type: text\/plain; charset=UTF-8/);
  assert.match(headerText, /Content-Transfer-Encoding: base64/);
  assert.doesNotMatch(headerText, /\r\n(?:Cc|Bcc):/i);
  assert.equal(bodyEncoded.split("\r\n").every((line) => line.length <= 76), true);
  assert.match(Buffer.from(bodyEncoded, "base64").toString("utf8"), /Hello 世界/);
});

test("duplicate accepted key returns the same case without another OAuth or Gmail call", async () => {
  const { env, counter } = createEnv();
  const calls = [];
  const first = await withFetchMock(successProvider(calls), () => worker.fetch(contactRequest(), env));
  const second = await withFetchMock(successProvider(calls), () => worker.fetch(contactRequest(), env));
  assert.deepEqual(await responseBody(first), { status: 202, body: { ok: true, caseNumber: "0001" } });
  assert.deepEqual(await responseBody(second), { status: 202, body: { ok: true, caseNumber: "0001" } });
  assert.equal(calls.filter(({ url }) => url === GMAIL_URL).length, 1);
  assert.equal(counter.sends, 1);
});

test("concurrent identical requests allocate and send exactly once", async () => {
  const { env, counter } = createEnv();
  let gmailCalls = 0;
  const provider = async (url) => {
    if (url === VERIFY_URL) return verifiedResponse();
    if (url === TOKEN_URL) return tokenResponse();
    if (url === GMAIL_URL) { gmailCalls += 1; return Response.json({ id: "one-message" }); }
    throw new Error("unexpected endpoint");
  };
  const [first, second] = await withFetchMock(provider, () => Promise.all([
    worker.fetch(contactRequest(), env), worker.fetch(contactRequest(), env),
  ]));
  assert.deepEqual([first.status, second.status], [202, 202]);
  assert.equal(counter.records.size, 1);
  assert.equal(counter.sends, 1);
  assert.equal(gmailCalls, 1);
});

test("OAuth failures leave the record reserved and spend no send claim", async () => {
  const outcomes = [
    () => new Response("revoked", { status: 400 }),
    () => Response.json({ token_type: "Bearer" }),
    () => Response.json({ access_token: "", token_type: "Bearer" }),
    () => Response.json({ access_token: "token", token_type: "Bearer", scope: "https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly" }),
    () => new Response("not-json", { status: 200 }),
    () => new Response("redirect", { status: 302 }),
    () => { throw new Error("reset"); },
  ];
  for (const makeTokenResponse of outcomes) {
    const { env, counter } = createEnv();
    const response = await withFetchMock(async (url) => {
      if (url === VERIFY_URL) return verifiedResponse();
      if (url === TOKEN_URL) return makeTokenResponse();
      throw new Error("Gmail must not be called");
    }, () => worker.fetch(contactRequest(), env));
    assert.deepEqual(await responseBody(response), { status: 503, body: { error: "service_unavailable" } });
    assert.equal(counter.records.get("operation-key-00000001").state, "reserved");
    assert.equal(counter.sends, 0);
  }
});

test("exhausted daily budget stops before OAuth and Gmail while leaving the reservation retryable", async () => {
  const counter = createCounter({ budgetAvailable: false });
  const { env } = createEnv({ __counter: counter });
  const providerUrls = [];
  const response = await withFetchMock(async (url) => {
    providerUrls.push(url);
    if (url === VERIFY_URL) return verifiedResponse();
    throw new Error("OAuth and Gmail must not run");
  },
    () => worker.fetch(contactRequest(), env));
  assert.deepEqual(await responseBody(response), { status: 503, body: { error: "service_unavailable" } });
  assert.deepEqual(providerUrls, [VERIFY_URL]);
  assert.deepEqual(counter.calls, ["rate_check", "reserve", "budget_status"]);
  assert.equal(counter.records.get("operation-key-00000001").state, "reserved");
  assert.equal(counter.sends, 0);
});

test("accepted-state write failure reports unknown and the sending record prohibits resend", async () => {
  const counter = createCounter({ failTransitionTo: "accepted" });
  const { env } = createEnv({ __counter: counter });
  let gmailCalls = 0;
  const provider = async (url) => {
    if (url === VERIFY_URL) return verifiedResponse();
    if (url === TOKEN_URL) return tokenResponse();
    if (url === GMAIL_URL) { gmailCalls += 1; return Response.json({ id: "accepted-but-write-failed" }); }
    throw new Error("unexpected endpoint");
  };
  assert.deepEqual(await responseBody(await withFetchMock(provider, () => worker.fetch(contactRequest(), env))), {
    status: 503,
    body: { error: "delivery_unknown" },
  });
  assert.equal(counter.records.get("operation-key-00000001").state, "sending");
  assert.deepEqual(await responseBody(await withFetchMock(provider, () => worker.fetch(contactRequest(), env))), {
    status: 409,
    body: { error: "request_in_progress" },
  });
  assert.equal(gmailCalls, 1);
});

test("first Gmail 401 is definite failure without OAuth refresh or Gmail retry", async () => {
  const { env, counter } = createEnv();
  let tokenCalls = 0;
  let gmailCalls = 0;
  const provider = async (url) => {
    if (url === VERIFY_URL) return verifiedResponse();
    if (url === TOKEN_URL) { tokenCalls += 1; return tokenResponse("first"); }
    if (url === GMAIL_URL) { gmailCalls += 1; return new Response("rejected", { status: 401 }); }
    throw new Error("unexpected endpoint");
  };
  const first = await withFetchMock(provider, () => worker.fetch(contactRequest(), env));
  assert.deepEqual(await responseBody(first), { status: 502, body: { error: "delivery_failed" } });
  assert.equal(tokenCalls, 1);
  assert.equal(gmailCalls, 1);
  assert.equal(counter.records.get("operation-key-00000001").state, "definite_failure");

  const duplicate = await withFetchMock(provider, () => worker.fetch(contactRequest(), env));
  assert.deepEqual(await responseBody(duplicate), { status: 502, body: { error: "delivery_failed" } });
  assert.equal(tokenCalls, 1);
  assert.equal(gmailCalls, 1);
});

test("initial Gmail outcomes are classified without automatic resend", async () => {
  const cases = [
    { response: () => new Response("quota", { status: 429 }), expected: [502, "delivery_failed", "definite_failure"] },
    { response: () => new Response("forbidden", { status: 403 }), expected: [502, "delivery_failed", "definite_failure"] },
    { response: () => new Response("timeout", { status: 408 }), expected: [503, "delivery_unknown", "unknown"] },
    { response: () => new Response("redirect", { status: 302 }), expected: [503, "delivery_unknown", "unknown"] },
    { response: () => new Response("down", { status: 503 }), expected: [503, "delivery_unknown", "unknown"] },
    { response: () => Response.json({}), expected: [503, "delivery_unknown", "unknown"] },
    { response: () => { throw new Error("reset"); }, expected: [503, "delivery_unknown", "unknown"] },
  ];
  for (const entry of cases) {
    const { env, counter } = createEnv();
    let gmailCalls = 0;
    const response = await withFetchMock(async (url) => {
      if (url === VERIFY_URL) return verifiedResponse();
      if (url === TOKEN_URL) return tokenResponse();
      if (url === GMAIL_URL) { gmailCalls += 1; return entry.response(); }
      throw new Error("unexpected endpoint");
    }, () => worker.fetch(contactRequest(), env));
    assert.deepEqual(await responseBody(response), { status: entry.expected[0], body: { error: entry.expected[1] } });
    assert.equal(counter.records.get("operation-key-00000001").state, entry.expected[2]);
    assert.equal(gmailCalls, 1);
  }
});

test("payload mismatch and terminal unknown fail closed without Gmail resend", async () => {
  const { env } = createEnv();
  let gmailCalls = 0;
  const unknownProvider = async (url) => {
    if (url === VERIFY_URL) return verifiedResponse();
    if (url === TOKEN_URL) return tokenResponse();
    if (url === GMAIL_URL) { gmailCalls += 1; return new Response("down", { status: 503 }); }
    throw new Error("unexpected endpoint");
  };
  assert.equal((await withFetchMock(unknownProvider, () => worker.fetch(contactRequest(), env))).status, 503);
  assert.equal((await withFetchMock(unknownProvider, () => worker.fetch(contactRequest(), env))).status, 503);
  assert.equal(gmailCalls, 1);
  const mismatch = await withFetchMock(unknownProvider, () => worker.fetch(contactRequest(validPayload({ message: "changed" })), env));
  assert.deepEqual(await responseBody(mismatch), { status: 409, body: { error: "idempotency_conflict" } });
  assert.equal(gmailCalls, 1);
});

test("strict direct CF IP validation and canonicalization reject ambiguous forms before providers", async () => {
  assert.equal(canonicalizeClientIp("192.0.2.1"), "192.0.2.1");
  assert.equal(canonicalizeClientIp("2001:0DB8::1"), "2001:0db8:0000:0000:0000:0000:0000:0001");
  assert.equal(canonicalizeClientIp("::ffff:192.0.2.1"), "0000:0000:0000:0000:0000:ffff:c000:0201");
  assert.equal(canonicalizeClientIp(" 192.0.2.1"), null);
  for (const ip of [null, "", "192.0.2.1, 198.51.100.2", "01.2.3.4", "2001::db8::1", "fe80::1%eth0"]) {
    const { env, counter } = createEnv();
    let providerCalls = 0;
    const headers = ip === null ? { "CF-Connecting-IP": "" } : { "CF-Connecting-IP": ip };
    const response = await withFetchMock(async () => { providerCalls += 1; return verifiedResponse(); },
      () => worker.fetch(contactRequest(validPayload(), { headers }), env));
    assert.equal(response.status, 503);
    assert.equal(providerCalls, 0);
    assert.equal(counter.calls.length, 0);
  }
});

test("visitor email CRLF injection is rejected before provider or message construction", async () => {
  const { env, counter } = createEnv();
  let providerCalls = 0;
  const response = await withFetchMock(async () => { providerCalls += 1; return verifiedResponse(); }, () => worker.fetch(
    contactRequest(validPayload({ email: "visitor@example.test\r\nBcc: attacker@example.test" })), env,
  ));
  assert.deepEqual(await responseBody(response), { status: 400, body: { error: "invalid_request" } });
  assert.equal(providerCalls, 0);
  assert.deepEqual(counter.calls, ["rate_check"]);
});

test("missing or invalid secrets, emails, environment, and binding fail closed", async () => {
  const overrides = [
    { CONTACT_RATE_LIMIT_HMAC_KEY: "short" },
    { CONTACT_IDEMPOTENCY_HMAC_KEY: "short" },
    { CONTACT_IDEMPOTENCY_HMAC_PREVIOUS_KEY: "short" },
    { CONTACT_IDEMPOTENCY_HMAC_PREVIOUS_KEY: "test-idempotency-hmac-key-at-least-32-bytes" },
    { GOOGLE_OAUTH_CLIENT_SECRET: "" },
    { GMAIL_SENDER_EMAIL: "bad\r\nBcc:x@example.test" },
    { CONTACT_ADMIN_EMAIL: "visitor-controlled" },
    { CONTACT_ENVIRONMENT: "staging" },
    { CONTACT_CASE_COUNTER: null },
  ];
  for (const override of overrides) {
    const { env } = createEnv(override);
    let providerCalls = 0;
    const response = await withFetchMock(async () => { providerCalls += 1; return verifiedResponse(); }, () => worker.fetch(contactRequest(), env));
    assert.equal(response.status, 503);
    assert.equal(providerCalls, 0);
  }
});

test("Turnstile remains mandatory and fail closed before OAuth", async () => {
  for (const [siteverify, status] of [
    [Response.json({ success: false, "error-codes": ["invalid-input-response"] }), 400],
    [verifiedResponse({ hostname: "attacker.test" }), 403],
    [new Response("down", { status: 503 }), 503],
    [new Response("not-json"), 503],
  ]) {
    const { env, counter } = createEnv();
    let calls = 0;
    const response = await withFetchMock(async (url) => {
      calls += 1;
      assert.equal(url, VERIFY_URL);
      return siteverify.clone();
    }, () => worker.fetch(contactRequest(), env));
    assert.equal(response.status, status);
    assert.equal(calls, 1);
    assert.deepEqual(counter.calls, ["rate_check"]);
  }
});

test("method and API routing never fall through while static routes delegate", async () => {
  const { env, assetRequests } = createEnv();
  const method = await worker.fetch(new Request("https://example.test/api/contact"), env);
  assert.equal(method.status, 405);
  assert.equal(method.headers.get("Allow"), "POST");
  for (const path of ["/api", "/api/unknown", "/api/contact?x=1"]) {
    assert.equal((await worker.fetch(new Request(`https://example.test${path}`), env)).status, 404);
  }
  assert.equal((await worker.fetch(new Request("https://example.test/research/project"), env)).status, 200);
  assert.equal(assetRequests.length, 1);
});
