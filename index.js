import { 
    useMultiFileAuthState, 
    makeWASocket, 
    DisconnectReason, 
    fetchLatestBaileysVersion, 
    Browsers,
    delay
} from '@whiskeysockets/baileys';
import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs';
import path from 'path';
import pino from 'pino';
import express from 'express';
import { Boom } from '@hapi/boom';

// ==============================================================================
// 1. RENDER SERVER (MUST BE AT TOP TO PREVENT TIMEOUTS)
// ==============================================================================
const app = express();
const PORT = process.env.PORT || 10000;

app.get('/', (req, res) => {
    res.send('Telegram-WhatsApp Bridge is Running.');
});

app.listen(PORT, () => {
    console.log(`✅ Server started on port ${PORT} (Render Health Check Passed)`);
});

// ==============================================================================
// 2. CONFIGURATION & GLOBALS
// ==============================================================================
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const SESSIONS_DIR = process.env.SESSIONS_DIR || './sessions';
const NUMBERS_FILE = './numbers.json';

if (!TELEGRAM_TOKEN) {
    console.error('❌ FATAL: TELEGRAM_TOKEN is missing.');
    process.exit(1);
}

// Ensure sessions directory exists
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

const clients = {}; 
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// ==============================================================================
// 3. ERROR HANDLING (PREVENTS CRASHES)
// ==============================================================================
const ignoredErrors = [
    'Socket connection timeout',
    'EKEYTYPE',
    'item-not-found',
    'rate-overlimit',
    'Connection Closed',
    'Timed Out',
    'Value not found',
    'ENOENT' // Ignore missing file errors
];

process.on('uncaughtException', (err) => {
    const msg = String(err);
    if (ignoredErrors.some(e => msg.includes(e))) return;
    console.error('⚠️ Uncaught Exception:', err.message);
});

process.on('unhandledRejection', (reason) => {
    const msg = String(reason);
    if (ignoredErrors.some(e => msg.includes(e))) return;
    console.error('⚠️ Unhandled Rejection:', reason);
});

// ==============================================================================
// 4. CORE FUNCTIONS (ADAPTED FROM STUDY CASE)
// ==============================================================================

// Helper: Clean deletion that won't crash
function safeDeleteSession(folder) {
    try {
        const sessionPath = path.join(SESSIONS_DIR, folder);
        if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
            console.log(`🗑️ Session ${folder} deleted.`);
        }
    } catch (e) {
        console.log(`Note: Could not delete session ${folder} (already gone).`);
    }
}

// Helper: Random Browser (Exact logic from Study Case)
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

async function startClient(folder, chatId = null) {
    const sessionPath = path.join(SESSIONS_DIR, folder);
    
    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: "silent" }), // Silent logs like Study Case
            browser: getRandomBrowser(), 
            version,
            connectTimeoutMs: 60000, // Increased timeout
            retryRequestDelayMs: 250,
            markOnlineOnConnect: true
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, pairingCode } = update;

            // 1. Handling Pairing Code (Send to Telegram)
            if (pairingCode && chatId) {
                console.log(`Code for ${folder}: ${pairingCode}`);
                bot.sendMessage(chatId, 
                    `🔐 *Pairing Code for ${folder}:*\n\n` +
                    `\`${pairingCode}\``,
                    { parse_mode: 'Markdown' }
                );
                // Clear chatId so we don't resend on reconnection
                chatId = null;
            }

            // 2. Handling Connection Open
            if (connection === 'open') {
                console.log(`✅ ${folder} Connected Successfully!`);
                clients[folder] = sock;
            }

            // 3. Handling Disconnects (Logic from Study Case)
            if (connection === 'close') {
                let reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
                
                if (reason === DisconnectReason.loggedOut) {
                    console.log(`❌ ${folder} Logged Out.`);
                    safeDeleteSession(folder);
                    delete clients[folder];
                } else {
                    console.log(`🔄 ${folder} disconnected (Reason: ${reason}). Reconnecting...`);
                    startClient(folder, null); // Auto-reconnect
                }
            }
        });

        // 4. Request Pairing Code (Only if strictly needed)
        // We wait 4 seconds to ensure socket is ready (Fixes "Stuck Initializing")
        if (chatId && !sock.authState.creds.registered) {
            setTimeout(async () => {
                if (!sock.authState.creds.registered) {
                    try {
                        const code = await sock.requestPairingCode(folder);
                        console.log(`Requested code for ${folder}: ${code}`);
                    } catch (e) {
                        bot.sendMessage(chatId, `⚠️ Failed to get code: ${e.message}. Try /pair again.`);
                    }
                }
            }, 4000);
        }

    } catch (error) {
        console.error(`Start Error ${folder}:`, error);
    }
}

// ==============================================================================
// 5. STARTUP LOGIC
// ==============================================================================
async function loadAllClients() {
    const folders = fs.readdirSync(SESSIONS_DIR).filter(f => fs.statSync(path.join(SESSIONS_DIR, f)).isDirectory());
    console.log(`🔄 Reloading ${folders.length} sessions...`);
    for (const folder of folders) {
        startClient(folder);
    }
}
loadAllClients();

// ==============================================================================
// 6. TELEGRAM COMMANDS
// ==============================================================================

bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, '🤖 Bot is Online.\nUse /pair <number> to connect.');
});

bot.onText(/\/pair (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const number = match[1].replace(/[^0-9]/g, '');

    if (!number) return bot.sendMessage(chatId, 'Invalid number.');
    
    if (clients[number]) return bot.sendMessage(chatId, 'Already connected.');

    // Clean reset
    safeDeleteSession(number);
    fs.mkdirSync(path.join(SESSIONS_DIR, number), { recursive: true });

    bot.sendMessage(chatId, `⏳ Initializing ${number}... Wait for code.`);
    startClient(number, chatId);
});

bot.onText(/\/send/, async (msg) => {
    const chatId = msg.chat.id;
    if (!msg.reply_to_message?.text) return bot.sendMessage(chatId, 'Reply to text with /send');
    
    if (!fs.existsSync(NUMBERS_FILE)) return bot.sendMessage(chatId, 'No numbers generated.');
    const numbers = JSON.parse(fs.readFileSync(NUMBERS_FILE));
    
    const activeClients = Object.values(clients);
    if (activeClients.length === 0) return bot.sendMessage(chatId, 'No WhatsApp connected.');

    bot.sendMessage(chatId, `🚀 Sending to ${numbers.length} numbers...`);
    
    let sent = 0;
    let clientIndex = 0;

    // Non-blocking send loop
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
                }
            } catch (e) {}
        }
        bot.sendMessage(chatId, `✅ Finished. Sent: ${sent}`);
    })();
});

bot.onText(/\/generate (.+)/, (msg, match) => {
    const args = msg.text.split(' ');
    const code = args[1];
    const amount = parseInt(args[2], 10) || 100;
    if(!code) return;

    const numbers = [];
    for (let i = 0; i < amount; i++) {
        numbers.push(`${code}${Math.floor(100000000 + Math.random() * 900000000)}`);
    }
    fs.writeFileSync(NUMBERS_FILE, JSON.stringify(numbers, null, 2));
    bot.sendMessage(msg.chat.id, `Generated ${amount} numbers.`);
});
