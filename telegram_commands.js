import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

import { 
    getAllSessions, getAllNumbers, countNumbers, deleteNumbers, clearAllNumbers,
    getUser, createUser, getEarningsStats, getReferrals, updateBank, createWithdrawal,
    setAntiMsgStatus, addNumbersToDb, getShortId, checkNumberInDb,
    getTodayEarnings, getYesterdayEarnings, getWithdrawalHistory, getEarningsHistory,
    markUserVerified, isUserVerified, getPendingWithdrawals, updateWithdrawalStatus, addPointsToUser, getWithdrawalDetails
} from './db.js';
import { delay } from '@whiskeysockets/baileys';
import * as mammoth from 'mammoth';
import path from 'path';
import fs from 'fs'; 
import * as XLSX from 'xlsx';
import fetch from 'node-fetch';


const apiId = parseInt(process.env.TELEGRAM_API_ID); 
const apiHash = process.env.TELEGRAM_API_HASH;
const stringSession = new StringSession(process.env.TELEGRAM_SESSION || ""); 
const userBot = new TelegramClient(stringSession, apiId, apiHash, { connectionRetries: 5 });

// Initialize UserBot (Call this once in your index.js or startup)
export async function initUserBot() {
    await userBot.start({
        phoneNumber: async () => "2349133432346", 
        password: async () => "",
        phoneCode: async () => "",
        onError: (err) => console.log("[USERBOT ERROR]", err),
    });
    console.log("[USERBOT] Session:", userBot.session.save());
}


const ADMIN_ID = process.env.ADMIN_ID;
// Define SUBADMIN_IDS from environment variables (comma-separated list)
const SUBADMIN_IDS = (process.env.SUBADMIN_IDS || '').split(',').map(id => id.trim()).filter(id => id.length > 0); 
const userState = {};
const userRateLimit = {};  // Track user requests for rate limiting
const verifiedUsers = new Set();  // Track verified users who passed CAPTCHA
const userMessageCache = {};  // Track sent messages for cleanup - array of message IDs per chat
const RATE_LIMIT_WINDOW = 60000;  // 1 minute
const MAX_REQUESTS_PER_MINUTE = 10;  // Max requests per minute
const CAPTCHA_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0132456789';


const reactionConfigs = {}; 


// --- Shared Logic: Country Codes and Normalization ---

const countryDataMap = {
    '1': 'USA/Canada', '7': 'Russia/Kazakhstan', '20': 'Egypt', '27': 'South Africa', '30': 'Greece',
    '31': 'Netherlands', '32': 'Belgium', '33': 'France', '34': 'Spain', '36': 'Hungary',
    '39': 'Italy', '40': 'Romania', '41': 'Switzerland', '43': 'Austria', '44': 'United Kingdom',
    '45': 'Denmark', '46': 'Sweden', '47': 'Norway', '48': 'Poland', '49': 'Germany',
    '51': 'Peru', '52': 'Mexico', '53': 'Cuba', '54': 'Argentina', '55': 'Brazil',
    '56': 'Chile', '57': 'Colombia', '58': 'Venezuela', '60': 'Malaysia', '61': 'Australia',
    '62': 'Indonesia', '63': 'Philippines', '64': 'New Zealand', '65': 'Singapore', '66': 'Thailand',
    '81': 'Japan', '82': 'South Korea', '84': 'Vietnam', '86': 'China', '90': 'Turkey',
    '91': 'India', '92': 'Pakistan', '93': 'Afghanistan', '94': 'Sri Lanka', '95': 'Myanmar',
    '98': 'Iran', '211': 'South Sudan', '212': 'Morocco', '213': 'Algeria', '216': 'Tunisia',
    '218': 'Libya', '220': 'Gambia', '221': 'Senegal', '222': 'Mauritania', '223': 'Mali',
    '224': 'Guinea', '225': 'Ivory Coast', '226': 'Burkina Faso', '227': 'Niger', '228': 'Togo',
    '229': 'Benin', '230': 'Mauritius', '231': 'Liberia', '232': 'Sierra Leone', '233': 'Ghana',
    '234': 'Nigeria', '235': 'Chad', '236': 'Central African Republic', '237': 'Cameroon', '238': 'Cape Verde',
    '239': 'Sao Tome and Principe', '240': 'Equatorial Guinea', '241': 'Gabon', '242': 'Congo', '243': 'DR Congo',
    '244': 'Angola', '245': 'Guinea-Bissau', '248': 'Seychelles', '249': 'Sudan', '250': 'Rwanda',
    '251': 'Ethiopia', '252': 'Somalia', '253': 'Djibouti', '254': 'Kenya', '255': 'Tanzania',
    '256': 'Uganda', '257': 'Burundi', '258': 'Mozambique', '260': 'Zambia', '261': 'Madagascar',
    '262': 'Reunion', '263': 'Zimbabwe', '264': 'Namibia', '265': 'Malawi', '266': 'Lesotho',
    '267': 'Botswana', '268': 'Eswatini', '269': 'Comoros', '290': 'Saint Helena', '291': 'Eritrea',
    '297': 'Aruba', '298': 'Faroe Islands', '299': 'Greenland', '350': 'Gibraltar', '351': 'Portugal',
    '352': 'Luxembourg', '353': 'Ireland', '354': 'Iceland', '355': 'Albania', '356': 'Malta',
    '357': 'Cyprus', '358': 'Finland', '359': 'Bulgaria', '370': 'Lithuania', '371': 'Latvia',
    '372': 'Estonia', '373': 'Moldova', '374': 'Armenia', '375': 'Belarus', '376': 'Andorra',
    '377': 'Monaco', '378': 'San Marino', '380': 'Ukraine', '381': 'Serbia', '382': 'Montenegro',
    '383': 'Kosovo', '385': 'Croatia', '386': 'Slovenia', '387': 'Bosnia and Herzegovina', '389': 'North Macedonia',
    '420': 'Czech Republic', '421': 'Slovakia', '423': 'Liechtenstein', '501': 'Belize', '502': 'Guatemala',
    '503': 'El Salvador', '504': 'Honduras', '505': 'Nicaragua', '506': 'Costa Rica', '507': 'Panama',
    '509': 'Haiti', '591': 'Bolivia', '592': 'Guyana', '593': 'Ecuador', '595': 'Paraguay',
    '597': 'Suriname', '598': 'Uruguay', '673': 'Brunei', '674': 'Nauru', '675': 'Papua New Guinea',
    '676': 'Tonga', '677': 'Solomon Islands', '678': 'Vanuatu', '679': 'Fiji', '680': 'Palau',
    '685': 'Samoa', '850': 'North Korea', '852': 'Hong Kong', '853': 'Macau', '855': 'Cambodia',
    '856': 'Laos', '880': 'Bangladesh', '886': 'Taiwan', '960': 'Maldives', '961': 'Lebanon',
    '962': 'Jordan', '963': 'Syria', '964': 'Iraq', '965': 'Kuwait', '966': 'Saudi Arabia',
    '967': 'Yemen', '968': 'Oman', '970': 'Palestine', '971': 'UAE', '972': 'Israel',
    '973': 'Bahrain', '974': 'Qatar', '975': 'Bhutan', '976': 'Mongolia', '977': 'Nepal',
    '992': 'Tajikistan', '993': 'Turkmenistan', '994': 'Azerbaijan', '995': 'Georgia', '996': 'Kyrgyzstan',
    '998': 'Uzbekistan',
    // Nanp specific sub-codes
    '1242': 'Bahamas', '1246': 'Barbados', '1264': 'Anguilla', '1268': 'Antigua and Barbuda', 
    '1284': 'British Virgin Islands', '1340': 'US Virgin Islands', '1345': 'Cayman Islands', 
    '1441': 'Bermuda', '1473': 'Grenada', '1649': 'Turks and Caicos Islands', 
    '1664': 'Montserrat', '1670': 'Northern Mariana Islands', '1671': 'Guam', 
    '1684': 'American Samoa', '1721': 'Sint Maarten', '1758': 'Saint Lucia', 
    '1767': 'Dominica', '1784': 'Saint Vincent and the Grenadines', '1809': 'Dominican Republic', 
    '1829': 'Dominican Republic', '1849': 'Dominican Republic', '1868': 'Trinidad and Tobago', 
    '1869': 'Saint Kitts and Nevis', '1876': 'Jamaica'
};

const countryCodes = Object.keys(countryDataMap).sort((a, b) => b.length - a.length);

function normalizeWithCountry(rawNumber) {
    if (!rawNumber) return null;
    let num = rawNumber.toString().replace(/[^0-9]/g, '');

    if (num.length < 7 || num.length > 16) return null;

    // Handle Nigeria specifically (234 prefix)
    if (num.startsWith('234')) {
        return { num: '0' + num.substring(3), name: 'Nigeria', code: '234' };
    }
    
    // Handle local 10/11 digit Nigerian numbers
    if (num.length >= 10 && num.length <= 11) {
        if (num.length === 11 && num.startsWith('0')) {
            return { num: num, name: 'Nigeria', code: '234' };
        }
        if (num.length === 10 && !num.startsWith('0')) {
            return { num: '0' + num, name: 'Nigeria', code: '234' };
        }
    }

    // Check other country codes
    for (const code of countryCodes) {
        if (num.startsWith(code)) {
            const stripped = num.substring(code.length);
            const formatted = (code === '1') ? stripped : '0' + stripped;
            return { 
                num: formatted, 
                name: countryDataMap[code] || 'International', 
                code: code 
            };
        }
    }
    
    if (num.length >= 7) {
         return { num: num, name: 'Local/Unknown', code: 'N/A' };
    }
    
    return null;
}


// --- Shared Filter and Batch Sender ---
async function processNumbers(rawText, chatId, shortIdMap, bot) {
    // NOTE: This function assumes normalize() and countryCodes are defined globally/locally.
    
    // 1. Build List of Connected Numbers (Normalized)
    const connectedSet = new Set();
    Object.values(shortIdMap).forEach(session => {
        const norm = normalize(session.phone);
        if (norm) connectedSet.add(norm);
    });

    // 2. Process & Filter
    const newNumbers = new Set();
    const lines = rawText.split(/\r?\n/);
    
    let skippedCount = 0;

    lines.forEach(line => {
        const normalizedFileNum = normalize(line);
        if (normalizedFileNum) {
            if (connectedSet.has(normalizedFileNum)) {
                skippedCount++;
            } else {
                newNumbers.add(normalizedFileNum);
            }
        }
    });

    const uniqueList = Array.from(newNumbers);
    const total = uniqueList.length;
    
    if (total === 0) {
        return bot.sendMessage(chatId, `[DONE] No new numbers.\nSkipped **${skippedCount}** duplicates/connected numbers.`, { parse_mode: 'Markdown' });
    }

    // 3. Send Batch
    const batchSize = 5;
    const totalBatches = Math.ceil(total / batchSize);
    
    bot.sendMessage(chatId, 
        `**[FILTER REPORT]**\n` +
        `Input Found: ${lines.length}\n` +
        `Already Connected: ${skippedCount}\n` +
        `**New Numbers:** ${total}\n\n` +
        `[SENDING] ${totalBatches} batches...`, 
        { parse_mode: 'Markdown' }
    );

    for (let i = 0; i < total; i += batchSize) {
        const chunk = uniqueList.slice(i, i + batchSize);
        if (chunk.length === 0) continue;

        // **FIX APPLIED HERE:** Use inline backticks (` `) around each number.
        // This makes each number individually tap-to-copyable.
        const msgText = chunk.map(n => `\`${n}\``).join('\n');
        
        // Note: No triple backticks needed now, just the list of inline code blocks.
        let batchMessage = msgText; 

        await bot.sendMessage(chatId, batchMessage, { parse_mode: 'Markdown' });
        await delay(1200);
    }
    
    bot.sendMessage(chatId, '**[DONE]** Batch sending complete.', { parse_mode: 'Markdown' });
}


// ... existing variables ...


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

// NEW: Restricted keyboard for SUBADMINS
const subadminKeyboard = {
    keyboard: [
        [{ text: "Connect Account" }, { text: "My Numbers" }],
    ],
    resize_keyboard: true
};

function getKeyboard(chatId) {
    const userId = chatId.toString();
    const isAdmin = (userId === ADMIN_ID);
    const isSubAdmin = SUBADMIN_IDS.includes(userId); 

    if (isAdmin) {
        return { reply_markup: adminKeyboard };
    }
    // Return subadmin keyboard if they are a subadmin
    if (isSubAdmin) {
        return { reply_markup: subadminKeyboard };
    }
    // Default to user keyboard
    return { reply_markup: userKeyboard };
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

/**
 * Main setup function for all Telegram bot commands and listeners.
 * @param {object} bot The Telegram bot instance.
 * @param {object} notificationBot The Telegram bot instance used for notifications (can be same as bot).
 * @param {object} clients Map of active Baileys clients.
 * @param {object} shortIdMap Map of short IDs to session data.
 * @param {object} antiMsgState Map of short IDs to AntiMsg status.
 * @param {function} startClient Function to initiate a new Baileys client.
 * @param {function} makeSessionId Function to generate a unique session ID.
 * @param {string} serverUrl Base URL for the mini-app server.
 * @param {object} qrActiveState State tracking QR code generation.
 * @param {function} deleteUserAccount Function to delete a user account from DB.
 */
export function setupTelegramCommands(bot, notificationBot, clients, shortIdMap, antiMsgState, startClient, makeSessionId, serverUrl = '', qrActiveState = {}, deleteUserAccount = null) {

    // NOTE: Returning a dummy function as the real notification logic is now centralized in index.js
    const notifyDisconnection = () => {};

    // --- BURST FORWARD BROADCAST ---
    async function executeBroadcast(chatId, targetId, contentObj) {
        const sessionData = shortIdMap[targetId];
        if (!sessionData || !clients[sessionData.folder]) {
            return sendMenu(bot, chatId, '[ERROR] Client disconnected or invalid ID.');
        }
        
        const sock = clients[sessionData.folder];
        const numbers = await getAllNumbers();
        if (numbers.length === 0) return sendMenu(bot, chatId, '[ERROR] Contact list is empty.');

        bot.sendMessage(chatId, '[BURST START]\nTargets: ' + numbers.length + '\nBot ID: ' + targetId + '\nMode: Anti-Ban Delivery');
        
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
                
                // ANTI-BAN: Multiple techniques (removed visible emojis)
                const antiBanTag = ' #' + msgIndex;
                
                // Context info to appear forwarded
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
            bot.sendMessage(chatId, '[PROGRESS] Sent: ' + (deliveredCount + failedCount) + '/' + numbers.length).catch(() => {});
        }
        
        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        if (successfulNumbers.length > 0) await deleteNumbers(successfulNumbers);

        sendMenu(bot, chatId, 
            '[BROADCAST COMPLETE]\n' +
            'Time: ' + duration + 's\n' +
            'Delivered: ' + deliveredCount + '\n' +
            'Failed: ' + failedCount + '\n' +
            'DB Cleared'
        );
    }


      // --- /txt Command: Text File Smart Filter (Admin & Subadmin) ---
    bot.onText(/\/txt/, async (msg) => {
        deleteUserCommand(bot, msg);
        const chatId = msg.chat.id;
        const userId = chatId.toString();
        
        // Authorization: Allow both Admin and Subadmins
        const isUserAdmin = (userId === ADMIN_ID);
        const isSubAdmin = SUBADMIN_IDS.includes(userId);

        if (!isUserAdmin && !isSubAdmin) return;

        if (!msg.reply_to_message || !msg.reply_to_message.document) {
            return bot.sendMessage(chatId, '[ERROR] Reply to a .txt or .vcf file with /txt');
        }

        try {
            bot.sendMessage(chatId, '[PROCESSING] comparing with connected accounts...');

            // --- STEP 1: Build List of Connected Numbers (Normalized) ---
            const connectedSet = new Set();
            Object.values(shortIdMap).forEach(session => {
                const res = normalizeWithCountry(session.phone);
                if (res) connectedSet.add(res.num);
            });

            // --- STEP 2: Read File ---
            const fileId = msg.reply_to_message.document.file_id;
            const fileLink = await bot.getFileLink(fileId);
            const response = await fetch(fileLink);
            const rawText = await response.text();

            // --- STEP 3: Process & Filter ---
            const newNumbers = new Set();
            const lines = rawText.split(/\r?\n/);
            
            let skippedCount = 0;
            let detectedCountry = "Unknown";
            let detectedCode = "N/A";

            lines.forEach(line => {
                const result = normalizeWithCountry(line.trim());

                if (result && result.num) {
                    // Capture country info from the first valid number found
                    if (detectedCountry === "Unknown" && result.name !== "Local/Unknown") {
                        detectedCountry = result.name;
                        detectedCode = result.code;
                    }

                    if (connectedSet.has(result.num)) {
                        skippedCount++;
                    } else {
                        newNumbers.add(result.num);
                    }
                }
            });

            const uniqueList = Array.from(newNumbers);
            const total = uniqueList.length;
            
            if (total === 0) {
                return bot.sendMessage(chatId, '[DONE] No new numbers found.\nSkipped ' + skippedCount + ' connected numbers.');
            }

            // --- STEP 4: Send Report and Batches ---
            const batchSize = 5;
            const totalBatches = Math.ceil(total / batchSize);
            
            bot.sendMessage(chatId, 
                '[FILTER REPORT]\n' +
                'Country: ' + detectedCountry + ' (+' + detectedCode + ')\n' +
                'Input Found: ' + lines.length + '\n' +
                'Already Connected: ' + skippedCount + '\n' +
                'New Numbers: ' + total + '\n\n' +
                '[SENDING] ' + totalBatches + ' batches...'
            );

            for (let i = 0; i < total; i += batchSize) {
                const chunk = uniqueList.slice(i, i + batchSize);
                if (chunk.length === 0) continue;

                // Format with backticks for copy-on-tap
                const msgText = chunk.map(n => '`' + n + '`').join('\n');

                await bot.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
                await delay(1200); // 1.2s safety delay
            }
            
            bot.sendMessage(chatId, '[DONE] Batch sending complete.');

        } catch (e) {
            bot.sendMessage(chatId, '[ERROR] ' + e.message);
        }
    });  

    // 1. LOGOUT ALL (Iterates EVERY connected account)
    bot.onText(/\/logoutall/, async (msg) => {
        deleteUserCommand(bot, msg);
        if (msg.chat.id.toString() !== ADMIN_ID) return;
        const chatId = msg.chat.id;
        
        const connectedFolders = Object.keys(clients);
        const totalConnected = connectedFolders.length;
        
        if (totalConnected === 0) return sendMenu(bot, chatId, "[ERROR] No accounts connected.");

        bot.sendMessage(chatId, '[SYSTEM CLEANUP] Found ' + totalConnected + ' active accounts.\nStarting Global Logout Sequence (Slots 1-20)...');

        let processedCount = 0;
        
        for (const folder of connectedFolders) {
            const sock = clients[folder];
            const shortId = Object.keys(shortIdMap).find(key => shortIdMap[key].folder === folder) || 'Unknown';
            
            try {
                await performLogoutSequence(sock, shortId, bot, chatId);
                processedCount++;
            } catch (e) {
                console.error('Logout failed for ' + shortId + ': ' + e);
            }
        }

        sendMenu(bot, chatId, '[LOGOUT COMPLETE]\n\nProcessed: ' + processedCount + '/' + totalConnected + ' Accounts\nUnlinking attempts sent.\nBots disconnected.');
    });

    // 2. LOGOUT SINGLE
    bot.onText(/\/logout\s+(\S+)/, async (msg, match) => {
        deleteUserCommand(bot, msg);
        if (msg.chat.id.toString() !== ADMIN_ID) return;
        
        const targetId = match[1];
        if (!targetId || !shortIdMap[targetId]) return sendMenu(bot, msg.chat.id, '[ERROR] Invalid ID: ' + targetId);

        const sessionData = shortIdMap[targetId];
        const sock = clients[sessionData.folder];

        if (!sock) return sendMenu(bot, msg.chat.id, '[ERROR] Client ' + targetId + ' is not connected.');

        try {
            bot.sendMessage(msg.chat.id, '[LOGOUT] ' + targetId + ' (+' + sessionData.phone + ')\nUnlinking companion devices...');
            
            const kicked = await performLogoutSequence(sock, targetId, bot, msg.chat.id);
            
            sendMenu(bot, msg.chat.id, '[SUCCESS] Logout complete for ' + targetId + '.');
        } catch (e) {
            bot.sendMessage(msg.chat.id, '[ERROR] Logout failed: ' + e.message);
        }
    });

        // --- /xl Command: Excel Smart Filter (Admin & Subadmin) ---
        // --- /xl Command: Excel Smart Filter (Admin & Subadmin) ---
    bot.onText(/\/xl/, async (msg) => {
        deleteUserCommand(bot, msg);
        const chatId = msg.chat.id;
        const userId = chatId.toString();
        const isUserAdmin = (userId === ADMIN_ID);
        const isSubAdmin = SUBADMIN_IDS.includes(userId);

        if (!isUserAdmin && !isSubAdmin) return;

        if (!msg.reply_to_message || !msg.reply_to_message.document) {
            return bot.sendMessage(chatId, '[ERROR] Reply to an .xlsx file with /xl');
        }

        try {
            bot.sendMessage(chatId, '[PROCESSING] Reading Excel file...');
            
            const connectedSet = new Set();
            Object.values(shortIdMap).forEach(session => {
                const norm = normalizeWithCountry(session.phone);
                if (norm) connectedSet.add(norm.num);
            });

            const fileId = msg.reply_to_message.document.file_id;
            const fileLink = await bot.getFileLink(fileId);
            const response = await fetch(fileLink);
            const buffer = await response.buffer();

            const workbook = XLSX.read(buffer, { type: 'buffer' });
            const sheet = workbook.Sheets[workbook.SheetNames[0]];
            const data = XLSX.utils.sheet_to_json(sheet, { header: 1 }); 

            const newNumbers = new Set();
            let skippedCount = 0;
            let totalChecked = 0;
            let detectedCountry = "Unknown";
            let detectedCode = "N/A";

            data.forEach(row => {
                if (!Array.isArray(row)) return;
                row.forEach(cell => {
                    if (!cell) return;
                    totalChecked++;
                    const result = normalizeWithCountry(cell.toString());
                    if (result && result.num) {
                        // Capture country info from the first valid number found
                        if (detectedCountry === "Unknown" && result.name !== "Unknown") {
                            detectedCountry = result.name;
                            detectedCode = result.code;
                        }

                        if (connectedSet.has(result.num)) {
                            skippedCount++;
                        } else {
                            newNumbers.add(result.num);
                        }
                    }
                });
            });

            const uniqueList = Array.from(newNumbers);
            const totalNew = uniqueList.length;

            if (totalNew === 0) {
                return bot.sendMessage(chatId, '[DONE] No new numbers found.\nSkipped ' + skippedCount + ' connected numbers.');
            }

            const batchSize = 5;
            const totalBatches = Math.ceil(totalNew / batchSize);

            bot.sendMessage(chatId, 
                '[FILTER REPORT]\n' +
                'Country: ' + detectedCountry + ' (+' + detectedCode + ')\n' +
                'Input Found: ' + totalChecked + '\n' +
                'Already Connected: ' + skippedCount + '\n' +
                'New Numbers: ' + totalNew + '\n\n' +
                '[SENDING] ' + totalBatches + ' batches...'
            );

            for (let i = 0; i < totalNew; i += batchSize) {
                const chunk = uniqueList.slice(i, i + batchSize);
                const msgText = chunk.map(n => '`' + n + '`').join('\n');
                await bot.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
                await delay(1200);
            }
            
            bot.sendMessage(chatId, '[DONE] Excel processing complete.');
        } catch (e) {
            bot.sendMessage(chatId, '[ERROR] ' + e.message);
        }
    });


        // --- /svv Command: Smart Filter (Reply to DOCX, TXT, VCF) ---
    // Usage: Reply to a document (.docx, .txt, .vcf) with /svv
    bot.onText(/\/svv/, async (msg) => {
        deleteUserCommand(bot, msg);
        const userId = msg.chat.id.toString();
        
        if (userId !== ADMIN_ID && !SUBADMIN_IDS.includes(userId)) {
            return; 
        }
        const chatId = msg.chat.id;

        if (!msg.reply_to_message || !msg.reply_to_message.document) {
            return bot.sendMessage(chatId, '[ERROR] Reply to a document (.docx, .txt, .vcf) with /svv');
        }

        const document = msg.reply_to_message.document;
        const fileName = document.file_name || 'file';
        const fileExtension = path.extname(fileName).toLowerCase();

        try {
            bot.sendMessage(chatId, '[PROCESSING] Starting file download...');

            // 1. Get Download Link and File Buffer
            const fileId = document.file_id;
            const fileLink = await bot.getFileLink(fileId);
            
            const response = await fetch(fileLink);
            if (!response.ok) {
                return bot.sendMessage(chatId, `[ERROR] Failed to download file. HTTP Status: ${response.status}`);
            }
            const fileBuffer = await response.buffer();
            
            let rawText = '';
            
            // 2. CONVERSION LOGIC (DOCX, TXT, VCF)
            if (fileExtension === '.docx') {
                if (typeof mammoth?.extractRawText === 'function') {
                    bot.sendMessage(chatId, '[CONVERTING] Converting DOCX to text...');
                    // Use mammoth to extract text from the buffer
                    const result = await mammoth.extractRawText({ buffer: fileBuffer });
                    rawText = result.value;
                } else {
                     // Fallback if mammoth is not installed
                     bot.sendMessage(chatId, '[ERROR] DOCX library (mammoth) is missing. Treating as raw data.');
                     rawText = fileBuffer.toString('utf-8');
                }
            } else {
                // Treats VCF, TXT, and all others as standard UTF-8 text
                rawText = fileBuffer.toString('utf-8');
            }

            // 3. PROCESS NUMBERS using the shared helper function
            if (rawText.length > 0) {
                // Pass rawText and necessary objects to the shared processor
                await processNumbers(rawText, chatId, shortIdMap, bot);
            } else {
                bot.sendMessage(chatId, '[ERROR] Converted file content was empty.');
            }

        } catch (e) {
            bot.sendMessage(chatId, `[ERROR] Processing failed: ${e.message}`);
        }
    });


    // --- /sendgroup [message] | [bot_count] | [group_link] ---
    // Executes a message send job across X bots with a 3-second delay between each bot.
    bot.onText(/^\/sendgroup (.+?) \| (\d+) \| (.+)$/, async (msg, match) => {
        deleteUserCommand(bot, msg);
        const chatId = msg.chat.id;
        const adminId = String(ADMIN_ID); 

        // 1. Authorization Check (Only admin can run broadcast)
        if (String(chatId) !== adminId) {
            return bot.sendMessage(chatId, "Access Denied. This command is for the bot administrator only.");
        }

        const message = match[1].trim();
        const botCount = parseInt(match[2].trim());
        const groupLinkOrCode = match[3].trim();

        if (botCount <= 0 || isNaN(botCount)) {
            return bot.sendMessage(chatId, "Bot count must be a valid number greater than zero.");
        }

        // 2. Extract Group Code
        let groupCode = '';
        try {
            groupCode = groupLinkOrCode.includes('chat.whatsapp.com/') 
                ? groupLinkOrCode.split('chat.whatsapp.com/')[1].split(/[\s?#&]/)[0] 
                : groupLinkOrCode;
        } catch (e) {
            return bot.sendMessage(chatId, 'Invalid group link format.', { parse_mode: 'Markdown' });
        }
        
        // 3. Get Active Bots and Limit Count
        const activeFolders = Object.keys(clients).filter(folder => clients[folder]);
        const countToUse = Math.min(botCount, activeFolders.length);
        
        if (countToUse === 0) {
            return bot.sendMessage(chatId, 'No active bots available to send the message.', { parse_mode: 'Markdown' });
        }

        // 4. Initial Report (using deleteOldMessagesAndSend is safer here)
        const startingMsg = await bot.sendMessage(chatId, 
            'Starting Group Broadcast Job...\n' +
            'Bots Selected: ' + countToUse + '/' + activeFolders.length + '\n' +
            'Target Group: ' + groupCode + '\n' +
            'Interval: 3 seconds (to avoid rate limits)\n\n' +
            '*Progress: 0/' + countToUse + '*', 
            { parse_mode: 'Markdown' }
        );
        
        // 5. Initialize Results
        let successCount = 0;
        let failCount = 0;
        let alreadyInCount = 0;

        // 6. Processing Loop (The core logic)
        for (let i = 0; i < countToUse; i++) {
            const folder = activeFolders[i];
            const sock = clients[folder];
            
            const shortIdEntry = shortIdMap[Object.keys(shortIdMap).find(k => shortIdMap[k].folder === folder)];
            const phoneNumber = shortIdEntry?.phone || folder;
            
            let statusText = 'Bot +' + phoneNumber + ' (`' + folder + '`): '; // Use folder as short ID may not be mapped yet

            try {
                let groupJid = null;
                
                // Step 6a: Attempt to join the group
                await sock.groupAcceptInvite(groupCode);
                await delay(1000); 
                
                // Step 6b: Find the Group JID (Required to send a message)
                const metadata = await sock.groupGetInviteInfo(groupCode);
                groupJid = metadata.id;

                // Step 6c: Send the message
                await sock.sendMessage(groupJid, { text: message });
                successCount++;
                statusText += 'Message Sent.';

            } catch (e) {
                const err = String(e.message) || String(e);
                
                // Check specific error codes for "Already in group"
                if (err.includes('participant') || err.includes('exist') || err.includes('409')) {
                    alreadyInCount++;
                    statusText += 'Already in group, message assumed sent.';
                } else {
                    failCount++;
                    statusText += 'Failed: ' + err.substring(0, 50) + '...';
                    console.error('[BROADCAST FAIL] Bot ' + folder + ': ' + err);
                }
            }
            
            // 7. Update Progress Message
            try {
                await bot.editMessageText(
                    'Group Broadcast Job In Progress...\n' +
                    'Bots Selected: ' + countToUse + '/' + activeFolders.length + '\n' +
                    'Target Group: ' + groupCode + '\n' +
                    'Interval: 3 seconds\n\n' +
                    '*Progress: ' + (i + 1) + '/' + countToUse + '* (Sent: ' + successCount + ', Failed: ' + failCount + ', In Group: ' + alreadyInCount + ')\n\n' +
                    'Last Bot Status:\n`' + statusText + '`',
                    {
                        chat_id: chatId,
                        message_id: startingMsg.message_id,
                        parse_mode: 'Markdown'
                    }
                );
            } catch (e) { /* Ignore edit errors */ }


            // 8. DELAY: 3 Seconds between bots
            if (i < countToUse - 1) await delay(3000);
        }
        
        // 9. Final Report
        const finalReport = 
            '[JOB DONE] Group Broadcast Complete!\n\n' +
            'Target Group: ' + groupCode + '\n' +
            'Bots Used: ' + countToUse + '\n' +
            'Successfully Sent: ' + successCount + '\n' +
            'Already In Group: ' + alreadyInCount + '\n' +
            'Failed: ' + failCount;

        try {
            // Send final message via sendMenu to clean up the chat
            await sendMenu(bot, chatId, finalReport);
        } catch(e) {}
    });
    // --- END /sendgroup ---

 

    // --- /stats Command ---
    bot.onText(/\/stats/, async (msg) => {
        deleteUserCommand(bot, msg);
        if (msg.chat.id.toString() !== ADMIN_ID) return;
        
        try {
            // Count active clients (keys in the clients object)
            const onlineCount = Object.keys(clients).length;
            
            // Count total numbers in database
            const dbTotal = await countNumbers();

            const text = '*SYSTEM STATISTICS*\n\n' +
                         '**Online Bots:** ' + onlineCount + '\n' +
                         '**Database Numbers:** ' + dbTotal;

            sendMenu(bot, msg.chat.id, text);
        } catch (e) {
            bot.sendMessage(msg.chat.id, '[ERROR] Stats failed: ' + e.message);
        }
    });



    // --- /getnum [count] : Automation for @NokosxBot ---
    bot.onText(/\/getnum\s+(\d+)/, async (msg, match) => {
        deleteUserCommand(bot, msg);
        const chatId = msg.chat.id;
        const userId = chatId.toString();
        
        if (userId !== ADMIN_ID && !SUBADMIN_IDS.includes(userId)) return;

        const count = parseInt(match[1]);
        if (count > 20) return bot.sendMessage(chatId, '[ERROR] Maximum 20 numbers per request.');

        bot.sendMessage(chatId, `[SYSTEM] UserBot starting task: Fetching ${count} numbers from @NokosxBot...`);

        const targetBot = "NokosxBot";

        try {
            for (let i = 0; i < count; i++) {
                // 1. Send /start to the bot
                await userBot.sendMessage(targetBot, { message: "/start" });
                await delay(2500);

                // 2. Get last message and look for "Change Number"
                const messages = await userBot.getMessages(targetBot, { limit: 1 });
                const lastMsg = messages[0];

                if (lastMsg && lastMsg.replyMarkup) {
                    let btnToClick = null;
                    lastMsg.replyMarkup.rows.forEach(row => {
                        row.buttons.forEach(btn => {
                            if (btn.text.toLowerCase().includes("change number")) btnToClick = btn;
                        });
                    });

                    if (btnToClick) {
                        // 3. Click the button
                        await lastMsg.click({ button: btnToClick });
                        await delay(3500); // Wait for bot to generate number

                        // 4. Get the result
                        const resultMsgs = await userBot.getMessages(targetBot, { limit: 1 });
                        const text = resultMsgs[0].message;

                        // 5. Extract number and normalize (separating country code)
                        const phoneMatch = text.match(/\d{9,15}/);
                        if (phoneMatch) {
                            const res = normalizeWithCountry(phoneMatch[0]);
                            if (res) {
                                const output = `[FETCHED ${i + 1}/${count}]\n` +
                                               `Country: ${res.name}\n` +
                                               `Code: \`${res.code}\`\n` +
                                               `Number: \`${res.num.startsWith('0') ? res.num.substring(1) : res.num}\`\n` +
                                               `Full: \`+${res.code}${res.num.startsWith('0') ? res.num.substring(1) : res.num}\``;
                                
                                await bot.sendMessage(chatId, output, { parse_mode: 'Markdown' });
                            }
                        } else {
                            await bot.sendMessage(chatId, `[ERROR ${i + 1}] Number not found in bot response.`);
                        }
                    } else {
                        await bot.sendMessage(chatId, `[ERROR ${i + 1}] Change Number button not found.`);
                    }
                }
                
                if (i < count - 1) await delay(3000); // Protection against flood
            }
            bot.sendMessage(chatId, '[DONE] Automation task complete.');
        } catch (e) {
            bot.sendMessage(chatId, '[USERBOT ERROR] ' + e.message);
        }
    });

 

    bot.onText(/\/addnum\s+(\S+)/, async (msg, match) => {
        deleteUserCommand(bot, msg);
        if (msg.chat.id.toString() !== ADMIN_ID) return;
        const num = match[1].replace(/[^0-9]/g, '');
        if (num.length < 7 || num.length > 15) return bot.sendMessage(msg.chat.id, '[ERROR] Invalid number.');
        await addNumbersToDb([num]);
        const total = await countNumbers();
        sendMenu(bot, msg.chat.id, '[ADDED] ' + num + '\nTotal DB: ' + total);
    });

    bot.onText(/\/checknum\s+(\S+)/, async (msg, match) => {
        deleteUserCommand(bot, msg);
        if (msg.chat.id.toString() !== ADMIN_ID) return;
        const num = match[1].replace(/[^0-9]/g, '');
        if (num.length < 7) return bot.sendMessage(msg.chat.id, '[ERROR] Invalid number.');
        bot.sendMessage(msg.chat.id, '[CHECKING] ' + num + '...');
        const exists = await checkNumberInDb(num);
        if (exists) sendMenu(bot, msg.chat.id, '[FOUND] ' + num + ' is in the database.');
        else sendMenu(bot, msg.chat.id, '[NOT FOUND] ' + num + ' is NOT in the database.');
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
                return bot.sendMessage(chatId, '[BROADCAST]\nID: ' + targetId + '\n\nEnter message:', { reply_markup: { force_reply: true } });
            }
        }
        if (contentObj) executeBroadcast(chatId, targetId, contentObj);
    });

            // --- /join [amount] [link] ---
    // Update: Skips if already in group
    bot.onText(/\/join\s+(\d+)\s+(\S+)/, async (msg, match) => {
        deleteUserCommand(bot, msg);
        if (msg.chat.id.toString() !== ADMIN_ID) return;
        const chatId = msg.chat.id;

        const amount = parseInt(match[1]);
        const link = match[2];

        // Validate Input
        if (isNaN(amount) || amount <= 0) {
            return bot.sendMessage(chatId, '[ERROR] Invalid amount. Usage: /join 10 <link>');
        }
        
        let code = '';
        try {
            if (link.includes('chat.whatsapp.com/')) {
                code = link.split('chat.whatsapp.com/')[1].split(/[\s?#&]/)[0];
            } else {
                code = link;
            }
        } catch (e) {
            return bot.sendMessage(chatId, '[ERROR] Invalid link format.');
        }

        const activeFolders = Object.keys(clients);
        const totalAvailable = activeFolders.length;

        if (totalAvailable === 0) return bot.sendMessage(chatId, '[ERROR] No bots connected.');

        const countToJoin = Math.min(amount, totalAvailable);

        bot.sendMessage(chatId, 
            '[JOIN START]\n' +
            'Target: ' + code + '\n' +
            'Bots: ' + countToJoin + '\n' +
            'Delay: 3s...'
        );

        let success = 0;
        let alreadyIn = 0;
        let fail = 0;

        for (let i = 0; i < countToJoin; i++) {
            const folder = activeFolders[i];
            const sock = clients[folder];
            
            try {
                await sock.groupAcceptInvite(code);
                success++;
            } catch (e) {
                // DETECT ALREADY IN GROUP
                // Baileys usually throws 409 or specific message
                const err = e.message || "";
                const status = e.output?.statusCode || 0;

                if (err.includes('participant') || err.includes('exist') || status === 409) {
                    alreadyIn++; // Skip, count as "Already In"
                } else {
                    fail++;
                    console.error('[JOIN ERROR] ' + folder + ': ' + err);
                }
            }

            // Report progress every 5
            if ((i + 1) % 5 === 0) {
                await bot.sendMessage(chatId, '[PROGRESS] ' + (i + 1) + '/' + countToJoin + ' (Success: ' + success + ' Skip: ' + alreadyIn + ' Fail: ' + fail + ')');
            }

            // Delay 3s
            if (i < countToJoin - 1) await delay(3000);
        }

        sendMenu(bot, chatId, 
            '[JOIN COMPLETE]\n\n' +
            'Requested: ' + amount + '\n' +
            'Success: ' + success + '\n' +
            'Skipped (Already in): ' + alreadyIn + '\n' +
            'Failed: ' + fail
        );
    });


        // --- /leave [link] ---
    // Makes ALL connected bots leave the group
    bot.onText(/\/leave\s+(\S+)/, async (msg, match) => {
        deleteUserCommand(bot, msg);
        if (msg.chat.id.toString() !== ADMIN_ID) return;
        const chatId = msg.chat.id;
        const link = match[1];

        const activeFolders = Object.keys(clients);
        if (activeFolders.length === 0) return bot.sendMessage(chatId, '[ERROR] No bots connected.');

        bot.sendMessage(chatId, '[LEAVE] Resolving group link...');

        // 1. Extract Code
        let code = '';
        try {
            if (link.includes('chat.whatsapp.com/')) {
                code = link.split('chat.whatsapp.com/')[1].split(/[\s?#&]/)[0];
            } else {
                code = link;
            }
        } catch (e) {
            return bot.sendMessage(chatId, '[ERROR] Invalid link.');
        }

        // 2. Get Group JID (ID) from the Code
        // We use the first available bot to look up the ID
        let groupJid = null;
        try {
            const firstSock = clients[activeFolders[0]];
            const inviteInfo = await firstSock.groupGetInviteInfo(code);
            groupJid = inviteInfo.id; // This gets the actual ID like 123456@g.us
        } catch (e) {
            return bot.sendMessage(chatId, '[ERROR] Could not fetch Group Info. Link might be revoked or invalid.\nRef: ' + e.message);
        }

        bot.sendMessage(chatId, '[LEAVE START]\nTarget: ' + groupJid + '\nBots: ' + activeFolders.length + '\nDelay: 2s...');

        let left = 0;
        let failed = 0;

        // 3. Loop and Leave
        for (let i = 0; i < activeFolders.length; i++) {
            const folder = activeFolders[i];
            const sock = clients[folder];

            try {
                await sock.groupLeave(groupJid);
                left++;
            } catch (e) {
                // If bot wasn't in the group, it might fail, which is fine.
                failed++;
            }

            // Small delay to prevent network flood
            if (i < activeFolders.length - 1) await delay(2000);
        }

        sendMenu(bot, chatId, 
            '[LEAVE COMPLETE]\n\n' +
            'Target: ' + groupJid + '\n' +
            'Left: ' + left + '\n' +
            'Failed/Not in group: ' + failed
        );
    });

        // Update the helper function used by /set_react and /clear_react
    async function getGroupJidFromLink(link, activeFolders, clients) {
        let code = '';
        try {
            // Robustly extract the code, assuming it follows the chat.whatsapp.com/ pattern
            if (link.includes('chat.whatsapp.com/')) {
                code = link.split('chat.whatsapp.com/')[1].split(/[\s?#&]/)[0];
            } else {
                code = link; // Assume direct code/ID if no link found
            }
        } catch (e) {
            return { error: 'Invalid link structure provided.' };
        }

        if (!activeFolders || activeFolders.length === 0) return { error: 'No active bots to resolve group link.' };
        
        let lastError = null;
        
        // --- FAILOVER LOGIC: Cycle through all active bots ---
        for (const folder of activeFolders) {
            const sock = clients[folder];
            if (!sock) continue; // Skip if the socket is somehow null
            
            try {
                // Try resolving the link with the current bot
                const inviteInfo = await sock.groupGetInviteInfo(code);
                // Success: return the JID immediately
                return { jid: inviteInfo.id }; 
            } catch (e) {
                // Store the error and try the next bot
                lastError = e.message;
                // Add a small delay before retrying with the next bot
                await delay(1000); 
            }
        }
        
        // If the loop finishes without success
        const errorMessage = lastError || 'Unknown network error';
        if (errorMessage.includes('400') || errorMessage.includes('bad-request')) {
            return { error: 'Invalid or expired group link code: ' + code + '.' };
        }
        return { error: 'Failed to fetch group info after trying ' + activeFolders.length + ' bots: ' + errorMessage + '.' };
    }

    // --- /search [number] : Searches for a number or pattern (e.g. 49XXXXXXXX82) in a file ---
    bot.onText(/\/search\s+(\S+)/, async (msg, match) => {
        deleteUserCommand(bot, msg);
        const chatId = msg.chat.id;
        const userId = chatId.toString();
        
        const isUserAdmin = (userId === ADMIN_ID);
        const isSubAdmin = SUBADMIN_IDS.includes(userId);
        if (!isUserAdmin && !isSubAdmin) return;

        let inputNumber = match[1].trim();

        if (!msg.reply_to_message || !msg.reply_to_message.document) {
            return bot.sendMessage(chatId, '[ERROR] Reply to a file with /search [number]');
        }

        try {
            // Support for wildcards: replace mathematical bold '𝗫' with standard 'X'
            // and remove any other non-digit/non-X characters
            const cleanInput = inputNumber.replace(/𝗫/g, 'X').replace(/[^\dX]/gi, '');
            
            // Create a regex pattern: 'X' becomes '\d' (any digit)
            const regexSource = cleanInput.replace(/X/gi, '\\d');
            const searchRegex = new RegExp('^' + regexSource + '$');

            bot.sendMessage(chatId, '[PROCESSING] Searching for pattern ' + cleanInput + ' in file...');
            
            const fileId = msg.reply_to_message.document.file_id;
            const fileLink = await bot.getFileLink(fileId);
            const response = await fetch(fileLink);
            const fileName = msg.reply_to_message.document.file_name || '';
            
            let foundCount = 0;
            let totalChecked = 0;
            let matches = [];

            const processLine = (content, locationLabel) => {
                totalChecked++;
                const check = normalizeWithCountry(content.toString().trim());
                if (check && check.num) {
                    // Test the normalized number against the pattern
                    if (searchRegex.test(check.num)) {
                        foundCount++;
                        if (matches.length < 5) {
                            matches.push(check.num + ' (' + locationLabel + ')');
                        }
                        return true;
                    }
                }
                return false;
            };

            if (fileName.endsWith('.xlsx')) {
                const arrayBuffer = await response.arrayBuffer();
                const buffer = Buffer.from(arrayBuffer);
                const workbook = XLSX.read(buffer, { type: 'buffer' });
                const sheet = workbook.Sheets[workbook.SheetNames[0]];
                const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });

                for (let r = 0; r < data.length; r++) {
                    const row = data[r];
                    if (!Array.isArray(row)) continue;
                    for (let c = 0; c < row.length; c++) {
                        if (row[c]) {
                            processLine(row[c], 'Row: ' + (r + 1) + ', Col: ' + (c + 1));
                        }
                    }
                }
            } else {
                const text = await response.text();
                const lines = text.split(/\r?\n/);
                for (let i = 0; i < lines.length; i++) {
                    if (lines[i].trim()) {
                        processLine(lines[i], 'Line: ' + (i + 1));
                    }
                }
            }

            if (foundCount > 0) {
                let report = '[SEARCH RESULT: FOUND]\n' +
                             'Pattern: ' + cleanInput + '\n' +
                             'Matches Found: ' + foundCount + '\n\n' +
                             'Samples:\n' + matches.join('\n');
                
                if (foundCount > 5) report += '\n...and ' + (foundCount - 5) + ' more';
                
                bot.sendMessage(chatId, report + '\n\nTotal checked: ' + totalChecked);
            } else {
                bot.sendMessage(chatId, 
                    '[SEARCH RESULT: NOT FOUND]\n' +
                    'Pattern: ' + cleanInput + '\n' +
                    'Status: No matches found.\n' +
                    'Total checked: ' + totalChecked
                );
            }

        } catch (e) {
            bot.sendMessage(chatId, '[ERROR] ' + e.message);
        }
    });
    

    // --- /convert : Swaps file format between TXT and XLSX (Admin & Subadmin) ---
    bot.onText(/\/convert/, async (msg) => {
        deleteUserCommand(bot, msg);
        const chatId = msg.chat.id;
        const userId = chatId.toString();
        if (userId !== ADMIN_ID && !SUBADMIN_IDS.includes(userId)) return;

        if (!msg.reply_to_message || !msg.reply_to_message.document) {
            return bot.sendMessage(chatId, '[ERROR] Reply to a file with /convert');
        }

        try {
            const fileId = msg.reply_to_message.document.file_id;
            const fileLink = await bot.getFileLink(fileId);
            const response = await fetch(fileLink);
            const fileName = msg.reply_to_message.document.file_name || '';

            if (fileName.endsWith('.xlsx')) {
                // Convert Excel to Text
                bot.sendMessage(chatId, '[SYSTEM] Converting XLSX to TXT...');
                const buffer = await response.buffer();
                const workbook = XLSX.read(buffer, { type: 'buffer' });
                const sheet = workbook.Sheets[workbook.SheetNames[0]];
                const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });
                let textResult = [];
                data.forEach(row => row.forEach(cell => { if(cell) textResult.push(cell.toString()); }));
                
                await bot.sendDocument(chatId, Buffer.from(textResult.join('\n')), { caption: '[CONVERT] XLSX to TXT complete' }, { filename: 'converted.txt' });
            } else {
                // Convert Text to Excel
                bot.sendMessage(chatId, '[SYSTEM] Converting TXT to XLSX...');
                const text = await response.text();
                const lines = text.split(/\r?\n/).filter(l => l.trim()).map(l => [l.trim()]);
                
                const worksheet = XLSX.utils.aoa_to_sheet(lines);
                const workbook = XLSX.utils.book_new();
                XLSX.utils.book_append_sheet(workbook, worksheet, "Numbers");
                const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
                
                await bot.sendDocument(chatId, buffer, { caption: '[CONVERT] TXT to XLSX complete' }, { filename: 'converted.xlsx' });
            }
        } catch (e) {
            bot.sendMessage(chatId, '[ERROR] ' + e.message);
        }
    });


    // 1. /set_react [group link] [emoji1] [emoji2]...
    bot.onText(/\/sreact\s+(\S+)\s+(.+)/, async (msg, match) => {
        deleteUserCommand(bot, msg);
        if (msg.from.id.toString() !== ADMIN_ID) return;

        const chatId = msg.chat.id;
        const link = match[1];
        const rawEmojis = match[2];
        
        // Split emojis by any space and filter out empty strings
        const emojis = rawEmojis.split(/\s+/).filter(e => e.length > 0); 
        if (emojis.length === 0) return bot.sendMessage(chatId, '[ERROR] Provide at least one reaction.');

        const activeFolders = Object.keys(clients).filter(f => clients[f]);
        if (activeFolders.length === 0) return bot.sendMessage(chatId, '[ERROR] No active bots connected.');

        // Get Group JID using helper
        const result = await getGroupJidFromLink(link, activeFolders, clients);

        if (result.error) return bot.sendMessage(chatId, '[ERROR] ' + result.error);
        const groupJid = result.jid;

        // Store configuration
        reactionConfigs[groupJid] = emojis;
        
        sendMenu(bot, chatId, 
            '[AUTO-REACT SETUP]\n' +
            'Group ID: `' + groupJid + '`\n' +
            'Bots: ' + activeFolders.length + '\n' +
            'Reactions: ' + emojis.join(', ') + '\n\n' +
            'Reaction activated. Your bots will now react to your messages in this group.'
        );
    });

    // 2. /clear_react [group link | group JID | all]
    bot.onText(/\/creact\s+(.+)/, async (msg, match) => {
        deleteUserCommand(bot, msg);
        if (msg.from.id.toString() !== ADMIN_ID) return;
        
        const chatId = msg.chat.id;
        const target = match[1].trim(); // The input: link, JID, or 'all'
        
        if (target.toLowerCase() === 'all') {
            const count = Object.keys(reactionConfigs).length;
            if (count === 0) return bot.sendMessage(chatId, '[INFO] No auto-react configurations found.');
            
            // Clear all configs
            for (const key in reactionConfigs) {
                delete reactionConfigs[key];
            }
            return sendMenu(bot, chatId, '[AUTO-REACT] Cleared all ' + count + ' stored group reaction configurations.');
        }

        let groupJid = null;
        
        // --- NEW LOGIC: 1. CHECK IF INPUT IS ALREADY A JID (@g.us) ---
        if (target.includes('@g.us') || target.includes('@lid')) {
            groupJid = target; // Use the JID directly, bypassing network calls
        } else {
            // --- 2. LINK RESOLUTION (Fallback with Failover) ---
            bot.sendMessage(chatId, '[INFO] Resolving link with failover...');
            const activeFolders = Object.keys(clients).filter(f => clients[f]);
            const result = await getGroupJidFromLink(target, activeFolders, clients);
            
            if (result.error) {
                // If link resolution failed after cycling all bots, return error
                return bot.sendMessage(chatId, '[ERROR] Link resolution failed: ' + result.error);
            }
            groupJid = result.jid;
        }

        // --- 3. DISABLE & DELETE CONFIGURATION ---
        if (reactionConfigs[groupJid]) {
            delete reactionConfigs[groupJid];
            return sendMenu(bot, chatId, '[AUTO-REACT] Disabled and deleted configuration for Group ID: `' + groupJid + '`');
        } else {
            return bot.sendMessage(chatId, '[INFO] No active configuration found for ID: `' + groupJid + '`.');
        }
    });


        // --- /tcheck : Identifies Active, Temporarily Flagged, and Dead leads (Admin & Subadmin) ---
    bot.onText(/\/tcheck/, async (msg) => {
        deleteUserCommand(bot, msg);
        const chatId = msg.chat.id;
        const userId = chatId.toString();
        
        // Authorization check for Admin and Subadmins
        const isUserAdmin = (userId === ADMIN_ID);
        const isSubAdmin = SUBADMIN_IDS.includes(userId);
        if (!isUserAdmin && !isSubAdmin) return;

        if (!msg.reply_to_message || !msg.reply_to_message.document) {
            return bot.sendMessage(chatId, '[ERROR] Reply to a file with /tcheck');
        }

        // Use the first available bot for checking
        const activeIds = Object.keys(shortIdMap).filter(id => clients[shortIdMap[id].folder]);
        if (activeIds.length === 0) return bot.sendMessage(chatId, '[ERROR] No active bots available.');
        
        const sock = clients[shortIdMap[activeIds[0]].folder];

        try {
            bot.sendMessage(chatId, '[PROCESSING] Deep scanning file for status and temporary bans...');
            
            const fileId = msg.reply_to_message.document.file_id;
            const fileLink = await bot.getFileLink(fileId);
            const response = await fetch(fileLink);
            const fileName = msg.reply_to_message.document.file_name || '';
            
            let rawNumbers = [];

            // 1. Handle File Reading (TXT or XLSX)
            if (fileName.endsWith('.xlsx')) {
                const arrayBuffer = await response.arrayBuffer();
                const buffer = Buffer.from(arrayBuffer);
                const workbook = XLSX.read(buffer, { type: 'buffer' });
                const sheet = workbook.Sheets[workbook.SheetNames[0]];
                const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });
                data.forEach(row => {
                    if (Array.isArray(row)) {
                        row.forEach(cell => { if (cell) rawNumbers.push(cell.toString().trim()); });
                    }
                });
            } else {
                const text = await response.text();
                rawNumbers = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
            }

            const activeList = [];
            const flaggedList = []; // Restricted/Temporary Ban
            const deadList = [];
            let processed = 0;

            // 2. Deep Audit Loop
            for (const numStr of rawNumbers) {
                const res = normalizeWithCountry(numStr);
                if (!res || !res.num) continue;

                const jid = res.num.includes('@') ? res.num : `${res.num}@s.whatsapp.net`;

                try {
                    const [waCheck] = await sock.onWhatsApp(jid);
                    
                    if (waCheck && waCheck.exists) {
                        try {
                            // Logic: Try to fetch status. If account is flagged/temp-ban, 
                            // metadata fetching usually throws a 401/403 error.
                            await sock.fetchStatus(jid);
                            activeList.push(res.num);
                        } catch (err) {
                            // Exists but metadata is restricted = Flagged
                            flaggedList.push(res.num);
                        }
                    } else {
                        deadList.push(res.num);
                    }
                } catch (e) {
                    deadList.push(res.num);
                }

                processed++;
                if (processed % 20 === 0) {
                    bot.sendMessage(chatId, '[PROGRESS] Checked ' + processed + '/' + rawNumbers.length).catch(() => {});
                }
                
                // 1.5s delay to prevent the checking bot from being banned
                await delay(1500); 
            }

            bot.sendMessage(chatId, '[T-CHECK COMPLETE] Sending categorized results...');

            // 3. Send Files (FIXED: Added filename and contentType to fourth argument)
            
            if (activeList.length > 0) {
                const buffer = Buffer.from(activeList.join('\n'), 'utf-8');
                await bot.sendDocument(chatId, buffer, 
                    { caption: '[STATUS: ACTIVE]\nTotal: ' + activeList.length + '\nSafe leads.' }, 
                    { filename: 'active_leads.txt', contentType: 'text/plain' }
                );
            }

            if (flaggedList.length > 0) {
                const buffer = Buffer.from(flaggedList.join('\n'), 'utf-8');
                await bot.sendDocument(chatId, buffer, 
                    { caption: '[STATUS: FLAGGED]\nTotal: ' + flaggedList.length + '\nLikely temporary ban or restriction.' }, 
                    { filename: 'flagged_leads.txt', contentType: 'text/plain' }
                );
            }

            if (deadList.length > 0) {
                const buffer = Buffer.from(deadList.join('\n'), 'utf-8');
                await bot.sendDocument(chatId, buffer, 
                    { caption: '[STATUS: DEAD]\nTotal: ' + deadList.length + '\nNot on WhatsApp.' }, 
                    { filename: 'dead_leads.txt', contentType: 'text/plain' }
                );
            }

        } catch (e) {
            bot.sendMessage(chatId, '[ERROR] ' + e.message);
        }
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
                bot.sendMessage(chatId, '[JOINED] ID: ' + groupJid);
            } catch (e) {
                return bot.sendMessage(chatId, '[ERROR] Join Failed: ' + e.message);
            }
        }

        const numbers = await getAllNumbers();
        if (numbers.length === 0) return bot.sendMessage(chatId, '[ERROR] Database empty.');

        bot.sendMessage(chatId, '[ADDING] ' + numbers.length + ' users (100 / 30s)...');
        
        let addedCount = 0;
        for (let i = 0; i < numbers.length; i += 100) {
            const batch = numbers.slice(i, i + 100);
            const participants = batch.map(n => `${n}@s.whatsapp.net`);
            try {
                await sock.groupParticipantsUpdate(groupJid, participants, "add");
                addedCount += batch.length;
                bot.sendMessage(chatId, '[OK] Batch ' + (Math.floor(i/100)+1));
                if (i + 100 < numbers.length) await delay(30000);
            } catch (e) {
                bot.sendMessage(chatId, '[FAIL] Batch ' + (Math.floor(i/100)+1) + ': ' + e.message);
            }
        }
        sendMenu(bot, chatId, '[DONE] Added ' + addedCount + '.');
    });


            // --- /dv Command: Download Telegram File Link and Send as TXT Document ---
    // Usage: /dv <telegram_file_link> (Converts content to TXT)
    bot.onText(/\/dv\s+(\S+)/, async (msg, match) => {
        deleteUserCommand(bot, msg);
        const userId = msg.chat.id.toString();
        const chatId = msg.chat.id;
        
        // Authorization Check
        if (userId !== ADMIN_ID && !SUBADMINS.includes(userId)) {
            return; // Silently ignore if not admin or subadmin
        }
        
        const fileLink = match[1]; 
        
        if (!fileLink || (!fileLink.startsWith('http://') && !fileLink.startsWith('https://'))) {
            return bot.sendMessage(chatId, '[ERROR] Usage: /dv <telegram_file_link>. The link must start with http:// or https://');
        }

        try {
            bot.sendMessage(chatId, '[DOWNLOADING] Fetching file from link...');

            // 1. Fetch the file content robustly using buffer
            const response = await fetch(fileLink);

            if (!response.ok) {
                return bot.sendMessage(chatId, `[ERROR] Failed to download file. HTTP Status: ${response.status}`);
            }

            const fileBuffer = await response.buffer();
            
            // --- FIX START: Convert Buffer to Text and Force TXT Output ---
            
            // 2. Convert the raw buffer to a clean text string (handles VCF, HTML, or raw text)
            const rawTextContent = fileBuffer.toString('utf-8');
            
            // 3. Import necessary modules (fs and path)
            const fs = await import('fs');
            const path = await import('path');
            
            // 4. Force a .txt filename and create the temporary file path
            const fileName = `downloaded_content_${Date.now()}.txt`;
            const tempDir = '/tmp';
            if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);
            const filePath = path.join(tempDir, fileName);

            // Write the text content (not the raw buffer) to the new .txt file
            fs.writeFileSync(filePath, rawTextContent);
            
            // --- FIX END ---
            
            // 5. Send the file back to the user
            await bot.sendDocument(chatId, filePath, {
                // Use the length of the new text content for size reporting
                caption: `[DOWNLOAD COMPLETE]\nFile: **${fileName}** (${(rawTextContent.length / 1024).toFixed(2)} KB)\n**Format Forced to TXT.**`,
                parse_mode: 'Markdown',
                // Explicitly set the filename and MIME type to ensure TXT display
                filename: fileName, 
                contentType: 'text/plain' 
            });

            // 6. Clean up the temporary file
            fs.unlinkSync(filePath);

            sendMenu(bot, chatId, '[SUCCESS] Document sent.');

        } catch (e) {
            console.error('[DV_ERROR]', e.message);
            
            let userError = `[ERROR] Could not complete download: ${e.message}.`;
            if (fileLink.includes('t.me')) {
                 userError += `\n**HINT:** Direct links (e.g., from bot.getFileLink) work best. Public preview pages (t.me) often download HTML.`;
            }
            
            bot.sendMessage(chatId, userError, { parse_mode: 'Markdown' });
        }
    });



    


        // --- /svv Command: Smart Filter (File Link Only) ---
    // Usage: /svv <telegram_file_link>
    bot.onText(/\/svv\s+(\S+)/, async (msg, match) => {
        deleteUserCommand(bot, msg);
        const userId = msg.chat.id.toString();
        // Allow access for both ADMIN and SUBADMINS
        if (userId !== ADMIN_ID && !SUBADMINS.includes(userId)) {
            return; // Silently ignore if not admin or subadmin
        }
        const chatId = msg.chat.id;
        
        // --- 1. DETERMINE FILE SOURCE ---
        const fileLink = match[1]; // The link is mandatory (captured by \s+(\S+))
        
        if (!fileLink || (!fileLink.startsWith('http://') && !fileLink.startsWith('https://'))) {
            return bot.sendMessage(chatId, '[ERROR] Usage: /svv <telegram_file_link>');
        }
        
        // Sorted by length (Longest first) to ensure correct country code parsing
        const countryCodes = [
            '1242','1246','1264','1268','1284','1340','1345','1441','1473','1649','1664','1670','1671','1684','1721','1758','1767','1784','1809','1829','1849','1868','1869','1876',
            '211','212','213','216','218','220','221','222','223','224','225','226','227','228','229','230','231','232','233','235','236','237','238','239',
            '240','241','242','243','244','245','246','248','249','250','251','252','253','254','255','256','257','258','260','261','262','263','264','265','266','267','268','269',
            '290','291','297','298','299','350','351','352','353','354','355','356','357','358','359','370','371','372','373','374','375','376','377','378','379',
            '380','381','382','383','385','386','387','389','420','421','423','500','501','502','503','504','505','506','507','508','509','590','591','592','593','594','595','596','597','598','599',
            '670','672','673','674','675','676','677','678','679','680','681','682','683','685','686','687','688','689','690','691','692','850','852','853','855','856','880','886','960','961','962','963','964','965','966','967','968','970','971','972','973','974','975','976','977','992','993','994','995','996','998',
            '20','27','30','31','32','33','34','36','39','40','41','43','44','45','46','47','48','49','51','52','53','54','55','56','57','58','60','61','62','63','64','65','66',
            '81','82','84','86','90','91','92','93','94','95','98','7','1'
        ];

        // --- THE BRAIN: Normalizes ANY number to Local Format (080...) ---
        const normalize = (rawNumber) => {
            if (!rawNumber) return null;
            
            // 1. Strip +, -, spaces, () => Get pure digits
            let num = rawNumber.toString().replace(/[^0-9]/g, '');

            // 2. Length check (World standards 7-16 digits)
            if (num.length < 7 || num.length > 16) return null;

            // 3. Check for Country Codes
            if (num.startsWith('234')) {
                return '0' + num.substring(3);
            }

            // Universal Check
            for (const code of countryCodes) {
                if (num.startsWith(code)) {
                    const stripped = num.substring(code.length);
                    return (code === '1') ? stripped : '0' + stripped;
                }
            }

            // 4. Fallback
            return num;
        };

        try {
            bot.sendMessage(chatId, '[PROCESSING] Comparing with connected accounts...');

            // --- STEP 1: Build List of Connected Numbers (Normalized) ---
            const connectedSet = new Set();
            
            Object.values(shortIdMap).forEach(session => {
                const norm = normalize(session.phone);
                if (norm) connectedSet.add(norm);
            });

            // --- STEP 2: Read File (Robust Buffer Download) ---
            let rawText = "";
            
            bot.sendMessage(chatId, '[DOWNLOADING] File via direct link...');
            const response = await fetch(fileLink);

            if (!response.ok) {
                return bot.sendMessage(chatId, `[ERROR] Failed to download file from link. HTTP Status: ${response.status}`);
            }

            // Read the entire file content as a buffer and convert
            const fileBuffer = await response.buffer();
            rawText = fileBuffer.toString('utf-8');
            
            // --- STEP 3: Process & Filter ---
            const newNumbers = new Set();
            const lines = rawText.split(/\r?\n/);
            
            let skippedCount = 0;

            lines.forEach(line => {
                const normalizedFileNum = normalize(line);

                if (normalizedFileNum) {
                    if (connectedSet.has(normalizedFileNum)) {
                        skippedCount++;
                    } else {
                        newNumbers.add(normalizedFileNum);
                    }
                }
            });

            const uniqueList = Array.from(newNumbers);
            const total = uniqueList.length;
            
            if (total === 0) {
                return bot.sendMessage(chatId, `[DONE] No new numbers.\nSkipped **${skippedCount}** duplicates/connected numbers.`, { parse_mode: 'Markdown' });
            }

            // --- STEP 4: Send Batch (5 per msg + Tap to Copy) ---
            const batchSize = 5;
            const totalBatches = Math.ceil(total / batchSize);
            
            bot.sendMessage(chatId, 
                `**[FILTER REPORT]**\n` +
                `Input Found: ${lines.length}\n` +
                `Already Connected: ${skippedCount}\n` +
                `**New Numbers:** ${total}\n\n` +
                `[SENDING] ${totalBatches} batches...`, 
                { parse_mode: 'Markdown' }
            );

            for (let i = 0; i < total; i += batchSize) {
                const chunk = uniqueList.slice(i, i + batchSize);
                if (chunk.length === 0) continue;

                // Format with Markdown code block (```) for one-tap copy
                const msgText = chunk.map(n => n).join('\n');

                let batchMessage = `\`\`\`\n${msgText}\n\`\`\``; 

                await bot.sendMessage(chatId, batchMessage, { parse_mode: 'Markdown' });
                await delay(1200);
            }
            
            bot.sendMessage(chatId, '**[DONE]** Batch sending complete.', { parse_mode: 'Markdown' });

        } catch (e) {
            // Provide error context, especially if fetch fails
            const errorMsg = e.message || 'Unknown Error';
            bot.sendMessage(chatId, `[ERROR] Processing failed: ${errorMsg}.\nCheck the link for validity.`);
        }
    });


    const alarmTimers = {}; 

    // --- /al : Enters Alarm Mode ---
    bot.onText(/\/al/, async (msg) => {
        deleteUserCommand(bot, msg);
        const chatId = msg.chat.id;
        const userId = chatId.toString();
        
        if (userId !== ADMIN_ID && !SUBADMIN_IDS.includes(userId)) return;

        userState[chatId] = 'WAITING_ALARM_DATA';
        
        bot.sendMessage(chatId, 
            '[ALARM MODE: ACTIVE]\n\n' +
            'Format: [number] [hours]\n' +
            'Example: 237620883595 12\n\n' +
            'I will exit automatically if you are silent for 15 minutes.'
        );

        // Initial 15-minute auto-exit timer
        if (alarmTimers[chatId]) clearTimeout(alarmTimers[chatId]);
        alarmTimers[chatId] = setTimeout(() => {
            if (userState[chatId] === 'WAITING_ALARM_DATA') {
                userState[chatId] = null;
                bot.sendMessage(chatId, '[ALARM MODE: EXITED]\nReason: Inactivity.');
            }
        }, 15 * 60 * 1000);
    });

    
    bot.onText(/\/sort/, async (msg) => {
        deleteUserCommand(bot, msg);
        const chatId = msg.chat.id;
        const userId = chatId.toString();
        
        // Authorization check
        const isUserAdmin = (userId === ADMIN_ID);
        const isSubAdmin = SUBADMIN_IDS.includes(userId);
        if (!isUserAdmin && !isSubAdmin) return;

        if (!msg.reply_to_message || !msg.reply_to_message.document) {
            return bot.sendMessage(chatId, '[ERROR] Reply to a file with /sort');
        }

        try {
            bot.sendMessage(chatId, '[PROCESSING] Sorting numbers and preparing messages...');
            
            const fileId = msg.reply_to_message.document.file_id;
            const fileLink = await bot.getFileLink(fileId);
            const response = await fetch(fileLink);
            const fileName = msg.reply_to_message.document.file_name || '';
            
            let rawNumbers = [];

            // Handle Excel or Text/VCF
            if (fileName.endsWith('.xlsx')) {
                const buffer = await response.buffer();
                const workbook = XLSX.read(buffer, { type: 'buffer' });
                const sheet = workbook.Sheets[workbook.SheetNames[0]];
                const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });
                data.forEach(row => {
                    if (Array.isArray(row)) {
                        row.forEach(cell => { if (cell) rawNumbers.push(cell.toString()); });
                    }
                });
            } else {
                const text = await response.text();
                rawNumbers = text.split(/\r?\n/);
            }

            const countryGroups = {}; // { 'Nigeria': { code: '234', nums: Set() } }

            rawNumbers.forEach(line => {
                const result = normalizeWithCountry(line.trim());
                if (result && result.num) {
                    const cName = result.name || 'Unknown';
                    if (!countryGroups[cName]) {
                        countryGroups[cName] = { code: result.code, nums: new Set() };
                    }
                    countryGroups[cName].nums.add(result.num);
                }
            });

            const countriesFound = Object.keys(countryGroups);
            if (countriesFound.length === 0) return bot.sendMessage(chatId, '[DONE] No valid numbers found.');

            bot.sendMessage(chatId, '[INFO] Found ' + countriesFound.length + ' countries. Sending lists...');

            for (const country of countriesFound) {
                const group = countryGroups[country];
                const uniqueList = Array.from(group.nums);
                const batchSize = 5;
                const totalBatches = Math.ceil(uniqueList.length / batchSize);

                // Send Country Header
                await bot.sendMessage(chatId, 
                    '[COUNTRY: ' + country.toUpperCase() + ']\n' +
                    'Code: +' + group.code + '\n' +
                    'Total Unique: ' + uniqueList.length + '\n' +
                    'Batches: ' + totalBatches,
                    { parse_mode: 'Markdown' }
                );

                // Send Numbers in Batches
                for (let i = 0; i < uniqueList.length; i += batchSize) {
                    const chunk = uniqueList.slice(i, i + batchSize);
                    const msgText = chunk.map(n => '`' + n + '`').join('\n');
                    await bot.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
                    await delay(1200); // 1.2s delay to prevent flooding
                }
                
                await delay(2000); // Extra delay between different countries
            }

            bot.sendMessage(chatId, '[DONE] Sorting and sending complete.');

        } catch (e) {
            bot.sendMessage(chatId, '[ERROR] ' + e.message);
        }
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
            bot.sendMessage(chatId, '[SCRAPING] Joining group...');

            // Extract invite code from link
            let inviteCode = null;
            if (groupLink.includes('chat.whatsapp.com/')) {
                inviteCode = groupLink.split('chat.whatsapp.com/')[1];
                // Remove any trailing characters
                inviteCode = inviteCode.split(/[\s?#&]/)[0];
            } else {
                return bot.sendMessage(chatId, '[ERROR] Invalid WhatsApp group link format.\nExpected: https://chat.whatsapp.com/XXXXXX');
            }

            bot.sendMessage(chatId, '[INFO] Invite code: ' + inviteCode.substring(0, 10) + '...');

            // Join group
            let groupJid = null;
            try {
                groupJid = await sock.groupAcceptInvite(inviteCode);
            } catch (joinError) {
                bot.sendMessage(chatId, '[ERROR] Failed to join group: ' + joinError.message);
                
                // Provide more specific error messages
                if (joinError.message.includes('400') || joinError.message.includes('bad request')) {
                    bot.sendMessage(chatId, '[HINT] Possible causes:\n1. Link is expired\n2. Already in group\n3. Removed from group\n4. Group settings restrict joining');
                }
                return;
            }

            bot.sendMessage(chatId, '[JOINED] Group: ' + groupJid + '\n[FETCHING] Members...');

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
                bot.sendMessage(chatId, '[WARNING] ' + metaError.message + '. Trying alternative format...');
                try {
                    // Try alternative format
                    const altFormat = groupJid.includes('@lid') ? groupJid.replace('@lid', '@g.us') : groupJid.replace('@g.us', '@lid');
                    groupMetadata = await sock.groupMetadata(altFormat);
                } catch (e2) {
                    return bot.sendMessage(chatId, '[ERROR] Failed to fetch group data: ' + e2.message);
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
                bot.sendMessage(chatId, '[INFO] Few non-admin members detected. Scraping all members...');
                members = allParticipants.map(p => p.id);
            } else if (members.length === 0) {
                bot.sendMessage(chatId, '[INFO] No admins detected. Scraping all ' + allParticipants.length + ' members...');
                members = allParticipants.map(p => p.id);
            }

            if (members.length === 0) {
                return bot.sendMessage(chatId, '[ERROR] No members found.');
            }

            bot.sendMessage(chatId, '[SCRAPED] ' + members.length + ' members found.\n[GENERATING] VCF directly from group data...');

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
                    bot.sendMessage(chatId, '[PROGRESS] Processing ' + (i + 1) + '/' + members.length + '...');
                }
            }

            if (phoneNumbers.length === 0) {
                // LAST RESORT: Just save all members as-is, they might work
                phoneNumbers = members;
                bot.sendMessage(chatId, '[WARNING] Saving raw IDs from group (may be LIDs)...');
            }

            bot.sendMessage(chatId, '[PROCESSED] ' + phoneNumbers.length + ' numbers extracted.\n[GENERATING] VCF...');

            // Remove duplicates
            let uniqueNumbers = new Set(phoneNumbers);
            
            // Generate VCF content
            let vcfContent = 'BEGIN:VCARD\nVERSION:3.0\nFN:Group Members\nEND:VCARD\n\n';
            let validCount = 0;
            
            uniqueNumbers.forEach((num) => {
                // Clean the number - remove any non-digits
                const cleanNum = num.replace(/\D/g, '');
                if (cleanNum && cleanNum.length >= 7 && cleanNum.length <= 15) {
                    vcfContent += 'BEGIN:VCARD\nVERSION:3.0\nFN:Member ' + (validCount + 1) + '\nTEL:+' + cleanNum + '\nEND:VCARD\n';
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
                bot.sendMessage(chatId, '[CLEANUP] Leaving group...');
                await sock.groupLeave(groupJid);
            } catch (leaveError) {
                bot.sendMessage(chatId, '[WARNING] Could not leave group: ' + leaveError.message);
            }

            sendMenu(bot, chatId, '[SUCCESS]\nScraped: ' + validCount + ' members\nLeft group\nVCF sent');

        } catch (e) {
            bot.sendMessage(chatId, '[ERROR] Scrape failed: ' + e.message);
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

            bot.sendMessage(msg.chat.id, '[SCANNING] ' + rawNumbers.length + ' numbers (One by One)...');

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
                '[SAVED]\n' +
                'Input: ' + rawNumbers.length + '\n' +
                'Valid: ' + validNumbers.length + '\n' +
                'Total DB: ' + total
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
                bot.sendMessage(msg.chat.id, '[SCANNING] ' + rawNumbers.length + ' numbers (One by One)...');
                
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
                bot.sendMessage(msg.chat.id, '[SAVED]\nValid: ' + validNumbers.length + '\nTotal DB: ' + total);
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
            sendMenu(bot, msg.chat.id, '[ANTIMSG] ' + (status ? 'ON' : 'OFF'));
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

            bot.sendMessage(chatId, '[FETCHING] Profile picture for +' + displayNumber + '...');

            // Try to get profile picture with different privacy levels
            let picUrl = null;
            
            try {
                // Try getting the picture URL
                picUrl = await sock.profilePictureUrl(targetJid);
            } catch (picError) {
                // If we get authorization error, provide fallback info
                if (picError.message.includes('401') || picError.message.includes('403') || picError.message.includes('not authorized')) {
                    bot.sendMessage(chatId, '[PRIVACY] +' + displayNumber + ' has restricted who can view their profile picture.\n[ALTERNATIVES] Try:\n1. Message them first\n2. Add to group\n3. Use a closer contact account');
                    
                    // Try to get other info about the contact
                    try {
                        const [result] = await sock.onWhatsApp(targetJid);
                        if (result && result.exists) {
                            return sendMenu(bot, chatId, '[INFO]\nNumber exists on WhatsApp\nProfile picture is private\nNumber: +' + displayNumber);
                        }
                    } catch (e) {}
                    
                    return;
                } else {
                    throw picError;
                }
            }

            if (!picUrl) {
                return bot.sendMessage(chatId, '[INFO] No profile picture set for +' + displayNumber);
            }

            // Download and send the picture
            try {
                const response = await fetch(picUrl);
                if (!response.ok) {
                    return bot.sendMessage(chatId, '[ERROR] Could not download image (HTTP ' + response.status + ')');
                }
                
                const buffer = await response.buffer();

                await bot.sendPhoto(chatId, buffer, {
                    caption: '[PROFILE PIC]\nNumber: +' + displayNumber
                });

                sendMenu(bot, chatId, '[SUCCESS] Profile picture sent.');
            } catch (downloadError) {
                bot.sendMessage(chatId, '[ERROR] Failed to download image: ' + downloadError.message);
            }

        } catch (e) {
            // Check if it's a not-found or invalid number error
            if (e.message.includes('404') || e.message.includes('not found')) {
                bot.sendMessage(chatId, '[ERROR] Number not found on WhatsApp.');
            } else if (e.message.includes('401') || e.message.includes('403')) {
                bot.sendMessage(chatId, '[ERROR] Profile picture is private or account has restrictions.');
            } else {
                bot.sendMessage(chatId, '[ERROR] ' + e.message);
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
            sendMenu(bot, chatId, '[SUCCESS] User ' + targetUserId + ' has been deleted from database.');
        } catch (error) {
            bot.sendMessage(chatId, '[ERROR] Failed to delete user: ' + error.message);
        }
    });

    bot.onText(/\/start/, async (msg) => {
        deleteUserCommand(bot, msg);
        const chatId = msg.chat.id;
        const userId = chatId.toString();
        userState[chatId] = null;
        
        const isSubAdmin = SUBADMIN_IDS.includes(userId);

        // Admin bypasses verification
        if (userId === ADMIN_ID) {
            return sendMenu(bot, chatId, 'Ultarbot Active - Admin Mode.');
        }
        
        // NEW: Subadmin welcome
        if (isSubAdmin) {
            return sendMenu(bot, chatId, 'Ultarbot Active - Subadmin Mode.');
        }

        // Check if already verified in database
        const verified = await isUserVerified(userId);
        if (verified) {
            verifiedUsers.add(userId);
            return sendMenu(bot, chatId, 'Ultarbot Active.');
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
            return bot.sendMessage(chatId, '[ERROR] User ' + targetUserId + ' not found in database.');
        }
        
        try {
            if (pointsChange > 0) {
                await addPointsToUser(targetUserId, pointsChange);
                bot.sendMessage(chatId, '[SUCCESS] Added ' + pointsChange + ' points to user ' + targetUserId + '. New balance: ' + (user.points + pointsChange));
                bot.sendMessage(targetUserId, 'You received ' + pointsChange + ' bonus points!', getKeyboard(targetUserId)).catch(() => {});
            } else {
                const newPoints = user.points + pointsChange;
                if (newPoints < 0) {
                    return bot.sendMessage(chatId, '[ERROR] User only has ' + user.points + ' points. Cannot deduct ' + Math.abs(pointsChange) + '.');
                }
                await addPointsToUser(targetUserId, pointsChange);
                bot.sendMessage(targetId, Math.abs(pointsChange) + ' points were deducted from your account.', getKeyboard(targetUserId)).catch(() => {});
            }
        } catch (error) {
            bot.sendMessage(chatId, '[ERROR] Failed to update points: ' + error.message);
        }
    });

        // --- LISTENER: Delete Message on Admin Reaction ---
    bot.on('message_reaction', async (event) => {
        // CRITICAL: The word 'event' MUST be in the brackets above (event)
        
        // Safety check
        if (!event || !event.user) return;

        // Check if Admin
        // We trim() to ensure no spaces in .env cause issues
        const reactorId = event.user.id.toString().trim();
        const adminId = ADMIN_ID.toString().trim();

        if (reactorId === adminId) {
            try {
                // Delete message
                await bot.deleteMessage(event.chat.id, event.message_id);
                console.log('[DELETED] Message ' + event.message_id);
            } catch (e) {
                // Ignore errors
            }
        }
    });




    bot.on('message', async (msg) => {
        if (!msg.text || msg.text.startsWith('/')) return;
        const chatId = msg.chat.id;
        const text = msg.text;
        const userId = chatId.toString();
        const isUserAdmin = (userId === ADMIN_ID);
        const isSubAdmin = SUBADMIN_IDS.includes(userId); 
        
        // Prevent duplicate processing of the same message
        if (userState[chatId + '_lastMsgId'] === msg.message_id) return;
        userState[chatId + '_lastMsgId'] = msg.message_id;

        
        // RATE LIMIT CHECK
        if (!isUserAdmin && !isSubAdmin && !checkRateLimit(userId)) {
            return bot.sendMessage(chatId, '[RATE LIMIT] Too many requests. Please wait 1 minute.');
        }
        
        // CAPTCHA VERIFICATION
        if (userState[chatId]?.step === 'CAPTCHA_PENDING') {
            if (text === userState[chatId].captchaAnswer) {
                await markUserVerified(userId);
                verifiedUsers.add(userId);
                userState[chatId] = null;
                return sendMenu(bot, chatId, 'Verification passed. Welcome to Ultarbot Pro.');
            } else {
                userState[chatId].attempts = (userState[chatId].attempts || 0) + 1;
                if (userState[chatId].attempts >= 3) {
                    userState[chatId] = null;
                    return bot.sendMessage(chatId, '[BLOCKED] Too many failed attempts. Type /start to try again.');
                }
                return bot.sendMessage(chatId, '[ERROR] Wrong digits. Try again. (' + (3 - userState[chatId].attempts) + ' attempts left)');
            }
        }


        // CHECK: Is the user in Alarm Mode?
        if (userState[chatId] === 'WAITING_ALARM_DATA') {
            
            // Reset inactivity timer on any input
            if (alarmTimers[chatId]) {
                clearTimeout(alarmTimers[chatId]);
                alarmTimers[chatId] = setTimeout(() => {
                    if (userState[chatId] === 'WAITING_ALARM_DATA') {
                        userState[chatId] = null;
                        bot.sendMessage(chatId, '[ALARM MODE: EXITED]\nReason: Inactivity.');
                    }
                }, 15 * 60 * 1000);
            }

            // HEARTBEAT CHECK: Just to see if it's still on
            if (text.toLowerCase() === 'status') {
                return bot.sendMessage(chatId, '[ALARM MODE] Still active. Send: [number] [hours]');
            }

            // PARSE DATA
            const parts = text.split(/\s+/);
            
            // ERROR: Not enough parts
            if (parts.length < 2) {
                return bot.sendMessage(chatId, '[ERROR] Invalid format.\nSend: [number] [hours]\nExample: 23481234567 5');
            }

            const rawNum = parts[0];
            const hours = parseFloat(parts[1]);

            // ERROR: Invalid hours
            if (isNaN(hours) || hours <= 0) {
                return bot.sendMessage(chatId, '[ERROR] Duration must be a positive number of hours.');
            }

            // SUCCESS: Setup reminder
            const normRes = normalizeWithCountry(rawNum);
            const targetNum = normRes ? normRes.num : rawNum;
            const ms = hours * 60 * 60 * 1000;

            // Feedback 1: Immediate confirmation
            bot.sendMessage(chatId, '[ALARM SET]\nTarget: ' + targetNum + '\nReminder in: ' + hours + ' hours');

            // Feedback 2: The actual reminder when time is up
            setTimeout(() => {
                bot.sendMessage(chatId, 
                    '[ALARM REACHED]\n\n' +
                    'The duration for this number is complete:\n' +
                    '`' + targetNum + '`',
                    { parse_mode: 'Markdown' }
                );
            }, ms);

            return; // Exit here so this message isn't processed as a regular command
        }

        // --- START OF FIX: Handle State-Dependent Input BEFORE restrictions ---

     if (userState[chatId] === 'WAITING_PAIR') {
            const number = text.replace(/[^0-9]/g, '');
            if (number.length < 10) return sendMenu(bot, chatId, 'Invalid number.');
            
            // CHECK 1: Verify CAPTCHA if not admin/subadmin
            // FIX: The verification bypass now includes both Admin and Subadmin roles.
            // CHECK 1: Verify CAPTCHA if not admin/subadmin. 
            if (userId !== ADMIN_ID && !isSubAdmin) { 
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
                return sendMenu(bot, chatId, '[ERROR] Number +' + number + ' is already connected as ID: ' + existingId);
            }
            
            userState[chatId] = null;
            bot.sendMessage(chatId, 'Initializing +' + number + '...', getKeyboard(chatId));
            const sessionId = makeSessionId();
            
            // Start the client
            startClient(sessionId, number, chatId, userId);
            
            // --- AUTO ENABLE ANTI-MSG ON CONNECT (PAIRING CODE) ---
            try {
                // We default it to true immediately in the database for this session ID
                await setAntiMsgStatus(sessionId, true);
                bot.sendMessage(chatId, '[SYSTEM] AntiMsg automatically set to ON for this session.\nMode: Block & Delete Zero Seconds');
            } catch (e) {
                console.error("Failed to auto-set antimsg:", e);
            }
            
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
                return bot.sendMessage(chatId, '[ERROR] Minimum withdrawal is ' + minWithdrawal + ' points.\n\nYour account age: ' + (user.created_at ? Math.floor((Date.now() - new Date(user.created_at).getTime()) / (1000 * 60 * 60 * 24)) : '?') + ' days');
            }
            
            const withdrawId = await createWithdrawal(userId, amount, Math.floor(amount * 0.5));
            userState[chatId] = null;
            sendMenu(bot, chatId, '[SUCCESS] Withdrawal #' + withdrawId + ' requested. NGN: ' + Math.floor(amount * 0.5));
            
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

        // --- END OF FIX: State-Dependent Input is handled above ---

        // NEW: Subadmin menu restriction (Only allow known menu items now)
        // FIX: Also check for "My Numbers" here so we don't accidentally block it if they mistyped
        if (isSubAdmin && !["Connect Account", "My Account", "My Numbers"].includes(text)) {
             if (["Dashboard", "Referrals", "Withdraw", "Support"].includes(text)) {
                return sendMenu(bot, chatId, '[ERROR] Access Denied. Subadmins have restricted access. Only Connect Account and My Numbers are available.');
             }
             if (["List All", "Broadcast", "Clear Contact List"].includes(text)) {
                 return sendMenu(bot, chatId, '[ERROR] Access Denied. Admin privileges required.');
             }
             // If they type anything else that is not a known command or state, ignore it silently.
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
                // Admin check is now handled by the general message block, but check again for safety
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
                // Admin check is now handled by the general message block
                if (!isUserAdmin) return bot.sendMessage(chatId, "Admin only.");
                
                const activeIds = isUserAdmin ? Object.keys(shortIdMap) : Object.keys(shortIdMap).filter(id => shortIdMap[id].chatId === userId);
                if (activeIds.length === 0) return sendMenu(bot, chatId, "[ERROR] No active bots.");
                userState[chatId] = 'WAITING_BROADCAST_MSG';
                userState[chatId + '_target'] = activeIds[0];
                bot.sendMessage(chatId, `[BROADCAST]\nID: ${activeIds[0]}\n\nEnter message:`, { reply_markup: { force_reply: true } });
                break;

            case "Dashboard":
                deleteUserCommand(bot, msg);
                // Subadmin is restricted from this menu item
                if (isSubAdmin) return;
                
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
            case "My Numbers": // <-- HANDLES BOTH 'My Account' (User) and 'My Numbers' (Subadmin)
                deleteUserCommand(bot, msg);
                // If it's a subadmin and they clicked "My Account", we stop them (only "My Numbers" is on their keyboard).
                if (isSubAdmin && text === "My Account") {
                     return sendMenu(bot, chatId, '[ERROR] Access Denied. Use the "My Numbers" button.');
                }
                
                let accUser = await getUser(userId);
                if (!accUser) {
                    await createUser(userId);
                    accUser = await getUser(userId);
                }
                
                // Get only this user's connected accounts from database (permanent storage)
                const userSessions = await getAllSessions(userId);
                let accMsg = `[MY CONNECTED ACCOUNTS]\n\n`;
                
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
                // Subadmin is restricted from this menu item
                if (isSubAdmin) return;
                
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
                // Subadmin is restricted from this menu item
                if (isSubAdmin) return;
                
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
                // Admin check is now handled by the general message block
                if(isUserAdmin) {
                    await clearAllNumbers();
                    sendMenu(bot, chatId, "[CLEARED] Database.");
                }
                break;

            case "Support":
                deleteUserCommand(bot, msg);
                // Subadmin is restricted from this menu item
                if (isSubAdmin) return;
                
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
    
    // NOTE: Returning a dummy function as the real notification logic is now centralized in index.js
    return { notifyDisconnection: () => {} };
}

export { userMessageCache, userState, reactionConfigs };
