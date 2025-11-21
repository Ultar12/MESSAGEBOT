import fs from 'fs';
import { delay } from '@whiskeysockets/baileys';
import { addNumbersToDb, getAllNumbers, clearAllNumbers } from './db.js';

const userState = {}; 

// Persistent Keyboard (Buttons)
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

    // --- 1. START ---
    bot.onText(/\/start/, (msg) => {
        userState[msg.chat.id] = null;
        bot.sendMessage(msg.chat.id, 'Ultarbot Pro Active. Select an option:', mainKeyboard);
    });

    // --- 2. INPUT LISTENER (Fixes the "Nothing Happens" bug) ---
    bot.on('message', async (msg) => {
        if (!msg.text) return;
        
        const chatId = msg.chat.id;
        const text = msg.text;

        // PRIORITY 1: CHECK STATE (Are we waiting for a number?)
        if (userState[chatId] === 'WAITING_PAIR') {
            // Remove spaces, dashes, plus signs
            const number = text.replace(/[^0-9]/g, '');
            
            // Validate
            if (number.length < 10) {
                return bot.sendMessage(chatId, 'Invalid format. Please send only the number (e.g. 2349012345678).');
            }

            // Check duplicates
            const existing = Object.values(shortIdMap).find(s => s.phone === number);
            if (existing) {
                userState[chatId] = null; // Reset state
                return bot.sendMessage(chatId, `Account +${number} is already connected.`, mainKeyboard);
            }

            // Proceed
            userState[chatId] = null; // Reset state
            bot.sendMessage(chatId, `Initializing +${number}... Code coming soon.`);
            
            const sessionId = makeSessionId();
            startClient(sessionId, number, chatId);
            return; // Stop here, don't process other commands
        }

        // PRIORITY 2: BUTTON HANDLERS
        switch (text) {
            case "Pair Account":
                userState[chatId] = 'WAITING_PAIR';
                bot.sendMessage(chatId, 'Please reply with your WhatsApp number (Country Code + Number):', {
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
                if (fs.existsSync('./contacts.vcf')) fs.unlinkSync('./contacts.vcf');
                bot.sendMessage(chatId, "Numbers database cleared.", mainKeyboard);
                break;

            case "Generate Numbers":
                bot.sendMessage(chatId, "Use command: /generate 234 50");
                break;

            case "Broadcast":
                const activeIds = Object.keys(shortIdMap);
                if (activeIds.length === 0) return bot.sendMessage(chatId, "Pair an account first.");
                
                // Pick first available for now
                const targetId = activeIds[0];
                const sock = clients[shortIdMap[targetId].folder];
                const numbers = await getAllNumbers();

                if (numbers.length === 0) return bot.sendMessage(chatId, "Database empty.", mainKeyboard);

                bot.sendMessage(chatId, `Flashing message to ${numbers.length} contacts using ID ${targetId}...\n\nPlease wait.`);
                
                let success = 0;
                const tasks = numbers.map(async (num) => {
                    try {
                        await sock.sendMessage(`${num}@s.whatsapp.net`, { text: "Hello" }); // Update text logic if needed
                        success++;
                    } catch (e) {}
                });

                await Promise.all(tasks);
                bot.sendMessage(chatId, `Flash Complete. Sent: ${success}`, mainKeyboard);
                break;
                
            case "Save VCF":
                bot.sendMessage(chatId, "Please send the .vcf file now and reply to it with /save");
                break;
        }
    });

    // --- COMMANDS (Manual override) ---
    
    bot.onText(/\/generate (.+)/, async (msg, match) => {
        const args = msg.text.split(' ');
        const code = args[1];
        const amount = parseInt(args[2], 10) || 100;
        
        const newNumbers = [];
        for (let i = 0; i < amount; i++) {
            newNumbers.push(`${code}${Math.floor(100000000 + Math.random() * 900000000)}`);
        }
        await addNumbersToDb(newNumbers);
        bot.sendMessage(msg.chat.id, `Added ${amount} numbers to DB.`);
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
            for (const num of rawNumbers) {
                try {
                    const [res] = await sock.onWhatsApp(`${num}@s.whatsapp.net`);
                    if (res?.exists) validNumbers.push(res.jid.split('@')[0]);
                } catch (e) {}
                await delay(100);
            }

            await addNumbersToDb(validNumbers);
            bot.sendMessage(msg.chat.id, `Saved ${validNumbers.length} verified numbers.`);

        } catch (e) {
            bot.sendMessage(msg.chat.id, "Error: " + e.message);
        }
    });
}
