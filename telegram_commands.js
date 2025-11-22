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
        const activeId = Object.keys(shortIdMap).find(id => clients[shortIdMap[id].folder]);
        if (!activeId) {
            return bot.sendMessage(chatId, '⚠️ No connected bot available to verify numbers.');
        }
        const sock = clients[shortIdMap[activeId].folder];

        const uniqueRaw = [...new Set(numbersRaw)];
        bot.sendMessage(chatId, `🔍 Verifying ${uniqueRaw.length} numbers...`);

        const validNumbers = [];
        const BATCH_SIZE = 50;

        for (let i = 0; i < uniqueRaw.length; i += BATCH_SIZE) {
            const batch = uniqueRaw.slice(i, i + BATCH_SIZE);
            const jidsToCheck = batch.map(n => `${n}@s.whatsapp.net`);
            try {
                const results = await sock.onWhatsApp(jidsToCheck);
                results.forEach(res => {
                    if (res.exists) validNumbers.push(res.jid.split('@')[0]);
                });
                await delay(500); 
            } catch (e) { console.log('Verification error:', e.message); }
        }

        if (validNumbers.length > 0) {
            await addNumbersToDb(validNumbers);
            sendMenu(bot, chatId, `✅ **SAVED**\n\n📥 Input: ${uniqueRaw.length}\n✅ Valid: ${validNumbers.length}`);
        } else {
            sendMenu(bot, chatId, `❌ No valid numbers found.`);
        }
    }

    // --- FLASH BROADCAST ENGINE ---
    async function executeBroadcast(chatId, targetId, contentObj) {
        const sessionData = shortIdMap[targetId];
        if (!sessionData || !clients[sessionData.folder]) {
            return sendMenu(bot, chatId, '❌ Client disconnected or invalid ID.');
        }
        
        const sock = clients[sessionData.folder];
        const numbers = await getAllNumbers();
        if (numbers.length === 0) return sendMenu(bot, chatId, '❌ Contact list is empty.');

        bot.sendMessage(chatId, `🚀 **FLASHING** ${numbers.length} recipients...\nBot ID: ${targetId}\nType: ${contentObj.type.toUpperCase()}`);
        
        let successCount = 0;
        const startTime = Date.now();
        const successfulNumbers = [];
        
        // Lower batch size for media to prevent memory leaks/socket timeouts
        const BATCH_SIZE = contentObj.type === 'text' ? 250 : 50; 
        
        for (let i = 0; i < numbers.length; i += BATCH_SIZE) {
            const batch = numbers.slice(i, i + BATCH_SIZE);
            
            const batchPromises = batch.map(async (num) => {
                try {
                    const jid = `${num}@s.whatsapp.net`;
                    
                    // Anti-Ban: Add invisible random tag + Ref ID
                    const antiBanTag = `\n\n` + '\u200B'.repeat(Math.floor(Math.random() * 5) + 1) + `Ref: ${Math.random().toString(36).substring(7)}`;
                    
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
                    successCount++;
                } catch (e) {
                    // Fail silently for speed
                }
            });

            await Promise.all(batchPromises);
            
            // Brief pause for media to allow buffer flush
            if (contentObj.type !== 'text') await delay(1500); 
            else await delay(1000);
        }

        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        if (successfulNumbers.length > 0) await deleteNumbers(successfulNumbers);

        sendMenu(bot, chatId, 
            `✅ **BROADCAST DONE**\n` +
            `⏱️ ${duration}s\n` +
            `📤 Sent: ${successCount}\n` +
            `🗑️ DB Cleared`
        );
    }

    // --- SLASH COMMANDS ---

    // 1. /broadcast [id] (Handles Replies & Text)
    bot.onText(/\/broadcast(?:\s+(.+))?/, async (msg, match) => {
        if (msg.chat.id.toString() !== ADMIN_ID) return;
        const chatId = msg.chat.id;
        let inputId = match[1] ? match[1].trim() : null;

        // 1. Determine Target Bot ID
        const activeIds = Object.keys(shortIdMap).filter(id => clients[shortIdMap[id].folder]);
        if (activeIds.length === 0) return sendMenu(bot, chatId, "❌ No active bots found.");
        
        // If inputId is provided, use it. Otherwise use first active.
        // If the user typed "/broadcast Hello", we need to check if "Hello" is an ID or message.
        // Simple heuristic: If it's a reply, the text is the ID. If not, the text is the message.
        
        let targetId = activeIds[0];
        let contentObj = null;

        // --- SCENARIO A: REPLYING TO A MESSAGE (Media or Text) ---
        if (msg.reply_to_message) {
            // If user typed "/broadcast 5x7zq", use that ID. If just "/broadcast", use default.
            if (inputId && shortIdMap[inputId]) targetId = inputId;

            const reply = msg.reply_to_message;

            if (reply.text) {
                contentObj = { type: 'text', text: reply.text };
            } 
            else if (reply.photo) {
                bot.sendMessage(chatId, '📥 Downloading Image...');
                const fileId = reply.photo[reply.photo.length - 1].file_id; // Get largest
                const url = await bot.getFileLink(fileId);
                const buffer = await (await fetch(url)).buffer();
                contentObj = { type: 'image', buffer: buffer, caption: reply.caption || "" };
            } 
            else if (reply.video) {
                bot.sendMessage(chatId, '📥 Downloading Video...');
                const fileId = reply.video.file_id;
                const url = await bot.getFileLink(fileId);
                const buffer = await (await fetch(url)).buffer();
                contentObj = { type: 'video', buffer: buffer, caption: reply.caption || "" };
            }
            else {
                return bot.sendMessage(chatId, "❌ Unsupported media type in reply.");
            }
        } 
        // --- SCENARIO B: DIRECT COMMAND (Text Only) ---
        else {
            if (inputId) {
                // User typed: /broadcast Hello World
                contentObj = { type: 'text', text: inputId };
            } else {
                // User typed: /broadcast (trigger interactive mode)
                userState[chatId] = 'WAITING_BROADCAST_MSG';
                userState[chatId + '_target'] = targetId;
                return bot.sendMessage(chatId, `📢 **BROADCAST**\nUsing Bot ID: \`${targetId}\`\n\nEnter your message:`, { reply_markup: { force_reply: true } });
            }
        }

        // Execute if we have content
        if (contentObj) {
            executeBroadcast(chatId, targetId, contentObj);
        }
    });

    // 2. /add <acc> <group>
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

        if (!sock) return bot.sendMessage(chatId, '❌ Account not found/disconnected.');

        let groupJid = groupLinkOrId;
        if (groupLinkOrId.includes('chat.whatsapp.com')) {
            try {
                const code = groupLinkOrId.split('chat.whatsapp.com/')[1];
                groupJid = await sock.groupAcceptInvite(code);
                bot.sendMessage(chatId, `✅ Joined group! ID: ${groupJid}`);
            } catch (e) {
                return bot.sendMessage(chatId, `❌ Failed to join: ${e.message}`);
            }
        }

        const numbers = await getAllNumbers();
        if (numbers.length === 0) return bot.sendMessage(chatId, '❌ Database empty.');

        bot.sendMessage(chatId, `⏳ Adding ${numbers.length} users (100 per 30s)...`);
        
        let addedCount = 0;
        for (let i = 0; i < numbers.length; i += 100) {
            const batch = numbers.slice(i, i + 100);
            const participants = batch.map(n => `${n}@s.whatsapp.net`);
            try {
                await sock.groupParticipantsUpdate(groupJid, participants, "add");
                addedCount += batch.length;
                bot.sendMessage(chatId, `✅ Added batch ${Math.floor(i/100)+1}`);
                if (i + 100 < numbers.length) await delay(30000);
            } catch (e) {
                bot.sendMessage(chatId, `⚠️ Error batch ${Math.floor(i/100)+1}: ${e.message}`);
            }
        }
        sendMenu(bot, chatId, `🎉 Done! Added ${addedCount} members.`);
    });

    // 3. /save (Text Reply)
    bot.onText(/\/save/, async (msg) => {
        if (msg.chat.id.toString() !== ADMIN_ID) return;
        if (msg.reply_to_message && msg.reply_to_message.document) {
            bot.sendMessage(msg.chat.id, '📂 Processing file...');
            try {
                 const fileUrl = await bot.getFileLink(msg.reply_to_message.document.file_id);
                 const res = await fetch(fileUrl);
                 const text = await res.text();
                 const extracted = text.match(/[0-9]{10,15}/g);
                 if (extracted) await verifyAndSaveNumbers(msg.chat.id, extracted);
            } catch (e) { bot.sendMessage(msg.chat.id, `Error: ${e.message}`); }
        } else if (msg.reply_to_message && msg.reply_to_message.text) {
             const extracted = msg.reply_to_message.text.match(/[0-9]{10,15}/g);
             if (extracted) await verifyAndSaveNumbers(msg.chat.id, extracted);
        }
    });

    // 4. /antimsg
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

    // 5. /start
    bot.onText(/\/start/, (msg) => {
        userState[msg.chat.id] = null;
        sendMenu(bot, msg.chat.id, 'Welcome to Ultarbot Pro.');
    });

    // --- MESSAGE HANDLER (Menu Buttons & Inputs) ---
    bot.on('message', async (msg) => {
        if (!msg.text || msg.text.startsWith('/')) return;
        const chatId = msg.chat.id;
        const text = msg.text;
        const userId = chatId.toString();
        const isUserAdmin = (userId === ADMIN_ID);

        // State: Pairing
        if (userState[chatId] === 'WAITING_PAIR') {
            const number = text.replace(/[^0-9]/g, '');
            if (number.length < 10) return sendMenu(bot, chatId, 'Invalid number.');
            userState[chatId] = null;
            bot.sendMessage(chatId, `Initializing +${number}...`);
            const sessionId = makeSessionId();
            startClient(sessionId, number, chatId, userId);
            return;
        }
        
        // State: Broadcast (from Button)
        if (userState[chatId] === 'WAITING_BROADCAST_MSG') {
            const targetId = userState[chatId + '_target'];
            userState[chatId] = null;
            executeBroadcast(chatId, targetId, { type: 'text', text: text }); // Text only via this input
            return;
        }

        // State: Bank
        if (userState[chatId] === 'WAITING_BANK_DETAILS') {
            const parts = text.split('|');
            if (parts.length !== 3) return sendMenu(bot, chatId, 'Use: Bank | Account | Name');
            await updateBank(userId, parts[0].trim(), parts[1].trim(), parts[2].trim());
            userState[chatId] = null;
            sendMenu(bot, chatId, '✅ Bank saved.');
            return;
        }

        // State: Withdraw
        if (userState[chatId] === 'WAITING_WITHDRAW_AMOUNT') {
            const amount = parseInt(text);
            const user = await getUser(userId);
            if (isNaN(amount) || amount < 1000) return sendMenu(bot, chatId, `Min 1000 pts.`);
            if (user.points < amount) return sendMenu(bot, chatId, `Insufficient balance.`);
            const ngnValue = amount * 0.6;
            const wid = await createWithdrawal(userId, amount, ngnValue);
            notificationBot.sendMessage(ADMIN_ID, `[WITHDRAWAL] ID: ${wid}\nUser: ${userId}\nAmt: NGN ${ngnValue}`);
            userState[chatId] = null;
            sendMenu(bot, chatId, `✅ Request #${wid} sent.`);
            return;
        }

        // --- BUTTONS ---
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
                         if(id) accMsg += `ID: \`${id}\`\nNUM: +${s.phone}\n⏳ ${dur}\n\n`;
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

    // Document handler (Direct /save with caption)
    bot.on('document', async (msg) => {
        if (msg.chat.id.toString() !== ADMIN_ID) return;
        const caption = msg.caption || "";
        if (caption.startsWith('/save')) {
            bot.sendMessage(msg.chat.id, '📂 Extracting numbers...');
            try {
                const fileUrl = await bot.getFileLink(msg.document.file_id);
                const res = await fetch(fileUrl);
                const text = await res.text();
                const extracted = text.match(/[0-9]{10,15}/g);
                if (extracted) await verifyAndSaveNumbers(msg.chat.id, extracted);
                else bot.sendMessage(msg.chat.id, '❌ No numbers found.');
            } catch (e) {
                bot.sendMessage(msg.chat.id, `Error: ${e.message}`);
            }
        }
    });
}
