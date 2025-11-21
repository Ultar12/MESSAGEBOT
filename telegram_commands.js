import fs from 'fs';
import path from 'path';
import { jidNormalizedUser } from '@whiskeysockets/baileys';

const NUMBERS_FILE = './numbers.json';
const VCF_FILE = './contacts.vcf';

// Helper: Extract Numbers from VCF Content
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

    // --- 1. START ---
    bot.onText(/\/start/, (msg) => {
        bot.sendMessage(msg.chat.id, 
            'Ultarbot Flash System\n\n' +
            '/pair <number> - Connect Account\n' +
            '/list - Show IDs & Accounts\n' +
            '/generate <code 234> <amount> - Gen Numbers\n' +
            '/save - Reply to .vcf to load list\n' +
            '/delnum - Delete saved numbers/VCF\n' +
            '/broadcast <id> - FLASH SEND (Reply to text)\n' +
            '/send <number> <msg> - Direct message'
        );
    });

    // --- 2. PAIRING ---
    bot.onText(/\/pair (.+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        const number = match[1].replace(/[^0-9]/g, '');
        if (!number) return bot.sendMessage(chatId, 'Usage: /pair 2349012345678');
        
        const existingSession = Object.values(shortIdMap).find(s => s.phone === number);
        if (existingSession) return bot.sendMessage(chatId, `Number already connected (ID: ${existingSession.id})`);

        const sessionId = makeSessionId(); 
        const sessionPath = path.join(SESSIONS_DIR, sessionId);
        fs.mkdirSync(sessionPath, { recursive: true });

        bot.sendMessage(chatId, `Initializing ${number}...`);
        startClient(sessionId, number, chatId);
    });

    // --- 3. LIST ---
    bot.onText(/\/list/, (msg) => {
        const ids = Object.keys(shortIdMap);
        if (ids.length === 0) return bot.sendMessage(msg.chat.id, "No accounts connected.");
        
        let listText = "Active Accounts:\n\n";
        ids.forEach((id) => {
            const session = shortIdMap[id];
            const phone = session.phone || "Connecting...";
            const status = antiMsgState[phone] ? "LOCKED" : "READY";
            listText += `ID: ${id} | +${phone} [${status}]\n`;
        });
        bot.sendMessage(msg.chat.id, listText);
    });

    // --- 4. GENERATE ---
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

    // --- 5. SAVE VCF ---
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

    // --- 6. DELETE NUMBERS ---
    bot.onText(/\/delnum/, (msg) => {
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
            bot.sendMessage(msg.chat.id, `Deleted successfully:\n- ${deletedItems.join('\n- ')}`);
        } else {
            bot.sendMessage(msg.chat.id, 'Database is already empty.');
        }
    });

    // --- 7. FLASH BROADCAST (AT ONCE) ---
    bot.onText(/\/broadcast (.+)/, async (msg, match) => {
        if (!msg.reply_to_message?.text) return bot.sendMessage(msg.chat.id, 'Reply to a text message with /broadcast <id>');
        
        const targetId = match[1].trim();
        const sessionData = shortIdMap[targetId];

        if (!sessionData) return bot.sendMessage(msg.chat.id, `Invalid ID: ${targetId}. Use /list to see IDs.`);
        
        const sock = clients[sessionData.folder];
        if (!sock) return bot.sendMessage(msg.chat.id, 'Client not active. Wait for it to connect.');

        // Get Numbers
        let numbers = [];
        if (fs.existsSync(VCF_FILE)) {
            numbers = parseVcf(fs.readFileSync(VCF_FILE, 'utf-8'));
        } else if (fs.existsSync(NUMBERS_FILE)) {
            numbers = JSON.parse(fs.readFileSync(NUMBERS_FILE));
        } else {
            return bot.sendMessage(msg.chat.id, 'No numbers found.');
        }

        bot.sendMessage(msg.chat.id, `FLASHING message to ${numbers.length} numbers using ${targetId}...`);

        const messageContent = { text: msg.reply_to_message.text };
        let successCount = 0;

        const startTime = Date.now();
        
        // --- FLASH LOGIC: PREPARE THEN EXECUTE ---
        // We create an array of Promises. Node.js executes these in parallel immediately.
        const tasks = numbers.map(async (num) => {
            try {
                const jid = `${num}@s.whatsapp.net`;
                // We do not await onWhatsApp. We fire the message directly.
                await sock.sendMessage(jid, messageContent);
                successCount++;
            } catch (e) {
                // Ignored for speed
            }
        });

        // The trigger has been pulled. Now we just wait for the network requests to clear buffer.
        await Promise.all(tasks);
        
        const duration = (Date.now() - startTime) / 1000;
        bot.sendMessage(msg.chat.id, `Flash Complete in ${duration}s.\nSent Requests: ${successCount}`);
    });

    // --- 8. DIRECT SEND ---
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
