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

// --- API FOR PAIRING ---
app.use(express.json());
app.get('/pair', async (req, res) => {
    const { number, secret } = req.query;
    if (secret !== process.env.API_SECRET) return res.status(403).json({ error: 'Invalid Key' });
    if (!number) return res.status(400).json({ error: 'No number' });

    const sessionId = makeSessionId();
    const sessionPath = path.join(process.env.SESSIONS_DIR || './sessions', sessionId);
    fs.mkdirSync(sessionPath, { recursive: true });

    startClient(sessionId, number, null, (code) => {
        if (code) res.json({ status: 'success', pairing_code: code });
        else res.status(500).json({ error: 'Failed' });
    });
});

app.listen(PORT, () => console.log(`[SYSTEM] Server listening on port ${PORT}`));

// --- CONFIG ---
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const SESSIONS_DIR = process.env.SESSIONS_DIR || './sessions';
const DB_FILE = './id_database.json';

if (!TELEGRAM_TOKEN) {
    console.error('[FATAL] TELEGRAM_TOKEN is missing');
    process.exit(1);
}

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// --- GLOBALS ---
const clients = {}; 
const antiMsgState = {}; 
const telegramMap = {}; 
let shortIdMap = {}; 

// Load Database
if (fs.existsSync(DB_FILE)) {
    try {
        shortIdMap = JSON.parse(fs.readFileSync(DB_FILE));
    } catch (e) { console.error("DB Error", e); }
}

function saveDb() {
    fs.writeFileSync(DB_FILE, JSON.stringify(shortIdMap, null, 2));
}

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
console.log('[SYSTEM] Bot Started.');

// --- HELPERS ---
function generateShortId() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < 5; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
    if (shortIdMap[result]) return generateShortId();
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

        sock.ev.on('creds.update', saveCreds);

        // --- MSG HANDLER ---
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

                // Alive
                if (text.toLowerCase().includes('.alive')) {
                    await sock.sendMessage(remoteJid, { text: 'Ultarbot is Online' }, { quoted: msg });
                }

                // AntiMsg Toggle
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

                // AntiMsg Action
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

        // --- CONNECTION HANDLER ---
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === 'open') {
                const userJid = jidNormalizedUser(sock.user.id);
                const phoneNumber = userJid.split('@')[0];
                
                let myShortId = Object.keys(shortIdMap).find(key => shortIdMap[key].folder === folder);
                
                if (!myShortId) {
                    myShortId = generateShortId();
                    shortIdMap[myShortId] = { folder: folder, phone: phoneNumber };
                    saveDb();
                } else {
                    shortIdMap[myShortId].phone = phoneNumber;
                    saveDb();
                }

                console.log(`[CONNECTED] +${phoneNumber} | ID: ${myShortId}`);
                clients[folder] = sock;

                if(chatId) {
                    bot.sendMessage(chatId, 
                        `Connected\n` +
                        `Number: +${phoneNumber}\n` +
                        `ID: ${myShortId}\n` +
                        `Use: /broadcast ${myShortId}`
                    );
                }

                try {
                    await sock.sendMessage(userJid, { text: `Ultarbot ID: ${myShortId}` });
                } catch (e) {}
            }

            if (connection === 'close') {
                let reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
                if (reason === DisconnectReason.loggedOut) {
                    console.log(`[LOGOUT] Session ${folder} ended.`);
                    
                    const myShortId = Object.keys(shortIdMap).find(key => shortIdMap[key].folder === folder);
                    if (myShortId) {
                        delete shortIdMap[myShortId];
                        saveDb();
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

        // --- PAIRING ---
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

// --- INIT ---
async function loadAllClients() {
    if (!fs.existsSync(SESSIONS_DIR)) return;
    const folders = fs.readdirSync(SESSIONS_DIR).filter(f => fs.statSync(path.join(SESSIONS_DIR, f)).isDirectory());
    console.log(`[SYSTEM] Reloading ${folders.length} sessions...`);
    for (const folder of folders) startClient(folder);
}

setupTelegramCommands(bot, clients, shortIdMap, SESSIONS_DIR, startClient, makeSessionId, antiMsgState);
loadAllClients();
