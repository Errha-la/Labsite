import {
  createIdempotencyDigests,
  initializeIdempotencySchema,
  reserveIdempotencyRecord,
  transitionIdempotencyRecord,
} from "./contact-idempotency.js";

const MAX_BODY_BYTES = 8192;
const COUNTER_EXHAUSTED = "COUNTER_EXHAUSTED";
const TRANSITION_STATES = new Set(["sending", "accepted", "definite_failure", "unknown"]);

function initializeCounterSchema(sql) {
  sql.exec(`CREATE TABLE IF NOT EXISTS contact_case_counter (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    next_value INTEGER NOT NULL CHECK(next_value >= 1),
    exhausted INTEGER NOT NULL DEFAULT 0 CHECK(exhausted IN (0, 1))
  )`);
  sql.exec("INSERT OR IGNORE INTO contact_case_counter (singleton, next_value, exhausted) VALUES (1, 1, 0)");
}

function allocateCase(sql) {
  const row = sql.exec(
    "SELECT next_value, exhausted FROM contact_case_counter WHERE singleton = 1",
  ).one();
  if (row.exhausted === 1 || !Number.isSafeInteger(row.next_value) || row.next_value < 1) {
    return { error: COUNTER_EXHAUSTED };
  }
  const caseNumber = String(row.next_value).padStart(4, "0");
  if (row.next_value === Number.MAX_SAFE_INTEGER) {
    sql.exec("UPDATE contact_case_counter SET exhausted = 1 WHERE singleton = 1");
  } else {
    sql.exec("UPDATE contact_case_counter SET next_value = next_value + 1 WHERE singleton = 1");
  }
  return { caseNumber };
}

function json(body, status = 200) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function hasExactKeys(value, required, optional = []) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key))
    && keys.every((key) => allowed.has(key));
}

async function readJson(request) {
  if (request.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") return null;
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function resolveNow(env, value) {
  if (value === undefined) return Date.now();
  if (env.CONTACT_TEST_CLOCK !== "enabled" || !Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

function errorResponse(error) {
  if (error === "IDEMPOTENCY_CONFLICT" || error === "IDEMPOTENCY_TRANSITION_REJECTED") {
    return json({ error }, 409);
  }
  if (error === "IDEMPOTENCY_NOT_FOUND") return json({ error }, 404);
  if (error === "IDEMPOTENCY_CAPACITY" || error === COUNTER_EXHAUSTED) return json({ error }, 503);
  return json({ error: "invalid_request" }, 400);
}

export class ContactCaseCounter {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sql = state.storage.sql;
    state.storage.transactionSync(() => {
      initializeCounterSchema(this.sql);
      initializeIdempotencySchema(this.sql);
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== "/" || url.search || request.method !== "POST") {
      return json({ error: "not_found" }, 404);
    }
    const input = await readJson(request);
    if (!input || typeof input.action !== "string") return json({ error: "invalid_request" }, 400);

    if (input.action === "allocate") {
      if (!hasExactKeys(input, ["action"])) return json({ error: "invalid_request" }, 400);
      const result = this.state.storage.transactionSync(() => allocateCase(this.sql));
      return result.error ? errorResponse(result.error) : json(result, 201);
    }

    const required = input.action === "reserve"
      ? ["action", "idempotencyKey", "payload"]
      : ["action", "idempotencyKey", "payload", "to"];
    if (!hasExactKeys(input, required, ["now"])) return json({ error: "invalid_request" }, 400);
    if (input.action !== "reserve" && input.action !== "transition") return json({ error: "invalid_request" }, 400);
    if (input.action === "transition" && !TRANSITION_STATES.has(input.to)) return json({ error: "invalid_request" }, 400);
    const now = resolveNow(this.env, input.now);
    if (now === null) return json({ error: "invalid_request" }, 400);

    let digests;
    try {
      digests = await createIdempotencyDigests(
        this.env.CONTACT_IDEMPOTENCY_HMAC_KEY,
        input.idempotencyKey,
        input.payload,
      );
    } catch {
      return json({ error: "service_unavailable" }, 503);
    }
    if (!digests) return json({ error: "invalid_request" }, 400);

    const result = this.state.storage.transactionSync(() => input.action === "reserve"
      ? reserveIdempotencyRecord(this.sql, { ...digests, now, allocateCase: () => allocateCase(this.sql) })
      : transitionIdempotencyRecord(this.sql, { ...digests, now, to: input.to }));
    if (result.error) return errorResponse(result.error);
    return json(result, result.created ? 201 : 200);
  }
}
