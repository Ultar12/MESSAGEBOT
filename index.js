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

// Import the separated command file
import { setupTelegramCommands } from './telegram_commands.js';

// --- SERVER ---
const app = express();
const PORT = process.env.PORT || 10000;
app.get('/', (req, res) => res.send('Ultarbot Active'));
app.listen(PORT, () => console.log(`[SYSTEM] Server listening on port ${PORT}`));

// --- CONFIG ---
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const SESSIONS_DIR = process.env.SESSIONS_DIR || './sessions';

if (!TELEGRAM_TOKEN) {
    console.error('[FATAL] TELEGRAM_TOKEN is missing');
    process.exit(1);
}

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// --- GLOBALS ---
const clients = {}; 
const sessionMap = {}; 
const antiMsgState = {}; 
const telegramMap = {}; 

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
console.log('[SYSTEM] Bot Started.');

// --- HELPERS ---
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
async function startClient(folder, targetNumber = null, chatId = null) {
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
                
                // Unwrap Message
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
                    await sock.sendMessage(remoteJid, { text: 'Ultarbot is Online 🟢' }, { quoted: msg });
                }

                // AntiMsg Toggle
                if (isFromMe && text.toLowerCase().startsWith('.antimsg')) {
                    const cmd = text.split(' ')[1];
                    if (cmd === 'on') {
                        antiMsgState[userPhone] = true;
                        await sock.sendMessage(remoteJid, { text: '✅ AntiMsg LOCKED.' }, { quoted: msg });
                    } else if (cmd === 'off') {
                        antiMsgState[userPhone] = false;
                        await sock.sendMessage(remoteJid, { text: '❌ AntiMsg UNLOCKED.' }, { quoted: msg });
                    }
                    return; 
                }

                // AntiMsg Action
                if (isFromMe && antiMsgState[userPhone]) {
                    if (remoteJid === myJid) return; 
                    if (text.startsWith('.')) return;

                    try { await sock.sendMessage(remoteJid, { delete: msg.key }); } catch (e) {}

                    const target = remoteJid.split('@')[0];
                    const tgChatId = telegramMap[folder];
                    
                    if (tgChatId) {
                        bot.sendMessage(tgChatId, `⚠️ *AntiMsg Action*\nTarget: +${target}\nAction: 🗑️ DELETED`, { parse_mode: 'Markdown' });
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
                
                console.log(`[SUCCESS] Connected: +${phoneNumber} (ID: ${folder})`);
                clients[phoneNumber] = sock;
                sessionMap[folder] = phoneNumber;
                if (chatId) telegramMap[folder] = chatId;

                if(chatId) bot.sendMessage(chatId, `[SUCCESS] Connected: +${phoneNumber}\nSession ID: ${folder}`);

                try {
                    await sock.sendMessage(userJid, { text: `Ultarbot Connected\nNumber: +${phoneNumber}\nSession ID:\n${folder}` });
                } catch (e) {}
            }

            if (connection === 'close') {
                let reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
                if (reason === DisconnectReason.loggedOut) {
                    const num = sessionMap[folder];
                    if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true, force: true });
                    if (num) delete clients[num];
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
                        console.log(`[PAIRING] Requesting code for +${targetNumber}...`);
                        const code = await sock.requestPairingCode(targetNumber);
                        if (chatId) {
                            await bot.sendMessage(chatId, `Pairing Code for +${targetNumber}:\n\n\`${code}\`\n\nTap code to copy.`, { parse_mode: 'Markdown' });
                        }
                    } catch (e) {
                        if (chatId) bot.sendMessage(chatId, `[ERROR] Failed to get code: ${e.message}`);
                        if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true, force: true });
                    }
                }
            }, 3000);
        }
    } catch (error) {
        console.error(`[CLIENT ERROR] ${folder}:`, error);
    }
}

// --- INIT ---
async function loadAllClients() {
    if (!fs.existsSync(SESSIONS_DIR)) return;
    const folders = fs.readdirSync(SESSIONS_DIR).filter(f => fs.statSync(path.join(SESSIONS_DIR, f)).isDirectory());
    console.log(`[SYSTEM] Reloading ${folders.length} sessions...`);
    for (const folder of folders) startClient(folder);
}

// Start Command Handling
setupTelegramCommands(bot, clients, SESSIONS_DIR, startClient, makeSessionId, antiMsgState);
loadAllClients();
