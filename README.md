# NuegenCRM WhatsApp Bridge

A standalone Node.js service that holds WhatsApp Web (Baileys) sessions
so employees can connect their own number by scanning a QR code, exactly
like WhatsApp Web itself.

**This only runs on a VPS.** It needs a persistent Node process, which is
architecturally impossible on shared hosting like InfinityFree - see the
main project README's "Hosting Modes" section.

## Setup

```bash
cd whatsapp-bridge
npm install
cp .env.example .env
# edit .env: set BRIDGE_SECRET (must match WHATSAPP_QR_BRIDGE_SECRET in
# the Laravel app's .env) and LARAVEL_WEBHOOK_URL
node index.js
```

If this is your first time running it, `npm install` will pull in
`@whiskeysockets/baileys`, which changes fairly often - if `index.js`
throws an error on a method name, check
[the Baileys repo](https://github.com/WhiskeySockets/Baileys) for the
current API and adjust; this was written against the documented shape
of the library but hasn't been run against a live session from the
environment that generated it.

## Running permanently (Supervisor)

Create `/etc/supervisor/conf.d/nuegencrm-whatsapp-bridge.conf`:

```ini
[program:nuegencrm-whatsapp-bridge]
directory=/path/to/nuegencrm/whatsapp-bridge
command=node index.js
autostart=true
autorestart=true
stderr_logfile=/var/log/nuegencrm-whatsapp-bridge.err.log
stdout_logfile=/var/log/nuegencrm-whatsapp-bridge.out.log
user=www-data
```

```bash
supervisorctl reread
supervisorctl update
supervisorctl start nuegencrm-whatsapp-bridge
```

## How Laravel talks to this

- `App\Services\WhatsApp\WhatsAppQrBridgeService` calls this service's
  HTTP endpoints (`/sessions/:id/start`, `/status`, `/send`, `/logout`),
  authenticated with the `X-Bridge-Secret` header.
- This service calls back to Laravel's
  `POST /webhooks/whatsapp/qr` whenever a message arrives or a
  session's connection status changes, using the same shared secret.

## Session storage

Each connected number's Baileys auth credentials live in
`sessions/<session-id>/` as plain files. **Back these up** if you care
about not having to re-scan the QR code after a server migration -
losing this folder means every employee has to reconnect.

## A note on Terms of Service

WhatsApp does not officially support or endorse third-party automation
of WhatsApp Web sessions (this is why the Cloud API exists as the
sanctioned path). Baileys-based connections can be rate-limited or
banned by WhatsApp at their discretion. This is a known, common
trade-off SMEs make for the "no Meta approval required" convenience -
just go in with that expectation.
