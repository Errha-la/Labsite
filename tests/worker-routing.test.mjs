import assert from "node:assert/strict";
import test from "node:test";
import worker from "../worker/index.js";

function createEnv() {
  const assetRequests = [];
  return {
    env: {
      ASSETS: {
        async fetch(request) {
          assetRequests.push(request);
          return new Response("static asset", {
            headers: { "Content-Type": "text/plain" },
          });
        },
      },
    },
    assetRequests,
  };
}

test("POST /api/contact returns a non-success stub without reading the body", async () => {
  const { env, assetRequests } = createEnv();
  const request = new Request("https://example.test/api/contact", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Visitor", email: "visitor@example.test", message: "Hello" }),
  });

  const response = await worker.fetch(request, env);

  assert.equal(response.status, 501);
  assert.deepEqual(await response.json(), { error: "not_implemented" });
  assert.equal(request.bodyUsed, false);
  assert.equal(assetRequests.length, 0);
});

test("non-POST /api/contact returns 405 and does not fall through to assets", async () => {
  const { env, assetRequests } = createEnv();
  const response = await worker.fetch(
    new Request("https://example.test/api/contact"),
    env,
  );

  assert.equal(response.status, 405);
  assert.equal(response.headers.get("Allow"), "POST");
  assert.deepEqual(await response.json(), { error: "method_not_allowed" });
  assert.equal(assetRequests.length, 0);
});

test("unknown API paths return JSON 404 instead of the SPA document", async () => {
  const { env, assetRequests } = createEnv();

  for (const path of ["/api", "/api/unknown"]) {
    const response = await worker.fetch(new Request(`https://example.test${path}`), env);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "not_found" });
  }

  assert.equal(assetRequests.length, 0);
});

test("non-API paths are delegated to Workers Static Assets", async () => {
  const { env, assetRequests } = createEnv();
  const request = new Request("https://example.test/research/project");
  const response = await worker.fetch(request, env);

  assert.equal(await response.text(), "static asset");
  assert.equal(assetRequests.length, 1);
  assert.equal(assetRequests[0], request);
});
