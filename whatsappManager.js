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
  console.log('Loading all existing clients...');
  const folders = getSessionFolders();
  
  for (const folder of folders) {
    const sessionPath = path.join(SESSIONS_DIR, folder);
    try {
      const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
      const sock = makeWASocket({ auth: state });

      // [!THIS IS THE FIX!]
      // Add the connection listener to all loaded clients
      sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
        if (connection === 'close') {
          const shouldLogout = lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut;
          console.log(`Client ${folder} disconnected. Reason: ${lastDisconnect?.error}`);
          if (shouldLogout) {
            console.log(`Client ${folder} was logged out. Removing session.`);
            // Check if directory exists before trying to remove
            if (fs.existsSync(sessionPath)) {
              fs.rmSync(sessionPath, { recursive: true, force: true });
            }
            delete clients[folder];
          }
        } else if (connection === 'open') {
            console.log(`Client ${folder} reconnected.`);
        }
      });
      // [!END OF FIX!]

      sock.ev.on('creds.update', saveCreds);
      clients[folder] = sock;
      console.log(`Loaded client: ${folder}`);

    } catch (e) {
        console.error(`Failed to load client ${folder}: ${e.message}`);
        // If session is corrupted, remove it
        if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
        }
    }
  }
}
// Load clients on startup
await loadAllClients();

// /pair or /pair <number>
export async function handlePair(ctx) {
  try {
    const args = ctx.message.text.split(' ');
    let number = args[1];
    if (!number) {
      number = `wa_${Date.now()}`;
    }
    
    // Prevent duplicate pairing
    if (clients[number]) {
        return ctx.reply(`A client with the name ${number} already exists.`);
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
        const shouldLogout = lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut;
        console.log(`Pairing client ${number} disconnected. Reason: ${lastDisconnect?.error}`);
        if (shouldLogout) {
          ctx.reply(`WhatsApp account ${number} logged out and removed.`);
          if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
          }
          delete clients[number];
        }
      }
      if (connection === 'open') {
        ctx.reply(`WhatsApp account ${number} paired successfully!`);
        clients[number] = sock; // Add to active clients
      }
    });

    // Trigger pairing code generation
    try {
      // Use the 'number' as the phone number for pairing code (without country code prefix)
      // If 'number' is a random string like 'wa_123', this might fail.
      // Let's assume 'number' should be the phone number.
      // For random IDs, you don't need to pass a number to requestPairingCode.
      // However, Baileys now recommends using the phone number for pairing.
      // If you are just using it as an ID, you might not need to pass it.
      // Let's try requesting without the number, as it's just an ID.
      // UPDATE: The Baileys docs say `requestPairingCode` *requires* a phone number.
      // Using your random 'wa_...' string as the ID is fine for the folder,
      // but you need a *real phone number* for `requestPairingCode`.
      
      // We will assume the user provides the number as the ID.
      // If args[1] is not a phone number, this will likely fail.
      // A better approach:
      if (!/^\d+$/.test(number)) {
        ctx.reply('Error: The ID for /pair must be a valid phone number (e.g., 2348012345678) to generate a pairing code.');
        fs.rmSync(sessionPath, { recursive: true, force: true }); // Clean up empty folder
        return;
      }
      
      await sock.requestPairingCode(number);
      
    } catch (e) {
      ctx.reply('Failed to generate pairing code: ' + (e.message || e));
      if (fs.existsSync(sessionPath)) {
         fs.rmSync(sessionPath, { recursive: true, force: true });
      }
    }
  } catch (err) {
    ctx.reply('Error during WhatsApp pairing: ' + (err.message || err));
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
  
  // Use replied message text if available
  let messageText = MESSAGE;
  if (ctx.message.reply_to_message && ctx.message.reply_to_message.text) {
    messageText = ctx.message.reply_to_message.text;
  }
  
  let sent = 0;
  let numbersIndex = 0; // Track position in the numbers list
  
  ctx.reply(`Starting to send messages to ${numbers.length} contacts using ${waNumbers.length} WhatsApp accounts.`);

  // Loop through available clients and assign them chunks of numbers
  for (const waNum of waNumbers) {
    if (numbersIndex >= numbers.length) break; // All numbers sent
    
    const sock = clients[waNum];
    // Send 5 messages per client, then move to the next client
    const chunk = numbers.slice(numbersIndex, numbersIndex + 5); 
    
    for (const num of chunk) {
      try {
        // Add a small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 2000));
        
        await sock.sendMessage(`${num}@s.whatsapp.net`, { text: messageText });
        sent++;
      } catch (e) {
        console.error(`Error sending to ${num} from ${waNum}: ${e.message}`);
        
        // Handle bans or logouts
        if (e?.output?.statusCode === 401 || e?.output?.statusCode === 403 || e?.output?.statusCode === DisconnectReason.loggedOut) {
          ctx.reply(`WhatsApp account ${waNum} banned or logged out. Removing.`);
          if (fs.existsSync(path.join(SESSIONS_DIR, waNum))) {
            fs.rmSync(path.join(SESSIONS_DIR, waNum), { recursive: true, force: true });
          }
          delete clients[waNum];
          // Stop this client from sending more in this loop
          break; 
        }
      }
    }
    numbersIndex += chunk.length;
  }
  
  ctx.reply(`Sent ${sent} messages in total. ${numbers.length - numbersIndex} numbers remaining (if any).`);
}

// /save - save VCF file sent to the bot
export async function handleSave(ctx) {
  if (!ctx.message.document) {
    ctx.reply('Please send a VCF file with the /save command.');
    return;
  }
  if (!ctx.message.document.file_name.endsWith('.vcf')) {
      ctx.reply('Error: File must be a .vcf file.');
      return;
  }

  const fileId = ctx.message.document.file_id;
  const fileUrl = await ctx.telegram.getFileLink(fileId);
  
  try {
    const res = await fetch(fileUrl.href);
    const vcfData = await res.text();
    
    // Parse and save numbers
    const numbers = parseVCF(vcfData); // Pass data directly
    fs.writeFileSync(NUMBERS_FILE, JSON.stringify(numbers, null, 2));
    ctx.reply(`Saved ${numbers.length} numbers from VCF file.`);

  } catch (e) {
      console.error('Error in /save:', e);
      ctx.reply(`Error processing VCF file: ${e.message}. Make sure vcfParser.js exists.`);
  }
}

// /generate <country_code> <amount>
export async function handleGenerate(ctx) {
  const args = ctx.message.text.split(' ');
  const code = args[1];
  const amount = parseInt(args[2], 10) || 1000; // Default to 1000

  if (!code || !/^\d+$/.test(code)) {
    ctx.reply('Usage: /generate <country_code> [amount]');
    return;
  }
  
  if (amount > 10000) {
      ctx.reply('Error: Cannot generate more than 10,000 numbers at a time.');
      return;
  }

  const numbers = [];
  for (let i = 0; i < amount; i++) {
    const rand = Math.floor(100000000 + Math.random() * 900000000); // 9 digits
    numbers.push(`${code}${rand}`);
  }
  fs.writeFileSync(NUMBERS_FILE, JSON.stringify(numbers, null, 2));
  ctx.reply(`Generated ${amount} random numbers for country code ${code}.`);
}
