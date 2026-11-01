import {
  claimIdempotencySend,
  createIdempotencyCandidates,
  initializeIdempotencySchema,
  reserveIdempotencyRecord,
  transitionIdempotencyRecord,
} from "./contact-idempotency.js";

const MAX_BODY_BYTES = 8192;
const COUNTER_EXHAUSTED = "COUNTER_EXHAUSTED";
export const RATE_LIMIT_MAX_ROWS = 10_000;
export const RATE_LIMIT_WINDOW_MS = 60_000;
export const RATE_LIMIT_REQUESTS = 5;
const FINAL_STATES = new Set(["accepted", "definite_failure", "unknown"]);

function initializeSchemas(sql) {
  sql.exec(`CREATE TABLE IF NOT EXISTS contact_case_counter (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    next_value INTEGER NOT NULL CHECK(next_value >= 1),
    exhausted INTEGER NOT NULL DEFAULT 0 CHECK(exhausted IN (0, 1))
  )`);
  sql.exec("INSERT OR IGNORE INTO contact_case_counter (singleton, next_value, exhausted) VALUES (1, 1, 0)");
  initializeIdempotencySchema(sql);
  sql.exec(`CREATE TABLE IF NOT EXISTS contact_send_budget (
    environment TEXT NOT NULL CHECK(environment IN ('production', 'preview')),
    utc_day INTEGER NOT NULL,
    used INTEGER NOT NULL CHECK(used >= 0),
    PRIMARY KEY(environment, utc_day)
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS contact_rate_windows (
    key_hash TEXT PRIMARY KEY
      CHECK(length(key_hash) = 64 AND key_hash NOT GLOB '*[^0-9a-f]*'),
    request_1 INTEGER NOT NULL,
    request_2 INTEGER,
    request_3 INTEGER,
    request_4 INTEGER,
    request_5 INTEGER,
    expires_at INTEGER NOT NULL
  )`);
  sql.exec("CREATE INDEX IF NOT EXISTS contact_rate_windows_expiry ON contact_rate_windows(expires_at)");
}

function allocateCase(sql) {
  const row = sql.exec("SELECT next_value, exhausted FROM contact_case_counter WHERE singleton = 1").one();
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

function rateCheck(sql, rateKey, now) {
  // Exact rolling window. Shared NATs share a limit and IP rotation can evade it;
  // this app-layer control does not protect Worker ingress or Durable Object quota.
  sql.exec("DELETE FROM contact_rate_windows WHERE expires_at <= ?", now);
  const row = sql.exec(
    `SELECT request_1, request_2, request_3, request_4, request_5
      FROM contact_rate_windows WHERE key_hash = ?`,
    rateKey,
  ).toArray()[0];
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const active = row
    ? [row.request_1, row.request_2, row.request_3, row.request_4, row.request_5]
      .filter((timestamp) => Number.isSafeInteger(timestamp) && timestamp >= cutoff)
    : [];
  if (active.length >= RATE_LIMIT_REQUESTS) return { allowed: false };
  active.push(now);
  const timestamps = [...active, null, null, null, null].slice(0, RATE_LIMIT_REQUESTS);
  const expiresAt = timestamps.at(-1) === null
    ? active.at(-1) + RATE_LIMIT_WINDOW_MS + 1
    : timestamps.at(-1) + RATE_LIMIT_WINDOW_MS + 1;
  if (!row) {
    const { count } = sql.exec("SELECT COUNT(*) AS count FROM contact_rate_windows").one();
    if (count >= RATE_LIMIT_MAX_ROWS) return { error: "RATE_LIMIT_CAPACITY" };
    sql.exec(
      `INSERT INTO contact_rate_windows
        (key_hash, request_1, request_2, request_3, request_4, request_5, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
      rateKey, ...timestamps, expiresAt,
    );
  } else {
    sql.exec(
      `UPDATE contact_rate_windows
        SET request_1 = ?, request_2 = ?, request_3 = ?, request_4 = ?, request_5 = ?, expires_at = ?
        WHERE key_hash = ?`,
      ...timestamps, expiresAt, rateKey,
    );
  }
  return { allowed: true, remaining: RATE_LIMIT_REQUESTS - active.length };
}

function json(body, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function hasExactKeys(value, required, optional = []) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key)) && keys.every((key) => allowed.has(key));
}

async function readJson(request) {
  if (request.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") return null;
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function resolveNow(env, value) {
  if (value === undefined) return Date.now();
  if (env.CONTACT_TEST_CLOCK !== "enabled" || !Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

function errorResponse(error) {
  if (["IDEMPOTENCY_CONFLICT", "IDEMPOTENCY_DUAL_RECORD_CONFLICT", "IDEMPOTENCY_TRANSITION_REJECTED"].includes(error)) {
    return json({ error }, 409);
  }
  if (error === "IDEMPOTENCY_NOT_FOUND") return json({ error }, 404);
  if (["IDEMPOTENCY_CAPACITY", "RATE_LIMIT_CAPACITY", "SEND_BUDGET_EXHAUSTED", COUNTER_EXHAUSTED].includes(error)) {
    return json({ error }, 503);
  }
  return json({ error: "invalid_request" }, 400);
}

function environmentBudget(env) {
  if (env.CONTACT_ENVIRONMENT === "production") return { environment: "production", budgetLimit: 50 };
  if (env.CONTACT_ENVIRONMENT === "preview") return { environment: "preview", budgetLimit: 5 };
  return null;
}

function budgetStatus(sql, { environment, budgetLimit }, now) {
  const utcDay = Math.floor(now / 86_400_000);
  const row = sql.exec(
    "SELECT used FROM contact_send_budget WHERE environment = ? AND utc_day = ?",
    environment,
    utcDay,
  ).toArray()[0];
  const used = row?.used || 0;
  return { available: used < budgetLimit, remaining: Math.max(0, budgetLimit - used) };
}

export class ContactCaseCounter {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sql = state.storage.sql;
    state.storage.transactionSync(() => initializeSchemas(this.sql));
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== "/" || url.search || request.method !== "POST") return json({ error: "not_found" }, 404);
    const input = await readJson(request);
    if (!input || typeof input.action !== "string") return json({ error: "invalid_request" }, 400);
    const now = resolveNow(this.env, input.now);
    if (now === null) return json({ error: "invalid_request" }, 400);

    if (input.action === "allocate") {
      if (!hasExactKeys(input, ["action"], ["now"])) return json({ error: "invalid_request" }, 400);
      const result = this.state.storage.transactionSync(() => allocateCase(this.sql));
      return result.error ? errorResponse(result.error) : json(result, 201);
    }

    if (input.action === "rate_check") {
      if (!hasExactKeys(input, ["action", "rateKey"], ["now"])
        || typeof input.rateKey !== "string" || !/^[0-9a-f]{64}$/.test(input.rateKey)) {
        return json({ error: "invalid_request" }, 400);
      }
      const result = this.state.storage.transactionSync(() => rateCheck(this.sql, input.rateKey, now));
      return result.error ? errorResponse(result.error) : json(result, result.allowed ? 200 : 429);
    }

    if (input.action === "budget_status") {
      if (!hasExactKeys(input, ["action"], ["now"])) return json({ error: "invalid_request" }, 400);
      const budget = environmentBudget(this.env);
      if (!budget) return json({ error: "service_unavailable" }, 503);
      return json(this.state.storage.transactionSync(() => budgetStatus(this.sql, budget, now)));
    }

    const required = input.action === "reserve"
      ? ["action", "idempotencyKey", "payload"]
      : ["action", "idempotencyKey", "payload", "to"];
    if (input.action === "claim_send") required.pop();
    if (!hasExactKeys(input, required, ["now"])) return json({ error: "invalid_request" }, 400);
    if (!["reserve", "claim_send", "transition"].includes(input.action)) return json({ error: "invalid_request" }, 400);
    if (input.action === "transition" && !FINAL_STATES.has(input.to)) return json({ error: "invalid_request" }, 400);

    let candidates;
    try {
      candidates = await createIdempotencyCandidates(
        this.env.CONTACT_IDEMPOTENCY_HMAC_KEY,
        this.env.CONTACT_IDEMPOTENCY_HMAC_PREVIOUS_KEY,
        input.idempotencyKey,
        input.payload,
      );
    } catch {
      return json({ error: "service_unavailable" }, 503);
    }
    if (!candidates) return json({ error: "invalid_request" }, 400);

    let result;
    if (input.action === "reserve") {
      result = this.state.storage.transactionSync(() => reserveIdempotencyRecord(
        this.sql, { candidates, now, allocateCase: () => allocateCase(this.sql) },
      ));
    } else if (input.action === "claim_send") {
      const budget = environmentBudget(this.env);
      if (!budget) return json({ error: "service_unavailable" }, 503);
      result = this.state.storage.transactionSync(() => claimIdempotencySend(
        this.sql, { candidates, now, ...budget },
      ));
    } else {
      result = this.state.storage.transactionSync(() => transitionIdempotencyRecord(
        this.sql, { candidates, now, to: input.to },
      ));
    }
    if (result.error) return errorResponse(result.error);
    return json(result, result.created ? 201 : 200);
  }
}
