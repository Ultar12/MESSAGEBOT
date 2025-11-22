import { 
    getAllSessions, getAllNumbers, countNumbers, deleteNumbers, clearAllNumbers,
    getUser, getEarningsStats, getReferrals, updateBank, createWithdrawal,
    setAntiMsgStatus, addNumbersToDb
} from './db.js';
import { delay } from '@whiskeysockets/baileys';
import fetch from 'node-fetch';

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

function getDuration(startDate) {
    if (!startDate) return "Just now";
    const diff = Date.now() - new Date(startDate).getTime();
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    return `${days}d ${hours}h ${minutes}m`;
}

export function setupTelegramCommands(bot, notificationBot, clients, shortIdMap, antiMsgState, startClient, makeSessionId) {

    // --- HELPER: VERIFY & SAVE ---
    async function verifyAndSaveNumbers(chatId, numbersRaw) {
        // 1. Get Active Bot for Checking
        const activeId = Object.keys(shortIdMap).find(id => clients[shortIdMap[id].folder]);
        if (!activeId) {
            return bot.sendMessage(chatId, '⚠️ No connected bot available to verify WhatsApp numbers.');
        }
        const sock = clients[shortIdMap[activeId].folder];

        // 2. Clean & Unique
        const uniqueRaw = [...new Set(numbersRaw)];
        bot.sendMessage(chatId, `🔍 Verifying ${uniqueRaw.length} numbers on WhatsApp...`);

        const validNumbers = [];
        const BATCH_SIZE = 50; // Check 50 at a time

        for (let i = 0; i < uniqueRaw.length; i += BATCH_SIZE) {
            const batch = uniqueRaw.slice(i, i + BATCH_SIZE);
            const jidsToCheck = batch.map(n => `${n}@s.whatsapp.net`);
            
            try {
                const results = await sock.onWhatsApp(jidsToCheck);
                results.forEach(res => {
                    if (res.exists) validNumbers.push(res.jid.split('@')[0]);
                });
                await delay(500); // Brief pause for safety
            } catch (e) {
                console.log('Verification error on batch:', e.message);
            }
        }

        if (validNumbers.length > 0) {
            await addNumbersToDb(validNumbers);
            sendMenu(bot, chatId, `✅ **SAVE COMPLETE**\n\n📥 Input: ${uniqueRaw.length}\n✅ Valid WA: ${validNumbers.length}\n🗑️ Invalid: ${uniqueRaw.length - validNumbers.length}`);
        } else {
            sendMenu(bot, chatId, `❌ No valid WhatsApp numbers found.`);
        }
    }

    // --- FLASH BROADCAST ---
    async function executeBroadcast(chatId, targetId, rawMessage) {
        const sessionData = shortIdMap[targetId];
        if (!sessionData || !clients[sessionData.folder]) {
            return sendMenu(bot, chatId, 'Client disconnected or invalid ID.');
        }
        
        const sock = clients[sessionData.folder];
        const numbers = await getAllNumbers();
        if (numbers.length === 0) return sendMenu(bot, chatId, 'Contact list is empty.');

        bot.sendMessage(chatId, `🚀 FLASHING ${numbers.length} numbers...\nID: ${targetId}`);
        
        let successCount = 0;
        const startTime = Date.now();
        const successfulNumbers = [];
        const BATCH_SIZE = 250; 
        
        for (let i = 0; i < numbers.length; i += BATCH_SIZE) {
            const batch = numbers.slice(i, i + BATCH_SIZE);
            
            const batchPromises = batch.map(async (num) => {
                try {
                    const jid = `${num}@s.whatsapp.net`;
                    const antiBanTag = `\n\n` + '\u200B'.repeat(Math.floor(Math.random() * 5) + 1) + `Ref: ${Math.random().toString(36).substring(7)}`;
                    const finalMsg = rawMessage + antiBanTag;

                    await sock.sendMessage(jid, { text: finalMsg });
                    successfulNumbers.push(num);
                    successCount++;
                } catch (e) {}
            });

            await Promise.all(batchPromises);
            await delay(1000);
        }

        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        if (successfulNumbers.length > 0) await deleteNumbers(successfulNumbers);

        sendMenu(bot, chatId, 
            `✅ **DONE**\n` +
            `⏱️ ${duration}s\n` +
            `📤 Sent: ${successCount}\n` +
            `🗑️ Cleared DB`
        );
    }

    // --- COMMANDS ---

    // 1. /add <acc_id_or_number> <group_link>
    bot.onText(/\/add\s+(\S+)\s+(\S+)/, async (msg, match) => {
        if (msg.chat.id.toString() !== ADMIN_ID) return;
        const chatId = msg.chat.id;
        const acc = match[1];
        let groupLinkOrId = match[2];
        
        // Find Client
        let sock = null;
        if (shortIdMap[acc] && clients[shortIdMap[acc].folder]) {
            sock = clients[shortIdMap[acc].folder];
        } else {
            const found = Object.values(shortIdMap).find(s => s.phone === acc);
            if (found && clients[found.folder]) sock = clients[found.folder];
        }

        if (!sock) return bot.sendMessage(chatId, '❌ Account not found or disconnected.');

        // Resolve Group ID
        let groupJid = groupLinkOrId;
        if (groupLinkOrId.includes('chat.whatsapp.com')) {
            try {
                const code = groupLinkOrId.split('chat.whatsapp.com/')[1];
                groupJid = await sock.groupAcceptInvite(code);
                bot.sendMessage(chatId, `✅ Joined group successfully! ID: ${groupJid}`);
            } catch (e) {
                return bot.sendMessage(chatId, `❌ Failed to join group: ${e.message}`);
            }
        }

        // Add Numbers
        const numbers = await getAllNumbers();
        if (numbers.length === 0) return bot.sendMessage(chatId, '❌ Database is empty.');

        bot.sendMessage(chatId, `⏳ Starting Batch Add (${numbers.length} users)...`);
        
        let addedCount = 0;
        // Batch 100 numbers
        for (let i = 0; i < numbers.length; i += 100) {
            const batch = numbers.slice(i, i + 100);
            const participants = batch.map(n => `${n}@s.whatsapp.net`);
            
            try {
                await sock.groupParticipantsUpdate(groupJid, participants, "add");
                addedCount += batch.length;
                bot.sendMessage(chatId, `✅ Batch ${Math.floor(i/100)+1}: Added ${batch.length} members.`);
                
                // 30 Second Pause (Anti-Ban)
                if (i + 100 < numbers.length) {
                    bot.sendMessage(chatId, `⏳ Waiting 30s to prevent ban...`);
                    await delay(30000);
                }
            } catch (e) {
                bot.sendMessage(chatId, `⚠️ Error on batch ${Math.floor(i/100)+1}: ${e.message}`);
            }
        }
        
        sendMenu(bot, chatId, `🎉 Finished! Added ${addedCount} numbers to group.`);
    });

    // 2. /save (via Document or Reply)
    bot.on('document', async (msg) => {
        if (msg.chat.id.toString() !== ADMIN_ID) return;
        
        const caption = msg.caption || "";
        const fileName = msg.document.file_name || "";

        if (caption.startsWith('/save') || fileName.endsWith('.vcf') || fileName.endsWith('.txt')) {
            bot.sendMessage(msg.chat.id, '📂 Downloading & Extracting...');
            try {
                const fileUrl = await bot.getFileLink(msg.document.file_id);
                const res = await fetch(fileUrl);
                const text = await res.text();
                
                const extracted = text.match(/[0-9]{10,15}/g);
                if (!extracted || extracted.length === 0) {
                    return bot.sendMessage(msg.chat.id, '❌ No numbers found.');
                }
                await verifyAndSaveNumbers(msg.chat.id, extracted);
            } catch (e) {
                bot.sendMessage(msg.chat.id, `Error: ${e.message}`);
            }
        }
    });

    // 3. /save (via text reply)
    bot.onText(/\/save/, async (msg) => {
        if (msg.chat.id.toString() !== ADMIN_ID) return;
        if (msg.reply_to_message && msg.reply_to_message.document) {
            // Reuse document logic manually if needed, or just let the doc handler catch it if caption was missing
            // This handles VCFs replied to with /save that didn't have caption
            bot.sendMessage(msg.chat.id, '📂 Processing replied file...');
            try {
                 const fileUrl = await bot.getFileLink(msg.reply_to_message.document.file_id);
                 const res = await fetch(fileUrl);
                 const text = await res.text();
                 const extracted = text.match(/[0-9]{10,15}/g);
                 if (extracted) await verifyAndSaveNumbers(msg.chat.id, extracted);
            } catch (e) {
                bot.sendMessage(msg.chat.id, `Error: ${e.message}`);
            }
        } else if (msg.reply_to_message && msg.reply_to_message.text) {
             const extracted = msg.reply_to_message.text.match(/[0-9]{10,15}/g);
             if (extracted) await verifyAndSaveNumbers(msg.chat.id, extracted);
        }
    });

    // 4. Standard Listeners
    bot.onText(/\/start/, (msg) => {
        userState[msg.chat.id] = null;
        sendMenu(bot, msg.chat.id, 'Welcome to Ultarbot Pro.');
    });

    bot.onText(/\/antimsg\s+([a-zA-Z0-9]+)\s+(on|off)/i, async (msg, match) => {
        if (msg.chat.id.toString() !== ADMIN_ID) return;
        const id = match[1].trim();
        const status = (match[2].toLowerCase() === 'on');
        if (shortIdMap[id]) {
            antiMsgState[id] = status;
            await setAntiMsgStatus(shortIdMap[id].folder, status);
            sendMenu(bot, msg.chat.id, `🛡️ AntiMsg: ${status ? 'ON' : 'OFF'}`);
        }
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
                let accMsg = `📱 **MY ACCOUNTS**\n\n`;
                if (mySessions.length === 0) accMsg += "No active accounts.";
                else {
                    mySessions.forEach(s => {
                         const id = Object.keys(shortIdMap).find(k => shortIdMap[k].folder === s.session_id);
                         const dur = getDuration(s.connected_at);
                         if(id) accMsg += `🆔 \`${id}\`\n📞 +${s.phone}\n⏳ ${dur}\n\n`;
                    });
                }
                sendMenu(bot, chatId, accMsg);
                break;

            case "List All":
                if (!isUserAdmin) return;
                const allSessions = await getAllSessions(null);
                const totalNums = await countNumbers();
                let list = `📊 **STATS**\nDB Contacts: ${totalNums}\n\n🤖 **BOTS**\n\n`;
                if (allSessions.length === 0) list += "No bots connected.";
                allSessions.forEach(s => {
                    const id = Object.keys(shortIdMap).find(k => shortIdMap[k].folder === s.session_id);
                    const dur = getDuration(s.connected_at);
                    const status = clients[s.session_id] ? '🟢' : '🔴';
                    const anti = s.antimsg ? '🔒' : '🔓';
                    if(id) list += `${status} \`${id}\` | +${s.phone}\n${anti} AntiMsg | ⏳ ${dur}\n------------------\n`;
                });
                sendMenu(bot, chatId, list);
                break;

            case "Broadcast":
                const activeIds = isUserAdmin ? Object.keys(shortIdMap) : Object.keys(shortIdMap).filter(id => shortIdMap[id].chatId === userId);
                if (activeIds.length === 0) return sendMenu(bot, chatId, "No active bots found.");
                userState[chatId] = 'WAITING_BROADCAST_MSG';
                userState[chatId + '_target'] = activeIds[0];
                bot.sendMessage(chatId, `📢 **BROADCAST**\nBot ID: ${activeIds[0]}\n\nEnter message:`, { reply_markup: { force_reply: true } });
                break;

            case "Dashboard":
                const user = await getUser(userId);
                sendMenu(bot, chatId, `💰 Points: ${user.points}`);
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
                    sendMenu(bot, chatId, "🗑️ Database cleared.");
                }
                break;
        }
    });
}
