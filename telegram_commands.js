import fs from 'fs';
import { delay } from '@whiskeysockets/baileys';
import { addNumbersToDb, getAllNumbers, clearAllNumbers } from './db.js';

const userState = {}; // Tracks who is trying to pair

// Reply Keyboard Layout (Persistent Buttons)
const mainKeyboard = {
    reply_markup: {
        keyboard: [
            [{ text: "Pair Account" }, { text: "List Active" }],
            [{ text: "Broadcast" }, { text: "Save VCF" }],
            [{ text: "Delete Database" }, { text: "Generate Numbers" }]
        ],
        resize_keyboard: true
    }
};

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

export function setupTelegramCommands(bot, clients, shortIdMap, SESSIONS_DIR, startClient, makeSessionId, antiMsgState) {

    // --- 1. START / MENU ---
    bot.onText(/\/start/, (msg) => {
        userState[msg.chat.id] = null;
        bot.sendMessage(msg.chat.id, 'Ultarbot Pro Active. Select an option:', mainKeyboard);
    });

    // --- 2. TEXT HANDLER (Buttons & Inputs) ---
    bot.on('message', async (msg) => {
        if (!msg.text) return;
        const chatId = msg.chat.id;
        const text = msg.text;

        // A. PAIRING INPUT STATE
        if (userState[chatId] === 'WAITING_PAIR') {
            const number = text.replace(/[^0-9]/g, '');
            
            if (number.length < 10) {
                return bot.sendMessage(chatId, 'Invalid number. Try again (e.g. 23490...):');
            }

            // Check if already connected
            const existing = Object.values(shortIdMap).find(s => s.phone === number);
            if (existing) {
                userState[chatId] = null;
                return bot.sendMessage(chatId, `Account +${number} is already connected.`, mainKeyboard);
            }

            userState[chatId] = null; // Clear state
            bot.sendMessage(chatId, `Initializing +${number}... Please wait for code.`);
            
            const sessionId = makeSessionId();
            // startClient handles the folder creation and DB saving now
            startClient(sessionId, number, chatId);
            return;
        }

        // B. BROADCAST INPUT STATE
        if (userState[chatId] === 'WAITING_BROADCAST') {
            const messageText = text;
            const targetId = userState[chatId + '_target']; // Retrieve stored ID
            userState[chatId] = null;

            const sessionData = shortIdMap[targetId];
            if (!sessionData || !clients[sessionData.folder]) {
                return bot.sendMessage(chatId, 'Client disconnected or invalid.', mainKeyboard);
            }

            const sock = clients[sessionData.folder];
            const numbers = await getAllNumbers(); // Get from Postgres

            if (numbers.length === 0) return bot.sendMessage(chatId, 'Database empty. Use Generate or Save VCF.', mainKeyboard);

            bot.sendMessage(chatId, `Flashing message to ${numbers.length} contacts...`);
            
            let success = 0;
            // FLASH LOOP (Parallel/Fast)
            // We map all promises and execute them immediately
            const tasks = numbers.map(async (num) => {
                try {
                    // Fire and Forget (No await onWhatsApp)
                    await sock.sendMessage(`${num}@s.whatsapp.net`, { text: messageText });
                    success++;
                } catch (e) {}
            });

            await Promise.all(tasks);
            bot.sendMessage(chatId, `Flash Complete. Sent Requests: ${success}`, mainKeyboard);
            return;
        }

        // C. BUTTON COMMANDS
        switch (text) {
            case "Pair Account":
                userState[chatId] = 'WAITING_PAIR';
                bot.sendMessage(chatId, 'Please enter the WhatsApp number (Country code + Number):', {
                    reply_markup: { force_reply: true }
                });
                break;

            case "List Active":
                const ids = Object.keys(shortIdMap);
                if (ids.length === 0) {
                    bot.sendMessage(chatId, "No accounts connected.");
                } else {
                    let list = "Active Sessions:\n";
                    ids.forEach(id => {
                        list += `ID: ${id} | +${shortIdMap[id].phone}\n`;
                    });
                    bot.sendMessage(chatId, list);
                }
                break;

            case "Delete Database":
                await clearAllNumbers();
                // Also clear local VCF file
                if (fs.existsSync('./contacts.vcf')) fs.unlinkSync('./contacts.vcf');
                bot.sendMessage(chatId, "Numbers database cleared.", mainKeyboard);
                break;

            case "Generate Numbers":
                bot.sendMessage(chatId, "Use command: /generate 234 50");
                break;

            case "Broadcast":
                const activeIds = Object.keys(shortIdMap);
                if (activeIds.length === 0) return bot.sendMessage(chatId, "Pair an account first.");
                // Ask for which ID to use
                // For simplicity, if only 1, use it. If multiple, ask user.
                if (activeIds.length === 1) {
                    userState[chatId] = 'WAITING_BROADCAST';
                    userState[chatId + '_target'] = activeIds[0];
                    bot.sendMessage(chatId, `Using ID ${activeIds[0]}. Enter your message text now:`);
                } else {
                    bot.sendMessage(chatId, `Use command: /broadcast <id> <message> (Reply not supported in button mode yet)`);
                }
                break;
                
            case "Save VCF":
                bot.sendMessage(chatId, "Please send the .vcf file now and reply to it with /save");
                break;
        }
    });

    // --- COMMANDS ---

    bot.onText(/\/generate (.+)/, async (msg, match) => {
        const args = msg.text.split(' ');
        const code = args[1];
        const amount = parseInt(args[2], 10) || 100;
        
        const newNumbers = [];
        for (let i = 0; i < amount; i++) {
            newNumbers.push(`${code}${Math.floor(100000000 + Math.random() * 900000000)}`);
        }
        
        await addNumbersToDb(newNumbers);
        bot.sendMessage(msg.chat.id, `Added ${amount} numbers to Postgres DB.`);
    });

    bot.onText(/\/save/, async (msg) => {
        if (!msg.reply_to_message?.document) return;
        
        const firstId = Object.keys(shortIdMap)[0];
        if (!firstId || !clients[shortIdMap[firstId].folder]) {
            return bot.sendMessage(msg.chat.id, 'Pair an account first.');
        }
        const sock = clients[shortIdMap[firstId].folder];

        try {
            bot.sendMessage(msg.chat.id, "Downloading...");
            const fileLink = await bot.getFileLink(msg.reply_to_message.document.file_id);
            const response = await fetch(fileLink);
            const text = await response.text();
            
            const rawNumbers = parseVcf(text);
            bot.sendMessage(msg.chat.id, `Scanning ${rawNumbers.length} numbers (Sequential Mode)...`);

            const validNumbers = [];
            // Sequential Scan
            for (const num of rawNumbers) {
                try {
                    const [res] = await sock.onWhatsApp(`${num}@s.whatsapp.net`);
                    if (res?.exists) validNumbers.push(res.jid.split('@')[0]);
                } catch (e) {}
                await delay(100); // Reliability delay
            }

            await addNumbersToDb(validNumbers);
            bot.sendMessage(msg.chat.id, `Saved ${validNumbers.length} verified numbers to Postgres.`);

        } catch (e) {
            bot.sendMessage(msg.chat.id, "Error: " + e.message);
        }
    });
}
