import fs from 'fs';
import path from 'path';
import { jidNormalizedUser, delay } from '@whiskeysockets/baileys';

const NUMBERS_FILE = './numbers.json';
const VCF_FILE = './contacts.vcf';

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

    // --- MAIN MENU ---
    const mainMenu = {
        reply_markup: {
            inline_keyboard: [
                [{ text: "Pair Account", callback_data: "btn_pair" }],
                [{ text: "List Active Accounts", callback_data: "btn_list" }],
                [{ text: "Delete Database", callback_data: "btn_delnum" }]
            ]
        }
    };

    // --- 1. START ---
    bot.onText(/\/start/, (msg) => {
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
        bot.answerCallbackQuery(query.id);

        if (data === 'btn_pair') {
            bot.sendMessage(chatId, 'Enter number to pair (e.g. 23490...):');
            // Note: Simple state handling would go here as per previous code
        }
        else if (data === 'btn_list') {
            const ids = Object.keys(shortIdMap);
            if (ids.length === 0) return bot.sendMessage(chatId, "No accounts connected.", mainMenu);
            
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
            if (fs.existsSync(NUMBERS_FILE)) { fs.unlinkSync(NUMBERS_FILE); deletedItems.push("Generated List"); }
            if (fs.existsSync(VCF_FILE)) { fs.unlinkSync(VCF_FILE); deletedItems.push("VCF Contacts"); }
            
            if (deletedItems.length > 0) bot.sendMessage(chatId, `Deleted:\n- ${deletedItems.join('\n- ')}`, mainMenu);
            else bot.sendMessage(chatId, 'Database is empty.', mainMenu);
        }
    });

    // --- 3. PAIRING (Command) ---
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

    // --- 5. SAVE VCF (SMART FILTER) ---
    bot.onText(/\/save/, async (msg) => {
        if (!msg.reply_to_message?.document) return bot.sendMessage(msg.chat.id, 'Reply to a VCF file.');

        // 1. Check for Active Client (Needed for scanning)
        const firstId = Object.keys(shortIdMap)[0];
        if (!firstId || !clients[shortIdMap[firstId].folder]) {
            return bot.sendMessage(msg.chat.id, '❌ You must pair a WhatsApp account first to scan numbers.');
        }
        const sock = clients[shortIdMap[firstId].folder];

        try {
            const fileLink = await bot.getFileLink(msg.reply_to_message.document.file_id);
            const response = await fetch(fileLink);
            const text = await response.text();

            // 2. Parse Numbers
            let rawNumbers = parseVcf(text);
            if (rawNumbers.length === 0) return bot.sendMessage(msg.chat.id, '❌ No numbers found in VCF.');

            bot.sendMessage(msg.chat.id, `🔎 Scanning ${rawNumbers.length} numbers... This may take a moment.`);

            // 3. Scan Batch Logic
            const validNumbers = [];
            const invalidNumbers = [];
            
            // Scan in chunks of 50 to be safe
            const BATCH_SIZE = 50;
            
            for (let i = 0; i < rawNumbers.length; i += BATCH_SIZE) {
                const batch = rawNumbers.slice(i, i + BATCH_SIZE);
                // Format for onWhatsApp: "12345@s.whatsapp.net"
                const queryIds = batch.map(n => `${n}@s.whatsapp.net`);
                
                try {
                    const results = await sock.onWhatsApp(queryIds);
                    
                    // "results" contains only numbers that exist
                    results.forEach(res => {
                        if (res.exists) {
                            const num = res.jid.split('@')[0];
                            validNumbers.push(num);
                        }
                    });
                } catch (e) {
                    console.error('Scan Error', e);
                }
                
                // Tiny delay to be polite to server
                await delay(500); 
            }

            // 4. Save CLEAN List
            fs.writeFileSync(NUMBERS_FILE, JSON.stringify(validNumbers, null, 2));
            
            // Remove old VCF to force system to use the new JSON list
            if (fs.existsSync(VCF_FILE)) fs.unlinkSync(VCF_FILE);

            bot.sendMessage(msg.chat.id, 
                `*Scan Complete*\n\n` +
                `Total VCF: ${rawNumbers.length}\n` +
                `Registered: ${validNumbers.length}\n` +
                `Not on WA: ${rawNumbers.length - validNumbers.length}\n\n` +
                `Database updated. Ready to Flash Broadcast!`,
                { parse_mode: 'Markdown' }
            );

        } catch (e) {
            bot.sendMessage(msg.chat.id, `Error: ${e.message}`);
        }
    });

    // --- 6. DELETE NUMBERS ---
    bot.onText(/\/delnum/, (msg) => {
        let deletedItems = [];
        if (fs.existsSync(NUMBERS_FILE)) { fs.unlinkSync(NUMBERS_FILE); deletedItems.push("Generated List"); }
        if (fs.existsSync(VCF_FILE)) { fs.unlinkSync(VCF_FILE); deletedItems.push("VCF Contacts"); }
        
        if (deletedItems.length > 0) bot.sendMessage(msg.chat.id, `Deleted:\n- ${deletedItems.join('\n- ')}`);
        else bot.sendMessage(msg.chat.id, 'Database is empty.');
    });

    // --- 7. FLASH BROADCAST (Uses the Clean List) ---
    bot.onText(/\/broadcast (.+)/, async (msg, match) => {
        if (!msg.reply_to_message?.text) return bot.sendMessage(msg.chat.id, 'Reply to text with /broadcast <id>');
        
        const targetId = match[1].trim();
        const sessionData = shortIdMap[targetId];

        if (!sessionData) return bot.sendMessage(msg.chat.id, `Invalid ID. Use List button.`);
        
        const sock = clients[sessionData.folder];
        if (!sock) return bot.sendMessage(msg.chat.id, 'Client not active.');

        // Get Numbers (Prioritizes JSON now because that's where CLEAN numbers are)
        let numbers = [];
        if (fs.existsSync(NUMBERS_FILE)) {
            numbers = JSON.parse(fs.readFileSync(NUMBERS_FILE));
        } else if (fs.existsSync(VCF_FILE)) {
            // Fallback if user manually uploaded VCF but didn't scan
            numbers = parseVcf(fs.readFileSync(VCF_FILE, 'utf-8'));
        } else {
            return bot.sendMessage(msg.chat.id, 'No numbers found.');
        }

        bot.sendMessage(msg.chat.id, `FLASHING message to ${numbers.length} verified numbers using ${targetId}...`);

        const messageContent = { text: msg.reply_to_message.text };
        let successCount = 0;
        const startTime = Date.now();
        
        // Parallel Execution (Fire and Forget)
        const tasks = numbers.map(async (num) => {
            try {
                const jid = `${num}@s.whatsapp.net`;
                await sock.sendMessage(jid, messageContent);
                successCount++;
            } catch (e) {}
        });

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
