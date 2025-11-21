import 'dotenv/config';
import { 
    useMultiFileAuthState, 
    makeWASocket, 
    DisconnectReason, 
    fetchLatestBaileysVersion, 
    Browsers,
    jidNormalizedUser
} from '@whiskeysockets/baileys';
import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs';
import path from 'path';
import pino from 'pino';
import express from 'express';
import { Boom } from '@hapi/boom';

import { setupTelegramCommands } from './telegram_commands.js';
import { initDb, saveSessionToDb, getAllSessions, deleteSessionFromDb } from './db.js';

// --- CONFIG ---
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const SESSIONS_DIR = './sessions';

if (!TELEGRAM_TOKEN) { console.error('Missing TELEGRAM_TOKEN'); process.exit(1); }
if (!process.env.DATABASE_URL) { console.error('Missing DATABASE_URL'); process.exit(1); }

// --- SERVER ---
const app = express();
const PORT = process.env.PORT || 10000;
app.get('/', (req, res) => res.send('Ultarbot Pro Running'));
app.listen(PORT, () => console.log(`Server on ${PORT}`));

// --- SETUP ---
const clients = {}; 
const shortIdMap = {}; // Memory cache of IDs
const antiMsgState = {}; 

// Init Local Folder
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// --- HELPERS ---
function generateShortId() {
    return Math.random().toString(36).substring(2, 7); // Random 5 chars
}

function makeSessionId() {
    return `Ultarbot_${Date.now()}`;
}

const getRandomBrowser = () => {
    const browsers = [
        Browsers.macOS('Safari'), Browsers.macOS('Chrome'), 
        Browsers.windows('Firefox'), Browsers.ubuntu('Chrome'), Browsers.windows('Edge')
    ];
    return browsers[Math.floor(Math.random() * browsers.length)];
};

// --- CLIENT LOGIC ---
async function startClient(folder, targetNumber = null, chatId = null) {
    const sessionPath = path.join(SESSIONS_DIR, folder);
    if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: "silent" }),
        browser: getRandomBrowser(), 
        version,
        connectTimeoutMs: 60000,
        markOnlineOnConnect: true,
        emitOwnEvents: true 
    });

    // PERSISTENCE: Save creds to DB on every update
    sock.ev.on('creds.update', async () => {
        await saveCreds();
        // Read creds file
        try {
            const credsFile = path.join(sessionPath, 'creds.json');
            if (fs.existsSync(credsFile)) {
                const content = fs.readFileSync(credsFile, 'utf-8');
                // We need the phone number to save. If we don't have it yet, use "pending"
                let phone = "pending";
                // Try to find phone in memory
                const id = Object.keys(shortIdMap).find(k => shortIdMap[k].folder === folder);
                if (id) phone = shortIdMap[id].phone;
                
                await saveSessionToDb(folder, phone, content);
            }
        } catch(e) { console.error('DB Save Fail', e); }
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'open') {
            const userJid = jidNormalizedUser(sock.user.id);
            const phoneNumber = userJid.split('@')[0];
            
            // Register in Memory Map
            let myShortId = Object.keys(shortIdMap).find(key => shortIdMap[key].folder === folder);
            if (!myShortId) {
                myShortId = generateShortId();
                shortIdMap[myShortId] = { folder, phone: phoneNumber };
            } else {
                shortIdMap[myShortId].phone = phoneNumber;
            }

            clients[folder] = sock;
            console.log(`Connected: ${phoneNumber}`);

            if (chatId) {
                bot.sendMessage(chatId, 
                    `Connected!\nNumber: +${phoneNumber}\nID: ${myShortId}`
                );
            }
        }

        if (connection === 'close') {
            let reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
            if (reason === DisconnectReason.loggedOut) {
                await deleteSessionFromDb(folder);
                if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true, force: true });
                delete clients[folder];
                
                const id = Object.keys(shortIdMap).find(k => shortIdMap[k].folder === folder);
                if (id) delete shortIdMap[id];
            } else {
                startClient(folder);
            }
        }
    });

    // PAIRING
    if (targetNumber && !sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(targetNumber);
                if (chatId) bot.sendMessage(chatId, `Code: \`${code}\``, { parse_mode: 'Markdown' });
            } catch (e) {
                if (chatId) bot.sendMessage(chatId, "Pairing failed. Try again.");
            }
        }, 3000);
    }
}

// --- RESTORE LOGIC ---
async function boot() {
    await initDb(); // Create tables
    const savedSessions = await getAllSessions();
    
    console.log(`[DB] Restoring ${savedSessions.length} sessions...`);
    
    for (const session of savedSessions) {
        // Re-create local file from DB content
        const folderPath = path.join(SESSIONS_DIR, session.session_id);
        if (!fs.existsSync(folderPath)) fs.mkdirSync(folderPath, { recursive: true });
        
        if (session.creds) {
            fs.writeFileSync(path.join(folderPath, 'creds.json'), session.creds);
        }
        
        // Start
        startClient(session.session_id);
        
        // Restore Memory Map
        const shortId = generateShortId();
        shortIdMap[shortId] = { folder: session.session_id, phone: session.phone };
    }
}

setupTelegramCommands(bot, clients, shortIdMap, SESSIONS_DIR, startClient, makeSessionId, antiMsgState);
boot();
