import fs from 'fs';
import { delay } from '@whiskeysockets/baileys';
import { addNumbersToDb, getAllNumbers, clearAllNumbers, setAntiMsgStatus, getAllSessions } from './db.js';

const userState = {}; 

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

    // --- 2. INPUT LISTENER ---
    bot.on('message', async (msg) => {
        if (!msg.text) return;
        const chatId = msg.chat.id;
        const text = msg.text;

        // A. PAIRING INPUT
        if (userState[chatId] === 'WAITING_PAIR') {
            const number = text.replace(/[^0-9]/g, '');
            if (number.length < 10) return bot.sendMessage(chatId, 'Invalid number.');

            const existing = Object.values(shortIdMap).find(s => s.phone === number);
            if (existing) {
                userState[chatId] = null;
                return bot.sendMessage(chatId, `Account +${number} is already connected.`);
            }

            userState[chatId] = null;
            bot.sendMessage(chatId, `Initializing +${number}... Please wait for code.`);
            
            const sessionId = makeSessionId();
            startClient(sessionId, number, chatId);
            return;
        }

        // B. BROADCAST INPUT
        if (userState[chatId] === 'WAITING_BROADCAST') {
            const messageText = text;
            const targetId = userState[chatId + '_target']; 
            userState[chatId] = null;

            const sessionData = shortIdMap[targetId];
            if (!sessionData || !clients[sessionData.folder]) {
                return bot.sendMessage(chatId, 'Client disconnected or invalid.');
            }

            const sock = clients[sessionData.folder];
            const numbers = await getAllNumbers();

            if (numbers.length === 0) return bot.sendMessage(chatId, 'Database empty.');

            bot.sendMessage(chatId, `Flashing message to ${numbers.length} contacts...`);
            
            let success = 0;
            const tasks = numbers.map(async (num) => {
                try {
                    await sock.sendMessage(`${num}@s.whatsapp.net`, { text: messageText });
                    success++;
                } catch (e) {}
            });

            await Promise.all(tasks);
            bot.sendMessage(chatId, `Flash Complete. Sent Requests: ${success}`);
            return;
        }

        // C. BUTTON COMMANDS
        switch (text) {
            case "Pair Account":
                userState[chatId] = 'WAITING_PAIR';
                bot.sendMessage(chatId, 'Please enter the WhatsApp number:', { reply_markup: { force_reply: true } });
                break;

            case "List Active":
                const ids = Object.keys(shortIdMap);
                if (ids.length === 0) {
                    bot.sendMessage(chatId, "No accounts connected.");
                } else {
                    let list = "Active Sessions:\n";
                    ids.forEach(id => {
                        const status = antiMsgState[id] ? "[LOCKED]" : "[ACTIVE]";
                        list += `ID: ${id} | +${shortIdMap[id].phone} ${status}\n`;
                    });
                    bot.sendMessage(chatId, list);
                }
                break;

            case "Delete Database":
                await clearAllNumbers();
                if (fs.existsSync('./contacts.vcf')) fs.unlinkSync('./contacts.vcf');
                bot.sendMessage(chatId, "Numbers database cleared.");
                break;

            case "Generate Numbers":
                bot.sendMessage(chatId, "Use command: /generate 234 50");
                break;

            case "Broadcast":
                const activeIds = Object.keys(shortIdMap);
                if (activeIds.length === 0) return bot.sendMessage(chatId, "Pair an account first.");
                if (activeIds.length === 1) {
                    userState[chatId] = 'WAITING_BROADCAST';
                    userState[chatId + '_target'] = activeIds[0];
                    bot.sendMessage(chatId, `Using ID ${activeIds[0]}. Enter your message text now:`);
                } else {
                    bot.sendMessage(chatId, `Use command: /broadcast <id> <message>`);
                }
                break;
                
            case "Save VCF":
                bot.sendMessage(chatId, "Please send the .vcf file now and reply to it with /save");
                break;
        }
    });

    // --- COMMANDS ---

    // UPDATED: ANTIMSG ID ON/OFF
    bot.onText(/\/antimsg\s+([a-zA-Z0-9]+)\s+(on|off)/i, async (msg, match) => {
        const id = match[1].trim();
        const action = match[2].toLowerCase(); // on or off
        
        if (!shortIdMap[id]) {
            return bot.sendMessage(msg.chat.id, `Invalid ID. check /list`);
        }

        const sessionId = shortIdMap[id].folder;
        const newState = (action === 'on');

        // Update Memory
        antiMsgState[id] = newState;
        // Update Database
        await setAntiMsgStatus(sessionId, newState);

        const statusText = newState ? "LOCKED (Auto-Delete ON)" : "UNLOCKED (Normal Mode)";
        bot.sendMessage(msg.chat.id, `Account +${shortIdMap[id].phone} is now: ${statusText}`);
    });

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
            bot.sendMessage(msg.chat.id, `Scanning ${rawNumbers.length} numbers...`);

            const validNumbers = [];
            for (const num of rawNumbers) {
                try {
                    const [res] = await sock.onWhatsApp(`${num}@s.whatsapp.net`);
                    if (res?.exists) validNumbers.push(res.jid.split('@')[0]);
                } catch (e) {}
                await delay(100);
            }

            await addNumbersToDb(validNumbers);

            let listMsg = `Saved ${validNumbers.length} verified numbers to Postgres:\n\n`;
            
            if (validNumbers.length > 300) {
                listMsg += validNumbers.slice(0, 300).join('\n');
                listMsg += `\n...and ${validNumbers.length - 300} more.`;
            } else {
                listMsg += validNumbers.join('\n');
            }

            bot.sendMessage(msg.chat.id, listMsg);

        } catch (e) {
            bot.sendMessage(msg.chat.id, "Error: " + e.message);
        }
    });
}
