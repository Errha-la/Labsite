export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
export const IDEMPOTENCY_MAX_ROWS = 10_000;
export const SENDING_STALE_MS = 5 * 60 * 1000;

const PAYLOAD_KEYS = ["consent", "email", "message", "name", "reason"];
const REASONS = new Set(["professor", "industry", "other"]);
const TERMINAL_STATES = new Set(["accepted", "definite_failure", "unknown"]);
const TRANSITIONS = new Map([
  ["reserved", new Set(["sending", "definite_failure"])],
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

export async function createIdempotencyDigests(secret, idempotencyKey, payload) {
  const secretBytes = typeof secret === "string" ? encoder.encode(secret) : new Uint8Array();
  if (secretBytes.byteLength < 32) throw new Error("IDEMPOTENCY_HMAC_KEY_UNAVAILABLE");
  if (typeof idempotencyKey !== "string" || idempotencyKey.length < 16 || idempotencyKey.length > 256
    || /[\u0000-\u001f\u007f]/.test(idempotencyKey)) return null;
  const canonicalPayload = canonicalizeContactPayload(payload);
  if (canonicalPayload === null) return null;

  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const [keyHash, payloadHash] = await Promise.all([
    crypto.subtle.sign("HMAC", key, encoder.encode(`contact-idempotency-key\0${idempotencyKey}`)),
    crypto.subtle.sign("HMAC", key, encoder.encode(`contact-payload\0${canonicalPayload}`)),
  ]);
  return { keyHash: toHex(keyHash), payloadHash: toHex(payloadHash) };
}

function publicRecord(row, created = false) {
  return {
    created,
    caseNumber: row.case_number,
    state: row.state,
    expiresAt: row.expires_at,
  };
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
  sql.exec(
    "UPDATE contact_idempotency SET state = 'unknown', updated_at = ? WHERE key_hash = ? AND state = 'sending'",
    now,
    row.key_hash,
  );
  return { ...row, state: "unknown", updated_at: now };
}

export function reserveIdempotencyRecord(sql, { keyHash, payloadHash, now, allocateCase }) {
  expireRows(sql, now);
  let existing = getRecord(sql, keyHash);
  if (existing) {
    if (existing.payload_hash !== payloadHash) return { error: "IDEMPOTENCY_CONFLICT" };
    existing = markStaleSendingUnknown(sql, existing, now);
    return publicRecord(existing);
  }

  const { count } = sql.exec("SELECT COUNT(*) AS count FROM contact_idempotency").one();
  if (count >= IDEMPOTENCY_MAX_ROWS) return { error: "IDEMPOTENCY_CAPACITY" };
  const allocation = allocateCase();
  if (allocation.error) return allocation;

  const expiresAt = now + IDEMPOTENCY_TTL_MS;
  sql.exec(
    `INSERT INTO contact_idempotency
      (key_hash, payload_hash, case_number, state, created_at, updated_at, expires_at)
      VALUES (?, ?, ?, 'reserved', ?, ?, ?)`,
    keyHash,
    payloadHash,
    allocation.caseNumber,
    now,
    now,
    expiresAt,
  );
  return {
    created: true,
    caseNumber: allocation.caseNumber,
    state: "reserved",
    expiresAt,
  };
}

export function transitionIdempotencyRecord(sql, { keyHash, payloadHash, now, to }) {
  expireRows(sql, now);
  let row = getRecord(sql, keyHash);
  if (!row) return { error: "IDEMPOTENCY_NOT_FOUND" };
  if (row.payload_hash !== payloadHash) return { error: "IDEMPOTENCY_CONFLICT" };
  row = markStaleSendingUnknown(sql, row, now);
  if (row.state === to) return publicRecord(row);
  if (TERMINAL_STATES.has(row.state) || !TRANSITIONS.get(row.state)?.has(to)) {
    return { error: "IDEMPOTENCY_TRANSITION_REJECTED", ...publicRecord(row) };
  }
  sql.exec(
    "UPDATE contact_idempotency SET state = ?, updated_at = ? WHERE key_hash = ? AND state = ?",
    to,
    now,
    keyHash,
    row.state,
  );
  return publicRecord({ ...row, state: to, updated_at: now });
}
