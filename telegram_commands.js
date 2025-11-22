import { 
    getAllSessions, getAllNumbers, countNumbers, deleteNumbers, clearAllNumbers,
    getUser, getEarningsStats, getReferrals, updateBank, createWithdrawal,
    setAntiMsgStatus, addNumbersToDb
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

export function setupTelegramCommands(bot, notificationBot, clients, shortIdMap, antiMsgState, startClient, makeSessionId) {

    // --- IMPROVED VERIFY & SAVE ---
    async function verifyAndSaveNumbers(chatId, numbersRaw) {
        const activeId = Object.keys(shortIdMap).find(id => clients[shortIdMap[id].folder]);
        if (!activeId) {
            return bot.sendMessage(chatId, '[ERROR] No connected bot available to verify numbers.');
        }
        const sock = clients[shortIdMap[activeId].folder];

        // Sanitize: Remove +, spaces, dashes
        const cleaned = numbersRaw.map(n => n.replace(/\D/g, '')).filter(n => n.length >= 7);
        const uniqueRaw = [...new Set(cleaned)];
        
        bot.sendMessage(chatId, `[CHECKING] Verifying ${uniqueRaw.length} numbers on WhatsApp...`);

        const validNumbers = [];
        const BATCH_SIZE = 50;

        for (let i = 0; i < uniqueRaw.length; i += BATCH_SIZE) {
            const batch = uniqueRaw.slice(i, i + BATCH_SIZE);
            const jidsToCheck = batch.map(n => `${n}@s.whatsapp.net`);
            
            try {
                // Check if registered
                const results = await sock.onWhatsApp(jidsToCheck);
                
                if (results && results.length > 0) {
                    results.forEach(res => {
                        if (res.exists) validNumbers.push(res.jid.split('@')[0]);
                    });
                }
                await delay(300); 
            } catch (e) {
                // If verification fails network-side, we log it but don't stop
                console.log('Verification check failed for batch, skipping check for this batch.');
            }
        }

        if (validNumbers.length > 0) {
            await addNumbersToDb(validNumbers);
            sendMenu(bot, chatId, `[SAVED]\n\nInput: ${uniqueRaw.length}\nValid WhatsApp: ${validNumbers.length}\nInvalid: ${uniqueRaw.length - validNumbers.length}`);
        } else {
            sendMenu(bot, chatId, `[ERROR] No valid WhatsApp numbers found in this list.`);
        }
    }

    // --- TURBO BROADCAST ---
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
        const startTime = Date.now();
        const successfulNumbers = [];
        const BATCH_SIZE = 50; 
        
        for (let i = 0; i < numbers.length; i += BATCH_SIZE) {
            const batch = numbers.slice(i, i + BATCH_SIZE);
            
            const batchPromises = batch.map(async (num) => {
                try {
                    const jid = `${num}@s.whatsapp.net`;
                    const invisibleSalt = '\u200B'.repeat(Math.floor(Math.random() * 5) + 1);
                    const uniqueRef = `  [Ref:${Math.random().toString(36).substring(2, 7)}]`; 
                    const antiBanTag = invisibleSalt + uniqueRef;
                    
                    if (contentObj.type === 'text') {
                        await sock.sendMessage(jid, { text: contentObj.text + antiBanTag });
                    } 
                    else if (contentObj.type === 'image') {
                        await sock.sendMessage(jid, { 
                            image: contentObj.buffer, 
                            caption: (contentObj.caption || "") + antiBanTag 
                        });
                    } 
                    else if (contentObj.type === 'video') {
                        await sock.sendMessage(jid, { 
                            video: contentObj.buffer, 
                            caption: (contentObj.caption || "") + antiBanTag 
                        });
                    }

                    successfulNumbers.push(num);
                    return true;
                } catch (e) {
                    return false; 
                }
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
            if (reply.text) {
                contentObj = { type: 'text', text: reply.text };
            } 
            else if (reply.photo) {
                bot.sendMessage(chatId, '[LOADING] Downloading Image...');
                const fileId = reply.photo[reply.photo.length - 1].file_id;
                const url = await bot.getFileLink(fileId);
                const buffer = await (await fetch(url)).buffer();
                contentObj = { type: 'image', buffer: buffer, caption: reply.caption || "" };
            } 
            else if (reply.video) {
                bot.sendMessage(chatId, '[LOADING] Downloading Video...');
                const fileId = reply.video.file_id;
                const url = await bot.getFileLink(fileId);
                const buffer = await (await fetch(url)).buffer();
                contentObj = { type: 'video', buffer: buffer, caption: reply.caption || "" };
            }
            else {
                return bot.sendMessage(chatId, "[ERROR] Media type not supported.");
            }
        } else {
            if (inputId) {
                contentObj = { type: 'text', text: inputId };
            } else {
                userState[chatId] = 'WAITING_BROADCAST_MSG';
                userState[chatId + '_target'] = targetId;
                return bot.sendMessage(chatId, `[BROADCAST]\nID: ${targetId}\n\nEnter message:`, { reply_markup: { force_reply: true } });
            }
        }
        if (contentObj) executeBroadcast(chatId, targetId, contentObj);
    });

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

    bot.onText(/\/save/, async (msg) => {
        if (msg.chat.id.toString() !== ADMIN_ID) return;
        if (msg.reply_to_message && msg.reply_to_message.document) {
            bot.sendMessage(msg.chat.id, '[PROCESSING] File...');
            try {
                 const fileUrl = await bot.getFileLink(msg.reply_to_message.document.file_id);
                 const res = await fetch(fileUrl);
                 const text = await res.text();
                 // Improved Regex to catch numbers with/without +
                 const extracted = text.match(/(?:\+|)\d{10,15}/g);
                 if (extracted) await verifyAndSaveNumbers(msg.chat.id, extracted);
            } catch (e) { bot.sendMessage(msg.chat.id, `Error: ${e.message}`); }
        } else if (msg.reply_to_message && msg.reply_to_message.text) {
             const extracted = msg.reply_to_message.text.match(/(?:\+|)\d{10,15}/g);
             if (extracted) await verifyAndSaveNumbers(msg.chat.id, extracted);
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
        sendMenu(bot, msg.chat.id, 'Welcome to Ultarbot Pro.');
    });

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

        if (userState[chatId] === 'WAITING_BANK_DETAILS') {
            const parts = text.split('|');
            if (parts.length !== 3) return sendMenu(bot, chatId, 'Use: Bank | Account | Name');
            await updateBank(userId, parts[0].trim(), parts[1].trim(), parts[2].trim());
            userState[chatId] = null;
            sendMenu(bot, chatId, '[SAVED] Bank details.');
            return;
        }

        if (userState[chatId] === 'WAITING_WITHDRAW_AMOUNT') {
            const amount = parseInt(text);
            const user = await getUser(userId);
            if (isNaN(amount) || amount < 1000) return sendMenu(bot, chatId, `Min 1000 pts.`);
            if (user.points < amount) return sendMenu(bot, chatId, `Insufficient balance.`);
            const ngnValue = amount * 0.6;
            const wid = await createWithdrawal(userId, amount, ngnValue);
            notificationBot.sendMessage(ADMIN_ID, `[WITHDRAWAL] ID: ${wid}\nUser: ${userId}\nAmt: NGN ${ngnValue}`);
            userState[chatId] = null;
            sendMenu(bot, chatId, `[SENT] Request #${wid}`);
            return;
        }

        switch (text) {
            case "Connect Account":
                userState[chatId] = 'WAITING_PAIR';
                bot.sendMessage(chatId, 'Enter WhatsApp number:', { reply_markup: { force_reply: true } });
                break;

            case "My Account":
                const mySessions = await getAllSessions(userId);
                let accMsg = `[MY ACCOUNTS]\n\n`;
                if (mySessions.length === 0) accMsg += "No active accounts.";
                else {
                    mySessions.forEach(s => {
                         const id = Object.keys(shortIdMap).find(k => shortIdMap[k].folder === s.session_id);
                         const dur = getDuration(s.connected_at);
                         if(id) accMsg += `ID: ${id}\nNUM: +${s.phone}\nTIME: ${dur}\n\n`;
                    });
                }
                sendMenu(bot, chatId, accMsg);
                break;

            case "List All":
                if (!isUserAdmin) return;
                const allSessions = await getAllSessions(null);
                const totalNums = await countNumbers();
                let list = `[STATS]\nDB Contacts: ${totalNums}\n\n[BOTS]\n\n`;
                if (allSessions.length === 0) list += "No bots connected.";
                allSessions.forEach(s => {
                    const id = Object.keys(shortIdMap).find(k => shortIdMap[k].folder === s.session_id);
                    const dur = getDuration(s.connected_at);
                    const status = clients[s.session_id] ? '[ON]' : '[OFF]';
                    const anti = s.antimsg ? '[LOCKED]' : '[OPEN]';
                    if(id) list += `${status} ${id} | +${s.phone}\n${anti} AntiMsg | ${dur}\n------------------\n`;
                });
                sendMenu(bot, chatId, list);
                break;

            case "Broadcast":
                const activeIds = isUserAdmin ? Object.keys(shortIdMap) : Object.keys(shortIdMap).filter(id => shortIdMap[id].chatId === userId);
                if (activeIds.length === 0) return sendMenu(bot, chatId, "[ERROR] No active bots.");
                userState[chatId] = 'WAITING_BROADCAST_MSG';
                userState[chatId + '_target'] = activeIds[0];
                bot.sendMessage(chatId, `[BROADCAST]\nBot ID: ${activeIds[0]}\n\nEnter message:`, { reply_markup: { force_reply: true } });
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

    bot.on('document', async (msg) => {
        if (msg.chat.id.toString() !== ADMIN_ID) return;
        const caption = msg.caption || "";
        if (caption.startsWith('/save')) {
            bot.sendMessage(msg.chat.id, '[EXTRACTING]...');
            try {
                const fileUrl = await bot.getFileLink(msg.document.file_id);
                const res = await fetch(fileUrl);
                const text = await res.text();
                const extracted = text.match(/(?:\+|)\d{10,15}/g);
                if (extracted) await verifyAndSaveNumbers(msg.chat.id, extracted);
                else bot.sendMessage(msg.chat.id, '[ERROR] No numbers.');
            } catch (e) {
                bot.sendMessage(msg.chat.id, `Error: ${e.message}`);
            }
        }
    });
}
