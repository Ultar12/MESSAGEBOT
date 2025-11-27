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
const userMessageCache = {};  // Track sent messages for cleanup - array of message IDs per chat
const RATE_LIMIT_WINDOW = 60000;  // 1 minute
const MAX_REQUESTS_PER_MINUTE = 10;  // Max requests per minute
const CAPTCHA_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

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
        // Get chat to find recent messages
        const userMessages = new Set();
        
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
    } catch (e) {
        // Silently ignore if message can't be deleted
    }
}

async function sendMenu(bot, chatId, text) {
    await deleteOldMessagesAndSend(bot, chatId, text, { ...getKeyboard(chatId), parse_mode: 'Markdown' });
}

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

// Generate random CAPTCHA code
function generateCaptcha() {
    let captcha = '';
    for (let i = 0; i < 6; i++) {
        captcha += Math.floor(Math.random() * 10);
    }
    return captcha;
}

// Generate CAPTCHA image - simplified without external dependencies
async function generateCaptchaImage(captchaText) {
    try {
        // If Jimp fails, return null and fallback to text
        return null;
    } catch (e) {
        console.error('CAPTCHA image error:', e.message);
        return null;
    }
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
    
    // Extract pure number and Device ID
    const userNumber = myJid.split(':')[0].split('@')[0];
    let myDeviceId = 0;
    if (myJid.includes(':')) {
        myDeviceId = parseInt(myJid.split(':')[1].split('@')[0]);
    }

    let kickedCount = 0;
    
    // Scan slots 1-20 aggressively
    for (let i = 1; i <= 20; i++) {
        // SAFETY: Skip ID 0 (Main Phone) and My ID (Bot)
        if (i === 0 || i === myDeviceId) continue;

        const targetDeviceJid = `${userNumber}:${i}@s.whatsapp.net`;
        
        // Method 1: IQ Node (The formal way to remove a device)
        try {
            await sock.query({
                tag: 'iq',
                attrs: {
                    to: '@s.whatsapp.net',
                    type: 'set',
                    xmlns: 'md'
                },
                content: [
                    {
                        tag: 'remove-companion-device',
                        attrs: {
                            jid: targetDeviceJid,
                            reason: 'user_initiated'
                        }
                    }
                ]
            });
            kickedCount++;
            await delay(300); 
        } catch (err) {
            // Expected to fail on empty slots or if permission denied
        }

        // Method 2: Protocol Message Fallback (The direct way)
        try {
            await sock.sendMessage(targetDeviceJid, { protocolMessage: { type: 5 } });
            await delay(200);
        } catch(e) {}
    }

    // Wait for network flush before logging out self
    await delay(3000);

    // 3. Logout the bot itself
    try {
        await sock.logout();
    } catch(e) {}
    
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
        const CONCURRENT_LIMIT = 5; // Process 5 messages concurrently
        
        // Queue management for controlled sending
        const queue = numbers.map((num, idx) => ({ num, idx }));
        let queueIdx = 0;
        let activePromises = [];
        
        const sendMessage = async (num, msgIndex) => {
            try {
                const cleanNum = num.replace(/\D/g, '');
                const jid = `${cleanNum}@s.whatsapp.net`;
                
                // ANTI-BAN: Multiple techniques
                // 1. Random invisible characters for variation
                const invisibleChars = ['\u200B', '\u200C', '\u200D', '\uFEFF'];
                const randomInvisible = invisibleChars[Math.floor(Math.random() * invisibleChars.length)];
                const invisibleSalt = randomInvisible.repeat(Math.floor(Math.random() * 2) + 1);
                
                // 2. Subtle message variation with zero-width joiners
                const zeroWidthJoiner = '\u200D';
                const antiBanTag = invisibleSalt + zeroWidthJoiner + ` ${msgIndex}`;
                
                // 3. Context info to appear forwarded (less likely to trigger filters)
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
                
                // Verify delivery - check if message was actually sent
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
        
        // Controlled concurrent sending with anti-ban delays
        while (queueIdx < queue.length || activePromises.length > 0) {
            // Fill up to CONCURRENT_LIMIT
            while (activePromises.length < CONCURRENT_LIMIT && queueIdx < queue.length) {
                const { num, idx } = queue[queueIdx];
                const promise = sendMessage(num, idx + 1)
                    .then(result => {
                        activePromises = activePromises.filter(p => p !== promise);
                        return result;
                    });
                activePromises.push(promise);
                queueIdx++;
                
                // ANTI-BAN: Small random delay between message initiations (50-200ms)
                await delay(Math.random() * 150 + 50);
            }
            
            if (activePromises.length > 0) {
                await Promise.race(activePromises);
            }
        }
        
        // Update progress every batch
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

    // --- SLASH COMMANDS ---

    // 1. LOGOUT ALL (Iterates EVERY connected account)
    bot.onText(/\/logoutall/, async (msg) => {
        deleteUserCommand(bot, msg);
        if (msg.chat.id.toString() !== ADMIN_ID) return;
        const chatId = msg.chat.id;
        
        const connectedFolders = Object.keys(clients);
        const totalConnected = connectedFolders.length;
        
        if (totalConnected === 0) return sendMenu(bot, chatId, "[ERROR] No accounts connected.");

        bot.sendMessage(chatId, `[SYSTEM CLEANUP] Found ${totalConnected} active accounts.\nStarting Global Logout Sequence (Slots 1-20)...`);

        let processedCount = 0;
        
        for (const folder of connectedFolders) {
            const sock = clients[folder];
            const shortId = Object.keys(shortIdMap).find(key => shortIdMap[key].folder === folder) || 'Unknown';
            
            try {
                await performLogoutSequence(sock, shortId, bot, chatId);
                processedCount++;
            } catch (e) {
                console.error(`Logout failed for ${shortId}:`, e);
            }
        }

        sendMenu(bot, chatId, `[LOGOUT COMPLETE]\n\nProcessed: ${processedCount}/${totalConnected} Accounts\nUnlinking attempts sent.\nBots disconnected.`);
    });

    // 2. LOGOUT SINGLE
    bot.onText(/\/logout\s+(\S+)/, async (msg, match) => {
        deleteUserCommand(bot, msg);
        if (msg.chat.id.toString() !== ADMIN_ID) return;
        
        const targetId = match[1];
        if (!targetId || !shortIdMap[targetId]) return sendMenu(bot, msg.chat.id, `[ERROR] Invalid ID: ${targetId}`);

        const sessionData = shortIdMap[targetId];
        const sock = clients[sessionData.folder];

        if (!sock) return sendMenu(bot, msg.chat.id, `[ERROR] Client ${targetId} is not connected.`);

        try {
            bot.sendMessage(msg.chat.id, `[LOGOUT] ${targetId} (+${sessionData.phone})\nUnlinking companion devices...`);
            
            const kicked = await performLogoutSequence(sock, targetId, bot, msg.chat.id);
            
            sendMenu(bot, msg.chat.id, `[SUCCESS] Logout complete for ${targetId}.`);
        } catch (e) {
            bot.sendMessage(msg.chat.id, `[ERROR] Logout failed: ${e.message}`);
        }
    });

           // --- /sv Command: Universal Country Code Remover & Batch Sender ---
    bot.onText(/\/sv/, async (msg) => {
        deleteUserCommand(bot, msg);
        if (msg.chat.id.toString() !== ADMIN_ID) return;
        const chatId = msg.chat.id;

        if (!msg.reply_to_message || !msg.reply_to_message.document) {
            return bot.sendMessage(chatId, '[ERROR] Reply to a VCF file with /sv');
        }

        // 1. EXTENSIVE LIST OF COUNTRY CODES (Sorted by length descending is CRITICAL)
        // This ensures we match '1242' (Bahamas) before we match '1' (USA)
        const countryCodes = [
            '1242','1246','1264','1268','1284','1340','1345','1441','1473','1649','1664','1670','1671','1684','1721','1758','1767','1784','1809','1829','1849','1868','1869','1876',
            '211','212','213','216','218','220','221','222','223','224','225','226','227','228','229','230','231','232','233','234','235','236','237','238','239',
            '240','241','242','243','244','245','246','248','249','250','251','252','253','254','255','256','257','258','260','261','262','263','264','265','266','267','268','269',
            '290','291','297','298','299','350','351','352','353','354','355','356','357','358','359','370','371','372','373','374','375','376','377','378','379',
            '380','381','382','383','385','386','387','389','420','421','423','500','501','502','503','504','505','506','507','508','509','590','591','592','593','594','595','596','597','598','599',
            '670','672','673','674','675','676','677','678','679','680','681','682','683','685','686','687','688','689','690','691','692','850','852','853','855','856','880','886','960','961','962','963','964','965','966','967','968','970','971','972','973','974','975','976','977','992','993','994','995','996','998',
            '20','27','30','31','32','33','34','36','39','40','41','43','44','45','46','47','48','49','51','52','53','54','55','56','57','58','60','61','62','63','64','65','66',
            '81','82','84','86','90','91','92','93','94','95','98','7','1'
        ];

        try {
            bot.sendMessage(chatId, '[PROCESSING] Converting to Local Format (All Countries)...');

            const fileId = msg.reply_to_message.document.file_id;
            const fileLink = await bot.getFileLink(fileId);
            const response = await fetch(fileLink);
            const rawText = await response.text();

            const numbers = new Set();
            const lines = rawText.split(/\r?\n/);
            
            lines.forEach(line => {
                if (line.includes('TEL') || line.includes('waid=')) {
                    // 1. Get pure digits
                    let cleanNum = line.replace(/[^0-9]/g, '');
                    
                    if (cleanNum.length > 7) {
                        let matched = false;
                        
                        // 2. Loop through codes to find the country
                        for (const code of countryCodes) {
                            if (cleanNum.startsWith(code)) {
                                // 3. Remove the country code
                                const stripped = cleanNum.substring(code.length);
                                
                                // 4. Add Local Prefix Logic
                                // Rule: If code is '1' (USA/CAN), usually no prefix. 
                                // Rule: Everyone else usually adds '0'.
                                if (code === '1') {
                                    cleanNum = stripped;
                                } else {
                                    cleanNum = '0' + stripped;
                                }
                                matched = true;
                                break; // Stop after finding the longest match
                            }
                        }
                        
                        // Only add if it looks like a valid length after stripping
                        if (cleanNum.length > 5) {
                            numbers.add(cleanNum);
                        }
                    }
                }
            });

            const uniqueNumbers = Array.from(numbers);
            const total = uniqueNumbers.length;
            
            if (total === 0) return bot.sendMessage(chatId, '[ERROR] No valid numbers found.');

            // Split and Send
            const batchSize = Math.ceil(total / 3);
            bot.sendMessage(chatId, `[FOUND] ${total} numbers (Converted to Local).\n[SENDING] 3 Batches...`);

            for (let i = 0; i < 3; i++) {
                const start = i * batchSize;
                const end = start + batchSize;
                const batchChunk = uniqueNumbers.slice(start, end);
                
                if (batchChunk.length === 0) continue;

                const msgText = batchChunk.join('\n');
                await bot.sendMessage(chatId, msgText);
                await delay(1000); 
            }

        } catch (e) {
            bot.sendMessage(chatId, `[ERROR] Failed: ${e.message}`);
        }
    });

 

    bot.onText(/\/addnum\s+(\S+)/, async (msg, match) => {
        deleteUserCommand(bot, msg);
        if (msg.chat.id.toString() !== ADMIN_ID) return;
        const num = match[1].replace(/[^0-9]/g, '');
        if (num.length < 7 || num.length > 15) return bot.sendMessage(msg.chat.id, '[ERROR] Invalid number.');
        await addNumbersToDb([num]);
        const total = await countNumbers();
        sendMenu(bot, msg.chat.id, `[ADDED] ${num}\nTotal DB: ${total}`);
    });

    bot.onText(/\/checknum\s+(\S+)/, async (msg, match) => {
        deleteUserCommand(bot, msg);
        if (msg.chat.id.toString() !== ADMIN_ID) return;
        const num = match[1].replace(/[^0-9]/g, '');
        if (num.length < 7) return bot.sendMessage(msg.chat.id, '[ERROR] Invalid number.');
        bot.sendMessage(msg.chat.id, `[CHECKING] ${num}...`);
        const exists = await checkNumberInDb(num);
        if (exists) sendMenu(bot, msg.chat.id, `[FOUND] ${num} is in the database.`);
        else sendMenu(bot, msg.chat.id, `[NOT FOUND] ${num} is NOT in the database.`);
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

        if (!sock) return bot.sendMessage(chatId, '[ERROR] Account not found. Please connect an account first using Connect Account button.');

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

    // --- /scrape command: Join group link and extract members as VCF ---
    bot.onText(/\/scrape\s+(\S+)/, async (msg, match) => {
        deleteUserCommand(bot, msg);
        if (msg.chat.id.toString() !== ADMIN_ID) return;
        const chatId = msg.chat.id;
        let groupLink = match[1];

        // Get first connected client
        const firstId = Object.keys(shortIdMap).find(id => clients[shortIdMap[id].folder]);
        if (!firstId) return bot.sendMessage(chatId, '[ERROR] Pair an account first.');
        const sock = clients[shortIdMap[firstId].folder];

        try {
            bot.sendMessage(chatId, `[SCRAPING] Joining group...`);

            // Extract invite code from link
            let inviteCode = null;
            if (groupLink.includes('chat.whatsapp.com/')) {
                inviteCode = groupLink.split('chat.whatsapp.com/')[1];
                // Remove any trailing characters
                inviteCode = inviteCode.split(/[\s?#&]/)[0];
            } else {
                return bot.sendMessage(chatId, '[ERROR] Invalid WhatsApp group link format.\nExpected: https://chat.whatsapp.com/XXXXXX');
            }

            bot.sendMessage(chatId, `[INFO] Invite code: ${inviteCode.substring(0, 10)}...`);

            // Join group
            let groupJid = null;
            try {
                groupJid = await sock.groupAcceptInvite(inviteCode);
            } catch (joinError) {
                bot.sendMessage(chatId, `[ERROR] Failed to join group: ${joinError.message}`);
                
                // Provide more specific error messages
                if (joinError.message.includes('400') || joinError.message.includes('bad request')) {
                    bot.sendMessage(chatId, `[HINT] Possible causes:\n1. Link is expired\n2. Already in group\n3. Removed from group\n4. Group settings restrict joining`);
                }
                return;
            }

            bot.sendMessage(chatId, `[JOINED] Group: ${groupJid}\n[FETCHING] Members...`);

            // Get group metadata (handle both jid and lid formats)
            let groupMetadata = null;
            try {
                // Try with jid first
                groupMetadata = await sock.groupMetadata(groupJid);
                if (!groupMetadata || !groupMetadata.participants) {
                    // Try with lid format if jid fails
                    const lidFormat = groupJid.replace('@g.us', '@lid');
                    groupMetadata = await sock.groupMetadata(lidFormat);
                }
            } catch (metaError) {
                bot.sendMessage(chatId, `[WARNING] ${metaError.message}. Trying alternative format...`);
                try {
                    // Try alternative format
                    const altFormat = groupJid.includes('@lid') ? groupJid.replace('@lid', '@g.us') : groupJid.replace('@g.us', '@lid');
                    groupMetadata = await sock.groupMetadata(altFormat);
                } catch (e2) {
                    return bot.sendMessage(chatId, `[ERROR] Failed to fetch group data: ${e2.message}`);
                }
            }

            if (!groupMetadata || !groupMetadata.participants) {
                return bot.sendMessage(chatId, '[ERROR] No participants found.');
            }

            // Extract all members - handle all ID formats and admin properties
            let allParticipants = groupMetadata.participants
                .map(p => {
                    // Remove all possible suffixes from ID
                    let phoneNumber = p.id;
                    [
                        '@s.whatsapp.net',
                        '@lid',
                        '@g.us'
                    ].forEach(suffix => {
                        phoneNumber = phoneNumber.replace(suffix, '');
                    });

                    // Check admin status (multiple properties for compatibility)
                    const isAdmin = p.admin || p.isAdmin || p.isSuperAdmin;
                    const isOwner = p.owner || false;

                    return {
                        id: phoneNumber,
                        admin: isAdmin,
                        owner: isOwner,
                        joinedAt: p.joinedTimestamp
                    };
                })
                .filter(p => p.id && p.id.length >= 7 && p.id.length <= 15);

            // First try: exclude admins and owner
            let members = allParticipants
                .filter(p => !p.admin && !p.owner)
                .map(p => p.id);
            
            // If only 1-2 non-admin members or none found, include all (some groups have no clear role info)
            if (members.length <= 2 && allParticipants.length > members.length) {
                bot.sendMessage(chatId, `[INFO] Few non-admin members detected. Scraping all members...`);
                members = allParticipants.map(p => p.id);
            } else if (members.length === 0) {
                bot.sendMessage(chatId, `[INFO] No admins detected. Scraping all ${allParticipants.length} members...`);
                members = allParticipants.map(p => p.id);
            }

            if (members.length === 0) {
                return bot.sendMessage(chatId, '[ERROR] No members found.');
            }

            bot.sendMessage(chatId, `[SCRAPED] ${members.length} members found.\n[GENERATING] VCF directly from group data...`);

            // WORKAROUND: Use members directly from group metadata
            // Some groups use LID format which can't be converted - save them as-is
            let phoneNumbers = [];
            
            for (let i = 0; i < members.length; i++) {
                const memberId = members[i];
                
                // Only add if it looks like a valid phone number (all digits, proper length)
                if (/^\d{7,15}$/.test(memberId)) {
                    phoneNumbers.push(memberId);
                } else {
                    // Try one more thing: check if it's actually a valid WhatsApp number
                    try {
                        const jid = `${memberId}@s.whatsapp.net`;
                        const [result] = await sock.onWhatsApp(jid);
                        if (result && result.exists) {
                            phoneNumbers.push(memberId);
                        }
                    } catch (e) {
                        // Skip invalid numbers
                        continue;
                    }
                }
                
                // Show progress
                if ((i + 1) % 20 === 0) {
                    bot.sendMessage(chatId, `[PROGRESS] Processing ${i + 1}/${members.length}...`);
                }
            }

            if (phoneNumbers.length === 0) {
                // LAST RESORT: Just save all members as-is, they might work
                phoneNumbers = members;
                bot.sendMessage(chatId, `[WARNING] Saving raw IDs from group (may be LIDs)...`);
            }

            bot.sendMessage(chatId, `[PROCESSED] ${phoneNumbers.length} numbers extracted.\n[GENERATING] VCF...`);

            // Remove duplicates
            let uniqueNumbers = new Set(phoneNumbers);
            
            // Generate VCF content
            let vcfContent = 'BEGIN:VCARD\nVERSION:3.0\nFN:Group Members\nEND:VCARD\n\n';
            let validCount = 0;
            
            uniqueNumbers.forEach((num) => {
                // Clean the number - remove any non-digits
                const cleanNum = num.replace(/\D/g, '');
                if (cleanNum && cleanNum.length >= 7 && cleanNum.length <= 15) {
                    vcfContent += `BEGIN:VCARD\nVERSION:3.0\nFN:Member ${validCount + 1}\nTEL:+${cleanNum}\nEND:VCARD\n`;
                    validCount++;
                }
            });

            // Create temporary file and send
            const fs = await import('fs');
            const path = await import('path');
            const tempDir = '/tmp';
            const fileName = `scraped_members_${Date.now()}.vcf`;
            const filePath = path.join(tempDir, fileName);

            fs.writeFileSync(filePath, vcfContent);

            // Send file
            await bot.sendDocument(chatId, filePath);
            
            // Clean up temp file
            fs.unlinkSync(filePath);

            // Leave the group after scraping
            try {
                bot.sendMessage(chatId, `[CLEANUP] Leaving group...`);
                await sock.groupLeave(groupJid);
            } catch (leaveError) {
                bot.sendMessage(chatId, `[WARNING] Could not leave group: ${leaveError.message}`);
            }

            sendMenu(bot, chatId, `[SUCCESS]\nScraped: ${validCount} members\nLeft group\nVCF sent`);

        } catch (e) {
            bot.sendMessage(chatId, `[ERROR] Scrape failed: ${e.message}`);
        }
    });

    // Save - EXACT OLD LOGIC (1-by-1 check)
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

    // --- /profilepic command: Get profile picture of any WhatsApp number ---
    bot.onText(/\/profilepic\s+(\S+)/, async (msg, match) => {
        deleteUserCommand(bot, msg);
        if (msg.chat.id.toString() !== ADMIN_ID) return;
        const chatId = msg.chat.id;
        let numberOrId = match[1].trim();

        // Get first connected client to use for fetching
        const firstId = Object.keys(shortIdMap).find(id => clients[shortIdMap[id].folder]);
        if (!firstId) return bot.sendMessage(chatId, '[ERROR] Pair an account first.');
        const sock = clients[shortIdMap[firstId].folder];

        try {
            // Check if input is account ID or phone number
            let targetJid = numberOrId;
            let displayNumber = numberOrId;
            
            // If it's an account ID, get the phone number
            if (shortIdMap[numberOrId]) {
                targetJid = `${shortIdMap[numberOrId].phone}@s.whatsapp.net`;
                displayNumber = shortIdMap[numberOrId].phone;
            } else {
                // Assume it's a phone number
                const cleanNum = numberOrId.replace(/[^0-9]/g, '');
                if (cleanNum.length < 7 || cleanNum.length > 15) {
                    return bot.sendMessage(chatId, '[ERROR] Invalid number format.');
                }
                targetJid = `${cleanNum}@s.whatsapp.net`;
                displayNumber = cleanNum;
            }

            bot.sendMessage(chatId, `[FETCHING] Profile picture for +${displayNumber}...`);

            // Try to get profile picture with different privacy levels
            let picUrl = null;
            
            try {
                // Try getting the picture URL
                picUrl = await sock.profilePictureUrl(targetJid);
            } catch (picError) {
                // If we get authorization error, provide fallback info
                if (picError.message.includes('401') || picError.message.includes('403') || picError.message.includes('not authorized')) {
                    bot.sendMessage(chatId, `[PRIVACY] +${displayNumber} has restricted who can view their profile picture.\n[ALTERNATIVES] Try:\n1. Message them first\n2. Add to group\n3. Use a closer contact account`);
                    
                    // Try to get other info about the contact
                    try {
                        const [result] = await sock.onWhatsApp(targetJid);
                        if (result && result.exists) {
                            return sendMenu(bot, chatId, `[INFO]\nNumber exists on WhatsApp\nProfile picture is private\nNumber: +${displayNumber}`);
                        }
                    } catch (e) {}
                    
                    return;
                } else {
                    throw picError;
                }
            }

            if (!picUrl) {
                return bot.sendMessage(chatId, `[INFO] No profile picture set for +${displayNumber}`);
            }

            // Download and send the picture
            try {
                const response = await fetch(picUrl);
                if (!response.ok) {
                    return bot.sendMessage(chatId, `[ERROR] Could not download image (HTTP ${response.status})`);
                }
                
                const buffer = await response.buffer();

                await bot.sendPhoto(chatId, buffer, {
                    caption: `[PROFILE PIC]\nNumber: +${displayNumber}`
                });

                sendMenu(bot, chatId, `[SUCCESS] Profile picture sent.`);
            } catch (downloadError) {
                bot.sendMessage(chatId, `[ERROR] Failed to download image: ${downloadError.message}`);
            }

        } catch (e) {
            // Check if it's a not-found or invalid number error
            if (e.message.includes('404') || e.message.includes('not found')) {
                bot.sendMessage(chatId, `[ERROR] Number not found on WhatsApp.`);
            } else if (e.message.includes('401') || e.message.includes('403')) {
                bot.sendMessage(chatId, `[ERROR] Profile picture is private or account has restrictions.`);
            } else {
                bot.sendMessage(chatId, `[ERROR] ${e.message}`);
            }
        }
    });

    bot.onText(/\/deluser\s+(\d+)/, async (msg, match) => {
        deleteUserCommand(bot, msg);
        const chatId = msg.chat.id;
        const userId = chatId.toString();
        
        if (userId !== ADMIN_ID) {
            return bot.sendMessage(chatId, '[ERROR] Admin only.');
        }
        
        const targetUserId = match[1];
        if (!targetUserId) {
            return bot.sendMessage(chatId, '[ERROR] Usage: /deluser <user_id>');
        }
        
        try {
            await deleteUserAccount(targetUserId);
            sendMenu(bot, chatId, `[SUCCESS] User ${targetUserId} has been deleted from database.`);
        } catch (error) {
            bot.sendMessage(chatId, `[ERROR] Failed to delete user: ${error.message}`);
        }
    });

    bot.onText(/\/start/, async (msg) => {
        deleteUserCommand(bot, msg);
        const chatId = msg.chat.id;
        const userId = chatId.toString();
        userState[chatId] = null;
        
        // Admin bypasses verification
        if (userId === ADMIN_ID) {
            return sendMenu(bot, chatId, 'Ultarbot Pro Active - Admin Mode.');
        }
        
        // Check if already verified in database
        const verified = await isUserVerified(userId);
        if (verified) {
            verifiedUsers.add(userId);
            return sendMenu(bot, chatId, 'Ultarbot Pro Active.');
        }
        
        // NEW USER: Show mini app verification button (only once per session)
        // Check if we already sent verification message this session
        if (userMessageCache[chatId] && Array.isArray(userMessageCache[chatId]) && userMessageCache[chatId].length > 0) {
            return; // Already sent verification, don't send again
        }
        
        // Pass userId to mini app via URL parameter (extracted from Telegram command)
        const verifyUrl = `${serverUrl.replace(/\/$/, '')}/verify?userId=${userId}`;
        
        // Send verification message
        try {
            const sentMsg = await bot.sendMessage(chatId,
                '[SECURITY VERIFICATION]\n\nPlease complete the user verification to proceed.\n\nTap the button below to verify your details:',
                {
                    reply_markup: {
                        inline_keyboard: [[
                            { 
                                text: 'Verify Now',
                                web_app: { url: verifyUrl }
                            }
                        ]]
                    }
                }
            );
            if (sentMsg && sentMsg.message_id) {
                if (!userMessageCache[chatId]) userMessageCache[chatId] = [];
                userMessageCache[chatId].push(sentMsg.message_id);
            }
        } catch (error) {
            console.error('[START] Error sending verification message:', error.message);
        }
    });

    // /add command - flexible pattern to handle various formats
    bot.onText(/\/add/, async (msg) => {
        deleteUserCommand(bot, msg);
        const chatId = msg.chat.id;
        const userId = chatId.toString();
        const fullText = msg.text;
        
        if (userId !== ADMIN_ID) {
            return bot.sendMessage(chatId, '[ERROR] Admin only.');
        }
        
        // Parse: /add <user_id> <+/-points>
        const parts = fullText.split(/\s+/);
        if (parts.length < 3) {
            return bot.sendMessage(chatId, '[ERROR] Usage: /add <user_id> <+/-points>\nExample: /add 12345 +100 or /add 12345 -50');
        }
        
        const targetUserId = parts[1];
        const pointsStr = parts[2];
        const pointsChange = parseInt(pointsStr);
        
        if (!targetUserId || isNaN(pointsChange) || pointsChange === 0) {
            return bot.sendMessage(chatId, '[ERROR] Invalid format. Use: /add <user_id> <+/-points>\nExample: /add 12345 +100');
        }
        
        const user = await getUser(targetUserId);
        if (!user) {
            return bot.sendMessage(chatId, `[ERROR] User ${targetUserId} not found in database.`);
        }
        
        try {
            if (pointsChange > 0) {
                await addPointsToUser(targetUserId, pointsChange);
                bot.sendMessage(chatId, `[SUCCESS] Added ${pointsChange} points to user ${targetUserId}. New balance: ${user.points + pointsChange}`);
                bot.sendMessage(targetUserId, `You received ${pointsChange} bonus points!`, getKeyboard(targetUserId)).catch(() => {});
            } else {
                const newPoints = user.points + pointsChange;
                if (newPoints < 0) {
                    return bot.sendMessage(chatId, `[ERROR] User only has ${user.points} points. Cannot deduct ${Math.abs(pointsChange)}.`);
                }
                await addPointsToUser(targetUserId, pointsChange);
                bot.sendMessage(chatId, `[SUCCESS] Deducted ${Math.abs(pointsChange)} points from user ${targetUserId}. New balance: ${newPoints}`);
                bot.sendMessage(targetUserId, `${Math.abs(pointsChange)} points were deducted from your account.`, getKeyboard(targetUserId)).catch(() => {});
            }
        } catch (error) {
            bot.sendMessage(chatId, `[ERROR] Failed to update points: ${error.message}`);
        }
    });

    bot.on('message', async (msg) => {
        if (!msg.text || msg.text.startsWith('/')) return;
        const chatId = msg.chat.id;
        const text = msg.text;
        const userId = chatId.toString();
        const isUserAdmin = (userId === ADMIN_ID);
        
        // Prevent duplicate processing of the same message
        if (userState[chatId + '_lastMsgId'] === msg.message_id) return;
        userState[chatId + '_lastMsgId'] = msg.message_id;

            // --- LISTENER: Delete Message on Admin Reaction ---
    
        // Only if the Admin reacts
        if (event.user.id.toString() === ADMIN_ID) {
            try {
                // Delete the message that was reacted to
                await bot.deleteMessage(event.chat.id, event.message_id);
            } catch (e) {
                // Ignore if already deleted
            }
        }

        
        // RATE LIMIT CHECK
        if (!isUserAdmin && !checkRateLimit(userId)) {
            return bot.sendMessage(chatId, '[RATE LIMIT] Too many requests. Please wait 1 minute.');
        }
        
        // CAPTCHA VERIFICATION
        if (userState[chatId]?.step === 'CAPTCHA_PENDING') {
            if (text === userState[chatId].captchaAnswer) {
                await markUserVerified(userId);
                verifiedUsers.add(userId);
                userState[chatId] = null;
                return sendMenu(bot, chatId, 'Verification passed! Welcome to Ultarbot Pro.');
            } else {
                userState[chatId].attempts = (userState[chatId].attempts || 0) + 1;
                if (userState[chatId].attempts >= 3) {
                    userState[chatId] = null;
                    return bot.sendMessage(chatId, '[BLOCKED] Too many failed attempts. Type /start to try again.');
                }
                return bot.sendMessage(chatId, `[ERROR] Wrong digits. Try again. (${3 - userState[chatId].attempts} attempts left)`);
            }
        }

        if (userState[chatId] === 'WAITING_PAIR') {
            const number = text.replace(/[^0-9]/g, '');
            if (number.length < 10) return sendMenu(bot, chatId, 'Invalid number.');
            
            // CHECK 1: Verify CAPTCHA if not admin
            if (userId !== ADMIN_ID) {
                const dbVerified = await isUserVerified(userId);
                if (!dbVerified) {
                    bot.sendMessage(chatId, '[SECURITY] Please complete CAPTCHA verification first.');
                    userState[chatId] = null;
                    return;
                }
            }
            
            // CHECK 2: Check if number already exists
            const existingSession = Object.values(shortIdMap).find(s => s.phone === number);
            if (existingSession) {
                const existingId = Object.keys(shortIdMap).find(k => shortIdMap[k] === existingSession);
                return sendMenu(bot, chatId, `[ERROR] Number +${number} is already connected as ID: ${existingId}`);
            }
            
            userState[chatId] = null;
            bot.sendMessage(chatId, `Initializing +${number}...`, getKeyboard(chatId));
            const sessionId = makeSessionId();
            
            // Start the client
            startClient(sessionId, number, chatId, userId);
            
            // --- AUTO ENABLE ANTI-MSG ON CONNECT (PAIRING CODE) ---
            try {
                // We default it to true immediately in the database for this session ID
                await setAntiMsgStatus(sessionId, true);
                bot.sendMessage(chatId, `[SYSTEM] AntiMsg automatically set to ON for this session.\nMode: Block & Delete Zero Seconds`);
            } catch (e) {
                console.error("Failed to auto-set antimsg:", e);
            }
            
            return;
        }

        if (userState[chatId] === 'WAITING_QR_CONNECT') {
            // User is waiting for QR connection - silently ignore any typed text
            return;
        }

        if (userState[chatId] === 'WAITING_BANK_DETAILS') {
            const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
            if (lines.length < 3) {
                return bot.sendMessage(chatId, '[ERROR] Send 3 lines: Bank Name, Account Number, Account Name');
            }
            const [bankName, accNum, accName] = lines;
            await updateBank(userId, bankName, accNum, accName);
            userState[chatId] = null;
            sendMenu(bot, chatId, '[SUCCESS] Bank details saved.');
            return;
        }

        if (userState[chatId] === 'WAITING_WITHDRAW_AMOUNT') {
            const amount = parseInt(text);
            if (isNaN(amount) || amount <= 0) {
                return bot.sendMessage(chatId, '[ERROR] Enter valid amount.');
            }
            const user = await getUser(userId);
            if (!user || user.points < amount) {
                return bot.sendMessage(chatId, '[ERROR] Insufficient points.');
            }
            
            // Check minimum withdrawal based on account age
            let minWithdrawal = 3000; // Default: 3000 pts
            if (user.created_at) {
                const accountAge = Date.now() - new Date(user.created_at).getTime();
                const daysOld = accountAge / (1000 * 60 * 60 * 24);
                if (daysOld < 3) {
                    minWithdrawal = 1000; // First 3 days: 1000 pts minimum
                }
            }
            
            if (amount < minWithdrawal) {
                return bot.sendMessage(chatId, `[ERROR] Minimum withdrawal is ${minWithdrawal} points.\n\nYour account age: ${user.created_at ? Math.floor((Date.now() - new Date(user.created_at).getTime()) / (1000 * 60 * 60 * 24)) : '?'} days`);
            }
            
            const withdrawId = await createWithdrawal(userId, amount, Math.floor(amount * 0.5));
            userState[chatId] = null;
            sendMenu(bot, chatId, `[SUCCESS] Withdrawal #${withdrawId} requested. NGN: ${Math.floor(amount * 0.5)}`);
            
            // Notify admin of pending withdrawal
            const userBank = `Bank: ${user.bank_name || 'N/A'}\nAccount: ${user.account_number || 'N/A'}\nName: ${user.account_name || 'N/A'}`;
            const adminMsg = `[NEW WITHDRAWAL]\nID: ${withdrawId}\nUser: ${userId}\nAmount: ${amount} pts = NGN${Math.floor(amount * 0.5)}\n\n${userBank}`;
            await bot.sendMessage(ADMIN_ID, adminMsg, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'Approve', callback_data: `approve_${withdrawId}` }, { text: 'Reject', callback_data: `reject_${withdrawId}` }]
                    ]
                }
            });
            return;
        }

        if (userState[chatId] === 'WAITING_SUPPORT_ISSUE') {
            const issue = text;
            userState[chatId] = null;
            
            const user = await getUser(userId);
            const supportMsg = `[SUPPORT TICKET]\nUser: ${userId}\nName: ${user?.account_name || 'N/A'}\nPhone: ${user?.bank_name || 'N/A'}\n\nISSUE:\n${issue}`;
            
            await bot.sendMessage(ADMIN_ID, supportMsg, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'Reply to User', callback_data: `support_reply_${userId}` }]
                    ]
                }
            });
            
            sendMenu(bot, chatId, '[SUCCESS] Your issue has been sent to our support team. We will get back to you soon.');
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
                    reply_markup: { 
                        inline_keyboard: [
                            [{ text: 'Scan QR', callback_data: 'connect_qr' }, { text: 'Enter Phone', callback_data: 'connect_code' }]
                        ]
                    } 
                });
                break;

            case "List All":
                deleteUserCommand(bot, msg);
                if (!isUserAdmin) return bot.sendMessage(chatId, "Admin only.");
                
                try {
                    const allSessions = await getAllSessions(null);
                    const totalNums = await countNumbers();
                    let list = `[STATS]\nDB Contacts: ${totalNums}\n\n[BOTS]\n\n`;
                    
                    if (allSessions.length === 0) list += "No bots connected.";
                    else {
                        for (const s of allSessions) {
                            // Get ID directly from database (permanent storage)
                            const id = s.short_id;
                            
                            // Skip if no ID (corrupted data)
                            if (!id) continue;
                            
                            const dur = getDuration(s.connected_at);
                            const status = clients[s.session_id] ? '[ONLINE]' : '[OFFLINE]';
                            const anti = s.antimsg ? '[LOCKED]' : '[OPEN]';
                            list += `${status} \`${id}\` | +${s.phone}\n${anti} AntiMsg | ${dur}\n------------------\n`;
                        }
                    }
                    sendMenu(bot, chatId, list);
                } catch(e) {
                    console.error('[LIST ALL] Error:', e.message);
                    bot.sendMessage(chatId, "List Error: " + e.message);
                }
                break;

            case "Broadcast":
                deleteUserCommand(bot, msg);
                const activeIds = isUserAdmin ? Object.keys(shortIdMap) : Object.keys(shortIdMap).filter(id => shortIdMap[id].chatId === userId);
                if (activeIds.length === 0) return sendMenu(bot, chatId, "[ERROR] No active bots.");
                userState[chatId] = 'WAITING_BROADCAST_MSG';
                userState[chatId + '_target'] = activeIds[0];
                bot.sendMessage(chatId, `[BROADCAST]\nID: ${activeIds[0]}\n\nEnter message:`, { reply_markup: { force_reply: true } });
                break;

            case "Dashboard":
                deleteUserCommand(bot, msg);
                let user = await getUser(userId);
                if (!user) {
                    await createUser(userId);
                    user = await getUser(userId);
                }
                const todayEarn = await getTodayEarnings(userId);
                const yesterdayEarn = await getYesterdayEarnings(userId);
                const refStats = await getReferrals(userId);
                
                let dashMsg = `[DASHBOARD]\n\n`;
                dashMsg += `TOTAL BALANCE: ${user?.points || 0} points\n`;
                dashMsg += `TODAY: +${todayEarn}\n`;
                dashMsg += `YESTERDAY: +${yesterdayEarn}\n`;
                dashMsg += `REFERRALS: ${refStats.total}\n`;
                dashMsg += `REFERRAL EARNINGS: ${user?.referral_earnings || 0} points\n`;
                
                await deleteOldMessagesAndSend(bot, chatId, dashMsg, {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: "Earnings Details", callback_data: "earnings_details" }],
                            [{ text: "Withdrawal History", callback_data: "withdrawal_history" }]
                        ]
                    }
                });
                break;

            case "My Account":
                deleteUserCommand(bot, msg);
                let accUser = await getUser(userId);
                if (!accUser) {
                    await createUser(userId);
                    accUser = await getUser(userId);
                }
                
                // Get only this user's connected accounts from database (permanent storage)
                const userSessions = await getAllSessions(userId);
                let accMsg = `[MY ACCOUNT]\n\n`;
                
                if (userSessions.length === 0) {
                    accMsg += `No accounts connected.\n`;
                } else {
                    for (const session of userSessions) {
                        const id = session.short_id;
                        if (!id) continue; // Skip if no ID
                        const status = clients[session.session_id] ? 'ONLINE' : 'OFFLINE';
                        const dur = getDuration(session.connected_at);
                        accMsg += `${id} | +${session.phone} | [${status}] | ${dur}\n`;
                    }
                }
                sendMenu(bot, chatId, accMsg);
                break;

            case "Referrals":
                deleteUserCommand(bot, msg);
                let refUser = await getUser(userId);
                if (!refUser) {
                    await createUser(userId);
                    refUser = await getUser(userId);
                }
                const refData = await getReferrals(userId);
                let refMsg = `[REFERRALS]\n\n`;
                refMsg += `YOUR LINK:\nhttps://t.me/YourBotUsername?start=${userId}\n\n`;
                refMsg += `TOTAL REFERRALS: ${refData.total}\n`;
                refMsg += `REFERRAL EARNINGS: ${refUser?.referral_earnings || 0} points\n`;
                refMsg += `RATE: 5 points per hour (if referral is active)\n`;
                sendMenu(bot, chatId, refMsg);
                break;

            case "Withdraw":
                deleteUserCommand(bot, msg);
                let wUser = await getUser(userId);
                if (!wUser) {
                    await createUser(userId);
                    wUser = await getUser(userId);
                }
                if (!wUser.bank_name) {
                    await bot.sendMessage(chatId, `[BANK DETAILS]\n\nSend in format:\nBank Name\nAccount Number\nAccount Name\n\nExample:\nGTBank\n1234567890\nJohn Doe`, {
                        reply_markup: { 
                            inline_keyboard: [[{ text: 'Cancel', callback_data: 'cancel_action' }]]
                        }
                    });
                    userState[chatId] = 'WAITING_BANK_DETAILS';
                } else {
                    // Calculate minimum based on account age
                    let minWithdrawal = 3000;
                    if (wUser.created_at) {
                        const accountAge = Date.now() - new Date(wUser.created_at).getTime();
                        const daysOld = accountAge / (1000 * 60 * 60 * 24);
                        if (daysOld < 3) {
                            minWithdrawal = 1000;
                        }
                    }
                    
                    userState[chatId] = 'WAITING_WITHDRAW_AMOUNT';
                    bot.sendMessage(chatId, `Enter amount (Minimum: ${minWithdrawal} pts):`, { 
                        reply_markup: { 
                            inline_keyboard: [[{ text: 'Cancel', callback_data: 'cancel_action' }]]
                        }
                    });
                }
                break;

            case "Clear Contact List":
                deleteUserCommand(bot, msg);
                if(isUserAdmin) {
                    await clearAllNumbers();
                    sendMenu(bot, chatId, "[CLEARED] Database.");
                }
                break;

            case "Support":
                deleteUserCommand(bot, msg);
                userState[chatId] = 'WAITING_SUPPORT_ISSUE';
                bot.sendMessage(chatId, '[SUPPORT]\n\nPlease describe your issue or question:', {
                    reply_markup: {
                        inline_keyboard: [[{ text: 'Cancel', callback_data: 'cancel_action' }]]
                    }
                });
                break;
        }
    });

    bot.on('callback_query', async (query) => {
        const chatId = query.message.chat.id;
        const userId = chatId.toString();
        const data = query.data;

        if (data === 'cancel_action') {
            userState[chatId] = null;
            await bot.deleteMessage(chatId, query.message.message_id);
            await bot.answerCallbackQuery(query.id);
            return sendMenu(bot, chatId, 'Cancelled.');
        }

        // Handle QR cancel
        if (data === 'cancel_qr') {
            userState[chatId] = null;
            await bot.answerCallbackQuery(query.id, 'QR connection cancelled');
            try {
                await bot.deleteMessage(chatId, query.message.message_id);
            } catch (e) {
                // Message already deleted, ignore
            }
            return sendMenu(bot, chatId, 'QR connection cancelled. Please try again.');
        }

        // Handle QR connection
        if (data === 'connect_qr') {
            userState[chatId] = 'WAITING_QR_CONNECT';
            await bot.answerCallbackQuery(query.id);
            
            // Reset QR active state so new QR can be generated
            for (const folder in qrActiveState) {
                delete qrActiveState[folder];
            }
            
            // Delete old messages and send new one
            await deleteOldMessagesAndSend(bot, chatId, 'Initializing QR connection...\n\nGenerating QR code...', {
                reply_markup: { 
                    inline_keyboard: [[{ text: 'Cancel', callback_data: 'cancel_action' }]]
                }
            });
            
            // Start client with QR mode (no phone number, null = QR)
            const sessionId = makeSessionId();
            startClient(sessionId, null, chatId, userId);

            // --- AUTO ENABLE ANTI-MSG ON CONNECT (QR MODE) ---
            try {
                // We default it to true immediately in the database for this session ID
                await setAntiMsgStatus(sessionId, true);
                // Note: We don't send a text message here as the QR code is displaying
            } catch (e) {
                console.error("Failed to auto-set antimsg (QR):", e);
            }
            return;
        }

        // Handle phone number connection
        if (data === 'connect_code') {
            userState[chatId] = 'WAITING_PAIR';
            await bot.answerCallbackQuery(query.id);
            return deleteOldMessagesAndSend(bot, chatId, 'Enter WhatsApp number:', { 
                reply_markup: { 
                    inline_keyboard: [[{ text: 'Cancel', callback_data: 'cancel_action' }]]
                }
            });
        }

        // Handle withdrawal approval
        if (data.startsWith('approve_')) {
            const withdrawId = parseInt(data.split('_')[1]);
            await updateWithdrawalStatus(withdrawId, 'APPROVED');
            await bot.editMessageText(`[APPROVED] Withdrawal #${withdrawId} approved.`, { chat_id: chatId, message_id: query.message.message_id });
            await bot.answerCallbackQuery(query.id, { text: 'Withdrawal approved' });
            return;
        }

        // Handle withdrawal rejection
        if (data.startsWith('reject_')) {
            const withdrawId = parseInt(data.split('_')[1]);
            const withdrawal = await getWithdrawalDetails(withdrawId);
            if (withdrawal) {
                const telegramId = withdrawal.telegram_id;
                const points = withdrawal.amount_points;
                await updateWithdrawalStatus(withdrawId, 'REJECTED');
                await addPointsToUser(telegramId, points);
                await bot.sendMessage(telegramId, `[REJECTED] Withdrawal #${withdrawId} was rejected. ${points} points refunded.`, getKeyboard(telegramId));
            }
            await bot.editMessageText(`[REJECTED] Withdrawal #${withdrawId} rejected.`, { chat_id: chatId, message_id: query.message.message_id });
            await bot.answerCallbackQuery(query.id, { text: 'Withdrawal rejected' });
            return;
        }

        if (data === 'earnings_details') {
            const earnings = await getEarningsHistory(userId, 10);
            let msg = '[EARNINGS HISTORY]\n\n';
            if (earnings.length === 0) {
                msg += 'No earnings yet.';
            } else {
                for (const e of earnings) {
                    const date = new Date(e.created_at).toLocaleDateString();
                    msg += `+${e.amount} (${e.type}) - ${date}\n`;
                }
            }
            await bot.editMessageText(msg, { chat_id: chatId, message_id: query.message.message_id });
            await bot.answerCallbackQuery(query.id);
            return;
        }

        if (data === 'withdrawal_history') {
            const withdrawals = await getWithdrawalHistory(userId, 10);
            let msg = '[WITHDRAWAL HISTORY]\n\n';
            if (withdrawals.length === 0) {
                msg += 'No withdrawals yet.';
            } else {
                for (const w of withdrawals) {
                    const date = new Date(w.created_at).toLocaleDateString();
                    msg += `ID: ${w.id} | ${w.amount_points} pts = NGN${w.amount_ngn} | ${w.status} - ${date}\n`;
                }
            }
            await bot.editMessageText(msg, { chat_id: chatId, message_id: query.message.message_id });
            await bot.answerCallbackQuery(query.id);
            return;
        }

        await bot.answerCallbackQuery(query.id);
    });
}

export { userMessageCache, userState };
