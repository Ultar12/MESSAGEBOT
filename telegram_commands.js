import { TelegramClient, Api } from "telegram";
import { NewMessage } from "telegram/events/index.js";
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
import docxConverter from 'docx-pdf';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit-table';
import PDFPlain from 'pdfkit';
import fs from 'fs'; 
import TelegramBot from 'node-telegram-bot-api';
import { pipeline } from 'node:stream/promises';
import * as XLSX from 'xlsx';
import fetch from 'node-fetch';


const apiId = parseInt(process.env.TELEGRAM_API_ID); 
// Add these to handle bulk forwards without spamming
const vzBuffer = {}; 
const vzTimer = {};
const apiHash = process.env.TELEGRAM_API_HASH;
const stringSession = new StringSession(process.env.TELEGRAM_SESSION || ""); 
// Initialize UserBot (Call this once in your index.js or startup)
const userBot = new TelegramClient(stringSession, apiId, apiHash, { 
    connectionRetries: 10, // Increased retries for stability
    useWSS: true // Force secure sockets for Heroku
});

// 🔄 Helper function to guarantee connection before any action
async function ensureConnected() {
    if (!userBot.connected) {
        console.log("[USERBOT] 🔌 Reconnecting...");
        await userBot.connect();
    }
    // Double check authorization status
    try {
        await userBot.getMe(); 
    } catch (e) {
        console.log("[USERBOT] 🔑 Session might be invalid or disconnected. Re-authorizing...");
        await userBot.connect();
    }
}

export let currentOtpSenderId = null;

// Add this at the top of your file with your other variables
const failedAccounts = new Set();

/**
 * Updates the current OTP sender and tracks failures.
 * @param {string|null} id - The session ID to lock.
 * @param {boolean} wasError - If true, the account is blacklisted from being picked again.
 */
export function updateOtpSender(id, wasError = false) {
    if (wasError && currentOtpSenderId) {
        failedAccounts.add(currentOtpSenderId);
        console.log(`🚫 [BLACKLIST] ${currentOtpSenderId} added to failed list.`);
    }
    
    currentOtpSenderId = id;
    
    if (id) {
        console.log(`🔒 [SYSTEM] ${id} is now the LOCKED OTP Sender.`);
    } else {
        console.log(`🔓 [SYSTEM] OTP Sender reset. Searching for new candidate...`);
    }
}

/**
 * Finds and locks a dedicated sender, skipping any that have previously failed.
 */
export function getDedicatedSender(activeClients) {
    // 1. If we already have a sender and they are still online, return them
    if (currentOtpSenderId && activeClients[currentOtpSenderId]) {
        return activeClients[currentOtpSenderId];
    }

    // 2. Find first available account that is NOT in the failed list
    const availableSessions = Object.keys(activeClients).filter(id => 
        activeClients[id] && !failedAccounts.has(id)
    );
    
    if (availableSessions.length > 0) {
        currentOtpSenderId = availableSessions[0]; 
        console.log(`🚀 [SYSTEM] Account ${currentOtpSenderId} has been CLAIMED as Dedicated OTP Sender.`);
        return activeClients[currentOtpSenderId];
    }

    // 3. Fallback: If ALL accounts have failed, clear the blacklist and try again
    if (failedAccounts.size > 0) {
        console.log("🔄 [SYSTEM] All accounts failed once. Clearing blacklist to retry...");
        failedAccounts.clear();
        
        const retrySessions = Object.keys(activeClients).filter(id => activeClients[id]);
        if (retrySessions.length > 0) {
            currentOtpSenderId = retrySessions[0];
            return activeClients[currentOtpSenderId];
        }
    }

    console.log("⚠️ [SYSTEM] No accounts available to assign as OTP Sender!");
    return null;
}


// To this line:
export async function initUserBot(activeClients) {
    try {
        console.log("[USERBOT] Starting initialization...");
        await userBot.connect();
        console.log("[USERBOT] Connection established.");
        
        // This forces the bot to pick an account and "LOCK" it immediately on startup
        getDedicatedSender(activeClients); 
        
        await setupLiveOtpForwarder(userBot, activeClients);
        
    } catch (e) {
        console.error("[USERBOT INIT FAIL]", e.message);
    }
}



// This function allows the scraper to "claim" or "reset" a bot



export function setupLiveOtpForwarder(userBot, activeClients) {
    console.log("[MONITOR] Starting active OTP Polling (Telegram + WhatsApp)...");

    // --- ADD THIS BLOCK HERE ---
    // Forces the bot to "see" all its groups and cache their access hashes
    const syncEntities = async () => {
        try {
            console.log("[USERBOT] Syncing group entities...");
            await userBot.getDialogs(); 
            console.log("[USERBOT] Sync complete.");
        } catch (e) {
            console.error("[USERBOT] Sync failed:", e.message);
        }
    };
    syncEntities(); 
    // ---------------------------

    const OTP_BOT_TOKEN = "8722377131:AAEr1SsPWXKy8m4WbTJBe7vrN03M2hZozhY";


    const senderBot = new TelegramBot(OTP_BOT_TOKEN, { polling: false });

    // Configuration
    const TELEGRAM_TARGET_GROUP = "-1003645249777"; 
    const WHATSAPP_INVITE_CODE = "KGSHc7U07u3IqbUFPQX15q"; 
    
    // Multi-Group Source List
    const SOURCE_GROUPS = ["-1003518737176", "-1003644661262"]; 

    // Independent trackers for each group
    const groupStates = {};
    SOURCE_GROUPS.forEach(id => { groupStates[id] = { lastMessageId: 0 }; });

    const recentCodes = new Map(); 

        setInterval(async () => {
        try {
            if (!userBot || !userBot.connected) return;

            for (const SOURCE_GROUP_ID of SOURCE_GROUPS) {
                // --- RESOLVE ENTITY TO FIX CHANNEL_INVALID ---
                let entity;
                try {
                    entity = await userBot.getEntity(SOURCE_GROUP_ID);
                } catch (entityErr) {
                    // Skip if the group isn't found or bot isn't a member
                    console.error(`[ENTITY ERROR] Could not resolve ${SOURCE_GROUP_ID}:`, entityErr.message);
                    continue; 
                }

                // Use the resolved entity instead of the raw ID
                const messages = await userBot.getMessages(entity, { limit: 1 });
                if (!messages || messages.length === 0) continue;

                const latestMsg = messages[0];
                const state = groupStates[SOURCE_GROUP_ID];

                if (state.lastMessageId === 0) {
                    state.lastMessageId = latestMsg.id;
                    continue;
                }

                if (latestMsg.id > state.lastMessageId) {
                    state.lastMessageId = latestMsg.id; 
                    
                    let textToSearch = latestMsg.message || "";
                    let replyText = "";

                    try {
                        const replyMsg = await latestMsg.getReplyMessage();
                        if (replyMsg && replyMsg.message) {
                            replyText = replyMsg.message;
                        }
                    } catch (e) { }

                    const combinedText = textToSearch + "\n" + replyText;
                    let code = null;


                    // EXTRACTION A: Text
                    const textCodeMatch = textToSearch.match(/(?:\b|[^0-9])(\d{3})[-\s]?(\d{3})(?:\b|[^0-9])/);
                    if (textCodeMatch) {
                        code = textCodeMatch[1] + textCodeMatch[2];
                    }

                    // EXTRACTION B: Buttons
                    if (!code && latestMsg.replyMarkup && latestMsg.replyMarkup.rows) {
                        for (const row of latestMsg.replyMarkup.rows) {
                            for (const btn of row.buttons) {
                                const btnText = btn.text || "";
                                const btnCodeMatch = btnText.match(/(?:\b|[^0-9])(\d{3})[-\s]?(\d{3})(?:\b|[^0-9])/);
                                if (btnCodeMatch) {
                                    code = btnCodeMatch[1] + btnCodeMatch[2];
                                    break;
                                }
                            }
                            if (code) break;
                        }
                    }

                    if (code) {
                        const now = Date.now();
                        if (recentCodes.has(code) && (now - recentCodes.get(code) < 30000)) continue; 
                        recentCodes.set(code, now);

                        // Extract Metadata
                        let platform = "WhatsApp"; 
                        if (combinedText.toLowerCase().includes("business") || combinedText.includes("WB")) {
                            platform = "WA Business"; 
                        }

                        const countryMap = {
                            "VE": { name: "Venezuela", flag: "🇻🇪" },
                            "ZW": { name: "Zimbabwe", flag: "🇿🇼" },
                            "NG": { name: "Nigeria", flag: "🇳🇬" },
                            "ID": { name: "Indonesia", flag: "🇮🇩" },
                            "BR": { name: "Brazil", flag: "🇧🇷" },
                            "RU": { name: "Russia", flag: "🇷🇺" },
                            "ZA": { name: "South Africa", flag: "🇿🇦" },
                            "PH": { name: "Philippines", flag: "🇵🇭" },
                            "VN": { name: "Vietnam", flag: "🇻🇳" },
                            "US": { name: "United States", flag: "🇺🇸" },
                            "GB": { name: "United Kingdom", flag: "🇬🇧" },
                            "BF": { name: "Burkina Faso", flag: "🇧🇫" },
                            "KG": { name: "Kyrgyzstan", flag: "🇰🇬" },
                            "SN": { name: "Senegal", flag: "🇸🇳" }
                        };

                        let countryCode = "Unknown";
                        const countryMatch = combinedText.match(/#([a-zA-Z]{2})/i);
                        if (countryMatch) countryCode = countryMatch[1].toUpperCase();

                        let fullCountry = countryCode;
                        let flagEmoji = "🌍";
                        if (countryMap[countryCode]) {
                            fullCountry = countryMap[countryCode].name;
                            flagEmoji = countryMap[countryCode].flag;
                        }

                        let maskedNumber = "Unknown";
                        const tagMatch = combinedText.match(/\[#(?:WP|WB)\]\s*([^\s┨]+)/i);
                        if (tagMatch && tagMatch[1]) {
                            maskedNumber = tagMatch[1];
                        } else {
                            const fallbackMatch = combinedText.match(/\d{2,6}[\u200B-\u200D\uFEFF\u200C]*[*•\u2022.]{2,}[\u200B-\u200D\uFEFF\u200C]*\d{2,6}/);
                            if (fallbackMatch) maskedNumber = fallbackMatch[0];
                        }
                        maskedNumber = maskedNumber.replace(/[\u200B-\u200D\uFEFF\u200C]/g, '');

                        // ==========================================
                        // 1. SEND TO TELEGRAM
                        // ==========================================
                        const tgOutputText = 
                            `╭═══ 𝚄𝙻𝚃𝙰𝚁 𝙾𝚃𝙿 ═══════⊷\n` +
                            `┃❃╭──────────────\n` +
                            `┃❃│ Platform : ${platform}\n` +
                            `┃❃│ Country  : ${fullCountry} ${flagEmoji}\n` +
                            `┃❃│ Number   : ${maskedNumber}\n` +
                            `┃❃│ Code     : \`${code}\`\n` +
                            `┃❃│ Num Bot  : t.me/ultarotpbot\n` +
                            `┃❃╰───────────────\n` +
                            `╰═════════════════⊷`;

                        let inlineKeyboard = [[{ text: `Copy: ${code}`, copy_text: { text: code } }], [{ text: `Owner`, url: `https://t.me/Staries1` }]];

                        try {
                            const tgMsg = await senderBot.sendMessage(TELEGRAM_TARGET_GROUP, tgOutputText, {
                                parse_mode: 'Markdown',
                                disable_web_page_preview: true,
                                reply_markup: { inline_keyboard: inlineKeyboard }
                            });
                            setTimeout(async () => {
                                try { await senderBot.deleteMessage(TELEGRAM_TARGET_GROUP, tgMsg.message_id); } catch (e) {}
                            }, 300000);
                        } catch (err) {}

                        // ==========================================
                        // 2. SEND TO WHATSAPP (LOCKED SENDER)
                        // ==========================================
                        const waOutputText = 
                            `╭═══ 𝚄𝙻𝚃𝙰𝚁 𝙾𝚃𝙿 ═══════⊷\n` +
                            `┃❃╭──────────────\n` +
                            `┃❃│ Platform : ${platform}\n` +
                            `┃❃│ Country  : ${fullCountry} ${flagEmoji}\n` +
                            `┃❃│ Number   : ${maskedNumber}\n` +
                            `┃❃│ Code     : *${code}*\n` +
                            `┃❃│ Num Bot  : t.me/ultarotpbot\n` +
                            `┃❃╰───────────────\n` +
                            `╰═════════════════⊷`;

                        const sock = getDedicatedSender(activeClients); 
                        if (sock) {
                            try {
                                const inviteInfo = await sock.groupGetInviteInfo(WHATSAPP_INVITE_CODE);
                                try {
                                    await sock.sendMessage(inviteInfo.id, { text: waOutputText });
                                } catch (e2) {
                                    await sock.groupAcceptInvite(WHATSAPP_INVITE_CODE);
                                    await new Promise(r => setTimeout(r, 2000));
                                    await sock.sendMessage(inviteInfo.id, { text: waOutputText });
                                }
                            } catch (fatalErr) {
                                updateOtpSender(null); 
                            }
                        }
                    }
                }
            }
        } catch (e) {
            if (!e.message.includes("Cannot read properties")) {
                console.error("[OTP Grabber Error]:", e.message);
            }
        }
    }, 3000); 
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

/**
 * --- BAN TYPE CHECKER ---
 * Distinguishes between Active, Reviewable (Suspended), and Permanently Banned.
 * * WARNING: Use sparingly. Attempting registration too often can trigger 
 * WhatsApp's anti-spam filters on your environment.
 */

export async function checkDetailedBanStatus(sock, phoneNumber) {
    try {
        // Step 1: Check if it exists on WhatsApp first
        const [result] = await sock.onWhatsApp(`${phoneNumber}@s.whatsapp.net`);
        
        if (result && result.exists) {
            return { status: "ACTIVE", detail: "Number is currently live." };
        }

        // Step 2: If not active, attempt to request a registration code (SMS)
        // This is where we see the specific server rejection reason.
        try {
            await sock.requestRegistrationCode({
                phoneNumber: phoneNumber,
                method: 'sms',
                // Mocking registration params
                fields: {
                    mcc: "624", // Example for Cameroon, adjust as needed
                    mnc: "01"
                }
            });
            
            // If it reaches here, it means it's NOT banned but just not logged in.
            return { status: "NOT_LOGGED_IN", detail: "Active but no account created." };
        } catch (err) {
            const reason = err.data?.reason || err.message;

            // Step 3: Parse the rejection reason
            // 'blocked' usually means Suspended with "Request Review" option
            if (reason === 'blocked') {
                return { status: "TEMPORARY_BAN", detail: "Suspended - Review option available." };
            }
            
            // 'banned' usually means Permanent/Flagged
            if (reason === 'banned') {
                return { status: "PERMANENT_BAN", detail: "Permanently removed from network." };
            }

            return { status: "UNKNOWN", detail: reason };
        }

    } catch (e) {
        return { status: "ERROR", detail: e.message };
    }
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

    // --- /st [r | nr] : Extract Registered or Not Registered numbers from Bio Checker files (TXT & XLSX) ---
    bot.onText(/\/st\s+(r|nr)/i, async (msg, match) => {
        deleteUserCommand(bot, msg);
        const chatId = msg.chat.id;
        const userId = chatId.toString();
        
        // Authorization check
        const isUserAdmin = (userId === ADMIN_ID);
        const isSubAdmin = SUBADMIN_IDS.includes(userId);
        if (!isUserAdmin && !isSubAdmin) return;

        if (!msg.reply_to_message || !msg.reply_to_message.document) {
            return bot.sendMessage(chatId, '[ERROR] Reply to the checker file (.txt or .xlsx) with /st r or /st nr.');
        }

        const mode = match[1].toLowerCase(); 

        try {
            bot.sendMessage(chatId, `[PROCESSING] Extracting **${mode === 'r' ? 'REGISTERED' : 'NOT REGISTERED'}** numbers...`, { parse_mode: 'Markdown' });

            // 1. Download the file
            const fileId = msg.reply_to_message.document.file_id;
            const fileLink = await bot.getFileLink(fileId);
            const response = await fetch(fileLink);
            const fileName = msg.reply_to_message.document.file_name || '';
            
            let rawText = "";

            // 2. Handle File Formats (XLSX vs TXT)
            if (fileName.toLowerCase().endsWith('.xlsx')) {
                const buffer = await response.buffer();
                const workbook = XLSX.read(buffer, { type: 'buffer' });
                const sheet = workbook.Sheets[workbook.SheetNames[0]];
                const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });
                
                // Convert Excel cells into a single searchable text block
                data.forEach(row => {
                    if (Array.isArray(row)) {
                        row.forEach(cell => { 
                            if (cell) rawText += cell.toString() + '\n'; 
                        });
                    }
                });
            } else {
                // Handle standard .txt or .vcf
                rawText = await response.text();
            }

            // 3. Split the document at the "Not Registered" header
            const splitRegex = /\[\s*NOMOR TIDAK TERDAFTAR WHATSAPP.*?\]/i;
            const splitText = rawText.split(splitRegex);

            let targetText = "";

            if (mode === 'r') {
                targetText = splitText[0] || "";
            } else if (mode === 'nr') {
                targetText = splitText[1] || "";
            }

            if (!targetText.trim()) {
                return bot.sendMessage(chatId, `[ERROR] Could not find any numbers for that category in this file.`);
            }

            // 4. Extract all numbers starting with a '+'
            const matches = targetText.match(/\+\d{10,15}/g) || [];
            
            if (matches.length === 0) {
                return bot.sendMessage(chatId, `[DONE] No numbers found in the ${mode.toUpperCase()} section.`);
            }

            // 5. Clean numbers and strip country code
            const uniqueCleanedNumbers = new Set();
            let countryPrefixDetected = "N/A";

            for (let raw of matches) {
                let cleanNum = raw.replace('+', ''); 
                
                const res = normalizeWithCountry(cleanNum);
                
                if (res && res.code && res.code !== 'N/A') {
                    countryPrefixDetected = res.code;
                    if (cleanNum.startsWith(res.code)) {
                        cleanNum = cleanNum.substring(res.code.length);
                    }
                }
                
                uniqueCleanedNumbers.add(cleanNum);
            }

            const finalList = Array.from(uniqueCleanedNumbers);

            bot.sendMessage(chatId, 
                `[REPORT]\n` +
                `Mode: ${mode === 'r' ? 'Registered ✅' : 'Not Registered ❌'}\n` +
                `File: ${fileName}\n` +
                `Country Code Stripped: +${countryPrefixDetected}\n` +
                `Total Found: ${finalList.length}\n\n` +
                `Sending batches...`
            );

            // 6. Send in clickable batches of 6
            const BATCH_SIZE = 6;
            for (let i = 0; i < finalList.length; i += BATCH_SIZE) {
                const chunk = finalList.slice(i, i + BATCH_SIZE);
                const msgText = chunk.map(n => `\`${n}\``).join('\n');
                
                await bot.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
                await delay(1000); 
            }

            bot.sendMessage(chatId, `[COMPLETED] All ${mode.toUpperCase()} batches sent.`);

        } catch (e) {
            bot.sendMessage(chatId, `[ERROR] Processing failed: ${e.message}`);
        }
    });

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



        // --- /ttx [Reply to file] ---
    // RAW MODE: Pours out numbers exactly as they are (Bypasses Country Normalization)
    bot.onText(/\/ttx/, async (msg) => {
        deleteUserCommand(bot, msg);
        const chatId = msg.chat.id;
        const userId = chatId.toString();
        
        // Authorization: Allow both Admin and Subadmins
        const isUserAdmin = (userId === ADMIN_ID);
        const isSubAdmin = SUBADMIN_IDS.includes(userId);

        if (!isUserAdmin && !isSubAdmin) return;

        if (!msg.reply_to_message || !msg.reply_to_message.document) {
            return bot.sendMessage(chatId, '[ERROR] Reply to a .txt or .vcf file with /ttx');
        }

        try {
            // Check if any WhatsApp bot is connected
                        // Filter all folders, but EXCLUDE the dedicated OTP sender
            const activeFolders = Object.keys(clients).filter(f => 
                clients[f] && f !== currentOtpSenderId
            );
            
            // Now 'sock' will only be a non-OTP account
            const sock = activeFolders.length > 0 ? clients[activeFolders[0]] : null;

            if (sock) {
                bot.sendMessage(chatId, `[STREAMING MODE] Using account: ${activeFolders[0]}. Checking WA status...`);
            } else {
                // If the only connected account is the OTP sender, we act as if none are connected
                bot.sendMessage(chatId, '[NORMAL MODE] No available checker account. (Dedicated OTP account is protected).');
            }


            // --- STEP 1: Build List of Connected Numbers (Raw) ---
            const connectedSet = new Set();
            Object.values(shortIdMap).forEach(session => {
                if (session.phone) {
                    connectedSet.add(session.phone.toString().replace(/\D/g, ''));
                }
            });

            // --- STEP 2: Read File ---
            const fileId = msg.reply_to_message.document.file_id;
            const fileLink = await bot.getFileLink(fileId);
            const response = await fetch(fileLink);
            const rawText = await response.text();
            const lines = rawText.split(/\r?\n/);

            let skippedConnectedCount = 0;

            if (sock) {
                // =========================================================
                // BRANCH A: BOT IS CONNECTED -> PERFORM WA CHECK (STREAMING)
                // =========================================================
                let activeBatch = []; 
                const bannedNumbers = []; 
                
                let totalChecked = 0;
                let validCount = 0;

                for (const line of lines) {
                    // Extract only digits, ignoring any other characters
                    const cleanNum = line.replace(/\D/g, '');

                    if (cleanNum && cleanNum.length >= 7) {
                        
                        // Filter duplicates
                        if (connectedSet.has(cleanNum)) {
                            skippedConnectedCount++;
                            continue;
                        }

                        // Check Status
                        totalChecked++;
                        try {
                            // Since it's pre-converted, we use the clean number directly
                            const jid = `${cleanNum}@s.whatsapp.net`;
                            
                            const [check] = await sock.onWhatsApp(jid);
                            
                            if (check && check.exists) {
                                // Found Valid: Add to batch
                                activeBatch.push(cleanNum);
                                validCount++;

                                if (activeBatch.length === 5) {
                                    const msgText = activeBatch.map(n => '`' + n + '`').join('\n');
                                    await bot.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
                                    activeBatch = []; // Clear buffer
                                    await delay(1000); // Small delay to prevent Telegram flood
                                }
                            } else {
                                // Found Banned: Save for later
                                bannedNumbers.push(cleanNum);
                            }
                        } catch (err) {
                            // Network error? Treat as banned/skip for now
                            bannedNumbers.push(cleanNum);
                        }

                        // Safety delay to protect your checker bot (300ms)
                        if (totalChecked % 5 === 0) await delay(300);
                    }
                }

                // Flush Remaining Active Numbers
                if (activeBatch.length > 0) {
                    const msgText = activeBatch.map(n => '`' + n + '`').join('\n');
                    await bot.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
                }

                // Send Banned Report (At the end)
                if (bannedNumbers.length > 0) {
                    await bot.sendMessage(chatId, `🔴 **[BANNED / INVALID]** (${bannedNumbers.length})`, { parse_mode: 'Markdown' });
                    
                    // Send banned in batches of 10 to clear them out quickly
                    for (let i = 0; i < bannedNumbers.length; i += 10) {
                        const chunk = bannedNumbers.slice(i, i + 10);
                        const msgText = chunk.map(n => '`' + n + '`').join('\n');
                        await bot.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
                        await delay(800);
                    }
                }

                // Final Summary
                bot.sendMessage(chatId, 
                    `[DONE]\n` +
                    `Checked: ${totalChecked}\n` +
                    `Active: ${validCount}\n` +
                    `Banned/Invalid: ${bannedNumbers.length}\n` +
                    `Skipped Connected: ${skippedConnectedCount}`
                );

            } else {
                // =========================================================
                // BRANCH B: NO BOT CONNECTED -> BATCH SEND WITHOUT WA CHECK
                // =========================================================
                const newNumbers = new Set();

                lines.forEach(line => {
                    const cleanNum = line.replace(/\D/g, '');

                    if (cleanNum && cleanNum.length >= 7) {
                        if (connectedSet.has(cleanNum)) {
                            skippedConnectedCount++;
                        } else {
                            newNumbers.add(cleanNum);
                        }
                    }
                });

                const uniqueList = Array.from(newNumbers);
                const total = uniqueList.length;
                
                if (total === 0) {
                    return bot.sendMessage(chatId, `[DONE] No new numbers found.\nSkipped ${skippedConnectedCount} connected numbers.`);
                }

                const batchSize = 5;
                const totalBatches = Math.ceil(total / batchSize);
                
                bot.sendMessage(chatId, 
                    `[FILTER REPORT]\n` +
                    `Input Found: ${lines.length}\n` +
                    `Already Connected: ${skippedConnectedCount}\n` +
                    `New Numbers: ${total}\n\n` +
                    `[SENDING] ${totalBatches} batches...`
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
            }

        } catch (e) {
            bot.sendMessage(chatId, '[ERROR] ' + e.message);
        }
    });


    bot.onText(/\/sender/, (msg) => {
    const chatId = msg.chat.id;
    
    if (!currentOtpSenderId || !clients[currentOtpSenderId]) {
        return bot.sendMessage(chatId, "⚠️ No account is currently locked as the OTP Sender.");
    }

    const sock = clients[currentOtpSenderId];
    const number = sock.user.id.split(':')[0]; // Extracts the number from the session data

    const statusMsg = 
        `*DEDICATED OTP SENDER*\n\n` +
        `*Number:* +${number}\n` +
        `*Session:* \`${currentOtpSenderId}\`\n` +
        `*Status:* Active & Connected`;

    bot.sendMessage(chatId, statusMsg, { parse_mode: 'Markdown' });
});


    bot.onText(/\/checknum\s+(\d+)/, async (msg, match) => {
        deleteUserCommand(bot, msg);
        const chatId = msg.chat.id;
        const userId = chatId.toString();

        const isUserAdmin = (userId === ADMIN_ID);
        const isSubAdmin = (SUBADMIN_IDS || []).includes(userId);
        if (!isUserAdmin && !isSubAdmin) return;

        const rawInput = match[1];
        const res = normalizeWithCountry(rawInput);

        if (!res || !res.num) {
            return bot.sendMessage(chatId, "[ERROR] Invalid number format.");
        }

        const activeFolders = Object.keys(clients).filter(f => clients[f]);
        const sock = activeFolders.length > 0 ? clients[activeFolders[0]] : null;

        if (!sock) {
            return bot.sendMessage(chatId, "[ERROR] No WhatsApp bots connected to perform deep check.");
        }

        const fullPhone = res.code === 'N/A' ? res.num : `${res.code}${res.num.replace(/^0/, '')}`;
        const jid = `${fullPhone}@s.whatsapp.net`;

        try {
            bot.sendMessage(chatId, "[CHECKING] Performing deep scan on " + fullPhone + "...");

            // 1. Initial Existence Check
            const [exists] = await sock.onWhatsApp(jid);

            if (exists && exists.exists) {
                return bot.sendMessage(chatId, 
                    "[RESULT] " + fullPhone + "\n" +
                    "Status: ACTIVE\n" +
                    "Detail: Number is currently live and usable."
                );
            }

            // 2. Registration Probe (Mock Attempt)
            // This triggers the server to return the specific ban reason
            try {
                await sock.requestRegistrationCode({
                    phoneNumber: "+" + fullPhone,
                    method: 'sms',
                    fields: {
                        mcc: "624", // Defaulting to Cameroon; adjust if needed based on res.code
                        mnc: "01"
                    }
                });

                // If it succeeds, the number is NOT banned, just not registered
                bot.sendMessage(chatId, 
                    "[RESULT] " + fullPhone + "\n" +
                    "Status: NOT REGISTERED\n" +
                    "Detail: Number is clean but no WhatsApp account exists yet."
                );

            } catch (regErr) {
                const reason = regErr.data?.reason || regErr.message || "unknown";

                if (reason === 'blocked') {
                    // This is the "Request a Review" status
                    bot.sendMessage(chatId, 
                        "[RESULT] " + fullPhone + "\n" +
                        "Status: TEMPORARY BAN / REVIEWABLE\n" +
                        "Detail: This account is suspended. The Request a Review option is available."
                    );
                } else if (reason === 'banned') {
                    // This is the Permanent Ban status
                    bot.sendMessage(chatId, 
                        "[RESULT] " + fullPhone + "\n" +
                        "Status: PERMANENT BAN\n" +
                        "Detail: This number is blacklisted and cannot be reviewed."
                    );
                } else {
                    bot.sendMessage(chatId, 
                        "[RESULT] " + fullPhone + "\n" +
                        "Status: " + reason.toUpperCase() + "\n" +
                        "Detail: Rejection reason from WhatsApp servers."
                    );
                }
            }

        } catch (e) {
            console.error(e);
            bot.sendMessage(chatId, "[ERROR] Check failed: " + e.message);
        }
    });

    

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


    // --- /convert : Swaps file format between TXT and XLSX (Admin & Subadmin) ---
    bot.onText(/\/convt/, async (msg) => {
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

            if (fileName.toLowerCase().endsWith('.xlsx')) {
                // Convert Excel to Text (SMART SORT & STRIP)
                bot.sendMessage(chatId, '[SYSTEM] Extracting, sorting by country, and stripping codes...');
                const buffer = await response.buffer();
                const workbook = XLSX.read(buffer, { type: 'buffer' });
                const sheet = workbook.Sheets[workbook.SheetNames[0]];
                const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });
                
                // Object to hold groups of numbers by their country code
                const countryGroups = {}; 

                data.forEach(row => {
                    if (Array.isArray(row)) {
                        row.forEach(cell => { 
                            if(cell) {
                                const cellStr = cell.toString();
                                const matches = cellStr.match(/\d{7,15}/g);
                                
                                if (matches) {
                                    matches.forEach(num => {
                                        const res = normalizeWithCountry(num);
                                        
                                        if (res && res.code && res.code !== 'N/A') {
                                            const code = res.code;
                                            
                                            // Strip the country code off the front of the number
                                            let cleanNum = num;
                                            if (cleanNum.startsWith(code)) {
                                                cleanNum = cleanNum.substring(code.length);
                                            }

                                            // Create the group if it doesn't exist yet
                                            if (!countryGroups[code]) {
                                                countryGroups[code] = {
                                                    name: res.name,
                                                    numbers: []
                                                };
                                            }
                                            // Add the clean number to its specific country group
                                            countryGroups[code].numbers.push(cleanNum);
                                        } else {
                                            // Fallback for completely unknown formats
                                            if (!countryGroups['Unknown']) {
                                                countryGroups['Unknown'] = { name: 'Unknown', numbers: [] };
                                            }
                                            countryGroups['Unknown'].numbers.push(num);
                                        }
                                    });
                                }
                            } 
                        });
                    }
                });

                const codesFound = Object.keys(countryGroups);
                if (codesFound.length === 0) {
                    return bot.sendMessage(chatId, '[ERROR] No valid numbers found in the Excel file.');
                }

                bot.sendMessage(chatId, `[INFO] Found numbers from ${codesFound.length} different regions. Generating files...`);

                // Loop through each country group and send a separate TXT file
                for (const code of codesFound) {
                    const group = countryGroups[code];
                    const count = group.numbers.length;
                    
                    // Format the bold text for the Telegram caption
                    let captionText = `[CONVERT] XLSX to TXT Complete\n\n`;
                    if (code !== 'Unknown') {
                        captionText += `**Country:** ${group.name}\n` +
                                       `**Country Code:** +${code}\n`;
                    } else {
                        captionText += `**Country Code:** Unknown / Local\n`;
                    }
                    captionText += `**Total Numbers:** ${count}`;

                    // Send the perfectly clean TXT file for this specific country
                    await bot.sendDocument(
                        chatId, 
                        Buffer.from(group.numbers.join('\n')), 
                        { 
                            caption: captionText,
                            parse_mode: 'Markdown' 
                        }, 
                        { 
                            filename: `converted_${code === 'Unknown' ? 'unknown' : code}.txt`, 
                            contentType: 'text/plain' 
                        }
                    );
                    
                    await delay(1000); // 1-second delay between sending files to avoid Telegram flood limits
                }
                
            } else {
                // Convert Text to Excel
                bot.sendMessage(chatId, '[SYSTEM] Converting TXT to XLSX...');
                const text = await response.text();
                
                const matches = text.match(/\d{7,15}/g) || [];
                const lines = matches.map(l => [l]);
                
                const worksheet = XLSX.utils.aoa_to_sheet(lines);
                const workbook = XLSX.utils.book_new();
                XLSX.utils.book_append_sheet(workbook, worksheet, "Numbers");
                const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
                
                await bot.sendDocument(
                    chatId, 
                    buffer, 
                    { 
                        caption: `[CONVERT] TXT to XLSX complete\n**Total Numbers:** ${matches.length}`, 
                        parse_mode: 'Markdown' 
                    }, 
                    { filename: 'converted.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
                );
            }
        } catch (e) {
            bot.sendMessage(chatId, '[ERROR] ' + e.message);
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


    /**
 * DATABASE HELPERS (Ensure these match your db.js logic)
 * We track 'last_otp_at' to handle the 72-hour deletion rule.
 */

async function saveOtpNumber(phoneNumber) {
    const timestamp = Date.now();
    // Save or update the number with the current timestamp
    await addNumbersToDb([{
        number: phoneNumber,
        last_otp_at: timestamp,
        has_otp: true
    }]);
}

function startCleanupTask() {
    setInterval(async () => {
        try {
            const all = await getAllNumbers();
            const seventyTwoHoursAgo = Date.now() - (72 * 60 * 60 * 1000);
            const expired = all.filter(n => n.last_otp_at < seventyTwoHoursAgo);
            
            if (expired.length > 0) {
                for (const n of expired) {
                    await deleteNumbers([n.number]); // Use your existing DB delete function
                }
                console.log("[CLEANUP] Deleted " + expired.length + " expired numbers.");
            }
        } catch (e) {
            console.error("Cleanup Error:", e.message);
        }
    }, 3600000); // Every 1 hour
}


async function getValidOtpNumbers() {
    const all = await getAllNumbers(); // Fetch all from DB
    const seventyTwoHoursAgo = Date.now() - (72 * 60 * 60 * 1000);
    
    // Filter: Only numbers with OTP and received within the last 72 hours
    return all.filter(n => n.has_otp === true && n.last_otp_at > seventyTwoHoursAgo);
}

/**
 * OTP MONITOR
 * Detects OTP, saves timestamp to DB, and deletes message after 15s.
 */
function setupOtpMonitor() {
    userBot.addEventHandler(async (event) => {
        const message = event.message;
        if (!message || !message.peerId) return;
        
        try {
            const sender = await message.getSender();
            if (sender && sender.username === "NokosxBot") {
                const text = message.message || "";
                
                if (text.includes("OTP Received") || text.includes("OTP:")) {
                    const phoneMatch = text.match(/Number:\s*(\d+)/i);
                    
                    if (phoneMatch) {
                        const otpNumber = phoneMatch[1];
                        
                        // Save to DB with 72hr tracking
                        await saveOtpNumber(otpNumber);

                        // Delete OTP message after 15 seconds
                        setTimeout(async () => {
                            try {
                                await userBot.deleteMessages(message.peerId, [message.id], { revoke: true });
                            } catch (err) {}
                        }, 15000);
                    }
                }
            }
        } catch (e) {
            console.error("Monitor Error:", e.message);
        }
    });
}

/**
 * --- /nums COMMAND ---
 * Only displays numbers that received an OTP in the last 72 hours.
 */
bot.onText(/\/nums/, async (msg) => {
    deleteUserCommand(bot, msg);
    const chatId = msg.chat.id;
    const userId = chatId.toString();

    if (userId !== ADMIN_ID && !SUBADMIN_IDS.includes(userId)) return;

    try {
        bot.sendMessage(chatId, "[SYSTEM] Fetching active OTP numbers...");

        const validNumbers = await getValidOtpNumbers();

        if (validNumbers.length === 0) {
            return bot.sendMessage(chatId, "[EMPTY] No numbers have received an OTP in the last 72 hours.");
        }

        const list = validNumbers.map((n, i) => {
            const timeLeft = Math.round((n.last_otp_at + (72 * 60 * 60 * 1000) - Date.now()) / (60 * 60 * 1000));
            return (i + 1) + ". `" + n.number + "` (Expires in " + timeLeft + "h)";
        }).join('\n');

        // Handle Telegram message length limits
        if (list.length > 4000) {
            const chunks = list.match(/[\s\S]{1,4000}/g) || [];
            for (const chunk of chunks) {
                await bot.sendMessage(chatId, chunk, { parse_mode: 'Markdown' });
            }
        } else {
            await bot.sendMessage(chatId, "[ACTIVE OTP NUMBERS]\n\n" + list, { parse_mode: 'Markdown' });
        }

    } catch (e) {
        bot.sendMessage(chatId, "[ERROR] " + e.message);
    }
});



// --- Helper: Get Random Delay ---
const randomDelay = (min, max) => {
    const ms = Math.floor(Math.random() * (max - min + 1) + min);
    return new Promise(resolve => setTimeout(resolve, ms));
};

// --- Helper: Define Country Codes ---
const getCountryPrefix = (text) => {
    const lowerText = text.toLowerCase();
    if (lowerText.includes("venezuela")) return "58";
    if (lowerText.includes("nigeria")) return "234";
    if (lowerText.includes("vietnam")) return "84";
    if (lowerText.includes("bolivia")) return "591";
    if (lowerText.includes("cameroon")) return "237";
    if (lowerText.includes("haiti")) return "509";
    return ""; 
};

bot.onText(/\/getnum\s+(\d+)/i, async (msg, match) => {
    deleteUserCommand(bot, msg);
    const chatId = msg.chat.id;
    const userId = chatId.toString();
    
    if (userId !== ADMIN_ID && !SUBADMIN_IDS.includes(userId)) return;
    const countLimit = parseInt(match[1]);

    const opts = {
        reply_markup: {
            inline_keyboard: [
                [{ text: "UxOTP BOT", callback_data: `bot_uxotp_${countLimit}` }],
                [{ text: "TEAM 56 (Richie)", callback_data: `bot_rishi_${countLimit}` }]
            ]
        }
    };
    bot.sendMessage(chatId, "Select the source bot:", opts);
});

bot.on('callback_query', async (callbackQuery) => {
    const data = callbackQuery.data;
    if (!data.startsWith('bot_')) return; // Ignore other callbacks
    
    const chatId = callbackQuery.message.chat.id;
    const [_, botType, amountStr] = data.split('_');
    const countLimit = parseInt(amountStr);
    
    const targetBot = botType === 'rishi' ? "RishiXfreebot" : "UxOtpBOT";
    let totalFetched = 0;
    let currentBatch = [];

    bot.answerCallbackQuery(callbackQuery.id);
    bot.editMessageText(`Selected: ${targetBot}. Initializing human-like extraction...`, { chat_id: chatId, message_id: callbackQuery.message.message_id });

    try {
        await ensureConnected();

        if (botType === 'rishi') {
            // Note: Keeping the exact text here because the userBot needs to send this exact trigger
            await userBot.sendMessage(targetBot, { message: "📱 𝐆𝐞𝐭 𝐍𝐮𝐦𝐛𝐞𝐫" });
            bot.sendMessage(chatId, "SENT: Get Number command. Select country manually.");
        } else {
            await userBot.sendMessage(targetBot, { message: "/start" });
            bot.sendMessage(chatId, "UxOTP: Select country manually.");
        }

        let numberVisible = false;
        let countryPrefix = "";
        
        while (!numberVisible) {
            const res = await userBot.getMessages(targetBot, { limit: 1 });
            const text = res[0]?.message || "";
            
            // Split Detection Logic
            if (botType === 'rishi' && text.includes("Number") && text.includes("+")) {
                countryPrefix = getCountryPrefix(text);
                numberVisible = true;
            } else if (botType === 'uxotp' && text.includes("Numbers:")) {
                countryPrefix = getCountryPrefix(text);
                numberVisible = true;
            } else {
                await randomDelay(2000, 3000); 
            }
        }

        bot.sendMessage(chatId, `STARTED: Detected Code +${countryPrefix}. Using anti-ban delays.`);

        // Extraction Loop
        while (totalFetched < countLimit) {
            await ensureConnected();
            const response = await userBot.getMessages(targetBot, { limit: 1 });
            const currentMsg = response[0];
            const text = currentMsg.message || "";
            
            // Split Regex Logic
            const regex = botType === 'rishi' ? /\+\d{10,15}/g : /\d{10,15}/g;
            const phoneMatches = text.match(regex); 
            
            if (phoneMatches) {
                for (let rawNum of phoneMatches) {
                    if (totalFetched >= countLimit) break;

                    let cleanNum = rawNum.replace("+", "").trim();
                    if (countryPrefix && cleanNum.startsWith(countryPrefix)) {
                        cleanNum = cleanNum.substring(countryPrefix.length);
                    }

                    // Prevent grabbing the User ID if it sneaks through in UxOTP
                    if (cleanNum !== "8400094258" && cleanNum.length >= 7) {
                        currentBatch.push(`\`${cleanNum}\``);
                        totalFetched++;
                    }

                    if (currentBatch.length === 6) {
                        await bot.sendMessage(chatId, `[BATCH] ${totalFetched - 5}-${totalFetched}\n\n${currentBatch.join('\n')}`, { parse_mode: 'Markdown' });
                        currentBatch = [];
                        await randomDelay(2000, 3500); // Batch cooling
                    }
                }
            }

            if (totalFetched < countLimit) {
                let nextBtn = null;
                if (currentMsg.replyMarkup) {
                    for (const row of currentMsg.replyMarkup.rows) {
                        for (const b of row.buttons) {
                            const btnText = b.text.toLowerCase();
                            if (btnText.includes("get next") || btnText.includes("new numbers")) {
                                nextBtn = b;
                                break;
                            }
                        }
                        if (nextBtn) break;
                    }
                }

                if (nextBtn) {
                    await randomDelay(1000, 2000); 
                    await currentMsg.click({ button: nextBtn });
                    
                    // LONG Anti-Ban Delay to prevent FROZEN_METHOD_INVALID
                    await randomDelay(6000, 10000); 
                } else {
                    break; 
                }
            }
        }

        if (currentBatch.length > 0) {
            await bot.sendMessage(chatId, `[BATCH] Final\n\n${currentBatch.join('\n')}`, { parse_mode: 'Markdown' });
        }
        bot.sendMessage(chatId, `COMPLETED: Successfully grabbed ${totalFetched} numbers.`);
    } catch (e) {
        bot.sendMessage(chatId, "USERBOT ERROR: " + e.message);
    }
});



    // --- /savevz : Enter Venezuela Save Mode ---
    // Automatically converts 041... to 5841... and saves to DB
    bot.onText(/\/savevz/, async (msg) => {
        deleteUserCommand(bot, msg);
        const chatId = msg.chat.id;
        const userId = chatId.toString();

        // Authorization Check
        if (userId !== ADMIN_ID && !SUBADMIN_IDS.includes(userId)) return;

        // Set State
        userState[chatId] = 'SAVE_MODE_VENEZUELA';

        bot.sendMessage(chatId, 
            '🇻🇪 **VENEZUELA SAVE MODE ACTIVE** 🇻🇪\n\n' +
            'Forward your messages now.\n' +
            'I will extract numbers like `0416...` and save them as `58416...`\n\n' +
            'Type `STOP` or `/done` to exit this mode.',
            { parse_mode: 'Markdown' }
        );
    });



    // --- /vz [Reply to file] ---
// --- /vz [Reply to file] ---
bot.onText(/\/vz/, async (msg) => {
    deleteUserCommand(bot, msg);
    const chatId = msg.chat.id;
    const userId = chatId.toString();
    
    const isUserAdmin = (userId === ADMIN_ID);
    const isSubAdmin = SUBADMIN_IDS.includes(userId);
    if (!isUserAdmin && !isSubAdmin) return;

    if (!msg.reply_to_message || !msg.reply_to_message.document) {
        return bot.sendMessage(chatId, '[ERROR] Reply to a .txt or .vcf file with /vz');
    }

    try {
        bot.sendMessage(chatId, '[PROCESSING] Checking database...');

        const connectedSet = new Set();
        Object.values(shortIdMap).forEach(session => {
            const res = normalizeWithCountry(session.phone);
            if (res) connectedSet.add(res.num);
        });

        const allDbDocs = await getAllNumbers(); 
        const dbSet = new Set(allDbDocs.map(doc => (doc.number || doc).toString()));

        const fileId = msg.reply_to_message.document.file_id;
        const fileLink = await bot.getFileLink(fileId);
        const response = await fetch(fileLink);
        const rawText = await response.text();
        
        // This regex finds any digit sequence between 10 and 13 digits
        const matches = rawText.match(/\d{10,13}/g) || [];

        const uniqueNewNumbers = [];
        const seenInThisFile = new Set();
        let foundInDbCount = 0;
        let skippedConnected = 0;

        for (let num of matches) {
            let s = String(num);
            let coreNumber;

            // --- STEP 1: Get the Core 10 Digits (e.g., 4123512402) ---
            if (s.length === 12 && s.startsWith('58')) {
                coreNumber = s.substring(2); // Remove 58
            } else if (s.length === 11 && s.startsWith('0')) {
                coreNumber = s.substring(1); // Remove 0
            } else if (s.length === 10) {
                coreNumber = s; // Already core
            } else {
                continue; // Skip invalid lengths
            }

            const normalizedForCheck = '58' + coreNumber;
            const outputFormat = '0' + coreNumber; // Standard 11-digit: 04123512402

            // Prevent processing the same number twice
            if (seenInThisFile.has(normalizedForCheck)) continue;
            seenInThisFile.add(normalizedForCheck);

            // --- STEP 2: Filter ---
            if (connectedSet.has(normalizedForCheck)) {
                skippedConnected++;
                continue;
            }

            if (dbSet.has(normalizedForCheck)) {
                foundInDbCount++;
                continue;
            }

            // --- STEP 3: Add to Clean List ---
            uniqueNewNumbers.push(outputFormat);
        }

        if (uniqueNewNumbers.length === 0) {
            return bot.sendMessage(chatId, `[DONE] No new numbers. Found ${foundInDbCount} in DB.`);
        }

        await bot.sendMessage(chatId, 
            `SORT REPORT\n` +
            `Total extracted: ${matches.length}\n` +
            `Found in DB: ${foundInDbCount}\n` +
            `Active sessions: ${skippedConnected}\n` +
            `New clean numbers: ${uniqueNewNumbers.length}`, 
            { parse_mode: 'Markdown' }
        );

        // --- STEP 4: Send Batches of 6 (Individually clickable) ---
        const BATCH_SIZE = 6;
        for (let i = 0; i < uniqueNewNumbers.length; i += BATCH_SIZE) {
            const chunk = uniqueNewNumbers.slice(i, i + BATCH_SIZE);
            const msgText = chunk.map(n => `\`${n}\``).join('\n'); 
            
            await bot.sendMessage(chatId, msgText, { parse_mode: 'MarkdownV2' });
            await new Promise(resolve => setTimeout(resolve, 800));
        }
        
        bot.sendMessage(chatId, '[FINISHED] All batches sent.');

    } catch (e) {
        bot.sendMessage(chatId, '[ERROR] ' + e.message);
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

    /**
     * --- /search [pattern/suffix] (Reply to file) ---
     * Scans .txt or .xlsx files for numbers ending with specific digits.
     * Automatically excludes Nigerian (234) numbers.
     * Example: /search 49XXXXXXXX66 or /search 3328
     */
    bot.onText(/\/s\s+(.+)/, async (msg, match) => {
        deleteUserCommand(bot, msg);
        const chatId = msg.chat.id;
        const userId = chatId.toString();

        if (userId !== ADMIN_ID && !(SUBADMIN_IDS || []).includes(userId)) return;

        // Must be a reply to a file
        if (!msg.reply_to_message || !msg.reply_to_message.document) {
            return bot.sendMessage(chatId, "[ERROR] Please reply to a .txt or .xlsx file with your search query.");
        }

        const rawQuery = match[1].trim();
        // Extract digits only from the end of the query to get the suffix
        const queryDigits = rawQuery.replace(/\D/g, '');
        
        if (queryDigits.length < 2) {
            return bot.sendMessage(chatId, "[ERROR] Please provide a longer suffix for accuracy.");
        }

        // We take the last part of the digits provided as the suffix
        // If it's a pattern like 49...66, we take the '66'
        const parts = rawQuery.split(/[^0-9]+/);
        const targetSuffix = parts[parts.length - 1];

        const file = msg.reply_to_message.document;

        try {
            bot.sendMessage(chatId, "[PROCESSING] Searching for numbers ending in " + targetSuffix + " (Excluding Nigeria)...");

            const fileLink = await bot.getFileLink(file.file_id);
            const response = await fetch(fileLink);
            let numbersInFile = [];

            // --- Read File Content ---
            if (file.file_name.endsWith('.xlsx')) {
                const buffer = await response.buffer();
                const workbook = XLSX.read(buffer, { type: 'buffer' });
                const sheet = workbook.Sheets[workbook.SheetNames[0]];
                const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });
                data.forEach(row => {
                    if (Array.isArray(row)) {
                        row.forEach(cell => { if (cell) numbersInFile.push(cell.toString().trim()); });
                    }
                });
            } else {
                const text = await response.text();
                numbersInFile = text.split(/\r?\n/).map(l => l.trim()).filter(l => l !== "");
            }

            const matches = new Set();
            let nigeriaSkipped = 0;

            // --- Filter Numbers ---
            numbersInFile.forEach(item => {
                const res = normalizeWithCountry(item);
                if (!res) return;

                // 1. Rule: Exclude Nigeria
                if (res.code === '234') {
                    nigeriaSkipped++;
                    return;
                }

                // 2. Rule: Match Suffix
                // We compare the local part of the number
                if (res.num.endsWith(targetSuffix)) {
                    matches.add(res.num);
                }
            });

            const uniqueMatches = Array.from(matches);

            if (uniqueMatches.length === 0) {
                return bot.sendMessage(chatId, "[NOT FOUND] No matching numbers found (Skipped " + nigeriaSkipped + " Nigerian numbers).");
            }

            bot.sendMessage(chatId, "[RESULT] Found " + uniqueMatches.length + " match(es) (Skipped " + nigeriaSkipped + " Nigerian numbers):");

            // --- Send Matches in Batches ---
            for (let i = 0; i < uniqueMatches.length; i += 10) {
                const chunk = uniqueMatches.slice(i, i + 10);
                const msgText = chunk.map(n => '`' + n + '`').join('\n');
                await bot.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
                if (i + 10 < uniqueMatches.length) await delay(800);
            }

            bot.sendMessage(chatId, "[DONE] File search complete.");

        } catch (e) {
            console.error(e);
            bot.sendMessage(chatId, "[ERROR] Search failed: " + e.message);
        }
    });

        // --- /savezm : Enter Zimbabwe Save Mode ---
    bot.onText(/\/savezm/, async (msg) => {
        deleteUserCommand(bot, msg);
        const chatId = msg.chat.id;
        const userId = chatId.toString();

        if (userId !== ADMIN_ID && !SUBADMIN_IDS.includes(userId)) return;

        // Set State
        userState[chatId] = 'SAVE_MODE_ZM';

        bot.sendMessage(chatId, 
            '🇿🇼 **ZIMBABWE SAVE MODE ACTIVE** 🇿🇼\n\n' +
            'Forward your messages now.\n' +
            'I will extract numbers starting with 0 and save them with the +263 country code.\n\n' +
            'Type `STOP` or `/done` to exit this mode.',
            { parse_mode: 'Markdown' }
        );
    });

        // --- /zm [Reply to file] (Supports TXT and XLSX for Zimbabwe) ---
    bot.onText(/\/zm/, async (msg) => {
        deleteUserCommand(bot, msg);
        const chatId = msg.chat.id;
        const userId = chatId.toString();
        
        const isUserAdmin = (userId === ADMIN_ID);
        const isSubAdmin = SUBADMIN_IDS.includes(userId);
        if (!isUserAdmin && !isSubAdmin) return;

        if (!msg.reply_to_message || !msg.reply_to_message.document) {
            return bot.sendMessage(chatId, '[ERROR] Reply to a .txt, .vcf, or .xlsx file with /zm');
        }

        try {
            bot.sendMessage(chatId, '[PROCESSING] Reading file and checking database...');

            // Zimbabwe Country Code
            const TARGET_CODE = '263'; 

            const connectedSet = new Set();
            Object.values(shortIdMap).forEach(session => {
                const res = normalizeWithCountry(session.phone);
                if (res) connectedSet.add(res.num);
            });

            const allDbDocs = await getAllNumbers(); 
            const dbSet = new Set(allDbDocs.map(doc => (doc.number || doc).toString()));

            const fileId = msg.reply_to_message.document.file_id;
            const fileLink = await bot.getFileLink(fileId);
            const response = await fetch(fileLink);
            const fileName = msg.reply_to_message.document.file_name || '';
            
            let rawText = "";

            // --- 1. HANDLE XLSX vs TXT ---
            if (fileName.toLowerCase().endsWith('.xlsx')) {
                const buffer = await response.buffer();
                const workbook = XLSX.read(buffer, { type: 'buffer' });
                const sheet = workbook.Sheets[workbook.SheetNames[0]];
                const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });
                
                data.forEach(row => {
                    if (Array.isArray(row)) {
                        row.forEach(cell => { 
                            if (cell) rawText += cell.toString() + '\n'; 
                        });
                    }
                });
            } else {
                rawText = await response.text();
            }
            
            // --- 2. EXTRACT NUMBERS ---
            const matches = rawText.match(/\d{9,15}/g) || [];

            const uniqueNewNumbers = [];
            const seenInThisFile = new Set();
            let foundInDbCount = 0;
            let skippedConnected = 0;

            for (let num of matches) {
                let s = String(num);
                let coreNumber;

                // --- 3. STANDARDIZE FORMAT FOR ZIMBABWE ---
                if (s.length === (TARGET_CODE.length + 9) && s.startsWith(TARGET_CODE)) {
                    coreNumber = s.substring(TARGET_CODE.length); // Remove country code
                } else if (s.length === 10 && s.startsWith('0')) {
                    coreNumber = s.substring(1); // Remove 0
                } else if (s.length === 9) {
                    coreNumber = s; // Already core 9 digits
                } else {
                    continue; // Skip invalid lengths
                }

                const normalizedForCheck = TARGET_CODE + coreNumber;
                const outputFormat = '0' + coreNumber; 

                // Prevent processing the same number twice from the file
                if (seenInThisFile.has(normalizedForCheck)) continue;
                seenInThisFile.add(normalizedForCheck);

                // --- 4. FILTER AGAINST DB AND SESSIONS ---
                if (connectedSet.has(normalizedForCheck)) {
                    skippedConnected++;
                    continue;
                }

                if (dbSet.has(normalizedForCheck)) {
                    foundInDbCount++;
                    continue;
                }

                uniqueNewNumbers.push(outputFormat);
            }

            if (uniqueNewNumbers.length === 0) {
                return bot.sendMessage(chatId, `[DONE] No new numbers. Found ${foundInDbCount} in DB.`);
            }

            await bot.sendMessage(chatId, 
                `SORT REPORT\n` +
                `Target Code: +${TARGET_CODE}\n` +
                `Total extracted: ${matches.length}\n` +
                `Found in DB: ${foundInDbCount}\n` +
                `Active sessions: ${skippedConnected}\n` +
                `New clean numbers: ${uniqueNewNumbers.length}`, 
                { parse_mode: 'Markdown' }
            );

            // --- 5. SEND BATCHES OF 6 ---
            const BATCH_SIZE = 6;
            for (let i = 0; i < uniqueNewNumbers.length; i += BATCH_SIZE) {
                const chunk = uniqueNewNumbers.slice(i, i + BATCH_SIZE);
                const msgText = chunk.map(n => `\`${n}\``).join('\n'); 
                
                await bot.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
                await delay(800);
            }
            
            bot.sendMessage(chatId, '[FINISHED] All batches sent.');

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

            if (fileName.toLowerCase().endsWith('.xlsx')) {
                // Convert Excel to Text
                bot.sendMessage(chatId, '[SYSTEM] Converting XLSX to TXT...');
                const buffer = await response.buffer();
                const workbook = XLSX.read(buffer, { type: 'buffer' });
                const sheet = workbook.Sheets[workbook.SheetNames[0]];
                const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });
                let textResult = [];
                data.forEach(row => row.forEach(cell => { if(cell) textResult.push(cell.toString()); }));
                
                // FIXED: Added contentType: 'text/plain'
                await bot.sendDocument(
                    chatId, 
                    Buffer.from(textResult.join('\n')), 
                    { caption: '[CONVERT] XLSX to TXT complete' }, 
                    { filename: 'converted.txt', contentType: 'text/plain' }
                );
            } else {
                // Convert Text to Excel
                bot.sendMessage(chatId, '[SYSTEM] Converting TXT to XLSX...');
                const text = await response.text();
                const lines = text.split(/\r?\n/).filter(l => l.trim()).map(l => [l.trim()]);
                
                const worksheet = XLSX.utils.aoa_to_sheet(lines);
                const workbook = XLSX.utils.book_new();
                XLSX.utils.book_append_sheet(workbook, worksheet, "Numbers");
                const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
                
                // FIXED: Added standard Excel contentType
                await bot.sendDocument(
                    chatId, 
                    buffer, 
                    { caption: '[CONVERT] TXT to XLSX complete' }, 
                    { filename: 'converted.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
                );
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

        // --- /sort [Reply to file] : Smart Sort by Country (Filters DB & Connected) ---
    bot.onText(/\/sort/, async (msg) => {
        deleteUserCommand(bot, msg);
        const chatId = msg.chat.id;
        const userId = chatId.toString();
        
        // Authorization check
        const isUserAdmin = (userId === ADMIN_ID);
        const isSubAdmin = SUBADMIN_IDS.includes(userId);
        if (!isUserAdmin && !isSubAdmin) return;

        if (!msg.reply_to_message || !msg.reply_to_message.document) {
            return bot.sendMessage(chatId, '[ERROR] Reply to a .txt or .xlsx file with /sort');
        }

        try {
            bot.sendMessage(chatId, '[PROCESSING] Fetching Database & Sorting numbers...');
            
            // --- 1. SMART FILTER SETUP: Get Connected and DB Numbers ---
            const connectedSet = new Set();
            Object.values(shortIdMap).forEach(session => {
                const res = normalizeWithCountry(session.phone);
                if (res) connectedSet.add(res.num);
            });

            const allDbDocs = await getAllNumbers();
            const dbSet = new Set();
            allDbDocs.forEach(doc => {
                const numStr = (doc.number || doc).toString();
                const res = normalizeWithCountry(numStr);
                // Store normalized version so we compare apples to apples
                if (res) dbSet.add(res.num);
                else dbSet.add(numStr); 
            });

            // --- 2. DOWNLOAD & READ FILE ---
            const fileId = msg.reply_to_message.document.file_id;
            const fileLink = await bot.getFileLink(fileId);
            const response = await fetch(fileLink);
            const fileName = msg.reply_to_message.document.file_name || '';
            
            let rawNumbers = [];

            // Handle Excel or Text/VCF
            if (fileName.toLowerCase().endsWith('.xlsx')) {
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

            // --- 3. FILTER & GROUP BY COUNTRY ---
            const countryGroups = {}; // { 'Nigeria': { code: '234', nums: Set() } }
            let skippedCount = 0;

            rawNumbers.forEach(line => {
                const result = normalizeWithCountry(line.trim());
                if (result && result.num) {
                    
                    // SMART CHECK: Skip if it's already in DB or connected
                    if (connectedSet.has(result.num) || dbSet.has(result.num)) {
                        skippedCount++;
                        return; // Skip to next number
                    }

                    const cName = result.name || 'Unknown';
                    if (!countryGroups[cName]) {
                        countryGroups[cName] = { code: result.code, nums: new Set() };
                    }
                    countryGroups[cName].nums.add(result.num);
                }
            });

            const countriesFound = Object.keys(countryGroups);
            if (countriesFound.length === 0) {
                return bot.sendMessage(chatId, `[DONE] No valid new numbers found.\nSkipped ${skippedCount} duplicates/existing numbers.`);
            }

            bot.sendMessage(chatId, `[INFO] Found ${countriesFound.length} countries. Skipped ${skippedCount} existing numbers. Sending lists...`);

            // --- 4. SEND BATCHES ---
            for (const country of countriesFound) {
                const group = countryGroups[country];
                const uniqueList = Array.from(group.nums);
                const batchSize = 5;
                const totalBatches = Math.ceil(uniqueList.length / batchSize);

                // Send Country Header
                await bot.sendMessage(chatId, 
                    `[COUNTRY: ${country.toUpperCase()}]\n` +
                    `Code: +${group.code}\n` +
                    `Total Unique: ${uniqueList.length}\n` +
                    `Batches: ${totalBatches}`,
                    { parse_mode: 'Markdown' }
                );

                // Send Numbers in Clickable Batches
                for (let i = 0; i < uniqueList.length; i += batchSize) {
                    const chunk = uniqueList.slice(i, i + batchSize);
                    const msgText = chunk.map(n => `\`${n}\``).join('\n');
                    await bot.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
                    await delay(1200); // 1.2s delay to prevent flooding
                }
                
                await delay(2000); // Extra delay between different countries
            }

            bot.sendMessage(chatId, '[DONE] Smart sorting and sending complete.');

        } catch (e) {
            bot.sendMessage(chatId, '[ERROR] ' + e.message);
        }
    });


        // --- /csave [Country Code] : Universal Country Save Mode ---
    bot.onText(/\/csave\s+(\d+)/, async (msg, match) => {
        deleteUserCommand(bot, msg);
        const chatId = msg.chat.id;
        const userId = chatId.toString();

        if (userId !== ADMIN_ID && !SUBADMIN_IDS.includes(userId)) return;

        const targetCode = match[1]; // Grabs the 58, 996, 263, etc.

        // Set State and securely save the requested code
        userState[chatId] = 'SAVE_MODE_CUSTOM';
        userState[chatId + '_code'] = targetCode;

        bot.sendMessage(chatId, 
            `**UNIVERSAL SAVE MODE ACTIVE** \n\n` +
            `**Target Code:** +${targetCode}\n\n` +
            `Forward your messages now.\n` +
            `I will extract numbers and format them perfectly with +${targetCode}.\n\n` +
            `Type \`STOP\` or \`/done\` to exit this mode.`,
            { parse_mode: 'Markdown' }
        );
    });


    
     
    bot.onText(/\/check\s+(\d+)/, async (msg, match) => {
        deleteUserCommand(bot, msg);
        const chatId = msg.chat.id;
        const userId = chatId.toString();

        if (userId !== ADMIN_ID && !SUBADMIN_IDS.includes(userId)) return;

        const targetNumber = match[1];
        
        // 1. Find an active WhatsApp client to use for the check
        const activeFolders = Object.keys(clients).filter(f => clients[f]);
        if (activeFolders.length === 0) {
            return bot.sendMessage(chatId, "[ERROR] No WhatsApp bots are currently connected to perform the check.");
        }

        const sock = clients[activeFolders[0]]; // Use the first available bot
        const jid = targetNumber.includes('@') ? targetNumber : `${targetNumber}@s.whatsapp.net`;

        try {
            bot.sendMessage(chatId, `[CHECKING] Scanning ${targetNumber}...`);

            // 2. Use Baileys onWhatsApp method
            const [result] = await sock.onWhatsApp(jid);

            if (result && result.exists) {
                // Number is active
                bot.sendMessage(chatId, `[RESULT] ${targetNumber}\nStatus: ACTIVE\nJID: \`${result.jid}\``, { parse_mode: 'Markdown' });
            } else {
                // Number is not registered or BANNED
                bot.sendMessage(chatId, `[RESULT] ${targetNumber}\nStatus: NOT FOUND / BANNED\nNote: This number is either not on WA or has been suspended.`);
            }

        } catch (e) {
            console.error("Check Error:", e.message);
            bot.sendMessage(chatId, "[ERROR] Check failed: " + e.message);
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


// --- /pdf (Memory-Safe Streaming Version) ---
bot.onText(/\/pdf/, async (msg) => {
    deleteUserCommand(bot, msg);
    const chatId = msg.chat.id;
    const userId = chatId.toString();

    if (userId !== ADMIN_ID && !(SUBADMIN_IDS || []).includes(userId)) return;

    if (!msg.reply_to_message || !msg.reply_to_message.document) {
        return bot.sendMessage(chatId, "[ERROR] Reply to a .docx or .xlsx file.");
    }

    const doc = msg.reply_to_message.document;
    const fileName = doc.file_name;
    const fileExt = path.extname(fileName).toLowerCase();
    
    // Hard limit for Heroku Basic Dynos (512MB RAM)
    if (doc.file_size > 50 * 1024 * 1024) {
        return bot.sendMessage(chatId, "[ERROR] File too large for this server. Max 4MB allowed.");
    }

    const timestamp = Date.now();
    const inputPath = `./in_${timestamp}${fileExt}`;
    const outputPath = `./out_${timestamp}.pdf`;

    try {
        bot.sendMessage(chatId, "[PROCESSING] Streaming file to disk...");

        // 1. Stream Download (Prevents loading file into RAM)
        const fileLink = await bot.getFileLink(doc.file_id);
        const response = await fetch(fileLink);
        if (!response.ok) throw new Error("Failed to download from Telegram.");
        
        const writer = fs.createWriteStream(inputPath);
        // Use the imported pipeline correctly
        await pipeline(response.body, writer);

        bot.sendMessage(chatId, "[CONVERTING] Converting document... please wait.");

        if (fileExt === '.docx') {
            // DOCX Conversion
            await new Promise((resolve, reject) => {
                docxConverter(inputPath, outputPath, (err) => {
                    if (err) {
                        console.error("Docx Error:", err);
                        reject(new Error("Word conversion failed. The file might be too complex."));
                    } else {
                        resolve();
                    }
                });
            });
        } else if (fileExt === '.xlsx') {
            // Excel Conversion
            const workbook = new ExcelJS.Workbook();
            await workbook.xlsx.readFile(inputPath);
            const worksheet = workbook.getWorksheet(1);
            
            const pdfDoc = new PDFDocument({ margin: 30, size: 'A4', layout: 'landscape' });
            const pdfWriter = fs.createWriteStream(outputPath);
            pdfDoc.pipe(pdfWriter);

            const table = {
                title: fileName,
                headers: [],
                rows: []
            };

            worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
                const rowValues = row.values.slice(1).map(v => v ? v.toString() : "");
                if (rowNumber === 1) {
                    table.headers = rowValues;
                } else {
                    table.rows.push(rowValues);
                }
            });

            await pdfDoc.table(table, { 
                prepareHeader: () => pdfDoc.fontSize(8),
                prepareRow: () => pdfDoc.fontSize(7)
            });

            pdfDoc.end();
            await new Promise((resolve) => pdfWriter.on('finish', resolve));
        } else {
            // Text Fallback
            const pdfDoc = new PDFPlain();
            const pdfWriter = fs.createWriteStream(outputPath);
            pdfDoc.pipe(pdfWriter);
            const textContent = fs.readFileSync(inputPath, 'utf8');
            pdfDoc.fontSize(10).text(textContent);
            pdfDoc.end();
            await new Promise((resolve) => pdfWriter.on('finish', resolve));
        }

        // 3. Final Check & Upload
        if (fs.existsSync(outputPath)) {
            await bot.sendDocument(chatId, outputPath, { 
                caption: "[SUCCESS] PDF conversion complete."
            });
        } else {
            throw new Error("PDF file was not generated.");
        }

    } catch (e) {
        console.error("PDF Fail:", e);
        bot.sendMessage(chatId, "[ERROR] " + e.message);
    } finally {
        // 4. Immediate Cleanup
        setTimeout(() => {
            try {
                if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
                if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
            } catch (err) {}
        }, 2000);
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


        // --- 🇻🇪 SMART VENEZUELA SAVE (Bulk Forward Support) ---
        if (userState[chatId] === 'SAVE_MODE_VENEZUELA') {
            
            // 1. Check for Exit Command
            if (['stop', '/done', 'exit'].includes(text.toLowerCase())) {
                userState[chatId] = null;
                // Clear any pending buffer immediately
                if (vzBuffer[chatId] && vzBuffer[chatId].length > 0) {
                     await addNumbersToDb(vzBuffer[chatId]);
                     delete vzBuffer[chatId];
                }
                const total = await countNumbers();
                return bot.sendMessage(chatId, `[EXITED] Venezuela Mode.\nTotal DB: ${total}`);
            }

            // 2. Extract Numbers (04...)
            const matches = text.match(/\d{10,15}/g);
            if (!matches) return; // Silent ignore if message has no numbers

            // 3. Format Numbers (58...)
const cleanNumbers = matches.map(n => {
    let s = String(n);
    if (s.startsWith('0')) {
        // If it starts with 0 (like 0412), remove the 0 and add 58
        return '58' + s.substring(1);
    } else if (s.startsWith('4')) {
        // If it starts with 4 (like 4267), just add 58 to the front
        return '58' + s;
    }
    // For anything else, just return it as is or handle it
    return s.startsWith('58') ? s : '58' + s; 
});

            // 4. BUFFERING LOGIC (The Magic Part)
            if (!vzBuffer[chatId]) vzBuffer[chatId] = [];
            
            // Add new numbers to the user's temporary list
            vzBuffer[chatId].push(...cleanNumbers);

            // Cancel previous timer (if you are still forwarding)
            if (vzTimer[chatId]) clearTimeout(vzTimer[chatId]);

            // Set a new timer: Wait 2 seconds for more messages
            vzTimer[chatId] = setTimeout(async () => {
                const finalBatch = vzBuffer[chatId];
                const count = finalBatch.length;
                
                // Clear buffer now so we don't save twice
                vzBuffer[chatId] = []; 
                delete vzTimer[chatId];

                if (count > 0) {
                    try {
                        await addNumbersToDb(finalBatch);
                        bot.sendMessage(chatId, `✅ **BATCH SAVED:** ${count} Venezuela numbers.`, { parse_mode: 'Markdown' });
                    } catch (e) {
                        bot.sendMessage(chatId, `[ERROR] Partial save failed: ${e.message}`);
                    }
                }
            }, 2000); // 2000ms = 2 seconds wait time

            return; // Stop processing
        }


                // --- 🇿🇼 SMART ZIMBABWE SAVE (Bulk Forward Support) ---
        if (userState[chatId] === 'SAVE_MODE_ZM') {
            
            // Zimbabwe Country Code
            const TARGET_CODE = '263'; 

            if (['stop', '/done', 'exit'].includes(text.toLowerCase())) {
                userState[chatId] = null;
                if (vzBuffer[chatId] && vzBuffer[chatId].length > 0) {
                     await addNumbersToDb(vzBuffer[chatId]);
                     delete vzBuffer[chatId];
                }
                const total = await countNumbers();
                return bot.sendMessage(chatId, `[EXITED] ZM Mode.\nTotal DB: ${total}`);
            }

            const matches = text.match(/\d{9,15}/g);
            if (!matches) return; 

            const cleanNumbers = matches.map(n => {
                let s = String(n);
                if (s.startsWith('0')) {
                    // Replaces the leading 0 with 263
                    return TARGET_CODE + s.substring(1);
                } else if (s.startsWith(TARGET_CODE)) {
                    // Keeps it if it already has 263
                    return s;
                }
                // Adds 263 to the front if it's just the core 9 digits
                return TARGET_CODE + s; 
            });

            if (!vzBuffer[chatId]) vzBuffer[chatId] = [];
            vzBuffer[chatId].push(...cleanNumbers);

            if (vzTimer[chatId]) clearTimeout(vzTimer[chatId]);

            vzTimer[chatId] = setTimeout(async () => {
                const finalBatch = vzBuffer[chatId];
                const count = finalBatch.length;
                
                vzBuffer[chatId] = []; 
                delete vzTimer[chatId];

                if (count > 0) {
                    try {
                        await addNumbersToDb(finalBatch);
                        bot.sendMessage(chatId, `✅ **BATCH SAVED:** ${count} ZM numbers.`, { parse_mode: 'Markdown' });
                    } catch (e) {
                        bot.sendMessage(chatId, `[ERROR] Partial save failed: ${e.message}`);
                    }
                }
            }, 2000); 

            return; 
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


                // --- 🌍 SMART UNIVERSAL SAVE (Bulk Forward Support) ---
        if (userState[chatId] === 'SAVE_MODE_CUSTOM') {
            
            // Retrieve the country code you typed when starting the command
            const TARGET_CODE = userState[chatId + '_code']; 

            if (['stop', '/done', 'exit'].includes(text.toLowerCase())) {
                userState[chatId] = null;
                userState[chatId + '_code'] = null; // Clean up memory
                
                if (vzBuffer[chatId] && vzBuffer[chatId].length > 0) {
                     await addNumbersToDb(vzBuffer[chatId]);
                     delete vzBuffer[chatId];
                }
                const total = await countNumbers();
                return bot.sendMessage(chatId, `[EXITED] Universal Mode (+${TARGET_CODE}).\nTotal DB: ${total}`);
            }

            // Extract any sequence of digits between 7 and 15 characters
            const matches = text.match(/\d{7,15}/g);
            if (!matches) return; 

            const cleanNumbers = matches.map(n => {
                let s = String(n);
                if (s.startsWith('0')) {
                    // If it starts with 0 (like 0770106866), drop the 0 and add the country code
                    return TARGET_CODE + s.substring(1);
                } else if (s.startsWith(TARGET_CODE)) {
                    // If it already perfectly starts with the country code, leave it alone
                    return s;
                }
                // If it's just raw local digits, slap the country code on the front
                return TARGET_CODE + s; 
            });

            if (!vzBuffer[chatId]) vzBuffer[chatId] = [];
            vzBuffer[chatId].push(...cleanNumbers);

            if (vzTimer[chatId]) clearTimeout(vzTimer[chatId]);

            vzTimer[chatId] = setTimeout(async () => {
                const finalBatch = vzBuffer[chatId];
                const count = finalBatch.length;
                
                vzBuffer[chatId] = []; 
                delete vzTimer[chatId];

                if (count > 0) {
                    try {
                        await addNumbersToDb(finalBatch);
                        bot.sendMessage(chatId, `**BATCH SAVED:** ${count} (+${TARGET_CODE}) numbers.`, { parse_mode: 'Markdown' });
                    } catch (e) {
                        bot.sendMessage(chatId, `[ERROR] Partial save failed: ${e.message}`);
                    }
                }
            }, 2000); 

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
