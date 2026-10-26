# Labsite Contact API

This small Node service accepts the Contact form and sends one plain-text email.
It does not save submissions. The default development mode keeps only the last
synthetic message in process memory for local inspection.

## Local development

Use Node 24.21.0. Copy .env.example to .env, then start the API with
node --env-file=.env server.js.
Set VITE_CONTACT_API_URL=http://localhost:8080/contact in the repository root
.env.local before starting Vite. Submit the form, then inspect the last message
at http://127.0.0.1:8080/__preview/last. The memory transport is restricted to
a loopback bind and is rejected when NODE_ENV=production.

## Production installation and acceptance

See [docs/CONTACT-API-DEPLOYMENT.md](../../docs/CONTACT-API-DEPLOYMENT.md)
for the systemd, HTTPS reverse-proxy, SMTP, and acceptance procedure.

## Production configuration

Run with NODE_ENV=production and CONTACT_MAIL_MODE=smtp. Set these values in
the lab server's protected environment; never put mail credentials in the
repository or static site build:

The GitHub Pages build also needs the public VITE_CONTACT_API_URL value set to
the lab API endpoint. It is a public URL, not a credential. If it is missing,
the form stays unavailable and directs visitors to the existing public email.

| Variable | Purpose |
| --- | --- |
| CONTACT_BIND_HOST | Bind to loopback when the reverse proxy is on the same host. |
| CONTACT_API_PORT | Private API port, default 8080. |
| CONTACT_ALLOWED_ORIGIN | Exact HTTPS site origin, with no path or trailing slash. |
| CONTACT_TO | Fixed destination mailbox; the Contact page currently discloses zaira4edu@gmail.com. |
| MAIL_FROM | Authorized sender mailbox controlled by the lab. |
| SMTP_HOST / SMTP_PORT | Approved SMTP relay. Port defaults to 587. |
| SMTP_SECURE | Set true for implicit TLS, such as port 465; otherwise STARTTLS is required. |
| SMTP_USER / SMTP_PASS | Optional SMTP credentials; set both or neither. |
| CONTACT_MAX_PER_MINUTE | Per-process global submission ceiling, default 10. |
| CONTACT_MAX_IN_FLIGHT | Maximum accepted requests being processed at once, default 2. |

The service accepts only the configured origin, JSON POST /contact, and the
matching OPTIONS preflight. CORS is not authentication; the reverse proxy must
also enforce per-source and global ingress limits, body and connection timeouts,
and HTTPS. Keep the Node port private. Configure the mailbox owner to delete
Contact messages within 180 days and restrict mailbox access. The API code does
not log request bodies, visitor email addresses, or SMTP errors. Reverse-proxy
and SMTP-provider logging depends on the host configuration.

Before public exposure, confirm the lab host supports Node 24.21.0, TLS and
reverse-proxy controls are active, the sender is authorized by the mail domain,
and the mailbox deletion procedure is in place. If CONTACT_TO changes, update
the bilingual privacy notice in index.html at the same time.
