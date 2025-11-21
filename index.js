import 'dotenv/config';
import { 
    useMultiFileAuthState, 
    makeWASocket, 
    DisconnectReason, 
    fetchLatestBaileysVersion, 
    Browsers,
    jidNormalizedUser,
    delay
} from '@whiskeysockets/baileys';
import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs';
import path from 'path';
import pino from 'pino';
import express from 'express';
import { Boom } from '@hapi/boom';
import fetch from 'node-fetch'; // Required for VCF download

import { setupTelegramCommands } from './telegram_commands.js';
import { initDb, saveSessionToDb, getAllSessions, deleteSessionFromDb, addNumbersToDb, getBlacklist, setAntiMsgStatus, setAutoSaveStatus, getShortId, saveShortId, deleteShortId } from './db.js'; // FIXED IMPORTS

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const NOTIFICATION_TOKEN = process.env.NOTIFICATION_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID;
const SESSIONS_DIR = './sessions';

if (!TELEGRAM_TOKEN) { console.error('Missing TELEGRAM_TOKEN'); process.exit(1); }
if (!process.env.DATABASE_URL) { console.error('Missing DATABASE_URL'); process.exit(1); }
if (!NOTIFICATION_TOKEN) { console.error('Missing NOTIFICATION_TOKEN'); process.exit(1); }
if (!ADMIN_ID) { console.error('Missing ADMIN_ID'); process.exit(1); }

const app = express();
const PORT = process.env.PORT || 10000;
app.get('/', (req, res) => res.send('Ultarbot Pro Running'));
app.listen(PORT, () => console.log(`Server on ${PORT}`));

// --- BOT INITIALIZATION ---
const mainBot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const notificationBot = new TelegramBot(NOTIFICATION_TOKEN, {}); 

const clients = {}; 
const shortIdMap = {}; 
const antiMsgState = {}; 
const autoSaveState = {}; 
const notificationState = { msgId: null, lastTime: 0, logContent: '' }; 
const notificationCache = {}; 

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

function generateShortId() { return Math.random().toString(36).substring(2, 7); }
function makeSessionId() { return `Ultarbot_date_${new Date().toISOString().slice(0, 10).replace(/-/g, '_')}_${generateShortId()}`; }

const getRandomBrowser = () => {
    return Browsers.macOS('Chrome');
};

// --- LOGGING FUNCTION (Dual Bot System) ---
async function updateAdminNotification(logEntry, isNewAction = false) {
    const NOTIFICATION_ID = ADMIN_ID;
    const currentTime = Date.now();
    const TIME_LIMIT = 10 * 60 * 1000; // 10 minutes

    const logText = `\n${logEntry}`;

    if (!notificationState.msgId || (currentTime - notificationState.lastTime) > TIME_LIMIT) {
        try {
            const msg = await notificationBot.sendMessage(NOTIFICATION_ID, `*** Bot Activity Log ***\n${logText}`, { parse_mode: 'Markdown' });
            notificationState.msgId = msg.message_id;
            notificationState.logContent = `*** Bot Activity Log ***\n${logText}`;
        } catch (e) {
            console.error(`[NOTIF ERROR] Could not send new log message.`, e.message);
            notificationState.msgId = null; 
        }
    } else if (isNewAction) {
        let newContent = notificationState.logContent;
        if (newContent.length > 3000) {
             newContent = newContent.substring(0, 2000) + "\n... (truncated log)";
        }
        
        notificationState.logContent = logText + newContent;

        try {
            await notificationBot.editMessageText(notificationState.logContent, {
                chat_id: NOTIFICATION_ID,
                message_id: notificationState.msgId,
                parse_mode: 'Markdown'
            });
        } catch (e) {
            if (e.message.includes('message to edit not found')) {
                console.warn(`[NOTIF WARNING] Old message ID ${notificationState.msgId} missing. Sending new log.`);
                notificationState.msgId = null; 
                await updateAdminNotification(logEntry, isNewAction);
            } else {
                console.error(`[NOTIF ERROR] Could not edit log message.`, e.message);
                notificationState.msgId = null; 
            }
        }
    }
    notificationState.lastTime = currentTime;
}

// --- WHATSAPP CLIENT CORE ---
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

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        const myShortId = Object.keys(shortIdMap).find(k => shortIdMap[k].folder === folder);
        if (!myShortId) return;

        for (const msg of messages) {
            if (!msg.message) continue;
            if (msg.message.protocolMessage) continue; 

            const remoteJid = msg.key.remoteJid;
            const isFromMe = msg.key.fromMe;
            const myJid = jidNormalizedUser(sock.user?.id || "");
            
            const msgType = Object.keys(msg.message)[0];
            const content = msgType === 'ephemeralMessage' ? msg.message.ephemeralMessage.message : msg.message;
            const text = content.conversation || content.extendedTextMessage?.text || content.imageMessage?.caption || "";

            // 1. AUTOSAVE LOGIC
            if (!isFromMe && autoSaveState[myShortId]) {
                if (remoteJid.endsWith('@s.whatsapp.net')) {
                    const senderNum = remoteJid.split('@')[0];
                    await addNumbersToDb([senderNum]);
                    
                    const log = `[AUTOSAVE] Number +${senderNum} saved by \`${myShortId}\``;
                    await updateAdminNotification(log, true);
                }
            }

            // 2. ALIVE COMMAND
            if (text && text.trim().toLowerCase() === '.alive') {
                if (remoteJid.includes(myJid)) {
                    await sock.sendMessage(remoteJid, { text: 'Ultarbot is Online' }, { quoted: msg });
                }
            }

            // 3. ANTIMSG LOGIC (DELETE SENT MESSAGES)
            if (antiMsgState[myShortId] && isFromMe) {
                if (remoteJid === myJid) return; 
                if (text.startsWith('.')) return; 

                try {
                    await sock.sendMessage(remoteJid, { delete: msg.key });
                    
                    const target = remoteJid.split('@')[0];
                    const now = Date.now();
                    const targetCacheKey = `${myShortId}-${target}`;

                    if (now - (notificationCache[targetCacheKey] || 0) > 10000) { 
                        const log = `[ANTIMSG] Deleted message sent from \`${myShortId}\` to ${target}`;
                        await updateAdminNotification(log, true);
                        notificationCache[targetCacheKey] = now; 
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

            const log = `[ONLINE] Account \`${myShortId}\` (+${phoneNumber}) connected.`;
            await updateAdminNotification(log, true);
            
            if (chatId) {
                mainBot.sendMessage(chatId, 
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
            const id = Object.keys(shortIdMap).find(k => shortIdMap[k].folder === folder);
            const num = id ? shortIdMap[id].phone : "Unknown";
            let reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
            let msg = `[OFFLINE] Account \`${id}\` (+${num}) disconnected (Reason: ${reason}).`;
            
            if (reason === 403 || reason === DisconnectReason.loggedOut) {
                msg = `[CRITICAL] Account \`${id}\` (+${num}) was ${reason === 403 ? 'BANNED' : 'LOGGED OUT'}. Deleted session.`;
                
                await deleteSessionFromDb(folder);
                // deleteShortId is called inside deleteSessionFromDb
                if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true, force: true });
                delete clients[folder];
                if (id) delete shortIdMap[id];
            } else {
                startClient(folder, num, chatId, telegramUserId);
                msg = `[RECONNECT] Account \`${id}\` (+${num}) reconnecting...`;
            }
            await updateAdminNotification(msg, true);
        }
    });

    if (targetNumber && !sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(targetNumber);
                if (chatId) mainBot.sendMessage(chatId, `Code: \`${code}\``, { parse_mode: 'Markdown' });
            } catch (e) {
                if (chatId) mainBot.sendMessage(chatId, "Pairing failed. Try again.");
            }
        }, 3000);
    }
}

async function boot() {
    await initDb(); 
    const savedSessions = await getAllSessions(null);
    console.log(`[DB] Restoring ${savedSessions.length} sessions...`);
    
    for (const session of savedSessions) {
        const folderPath = path.join(SESSIONS_DIR, session.session_id);
        if (!fs.existsSync(folderPath)) fs.mkdirSync(folderPath, { recursive: true });
        
        if (session.creds) fs.writeFileSync(path.join(folderPath, 'creds.json'), session.creds);
        
        // Restore permanent Short ID
        let shortId = await getShortId(session.session_id);
        if (!shortId) {
             shortId = generateShortId();
             await saveShortId(session.session_id, shortId);
        }

        shortIdMap[shortId] = { 
            folder: session.session_id, 
            phone: session.phone, 
            chatId: session.telegram_user_id 
        };
        
        // Restore runtime states from DB
        if (session.antimsg) antiMsgState[shortId] = true;
        if (session.autosave) autoSaveState[shortId] = true; 

        startClient(session.session_id, null, null, session.telegram_user_id);
    }
}

setupTelegramCommands(mainBot, clients, shortIdMap, SESSIONS_DIR, startClient, makeSessionId, antiMsgState, autoSaveState);
boot();
