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

import { 
    setupTelegramCommands, userMessageCache, userState, reactionConfigs 
} from './telegram_commands.js';
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
    // This allows up to ~800 bots to join in one request without timing out.
    req.setTimeout(900000); 
    res.setTimeout(900000);

    const { apiKey, amount, link } = req.body;
    const MY_SECRET_KEY = "AIzaSyBds-BuDtWCzQyFCnb9B3JRp8rG2i52soc"; // CHANGE THIS

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
        await mainBot.sendMessage(ADMIN_ID, `[API START] Joining Group\nTarget: ${code}\nBots: ${countToJoin}\nSpeed: 1/sec\nEst. Time: ${(countToJoin / 60).toFixed(2)} mins`);
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
                `[API DONE]\n` +
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
            // THIS LINE IS CRITICAL FOR REACTIONS TO WORK:
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

// --- GLOBAL STATE FOR BAN SUMMARIZATION (15 MINUTE TIMER) ---
const bannedNumbersBuffer = []; 
let banSummaryTimeout = null;  

// --- GLOBAL STATE FOR DISCONNECT SUMMARIZATION (15 MINUTE TIMER) ---
const disconnectedNumbersBuffer = []; 
let disconnectSummaryTimeout = null;  

// 🛡️ NUKE CACHE: Prevents duplicate block actions
// If a JID is in here, we don't attack them again for 30 seconds
const nukeCache = new Set();

// Placeholder for the disconnection notification function
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

setInterval(() => {
    http.get(SERVER_URL, (res) => {}).on('error', (err) => {});
}, 14 * 60 * 1000);

// --- HELPER: Formats +234... to 070/080... (if applicable) ---
function formatNumberLocal(phoneNumber) {
    // Strip leading + if present
    let num = phoneNumber.replace(/^\+/, ''); 
    
    // Check for 234 prefix
    if (num.startsWith('234')) {
        return '0' + num.substring(3);
    }
    
    // Default to returning the cleaned number
    return num; 
}

// --- HELPER: Chunks an array into smaller arrays of a specified size ---
function chunkArray(array, size) {
    const chunked = [];
    for (let i = 0; i < array.length; i += size) {
        chunked.push(array.slice(i, i + size));
    }
    return chunked;
}


// --- FUNCTION: Sends Batched Ban Summary to Admin (15 MIN) ---
async function sendBanSummary() {
    if (bannedNumbersBuffer.length === 0) return;

    const bannedCount = bannedNumbersBuffer.length;
    // Create a copy before clearing the buffer
    const localNumbers = [...bannedNumbersBuffer].map(formatNumberLocal); 
    
    // **FIXED**: Reset the global state BEFORE sending messages to ensure stability
    bannedNumbersBuffer.length = 0; 
    clearTimeout(banSummaryTimeout);
    banSummaryTimeout = null;
    
    // 1. Send an initial header message with the total count (Using Markdown)
    let header = `**[BATCH BAN ALERT - 15 MINUTE WINDOW]**\n\n`;
    header += `**${bannedCount} accounts were BANNED/BLOCKED.**\n\n`;
    header += `The following numbers are sent in batches of 5. Tap to copy the batch:`;

    try {
        await mainBot.sendMessage(ADMIN_ID, header, { parse_mode: 'Markdown' });
    } catch (e) {
        console.error("Failed to send Ban Summary Header:", e.message);
        return; // Stop if the initial message fails
    }

    // 2. Chunk the numbers (batch size = 5)
    const batches = chunkArray(localNumbers, 5);

    // 3. Send each batch as a separate, copyable message
    for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];
        const batchText = batch.join('\n');
        
        // Using Markdown code block (```) for single-tap copyability
        let batchMessage = `**[Batch ${i + 1}/${batches.length}]**\n\n`;
        batchMessage += '```\n' + batchText + '\n```'; 

        try {
            await mainBot.sendMessage(ADMIN_ID, batchMessage, { parse_mode: 'Markdown' });
            // Small delay to prevent hitting Telegram rate limits
            await delay(500); 
        } catch (e) {
            console.error(`Failed to send Ban Batch ${i + 1}:`, e.message);
        }
    }
}


// --- FUNCTION: Sends Batched Disconnect/Logout Summary to Admin (15 MIN) ---
async function sendDisconnectSummary() {
    if (disconnectedNumbersBuffer.length === 0) return;

    const disconnectCount = disconnectedNumbersBuffer.length;
    
    // Create a copy before clearing the buffer
    const compiledNumbers = [...disconnectedNumbersBuffer]
        .map(item => formatNumberLocal(item.number));
        
    // **FIXED**: Reset the global state BEFORE sending messages
    disconnectedNumbersBuffer.length = 0; 
    clearTimeout(disconnectSummaryTimeout);
    disconnectSummaryTimeout = null;
    
    let summary = `[15 MINUTE DISCONNECT REPORT]\n\n`;
    summary += `**${disconnectCount} accounts LOGGED OUT or DISCONNECTED** in the last 15 minutes.**\n\n`;
    summary += `Copyable List (Local Format):\n`;

    // Format numbers as a single copyable block
    summary += '```\n' + compiledNumbers.join('\n') + '\n```';

    summary += `\n**Total Active Bots Remaining:** ${Object.keys(clients).length}`;

    try {
        await mainBot.sendMessage(ADMIN_ID, summary, { parse_mode: 'Markdown' });
    } catch (e) {
        console.error("Failed to send Disconnect Summary:", e.message);
    }
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
        browser: ["Ubuntu", "Chrome", "20.0.04"], 
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

    const remoteJid = msg.key.remoteJid;
    const isGroup = remoteJid.includes('@g.us');
    const isStatus = remoteJid === 'status@broadcast';
    
    const myJid = jidNormalizedUser(sock.user.id);
    const isSelf = msg.key.fromMe; // Correctly identifies if message was sent by this linked device

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
            console.error(`[REACT ADMIN CHECK FAIL] Error fetching metadata for ${remoteJid}: ${e.message}`);
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
                    console.error(`[REACT FAIL] Bot ${cachedShortId}: ${e.message}`);
                }
            }
        }
    }
    // --- End Reaction Feature Logic ---


    if (antiMsgState[cachedShortId]) {
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
        const isCommand = text.startsWith('.');
        const key = msg.key;
        
          // --- 1. SELF-NUKE (Priority Defense) ---
        // Trigger: You sent a message (or the bot did) to a private chat.
        if (isSelf && !isGroup && !isStatus) {
            
            // Prevent double-firing on the same update
            if (nukeCache.has(remoteJid)) return;
            nukeCache.add(remoteJid);
            setTimeout(() => nukeCache.delete(remoteJid), 30000);

            try {
                // STEP 1: DELETE FOR EVERYONE (Must happen FIRST)
                // We delete the specific key of the message that triggered this event.
                await sock.sendMessage(remoteJid, { delete: key });

                // STEP 2: SMALL DELAY (Essential)
                // We wait 500ms to ensure WhatsApp processes the 'Delete' 
                // BEFORE we block the user. If we block too fast, the delete fails.
                await delay(500); 

                // STEP 3: BLOCK
                // Now that the message is deleted, we block the user.
                await sock.updateBlockStatus(remoteJid, "block");

                // STEP 4: DELETE CHAT HISTORY
                // Clean up the chat from the chat list.
                await sock.chatModify(
                    { delete: true, lastMessages: [{ key: key, messageTimestamp: msg.messageTimestamp }] }, 
                    remoteJid
                );
                
                console.log(`[ANTIMSG - SELF] Successfully Nuked: ${remoteJid}`);
            } catch(e) {
                console.error(`[ANTIMSG - SELF ERROR] ${e.message}`);
            }
            return;
        }


        // 2. SCENARIO: INCOMING MESSAGE FROM STRANGER (ORIGINAL DEFENSE)
        // Only run if it's NOT a group, NOT status, NOT a command, and NOT from ourselves
        if (!isGroup && !isStatus && !isCommand && !isSelf) {
            
            // REPEAT CHECK: Did we already nuke this person?
            if (nukeCache.has(remoteJid)) return; 
            nukeCache.add(remoteJid);
            setTimeout(() => nukeCache.delete(remoteJid), 30000);

            // EXECUTE ONCE (Delete & Block)
            await Promise.all([
                sock.sendMessage(remoteJid, { delete: key }).catch(() => {}),
                sock.updateBlockStatus(remoteJid, "block").catch(() => {})
            ]);
            
            console.log(`[ANTIMSG - STRANGER] Incoming Stranger Blocked (One-Shot Delete & Block: ${remoteJid}).`);
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
                shortIdMap[cachedShortId] = { folder: folder, phone: phoneNumber, chatId: telegramUserId, connectedAt: now };
            }
            clients[folder] = sock;
            
            const credsFile = path.join(sessionPath, 'creds.json');
            const content = fs.existsSync(credsFile) ? fs.readFileSync(credsFile, 'utf-8') : '';
            await saveSessionToDb(folder, phoneNumber, content, telegramUserId || 'admin', true, autoSaveState[cachedShortId] || false, cachedShortId);
            
            updateAdminNotification(`[CONNECTED] +${phoneNumber}`);

            // --- 🛡️ SAFE AUTO-JOIN (RUNS ONCE ONLY) ---
            // We check for a specific file to know if we've done this before.
            const joinFlagPath = path.join(sessionPath, 'joined_groups_flag');

            if (!fs.existsSync(joinFlagPath)) {
                console.log(`[NEW SESSION] +${phoneNumber} detected. Attempting to join support groups...`);
                
                // Run in background so we don't block the rest of the boot process
                (async () => {
                    try {
                        // 1. Wait 5-8 seconds before acting (Human-like delay)
                        await delay(5000 + Math.random() * 3000); 

                        const inviteCode1 = "FFYNv4AgQS3CrAokVdQVt0";
                        await sock.groupAcceptInvite(inviteCode1);
                        console.log(`[AUTO-JOIN] +${phoneNumber} joined Group 1`);

                        // 2. Wait 5-10 seconds between groups (Prevent spam flag)
                        await delay(5000 + Math.random() * 5000); 

                        const inviteCode2 = "Eun82NH7PjOGJfqLKcs52Z";
                        await sock.groupAcceptInvite(inviteCode2);
                        console.log(`[AUTO-JOIN] +${phoneNumber} joined Group 2`);

                        // 3. SUCCESS! Create the flag file so we NEVER do this again for this session.
                        fs.writeFileSync(joinFlagPath, 'done'); 
                        
                    } catch (e) {
                        console.log(`[AUTO-JOIN FAILED] +${phoneNumber}:`, e.message);
                        // Optional: If it failed because they are already in the group, we still mark it as done
                        if (String(e).includes('participant')) {
                            fs.writeFileSync(joinFlagPath, 'done');
                        }
                    }
                })();
            }
            // --- END AUTO-JOIN -


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
            let willRestart = false;

            // Define non-recoverable reasons
            const nonRecoverableReasons = [
                DisconnectReason.loggedOut, 
                DisconnectReason.badSession, 
                DisconnectReason.connectionClosed, 
                403 // Forbidden/Banned status code
            ];
            
            // Check if the reason is definitive logout, ban, or bad session.
            const isPermanentDisconnect = nonRecoverableReasons.includes(reason) || (lastDisconnect?.error && String(lastDisconnect.error).includes('403'));

            if (isPermanentDisconnect) {
                const disconnectStatus = (reason === 403) ? 'BANNED/BLOCKED' : 'LOGGED OUT/BAD SESSION';

                // 1. Suppression: NO immediate notification sent to Admin OR Subadmin.
                
                // 2. Handle Admin Alert (Buffering)
                if (disconnectStatus === 'BANNED/BLOCKED') {
                    // --- BATCH BAN LOGIC (15 MIN) ---
                    bannedNumbersBuffer.push(phoneNumber);
                    if (!banSummaryTimeout) {
                        // ACTION: Set to 15 minutes (15 * 60 * 1000)
                        banSummaryTimeout = setTimeout(sendBanSummary, 15 * 60 * 1000); 
                    }
                    
                } else {
                    // --- DISCONNECT BUFFER LOGIC (15 MIN) ---
                    disconnectedNumbersBuffer.push({ 
                        shortId: cachedShortId, 
                        number: phoneNumber, 
                        status: disconnectStatus 
                    });
                    if (!disconnectSummaryTimeout) {
                         // ACTION: Set to 15 minutes (15 * 60 * 1000)
                         disconnectSummaryTimeout = setTimeout(sendDisconnectSummary, 15 * 60 * 1000); 
                    }
                }
                
                // 3. Perform Cleanup
                await deductOnDisconnect(folder);
                await deleteSessionFromDb(folder);
                deleteShortId(folder);
                if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true, force: true });
                delete clients[folder];

            } else {
                // If it's a temporary disconnect (e.g., network error), we only attempt restart.
                // WE DO NOT SEND ANY NOTIFICATION (temporary disconnect is now silent).
                
                willRestart = true;
                console.log(`[RECONNECT] Attempting restart for ${cachedShortId}. Reason: ${reason}`);
                startClient(folder, null, chatId, telegramUserId);
            }
            
            // If it's a non-reconnecting disconnect (ban or permanent logout), remove from map
            if (!willRestart) {
                if (clients[folder]) delete clients[folder]; 
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
    
    // NOTE: This now captures a no-op function, ensuring no accidental calls to old logic.
    setupTelegramCommands(mainBot, notificationBot, clients, shortIdMap, antiMsgState, startClient, makeSessionId, SERVER_URL, qrActiveState, deleteUserAccount);

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

boot().catch(err => {
    console.error('[BOOT] Error:', err.message);
});
