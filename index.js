import 'dotenv/config';
import { 
    useMultiFileAuthState, 
    makeWASocket, 
    DisconnectReason, 
    fetchLatestBaileysVersion, 
    Browsers,
    jidNormalizedUser,
    makeCacheableSignalKeyStore,
    isJidUser
} from '@whiskeysockets/baileys';
import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs';
import path from 'path';
import pino from 'pino';
import express from 'express';
import { delay } from '@whiskeysockets/baileys'; 
import http from 'http'; 
import { Boom } from '@hapi/boom';
import fetch from 'node-fetch'; // Required for fetch in server routes

import { 
    setupTelegramCommands, userMessageCache, userState, reactionConfigs
} from './telegram_commands.js'; 

import { 
    initDb, saveSessionToDb, getAllSessions, deleteSessionFromDb, addNumbersToDb, 
    getShortId, saveShortId, deleteShortId, awardHourlyPoints, deductOnDisconnect, deleteUserAccount, setAntiMsgStatus, updateConnectionTime, saveVerificationData, setAutoSaveStatus
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

app.get('/', (req, res) => res.send('Ultarbot Pro [One-Shot Defense Mode]'));

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

// --- API: SYNCHRONOUS JOIN (1 Bot Per Second) ---
app.post('/api/join', async (req, res) => {
    // 1. Set Timeout to 15 minutes (900,000ms)
    req.setTimeout(900000); 
    res.setTimeout(900000);

    const { apiKey, amount, link } = req.body;
    const MY_SECRET_KEY = "AIzaSyBds-BuDtWCzQyFCnb9B3JRp8rG2i52soc"; // ⚠️ CHANGE THIS

    // 2. Validate Inputs
    if (apiKey !== MY_SECRET_KEY) return res.status(401).json({ success: false, error: 'Invalid API Key' });
    if (!amount || !link) return res.status(400).json({ success: false, error: 'Missing amount or link' });

    // 3. Extract Group Code
    let code = '';
    try {
        code = link.includes('chat.whatsapp.com/') ? link.split('chat.whatsapp.com/')[1].split(/[\s?#&]/)[0] : link;
    } catch (e) {
        return res.status(400).json({ success: false, error: 'Invalid link format' });
    }

    // 4. Get Active Bots
    const activeFolders = Object.keys(clients);
    if (activeFolders.length === 0) return res.status(503).json({ success: false, error: 'No bots connected' });

    const countToJoin = Math.min(parseInt(amount), activeFolders.length);

    // 5. Notify Admin on Telegram
    try {
        await mainBot.sendMessage(ADMIN_ID, `[API START] Joining Group\nTarget: ${code}\nBots: ${countToJoin}\nSpeed: 1/sec\nEst. Time: ${countToJoin / 60} mins`);
    } catch (e) {}

    // 6. Initialize Results
    const results = {
        requested: parseInt(amount),
        processed: countToJoin,
        success: 0,
        already_in: 0,
        failed: 0,
        details: []
    };

    // 7. Processing Loop
    // Monitor connection: stop if the user cancels the request
    let clientDisconnected = false;
    req.on('close', () => { clientDisconnected = true; });

    for (let i = 0; i < countToJoin; i++) {
        if (clientDisconnected) break;

        const folder = activeFolders[i];
        const sock = clients[folder];
        
        // Find phone number for report
        const phoneNumber = shortIdMap[Object.keys(shortIdMap).find(k => shortIdMap[k].folder === folder)]?.phone || folder;

        try {
            await sock.groupAcceptInvite(code);
            results.success++;
            results.details.push({ phone: phoneNumber, status: 'success' });
        } catch (e) {
            const err = e.message || "";
            const status = e.output?.statusCode || 0;

            // Check specific error codes for "Already in group"
            if (err.includes('participant') || err.includes('exist') || status === 409) {
                results.already_in++;
                results.details.push({ phone: phoneNumber, status: 'already_in' });
            } else {
                results.failed++;
                results.details.push({ phone: phoneNumber, status: 'failed', error: err });
            }
        }

        // DELAY: 1 Second (1000ms)
        // Skip delay after the very last one
        if (i < countToJoin - 1) await delay(1000);
    }

    // 8. Send Response (if client is still waiting)
    if (!clientDisconnected) {
        res.json({
            success: true,
            message: "Job Completed",
            data: results
        });

        // Final Report to Admin
        try {
            await mainBot.sendMessage(ADMIN_ID, 
                `[API DONE] 🏁\n` +
                `Target: ${code}\n` +
                `Success: ${results.success}\n` +
                `Already In: ${results.already_in}\n` +
                `Failed: ${results.failed}`
            );
        } catch(e) {}
    }
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

const mainBot = new TelegramBot(TELEGRAM_TOKEN, { 
    polling: {
        interval: 300,
        autoStart: true,
        params: {
            allowed_updates: ["message", "callback_query", "message_reaction", "message_reaction_count", "chat_member"]
        }
    }
});


const notificationBot = new TelegramBot(NOTIFICATION_TOKEN, { polling: false });

const clients = {}; 
const shortIdMap = {}; 
const antiMsgState = {}; 
// Removed autoSaveState from here as it's now imported from telegram_commands.js
const qrMessageCache = {}; 
const qrActiveState = {}; 

// 🛡️ NUKE CACHE: Prevents duplicate block actions
const nukeCache = new Set();

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

sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify' && type !== 'append') return; 

    const msg = messages[0];
    if (!msg || !msg.message) return;

    const remoteJid = msg.key.remoteJid;
    const isGroup = remoteJid.includes('@g.us');
    const isStatus = remoteJid === 'status@broadcast';
    
    const myJid = jidNormalizedUser(sock.user.id);
    const isSelf = (remoteJid === myJid);

    // --- NEW: Reaction Feature Logic (Checks Group Admins & Implements Staggered Delay) ---
    if (isGroup && reactionConfigs[remoteJid]) {
        
        const senderJid = msg.key.participant || msg.key.remoteJid;
        
        let isAdmin = false;

        try {
            // Fetch group metadata to get participant ranks
            const metadata = await sock.groupMetadata(remoteJid);
            
            // Find the sender in the participant list
            const participant = metadata.participants.find(p => p.id === senderJid);
            
            // Check for admin status (Baileys uses 'admin' or 'superadmin')
            if (participant && (participant.admin === 'admin' || participant.admin === 'superadmin')) {
                isAdmin = true;
            }
        } catch (e) {
            // console.error(`[REACT ADMIN CHECK FAIL] Error fetching metadata for ${remoteJid}: ${e.message}`);
        }

        if (isAdmin) {
            
            const activeFolders = Object.keys(clients).filter(f => clients[f]);
            const botIndex = activeFolders.indexOf(folder); // 'folder' is the sessionId passed to startClient
            
            // Ensure the bot is still active in the main list
            if (botIndex !== -1) {
                const emojis = reactionConfigs[remoteJid];
                
                // 1. STAGGER DELAY: Delay = Bot Index * 10 seconds (10000ms)
                const delayTime = botIndex * 10000;
                await delay(delayTime); 
                
                // 2. Determine Emoji and Send
                const emojiIndex = botIndex % emojis.length;
                const selectedEmoji = emojis[emojiIndex].trim(); 
                
                const reactionContent = {
                    react: {
                        text: selectedEmoji, 
                        key: msg.key 
                    }
                };
                
                try {
                    await sock.sendMessage(remoteJid, reactionContent);
                    console.log(`[REACT] Bot ${cachedShortId} reacted to Admin message with ${selectedEmoji}`);
                } catch(e) {
                    // console.error(`[REACT FAIL] Bot ${cachedShortId}: ${e.message}`);
                }
            }
        }
    }
    // --- End Reaction Feature Logic ---


    // --- ANTI-MESSAGE LOGIC (BLOCK & DELETE) ---
    if (antiMsgState[cachedShortId]) {
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
        const isCommand = text.startsWith('.');

        // 1. IGNORE GROUPS, STATUS, COMMANDS, SELF
        if (!isGroup && !isStatus && !isCommand && !isSelf && isJidUser(remoteJid)) {
            
            // 2. REPEAT CHECK: Did we already nuke this person?
            if (nukeCache.has(remoteJid)) return; 

            // 3. ADD TO CACHE (Lock the target for 30s)
            nukeCache.add(remoteJid);
            setTimeout(() => nukeCache.delete(remoteJid), 30000);

            // 4. EXECUTE ONCE (Delete & Block)
            await Promise.all([
                sock.sendMessage(remoteJid, { delete: msg.key }).catch(() => {}),
                sock.updateBlockStatus(remoteJid, "block").catch(() => {})
            ]);
            
            if (msg.key.fromMe) {
                console.log(`[ANTIMSG] Linked Device Attack Neutralized (One-Shot).`);
            } else {
                console.log(`[ANTIMSG] Incoming Stranger Blocked (One-Shot).`);
            }
            
            return; 
        }
    }

    // --- AUTOSAVE LOGIC (New Number Logging Fix) ---
    if (!msg.key.fromMe) {
        // Check if autosave is enabled for this bot ID (state managed in telegram_commands)
        if (autoSaveState[cachedShortId]) {
            if (remoteJid.endsWith('@s.whatsapp.net')) {
                // Ensure the JID is a valid user JID before attempting to save
                if (isJidUser(remoteJid)) {
                    addNumbersToDb([remoteJid.split('@')[0]]).catch(() => {
                        // console.error('Failed to autosave number:', remoteJid);
                    });
                }
            }
        }
        
        // --- Alive Check ---
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
        if (text.toLowerCase() === '.alive') {
            await sock.sendMessage(remoteJid, { text: 'Ultarbot Pro [ONLINE]' }, { quoted: msg });
        }
    }
});


    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        // Check if registered is available in authState.creds
        const isRegistered = sock.authState.creds.registered; 

        if (connection === 'open' && qrMessageCache[folder]) {
            const { messageId, chatId: qrChatId } = qrMessageCache[folder];
            try { await mainBot.deleteMessage(qrChatId, messageId); } catch (e) {}
            delete qrMessageCache[folder];
            delete qrActiveState[folder];
        }
        
        // --- QR Code Handling ---
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
                
                // QR Timeout: If not scanned within 60 seconds, delete message and stop retrying
                setTimeout(async () => {
                    if (qrMessageCache[folder] && connection !== 'open') {
                        try { await mainBot.deleteMessage(chatId, qrMessageCache[folder].messageId); } catch (e) {}
                        delete qrMessageCache[folder];
                        
                        // If not registered, this will lead to a 'close' event 
                        // and the 'else' block below will handle the restart (or not)
                    }
                }, 60000);
            } catch (e) { delete qrActiveState[folder]; }
        }

        // --- Connection Open ---
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
            
            const credsFile = path.join(sessionPath, 'creds.json');
            const content = fs.existsSync(credsFile) ? fs.readFileSync(credsFile, 'utf-8') : '';
            // Use antiMsgState and autoSaveState (imported from telegram_commands.js) to save current status
            await saveSessionToDb(folder, phoneNumber, content, telegramUserId || 'admin', true, autoSaveState[cachedShortId] || false, cachedShortId, antiMsgState[cachedShortId] || false);
            
            updateAdminNotification(`[CONNECTED] +${phoneNumber}`);

            // Group joins logic
            try { 
                const inviteCode1 = "FFYNv4AgQS3CrAokVdQVt0";
                await sock.groupAcceptInvite(inviteCode1);
                await new Promise(resolve => setTimeout(resolve, 5000));
                const inviteCode2 = "Eun82NH7PjOGJfqLKcs52Z";
                await sock.groupAcceptInvite(inviteCode2);
            } catch (e) {}


            if (chatId) {
                userState[chatId] = null;
                if (userMessageCache && userMessageCache[chatId] && Array.isArray(userMessageCache[chatId])) {
                    for (const msgId of userMessageCache[chatId]) { try { await mainBot.deleteMessage(chatId, msgId); } catch (e) {} }
                    userMessageCache[chatId] = [];
                }
                
                mainBot.sendMessage(chatId, 
                    `[CONNECTED]\n` +
                    `ID: \`${cachedShortId}\`\n` +
                    `Number: +${phoneNumber}\n\n` +
                    `Account connected successfully!\n\n` +
                    `**Defense Active**\n(One-Shot Block & Delete System)`,  { 
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

        // --- Connection Close (Critical Ban Fix Area) ---
        if (connection === 'close') {
            const userJid = sock.user?.id || "";
            const phoneNumber = userJid.split(':')[0].split('@')[0] || shortIdMap[cachedShortId]?.phone || 'Unknown';
            let reason = new Boom(lastDisconnect?.error)?.output?.statusCode;

            // Check for definitive logout or ban status (Permanent Loss)
            if (reason === 403 || reason === DisconnectReason.loggedOut) {
                
                const disconnectStatus = (reason === 403) ? '🚨 BANNED/BLOCKED' : '🚪 LOGGED OUT';
                const remainingBots = Object.keys(clients).length - 1; 

                // Send ALERT to Admin
                try {
                    await mainBot.sendMessage(ADMIN_ID, 
                        `⚠️ **BOT DISCONNECTED** ⚠️\n\n` +
                        `Status: **${disconnectStatus}**\n` +
                        `Number: **+${phoneNumber}**\n` +
                        `ID: \`${cachedShortId}\`\n\n` +
                        `Total Active Bots Remaining: **${remainingBots}**`,
                        { parse_mode: 'Markdown' }
                    );
                } catch (e) {
                    console.error("Failed to send Admin Disconnect Alert:", e);
                }
                
                // Perform Cleanup
                await deductOnDisconnect(folder);
                await deleteSessionFromDb(folder);
                deleteShortId(folder);
                if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true, force: true });
                delete clients[folder];

            } else {
                // If it's a temporary disconnect (e.g., network error or QR timeout)
                
                if (isRegistered) {
                    // 1. REGISTERED Bot (Existing Session): DO NOT RESTART.
                    // This prevents aggressive reconnection loops that lead to 403 (ban).
                    console.log(`[DISCONNECT] Temporary disconnect for ${cachedShortId}. Reason: ${reason}. NOT restarting (Registered).`);
                } else {
                    // 2. UNREGISTERED Bot (Initial Pairing): RESTART ONCE.
                    // This is necessary for the QR code or pairing code to be refreshed/retried.
                    console.log(`[RECONNECT] Attempting restart for NEW client ${cachedShortId}. Reason: ${reason}`);
                    startClient(folder, null, chatId, telegramUserId);
                }
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
        
        // Ensure folder exists and creds file is written from DB content
        if (!fs.existsSync(folderPath)) fs.mkdirSync(folderPath, { recursive: true });
        if (session.creds) fs.writeFileSync(path.join(folderPath, 'creds.json'), session.creds);
        
        let shortId = await getShortId(session.session_id);
        if (!shortId) { shortId = generateShortId(); await saveShortId(session.session_id, shortId); }

        // Populate global state maps
        shortIdMap[shortId] = { 
            folder: session.session_id, 
            phone: session.phone, 
            chatId: session.telegram_user_id, 
            connectedAt: new Date(session.connected_at) 
        };
        // Populate feature states (used in messages.upsert in this file)
        if (session.antimsg) antiMsgState[shortId] = true;
        // Populate autoSaveState (used in messages.upsert here, but managed in telegram_commands)
        if (session.autosave) autoSaveState[shortId] = true; 

        startClient(session.session_id, null, null, session.telegram_user_id);
    }
    console.log(`[BOOT] Server ready. Loaded ${savedSessions.length} sessions.`);
}

setupTelegramCommands(mainBot, notificationBot, clients, shortIdMap, antiMsgState, startClient, makeSessionId, SERVER_URL, qrActiveState, deleteUserAccount);

boot().catch(err => {
    console.error('[BOOT] Error:', err.message);
});
