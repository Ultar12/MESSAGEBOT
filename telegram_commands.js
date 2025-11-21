import fs from 'fs';
import path from 'path';
import { jidNormalizedUser, delay } from '@whiskeysockets/baileys';

const NUMBERS_FILE = './numbers.json';
const VCF_FILE = './contacts.vcf';

// State machine to track if user is inputting a number
const userState = {};

// Helper: Fast VCF Parser
function parseVcf(vcfContent) {
    const numbers = new Set(); 
    const regex = /TEL;?[^:]*:(?:[\+]?)([\d\s-]+)/gi;
    let match;
    while ((match = regex.exec(vcfContent)) !== null) {
        let cleanNum = match[1].replace(/[^0-9]/g, '');
        if (cleanNum.length > 5) numbers.add(cleanNum);
    }
    return Array.from(numbers);
}

export function setupTelegramCommands(bot, clients, shortIdMap, SESSIONS_DIR, startClient, makeSessionId, antiMsgState) {

    // --- MAIN MENU KEYBOARD ---
    const mainMenu = {
        reply_markup: {
            inline_keyboard: [
                [{ text: "Pair Account", callback_data: "btn_pair" }],
                [{ text: "List Active Accounts", callback_data: "btn_list" }],
                [{ text: "Delete Database", callback_data: "btn_delnum" }]
            ]
        }
    };

    // --- 1. START COMMAND ---
    bot.onText(/\/start/, (msg) => {
        userState[msg.chat.id] = null; // Reset state
        bot.sendMessage(msg.chat.id, 
            'Ultarbot Flash System\n\n' +
            'Select an option below or use commands:\n' +
            '/generate <code 234> <amount>\n' +
            '/save (Reply to VCF)\n' +
            '/broadcast <id> (Reply to text)',
            mainMenu
        );
    });

    // --- 2. BUTTON HANDLER ---
    bot.on('callback_query', async (query) => {
        const chatId = query.message.chat.id;
        const data = query.data;

        // Acknowledge click
        bot.answerCallbackQuery(query.id);

        if (data === 'btn_pair') {
            userState[chatId] = 'WAITING_FOR_NUMBER';
            bot.sendMessage(chatId, 'Please enter the WhatsApp number (e.g. 2349012345678):');
        }

        else if (data === 'btn_list') {
            const ids = Object.keys(shortIdMap);
            if (ids.length === 0) {
                return bot.sendMessage(chatId, "No accounts connected.", mainMenu);
            }
            let listText = "Active Accounts:\n\n";
            ids.forEach((id) => {
                const session = shortIdMap[id];
                const phone = session.phone || "Connecting...";
                const status = antiMsgState[phone] ? "LOCKED" : "READY";
                listText += `ID: \`${id}\` | +${phone} [${status}]\n`;
            });
            bot.sendMessage(chatId, listText, { parse_mode: 'Markdown' });
        }

        else if (data === 'btn_delnum') {
            let deletedItems = [];
            if (fs.existsSync(NUMBERS_FILE)) {
                fs.unlinkSync(NUMBERS_FILE);
                deletedItems.push("Generated List");
            }
            if (fs.existsSync(VCF_FILE)) {
                fs.unlinkSync(VCF_FILE);
                deletedItems.push("VCF Contacts");
            }
            if (deletedItems.length > 0) {
                bot.sendMessage(chatId, `Deleted:\n- ${deletedItems.join('\n- ')}`, mainMenu);
            } else {
                bot.sendMessage(chatId, 'Database is already empty.', mainMenu);
            }
        }
    });

    // --- 3. TEXT INPUT HANDLER (For Pairing) ---
    bot.on('message', async (msg) => {
        if (!msg.text || msg.text.startsWith('/')) return; // Ignore commands

        const chatId = msg.chat.id;

        // Handle Pairing Input
        if (userState[chatId] === 'WAITING_FOR_NUMBER') {
            const number = msg.text.replace(/[^0-9]/g, '');
            
            if (number.length < 10) {
                return bot.sendMessage(chatId, 'Invalid format. Enter number only (e.g. 23490...)');
            }

            // Check existing
            const existingSession = Object.values(shortIdMap).find(s => s.phone === number);
            if (existingSession) {
                userState[chatId] = null;
                return bot.sendMessage(chatId, `Number already connected (ID: \`${existingSession.id}\`)`, { parse_mode: 'Markdown' });
            }

            userState[chatId] = null; // Reset State
            
            // Start Pairing Logic
            const sessionId = makeSessionId(); 
            const sessionPath = path.join(SESSIONS_DIR, sessionId);
            fs.mkdirSync(sessionPath, { recursive: true });

            bot.sendMessage(chatId, `Initializing ${number}...`);
            startClient(sessionId, number, chatId);
        }
    });

    // --- 4. COMMANDS ---

    // PAIR (Manual Command)
    bot.onText(/\/pair (.+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        const number = match[1].replace(/[^0-9]/g, '');
        if (!number) return bot.sendMessage(chatId, 'Usage: /pair 2349012345678');
        
        const sessionId = makeSessionId(); 
        const sessionPath = path.join(SESSIONS_DIR, sessionId);
        fs.mkdirSync(sessionPath, { recursive: true });

        bot.sendMessage(chatId, `Initializing ${number}...`);
        startClient(sessionId, number, chatId);
    });

    // GENERATE
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

    // SAVE VCF
    bot.onText(/\/save/, async (msg) => {
        if (!msg.reply_to_message?.document) return bot.sendMessage(msg.chat.id, 'Reply to a VCF file.');

        try {
            const fileLink = await bot.getFileLink(msg.reply_to_message.document.file_id);
            const response = await fetch(fileLink);
            const text = await response.text();

            fs.writeFileSync(VCF_FILE, text);
            const numbers = parseVcf(text);
            bot.sendMessage(msg.chat.id, `VCF Loaded: ${numbers.length} contacts ready for Flash.`);
        } catch (e) {
            bot.sendMessage(msg.chat.id, `Error: ${e.message}`);
        }
    });

    // FLASH BROADCAST (One-by-One but Fast)
    bot.onText(/\/broadcast (.+)/, async (msg, match) => {
        if (!msg.reply_to_message?.text) return bot.sendMessage(msg.chat.id, 'Reply to text with /broadcast <id>');
        
        const targetId = match[1].trim();
        const sessionData = shortIdMap[targetId];

        if (!sessionData) return bot.sendMessage(msg.chat.id, `Invalid ID. Use List button.`);
        
        const sock = clients[sessionData.folder];
        if (!sock) return bot.sendMessage(msg.chat.id, 'Client not active.');

        // Get Numbers
        let numbers = [];
        if (fs.existsSync(VCF_FILE)) {
            numbers = parseVcf(fs.readFileSync(VCF_FILE, 'utf-8'));
        } else if (fs.existsSync(NUMBERS_FILE)) {
            numbers = JSON.parse(fs.readFileSync(NUMBERS_FILE));
        } else {
            return bot.sendMessage(msg.chat.id, 'No numbers database found.');
        }

        bot.sendMessage(msg.chat.id, `FLASHING message to ${numbers.length} numbers using ${targetId}...`);

        const messageContent = { text: msg.reply_to_message.text };
        let successCount = 0;

        const startTime = Date.now();
        
        // --- FLASH ONE-BY-ONE LOGIC ---
        // We use a for loop (Sequential) but we DO NOT await the result (Fire and Forget)
        // This keeps the order correct but moves extremely fast.
        
        for (const num of numbers) {
            const jid = `${num}@s.whatsapp.net`;
            
            // FIRE (No Await)
            sock.sendMessage(jid, messageContent)
                .then(() => { /* success silently */ })
                .catch(() => { /* fail silently */ });
            
            successCount++;
            
            // Tiny delay (10ms) to prevent crashing the server CPU
            await delay(10);
        }

        const duration = (Date.now() - startTime) / 1000;
        bot.sendMessage(msg.chat.id, `Flash Complete in ${duration}s.\nSent Requests: ${successCount}`);
    });

    // DIRECT SEND
    bot.onText(/\/send/, async (msg) => {
        if (msg.reply_to_message) return; 
        const directMatch = msg.text.match(/\/send\s+(\d+)\s+(.+)/);
        if (!directMatch) return bot.sendMessage(msg.chat.id, 'Usage: /send <number> <msg>');

        const firstId = Object.keys(shortIdMap)[0];
        if(!firstId) return bot.sendMessage(msg.chat.id, 'No clients.');

        const sock = clients[shortIdMap[firstId].folder];
        try {
            await sock.sendMessage(`${directMatch[1]}@s.whatsapp.net`, { text: directMatch[2] });
            bot.sendMessage(msg.chat.id, 'Sent.');
        } catch (e) {
            bot.sendMessage(msg.chat.id, `Error: ${e.message}`);
        }
    });
}
