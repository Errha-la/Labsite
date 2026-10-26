import { createServer } from 'node:http';
import nodemailer from 'nodemailer';

const MAX_BODY_BYTES = 8192;
const MAX_NAME_LENGTH = 100;
const MAX_EMAIL_LENGTH = 254;
const MAX_MESSAGE_LENGTH = 1500;
const RATE_WINDOW_MS = 60_000;
const RATE_WINDOW_LIMIT = readInteger('CONTACT_MAX_PER_MINUTE', 10, 1, 120);
const MAX_IN_FLIGHT = readInteger('CONTACT_MAX_IN_FLIGHT', 2, 1, 8);
const MODE = process.env.CONTACT_MAIL_MODE || 'smtp';
const NODE_ENV = process.env.NODE_ENV || 'development';
const PORT = readInteger('CONTACT_API_PORT', 8080, 1, 65535);
const HOST = process.env.CONTACT_BIND_HOST || '127.0.0.1';
const ALLOWED_ORIGIN = readOrigin(process.env.CONTACT_ALLOWED_ORIGIN);
const CONTACT_TO = readMailbox(process.env.CONTACT_TO, 'CONTACT_TO');
const MAIL_FROM = readMailbox(process.env.MAIL_FROM, 'MAIL_FROM');

function readInteger(name, fallback, minimum, maximum) {
  const raw = process.env[name];
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(name + ' must be an integer from ' + minimum + ' to ' + maximum);
  }
  return value;
}

function readOrigin(value) {
  if (!value) throw new Error('CONTACT_ALLOWED_ORIGIN is required');
  const url = new URL(value);
  const isLocalHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.origin !== value || (url.protocol !== 'https:' && !isLocalHttp)) {
    throw new Error('CONTACT_ALLOWED_ORIGIN must be an HTTPS origin, or a local development origin');
  }
  return url.origin;
}

function isMailbox(value) {
  if (typeof value !== 'string' || value.length < 3 || value.length > MAX_EMAIL_LENGTH) return false;
  if (/[\u0000-\u0020\u007f,;<>"]/u.test(value)) return false;
  const parts = value.split('@');
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  if (!local || local.length > 64 || local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;
  if (!/^[A-Z0-9.!#$%&'*+/=?^_{|}~-]+$/i.test(local)) return false;
  const labels = domain.split('.');
  if (labels.length < 2) return false;
  return labels.every(label =>
    label.length > 0 && label.length <= 63 &&
    /^[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?$/i.test(label)
  );
}

function readMailbox(value, name) {
  if (!isMailbox(value)) throw new Error(name + ' must be one valid mailbox address');
  return value;
}

function isLoopback(host) {
  return host === 'localhost' || host === '::1' || host === '[::1]' || host.startsWith('127.');
}

if (!['smtp', 'memory'].includes(MODE)) throw new Error('CONTACT_MAIL_MODE must be smtp or memory');
if (NODE_ENV === 'production' && MODE !== 'smtp') throw new Error('Production requires SMTP mail mode');
if (MODE === 'memory' && !isLoopback(HOST)) throw new Error('Memory mail mode can bind only to loopback');

let transporter = null;
if (MODE === 'smtp') {
  const smtpHost = process.env.SMTP_HOST;
  const smtpPort = readInteger('SMTP_PORT', 587, 1, 65535);
  const smtpUser = process.env.SMTP_USER || '';
  const smtpPass = process.env.SMTP_PASS || '';
  const secure = process.env.SMTP_SECURE === 'true';
  if (!smtpHost) throw new Error('SMTP_HOST is required in SMTP mail mode');
  if (!!smtpUser !== !!smtpPass) throw new Error('SMTP_USER and SMTP_PASS must be set together');
  transporter = nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort,
    secure,
    requireTLS: !secure,
    auth: smtpUser ? { user: smtpUser, pass: smtpPass } : undefined,
    connectionTimeout: 5000,
    greetingTimeout: 5000,
    socketTimeout: 10000,
    tls: { minVersion: 'TLSv1.2' },
    logger: false,
    debug: false
  });
}

class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

let rateWindowStarted = Date.now();
let submissionsInWindow = 0;
let activeRequests = 0;
let previewMessage = null;

function sendJson(response, status, body, corsOrigin = '') {
  if (response.destroyed || response.writableEnded) return;
  const headers = {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...(corsOrigin ? {
      'Access-Control-Allow-Origin': corsOrigin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '600',
      'Vary': 'Origin'
    } : {})
  };
  if (status !== 204) {
    const encoded = Buffer.from(JSON.stringify(body));
    headers['Content-Type'] = 'application/json; charset=utf-8';
    headers['Content-Length'] = encoded.length;
    response.writeHead(status, headers);
    response.end(encoded);
    return;
  }
  response.writeHead(status, headers);
  response.end();
}

function consumeRateBudget() {
  const now = Date.now();
  if (now - rateWindowStarted >= RATE_WINDOW_MS) {
    rateWindowStarted = now;
    submissionsInWindow = 0;
  }
  if (submissionsInWindow >= RATE_WINDOW_LIMIT) return false;
  submissionsInWindow += 1;
  return true;
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;

    request.on('data', chunk => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        settled = true;
        reject(new HttpError(413, 'request_too_large'));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (settled) return;
      settled = true;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'invalid_request'));
      }
    });
    request.on('aborted', () => {
      if (!settled) {
        settled = true;
        reject(new HttpError(400, 'invalid_request'));
      }
    });
    request.on('error', () => {
      if (!settled) {
        settled = true;
        reject(new HttpError(400, 'invalid_request'));
      }
    });
  });
}

function validatePayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'invalid_submission');
  const keys = Object.keys(value).sort();
  if (keys.length !== 3 || keys[0] !== 'email' || keys[1] !== 'message' || keys[2] !== 'name') {
    throw new HttpError(400, 'invalid_submission');
  }

  const name = typeof value.name === 'string' ? value.name.trim() : '';
  const email = typeof value.email === 'string' ? value.email.trim() : '';
  const message = typeof value.message === 'string' ? value.message.replace(/\r\n?/g, '\n').trim() : '';
  if (!name || name.length > MAX_NAME_LENGTH || /[\u0000-\u001f\u007f]/u.test(name)) {
    throw new HttpError(400, 'invalid_submission');
  }
  if (!isMailbox(email)) throw new HttpError(400, 'invalid_submission');
  if (!message || message.length > MAX_MESSAGE_LENGTH || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(message)) {
    throw new HttpError(400, 'invalid_submission');
  }
  return { name, email, message };
}

function contentTypeIsJson(value) {
  return typeof value === 'string' && /^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(value);
}

async function handleRequest(request, response) {
  const url = new URL(request.url || '/', 'http://localhost');

  if (MODE === 'memory' && request.method === 'GET' && url.pathname === '/__preview/last') {
    if (!previewMessage) return sendJson(response, 404, { error: 'no_preview_message' });
    return sendJson(response, 200, previewMessage);
  }

  const origin = request.headers.origin;
  if (origin !== ALLOWED_ORIGIN) {
    return sendJson(response, 403, { error: 'origin_not_allowed' });
  }
  if (url.pathname !== '/contact') return sendJson(response, 404, { error: 'not_found' }, origin);

  if (request.method === 'OPTIONS') {
    const requestedMethod = request.headers['access-control-request-method'];
    const requestedHeaders = String(request.headers['access-control-request-headers'] || '')
      .split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
    if (requestedMethod !== 'POST' || requestedHeaders.some(value => value !== 'content-type')) {
      return sendJson(response, 403, { error: 'preflight_not_allowed' }, origin);
    }
    return sendJson(response, 204, {}, origin);
  }
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST, OPTIONS');
    return sendJson(response, 405, { error: 'method_not_allowed' }, origin);
  }
  if (!contentTypeIsJson(request.headers['content-type'])) {
    return sendJson(response, 415, { error: 'unsupported_media_type' }, origin);
  }
  if (Number(request.headers['content-length'] || 0) > MAX_BODY_BYTES) {
    response.setHeader('Connection', 'close');
    request.resume();
    return sendJson(response, 413, { error: 'request_too_large' }, origin);
  }
  if (!consumeRateBudget()) return sendJson(response, 429, { error: 'rate_limited' }, origin);
  if (activeRequests >= MAX_IN_FLIGHT) return sendJson(response, 503, { error: 'temporarily_unavailable' }, origin);

  activeRequests += 1;
  try {
    const payload = validatePayload(await readJson(request));
    const mail = {
      from: { name: 'Labsite Contact', address: MAIL_FROM },
      to: { address: CONTACT_TO },
      replyTo: { address: payload.email },
      subject: 'Labsite Contact Form',
      text: 'Name: ' + payload.name + '\nEmail: ' + payload.email + '\n\n' + payload.message,
      disableFileAccess: true,
      disableUrlAccess: true,
      envelope: { from: MAIL_FROM, to: [CONTACT_TO] }
    };

    if (MODE === 'memory') {
      previewMessage = {
        from: mail.from,
        to: mail.to,
        replyTo: mail.replyTo,
        subject: mail.subject,
        text: mail.text
      };
    } else {
      await transporter.sendMail(mail);
    }
    return sendJson(response, 202, { ok: true }, origin);
  } catch (error) {
    if (error instanceof HttpError) {
      return sendJson(response, error.status, { error: error.code }, origin);
    }
    return sendJson(response, 503, { error: 'temporarily_unavailable' }, origin);
  } finally {
    activeRequests -= 1;
  }
}

const server = createServer((request, response) => {
  handleRequest(request, response).catch(() => {
    sendJson(response, 503, { error: 'temporarily_unavailable' });
  });
});

server.headersTimeout = 5000;
server.requestTimeout = 10000;
server.keepAliveTimeout = 5000;
server.maxHeadersCount = 30;
server.listen(PORT, HOST, () => {
  console.log('Labsite Contact API listening');
});
