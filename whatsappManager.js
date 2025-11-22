import 'dotenv/config';
import { 
    useMultiFileAuthState, 
    makeWASocket, 
    DisconnectReason, 
    fetchLatestBaileysVersion, 
    Browsers,
    jidNormalizedUser
} from '@whiskeysockets/baileys';
import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs';
import path from 'path';
import pino from 'pino';
import express from 'express';
import { Boom } from '@hapi/boom';

import { setupTelegramCommands } from './telegram_commands.js';
import { initDb, saveSessionToDb, getAllSessions, deleteSessionFromDb, awardHourlyPoints, deductOnDisconnect } from './db.js';
// Award points every hour
setInterval(() => {
    awardHourlyPoints().catch(console.error);
}, 60 * 60 * 1000); // every hour

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const SESSIONS_DIR = './sessions';

if (!TELEGRAM_TOKEN) { console.error('Missing TELEGRAM_TOKEN'); process.exit(1); }
if (!process.env.DATABASE_URL) { console.error('Missing DATABASE_URL'); process.exit(1); }

const app = express();
const PORT = process.env.PORT || 10000;
app.use(express.json());
app.get('/', (req, res) => res.send('Ultarbot Pro Running'));

// HTTP endpoint to trigger /pair for external services
app.post('/api/pair', async (req, res) => {
    const { number, chatId } = req.body;
    if (!number || !chatId) {
        return res.status(400).json({ error: 'number and chatId are required' });
    }
    try {
        const sessionId = makeSessionId();
        await startClient(sessionId, number, chatId);
        res.json({ status: 'Pairing started', sessionId });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to start pairing' });
    }
});

app.listen(PORT, () => console.log(`Server on ${PORT}`));

const clients = {}; 
const shortIdMap = {}; 
// Stores state: { "shortID": true/false }
const antiMsgState = {}; 

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

function generateShortId() {
    return Math.random().toString(36).substring(2, 7);
}

function makeSessionId() {
    return `Ultarbot_${Date.now()}`;
}

const getRandomBrowser = () => {
    const browsers = [
        Browsers.macOS('Safari'), Browsers.macOS('Chrome'), 
        Browsers.windows('Firefox'), Browsers.ubuntu('Chrome'), Browsers.windows('Edge')
    ];
    return browsers[Math.floor(Math.random() * browsers.length)];
};

async function startClient(folder, targetNumber = null, chatId = null) {
    const sessionPath = path.join(SESSIONS_DIR, folder);
    if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: "silent" }),
        browser: getRandomBrowser(), 
        version,
        connectTimeoutMs: 60000,
        markOnlineOnConnect: true,
        emitOwnEvents: true // Essential for AntiMsg
    });

    sock.ev.on('creds.update', async () => {
        await saveCreds();
        try {
            const credsFile = path.join(sessionPath, 'creds.json');
            if (fs.existsSync(credsFile)) {
                const content = fs.readFileSync(credsFile, 'utf-8');
                let phone = "pending";
                const id = Object.keys(shortIdMap).find(k => shortIdMap[k].folder === folder);
                if (id) phone = shortIdMap[id].phone;
                await saveSessionToDb(folder, phone, content);
            }
        } catch(e) {}
    });

    // --- MESSAGE HANDLER (ANTIMSG LOGIC) ---
    sock.ev.on('messages.upsert', async ({ messages }) => {
        // Find Short ID associated with this socket
        const myShortId = Object.keys(shortIdMap).find(k => shortIdMap[k].folder === folder);
        if (!myShortId) return;

        // Check if AntiMsg is ON for this account
        const isLocked = antiMsgState[myShortId];

        for (const msg of messages) {
            if (!msg.message) continue;
            if (msg.key.remoteJid === 'status@broadcast') continue;

            // If Locked AND Message is From Me (Sent from phone/web)
            if (isLocked && msg.key.fromMe) {
                
                // Exception: Allow Self-Messages (Saved Messages)
                const myJid = jidNormalizedUser(sock.user?.id);
                if (msg.key.remoteJid === myJid) continue;

                console.log(`[ANTIMSG] Deleting outgoing message on ${myShortId}`);
                
                // FLASH DELETE
                try {
                    await sock.sendMessage(msg.key.remoteJid, { delete: msg.key });
                } catch (e) {
                    console.error('Delete failed', e);
                }
            }
        }
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'open') {
            const userJid = jidNormalizedUser(sock.user.id);
            const phoneNumber = userJid.split('@')[0];
            
            let myShortId = Object.keys(shortIdMap).find(key => shortIdMap[key].folder === folder);
            
            if (!myShortId) {
                myShortId = generateShortId();
                shortIdMap[myShortId] = { folder, phone: phoneNumber };
            } else {
                shortIdMap[myShortId].phone = phoneNumber;
            }

            clients[folder] = sock;
            console.log(`Connected: ${phoneNumber}`);

            if (chatId) {
                bot.sendMessage(chatId, `Connected!\nNumber: +${phoneNumber}\nID: ${myShortId}`);
            }
        }

        if (connection === 'close') {
            let reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
            if (reason === 403 || reason === DisconnectReason.loggedOut) {
                const id = Object.keys(shortIdMap).find(k => shortIdMap[k].folder === folder);
                const num = id ? shortIdMap[id].phone : "Unknown";
                let msg = `Logged Out.`;
                if (reason === 403) msg = `CRITICAL: Account +${num} was BANNED. Deleting data.`;
                if (chatId) bot.sendMessage(chatId, msg);
                // Deduct points if disconnected without sending message
                await deductOnDisconnect(folder);
                await deleteSessionFromDb(folder);
                if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true, force: true });
                delete clients[folder];
                if (id) delete shortIdMap[id];
            } else {
                startClient(folder, null, chatId);
            }
        }
    });

    if (targetNumber && !sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(targetNumber);
                if (chatId) bot.sendMessage(chatId, `Code: \`${code}\``, { parse_mode: 'Markdown' });
            } catch (e) {
                if (chatId) bot.sendMessage(chatId, "Pairing failed. Try again.");
            }
        }, 3000);
    }
}

async function boot() {
    await initDb(); 
    const savedSessions = await getAllSessions();
    
    console.log(`[DB] Restoring ${savedSessions.length} sessions...`);
    
    for (const session of savedSessions) {
        const folderPath = path.join(SESSIONS_DIR, session.session_id);
        if (!fs.existsSync(folderPath)) fs.mkdirSync(folderPath, { recursive: true });
        
        if (session.creds) {
            fs.writeFileSync(path.join(folderPath, 'creds.json'), session.creds);
        }
        
        // Restore Memory Map
        const shortId = generateShortId();
        shortIdMap[shortId] = { folder: session.session_id, phone: session.phone };
        
        // Restore AntiMsg State
        if (session.antimsg) {
            antiMsgState[shortId] = true;
        }

        startClient(session.session_id);
    }
}

setupTelegramCommands(bot, clients, shortIdMap, SESSIONS_DIR, startClient, makeSessionId, antiMsgState);
boot();
