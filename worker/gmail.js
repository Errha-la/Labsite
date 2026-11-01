const TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const PROVIDER_TIMEOUT_MS = 5000;
const encoder = new TextEncoder();
export const GMAIL_OAUTH_SCOPE = "https://www.googleapis.com/auth/gmail.send";

function isValidEmail(email) {
  if (typeof email !== "string" || email.length < 3 || email.length > 254
    || /[\u0000-\u0020\u007f]/.test(email)) return false;
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

function isNonEmptySecret(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 8192
    && !/[\u0000\r\n]/.test(value);
}

export function validateGmailConfig(env) {
  if (!isNonEmptySecret(env.GOOGLE_OAUTH_CLIENT_ID)
    || !isNonEmptySecret(env.GOOGLE_OAUTH_CLIENT_SECRET)
    || !isNonEmptySecret(env.GOOGLE_OAUTH_REFRESH_TOKEN)
    || !isValidEmail(env.GMAIL_SENDER_EMAIL)
    || !isValidEmail(env.CONTACT_ADMIN_EMAIL)) return null;
  return {
    clientId: env.GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
    refreshToken: env.GOOGLE_OAUTH_REFRESH_TOKEN,
    sender: env.GMAIL_SENDER_EMAIL,
    admin: env.CONTACT_ADMIN_EMAIL,
  };
}

function toBase64(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function base64Utf8(value) {
  return toBase64(encoder.encode(value));
}

function base64UrlUtf8(value) {
  return base64Utf8(value).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function foldBase64(value) {
  return value.match(/.{1,76}/gu)?.join("\r\n") || "";
}

export function buildGmailRaw({ admin, sender }, contact, caseNumber) {
  if (!isValidEmail(admin) || !isValidEmail(sender) || !isValidEmail(contact.email)
    || !/^\d{4,}$/u.test(caseNumber)) throw new Error("INVALID_MESSAGE_INPUT");
  const subjectPrefix = base64Utf8(`[案件編號 ${caseNumber}]`);
  const body = [
    `Case: ${caseNumber}`,
    `Name: ${contact.name}`,
    `Email: ${contact.email}`,
    `Reason: ${contact.reason}`,
    "",
    contact.message,
  ].join("\n");
  const mime = [
    `From: ${sender}`,
    `To: ${admin}`,
    `Reply-To: ${contact.email}`,
    `Subject: =?UTF-8?B?${subjectPrefix}?= New Contact Message`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    foldBase64(base64Utf8(body)),
  ].join("\r\n");
  return base64UrlUtf8(mime);
}

async function timedFetch(url, init) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, redirect: "manual", signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

export async function refreshAccessToken(config) {
  let response;
  try {
    response = await timedFetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: config.refreshToken,
        grant_type: "refresh_token",
      }),
    });
  } catch {
    return { ok: false };
  }
  if (response.status !== 200) return { ok: false };
  let data;
  try {
    data = await response.json();
  } catch {
    return { ok: false };
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)
    || typeof data.access_token !== "string" || data.access_token.length < 1
    || data.access_token.length > 8192 || /[\u0000-\u0020\u007f]/.test(data.access_token)
    || (data.token_type !== undefined && data.token_type !== "Bearer")) return { ok: false };
  if (data.scope !== undefined) {
    if (typeof data.scope !== "string") return { ok: false };
    const scopes = data.scope.split(/\s+/u).filter(Boolean);
    if (scopes.length !== 1 || scopes[0] !== GMAIL_OAUTH_SCOPE) return { ok: false };
  }
  return { ok: true, accessToken: data.access_token };
}

export async function sendGmail(accessToken, raw) {
  let response;
  try {
    response = await timedFetch(GMAIL_SEND_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ raw }),
    });
  } catch {
    return { outcome: "unknown" };
  }
  if (response.status === 401) return { outcome: "unauthorized" };
  if (response.status >= 400 && response.status < 500 && response.status !== 408) {
    return { outcome: "definite_failure" };
  }
  if (response.status < 200 || response.status >= 300) return { outcome: "unknown" };
  let data;
  try {
    data = await response.json();
  } catch {
    return { outcome: "unknown" };
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)
    || typeof data.id !== "string" || data.id.length < 1 || data.id.length > 512
    || /[\u0000-\u0020\u007f]/.test(data.id)) return { outcome: "unknown" };
  return { outcome: "accepted" };
}

// Manual integration check: after authorizing only GMAIL_OAUTH_SCOPE and confirming
// sender ownership, verify in Gmail UI that Reply uses Reply-To. No live credential is used here.
