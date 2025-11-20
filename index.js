import 'dotenv/config';
import { 
    useMultiFileAuthState, 
    makeWASocket, 
    DisconnectReason, 
    fetchLatestBaileysVersion, 
    Browsers,
    delay,
    jidNormalizedUser
} from '@whiskeysockets/baileys';
import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs';
import path from 'path';
import pino from 'pino';
import express from 'express';
import { Boom } from '@hapi/boom';

// --- SERVER (Required for Heroku/Render) ---
const app = express();
const PORT = process.env.PORT || 10000;

app.get('/', (req, res) => {
    res.send('Ultarbot Active');
});

app.listen(PORT, () => {
    console.log(`[SYSTEM] Server listening on port ${PORT}`);
});

// --- CONFIGURATION ---
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const SESSIONS_DIR = process.env.SESSIONS_DIR || './sessions';
const NUMBERS_FILE = './numbers.json';

if (!TELEGRAM_TOKEN) {
    console.error('[FATAL] TELEGRAM_TOKEN is missing');
    process.exit(1);
}

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// --- GLOBALS ---
const clients = {}; 
const sessionMap = {}; 
const antiMsgState = {}; // Stores AntiMsg state (PhoneNumber -> Boolean)
const telegramMap = {}; // Maps SessionFolder -> TelegramChatID

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
console.log('[SYSTEM] Bot Started. Waiting for commands...');

// --- ERROR HANDLING ---
bot.on('polling_error', (error) => {
    if (error.code === 'ETELEGRAM' && error.message.includes('409 Conflict')) return;
    console.log(`[TELEGRAM ERROR] ${error.code || error.message}`);
});

// --- HELPER: GENERATE SESSION ID WITH DATE ---
function makeSessionId() {
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0]; 
    let randomStr = '';
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 8; i++) {
        randomStr += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return `Ultarbot_${dateStr}_${randomStr}`;
}

// --- HELPER: RANDOM BROWSER ---
const getRandomBrowser = () => {
    const browserOptions = [
        Browsers.macOS('Safari'),
        Browsers.macOS('Chrome'),
        Browsers.windows('Firefox'),
        Browsers.ubuntu('Chrome'),
        Browsers.windows('Edge'),
    ];
    return browserOptions[Math.floor(Math.random() * browserOptions.length)];
};

// --- CORE: WHATSAPP CLIENT ---
async function startClient(folder, targetNumber = null, chatId = null) {
    const sessionPath = path.join(SESSIONS_DIR, folder);
    
    // Save ChatID for notifications
    if(chatId) telegramMap[folder] = chatId;

    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: "silent" }),
            browser: getRandomBrowser(), 
            version,
            connectTimeoutMs: 60000,
            retryRequestDelayMs: 250,
            markOnlineOnConnect: true,
            emitOwnEvents: true 
        });

        sock.ev.on('creds.update', saveCreds);

        // --- MESSAGE LISTENER ---
        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;
            
            for (const msg of messages) {
                if (!msg.message) continue;

                const text = msg.message.conversation || 
                             msg.message.extendedTextMessage?.text || 
                             msg.message.imageMessage?.caption || "";
                
                const remoteJid = msg.key.remoteJid;
                const isFromMe = msg.key.fromMe;
                const userPhone = jidNormalizedUser(sock.user?.id || "").split('@')[0];

                // 1. ALIVE COMMAND
                if (text.toLowerCase() === '.alive') {
                    await sock.sendMessage(remoteJid, { 
                        text: 'Ultarbot is Online 🟢\nMode: Active' 
                    }, { quoted: msg });
                }

                // 2. ANTIMSG TOGGLE
                if (isFromMe && text.toLowerCase().startsWith('.antimsg')) {
                    const cmd = text.split(' ')[1];
                    if (cmd === 'on') {
                        antiMsgState[userPhone] = true;
                        await sock.sendMessage(remoteJid, { text: '✅ AntiMsg ON. I will delete your outgoing messages.' }, { quoted: msg });
                    } else if (cmd === 'off') {
                        antiMsgState[userPhone] = false;
                        await sock.sendMessage(remoteJid, { text: '❌ AntiMsg OFF.' }, { quoted: msg });
                    } else {
                        await sock.sendMessage(remoteJid, { text: 'Usage: .antimsg on | .antimsg off' }, { quoted: msg });
                    }
                }

                // 3. ANTIMSG LOGIC (DELETE IMMEDIATELY)
                if (isFromMe && antiMsgState[userPhone]) {
                    // Ignore commands so you can turn it off
                    if (text.startsWith('.')) return; 

                    // DELETE ACTION
                    try {
                        await sock.sendMessage(remoteJid, { delete: msg.key });
                    } catch (e) {
                        console.error('Delete failed', e);
                    }

                    const target = remoteJid.split('@')[0];
                    const tgChatId = telegramMap[folder];
                    
                    if (tgChatId) {
                        bot.sendMessage(tgChatId, 
                            `⚠️ *AntiMsg Action* ⚠️\n\n` +
                            `You sent a message to: +${target}\n` +
                            `Content: "${text}"\n` +
                            `Status: 🗑️ Deleted Automatically`,
                            { parse_mode: 'Markdown' }
                        );
                    }
                }
            }
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === 'open') {
                const userJid = jidNormalizedUser(sock.user.id);
                const phoneNumber = userJid.split('@')[0];
                
                console.log(`[SUCCESS] Connected: +${phoneNumber} (ID: ${folder})`);
                clients[phoneNumber] = sock;
                sessionMap[folder] = phoneNumber;
                if (chatId) telegramMap[folder] = chatId;

                if(chatId) {
                    bot.sendMessage(chatId, `[SUCCESS] Connected: +${phoneNumber}\nSession ID: ${folder}`);
                }

                try {
                    await sock.sendMessage(userJid, { 
                        text: `Ultarbot Connected\n\n` +
                              `Number: +${phoneNumber}\n` +
                              `Session ID:\n` +
                              `${folder}` 
                    });
                } catch (e) {
                    console.error(`[ERROR] Failed to send self-message: ${e.message}`);
                }
            }

            if (connection === 'close') {
                let reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
                
                if (reason === DisconnectReason.loggedOut) {
                    const num = sessionMap[folder] || "Unknown";
                    console.log(`[LOGOUT] Client ${num} Logged Out`);
                    if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true, force: true });
                    if (num) delete clients[num];
                } else {
                    const savedChatId = telegramMap[folder];
                    startClient(folder, null, savedChatId);
                }
            }
        });

        if (targetNumber && !sock.authState.creds.registered) {
            setTimeout(async () => {
                if (!sock.authState.creds.registered) {
                    try {
                        console.log(`[PAIRING] Requesting code for +${targetNumber}...`);
                        const code = await sock.requestPairingCode(targetNumber);
                        
                        console.log(`\n--------------------------------------------------`);
                        console.log(`PAIRING CODE FOR +${targetNumber}:`);
                        console.log(`>>>  ${code}  <<<`);
                        console.log(`--------------------------------------------------\n`);

                        if (chatId) {
                            await bot.sendMessage(chatId, 
                                `Pairing Code for +${targetNumber}:\n\n` +
                                `\`${code}\`\n\n` +
                                `Tap code to copy.`,
                                { parse_mode: 'Markdown' }
                            );
                        }
                    } catch (e) {
                        console.error('[PAIRING ERROR]', e.message);
                        if (chatId) bot.sendMessage(chatId, `[ERROR] Failed to get code: ${e.message}`);
                        if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true, force: true });
                    }
                }
            }, 3000);
        }
    } catch (error) {
        console.error(`[CLIENT ERROR] ${folder}:`, error);
    }
}

// --- LOAD SESSIONS ---
async function loadAllClients() {
    if (!fs.existsSync(SESSIONS_DIR)) return;
    const folders = fs.readdirSync(SESSIONS_DIR).filter(f => fs.statSync(path.join(SESSIONS_DIR, f)).isDirectory());
    console.log(`[SYSTEM] Reloading ${folders.length} sessions...`);
    for (const folder of folders) {
        startClient(folder);
    }
}
loadAllClients();

// --- TELEGRAM COMMANDS ---

bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, 
        'Ultarbot Online.\n\n' +
        '/pair <number> - Connect New Account\n' +
        '/list - Show Connected Numbers\n' +
        '/generate <code 234> <amount> - Gen Numbers\n' +
        '/send <number> <text> - Direct Message\n' +
        '/send (Reply) - Broadcast'
    );
});

bot.onText(/\/pair (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const number = match[1].replace(/[^0-9]/g, '');
    if (!number) return bot.sendMessage(chatId, 'Usage: /pair 2349012345678');
    
    if (clients[number]) return bot.sendMessage(chatId, `+${number} is already connected.`);

    const sessionId = makeSessionId();
    const sessionPath = path.join(SESSIONS_DIR, sessionId);
    
    fs.mkdirSync(sessionPath, { recursive: true });

    bot.sendMessage(chatId, `Initializing +${number}...\nSession ID: ${sessionId}`);
    
    startClient(sessionId, number, chatId);
});

bot.onText(/\/list/, (msg) => {
    const active = Object.keys(clients);
    if (active.length === 0) return bot.sendMessage(msg.chat.id, "No WhatsApp numbers connected.");
    
    let listText = "Connected Clients:\n";
    active.forEach((num, i) => {
        listText += `${i + 1}. +${num}\n`;
    });
    bot.sendMessage(msg.chat.id, listText);
});

bot.onText(/\/generate (.+)/, (msg, match) => {
    const args = msg.text.split(' ');
    const code = args[1];
    const amount = parseInt(args[2], 10) || 100;
    if (!code) return bot.sendMessage(msg.chat.id, 'Usage: /generate 234 50');
    
    const numbers = [];
    for (let i = 0; i < amount; i++) {
        numbers.push(`${code}${Math.floor(100000000 + Math.random() * 900000000)}`);
    }
    fs.writeFileSync(NUMBERS_FILE, JSON.stringify(numbers, null, 2));
    bot.sendMessage(msg.chat.id, `Generated ${amount} numbers.`);
});

bot.onText(/\/send/, async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    const activeClients = Object.values(clients);
    
    if (activeClients.length === 0) return bot.sendMessage(chatId, 'No WhatsApp connected. Use /pair first.');

    // CASE 1: DIRECT MESSAGE
    const directMatch = text.match(/\/send\s+(\d+)\s+(.+)/);
    if (directMatch) {
        const targetNumber = directMatch[1];
        const messageContent = directMatch[2];
        const sock = activeClients[0]; 
        const jid = `${targetNumber}@s.whatsapp.net`;
        
        bot.sendMessage(chatId, `Sending DM to ${targetNumber}...`);
        try {
            await sock.sendMessage(jid, { text: messageContent });
            bot.sendMessage(chatId, `[SUCCESS] Sent to ${targetNumber}`);
        } catch (e) {
            bot.sendMessage(chatId, `[FAILED] ${e.message}`);
        }
        return;
    }

    // CASE 2: BROADCAST
    if (msg.reply_to_message && msg.reply_to_message.text) {
        if (!fs.existsSync(NUMBERS_FILE)) return bot.sendMessage(chatId, 'Use /generate first.');
        
        const numbers = JSON.parse(fs.readFileSync(NUMBERS_FILE));
        bot.sendMessage(chatId, `Broadcasting to ${numbers.length} numbers...`);

        let sent = 0, failed = 0, clientIndex = 0;

        (async () => {
            for (const num of numbers) {
                const sock = activeClients[clientIndex];
                clientIndex = (clientIndex + 1) % activeClients.length;

                try {
                    const jid = `${num}@s.whatsapp.net`;
                    const [result] = await sock.onWhatsApp(jid);

                    if (result?.exists) {
                        await sock.sendMessage(jid, { text: msg.reply_to_message.text });
                        sent++;
                        await delay(Math.random() * 2000 + 2000); 
                    } else {
                        failed++;
                    }
                } catch (e) {
                    failed++;
                }
            }
            bot.sendMessage(chatId, `Broadcast Complete.\nSent: ${sent}\nFailed: ${failed}`);
        })();
        return;
    }

    bot.sendMessage(chatId, 'Usage:\nDirect: /send <number> <msg>\nBroadcast: Reply to msg with /send');
});
