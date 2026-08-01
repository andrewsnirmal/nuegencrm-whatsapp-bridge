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

// In-memory registry of active sockets/state per session ID. Auth
// credentials themselves persist to disk (sessions/<id>/) so a restart
// resumes without re-scanning, as long as the session wasn't logged out.
const sessions = {}; // { [sessionId]: { sock, status, qr, phoneNumber } }
const sessionStarts = {}; // { [sessionId]: Promise<SessionEntry> }

const healthRoutes = require("./routes/health");
const authMiddleware = require('./middleware/auth');

app.use(authMiddleware);
app.use('/health', healthRoutes);

function normalizeRecipient(to) {
    const value = String(to || '').trim();

    if (!value) {
        return { error: 'Recipient phone number is required' };
    }

    if (value.endsWith('@g.us')) {
        return { jid: value, isGroup: true };
    }

    const digits = value.split('@')[0].replace(/[^\d]/g, '');

    if (digits.length < 8) {
        return {
            error: 'Recipient phone number must include country code, e.g. 919876543210'
        };
    }

    return {
        digits,
        jid: `${digits}@s.whatsapp.net`,
        isGroup: false
    };
}

async function resolveRecipientJid(sock, to) {
    const recipient = normalizeRecipient(to);

    if (recipient.error || recipient.isGroup) {
        return recipient;
    }

    const lookup = await sock.onWhatsApp(recipient.digits);
    console.log("========== onWhatsApp Lookup ==========");
    console.log(JSON.stringify(lookup, null, 2));
    console.log("=======================================");
    const match = Array.isArray(lookup)
        ? lookup.find((item) => item.exists)
        : null;

    if (!match?.jid) {
        return {
            ...recipient,
            lookup,
            error: 'Recipient phone number is not registered on WhatsApp'
        };
    }

    // NOTE: previously this preferred match.lid over match.jid. Sending to
    // the lid address has been unreliable in practice (message accepted by
    // WhatsApp's server - status "pending" - but never actually delivered
    // to the recipient's device). Prefer the classic phone JID
    // (<digits>@s.whatsapp.net) and only fall back to lid if no phone JID
    // was returned by the lookup.
    return {
        ...recipient,
        jid: match.jid || match.lid,
        phoneJid: match.jid,
        lid: match.lid || null,
        lookup
    };
}

async function ensureSession(sessionId) {
    if (sessions[sessionId]) {
        return sessions[sessionId];
    }

    if (!sessionStarts[sessionId]) {
        sessionStarts[sessionId] = startSession(sessionId)
            .finally(() => {
                delete sessionStarts[sessionId];
            });
    }

    return sessionStarts[sessionId];
}

async function closeSession(id, logout = false) {
    const entry = sessions[id];

    if (entry?.sock) {
        if (logout) {
            try { await entry.sock.logout(); } catch (_) {}
        }

        try { entry.sock.end?.(); } catch (_) {}
    }

    delete sessions[id];
    delete sessionStarts[id];
}

function deleteSessionFiles(id) {
    const sessionDir = path.join(SESSIONS_DIR, id);
    fs.rmSync(sessionDir, { recursive: true, force: true });
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
			level: process.env.BAILEYS_LOG_LEVEL || 'warn'
		}),
        printQRInTerminal: false,
    });

    sessions[sessionId] = { sock, status: 'connecting', qr: null, phoneNumber: null };

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        console.log("Connection Update:", update);
        const { connection, lastDisconnect, qr } = update;
        const entry = sessions[sessionId];
        if (!entry || entry.sock !== sock) return;

        
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
                delete sessions[sessionId];
                setTimeout(() => {
                    ensureSession(sessionId).catch((e) => console.error('Reconnect failed:', e));
                }, 3000);
            }
        }
        
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        const entry = sessions[sessionId];
        if (!entry || entry.sock !== sock) return;

        if (type !== 'notify') return;

        for (const msg of messages) {
            if (msg.key.fromMe || !msg.message) continue;

            if (msg.message.protocolMessage || msg.message.senderKeyDistributionMessage) {
                continue;
            }

            console.log("Incoming Message", JSON.stringify({
                from: msg.key.remoteJid,
                id: msg.key.id,
                timestamp: msg.messageTimestamp
            }));

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

    sock.ev.on('messages.update', (updates) => {
        const entry = sessions[sessionId];
        if (!entry || entry.sock !== sock) return;

        console.log("Message Status Update");
        console.log(JSON.stringify(updates, null, 2));
    });

    return sessions[sessionId];
}

// --- Routes -------------------------------------------------------------
// added
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        service: 'NuegenCRM WhatsApp Bridge-v2',
        uptime: process.uptime(),
        sessions: Object.keys(sessions).length
    });
});
//--
app.post('/sessions/:id/start', authMiddleware, async (req, res) => {
    const { id } = req.params;
    try {
        const entry = await ensureSession(id);
        res.json({ status: entry.status });
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

app.get('/sessions', authMiddleware, (req, res) => {
    const sessionIds = new Set([
        ...Object.keys(sessions),
        ...fs.readdirSync(SESSIONS_DIR, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
    ]);

    res.json({
        sessions: Array.from(sessionIds).sort().map((id) => {
            const entry = sessions[id];

            return {
                id,
                status: entry?.status || 'saved',
                phone_number: entry?.phoneNumber || null,
                has_qr: Boolean(entry?.qr)
            };
        })
    });
});

app.post('/sessions/:id/sendOLD', authMiddleware, async (req, res) => {
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
app.post('/sessions/:id/send', authMiddleware, async (req, res) => {

    console.log("======================================");
    console.log("SEND REQUEST RECEIVED");
    console.log("Session:", req.params.id);
    console.log("Body:", JSON.stringify(req.body, null, 2));

    const entry = sessions[req.params.id];

    if (!entry) {
        console.log("ERROR: Session not found");
        return res.status(400).json({ error: 'Session not found' });
    }

    console.log("Session Status:", entry.status);

    if (entry.status !== 'connected') {
        console.log("ERROR: Session is not connected");
        return res.status(400).json({ error: 'Session not connected' });
    }

    const { to, type, body, mediaUrl, caption } = req.body;

    console.log("Recipient:", to);
    console.log("Message Type:", type);

    try {
        const recipient = await resolveRecipientJid(entry.sock, to);

        console.log("================================");
        console.log("WhatsApp Recipient Lookup");
        console.log(JSON.stringify({
            requested: to,
            jid: recipient.jid,
            phone_jid: recipient.phoneJid,
            lid: recipient.lid,
            lookup: recipient.lookup,
            error: recipient.error
        }, null, 2));
        console.log("================================");

        if (recipient.error) {
            return res.status(422).json({
                success: false,
                error: recipient.error,
                requested_recipient: to,
                normalized_recipient: recipient.digits || recipient.jid || null,
                lookup: recipient.lookup || null
            });
        }

        let sent;

        if (type === 'text') {

            console.log("Sending text message...");

            sent = await entry.sock.sendMessage(recipient.jid, {
                text: body
            });

        } else if (['image', 'video', 'document'].includes(type)) {

            console.log("Sending media message...");

            const key = type === 'document'
                ? 'document'
                : type;

            if (!mediaUrl) {
                return res.status(400).json({
                    success: false,
                    error: 'mediaUrl is required for media messages'
                });
            }

            sent = await entry.sock.sendMessage(recipient.jid, {
                [key]: { url: mediaUrl },
                caption
            });

        } else {

            console.log("Unsupported type:", type);

            return res.status(400).json({
                error: `Unsupported type: ${type}`
            });

        }

        console.log("SUCCESS");
        console.log(sent);

        res.json({
            success: true,
            recipient_jid: recipient.jid,
            recipient_phone_jid: recipient.phoneJid || null,
            recipient_lid: recipient.lid || null,
            provider_message_id: sent?.key?.id
        });

    } catch (err) {

        console.log("SEND FAILED");
        console.error(err);

        res.status(500).json({
            success: false,
            error: err.message,
            stack: err.stack
        });

    }

});
app.post('/sessions/:id/logout', authMiddleware, async (req, res) => {
    await closeSession(req.params.id, true);
    res.json({ status: 'logged_out' });
});

app.post('/sessions/:id/reset', authMiddleware, async (req, res) => {
    const { id } = req.params;
    const logout = req.body?.logout === true;

    await closeSession(id, logout);
    deleteSessionFiles(id);

    res.json({
        status: 'reset',
        logout,
        message: 'Session files deleted. Start session again and scan a fresh QR.'
    });
});

app.delete('/sessions/:id', authMiddleware, async (req, res) => {
    const { id } = req.params;
    const logout = req.query.logout === 'true' || req.body?.logout === true;

    await closeSession(id, logout);
    deleteSessionFiles(id);

    res.json({
        status: 'deleted',
        logout,
        message: 'Session removed from bridge storage.'
    });
});
//added by to test

app.listen(PORT, () => {
    console.log("=======================================");
    console.log("NuegenCRM WhatsApp Bridge v2");
    console.log(`Port      : ${PORT}`);
    console.log(`Node      : ${process.version}`);
    console.log(`Started   : ${new Date().toISOString()}`);
    console.log("=======================================");
});



const sessionFolders = fs.readdirSync(SESSIONS_DIR);

console.log(`Found ${sessionFolders.length} saved session(s).`);

sessionFolders.forEach(folder => {
    console.log(`Restoring session: ${folder}`);
    ensureSession(folder).catch(err => {
        console.error(`Failed restoring ${folder}`, err);
    });
});