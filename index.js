import 'dotenv/config';
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
import express from 'express'; // Required for Heroku/Render
import { Boom } from '@hapi/boom';

// --- SERVER FOR HEROKU/RENDER ---
const app = express();
const PORT = process.env.PORT || 10000;

app.get('/', (req, res) => {
    res.send('Bot is Running');
});

app.listen(PORT, () => {
    console.log(`[SYSTEM] Server listening on port ${PORT}`);
});

// --- CONFIGURATION ---
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const SESSIONS_DIR = process.env.SESSIONS_DIR || './sessions';
const NUMBERS_FILE = './numbers.json';

if (!TELEGRAM_TOKEN) {
    console.error('[FATAL] TELEGRAM_TOKEN is missing in environment variables');
    process.exit(1);
}

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// --- GLOBALS ---
const clients = {}; 
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
console.log('[SYSTEM] Bot Started. Waiting for commands...');

// --- ERROR HANDLING ---
bot.on('polling_error', (error) => {
    if (error.code === 'ETELEGRAM' && error.message.includes('409 Conflict')) {
        return; 
    }
    console.log(`[TELEGRAM ERROR] ${error.code || error.message}`);
});

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
async function startClient(folder, chatId = null) {
    const sessionPath = path.join(SESSIONS_DIR, folder);
    
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
            markOnlineOnConnect: true
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === 'open') {
                console.log(`[SUCCESS] Client ${folder} Connected`);
                clients[folder] = sock;
                if(chatId) bot.sendMessage(chatId, `[SUCCESS] Client ${folder} is now connected.`);
            }

            if (connection === 'close') {
                let reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
                
                if (reason === DisconnectReason.loggedOut) {
                    console.log(`[LOGOUT] Client ${folder} Logged Out`);
                    if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true, force: true });
                    delete clients[folder];
                } else {
                    startClient(folder, null);
                }
            }
        });

        // --- PAIRING LOGIC ---
        if (chatId && !sock.authState.creds.registered) {
            setTimeout(async () => {
                if (!sock.authState.creds.registered) {
                    try {
                        console.log(`[PAIRING] Requesting code for ${folder}...`);
                        
                        const code = await sock.requestPairingCode(folder);
                        
                        // Print to Console
                        console.log(`\n--------------------------------------------------`);
                        console.log(`PAIRING CODE FOR ${folder}:`);
                        console.log(`>>>  ${code}  <<<`);
                        console.log(`--------------------------------------------------\n`);

                        // Send to Telegram (Copyable format)
                        await bot.sendMessage(chatId, 
                            `Pairing Code for ${folder}:\n\n` +
                            `\`${code}\`\n\n` +
                            `Tap code to copy.`,
                            { parse_mode: 'Markdown' }
                        );
                    } catch (e) {
                        console.error('[PAIRING ERROR]', e.message);
                        bot.sendMessage(chatId, `[ERROR] Could not generate code: ${e.message}`);
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
    console.log(`[SYSTEM] Reloaded ${folders.length} sessions.`);
    for (const folder of folders) {
        startClient(folder);
    }
}
loadAllClients();

// --- TELEGRAM COMMANDS ---
bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, 'Bot Online. Use /pair <number>');
});

bot.onText(/\/pair (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const number = match[1].replace(/[^0-9]/g, '');

    if (!number) return bot.sendMessage(chatId, 'Usage: /pair 2349012345678');
    if (clients[number]) return bot.sendMessage(chatId, 'Already connected.');

    const sessionPath = path.join(SESSIONS_DIR, number);
    if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true, force: true });
    fs.mkdirSync(sessionPath, { recursive: true });

    bot.sendMessage(chatId, `Initializing ${number}...`);
    startClient(number, chatId);
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
    if (!msg.reply_to_message?.text) return bot.sendMessage(chatId, 'Reply to a message with /send');

    if (!fs.existsSync(NUMBERS_FILE)) return bot.sendMessage(chatId, 'Use /generate first.');
    
    const numbers = JSON.parse(fs.readFileSync(NUMBERS_FILE));
    const activeClients = Object.values(clients);

    if (activeClients.length === 0) return bot.sendMessage(chatId, 'No WhatsApp connected.');

    bot.sendMessage(chatId, `Sending to ${numbers.length} numbers...`);

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
        bot.sendMessage(chatId, `Task Complete. Sent: ${sent}, Failed: ${failed}`);
    })();
});
