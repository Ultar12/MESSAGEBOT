// This is your updated code for deployment.
// It reads the token from a secret environment variable.
import { useMultiFileAuthState, makeWASocket, DisconnectReason } from '@whiskeysockets/baileys';
import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs';
import path from 'path';

// --- CONFIG ---
// [! FIX !] Read the token from the server's environment variables.
// On Render, you will set this in the "Environment" tab.
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;

const SESSIONS_DIR = process.env.SESSIONS_DIR || './sessions'; // Allow session path to be set by environment
const NUMBERS_FILE = './numbers.json';
const WA_VERSION = [2, 3000, 1025190524]; // Your version fix

// --- GLOBALS ---
const clients = {}; 

// Check for token
if (!TELEGRAM_TOKEN) {
    console.error('[FATAL ERROR] TELEGRAM_TOKEN is not set in your environment variables.');
    process.exit(1);
}

// Create sessions directory if it doesn't exist
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR);

// --- 1. INITIALIZE TELEGRAM BOT ---
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
console.log('✅ Telegram bot started with polling...');

// --- 2. LOAD ALL EXISTING SESSIONS ON STARTUP ---
async function loadAllClients() {
  console.log('Loading all existing clients...');
  const folders = fs.readdirSync(SESSIONS_DIR)
                    .filter(f => fs.statSync(path.join(SESSIONS_DIR, f)).isDirectory());
  
  console.log(`Found ${folders.length} session folders.`);
  for (const folder of folders) {
    const sessionPath = path.join(SESSIONS_DIR, folder);
    try {
      const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
      const sock = makeWASocket({ 
          auth: state, 
          printQRInTerminal: false,
          version: WA_VERSION 
      });

      sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
        if (connection === 'close') {
          const shouldLogout = lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut;
          console.log(`Client ${folder} disconnected. Reason: ${lastDisconnect?.error}`);
          if (shouldLogout) {
            console.log(`Client ${folder} was logged out. Removing session.`);
            if (fs.existsSync(sessionPath)) {
              fs.rmSync(sessionPath, { recursive: true, force: true });
            }
            delete clients[folder];
          }
        } else if (connection === 'open') {
            console.log(`Client ${folder} reconnected.`);
        }
      });

      sock.ev.on('creds.update', saveCreds);
      clients[folder] = sock; 
      console.log(`Loaded client: ${folder}`);
    } catch (e) {
        console.error(`Failed to load client ${folder}: ${e.message}`);
        if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
        }
    }
  }
}
loadAllClients();

// --- 3. TELEGRAM COMMAND HANDLERS ---
bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id,
        'Welcome! This bot is running on a server.\n\n' +
        '1. Use `/pair <phone_number>` to link (e.g., `/pair 2349163916314`).\n' +
        '2. Use `/generate <country_code> <amount>` to create a list of numbers.\n' +
        '3. Reply to a message with `/send` to send it to your list.'
    );
});

bot.onText(/\/pair (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const number = match[1]; 

  if (!number || !/^\d+$/.test(number)) {
    return bot.sendMessage(chatId, 'Usage: /pair <phone_number>\n(e.g., /pair 2349163916314)');
  }
  if (clients[number]) {
      return bot.sendMessage(chatId, `A client for ${number} already exists or is pairing.`);
  }

  const sessionPath = path.join(SESSIONS_DIR, number);
  if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, { recursive: true, force: true });
  }
  fs.mkdirSync(sessionPath);
  
  bot.sendMessage(chatId, `Attempting to pair ${number}. Requesting code...`);

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
  const sock = makeWASocket({ 
      auth: state, 
      printQRInTerminal: false,
      version: WA_VERSION
  });

  sock.ev.on('creds.update', saveCreds);

  let pairingCodeSent = false;
  sock.ev.on('connection.update', async ({ pairingCode, connection, lastDisconnect }) => {
    
    if (pairingCode && !pairingCodeSent) {
      pairingCodeSent = true;
      bot.sendMessage(chatId, 
          `WhatsApp Pairing Code for *${number}*:\n\n` +
          `*${pairingCode}*\n\n` +
          `Open WhatsApp > Linked Devices > Link a Device > Enter this code.`,
          { parse_mode: 'Markdown' }
      );
    }
    
    if (connection === 'close') {
      const shouldLogout = lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut;
      console.log(`Pairing client ${number} disconnected. Reason: ${lastDisconnect?.error}`);
      
      if (fs.existsSync(sessionPath)) {
          fs.rmSync(sessionPath, { recursive: true, force: true });
      }
      delete clients[number];
      
      if (shouldLogout) {
        bot.sendMessage(chatId, `WhatsApp account ${number} logged out.`);
      } else {
        bot.sendMessage(chatId, 
            `Pairing failed for ${number}: *${lastDisconnect?.error?.message || 'Connection closed'}*`,
            { parse_mode: 'Markdown' }
        );
      }
    }
    
    if (connection === 'open') {
      bot.sendMessage(chatId, `✅ WhatsApp account *${number}* paired successfully!`, { parse_mode: 'Markdown' });
      clients[number] = sock;
    }
  });

  try {
    await sock.requestPairingCode(number);
  } catch (e) {
    console.error('Error requesting pairing code:', e);
    bot.sendMessage(chatId, 'Failed to generate pairing code: ' + (e.message || e));
    if (fs.existsSync(sessionPath)) {
       fs.rmSync(sessionPath, { recursive: true, force: true });
    }
  }
});

bot.onText(/\/send/, async (msg) => {
    const chatId = msg.chat.id;
    let messageText = '';
    if (msg.reply_to_message && msg.reply_to_message.text) {
        messageText = msg.reply_to_message.text;
    } else {
        return bot.sendMessage(chatId, 'Please reply to a message with /send to send it.');
    }
    let numbers = [];
    if (fs.existsSync(NUMBERS_FILE)) {
        numbers = JSON.parse(fs.readFileSync(NUMBERS_FILE));
    } else {
        return bot.sendMessage(chatId, `No numbers found. Use /generate first.`);
    }
    const waClients = Object.entries(clients);
    if (waClients.length === 0) {
        return bot.sendMessage(chatId, 'No WhatsApp accounts are paired. Use /pair first.');
    }
    bot.sendMessage(chatId, `Starting to send "${messageText}" to ${numbers.length} numbers using ${waClients.length} accounts...`);
    let sent = 0;
    let failed = 0;
    let clientIndex = 0;
    for (const num of numbers) {
        const [clientNumber, sock] = waClients[clientIndex];
        clientIndex = (clientIndex + 1) % waClients.length;
        try {
            const jid = `${num}@s.whatsapp.net`;
            const [exists] = await sock.onWhatsApp(jid);
            if (!exists?.exists) {
                console.log(`Number ${num} does not exist on WhatsApp.`);
                failed++;
                continue;
            }
            await sock.sendMessage(jid, { text: messageText });
            sent++;
            await new Promise(resolve => setTimeout(resolve, 1500 + Math.random() * 2000));
        } catch (e) {
            console.error(`Failed to send to ${num} from ${clientNumber}: ${e.message}`);
            failed++;
        }
    }
    bot.sendMessage(chatId, `✅ Send complete!\nSent: ${sent}\nFailed: ${failed}`);
});

bot.onText(/\/generate (.+)/, (msg, match) => {
    const args = msg.text.split(' ');
    const code = args[1];
    const amount = parseInt(args[2], 10) || 100;
    if (!code || !/^\d+$/.test(code)) {
        return bot.sendMessage(msg.chat.id, 'Usage: /generate <country_code> [amount]\n(e.g., /generate 234 50)');
    }
    if (amount > 1000) {
        return bot.sendMessage(msg.chat.id, 'Cannot generate more than 1000 at a time.');
    }
    const numbers = [];
    for (let i = 0; i < amount; i++) {
        const rand = Math.floor(100000000 + Math.random() * 900000000);
        numbers.push(`${code}${rand}`);
    }
    fs.writeFileSync(NUMBERS_FILE, JSON.stringify(numbers, null, 2));
    bot.sendMessage(msg.chat.id, `Generated ${amount} numbers for code ${code} and saved to ${NUMBERS_FILE}.`);
});

bot.onText(/\/save/, async (msg) => {
    bot.sendMessage(msg.chat.id, 'Note: The /save command is disabled until `vcfParser.js` is created.');
});
