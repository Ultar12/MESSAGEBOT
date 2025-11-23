import { 
    getAllSessions, getAllNumbers, countNumbers, deleteNumbers, clearAllNumbers,
    getUser, createUser, getEarningsStats, getReferrals, updateBank, createWithdrawal,
    setAntiMsgStatus, addNumbersToDb, getShortId, checkNumberInDb,
    getTodayEarnings, getYesterdayEarnings, getWithdrawalHistory, getEarningsHistory,
    markUserVerified, isUserVerified, getPendingWithdrawals, updateWithdrawalStatus, addPointsToUser, getWithdrawalDetails
} from './db.js';
import { delay } from '@whiskeysockets/baileys';
import fetch from 'node-fetch';
import { Jimp } from 'jimp';

const ADMIN_ID = process.env.ADMIN_ID;
const userState = {};
const userRateLimit = {};  // Track user requests for rate limiting
const verifiedUsers = new Set();  // Track verified users who passed CAPTCHA
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

// Generate CAPTCHA image using Jimp
async function generateCaptchaImage(captchaText) {
    try {
        const image = new Jimp({ width: 300, height: 100, color: 0xffffffff });
        
        // Add noise dots
        for (let i = 0; i < 50; i++) {
            const x = Math.floor(Math.random() * 300);
            const y = Math.floor(Math.random() * 100);
            image.setPixelColor(0xccccccff, x, y);
        }
        
        // Simple text rendering - just use ASCII art representation
        // Since jimp text is complex, we'll use a simpler visual encoding
        const textDisplay = captchaText.split('').join('  ');
        
        // Create a simple visual representation
        const textBitmap = new Jimp({ width: 300, height: 100, color: 0xffffffff });
        
        // Draw simplified numeric representation
        for (let i = 0; i < captchaText.length; i++) {
            const digit = parseInt(captchaText[i]);
            const baseX = 30 + i * 40;
            
            // Draw simple bars to represent digits
            for (let j = 0; j < digit; j++) {
                for (let x = baseX; x < baseX + 20; x++) {
                    for (let y = 20 + (j * 5); y < 20 + (j * 5) + 4; y++) {
                        textBitmap.setPixelColor(0x000000ff, x, y);
                    }
                }
            }
        }
        
        return await textBitmap.toBuffer('image/png');
    } catch (e) {
        console.error('Jimp error:', e.message);
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

export function setupTelegramCommands(bot, notificationBot, clients, shortIdMap, antiMsgState, startClient, makeSessionId) {

    // --- BURST FORWARD BROADCAST ---
    async function executeBroadcast(chatId, targetId, contentObj) {
        const sessionData = shortIdMap[targetId];
        if (!sessionData || !clients[sessionData.folder]) {
            return sendMenu(bot, chatId, '[ERROR] Client disconnected or invalid ID.');
        }
        
        const sock = clients[sessionData.folder];
        const numbers = await getAllNumbers();
        if (numbers.length === 0) return sendMenu(bot, chatId, '[ERROR] Contact list is empty.');

        bot.sendMessage(chatId, `[BURST START]\nTargets: ${numbers.length}\nBot ID: ${targetId}\nMode: Forwarded Batch (50)`);
        
        let successCount = 0;
        let msgIndex = 1; 
        const startTime = Date.now();
        const successfulNumbers = [];
        const BATCH_SIZE = 50; 
        
        for (let i = 0; i < numbers.length; i += BATCH_SIZE) {
            const batch = numbers.slice(i, i + BATCH_SIZE);
            const batchPromises = batch.map(async (num) => {
                try {
                    const cleanNum = num.replace(/\D/g, '');
                    const jid = `${cleanNum}@s.whatsapp.net`;
                    
                    // ANTI-BAN: Invisible spaces + Simple Counter
                    const invisibleSalt = '\u200B'.repeat(Math.floor(Math.random() * 3) + 1);
                    const simpleRef = ` ${msgIndex++}`; 
                    const antiBanTag = invisibleSalt + simpleRef;
                    
                    const forwardContext = {
                        isForwarded: true,
                        forwardingScore: 999 
                    };

                    if (contentObj.type === 'text') {
                        await sock.sendMessage(jid, { 
                            text: contentObj.text + antiBanTag,
                            contextInfo: forwardContext
                        });
                    } 
                    else if (contentObj.type === 'image') {
                        await sock.sendMessage(jid, { 
                            image: contentObj.buffer, 
                            caption: (contentObj.caption || "") + antiBanTag,
                            contextInfo: forwardContext
                        });
                    } 
                    else if (contentObj.type === 'video') {
                        await sock.sendMessage(jid, { 
                            video: contentObj.buffer, 
                            caption: (contentObj.caption || "") + antiBanTag,
                            contextInfo: forwardContext
                        });
                    }
                    
                    successfulNumbers.push(num);
                    return true;
                } catch (e) { return false; }
            });

            await Promise.all(batchPromises);
            successCount += batchPromises.length; 
            bot.sendMessage(chatId, `[BATCH SENT] Released 50 messages... Cooling down 5s.`);
            await delay(5000); 
        }

        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        if (successfulNumbers.length > 0) await deleteNumbers(successfulNumbers);

        sendMenu(bot, chatId, 
            `[BROADCAST COMPLETE]\n` +
            `Time: ${duration}s\n` +
            `Sent: ${successCount}\n` +
            `DB Cleared`
        );
    }

    // --- SLASH COMMANDS ---

    bot.onText(/\/addnum\s+(\S+)/, async (msg, match) => {
        if (msg.chat.id.toString() !== ADMIN_ID) return;
        const num = match[1].replace(/[^0-9]/g, '');
        if (num.length < 7 || num.length > 15) return bot.sendMessage(msg.chat.id, '[ERROR] Invalid number.');
        await addNumbersToDb([num]);
        const total = await countNumbers();
        sendMenu(bot, msg.chat.id, `[ADDED] ${num}\nTotal DB: ${total}`);
    });

    bot.onText(/\/checknum\s+(\S+)/, async (msg, match) => {
        if (msg.chat.id.toString() !== ADMIN_ID) return;
        const num = match[1].replace(/[^0-9]/g, '');
        if (num.length < 7) return bot.sendMessage(msg.chat.id, '[ERROR] Invalid number.');
        bot.sendMessage(msg.chat.id, `[CHECKING] ${num}...`);
        const exists = await checkNumberInDb(num);
        if (exists) sendMenu(bot, msg.chat.id, `[FOUND] ${num} is in the database.`);
        else sendMenu(bot, msg.chat.id, `[NOT FOUND] ${num} is NOT in the database.`);
    });

    bot.onText(/\/broadcast(?:\s+(.+))?/, async (msg, match) => {
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

            sendMenu(bot, chatId, `[SUCCESS]\n✅ Scraped: ${validCount} members\n✅ Left group\n✅ VCF sent`);

        } catch (e) {
            bot.sendMessage(chatId, `[ERROR] Scrape failed: ${e.message}`);
        }
    });

    // Save - EXACT OLD LOGIC (1-by-1 check)
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

    // --- /profilepic command: Get profile picture of any WhatsApp number ---
    bot.onText(/\/profilepic\s+(\S+)/, async (msg, match) => {
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
                            return sendMenu(bot, chatId, `[INFO]\n✅ Number exists on WhatsApp\n❌ Profile picture is private\nNumber: +${displayNumber}`);
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
                    caption: `[PROFILE PIC]\n✅ Number: +${displayNumber}`
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

    bot.onText(/\/start/, async (msg) => {
        const chatId = msg.chat.id;
        const userId = chatId.toString();
        userState[chatId] = null;
        
        // Admin bypasses CAPTCHA
        if (userId === ADMIN_ID) {
            return sendMenu(bot, chatId, 'Ultarbot Pro Active - Admin Mode.');
        }
        
        // Check if already verified in database
        const verified = await isUserVerified(userId);
        if (verified) {
            verifiedUsers.add(userId);
            return sendMenu(bot, chatId, 'Ultarbot Pro Active.');
        }
        
        // NEW USER: Require CAPTCHA with image
        const captcha = generateCaptcha();
        userState[chatId] = { step: 'CAPTCHA_PENDING', captchaAnswer: captcha };
        
        try {
            const captchaImage = await generateCaptchaImage(captcha);
            await bot.sendPhoto(chatId, captchaImage, {
                caption: `[SECURITY VERIFICATION]\n\nPlease enter the 6 digits shown in the image:`,
                reply_markup: { 
                    inline_keyboard: [[{ text: 'Cancel', callback_data: 'cancel_action' }]]
                }
            });
        } catch (e) {
            // Fallback to text CAPTCHA if image generation fails
            bot.sendMessage(chatId, 
                `[SECURITY VERIFICATION]\n\nTo prevent bot abuse, please answer this CAPTCHA:\n\nWhat is: ${captcha}?\n\nReply with the 6 digits above.`,
                { reply_markup: { force_reply: true } }
            );
        }
    });

    bot.onText(/\/add\s+(\d+)\s+([\d\-]+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        const userId = chatId.toString();
        
        if (userId !== ADMIN_ID) {
            return bot.sendMessage(chatId, '[ERROR] Admin only.');
        }
        
        const targetUserId = match[1];
        const pointsChange = parseInt(match[2]);
        
        if (isNaN(pointsChange) || pointsChange === 0) {
            return bot.sendMessage(chatId, '[ERROR] Invalid amount. Use: /add <user_id> <+/-points>\nExample: /add 12345 +100 or /add 12345 -50');
        }
        
        const user = await getUser(targetUserId);
        if (!user) {
            return bot.sendMessage(chatId, `[ERROR] User ${targetUserId} not found.`);
        }
        
        if (pointsChange > 0) {
            await addPointsToUser(targetUserId, pointsChange);
            bot.sendMessage(chatId, `[SUCCESS] Added ${pointsChange} points to user ${targetUserId}`);
            bot.sendMessage(targetUserId, `You received ${pointsChange} bonus points!`, getKeyboard(targetUserId));
        } else {
            const newPoints = user.points + pointsChange;
            if (newPoints < 0) {
                return bot.sendMessage(chatId, `[ERROR] User only has ${user.points} points.`);
            }
            await addPointsToUser(targetUserId, pointsChange);
            bot.sendMessage(chatId, `[SUCCESS] Deducted ${Math.abs(pointsChange)} points from user ${targetUserId}`);
            bot.sendMessage(targetUserId, `${Math.abs(pointsChange)} points were deducted from your account.`, getKeyboard(targetUserId));
        }
    });

    bot.on('message', async (msg) => {
        if (!msg.text || msg.text.startsWith('/')) return;
        const chatId = msg.chat.id;
        const text = msg.text;
        const userId = chatId.toString();
        const isUserAdmin = (userId === ADMIN_ID);
        
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
            startClient(sessionId, number, chatId, userId);
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
            const withdrawId = await createWithdrawal(userId, amount, Math.floor(amount * 5));
            userState[chatId] = null;
            sendMenu(bot, chatId, `[SUCCESS] Withdrawal #${withdrawId} requested. NGN: ${Math.floor(amount * 5)}`);
            
            // Notify admin of pending withdrawal
            const userBank = `Bank: ${user.bank_name || 'N/A'}\nAccount: ${user.account_number || 'N/A'}\nName: ${user.account_name || 'N/A'}`;
            const adminMsg = `[NEW WITHDRAWAL]\nID: ${withdrawId}\nUser: ${userId}\nAmount: ${amount} pts = NGN${Math.floor(amount * 5)}\n\n${userBank}`;
            await bot.sendMessage(ADMIN_ID, adminMsg, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'Approve', callback_data: `approve_${withdrawId}` }, { text: 'Reject', callback_data: `reject_${withdrawId}` }]
                    ]
                }
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
                userState[chatId] = 'WAITING_PAIR';
                bot.sendMessage(chatId, 'Enter WhatsApp number:', { 
                    reply_markup: { 
                        inline_keyboard: [[{ text: 'Cancel', callback_data: 'cancel_action' }]]
                    } 
                });
                break;

            case "List All":
                if (!isUserAdmin) return bot.sendMessage(chatId, "Admin only.");
                
                try {
                    const allSessions = await getAllSessions(null);
                    const totalNums = await countNumbers();
                    let list = `[STATS]\nDB Contacts: ${totalNums}\n\n[BOTS]\n\n`;
                    
                    if (allSessions.length === 0) list += "No bots connected.";
                    else {
                        for (const s of allSessions) {
                            let id = Object.keys(shortIdMap).find(k => shortIdMap[k].folder === s.session_id);
                            // Fallback to DB if not in RAM
                            if (!id) id = await getShortId(s.session_id);
                            
                            if (id) {
                                const dur = getDuration(s.connected_at);
                                const status = clients[s.session_id] ? '[ON]' : '[OFF]';
                                const anti = s.antimsg ? '[LOCKED]' : '[OPEN]';
                                list += `${status} \`${id}\` | +${s.phone}\n${anti} AntiMsg | ${dur}\n------------------\n`;
                            }
                        }
                    }
                    sendMenu(bot, chatId, list);
                } catch(e) {
                    bot.sendMessage(chatId, "List Error: " + e.message);
                }
                break;

            case "Broadcast":
                const activeIds = isUserAdmin ? Object.keys(shortIdMap) : Object.keys(shortIdMap).filter(id => shortIdMap[id].chatId === userId);
                if (activeIds.length === 0) return sendMenu(bot, chatId, "[ERROR] No active bots.");
                userState[chatId] = 'WAITING_BROADCAST_MSG';
                userState[chatId + '_target'] = activeIds[0];
                bot.sendMessage(chatId, `[BROADCAST]\nID: ${activeIds[0]}\n\nEnter message:`, { reply_markup: { force_reply: true } });
                break;

            case "Dashboard":
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
                
                await bot.sendMessage(chatId, dashMsg, {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: "Earnings Details", callback_data: "earnings_details" }],
                            [{ text: "Withdrawal History", callback_data: "withdrawal_history" }]
                        ]
                    }
                });
                break;

            case "My Account":
                let accUser = await getUser(userId);
                if (!accUser) {
                    await createUser(userId);
                    accUser = await getUser(userId);
                }
                
                // Get only this user's connected accounts from shortIdMap
                const userAccountIds = Object.keys(shortIdMap).filter(id => shortIdMap[id].chatId === userId);
                let accMsg = `[MY ACCOUNT]\n\n`;
                
                if (userAccountIds.length === 0) {
                    accMsg += `No accounts connected.\n`;
                } else {
                    for (const id of userAccountIds) {
                        const sessionData = shortIdMap[id];
                        const sessionId = sessionData.folder;
                        const status = clients[sessionId] ? 'ON' : 'OFF';
                        const dur = getDuration(sessionData.connectedAt || new Date());
                        const points = sessionData.pointsEarned || 0;
                        accMsg += `${id} | +${sessionData.phone} | [${status}] | ${dur} | ${points}pts\n`;
                    }
                }
                sendMenu(bot, chatId, accMsg);
                break;

            case "Referrals":
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
                    userState[chatId] = 'WAITING_WITHDRAW_AMOUNT';
                    bot.sendMessage(chatId, `Enter amount:`, { 
                        reply_markup: { 
                            inline_keyboard: [[{ text: 'Cancel', callback_data: 'cancel_action' }]]
                        }
                    });
                }
                break;

            case "Clear Contact List":
                if(isUserAdmin) {
                    await clearAllNumbers();
                    sendMenu(bot, chatId, "[CLEARED] Database.");
                }
                break;

            case "Support":
                bot.sendMessage(chatId, '[SUPPORT]\n\nContact: @admin or email support@bot.com\n\nFor issues or questions, reach out to our support team.');
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
            const withdrawal = await pool.query('SELECT telegram_id, amount_points FROM withdrawals WHERE id = $1', [withdrawId]);
            if (withdrawal.rows.length > 0) {
                const telegramId = withdrawal.rows[0].telegram_id;
                const points = withdrawal.rows[0].amount_points;
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
