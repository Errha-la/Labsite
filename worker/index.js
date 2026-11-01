import { buildGmailRaw, refreshAccessToken, sendGmail, validateGmailConfig } from "./gmail.js";

const API_PREFIX = "/api";
const CONTACT_PATH = "/api/contact";
const MAX_BODY_BYTES = 8192;
const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const SITEVERIFY_TIMEOUT_MS = 3500;
const CONTACT_KEYS = ["consent", "email", "message", "name", "reason", "turnstileToken"];
const REASONS = new Set(["professor", "industry", "other"]);
const TOKEN_ERROR_CODES = new Set(["invalid-input-response", "missing-input-response", "timeout-or-duplicate"]);
const SERVICE_ERROR_CODES = new Set(["missing-input-secret", "invalid-input-secret", "bad-request", "internal-error"]);
const encoder = new TextEncoder();

export { ContactCaseCounter } from "./contact-case-counter.js";

function jsonResponse(body, status, headers = {}) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

function isApiPath(pathname) {
  return pathname === API_PREFIX || pathname.startsWith(`${API_PREFIX}/`);
}

function isJsonContentType(request) {
  const contentType = request.headers.get("Content-Type");
  return contentType?.split(";", 1)[0].trim().toLowerCase() === "application/json";
}

function isValidEmail(email) {
  const at = email.lastIndexOf("@");
  if (at <= 0 || at !== email.indexOf("@") || at === email.length - 1) return false;
  const local = email.slice(0, at);
  const labels = email.slice(at + 1).split(".");
  return /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)
    && !local.startsWith(".") && !local.endsWith(".") && !local.includes("..")
    && labels.length >= 2
    && labels.every((label) => label.length >= 1 && label.length <= 63
      && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label));
}

async function readLimitedBody(request) {
  const contentLength = request.headers.get("Content-Length");
  if (contentLength !== null && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_BODY_BYTES) return { tooLarge: true };
  if (!request.body) return { text: "" };
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        return { tooLarge: true };
      }
      chunks.push(value);
    }
  } catch { return { invalid: true }; }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) }; }
  catch { return { invalid: true }; }
}

function normalizeContact(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
  const keys = Object.keys(input).sort();
  if (keys.length !== CONTACT_KEYS.length || keys.some((key, index) => key !== CONTACT_KEYS[index])) return null;
  if (input.consent !== true) return null;
  if ([input.email, input.message, input.name, input.reason, input.turnstileToken].some((value) => typeof value !== "string")) return null;
  const name = input.name.trim();
  const email = input.email.trim();
  const message = input.message.replace(/\r\n?/g, "\n").trim();
  const turnstileToken = input.turnstileToken.trim();
  if (name.length < 1 || name.length > 100) return null;
  if (email.length < 3 || email.length > 254 || /[\u0000-\u0020\u007f]/.test(email) || !isValidEmail(email)) return null;
  if (!REASONS.has(input.reason)) return null;
  if (message.length < 1 || message.length > 1500) return null;
  if (turnstileToken.length < 1 || turnstileToken.length > 2048) return null;
  return { consent: true, email, message, name, reason: input.reason, turnstileToken };
}

function parseIpv4(value) {
  const parts = value.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^(?:0|[1-9]\d{0,2})$/.test(part))) return null;
  const numbers = parts.map(Number);
  return numbers.some((part) => part > 255) ? null : numbers.join(".");
}

function parseIpv6(value) {
  if (!value.includes(":") || value.includes("%") || value.includes("[") || value.includes("]")) return null;
  const doubleColon = value.indexOf("::");
  if (doubleColon !== -1 && doubleColon !== value.lastIndexOf("::")) return null;
  let normalized = value.toLowerCase();
  const tail = normalized.split(":").at(-1);
  if (tail?.includes(".")) {
    const ipv4 = parseIpv4(tail);
    if (!ipv4) return null;
    const bytes = ipv4.split(".").map(Number);
    normalized = `${normalized.slice(0, normalized.length - tail.length)}${((bytes[0] << 8) | bytes[1]).toString(16)}:${((bytes[2] << 8) | bytes[3]).toString(16)}`;
  }
  const halves = normalized.split("::");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if ([...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  if (halves.length === 1 && left.length !== 8) return null;
  if (halves.length === 2 && left.length + right.length >= 8) return null;
  const groups = halves.length === 2
    ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right]
    : left;
  return groups.map((part) => Number.parseInt(part, 16).toString(16).padStart(4, "0")).join(":");
}

export function canonicalizeClientIp(value) {
  if (typeof value !== "string" || value.length < 1 || value !== value.trim() || value.includes(",")) return null;
  return parseIpv4(value) || parseIpv6(value);
}

function toHex(bytes) {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hmacRateKey(secret, canonicalIp) {
  if (typeof secret !== "string" || encoder.encode(secret).byteLength < 32) return null;
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(`contact-rate-ip\0${canonicalIp}`)));
}

function getCounter(env) {
  if (!env.CONTACT_CASE_COUNTER || typeof env.CONTACT_CASE_COUNTER.idFromName !== "function"
    || typeof env.CONTACT_CASE_COUNTER.get !== "function") return null;
  try { return env.CONTACT_CASE_COUNTER.get(env.CONTACT_CASE_COUNTER.idFromName("contact-cases")); }
  catch { return null; }
}

async function callCounter(counter, body) {
  try {
    const response = await counter.fetch("https://contact-counter.internal/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    let data;
    try { data = await response.json(); } catch { return { ok: false, status: response.status }; }
    return { ok: response.ok, status: response.status, data };
  } catch { return { ok: false, status: 503 }; }
}

function classifyVerification(data, expectedHostname) {
  if (data === null || typeof data !== "object" || Array.isArray(data) || typeof data.success !== "boolean") return "unavailable";
  const codes = data["error-codes"];
  if (codes !== undefined && (!Array.isArray(codes) || codes.some((code) => typeof code !== "string"))) return "unavailable";
  if (data.success) {
    if (codes?.length) return "unavailable";
    if (data.hostname !== expectedHostname || data.action !== "contact") return "mismatch";
    return "verified";
  }
  if (!codes?.length || codes.some((code) => SERVICE_ERROR_CODES.has(code))
    || codes.some((code) => !TOKEN_ERROR_CODES.has(code))) return "unavailable";
  return "invalid";
}

async function verifyTurnstile(turnstileToken, env) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SITEVERIFY_TIMEOUT_MS);
  try {
    const response = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: turnstileToken, idempotency_key: crypto.randomUUID() }),
      redirect: "manual",
      signal: controller.signal,
    });
    if (!response.ok) return "unavailable";
    try { return classifyVerification(await response.json(), env.TURNSTILE_EXPECTED_HOSTNAME); }
    catch { return "unavailable"; }
  } catch { return "unavailable"; }
  finally { clearTimeout(timeout); }
}

function validHmacConfig(env) {
  const current = typeof env.CONTACT_IDEMPOTENCY_HMAC_KEY === "string"
    && encoder.encode(env.CONTACT_IDEMPOTENCY_HMAC_KEY).byteLength >= 32;
  const previous = env.CONTACT_IDEMPOTENCY_HMAC_PREVIOUS_KEY;
  return current && (previous === undefined || (typeof previous === "string"
    && encoder.encode(previous).byteLength >= 32 && previous !== env.CONTACT_IDEMPOTENCY_HMAC_KEY));
}

function publicStateResponse(record) {
  if (record.state === "accepted") return jsonResponse({ ok: true, caseNumber: record.caseNumber }, 202);
  if (record.state === "unknown") return jsonResponse({ error: "delivery_unknown" }, 503);
  if (record.state === "definite_failure") return jsonResponse({ error: "delivery_failed" }, 502);
  if (record.state === "sending") return jsonResponse({ error: "request_in_progress" }, 409);
  return null;
}

async function finishState(counter, idempotencyKey, payload, to) {
  return callCounter(counter, { action: "transition", idempotencyKey, payload, to });
}

async function handleContact(request, env) {
  if (request.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405, { Allow: "POST" });
  if (!isJsonContentType(request)) return jsonResponse({ error: "invalid_request" }, 400);
  const counter = getCounter(env);
  const canonicalIp = canonicalizeClientIp(request.headers.get("CF-Connecting-IP"));
  let rateKey;
  try { rateKey = canonicalIp && await hmacRateKey(env.CONTACT_RATE_LIMIT_HMAC_KEY, canonicalIp); }
  catch { rateKey = null; }
  if (!counter || !rateKey) return jsonResponse({ error: "service_unavailable" }, 503);
  const rate = await callCounter(counter, { action: "rate_check", rateKey });
  if (rate.status === 429) return jsonResponse({ error: "rate_limited" }, 429);
  if (!rate.ok || rate.data?.allowed !== true) return jsonResponse({ error: "service_unavailable" }, 503);

  const body = await readLimitedBody(request);
  if (body.tooLarge) return jsonResponse({ error: "request_too_large" }, 413);
  if (body.invalid) return jsonResponse({ error: "invalid_request" }, 400);
  let parsed;
  try { parsed = JSON.parse(body.text); } catch { return jsonResponse({ error: "invalid_request" }, 400); }
  const contact = normalizeContact(parsed);
  if (!contact) return jsonResponse({ error: "invalid_request" }, 400);
  const idempotencyKey = request.headers.get("X-Contact-Idempotency-Key");
  if (typeof idempotencyKey !== "string" || idempotencyKey.length < 16 || idempotencyKey.length > 256
    || /[\u0000-\u001f\u007f]/.test(idempotencyKey)) return jsonResponse({ error: "invalid_request" }, 400);

  const gmailConfig = validateGmailConfig(env);
  if (!gmailConfig || !validHmacConfig(env)
    || typeof env.TURNSTILE_SECRET !== "string" || !env.TURNSTILE_SECRET
    || typeof env.TURNSTILE_EXPECTED_HOSTNAME !== "string" || !env.TURNSTILE_EXPECTED_HOSTNAME
    || !["production", "preview"].includes(env.CONTACT_ENVIRONMENT)) {
    return jsonResponse({ error: "service_unavailable" }, 503);
  }

  const verification = await verifyTurnstile(contact.turnstileToken, env);
  if (verification === "invalid") return jsonResponse({ error: "verification_failed" }, 400);
  if (verification === "mismatch") return jsonResponse({ error: "verification_failed" }, 403);
  if (verification !== "verified") return jsonResponse({ error: "service_unavailable" }, 503);

  const payload = { consent: true, email: contact.email, message: contact.message, name: contact.name, reason: contact.reason };
  const reservation = await callCounter(counter, { action: "reserve", idempotencyKey, payload });
  if (!reservation.ok) {
    const status = reservation.status === 409 ? 409 : 503;
    return jsonResponse({ error: status === 409 ? "idempotency_conflict" : "service_unavailable" }, status);
  }
  const existingResponse = publicStateResponse(reservation.data);
  if (existingResponse) return existingResponse;

  const budget = await callCounter(counter, { action: "budget_status" });
  if (!budget.ok || budget.data?.available !== true) {
    return jsonResponse({ error: "service_unavailable" }, 503);
  }
  const token = await refreshAccessToken(gmailConfig);
  if (!token.ok) return jsonResponse({ error: "service_unavailable" }, 503);
  const claim = await callCounter(counter, { action: "claim_send", idempotencyKey, payload });
  if (!claim.ok) return jsonResponse({ error: "service_unavailable" }, 503);
  if (claim.data.claimed !== true) return publicStateResponse(claim.data) || jsonResponse({ error: "service_unavailable" }, 503);

  let raw;
  try { raw = buildGmailRaw(gmailConfig, contact, claim.data.caseNumber); }
  catch {
    await finishState(counter, idempotencyKey, payload, "unknown");
    return jsonResponse({ error: "delivery_unknown" }, 503);
  }
  let outcome = await sendGmail(token.accessToken, raw);
  if (outcome.outcome === "unauthorized") {
    const refreshed = await refreshAccessToken(gmailConfig);
    if (!refreshed.ok) outcome = { outcome: "definite_failure" };
    else {
      outcome = await sendGmail(refreshed.accessToken, raw);
      if (outcome.outcome === "unauthorized") outcome = { outcome: "definite_failure" };
    }
  }
  const finalState = outcome.outcome === "accepted"
    ? "accepted"
    : outcome.outcome === "definite_failure" ? "definite_failure" : "unknown";
  const finished = await finishState(counter, idempotencyKey, payload, finalState);
  if (!finished.ok || finished.data?.state !== finalState) return jsonResponse({ error: "delivery_unknown" }, 503);
  return publicStateResponse(finished.data);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === CONTACT_PATH && url.search === "") return handleContact(request, env);
    if (isApiPath(url.pathname)) return jsonResponse({ error: "not_found" }, 404);
    return env.ASSETS.fetch(request);
  },
};
