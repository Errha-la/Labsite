import assert from "node:assert/strict";
import test from "node:test";
import worker from "../worker/index.js";

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

function createEnv(overrides = {}) {
  const assetRequests = [];
  return {
    env: {
      ASSETS: {
        async fetch(request) {
          assetRequests.push(request);
          return new Response("static asset", { headers: { "Content-Type": "text/plain" } });
        },
      },
      TURNSTILE_SECRET: "test-secret",
      TURNSTILE_EXPECTED_HOSTNAME: "example.test",
      ...overrides,
    },
    assetRequests,
  };
}

function validPayload(overrides = {}) {
  return {
    consent: true,
    email: "visitor@example.test",
    message: "Hello",
    name: "Visitor",
    reason: "other",
    turnstileToken: "token-1",
    ...overrides,
  };
}

function contactRequest(payload = validPayload(), options = {}) {
  return new Request(options.url || "https://example.test/api/contact", {
    method: options.method || "POST",
    headers: options.headers || { "Content-Type": "application/json" },
    body: options.body === undefined ? JSON.stringify(payload) : options.body,
    ...(options.duplex ? { duplex: options.duplex } : {}),
  });
}

async function withFetchMock(mock, callback) {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  try {
    return await callback();
  } finally {
    globalThis.fetch = original;
  }
}

function verifiedResponse(overrides = {}) {
  return Response.json({ success: true, hostname: "example.test", action: "contact", ...overrides });
}

async function expectJson(response, status, error) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.match(response.headers.get("Content-Type"), /^application\/json/);
  assert.deepEqual(await response.json(), { error });
}

test("valid schema, normalized values, and verified token return only the 501 stub", async () => {
  const { env, assetRequests } = createEnv();
  let verifyRequest;
  await withFetchMock(async (url, init) => {
    verifyRequest = { url, init };
    return verifiedResponse();
  }, async () => {
    const response = await worker.fetch(contactRequest(validPayload({
      name: "  Visitor  ",
      email: "  visitor@example.test  ",
      message: "  first\r\nsecond\r  ",
      turnstileToken: "  token-1  ",
    })), env);
    await expectJson(response, 501, "not_implemented");
  });
  assert.equal(assetRequests.length, 0);
  assert.equal(new URLSearchParams(verifyRequest.init.body).get("response"), "token-1");
  assert.equal("MAIL" in env, false);
});

test("verified contact requests do not invoke the case allocator or idempotency ledger", async () => {
  let durableObjectCalls = 0;
  const { env } = createEnv({
    CONTACT_CASE_COUNTER: {
      idFromName() { durableObjectCalls += 1; throw new Error("must not allocate"); },
      get() { durableObjectCalls += 1; throw new Error("must not open ledger"); },
    },
  });
  await withFetchMock(async () => verifiedResponse(), async () => {
    await expectJson(await worker.fetch(contactRequest(), env), 501, "not_implemented");
  });
  assert.equal(durableObjectCalls, 0);
});

test("exact contact key set, consent, string types, and reason enum are enforced", async () => {
  const { env } = createEnv();
  const invalid = [
    { ...validPayload(), extra: "no" },
    Object.fromEntries(Object.entries(validPayload()).filter(([key]) => key !== "name")),
    validPayload({ consent: false }),
    validPayload({ consent: "true" }),
    validPayload({ name: 1 }),
    validPayload({ email: null }),
    validPayload({ message: [] }),
    validPayload({ reason: "Professor" }),
    validPayload({ turnstileToken: {} }),
  ];
  let calls = 0;
  await withFetchMock(async () => { calls += 1; return verifiedResponse(); }, async () => {
    for (const payload of invalid) {
      await expectJson(await worker.fetch(contactRequest(payload), env), 400, "invalid_request");
    }
  });
  assert.equal(calls, 0);
});

test("name, message, token, and email bounds reject empty and over-limit values", async () => {
  const { env } = createEnv();
  const invalid = [
    validPayload({ name: "   " }),
    validPayload({ name: "n".repeat(101) }),
    validPayload({ message: "\r\n  " }),
    validPayload({ message: "m".repeat(1501) }),
    validPayload({ turnstileToken: "  " }),
    validPayload({ turnstileToken: "t".repeat(2049) }),
    validPayload({ email: `${"a".repeat(243)}@example.test` }),
  ];
  await withFetchMock(async () => verifiedResponse(), async () => {
    for (const payload of invalid) {
      await expectJson(await worker.fetch(contactRequest(payload), env), 400, "invalid_request");
    }
    for (const payload of [
      validPayload({ name: "n".repeat(100) }),
      validPayload({ message: "m".repeat(1500) }),
      validPayload({ turnstileToken: "t".repeat(2048) }),
    ]) {
      await expectJson(await worker.fetch(contactRequest(payload), env), 501, "not_implemented");
    }
  });
});

test("email rejects controls, whitespace, repeated dots, malformed domains, and multiple at signs", async () => {
  const { env } = createEnv();
  for (const email of [
    "a b@example.test",
    "a\n@example.test",
    ".a@example.test",
    "a..b@example.test",
    "a@example..test",
    "a@-example.test",
    "a@@example.test",
    "not-an-address",
  ]) {
    await expectJson(await worker.fetch(contactRequest(validPayload({ email })), env), 400, "invalid_request");
  }
});

test("JSON content type, valid JSON, and exact query-free path are required", async () => {
  const { env } = createEnv();
  await expectJson(await worker.fetch(contactRequest(null, { headers: { "Content-Type": "text/plain" } }), env), 400, "invalid_request");
  await expectJson(await worker.fetch(contactRequest(null, { headers: { "Content-Type": "application/problem+json" } }), env), 400, "invalid_request");
  await expectJson(await worker.fetch(contactRequest(null, { body: "{" }), env), 400, "invalid_request");
  await expectJson(await worker.fetch(contactRequest(validPayload(), { url: "https://example.test/api/contact?x=1" }), env), 404, "not_found");
});

test("body cap accepts 8192 bytes for schema validation and rejects 8193 without Content-Length", async () => {
  const { env } = createEnv();
  for (const [size, status, error] of [[8192, 400, "invalid_request"], [8193, 413, "request_too_large"]]) {
    const prefix = '{"padding":"';
    const suffix = '"}';
    const text = prefix + "x".repeat(size - prefix.length - suffix.length) + suffix;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    });
    const request = contactRequest(null, { body: stream, duplex: "half" });
    assert.equal(request.headers.has("Content-Length"), false);
    await expectJson(await worker.fetch(request, env), status, error);
  }
});

test("Content-Length over 8192 is rejected before reading the stream", async () => {
  const { env } = createEnv();
  const request = contactRequest(null, {
    headers: { "Content-Type": "application/json", "Content-Length": "8193" },
    body: JSON.stringify(validPayload()),
  });
  await expectJson(await worker.fetch(request, env), 413, "request_too_large");
  assert.equal(request.bodyUsed, false);
});

test("Siteverify uses the fixed URL, POST form body, manual redirects, and no remote IP", async () => {
  const { env } = createEnv();
  let captured;
  await withFetchMock(async (url, init) => { captured = { url, init }; return verifiedResponse(); }, async () => {
    await expectJson(await worker.fetch(contactRequest(), env), 501, "not_implemented");
  });
  assert.equal(captured.url, VERIFY_URL);
  assert.equal(new URL(captured.url).search, "");
  assert.equal(captured.init.method, "POST");
  assert.equal(captured.init.redirect, "manual");
  assert.equal(captured.init.headers["Content-Type"], "application/x-www-form-urlencoded");
  const body = new URLSearchParams(captured.init.body);
  assert.deepEqual([...body.keys()].sort(), ["idempotency_key", "response", "secret"]);
  assert.equal(body.get("secret"), "test-secret");
  assert.equal(body.get("response"), "token-1");
  assert.match(body.get("idempotency_key"), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(body.has("remoteip"), false);
});

test("missing secret or expected hostname fails closed before Siteverify", async () => {
  let calls = 0;
  await withFetchMock(async () => { calls += 1; return verifiedResponse(); }, async () => {
    for (const overrides of [{ TURNSTILE_SECRET: "" }, { TURNSTILE_EXPECTED_HOSTNAME: "" }]) {
      const { env } = createEnv(overrides);
      await expectJson(await worker.fetch(contactRequest(), env), 503, "service_unavailable");
    }
  });
  assert.equal(calls, 0);
});

test("invalid, expired, and duplicate token codes map to generic 400", async () => {
  for (const code of ["invalid-input-response", "missing-input-response", "timeout-or-duplicate"]) {
    const { env } = createEnv();
    await withFetchMock(async () => Response.json({ success: false, "error-codes": [code] }), async () => {
      await expectJson(await worker.fetch(contactRequest(), env), 400, "verification_failed");
    });
  }
});

test("hostname or action mismatch maps to generic 403", async () => {
  for (const response of [
    verifiedResponse({ hostname: "attacker.test" }),
    verifiedResponse({ action: "other" }),
  ]) {
    const { env } = createEnv();
    await withFetchMock(async () => response, async () => {
      await expectJson(await worker.fetch(contactRequest(), env), 403, "verification_failed");
    });
  }
});

test("provider service codes, mixed or unknown codes, malformed data, non-2xx, and network errors map to 503", async () => {
  const cases = [
    async () => Response.json({ success: false, "error-codes": ["missing-input-secret"] }),
    async () => Response.json({ success: false, "error-codes": ["invalid-input-secret"] }),
    async () => Response.json({ success: false, "error-codes": ["bad-request"] }),
    async () => Response.json({ success: false, "error-codes": ["internal-error"] }),
    async () => Response.json({ success: false, "error-codes": ["invalid-input-response", "internal-error"] }),
    async () => Response.json({ success: false, "error-codes": ["future-code"] }),
    async () => Response.json({ success: false }),
    async () => Response.json({ success: "true", hostname: "example.test", action: "contact" }),
    async () => new Response("not-json", { status: 200 }),
    async () => new Response("redirect", { status: 302 }),
    async () => new Response("down", { status: 503 }),
    async () => { throw new Error("network down"); },
  ];
  for (const mock of cases) {
    const { env } = createEnv();
    await withFetchMock(mock, async () => {
      await expectJson(await worker.fetch(contactRequest(), env), 503, "service_unavailable");
    });
  }
});

test("Siteverify aborts at 3500ms and always clears the timer", async () => {
  const { env } = createEnv();
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let delay;
  let timer;
  let cleared;
  globalThis.setTimeout = (callback, milliseconds) => {
    delay = milliseconds;
    timer = { timer: true };
    queueMicrotask(callback);
    return timer;
  };
  globalThis.clearTimeout = (value) => { cleared = value; };
  try {
    await withFetchMock(async (_url, { signal }) => new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason || new DOMException("Aborted", "AbortError"));
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }), async () => {
      await expectJson(await worker.fetch(contactRequest(), env), 503, "service_unavailable");
    });
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
  assert.equal(delay, 3500);
  assert.equal(cleared, timer);
});

test("successful Siteverify clears its timer", async () => {
  const { env } = createEnv();
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timer = { timer: true };
  let cleared;
  globalThis.setTimeout = (_callback, milliseconds) => {
    assert.equal(milliseconds, 3500);
    return timer;
  };
  globalThis.clearTimeout = (value) => { cleared = value; };
  try {
    await withFetchMock(async () => verifiedResponse(), async () => {
      await expectJson(await worker.fetch(contactRequest(), env), 501, "not_implemented");
    });
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
  assert.equal(cleared, timer);
});

test("reusing a token performs a second verification and a provider duplicate result fails", async () => {
  const { env } = createEnv();
  const ids = [];
  let calls = 0;
  await withFetchMock(async (_url, init) => {
    calls += 1;
    ids.push(new URLSearchParams(init.body).get("idempotency_key"));
    return calls === 1
      ? verifiedResponse()
      : Response.json({ success: false, "error-codes": ["timeout-or-duplicate"] });
  }, async () => {
    await expectJson(await worker.fetch(contactRequest(), env), 501, "not_implemented");
    await expectJson(await worker.fetch(contactRequest(), env), 400, "verification_failed");
  });
  assert.equal(calls, 2);
  assert.notEqual(ids[0], ids[1]);
});

test("method and API routing never fall through to static assets", async () => {
  const { env, assetRequests } = createEnv();
  const response = await worker.fetch(new Request("https://example.test/api/contact"), env);
  await expectJson(response, 405, "method_not_allowed");
  assert.equal(response.headers.get("Allow"), "POST");
  for (const path of ["/api", "/api/unknown", "/api/contact?query=1"]) {
    await expectJson(await worker.fetch(new Request(`https://example.test${path}`), env), 404, "not_found");
  }
  assert.equal(assetRequests.length, 0);
});

test("static routes and refreshes delegate unchanged to Workers Static Assets", async () => {
  const { env, assetRequests } = createEnv();
  for (const path of ["/", "/research/project"]) {
    const request = new Request(`https://example.test${path}`);
    const response = await worker.fetch(request, env);
    assert.equal(await response.text(), "static asset");
    assert.equal(assetRequests.at(-1), request);
  }
  assert.equal(assetRequests.length, 2);
});
