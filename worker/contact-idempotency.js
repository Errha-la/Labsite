export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
export const IDEMPOTENCY_MAX_ROWS = 10_000;
export const SENDING_STALE_MS = 5 * 60 * 1000;

const PAYLOAD_KEYS = ["consent", "email", "message", "name", "reason"];
const REASONS = new Set(["professor", "industry", "other"]);
const TERMINAL_STATES = new Set(["accepted", "definite_failure", "unknown"]);
const FINAL_TRANSITIONS = new Map([
  ["reserved", new Set(["definite_failure"])],
  ["sending", new Set(["accepted", "definite_failure", "unknown"])],
]);
const encoder = new TextEncoder();

export function initializeIdempotencySchema(sql) {
  sql.exec(`CREATE TABLE IF NOT EXISTS contact_idempotency (
    key_hash TEXT PRIMARY KEY
      CHECK(length(key_hash) = 64 AND key_hash NOT GLOB '*[^0-9a-f]*'),
    payload_hash TEXT NOT NULL
      CHECK(length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
    case_number TEXT NOT NULL,
    state TEXT NOT NULL
      CHECK(state IN ('reserved', 'sending', 'accepted', 'definite_failure', 'unknown')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`);
  sql.exec("CREATE INDEX IF NOT EXISTS contact_idempotency_expiry ON contact_idempotency(expires_at)");
}

export function canonicalizeContactPayload(payload) {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const keys = Object.keys(payload).sort();
  if (keys.length !== PAYLOAD_KEYS.length || keys.some((key, index) => key !== PAYLOAD_KEYS[index])) return null;
  if (payload.consent !== true) return null;
  if ([payload.email, payload.message, payload.name, payload.reason].some((value) => typeof value !== "string")) return null;
  if (!REASONS.has(payload.reason)) return null;
  if (payload.name.length < 1 || payload.name.length > 100) return null;
  if (payload.email.length < 3 || payload.email.length > 254) return null;
  if (payload.message.length < 1 || payload.message.length > 1500) return null;
  return JSON.stringify({
    consent: true,
    email: payload.email,
    message: payload.message,
    name: payload.name,
    reason: payload.reason,
  });
}

function toHex(bytes) {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function digestCandidate(secret, idempotencyKey, canonicalPayload) {
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const [keyHash, payloadHash] = await Promise.all([
    crypto.subtle.sign("HMAC", key, encoder.encode(`contact-idempotency-key\0${idempotencyKey}`)),
    crypto.subtle.sign("HMAC", key, encoder.encode(`contact-payload\0${canonicalPayload}`)),
  ]);
  return { keyHash: toHex(keyHash), payloadHash: toHex(payloadHash) };
}

export async function createIdempotencyCandidates(currentSecret, previousSecret, idempotencyKey, payload) {
  if (typeof currentSecret !== "string" || encoder.encode(currentSecret).byteLength < 32) {
    throw new Error("IDEMPOTENCY_HMAC_KEY_UNAVAILABLE");
  }
  // Keep the previous rotation key configured for at least the full 24-hour ledger TTL.
  if (previousSecret !== undefined && (typeof previousSecret !== "string"
    || encoder.encode(previousSecret).byteLength < 32 || previousSecret === currentSecret)) {
    throw new Error("IDEMPOTENCY_PREVIOUS_HMAC_KEY_INVALID");
  }
  if (typeof idempotencyKey !== "string" || idempotencyKey.length < 16 || idempotencyKey.length > 256
    || /[\u0000-\u001f\u007f]/.test(idempotencyKey)) return null;
  const canonicalPayload = canonicalizeContactPayload(payload);
  if (canonicalPayload === null) return null;
  const current = await digestCandidate(currentSecret, idempotencyKey, canonicalPayload);
  const previous = previousSecret ? await digestCandidate(previousSecret, idempotencyKey, canonicalPayload) : undefined;
  return { current, previous };
}

export async function createIdempotencyDigests(secret, idempotencyKey, payload) {
  const candidates = await createIdempotencyCandidates(secret, undefined, idempotencyKey, payload);
  return candidates?.current || null;
}

function publicRecord(row, created = false) {
  return { created, caseNumber: row.case_number, state: row.state, expiresAt: row.expires_at };
}

function getRecord(sql, keyHash) {
  return sql.exec(
    "SELECT key_hash, payload_hash, case_number, state, created_at, updated_at, expires_at FROM contact_idempotency WHERE key_hash = ?",
    keyHash,
  ).toArray()[0];
}

function expireRows(sql, now) {
  sql.exec("DELETE FROM contact_idempotency WHERE expires_at <= ?", now);
}

function markStaleSendingUnknown(sql, row, now) {
  if (row.state !== "sending" || now - row.updated_at < SENDING_STALE_MS) return row;
  sql.exec("UPDATE contact_idempotency SET state = 'unknown', updated_at = ? WHERE key_hash = ? AND state = 'sending'", now, row.key_hash);
  return { ...row, state: "unknown", updated_at: now };
}

function resolveRecord(sql, candidates, now) {
  expireRows(sql, now);
  const matches = [candidates.current, candidates.previous]
    .filter(Boolean)
    .map((candidate) => ({ candidate, row: getRecord(sql, candidate.keyHash) }))
    .filter(({ row }) => row);
  if (matches.length > 1) return { error: "IDEMPOTENCY_DUAL_RECORD_CONFLICT" };
  if (!matches.length) return { candidate: candidates.current };
  const { candidate, row: found } = matches[0];
  if (found.payload_hash !== candidate.payloadHash) return { error: "IDEMPOTENCY_CONFLICT" };
  return { candidate, row: markStaleSendingUnknown(sql, found, now) };
}

export function reserveIdempotencyRecord(sql, { candidates, now, allocateCase }) {
  const resolved = resolveRecord(sql, candidates, now);
  if (resolved.error) return resolved;
  if (resolved.row) return publicRecord(resolved.row);
  const { count } = sql.exec("SELECT COUNT(*) AS count FROM contact_idempotency").one();
  if (count >= IDEMPOTENCY_MAX_ROWS) return { error: "IDEMPOTENCY_CAPACITY" };
  const allocation = allocateCase();
  if (allocation.error) return allocation;
  const expiresAt = now + IDEMPOTENCY_TTL_MS;
  sql.exec(
    `INSERT INTO contact_idempotency
      (key_hash, payload_hash, case_number, state, created_at, updated_at, expires_at)
      VALUES (?, ?, ?, 'reserved', ?, ?, ?)`,
    resolved.candidate.keyHash, resolved.candidate.payloadHash, allocation.caseNumber, now, now, expiresAt,
  );
  return { created: true, caseNumber: allocation.caseNumber, state: "reserved", expiresAt };
}

export function claimIdempotencySend(sql, { candidates, now, environment, budgetLimit }) {
  const resolved = resolveRecord(sql, candidates, now);
  if (resolved.error) return resolved;
  if (!resolved.row) return { error: "IDEMPOTENCY_NOT_FOUND" };
  if (resolved.row.state !== "reserved") return { ...publicRecord(resolved.row), claimed: false };
  const utcDay = Math.floor(now / 86_400_000);
  const budget = sql.exec("SELECT used FROM contact_send_budget WHERE environment = ? AND utc_day = ?", environment, utcDay).toArray()[0];
  if ((budget?.used || 0) >= budgetLimit) return { error: "SEND_BUDGET_EXHAUSTED", ...publicRecord(resolved.row) };
  sql.exec(
    `INSERT INTO contact_send_budget (environment, utc_day, used) VALUES (?, ?, 1)
      ON CONFLICT(environment, utc_day) DO UPDATE SET used = used + 1`,
    environment, utcDay,
  );
  sql.exec("UPDATE contact_idempotency SET state = 'sending', updated_at = ? WHERE key_hash = ? AND state = 'reserved'", now, resolved.row.key_hash);
  return { ...publicRecord({ ...resolved.row, state: "sending", updated_at: now }), claimed: true };
}

export function transitionIdempotencyRecord(sql, { candidates, now, to }) {
  const resolved = resolveRecord(sql, candidates, now);
  if (resolved.error) return resolved;
  if (!resolved.row) return { error: "IDEMPOTENCY_NOT_FOUND" };
  const row = resolved.row;
  if (row.state === to) return publicRecord(row);
  if (to === "sending" || TERMINAL_STATES.has(row.state) || !FINAL_TRANSITIONS.get(row.state)?.has(to)) {
    return { error: "IDEMPOTENCY_TRANSITION_REJECTED", ...publicRecord(row) };
  }
  sql.exec("UPDATE contact_idempotency SET state = ?, updated_at = ? WHERE key_hash = ? AND state = ?", to, now, row.key_hash, row.state);
  return publicRecord({ ...row, state: to, updated_at: now });
}
