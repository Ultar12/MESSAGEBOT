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
import { Boom } from '@hapi/boom';

// --- CONFIGURATION ---
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const SESSIONS_DIR = process.env.SESSIONS_DIR || './sessions';
const NUMBERS_FILE = './numbers.json';

// Check for token
if (!TELEGRAM_TOKEN) {
    console.error('[FATAL ERROR] TELEGRAM_TOKEN is not set in your environment variables.');
    process.exit(1);
}

// Create sessions directory
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// --- GLOBALS ---
const clients = {}; 
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
console.log('✅ Telegram bot started...');

// --- GLOBAL ERROR HANDLING (From Script B) ---
// This prevents the bot from crashing on random socket errors
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
    const msg = String(err);
    if (ignoredErrors.some(e => msg.includes(e))) return;
    console.error('Unhandled Exception:', err);
});

process.on('unhandledRejection', (reason) => {
    const msg = String(reason);
    if (ignoredErrors.some(e => msg.includes(e))) return;
    console.error('Unhandled Rejection:', reason);
});

// --- HELPER: GET RANDOM BROWSER ---
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

// --- CORE: START WHATSAPP CLIENT ---
async function startClient(folder, chatId = null) {
    const sessionPath = path.join(SESSIONS_DIR, folder);
    
    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: "silent" }), // Silence internal logs
            browser: getRandomBrowser(), // Spoof browser to avoid bans
            version,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 0,
            keepAliveIntervalMs: 10000,
            emitOwnEvents: true,
            retryRequestDelayMs: 250
        });

        // Save credentials whenever they update
        sock.ev.on('creds.update', saveCreds);

        // Connection Logic
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, pairingCode } = update;

            // 1. Send Pairing Code if requested
            if (pairingCode && chatId) {
                bot.sendMessage(chatId, 
                    `WhatsApp Pairing Code for *${folder}*:\n\n` +
                    `*${pairingCode}*\n\n` +
                    `Open WhatsApp > Linked Devices > Link a Device > Enter this code.`,
                    { parse_mode: 'Markdown' }
                );
            }

            // 2. Handle Connection Open
            if (connection === 'open') {
                console.log(`✅ Client ${folder} connected successfully.`);
                clients[folder] = sock;
                if (chatId) {
                    bot.sendMessage(chatId, `✅ WhatsApp account *${folder}* paired successfully!`, { parse_mode: 'Markdown' });
                    // Clear chatId so we don't spam on re-connects
                    chatId = null; 
                }
            }

            // 3. Handle Disconnects (The Logic from Script B)
            if (connection === 'close') {
                let reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
                
                if (reason === DisconnectReason.loggedOut) {
                    console.log(`❌ Client ${folder} Logged Out. Deleting session.`);
                    if (fs.existsSync(sessionPath)) {
                        fs.rmSync(sessionPath, { recursive: true, force: true });
                    }
                    delete clients[folder];
                    if (chatId) bot.sendMessage(chatId, `❌ Account ${folder} was logged out.`);
                } else {
                    // RECONNECTION LOGIC
                    console.log(`⚠️ Client ${folder} disconnected (Reason: ${reason}). Reconnecting...`);
                    startClient(folder, chatId); // Recursively call startClient to reconnect
                }
            }
        });

        // If this is a fresh pairing, request the code
        if (chatId && !sock.authState.creds.registered) {
            try {
                await delay(2000); // Wait a bit before requesting
                const code = await sock.requestPairingCode(folder);
                console.log(`Pairing code for ${folder}: ${code}`);
            } catch (e) {
                console.error('Failed to request pairing code:', e);
                bot.sendMessage(chatId, 'Error requesting pairing code. Please wait and try again.');
            }
        }

    } catch (error) {
        console.error(`Failed to start client ${folder}:`, error);
    }
}

// --- LOAD EXISTING SESSIONS ---
async function loadAllClients() {
    console.log('Loading all existing sessions...');
    if (!fs.existsSync(SESSIONS_DIR)) return;

    const folders = fs.readdirSync(SESSIONS_DIR)
                      .filter(f => fs.statSync(path.join(SESSIONS_DIR, f)).isDirectory());
    
    console.log(`Found ${folders.length} sessions.`);
    for (const folder of folders) {
        startClient(folder); // Start without chatId (background reconnection)
    }
}
loadAllClients();

// --- TELEGRAM COMMANDS ---

bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id,
        '🤖 *Bot Active*\n\n' +
        '1. `/pair <number>` - Link new WhatsApp.\n' +
        '2. `/generate <code 234> <amount>` - Generate numbers.\n' +
        '3. Reply `/send` - Broadcast message.',
        { parse_mode: 'Markdown' }
    );
});

bot.onText(/\/pair (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const number = match[1].replace(/[^0-9]/g, '');

    if (!number) return bot.sendMessage(chatId, 'Invalid format. Use /pair 234900000000');

    if (clients[number]) {
        return bot.sendMessage(chatId, `Client ${number} is already active.`);
    }

    // Clear old session if exists to ensure fresh pair
    const sessionPath = path.join(SESSIONS_DIR, number);
    if (fs.existsSync(sessionPath)) {
        fs.rmSync(sessionPath, { recursive: true, force: true });
    }
    fs.mkdirSync(sessionPath, { recursive: true });

    bot.sendMessage(chatId, `Initializing ${number}... Please wait.`);
    startClient(number, chatId);
});

bot.onText(/\/generate (.+)/, (msg, match) => {
    const args = msg.text.split(' ');
    const code = args[1];
    const amount = parseInt(args[2], 10) || 100;

    if (!code || !/^\d+$/.test(code)) return bot.sendMessage(msg.chat.id, 'Usage: /generate 234 50');
    
    const numbers = [];
    for (let i = 0; i < amount; i++) {
        const rand = Math.floor(100000000 + Math.random() * 900000000);
        numbers.push(`${code}${rand}`);
    }
    fs.writeFileSync(NUMBERS_FILE, JSON.stringify(numbers, null, 2));
    bot.sendMessage(msg.chat.id, `✅ Generated ${amount} numbers to ${NUMBERS_FILE}`);
});

bot.onText(/\/send/, async (msg) => {
    const chatId = msg.chat.id;
    if (!msg.reply_to_message?.text) return bot.sendMessage(chatId, '⚠️ Reply to a text message with /send');

    const messageText = msg.reply_to_message.text;
    
    if (!fs.existsSync(NUMBERS_FILE)) return bot.sendMessage(chatId, '⚠️ No numbers file found. Use /generate first.');
    
    const numbers = JSON.parse(fs.readFileSync(NUMBERS_FILE));
    const activeClients = Object.values(clients);

    if (activeClients.length === 0) return bot.sendMessage(chatId, '⚠️ No active WhatsApp clients.');

    bot.sendMessage(chatId, `🚀 Sending to ${numbers.length} numbers using ${activeClients.length} accounts...`);

    let sent = 0, failed = 0, clientIndex = 0;

    // Non-blocking loop (Bot won't freeze)
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
                    // Random delay to prevent spam flag
                    await delay(Math.random() * 2000 + 1500); 
                } else {
                    failed++;
                }
            } catch (e) {
                console.error(`Send Error: ${e.message}`);
                failed++;
            }
        }
        bot.sendMessage(chatId, `✅ Task Complete.\nSent: ${sent}\nFailed/Invalid: ${failed}`);
    })();
});
