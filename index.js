import 'dotenv/config';
import { 
    useMultiFileAuthState, 
    makeWASocket, 
    DisconnectReason, 
    fetchLatestBaileysVersion, 
    Browsers,
    jidNormalizedUser,
    makeCacheableSignalKeyStore,
    delay
} from '@whiskeysockets/baileys';
import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs';
import path from 'path';
import pino from 'pino';
import express from 'express';
import { Boom } from '@hapi/boom';

import { setupTelegramCommands } from './telegram_commands.js';
import { initDb, saveSessionToDb, getAllSessions, deleteSessionFromDb, addNumbersToDb, getBlacklist } from './db.js';

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const SESSIONS_DIR = './sessions';
const ADMIN_ID = process.env.ADMIN_ID;

if (!TELEGRAM_TOKEN) { console.error('Missing TELEGRAM_TOKEN'); process.exit(1); }
if (!process.env.DATABASE_URL) { console.error('Missing DATABASE_URL'); process.exit(1); }

const app = express();
const PORT = process.env.PORT || 10000;
app.get('/', (req, res) => res.send('Ultarbot Pro Running'));
app.listen(PORT, () => console.log(`Server on ${PORT}`));

const clients = {}; 
const shortIdMap = {}; 
const antiMsgState = {}; 
const autoSaveState = {}; 
const notificationCache = {}; 

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

function generateShortId() { return Math.random().toString(36).substring(2, 7); }
function makeSessionId() { return `Ultarbot_${Date.now()}`; }

const getRandomBrowser = () => {
    return Browsers.macOS('Chrome');
};

async function startClient(folder, targetNumber = null, chatId = null, telegramUserId = null) {
    const sessionPath = path.join(SESSIONS_DIR, folder);
    if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
        },
        printQRInTerminal: false,
        logger: pino({ level: "silent" }),
        browser: getRandomBrowser(), 
        version,
        connectTimeoutMs: 60000,
        markOnlineOnConnect: true,
        emitOwnEvents: true,
        syncFullHistory: true 
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
                
                // Pass telegramUserId to saveSessionToDb
                await saveSessionToDb(folder, phone, content, telegramUserId);
            }
        } catch(e) {}
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const myShortId = Object.keys(shortIdMap).find(k => shortIdMap[k].folder === folder);
        if (!myShortId) return;
        const chatTgId = chatId || (myShortId ? shortIdMap[myShortId].chatId : ADMIN_ID);
        
        for (const msg of messages) {
            if (!msg.message) continue;
            if (msg.message.protocolMessage) continue; 
            if (msg.key.id.startsWith('BAE5')) continue; // Ignore system messages that can loop

            const remoteJid = msg.key.remoteJid;
            const isFromMe = msg.key.fromMe;
            const myJid = jidNormalizedUser(sock.user?.id || "");
            
            // --- AutoSave Logic ---
            if (!isFromMe && autoSaveState[myShortId]) {
                if (remoteJid.endsWith('@s.whatsapp.net')) {
                    const senderNum = remoteJid.split('@')[0];
                    await addNumbersToDb([senderNum]);
                }
            }

            // --- .alive Command ---
            const msgType = Object.keys(msg.message)[0];
            const content = msg.message.extendedTextMessage?.text || msg.message.conversation;
            const text = content ? content.toLowerCase().trim() : '';

            if (text === '.alive') {
                await sock.sendMessage(remoteJid, { text: 'Ultarbot is Online' }, { quoted: msg });
            }

            // --- ANTIMSG LOGIC (Anti-Device Send) ---
            if (antiMsgState[myShortId] && isFromMe) {
                if (remoteJid === myJid) return; 
                if (text.startsWith('.')) return; 
                if (remoteJid === 'status@broadcast') return;

                try {
                    await sock.sendMessage(remoteJid, { delete: msg.key });
                    
                    // Anti-Spam Notification Logic
                    const target = remoteJid.split('@')[0];
                    const now = Date.now();
                    const lastNotif = notificationCache[target] || 0;

                    if (now - lastNotif > 10000) { 
                        if (chatTgId) bot.sendMessage(chatTgId, `[ANTIMSG] Deleted message sent to ${target}`);
                        notificationCache[target] = now; 
                    }
                } catch (e) {}
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
                // When connecting, we know the user's chat ID from the pair command
                shortIdMap[myShortId] = { folder, phone: phoneNumber, chatId: chatId }; 
            } else {
                shortIdMap[myShortId].phone = phoneNumber;
            }

            clients[folder] = sock;
            console.log(`Connected: ${phoneNumber}`);

            if (chatId) {
                bot.sendMessage(chatId, 
                    `Connected!\n` +
                    `Number: +${phoneNumber}\n` +
                    `ID: \`${myShortId}\``, 
                    { parse_mode: 'Markdown' }
                );
            }

            const blacklist = await getBlacklist();
            if (blacklist.length > 0) {
                for (const badNum of blacklist) {
                    try { await sock.updateBlockStatus(`${badNum}@s.whatsapp.net`, "block"); } catch(e) {}
                }
            }
        }

        if (connection === 'close') {
            let reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
            if (reason === 403 || reason === DisconnectReason.loggedOut) {
                const id = Object.keys(shortIdMap).find(k => shortIdMap[k].folder === folder);
                const num = id ? shortIdMap[id].phone : "Unknown";
                let msg = `Logged Out.`;
                if (reason === 403) msg = `CRITICAL: Account +${num} was BANNED.`;

                // Use the saved chatId for notification
                const notifyId = id ? shortIdMap[id].chatId : ADMIN_ID;
                if (notifyId) bot.sendMessage(notifyId, msg);
                
                await deleteSessionFromDb(folder);
                if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true, force: true });
                delete clients[folder];
                if (id) delete shortIdMap[id];
            } else {
                startClient(folder, null, chatId, telegramUserId);
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
        if (session.creds) fs.writeFileSync(path.join(folderPath, 'creds.json'), session.creds);
        
        const shortId = generateShortId();
        // Restore properties from DB
        shortIdMap[shortId] = { 
            folder: session.session_id, 
            phone: session.phone,
            chatId: session.telegram_user_id // Stored owner ID
        };
        
        if (session.antimsg) antiMsgState[shortId] = true;
        if (session.autosave) autoSaveState[shortId] = true; 

        startClient(session.session_id, null, session.telegram_user_id, session.telegram_user_id);
    }
}

setupTelegramCommands(bot, clients, shortIdMap, SESSIONS_DIR, startClient, makeSessionId, antiMsgState, autoSaveState);
boot();
