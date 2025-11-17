// WhatsApp account management using baileys
import { useMultiFileAuthState, makeWASocket, DisconnectReason } from '@whiskeysockets/baileys';
import fs from 'fs';
import path from 'path';
import { parseVCF } from './vcfParser.js';

const SESSIONS_DIR = './sessions';
const NUMBERS_FILE = './numbers.json';
const MESSAGE = 'Hello from Telegram WhatsApp Bot!';

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR);

// Store WhatsApp clients by number
const clients = {};

// Helper to get all session folders
function getSessionFolders() {
  return fs.readdirSync(SESSIONS_DIR).filter(f => fs.statSync(path.join(SESSIONS_DIR, f)).isDirectory());
}

// Helper to load all WhatsApp clients
async function loadAllClients() {
  const folders = getSessionFolders();
  for (const folder of folders) {
    const { state, saveCreds } = await useMultiFileAuthState(path.join(SESSIONS_DIR, folder));
    const sock = makeWASocket({ auth: state });
    sock.ev.on('creds.update', saveCreds);
    clients[folder] = sock;
  }
}
await loadAllClients();

// /pair or /pair <number>
export async function handlePair(ctx) {
  const args = ctx.message.text.split(' ');
  let number = args[1];
  if (!number) {
    number = `wa_${Date.now()}`;
  }
  const sessionPath = path.join(SESSIONS_DIR, number);
  if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath);
  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
  const sock = makeWASocket({ auth: state, printQRInTerminal: false });
  sock.ev.on('creds.update', saveCreds);
  let pairingCodeSent = false;
  sock.ev.on('connection.update', async ({ pairingCode, connection, lastDisconnect }) => {
    if (pairingCode && !pairingCodeSent) {
      pairingCodeSent = true;
      ctx.reply(`WhatsApp Pairing Code for ${number}:\n\n${pairingCode}\n\nOpen WhatsApp > Linked Devices > Link a Device > Enter this code.`);
    }
    if (connection === 'close') {
      if (lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut) {
        ctx.reply(`WhatsApp account ${number} logged out and removed.`);
        fs.rmSync(sessionPath, { recursive: true, force: true });
        delete clients[number];
      }
    }
    if (connection === 'open') {
      ctx.reply(`WhatsApp account ${number} paired successfully!`);
      clients[number] = sock;
    }
  });
  // Trigger pairing code generation
  try {
    await sock.requestPairingCode(number);
  } catch (e) {
    ctx.reply('Failed to generate pairing code.');
  }
}

// /send
export async function handleSend(ctx) {
  // Load numbers from VCF or generated file
  let numbers = [];
  if (fs.existsSync(NUMBERS_FILE)) {
    numbers = JSON.parse(fs.readFileSync(NUMBERS_FILE));
  } else {
    ctx.reply('No numbers found. Use /generate or upload a VCF.');
    return;
  }
  // Get available WhatsApp clients
  const waNumbers = Object.keys(clients);
  if (waNumbers.length === 0) {
    ctx.reply('No WhatsApp accounts paired. Use /pair first.');
    return;
  }
  let sent = 0;
  for (const waNum of waNumbers) {
    const sock = clients[waNum];
    const chunk = numbers.slice(sent, sent + 5);
    for (const num of chunk) {
      try {
        await sock.sendMessage(`${num}@s.whatsapp.net`, { text: MESSAGE });
      } catch (e) {
        if (e?.output?.statusCode === 401 || e?.output?.statusCode === 403) {
          ctx.reply(`WhatsApp account ${waNum} banned or logged out. Removing.`);
          fs.rmSync(path.join(SESSIONS_DIR, waNum), { recursive: true, force: true });
          delete clients[waNum];
        }
      }
    }
    sent += 5;
    if (sent >= numbers.length) break;
  }
  ctx.reply(`Sent messages to ${sent} numbers.`);
}

// /generate <country_code>
export async function handleGenerate(ctx) {
  const args = ctx.message.text.split(' ');
  const code = args[1];
  if (!code || !/^\d+$/.test(code)) {
    ctx.reply('Usage: /generate <country_code>');
    return;
  }
  const numbers = [];
  for (let i = 0; i < 1000; i++) {
    const rand = Math.floor(100000000 + Math.random() * 900000000); // 9 digits
    numbers.push(`${code}${rand}`);
  }
  fs.writeFileSync(NUMBERS_FILE, JSON.stringify(numbers, null, 2));
  ctx.reply(`Generated 1000 random numbers for country code ${code}.`);
}
