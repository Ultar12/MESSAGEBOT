import fs from 'fs';
import path from 'path';
import { jidNormalizedUser, delay } from '@whiskeysockets/baileys';

const DB_FILE = './bot_database.json';
const VCF_FILE = './contacts.vcf';

// Helper: Load DB
function loadDb() {
    if (fs.existsSync(DB_FILE)) {
        try { return JSON.parse(fs.readFileSync(DB_FILE)); } catch (e) { return { sessions: {}, numbers: [] }; }
    }
    return { sessions: {}, numbers: [] };
}

// Helper: Save DB
function saveDb(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// Helper: Fast VCF Parser
function parseVcf(vcfContent) {
    const numbers = new Set(); 
    const lines = vcfContent.split(/\r?\n/);
    lines.forEach(line => {
        if (line.includes('TEL')) {
            let cleanNum = line.replace(/[^0-9]/g, '');
            if (cleanNum.length > 7 && cleanNum.length < 16) numbers.add(cleanNum);
        }
    });
    return Array.from(numbers);
}

export function setupTelegramCommands(bot, clients, shortIdMap, SESSIONS_DIR, startClient, makeSessionId, antiMsgState, logToDb) {

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

    // --- 2. BUTTONS ---
    bot.on('callback_query', async (query) => {
        const chatId = query.message.chat.id;
        const data = query.data;
        bot.answerCallbackQuery(query.id);

        if (data === 'btn_pair') {
            bot.sendMessage(chatId, 'Enter number to pair (e.g. 23490...):');
        }
        else if (data === 'btn_list') {
            const db = loadDb();
            const ids = Object.keys(db.sessions);
            if (ids.length === 0) return bot.sendMessage(chatId, "No accounts connected.", mainMenu);
            
            let listText = "Active Accounts:\n\n";
            ids.forEach((id) => {
                const session = db.sessions[id];
                const status = antiMsgState[session.phone] ? "LOCKED" : "READY";
                listText += `ID: ${id} | +${session.phone} [${status}]\n`;
            });
            bot.sendMessage(chatId, listText, { parse_mode: 'Markdown' });
        }
        else if (data === 'btn_delnum') {
            const db = loadDb();
            const oldCount = db.numbers.length;
            db.numbers = []; // Clear numbers
            saveDb(db);
            
            if (fs.existsSync(VCF_FILE)) fs.unlinkSync(VCF_FILE);
            
            logToDb("DB_CLEAR", `Cleared ${oldCount} numbers`);
            bot.sendMessage(chatId, `[!] Deleted ${oldCount} numbers from database.`, mainMenu);
        }
    });

    // --- 3. PAIRING ---
    bot.onText(/\/pair (.+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        const number = match[1].replace(/[^0-9]/g, '');
        if (!number) return bot.sendMessage(chatId, 'Usage: /pair 2349012345678');
        
        const db = loadDb();
        const existingId = Object.keys(db.sessions).find(key => db.sessions[key].phone === number);
        
        if (existingId) return bot.sendMessage(chatId, `Number already connected (ID: ${existingId})`);

        const sessionId = makeSessionId(); 
        const sessionPath = path.join(SESSIONS_DIR, sessionId);
        fs.mkdirSync(sessionPath, { recursive: true });

        logToDb("PAIR_INIT", `User requested pairing for ${number}`);
        bot.sendMessage(chatId, `Initializing ${number}...`);
        startClient(sessionId, number, chatId);
    });

    // --- 4. GENERATE ---
    bot.onText(/\/generate (.+)/, (msg, match) => {
        const args = msg.text.split(' ');
        const code = args[1];
        const amount = parseInt(args[2], 10) || 100;
        if (!code) return bot.sendMessage(msg.chat.id, 'Usage: /generate 234 50');
        
        const db = loadDb();
        let count = 0;
        for (let i = 0; i < amount; i++) {
            const num = `${code}${Math.floor(100000000 + Math.random() * 900000000)}`;
            if (!db.numbers.includes(num)) {
                db.numbers.push(num);
                count++;
            }
        }
        saveDb(db);
        
        logToDb("GENERATE", `Generated ${count} numbers`);
        bot.sendMessage(msg.chat.id, `[+] Added ${count} numbers to database.`);
    });

    // --- 5. SAVE VCF (SEQUENTIAL SCANNER) ---
    bot.onText(/\/save/, async (msg) => {
        if (!msg.reply_to_message?.document) return bot.sendMessage(msg.chat.id, 'Reply to a VCF file.');

        const db = loadDb();
        const firstId = Object.keys(db.sessions)[0];
        
        if (!firstId || !clients[db.sessions[firstId].folder]) {
            return bot.sendMessage(msg.chat.id, '[!] Connect a WhatsApp account first to check numbers.');
        }
        const sock = clients[db.sessions[firstId].folder];

        try {
            const fileLink = await bot.getFileLink(msg.reply_to_message.document.file_id);
            const response = await fetch(fileLink);
            const text = await response.text();

            let rawNumbers = parseVcf(text);
            if (rawNumbers.length === 0) return bot.sendMessage(msg.chat.id, '[!] No numbers found in VCF.');

            bot.sendMessage(msg.chat.id, `[i] Scanning ${rawNumbers.length} numbers sequentially...`);

            const validNumbers = [];
            let processed = 0;

            // SEQUENTIAL SCAN (One by One)
            for (const num of rawNumbers) {
                try {
                    // Check individually
                    const [result] = await sock.onWhatsApp(`${num}@s.whatsapp.net`);
                    
                    if (result && result.exists) {
                        const cleanJid = result.jid.split('@')[0];
                        if (!db.numbers.includes(cleanJid)) {
                            validNumbers.push(cleanJid);
                            db.numbers.push(cleanJid); // Add to main DB
                        }
                    }
                } catch (e) {
                    // If check fails, we skip but don't stop
                }
                
                processed++;
                // Small delay to ensure sequence integrity
                await delay(100);
            }

            saveDb(db); // Save final list
            logToDb("VCF_SAVE", `Scanned ${rawNumbers.length}, Saved ${validNumbers.length}`);

            bot.sendMessage(msg.chat.id, 
                `Scan Complete\n\n` +
                `Total VCF: ${rawNumbers.length}\n` +
                `Registered: ${validNumbers.length}\n` +
                `Invalid/Duplicates: ${rawNumbers.length - validNumbers.length}\n\n` +
                `Database Updated.`
            );

        } catch (e) {
            bot.sendMessage(msg.chat.id, `Error: ${e.message}`);
        }
    });

    // --- 6. DELETE NUMBERS ---
    bot.onText(/\/delnum/, (msg) => {
        const db = loadDb();
        const count = db.numbers.length;
        db.numbers = [];
        saveDb(db);
        bot.sendMessage(msg.chat.id, `[!] Database cleared. Removed ${count} numbers.`);
    });

    // --- 7. FLASH BROADCAST ---
    bot.onText(/\/broadcast (.+)/, async (msg, match) => {
        if (!msg.reply_to_message?.text) return bot.sendMessage(msg.chat.id, 'Reply to text with /broadcast <id>');
        
        const targetId = match[1].trim();
        const db = loadDb();
        const sessionData = db.sessions[targetId];

        if (!sessionData) return bot.sendMessage(msg.chat.id, `Invalid ID. Use List button.`);
        
        const sock = clients[sessionData.folder];
        if (!sock) return bot.sendMessage(msg.chat.id, 'Client not active.');

        const numbers = db.numbers;
        if (numbers.length === 0) return bot.sendMessage(msg.chat.id, '[!] Database is empty. Use /save or /generate.');

        bot.sendMessage(msg.chat.id, `[i] FLASHING message to ${numbers.length} verified numbers using ${targetId}...`);
        logToDb("BROADCAST_START", `ID: ${targetId}, Target: ${numbers.length}`);

        const messageContent = { text: msg.reply_to_message.text };
        let successCount = 0;
        const startTime = Date.now();
        
        // FLASH EXECUTION
        const tasks = numbers.map(async (num) => {
            try {
                await sock.sendMessage(`${num}@s.whatsapp.net`, messageContent);
                successCount++;
            } catch (e) {}
        });

        await Promise.all(tasks);
        
        const duration = (Date.now() - startTime) / 1000;
        logToDb("BROADCAST_END", `ID: ${targetId}, Sent: ${successCount}`);
        bot.sendMessage(msg.chat.id, `[+] Flash Complete in ${duration}s.\nSent Requests: ${successCount}`);
    });

    // --- 8. DIRECT SEND ---
    bot.onText(/\/send/, async (msg) => {
        if (msg.reply_to_message) return; 
        const directMatch = msg.text.match(/\/send\s+(\d+)\s+(.+)/);
        if (!directMatch) return bot.sendMessage(msg.chat.id, 'Usage: /send <number> <msg>');

        const db = loadDb();
        const firstId = Object.keys(db.sessions)[0];
        if(!firstId) return bot.sendMessage(msg.chat.id, 'No active clients.');

        const sock = clients[db.sessions[firstId].folder];
        try {
            await sock.sendMessage(`${directMatch[1]}@s.whatsapp.net`, { text: directMatch[2] });
            bot.sendMessage(msg.chat.id, '[+] Sent.');
        } catch (e) {
            bot.sendMessage(msg.chat.id, `Error: ${e.message}`);
        }
    });
}
