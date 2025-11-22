import { 
    getAllSessions, getAllNumbers, countNumbers, deleteNumbers, clearAllNumbers,
    getUser, getEarningsStats, getReferrals, updateBank, createWithdrawal,
    setAntiMsgStatus, addNumbersToDb, getShortId, checkNumberInDb
} from './db.js';
import { delay } from '@whiskeysockets/baileys';
import fetch from 'node-fetch';

const ADMIN_ID = process.env.ADMIN_ID;
const userState = {};

const userKeyboard = {
    keyboard: [
        [{ text: "Connect Account" }, { text: "My Account" }],
        [{ text: "Dashboard" }, { text: "Referrals" }],
        [{ text: "Withdraw" }, { text: "Support" }]
    ],
    resize_keyboard: true
};

const adminKeyboard = {
    keyboard: [
        [{ text: "Connect Account" }, { text: "List All" }],
        [{ text: "Broadcast" }, { text: "Clear Contact List" }]
    ],
    resize_keyboard: true
};

function getKeyboard(chatId) {
    return { reply_markup: (chatId.toString() === ADMIN_ID) ? adminKeyboard : userKeyboard };
}

async function sendMenu(bot, chatId, text) {
    await bot.sendMessage(chatId, text, { ...getKeyboard(chatId), parse_mode: 'Markdown' });
}

function getDuration(startDate) {
    if (!startDate) return "Just now";
    const diff = Date.now() - new Date(startDate).getTime();
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    return `${days}d ${hours}h ${minutes}m`;
}

// --- OLD SAVE LOGIC (STRICT) ---
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

export function setupTelegramCommands(bot, notificationBot, clients, shortIdMap, antiMsgState, startClient, makeSessionId) {

    // --- FLASH BROADCAST ---
    async function executeBroadcast(chatId, targetId, contentObj) {
        const sessionData = shortIdMap[targetId];
        if (!sessionData || !clients[sessionData.folder]) {
            return sendMenu(bot, chatId, '[ERROR] Client disconnected or invalid ID.');
        }
        
        const sock = clients[sessionData.folder];
        const numbers = await getAllNumbers();
        if (numbers.length === 0) return sendMenu(bot, chatId, '[ERROR] Contact list is empty.');

        bot.sendMessage(chatId, `[FLASHING START]\nTargets: ${numbers.length}\nBot ID: ${targetId}`);
        
        let successCount = 0;
        let msgIndex = 1; // Counter for unique messages (1, 2, 3...)
        const startTime = Date.now();
        const successfulNumbers = [];
        const BATCH_SIZE = 50; 
        
        for (let i = 0; i < numbers.length; i += BATCH_SIZE) {
            const batch = numbers.slice(i, i + BATCH_SIZE);
            
            const batchPromises = batch.map(async (num) => {
                try {
                    const jid = `${num}@s.whatsapp.net`;
                    
                    // ANTI-BAN: Invisible space + Simple Counter
                    const invisibleSalt = '\u200B'.repeat(Math.floor(Math.random() * 5) + 1);
                    const simpleRef = ` ${msgIndex++}`; 
                    const antiBanTag = invisibleSalt + simpleRef;
                    
                    if (contentObj.type === 'text') {
                        await sock.sendMessage(jid, { text: contentObj.text + antiBanTag });
                    } 
                    else if (contentObj.type === 'image') {
                        await sock.sendMessage(jid, { image: contentObj.buffer, caption: (contentObj.caption || "") + antiBanTag });
                    } 
                    else if (contentObj.type === 'video') {
                        await sock.sendMessage(jid, { video: contentObj.buffer, caption: (contentObj.caption || "") + antiBanTag });
                    }
                    successfulNumbers.push(num);
                    return true;
                } catch (e) { return false; }
            });

            const results = await Promise.all(batchPromises);
            successCount += results.filter(r => r === true).length;
            await delay(150); 
        }

        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        const speed = (successCount / duration).toFixed(1);

        if (successfulNumbers.length > 0) await deleteNumbers(successfulNumbers);

        sendMenu(bot, chatId, 
            `[BROADCAST COMPLETE]\n` +
            `Time: ${duration}s\n` +
            `Speed: ${speed} msg/sec\n` +
            `Sent: ${successCount}\n` +
            `DB Cleared`
        );
    }

    // --- SLASH COMMANDS ---

    // 1. /checknum <number>
    bot.onText(/\/checknum\s+(\S+)/, async (msg, match) => {
        if (msg.chat.id.toString() !== ADMIN_ID) return;
        const num = match[1].replace(/[^0-9]/g, '');
        if (num.length < 7) return bot.sendMessage(msg.chat.id, '[ERROR] Invalid number.');

        bot.sendMessage(msg.chat.id, `[CHECKING] ${num}...`);
        const exists = await checkNumberInDb(num);
        
        if (exists) sendMenu(bot, msg.chat.id, `[FOUND] ${num} is in the database.`);
        else sendMenu(bot, msg.chat.id, `[NOT FOUND] ${num} is NOT in the database.`);
    });

    // Broadcast
    bot.onText(/\/broadcast(?:\s+(.+))?/, async (msg, match) => {
        if (msg.chat.id.toString() !== ADMIN_ID) return;
        const chatId = msg.chat.id;
        let inputId = match[1] ? match[1].trim() : null;

        const activeIds = Object.keys(shortIdMap).filter(id => clients[shortIdMap[id].folder]);
        if (activeIds.length === 0) return sendMenu(bot, chatId, "[ERROR] No active bots found.");
        
        let targetId = activeIds[0];
        let contentObj = null;

        if (msg.reply_to_message) {
            if (inputId && shortIdMap[inputId]) targetId = inputId; 
            const reply = msg.reply_to_message;
            if (reply.text) contentObj = { type: 'text', text: reply.text };
            else if (reply.photo) {
                bot.sendMessage(chatId, '[LOADING] Image...');
                const fileId = reply.photo[reply.photo.length - 1].file_id;
                const url = await bot.getFileLink(fileId);
                const buffer = await (await fetch(url)).buffer();
                contentObj = { type: 'image', buffer, caption: reply.caption || "" };
            } 
            else if (reply.video) {
                bot.sendMessage(chatId, '[LOADING] Video...');
                const fileId = reply.video.file_id;
                const url = await bot.getFileLink(fileId);
                const buffer = await (await fetch(url)).buffer();
                contentObj = { type: 'video', buffer, caption: reply.caption || "" };
            }
        } else {
            if (inputId) contentObj = { type: 'text', text: inputId };
            else {
                userState[chatId] = 'WAITING_BROADCAST_MSG';
                userState[chatId + '_target'] = targetId;
                return bot.sendMessage(chatId, `[BROADCAST]\nID: ${targetId}\n\nEnter message:`, { reply_markup: { force_reply: true } });
            }
        }
        if (contentObj) executeBroadcast(chatId, targetId, contentObj);
    });

    // Group Adder
    bot.onText(/\/add\s+(\S+)\s+(\S+)/, async (msg, match) => {
        if (msg.chat.id.toString() !== ADMIN_ID) return;
        const chatId = msg.chat.id;
        const acc = match[1];
        let groupLinkOrId = match[2];
        
        let sock = null;
        if (shortIdMap[acc] && clients[shortIdMap[acc].folder]) {
            sock = clients[shortIdMap[acc].folder];
        } else {
            const found = Object.values(shortIdMap).find(s => s.phone === acc);
            if (found && clients[found.folder]) sock = clients[found.folder];
        }

        if (!sock) return bot.sendMessage(chatId, '[ERROR] Account not found.');

        let groupJid = groupLinkOrId;
        if (groupLinkOrId.includes('chat.whatsapp.com')) {
            try {
                const code = groupLinkOrId.split('chat.whatsapp.com/')[1];
                groupJid = await sock.groupAcceptInvite(code);
                bot.sendMessage(chatId, `[JOINED] ID: ${groupJid}`);
            } catch (e) {
                return bot.sendMessage(chatId, `[ERROR] Join Failed: ${e.message}`);
            }
        }

        const numbers = await getAllNumbers();
        if (numbers.length === 0) return bot.sendMessage(chatId, '[ERROR] Database empty.');

        bot.sendMessage(chatId, `[ADDING] ${numbers.length} users (100 / 30s)...`);
        
        let addedCount = 0;
        for (let i = 0; i < numbers.length; i += 100) {
            const batch = numbers.slice(i, i + 100);
            const participants = batch.map(n => `${n}@s.whatsapp.net`);
            try {
                await sock.groupParticipantsUpdate(groupJid, participants, "add");
                addedCount += batch.length;
                bot.sendMessage(chatId, `[OK] Batch ${Math.floor(i/100)+1}`);
                if (i + 100 < numbers.length) await delay(30000);
            } catch (e) {
                bot.sendMessage(chatId, `[FAIL] Batch ${Math.floor(i/100)+1}: ${e.message}`);
            }
        }
        sendMenu(bot, chatId, `[DONE] Added ${addedCount}.`);
    });

    // Save - OLD LOGIC RESTORED
    bot.onText(/\/save/, async (msg) => {
        if (msg.chat.id.toString() !== ADMIN_ID) return;
        
        const firstId = Object.keys(shortIdMap).find(id => clients[shortIdMap[id].folder]);
        if (!firstId) return bot.sendMessage(msg.chat.id, '[ERROR] Pair an account first.');
        const sock = clients[shortIdMap[firstId].folder];

        try {
            let rawText = "";
            if (msg.reply_to_message && msg.reply_to_message.document) {
                bot.sendMessage(msg.chat.id, "[DOWNLOADING]...");
                const fileLink = await bot.getFileLink(msg.reply_to_message.document.file_id);
                const response = await fetch(fileLink);
                rawText = await response.text();
            } else if (msg.document) {
                bot.sendMessage(msg.chat.id, "[DOWNLOADING]...");
                const fileLink = await bot.getFileLink(msg.document.file_id);
                const response = await fetch(fileLink);
                rawText = await response.text();
            } else if (msg.reply_to_message && msg.reply_to_message.text) {
                rawText = msg.reply_to_message.text;
            } else {
                return;
            }
            
            const rawNumbers = parseVcf(rawText);
            if (rawNumbers.length === 0) return bot.sendMessage(msg.chat.id, '[ERROR] No numbers found.');

            bot.sendMessage(msg.chat.id, `[SCANNING] ${rawNumbers.length} numbers (One by One)...`);

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
            
            bot.sendMessage(msg.chat.id, 
                `[SAVED]\n` +
                `Input: ${rawNumbers.length}\n` +
                `Valid: ${validNumbers.length}\n` +
                `Total DB: ${total}`
            );

        } catch (e) {
            bot.sendMessage(msg.chat.id, "Error: " + e.message);
        }
    });

    bot.on('document', async (msg) => {
        if (msg.chat.id.toString() !== ADMIN_ID) return;
        const caption = msg.caption || "";
        if (caption.startsWith('/save')) {
            const firstId = Object.keys(shortIdMap).find(id => clients[shortIdMap[id].folder]);
            if (!firstId) return bot.sendMessage(msg.chat.id, '[ERROR] Pair an account.');
            const sock = clients[shortIdMap[firstId].folder];

            try {
                bot.sendMessage(msg.chat.id, "[DOWNLOADING]...");
                const fileLink = await bot.getFileLink(msg.document.file_id);
                const response = await fetch(fileLink);
                const rawText = await response.text();
                
                const rawNumbers = parseVcf(rawText);
                if (rawNumbers.length === 0) return bot.sendMessage(msg.chat.id, '[ERROR] No numbers.');
                bot.sendMessage(msg.chat.id, `[SCANNING] ${rawNumbers.length} numbers (One by One)...`);
                
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
                bot.sendMessage(msg.chat.id, `[SAVED]\nValid: ${validNumbers.length}\nTotal DB: ${total}`);
            } catch(e) { bot.sendMessage(msg.chat.id, "Error: " + e.message); }
        }
    });

    bot.onText(/\/antimsg\s+([a-zA-Z0-9]+)\s+(on|off)/i, async (msg, match) => {
        if (msg.chat.id.toString() !== ADMIN_ID) return;
        const id = match[1].trim();
        const status = (match[2].toLowerCase() === 'on');
        if (shortIdMap[id]) {
            antiMsgState[id] = status;
            await setAntiMsgStatus(shortIdMap[id].folder, status);
            sendMenu(bot, msg.chat.id, `[ANTIMSG] ${status ? 'ON' : 'OFF'}`);
        }
    });

    bot.onText(/\/start/, (msg) => {
        userState[msg.chat.id] = null;
        sendMenu(bot, msg.chat.id, 'Ultarbot Pro Active.');
    });

    // --- MESSAGE HANDLER (BUTTONS) ---
    bot.on('message', async (msg) => {
        if (!msg.text || msg.text.startsWith('/')) return;
        const chatId = msg.chat.id;
        const text = msg.text;
        const userId = chatId.toString();
        const isUserAdmin = (userId === ADMIN_ID);

        if (userState[chatId] === 'WAITING_PAIR') {
            const number = text.replace(/[^0-9]/g, '');
            if (number.length < 10) return sendMenu(bot, chatId, 'Invalid number.');
            userState[chatId] = null;
            bot.sendMessage(chatId, `Initializing +${number}...`);
            const sessionId = makeSessionId();
            startClient(sessionId, number, chatId, userId);
            return;
        }
        
        if (userState[chatId] === 'WAITING_BROADCAST_MSG') {
            const targetId = userState[chatId + '_target'];
            userState[chatId] = null;
            executeBroadcast(chatId, targetId, { type: 'text', text: text });
            return;
        }

        switch (text) {
            case "Connect Account":
                userState[chatId] = 'WAITING_PAIR';
                bot.sendMessage(chatId, 'Enter WhatsApp number:', { reply_markup: { force_reply: true } });
                break;

            case "List All":
                if (!isUserAdmin) return;
                const allSessions = await getAllSessions(null);
                const totalNums = await countNumbers();
                let list = `[STATS]\nDB Contacts: ${totalNums}\n\n[BOTS]\n\n`;
                
                if (allSessions.length === 0) list += "No bots connected.";
                else {
                    for (const s of allSessions) {
                        let id = Object.keys(shortIdMap).find(k => shortIdMap[k].folder === s.session_id);
                        if (!id) id = await getShortId(s.session_id); 
                        
                        if (id) {
                            const dur = getDuration(s.connected_at);
                            const status = clients[s.session_id] ? '[ON]' : '[OFF]';
                            const anti = s.antimsg ? '[LOCKED]' : '[OPEN]';
                            // Copyable ID with backticks
                            list += `${status} \`${id}\` | +${s.phone}\n${anti} AntiMsg | ${dur}\n------------------\n`;
                        }
                    }
                }
                sendMenu(bot, chatId, list);
                break;

            case "Broadcast":
                const activeIds = isUserAdmin ? Object.keys(shortIdMap) : Object.keys(shortIdMap).filter(id => shortIdMap[id].chatId === userId);
                if (activeIds.length === 0) return sendMenu(bot, chatId, "[ERROR] No active bots.");
                userState[chatId] = 'WAITING_BROADCAST_MSG';
                userState[chatId + '_target'] = activeIds[0];
                bot.sendMessage(chatId, `[BROADCAST]\nID: ${activeIds[0]}\n\nEnter message:`, { reply_markup: { force_reply: true } });
                break;

            case "Dashboard":
                const user = await getUser(userId);
                sendMenu(bot, chatId, `POINTS: ${user.points}`);
                break;

            case "Withdraw":
                const wUser = await getUser(userId);
                if (!wUser.bank_name) {
                    userState[chatId] = 'WAITING_BANK_DETAILS';
                    bot.sendMessage(chatId, `Send: Bank | Account | Name`, { reply_markup: { force_reply: true } });
                } else {
                    userState[chatId] = 'WAITING_WITHDRAW_AMOUNT';
                    bot.sendMessage(chatId, `Enter amount:`, { reply_markup: { force_reply: true } });
                }
                break;

            case "Clear Contact List":
                if(isUserAdmin) {
                    await clearAllNumbers();
                    sendMenu(bot, chatId, "[CLEARED] Database.");
                }
                break;
        }
    });
}
