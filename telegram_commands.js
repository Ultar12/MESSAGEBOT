import fs from 'fs';
import { delay } from '@whiskeysockets/baileys';
import { addNumbersToDb, getAllNumbers, clearAllNumbers, setAntiMsgStatus, setAutoSaveStatus, countNumbers, deleteNumbers } from './db.js';

const userState = {}; 

const mainKeyboard = {
    reply_markup: {
        keyboard: [
            [{ text: "Pair Account" }, { text: "List Active" }],
            [{ text: "Broadcast" }, { text: "Delete Database" }]
        ],
        resize_keyboard: true
    }
};

// HELPER: Chunk Array for Batching
function chunkArray(myArray, chunk_size){
    var index = 0;
    var arrayLength = myArray.length;
    var tempArray = [];
    
    for (index = 0; index < arrayLength; index += chunk_size) {
        myChunk = myArray.slice(index, index+chunk_size);
        tempArray.push(myChunk);
    }
    return tempArray;
}

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

// --- HELPER: EXECUTE TURBO BROADCAST ---
async function executeBroadcast(bot, clients, shortIdMap, chatId, targetId, messageText) {
    const sessionData = shortIdMap[targetId];
    if (!sessionData || !clients[sessionData.folder]) {
        return bot.sendMessage(chatId, 'Client disconnected or invalid ID.', mainKeyboard);
    }

    const sock = clients[sessionData.folder];
    const numbers = await getAllNumbers();

    if (numbers.length === 0) return bot.sendMessage(chatId, 'Database empty.', mainKeyboard);

    bot.sendMessage(chatId, `Turbo-Flashing message to ${numbers.length} contacts using ID ${targetId}...`);
    
    let successCount = 0;
    const startTime = Date.now();
    const successfulNumbers = [];

    // --- TURBO BATCH LOGIC ---
    // 1. Batch Size: 10 messages per burst
    // 2. Delay: 1 second between bursts
    // This prevents the "Missing Messages" issue while staying fast.
    
    const BATCH_SIZE = 10; 
    
    for (let i = 0; i < numbers.length; i += BATCH_SIZE) {
        const batch = numbers.slice(i, i + BATCH_SIZE);
        
        // Create parallel tasks for this batch only
        const batchTasks = batch.map(async (num) => {
            try {
                await sock.sendMessage(`${num}@s.whatsapp.net`, { text: messageText });
                successfulNumbers.push(num);
                successCount++;
            } catch (e) {}
        });

        // Fire this batch instantly
        await Promise.all(batchTasks);
        
        // Cool down to let WhatsApp sync
        await delay(1000); 
    }

    const duration = (Date.now() - startTime) / 1000;

    // CLEANUP
    if (successfulNumbers.length > 0) {
        await deleteNumbers(successfulNumbers);
    }

    bot.sendMessage(chatId, 
        `Flash Complete in ${duration}s.\n` +
        `Sent: ${successCount}\n` +
        `Database Cleaned: ${successfulNumbers.length} numbers removed.`, 
        mainKeyboard
    );
}

export function setupTelegramCommands(bot, clients, shortIdMap, SESSIONS_DIR, startClient, makeSessionId, antiMsgState, autoSaveState) {

    bot.onText(/\/start/, (msg) => {
        userState[msg.chat.id] = null;
        bot.sendMessage(msg.chat.id, 'Ultarbot Pro Active.', mainKeyboard);
    });

    bot.on('message', async (msg) => {
        if (!msg.text) return;
        const chatId = msg.chat.id;
        const text = msg.text;

        if (userState[chatId] === 'WAITING_PAIR') {
            const number = text.replace(/[^0-9]/g, '');
            if (number.length < 10) return bot.sendMessage(chatId, 'Invalid number.');

            const existing = Object.values(shortIdMap).find(s => s.phone === number);
            if (existing) {
                userState[chatId] = null;
                return bot.sendMessage(chatId, `Account +${number} is already connected.`, mainKeyboard);
            }

            userState[chatId] = null;
            bot.sendMessage(chatId, `Initializing +${number}... Please wait for code.`);
            const sessionId = makeSessionId();
            startClient(sessionId, number, chatId);
            return;
        }

        if (userState[chatId] === 'WAITING_BROADCAST_MSG') {
            const targetId = userState[chatId + '_target']; 
            userState[chatId] = null; 
            await executeBroadcast(bot, clients, shortIdMap, chatId, targetId, text);
            return;
        }

        switch (text) {
            case "Pair Account":
                userState[chatId] = 'WAITING_PAIR';
                bot.sendMessage(chatId, 'Please enter the WhatsApp number:', { reply_markup: { force_reply: true } });
                break;

            case "List Active":
                const ids = Object.keys(shortIdMap);
                const totalNumbers = await countNumbers();
                
                let list = `[ Total Numbers in DB: ${totalNumbers} ]\n\n`;
                if (ids.length === 0) {
                    list += "No accounts connected.";
                } else {
                    list += "Active Sessions:\n";
                    ids.forEach(id => {
                        const session = shortIdMap[id];
                        const antiStatus = antiMsgState[id] ? "LOCKED" : "UNLOCKED";
                        const saveStatus = autoSaveState[id] ? "AUTOSAVE" : "MANUAL";
                        list += `ID: \`${id}\` | +${session.phone}\n[${antiStatus}] [${saveStatus}]\n\n`;
                    });
                }
                bot.sendMessage(chatId, list, { parse_mode: 'Markdown' });
                break;

            case "Delete Database":
                await clearAllNumbers();
                if (fs.existsSync('./contacts.vcf')) fs.unlinkSync('./contacts.vcf');
                bot.sendMessage(chatId, "Numbers database cleared.", mainKeyboard);
                break;

            case "Broadcast":
                const activeIds = Object.keys(shortIdMap);
                if (activeIds.length === 0) return bot.sendMessage(chatId, "Pair an account first.", mainKeyboard);
                
                const autoId = activeIds[0];
                userState[chatId] = 'WAITING_BROADCAST_MSG';
                userState[chatId + '_target'] = autoId;
                
                bot.sendMessage(chatId, `Using Account ID: \`${autoId}\`\n\nPlease enter the message to broadcast:`, { parse_mode: 'Markdown' });
                break;
        }
    });

    // --- COMMANDS ---

    bot.onText(/\/broadcast (.+)/, async (msg, match) => {
        if (!msg.reply_to_message?.text) return bot.sendMessage(msg.chat.id, 'Reply to text with /broadcast <id>');
        const targetId = match[1].trim();
        await executeBroadcast(bot, clients, shortIdMap, msg.chat.id, targetId, msg.reply_to_message.text);
    });

    bot.onText(/\/antimsg\s+([a-zA-Z0-9]+)\s+(on|off)/i, async (msg, match) => {
        const id = match[1].trim();
        const action = match[2].toLowerCase();
        if (!shortIdMap[id]) return bot.sendMessage(msg.chat.id, `Invalid ID.`);

        const sessionId = shortIdMap[id].folder;
        const newState = (action === 'on');
        
        antiMsgState[id] = newState;
        await setAntiMsgStatus(sessionId, newState);

        bot.sendMessage(msg.chat.id, `AntiMsg for \`${id}\` is now ${action.toUpperCase()}.`, { parse_mode: 'Markdown' });
    });

    bot.onText(/\/autosave\s+([a-zA-Z0-9]+)\s+(on|off)/i, async (msg, match) => {
        const id = match[1].trim();
        const action = match[2].toLowerCase();
        if (!shortIdMap[id]) return bot.sendMessage(msg.chat.id, `Invalid ID.`);

        const sessionId = shortIdMap[id].folder;
        const newState = (action === 'on');
        
        autoSaveState[id] = newState;
        await setAutoSaveStatus(sessionId, newState);

        bot.sendMessage(msg.chat.id, `AutoSave for \`${id}\` is now ${action.toUpperCase()}.`, { parse_mode: 'Markdown' });
    });

    bot.onText(/\/generate (.+)/, async (msg, match) => {
        const args = msg.text.split(' ');
        const code = args[1];
        const amount = parseInt(args[2], 10) || 100;
        
        const newNumbers = [];
        for (let i = 0; i < amount; i++) newNumbers.push(`${code}${Math.floor(100000000 + Math.random() * 900000000)}`);
        
        await addNumbersToDb(newNumbers);
        const total = await countNumbers();
        bot.sendMessage(msg.chat.id, `Added ${amount} numbers. (Total: ${total})`);
    });

    bot.onText(/\/save/, async (msg) => {
        if (!msg.reply_to_message?.document) return;
        
        const firstId = Object.keys(shortIdMap)[0];
        if (!firstId || !clients[shortIdMap[firstId].folder]) return bot.sendMessage(msg.chat.id, 'Pair an account first.');
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
            const total = await countNumbers();
            
            let listMsg = `Saved ${validNumbers.length} numbers.\nTotal Database: ${total}\n\nNew Numbers:\n`;
            if (validNumbers.length > 300) listMsg += validNumbers.slice(0, 300).join('\n') + `\n...and ${validNumbers.length - 300} more.`;
            else listMsg += validNumbers.join('\n');

            bot.sendMessage(msg.chat.id, listMsg);
        } catch (e) {
            bot.sendMessage(msg.chat.id, "Error: " + e.message);
        }
    });
}
