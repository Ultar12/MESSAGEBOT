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

// --- SERVER ---
const app = express();
const PORT = process.env.PORT || 10000;
app.get('/', (req, res) => res.send('Ultarbot Active'));

// --- DATABASE SETUP ---
const DB_FILE = './bot_database.json';
const LOG_FILE = './activity_log.json';
const SESSIONS_DIR = process.env.SESSIONS_DIR || './sessions';

// Function: Load/Init DB
function loadDb() {
    if (fs.existsSync(DB_FILE)) {
        try { return JSON.parse(fs.readFileSync(DB_FILE)); } catch(e) { return { sessions: {}, numbers: [] }; }
    }
    return { sessions: {}, numbers: [] };
}

// Function: Save DB
function saveDb(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// Function: Log Activity
function logToDb(type, message) {
    const entry = {
        timestamp: new Date().toISOString(),
        type: type,
        details: message
    };
    let logs = [];
    if (fs.existsSync(LOG_FILE)) { try { logs = JSON.parse(fs.readFileSync(LOG_FILE)); } catch(e) {} }
    logs.push(entry);
    if (logs.length > 1000) logs = logs.slice(-1000);
    fs.writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2));
    console.log(`[LOG] ${type}: ${message}`);
}

// --- API FOR PAIRING ---
app.use(express.json());
app.get('/pair', async (req, res) => {
    const { number, secret } = req.query;
    if (secret !== process.env.API_SECRET) return res.status(403).json({ error: 'Invalid Key' });
    if (!number) return res.status(400).json({ error: 'No number' });

    const sessionId = makeSessionId();
    const sessionPath = path.join(SESSIONS_DIR, sessionId);
    fs.mkdirSync(sessionPath, { recursive: true });

    startClient(sessionId, number, null, (code) => {
        if (code) res.json({ status: 'success', pairing_code: code });
        else res.status(500).json({ error: 'Failed' });
    });
});

app.listen(PORT, () => console.log(`[SYSTEM] Server listening on port ${PORT}`));

// --- CONFIG ---
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;

if (!TELEGRAM_TOKEN) {
    console.error('[FATAL] TELEGRAM_TOKEN is missing');
    process.exit(1);
}

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

const clients = {}; 
const antiMsgState = {}; 
const telegramMap = {}; 

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
console.log('[SYSTEM] Bot Started.');

// --- HELPERS ---
function generateShortId() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < 5; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
    return result;
}

function makeSessionId() {
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0]; 
    let randomStr = '';
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 8; i++) randomStr += chars.charAt(Math.floor(Math.random() * chars.length));
    return `Ultarbot_${dateStr}_${randomStr}`;
}

const getRandomBrowser = () => {
    const browsers = [
        Browsers.macOS('Safari'), Browsers.macOS('Chrome'), 
        Browsers.windows('Firefox'), Browsers.ubuntu('Chrome'), Browsers.windows('Edge')
    ];
    return browsers[Math.floor(Math.random() * browsers.length)];
};

// --- WHATSAPP CLIENT LOGIC ---
async function startClient(folder, targetNumber = null, chatId = null, onCode = null) {
    const sessionPath = path.join(SESSIONS_DIR, folder);
    if(chatId) telegramMap[folder] = chatId;

    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: "silent" }),
            browser: getRandomBrowser(), 
            version,
            connectTimeoutMs: 60000,
            retryRequestDelayMs: 250,
            markOnlineOnConnect: true,
            emitOwnEvents: true 
        });

        sock.ev.on('creds.update', async () => {
            await saveCreds();
            
            // --- DATABASE SAVE (CREDENTIALS) ---
            // We read the creds file and save it to our JSON DB for persistence
            try {
                const credsFile = path.join(sessionPath, 'creds.json');
                if (fs.existsSync(credsFile)) {
                    const content = fs.readFileSync(credsFile, 'utf-8');
                    const db = loadDb();
                    // Find session by folder
                    const id = Object.keys(db.sessions).find(k => db.sessions[k].folder === folder);
                    if (id) {
                        db.sessions[id].creds = content; // Save creds content
                        saveDb(db);
                    }
                }
            } catch (e) { console.error('DB Save Error', e); }
        });

        sock.ev.on('messages.upsert', async ({ messages }) => {
            for (const msg of messages) {
                if (!msg.message) continue;
                
                const msgType = Object.keys(msg.message)[0];
                const content = msgType === 'ephemeralMessage' ? msg.message.ephemeralMessage.message : msg.message;
                const text = content.conversation || content.extendedTextMessage?.text || content.imageMessage?.caption || "";

                if (!text) continue;

                const remoteJid = msg.key.remoteJid;
                const isFromMe = msg.key.fromMe;
                const myJid = jidNormalizedUser(sock.user?.id || "");
                const userPhone = myJid.split('@')[0];

                if (text.toLowerCase().includes('.alive')) {
                    await sock.sendMessage(remoteJid, { text: 'Ultarbot is Online' }, { quoted: msg });
                }

                if (isFromMe && text.toLowerCase().startsWith('.antimsg')) {
                    const cmd = text.split(' ')[1];
                    if (cmd === 'on') {
                        antiMsgState[userPhone] = true;
                        await sock.sendMessage(remoteJid, { text: 'Locked' }, { quoted: msg });
                    } else if (cmd === 'off') {
                        antiMsgState[userPhone] = false;
                        await sock.sendMessage(remoteJid, { text: 'Unlocked' }, { quoted: msg });
                    }
                    return; 
                }

                if (isFromMe && antiMsgState[userPhone]) {
                    if (remoteJid === myJid) return; 
                    if (text.startsWith('.')) return;

                    try { await sock.sendMessage(remoteJid, { delete: msg.key }); } catch (e) {}

                    const target = remoteJid.split('@')[0];
                    if (telegramMap[folder]) {
                        bot.sendMessage(telegramMap[folder], `[AntiMsg] Target: +${target} - Deleted`);
                    }
                }
            }
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === 'open') {
                const userJid = jidNormalizedUser(sock.user.id);
                const phoneNumber = userJid.split('@')[0];
                
                const db = loadDb();
                let myShortId = Object.keys(db.sessions).find(key => db.sessions[key].folder === folder);
                
                if (!myShortId) {
                    myShortId = generateShortId();
                    db.sessions[myShortId] = { 
                        folder: folder, 
                        phone: phoneNumber, 
                        creds: "" // Will be filled by creds.update
                    };
                    saveDb(db);
                }

                clients[folder] = sock;
                logToDb("CONNECTED", `Client ${phoneNumber} connected as ${myShortId}`);

                if(chatId) {
                    bot.sendMessage(chatId, 
                        `Connected\n` +
                        `Number: +${phoneNumber}\n` +
                        `ID: \`${myShortId}\`\n` +
                        `Use: /broadcast ${myShortId}`,
                        { parse_mode: 'Markdown' }
                    );
                }

                try {
                    await sock.sendMessage(userJid, { text: `Ultarbot ID: ${myShortId}` });
                } catch (e) {}
            }

            if (connection === 'close') {
                let reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
                if (reason === DisconnectReason.loggedOut) {
                    const db = loadDb();
                    const myShortId = Object.keys(db.sessions).find(key => db.sessions[key].folder === folder);
                    if (myShortId) {
                        delete db.sessions[myShortId];
                        saveDb(db);
                    }
                    if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true, force: true });
                    delete clients[folder];
                    if (telegramMap[folder]) bot.sendMessage(telegramMap[folder], `Session Logged Out & Deleted.`);
                } else {
                    const savedChatId = telegramMap[folder];
                    startClient(folder, null, savedChatId);
                }
            }
        });

        if (targetNumber && !sock.authState.creds.registered) {
            setTimeout(async () => {
                if (!sock.authState.creds.registered) {
                    try {
                        const code = await sock.requestPairingCode(targetNumber);
                        if (chatId) {
                            await bot.sendMessage(chatId, `Code: \`${code}\``, { parse_mode: 'Markdown' });
                        }
                        if (onCode) onCode(code);
                    } catch (e) {
                        if (onCode) onCode(null);
                        if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true, force: true });
                    }
                }
            }, 3000);
        }
    } catch (error) {
        console.error(`[ERROR] ${folder}:`, error);
        if (onCode) onCode(null);
    }
}

async function loadAllClients() {
    if (!fs.existsSync(SESSIONS_DIR)) return;
    const folders = fs.readdirSync(SESSIONS_DIR).filter(f => fs.statSync(path.join(SESSIONS_DIR, f)).isDirectory());
    for (const folder of folders) startClient(folder);
}

setupTelegramCommands(bot, clients, loadDb().sessions, SESSIONS_DIR, startClient, makeSessionId, antiMsgState, logToDb);
loadAllClients();
