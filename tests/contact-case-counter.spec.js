import { env } from "cloudflare:test";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, test, vi } from "vitest";
import {
  createIdempotencyDigests,
  IDEMPOTENCY_MAX_ROWS,
  IDEMPOTENCY_TTL_MS,
  SENDING_STALE_MS,
} from "../worker/contact-idempotency.js";
import { RATE_LIMIT_MAX_ROWS, RATE_LIMIT_WINDOW_MS } from "../worker/contact-case-counter.js";

const PAYLOAD = {
  consent: true,
  email: "visitor@example.test",
  message: "Private visitor message",
  name: "Private Visitor",
  reason: "other",
};

function stub(name) {
  const id = env.CONTACT_CASE_COUNTER.idFromName(name);
  return env.CONTACT_CASE_COUNTER.get(id);
}

async function post(target, body) {
  const response = await target.fetch("https://counter.internal/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

function reserve(target, key, overrides = {}) {
  return post(target, {
    action: "reserve",
    idempotencyKey: key,
    payload: PAYLOAD,
    now: 1_000_000,
    ...overrides,
  });
}

function transition(target, key, to, overrides = {}) {
  return post(target, {
    action: "transition",
    idempotencyKey: key,
    payload: PAYLOAD,
    to,
    now: 1_000_001,
    ...overrides,
  });
}

function claim(target, key, overrides = {}) {
  return post(target, {
    action: "claim_send",
    idempotencyKey: key,
    payload: PAYLOAD,
    now: 1_000_001,
    ...overrides,
  });
}

function rateCheck(target, rateKey, now = 1_000_000) {
  return post(target, { action: "rate_check", rateKey, now });
}

function budgetStatus(target, now = 1_000_000) {
  return post(target, { action: "budget_status", now });
}

describe("persistent sequential contact case counter", () => {
  test("concurrent allocations are unique, sequential, and expand after four digits", async () => {
    const target = stub("concurrent");
    const results = await Promise.all(Array.from({ length: 10_001 }, () => post(target, { action: "allocate" })));
    expect(results.every(({ status }) => status === 201)).toBe(true);
    const numbers = results.map(({ body }) => Number(body.caseNumber)).sort((a, b) => a - b);
    expect(numbers).toEqual(Array.from({ length: 10_001 }, (_, index) => index + 1));
    expect(results.map(({ body }) => body.caseNumber)).toContain("0001");
    expect(results.map(({ body }) => body.caseNumber)).toContain("10000");
  }, 60_000);

  test("SQLite transaction rollback does not consume a case number", async () => {
    const target = stub("rollback");
    await expect(runInDurableObject(target, (_instance, state) => {
      state.storage.transactionSync(() => {
        state.storage.sql.exec("UPDATE contact_case_counter SET next_value = 2 WHERE singleton = 1");
        throw new Error("controlled rollback");
      });
    })).rejects.toThrow("controlled rollback");
    expect(await post(target, { action: "allocate" })).toEqual({ status: 201, body: { caseNumber: "0001" } });
  });

  test("counter survives object eviction and environment-scoped objects stay isolated", async () => {
    const production = stub("environment-production");
    expect((await post(production, { action: "allocate" })).body.caseNumber).toBe("0001");
    await evictDurableObject(production);
    expect((await post(production, { action: "allocate" })).body.caseNumber).toBe("0002");

    const preview = stub("environment-preview");
    expect((await post(preview, { action: "allocate" })).body.caseNumber).toBe("0001");
  });

  test("allocates Number.MAX_SAFE_INTEGER once, then returns terminal COUNTER_EXHAUSTED without mutation", async () => {
    const target = stub("overflow");
    await runInDurableObject(target, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE contact_case_counter SET next_value = ?, exhausted = 0 WHERE singleton = 1",
        Number.MAX_SAFE_INTEGER,
      );
    });
    expect(await post(target, { action: "allocate" })).toEqual({
      status: 201,
      body: { caseNumber: String(Number.MAX_SAFE_INTEGER) },
    });
    expect(await post(target, { action: "allocate" })).toEqual({
      status: 503,
      body: { error: "COUNTER_EXHAUSTED" },
    });
    expect(await runInDurableObject(target, (_instance, state) => state.storage.sql.exec(
      "SELECT next_value, exhausted FROM contact_case_counter WHERE singleton = 1",
    ).one())).toEqual({ next_value: Number.MAX_SAFE_INTEGER, exhausted: 1 });
  });
});

describe("privacy-preserving idempotency ledger", () => {
  test("identical retries persist one HMAC-only record and never allocate twice", async () => {
    const target = stub("persistent-idempotency");
    const key = "persistent-idempotency-key";
    const first = await reserve(target, key);
    expect(first).toMatchObject({ status: 201, body: { created: true, caseNumber: "0001", state: "reserved" } });
    await evictDurableObject(target);
    const retry = await reserve(target, key);
    expect(retry).toEqual({ status: 200, body: { ...first.body, created: false } });
    expect((await post(target, { action: "allocate" })).body.caseNumber).toBe("0002");

    const stored = await runInDurableObject(target, (_instance, state) => ({
      columns: state.storage.sql.exec("PRAGMA table_info(contact_idempotency)").toArray().map(({ name }) => name),
      rows: state.storage.sql.exec("SELECT * FROM contact_idempotency").toArray(),
    }));
    expect(stored.columns).toEqual([
      "key_hash", "payload_hash", "case_number", "state", "created_at", "updated_at", "expires_at",
    ]);
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0].key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.rows[0].payload_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(key);
    for (const privateValue of [PAYLOAD.name, PAYLOAD.email, PAYLOAD.message]) {
      expect(JSON.stringify(stored)).not.toContain(privateValue);
    }
    const expected = await createIdempotencyDigests(
      "test-only-hmac-key-at-least-32-bytes-long",
      key,
      PAYLOAD,
    );
    expect(stored.rows[0]).toMatchObject(expected && {
      key_hash: expected.keyHash,
      payload_hash: expected.payloadHash,
    });
  });

  test("payload hash conflicts fail closed without allocating another case", async () => {
    const target = stub("payload-conflict");
    const key = "payload-conflict-key";
    await reserve(target, key);
    const conflict = await reserve(target, key, { payload: { ...PAYLOAD, message: "Changed message" } });
    expect(conflict).toEqual({ status: 409, body: { error: "IDEMPOTENCY_CONFLICT" } });
    expect((await post(target, { action: "allocate" })).body.caseNumber).toBe("0002");
  });

  test("24-hour expiry removes the old record and permits a new case", async () => {
    const target = stub("expiration");
    const key = "expiration-idempotency-key";
    expect((await reserve(target, key)).body.caseNumber).toBe("0001");
    const expired = await reserve(target, key, { now: 1_000_000 + IDEMPOTENCY_TTL_MS });
    expect(expired).toMatchObject({ status: 201, body: { created: true, caseNumber: "0002" } });
  });

  test("10,000 live rows enforce capacity without consuming the counter", async () => {
    const target = stub("capacity");
    await runInDurableObject(target, (_instance, state) => {
      state.storage.transactionSync(() => {
        for (let index = 0; index < IDEMPOTENCY_MAX_ROWS; index += 1) {
          const hash = index.toString(16).padStart(64, "0");
          state.storage.sql.exec(
            `INSERT INTO contact_idempotency
              (key_hash, payload_hash, case_number, state, created_at, updated_at, expires_at)
              VALUES (?, ?, ?, 'accepted', 0, 0, ?)`,
            hash,
            "f".repeat(64),
            String(index + 1).padStart(4, "0"),
            IDEMPOTENCY_TTL_MS + 10,
          );
        }
      });
    });
    expect(await reserve(target, "capacity-idempotency-key")).toEqual({
      status: 503,
      body: { error: "IDEMPOTENCY_CAPACITY" },
    });
    expect((await post(target, { action: "allocate" })).body.caseNumber).toBe("0001");
  }, 60_000);

  test("only allowed transitions succeed and terminal states cannot reopen", async () => {
    const target = stub("transitions");
    const key = "transition-idempotency-key";
    await reserve(target, key);
    expect(await transition(target, key, "accepted")).toEqual({
      status: 409,
      body: { error: "IDEMPOTENCY_TRANSITION_REJECTED" },
    });
    expect((await claim(target, key)).body).toMatchObject({ state: "sending", claimed: true });
    expect((await transition(target, key, "accepted", { now: 1_000_002 })).body.state).toBe("accepted");
    expect(await transition(target, key, "unknown", { now: 1_000_003 })).toEqual({
      status: 409,
      body: { error: "IDEMPOTENCY_TRANSITION_REJECTED" },
    });

    const failureKey = "failure-idempotency-key";
    await reserve(target, failureKey);
    expect((await transition(target, failureKey, "definite_failure")).body.state).toBe("definite_failure");
  });

  test("stale sending becomes terminal unknown and identical retries cannot resend", async () => {
    const target = stub("stale-sending");
    const key = "stale-sending-key";
    const send = vi.fn(async () => { throw new Error("delivery outcome unavailable"); });

    const first = await reserve(target, key);
    if (first.body.created) {
      await claim(target, key);
      await expect(send()).rejects.toThrow("delivery outcome unavailable");
      await transition(target, key, "unknown", { now: 1_000_002 });
    }
    const retry = await reserve(target, key, { now: 1_000_003 });
    if (retry.body.created) await send();
    expect(retry).toMatchObject({ status: 200, body: { created: false, state: "unknown", caseNumber: "0001" } });
    expect(send).toHaveBeenCalledTimes(1);

    const staleKey = "stale-timeout-key";
    await reserve(target, staleKey);
    await claim(target, staleKey);
    const stale = await reserve(target, staleKey, { now: 1_000_001 + SENDING_STALE_MS });
    expect(stale).toMatchObject({ status: 200, body: { created: false, state: "unknown" } });
    expect(await transition(target, staleKey, "accepted", { now: 1_000_002 + SENDING_STALE_MS })).toEqual({
      status: 409,
      body: { error: "IDEMPOTENCY_TRANSITION_REJECTED" },
    });
  });

  test("generic transition cannot bypass the atomic budgeted send claim", async () => {
    const target = stub("no-generic-sending");
    const key = "no-generic-sending-key";
    await reserve(target, key);
    expect(await transition(target, key, "sending")).toEqual({
      status: 400,
      body: { error: "invalid_request" },
    });
    expect((await claim(target, key)).body).toMatchObject({ state: "sending", claimed: true });
    expect((await claim(target, key, { now: 1_000_002 })).body).toMatchObject({ state: "sending", claimed: false });
  });

  test("concurrent production and preview send claims enforce exact daily budgets", async () => {
    const production = stub("budget-production");
    expect(await budgetStatus(production)).toEqual({ status: 200, body: { available: true, remaining: 50 } });
    const productionKeys = Array.from({ length: 51 }, (_, index) => `production-budget-key-${index}`);
    await Promise.all(productionKeys.map((key) => reserve(production, key)));
    const productionClaims = await Promise.all(productionKeys.map((key) => claim(production, key)));
    expect(productionClaims.filter(({ status, body }) => status === 200 && body.claimed === true)).toHaveLength(50);
    expect(productionClaims.filter(({ status, body }) => status === 503 && body.error === "SEND_BUDGET_EXHAUSTED")).toHaveLength(1);
    expect((await claim(production, productionKeys[0], { now: 1_000_002 })).body.claimed).toBe(false);
    expect(await runInDurableObject(production, (_instance, state) => state.storage.sql.exec(
      "SELECT used FROM contact_send_budget WHERE environment = 'production'",
    ).one())).toEqual({ used: 50 });
    expect(await budgetStatus(production)).toEqual({ status: 200, body: { available: false, remaining: 0 } });

    const preview = stub("budget-preview");
    await runInDurableObject(preview, (instance) => { instance.env.CONTACT_ENVIRONMENT = "preview"; });
    expect(await budgetStatus(preview)).toEqual({ status: 200, body: { available: true, remaining: 5 } });
    const previewKeys = Array.from({ length: 6 }, (_, index) => `preview-budget-key-${index}`);
    await Promise.all(previewKeys.map((key) => reserve(preview, key)));
    const previewClaims = await Promise.all(previewKeys.map((key) => claim(preview, key)));
    expect(previewClaims.filter(({ status, body }) => status === 200 && body.claimed === true)).toHaveLength(5);
    expect(previewClaims.filter(({ status }) => status === 503)).toHaveLength(1);
  });

  test("previous HMAC key lookup survives rotation and conflicting dual records fail closed", async () => {
    const target = stub("key-rotation");
    const oldSecret = "old-test-hmac-key-at-least-32-bytes-long";
    const newSecret = "new-test-hmac-key-at-least-32-bytes-long";
    await runInDurableObject(target, (instance) => { instance.env.CONTACT_IDEMPOTENCY_HMAC_KEY = oldSecret; });
    const original = await reserve(target, "rotation-idempotency-key");
    await runInDurableObject(target, (instance) => {
      instance.env.CONTACT_IDEMPOTENCY_HMAC_KEY = newSecret;
      instance.env.CONTACT_IDEMPOTENCY_HMAC_PREVIOUS_KEY = oldSecret;
    });
    expect(await reserve(target, "rotation-idempotency-key")).toEqual({
      status: 200,
      body: { ...original.body, created: false },
    });

    const conflictKey = "rotation-conflict-key";
    const oldDigest = await createIdempotencyDigests(oldSecret, conflictKey, PAYLOAD);
    const newDigest = await createIdempotencyDigests(newSecret, conflictKey, PAYLOAD);
    await runInDurableObject(target, (_instance, state) => {
      for (const [digest, caseNumber] of [[oldDigest, "9001"], [newDigest, "9002"]]) {
        state.storage.sql.exec(
          `INSERT INTO contact_idempotency
            (key_hash, payload_hash, case_number, state, created_at, updated_at, expires_at)
            VALUES (?, ?, ?, 'reserved', 0, 0, ?)`,
          digest.keyHash, digest.payloadHash, caseNumber, IDEMPOTENCY_TTL_MS + 10,
        );
      }
    });
    expect(await reserve(target, conflictKey)).toEqual({
      status: 409,
      body: { error: "IDEMPOTENCY_DUAL_RECORD_CONFLICT" },
    });
  });
});

describe("strict privacy-preserving rolling rate limit", () => {
  test("exact 60-second boundary denies until the earliest timestamp ages out and denial does not write", async () => {
    const target = stub("rate-boundary");
    const hash = "a".repeat(64);
    const results = await Promise.all(Array.from({ length: 5 }, () => rateCheck(target, hash, 59_999)));
    expect(results.filter(({ status, body }) => status === 200 && body.allowed)).toHaveLength(5);
    const before = await runInDurableObject(target, (_instance, state) => state.storage.sql.exec(
      `SELECT request_1, request_2, request_3, request_4, request_5, expires_at
        FROM contact_rate_windows WHERE key_hash = ?`, hash,
    ).one());
    expect(await rateCheck(target, hash, 119_998)).toEqual({ status: 429, body: { allowed: false } });
    expect(await rateCheck(target, hash, 119_999)).toEqual({ status: 429, body: { allowed: false } });
    const after = await runInDurableObject(target, (_instance, state) => state.storage.sql.exec(
      `SELECT request_1, request_2, request_3, request_4, request_5, expires_at
        FROM contact_rate_windows WHERE key_hash = ?`, hash,
    ).one());
    expect(after).toEqual(before);
    expect(await rateCheck(target, hash, 120_000))
      .toMatchObject({ status: 200, body: { allowed: true, remaining: 4 } });
  });

  test("six concurrent requests admit exactly five", async () => {
    const target = stub("rate-concurrent");
    const hash = "b".repeat(64);
    const results = await Promise.all(Array.from({ length: 6 }, () => rateCheck(target, hash)));
    expect(results.filter(({ status, body }) => status === 200 && body.allowed)).toHaveLength(5);
    expect(results.filter(({ status, body }) => status === 429 && body.allowed === false)).toHaveLength(1);
  });

  test("bounded rate storage fails closed at capacity", async () => {
    const target = stub("rate-capacity");
    await runInDurableObject(target, (_instance, state) => {
      state.storage.transactionSync(() => {
        for (let index = 0; index < RATE_LIMIT_MAX_ROWS; index += 1) {
          state.storage.sql.exec(
            `INSERT INTO contact_rate_windows
              (key_hash, request_1, request_2, request_3, request_4, request_5, expires_at)
              VALUES (?, 0, NULL, NULL, NULL, NULL, ?)`,
            index.toString(16).padStart(64, "0"), RATE_LIMIT_WINDOW_MS * 100,
          );
        }
      });
    });
    expect(await rateCheck(target, "f".repeat(64))).toEqual({
      status: 503,
      body: { error: "RATE_LIMIT_CAPACITY" },
    });
  }, 60_000);
});
