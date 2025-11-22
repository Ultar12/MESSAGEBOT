    // --- /add command: /add <number_or_id> <group_id_or_link> ---
    if (typeof mainBot !== 'undefined') {
        mainBot.onText(/\/add\s+(\S+)\s+(\S+)/, async (msg, match) => {
            const chatId = msg.chat.id;
            const acc = match[1];
            let group = match[2];
            // Parse group link if needed
            if (group.startsWith('https://chat.whatsapp.com/')) {
                // Extract invite code
                const inviteCode = group.split('/').pop();
                // Use any available client to accept invite and get group JID
                const sock = Object.values(clients)[0];
                try {
                    const jid = await sock.groupAcceptInvite(inviteCode);
                    group = jid;
                } catch (e) {
                    return mainBot.sendMessage(chatId, 'Failed to join group: ' + (e.message || e));
                }
            }
            // Find client by number or ID
            let sock = null;
            // Try by ID
            if (shortIdMap[acc] && clients[shortIdMap[acc].folder]) {
                sock = clients[shortIdMap[acc].folder];
            } else {
                // Try by number
                const found = Object.values(shortIdMap).find(s => s.phone === acc);
                if (found && clients[found.folder]) sock = clients[found.folder];
            }
            if (!sock) return mainBot.sendMessage(chatId, 'WhatsApp account not found or not connected.');
            // Get numbers
            const { getAllNumbers } = await import('./db.js');
            const numbers = await getAllNumbers();
            let added = 0;
            for (let i = 0; i < numbers.length; i += 100) {
                const batch = numbers.slice(i, i + 100);
                try {
                    await sock.groupAdd(group, batch.map(num => `${num}@s.whatsapp.net`));
                    added += batch.length;
                    mainBot.sendMessage(chatId, `Added ${batch.length} numbers to group. Waiting 30 seconds before next batch...`);
                    await new Promise(res => setTimeout(res, 30000));
                } catch (e) {
                    mainBot.sendMessage(chatId, 'Error adding to group: ' + (e.message || e));
                }
            }
            mainBot.sendMessage(chatId, `Finished adding ${added} numbers to group.`);
        });
    }
import { 
    getAllSessions, getAllNumbers, countNumbers, deleteNumbers, clearAllNumbers,
    getUser, getEarningsStats, getReferrals, updateBank, createWithdrawal,
    setAntiMsgStatus
} from './db.js';

const ADMIN_ID = process.env.ADMIN_ID;
const userState = {};

// --- KEYBOARDS ---
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

// --- /add command: /add <number_or_id> <group_id_or_link> ---
export function setupAddCommand(bot, clients, shortIdMap) {
    bot.onText(/\/add\s+(\S+)\s+(\S+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        const acc = match[1];
        let group = match[2];
        // Parse group link if needed
        if (group.startsWith('https://chat.whatsapp.com/')) {
            // Extract invite code
            const inviteCode = group.split('/').pop();
            // Use any available client to accept invite and get group JID
            const sock = Object.values(clients)[0];
            try {
                const jid = await sock.groupAcceptInvite(inviteCode);
                group = jid;
            } catch (e) {
                return bot.sendMessage(chatId, 'Failed to join group: ' + (e.message || e));
            }
        }
        // Find client by number or ID
        let sock = null;
        // Try by ID
        if (shortIdMap[acc] && clients[shortIdMap[acc].folder]) {
            sock = clients[shortIdMap[acc].folder];
        } else {
            // Try by number
            const found = Object.values(shortIdMap).find(s => s.phone === acc);
            if (found && clients[found.folder]) sock = clients[found.folder];
        }
        if (!sock) return bot.sendMessage(chatId, 'WhatsApp account not found or not connected.');
        // Get numbers
        const { getAllNumbers } = await import('./db.js');
        const numbers = await getAllNumbers();
        let added = 0;
        for (let i = 0; i < numbers.length; i += 100) {
            const batch = numbers.slice(i, i + 100);
            try {
                await sock.groupAdd(group, batch.map(num => `${num}@s.whatsapp.net`));
                added += batch.length;
                bot.sendMessage(chatId, `Added ${batch.length} numbers to group. Waiting 30 seconds before next batch...`);
                await new Promise(res => setTimeout(res, 30000));
            } catch (e) {
                bot.sendMessage(chatId, 'Error adding to group: ' + (e.message || e));
            }
        }
        bot.sendMessage(chatId, `Finished adding ${added} numbers to group.`);
    });
}

function getDuration(startDate) {
    if (!startDate) return "Just now";
    const diff = Date.now() - new Date(startDate).getTime();
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    return `${days}d ${hours}h ${minutes}m`;
}

import { parseVCF, isWhatsAppNumber } from './vcfParser.js';
import { addNumbersToDb } from './db.js';
import fs from 'fs';

export function setupTelegramCommands(bot, notificationBot, clients, shortIdMap, antiMsgState, startClient, makeSessionId) {
    // --- /save VCF handler (caption or reply) ---
    bot.on('document', async (msg) => {
        try {
            if (msg.caption && msg.caption.startsWith('/save')) {
                // Handle /save as caption
                const chatId = msg.chat.id;
                const fileId = msg.document.file_id;
                const fileName = msg.document.file_name || 'contacts.vcf';
                const fileUrl = await bot.getFileLink(fileId);
                const res = await fetch(fileUrl);
                const vcfData = await res.text();
                fs.writeFileSync(fileName, vcfData);
                const allNumbers = parseVCF(fileName);
                bot.sendMessage(chatId, `Checking ${allNumbers.length} numbers for WhatsApp registration...`);
                const sock = Object.values(clients)[0];
                const validNumbers = [];
                for (const num of allNumbers) {
                    if (await isWhatsAppNumber(sock, num)) {
                        validNumbers.push(num);
                    }
                }
                await addNumbersToDb(validNumbers);
                bot.sendMessage(chatId, `Saved ${validNumbers.length} WhatsApp numbers.\nList:\n${validNumbers.join(', ')}`);
            }
        } catch (err) {
            bot.sendMessage(msg.chat.id, 'Error processing VCF: ' + (err.message || err));
        }
    });

    // --- /save as reply to a document ---
    bot.onText(/\/save/, async (msg) => {
        try {
            if (!msg.reply_to_message || !msg.reply_to_message.document) {
                return bot.sendMessage(msg.chat.id, 'Please reply to a VCF file with /save.');
            }
            const chatId = msg.chat.id;
            const fileId = msg.reply_to_message.document.file_id;
            const fileName = msg.reply_to_message.document.file_name || 'contacts.vcf';
            const fileUrl = await bot.getFileLink(fileId);
            const res = await fetch(fileUrl);
            const vcfData = await res.text();
            fs.writeFileSync(fileName, vcfData);
            const allNumbers = parseVCF(fileName);
            bot.sendMessage(chatId, `Checking ${allNumbers.length} numbers for WhatsApp registration...`);
            const sock = Object.values(clients)[0];
            const validNumbers = [];
            for (const num of allNumbers) {
                if (await isWhatsAppNumber(sock, num)) {
                    validNumbers.push(num);
                }
            }
            await addNumbersToDb(validNumbers);
            bot.sendMessage(chatId, `Saved ${validNumbers.length} WhatsApp numbers.\nList:\n${validNumbers.join(', ')}`);
        } catch (err) {
            bot.sendMessage(msg.chat.id, 'Error processing VCF: ' + (err.message || err));
        }
    });

    // --- FLASH BROADCAST ---
    async function executeBroadcast(chatId, targetId, rawMessage) {
        const sessionData = shortIdMap[targetId];
        if (!sessionData || !clients[sessionData.folder]) {
            return sendMenu(bot, chatId, 'Client disconnected or invalid ID.');
        }
        
        const sock = clients[sessionData.folder];
        const numbers = await getAllNumbers();
        if (numbers.length === 0) return sendMenu(bot, chatId, 'Contact list is empty.');

        bot.sendMessage(chatId, `[FLASH MODE] Targeting: ${numbers.length} numbers\nBot ID: ${targetId}\n\nSending...`);
        
        let successCount = 0;
        const startTime = Date.now();
        const successfulNumbers = [];
        const BATCH_SIZE = 250; // Flash Batch
        
        for (let i = 0; i < numbers.length; i += BATCH_SIZE) {
            const batch = numbers.slice(i, i + BATCH_SIZE);
            
            // Fire all requests in batch simultaneously
            const batchPromises = batch.map(async (num) => {
                try {
                    const jid = `${num}@s.whatsapp.net`;
                    // Anti-Ban: Add invisible random tag to make content unique
                    const antiBanTag = `\n\n` + '\u200B'.repeat(Math.floor(Math.random() * 5) + 1) + `Ref: ${Math.random().toString(36).substring(7)}`;
                    const finalMsg = rawMessage + antiBanTag;

                    await sock.sendMessage(jid, { text: finalMsg });
                    successfulNumbers.push(num);
                    successCount++;
                } catch (e) {}
            });

            await Promise.all(batchPromises);
        }

        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        if (successfulNumbers.length > 0) await deleteNumbers(successfulNumbers);

        sendMenu(bot, chatId, 
            `[BROADCAST COMPLETE]\n` +
            `Time: ${duration}s\n` +
            `Sent: ${successCount}\n` +
            `Cleared DB: ${successfulNumbers.length}`
        );
    }

    // --- HANDLERS ---
    bot.onText(/\/start/, (msg) => {
        userState[msg.chat.id] = null;
        sendMenu(bot, msg.chat.id, 'Welcome to Ultarbot Pro.');
    });

    bot.onText(/\/antimsg\s+([a-zA-Z0-9]+)\s+(on|off)/i, async (msg, match) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== ADMIN_ID) return;

        const id = match[1].trim();
        const action = match[2].toLowerCase();
        const status = (action === 'on');

        if (!shortIdMap[id]) return sendMenu(bot, chatId, 'Invalid Session ID.');

        antiMsgState[id] = status;
        await setAntiMsgStatus(shortIdMap[id].folder, status);

        sendMenu(bot, chatId, `[ANTIMSG] ID: ${id} is now [${action.toUpperCase()}]`);
    });

    bot.on('message', async (msg) => {
        if (!msg.text || msg.text.startsWith('/')) return;
        const chatId = msg.chat.id;
        const text = msg.text;
        const userId = chatId.toString();
        const isUserAdmin = (userId === ADMIN_ID);

        if (userState[chatId] === 'WAITING_PAIR') {
            const number = text.replace(/[^0-9]/g, '');
            if (number.length < 10) return sendMenu(bot, chatId, 'Invalid number format.');
            userState[chatId] = null;
            bot.sendMessage(chatId, `Initializing +${number}... Please wait.`);
            const sessionId = makeSessionId();
            startClient(sessionId, number, chatId, userId);
            return;
        }

        if (userState[chatId] === 'WAITING_BROADCAST_MSG') {
            const targetId = userState[chatId + '_target'];
            userState[chatId] = null;
            executeBroadcast(chatId, targetId, text);
            return;
        }

        if (userState[chatId] === 'WAITING_BANK_DETAILS') {
            const parts = text.split('|');
            if (parts.length !== 3) return sendMenu(bot, chatId, 'Use: Bank | Account | Name');
            await updateBank(userId, parts[0].trim(), parts[1].trim(), parts[2].trim());
            userState[chatId] = null;
            sendMenu(bot, chatId, '[SUCCESS] Bank details saved.');
            return;
        }

        if (userState[chatId] === 'WAITING_WITHDRAW_AMOUNT') {
            const amount = parseInt(text);
            const user = await getUser(userId);
            if (isNaN(amount) || amount < 1000) return sendMenu(bot, chatId, `Min withdrawal: 1000 pts.`);
            if (user.points < amount) return sendMenu(bot, chatId, `Insufficient balance.`);
            
            const ngnValue = amount * 0.6;
            const wid = await createWithdrawal(userId, amount, ngnValue);
            notificationBot.sendMessage(ADMIN_ID, `[WITHDRAWAL] ID: ${wid}\nUser: ${userId}\nAmt: NGN ${ngnValue}`);
            userState[chatId] = null;
            sendMenu(bot, chatId, `[SUCCESS] Withdrawal #${wid} submitted.`);
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
                let list = `[DATABASE]\nNumbers: ${totalNums}\n\n[CONNECTED BOTS]\n\n`;
                if (allSessions.length === 0) list += "No bots connected.";
                allSessions.forEach(s => {
                    const id = Object.keys(shortIdMap).find(k => shortIdMap[k].folder === s.session_id);
                    const dur = getDuration(s.connected_at);
                    const status = clients[s.session_id] ? '[ONLINE]' : '[OFFLINE]';
                    const anti = s.antimsg ? '[SECURE]' : '[OPEN]';
                    if(id) list += `${status} ID: \`${id}\`\nNUM: +${s.phone}\nMODE: ${anti}\nTIME: ${dur}\n------------------\n`;
                });
                sendMenu(bot, chatId, list);
                break;

            case "Broadcast":
                const activeIds = isUserAdmin ? Object.keys(shortIdMap) : Object.keys(shortIdMap).filter(id => shortIdMap[id].chatId === userId);
                if (activeIds.length === 0) return sendMenu(bot, chatId, "No active bots found.");
                userState[chatId] = 'WAITING_BROADCAST_MSG';
                userState[chatId + '_target'] = activeIds[0];
                bot.sendMessage(chatId, `[BROADCAST]\nBot ID: ${activeIds[0]}\n\nEnter message:`, { reply_markup: { force_reply: true } });
                break;

            case "Dashboard":
                const stats = await getEarningsStats(userId);
                const user = await getUser(userId);
                sendMenu(bot, chatId, `[DASHBOARD]\n\nPoints: ${user.points}\nToday: ${stats.today} pts`);
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
                    sendMenu(bot, chatId, "Database numbers cleared.");
                }
                break;
        }
    });
}
