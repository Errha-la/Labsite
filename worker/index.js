const API_PREFIX = "/api";
const CONTACT_PATH = "/api/contact";
const MAX_BODY_BYTES = 8192;
const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const SITEVERIFY_TIMEOUT_MS = 3500;
const CONTACT_KEYS = ["consent", "email", "message", "name", "reason", "turnstileToken"];
const REASONS = new Set(["professor", "industry", "other"]);
const TOKEN_ERROR_CODES = new Set(["invalid-input-response", "missing-input-response", "timeout-or-duplicate"]);
const SERVICE_ERROR_CODES = new Set([
  "missing-input-secret",
  "invalid-input-secret",
  "bad-request",
  "internal-error",
]);

function jsonResponse(body, status, headers = {}) {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      ...headers,
    },
  });
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
  const domain = email.slice(at + 1);
  if (!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)
    || local.startsWith(".") || local.endsWith(".") || local.includes("..")) return false;
  const labels = domain.split(".");
  return labels.length >= 2 && labels.every((label) => label.length >= 1 && label.length <= 63
    && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label));
}

async function readLimitedBody(request) {
  const contentLength = request.headers.get("Content-Length");
  if (contentLength !== null && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_BODY_BYTES) {
    return { tooLarge: true };
  }
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
  } catch {
    return { invalid: true };
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { invalid: true };
  }
}

function normalizeContact(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
  const keys = Object.keys(input).sort();
  if (keys.length !== CONTACT_KEYS.length || keys.some((key, index) => key !== CONTACT_KEYS[index])) return null;
  if (input.consent !== true) return null;
  if ([input.email, input.message, input.name, input.reason, input.turnstileToken]
    .some((value) => typeof value !== "string")) return null;

  const name = input.name.trim();
  const email = input.email.trim();
  const message = input.message.replace(/\r\n?/g, "\n").trim();
  const turnstileToken = input.turnstileToken.trim();

  if (name.length < 1 || name.length > 100) return null;
  if (email.length < 3 || email.length > 254 || /[\u0000-\u0020\u007f]/.test(email)) return null;
  if (!isValidEmail(email)) return null;
  if (!REASONS.has(input.reason)) return null;
  if (message.length < 1 || message.length > 1500) return null;
  if (turnstileToken.length < 1 || turnstileToken.length > 2048) return null;

  return { consent: true, email, message, name, reason: input.reason, turnstileToken };
}

function classifyVerification(data, expectedHostname) {
  if (data === null || typeof data !== "object" || Array.isArray(data) || typeof data.success !== "boolean") {
    return "unavailable";
  }

  const codes = data["error-codes"];
  if (codes !== undefined && (!Array.isArray(codes) || codes.some((code) => typeof code !== "string"))) {
    return "unavailable";
  }

  if (data.success) {
    if (codes?.length) return "unavailable";
    if (data.hostname !== expectedHostname || data.action !== "contact") return "mismatch";
    return "verified";
  }

  if (!codes?.length) return "unavailable";
  if (codes.some((code) => SERVICE_ERROR_CODES.has(code))) return "unavailable";
  if (codes.some((code) => !TOKEN_ERROR_CODES.has(code))) return "unavailable";
  return "invalid";
}

async function verifyTurnstile(turnstileToken, env) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SITEVERIFY_TIMEOUT_MS);
  try {
    const body = new URLSearchParams({
      secret: env.TURNSTILE_SECRET,
      response: turnstileToken,
      idempotency_key: crypto.randomUUID(),
    });
    const response = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      redirect: "manual",
      signal: controller.signal,
    });
    if (!response.ok) return "unavailable";
    let data;
    try {
      data = await response.json();
    } catch {
      return "unavailable";
    }
    return classifyVerification(data, env.TURNSTILE_EXPECTED_HOSTNAME);
  } catch {
    return "unavailable";
  } finally {
    clearTimeout(timeout);
  }
}

async function handleContact(request, env) {
  if (request.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed" }, 405, { Allow: "POST" });
  }
  if (!isJsonContentType(request)) return jsonResponse({ error: "invalid_request" }, 400);

  const body = await readLimitedBody(request);
  if (body.tooLarge) return jsonResponse({ error: "request_too_large" }, 413);
  if (body.invalid) return jsonResponse({ error: "invalid_request" }, 400);

  let parsed;
  try {
    parsed = JSON.parse(body.text);
  } catch {
    return jsonResponse({ error: "invalid_request" }, 400);
  }
  const contact = normalizeContact(parsed);
  if (!contact) return jsonResponse({ error: "invalid_request" }, 400);

  if (typeof env.TURNSTILE_SECRET !== "string" || !env.TURNSTILE_SECRET
    || typeof env.TURNSTILE_EXPECTED_HOSTNAME !== "string" || !env.TURNSTILE_EXPECTED_HOSTNAME) {
    return jsonResponse({ error: "service_unavailable" }, 503);
  }

  const verification = await verifyTurnstile(contact.turnstileToken, env);
  if (verification === "invalid") return jsonResponse({ error: "verification_failed" }, 400);
  if (verification === "mismatch") return jsonResponse({ error: "verification_failed" }, 403);
  if (verification !== "verified") return jsonResponse({ error: "service_unavailable" }, 503);
  return jsonResponse({ error: "not_implemented" }, 501);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === CONTACT_PATH && url.search === "") return handleContact(request, env);
    if (isApiPath(url.pathname)) return jsonResponse({ error: "not_found" }, 404);
    return env.ASSETS.fetch(request);
  },
};
