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
import express from 'express'; // REQUIRED FOR RENDER
import { Boom } from '@hapi/boom';

// --- 1. RENDER KEEPALIVE SERVER (CRITICAL FIX) ---
// This tricks Render into thinking this is a website so it stays online.
const app = express();
const PORT = process.env.PORT || 10000;

app.get('/', (req, res) => {
    res.send('Bot is running active!');
});

app.listen(PORT, () => {
    console.log(`✅ Render Health Check: Listening on port ${PORT}`);
});

// --- 2. CONFIGURATION ---
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const SESSIONS_DIR = process.env.SESSIONS_DIR || './sessions';
const NUMBERS_FILE = './numbers.json';

if (!TELEGRAM_TOKEN) {
    console.error('❌ TELEGRAM_TOKEN is missing.');
    process.exit(1);
}

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// --- 3. GLOBALS & ERROR HANDLING (FROM STUDY CASE) ---
const clients = {}; 
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
console.log('✅ Telegram bot started...');

// Prevent crash on network errors
const ignoredErrors = [
    'Socket connection timeout',
    'EKEYTYPE',
    'item-not-found',
    'rate-overlimit',
    'Connection Closed',
    'Timed Out',
    'Value not found'
];

process.on('uncaughtException', (err) => {
    if (ignoredErrors.some(e => String(err).includes(e))) return;
    console.error('Unhandled Exception:', err);
});

// --- 4. HELPER: RANDOM BROWSER (FROM STUDY CASE) ---
// This prevents WhatsApp from detecting a "bot"
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

// --- 5. CORE: WHATSAPP LOGIC ---
async function startClient(folder, chatId = null) {
    const sessionPath = path.join(SESSIONS_DIR, folder);
    
    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: "silent" }), // Silent logs as per study case
            browser: getRandomBrowser(), 
            version,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 0,
            keepAliveIntervalMs: 10000,
            emitOwnEvents: true,
            retryRequestDelayMs: 250,
            markOnlineOnConnect: true
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, pairingCode } = update;

            // CAPTURE PAIRING CODE
            if (pairingCode && chatId) {
                console.log(`Code generated for ${folder}: ${pairingCode}`);
                bot.sendMessage(chatId, 
                    `*${folder}* Pairing Code:\n\`${pairingCode}\`\n\n_Tap code to copy_`,
                    { parse_mode: 'Markdown' }
                );
            }

            if (connection === 'open') {
                console.log(`✅ Client ${folder} connected!`);
                clients[folder] = sock;
                if (chatId) {
                    bot.sendMessage(chatId, `✅ *${folder}* is now Connected!`, { parse_mode: 'Markdown' });
                    chatId = null; // Stop sending updates
                }
            }

            if (connection === 'close') {
                let reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
                
                if (reason === DisconnectReason.loggedOut) {
                    console.log(`❌ Client ${folder} Logged Out.`);
                    if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true, force: true });
                    delete clients[folder];
                    if (chatId) bot.sendMessage(chatId, `❌ ${folder} session expired/logged out.`);
                } else {
                    // Reconnect logic
                    startClient(folder, chatId);
                }
            }
        });

        // REQUEST CODE LOGIC
        if (chatId && !sock.authState.creds.registered) {
            setTimeout(async () => {
                try {
                    const code = await sock.requestPairingCode(folder);
                    // We rely on connection.update to catch the code, but logging here just in case
                    console.log(`Request sent for ${folder}. Code: ${code}`);
                } catch (e) {
                    console.error('Pairing Error:', e.message);
                    bot.sendMessage(chatId, '❌ Error generating code. Wait a few seconds and try again.');
                }
            }, 3000); // 3s delay to let socket stabilize
        }

    } catch (error) {
        console.error(`Client Error ${folder}:`, error);
    }
}

// --- 6. LOAD SAVED SESSIONS ---
async function loadAllClients() {
    if (!fs.existsSync(SESSIONS_DIR)) return;
    const folders = fs.readdirSync(SESSIONS_DIR).filter(f => fs.statSync(path.join(SESSIONS_DIR, f)).isDirectory());
    console.log(`Reloading ${folders.length} sessions...`);
    for (const folder of folders) {
        startClient(folder);
    }
}
loadAllClients();

// --- 7. TELEGRAM HANDLERS ---
bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, '🤖 Bot is Online on Render!');
});

bot.onText(/\/pair (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const number = match[1].replace(/[^0-9]/g, '');

    if (!number) return bot.sendMessage(chatId, 'Format: /pair 2349012345678');
    
    if (clients[number]) return bot.sendMessage(chatId, 'Already connected.');

    // Reset Session
    const sessionPath = path.join(SESSIONS_DIR, number);
    if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true, force: true });
    fs.mkdirSync(sessionPath, { recursive: true });

    bot.sendMessage(chatId, `⚙️ Initializing ${number}...`);
    startClient(number, chatId);
});

bot.onText(/\/generate (.+)/, (msg, match) => {
    const args = msg.text.split(' ');
    const code = args[1];
    const amount = parseInt(args[2], 10) || 100;

    if (!code) return bot.sendMessage(msg.chat.id, 'Usage: /generate 234 50');
    
    const numbers = [];
    for (let i = 0; i < amount; i++) {
        const rand = Math.floor(100000000 + Math.random() * 900000000);
        numbers.push(`${code}${rand}`);
    }
    fs.writeFileSync(NUMBERS_FILE, JSON.stringify(numbers, null, 2));
    bot.sendMessage(msg.chat.id, `Generated ${amount} numbers.`);
});

bot.onText(/\/send/, async (msg) => {
    const chatId = msg.chat.id;
    if (!msg.reply_to_message?.text) return bot.sendMessage(chatId, 'Reply to a message with /send');

    const messageText = msg.reply_to_message.text;
    if (!fs.existsSync(NUMBERS_FILE)) return bot.sendMessage(chatId, 'Generate numbers first.');
    
    const numbers = JSON.parse(fs.readFileSync(NUMBERS_FILE));
    const activeClients = Object.values(clients);

    if (activeClients.length === 0) return bot.sendMessage(chatId, 'No WhatsApp accounts connected.');

    bot.sendMessage(chatId, `Sending to ${numbers.length} numbers...`);

    let sent = 0, failed = 0, clientIndex = 0;
    
    // Async sending loop
    (async () => {
        for (const num of numbers) {
            const sock = activeClients[clientIndex];
            clientIndex = (clientIndex + 1) % activeClients.length;

            try {
                const jid = `${num}@s.whatsapp.net`;
                const [result] = await sock.onWhatsApp(jid);

                if (result?.exists) {
                    await sock.sendMessage(jid, { text: messageText });
                    sent++;
                    await delay(Math.random() * 2000 + 2000); 
                } else {
                    failed++;
                }
            } catch (e) {
                failed++;
            }
        }
        bot.sendMessage(chatId, `Done.\nSent: ${sent}\nFailed: ${failed}`);
    })();
});
