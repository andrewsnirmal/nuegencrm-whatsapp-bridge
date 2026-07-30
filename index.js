/**
 * NuegenCRM WhatsApp Web Bridge
 * -----------------------------------------------------------------------
 * A small Express server that holds one or more Baileys (WhatsApp Web)
 * sessions and exposes a simple HTTP API for the Laravel app to drive:
 * start a session, poll its status/QR code, send a message, log out.
 *
 * This is intentionally a SEPARATE process from Laravel - PHP cannot
 * hold the persistent WebSocket connection Baileys needs. Run this via
 * Supervisor (or pm2) on a VPS; it is never deployed to shared hosting.
 *
 * IMPORTANT: written against the documented @whiskeysockets/baileys API.
 * This has not been run against a live WhatsApp session from the
 * environment that generated it (no real phone/network available there).
 * Expect to `npm install`, run it yourself, scan a real QR code, and
 * likely need small adjustments if Baileys' API has moved since - check
 * https://github.com/WhiskeySockets/Baileys for the current version's docs.
 * -----------------------------------------------------------------------
 */

require('dotenv').config();
const express = require('express');
const QRCode = require('qrcode');
const axios = require('axios');
const pino = require('pino');
const path = require('path');
const fs = require('fs');

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3001;
const BRIDGE_SECRET = process.env.BRIDGE_SECRET || '';
const LARAVEL_WEBHOOK_URL = process.env.LARAVEL_WEBHOOK_URL;
const SESSIONS_DIR = path.join(__dirname, 'sessions');

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR);
// added
fs.readdirSync(SESSIONS_DIR).forEach(folder => {
    startSession(folder).catch(console.error);
});

// In-memory registry of active sockets/state per session ID. Auth
// credentials themselves persist to disk (sessions/<id>/) so a restart
// resumes without re-scanning, as long as the session wasn't logged out.
const sessions = {}; // { [sessionId]: { sock, status, qr, phoneNumber } }

function authMiddleware(req, res, next) {
    if (req.headers['x-bridge-secret'] !== BRIDGE_SECRET) {
        return res.status(403).json({ error: 'Invalid bridge secret' });
    }
    next();
}

async function postToLaravel(payload) {
    if (!LARAVEL_WEBHOOK_URL) return;
    try {
        await axios.post(LARAVEL_WEBHOOK_URL, payload, {
            headers: { 'X-Bridge-Secret': BRIDGE_SECRET },
            timeout: 10000,
        });
    } catch (err) {
        console.error('Failed to post to Laravel webhook:', err.message);
    }
}

async function startSession(sessionId) {
    const sessionDir = path.join(SESSIONS_DIR, sessionId);
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({
			level: process.env.NODE_ENV === 'production'
				? 'info'
				: 'debug'
		}),
        printQRInTerminal: false,
    });

    sessions[sessionId] = { sock, status: 'connecting', qr: null, phoneNumber: null };

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        const entry = sessions[sessionId];
        if (!entry) return;

        if (qr) {
            entry.status = 'qr_pending';
            entry.qr = await QRCode.toDataURL(qr);
            await postToLaravel({ session_id: sessionId, event: 'connection_update', status: 'qr_pending' });
        }

        if (connection === 'open') {
            entry.status = 'connected';
            entry.qr = null;
            entry.phoneNumber = sock.user?.id?.split(':')[0] || null;
            await postToLaravel({
                session_id: sessionId,
                event: 'connection_update',
                status: 'connected',
                phone_number: entry.phoneNumber,
            });
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const loggedOut = statusCode === DisconnectReason.loggedOut;

            entry.status = loggedOut ? 'logged_out' : 'disconnected';
            await postToLaravel({ session_id: sessionId, event: 'connection_update', status: entry.status });

            // Auto-reconnect on anything except an explicit logout.
            if (!loggedOut) {
                startSession(sessionId).catch((e) => console.error('Reconnect failed:', e));
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (msg.key.fromMe || !msg.message) continue;

            const from = msg.key.remoteJid?.split('@')[0];
            const text =
                msg.message.conversation ||
                msg.message.extendedTextMessage?.text ||
                msg.message.imageMessage?.caption ||
                null;

            await postToLaravel({
                session_id: sessionId,
                event: 'message',
                from,
                type: 'text',
                body: text,
                provider_message_id: msg.key.id,
            });
        }
    });

    return sessions[sessionId];
}

// --- Routes -------------------------------------------------------------
// added
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        service: 'NuegenCRM WhatsApp Bridge',
        uptime: process.uptime(),
        sessions: Object.keys(sessions).length
    });
});
//--
app.post('/sessions/:id/start', authMiddleware, async (req, res) => {
    const { id } = req.params;
    try {
        if (!sessions[id]) {
            await startSession(id);
        }
        res.json({ status: sessions[id].status });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/sessions/:id/status', authMiddleware, (req, res) => {
    const entry = sessions[req.params.id];
    if (!entry) return res.json({ status: 'disconnected', qr: null });

    res.json({ status: entry.status, qr: entry.qr, phone_number: entry.phoneNumber });
});

app.post('/sessions/:id/send', authMiddleware, async (req, res) => {
    const entry = sessions[req.params.id];
    if (!entry || entry.status !== 'connected') {
        return res.status(400).json({ error: 'Session not connected' });
    }

    const { to, type, body, mediaUrl, caption } = req.body;
    const jid = `${to.replace(/[^\d]/g, '')}@s.whatsapp.net`;

    try {
        let sent;
        if (type === 'text') {
            sent = await entry.sock.sendMessage(jid, { text: body });
        } else if (['image', 'video', 'document'].includes(type)) {
            const key = type === 'document' ? 'document' : type;
            sent = await entry.sock.sendMessage(jid, { [key]: { url: mediaUrl }, caption });
        } else {
            return res.status(400).json({ error: `Unsupported type: ${type}` });
        }

        res.json({ success: true, provider_message_id: sent?.key?.id });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/sessions/:id/logout', authMiddleware, async (req, res) => {
    const entry = sessions[req.params.id];
    if (entry?.sock) {
        try { await entry.sock.logout(); } catch (_) {}
    }
    delete sessions[req.params.id];
    res.json({ status: 'logged_out' });
});

app.listen(PORT, () => {
    console.log(`NuegenCRM WhatsApp bridge listening on port ${PORT}`);
});
